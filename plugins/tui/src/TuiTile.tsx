/**
 * The `run` tile: a terminal program in a PTY the plugin owns.
 *
 * The program comes from the tool config's settings (`configSchema`:
 * executable, args, working directory, init commands) or, for an ad-hoc tile
 * opened by "Run Program in Tile…", from the tile state. The PTY id is kept in
 * the tile state, so a remount — reopening a flyout, a layout change, a plugin
 * reload — re-attaches to the running program instead of starting it again.
 * The PTY is killed when the tile is closed for good (`ui.onTileClosed`).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { JsonValue, PluginContext, TileProps } from '@quadflow/plugin-api'
import { claimTileState } from '@quadflow/plugin-kit'
import { Button } from '@quadflow/ui'
import { commandLine, programFrom, resolveCwd, type TuiProgram } from './command'
import { forgetTerminal, rememberTerminal } from './model'

interface TuiState {
  terminalId?: string
  /** Ad-hoc program ("Run Program in Tile…"); otherwise the tool config's settings. */
  program?: TuiProgram
}

function stateOf(v: JsonValue): TuiState {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  const o = v as Record<string, JsonValue>
  return {
    terminalId: typeof o.terminalId === 'string' ? o.terminalId : undefined,
    program: programFrom(o.program) ?? undefined,
  }
}

const isWindows = () => /win/i.test(navigator.platform || navigator.userAgent)

async function startProgram(ctx: PluginContext, p: TuiProgram, title: string): Promise<string> {
  const win = isWindows()
  const h = await ctx.terminals.spawn({
    cwd: resolveCwd(p.workingDirectory, ctx.project.current()?.root),
    shell: win ? 'powershell' : 'default',
    initCommands: [...p.initCommands, commandLine(p, win ? 'powershell' : 'posix')],
    title,
  })
  return h.id
}

type Phase = { kind: 'starting' } | { kind: 'running'; terminalId: string } | { kind: 'exited'; terminalId: string } | { kind: 'error'; message: string }

export function TuiTile(props: TileProps) {
  const { ctx, instance, config } = props
  const [initial] = useState(() => stateOf(claimTileState(ctx, 'run', instance.state)))
  const program = initial.program ?? programFrom(config.settings)
  const [phase, setPhase] = useState<Phase>({ kind: 'starting' })
  const [generation, setGeneration] = useState(0)
  const hostRef = useRef<HTMLDivElement>(null)
  const persist = useRef(props.setState)
  persist.current = props.setState
  const terminalIdRef = useRef<string | undefined>(initial.terminalId)

  const attachable = ctx.api.has('terminals.attach')

  // Ad-hoc tiles ("Run Program in Tile…") are titled after their program.
  const setTitle = useRef(props.setTitle)
  setTitle.current = props.setTitle
  useEffect(() => {
    if (initial.program) setTitle.current(initial.program.executablePath)
  }, [initial.program])

  // Find (or start) the PTY.
  useEffect(() => {
    if (!program || !attachable) return
    let cancelled = false
    void (async () => {
      try {
        let id = terminalIdRef.current
        if (id) {
          const own = await ctx.terminals.list()
          if (!own.some((t) => t.id === id)) id = undefined
        }
        if (!id) {
          setPhase({ kind: 'starting' })
          // Kept even if the tile unmounted meanwhile: the state records it for the next mount.
          id = await startProgram(ctx, program, config.name)
          terminalIdRef.current = id
          persist.current({ terminalId: id, ...(initial.program ? { program: initial.program as unknown as JsonValue } : {}) })
        }
        rememberTerminal(instance.id, id)
        if (!cancelled) setPhase({ kind: 'running', terminalId: id })
      } catch (e) {
        if (!cancelled) setPhase({ kind: 'error', message: e instanceof Error ? e.message : String(e) })
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, generation, attachable, JSON.stringify(program)])

  // Mount the terminal view; unmounting only detaches the view (the program keeps running).
  const terminalId = phase.kind === 'running' || phase.kind === 'exited' ? phase.terminalId : null
  useEffect(() => {
    const el = hostRef.current
    if (!el || !terminalId) return
    const detach = ctx.terminals.attach(terminalId, el)
    const offExit = ctx.terminals.onExit(terminalId, () => {
      forgetTerminal(instance.id)
      setPhase({ kind: 'exited', terminalId })
    })
    requestAnimationFrame(() => el.querySelector<HTMLTextAreaElement>('textarea')?.focus())
    return () => {
      offExit()
      detach()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx, terminalId, instance.id])

  const restart = useCallback(() => {
    const id = terminalIdRef.current
    terminalIdRef.current = undefined
    if (id) void ctx.terminals.kill(id).catch(() => {})
    forgetTerminal(instance.id)
    setGeneration((g) => g + 1)
  }, [ctx, instance.id])

  if (!attachable) {
    return <Message title="Not supported here" body="This host cannot show terminals in plugin tiles (terminals.attach)." />
  }
  if (!program) {
    return (
      <Message
        title="No program configured"
        body={`Set the executable of "${config.name}" in its tool settings (Tools → edit), or use "Run Program in Tile…" from the command palette.`}
      />
    )
  }
  if (phase.kind === 'error') {
    return (
      <Message title="Failed to start the program" body={phase.message}>
        <Button size="sm" onClick={restart}>
          Retry
        </Button>
      </Message>
    )
  }

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg" data-testid="tui-tile" data-terminal-id={terminalId ?? ''}>
      <div className="relative flex-1 min-h-0">
        <div
          ref={hostRef}
          className="absolute inset-0"
          style={{ padding: 4 }}
          data-testid="tui-terminal"
          onClick={() => hostRef.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus()}
        />
        {phase.kind === 'starting' && (
          <div className="absolute inset-0 flex items-center justify-center text-vibe-muted">
            <div className="text-center">
              <div className="animate-spin w-8 h-8 border-2 border-vibe-primary border-t-transparent rounded-full mx-auto mb-2" />
              <p className="text-sm">Starting {program.executablePath}…</p>
            </div>
          </div>
        )}
      </div>
      {phase.kind === 'exited' && (
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 border-t border-vibe-border bg-vibe-bg-lighter text-xs" data-testid="tui-exited">
          <span className="text-vibe-muted">The program's terminal has closed.</span>
          <Button size="sm" onClick={restart}>
            Restart
          </Button>
        </div>
      )}
    </div>
  )
}

function Message({ title, body, children }: { title: string; body: string; children?: ReactNode }) {
  return (
    <div className="h-full w-full flex items-center justify-center bg-vibe-bg text-vibe-muted px-6">
      <div className="text-center max-w-md space-y-2">
        <p className="text-sm font-medium text-vibe-text">{title}</p>
        <p className="text-xs break-words">{body}</p>
        {children}
      </div>
    </div>
  )
}
