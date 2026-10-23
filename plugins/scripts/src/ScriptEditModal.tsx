/** Create / edit a saved script ("build recipe"). */
import { useState, type FormEvent } from 'react'
import type { ScriptInput_Deserialize, ScriptKind, ShellKind, TargetPlatform } from '@quadflow/plugin-api'
import { Modal } from '@quadflow/ui'
import type { Environment, Script } from './model'

interface Props {
  open: boolean
  script: Script | null
  environments: Environment[]
  onSave(input: ScriptInput_Deserialize): Promise<void>
  onClose(): void
}

const input =
  'w-full px-3 py-2 bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-purple-500'
const label = 'block text-sm font-medium text-vibe-muted mb-1'

export function ScriptEditModal({ open, script, environments, onSave, onClose }: Props) {
  // Keyed by the caller (`key={script?.id ?? 'new'}`), so state starts fresh per script.
  const [name, setName] = useState(script?.name ?? '')
  const [description, setDescription] = useState(script?.description ?? '')
  const [command, setCommand] = useState(script?.command ?? '')
  const [setup, setSetup] = useState(script?.setupCommands?.join('\n') ?? '')
  const [envVars, setEnvVars] = useState(script?.env ? Object.entries(script.env).map(([k, v]) => `${k}=${v}`).join('\n') : '')
  const [platform, setPlatform] = useState<TargetPlatform | 'all'>(script?.platforms?.length === 1 ? script.platforms[0] : 'all')
  const [shell, setShell] = useState<ShellKind | 'default'>(script?.shell ?? 'default')
  const [workingDirectory, setWorkingDirectory] = useState(script?.workingDirectory ?? '')
  const [environment, setEnvironment] = useState(script?.environment ?? '')
  const [kind, setKind] = useState<ScriptKind>(script?.kind ?? 'command')
  const [previewUrl, setPreviewUrl] = useState(script?.previewUrl ?? '')
  const [autoOpenPreview, setAutoOpenPreview] = useState(script?.autoOpenPreview ?? false)
  const [saving, setSaving] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const env: Record<string, string> = {}
    for (const line of envVars.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    const setupCommands = setup.split('\n').map((l) => l.trim()).filter(Boolean)
    setSaving(true)
    try {
      await onSave({
        name: name.trim(),
        description: description.trim() || null,
        command: command.trim(),
        setupCommands,
        env,
        platforms: platform === 'all' ? [] : [platform],
        shell: shell === 'default' ? null : shell,
        workingDirectory: workingDirectory.trim() || null,
        environment: environment || null,
        kind,
        previewUrl: kind === 'server' && previewUrl.trim() ? previewUrl.trim() : null,
        autoOpenPreview: kind === 'server' ? autoOpenPreview : false,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} size="lg" overlayId="scripts-edit" title={script ? 'Edit Script' : 'New Script'}>
      <form onSubmit={submit} className="qf-scripts">
        <div className="space-y-4">
          <div>
            <label className={label}>Name *</label>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Build with CUDA" required autoFocus data-field="name" />
          </div>
          <div>
            <label className={label}>Description</label>
            <input className={input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g., Builds the app with CUDA GPU support" />
          </div>
          <div>
            <label className={label}>Type</label>
            <div className="flex gap-2">
              {(['command', 'server', 'build'] as ScriptKind[]).map((k) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setKind(k)}
                  className={`flex-1 px-3 py-2 text-sm rounded-lg border transition-colors ${
                    kind === k
                      ? k === 'server'
                        ? 'bg-cyan-600/20 border-cyan-500/50 text-cyan-400'
                        : k === 'build'
                          ? 'bg-orange-600/20 border-orange-500/50 text-orange-400'
                          : 'bg-purple-600/20 border-purple-500/50 text-purple-400'
                      : 'border-vibe-border text-vibe-muted hover:text-vibe-text'
                  }`}
                >
                  <div className="font-medium capitalize">{k}</div>
                  <div className="text-[10px] opacity-75 mt-0.5">
                    {k === 'command' ? 'One-time command' : k === 'server' ? 'Long-running server' : 'Build process'}
                  </div>
                </button>
              ))}
            </div>
          </div>
          {kind === 'server' && (
            <div className="space-y-3 p-3 rounded-lg bg-cyan-500/5 border border-cyan-500/20">
              <div>
                <label className="block text-sm font-medium text-cyan-400 mb-1">Preview URL</label>
                <input className={`${input} font-mono text-sm`} value={previewUrl} onChange={(e) => setPreviewUrl(e.target.value)} placeholder="http://localhost:3000" />
              </div>
              <label className="flex items-center gap-2 text-sm text-vibe-muted cursor-pointer">
                <input type="checkbox" checked={autoOpenPreview} onChange={(e) => setAutoOpenPreview(e.target.checked)} className="w-4 h-4 accent-cyan-500" />
                Open the preview when the script starts
              </label>
            </div>
          )}
          <div>
            <label className={label}>
              Environment variables <span className="text-xs opacity-75">(one per line: KEY=value)</span>
            </label>
            <textarea className={`${input} font-mono text-sm`} rows={3} value={envVars} onChange={(e) => setEnvVars(e.target.value)} placeholder="NODE_ENV=production" />
          </div>
          <div>
            <label className={label}>
              Setup commands <span className="text-xs opacity-75">(run before the main command)</span>
            </label>
            <textarea className={`${input} font-mono text-sm`} rows={2} value={setup} onChange={(e) => setSetup(e.target.value)} placeholder="npm ci" />
          </div>
          <div>
            <label className={label}>Command *</label>
            <textarea className={`${input} font-mono text-sm`} rows={2} value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npm run tauri dev" required data-field="command" />
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className={label}>Terminal environment</label>
              <select className={input} value={environment} onChange={(e) => setEnvironment(e.target.value)}>
                <option value="">None (script shell)</option>
                {environments
                  .filter((e) => e.available || e.name === environment)
                  .map((e) => (
                    <option key={e.id} value={e.name}>
                      {e.name} ({e.shell})
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label className={label}>Platform</label>
              <select className={input} value={platform} onChange={(e) => setPlatform(e.target.value as TargetPlatform | 'all')}>
                <option value="all">All platforms</option>
                <option value="windows">Windows only</option>
                <option value="macos">macOS only</option>
                <option value="linux">Linux only</option>
              </select>
            </div>
          </div>
          {!environment && (
            <div>
              <label className={label}>Shell</label>
              <select className={input} value={shell} onChange={(e) => setShell(e.target.value as ShellKind | 'default')}>
                <option value="default">Default shell</option>
                <option value="cmd">Command Prompt (cmd)</option>
                <option value="powershell">Windows PowerShell</option>
                <option value="pwsh">PowerShell 7 (pwsh)</option>
                <option value="bash">Bash</option>
                <option value="zsh">Zsh</option>
                <option value="sh">sh</option>
              </select>
            </div>
          )}
          <div>
            <label className={label}>
              Working directory <span className="text-xs opacity-75">(relative to the project root)</span>
            </label>
            <input className={`${input} font-mono text-sm`} value={workingDirectory} onChange={(e) => setWorkingDirectory(e.target.value)} placeholder="Empty = project root" />
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 mt-4 pt-3 border-t border-vibe-border">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-vibe-muted hover:text-vibe-text">
            Cancel
          </button>
          <button
            type="submit"
            disabled={saving || !name.trim() || !command.trim()}
            className="px-4 py-2 text-sm bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white rounded-lg"
          >
            {script ? 'Save' : 'Create Script'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
