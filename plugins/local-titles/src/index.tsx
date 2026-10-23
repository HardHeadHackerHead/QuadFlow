/**
 * `local-titles` — offline terminal titles from a local model (first-party,
 * optional: not bundled, installed from the plugin source).
 *
 * Contributions (quadflow-plugin.json):
 *  - title generator `llama` (API 1.3): the shell asks it first for terminal
 *    titles (src/lib/titles.ts); it resolves `null` until a model is downloaded
 *  - settings page `models`: download / delete models, device, sampling
 *  - Rust sidecar (sidecar/, llama.cpp): inference + model downloads into the
 *    plugin's data folder. GPU backends are sidecar crate features
 *    (`cuda` / `metal` / `vulkan`), one release build per platform.
 */
import { definePlugin, type PluginContext, type TitleRequest } from '@quadflow/plugin-api'
import { SettingsPage } from './SettingsPage'
import { localTitlesModel } from './model'
import './styles.css'

export default definePlugin({
  settingsPages: { models: SettingsPage },
  titleGenerators: {
    llama: { generate: (req: TitleRequest, ctx: PluginContext) => localTitlesModel(ctx).generate(req) },
  },
})
