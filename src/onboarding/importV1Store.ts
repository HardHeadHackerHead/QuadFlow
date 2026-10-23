/**
 * "Bring over your projects from QuadFlow 1.x" (core `import_v1`): adds the
 * 1.x project list (names + folders) to this app's projects list.
 *
 * On app start, when a 1.x installation is found and the import has neither
 * run nor been dismissed (`importV1/state`), the dialog opens — after the
 * first-run onboarding, if that is showing. Settings → Advanced opens it again
 * at any time ("manual" mode). Dev builds only see a 1.x install named by
 * `QUADFLOW_V1_DATA_DIR`, never the real one.
 */
import { create } from 'zustand'
import { commands, type ImportV1Detection, type ImportV1ProjectReport, type ImportV1Report } from '../generated/bindings'
import { call } from '../lib/core'
import { useOnboardingStore } from './onboardingStore'

export type ImportV1Mode = 'first-run' | 'manual'

/** Projects that can be selected. */
export function isSelectable(p: ImportV1ProjectReport): boolean {
  return p.outcome === 'would_register' || p.outcome === 'would_move_aside' || p.outcome === 'v1_data_kept'
}

interface ImportV1State {
  isOpen: boolean
  mode: ImportV1Mode
  loading: boolean
  running: boolean
  error: string | null
  detection: ImportV1Detection | null
  /** Selected project roots. */
  selected: string[]
  report: ImportV1Report | null
  /** Open the dialog; `detection` skips a second detect when the caller just ran one. */
  open: (mode: ImportV1Mode, detection?: ImportV1Detection) => Promise<void>
  close: () => void
  /** "Not now" in first-run mode: never offered automatically again. */
  dismiss: () => Promise<void>
  toggle: (root: string, on: boolean) => void
  setAll: (on: boolean) => void
  run: () => Promise<void>
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const useImportV1Store = create<ImportV1State>((set, get) => ({
  isOpen: false,
  mode: 'manual',
  loading: false,
  running: false,
  error: null,
  detection: null,
  selected: [],
  report: null,

  open: async (mode, pre) => {
    set({ isOpen: true, mode, loading: true, error: null, report: null })
    try {
      const detection = pre ?? (await call(commands.importV1Detect()))
      const projects = detection.preview?.projects ?? []
      set({ detection, selected: projects.filter(isSelectable).map((p) => p.root), loading: false })
    } catch (e) {
      set({ loading: false, error: errorText(e) })
    }
  },

  close: () => set({ isOpen: false }),

  dismiss: async () => {
    set({ isOpen: false })
    try {
      await call(commands.importV1Dismiss())
    } catch (e) {
      console.error('[import-v1] could not record the dismissal:', e)
    }
  },

  toggle: (root, on) => {
    const cur = get().selected.filter((r) => r !== root)
    set({ selected: on ? [...cur, root] : cur })
  },

  setAll: (on) => {
    const projects = get().detection?.preview?.projects ?? []
    set({ selected: on ? projects.filter(isSelectable).map((p) => p.root) : [] })
  },

  run: async () => {
    set({ running: true, error: null })
    try {
      const report = await call(commands.importV1Run({ projects: get().selected, all: false, dryRun: false }))
      set({ report, running: false })
    } catch (e) {
      set({ running: false, error: errorText(e) })
    }
  },
}))

/** App start: offer the import once when a 1.x installation is present. */
export async function maybeShowImportV1(): Promise<boolean> {
  try {
    const detection = await call(commands.importV1Detect())
    if (!detection.found || detection.state) return false
    if (!(detection.preview?.projects ?? []).some(isSelectable)) return false
    const show = () => void useImportV1Store.getState().open('first-run', detection)
    if (!useOnboardingStore.getState().isOpen) {
      show()
      return true
    }
    // Show after the welcome flow closes.
    const unsub = useOnboardingStore.subscribe((s) => {
      if (!s.isOpen) {
        unsub()
        show()
      }
    })
    return true
  } catch (e) {
    console.error('[import-v1] detection failed:', e)
    return false
  }
}
