/**
 * Code Quality state, one model per plugin context (the pane and the flyout tile share it).
 *
 * Ported from the shell's `codeQualityStore`: the scan root is the active project
 * (`ctx.project.current()`), files are read through `ctx.fs` (`project` scope), and the LLM
 * insight is a one-off question to the Chat endpoint through `ctx.data.chat.ask`
 * (`chatAsk` from `@quadflow/plugin-kit`; nothing is stored). A failing insight (no endpoint configured, …) is
 * shown in the tile instead of being swallowed.
 */
import type { PluginContext } from '@quadflow/plugin-api'
import { chatAsk, errorMessage } from '@quadflow/plugin-kit'
import { create as createZustand, type StoreApi, type UseBoundStore } from 'zustand'
import { scanProject, validateProjectPath, type ScanFs } from './analysis'
import type { CodeQualityMetrics, LanguageMetrics, ScanProgress } from './types'

export interface CodeQualityState {
  /** Project root the metrics / warning belong to. */
  root: string | null
  metrics: CodeQualityMetrics | null
  isScanning: boolean
  error: string | null
  scanProgress: ScanProgress
  llmInsightLoading: boolean
  llmError: string | null
  pathWarning: string[] | null
}

const IDLE: ScanProgress = { phase: 'idle', filesFound: 0, filesAnalyzed: 0 }

export interface CodeQualityModel {
  store: UseBoundStore<StoreApi<CodeQualityState>>
  use<T>(sel: (s: CodeQualityState) => T): T
  /** Validate the project path, then scan (or show the path warning). */
  scan(): Promise<void>
  /** Scan without the path check ("Scan Anyway"). */
  forceScan(): Promise<void>
  refresh(): Promise<void>
  requestLlmInsight(): Promise<void>
  languagePercentages(): { language: string; percentage: number; color: string }[]
  topLanguages(limit?: number): LanguageMetrics[]
}

/** `ctx.fs` with the `project` scope, as the scan's file adapter. */
export function projectFs(ctx: PluginContext): ScanFs {
  return {
    list: (p) => ctx.fs.list(p, 'project'),
    readText: (p) => ctx.fs.readText(p, 'project'),
    stat: (p) => ctx.fs.stat(p, 'project'),
  }
}

const models = new WeakMap<PluginContext, CodeQualityModel>()

export function codeQualityModel(ctx: PluginContext): CodeQualityModel {
  let m = models.get(ctx)
  if (!m) {
    m = create(ctx)
    models.set(ctx, m)
  }
  return m
}

function create(ctx: PluginContext): CodeQualityModel {
  const store = createZustand<CodeQualityState>()(() => ({
    root: null,
    metrics: null,
    isScanning: false,
    error: null,
    scanProgress: IDLE,
    llmInsightLoading: false,
    llmError: null,
    pathWarning: null,
  }))
  const set = store.setState
  const get = store.getState

  const currentRoot = () => ctx.project.current()?.root ?? null

  async function forceScan() {
    if (get().isScanning) return
    const root = currentRoot()
    if (!root) {
      set({ error: 'No project is open. Open a project to scan it.', root: null })
      return
    }
    set({ root, isScanning: true, error: null, pathWarning: null, llmError: null, scanProgress: { phase: 'scanning', filesFound: 0, filesAnalyzed: 0 } })
    try {
      const metrics = await scanProject(root, projectFs(ctx), (progress) => {
        if (currentRoot() === root) set({ scanProgress: progress })
      })
      if (currentRoot() !== root) return
      set({ metrics, isScanning: false, scanProgress: { phase: 'done', filesFound: metrics.totalFiles, filesAnalyzed: metrics.totalFiles } })
    } catch (e) {
      ctx.log.error('code quality scan failed', e)
      set({ error: errorMessage(e) || 'Failed to scan project', isScanning: false, scanProgress: IDLE })
    } finally {
      if (get().isScanning && currentRoot() !== root) set({ isScanning: false, scanProgress: IDLE })
    }
  }

  async function scan() {
    if (get().isScanning) return
    const root = currentRoot()
    if (!root) {
      set({ error: 'No project is open. Open a project to scan it.', root: null })
      return
    }
    try {
      const validation = await validateProjectPath(root, projectFs(ctx))
      if (!validation.safe) {
        set({ root, pathWarning: validation.warnings, metrics: null, error: null })
        return
      }
    } catch {
      // If validation itself fails, proceed with the scan anyway.
    }
    await forceScan()
  }

  async function requestLlmInsight() {
    const { metrics, llmInsightLoading } = get()
    if (!metrics || llmInsightLoading) return
    set({ llmInsightLoading: true, llmError: null })
    const summary = [
      `Project: ${metrics.projectPath}`,
      `Files: ${metrics.totalFiles}, Lines of code: ${metrics.totalLines.code}, Comments: ${metrics.totalLines.comment}`,
      `Languages: ${metrics.languages.slice(0, 5).map((l) => `${l.language} (${l.fileCount} files)`).join(', ')}`,
      `Test files: ${metrics.testMetrics.testFiles}, Source files: ${metrics.testMetrics.sourceFiles}, Test ratio: ${(metrics.testMetrics.testToSourceRatio * 100).toFixed(1)}%`,
      `Avg complexity: ${metrics.complexityMetrics.average}, High complexity files: ${metrics.complexityMetrics.distribution.high + metrics.complexityMetrics.distribution.veryHigh}`,
      `Quality score: ${metrics.qualityScore.overall}/100 (${metrics.qualityScore.grade})`,
      `Comment ratio: ${metrics.qualityScore.breakdown.commentRatio.value}%`,
    ].join('\n')
    try {
      const insight = await chatAsk(
        ctx,
        `Here are the code quality metrics for this project:\n\n${summary}\n\nGive a brief 2-3 sentence assessment.`,
        {
          systemPrompt:
            'You are a senior software engineer reviewing code quality metrics. Give a concise 2-3 sentence assessment of the project health based on the metrics provided. Be specific and actionable. Do not use markdown formatting.',
        },
      )
      set((s) => ({
        metrics: s.metrics ? { ...s.metrics, llmInsight: insight.trim() } : s.metrics,
        llmInsightLoading: false,
      }))
    } catch (e) {
      ctx.log.warn('code quality insight failed', e)
      set({ llmInsightLoading: false, llmError: errorMessage(e) || 'The AI insight request failed' })
    }
  }

  const model: CodeQualityModel = {
    store,
    use: (sel) => store(sel),
    scan,
    forceScan,
    async refresh() {
      set({ metrics: null, pathWarning: null, error: null, llmError: null })
      await scan()
    },
    requestLlmInsight,
    languagePercentages() {
      const { metrics } = get()
      if (!metrics) return []
      const totalCode = metrics.totalLines.code
      if (totalCode === 0) return []
      return metrics.languages.map((lang) => ({
        language: lang.language,
        percentage: Math.round((lang.lines.code / totalCode) * 1000) / 10,
        color: lang.color,
      }))
    },
    topLanguages(limit = 5) {
      return get().metrics?.languages.slice(0, limit) ?? []
    },
  }

  // A project switch invalidates the old project's metrics; the tile rescans when visible.
  ctx.project.onDidChange((p) => {
    if ((p?.root ?? null) !== get().root) {
      set({ root: p?.root ?? null, metrics: null, pathWarning: null, error: null, llmError: null, isScanning: false, scanProgress: IDLE })
    }
  })
  return model
}
