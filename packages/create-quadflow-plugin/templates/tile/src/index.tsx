/**
 * {{name}} — QuadFlow plugin module.
 *
 * `definePlugin()` lists what this module implements for the contributions declared in
 * quadflow-plugin.json: the `main` tile and the `hello` command. Everything QuadFlow offers is
 * reached through `ctx` (the host API; see the @quadflow/plugin-api reference).
 */
import { useEffect, useRef, useState } from 'react'
import { definePlugin, type JsonValue, type TileProps } from '@quadflow/plugin-api'
import { Button, Card } from '@quadflow/ui'
import './style.css'

interface TileState {
  count: number
}

/** `instance.state` is whatever the tile last passed to `setState()` (or null for a new tile). */
function readState(state: JsonValue): TileState {
  const count = state && typeof state === 'object' && !Array.isArray(state) ? state.count : undefined
  return { count: typeof count === 'number' ? count : 0 }
}

function MainTile({ ctx, instance, setState, mode }: TileProps) {
  // Persisted per tile instance: survives hot reloads, closing a flyout and app restarts.
  const [count, setCount] = useState(() => readState(instance.state).count)
  const [greeting, setGreeting] = useState(() => ctx.settings.get<string>('greeting') ?? 'Hello')

  useEffect(() => ctx.settings.onDidChange((key, value) => key === 'greeting' && setGreeting(String(value))), [ctx])
  // Store every change with the tile instance (through a ref: `setState` is not a stable identity).
  const save = useRef(setState)
  save.current = setState
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    save.current({ count })
  }, [count])

  const bump = (delta: number) => setCount((c) => c + delta)

  return (
    <div className="{{cls}}">
      <Card padding="md">
        <h2 className="{{cls}}__title">{greeting} from {{name}}</h2>
        <p className="{{cls}}__muted">
          Plugin <code>{ctx.plugin.id}</code> {ctx.plugin.version} · {ctx.plugin.isolation} · {mode}
        </p>
        <div className="{{cls}}__row">
          <Button variant="secondary" onClick={() => bump(-1)}>
            −1
          </Button>
          <span className="{{cls}}__count" data-testid="{{cls}}-count">
            {count}
          </span>
          <Button variant="primary" onClick={() => bump(1)}>
            +1
          </Button>
        </div>
        <p className="{{cls}}__muted">Project: {ctx.project.current()?.name ?? 'none'}</p>
      </Card>
    </div>
  )
}

export default definePlugin({
  activate(ctx) {
    ctx.log.info('{{id}} activated')
  },
  tiles: { main: MainTile },
  commands: {
    hello: (ctx) => {
      ctx.notifications.toast({ title: `${ctx.settings.get<string>('greeting') ?? 'Hello'} from {{name}}`, kind: 'success' })
    },
  },
})
