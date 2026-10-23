import { TerminalEnvironment, TerminalEnvironmentType, ScriptPlatform, ScriptShell } from '../types'
import { call, commands } from './core'
import type { ShellKind, TerminalEnvironment_Serialize as CoreEnvironment } from '../generated/bindings'

// Detect current platform
export function getCurrentPlatform(): ScriptPlatform {
  const userAgent = navigator.userAgent.toLowerCase()
  if (userAgent.includes('win')) return 'windows'
  if (userAgent.includes('mac')) return 'macos'
  return 'linux'
}

// Get icon for environment type
export function getEnvironmentIcon(type: TerminalEnvironmentType): JSX.Element {
  switch (type) {
    case 'vs-native':
      return (
        <svg className="w-4 h-4 text-purple-400" fill="currentColor" viewBox="0 0 24 24">
          <path d="M1 3.75L6.7 8.2v7.6L1 20.25V3.75zm2.4 1.8v12.9l1.8-1.35V6.9L3.4 5.55zM8.3 4.2l8.4-3 4.3 1.7v18.2l-4.3 1.7-8.4-8.3V4.2zm1.8 1.9v11.8l5.6 5.5V4.6l-5.6 2.5v-.95z"/>
        </svg>
      )
    case 'system-powershell':
      return (
        <svg className="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 24 24">
          <path d="M23.181 2.974c.568 0 .923.463.792 1.035l-3.659 15.982c-.13.572-.697 1.035-1.265 1.035H.819c-.568 0-.923-.463-.792-1.035L3.686 4.009c.13-.572.697-1.035 1.265-1.035h18.23zM6.48 15.449l6.378-5.39-1.373-1.183-6.378 5.39 1.373 1.183zm7.857-1.183h-5.013v1.667h5.013v-1.667z"/>
        </svg>
      )
    case 'system-cmd':
      return (
        <svg className="w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
        </svg>
      )
    case 'system-bash':
      return (
        <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 24 24">
          <path d="M4 20q-.825 0-1.412-.587Q2 18.825 2 18V6q0-.825.588-1.412Q3.175 4 4 4h16q.825 0 1.413.588Q22 5.175 22 6v12q0 .825-.587 1.413Q20.825 20 20 20Zm0-2h16V8H4v10Zm4-2l-1.4-1.4L8.175 13 6.6 11.4 8 10l2.8 2.8L8 16Zm4 0v-2h4v2Z"/>
        </svg>
      )
    case 'custom':
    default:
      return (
        <svg className="w-4 h-4 text-amber-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      )
  }
}

// ==================== Core-backed environments (DL-6) ====================
//
// Terminal environments live in the core app DB (`environments_*` commands).
// The app-wide consumers use the shell's `TerminalEnvironment` shape held in
// appSettingsStore; these helpers map between the two. In the shell shape
// `shell` is the value to launch a terminal with: the detected executable path
// when the core knows it (e.g. Git Bash's bash.exe), else the shell name.

export function toShellEnvironment(e: CoreEnvironment): TerminalEnvironment {
  const type: TerminalEnvironmentType =
    e.kind === 'vs_dev' ? 'vs-native'
      : e.kind === 'custom' ? 'custom'
        : e.shell === 'cmd' ? 'system-cmd'
          : e.shell === 'powershell' || e.shell === 'pwsh' ? 'system-powershell'
            : 'system-bash'
  return {
    id: e.id,
    name: e.name,
    description: e.description ?? undefined,
    type,
    shell: (e.shellPath ?? e.shell) as ScriptShell,
    shellKind: e.shell,
    shellPath: e.shellPath ?? undefined,
    vsVersion: e.vs?.version,
    vsEdition: e.vs?.edition,
    vsArchitecture: e.vs?.arch,
    vcvarsPath: e.vs?.vcvarsPath,
    initCommands: e.initCommands && e.initCommands.length > 0 ? e.initCommands : undefined,
    env: e.env && Object.keys(e.env).length > 0 ? e.env : undefined,
    isBuiltIn: e.builtIn,
    isAvailable: e.available,
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  }
}

const SHELL_KINDS: ShellKind[] = ['cmd', 'powershell', 'pwsh', 'bash', 'zsh', 'sh']

function shellKindOf(env: TerminalEnvironment): ShellKind {
  if ((SHELL_KINDS as string[]).includes(env.shell)) return env.shell as ShellKind
  if (env.shellKind) return env.shellKind
  return getCurrentPlatform() === 'windows' ? 'cmd' : 'bash'
}

/** All environments known on this machine (core app DB). */
export async function listEnvironments(): Promise<TerminalEnvironment[]> {
  return (await call(commands.environmentsList())).map(toShellEnvironment)
}

/**
 * Detect shells / toolchains on this machine (core `environments_detect`, per
 * platform: cmd, Windows PowerShell, pwsh, Git Bash and Visual Studio on
 * Windows; zsh, bash, sh and pwsh on macOS/Linux) and return the full list,
 * custom environments included.
 */
export async function detectEnvironments(): Promise<TerminalEnvironment[]> {
  return (await call(commands.environmentsDetect())).map(toShellEnvironment)
}

/**
 * Persist edits to the custom (non-built-in) environments: deletes removed
 * ones and upserts added/changed ones, then returns the core's list.
 */
export async function saveCustomEnvironments(
  prev: TerminalEnvironment[],
  next: TerminalEnvironment[],
): Promise<TerminalEnvironment[]> {
  const coreIds = new Set(prev.map(e => e.id))
  const nextIds = new Set(next.map(e => e.id))
  for (const e of prev) {
    if (!e.isBuiltIn && !nextIds.has(e.id)) await call(commands.environmentsDelete(e.id))
  }
  for (const e of next) {
    if (e.isBuiltIn) continue
    const before = prev.find(p => p.id === e.id)
    if (before && before.updatedAt === e.updatedAt) continue
    await call(commands.environmentsUpsert({
      id: coreIds.has(e.id) ? e.id : null,
      name: e.name,
      description: e.description ?? null,
      shell: shellKindOf(e),
      shellPath: e.shellPath ?? null,
      initCommands: e.initCommands ?? [],
      env: e.env ?? {},
    }))
  }
  return listEnvironments()
}
