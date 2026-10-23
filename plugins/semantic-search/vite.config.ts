/**
 * Trusted-plugin build (plugin-system.md §15.1): see @quadflow/plugin-build. Utilities are scoped
 * under `.qf-semantic-search`; wrap every rendered root (tiles, settings page, modal bodies) in it.
 *
 * `npm run build` builds only the UI module (`--no-sidecar`, so the app's `npm run build:plugins`
 * never compiles candle); `npm run build:sidecar` also builds the Rust sidecar into bin/.
 */
import { fileURLToPath } from 'node:url'
import { defineQuadflowPlugin } from '@quadflow/plugin-build'

export default defineQuadflowPlugin({ root: fileURLToPath(new URL('.', import.meta.url)), tailwind: { scope: '.qf-semantic-search' } })
