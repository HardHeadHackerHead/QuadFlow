/**
 * SettingsMenu — left-side toolbar gear dropdown.
 *
 * Click the gear: opens this dropdown. Inside:
 *   - "Open Settings" → triggers the existing AppSettingsModal
 *   - "Show Welcome" → re-opens the first-run onboarding
 *   - Update section (version + check / install-and-restart)
 */

import { useEffect, useRef, useState } from 'react'
import { openUrl as openExternal } from '@tauri-apps/plugin-opener'
import { useUpdateStore } from '../../stores/updateStore'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { showOnboarding } from '../../onboarding/onboardingStore'

const RELEASES_URL = 'https://github.com/HardHeadHackerHead/QuadFlow/releases'

function UpdateSection({ onAfterAction }: { onAfterAction?: () => void }) {
  const {
    currentVersion,
    status,
    availableVersion,
    errorMessage,
    downloadedBytes,
    contentLength,
    checkForUpdates,
    installAndRestart,
  } = useUpdateStore()

  const versionLabel = currentVersion ? `v${currentVersion}` : '…'
  const isBusy = status === 'checking' || status === 'downloading'

  let statusLine: { text: string; tone: 'muted' | 'green' | 'red' | 'yellow' } | null = null
  switch (status) {
    case 'checking':
      statusLine = { text: 'Checking for updates…', tone: 'muted' }
      break
    case 'up-to-date':
      statusLine = { text: 'You’re on the latest version', tone: 'green' }
      break
    case 'available':
      statusLine = { text: `Update available: v${availableVersion}`, tone: 'yellow' }
      break
    case 'downloading': {
      const pct =
        contentLength && contentLength > 0
          ? Math.min(100, Math.round((downloadedBytes / contentLength) * 100))
          : null
      statusLine = { text: pct != null ? `Downloading… ${pct}%` : 'Downloading…', tone: 'muted' }
      break
    }
    case 'ready':
      statusLine = { text: 'Restarting…', tone: 'green' }
      break
    case 'error':
      statusLine = { text: errorMessage || 'Update check failed', tone: 'red' }
      break
  }

  const toneClass = (tone: 'muted' | 'green' | 'red' | 'yellow') =>
    tone === 'green'
      ? 'text-green-400'
      : tone === 'red'
        ? 'text-red-400'
        : tone === 'yellow'
          ? 'text-yellow-400'
          : 'text-vibe-muted'

  return (
    <div className="px-3 py-2 border-t border-vibe-border">
      <div className="flex items-center justify-between text-xs text-vibe-muted">
        <span>Version</span>
        <span className="font-mono text-vibe-text">{versionLabel}</span>
      </div>

      {statusLine && (
        <div className={`text-xs mt-1 ${toneClass(statusLine.tone)}`}>{statusLine.text}</div>
      )}

      <div className="mt-2 flex gap-2">
        {status === 'available' ? (
          <button
            onClick={() => installAndRestart()}
            disabled={isBusy}
            className="flex-1 text-xs px-2 py-1.5 rounded border border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500/20 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Install &amp; restart
          </button>
        ) : (
          <button
            onClick={() => { checkForUpdates(); onAfterAction?.() }}
            disabled={isBusy}
            className="flex-1 text-xs px-2 py-1.5 rounded border border-vibe-border bg-vibe-surface text-vibe-text hover:bg-vibe-border/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {status === 'checking' ? 'Checking…' : 'Check for updates'}
          </button>
        )}
        {status === 'error' && (
          <button
            onClick={() => {
              openExternal(RELEASES_URL).catch((e) =>
                console.error('[SettingsMenu] failed to open releases:', e),
              )
              onAfterAction?.()
            }}
            className="text-xs px-2 py-1.5 rounded border border-vibe-border bg-vibe-surface text-vibe-text hover:bg-vibe-border/50 transition-colors"
            title="Download the latest version from GitHub"
          >
            Open releases ↗
          </button>
        )}
      </div>
    </div>
  )
}

export default function SettingsMenu() {
  const loadVersion = useUpdateStore((s) => s.loadVersion)
  const updateStatus = useUpdateStore((s) => s.status)
  const setShowAppSettings = useAppSettingsStore((s) => s.setShowSettingsModal)

  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { loadVersion() }, [loadVersion])

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const hasUpdateBadge = updateStatus === 'available' || updateStatus === 'ready'

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center justify-center w-7 h-7 bg-vibe-surface border border-vibe-border text-vibe-muted rounded hover:bg-vibe-border/50 hover:text-vibe-text transition-colors ml-1"
        title="Settings"
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
        {hasUpdateBadge && (
          <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-green-400 border border-vibe-surface" />
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-1 w-72 bg-vibe-surface border border-vibe-border rounded-lg shadow-lg z-50 py-1">
          {/* Open the existing app settings modal (the QuadFlow settings UI). */}
          <button
            onClick={() => { setShowAppSettings(true); setOpen(false) }}
            className="w-full text-left px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            Open Settings
          </button>
          <button
            onClick={() => { showOnboarding(); setOpen(false) }}
            className="w-full text-left px-3 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 transition-colors flex items-center gap-2"
            data-settings-show-welcome
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Show Welcome
          </button>

          <UpdateSection onAfterAction={() => setOpen(false)} />
        </div>
      )}
    </div>
  )
}
