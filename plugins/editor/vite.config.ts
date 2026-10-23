/**
 * Trusted-plugin build (plugin-system.md §15.1): see @quadflow/plugin-build.
 *
 * Styling: the plugin compiles its own Tailwind utilities (the shell's Tailwind only scans the
 * shell) with the `@quadflow/ui` preset (`vibe-*` / `qf-*` colors follow the theme), no
 * preflight, and every rule scoped under `.qf-editor` so this stylesheet can never change the
 * shell or another plugin. Wrap every rendered root — tiles and portal content such as modal
 * bodies — in an element with class `qf-editor`.
 */
import { fileURLToPath } from 'node:url'
import { defineQuadflowPlugin } from '@quadflow/plugin-build'

export default defineQuadflowPlugin({ root: fileURLToPath(new URL('.', import.meta.url)), tailwind: { scope: '.qf-editor' } })
