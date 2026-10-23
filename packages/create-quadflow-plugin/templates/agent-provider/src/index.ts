/**
 * {{name}} — QuadFlow agent provider.
 *
 * Most of a provider is declarative: `contributes.agentProvider` in quadflow-plugin.json tells
 * QuadFlow how to find `{{agentCommand}}` (detect), build its command line (launch: model,
 * approval modes, resume), where its sessions live and which context file it reads (AGENTS.md).
 *
 * The procedural hooks listed in `agentProvider.hooks` are served by the sidecar
 * (sidecar/index.mjs, `agentProvider/<hook>` requests), which works whether the plugin runs
 * sandboxed (third-party) or trusted. A trusted plugin may instead export them here as
 * `agentProvider: { usage(ctx) {…} }` (QuadFlow docs: docs/plugins/agent-providers.md).
 */
import { definePlugin } from '@quadflow/plugin-api'

export default definePlugin({
  activate(ctx) {
    ctx.log.info('{{id}} provider ready')
  },
})
