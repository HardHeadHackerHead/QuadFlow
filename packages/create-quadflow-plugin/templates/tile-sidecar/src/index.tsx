/**
 * {{name}} — QuadFlow plugin module with a sidecar.
 *
 * The sidecar is a separate process (see sidecar/) that QuadFlow starts on the first request
 * and restarts after crashes or rebuilds. The tile talks to it with `ctx.sidecar.request()`;
 * the sidecar can call back into the host API (`host.call('storage.get', …)`) with this
 * plugin's permissions.
 */
import { useEffect, useState } from 'react'
import { definePlugin, type JsonValue, type SidecarStatus, type TileProps } from '@quadflow/plugin-api'
import { Badge, Button, Card, Input } from '@quadflow/ui'
import './style.css'

interface Greeting {
  message: string
  pid: number
  calls: number
}

function readName(state: JsonValue): string {
  const name = state && typeof state === 'object' && !Array.isArray(state) ? state.name : undefined
  return typeof name === 'string' ? name : 'world'
}

function MainTile({ ctx, instance, setState }: TileProps) {
  const [name, setName] = useState(() => readName(instance.state))
  const [reply, setReply] = useState<Greeting | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [status, setStatus] = useState<SidecarStatus | null>(null)

  useEffect(() => {
    void ctx.sidecar.status().then(setStatus)
    return ctx.sidecar.onStatus(setStatus)
  }, [ctx])

  const greet = async () => {
    setError(null)
    try {
      setReply(await ctx.sidecar.request<Greeting>('greet', { name }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="{{cls}}">
      <Card padding="md">
        <h2 className="{{cls}}__title">{{name}}</h2>
        <p className="{{cls}}__muted">
          Sidecar: <Badge tone={status?.state === 'running' ? 'success' : 'neutral'}>{status?.state ?? '…'}</Badge>
          {status?.pid ? ` pid ${status.pid}` : ''}
        </p>
        <div className="{{cls}}__row">
          <Input
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setState({ name: e.target.value })
            }}
            aria-label="Name"
          />
          <Button variant="primary" onClick={() => void greet()}>
            Greet
          </Button>
        </div>
        {reply && (
          <p data-testid="{{cls}}-reply">
            {reply.message} <span className="{{cls}}__muted">(pid {reply.pid}, call #{reply.calls})</span>
          </p>
        )}
        {error && <p className="{{cls}}__error">{error}</p>}
        <Button size="sm" variant="ghost" onClick={() => void ctx.sidecar.restart()}>
          Restart sidecar
        </Button>
      </Card>
    </div>
  )
}

export default definePlugin({
  tiles: { main: MainTile },
  commands: {
    hello: async (ctx) => {
      const r = await ctx.sidecar.request<Greeting>('greet', { name: 'command' })
      ctx.notifications.toast({ title: r.message, kind: 'success' })
    },
  },
})
