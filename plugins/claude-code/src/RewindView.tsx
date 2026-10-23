/**
 * Rewind points of a Claude Code session (command `rewind`, agent-providers.md
 * §9; port of the former `RewindDropdown` + `lib.rs` rewind commands). Lists one
 * point per human prompt with the edits that followed; when opened for a live
 * terminal, "Rewind here" drives Claude Code's own `/rewind` picker in it.
 */
import { useCallback, useEffect, useState } from 'react'
import { create } from 'zustand'
import { usePluginContext, type PluginContext } from '@quadflow/plugin-api'
import { Badge, Button, EmptyState, Spinner } from '@quadflow/ui'
import { errorMessage, sessionDirsFor } from './paths'
import { parseRewindPoints, titleFromSession, type RewindPoint } from './session'

/** What the `rewind` command asked for (module state, shared with the tile). */
export interface RewindTarget {
  terminalId?: string
  sessionId?: string
  cwd?: string
}
export const useRewindTarget = create<{ target: RewindTarget | null; set(t: RewindTarget | null): void }>((set) => ({
  target: null,
  set: (target) => set({ target }),
}))

export interface SessionFile {
  id: string
  /** Home-relative path. */
  path: string
  modifiedAt: number
  size: number
}

/** Claude Code session files recorded for `cwd`, newest first. */
export async function listSessionFiles(ctx: PluginContext, cwd: string): Promise<SessionFile[]> {
  const out = new Map<string, SessionFile>()
  for (const dir of sessionDirsFor(cwd)) {
    const entries = await ctx.fs.list(dir, 'home').catch(() => [])
    for (const e of entries) {
      if (e.kind !== 'file' || !e.name.endsWith('.jsonl')) continue
      const id = e.name.slice(0, -'.jsonl'.length)
      if (!out.has(id)) out.set(id, { id, path: `${dir}/${e.name}`, modifiedAt: e.modifiedAt, size: e.size })
    }
  }
  return [...out.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export function timeAgo(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000)
  if (!Number.isFinite(s) || s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Open Claude Code's `/rewind` picker and select `point`: the picker starts on
 * "current" at the bottom; turn N of T is T − N + 1 arrow-ups away.
 */
async function rewindTo(ctx: PluginContext, terminalId: string, point: RewindPoint, total: number) {
  await ctx.terminals.write(terminalId, '/rewind\r')
  await sleep(1500)
  for (let i = 0; i < total - point.turn + 1; i++) {
    await ctx.terminals.write(terminalId, '\x1b[A')
    await sleep(80)
  }
  await sleep(200)
  await ctx.terminals.write(terminalId, '\r')
}

function summary(p: RewindPoint): string | null {
  const parts: string[] = []
  if (p.filesModified.length) parts.push(`${p.filesModified.length} modified`)
  if (p.filesCreated.length) parts.push(`${p.filesCreated.length} created`)
  return parts.length ? parts.join(', ') : null
}

export function RewindView({ cwd }: { cwd: string }) {
  const ctx = usePluginContext()
  const target = useRewindTarget((s) => s.target)
  const [sessions, setSessions] = useState<SessionFile[] | null>(null)
  const [selected, setSelected] = useState<string | null>(target?.sessionId ?? null)
  const [points, setPoints] = useState<RewindPoint[] | null>(null)
  const [title, setTitle] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const terminalId = target?.terminalId && (!target.sessionId || target.sessionId === selected) ? target.terminalId : undefined
  const root = target?.cwd ?? cwd

  const loadSessions = useCallback(async () => {
    setError(null)
    try {
      const list = await listSessionFiles(ctx, root)
      setSessions(list)
      setSelected((cur) => cur ?? list[0]?.id ?? null)
    } catch (e) {
      setError(errorMessage(e))
      setSessions([])
    }
  }, [ctx, root])

  useEffect(() => {
    void loadSessions()
  }, [loadSessions])
  useEffect(() => {
    if (target?.sessionId) setSelected(target.sessionId)
  }, [target])

  useEffect(() => {
    const file = sessions?.find((s) => s.id === selected)
    setPoints(null)
    setTitle(null)
    if (!file) return
    let cancelled = false
    ctx.fs.readText(file.path, 'home').then(
      (text) => {
        if (cancelled) return
        setPoints(parseRewindPoints(text))
        setTitle(titleFromSession(text))
      },
      (e) => !cancelled && setError(errorMessage(e)),
    )
    return () => {
      cancelled = true
    }
  }, [ctx, sessions, selected])

  if (sessions === null) return <Spinner />
  if (sessions.length === 0) {
    return <EmptyState title="No Claude Code sessions" description={`No sessions recorded for ${root} yet.`} />
  }

  const newestFirst = points ? [...points].reverse() : []
  return (
    <div className="qf-cc__section" data-testid="claude-rewind">
      {error && <div className="qf-cc__error">{error}</div>}
      <div className="qf-cc__row">
        <h4 className="qf-cc__section-title">Sessions</h4>
        <span className="qf-cc__spacer" />
        <Button size="xs" variant="ghost" onClick={() => void loadSessions()}>
          Refresh
        </Button>
      </div>
      <ul className="qf-cc__list">
        {sessions.slice(0, 12).map((s) => (
          <li key={s.id} className={`qf-cc__item${s.id === selected ? ' qf-cc__item--active' : ''}`}>
            <button type="button" className="qf-cc__clickable qf-cc__row" onClick={() => setSelected(s.id)}>
              <code className="qf-cc__item-main">{s.id}</code>
              {s.id === target?.sessionId && target.terminalId && <Badge tone="primary">this terminal</Badge>}
              <span className="qf-cc__muted">{timeAgo(s.modifiedAt)}</span>
            </button>
          </li>
        ))}
      </ul>

      <h4 className="qf-cc__section-title">
        Rewind points{title ? ` — ${title}` : ''}
        {points && <span className="qf-cc__muted">{points.length}</span>}
      </h4>
      {!terminalId && (
        <div className="qf-cc__muted">
          Read-only: open this from a Claude terminal&apos;s menu to rewind it, or type <code>/rewind</code> in the session.
        </div>
      )}
      {points === null ? (
        <Spinner />
      ) : points.length === 0 ? (
        <div className="qf-cc__muted">No prompts in this session.</div>
      ) : (
        newestFirst.map((p) => (
          <div key={`${p.turn}:${p.uuid}`} className="qf-cc__point" data-testid="claude-rewind-point">
            <div className="qf-cc__point-head">
              <Badge tone="neutral">#{p.turn}</Badge>
              <span className="qf-cc__point-prompt" title={p.prompt}>
                {p.prompt}
              </span>
              {p.timestamp && <span className="qf-cc__muted">{timeAgo(Date.parse(p.timestamp))}</span>}
              {terminalId && (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await rewindTo(ctx, terminalId, p, points.length)
                    } catch (e) {
                      setError(errorMessage(e))
                    } finally {
                      setBusy(false)
                    }
                  }}
                >
                  Rewind here
                </Button>
              )}
            </div>
            {(summary(p) || p.linesAdded > 0 || p.linesRemoved > 0) && (
              <div className="qf-cc__muted" title={[...p.filesModified, ...p.filesCreated].join('\n')}>
                {summary(p)} {p.linesAdded > 0 && <span className="qf-cc__add">+{p.linesAdded}</span>}{' '}
                {p.linesRemoved > 0 && <span className="qf-cc__del">-{p.linesRemoved}</span>}
              </div>
            )}
          </div>
        ))
      )}
    </div>
  )
}
