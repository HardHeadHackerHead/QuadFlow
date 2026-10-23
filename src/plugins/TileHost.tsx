/**
 * Renders a plugin tile in a mosaic pane or a toolbar flyout (plugin-system.md §5.4).
 *
 * Trusted plugins render as ordinary React children of the host (shared React
 * via the import map), wrapped in an ErrorBoundary ("Plugin crashed — Reload"),
 * Suspense, and a `PluginContextProvider` so `usePluginContext()` works anywhere
 * inside the tile. Missing / disabled / failed plugins render
 * `<MissingPluginTile>`. Sandboxed plugins render `<SandboxedTile>` (an iframe, §8.4).
 *
 * Props are the plugin-facing subset of `TileInstance` / `ToolConfig` plus
 * host callbacks, so both the shell's tool store and the global workspace's
 * tile instances can drive it.
 */
import { Component, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { PluginContextProvider, type JsonValue, type TileProps } from '@quadflow/plugin-api'
import { Button, Spinner } from '@quadflow/ui'
import { ensurePluginRegistry, usePluginRegistry } from './registry'
import { loadPluginModule, type LoadedPluginModule } from './loader'
import MissingPluginTile from './MissingPluginTile'
import SandboxedTile from './SandboxedTile'
import { registerTile, setTileVisible } from './hostApi'

export interface TileHostProps {
  pluginId: string
  contributionId: string
  instance: { id: string; title: string; state: JsonValue }
  config: { id: string; name: string; settings: JsonValue }
  mode: 'pane' | 'flyout'
  visible: boolean
  onSetTitle?(title: string): void
  onSetState?(state: JsonValue): void
  onSetAttention?(needsAttention: boolean): void
  onClose?(): void
}

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; loaded: LoadedPluginModule }
  | { kind: 'error'; message: string }

export default function TileHost(props: TileHostProps) {
  const { pluginId, contributionId } = props
  const status = usePluginRegistry((s) => s.status)
  const plugin = usePluginRegistry((s) => s.plugins.find((p) => p.id === pluginId))
  const generation = usePluginRegistry((s) => s.generations[pluginId] ?? 0)
  const [state, setState] = useState<LoadState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    void ensurePluginRegistry()
  }, [])

  const active = plugin?.status.kind === 'active'
  useEffect(() => {
    if (!active) return
    let cancelled = false
    setState({ kind: 'loading' })
    loadPluginModule(pluginId).then(
      (loaded) => !cancelled && setState({ kind: 'ready', loaded }),
      (e) => !cancelled && setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      cancelled = true
    }
  }, [pluginId, active, generation, attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])

  if (status !== 'ready' && !plugin) return <Centered><Spinner /></Centered>
  if (!plugin || !active) {
    return <MissingPluginTile pluginId={pluginId} contributionId={contributionId} plugin={plugin} />
  }
  if (state.kind === 'loading') return <Centered><Spinner /></Centered>
  if (state.kind === 'error') return <PluginError pluginId={pluginId} message={state.message} onReload={retry} />

  if (plugin.isolation === 'sandboxed') {
    return (
      <SandboxedTile
        {...props}
        loaded={state.loaded}
        onReload={() => {
          void usePluginRegistry.getState().reload(pluginId)
        }}
      />
    )
  }

  const Tile = state.loaded.module.tiles?.[contributionId]
  if (!Tile) {
    return (
      <PluginError
        pluginId={pluginId}
        message={`Plugin "${pluginId}" does not export a component for tile "${contributionId}"`}
        onReload={retry}
      />
    )
  }
  return (
    <TrustedTile
      {...props}
      loaded={state.loaded}
      Tile={Tile}
      onReload={() => {
        void usePluginRegistry.getState().reload(pluginId)
      }}
    />
  )
}

function TrustedTile(
  props: TileHostProps & {
    loaded: LoadedPluginModule
    Tile: React.ComponentType<TileProps>
    onReload(): void
  },
) {
  const { loaded, Tile, instance, config, mode, visible, onSetTitle, onSetState, onSetAttention, onClose } = props
  const tileProps = useMemo<TileProps>(
    () => ({
      ctx: loaded.ctx,
      instance,
      config,
      mode,
      visible,
      setTitle: (t) => onSetTitle?.(t),
      setState: (s) => onSetState?.(s),
      setAttention: (a) => onSetAttention?.(a),
      close: () => onClose?.(),
    }),
    [loaded.ctx, instance, config, mode, visible, onSetTitle, onSetState, onSetAttention, onClose],
  )

  // Host-API tile registry: ui.closeTile/focusTile, notifications.attention,
  // native.tileGeometry/onTileGeometry (plugin-system.md §6.7).
  const rootRef = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onSetAttention, onClose })
  callbacks.current = { onSetAttention, onClose }
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    return registerTile({
      instanceId: instance.id,
      pluginId: loaded.id,
      contributionId: props.contributionId,
      el,
      visible: visibleRef.current,
      setAttention: (a) => callbacks.current.onSetAttention?.(a),
      close: () => callbacks.current.onClose?.(),
    })
  }, [instance.id, loaded.id, props.contributionId])
  useEffect(() => setTileVisible(instance.id, visible), [instance.id, visible])

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="h-full w-full overflow-auto outline-none"
      data-plugin-id={loaded.id}
      data-plugin-tile={props.contributionId}
      data-plugin-instance={instance.id}
    >
      <PluginErrorBoundary pluginId={loaded.id} onReload={props.onReload} resetKey={loaded.generation}>
        <Suspense fallback={<Centered><Spinner /></Centered>}>
          <PluginContextProvider value={loaded.ctx}>
            <Tile {...tileProps} />
          </PluginContextProvider>
        </Suspense>
      </PluginErrorBoundary>
    </div>
  )
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="h-full w-full flex items-center justify-center text-vibe-muted">{children}</div>
}

function PluginError({ pluginId, message, onReload }: { pluginId: string; message: string; onReload(): void }) {
  return (
    <Centered>
      <div className="max-w-md text-center px-4">
        <p className="text-sm font-medium text-vibe-text">Plugin “{pluginId}” crashed</p>
        <p className="mt-1 text-xs break-words">{message}</p>
        <Button className="mt-3" size="sm" onClick={onReload}>
          Reload
        </Button>
      </div>
    </Centered>
  )
}

interface BoundaryProps {
  pluginId: string
  resetKey: number
  onReload(): void
  children: ReactNode
}
interface BoundaryState {
  error: Error | null
  resetKey: number
}

class PluginErrorBoundary extends Component<BoundaryProps, BoundaryState> {
  state: BoundaryState = { error: null, resetKey: this.props.resetKey }

  static getDerivedStateFromError(error: Error): Partial<BoundaryState> {
    return { error }
  }

  static getDerivedStateFromProps(props: BoundaryProps, state: BoundaryState): Partial<BoundaryState> | null {
    return props.resetKey !== state.resetKey ? { error: null, resetKey: props.resetKey } : null
  }

  componentDidCatch(error: Error) {
    console.error(`[plugin:${this.props.pluginId}] tile crashed:`, error)
  }

  render() {
    if (this.state.error) {
      return (
        <PluginError
          pluginId={this.props.pluginId}
          message={this.state.error.message}
          onReload={() => {
            this.setState({ error: null })
            this.props.onReload()
          }}
        />
      )
    }
    return this.props.children
  }
}
