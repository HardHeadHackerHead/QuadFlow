/**
 * Main area when the workspace has no terminals or tools: what to do next
 * instead of a blank screen. With no project open it leads with "Open a
 * project".
 */
import { useState } from 'react'
import { MOD_LABEL } from '../../lib/platformKeys'
import { Button, Icon, Kbd } from '@quadflow/ui'
import { useProjectStore } from '../../stores/projectStore'
import { useTerminalStore } from '../../stores/terminalStore'
import { useAgentPromptStore } from '../../stores/agentPromptStore'
import { useCommandPaletteStore } from '../../stores/commandPaletteStore'
import { openNewTerminal, pickAndOpenProject } from '../../lib/shellActions'
import { showOnboarding } from '../../onboarding/onboardingStore'
import quadflowLogo from '../../assets/logo.png'

export default function WorkspaceEmptyState() {
  const project = useProjectStore((s) => s.activeProject)
  const workingDir = useTerminalStore((s) => s.globalWorkingDirectory)
  const [error, setError] = useState<string | null>(null)
  const run = (fn: () => unknown) => async () => {
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="h-full w-full flex items-center justify-center overflow-auto p-6" data-empty-workspace={project ? 'project' : 'no-project'}>
      <div className="flex max-w-md flex-col items-center text-center">
        <img
          src={quadflowLogo}
          alt="QuadFlow"
          className="mb-5 h-28 w-28 select-none opacity-25 pointer-events-none"
          draggable={false}
        />
        {project ? (
          <>
            <p className="text-lg text-qf-text">No terminals or tools open</p>
            <p className="mt-1 text-sm text-qf-text-muted">
              Project <span className="font-medium text-qf-text">{project.name}</span>
              {workingDir && <span className="block truncate font-mono text-[11px]" title={workingDir}>{workingDir}</span>}
            </p>
          </>
        ) : (
          <>
            <p className="text-lg text-qf-text">No project open</p>
            <p className="mt-1 text-sm text-qf-text-muted">
              Open a folder as a project. Terminals and agents start there, and its ideas, issues and plans are kept with it.
            </p>
          </>
        )}

        <div className="mt-5 flex flex-wrap justify-center gap-2">
          {!project && (
            <Button variant="primary" onClick={run(pickAndOpenProject)} leftIcon={<Icon name="folder" className="h-3.5 w-3.5" />} data-empty-open-project>
              Open a project…
            </Button>
          )}
          <Button variant={project ? 'primary' : 'secondary'} onClick={run(openNewTerminal)} leftIcon={<Icon name="terminal" className="h-3.5 w-3.5" />} data-empty-new-terminal>
            New terminal
          </Button>
          <Button variant="secondary" onClick={() => useAgentPromptStore.getState().openModal()} leftIcon={<Icon name="aiAgent" className="h-3.5 w-3.5" />} data-empty-launch-agent>
            Launch agent
          </Button>
          {project && (
            <Button variant="ghost" onClick={run(pickAndOpenProject)} leftIcon={<Icon name="folder" className="h-3.5 w-3.5" />}>
              Open another folder…
            </Button>
          )}
        </div>

        <div className="mt-5 flex flex-col items-center gap-1.5 text-xs text-qf-text-muted">
          <button type="button" className="flex items-center gap-1.5 hover:text-qf-text" onClick={() => useCommandPaletteStore.getState().open()}>
            <Kbd>{MOD_LABEL}</Kbd><Kbd>K</Kbd> command palette: tools, actions, projects
          </button>
          <span>Tools live in the toolbar under “Tools”; drag them into the layout.</span>
          <button type="button" className="underline-offset-2 hover:text-qf-text hover:underline" onClick={showOnboarding} data-empty-show-welcome>
            Show the welcome guide
          </button>
        </div>
        {error && <p className="mt-3 text-xs text-qf-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}
