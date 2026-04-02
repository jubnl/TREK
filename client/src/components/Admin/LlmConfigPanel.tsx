import { useState, useEffect, useCallback } from 'react'
import { adminApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { AlertTriangle, Eye, EyeOff, Save, Loader2, RefreshCw } from 'lucide-react'
import { useTranslation } from '../../i18n'

type ProviderName = 'openai' | 'anthropic' | 'ollama' | ''

const CLOUD_PROVIDERS: ProviderName[] = ['openai', 'anthropic']

interface ModelOption { id: string; name: string }

export default function LlmConfigPanel() {
  const [provider, setProvider] = useState<ProviderName>('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKeySet, setApiKeySet] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [models, setModels] = useState<ModelOption[]>([])
  const [fetchingModels, setFetchingModels] = useState(false)
  const toast = useToast()
  const { t } = useTranslation()

  useEffect(() => {
    setIsLoading(true)
    adminApi.getLlmConfig()
      .then((data: { provider: string | null; model: string | null; baseUrl: string | null; apiKeySet: boolean }) => {
        setProvider((data.provider as ProviderName) || '')
        setModel(data.model || '')
        setBaseUrl(data.baseUrl || '')
        setApiKeySet(data.apiKeySet)
      })
      .catch(() => toast.error(t('admin.llm.loadError')))
      .finally(() => setIsLoading(false))
  }, [])

  const isCloud = CLOUD_PROVIDERS.includes(provider as ProviderName)

  // Fetch available models from the provider
  const fetchModels = useCallback(async () => {
    if (!provider) return
    // For cloud providers we need an API key (either the just-typed one, or the stored one)
    if (isCloud && !apiKey && !apiKeySet) return

    setFetchingModels(true)
    setModels([])
    try {
      const data = await adminApi.fetchLlmModels({
        provider,
        apiKey: apiKey || undefined,
        baseUrl: baseUrl || undefined,
      }) as { models: ModelOption[] }
      setModels(data.models)
    } catch (err) {
      toast.error(t('admin.llm.fetchModelsError'))
    } finally {
      setFetchingModels(false)
    }
  }, [provider, apiKey, apiKeySet, baseUrl])

  // Auto-fetch when provider changes (or when a key is set and provider becomes ready)
  useEffect(() => {
    setModels([])
    setModel('')
    if (!provider) return
    // Auto-fetch for Anthropic (no key needed) and Ollama
    // For OpenAI/Anthropic, only auto-fetch if we have a key
    if (!isCloud || apiKeySet) {
      fetchModels()
    }
  }, [provider])

  const handleSave = async () => {
    if (!provider) return toast.error(t('admin.llm.providerRequired'))
    if (isCloud && !apiKey && !apiKeySet) return toast.error(t('admin.llm.apiKeyRequired'))

    setIsSaving(true)
    try {
      await adminApi.updateLlmConfig({
        provider,
        model: model || undefined,
        apiKey: apiKey || undefined,
        baseUrl: baseUrl || undefined,
      })
      if (apiKey) {
        setApiKey('')
        setApiKeySet(true)
        // Now that the key is stored, fetch models if we haven't yet
        if (models.length === 0) fetchModels()
      }
      toast.success(t('admin.llm.saved'))
    } catch {
      toast.error(t('admin.llm.saveError'))
    } finally {
      setIsSaving(false)
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-6 h-6 animate-spin text-blue-500" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-semibold text-slate-900">{t('admin.llm.title')}</h2>
        <p className="text-sm text-slate-500 mt-1">{t('admin.llm.description')}</p>
      </div>

      {isCloud && (
        <div className="flex gap-3 rounded-lg border border-orange-200 bg-orange-50 p-4">
          <AlertTriangle className="w-5 h-5 text-orange-500 shrink-0 mt-0.5" />
          <div>
            <p className="font-medium text-orange-800 text-sm">{t('admin.llm.privacyWarningTitle')}</p>
            <p className="text-orange-700 text-sm mt-1">{t('admin.llm.privacyWarningBody')}</p>
          </div>
        </div>
      )}

      <div className="grid gap-4">
        {/* Provider */}
        <div>
          <label className="block text-sm font-medium text-slate-700 mb-1">{t('admin.llm.provider')}</label>
          <select
            value={provider}
            onChange={e => setProvider(e.target.value as ProviderName)}
            className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">{t('admin.llm.selectProvider')}</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="ollama">Ollama (local)</option>
          </select>
        </div>

        {/* API Key — cloud only */}
        {isCloud && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t('admin.llm.apiKey')}
              {apiKeySet && !apiKey && (
                <span className="ml-2 text-xs text-green-600 font-normal">{t('admin.llm.keySet')}</span>
              )}
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={e => setApiKey(e.target.value)}
                  placeholder={apiKeySet ? t('admin.llm.keyPlaceholderUpdate') : t('admin.llm.keyPlaceholder')}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 pr-10 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  type="button"
                  onClick={() => setShowKey(v => !v)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                >
                  {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              {/* Fetch models button — shows after key is entered or already set */}
              {(apiKey || apiKeySet) && (
                <button
                  type="button"
                  onClick={fetchModels}
                  disabled={fetchingModels}
                  title={t('admin.llm.fetchModels')}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  <RefreshCw className={`w-4 h-4 ${fetchingModels ? 'animate-spin' : ''}`} />
                  {t('admin.llm.fetchModels')}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Base URL — Ollama */}
        {provider === 'ollama' && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">{t('admin.llm.baseUrl')}</label>
            <div className="flex gap-2">
              <input
                type="text"
                value={baseUrl}
                onChange={e => setBaseUrl(e.target.value)}
                placeholder="http://localhost:11434"
                className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={fetchModels}
                disabled={fetchingModels}
                title={t('admin.llm.fetchModels')}
                className="flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw className={`w-4 h-4 ${fetchingModels ? 'animate-spin' : ''}`} />
                {t('admin.llm.fetchModels')}
              </button>
            </div>
          </div>
        )}

        {/* Model — dropdown when models fetched, text input otherwise */}
        {provider && (
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">
              {t('admin.llm.model')}
              {fetchingModels && <Loader2 className="inline w-3.5 h-3.5 animate-spin ml-2 text-slate-400" />}
            </label>
            {models.length > 0 ? (
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">{t('admin.llm.selectModel')}</option>
                {models.map(m => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={model}
                onChange={e => setModel(e.target.value)}
                placeholder={t('admin.llm.modelPlaceholder')}
                className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            )}
            {!fetchingModels && models.length === 0 && isCloud && (apiKey || apiKeySet) && (
              <p className="text-xs text-slate-400 mt-1">{t('admin.llm.noModelsHint')}</p>
            )}
          </div>
        )}
      </div>

      <button
        onClick={handleSave}
        disabled={isSaving || !provider}
        className="flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        {t('common.save')}
      </button>
    </div>
  )
}
