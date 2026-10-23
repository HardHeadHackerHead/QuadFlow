interface ContextUsageIndicatorProps {
  estimatedTokens: number
  contextWindow: number
  percentage: number
  isLoading: boolean
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    const val = tokens / 1_000_000
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}M`
  }
  if (tokens >= 1_000) {
    const val = tokens / 1_000
    return `${val % 1 === 0 ? val.toFixed(0) : val.toFixed(1)}K`
  }
  return String(tokens)
}

function getBarColor(pct: number): string {
  if (pct >= 90) return 'bg-red-500'
  if (pct >= 75) return 'bg-orange-500'
  if (pct >= 50) return 'bg-amber-500'
  if (pct >= 25) return 'bg-emerald-500'
  return 'bg-green-500'
}

export default function ContextUsageIndicator({
  estimatedTokens,
  contextWindow,
  percentage,
  isLoading,
}: ContextUsageIndicatorProps) {
  if (contextWindow === 0) return null

  const clampedPct = Math.min(percentage, 100)
  const tooltipText = `~${formatTokenCount(estimatedTokens)} / ${formatTokenCount(contextWindow)} tokens (${percentage.toFixed(1)}%)`

  return (
    <div
      className="flex items-center gap-1 flex-shrink-0 cursor-help"
      title={tooltipText}
    >
      {/* Mini progress bar */}
      <div className="w-10 h-1.5 rounded-full bg-vibe-border overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            isLoading ? 'opacity-60 animate-pulse' : ''
          } ${getBarColor(clampedPct)}`}
          style={{ width: `${clampedPct}%` }}
        />
      </div>
      {/* Percentage text */}
      <span className="text-[10px] font-mono text-vibe-muted tabular-nums leading-none">
        {Math.round(percentage)}%
      </span>
    </div>
  )
}
