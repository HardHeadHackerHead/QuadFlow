/**
 * Pure helpers of a script run (no host calls, type-only imports, so
 * `test/runLogic.test.ts` runs them with plain `node --test`).
 */
import type { ShellKind, TargetPlatform } from '@quadflow/plugin-api'

export function platformOf(userAgent: string): TargetPlatform {
  return /Windows/i.test(userAgent) ? 'windows' : /Mac/i.test(userAgent) ? 'macos' : 'linux'
}

export const PLATFORM: TargetPlatform = platformOf(typeof navigator === 'undefined' ? '' : navigator.userAgent)

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Terminal output as plain text (escape sequences removed, bare CRs as newlines). */
export const stripAnsi = (s: string) => s.replace(ANSI, '').replace(/\r(?!\n)/g, '\n')

/**
 * `line`, then leave the shell, so the PTY's exit (and its code) ends the run.
 * `shell` null = the platform default shell (PowerShell on Windows, a POSIX shell elsewhere).
 */
export function withExit(line: string, shell: ShellKind | null | undefined, platform: TargetPlatform = PLATFORM): string {
  const s = shell ?? (platform === 'windows' ? 'powershell' : 'sh')
  if (s === 'cmd') return `${line} & exit`
  if (s === 'powershell' || s === 'pwsh') return `${line}; exit $LASTEXITCODE`
  return `${line}; exit`
}

/** Output that marks a failed build even when the exit code is unknown or 0. */
export const ERROR_PATTERNS = [
  /error\s*[[:]/i,
  /failed\s*[[:]/i,
  /error TS\d+:/,
  /error\[E\d+\]:/,
  /npm ERR!/,
  /Build failed/i,
  /SyntaxError:/,
  /TypeError:/,
  /ELIFECYCLE/,
  /FATAL ERROR/i,
  /panic:/i,
  /Exception:/i,
  /Compilation failed/i,
]

/** A non-zero exit code, or (any code) output matching {@link ERROR_PATTERNS}. */
export function looksFailed(code: number | null, output: string): boolean {
  if (code !== null && code !== 0) return true
  const text = stripAnsi(output)
  return ERROR_PATTERNS.some((p) => p.test(text))
}

/** The lines an agent needs to fix a failure: error-looking lines plus the last 100, at most 150. */
export function errorContext(output: string): string {
  const lines = stripAnsi(output).split('\n')
  const errors = lines.filter((l) => /error|failed|exception/i.test(l))
  return [...new Set([...errors, ...lines.slice(-100)])].slice(-150).join('\n')
}
