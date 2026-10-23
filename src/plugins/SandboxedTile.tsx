/**
 * A sandboxed plugin's tile (plugin-system.md §8.4): an iframe on
 * `/_frame/<pluginId>?role=tile&tile=…&instance=…` with `sandbox="allow-scripts"`
 * (no `allow-same-origin`), connected to the host through `rpcBridge.ts`.
 *
 * Tile props cross as messages: `setTitle/setState/setAttention/close` arrive
 * as `ui` ops; `visible` / `mode` changes are pushed as `ctx`. While the frame
 * has a menu or modal open the iframe carries `data-qf-overlay`, so the overlay
 * contract (§6.7) sees an overlay over exactly this tile's rect.
 */
import { useEffect, useRef, useState } from 'react'
import type { JsonValue } from '@quadflow/plugin-api'
import { Button, Spinner } from '@quadflow/ui'
import type { TileHostProps } from './TileHost'
import type { LoadedPluginModule } from './loader'
import { registerFrame, type FrameHandle } from './rpcBridge'
import { createSandboxIframe, frameUrl } from './sandbox'
import { registerTile, setTileVisible } from './hostApi'
import { usePluginRegistry } from './registry'

type FrameState = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string }

export default function SandboxedTile(props: TileHostProps & { loaded: LoadedPluginModule; onReload(): void }) {
  const { pluginId, contributionId, instance, config, mode, visible, loaded } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<FrameHandle | null>(null)
  const [state, setState] = useState<FrameState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  // Latest props for callbacks without re-creating the frame.
  const live = useRef(props)
  live.current = props

  useEffect(() => {
    const host = hostRef.current
    const info = usePluginRegistry.getState().getPlugin(pluginId)
    if (!host || !info) return
    setState({ kind: 'loading' })
    const iframe = createSandboxIframe(`${pluginId}: ${instance.title || contributionId}`)
    iframe.className = 'block h-full w-full border-0 bg-transparent'
    iframe.dataset.qfSandbox = pluginId
    iframe.dataset.qfRole = 'tile'
    iframe.dataset.pluginInstance = instance.id
    const frame = registerFrame({
      iframe,
      info,
      ctx: loaded.ctx,
      role: 'tile',
      bust: loaded.bust,
      tile: () => ({
        contributionId,
        instance: { id: live.current.instance.id, title: live.current.instance.title, state: live.current.instance.state },
        config: live.current.config,
        mode: live.current.mode,
        visible: live.current.visible,
      }),
      onUi: (op, value) => {
        const p = live.current
        if (op === 'setTitle') p.onSetTitle?.(String(value ?? ''))
        else if (op === 'setState') p.onSetState?.((value ?? null) as JsonValue)
        else if (op === 'setAttention') p.onSetAttention?.(!!value)
        else if (op === 'close') p.onClose?.()
      },
      onStatus: (s, error) => setState(s === 'ready' ? { kind: 'ready' } : { kind: 'error', message: error ?? 'the plugin frame failed' }),
      onOverlay: (open) => {
        if (open) iframe.setAttribute('data-qf-overlay', '')
        else iframe.removeAttribute('data-qf-overlay')
      },
    })
    frameRef.current = frame
    iframe.src = frameUrl(pluginId, { role: 'tile', tile: contributionId, instance: instance.id, v: loaded.bust })
    host.appendChild(iframe)
    const unregister = registerTile({
      instanceId: instance.id,
      pluginId,
      contributionId,
      el: host,
      visible: live.current.visible,
      setAttention: (a) => live.current.onSetAttention?.(a),
      close: () => live.current.onClose?.(),
    })
    return () => {
      unregister()
      frame.dispose()
      frameRef.current = null
      iframe.remove()
    }
    // A new frame per instance, plugin load (generation) and manual reload.
  }, [pluginId, contributionId, instance.id, loaded, attempt]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setTileVisible(instance.id, visible)
    frameRef.current?.update({ visible, mode })
  }, [instance.id, visible, mode])

  // Tool settings edits reach the frame through a reload (config is init-time data).
  const configKey = JSON.stringify(config)
  const firstConfig = useRef(configKey)
  useEffect(() => {
    if (firstConfig.current !== configKey) {
      firstConfig.current = configKey
      setAttempt((n) => n + 1)
    }
  }, [configKey])

  return (
    <div
      className="relative h-full w-full outline-none"
      tabIndex={-1}
      data-plugin-id={pluginId}
      data-plugin-tile={contributionId}
      data-plugin-instance={instance.id}
      data-plugin-isolation="sandboxed"
    >
      <div ref={hostRef} className="absolute inset-0" />
      {state.kind === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-vibe-muted pointer-events-none">
          <Spinner />
        </div>
      )}
      {state.kind === 'error' && (
        <div className="absolute inset-0 flex items-center justify-center bg-vibe-bg text-vibe-muted">
          <div className="max-w-md text-center px-4">
            <p className="text-sm font-medium text-vibe-text">Plugin “{pluginId}” crashed</p>
            <p className="mt-1 text-xs break-words">{state.message}</p>
            <Button
              className="mt-3"
              size="sm"
              onClick={() => {
                setAttempt((n) => n + 1)
                props.onReload()
              }}
            >
              Reload
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
