/**
 * updateStore — wraps the Tauri updater plugin.
 *
 * Provides a single source of truth for: current app version, update-check
 * status, the pending Update handle (if any), download progress, and the
 * timestamp of the last automatic check (persisted to localStorage so we
 * don't hammer GitHub on every launch).
 *
 * The version is read from tauri.conf.json at compile time via getVersion();
 * never hard-code it.
 */

import { create } from 'zustand'
import { getVersion } from '@tauri-apps/api/app'
import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { deactivateAllPlugins } from '../plugins/loader'
import { commands } from '../generated/bindings'

const LAST_CHECK_KEY = 'quadflow.updater.lastCheckAt'
const AUTO_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // 24h

export type UpdateStatus =
  | 'idle'
  | 'checking'
  | 'up-to-date'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error'

interface UpdateState {
  currentVersion: string | null
  status: UpdateStatus
  availableVersion: string | null
  releaseNotes: string | null
  errorMessage: string | null
  downloadedBytes: number
  contentLength: number | null
  pendingUpdate: Update | null
  lastCheckAt: number | null

  loadVersion: () => Promise<void>
  checkForUpdates: (opts?: { silent?: boolean }) => Promise<void>
  installAndRestart: () => Promise<void>
  maybeAutoCheck: () => Promise<void>
  dismiss: () => void
}

function readLastCheck(): number | null {
  try {
    const raw = localStorage.getItem(LAST_CHECK_KEY)
    if (!raw) return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}

function writeLastCheck(ts: number) {
  try {
    localStorage.setItem(LAST_CHECK_KEY, String(ts))
  } catch {
    // ignore
  }
}

const RELEASES_URL =
  'https://github.com/HardHeadHackerHead/QuadFlow/releases'

/**
 * Translate the Tauri updater plugin's raw error into something the user
 * can act on. The plugin's most common failure on this app is "Could
 * not fetch a valid release JSON from the remote" — fired when the
 * configured `latest.json` URL 404s (because the release was published
 * without an updater manifest) or returns non-JSON. The bare string is
 * jargon for users; this maps the known shapes to a clear sentence and
 * leaves anything we don't recognise alone.
 */
function humanizeUpdateError(raw: string): string {
  const lower = raw.toLowerCase()
  if (
    lower.includes('release json') ||
    lower.includes('latest.json') ||
    (lower.includes('404') && lower.includes('not found'))
  ) {
    return (
      `In-app updates are temporarily unavailable for this release ` +
      `(the updater manifest is missing). Download the latest version ` +
      `manually from ${RELEASES_URL}.`
    )
  }
  if (
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('dns') ||
    lower.includes('connection') ||
    lower.includes('timed out') ||
    lower.includes('timeout')
  ) {
    return (
      `Couldn't reach the update server. Check your internet ` +
      `connection and try again.`
    )
  }
  if (lower.includes('signature') || lower.includes('pubkey')) {
    return (
      `An update is available, but its signature didn't validate. ` +
      `For safety we won't install it. Download manually from ` +
      `${RELEASES_URL} if you need to update now.`
    )
  }
  return raw
}

export const useUpdateStore = create<UpdateState>((set, get) => ({
  currentVersion: null,
  status: 'idle',
  availableVersion: null,
  releaseNotes: null,
  errorMessage: null,
  downloadedBytes: 0,
  contentLength: null,
  pendingUpdate: null,
  lastCheckAt: readLastCheck(),

  loadVersion: async () => {
    if (get().currentVersion) return
    try {
      const v = await getVersion()
      set({ currentVersion: v })
    } catch (e) {
      console.error('[updateStore] getVersion failed:', e)
    }
  },

  checkForUpdates: async (opts) => {
    const silent = opts?.silent ?? false
    if (get().status === 'checking' || get().status === 'downloading') return

    set({ status: 'checking', errorMessage: null })

    try {
      const update = await check()
      const now = Date.now()
      writeLastCheck(now)
      set({ lastCheckAt: now })

      if (!update) {
        set({
          status: 'up-to-date',
          availableVersion: null,
          releaseNotes: null,
          pendingUpdate: null,
        })
        return
      }

      set({
        status: 'available',
        availableVersion: update.version,
        releaseNotes: update.body ?? null,
        pendingUpdate: update,
      })
    } catch (e) {
      // A background check failing (offline, no release published yet) is not an app error.
      ;(silent ? console.warn : console.error)('[updateStore] check failed:', e)
      if (silent) {
        // Don't surface errors during a background check — just go quiet.
        set({ status: 'idle', errorMessage: null })
      } else {
        const raw = e instanceof Error ? e.message : String(e)
        set({
          status: 'error',
          errorMessage: humanizeUpdateError(raw),
        })
      }
    }
  },

  installAndRestart: async () => {
    const update = get().pendingUpdate
    if (!update) return

    set({
      status: 'downloading',
      downloadedBytes: 0,
      contentLength: null,
      errorMessage: null,
    })

    try {
      // download → give native resources back → install: on Windows `install()` runs the
      // installer and exits the process itself, so plugins and sidecars stop before it.
      await update.download((event) => {
        switch (event.event) {
          case 'Started':
            set({
              contentLength: event.data.contentLength ?? null,
              downloadedBytes: 0,
            })
            break
          case 'Progress':
            set((s) => ({
              downloadedBytes: s.downloadedBytes + (event.data.chunkLength ?? 0),
            }))
            break
          case 'Finished':
            set({ status: 'ready' })
            break
        }
      })
      // Give native resources back (embedded windows) before the process goes away.
      await deactivateAllPlugins()
      await commands.pluginSidecarsStopAll().catch((e) => console.warn('[updateStore] stopping sidecars failed:', e))
      await update.install()
      await relaunch()
    } catch (e) {
      console.error('[updateStore] install failed:', e)
      const raw = e instanceof Error ? e.message : String(e)
      set({
        status: 'error',
        errorMessage: humanizeUpdateError(raw),
      })
    }
  },

  maybeAutoCheck: async () => {
    const last = get().lastCheckAt
    if (last && Date.now() - last < AUTO_CHECK_INTERVAL_MS) return
    await get().checkForUpdates({ silent: true })
  },

  dismiss: () => {
    const s = get().status
    if (s === 'up-to-date' || s === 'error') {
      set({ status: 'idle', errorMessage: null })
    }
  },
}))
