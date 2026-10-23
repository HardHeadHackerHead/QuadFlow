/** Trusted-plugin build (plugin-system.md §15.1): see @quadflow/plugin-build. No UI, so no React. */
import { fileURLToPath } from 'node:url'
import { defineQuadflowPlugin } from '@quadflow/plugin-build'

export default defineQuadflowPlugin({ root: fileURLToPath(new URL('.', import.meta.url)), react: false })
