import type { JsonValue, PluginContext } from '@quadflow/plugin-api'
import { useEffect, useState } from 'react'

export interface SessionDirSetting {
  path: string
  glob?: string
  providerId?: string
}

/** `contributes.settings` of the manifest (defaults filled by the host). */
export interface SemanticSettings {
  model: string
  useGpu: boolean
  indexMode: 'manual' | 'periodic' | 'realtime'
  intervalMinutes: number
  maxChunkTokens: number
  overlapTokens: number
  useProviderSessions: boolean
  sessionDirs: SessionDirSetting[]
  maxSessionAgeDays: number
}

export const SETTING_DEFAULTS: SemanticSettings = {
  model: 'all-MiniLM-L6-v2',
  useGpu: false,
  indexMode: 'manual',
  intervalMinutes: 10,
  maxChunkTokens: 512,
  overlapTokens: 50,
  useProviderSessions: true,
  sessionDirs: [],
  maxSessionAgeDays: 0,
}

export function readSettings(ctx: PluginContext): SemanticSettings {
  return { ...SETTING_DEFAULTS, ...(ctx.settings.getAll() as Partial<SemanticSettings>) }
}

/** Live plugin settings. */
export function useSettings(ctx: PluginContext): SemanticSettings {
  const [s, setS] = useState(() => readSettings(ctx))
  useEffect(() => {
    setS(readSettings(ctx))
    const d = ctx.settings.onDidChange(() => setS(readSettings(ctx)))
    return d
  }, [ctx])
  return s
}

export async function setSetting<K extends keyof SemanticSettings>(ctx: PluginContext, key: K, value: SemanticSettings[K]): Promise<void> {
  await ctx.settings.set(key, value as unknown as JsonValue)
}
