import { useState, useEffect } from 'react'
import {
  Sparkles, Check, X, Pencil, Loader2,
  Plane, Hotel, Utensils, Train, Car, Ship, Ticket, Users, FileText,
} from 'lucide-react'
import { extractionApi } from '../../api/client'
import { useToast } from '../shared/Toast'
import { useTranslation } from '../../i18n'
import { useTripStore } from '../../store/tripStore'
import { ReservationModal } from './ReservationModal'
import type { Reservation } from '../../types'

const TYPE_META: Record<string, { Icon: React.ElementType; color: string }> = {
  flight:     { Icon: Plane,     color: '#3b82f6' },
  hotel:      { Icon: Hotel,     color: '#8b5cf6' },
  restaurant: { Icon: Utensils,  color: '#ef4444' },
  train:      { Icon: Train,     color: '#06b6d4' },
  car:        { Icon: Car,       color: '#6b7280' },
  cruise:     { Icon: Ship,      color: '#0ea5e9' },
  event:      { Icon: Ticket,    color: '#f59e0b' },
  tour:       { Icon: Users,     color: '#10b981' },
  other:      { Icon: FileText,  color: '#6b7280' },
}

interface Props {
  tripId: number
  reservations: Reservation[]
  onClose: () => void
}

export default function ExtractionReviewModal({ tripId, reservations, onClose }: Props) {
  const { t, locale } = useTranslation()
  const toast = useToast()

  // Local list — items removed as they're confirmed/rejected
  const [local, setLocal] = useState<Reservation[]>(reservations)
  const [editingReservation, setEditingReservation] = useState<Reservation | null>(null)
  const [loadingId, setLoadingId] = useState<number | null>(null)

  // Store access for passing to ReservationModal
  const days        = useTripStore(s => s.days)
  const places      = useTripStore(s => s.places)
  const assignments = useTripStore(s => s.assignments)
  const files       = useTripStore(s => s.files)
  const updateReservation = useTripStore(s => s.updateReservation)
  const deleteFile  = useTripStore(s => s.deleteFile)

  // Auto-close when all items have been processed
  useEffect(() => {
    if (local.length === 0) onClose()
  }, [local])

  const removeFromList = (id: number) =>
    setLocal(prev => prev.filter(r => r.id !== id))

  // ── Quick confirm (no edit needed) ─────────────────────────────────────────
  const handleConfirm = async (id: number) => {
    setLoadingId(id)
    try {
      await extractionApi.review([id], 'confirm', tripId)
      removeFromList(id)
      toast.success(t('extraction.review.confirmed', { count: 1 }))
    } catch {
      toast.error(t('extraction.review.error'))
    } finally {
      setLoadingId(null)
    }
  }

  // ── Reject (delete reservation) ────────────────────────────────────────────
  const handleReject = async (id: number) => {
    setLoadingId(id)
    try {
      await extractionApi.review([id], 'reject', tripId)
      removeFromList(id)
      toast.success(t('extraction.review.rejected', { count: 1 }))
    } catch {
      toast.error(t('extraction.review.error'))
    } finally {
      setLoadingId(null)
    }
  }

  // ── Confirm all remaining ─────────────────────────────────────────────────
  const handleConfirmAll = async () => {
    const ids = local.map(r => r.id)
    setLoadingId(-1) // sentinel: bulk action in progress
    try {
      await extractionApi.review(ids, 'confirm', tripId)
      setLocal([])
      toast.success(t('extraction.review.confirmed', { count: ids.length }))
    } catch {
      toast.error(t('extraction.review.error'))
    } finally {
      setLoadingId(null)
    }
  }

  // ── Reject all remaining ──────────────────────────────────────────────────
  const handleRejectAll = async () => {
    const ids = local.map(r => r.id)
    setLoadingId(-1)
    try {
      await extractionApi.review(ids, 'reject', tripId)
      setLocal([])
      toast.success(t('extraction.review.rejected', { count: ids.length }))
    } catch {
      toast.error(t('extraction.review.error'))
    } finally {
      setLoadingId(null)
    }
  }

  // ── Save from ReservationModal: update then confirm ───────────────────────
  const handleEditSave = async (data: Record<string, unknown>) => {
    if (!editingReservation) return
    await updateReservation(tripId, editingReservation.id, data)
    await extractionApi.review([editingReservation.id], 'confirm', tripId)
    removeFromList(editingReservation.id)
    setEditingReservation(null)
    toast.success(t('extraction.review.confirmed', { count: 1 }))
  }

  const isBusy = loadingId !== null

  return (
    <>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center p-4"
        style={{ background: 'rgba(0,0,0,0.5)' }}
        onClick={e => { if (e.target === e.currentTarget && !isBusy) onClose() }}
      >
        <div
          className="rounded-xl shadow-xl w-full max-w-2xl flex flex-col"
          style={{ background: 'var(--bg-card)', maxHeight: '85vh' }}
        >
          {/* Header */}
          <div className="flex items-center justify-between p-5 border-b shrink-0" style={{ borderColor: 'var(--border-faint)' }}>
            <div className="flex items-center gap-2.5">
              <Sparkles className="w-5 h-5 text-purple-500" />
              <div>
                <h3 className="font-semibold" style={{ color: 'var(--text-primary)' }}>
                  {t('extraction.review.title')}
                </h3>
                <p className="text-xs mt-0.5" style={{ color: 'var(--text-faint)' }}>
                  {t('extraction.review.subtitle', { count: local.length })}
                </p>
              </div>
            </div>
            <button
              onClick={onClose}
              disabled={isBusy}
              className="p-1 rounded hover:bg-black/5 disabled:opacity-40"
              style={{ color: 'var(--text-faint)' }}
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* Card list */}
          <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
            {local.map(r => {
              const meta = typeof r.metadata === 'string'
                ? (() => { try { return JSON.parse(r.metadata) } catch { return {} } })()
                : (r.metadata ?? {})
              const { Icon, color } = TYPE_META[r.type] ?? TYPE_META.other
              const isLoading = loadingId === r.id || loadingId === -1

              return (
                <div
                  key={r.id}
                  className="rounded-lg border p-4"
                  style={{ borderColor: 'var(--border-primary)', background: 'var(--bg-input)' }}
                >
                  {/* Top row: icon + title + type badge */}
                  <div className="flex items-start gap-3">
                    <div className="mt-0.5 shrink-0 rounded-md p-1.5" style={{ background: `${color}18` }}>
                      <Icon className="w-4 h-4" style={{ color }} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-sm truncate" style={{ color: 'var(--text-primary)' }}>
                          {r.title}
                        </span>
                        <span
                          className="text-xs px-1.5 py-0.5 rounded-full shrink-0"
                          style={{ background: `${color}20`, color }}
                        >
                          {t(`reservations.type.${r.type}`) ?? r.type}
                        </span>
                      </div>

                      {/* Summary line */}
                      <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--text-faint)' }}>
                        {[
                          r.reservation_time && new Date(r.reservation_time).toLocaleDateString(locale),
                          r.location,
                          r.confirmation_number,
                        ].filter(Boolean).join(' · ')}
                      </p>

                      {/* Type-specific metadata chips */}
                      {r.type === 'flight' && (meta.departure_airport || meta.arrival_airport || meta.airline || meta.flight_number) && (
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {meta.airline && <Chip>{meta.airline}</Chip>}
                          {meta.flight_number && <Chip>{meta.flight_number}</Chip>}
                          {meta.departure_airport && <Chip>{meta.departure_airport} →</Chip>}
                          {meta.arrival_airport && <Chip>{meta.arrival_airport}</Chip>}
                        </div>
                      )}
                      {r.type === 'train' && meta.train_number && (
                        <div className="flex flex-wrap gap-1.5 mt-1.5">
                          {meta.operator && <Chip>{meta.operator}</Chip>}
                          <Chip>{meta.train_number}</Chip>
                          {meta.from && <Chip>{meta.from} →</Chip>}
                          {meta.to && <Chip>{meta.to}</Chip>}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Action buttons */}
                  <div className="flex items-center justify-end gap-2 mt-3 pt-3 border-t" style={{ borderColor: 'var(--border-faint)' }}>
                    <button
                      onClick={() => handleReject(r.id)}
                      disabled={isLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border disabled:opacity-50 hover:bg-red-50"
                      style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
                    >
                      {isLoading && loadingId === r.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <X className="w-3.5 h-3.5 text-red-500" />
                      )}
                      {t('extraction.review.reject')}
                    </button>
                    <button
                      onClick={() => setEditingReservation(r)}
                      disabled={isLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border disabled:opacity-50 hover:bg-black/5"
                      style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                      {t('extraction.review.edit')}
                    </button>
                    <button
                      onClick={() => handleConfirm(r.id)}
                      disabled={isLoading}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-white disabled:opacity-50"
                      style={{ background: color }}
                    >
                      {isLoading && loadingId === r.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <Check className="w-3.5 h-3.5" />
                      )}
                      {t('extraction.review.quickConfirm')}
                    </button>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Footer batch actions */}
          <div className="p-5 border-t shrink-0 flex items-center justify-between gap-3" style={{ borderColor: 'var(--border-faint)' }}>
            <button
              onClick={handleRejectAll}
              disabled={isBusy}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm border disabled:opacity-50"
              style={{ borderColor: 'var(--border-primary)', color: 'var(--text-secondary)' }}
            >
              {loadingId === -1 ? <Loader2 className="w-4 h-4 animate-spin" /> : <X className="w-4 h-4" />}
              {t('extraction.review.rejectAll')}
            </button>
            <button
              onClick={handleConfirmAll}
              disabled={isBusy}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm font-medium text-white bg-purple-600 hover:bg-purple-700 disabled:opacity-50"
            >
              {loadingId === -1 ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
              {t('extraction.review.confirmAll')}
            </button>
          </div>
        </div>
      </div>

      {/* Edit modal — opens on top of review modal */}
      {editingReservation && (
        <ReservationModal
          isOpen={true}
          onClose={() => setEditingReservation(null)}
          onSave={handleEditSave}
          reservation={editingReservation}
          days={days}
          places={places}
          assignments={assignments}
          selectedDayId={null}
          files={files}
          onFileUpload={undefined}
          onFileDelete={(id) => deleteFile(tripId, id)}
          accommodations={[]}
        />
      )}
    </>
  )
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span
      className="text-xs px-1.5 py-0.5 rounded"
      style={{ background: 'var(--bg-hover)', color: 'var(--text-secondary)' }}
    >
      {children}
    </span>
  )
}
