/**
 * `usage-monitor` (AP-5, agent-providers.md §4.2): account usage / rate-limit
 * windows of every agent provider with a `usage` hook, as a tile and a
 * toolbar mini widget. Everything goes through the plugin API
 * (`ctx.agents.providers()`, `ctx.agents.usage()`, `ctx.settings`); the
 * providers' hooks (plugins/claude-code, plugins/codex) do the reading.
 *
 * Activated at startup so the background refresh (setting
 * `backgroundPollSeconds`) also runs while no tile is open.
 */
import { definePlugin } from '@quadflow/plugin-api'
import UsageMonitorTile from './UsageMonitorTile'
import UsageMiniWidget from './MiniWidget'
import UsageMonitorSettingsPage from './SettingsPage'
import { bind, unbind } from './store'
import './usage.css'

export default definePlugin({
  activate(ctx) {
    bind(ctx)
  },
  deactivate() {
    unbind()
  },
  tiles: { 'usage-monitor': UsageMonitorTile },
  miniWidgets: { 'usage-monitor': UsageMiniWidget },
  settingsPages: { 'usage-monitor': UsageMonitorSettingsPage },
})
