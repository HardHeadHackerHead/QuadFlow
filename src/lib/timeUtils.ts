/**
 * Compact relative time formatter.
 * Returns: "now" (<60s), "3m" (<60m), "2h" (<24h), "5d" (<30d), "Mar 28" (older)
 */
export function relativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  if (diff < 60_000) return 'now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)}d`
  return new Date(timestamp).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
