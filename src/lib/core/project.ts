/**
 * Open a working directory as a core project for a domain store.
 *
 * Stopgap until DL-10's `projects_open` returns the registry row (with its
 * `rootKey`): makes sure the project marker (`<dir>/.quadflow/config.json`, `.quadflow-dev` in dev) exists (project folders
 * are created lazily, on first open), starts
 * the per-project watcher (CLI/other-process edits → `External` `DataChanged`),
 * and returns the root key used to filter `onDataChanged`.
 */
import { commands } from '../../generated/bindings'
import { call, CoreCallError } from './index'
import { checkV1Project } from './v1Legacy'

export interface OpenedProject {
  root: string
  rootKey: string
}

const opened = new Map<string, Promise<OpenedProject>>()

/** Mirror of `paths::key_of_canonical` for an already-canonical path. */
export function rootKeyOf(canonicalPath: string): string {
  let s = canonicalPath.replace(/\\/g, '/')
  while (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1)
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Windows|Macintosh|Mac OS/i.test(ua)) s = s.toLowerCase()
  return s
}

async function open(root: string): Promise<OpenedProject> {
  let canonical = root
  // A QuadFlow 1.x `.quadflow/` is moved aside first (release) so the project opens fresh.
  await checkV1Project(root)
  try {
    await call(commands.projectConfigGet(root))
    // The doctor report carries the canonical root; cheap (no fixes).
    canonical = (await call(commands.projectDoctor(root, false))).root
  } catch (e) {
    if (!(e instanceof CoreCallError) || e.error.code !== 'project_not_found') throw e
    try {
      canonical = (await call(commands.projectInit(root, {}))).root
    } catch (e2) {
      // Lost an init race with another store / process: it is a project now.
      if (!(e2 instanceof CoreCallError) || e2.error.code !== 'conflict') throw e2
      canonical = (await call(commands.projectDoctor(root, false))).root
    }
  }
  await call(commands.projectWatch(root))
  return { root, rootKey: rootKeyOf(canonical) }
}

/** Idempotent per root; a failure is not cached. */
export function ensureProject(root: string): Promise<OpenedProject> {
  let p = opened.get(root)
  if (!p) {
    p = open(root).catch((e) => {
      opened.delete(root)
      throw e
    })
    opened.set(root, p)
  }
  return p
}
