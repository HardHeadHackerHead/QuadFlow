// The Code Quality tile (ported from the shell's CodeQualityToolView): scans the active
// project through `ctx.fs` and asks the Chat endpoint for a short assessment.
import { useEffect, useState, useCallback, useSyncExternalStore, type ReactNode } from 'react'
import type { PluginContext, TileProps } from '@quadflow/plugin-api'
import { codeQualityModel } from './model'
import type { FileAnalysis, QualityGrade, LanguageMetrics } from './types'

function useProjectRoot(ctx: PluginContext): string | null {
  return useSyncExternalStore(
    (cb) => ctx.project.onDidChange(cb),
    () => ctx.project.current()?.root ?? null,
  )
}

// ==================== Helpers ====================

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return n.toLocaleString()
}

function gradeColor(grade: QualityGrade): string {
  switch (grade) {
    case 'A': return '#22c55e'
    case 'B': return '#84cc16'
    case 'C': return '#eab308'
    case 'D': return '#f97316'
    case 'F': return '#ef4444'
  }
}

function scoreColor(score: number): string {
  if (score >= 70) return 'text-green-400'
  if (score >= 40) return 'text-yellow-400'
  return 'text-red-400'
}

function complexityLevel(c: number): { label: string; color: string; bg: string } {
  if (c <= 5) return { label: 'Low', color: 'text-green-400', bg: 'bg-green-500' }
  if (c <= 10) return { label: 'Moderate', color: 'text-yellow-400', bg: 'bg-yellow-500' }
  if (c <= 20) return { label: 'High', color: 'text-orange-400', bg: 'bg-orange-500' }
  return { label: 'Very High', color: 'text-red-400', bg: 'bg-red-500' }
}

// ==================== Sub-Components ====================

function QualityGauge({ score, grade }: { score: number; grade: QualityGrade }) {
  const radius = 54
  const circumference = 2 * Math.PI * radius
  const offset = circumference - (score / 100) * circumference
  const color = gradeColor(grade)

  return (
    <div className="relative inline-flex items-center justify-center">
      <svg width="140" height="140" viewBox="0 0 140 140">
        {/* Background circle */}
        <circle
          cx="70" cy="70" r={radius}
          fill="none"
          stroke="currentColor"
          className="text-vibe-border"
          strokeWidth="10"
        />
        {/* Score arc */}
        <circle
          cx="70" cy="70" r={radius}
          fill="none"
          stroke={color}
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          transform="rotate(-90 70 70)"
          className="transition-all duration-1000"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-bold" style={{ color }}>{grade}</span>
        <span className="text-sm text-vibe-muted">{score}/100</span>
      </div>
    </div>
  )
}

function MetricCard({ label, value, subValue, icon, color }: {
  label: string
  value: string | number
  subValue?: string
  icon: ReactNode
  color: string
}) {
  return (
    <div className="bg-vibe-bg rounded-lg p-3 border border-vibe-border">
      <div className="flex items-center gap-2 mb-1">
        <span className={color}>{icon}</span>
        <span className="text-xs text-vibe-muted">{label}</span>
      </div>
      <div className="text-xl font-bold text-vibe-text">
        {typeof value === 'number' ? formatNumber(value) : value}
      </div>
      {subValue && <div className="text-xs text-vibe-muted">{subValue}</div>}
    </div>
  )
}

