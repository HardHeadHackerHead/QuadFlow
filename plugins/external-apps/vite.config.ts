/**
 * Trusted-plugin build (plugin-system.md §15.1): see @quadflow/plugin-build.
 * Tailwind utilities are compiled here, scoped under `.qf-external-apps` (no preflight):
 * wrap every rendered root (tiles, portal content) in an element with that class.
 */
import { fileURLToPath } from 'node:url'
import { defineQuadflowPlugin } from '@quadflow/plugin-build'

export default defineQuadflowPlugin({ root: fileURLToPath(new URL('.', import.meta.url)), tailwind: { scope: '.qf-external-apps' } })
