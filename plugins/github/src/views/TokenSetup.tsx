import { useState } from 'react'
import { useGitHubStore } from '../model'
import ExternalLink from './ExternalLink'

const TOKEN_URL = 'https://github.com/settings/tokens/new?scopes=repo,read:org&description=QuadFlow'

/**
 * Sign-in form: paste a GitHub personal access token (stored in the OS keychain through
 * `ctx.secrets`), or take the token of a signed-in GitHub CLI (`gh auth token`).
 */
export default function TokenSetup({ compact = false }: { compact?: boolean }) {
  const { setToken, importGhCliToken, checkAuth, ghInstalled } = useGitHubStore()
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<null | 'save' | 'gh' | 'check'>(null)
  const [error, setError] = useState<string | null>(null)

  const run = async (kind: 'save' | 'gh' | 'check', f: () => Promise<{ success?: boolean; authenticated?: boolean; error?: string }>) => {
    setBusy(kind)
    setError(null)
    try {
      const r = await f()
      if (r.error) setError(r.error)
      else if (r.success) setValue('')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="space-y-3" data-testid="github-token-setup">
      {!compact && (
        <div className="p-3 bg-vibe-surface border border-vibe-border rounded-lg text-sm text-vibe-muted space-y-1">
          <p>
            Connect with a GitHub personal access token (scopes <code className="bg-vibe-bg px-1 rounded">repo</code>,{' '}
            <code className="bg-vibe-bg px-1 rounded">read:org</code>). It is kept in your OS keychain.
          </p>
          <p>
            <ExternalLink href={TOKEN_URL} className="text-teal-400 hover:underline">Create a token on github.com →</ExternalLink>
          </p>
          {ghInstalled === true && <p className="text-yellow-400">The stored token was rejected — paste a new one.</p>}
        </div>
      )}
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) void run('save', () => setToken(value))
          }}
          placeholder="ghp_… or github_pat_…"
          aria-label="GitHub token"
          className="flex-1 min-w-0 px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-sm focus:outline-none focus:border-teal-500"
        />
        <button
          onClick={() => void run('save', () => setToken(value))}
          disabled={!value.trim() || busy !== null}
          className="px-3 py-2 bg-teal-600 hover:bg-teal-500 disabled:opacity-50 rounded-lg text-sm text-white"
        >
          {busy === 'save' ? 'Checking…' : 'Save token'}
        </button>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => void run('gh', importGhCliToken)}
          disabled={busy !== null}
          className="px-3 py-1.5 text-xs bg-vibe-surface border border-vibe-border hover:border-teal-500 rounded-lg disabled:opacity-50"
          title="Run `gh auth token` once and store the result"
        >
          {busy === 'gh' ? 'Reading gh token…' : 'Use GitHub CLI token'}
        </button>
        <button
          onClick={() => void run('check', checkAuth)}
          disabled={busy !== null}
          className="px-3 py-1.5 text-xs bg-vibe-surface border border-vibe-border hover:border-teal-500 rounded-lg disabled:opacity-50"
        >
          {busy === 'check' ? 'Checking…' : 'Check Connection'}
        </button>
      </div>
      {error && (
        <p className="text-xs text-red-400" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
