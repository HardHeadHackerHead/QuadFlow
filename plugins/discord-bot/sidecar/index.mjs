/**
 * Node sidecar of the `discord-bot` plugin (plugin-system.md §10.6): the
 * reference conversion of the old `discord_bridge.rs` NDJSON protocol to
 * JSON-RPC methods. Bundled with discord.js to `bin/sidecar.mjs` by
 * `@quadflow/plugin-build`; run with the system `node`
 * (`sidecar:runtime:node`).
 *
 * UI → sidecar (requests):
 *   discord/init      { token, guildId, channelId, qualifiedRoleId } → { ok }
 *   discord/createThread { terminalId, sessionLabel }               → { ok }
 *   discord/closeThread  { terminalId }                             → { ok }
 *   discord/updateSettings { qualifiedRoleId?, channelId? }         → { ok }
 *   discord/stop      {} → { ok }   (logs the bot out; the process stays)
 *   discord/status    {} → { running, connected, botUsername, guildName, threads }
 * UI → sidecar (notification):
 *   discord/output    { terminalId, data }   (already batched by the UI, ~300 ms)
 * Sidecar → UI (`ui/*` notifications → ctx.sidecar.onNotification):
 *   status { running, connected, botUsername?, guildName? } · threadCreated { terminalId, threadId, threadUrl }
 *   reply { terminalId, author, content } · error { message, fatal }
 *
 * The bot token never touches disk here: the UI reads it from `ctx.secrets`
 * and passes it to `discord/init`.
 */
import { createServer } from '@quadflow/sidecar-sdk-node'
import { DiscordBot } from './bot.js'

const server = createServer()
const host = server.host

/** null until `discord/init`; replaced on every init. */
let bot = null
const state = { running: false, connected: false, botUsername: null, guildName: null }

function publishStatus() {
  host.ui('status', { ...state })
}

/** The old stdout messages of bot.js, mapped onto `ui/*` notifications. */
function fromBot(msg) {
  switch (msg.type) {
    case 'ready':
      state.botUsername = msg.botUsername ?? null
      publishStatus()
      break
    case 'status':
      state.connected = !!msg.connected
      if (msg.guildName !== undefined) state.guildName = msg.guildName
      publishStatus()
      break
    case 'thread_created':
      host.ui('threadCreated', { terminalId: msg.terminalId, threadId: msg.threadId, threadUrl: msg.threadUrl })
      break
    case 'reply':
      host.ui('reply', { terminalId: msg.terminalId, author: msg.author, content: msg.content })
      break
    case 'error':
      host.log(msg.fatal ? 'error' : 'warn', msg.message)
      host.ui('error', { message: msg.message, fatal: !!msg.fatal })
      if (msg.fatal) void stop()
      break
    default:
      host.log('warn', `unknown bot message ${JSON.stringify(msg)}`)
  }
}

async function stop() {
  const b = bot
  bot = null
  Object.assign(state, { running: false, connected: false })
  publishStatus()
  if (b) await b.shutdown().catch((e) => host.log('warn', `shutdown: ${e?.message ?? e}`))
}

function requireBot() {
  if (!bot) throw new Error('The bot is not running')
  return bot
}

server
  .onRequest('discord/init', async (p = {}) => {
    if (!p.token) throw new Error('No bot token: set it in the Discord Bot tile')
    if (!p.guildId || !p.channelId) throw new Error('Server (guild) ID and channel ID are required')
    await stop()
    bot = new DiscordBot(fromBot)
    Object.assign(state, { running: true, connected: false, botUsername: null, guildName: null })
    publishStatus()
    // Login runs in the background; `ui/status` reports the connection.
    void bot.init({
      token: p.token,
      guildId: p.guildId,
      channelId: p.channelId,
      qualifiedRoleId: p.qualifiedRoleId || null,
    })
    return { ok: true }
  })
  .onRequest('discord/createThread', async ({ terminalId, sessionLabel } = {}) => {
    await requireBot().createThread(terminalId, sessionLabel)
    return { ok: true }
  })
  .onRequest('discord/closeThread', async ({ terminalId } = {}) => {
    if (bot) await bot.closeThread(terminalId)
    return { ok: true }
  })
  .onRequest('discord/updateSettings', ({ qualifiedRoleId, channelId } = {}) => {
    if (bot?.config) bot.updateSettings({ qualifiedRoleId, channelId })
    return { ok: true }
  })
  .onRequest('discord/stop', async () => {
    await stop()
    return { ok: true }
  })
  .onRequest('discord/status', () => ({ ...state, threads: bot ? [...bot.threads.keys()] : [] }))
  .onNotification('discord/output', ({ terminalId, data } = {}) => {
    if (bot && terminalId && data) void bot.sendOutput(terminalId, data)
  })
  .onShutdown(() => stop())

process.on('unhandledRejection', (reason) => host.log('error', `unhandled rejection: ${reason}`))

server.run()
