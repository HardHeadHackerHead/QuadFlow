import { create } from 'zustand'
import { useEffect } from 'react'

interface OverlayState {
  /** Record of active overlay IDs - when any overlay is registered, native webviews should hide */
  activeOverlays: Record<string, boolean>
  registerOverlay: (id: string) => void
  unregisterOverlay: (id: string) => void
}

export const useOverlayStore = create<OverlayState>((set) => ({
  activeOverlays: {},
  registerOverlay: (id) =>
    set((state) => ({
      activeOverlays: { ...state.activeOverlays, [id]: true },
    })),
  unregisterOverlay: (id) =>
    set((state) => {
      const { [id]: _, ...rest } = state.activeOverlays
      return { activeOverlays: rest }
    }),
}))

/**
 * Hook to register/unregister an overlay based on its open state.
 * When isOpen is true, the overlay is registered; when false, it's unregistered.
 * This causes native webviews (e.g. YouTube Shorts) to hide so popups appear on top.
 */
export function useOverlayRegistration(id: string, isOpen: boolean) {
  const registerOverlay = useOverlayStore((s) => s.registerOverlay)
  const unregisterOverlay = useOverlayStore((s) => s.unregisterOverlay)

  useEffect(() => {
    if (isOpen) {
      registerOverlay(id)
    } else {
      unregisterOverlay(id)
    }
    return () => {
      unregisterOverlay(id)
    }
  }, [id, isOpen, registerOverlay, unregisterOverlay])
}
