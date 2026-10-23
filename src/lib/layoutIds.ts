/**
 * Layout leaf ids (plugin-system.md §5.2). Every leaf of a mosaic tree is
 * prefixed so its kind never has to be guessed:
 *
 * | Leaf              | Format                     |
 * |-------------------|----------------------------|
 * | Terminal          | `term:<terminalId>`        |
 * | Tool tile         | `tool:<tileInstanceId>`    |
 * | Empty             | `empty:<ulid>`             |
 * | Global workspace  | `globalWs:<id>`            |
 * | Project frame     | `__project__`              |
 *
 * Terminal ids *are* their leaf ids: the PTY backend names new terminals
 * `term:<uuid>`, so `terminals.get(leafId)` keeps working. Tool tile ids are
 * `tool:<ulid>` and carry no config id (look the instance up instead).
 */

export type LeafKind = 'term' | 'tool' | 'empty' | 'globalWs' | 'project'

export interface ParsedLeafId {
  kind: LeafKind
  /** The id after the prefix (`''` for the project frame). */
  id: string
}

export const TERM_PREFIX = 'term:'
export const TOOL_PREFIX = 'tool:'
export const EMPTY_PREFIX = 'empty:'
export const GLOBAL_WS_PREFIX = 'globalWs:'
export const PROJECT_LEAF = '__project__'

/**
 * Classify a leaf id. Ids without a known prefix are treated as terminals
 * (terminals created with an explicit id by older code paths).
 */
export function parseLeafId(leaf: string): ParsedLeafId {
  if (leaf === PROJECT_LEAF) return { kind: 'project', id: '' }
  if (leaf.startsWith(TOOL_PREFIX)) return { kind: 'tool', id: leaf.slice(TOOL_PREFIX.length) }
  if (leaf.startsWith(EMPTY_PREFIX)) return { kind: 'empty', id: leaf.slice(EMPTY_PREFIX.length) }
  if (leaf.startsWith(GLOBAL_WS_PREFIX)) return { kind: 'globalWs', id: leaf.slice(GLOBAL_WS_PREFIX.length) }
  if (leaf.startsWith(TERM_PREFIX)) return { kind: 'term', id: leaf.slice(TERM_PREFIX.length) }
  return { kind: 'term', id: leaf }
}

export const isToolLeaf = (leaf: string): boolean => leaf.startsWith(TOOL_PREFIX)
export const isEmptyLeaf = (leaf: string): boolean => leaf.startsWith(EMPTY_PREFIX)
export const isTermLeaf = (leaf: string): boolean => parseLeafId(leaf).kind === 'term'

// ---- ids ----

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz'

/** A lowercase ULID (time-ordered, 26 chars), like the core's `Id`. */
export function newUlid(now: number = Date.now()): string {
  let time = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time
    t = Math.floor(t / 32)
  }
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  let rand = ''
  for (let i = 0; i < 16; i++) rand += CROCKFORD[bytes[i] % 32]
  return time + rand
}

/** A fresh tool tile instance id / leaf id. */
export function newToolLeafId(): string {
  return `${TOOL_PREFIX}${newUlid()}`
}

/** A fresh empty placeholder leaf id. */
export function newEmptyLeafId(): string {
  return `${EMPTY_PREFIX}${newUlid()}`
}
