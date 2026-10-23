/**
 * First-run onboarding (ROADMAP §3 "App shell"): open state + persistence.
 *
 * The outcome is a core setting (`shell` / `onboarding`), so the flow shows on
 * a fresh data dir only and never again once completed or skipped. It can be
 * re-opened from the gear menu or the command palette ("Show Welcome").
 * `QUADFLOW_SKIP_ONBOARDING=1` (`CoreInfo.skipOnboarding`, set by the GUI
 * harness) suppresses the automatic first-run display.
 */
import { create } from 'zustand'
import * as appData from '../lib/appData'
import { getCoreInfo } from '../lib/core'

export const ONBOARDING_NS = 'shell'
export const ONBOARDING_KEY = 'onboarding'
export const ONBOARDING_VERSION = 1

export type OnboardingOutcome = 'completed' | 'skipped'

/** Persisted value of `shell.onboarding`. */
export interface OnboardingRecord {
  status: OnboardingOutcome
  /** Step index the user left from (0-based). */
  lastStep: number
  at: number
  version: number
}

interface OnboardingState {
  isOpen: boolean
  step: number
  open: (step?: number) => void
  setStep: (step: number) => void
  /** Close and persist the outcome (never shown automatically again). */
  finish: (status: OnboardingOutcome) => Promise<void>
}

export const useOnboardingStore = create<OnboardingState>((set, get) => ({
  isOpen: false,
  step: 0,
  open: (step = 0) => set({ isOpen: true, step }),
  setStep: (step) => set({ step }),
  finish: async (status) => {
    const lastStep = get().step
    set({ isOpen: false })
    const record: OnboardingRecord = { status, lastStep, at: Date.now(), version: ONBOARDING_VERSION }
    try {
      await appData.setSetting(ONBOARDING_NS, ONBOARDING_KEY, { ...record })
    } catch (e) {
      console.error('[onboarding] could not persist the outcome:', e)
    }
  },
}))

export async function readOnboardingRecord(): Promise<OnboardingRecord | undefined> {
  return appData.getSetting<OnboardingRecord>(ONBOARDING_NS, ONBOARDING_KEY)
}

/** App start: show the flow when this data dir has never completed/skipped it. */
export async function maybeShowOnboarding(): Promise<boolean> {
  try {
    const info = await getCoreInfo()
    if (info.skipOnboarding) return false
    const record = await readOnboardingRecord()
    if (record?.status === 'completed' || record?.status === 'skipped') return false
    useOnboardingStore.getState().open(0)
    return true
  } catch (e) {
    // Never block the workspace on onboarding.
    console.error('[onboarding] first-run check failed:', e)
    return false
  }
}

/** "Show Welcome" (palette / gear menu). */
export function showOnboarding(): void {
  useOnboardingStore.getState().open(0)
}
