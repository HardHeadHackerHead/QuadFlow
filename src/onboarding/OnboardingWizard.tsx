/**
 * First-run onboarding (ROADMAP §3 "App shell → First-run onboarding";
 * agent-providers.md §11 "Onboarding step Agents").
 *
 * Six skippable steps over the workspace: Welcome → Agents → Project → CLI →
 * Plugins → Done. Nothing is required; closing the dialog (×, Esc, "Skip
 * setup") records `skipped`, "Get started" records `completed`.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { MOD_LABEL } from '../lib/platformKeys'
import { openUrl as openExternal } from '@tauri-apps/plugin-opener'
import { Badge, Button, Icon, Kbd, Modal, Spinner, cx } from '@quadflow/ui'
import { commands, type AgentDetection, type AgentProviderInfo } from '../generated/bindings'
import { call } from '../lib/core'
import { cliInstallApi, type CliInstallStatus } from '../lib/tauri-api'
import { openNewTerminal, pickProjectFolder, openProjectDirectory } from '../lib/shellActions'
import { pluginsApi, errorMessage, type PluginInfoData } from '../components/settings/plugins/api'
import { useAppSettingsStore } from '../stores/appSettingsStore'
import { useProjectStore } from '../stores/projectStore'
import { useTerminalStore } from '../stores/terminalStore'
import { useAgentPromptStore } from '../stores/agentPromptStore'
import { useAgentProvidersStore } from '../agents/providers'
import PluginIcon from '../plugins/PluginIcon'
import quadflowLogo from '../assets/logo.png'
import { useOnboardingStore } from './onboardingStore'

export const DOCS_URL = 'https://github.com/HardHeadHackerHead/QuadFlow/tree/main/docs'

const STEPS = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'agents', label: 'Agents' },
  { id: 'project', label: 'Project' },
  { id: 'cli', label: 'CLI' },
  { id: 'plugins', label: 'Plugins' },
  { id: 'done', label: 'Done' },
] as const

function openLink(url: string) {
  openExternal(url).catch((e: unknown) => console.error('[onboarding] open link failed:', e))
}

export default function OnboardingWizard() {
  const { isOpen, step, setStep, finish } = useOnboardingStore()
  if (!isOpen) return null
  const last = STEPS.length - 1
  const current = STEPS[Math.min(step, last)]

  return (
    <Modal
      open
      size="lg"
      overlayId="onboarding"
      closeOnBackdrop={false}
      onClose={() => void finish('skipped')}
      title={<span data-onboarding-title>Welcome to QuadFlow</span>}
      description={`Step ${step + 1} of ${STEPS.length} · ${current.label}`}
      className="min-h-[30rem]"
      footer={
        <div className="flex w-full items-center gap-2" data-onboarding-footer>
          {step < last && (
            <Button variant="ghost" onClick={() => void finish('skipped')} data-onboarding-skip>
              Skip setup
            </Button>
          )}
          <div className="flex-1" />
          {step > 0 && (
            <Button variant="secondary" onClick={() => setStep(step - 1)} data-onboarding-back>
              Back
            </Button>
          )}
          {step < last ? (
            <Button variant="primary" onClick={() => setStep(step + 1)} data-onboarding-next data-autofocus>
              Next
            </Button>
          ) : (
            <Button variant="primary" onClick={() => void finish('completed')} data-onboarding-finish data-autofocus>
              Get started
            </Button>
          )}
        </div>
      }
    >
      <div data-onboarding data-onboarding-step={current.id} className="flex flex-col gap-4">
        <StepIndicator step={step} onSelect={setStep} />
        {current.id === 'welcome' && <WelcomeStep />}
        {current.id === 'agents' && <AgentsStep />}
        {current.id === 'project' && <ProjectStep />}
        {current.id === 'cli' && <CliStep />}
        {current.id === 'plugins' && <PluginsStep />}
        {current.id === 'done' && <DoneStep />}
      </div>
    </Modal>
  )
}

function StepIndicator({ step, onSelect }: { step: number; onSelect: (i: number) => void }) {
  return (
    <ol className="flex items-center gap-1" aria-label="Onboarding steps">
      {STEPS.map((s, i) => (
        <li key={s.id} className="flex flex-1 items-center gap-1">
          <button
            type="button"
            onClick={() => onSelect(i)}
            aria-current={i === step ? 'step' : undefined}
            className={cx(
              'flex w-full flex-col items-start gap-1 rounded px-1 py-0.5 text-left text-[11px] transition-colors',
              i === step ? 'text-qf-text' : 'text-qf-text-muted hover:text-qf-text',
            )}
          >
            <span className={cx('h-1 w-full rounded-full', i <= step ? 'bg-qf-primary' : 'bg-qf-border')} />
            {s.label}
          </button>
        </li>
      ))}
    </ol>
  )
}

function Section({ title, children, aside }: { title: ReactNode; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-semibold text-qf-text">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  )
}

function Muted({ children }: { children: ReactNode }) {
  return <p className="text-xs leading-relaxed text-qf-text-muted">{children}</p>
}

function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null
  return <p className="text-xs text-qf-error" role="alert">{message}</p>
}

// ---- 1. Welcome ----

function WelcomeStep() {
  const mode = useAppSettingsStore((s) => s.theme.mode)
  const setThemeMode = useAppSettingsStore((s) => s.setThemeMode)
  const modes = [
    { id: 'dark', label: 'Dark', icon: 'moon' },
    { id: 'light', label: 'Light', icon: 'sun' },
    { id: 'system', label: 'System', icon: 'monitor' },
  ] as const
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-4">
        <img src={quadflowLogo} alt="" className="h-16 w-16 select-none" draggable={false} />
        <div className="flex flex-col gap-1">
          <h3 className="text-base font-semibold text-qf-text">Run your AI coding agents side by side</h3>
          <p className="text-sm leading-relaxed text-qf-text-muted" data-onboarding-intro>
            QuadFlow is a desktop workspace for running several AI coding agents and
            terminals in one tiled layout. Ideas, issues, plans and scripts live next to your code, and agents
            reach them through the <code className="font-mono text-qf-text">quadflow</code> CLI.
          </p>
        </div>
      </div>
      <Section title="Appearance">
        <div className="flex gap-2" role="radiogroup" aria-label="Theme">
          {modes.map((m) => (
            <Button
              key={m.id}
              size="sm"
              variant={mode === m.id ? 'primary' : 'secondary'}
              role="radio"
              aria-checked={mode === m.id}
              data-onboarding-theme={m.id}
              leftIcon={<Icon name={m.icon} className="h-3.5 w-3.5" />}
              onClick={() => setThemeMode(m.id)}
            >
              {m.label}
            </Button>
          ))}
        </div>
      </Section>
      <Muted>
        This short setup checks your agent CLIs, picks a first project and offers to put the CLI on your PATH.
        Every step is optional. You can reopen it later from the gear menu or the command palette
        (<Kbd>{MOD_LABEL}</Kbd> <Kbd>K</Kbd> → “Show Welcome”).
      </Muted>
    </div>
  )
}

// ---- 2. Agents ----

function AgentsStep() {
  const [providers, setProviders] = useState<AgentProviderInfo[] | null>(null)
  const [detections, setDetections] = useState<Record<string, AgentDetection>>({})
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const detect = useCallback(async (refresh: boolean) => {
    setChecking(true)
    setError(null)
    try {
      const [list, dets] = await Promise.all([call(commands.agentsProviders()), call(commands.agentsDetectAll(refresh))])
      const byId = Object.fromEntries(dets.map((d) => [d.providerId, d]))
      setProviders(list)
      setDetections(byId)
      // Keep the launch menu in sync with what we just found.
      useAgentProvidersStore.setState((s) => ({ detections: { ...s.detections, ...byId } }))
    } catch (e) {
      setError(errorMessage(e))
      setProviders((p) => p ?? [])
    } finally {
      setChecking(false)
    }
  }, [])

  useEffect(() => {
    void detect(false)
  }, [detect])

  return (
    <Section
      title="Agent CLIs"
      aside={
        <Button size="xs" variant="ghost" onClick={() => void detect(true)} loading={checking} data-onboarding-recheck
          leftIcon={<Icon name="refresh" className="h-3 w-3" />}>
          Re-check
        </Button>
      }
    >
      <Muted>
        QuadFlow launches the agent CLIs you already have installed. Each one comes from a provider plugin.
        None is required, and you can install one later and press Re-check.
      </Muted>
      {providers === null ? (
        <div className="flex items-center gap-2 py-4 text-xs text-qf-text-muted"><Spinner /> Detecting agent CLIs…</div>
      ) : providers.length === 0 ? (
        <p className="py-2 text-xs text-qf-text-muted">No agent provider plugins are enabled. Enable one in Settings → Plugins.</p>
      ) : (
        <ul className="flex flex-col gap-2" data-onboarding-providers>
          {providers.map((p) => {
            const d = detections[p.id]
            const installed = !!d?.installed
            return (
              <li key={p.id} data-onboarding-provider={p.id} data-installed={installed ? 'true' : 'false'}
                className="flex items-start gap-3 rounded-lg border border-qf-border bg-qf-surface/40 p-3">
                <PluginIcon pluginId={p.pluginId} size={20} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-qf-text">{p.displayName}</span>
                    {!d ? (
                      <Badge>unknown</Badge>
                    ) : installed ? (
                      <Badge tone={d.meetsMinVersion ? 'success' : 'warning'}>
                        {d.version ? `v${d.version}` : 'installed'}{d.meetsMinVersion ? '' : ' (update recommended)'}
                      </Badge>
                    ) : (
                      <Badge tone="neutral">not installed</Badge>
                    )}
                  </div>
                  {installed && d?.path && <p className="mt-1 truncate font-mono text-[11px] text-qf-text-muted" title={d.path}>{d.path}</p>}
                  {!installed && p.installHint && (
                    <p className="mt-1 whitespace-pre-wrap break-words font-mono text-[11px] text-qf-text-muted">{p.installHint}</p>
                  )}
                </div>
                {p.docsUrl && (
                  <Button size="xs" variant="ghost" onClick={() => openLink(p.docsUrl!)}
                    rightIcon={<Icon name="external" className="h-3 w-3" />}>
                    Docs
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      <ErrorLine message={error} />
    </Section>
  )
}

// ---- 3. Project ----

function ProjectStep() {
  const activeProject = useProjectStore((s) => s.activeProject)
  const workingDir = useTerminalStore((s) => s.globalWorkingDirectory)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<string | null>(null)

  const choose = async () => {
    setError(null)
    try {
      const dir = await pickProjectFolder()
      if (!dir) return
      setBusy(true)
      // Opened empty: no agent auto-launch behind the wizard (Done offers one).
      const p = await openProjectDirectory(dir, { applyDefault: false })
      setOpened(p.workingDirectory)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const current = activeProject?.workingDirectory ?? workingDir
  return (
    <Section title="Your first project">
      <Muted>
        A project is a working directory: terminals and agents start there, and QuadFlow keeps its ideas,
        issues and plans in a <code className="font-mono">.quadflow</code> folder inside it. Pick an existing
        folder, or create a new one from the folder dialog.
      </Muted>
      <div className="rounded-lg border border-qf-border bg-qf-surface/40 p-3" data-onboarding-current-project>
        <div className="text-[11px] uppercase tracking-wide text-qf-text-muted">Current</div>
        <div className="mt-0.5 flex items-center gap-2">
          <Icon name="folder" className="h-4 w-4 text-qf-primary" />
          <span className="text-sm font-medium text-qf-text">{activeProject?.name ?? 'Default folder'}</span>
          {opened && <Badge tone="success" data-onboarding-project-opened>opened</Badge>}
        </div>
        {current && <p className="mt-1 truncate font-mono text-[11px] text-qf-text-muted" title={current}>{current}</p>}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={() => void choose()} loading={busy} data-onboarding-pick-project
          leftIcon={<Icon name="folder" className="h-3.5 w-3.5" />}>
          Choose or create a folder…
        </Button>
        <Button variant="ghost" onClick={() => useOnboardingStore.getState().setStep(3)} data-onboarding-skip-project>
          Skip for now
        </Button>
      </div>
      <Muted>Skipping keeps the default folder shown above. You can switch projects any time from the project sidebar.</Muted>
      <ErrorLine message={error} />
    </Section>
  )
}

// ---- 4. CLI ----

declare global {
  interface Window {
    /** Test hook (GUI harness): replaces "Install on PATH" so tests never touch the real PATH. */
    __QF_TEST_CLI_INSTALL__?: () => CliInstallStatus | Promise<CliInstallStatus>
  }
}

