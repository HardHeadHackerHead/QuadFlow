/**
 * `chat` — conversations with an OpenAI-compatible LLM endpoint (first-party, bundled, trusted).
 *
 * Contributions (quadflow-plugin.json):
 *  - tile `chat`: conversations, streamed replies, settings (./ChatTile.tsx)
 *  - commands `new-conversation` and `ask` (prompt for a question, answer in the tile)
 *  - palette provider `chat-conversations`: find conversations by title
 *  - agent context doc `chat` (docs/agent.md): `quadflow docs chat`
 *
 * Everything goes through the public host API (`ctx.data.chat.*`, `ctx.secrets`);
 * nothing is imported from the shell. See docs/plugins/migrating-a-tool.md.
 */
import { definePlugin, type PaletteItem, type PluginContext, type TileProps } from '@quadflow/plugin-api'
import { ChatTile } from './ChatTile'
import { chatModel, errorMessage } from './model'
import './styles.css'

async function openChat(ctx: PluginContext, conversationId?: string) {
  if (conversationId) await chatModel(ctx).setActiveConversation(conversationId)
  await ctx.ui.openTile('chat')
}

async function newConversation(ctx: PluginContext) {
  try {
    const c = await chatModel(ctx).createConversation({ title: 'New Conversation' })
    await openChat(ctx, c.id)
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: 'Could not create a conversation', body: errorMessage(e) })
  }
}

async function ask(ctx: PluginContext) {
  const question = (await ctx.ui.prompt({ title: 'Ask the chat model', label: 'Question' }))?.trim()
  if (!question) return
  const model = chatModel(ctx)
  try {
    await model.createConversation({ title: question.slice(0, 50) })
  } catch (e) {
    ctx.notifications.toast({ kind: 'error', title: 'Could not create a conversation', body: errorMessage(e) })
    return
  }
  await ctx.ui.openTile('chat')
  await model.sendMessage(question)
}

async function searchConversations(query: string, ctx: PluginContext): Promise<PaletteItem[]> {
  const q = query.trim().toLowerCase()
  const list = await ctx.data.chat.conversations()
  return list
    .filter((c) => c.title.toLowerCase().includes(q))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 10)
    .map((c) => ({
      id: c.id,
      title: c.title,
      subtitle: `Chat · ${new Date(c.updatedAt).toLocaleString()}`,
      keywords: ['chat', 'conversation', c.title],
      run: () => openChat(ctx, c.id),
    }))
}

export default definePlugin({
  tiles: {
    // The `.qf-chat` wrapper is the style scope of this plugin's Tailwind build.
    chat: (props: TileProps) => (
      <div className="qf-chat">
        <ChatTile {...props} />
      </div>
    ),
  },
  commands: {
    open: (ctx) => openChat(ctx),
    'new-conversation': (ctx) => newConversation(ctx),
    ask: (ctx) => ask(ctx),
  },
  paletteProviders: { 'chat-conversations': { search: searchConversations } },
})
