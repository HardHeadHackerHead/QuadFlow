/**
 * Read-modify-write of the active project's `.claude/settings.local.json`
 * (fs scope `project`); keys this plugin does not edit are preserved.
 */
import { HostError, type PluginContext } from '@quadflow/plugin-api'
import { SETTINGS_FILE, readTextOrNull } from './paths'

export type ClaudeSettingsJson = Record<string, unknown> & {
  permissions?: { allow?: string[]; deny?: string[]; [k: string]: unknown }
  env?: Record<string, string>
}

export async function readSettings(ctx: PluginContext): Promise<ClaudeSettingsJson | null> {
  const text = await readTextOrNull(ctx, SETTINGS_FILE, 'project')
  if (text === null) return null
  try {
    const v = JSON.parse(text) as unknown
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not a JSON object')
    return v as ClaudeSettingsJson
  } catch (e) {
    throw new HostError('corrupt', `${SETTINGS_FILE} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** Apply `edit` to the current file content (re-read right before writing). */
export async function updateSettings(ctx: PluginContext, edit: (s: ClaudeSettingsJson) => void): Promise<ClaudeSettingsJson> {
  const s = (await readSettings(ctx)) ?? {}
  edit(s)
  await ctx.fs.writeText(SETTINGS_FILE, `${JSON.stringify(s, null, 2)}\n`, 'project')
  return s
}
