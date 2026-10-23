import type { UserConfig } from 'vite'

export interface DefineQuadflowPluginOptions {
  /** The plugin directory (the one holding `quadflow-plugin.json`). */
  root: string
  /** UI source entry. Default: `src/index.tsx`, `.ts`, `.jsx` or `.js`, whichever exists. */
  entry?: string
  /** Add `@vitejs/plugin-react` for `.tsx`/`.jsx` entries (default `true`). */
  react?: boolean
  /** Run the post-build checks and write `dist/.integrity.json` (default `true`). */
  check?: boolean
  /**
   * Compile the plugin's own Tailwind utilities: `@quadflow/ui` preset, no preflight, every rule
   * scoped under `scope` (e.g. `'.qf-my-plugin'`; wrap tiles and portal content in that class).
   * `content` defaults to `src/**`. Needs `tailwindcss` (resolved from the plugin or this package).
   */
  tailwind?: { scope: string; content?: string[] }
  /** Merged over the generated config with Vite's `mergeConfig`. */
  vite?: UserConfig
}

/** Vite config for the plugin's UI module (library mode, shared modules external, post-build checks). */
export function defineQuadflowPlugin(o: DefineQuadflowPluginOptions): UserConfig

export interface CheckResult {
  errors: string[]
  warnings: string[]
}
export type ReferencedFileKind = 'ui' | 'sidecar' | 'static'
export type PluginManifestJson = Record<string, any>

export function sharedExports(): Record<string, string[]>
export function sharedSpecifiers(): string[]
export function checkSharedImports(files: string[], exportsMap?: Record<string, string[]>): string[]
export function readManifest(root: string): PluginManifestJson
export function validateManifest(root: string, manifest?: PluginManifestJson): CheckResult
export function referencedFiles(manifest: PluginManifestJson, targetKey: string): { path: string; kind: ReferencedFileKind }[]
export function missingFiles(
  root: string,
  manifest: PluginManifestJson,
  o?: { kinds?: ReferencedFileKind[]; targetKey?: string },
): string[]
export function checkBuiltPlugin(root: string, o?: { kinds?: ReferencedFileKind[]; manifest?: PluginManifestJson }): CheckResult
export function currentTarget(): { os: 'windows' | 'macos' | 'linux'; arch: 'x86_64' | 'aarch64'; key: string }
export function isNative(manifest: PluginManifestJson): boolean
export function findUiSource(root: string): string | null
export function writeIntegrity(root: string, outDir?: string): Record<string, string>
export function buildUi(root: string, o?: { watch?: boolean }): Promise<unknown>
export function buildRustSidecar(root: string, o?: { profile?: 'release' | 'debug' }): Promise<string>
export function buildNodeSidecar(root: string, o?: { watch?: boolean }): Promise<unknown>
export function buildPlugin(root: string, o?: { sidecar?: boolean }): Promise<CheckResult>
export function watchPlugin(root: string, o?: { sidecar?: boolean }): Promise<never>
export function archiveName(manifest: PluginManifestJson, target?: { key: string }): string
export function packPlugin(root: string, o?: { outDir?: string }): { file: string; sha256: string; size: number; entries: number }
export function createZip(entries: { name: string; data: Uint8Array; executable?: boolean }[]): Uint8Array
export const INTEGRITY_FILE: string
