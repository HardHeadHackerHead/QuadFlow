/**
 * Bootstrap of a sandboxed plugin frame (plugin-system.md §8.4), served as
 * `/_runtime/frame.js` and loaded by the generated `/_frame/<pluginId>` document.
 *
 *  1. connect to the host bridge (`ready` → `init`) and build the RPC
 *     `PluginContext` (`@quadflow/plugin-api/rpc`);
 *  2. apply the host theme to this document (and follow `ctx` theme updates),
 *     route `@quadflow/ui` overlays and toasts to the host;
 *  3. `import()` the plugin's `ui.entry` — its bare imports of the shared
 *     specifiers resolve through the frame's import map to this runtime's
 *     React / zustand / `@quadflow/ui` / `@quadflow/plugin-api`;
 *  4. `role=tile`: render `tiles[tile]` with `TileProps` whose callbacks post
 *     `ui` messages; `role=background`: run `activate(ctx)` and answer
 *     `$command` / `$deactivate` calls;
 *  5. report `status: ready` (or `error`).
 */
import { Component, useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { HostError, PluginContextProvider, type JsonValue, type PluginModule, type TileProps } from '@quadflow/plugin-api'
import { applyTheme, configureUi } from '@quadflow/ui'
import { connectRpc, windowEndpoint, type RpcFrame, type RpcTheme, type RpcTileInit } from '@quadflow/plugin-api/rpc'
import './runtime.css'

interface Boot {
  pluginId: string
  entry: string
  dev: boolean
}

function readBoot(): Boot {
  const el = document.getElementById('qf-frame')
  return JSON.parse(el?.textContent ?? '{}') as Boot
}

function themeVars(t: RpcTheme): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const [k, v] of Object.entries(t.colors)) if (v) vars[k] = v
  for (const [k, v] of Object.entries(t.terminal)) if (v) vars[`term-${k}`] = v
  for (const [k, v] of Object.entries(t.scalars)) if (v) vars[k] = v
  return vars
}

function applyFrameTheme(t: RpcTheme) {
  applyTheme({ mode: t.preference, vars: themeVars(t) })
  document.documentElement.style.colorScheme = t.mode
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function showError(text: string) {
  const root = document.getElementById('root')
  if (!root) return
  root.textContent = ''
  const p = document.createElement('pre')
  p.className = 'qf-frame-error'
  p.textContent = text
  root.appendChild(p)
}

class Boundary extends Component<{ onError(e: Error): void; children?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  componentDidCatch(error: Error) {
    this.props.onError(error)
  }
  render() {
    return this.state.error ? <pre className="qf-frame-error">{this.state.error.message}</pre> : this.props.children
  }
}

function renderTile(rpc: RpcFrame, Tile: ComponentType<TileProps>, init: RpcTileInit) {
  let snap = { mode: init.mode, visible: init.visible }
  const listeners = new Set<() => void>()
  rpc.onCtx((m) => {
    if (m.visible === undefined && m.mode === undefined) return
    snap = { mode: m.mode ?? snap.mode, visible: m.visible ?? snap.visible }
    listeners.forEach((l) => l())
  })
  const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }

  function App() {
    const s = useSyncExternalStore(subscribe, () => snap)
    const props = useMemo<TileProps>(
      () => ({
        ctx: rpc.ctx,
        instance: init.instance,
        config: init.config,
        mode: s.mode,
        visible: s.visible,
        setTitle: (title) => rpc.ui('setTitle', title),
        setState: (state: JsonValue) => rpc.ui('setState', state),
        setAttention: (on) => rpc.ui('setAttention', on),
        close: () => rpc.ui('close'),
      }),
      [s],
    )
    return (
      <PluginContextProvider value={rpc.ctx}>
        <Tile {...props} />
      </PluginContextProvider>
    )
  }

  createRoot(document.getElementById('root')!).render(
    <Boundary
      onError={(e) => {
        rpc.ctx.log.error('tile crashed:', e)
        rpc.status('error', e.message)
      }}
    >
      <App />
    </Boundary>,
  )
}

async function main() {
  const boot = readBoot()
  const rpc = await connectRpc(windowEndpoint())
  const { init, ctx } = rpc

  applyFrameTheme(init.theme)
  ctx.ui.onThemeChange((t) => applyFrameTheme(t as RpcTheme))
  configureUi({
    overlay: { register: (id) => ctx.overlay.register(id, true), unregister: (id) => ctx.overlay.register(id, false) },
    toast: (t) => ctx.notifications.toast({ title: t.title ?? '', body: t.message, kind: t.kind }),
  })
  window.addEventListener('error', (e) => ctx.log.error('uncaught:', e.message))
  window.addEventListener('unhandledrejection', (e) => ctx.log.error('unhandled rejection:', message(e.reason)))

  const fail = (text: string) => {
    showError(text)
    rpc.status('error', text)
  }

  let mod: PluginModule | undefined
  const url = boot.entry + (init.bust ? `?v=${encodeURIComponent(init.bust)}` : '')
  try {
    mod = ((await import(/* @vite-ignore */ url)) as { default?: PluginModule }).default
  } catch (e) {
    return fail(`Failed to load ${boot.entry}: ${message(e)}`)
  }
  if (!mod || typeof mod !== 'object') return fail(`${boot.entry} has no default export (use definePlugin())`)
  const module = mod

  if (init.role === 'background') {
    rpc.onCall('$command', async ([commandId, args]) => {
      const fn = module.commands?.[String(commandId)]
      if (!fn) throw new HostError('not_found', `plugin ${JSON.stringify(init.plugin.id)} has no command ${JSON.stringify(commandId)}`)
      return fn(ctx, (args ?? undefined) as JsonValue | undefined)
    })
    rpc.onCall('$deactivate', async () => {
      await module.deactivate?.()
    })
    try {
      await module.activate?.(ctx)
    } catch (e) {
      return fail(`activate() failed: ${message(e)}`)
    }
    rpc.status('ready')
    return
  }

  const tile = init.tile
  const Tile = tile ? module.tiles?.[tile.contributionId] : undefined
  if (!tile || !Tile) return fail(`Plugin "${init.plugin.id}" does not export a component for tile "${tile?.contributionId ?? '?'}"`)
  renderTile(rpc, Tile, tile)
  rpc.status('ready')
}

void main().catch((e) => showError(`QuadFlow sandbox runtime: ${message(e)}`))
