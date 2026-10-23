/**
 * Trusted-plugin build (plugin-system.md §15.1): see @quadflow/plugin-build.
 * Tailwind utilities scoped under `.qf-obs-tracker` (wrap every rendered root in it).
 */
import { fileURLToPath } from 'node:url'
import { defineQuadflowPlugin } from '@quadflow/plugin-build'

export default defineQuadflowPlugin({ root: fileURLToPath(new URL('.', import.meta.url)), tailwind: { scope: '.qf-obs-tracker' } })