function LanguageBar({ languages }: { languages: { language: string; percentage: number; color: string }[] }) {
  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden bg-vibe-bg">
        {languages.map((lang) => (
          <div
            key={lang.language}
            className="h-full transition-all duration-500"
            style={{ width: `${lang.percentage}%`, backgroundColor: lang.color }}
            title={`${lang.language}: ${lang.percentage}%`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-3 gap-y-1">
        {languages.filter(l => l.percentage >= 1).map((lang) => (
          <div key={lang.language} className="flex items-center gap-1.5 text-xs">
            <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: lang.color }} />
            <span className="text-vibe-muted">{lang.language}</span>
            <span className="font-medium">{lang.percentage}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

function ScanProgressBar({ progress }: { progress: { phase: string; filesFound: number; filesAnalyzed: number; currentFile?: string } }) {
  const pct = progress.filesFound > 0
    ? Math.round((progress.filesAnalyzed / progress.filesFound) * 100)
    : 0

  return (
    <div className="space-y-2">
      <div className="flex justify-between text-sm">
        <span className="text-vibe-muted capitalize">{progress.phase}...</span>
        <span className="text-vibe-muted">{progress.filesAnalyzed}/{progress.filesFound} files</span>
      </div>
      <div className="h-2 bg-vibe-bg rounded-full overflow-hidden">
        <div
          className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-300"
          style={{ width: `${progress.phase === 'scanning' ? 30 : Math.max(pct, 5)}%` }}
        />
      </div>
      {progress.currentFile && (
        <div className="text-xs text-vibe-muted truncate">{progress.currentFile}</div>
      )}
    </div>
  )
}

function ScoreBar({ label, score, value, valueLabel }: { label: string; score: number; value: number | string; valueLabel?: string }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-sm">
        <span className="text-vibe-muted">{label}</span>
        <span className="font-medium">
          {score}
          <span className="text-vibe-muted text-xs ml-1">({valueLabel || value})</span>
        </span>
      </div>
      <div className="h-2.5 bg-vibe-bg rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            score >= 70 ? 'bg-green-500' : score >= 40 ? 'bg-yellow-500' : 'bg-red-500'
          }`}
          style={{ width: `${score}%` }}
        />
      </div>
    </div>
  )
}

function LanguageRow({ lang, totalCode }: { lang: LanguageMetrics; totalCode: number }) {
  const pct = totalCode > 0 ? Math.round((lang.lines.code / totalCode) * 1000) / 10 : 0
  return (
    <div className="flex items-center gap-3 py-2">
      <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: lang.color }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm font-medium capitalize">{lang.language}</span>
          <span className="text-xs text-vibe-muted">{lang.fileCount} files / {formatNumber(lang.lines.code)} LOC</span>
        </div>
        <div className="h-1.5 bg-vibe-bg rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{ width: `${pct}%`, backgroundColor: lang.color }}
          />
        </div>
      </div>
      <span className="text-xs font-medium w-12 text-right">{pct}%</span>
    </div>
  )
}

function ComplexityChart({ distribution }: { distribution: { low: number; moderate: number; high: number; veryHigh: number } }) {
  const total = distribution.low + distribution.moderate + distribution.high + distribution.veryHigh
  if (total === 0) return <div className="text-sm text-vibe-muted">No code files analyzed</div>

  const buckets = [
    { label: 'Low (1-5)', count: distribution.low, color: 'bg-green-500', textColor: 'text-green-400' },
    { label: 'Moderate (6-10)', count: distribution.moderate, color: 'bg-yellow-500', textColor: 'text-yellow-400' },
    { label: 'High (11-20)', count: distribution.high, color: 'bg-orange-500', textColor: 'text-orange-400' },
    { label: 'Very High (21+)', count: distribution.veryHigh, color: 'bg-red-500', textColor: 'text-red-400' },
  ]

  const maxCount = Math.max(...buckets.map(b => b.count), 1)

  return (
    <div className="space-y-3">
      {buckets.map((bucket) => (
        <div key={bucket.label} className="space-y-1">
          <div className="flex justify-between text-sm">
            <span className={bucket.textColor}>{bucket.label}</span>
            <span className="text-vibe-muted">{bucket.count} files ({total > 0 ? Math.round((bucket.count / total) * 100) : 0}%)</span>
          </div>
          <div className="h-4 bg-vibe-bg rounded overflow-hidden">
            <div
              className={`h-full ${bucket.color} transition-all duration-500 rounded`}
              style={{ width: `${(bucket.count / maxCount) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  )
}

function ComplexFileRow({ file, index }: { file: FileAnalysis; index: number }) {
  const level = complexityLevel(file.complexity)
  const shortPath = file.path.replace(/\\/g, '/').split('/').slice(-3).join('/')

  return (
    <tr className="border-b border-vibe-border/50 hover:bg-vibe-border/20">
      <td className="py-1.5 pr-2 text-xs text-vibe-muted">{index + 1}</td>
      <td className="py-1.5 pr-2 text-xs truncate max-w-[200px]" title={file.path}>{shortPath}</td>
      <td className="py-1.5 pr-2 text-xs capitalize text-vibe-muted">{file.language}</td>
      <td className={`py-1.5 pr-2 text-xs font-medium ${level.color}`}>{file.complexity}</td>
      <td className="py-1.5 text-xs text-vibe-muted">{file.lines.code}</td>
    </tr>
  )
}

// ==================== Main Component ====================

export function CodeQualityTile({ ctx, visible }: TileProps) {
  const model = codeQualityModel(ctx)
  const metrics = model.use((s) => s.metrics)
  const isScanning = model.use((s) => s.isScanning)
  const error = model.use((s) => s.error)
  const pathWarning = model.use((s) => s.pathWarning)
  const scanProgress = model.use((s) => s.scanProgress)
  const llmInsightLoading = model.use((s) => s.llmInsightLoading)
  const llmError = model.use((s) => s.llmError)
  const { scan, forceScan, refresh, requestLlmInsight } = model

  const workingDir = useProjectRoot(ctx)

  const [activeTab, setActiveTab] = useState<'overview' | 'languages' | 'complexity' | 'tests'>('overview')

  // Scan when shown without results (on mount and after a project switch, which clears them).
  useEffect(() => {
    if (visible && workingDir && !metrics && !isScanning && !error && !pathWarning) {
      void scan()
    }
  }, [visible, workingDir, metrics, isScanning, error, pathWarning, scan])

  const handleRefresh = useCallback(() => {
    refresh()
  }, [refresh])

  if (!workingDir) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-vibe-bg">
        <p className="text-sm text-vibe-muted">Open a project to see its code quality.</p>
      </div>
    )
  }

  // Loading state
  if (isScanning) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-vibe-bg">
        <div className="text-center w-64">
          <div className="animate-spin w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full mx-auto mb-4" />
          <p className="text-vibe-text font-medium mb-3">Scanning project...</p>
          <ScanProgressBar progress={scanProgress} />
        </div>
      </div>
    )
  }

  // Error state
  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-vibe-bg">
        <div className="text-center max-w-sm">
          <svg className="w-12 h-12 mx-auto mb-3 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p className="text-vibe-text font-medium mb-2">Scan Failed</p>
          <p className="text-sm text-vibe-muted mb-4">{error}</p>
          <button
            onClick={handleRefresh}
            className="px-4 py-2 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-sm transition-colors text-white"
          >
            Try Again
          </button>
        </div>
      </div>
    )
  }

  // Path warning state
  if (pathWarning) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-vibe-bg">
        <div className="text-center max-w-sm px-4">
          <svg className="w-12 h-12 mx-auto mb-3 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <p className="text-vibe-text font-medium mb-2">Directory Warning</p>
          <div className="space-y-1.5 mb-3">
            {pathWarning.map((w, i) => (
              <p key={i} className="text-sm text-vibe-muted">{w}</p>
            ))}
          </div>
          {workingDir && (
            <div className="bg-vibe-bg-lighter rounded-lg px-3 py-2 mb-4 border border-vibe-border">
              <p className="text-xs text-vibe-muted mb-0.5">Scan target</p>
              <p className="text-xs font-mono text-vibe-text truncate" title={workingDir}>{workingDir}</p>
            </div>
          )}
          <button
            onClick={forceScan}
            className="px-4 py-2 bg-yellow-600 hover:bg-yellow-500 rounded-lg text-sm transition-colors text-white"
          >
            Scan Anyway
          </button>
        </div>
      </div>
    )
  }

  // Empty state
  if (!metrics) {
    return (
      <div className="h-full w-full flex items-center justify-center bg-vibe-bg">
        <div className="text-center">
          <svg className="w-12 h-12 mx-auto mb-3 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
          </svg>
          <p className="text-vibe-text font-medium mb-2">Code Quality</p>
          <p className="text-sm text-vibe-muted mb-4">Scan your project to see quality metrics</p>
          <button
            onClick={scan}
            className="px-4 py-2 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 rounded-lg text-sm transition-colors text-white"
          >
            Start Scan
          </button>
        </div>
      </div>
    )
  }

  const langPercentages = model.languagePercentages()

  return (
    <div className="h-full w-full flex flex-col bg-vibe-bg text-vibe-text overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-vibe-border p-3">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            <span className="font-medium">Code Quality</span>
            <span className="text-xs font-semibold" data-testid="cq-grade">{metrics.qualityScore.grade} · {metrics.totalFiles} files</span>
          </div>
          <button
            onClick={handleRefresh}
            disabled={isScanning}
            className="p-1.5 text-vibe-muted hover:text-vibe-text rounded transition-colors disabled:opacity-50"
            title="Rescan"
          >
            <svg className={`w-4 h-4 ${isScanning ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex gap-1 p-1 bg-vibe-bg-lighter rounded-lg">
          {[
            { id: 'overview', label: 'Overview' },
            { id: 'languages', label: 'Languages' },
            { id: 'complexity', label: 'Complexity' },
            { id: 'tests', label: 'Tests' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as typeof activeTab)}
              className={`flex-1 px-3 py-1.5 text-xs font-medium rounded transition-colors ${
                activeTab === tab.id
                  ? 'bg-gradient-to-r from-cyan-500 to-blue-500 text-white'
                  : 'text-vibe-muted hover:text-vibe-text'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-3">
        {/* Overview Tab */}
        {activeTab === 'overview' && (
          <div className="space-y-4">
            {/* Gauge + Metric Cards */}
            <div className="flex items-center gap-4">
              <QualityGauge score={metrics.qualityScore.overall} grade={metrics.qualityScore.grade} />
              <div className="flex-1 grid grid-cols-1 gap-2">
                <MetricCard
                  label="Lines of Code"
                  value={metrics.totalLines.code}
                  subValue={`${formatNumber(metrics.totalLines.total)} total`}
                  color="text-cyan-400"
                  icon={
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                    </svg>
                  }
                />
                <MetricCard
                  label="Files"
                  value={metrics.totalFiles}
                  subValue={`${metrics.languages.length} languages`}
                  color="text-blue-400"
                  icon={
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>
                  }
                />
                <MetricCard
                  label="Avg Complexity"
                  value={metrics.complexityMetrics.average}
                  subValue={complexityLevel(metrics.complexityMetrics.average).label}
                  color={complexityLevel(metrics.complexityMetrics.average).color}
                  icon={
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  }
                />
              </div>
            </div>

            {/* Score Breakdown */}
            <div className="bg-vibe-bg-lighter rounded-lg p-4 border border-vibe-border">
              <h3 className="text-sm font-medium mb-3">Score Breakdown</h3>
              <div className="space-y-3">
                <ScoreBar
                  label="Comment Ratio (20%)"
                  score={metrics.qualityScore.breakdown.commentRatio.score}
                  value={metrics.qualityScore.breakdown.commentRatio.value}
                  valueLabel={`${metrics.qualityScore.breakdown.commentRatio.value}%`}
                />
                <ScoreBar
                  label="Test Coverage (30%)"
                  score={metrics.qualityScore.breakdown.testCoverage.score}
                  value={metrics.qualityScore.breakdown.testCoverage.value}
                  valueLabel={`${metrics.qualityScore.breakdown.testCoverage.value}% ratio`}
                />
                <ScoreBar
                  label="Complexity (30%)"
                  score={metrics.qualityScore.breakdown.complexity.score}
                  value={metrics.qualityScore.breakdown.complexity.value}
                  valueLabel={`avg ${metrics.qualityScore.breakdown.complexity.value}`}
                />
                <ScoreBar
                  label="Organization (20%)"
                  score={metrics.qualityScore.breakdown.organization.score}
                  value={metrics.qualityScore.breakdown.organization.value}
                />
              </div>
            </div>

            {/* Language Composition */}
            <div className="bg-vibe-bg-lighter rounded-lg p-4 border border-vibe-border">
              <h3 className="text-sm font-medium mb-3">Language Composition</h3>
              <LanguageBar languages={langPercentages} />
            </div>

            {/* AI Insight */}
            <div className="bg-vibe-bg-lighter rounded-lg p-4 border border-vibe-border" data-testid="cq-insight">
              {llmError && !metrics.llmInsight && !llmInsightLoading && (
                <div className="mb-2 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-400" role="alert" data-testid="cq-insight-error">
                  <span className="font-medium">AI insight unavailable:</span> {llmError}
                </div>
              )}
              {metrics.llmInsight ? (
                <div>
                  <h3 className="text-sm font-medium mb-2 flex items-center gap-2">
                    <svg className="w-4 h-4 text-cyan-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                    </svg>
                    AI Assessment
                  </h3>
                  <p className="text-sm text-vibe-muted leading-relaxed">{metrics.llmInsight}</p>
                </div>
              ) : (
                <button
                  onClick={() => void requestLlmInsight()}
                  data-testid="cq-insight-button"
                  disabled={llmInsightLoading}
                  className="w-full flex items-center justify-center gap-2 py-2 text-sm text-cyan-400 hover:text-cyan-300 transition-colors disabled:opacity-50"
                >
                  {llmInsightLoading ? (
                    <>
                      <div className="animate-spin w-4 h-4 border-2 border-cyan-400 border-t-transparent rounded-full" />
                      Analyzing...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
                      </svg>
                      Get AI Insight
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}

        {/* Languages Tab */}
        {activeTab === 'languages' && (
          <div className="space-y-4">
            {/* Stacked bar at top */}
            <div className="bg-vibe-bg-lighter rounded-lg p-4 border border-vibe-border">
              <h3 className="text-sm font-medium mb-3">Language Distribution</h3>
              <LanguageBar languages={langPercentages} />
            </div>

            {/* Per-language rows */}
            <div className="bg-vibe-bg-lighter rounded-lg p-4 border border-vibe-border">
              <h3 className="text-sm font-medium mb-3">Details</h3>
              <div className="divide-y divide-vibe-border/50">
                {metrics.languages.map((lang) => (
                  <LanguageRow key={lang.language} lang={lang} totalCode={metrics.totalLines.code} />
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Complexity Tab */}
        {activeTab === 'complexity' && (
          <div className="space-y-4">
            {/* Distribution chart */}
            <div className="bg-vibe-bg-lighter rounded-lg p-4 border border-vibe-border">
              <h3 className="text-sm font-medium mb-3">Complexity Distribution</h3>
              <ComplexityChart distribution={metrics.complexityMetrics.distribution} />
            </div>

            {/* Top complex files */}
            {metrics.complexityMetrics.topFiles.length > 0 && (
              <div className="bg-vibe-bg-lighter rounded-lg p-4 border border-vibe-border">
                <h3 className="text-sm font-medium mb-3">Most Complex Files</h3>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead>
                      <tr className="border-b border-vibe-border">
                        <th className="pb-2 pr-2 text-xs text-vibe-muted font-medium">#</th>
                        <th className="pb-2 pr-2 text-xs text-vibe-muted font-medium">File</th>
                        <th className="pb-2 pr-2 text-xs text-vibe-muted font-medium">Lang</th>
                        <th className="pb-2 pr-2 text-xs text-vibe-muted font-medium">Complexity</th>
                        <th className="pb-2 text-xs text-vibe-muted font-medium">Lines</th>
                      </tr>
                    </thead>
                    <tbody>
                      {metrics.complexityMetrics.topFiles.map((file, i) => (
                        <ComplexFileRow key={file.path} file={file} index={i} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Tests Tab */}
        {activeTab === 'tests' && (
          <div className="space-y-4">
            {/* Ratio display */}
            <div className="bg-vibe-bg-lighter rounded-lg p-4 border border-vibe-border text-center">
              <div className={`text-4xl font-bold ${scoreColor(metrics.qualityScore.breakdown.testCoverage.score)}`}>
                {Math.round(metrics.testMetrics.testToSourceRatio * 100)}%
              </div>
              <div className="text-sm text-vibe-muted mt-1">Test-to-Source Ratio</div>
              <div className="text-xs text-vibe-muted mt-2">
                {metrics.testMetrics.testFiles} test files / {metrics.testMetrics.sourceFiles} source files
              </div>
            </div>

            {/* Source vs Test comparison */}
            <div className="bg-vibe-bg-lighter rounded-lg p-4 border border-vibe-border">
              <h3 className="text-sm font-medium mb-3">Source vs Test Files</h3>
              <div className="space-y-3">
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-vibe-muted">Source Files</span>
                    <span className="font-medium">{metrics.testMetrics.sourceFiles}</span>
                  </div>
                  <div className="h-3 bg-vibe-bg rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-500"
                      style={{ width: '100%' }}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="text-vibe-muted">Test Files</span>
                    <span className="font-medium">{metrics.testMetrics.testFiles}</span>
                  </div>
                  <div className="h-3 bg-vibe-bg rounded-full overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-green-500 to-emerald-500 transition-all duration-500"
                      style={{
                        width: `${metrics.testMetrics.sourceFiles > 0
                          ? (metrics.testMetrics.testFiles / metrics.testMetrics.sourceFiles) * 100
                          : 0}%`
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Per-language test breakdown */}
            {Object.keys(metrics.testMetrics.languageBreakdown).length > 0 && (
              <div className="bg-vibe-bg-lighter rounded-lg p-4 border border-vibe-border">
                <h3 className="text-sm font-medium mb-3">Tests by Language</h3>
                <div className="space-y-3">
                  {Object.entries(metrics.testMetrics.languageBreakdown)
                    .filter(([, v]) => v.sourceFiles > 0 || v.testFiles > 0)
                    .sort(([, a], [, b]) => (b.testFiles + b.sourceFiles) - (a.testFiles + a.sourceFiles))
                    .map(([lang, data]) => {
                      const ratio = data.sourceFiles > 0 ? (data.testFiles / data.sourceFiles * 100) : 0
                      return (
                        <div key={lang} className="flex items-center gap-3">
                          <span className="text-sm capitalize w-24 flex-shrink-0">{lang}</span>
                          <div className="flex-1 flex items-center gap-2">
                            <span className="text-xs text-vibe-muted w-16">{data.testFiles}T / {data.sourceFiles}S</span>
                            <div className="flex-1 h-2 bg-vibe-bg rounded-full overflow-hidden">
                              <div
                                className={`h-full rounded-full ${ratio >= 30 ? 'bg-green-500' : ratio >= 10 ? 'bg-yellow-500' : 'bg-red-500'}`}
                                style={{ width: `${Math.min(ratio, 100)}%` }}
                              />
                            </div>
                            <span className="text-xs font-medium w-10 text-right">{Math.round(ratio)}%</span>
                          </div>
                        </div>
                      )
                    })}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="flex-shrink-0 border-t border-vibe-border px-3 py-2">
        <div className="flex items-center justify-between text-xs text-vibe-muted">
          <span>Scanned in {(metrics.scanDuration / 1000).toFixed(1)}s</span>
          <span>{metrics.totalFiles} files analyzed</span>
        </div>
      </div>
    </div>
  )
}
