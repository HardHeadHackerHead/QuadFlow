// One-off questions to the configured Chat endpoint (OpenAI-compatible, data-layer.md §7.3)
// through `ctx.data.chat.ask` (API 1.4): nothing is stored. Needs `data:chat:write`. Rejects with
// the host's error when no endpoint is configured or the request fails, so callers can show it.
import type { PluginContext } from '@quadflow/plugin-api'

export interface ChatAskOptions {
  systemPrompt?: string
  /** Model override; default: the `chat.defaultModel` setting. */
  model?: string
}

/** Ask once and return the assistant's answer. */
export async function chatAsk(ctx: PluginContext, question: string, o: ChatAskOptions = {}): Promise<string> {
  return ctx.data.chat.ask(question, { systemPrompt: o.systemPrompt ?? null, model: o.model ?? null })
}

/** Readable message of anything thrown by a host call (`HostError`, `Error`, string, …). */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && 'message' in e && typeof (e as { message: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  try {
    return JSON.stringify(e)
  } catch {
    return String(e)
  }
}
