/**
 * Sandboxed plugin loading (plugin-system.md §8.4).
 *
 * Third-party (installed from a non-official source, dev) plugins — and bundled
 * copies marked sandboxed at build time (`hello-sandboxed`) — run in iframes
 * served from `/_frame/<pluginId>` with `sandbox="allow-scripts"` and **no**
 * `allow-same-origin`: an opaque origin with no access to the host DOM, storage,
 * cookies, Tauri IPC or other plugins' frames. Everything the plugin does goes
 * through `rpcBridge.ts`.
 *
 * One hidden `role=background` frame per active sandboxed plugin hosts
 * `activate()` and the manifest's command handlers; `SandboxedTile` creates one
 * `role=tile` frame per tile instance.
 */
import type { PluginContext, PluginModule } from '@quadflow/plugin-api'
import { registerFrame, type FrameHandle } from './rpcBridge'
import type { PluginInfo } from './registry'
import { pluginAssetBase } from './urls'

/** The iframe sandbox: scripts only — no same-origin, forms, popups or top navigation. */
export const SANDBOX_FLAGS = 'allow-scripts'

/** How long a frame may take to load its module and report `ready`. */
const START_TIMEOUT_MS = 20_000

export function frameUrl(pluginId: string, params: Record<string, string>): string {
  const q = new URLSearchParams({ ...params, theme: document.documentElement.dataset.theme === 'light' ? 'light' : 'dark' })
  return `${pluginAssetBase()}/_frame/${encodeURIComponent(pluginId)}?${q.toString()}`
}

/** A new sandboxed iframe element (not yet attached). */
export function createSandboxIframe(title: string): HTMLIFrameElement {
  const el = document.createElement('iframe')
  el.setAttribute('sandbox', SANDBOX_FLAGS)
  el.setAttribute('referrerpolicy', 'no-referrer')
  el.title = title
  return el
}

let container: HTMLDivElement | null = null
function backgroundContainer(): HTMLDivElement {
  if (container?.isConnected) return container
  container = document.createElement('div')
  container.id = 'qf-sandbox-background'
  container.setAttribute('aria-hidden', 'true')
  Object.assign(container.style, {
    position: 'fixed',
    width: '0',
    height: '0',
    overflow: 'hidden',
    visibility: 'hidden',
    pointerEvents: 'none',
    left: '0',
    top: '0',
  })
  document.body.appendChild(container)
  return container
}

export interface BackgroundFrame {
  frame: FrameHandle
  iframe: HTMLIFrameElement
  dispose(): Promise<void>
}

/**
 * Start a plugin's background frame and wait until its `activate()` finished.
 * Rejects (and removes the frame) when loading/activation fails or times out.
 */
export function startBackgroundFrame(info: PluginInfo, ctx: PluginContext, bust: string): Promise<BackgroundFrame> {
  return new Promise((resolve, reject) => {
    const iframe = createSandboxIframe(`${info.id} (background)`)
    iframe.dataset.qfSandbox = info.id
    iframe.dataset.qfRole = 'background'
    let settled = false
    const dispose = async () => {
      try {
        await frame.call('$deactivate', [], 2000)
      } catch {
        // deactivate() threw, timed out, or the frame is already gone.
      }
      frame.dispose()
      iframe.remove()
    }
    const timer = setTimeout(() => finish(new Error(`${info.id}: the background frame did not start within ${START_TIMEOUT_MS / 1000} s`)), START_TIMEOUT_MS)
    const finish = (err?: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (err) {
        frame.dispose()
        iframe.remove()
        reject(err)
      } else resolve({ frame, iframe, dispose })
    }
    const frame = registerFrame({
      iframe,
      info,
      ctx,
      role: 'background',
      bust,
      onStatus: (state, error) => {
        if (state === 'ready') finish()
        else if (!settled) finish(new Error(error ?? 'the background frame failed'))
        else console.error(`[sandbox:${info.id}] background frame:`, error)
      },
    })
    iframe.src = frameUrl(info.id, { role: 'background', v: bust })
    backgroundContainer().appendChild(iframe)
  })
}

/**
 * The host-side stand-in for a sandboxed plugin's module: manifest commands
 * run in the background frame; tiles render in their own frames.
 */
export function sandboxedModule(info: PluginInfo, bg: BackgroundFrame): PluginModule {
  const commands: NonNullable<PluginModule['commands']> = {}
  for (const c of info.manifest?.contributes?.commands ?? []) {
    commands[c.id] = (_ctx, args) => bg.frame.call('$command', [c.id, args ?? null])
  }
  return { commands, deactivate: () => bg.dispose() }
}
