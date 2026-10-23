/**
 * The Ship tool: release pipeline status, readiness checks, cut-a-release
 * buttons, run history and a live output pane. Ported from the shell's old
 * `ShipToolView`; everything goes through `ctx` (see ./model.ts).
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type {
  PluginContext,
  ShipDiagnostics_Serialize,
  ShipLineEvent,
  ShipPhaseEvent_Serialize,
  ShipPhaseResult_Serialize,
  ShipReadinessCheck_Serialize,
  ShipRunMode,
  ShipRun_Serialize,
  ShipStatus_Serialize,
  ShipTemplateInfo_Serialize,
  TileProps,
} from '@quadflow/plugin-api'
import { Modal } from '@quadflow/ui'
import { launchAgent } from '@quadflow/plugin-kit'
import { readinessBlocks, shipModel, phaseSummaryLine, type ShipRunFlags } from './model'
import { OutputPane } from './OutputPane'

type BumpType = 'patch' | 'minor' | 'major'
type ConfirmTarget = { mode: ShipRunMode; flags: ShipRunFlags; nextVersion: string }

const TOP_PANE_DEFAULT_PCT = 50
const TOP_PANE_MIN_PX = 240
const BOTTOM_PANE_MIN_PX = 140

/** Portal content (modal bodies/footers) needs the style scope too. */
const Scoped = ({ children }: { children: ReactNode }) => <div className="qf-ship">{children}</div>

function useProjectRoot(ctx: PluginContext): string | null {
  const [root, setRoot] = useState(() => ctx.project.current()?.root ?? null)
  useEffect(() => ctx.project.onDidChange((p) => setRoot(p?.root ?? null)), [ctx])
  return root
}

