import { useEffect, useId } from 'react'

/**
 * Host bridge. `@quadflow/ui` never imports shell code; the shell (or the
 * sandbox runtime, which forwards over RPC) wires these in once at startup:
 *
 *   configureUi({ overlay: { register, unregister }, toast: (t) => … })
 *
 * Until configured, overlays are tracked only locally and toasts render through
 * the kit's own <Toaster/> (if mounted).
 */
export interface OverlayBridge {
  register(id: string): void
  unregister(id: string): void
}

export type ToastKind = 'info' | 'success' | 'warning' | 'error'

export interface ToastOptions {
  message: string
  title?: string
  kind?: ToastKind
  /** ms; 0 = sticky. Default 4000. */
  duration?: number
  action?: { label: string; onClick: () => void }
}

export interface UiHostBridge {
  overlay?: OverlayBridge
  toast?: (t: ToastOptions) => void
}

const bridge: UiHostBridge = {}
const localOverlays = new Set<string>()

export function configureUi(b: UiHostBridge) {
  Object.assign(bridge, b)
  // Replay overlays opened before the bridge was installed.
  if (b.overlay) localOverlays.forEach((id) => b.overlay!.register(id))
}

export function getUiBridge(): Readonly<UiHostBridge> {
  return bridge
}

export function registerOverlay(id: string) {
  localOverlays.add(id)
  bridge.overlay?.register(id)
}

export function unregisterOverlay(id: string) {
  localOverlays.delete(id)
  bridge.overlay?.unregister(id)
}

/** True while any kit overlay is open (local view; the host has the global one). */
export function isAnyUiOverlayOpen() {
  return localOverlays.size > 0
}

/**
 * Register a floating surface with the host overlay system while `open`, so
 * native child windows/webviews hide underneath it (plugin-system.md §6.7).
 * `id` is optional; a stable unique id is generated when omitted.
 */
export function useOverlay(id: string | undefined, open: boolean) {
  const auto = useId()
  const key = id ?? `qf-ui${auto}`
  useEffect(() => {
    if (!open) return
    registerOverlay(key)
    return () => unregisterOverlay(key)
  }, [key, open])
}
