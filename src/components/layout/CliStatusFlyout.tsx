import { useEffect, useRef, useState } from 'react'
import { cliInstallApi, CliInstallStatus } from '../../lib/tauri-api'
import { useAppSettingsStore } from '../../stores/appSettingsStore'
import { useProjectStore } from '../../stores/projectStore'

/**
 * Toolbar button + flyout for the `quadflow` CLI install state.
 *
 * Three sections:
 *  1. Status header — colored gradient based on install/match state
 *  2. Install actions — Install / Switch-to-this-build / Uninstall
 *  3. Context modules — inline toggles for which CLI subcommand docs
 *     get injected into this project's agent context files
 *
 * Key affordance: when the resolved `quadflow` on PATH points at a
 * DIFFERENT build than this app (common when switching between dev and
 * a published install), surface that prominently with a one-click
 * "Switch to this build" button that prepends our bin_dir to PATH.
 */
export default function CliStatusFlyout({
  onOpenSettings: _onOpenSettings,
}: {
  // Kept in props signature for backwards compat; no longer used —
  // context modules are toggled inline now.
  onOpenSettings: () => void
}) {
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [busy, setBusy] = useState<'install' | 'switch' | 'uninstall' | null>(null)
  const [actionMsg, setActionMsg] = useState<string | null>(null)
  const [showDebug, setShowDebug] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  // Initial load + refresh on open.
  useEffect(() => {
    let cancelled = false
    cliInstallApi.status().then((s) => { if (!cancelled) setStatus(s) }).catch(() => {})
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!open) return
    cliInstallApi.status().then(setStatus).catch((e) => setActionMsg(`status: ${e}`))
  }, [open])

  // Click-outside-to-close.
  useEffect(() => {
    if (!open) return
    const onDocClick = (e: MouseEvent) => {
      if (!containerRef.current) return
      if (!containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const dotColor = computeDotColor(status)
  const buttonStyle = computeButtonStyle(dotColor)
  const title = computeTooltip(status)

  const wrap = async (kind: 'install' | 'switch' | 'uninstall', fn: () => Promise<CliInstallStatus>) => {
    setBusy(kind); setActionMsg(null)
    try {
      const next = await fn()
      setStatus(next)
      setActionMsg(next.message ?? 'Done.')
    } catch (e) {
      setActionMsg(`${kind} failed: ${e}`)
    } finally {
      setBusy(null)
    }
  }

  const handleRefresh = async () => {
    setActionMsg(null)
    try { setStatus(await cliInstallApi.status()) }
    catch (e) { setActionMsg(`refresh: ${e}`) }
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={`flex items-center justify-center w-8 h-8 rounded border transition-all ${buttonStyle}`}
        title={title}
      >
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-96 bg-vibe-surface border border-vibe-border rounded-xl shadow-2xl z-50 text-sm overflow-hidden">
          {/* Section 1: status header (gradient based on color) */}
          <StatusHeader status={status} dotColor={dotColor} onRefresh={handleRefresh} />

          {!status ? (
            <div className="p-4 text-vibe-muted text-xs">Loading…</div>
          ) : (
            <>
              {/* Mismatch banner — most prominent affordance */}
              <MismatchBanner status={status} busy={busy === 'switch'} onSwitch={() =>
                wrap('switch', cliInstallApi.switchToThisBuild)
              } />

              {/* Section 2: install actions */}
              <InstallActions
                status={status}
                busy={busy}
                onInstall={() => wrap('install', cliInstallApi.install)}
                onSwitch={() => wrap('switch', cliInstallApi.switchToThisBuild)}
                onUninstall={() => wrap('uninstall', cliInstallApi.uninstall)}
              />

              {actionMsg && (
                <div className="px-4 py-2 text-[11px] text-vibe-muted border-t border-vibe-border bg-vibe-bg/40">
                  {actionMsg}
                </div>
              )}

              {/* Section 3: context modules */}
              <ContextModulesSection />

              {/* Debug toggle (collapsed by default) */}
              <div className="border-t border-vibe-border">
                <button
                  onClick={() => setShowDebug(!showDebug)}
                  className="w-full px-4 py-2 text-[11px] text-vibe-muted hover:text-vibe-text flex items-center justify-between"
                >
                  <span>Diagnostics</span>
                  <span>{showDebug ? '▾' : '▸'}</span>
                </button>
                {showDebug && (
                  <div className="px-4 pb-3">
                    <StatusGrid status={status} />
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

// ============================================================
// Status header — colored gradient, app version + on-PATH version
// ============================================================

function StatusHeader({
  status, dotColor, onRefresh,
}: {
  status: CliInstallStatus | null
  dotColor: DotColor
  onRefresh: () => void
}) {
  const grad = ({
    green:  'from-green-900/40 to-green-700/10',
    yellow: 'from-yellow-900/40 to-yellow-700/10',
    red:    'from-red-900/40 to-red-700/10',
    gray:   'from-vibe-bg to-vibe-bg',
  } as const)[dotColor]
  const headline = computeHeadline(status, dotColor)
  const subtext = computeSubtext(status, dotColor)
  return (
    <div className={`px-4 py-3 border-b border-vibe-border bg-gradient-to-br ${grad}`}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${dotBg(dotColor)}`} />
          <span className="font-semibold truncate">{headline}</span>
        </div>
        <button
          onClick={onRefresh}
          className="text-vibe-muted hover:text-vibe-text text-xs"
          title="Re-check PATH"
        >⟳</button>
      </div>
      {subtext && <div className="mt-1 text-[11px] text-vibe-muted">{subtext}</div>}
    </div>
  )
}

function computeHeadline(s: CliInstallStatus | null, c: DotColor): string {
  if (!s) return 'Loading…'
  if (c === 'green') return `quadflow ${s.app_version} · ready`
  if (c === 'yellow') {
    if (!s.version_match && s.version_on_path) {
      return `quadflow ${shortVersion(s.version_on_path)} on PATH (this build is ${s.app_version})`
    }
    return `quadflow ${s.app_version} (warning)`
  }
  if (c === 'red') return 'quadflow not on PATH'
  return 'quadflow CLI'
}

function computeSubtext(s: CliInstallStatus | null, c: DotColor): string | null {
  if (!s) return null
  if (c === 'green') return 'cmd, PowerShell, Git Bash all see this build.'
  if (c === 'red' && s.supported) return 'Click Install below to make `quadflow` available in any new terminal.'
  if (c === 'yellow') {
    if (!s.shim_present) return 'Shims missing — re-install to refresh.'
    if (!s.on_path) return 'New shells haven\'t picked up the new PATH yet — open a fresh terminal.'
    return 'A different build is currently winning PATH lookup.'
  }
  if (!s.supported) return 'Auto-install is Windows-only for now.'
  return null
}

// ============================================================
// Mismatch banner — the "switch to this build" affordance
// ============================================================

function MismatchBanner({
  status, busy, onSwitch,
}: {
  status: CliInstallStatus
  busy: boolean
  onSwitch: () => void
}) {
  // The mismatch banner should ONLY fire when a foreign build is winning
  // PATH lookup. Anything in OUR bin_dir is one of our shims — `where
  // quadflow` returns the extensionless `quadflow` first (alphabetical),
  // even though our state stores the .cmd as the primary shim_path. Use a
  // bin-dir membership test instead of filename equality.
  const resolvedIsOurs = status.resolved_exe_on_path
    && isInsideDir(status.resolved_exe_on_path, status.bin_dir)
  const differentExe = !!status.resolved_exe_on_path
    && !samePath(status.resolved_exe_on_path, status.exe_path)
    && !samePath(status.resolved_exe_on_path, status.shim_path)
    && !resolvedIsOurs
  const versionDrift = status.on_path && !status.version_match && status.version_on_path
  if (!differentExe && !versionDrift) return null

  return (
    <div className="px-4 py-3 bg-yellow-500/10 border-b border-yellow-500/30">
      <div className="flex items-start gap-2 text-xs">
        <span className="text-yellow-300 text-base leading-none mt-0.5">⚠</span>
        <div className="min-w-0 flex-1">
          <div className="font-semibold text-yellow-400 mb-1">
            Different build is on PATH
          </div>
          <div className="text-vibe-text space-y-1">
            <div>
              <span className="text-vibe-muted">Currently resolves to:</span>{' '}
              <code className="text-[10px] text-yellow-400 break-all">
                {shortVersion(status.version_on_path ?? '?')} at {basename(status.resolved_exe_on_path ?? '')}
              </code>
            </div>
            <div>
              <span className="text-vibe-muted">This build is:</span>{' '}
              <code className="text-[10px] text-vibe-text">{status.app_version} at {basename(status.exe_path)}</code>
            </div>
          </div>
          <button
            onClick={onSwitch}
            disabled={busy}
            className="mt-2.5 w-full px-3 py-1.5 bg-yellow-600/80 hover:bg-yellow-500 text-white text-xs font-medium rounded transition-colors disabled:opacity-50"
          >
            {busy ? 'Switching…' : '↺ Switch `quadflow` to this build'}
          </button>
          <div className="text-[10px] text-yellow-300/60 mt-1.5">
            Promotes this build's bin dir to the front of your user PATH. The other install stays installed; you can switch back later.
          </div>
        </div>
      </div>
    </div>
  )
}

// ============================================================
// Install actions
// ============================================================

function InstallActions({
  status, busy, onInstall, onSwitch, onUninstall,
}: {
  status: CliInstallStatus
  busy: 'install' | 'switch' | 'uninstall' | null
  onInstall: () => void
  onSwitch: () => void
  onUninstall: () => void
}) {
  if (!status.supported) {
    return (
      <div className="px-4 py-3 text-xs text-vibe-muted">
        Auto-install is Windows-only. To use <code>quadflow</code> on this OS, add this directory to your shell PATH manually:
        <code className="block mt-1.5 p-2 bg-vibe-bg border border-vibe-border rounded break-all text-vibe-text">{status.bin_dir}</code>
      </div>
    )
  }

  return (
    <div className="px-4 py-3 space-y-2">
      {!status.installed ? (
        <button
          onClick={onInstall}
          disabled={busy != null}
          className="w-full py-2.5 px-4 bg-gradient-to-b from-vibe-primary to-vibe-primary/80 hover:from-vibe-primary/90 hover:to-vibe-primary/70 text-white text-sm font-medium rounded-md shadow-sm transition-all disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2"
        >
          {busy === 'install' ? (
            <>
              <span className="inline-block w-3 h-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              Installing…
            </>
          ) : (
            <>
              <span className="text-base leading-none">⬇</span>
              Install <code className="text-xs bg-white/15 px-1 rounded">quadflow</code> for this user
            </>
          )}
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          <button
            onClick={onSwitch}
            disabled={busy != null}
            className="py-2 px-3 bg-vibe-bg border border-vibe-border hover:bg-vibe-primary/15 hover:border-vibe-primary text-vibe-text text-xs font-medium rounded transition-colors disabled:opacity-50"
            title="Promote this build's bin dir to the front of PATH"
          >
            {busy === 'switch' ? '…' : '↺ Re-install / promote'}
          </button>
          <button
            onClick={onUninstall}
            disabled={busy != null}
            className="py-2 px-3 bg-vibe-bg border border-vibe-border hover:bg-red-500/10 hover:border-red-500/50 hover:text-red-400 text-vibe-text text-xs font-medium rounded transition-colors disabled:opacity-50"
          >
            {busy === 'uninstall' ? '…' : 'Uninstall'}
          </button>
        </div>
      )}
    </div>
  )
}

// ============================================================
// Context modules — inline toggles
// ============================================================

const MODULE_DESCRIPTIONS: Record<string, string> = {
  ideas: 'Lets agents discover, create, tag, and promote ideas via the CLI without you having to dump the schema into chat each time.',
  issues: 'Issue tracking commands (status workflow, labels, comments, blocking, priorities) — agents read this to drive the issue board for you.',
  plans: 'Plan creation, decomposition into steps, and step → issue promotion. Agents need this to author or execute multi-step plans.',
  projects: 'Big-picture project tracking (research, requirements, decisions, references). Agents use it to maintain a living project doc.',
  scripts: 'Saved build/test/run recipes with environment + setup commands. Agents can list and invoke saved scripts.',
  ship: 'The release pipeline — preflight checks, version bump, build, sign, upload. Required for /setup-ship and /cut-ship to work.',
  chat: 'Conversations with external LLMs (Ollama, OpenRouter, etc.). Agents can manage chat threads on your behalf.',
  missions: 'Multi-agent coordination — team composition, mission proposals, agent orchestration.',
}

function ContextModulesSection() {
  const projectDir = useProjectStore((s) => s.activeProject?.workingDirectory ?? null)
  const { contextModules, loadContextModules, toggleContextModule } = useAppSettingsStore()
  const [pendingModule, setPendingModule] = useState<string | null>(null)
  const [hoveredModule, setHoveredModule] = useState<string | null>(null)

  useEffect(() => {
    if (projectDir) loadContextModules(projectDir).catch(() => {})
  }, [projectDir, loadContextModules])

  const handleToggle = async (name: string, enabled: boolean) => {
    if (!projectDir) return
    setPendingModule(name)
    try { await toggleContextModule(projectDir, name, enabled) }
    finally { setPendingModule(null) }
  }

  if (!projectDir) {
    return (
      <div className="px-4 py-3 border-t border-vibe-border">
        <div className="text-[11px] text-vibe-muted">
          Open a project to manage agent context modules.
        </div>
      </div>
    )
  }

  const enabledCount = contextModules.filter(m => m.enabled).length

  return (
    <div className="border-t border-vibe-border">
      <div className="px-4 pt-3 pb-1.5 flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wide text-vibe-muted font-semibold">Agent context modules</div>
        <span className="text-[10px] text-vibe-muted">{enabledCount}/{contextModules.length} enabled</span>
      </div>
      <div className="text-[10px] text-vibe-muted px-4 pb-2">
        Toggle which CLI subcommand reference docs get injected into this project's agent context files.
        Agents in this project will see the docs for enabled modules without needing to ask.
      </div>
      <div className="px-2 pb-3 space-y-0.5 max-h-56 overflow-auto">
        {contextModules.length === 0 && (
          <div className="px-2 py-2 text-[11px] text-vibe-muted">No modules — this project may not be scaffolded yet.</div>
        )}
        {contextModules.map((m) => {
          const desc = MODULE_DESCRIPTIONS[m.name] ?? `Inject the ${m.name} reference into the agent context files.`
          const isHovered = hoveredModule === m.name
          return (
            <div key={m.name} className="px-2 py-1 rounded hover:bg-vibe-bg/60">
              <div className="flex items-center justify-between gap-2">
                <button
                  onClick={() => handleToggle(m.name, !m.enabled)}
                  disabled={pendingModule === m.name}
                  className="flex items-center gap-2 min-w-0 flex-1 text-left disabled:opacity-50"
                >
                  <Toggle on={m.enabled} pending={pendingModule === m.name} />
                  <span className={`text-xs ${m.enabled ? 'text-vibe-text' : 'text-vibe-muted'}`}>{m.name}</span>
                </button>
                <button
                  onClick={() => setHoveredModule(isHovered ? null : m.name)}
                  className="text-vibe-muted hover:text-vibe-primary w-4 h-4 flex items-center justify-center rounded-full border border-vibe-border text-[9px] flex-shrink-0"
                  title="What does this do?"
                >i</button>
              </div>
              {isHovered && (
                <div className="mt-1 ml-7 text-[10px] text-vibe-muted leading-relaxed">{desc}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function Toggle({ on, pending }: { on: boolean; pending: boolean }) {
  return (
    <span className={`inline-flex items-center w-7 h-3.5 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-vibe-primary' : 'bg-vibe-border'}`}>
      <span
        className={`inline-block w-2.5 h-2.5 bg-white rounded-full shadow transform transition-transform ${on ? 'translate-x-3.5' : 'translate-x-0.5'} ${pending ? 'animate-pulse' : ''}`}
      />
    </span>
  )
}

// ============================================================
// helpers
// ============================================================

type DotColor = 'green' | 'yellow' | 'red' | 'gray'

function computeDotColor(s: CliInstallStatus | null): DotColor {
  if (!s) return 'gray'
  if (!s.supported) return 'gray'
  if (!s.on_path) return 'red'
  if (!s.version_match) return 'yellow'
  // Match MismatchBanner's logic: anything in our bin_dir counts as ours
  // (where quadflow returns the extensionless shim, not the .cmd).
  const resolvedIsOurs = s.resolved_exe_on_path
    && isInsideDir(s.resolved_exe_on_path, s.bin_dir)
  if (s.resolved_exe_on_path
      && !samePath(s.resolved_exe_on_path, s.exe_path)
      && !samePath(s.resolved_exe_on_path, s.shim_path)
      && !resolvedIsOurs) {
    return 'yellow'
  }
  return 'green'
}

function dotBg(c: DotColor): string {
  return ({
    green: 'bg-green-400',
    yellow: 'bg-yellow-400',
    red: 'bg-red-400',
    gray: 'bg-vibe-muted',
  } as const)[c]
}

function computeButtonStyle(c: DotColor): string {
  return ({
    green:  'bg-green-500/10 border-green-500/30 text-green-400 hover:bg-green-500/20',
    yellow: 'bg-yellow-500/10 border-yellow-500/30 text-yellow-300 hover:bg-yellow-500/20',
    red:    'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20',
    gray:   'bg-vibe-surface border-vibe-border text-vibe-muted hover:bg-vibe-border/50',
  } as const)[c]
}

function computeTooltip(s: CliInstallStatus | null): string {
  if (!s) return 'quadflow CLI: loading…'
  if (!s.supported) return 'quadflow CLI: not auto-installable on this platform'
  if (!s.on_path) return 'quadflow CLI: NOT on PATH (click to install)'
  if (!s.version_match) return `quadflow CLI: version mismatch (${shortVersion(s.version_on_path ?? '?')} vs app ${s.app_version})`
  return `quadflow CLI: installed and current (${s.app_version})`
}

function shortVersion(s: string): string {
  const m = s.match(/(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/)
  return m ? m[1] : s
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** True if `file` lives inside `dir` (case-insensitive on Windows). Used to
 *  recognize either of our shims (`quadflow.cmd`, `quadflow`) as "ours" since
 *  `where` returns whichever wins alphabetically, not the .cmd we display. */
function isInsideDir(file: string, dir: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const f = norm(file)
  const d = norm(dir)
  return f === d || f.startsWith(d + '/')
}

function basename(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

function StatusGrid({ status }: { status: CliInstallStatus }) {
  return (
    <div className="text-[11px] space-y-1">
      <Row label="On PATH" value={status.on_path ? <span className="text-green-300">yes</span> : <span className="text-red-300">no</span>} />
      <Row label="Bin dir on PATH" value={status.bin_on_path ? <span className="text-green-300">yes</span> : <span className="text-vibe-muted">no</span>} />
      <Row label="Shims (cmd + bash)" value={status.shim_present ? <span className="text-green-300">both present</span> : <span className="text-vibe-muted">missing</span>} />
      <Row
        label="Version on PATH"
        value={status.version_on_path
          ? <span className={status.version_match ? 'text-green-300' : 'text-yellow-300'}>{shortVersion(status.version_on_path)}</span>
          : <span className="text-vibe-muted">—</span>
        }
      />
      <Row label="App version" value={<code className="text-vibe-text">{status.app_version}</code>} />
      <Row label="App exe" value={<code className="text-vibe-muted break-all text-[10px]">{status.exe_path}</code>} />
      {status.resolved_exe_on_path && !samePath(status.resolved_exe_on_path, status.exe_path) && (
        <Row label="Resolved by PATH" value={<code className="text-yellow-300 break-all text-[10px]">{status.resolved_exe_on_path}</code>} />
      )}
      <Row label="Bin dir" value={<code className="text-vibe-muted break-all text-[10px]">{status.bin_dir}</code>} />
      <Row label="Shim path" value={<code className="text-vibe-muted break-all text-[10px]">{status.shim_path}</code>} />
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-vibe-muted flex-shrink-0">{label}:</span>
      <span className="text-right min-w-0">{value}</span>
    </div>
  )
}