export function ShipTile({ ctx }: TileProps) {
  const model = shipModel(ctx)
  useEffect(() => model.retain(), [model])
  const s = model.use()
  const runs = model.runs.use((x) => x.items)
  const corruptRuns = model.runs.use((x) => x.corrupt.length)
  const projectDir = useProjectRoot(ctx)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [showConfirm, setShowConfirm] = useState<ConfirmTarget | null>(null)
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null)
  const [topPanePct, setTopPanePct] = useState(TOP_PANE_DEFAULT_PCT)
  const [terminalCollapsed, setTerminalCollapsed] = useState(false)

  // Readiness spawns a subprocess per check: refresh it rarely, never mid-run.
  useEffect(() => {
    if (!s.config || s.running) return
    const id = setInterval(() => void model.loadReadiness(), 120_000)
    return () => clearInterval(id)
  }, [s.config, s.running, model])

  // Follow the live run in the history list.
  useEffect(() => {
    if (s.running && s.liveRun && !s.liveRun.dryRun) setExpandedRunId(s.liveRun.id)
  }, [s.running, s.liveRun?.id, s.liveRun?.dryRun])

  if (!projectDir) {
    return <div className="h-full w-full flex items-center justify-center text-vibe-muted">Open a project to configure its release pipeline.</div>
  }

  if (!s.configLoaded) {
    return <div className="h-full w-full flex items-center justify-center text-vibe-muted">Loading…</div>
  }

  if (!s.config) {
    return <InitView ctx={ctx} />
  }

  const config = s.config
  const status = s.status
  const blocked = readinessBlocks(s.readiness)
  const nextVersions = computeNextVersions(status?.canonicalVersion ?? undefined)
  const effectiveTopPct = terminalCollapsed ? 100 : topPanePct
  const inProgress = s.running || runs.some((r) => r.status === 'in_progress')
  const replaying = s.replayingRun

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden" data-testid="ship-tool">
      <div className="overflow-auto" style={{ height: terminalCollapsed ? 'calc(100% - 28px)' : `${effectiveTopPct}%`, minHeight: TOP_PANE_MIN_PX }}>
        <div className="max-w-4xl mx-auto p-4 space-y-3">
          {s.error && <ErrorBanner error={s.error} onDismiss={model.clearError} />}
          <DiagnosticsBanner diagnostics={s.diagnostics} onRefresh={() => void model.loadAll()} />
          {corruptRuns > 0 && (
            <div className="text-xs bg-yellow-500/10 border border-yellow-500/40 text-yellow-400 px-3 py-2 rounded">
              {corruptRuns} run record file(s) could not be read.
            </div>
          )}
          {s.notices.length > 0 && (
            <div className="text-xs bg-yellow-500/10 border border-yellow-500/40 text-yellow-400 px-3 py-2 rounded">
              {s.notices.slice(-3).map((n, i) => (
                <div key={i}>
                  {n.kind === 'restored_backups' ? `Restored ${n.files?.length ?? 0} orphan backup(s) from a previous crashed run.` : n.kind}
                </div>
              ))}
            </div>
          )}

          <StatusCard status={status} productName={config.productName} />
          <ValidationBanner validation={s.validation} />
          <ReadinessChecklist
            ctx={ctx}
            checks={s.readiness}
            loading={s.readinessLoading}
            rechecking={s.rechecking}
            runningFixId={s.runningFix}
            onRefresh={() => void model.loadReadiness()}
            onRecheck={(id) => void model.recheckOne(id)}
            onRunFix={(id) => void model.runFix(id)}
          />

          <CutReleaseButtons
            running={s.running}
            blocked={blocked}
            canBump={(status?.inSync ?? false) && config.versionFiles.length > 0}
            current={status?.canonicalVersion ?? undefined}
            nextVersions={nextVersions}
            onChoose={(mode, flags) =>
              setShowConfirm({
                mode,
                flags,
                nextVersion: mode === 'deploy' ? status?.canonicalVersion || '?' : nextVersions[mode as BumpType] || '?',
              })
            }
            onDryRun={() => void model.run(config.versionFiles.length > 0 ? 'patch' : 'deploy', { dryRun: true })}
            onRestoreBackups={async () => {
              const restored = await model.restoreBackups()
              if (restored == null) return
              ctx.notifications.toast({
                kind: 'info',
                title: restored.length === 0 ? 'No orphan backups found' : `Restored ${restored.length} backup(s)`,
                body: restored.length ? restored.join('\n') : undefined,
              })
            }}
            onAbort={() => void model.abort()}
            showAbort={inProgress}
          />

          {s.liveRun?.dryRun && (
            <div className="bg-vibe-surface rounded-lg border border-purple-700" data-testid="ship-dry-run">
              <div className="px-3 py-2 border-b border-vibe-border text-sm font-semibold flex items-center gap-2">
                Dry-run plan · v{s.liveRun.version} <RunStatusBadge status={s.liveRun.status} />
              </div>
              <div className="px-3 py-2">
                <PhaseTimeline phases={s.liveRun.phases} />
              </div>
            </div>
          )}

          <RunHistorySection
            ctx={ctx}
            runs={runs}
            liveRun={s.running ? s.liveRun : null}
            expandedRunId={expandedRunId}
            setExpandedRunId={setExpandedRunId}
            liveProgress={s.running ? s.liveProgress : null}
            replayingRunId={replaying?.id ?? null}
            onViewOutput={model.enterReplay}
          />

          <div className="flex items-center justify-between text-[11px] text-vibe-muted px-1 gap-3">
            <span className="truncate">
              {config.phases.length} phases · {config.versionFiles.length} version files
            </span>
            <span className="flex items-center gap-3 flex-shrink-0">
              <button onClick={() => void launchSetupShip(ctx)} className="text-vibe-primary hover:underline" title="Start an agent with the setup-ship skill">
                Configure with an agent…
              </button>
              <span className="text-vibe-muted opacity-60">|</span>
              <button
                onClick={() => setShowResetConfirm(true)}
                className="underline hover:text-vibe-text"
                title="Back up the current config to .bak and return to the template picker"
              >
                Reset
              </button>
            </span>
          </div>
        </div>
      </div>

      {!terminalCollapsed && <Splitter onDrag={(deltaPct) => setTopPanePct((p) => Math.min(85, Math.max(15, p + deltaPct)))} />}

      <div
        className={`border-t flex flex-col ${replaying ? 'border-yellow-700' : 'border-vibe-border'}`}
        style={{ height: terminalCollapsed ? '28px' : `${100 - effectiveTopPct}%`, minHeight: terminalCollapsed ? 28 : BOTTOM_PANE_MIN_PX }}
      >
        <div
          className={`flex items-center justify-between px-3 py-1 border-b text-xs ${replaying ? 'bg-yellow-500/10 border-yellow-500/40' : 'bg-vibe-surface border-vibe-border'}`}
        >
          <span className="flex items-center gap-2">
            <span className="font-semibold">{replaying ? `Replay: v${replaying.version}` : 'Output'}</span>
            {!replaying && s.running && (
              <span className="text-vibe-primary flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 bg-vibe-primary rounded-full animate-pulse" />
                live
              </span>
            )}
            {!replaying && s.runningFix && <span className="text-yellow-300">running fix: {s.runningFix}</span>}
            {!replaying && !s.running && s.terminalLines.length > 0 && (
              <span className="text-vibe-muted">
                {s.terminalLines.length} line{s.terminalLines.length === 1 ? '' : 's'}
              </span>
            )}
          </span>
          <span className="flex items-center gap-2">
            {replaying && (
              <button onClick={model.exitReplay} className="text-vibe-text hover:text-yellow-400">
                ← back to live
              </button>
            )}
            {!replaying && !terminalCollapsed && s.terminalLines.length > 0 && (
              <button onClick={model.clearTerminal} className="text-vibe-muted hover:text-vibe-text">
                clear
              </button>
            )}
            <button onClick={() => setTerminalCollapsed(!terminalCollapsed)} className="text-vibe-muted hover:text-vibe-text">
              {terminalCollapsed ? '▴ expand' : '▾ collapse'}
            </button>
          </span>
        </div>
        {!terminalCollapsed && (
          <div className="flex-1 overflow-hidden">
            <OutputPane lines={replaying ? historicalLines(replaying) : s.terminalLines} />
          </div>
        )}
      </div>

      <Modal open={showResetConfirm} onClose={() => setShowResetConfirm(false)} title="Reset ship config?" size="sm" overlayId="ship-reset"
        footer={
          <Scoped>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowResetConfirm(false)} className="px-3 py-1.5 text-sm border border-vibe-border rounded hover:bg-vibe-bg">Cancel</button>
              <button
                disabled={s.loading}
                onClick={() => {
                  setShowResetConfirm(false)
                  void model.deleteConfig()
                }}
                className="px-3 py-1.5 text-sm bg-vibe-primary text-white rounded hover:bg-opacity-90 disabled:opacity-50"
              >
                Reset
              </button>
            </div>
          </Scoped>
        }
      >
        <Scoped>
          <p className="text-xs text-vibe-muted mb-2">The current config moves to a <code>.bak</code> file and the panel returns to the template picker.</p>
          {s.diagnostics?.configPath && <p className="text-[11px] text-vibe-muted font-mono break-all mb-2">{s.diagnostics.configPath}</p>}
          <p className="text-[11px] text-vibe-muted">An older backup is overwritten. Run history is kept.</p>
        </Scoped>
      </Modal>

      {showConfirm && (
        <ConfirmRunDialog
          target={showConfirm}
          status={status}
          readiness={s.readiness}
          runsDir={s.diagnostics?.runsDir ?? null}
          onCancel={() => setShowConfirm(null)}
          onConfirm={() => {
            const t = showConfirm
            setShowConfirm(null)
            void model.run(t.mode, t.flags)
          }}
        />
      )}
    </div>
  )
}

