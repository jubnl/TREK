import { useState, useEffect, useRef, useCallback } from 'react'
import { Sparkles, AlertTriangle, Loader2, Upload, FileText, X, FolderOpen } from 'lucide-react'
import { extractionApi, filesApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import type { TripFile } from '../../types'

interface Props {
  tripId: number
  files: TripFile[]
  preselectedFileId?: number
  onJobStarted: (jobId: number) => void
  onFileUploaded?: (file: TripFile) => void
  onClose: () => void
}

type Tab = 'existing' | 'upload'

export default function ExtractionButton({
  tripId,
  files,
  preselectedFileId,
  onJobStarted,
  onFileUploaded,
  onClose,
}: Props) {
  const { t } = useTranslation()
  const toast = useToast()

  const [config, setConfig] = useState<{
    configured: boolean; provider?: string; isCloud?: boolean; model?: string
  } | null>(null)
  const [loadingConfig, setLoadingConfig] = useState(true)

  const [tab, setTab] = useState<Tab>(preselectedFileId ? 'existing' : 'existing')
  const [selectedFileId, setSelectedFileId] = useState<number | ''>(preselectedFileId ?? '')

  // Upload state
  const [dragOver, setDragOver] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadProgress, setUploadProgress] = useState<number>(0)
  const [uploading, setUploading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [cloudAcknowledged, setCloudAcknowledged] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    extractionApi.getConfig()
      .then(d => setConfig(d))
      .catch(() => setConfig(null))
      .finally(() => setLoadingConfig(false))
  }, [])

  const isCloud = config?.isCloud ?? false

  // ── drag-and-drop ──────────────────────────────────────────────────────────
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
  }, [])

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    const file = e.dataTransfer.files[0]
    if (file) setUploadFile(file)
  }, [])

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) setUploadFile(file)
  }

  // ── submit ─────────────────────────────────────────────────────────────────
  const handleExtract = async () => {
    if (isCloud && !cloudAcknowledged) {
      return toast.error(t('extraction.acknowledgeRequired'))
    }

    setSubmitting(true)
    try {
      let fileId: number

      if (tab === 'upload') {
        if (!uploadFile) return toast.error(t('extraction.uploadSelectFile'))

        setUploading(true)
        setUploadProgress(0)
        const formData = new FormData()
        formData.append('file', uploadFile)

        let uploaded: TripFile
        try {
          const response = await filesApi.uploadWithProgress(tripId, formData, pct => setUploadProgress(pct))
          uploaded = response.file ?? response
          onFileUploaded?.(uploaded)
          fileId = uploaded.id
        } finally {
          setUploading(false)
        }
      } else {
        if (!selectedFileId) return toast.error(t('extraction.selectFile'))
        fileId = Number(selectedFileId)
      }

      const data = await extractionApi.extract(tripId, fileId, isCloud ? cloudAcknowledged : undefined)
      onJobStarted(data.job.id)
      toast.success(t('extraction.started'))
      onClose()
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message
      toast.error(msg || t('extraction.startError'))
    } finally {
      setSubmitting(false)
      setUploading(false)
    }
  }

  const canSubmit =
    config?.configured &&
    (!isCloud || cloudAcknowledged) &&
    !submitting &&
    (tab === 'existing' ? !!selectedFileId : !!uploadFile)

  const existingFiles = files.filter(f => !f.deleted_at)

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(0,0,0,0.5)' }}
      onClick={e => { if (e.target === e.currentTarget && !submitting) onClose() }}
    >
      <div className="rounded-xl shadow-xl w-full max-w-md" style={{ background: 'var(--bg-card)' }}>
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b" style={{ borderColor: 'var(--border-faint)' }}>
          <div className="flex items-center gap-2.5">
            <Sparkles className="w-5 h-5 text-purple-500" />
            <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
              {t('extraction.title')}
            </h3>
          </div>
          <button
            onClick={onClose}
            disabled={submitting}
            className="p-1 rounded hover:bg-black/5 disabled:opacity-40"
            style={{ color: 'var(--text-faint)' }}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {loadingConfig ? (
            <div className="flex justify-center py-4">
              <Loader2 className="w-5 h-5 animate-spin text-blue-500" />
            </div>
          ) : !config?.configured ? (
            <div className="text-sm p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-800">
              {t('extraction.notConfigured')}
            </div>
          ) : (
            <>
              {/* Provider info */}
              <p className="text-xs" style={{ color: 'var(--text-faint)' }}>
                {t('extraction.usingProvider', { provider: config.provider, model: config.model })}
              </p>

              {/* Privacy warning for cloud */}
              {isCloud && (
                <div className="rounded-lg border border-orange-200 bg-orange-50 p-3 space-y-2">
                  <div className="flex gap-2">
                    <AlertTriangle className="w-4 h-4 text-orange-500 shrink-0 mt-0.5" />
                    <p className="text-sm text-orange-700">{t('extraction.cloudPrivacyWarning')}</p>
                  </div>
                  <label className="flex items-center gap-2 text-sm text-orange-800 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={cloudAcknowledged}
                      onChange={e => setCloudAcknowledged(e.target.checked)}
                      className="rounded w-4 h-4"
                    />
                    {t('extraction.acknowledgeCloud')}
                  </label>
                </div>
              )}

              {/* Tabs */}
              <div className="flex rounded-lg border overflow-hidden text-sm" style={{ borderColor: 'var(--border-primary)' }}>
                <button
                  onClick={() => setTab('existing')}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 transition-colors"
                  style={{
                    background: tab === 'existing' ? 'var(--bg-hover)' : 'transparent',
                    color: tab === 'existing' ? 'var(--text-primary)' : 'var(--text-faint)',
                    fontWeight: tab === 'existing' ? 600 : 400,
                  }}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  {t('extraction.tabExisting')}
                </button>
                <button
                  onClick={() => setTab('upload')}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 px-3 border-l transition-colors"
                  style={{
                    borderColor: 'var(--border-primary)',
                    background: tab === 'upload' ? 'var(--bg-hover)' : 'transparent',
                    color: tab === 'upload' ? 'var(--text-primary)' : 'var(--text-faint)',
                    fontWeight: tab === 'upload' ? 600 : 400,
                  }}
                >
                  <Upload className="w-3.5 h-3.5" />
                  {t('extraction.tabUpload')}
                </button>
              </div>

              {/* Tab content */}
              {tab === 'existing' ? (
                <div>
                  {existingFiles.length === 0 ? (
                    <p className="text-sm text-center py-3" style={{ color: 'var(--text-faint)' }}>
                      {t('extraction.noFiles')}
                    </p>
                  ) : (
                    <select
                      value={selectedFileId}
                      onChange={e => setSelectedFileId(Number(e.target.value) || '')}
                      className="w-full rounded-lg border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-purple-500"
                      style={{
                        borderColor: 'var(--border-primary)',
                        background: 'var(--bg-input)',
                        color: 'var(--text-primary)',
                      }}
                    >
                      <option value="">{t('extraction.chooseFile')}</option>
                      {existingFiles.map(f => (
                        <option key={f.id} value={f.id}>{f.original_name}</option>
                      ))}
                    </select>
                  )}
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Drop zone */}
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    onClick={() => !submitting && fileInputRef.current?.click()}
                    className="relative rounded-lg border-2 border-dashed p-6 flex flex-col items-center gap-2 cursor-pointer transition-colors"
                    style={{
                      borderColor: dragOver ? 'var(--color-primary, #7c3aed)' : 'var(--border-primary)',
                      background: dragOver ? 'rgba(124,58,237,0.05)' : 'var(--bg-input)',
                    }}
                  >
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden"
                      accept=".pdf,.eml,.txt,.png,.jpg,.jpeg,.webp"
                      onChange={handleFileInputChange}
                    />
                    {uploadFile ? (
                      <>
                        <FileText className="w-8 h-8 text-purple-500" />
                        <div className="text-center">
                          <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>
                            {uploadFile.name}
                          </p>
                          <p className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>
                            {(uploadFile.size / 1024).toFixed(0)} KB — {t('extraction.clickToChange')}
                          </p>
                        </div>
                      </>
                    ) : (
                      <>
                        <Upload className="w-8 h-8" style={{ color: 'var(--text-faint)' }} />
                        <div className="text-center">
                          <p className="text-sm font-medium" style={{ color: 'var(--text-secondary)' }}>
                            {t('extraction.dropOrClick')}
                          </p>
                          <p className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>
                            PDF, EML, TXT, PNG, JPG
                          </p>
                        </div>
                      </>
                    )}
                  </div>

                  {/* Upload progress */}
                  {uploading && (
                    <div className="space-y-1">
                      <div className="flex justify-between text-xs" style={{ color: 'var(--text-faint)' }}>
                        <span>{t('extraction.uploading')}</span>
                        <span>{uploadProgress}%</span>
                      </div>
                      <div className="h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border-primary)' }}>
                        <div
                          className="h-full rounded-full bg-purple-500 transition-all duration-150"
                          style={{ width: `${uploadProgress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="p-5 pt-0 flex justify-end gap-3">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2 rounded-lg text-sm border disabled:opacity-50"
            style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleExtract}
            disabled={!canSubmit}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50"
          >
            {submitting ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Sparkles className="w-4 h-4" />
            )}
            {uploading ? t('extraction.uploading') : t('extraction.extract')}
          </button>
        </div>
      </div>
    </div>
  )
}
