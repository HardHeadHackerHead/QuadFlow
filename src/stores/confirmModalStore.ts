import { create } from 'zustand'

export type ConfirmModalKind = 'default' | 'warning' | 'danger'

interface ConfirmRequest {
  title: string
  message: string
  confirmLabel: string
  cancelLabel: string
  kind: ConfirmModalKind
}

interface ConfirmModalState {
  request: ConfirmRequest | null
  resolver: ((value: boolean) => void) | null
  ask: (opts: Partial<ConfirmRequest> & { message: string }) => Promise<boolean>
  resolve: (value: boolean) => void
}

export const useConfirmModalStore = create<ConfirmModalState>((set, get) => ({
  request: null,
  resolver: null,
  ask: (opts) => {
    // If another confirm is already pending, cancel it first so we don't leak resolvers.
    const existing = get().resolver
    if (existing) existing(false)

    return new Promise<boolean>((resolve) => {
      set({
        request: {
          title: opts.title ?? 'Confirm',
          message: opts.message,
          confirmLabel: opts.confirmLabel ?? 'Confirm',
          cancelLabel: opts.cancelLabel ?? 'Cancel',
          kind: opts.kind ?? 'default',
        },
        resolver: resolve,
      })
    })
  },
  resolve: (value) => {
    const { resolver } = get()
    if (resolver) resolver(value)
    set({ request: null, resolver: null })
  },
}))
