/**
 * Claude Code session JSONL parsing (ports of the former
 * `src-tauri/src/session_context.rs`): context-window usage, rewind points
 * and titles. Pure functions over text, so they are unit-testable.
 */

interface Usage {
  input_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}
interface Entry {
  type?: string
  subtype?: string
  isMeta?: boolean
  uuid?: string
  timestamp?: string
  message?: { role?: string; content?: unknown; usage?: Usage }
  microcompactMetadata?: { tokensSaved?: number }
  aiTitle?: string
  customTitle?: string
  summary?: string
}

function* entries(text: string): Generator<Entry> {
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t[0] !== '{') continue
    try {
      yield JSON.parse(t) as Entry
    } catch {
      // Partial line (tail read) or corrupt line: skip.
    }
  }
}

function contentChars(content: unknown): number {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  let n = 0
  for (const item of content) {
    if (typeof item === 'string') {
      n += item.length
      continue
    }
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    switch (o.type) {
      case 'text':
        n += typeof o.text === 'string' ? o.text.length : 0
        break
      case 'tool_use':
        n += (typeof o.name === 'string' ? o.name.length : 0) + JSON.stringify(o.input ?? null).length
        break
      case 'tool_result':
        n += contentChars(o.content)
        break
      default:
        n += JSON.stringify(o).length
    }
  }
  return n
}

/**
 * Tokens currently in the context window. Prefers the API-reported input size
 * (`input + cache_creation + cache_read`) of the last assistant message after
 * the last `compact_boundary`; falls back to 4 chars/token minus microcompact
 * savings. `null` when the text holds no messages.
 */
export function estimateContextTokens(text: string): { tokens: number; estimated: boolean } | null {
  let chars = 0
  let messages = 0
  let saved = 0
  let api: number | null = null
  for (const e of entries(text)) {
    if (e.subtype === 'compact_boundary') {
      chars = 0
      messages = 0
      saved = 0
      api = null
      continue
    }
    if (e.subtype === 'microcompact_boundary') {
      saved += e.microcompactMetadata?.tokensSaved ?? 0
      continue
    }
    if (!e.message) continue
    chars += contentChars(e.message.content)
    messages++
    const u = e.message.usage
    if (u) {
      const total = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0)
      if (total > 0) api = total
    }
  }
  if (api !== null) return { tokens: api, estimated: false }
  if (messages === 0) return null
  return { tokens: Math.max(0, Math.floor(chars / 4) - saved), estimated: true }
}

export interface RewindPoint {
  turn: number
  uuid: string
  prompt: string
  timestamp: string | null
  filesModified: string[]
  filesCreated: string[]
  linesAdded: number
  linesRemoved: number
}

const isSystemText = (s: string) => {
  const t = s.trim()
  return /^Unknown skill:/i.test(t) || t.startsWith('[Request interrupted')
}

function promptText(content: unknown): string | null {
  if (typeof content === 'string') return content.trim() && !isSystemText(content) ? content : null
  if (!Array.isArray(content)) return null
  for (const item of content) {
    const o = item as Record<string, unknown> | null
    if (o && o.type === 'text' && typeof o.text === 'string' && !isSystemText(o.text)) return o.text
  }
  return null
}

function lineCount(s: unknown): number {
  if (typeof s !== 'string' || !s) return 0
  const lines = s.split(/\r?\n/)
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

function truncate(s: string, max: number) {
  const t = s.trim().replace(/\s+/g, ' ')
  return [...t].length <= max ? t : `${[...t].slice(0, max).join('')}…`
}

/** One rewind point per human prompt, with the edits of the following assistant turns. */
export function parseRewindPoints(text: string): RewindPoint[] {
  let points: RewindPoint[] = []
  let turn = 0
  for (const e of entries(text)) {
    if (e.subtype === 'compact_boundary') {
      points = []
      continue
    }
    if (e.type === 'user') {
      if (e.isMeta) continue
      const p = promptText(e.message?.content)
      if (p === null) continue
      turn++
      points.push({
        turn,
        uuid: e.uuid ?? '',
        prompt: truncate(p, 120),
        timestamp: e.timestamp ?? null,
        filesModified: [],
        filesCreated: [],
        linesAdded: 0,
        linesRemoved: 0,
      })
    } else if (e.type === 'assistant') {
      const cur = points[points.length - 1]
      const content = e.message?.content
      if (!cur || !Array.isArray(content)) continue
      for (const item of content) {
        const o = item as { type?: string; name?: string; input?: Record<string, unknown> } | null
        if (!o || o.type !== 'tool_use' || !o.input) continue
        const fp = typeof o.input.file_path === 'string' ? o.input.file_path : null
        let create = false
        if (o.name === 'Edit') {
          cur.linesAdded += lineCount(o.input.new_string)
          cur.linesRemoved += lineCount(o.input.old_string)
        } else if (o.name === 'Write') {
          create = true
          cur.linesAdded += lineCount(o.input.content)
        } else if (o.name === 'NotebookEdit') {
          cur.linesAdded += lineCount(o.input.new_source)
        } else {
          continue
        }
        if (!fp) continue
        if (create) {
          if (!cur.filesCreated.includes(fp)) cur.filesCreated.push(fp)
        } else if (!cur.filesModified.includes(fp) && !cur.filesCreated.includes(fp)) {
          cur.filesModified.push(fp)
        }
      }
    }
  }
  return points
}

/** Latest title recorded in a session file (`custom-title` beats `ai-title` beats `summary`). */
export function titleFromSession(text: string): string | null {
  let custom: string | null = null
  let ai: string | null = null
  let summary: string | null = null
  for (const e of entries(text)) {
    if (e.type === 'custom-title' && e.customTitle) custom = e.customTitle
    else if (e.type === 'ai-title' && e.aiTitle) ai = e.aiTitle
    else if (e.type === 'summary' && e.summary) summary = e.summary
  }
  return custom ?? ai ?? summary
}

/** `sessions-index.json` (`{ version, entries: [{ sessionId, summary, messageCount }] }`). */
export function titleFromIndex(json: string, sessionId: string): string | null {
  try {
    const doc = JSON.parse(json) as { entries?: unknown } | unknown[]
    const list = Array.isArray(doc) ? doc : Array.isArray((doc as { entries?: unknown }).entries) ? ((doc as { entries: unknown[] }).entries) : []
    for (const item of list) {
      const e = item as { sessionId?: string; summary?: string; messageCount?: number }
      if (e.sessionId !== sessionId || !e.summary) continue
      if (e.summary === 'Session Ended' || (e.messageCount ?? 0) < 2) return null
      return e.summary
    }
  } catch {
    // Unreadable index: no title.
  }
  return null
}

/** The last `max` bytes of `bytes` as text, starting at a line boundary. */
export function tailText(bytes: Uint8Array, max: number): string {
  const start = Math.max(0, bytes.length - max)
  const text = new TextDecoder().decode(bytes.subarray(start))
  if (start === 0) return text
  const nl = text.indexOf('\n')
  return nl < 0 ? '' : text.slice(nl + 1)
}
