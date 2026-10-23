// Build preset for QuadFlow plugins: ES module at dist/index.js (+ dist/index.css), the host's
// shared modules (react, @quadflow/plugin-api, @quadflow/ui, …) stay external, and every build
// is checked (manifest, referenced files, shared imports). See @quadflow/plugin-build.
import { fileURLToPath } from 'node:url'
import { defineQuadflowPlugin } from '@quadflow/plugin-build'

export default defineQuadflowPlugin({ root: fileURLToPath(new URL('.', import.meta.url)) })
