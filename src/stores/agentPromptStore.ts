import { create } from 'zustand'
import type { AgentApprovalMode } from '../generated/bindings'

/**
 * Open state of the agent launch dialog plus the choices made in it this run
 * (per provider id), so reopening the dialog keeps the last picks.
 */
interface AgentPromptStore {
  isOpen: boolean
  /** Provider preselected when opening (`null` = the default provider). */
  providerId: string | null
  initialPrompt: string
  lastApprovalMode: Record<string, AgentApprovalMode>
  lastEffort: Record<string, string>
  openModal: (providerId?: string | null, initialPrompt?: string) => void
  closeModal: () => void
  remember: (providerId: string, picks: { approvalMode?: AgentApprovalMode; effort?: string | null }) => void
}

export const useAgentPromptStore = create<AgentPromptStore>((set) => ({
  isOpen: false,
  providerId: null,
  initialPrompt: '',
  lastApprovalMode: {},
  lastEffort: {},

  openModal: (providerId = null, initialPrompt = '') => {
    set({ isOpen: true, providerId, initialPrompt })
  },

  closeModal: () => {
    set({ isOpen: false, initialPrompt: '' })
  },

  remember: (providerId, picks) => {
    set((s) => ({
      lastApprovalMode: picks.approvalMode ? { ...s.lastApprovalMode, [providerId]: picks.approvalMode } : s.lastApprovalMode,
      lastEffort: picks.effort ? { ...s.lastEffort, [providerId]: picks.effort } : s.lastEffort,
    }))
  },
}))