// ---- Sub-components ----

function StatusCard({ status, productName }: { status: ShipStatus_Serialize | null; productName: string }) {
  if (!status) return null
  return (
    <div className="bg-vibe-surface rounded-lg p-3 border border-vibe-border" data-testid="ship-status">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        <div>
          <div className="text-vibe-muted text-xs">{productName}</div>
          <div className={`font-semibold ${status.inSync ? '' : 'text-red-400'}`}>
            {status.inSync ? status.canonicalVersion ?? 'no version files' : 'OUT OF SYNC'}
          </div>
        </div>
        <div>
          <div className="text-vibe-muted text-xs">Branch</div>
          <div className="font-semibold">{status.branch ?? '?'}</div>
        </div>
        <div>
          <div className="text-vibe-muted text-xs">Tree</div>
          <div className={`font-semibold ${status.gitClean === false ? 'text-yellow-400' : ''}`}>
            {status.gitClean === true ? 'clean' : status.gitClean === false ? 'DIRTY' : 'unknown'}
          </div>
        </div>
        <div>
          <div className="text-vibe-muted text-xs">Last run</div>
          <div className="font-semibold flex items-center gap-2">
            {status.lastRun ? (
              <>
                v{status.lastRun.version} <RunStatusBadge status={status.lastRun.status} />
              </>
            ) : (
              <span className="text-vibe-muted">none</span>
            )}
          </div>
        </div>
      </div>
      {!status.inSync && (
        <ul className="mt-2 text-[11px] text-red-300 ml-4 list-disc">
          {status.versionFiles.map((f) => (
            <li key={f.file}>
              <code>{f.file}</code>: {f.current ?? f.error}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ReadinessChecklist({
  ctx, checks, loading, rechecking, runningFixId, onRefresh, onRecheck, onRunFix,
}: {
  ctx: PluginContext
  checks: ShipReadinessCheck_Serialize[]
  loading: boolean
  rechecking: string[]
  runningFixId: string | null
  onRefresh: () => void
  onRecheck: (checkId: string) => void
  onRunFix: (checkId: string) => void
}) {
  const [note, setNote] = useState<string | null>(null)
  useEffect(() => {
    if (!note) return
    const id = setTimeout(() => setNote(null), 2000)
    return () => clearTimeout(id)
  }, [note])

  const copy = async (cmd: string) => {
    try {
      await ctx.clipboard.writeText(cmd)
      setNote(`Copied: ${cmd}`)
    } catch {
      setNote('Copy failed')
    }
  }

  const fails = checks.filter((c) => c.level === 'fail').length
  const warns = checks.filter((c) => c.level === 'warn').length
  const passes = checks.length - fails - warns

  return (
    <div className="bg-vibe-surface rounded-lg border border-vibe-border" data-testid="ship-readiness">
      <div className="px-3 py-2 border-b border-vibe-border flex items-center justify-between text-sm">
        <span className="font-semibold flex items-center gap-2">
          Readiness
          {loading && <span className="inline-block w-2 h-2 bg-vibe-muted rounded-full animate-pulse" />}
          <span className="text-xs text-vibe-muted">
            {passes} ✓ {warns > 0 && <span className="text-yellow-400">· {warns} ⚠</span>}
            {fails > 0 && <span className="text-red-400"> · {fails} ✗</span>}
          </span>
        </span>
        <button onClick={onRefresh} disabled={loading} className="text-xs text-vibe-muted hover:text-vibe-text disabled:opacity-50">
          ⟳ check all
        </button>
      </div>
      <div className="divide-y divide-vibe-border max-h-72 overflow-auto">
        {checks.length === 0 && !loading && (
          <div className="px-3 py-4 text-xs text-vibe-muted text-center">
            No checks configured. Add some to a <code>checks</code> phase.
          </div>
        )}
        {checks.map((c) => {
          const isRechecking = rechecking.includes(c.id)
          const isFixing = runningFixId === c.id
          return (
            <div key={c.id} className="px-3 py-1.5 text-xs flex items-start justify-between gap-2" data-ship-check={c.id} data-ship-check-level={c.level}>
              <span className="flex items-start gap-2 min-w-0 flex-1">
                {isRechecking ? (
                  <span className="inline-block w-3 h-3 mt-0.5 border-2 border-vibe-muted border-t-vibe-primary rounded-full animate-spin" />
                ) : (
                  <CheckIcon level={c.level} />
                )}
                <span className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={c.level === 'fail' ? 'text-red-300' : c.level === 'warn' ? 'text-yellow-300' : 'text-vibe-text'}>{c.label}</span>
                    {!c.fromConfig && <span className="text-[10px] text-vibe-muted opacity-70">auto</span>}
                  </div>
                  {c.hint && c.level !== 'pass' && <div className="text-vibe-muted text-[11px] mt-0.5">{c.hint}</div>}
                  {c.fixCommand && c.level !== 'pass' && (
                    <code className="text-[10px] text-vibe-muted opacity-80 mt-0.5 inline-block break-all">{c.fixCommand}</code>
                  )}
                </span>
              </span>
              <span className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={() => onRecheck(c.id)}
                  disabled={isRechecking || isFixing}
                  className="text-[10px] px-1.5 py-0.5 border border-vibe-border rounded hover:bg-vibe-bg disabled:opacity-50"
                  title="Re-run just this check"
                >
                  ⟳
                </button>
                {c.fixCommand && c.level !== 'pass' && (
                  <>
                    <button
                      onClick={() => void copy(c.fixCommand!)}
                      className="text-[10px] px-1.5 py-0.5 border border-vibe-border rounded hover:bg-vibe-bg"
                      title={`Copy: ${c.fixCommand}`}
                    >
                      copy
                    </button>
                    <button
                      onClick={() => onRunFix(c.id)}
                      disabled={isFixing || isRechecking}
                      className="text-[10px] px-1.5 py-0.5 border border-vibe-border rounded hover:bg-vibe-bg disabled:opacity-40 disabled:cursor-not-allowed"
                      title={`Run: ${c.fixCommand}`}
                    >
                      {isFixing ? '…' : 'run'}
                    </button>
                  </>
                )}
              </span>
            </div>
          )
        })}
      </div>
      {note && <div className="px-3 py-1.5 border-t border-vibe-border text-[11px] text-vibe-primary">{note}</div>}
    </div>
  )
}

function CheckIcon({ level }: { level: ShipReadinessCheck_Serialize['level'] }) {
  if (level === 'pass') return <span className="inline-block text-green-400 mt-0.5">✓</span>
  if (level === 'warn') return <span className="inline-block text-yellow-400 mt-0.5">⚠</span>
  return <span className="inline-block text-red-400 mt-0.5">✗</span>
}

function CutReleaseButtons({
  running, blocked, canBump, current, nextVersions, onChoose, onDryRun, onRestoreBackups, onAbort, showAbort,
}: {
  running: boolean
  blocked: boolean
  canBump: boolean
  current?: string
  nextVersions: Record<BumpType, string>
  onChoose: (mode: ShipRunMode, flags: ShipRunFlags) => void
  onDryRun: () => void
  onRestoreBackups: (() => void) | null
  onAbort: () => void
  showAbort: boolean
}) {
  const bumpDisabled = running || blocked || !canBump
  const deployDisabled = running || blocked
  const bumpReason = !canBump ? 'version files missing or out of sync' : blocked ? 'fix blocking checks first' : running ? 'a run is in progress' : null
  const deployReason = blocked ? 'fix blocking checks first' : running ? 'a run is in progress' : null
  const btn = 'px-3 py-2 bg-vibe-bg border border-vibe-border rounded hover:bg-vibe-primary/20 disabled:opacity-40 disabled:cursor-not-allowed text-sm'
  const small = 'px-2 py-1 border border-vibe-border rounded hover:bg-vibe-primary/20 disabled:opacity-40'
  return (
    <div className="bg-vibe-surface rounded-lg p-3 border border-vibe-border">
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-semibold text-sm">Cut a release</h3>
        {running && (
          <span className="text-xs text-vibe-primary flex items-center gap-2" data-testid="ship-running">
            <span className="inline-block w-2 h-2 bg-vibe-primary rounded-full animate-pulse" />
            running…
          </span>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {(['patch', 'minor', 'major'] as BumpType[]).map((bt) => (
          <button
            key={bt}
            disabled={bumpDisabled}
            onClick={() => onChoose(bt, { draft: true })}
            className={btn}
            title={bumpReason ? `Disabled: ${bumpReason}` : `Run the pipeline; bumps ${current ?? '?'} → ${nextVersions[bt] || '?'}`}
          >
            <div className="font-semibold capitalize">{bt}</div>
            <div className="text-xs text-vibe-muted">→ {nextVersions[bt] || '?'}</div>
          </button>
        ))}
        <button
          disabled={deployDisabled}
          onClick={() => onChoose('deploy', { draft: true })}
          className={btn}
          title={deployReason ? `Disabled: ${deployReason}` : `Re-ship the current version (${current ?? '?'}) without bumping`}
        >
          <div className="font-semibold">Deploy</div>
          <div className="text-xs text-vibe-muted">re-ship {current ?? 'current'}</div>
        </button>
        <button
          disabled={running}
          onClick={onDryRun}
          data-testid="ship-dry-run-button"
          className={`${btn} col-span-2 sm:col-span-1`}
          title="Resolve the phase plan with substituted tokens; nothing is executed or recorded"
        >
          <div className="font-semibold">Dry run</div>
          <div className="text-xs text-vibe-muted">preview plan</div>
        </button>
      </div>
      {bumpReason && !running && (
        <div className="mt-2 text-[11px] text-yellow-300">
          ⚠ Bump buttons disabled: {bumpReason}.{!blocked ? ' Deploy still works (re-ships the current version).' : ''}
        </div>
      )}
      <div className="flex flex-wrap gap-2 mt-3 text-xs">
        <button disabled={bumpDisabled} onClick={() => onChoose('patch', { reuseBuild: true, draft: true })} className={small}>
          Reuse build (sign + upload only)
        </button>
        <button disabled={bumpDisabled} onClick={() => onChoose('patch', { skipBuild: true, draft: true })} className={small}>
          Skip build phases
        </button>
        {onRestoreBackups && (
          <button disabled={running} onClick={onRestoreBackups} className={small}>
            Restore orphan backups
          </button>
        )}
        {showAbort && (
          <button onClick={onAbort} className="px-2 py-1 border border-red-500/50 text-red-400 rounded hover:bg-red-500/10" data-testid="ship-abort">
            Abort run
          </button>
        )}
      </div>
    </div>
  )
}

function RunStatusBadge({ status }: { status: ShipRun_Serialize['status'] }) {
  const cls = {
    completed: 'bg-green-500/15 text-green-400 border-green-500/40',
    failed: 'bg-red-500/15 text-red-400 border-red-500/40',
    in_progress: 'bg-blue-500/15 text-blue-400 border-blue-500/40 animate-pulse',
    aborted: 'bg-vibe-surface text-vibe-muted border-vibe-border',
    dry_run: 'bg-purple-500/15 text-purple-400 border-purple-500/40',
  }[status]
  return <span className={`text-[10px] uppercase px-1.5 py-0.5 rounded border ${cls}`}>{status.replace('_', ' ')}</span>
}

function PhaseStatusBadge({ status }: { status: ShipPhaseResult_Serialize['status'] }) {
  const map = {
    passed: { label: 'PASS', cls: 'bg-green-500/15 text-green-400' },
    failed: { label: 'FAIL', cls: 'bg-red-500/15 text-red-400' },
    skipped: { label: 'SKIP', cls: 'bg-vibe-surface text-vibe-muted' },
    running: { label: 'RUN', cls: 'bg-blue-500/15 text-blue-400 animate-pulse' },
    pending: { label: 'PEND', cls: 'bg-vibe-bg text-vibe-muted border border-vibe-border' },
  }[status]
  return <span className={`text-[10px] font-mono px-1.5 py-0.5 rounded ${map.cls}`}>{map.label}</span>
}

function ValidationBanner({ validation }: { validation: { valid: boolean; errors: string[] } | null }) {
  if (!validation || validation.valid) return null
  return (
    <div className="bg-red-500/10 border border-red-500/40 text-red-400 px-3 py-2 rounded text-xs">
      <div className="font-semibold mb-1">Config has {validation.errors.length} issue(s):</div>
      <ul className="ml-4 list-disc">
        {validation.errors.map((e, i) => (
          <li key={i}>{e}</li>
        ))}
      </ul>
    </div>
  )
}

function ErrorBanner({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  return (
    <div className="bg-red-500/10 border border-red-500/40 text-red-400 px-3 py-2 rounded text-xs flex justify-between" data-testid="ship-error">
      <span className="break-all">{error}</span>
      <button onClick={onDismiss} className="ml-3 text-red-400 hover:text-red-300">
        ×
      </button>
    </div>
  )
}

/** Phases of `run`, with the live run's streamed phases laid over them. */
function mergedPhases(run: ShipRun_Serialize, live: ShipRun_Serialize | null): ShipPhaseResult_Serialize[] {
  if (!live || live.id !== run.id) return run.phases
  const n = Math.max(run.phases.length, live.phases.length)
  return Array.from({ length: n }, (_, i) => live.phases[i] ?? run.phases[i]).filter(Boolean)
}

function RunHistorySection({
  ctx, runs, liveRun, expandedRunId, setExpandedRunId, liveProgress, replayingRunId, onViewOutput,
}: {
  ctx: PluginContext
  runs: ShipRun_Serialize[]
  liveRun: ShipRun_Serialize | null
  expandedRunId: string | null
  setExpandedRunId: (id: string | null) => void
  liveProgress: ShipPhaseEvent_Serialize | null
  replayingRunId: string | null
  onViewOutput: (run: ShipRun_Serialize) => void
}) {
  if (runs.length === 0) {
    return (
      <div className="bg-vibe-surface rounded-lg p-3 border border-vibe-border text-sm text-vibe-muted" data-testid="ship-history">
        No ship runs yet. Click a button above to cut your first release.
      </div>
    )
  }
  return (
    <div className="bg-vibe-surface rounded-lg border border-vibe-border" data-testid="ship-history">
      <div className="px-3 py-2 border-b border-vibe-border font-semibold text-sm">Run history</div>
      <div className="divide-y divide-vibe-border">
        {runs.slice(0, 15).map((r) => {
          const expanded = expandedRunId === r.id
          const isLive = liveProgress?.runId === r.id
          return (
            <div key={r.id} className="text-sm" data-ship-run={r.id} data-ship-run-status={r.status}>
              <div
                role="button"
                tabIndex={0}
                className="w-full px-3 py-1.5 flex items-center justify-between hover:bg-vibe-bg cursor-pointer"
                onClick={() => setExpandedRunId(expanded ? null : r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setExpandedRunId(expanded ? null : r.id)
                  }
                }}
              >
                <span className="flex items-center gap-3">
                  <span className="font-mono">v{r.version}</span>
                  <RunStatusBadge status={r.status} />
                  <span className="text-[10px] text-vibe-muted">{r.mode}</span>
                  {isLive && liveProgress && (
                    <span className="text-xs text-vibe-primary">
                      phase {liveProgress.index + 1}/{liveProgress.total}: {liveProgress.phase.name}
                    </span>
                  )}
                </span>
                <span className="flex items-center gap-3 text-xs text-vibe-muted">
                  <span title={new Date(r.startedAt).toLocaleString()}>{new Date(r.startedAt).toLocaleDateString()}</span>
                  {r.completedAt != null && <span>{Math.round((r.completedAt - r.startedAt) / 1000)}s</span>}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      onViewOutput(r)
                    }}
                    className={`text-[10px] px-1.5 py-0.5 border border-vibe-border rounded hover:bg-vibe-bg ${replayingRunId === r.id ? 'bg-yellow-500/15 text-yellow-400' : ''}`}
                    title="Show this run's saved output in the output pane"
                  >
                    view output
                  </button>
                  {r.releaseUrl && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation()
                        ctx.shell.openExternal(r.releaseUrl!).catch((err) => ctx.notifications.toast({ kind: 'error', title: 'Could not open the release', body: String(err?.message ?? err) }))
                      }}
                      className="text-vibe-primary hover:underline"
                    >
                      release →
                    </button>
                  )}
                  <span>{expanded ? '▾' : '▸'}</span>
                </span>
              </div>
              {expanded && (
                <div className="px-3 pb-3 pt-1 bg-vibe-bg border-t border-vibe-border">
                  <PhaseTimeline phases={mergedPhases(r, liveRun)} />
                  {(r.artifacts ?? []).length > 0 && (
                    <div className="mt-3 text-xs">
                      <div className="text-vibe-muted mb-1">Artifacts:</div>
                      <ul className="ml-4 list-disc">
                        {(r.artifacts ?? []).map((a, i) => (
                          <li key={i}>
                            <code className="text-[11px]">{a}</code>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PhaseTimeline({ phases, depth = 0 }: { phases: ShipPhaseResult_Serialize[]; depth?: number }) {
  return (
    <div className="space-y-1" style={{ marginLeft: depth * 16 }}>
      {phases.map((p, idx) => (
        <div key={idx} className="text-xs flex flex-col gap-1 py-1 border-b border-vibe-border last:border-b-0" data-ship-phase={p.name} data-ship-phase-status={p.status}>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-2">
              <PhaseStatusBadge status={p.status} />
              <span className="font-mono">{p.name}</span>
              <span className="text-vibe-muted">({p.kind})</span>
            </span>
            <span className="text-vibe-muted">{p.durationMs != null ? `${p.durationMs}ms` : ''}</span>
          </div>
          {p.command && <div className="ml-12 text-vibe-muted break-all font-mono">$ {p.command}</div>}
          {p.detail && <div className="ml-12 text-vibe-muted break-all">{p.detail}</div>}
          {p.error && <div className="ml-12 text-red-300">error: {p.error}</div>}
          {(p.children ?? []).length > 0 && <PhaseTimeline phases={p.children ?? []} depth={depth + 1} />}
        </div>
      ))}
    </div>
  )
}

function ConfirmRunDialog({
  target, status, readiness, runsDir, onCancel, onConfirm,
}: {
  target: ConfirmTarget
  status: ShipStatus_Serialize | null
  readiness: ShipReadinessCheck_Serialize[]
  runsDir: string | null
  onCancel: () => void
  onConfirm: () => void
}) {
  const dirty = status?.gitClean === false
  const warns = readiness.filter((c) => c.level === 'warn')
  const isDeploy = target.mode === 'deploy'
  const flagLine = useMemo(() => {
    const flags: string[] = []
    if (target.flags.reuseBuild) flags.push('--reuse-build')
    if (target.flags.skipBuild) flags.push('--skip-build')
    if (target.flags.draft) flags.push('--draft')
    return flags.length ? flags.join(' ') : '(no extra flags)'
  }, [target])
  const headline = isDeploy ? `Re-deploy v${status?.canonicalVersion ?? '?'} (no bump)` : `Cut release: ${status?.canonicalVersion} → ${target.nextVersion}`

  return (
    <Modal open onClose={onCancel} title={headline} size="sm" overlayId="ship-confirm-run"
      footer={
        <Scoped>
          <div className="flex justify-end gap-2">
            <button onClick={onCancel} className="px-3 py-1.5 text-sm border border-vibe-border rounded hover:bg-vibe-bg">Cancel</button>
            <button onClick={onConfirm} className="px-3 py-1.5 text-sm bg-vibe-primary text-white rounded hover:bg-opacity-90" data-testid="ship-confirm-run">Run</button>
          </div>
        </Scoped>
      }
    >
      <Scoped>
        <div className="text-sm space-y-2">
          <div><span className="text-vibe-muted">Mode:</span> <code>{target.mode}</code></div>
          <div><span className="text-vibe-muted">Flags:</span> <code>{flagLine}</code></div>
          <div><span className="text-vibe-muted">Branch:</span> <code>{status?.branch ?? '?'}</code></div>
          {isDeploy && (
            <div className="text-xs text-vibe-muted border border-vibe-border bg-vibe-bg p-2 rounded">
              Skips <code>version_bump</code>; <code>{'{version}'}</code> resolves to <code>{status?.canonicalVersion ?? '?'}</code>.
            </div>
          )}
          {dirty && (
            <div className="text-yellow-300 text-xs border border-yellow-500/40 bg-yellow-500/10 p-2 rounded">
              ⚠ Working tree is dirty. Uncommitted changes will be in the release.
            </div>
          )}
          {warns.length > 0 && (
            <div className="text-yellow-300 text-xs border border-yellow-500/40 bg-yellow-500/10 p-2 rounded">
              ⚠ {warns.length} warning(s):
              <ul className="ml-4 list-disc mt-1">
                {warns.slice(0, 3).map((w, i) => (
                  <li key={i}>{w.label}</li>
                ))}
              </ul>
            </div>
          )}
          <div className="text-xs text-vibe-muted">
            Output streams to the pane below. The run is recorded under <code className="break-all">{runsDir ?? '.quadflow/local/ship/runs'}</code>.
          </div>
        </div>
      </Scoped>
    </Modal>
  )
}

function Splitter({ onDrag }: { onDrag: (deltaPct: number) => void }) {
  const dragging = useRef(false)
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      onDrag((e.movementY / window.innerHeight) * 100)
    }
    const onUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onDrag])
  return (
    <div
      className="h-1 bg-vibe-border hover:bg-vibe-primary cursor-ns-resize flex-shrink-0"
      onMouseDown={() => {
        dragging.current = true
        document.body.style.cursor = 'ns-resize'
      }}
    />
  )
}

function DiagnosticsBanner({ diagnostics, onRefresh }: { diagnostics: ShipDiagnostics_Serialize | null; onRefresh: () => void }) {
  const [expanded, setExpanded] = useState(false)
  // Older hosts have no `data.ship.diagnostics`: nothing to show.
  if (!diagnostics) return null
  const parseError = diagnostics.configParseError
  const noConfig = !diagnostics.configExists
  const border = parseError ? 'border-red-500/40 bg-red-500/10' : noConfig ? 'border-yellow-500/40 bg-yellow-500/10' : 'border-vibe-border bg-vibe-surface'
  const n = (v: number | null | undefined, word: string) => `${v ?? 0} ${word}${v === 1 ? '' : 's'}`
  return (
    <div className={`text-[11px] border rounded px-3 py-1.5 ${border}`} data-testid="ship-diagnostics">
      <div className="flex items-center justify-between">
        <span className="truncate">
          {parseError ? (
            <>Config could not be read: <code>{diagnostics.configPath}</code></>
          ) : noConfig ? (
            <>No config at <code>{diagnostics.configPath}</code></>
          ) : (
            <>
              Config: <code>{diagnostics.configPath}</code> ({n(diagnostics.configPhaseCount, 'phase')}
              {diagnostics.configCheckCount != null ? `, ${n(diagnostics.configCheckCount, 'declared check')}` : ''}, {n(diagnostics.runCount, 'run')})
            </>
          )}
        </span>
        <span className="flex items-center gap-2 flex-shrink-0">
          <button onClick={onRefresh} className="text-vibe-muted hover:text-vibe-text" title="Reload">⟳</button>
          <button onClick={() => setExpanded(!expanded)} className="text-vibe-muted hover:text-vibe-text">{expanded ? '▾' : '▸'}</button>
        </span>
      </div>
      {parseError && <div className="mt-1 text-red-400 break-all">{parseError}</div>}
      {expanded && (
        <div className="mt-2 pt-2 border-t border-vibe-border space-y-0.5 font-mono text-[10px] text-vibe-muted">
          <div>projectDir: <span className="text-vibe-text">{diagnostics.projectDir}</span></div>
          <div>configPath: <span className="text-vibe-text">{diagnostics.configPath}</span></div>
          <div>runsDir: <span className="text-vibe-text">{diagnostics.runsDir}</span></div>
          <div>projectKind: <span className="text-vibe-text">{diagnostics.projectKind ?? 'not detected'}</span></div>
        </div>
      )}
    </div>
  )
}

function InitView({ ctx }: { ctx: PluginContext }) {
  const model = shipModel(ctx)
  const { loading, error, diagnostics, projectKind } = model.use()
  const [templates, setTemplates] = useState<ShipTemplateInfo_Serialize[] | null>(null)
  const [expandedTemplate, setExpandedTemplate] = useState<string | null>(null)
  const [paramValues, setParamValues] = useState<Record<string, string>>({})
  useEffect(() => {
    ctx.data.ship.templates().then(setTemplates).catch((e) => ctx.log.error('ship templates:', e))
  }, [ctx])

  const recommendedId = useMemo<string | null>(() => {
    if (projectKind === 'tauri') return /Mac/i.test(navigator.userAgent) ? 'tauri-macos' : 'tauri-windows'
    if (projectKind === 'cargo' || projectKind === 'npm' || projectKind === 'python') return 'library-publish'
    return null
  }, [projectKind])
  const grouped = useMemo(() => groupTemplates(templates ?? []), [templates])

  const handleCreate = (t: ShipTemplateInfo_Serialize) => {
    const missing = t.params.filter((p) => p.required && !(paramValues[p.key] ?? '').trim())
    if (missing.length > 0) {
      ctx.notifications.toast({ kind: 'warning', title: 'Missing parameters', body: 'Please fill in: ' + missing.map((p) => p.label).join(', ') })
      return
    }
    const params = Object.fromEntries(Object.entries(paramValues).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v !== ''))
    model.init(t.id, params).catch(() => {})
  }

  return (
    <div className="h-full w-full overflow-auto p-6 bg-vibe-bg text-vibe-text" data-testid="ship-init">
      <div className="max-w-xl mx-auto space-y-4">
        <div>
          <h2 className="text-xl font-semibold mb-2">Ship pipeline not configured</h2>
          <p className="text-vibe-muted text-sm">
            Detected project type: <code className="text-xs bg-vibe-surface px-1 py-0.5 rounded">{projectKind ?? 'not recognized'}</code>
          </p>
        </div>

        {error && <ErrorBanner error={error} onDismiss={model.clearError} />}
        <DiagnosticsBanner diagnostics={diagnostics} onRefresh={() => void model.loadAll()} />

        <div className="bg-vibe-surface rounded-lg p-4 border-2 border-vibe-primary">
          <h3 className="font-semibold mb-1">
            Configure with an agent <span className="text-xs text-vibe-primary ml-2">recommended</span>
          </h3>
          <p className="text-xs text-vibe-muted mb-3">
            Runs the interactive <code className="text-[10px] bg-vibe-bg px-1 py-0.5 rounded">setup-ship</code> skill: the agent detects your tooling (gh,
            deploy CLIs, signing tools), asks what you ship and where, and writes a validated configuration.
          </p>
          <button onClick={() => void launchSetupShip(ctx)} className="px-4 py-2 bg-vibe-primary text-white rounded hover:bg-opacity-90">
            Launch setup-ship in a new terminal
          </button>
        </div>

        {templates && templates.length > 0 && (
          <>
            <div className="text-xs text-vibe-muted text-center">— or pick a template —</div>
            <div className="space-y-4">
              {grouped.map((group) => (
                <div key={group.category}>
                  <div className="text-xs uppercase text-vibe-muted font-semibold mb-1.5 px-1">{group.category}</div>
                  <div className="space-y-2">
                    {group.templates.map((t) => (
                      <TemplateCard
                        key={t.id}
                        template={t}
                        recommended={t.id === recommendedId}
                        expanded={expandedTemplate === t.id}
                        paramValues={paramValues}
                        setParamValues={setParamValues}
                        onToggle={() => {
                          setExpandedTemplate(expandedTemplate === t.id ? null : t.id)
                          setParamValues({})
                        }}
                        onCreate={() => handleCreate(t)}
                        loading={loading}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <p className="text-xs text-vibe-muted">
          Something else? Write <code className="text-xs bg-vibe-surface px-1 py-0.5 rounded">{diagnostics?.configPath ?? '.quadflow/ship/config.json'}</code> by
          hand (schema: <code>quadflow docs ship</code>) or use "Configure with an agent".
        </p>
      </div>
    </div>
  )
}

function TemplateCard({
  template, recommended, expanded, paramValues, setParamValues, onToggle, onCreate, loading,
}: {
  template: ShipTemplateInfo_Serialize
  recommended: boolean
  expanded: boolean
  paramValues: Record<string, string>
  setParamValues: (next: Record<string, string>) => void
  onToggle: () => void
  onCreate: () => void
  loading: boolean
}) {
  const requiredFilled = template.params.filter((p) => p.required).every((p) => (paramValues[p.key] ?? '').trim().length > 0)
  return (
    <div className={`bg-vibe-surface rounded-lg p-3 border ${recommended ? 'border-vibe-primary' : 'border-vibe-border'}`} data-testid={`ship-template-${template.id}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-sm">
            {template.label}
            {recommended && <span className="text-xs text-vibe-primary ml-2">recommended</span>}
          </h3>
          <p className="text-[11px] text-vibe-muted mt-1">{template.description}</p>
        </div>
        <button
          onClick={onToggle}
          disabled={loading}
          className="text-xs px-2 py-1 bg-vibe-bg border border-vibe-border rounded hover:bg-vibe-primary/20 flex-shrink-0"
        >
          {expanded ? 'Cancel' : 'Configure…'}
        </button>
      </div>
      {expanded && (
        <div className="mt-3 pt-3 border-t border-vibe-border space-y-2 text-xs">
          {template.params.map((p) => (
            <label key={p.key} className="block">
              <span className="text-vibe-muted">
                {p.label}
                {p.required && <span className="text-red-400 ml-1">*</span>}:
              </span>
              <input
                value={paramValues[p.key] ?? ''}
                onChange={(e) => setParamValues({ ...paramValues, [p.key]: e.target.value })}
                placeholder={p.default ?? p.placeholder}
                className="w-full mt-1 px-2 py-1 bg-vibe-bg border border-vibe-border rounded font-mono"
              />
            </label>
          ))}
          <div className="flex gap-2 pt-1">
            <button
              disabled={loading || !requiredFilled}
              onClick={onCreate}
              data-testid="ship-create-config"
              className="px-3 py-1.5 bg-vibe-primary text-white rounded hover:bg-opacity-90 disabled:opacity-50"
            >
              {loading ? 'Creating…' : 'Create config'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

// ---- helpers ----

/** Start an agent in the project with the setup-ship skill. */
export async function launchSetupShip(ctx: PluginContext): Promise<void> {
  const prompt =
    'Use the setup-ship skill to walk me through configuring this projects release pipeline. ' +
    'Run quadflow ship detect --json first to see what is installed. ' +
    'Ask me to confirm the template and any required parameters before writing the config.'
  await launchAgent(ctx, prompt, { preferred: 'claude-code', autoSubmit: true })
}

function computeNextVersions(current: string | undefined): Record<BumpType, string> {
  const blank = { patch: '', minor: '', major: '' }
  if (!current) return blank
  const parts = current.split(/[-+]/)[0].split('.').map(Number)
  if (parts.length !== 3 || parts.some(isNaN)) return blank
  const [maj, min, pat] = parts
  return { patch: `${maj}.${min}.${pat + 1}`, minor: `${maj}.${min + 1}.0`, major: `${maj + 1}.0.0` }
}

/** Replay lines from a stored run's per-phase stdout/stderr. */
export function historicalLines(run: ShipRun_Serialize): ShipLineEvent[] {
  const out: ShipLineEvent[] = []
  const walk = (phases: ShipPhaseResult_Serialize[]) => {
    for (const p of phases) {
      const ts = p.completedAt ?? 0
      if (p.command) out.push({ runId: run.id, phase: p.name, stream: 'meta', line: `$ ${p.command}`, ts })
      for (const [text, stream] of [[p.stdout, 'stdout'], [p.stderr, 'stderr']] as const) {
        for (const line of (text ?? '').split(/\r?\n/)) {
          if (line.length > 0) out.push({ runId: run.id, phase: p.name, stream, line, ts })
        }
      }
      walk(p.children ?? [])
      const summary = phaseSummaryLine(p)
      if (summary) out.push({ runId: run.id, phase: p.name, stream: p.status === 'failed' ? 'stderr' : 'stdout', line: summary, ts })
    }
  }
  walk(run.phases)
  return out
}

function groupTemplates(templates: ShipTemplateInfo_Serialize[]): { category: string; templates: ShipTemplateInfo_Serialize[] }[] {
  const categoryFor = (id: string): string => {
    if (id.startsWith('tauri-')) return 'Desktop apps'
    if (id === 'library-publish' || id === 'gh-release-binaries') return 'Libraries & binaries'
    if (['vercel', 'cloudflare-pages', 'netlify', 'railway', 'fly', 's3-static-site'].includes(id)) return 'Web apps & hosting'
    if (id === 'docker') return 'Containers'
    return 'Other'
  }
  const order = ['Desktop apps', 'Web apps & hosting', 'Libraries & binaries', 'Containers', 'Other']
  const map = new Map<string, ShipTemplateInfo_Serialize[]>()
  for (const t of templates) {
    const cat = categoryFor(t.id)
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat)!.push(t)
  }
  return order.filter((c) => map.has(c)).map((c) => ({ category: c, templates: map.get(c)! }))
}