function CliStep() {
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setError(null)
    try {
      setStatus(await cliInstallApi.status())
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])

  const install = async () => {
    setBusy(true)
    setError(null)
    try {
      setStatus(await (window.__QF_TEST_CLI_INSTALL__ ? window.__QF_TEST_CLI_INSTALL__() : cliInstallApi.install()))
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const state = !status ? 'loading' : status.installed ? (status.version_match ? 'installed' : 'mismatch') : status.on_path ? 'other' : 'missing'
  return (
    <Section title="The quadflow CLI">
      <Muted>
        Agents read and update your ideas, issues, plans and scripts through the <code className="font-mono">quadflow</code> command.
        Agents launched from QuadFlow always find it; installing it on your PATH also makes it available in
        any other terminal. This adds a per-user PATH entry (no admin rights).
      </Muted>
      <div className="rounded-lg border border-qf-border bg-qf-surface/40 p-3" data-onboarding-cli-status={state}>
        {!status ? (
          <div className="flex items-center gap-2 text-xs text-qf-text-muted"><Spinner /> Checking…</div>
        ) : (
          <div className="flex flex-col gap-1.5 text-xs">
            <div className="flex items-center gap-2">
              {state === 'installed' && <Badge tone="success">installed on PATH</Badge>}
              {state === 'mismatch' && <Badge tone="warning">on PATH, version {status.version_on_path ?? '?'}</Badge>}
              {state === 'other' && <Badge tone="warning">another quadflow is on PATH</Badge>}
              {state === 'missing' && <Badge>not on PATH</Badge>}
              <span className="text-qf-text-muted">app v{status.app_version}</span>
            </div>
            {status.resolved_exe_on_path && (
              <p className="truncate font-mono text-[11px] text-qf-text-muted" title={status.resolved_exe_on_path}>{status.resolved_exe_on_path}</p>
            )}
            {status.message && <p className="text-qf-text-muted">{status.message}</p>}
            {!status.supported && <p className="text-qf-text-muted">Automatic install is not supported on this platform yet.</p>}
          </div>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {status && status.supported && state !== 'installed' && (
          <Button variant="primary" onClick={() => void install()} loading={busy} data-onboarding-cli-install>
            Install on PATH
          </Button>
        )}
        <Button variant="ghost" onClick={() => void refresh()} leftIcon={<Icon name="refresh" className="h-3 w-3" />}>
          Refresh
        </Button>
      </div>
      <ErrorLine message={error} />
    </Section>
  )
}

// ---- 5. Plugins ----

/** Optional first-party plugins that are not bundled (installed from Settings → Plugins). */
const OPTIONAL_PLUGINS: { id: string; name: string; description: string; ids: string[] }[] = [
  { id: 'streamer-kit', name: 'Streamer kit', description: 'YouTube Live chat overlay, YouTube Shorts and the OBS webcam tracker.', ids: ['youtube-live', 'youtube-shorts', 'obs-tracker'] },
  { id: 'semantic-search', name: 'Semantic search', description: 'Search past agent sessions by meaning (local embedding model).', ids: ['semantic-search'] },
  { id: 'local-titles', name: 'Local titles', description: 'Generate terminal titles with a local model instead of an API.', ids: ['local-titles'] },
  { id: 'discord-bot', name: 'Discord bridge (experimental)', description: 'Mirror terminal sessions into Discord threads and reply from Discord.', ids: ['discord-bot'] },
]

function PluginsStep() {
  const [plugins, setPlugins] = useState<PluginInfoData[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let disposed = false
    pluginsApi
      .list(false)
      .then((list) => { if (!disposed) setPlugins(list) })
      .catch((e) => { if (!disposed) { setError(errorMessage(e)); setPlugins([]) } })
    return () => { disposed = true }
  }, [])

  const bundled = (plugins ?? []).filter((p) => p.origin === 'bundled' && p.enabled && !p.id.startsWith('hello'))
  const present = new Set((plugins ?? []).map((p) => p.id))
  const goToPlugins = () => {
    void useOnboardingStore.getState().finish('completed')
    useAppSettingsStore.getState().openSettingsModalAt('plugins')
  }

  return (
    <div className="flex flex-col gap-4">
      <Section title="Included and enabled">
        <Muted>Every tool in QuadFlow is a plugin. These ship with the app and are already on.</Muted>
        {plugins === null ? (
          <div className="flex items-center gap-2 text-xs text-qf-text-muted"><Spinner /> Loading plugins…</div>
        ) : (
          <ul className="flex flex-wrap gap-1.5" data-onboarding-bundled>
            {bundled.map((p) => (
              <li key={p.id} data-onboarding-plugin={p.id} title={p.description ?? undefined}
                className="flex items-center gap-1.5 rounded-md border border-qf-border bg-qf-surface/40 px-2 py-1 text-xs text-qf-text">
                <PluginIcon pluginId={p.id} size={14} />
                {p.name}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="Optional">
        <ul className="flex flex-col gap-2" data-onboarding-optional>
          {OPTIONAL_PLUGINS.map((o) => {
            const installed = o.ids.some((id) => present.has(id))
            return (
              <li key={o.id} data-onboarding-optional-plugin={o.id}
                className="flex items-start gap-3 rounded-lg border border-qf-border bg-qf-surface/40 p-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-sm font-medium text-qf-text">
                    {o.name}
                    {installed ? <Badge tone="success">installed</Badge> : <Badge>not installed</Badge>}
                  </div>
                  <p className="mt-0.5 text-xs text-qf-text-muted">{o.description}</p>
                </div>
              </li>
            )
          })}
        </ul>
        <div>
          <Button variant="secondary" size="sm" onClick={goToPlugins} data-onboarding-open-plugins
            rightIcon={<Icon name="chevron-right" className="h-3 w-3" />}>
            Open Settings → Plugins
          </Button>
        </div>
      </Section>
      <ErrorLine message={error} />
    </div>
  )
}

// ---- 6. Done ----

function DoneStep() {
  const finish = useOnboardingStore((s) => s.finish)
  const [error, setError] = useState<string | null>(null)
  const run = (fn: () => void | Promise<void>) => async () => {
    try {
      await finish('completed')
      await fn()
    } catch (e) {
      setError(errorMessage(e))
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-qf-success/15 text-qf-success">
          <Icon name="check" className="h-5 w-5" />
        </span>
        <div>
          <h3 className="text-base font-semibold text-qf-text">You're all set</h3>
          <p className="text-xs text-qf-text-muted">A few things to try first:</p>
        </div>
      </div>
      <ul className="flex flex-col gap-2 text-sm text-qf-text">
        <Tip icon="terminal" title="Open a terminal" text="Terminal in the toolbar, or the button below.">
          <Button size="xs" variant="secondary" onClick={run(openNewTerminal)} data-onboarding-open-terminal>New terminal</Button>
        </Tip>
        <Tip icon="aiAgent" title="Launch an agent" text="AI Agent in the toolbar picks a provider, model and prompt.">
          <Button size="xs" variant="secondary" onClick={run(() => useAgentPromptStore.getState().openModal())} data-onboarding-launch-agent>
            Launch agent
          </Button>
        </Tip>
        <Tip icon="search" title="Command palette" text="Every action, tool and project in one search box.">
          <span className="flex items-center gap-1"><Kbd>{MOD_LABEL}</Kbd><Kbd>K</Kbd></span>
        </Tip>
        <Tip icon="info" title="Docs" text="Guides for agents, plugins and the CLI.">
          <Button size="xs" variant="ghost" onClick={() => openLink(DOCS_URL)} rightIcon={<Icon name="external" className="h-3 w-3" />}>
            Open docs
          </Button>
        </Tip>
      </ul>
      <ErrorLine message={error} />
    </div>
  )
}

function Tip({ icon, title, text, children }: { icon: Parameters<typeof Icon>[0]['name']; title: string; text: string; children?: ReactNode }) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-qf-border bg-qf-surface/40 p-2.5">
      <Icon name={icon} className="h-4 w-4 shrink-0 text-qf-primary" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{title}</div>
        <div className="text-xs text-qf-text-muted">{text}</div>
      </div>
      {children}
    </li>
  )
}
