/**
 * What a TUI tile runs, and the shell line that starts it (pure; unit-tested in
 * test/command.test.ts).
 *
 * The program is started by typing one line into a fresh shell (the shell stays
 * when the program exits, as in a terminal). On Windows the shell is PowerShell,
 * so the line is `& "<exe>" <args>`; elsewhere the default POSIX shell. Each
 * configured argument is one argv entry and is quoted when it needs it.
 */

export interface TuiProgram {
  executablePath: string
  args: string[]
  /** Absolute, or relative to the project root; empty = project root. */
  workingDirectory: string
  /** Typed into the shell before the program line. */
  initCommands: string[]
}

export type ShellFlavor = 'powershell' | 'posix'

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/** Read a program from tool-config settings or tile state (`{ executablePath, args, … }`). */
export function programFrom(v: unknown): TuiProgram | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const executablePath = typeof o.executablePath === 'string' ? o.executablePath.trim() : ''
  if (!executablePath) return null
  return {
    executablePath,
    args: strings(o.args),
    workingDirectory: typeof o.workingDirectory === 'string' ? o.workingDirectory.trim() : '',
    initCommands: strings(o.initCommands).filter((c) => c.trim()),
  }
}

/** Split a typed command line into executable + args (double/single quotes group). */
export function parseCommandLine(line: string): { executablePath: string; args: string[] } | null {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of line.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || cur) out.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has || cur) out.push(cur)
  if (!out.length || !out[0]) return null
  return { executablePath: out[0], args: out.slice(1) }
}

const SAFE = /^[\w@%+=:,./\\-]+$/

export function quoteArg(arg: string, shell: ShellFlavor): string {
  if (arg && SAFE.test(arg)) return arg
  if (shell === 'powershell') return `'${arg.replace(/'/g, "''")}'`
  return `'${arg.replace(/'/g, `'\\''`)}'`
}

/** Script files run through their interpreter (the OS association may open an editor instead). */
function interpreterFor(exe: string, shell: ShellFlavor): string | null {
  const ext = exe.toLowerCase().split('.').pop() ?? ''
  if (ext === 'py') return shell === 'powershell' ? 'python' : 'python3'
  if (ext === 'pyw') return shell === 'powershell' ? 'pythonw' : 'python3'
  return null
}

/** The line typed into the shell to start `p`. */
export function commandLine(p: TuiProgram, shell: ShellFlavor): string {
  const exe = p.executablePath
  const args = p.args.map((a) => quoteArg(a, shell))
  const quotedExe = shell === 'powershell' ? `"${exe.replace(/"/g, '`"')}"` : quoteArg(exe, shell)
  const interpreter = interpreterFor(exe, shell)
  const parts = interpreter ? [interpreter, quotedExe, ...args] : shell === 'powershell' ? ['&', quotedExe, ...args] : [quotedExe, ...args]
  return parts.join(' ')
}

/** Working directory for `terminals.spawn` (undefined = the project root). */
export function resolveCwd(dir: string, projectRoot: string | null | undefined): string | undefined {
  const d = dir.trim()
  if (!d) return undefined
  if (/^[a-zA-Z]:[\\/]/.test(d) || d.startsWith('/') || d.startsWith('\\\\') || d.startsWith('~')) return d
  if (!projectRoot) return d
  const sep = projectRoot.includes('\\') ? '\\' : '/'
  return `${projectRoot.replace(/[\\/]+$/, '')}${sep}${d.replace(/^[.][\\/]/, '').replace(/[\\/]/g, sep)}`
}
