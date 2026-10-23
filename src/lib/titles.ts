/**
 * Terminal title generation: "who can generate a title?"
 *
 * 1. Plugins that contribute `contributes.titleGenerators[]` (API 1.3, e.g. the
 *    optional `local-titles` plugin with its llama.cpp sidecar), in
 *    contribution order. A generator resolves `null` to pass.
 * 2. The terminal's agent provider: its `sessionTitle` hook (agent-providers.md
 *    §4.2) when the terminal is bound to a session and the title is short.
 * 3. The chat API (`generate_title_via_api`, Settings → Integrations → the
 *    chat endpoint) when an API model is set.
 * 4. A heuristic from the text (unless `fallback: false`).
 *
 * Every step is best effort: failures are logged and the next one is tried.
 */
import { invoke } from '@tauri-apps/api/core'
import type { PluginContext, TitleGenerator } from '@quadflow/plugin-api'
import { commands } from '../generated/bindings'
import { call } from './core'
import { providerSessionTitle } from '../agents/providerRegistry'
import { getProviderInfo } from '../agents/providers'
import { loadPluginModule } from '../plugins/loader'
import { ensurePluginRegistry, usePluginRegistry } from '../plugins/registry'
import { useTerminalStore } from '../stores/terminalStore'
import { useTitleSettingsStore } from '../stores/titleSettingsStore'
import type { TitleGenerateResult } from '../types'

export type GeneratedTitleSource = 'plugin' | 'session' | 'api' | 'fallback'

export interface GeneratedTitle {
  title: string
  source: GeneratedTitleSource
  /** `<pluginId>/<generatorId>` for plugin titles. */
  generator?: string
}

export interface GenerateTitleOptions {
  /** Terminal the title is for (enables the provider's `sessionTitle` step). */
  terminalId?: string
  /** Ask the agent provider's `sessionTitle` hook (default true). */
  session?: boolean
  /** Return a heuristic title when nobody else can (default true); `false` → `null`. */
  fallback?: boolean
}

export interface TitleGeneratorInfo {
  pluginId: string
  id: string
  title: string
}

/** Plugin time budget: a local model may need a while to load on first use. */
const GENERATOR_TIMEOUT_MS = 30_000
/** Session titles longer than this are summaries, not titles. */
const MAX_SESSION_TITLE = 50

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e)
      },
    )
  })
}

/** Active plugins' title generators, in the order they are asked. */
export async function listTitleGenerators(): Promise<TitleGeneratorInfo[]> {
  await ensurePluginRegistry()
  return (usePluginRegistry.getState().contributions?.titleGenerators ?? []).map(({ pluginId, contribution }) => ({
    pluginId,
    id: contribution.id,
    title: contribution.title,
  }))
}

/** Words in range, no quotes / trailing punctuation, ≤ 80 chars; `''` when unusable. */
export function cleanTitle(raw: string, minWords: number, maxWords: number): string {
  const cleaned = raw
    .replace(/^\s*title\s*:/i, '')
    .replace(/["'`]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?,;:]+$/, '')
  const words = cleaned.split(' ').filter(Boolean)
  if (words.length < Math.max(1, Math.min(minWords, 2))) return ''
  let title = words.slice(0, Math.max(1, maxWords)).join(' ')
  if (title.length > 80) title = title.slice(0, 80).trim()
  return title
}

/** First words of the text, capitalised (the last resort). */
export function heuristicTitle(text: string, maxWords: number): string {
  const firstLine = text.trim().split('\n')[0] ?? ''
  const words = firstLine.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean)
  if (words.length === 0) return 'New Terminal'
  let title = words.slice(0, Math.max(maxWords, 3)).join(' ')
  if (title.length > 50) title = title.slice(0, 47) + '...'
  return title.charAt(0).toUpperCase() + title.slice(1)
}

async function fromPlugins(text: string, minWords: number, maxWords: number, terminalId?: string): Promise<GeneratedTitle | null> {
  for (const g of await listTitleGenerators()) {
    try {
      const loaded = await loadPluginModule(g.pluginId)
      const gen = (loaded.module.titleGenerators as Record<string, TitleGenerator> | undefined)?.[g.id]
      if (!gen) {
        console.warn(`[titles] ${g.pluginId} declares title generator "${g.id}" but its UI module does not export it`)
        continue
      }
      const raw = await withTimeout(gen.generate({ text, minWords, maxWords, terminalId }, loaded.ctx as PluginContext), GENERATOR_TIMEOUT_MS)
      const title = raw ? cleanTitle(raw, minWords, maxWords) : ''
      if (title) return { title, source: 'plugin', generator: `${g.pluginId}/${g.id}` }
    } catch (e) {
      console.warn(`[titles] title generator ${g.pluginId}/${g.id} failed:`, e)
    }
  }
  return null
}

async function fromSession(terminalId: string): Promise<GeneratedTitle | null> {
  const t = useTerminalStore.getState().terminals.get(terminalId)
  const b = t?.agent
  if (!t || !b?.sessionId || !getProviderInfo(b.providerId)?.hooks.includes('sessionTitle')) return null
  try {
    const sessions = await call(commands.agentsSessionsList(b.providerId, t.workingDirectory))
    const session = sessions.find((s) => s.id === b.sessionId)
    if (!session) return null
    const title = (await providerSessionTitle(session))?.trim()
    return title && title.length <= MAX_SESSION_TITLE ? { title, source: 'session' } : null
  } catch (e) {
    console.warn('[titles] sessionTitle failed:', e)
    return null
  }
}

async function fromApi(text: string, model: string, minWords: number, maxWords: number): Promise<GeneratedTitle | null> {
  if (!model) return null
  try {
    const r = await invoke<TitleGenerateResult>('generate_title_via_api', {
      prompt: text,
      options: { model, min_words: minWords, max_words: maxWords },
    })
    return r.title ? { title: r.title, source: 'api' } : null
  } catch (e) {
    console.warn('[titles] API title generation failed:', e)
    return null
  }
}

/** A short title for `text` from the first source that can give one (see the module comment). */
export async function generateTitle(text: string, o: GenerateTitleOptions & { fallback: false }): Promise<GeneratedTitle | null>
export async function generateTitle(text: string, o?: GenerateTitleOptions): Promise<GeneratedTitle>
export async function generateTitle(text: string, o: GenerateTitleOptions = {}): Promise<GeneratedTitle | null> {
  const { min_words, max_words, api_model } = useTitleSettingsStore.getState().settings
  const minWords = Math.max(1, min_words)
  const maxWords = Math.max(minWords, max_words)
  const trimmed = text.trim()
  if (trimmed) {
    const r =
      (await fromPlugins(trimmed, minWords, maxWords, o.terminalId)) ??
      (o.terminalId && o.session !== false ? await fromSession(o.terminalId) : null) ??
      (await fromApi(trimmed, api_model, minWords, maxWords))
    if (r) return r
  }
  if (o.fallback === false) return null
  return { title: heuristicTitle(trimmed, maxWords), source: 'fallback' }
}
