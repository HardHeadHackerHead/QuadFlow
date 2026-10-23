/**
 * The output panel: one tab per run, the active run's terminal attached with
 * `ctx.terminals.attach` (an xterm view of the PTY; input goes to the script).
 * A stopped run's PTY is gone, so it shows the output the model kept.
 */
import { useEffect, useRef, useState } from 'react'
import type { PluginContext } from '@quadflow/plugin-api'
import { stripAnsi, type Run, type RunStatus, type ScriptsModel } from './model'

const DOT: Record<RunStatus, string> = {
  starting: 'bg-amber-400 animate-pulse',
  running: 'bg-green-500 animate-pulse',
  completed: 'bg-gray-500',
  failed: 'bg-red-500',
  stopped: 'bg-gray-600',
}

function statusText(r: Run): string {
  switch (r.status) {
    case 'starting':
      return 'starting'
    case 'running':
      return 'running'
    case 'completed':
      return r.exitCode === null ? 'done' : `exit ${r.exitCode}`
    case 'failed':
      return r.error ? 'failed to start' : `exit ${r.exitCode ?? '?'}`
    case 'stopped':
      return 'stopped'
  }
}

function KeptOutput({ model, run }: { model: ScriptsModel; run: Run }) {
  const [text, setText] = useState(() => stripAnsi(model.output(run.id)))
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => {
    if (run.status !== 'running' && run.status !== 'starting') {
      setText(stripAnsi(model.output(run.id)))
      return
    }
    const t = setInterval(() => setText(stripAnsi(model.output(run.id))), 500)
    return () => clearInterval(t)
  }, [model, run.id, run.status])
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [text])
  return (
    <pre ref={ref} className="absolute inset-0 m-0 p-2 overflow-auto text-xs font-mono text-vibe-text whitespace-pre-wrap" data-run-output={run.label}>
      {run.error ? `${run.error}\n` : ''}
      {text}
    </pre>
  )
}

function RunView({ ctx, model, run, visible }: { ctx: PluginContext; model: ScriptsModel; run: Run; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const canAttach = ctx.api.has('terminals.attach')
  const attach = canAttach && visible && run.alive && !!run.terminalId
  useEffect(() => {
    if (!attach || !ref.current || !run.terminalId) return
    try {
      return ctx.terminals.attach(run.terminalId, ref.current)
    } catch (e) {
      ctx.log.warn('attach failed:', e)
    }
  }, [ctx, attach, run.terminalId])
  if (!attach) return <KeptOutput model={model} run={run} />
  return <div ref={ref} className="absolute inset-1" data-run-terminal={run.label} />
}

export function RunPanel({ ctx, model, compact, visible }: { ctx: PluginContext; model: ScriptsModel; compact: boolean; visible: boolean }) {
  const runs = model.runsStore((s) => s.runs)
  const activeRunId = model.runsStore((s) => s.activeRunId)
  const expanded = model.ui((s) => s.panelExpanded)
  if (runs.length === 0) return null
  const active = runs.find((r) => r.id === activeRunId) ?? runs[runs.length - 1]
  const live = active.alive && (active.status === 'running' || active.status === 'starting')

  return (
    <div className={`flex-shrink-0 border-t border-vibe-border flex flex-col ${expanded ? (compact ? 'h-52' : 'h-[45%] min-h-[180px]') : ''}`} data-scripts-panel>
      <div className="flex items-center px-1.5 py-1 bg-vibe-bg-lighter border-b border-vibe-border gap-1">
        <button
          onClick={() => model.ui.setState({ panelExpanded: !expanded })}
          className="p-1 text-vibe-muted hover:text-vibe-text rounded"
          title={expanded ? 'Collapse output' : 'Expand output'}
        >
          <svg className={`w-3.5 h-3.5 transition-transform ${expanded ? '' : 'rotate-180'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        <div className="flex-1 flex gap-1 overflow-x-auto min-w-0">
          {runs.map((r) => (
            <div
              key={r.id}
              onClick={() => model.runsStore.setState({ activeRunId: r.id })}
              data-run-label={r.label}
              data-run-status={r.status}
              title={`${r.label} — ${statusText(r)}`}
              className={`flex items-center gap-1.5 px-2 py-0.5 text-xs rounded cursor-pointer whitespace-nowrap ${
                r.id === active.id ? 'bg-vibe-bg border border-teal-500/50 text-vibe-text' : 'text-vibe-muted hover:bg-vibe-bg hover:text-vibe-text'
              }`}
            >
              <span className={`w-2 h-2 rounded-full flex-shrink-0 ${DOT[r.status]}`} />
              <span className="max-w-[110px] truncate">{r.label}</span>
              {!compact && <span className="text-[10px] opacity-60">{statusText(r)}</span>}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  void model.close(r.id)
                }}
                className="p-0.5 rounded hover:bg-vibe-bg-lighter"
                title={r.status === 'running' ? 'Stop and close' : 'Close'}
              >
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
        {live && (
          <button
            onClick={() => void model.stop(active.id)}
            className="flex items-center gap-1 px-2 py-0.5 text-xs text-red-400 hover:bg-red-500/10 rounded"
            title={`Stop ${active.label}`}
          >
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 6h12v12H6z" />
            </svg>
            Stop
          </button>
        )}
        <button onClick={() => void model.closeAll()} className="p-1 text-vibe-muted hover:text-vibe-text rounded" title="Stop and close all">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div className="relative flex-1 min-h-0 bg-vibe-bg">
          <RunView key={active.id} ctx={ctx} model={model} run={active} visible={visible} />
        </div>
      )}
    </div>
  )
}
