/** Small shared view pieces of the Missions tile. */
import type { ReactNode } from 'react'
import type { MissionMemberStatus, MissionStatus, ProviderInfo } from '@quadflow/plugin-api'
import { memberStatusConfig, missionStatusConfig, roleLook } from './display'

/** Portal content (modal bodies/footers) renders outside the tile: re-enter the style scope. */
export const Scoped = ({ children }: { children: ReactNode }) => <div className="qf-missions">{children}</div>

export const inputCls =
  'w-full bg-vibe-bg border border-vibe-border rounded px-2 py-1.5 text-sm text-vibe-text focus:outline-none focus:border-teal-500'
export const smallBtn = 'px-2 py-1 text-[11px] rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
export const primaryBtn = 'px-3 py-1.5 text-xs bg-teal-600 hover:bg-teal-500 text-white rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed'
export const ghostBtn = 'px-3 py-1.5 text-xs text-vibe-muted hover:text-vibe-text rounded transition-colors'

export function RoleBadge({ role }: { role: string }) {
  const cfg = roleLook(role)
  return <span className={`px-1.5 py-0.5 text-[10px] rounded-full whitespace-nowrap ${cfg.bgColor} ${cfg.color}`}>{cfg.label}</span>
}

export function StatusBadge({ status }: { status: MissionStatus }) {
  const cfg = missionStatusConfig[status] ?? missionStatusConfig.preparing
  return (
    <span data-testid="mission-status" className={`px-1.5 py-0.5 text-[10px] rounded-full whitespace-nowrap ${cfg.bgColor} ${cfg.color}`}>
      {cfg.label}
    </span>
  )
}

export function MemberDot({ status }: { status: MissionMemberStatus }) {
  const cfg = memberStatusConfig[status] ?? memberStatusConfig.pending
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${cfg.dotColor}`} />
}

export function ProviderBadge({ providerId, providers }: { providerId: string; providers: ProviderInfo[] }) {
  if (!providerId || providerId === 'default') {
    return <span className="px-1.5 py-0.5 text-[10px] rounded-full bg-gray-500/20 text-gray-400">Default agent</span>
  }
  const p = providers.find((x) => x.id === providerId)
  const color = p?.color ?? '#9ca3af'
  return (
    <span className="px-1.5 py-0.5 text-[10px] rounded-full" style={{ backgroundColor: `${color}33`, color }}>
      {p?.shortName ?? p?.displayName ?? providerId}
    </span>
  )
}

/** Green < 2 min, yellow 2–5 min, red > 5 min since the last heartbeat. */
export function Health({ lastHeartbeat }: { lastHeartbeat?: number | null }) {
  if (!lastHeartbeat) return null
  const elapsed = Date.now() - lastHeartbeat
  const color = elapsed < 2 * 60_000 ? 'text-green-400' : elapsed < 5 * 60_000 ? 'text-yellow-400' : 'text-red-400'
  const label = elapsed < 60_000 ? '<1m' : `${Math.round(elapsed / 60_000)}m`
  return (
    <span className={`text-[9px] ${color}`} title="Time since the last heartbeat">
      ♥ {label}
    </span>
  )
}

export function Empty({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="text-center py-6 text-xs text-vibe-muted">
      {children}
    </div>
  )
}
