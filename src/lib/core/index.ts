/**
 * Typed access to the Rust core (data-layer.md §10.3).
 *
 * Every data command goes through `call(commands.xxx(...))`, which unwraps the
 * tauri-specta `Result` envelope and throws `CoreCallError` on failure.
 */
import { homeDir } from '@tauri-apps/api/path'
import { commands, type CoreError, type CoreInfo } from '../../generated/bindings'

export class CoreCallError extends Error {
  constructor(public error: CoreError) {
    super(error.message)
    this.name = 'CoreCallError'
  }
}

export async function call<T>(
  p: Promise<{ status: 'ok'; data: T } | { status: 'error'; error: CoreError }>,
): Promise<T> {
  const r = await p
  if (r.status === 'error') throw new CoreCallError(r.error)
  return r.data
}

let coreInfoPromise: Promise<CoreInfo> | null = null

/**
 * Profile + resolved paths of this process (cached for the app's lifetime).
 * Use `projectDirName` (`.quadflow` / `.quadflow-dev`) and `defaultWorkingDir`
 * instead of hard-coding directories or defaulting to the home folder.
 */
export function getCoreInfo(): Promise<CoreInfo> {
  if (!coreInfoPromise) {
    coreInfoPromise = call(commands.coreInfo()).catch((e) => {
      coreInfoPromise = null // allow a retry on the next call
      throw e
    })
  }
  return coreInfoPromise
}

/**
 * Directory to use when nothing else is configured. Dev never falls back to the
 * real home folder (the core always returns a scratch dir there); release uses
 * the home folder when the core has no opinion.
 */
export async function resolveDefaultWorkingDir(): Promise<string> {
  const info = await getCoreInfo()
  if (info.defaultWorkingDir) return info.defaultWorkingDir
  if (info.profile === 'dev') {
    throw new Error('dev profile without a default working dir (core bug)')
  }
  return homeDir()
}

export { commands }
export * from './events'
