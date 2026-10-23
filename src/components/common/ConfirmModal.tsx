import { useEffect, useRef } from 'react'
import { useConfirmModalStore } from '../../stores/confirmModalStore'

export default function ConfirmModal() {
  const request = useConfirmModalStore((s) => s.request)
  const resolve = useConfirmModalStore((s) => s.resolve)
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!request) return
    confirmBtnRef.current?.focus()

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        resolve(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        resolve(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, resolve])

  if (!request) return null

  const isDanger = request.kind === 'danger' || request.kind === 'warning'
  const confirmBtnClasses = isDanger
    ? 'px-4 py-2 rounded text-sm font-medium bg-red-500/90 hover:bg-red-500 text-white transition-colors'
    : 'px-4 py-2 rounded text-sm font-medium bg-vibe-primary hover:bg-vibe-primary-hover text-white transition-colors'

  return (
    <div
      className="fixed inset-0 z-[100] bg-black/60 backdrop-blur-sm flex items-center justify-center p-8"
      onClick={() => resolve(false)}
    >
      <div
        className="w-full max-w-md bg-vibe-surface border border-vibe-border rounded-lg shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
      >
        <div className="p-6 border-b border-vibe-border">
          <div className="flex items-start gap-3">
            {isDanger && (
              <div className="shrink-0 mt-0.5 w-8 h-8 rounded-full bg-red-500/15 text-red-400 flex items-center justify-center">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="w-4 h-4">
                  <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
                  <line x1="12" y1="9" x2="12" y2="13" />
                  <line x1="12" y1="17" x2="12.01" y2="17" />
                </svg>
              </div>
            )}
            <div className="min-w-0 flex-1">
              <h2 id="confirm-modal-title" className="text-lg font-semibold text-vibe-text">
                {request.title}
              </h2>
              <p className="text-sm text-vibe-muted mt-2 whitespace-pre-line">
                {request.message}
              </p>
            </div>
          </div>
        </div>

        <div className="p-4 flex justify-end gap-2 bg-vibe-bg/40 rounded-b-lg">
          <button
            onClick={() => resolve(false)}
            className="px-4 py-2 rounded text-sm font-medium text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/40 transition-colors"
          >
            {request.cancelLabel}
          </button>
          <button
            ref={confirmBtnRef}
            onClick={() => resolve(true)}
            className={confirmBtnClasses}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
