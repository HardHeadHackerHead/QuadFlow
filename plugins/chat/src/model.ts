/**
 * Chat state over the public host API (`ctx.data.chat.*`, `ctx.secrets`).
 *
 * One model per plugin context (pane and flyout share it). Conversations live
 * in the app DB (not project-scoped); changes made elsewhere (CLI, other
 * windows, other processes) arrive as `chat` change events while a tile is
 * mounted, endpoint changes as `settings` events (`chat/<key>` ids). Replies
 * stream over `data.chat.send`. The endpoint API key is write-only: it is
 * stored with `ctx.secrets.set` (core chat reads it) and never read back.
 */
import { create, type StoreApi, type UseBoundStore } from 'zustand'
import type { ChatConversation, ChatMessage, ChatSettings, ChatSettingsPatch_Deserialize, Disposable, PluginContext } from '@quadflow/plugin-api'
import { API_KEY_SECRET } from './api'

export interface ChatState {
  settings: ChatSettings | null
  /** A key is stored (`settings.hasApiKey`). */
  hasApiKey: boolean
  conversations: ChatConversation[]
  activeConversationId: string | null
  messages: ChatMessage[]
  availableModels: string[]
  /** Why the model list could not be loaded (endpoint unreachable, …). */
  modelsError: string | null

  isLoadingConversations: boolean
  isLoadingMessages: boolean
  isSendingMessage: boolean
  isLoadingModels: boolean
  isStreaming: boolean
  streamingContent: string
  error: string | null
}

export interface ChatModel {
  use: UseBoundStore<StoreApi<ChatState>>
  retain(): Disposable
  loadSettings(): Promise<void>
  updateSettings(patch: ChatSettingsPatch_Deserialize): Promise<void>
  setApiKey(value: string): Promise<void>
  clearApiKey(): Promise<void>
  loadConversations(): Promise<void>
  createConversation(input?: { title?: string | null; model?: string | null; systemPrompt?: string | null }): Promise<ChatConversation>
  deleteConversation(id: string): Promise<void>
  renameConversation(id: string, title: string): Promise<void>
  setActiveConversation(id: string | null): Promise<void>
  sendMessage(text: string): Promise<void>
  loadModels(): Promise<void>
  clearError(): void
}

export const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'object' && e && 'message' in e ? String((e as { message: unknown }).message) : String(e)

const byActivity = (a: ChatConversation, b: ChatConversation) => b.updatedAt - a.updatedAt

const models = new WeakMap<PluginContext, ChatModel>()

export function chatModel(ctx: PluginContext): ChatModel {
  let m = models.get(ctx)
  if (!m) {
    m = createChatModel(ctx)
    models.set(ctx, m)
  }
  return m
}

function createChatModel(ctx: PluginContext): ChatModel {
  const use = create<ChatState>(() => ({
    settings: null,
    hasApiKey: false,
    conversations: [],
    activeConversationId: null,
    messages: [],
    availableModels: [],
    modelsError: null,
    isLoadingConversations: false,
    isLoadingMessages: false,
    isSendingMessage: false,
    isLoadingModels: false,
    isStreaming: false,
    streamingContent: '',
    error: null,
  }))
  const set = use.setState
  const get = use.getState

  async function loadSettings() {
    try {
      const settings = await ctx.data.chat.settingsGet()
      set({ settings, hasApiKey: settings.hasApiKey })
    } catch (e) {
      set({ error: `Failed to load chat settings: ${errorMessage(e)}` })
    }
  }

  // Bumped whenever `messages` changes locally (a send appends its user message and the reply):
  // a load that was started before is older than the list and must not replace it — e.g. a
  // conversation opened and a message sent right away, before its messages had loaded.
  let localEdits = 0

  async function loadMessages(id: string) {
    set({ isLoadingMessages: true })
    const edits = localEdits
    try {
      const messages = await ctx.data.chat.messages(id)
      // Ignore a late answer for a conversation that is no longer active, or one that predates a
      // local change (it would drop the message just sent).
      if (get().activeConversationId !== id) return
      if (edits !== localEdits) {
        set({ isLoadingMessages: false })
        return
      }
      set({ messages, isLoadingMessages: false })
    } catch (e) {
      set({ isLoadingMessages: false, error: `Failed to load messages: ${errorMessage(e)}` })
    }
  }

  async function loadConversations() {
    set({ isLoadingConversations: true })
    try {
      const conversations = (await ctx.data.chat.conversations()).sort(byActivity)
      set((s) => ({
        conversations,
        isLoadingConversations: false,
        // The active conversation was deleted elsewhere.
        ...(s.activeConversationId && !conversations.some((c) => c.id === s.activeConversationId) ? { activeConversationId: null, messages: [] } : {}),
      }))
    } catch (e) {
      set({ isLoadingConversations: false, error: `Failed to load conversations: ${errorMessage(e)}` })
    }
  }

  async function setActiveConversation(id: string | null) {
    set({ activeConversationId: id, messages: [], streamingContent: '', isStreaming: false })
    if (id) await loadMessages(id)
  }

  async function loadModels() {
    set({ isLoadingModels: true })
    try {
      set({ availableModels: await ctx.data.chat.models(), modelsError: null, isLoadingModels: false })
    } catch (e) {
      set({ availableModels: [], modelsError: errorMessage(e), isLoadingModels: false })
    }
  }

  let refs = 0
  let off: Disposable | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const pending = new Set<string>()
  let pendingAll = false

  function retain(): Disposable {
    if (refs++ === 0) {
      // Conversations live in the app DB: writes of other processes (the CLI, agents) arrive
      // here too (`origin: external`). `settings` events carry only `chat/<key>` ids.
      off = ctx.data.onDidChange({ domain: ['chat', 'settings'] }, (e) => {
        if (e.domain === 'settings') {
          const prevEndpoint = get().settings?.endpoint
          void loadSettings().then(() => {
            if (get().settings?.endpoint !== prevEndpoint) void loadModels()
          })
          return
        }
        if (e.ids.length === 0) pendingAll = true
        for (const id of e.ids) pending.add(id)
        if (timer) return
        timer = setTimeout(() => {
          timer = null
          const ids = [...pending]
          const all = pendingAll
          pending.clear()
          pendingAll = false
          void loadConversations()
          const active = get().activeConversationId
          if (active && !get().isSendingMessage && (all || ids.includes(active))) void loadMessages(active)
        }, 100)
      })
      void loadSettings().then(() => loadModels())
      void loadConversations()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      if (--refs > 0) return
      off?.()
      off = null
    }
  }

  return {
    use,
    retain,
    loadSettings,
    loadConversations,
    loadModels,
    setActiveConversation,

    async updateSettings(patch) {
      set({ error: null })
      const prevEndpoint = get().settings?.endpoint
      const settings = await ctx.data.chat.settingsUpdate(patch)
      set({ settings, hasApiKey: settings.hasApiKey })
      if (settings.endpoint !== prevEndpoint) void loadModels()
    },

    async setApiKey(value) {
      await ctx.secrets.set(API_KEY_SECRET, value)
      await loadSettings()
    },

    async clearApiKey() {
      try {
        await ctx.secrets.delete(API_KEY_SECRET)
        // Still true when `quadflow chat key set` stored one (core falls back to it).
        await loadSettings()
      } catch (e) {
        set({ error: `Failed to remove the API key: ${errorMessage(e)}` })
      }
    },

    async createConversation(input = {}) {
      set({ error: null })
      try {
        const conversation = await ctx.data.chat.create({
          title: input.title ?? null,
          model: input.model ?? null,
          systemPrompt: input.systemPrompt ?? null,
          projectRootKey: null,
        })
        set((s) => ({
          conversations: [conversation, ...s.conversations.filter((c) => c.id !== conversation.id)],
          activeConversationId: conversation.id,
          messages: [],
        }))
        return conversation
      } catch (e) {
        set({ error: `Failed to create conversation: ${errorMessage(e)}` })
        throw e
      }
    },

    async deleteConversation(id) {
      set({ error: null })
      try {
        await ctx.data.chat.delete(id)
        const { activeConversationId, conversations } = get()
        const remaining = conversations.filter((c) => c.id !== id)
        set({ conversations: remaining })
        if (activeConversationId === id) await setActiveConversation(remaining[0]?.id ?? null)
      } catch (e) {
        set({ error: `Failed to delete conversation: ${errorMessage(e)}` })
      }
    },

    async renameConversation(id, title) {
      set({ error: null })
      try {
        const updated = await ctx.data.chat.rename(id, title)
        set((s) => ({ conversations: s.conversations.map((c) => (c.id === id ? updated : c)) }))
      } catch (e) {
        set({ error: `Failed to rename conversation: ${errorMessage(e)}` })
      }
    },

    async sendMessage(text) {
      const id = get().activeConversationId
      if (!id) {
        set({ error: 'No active conversation' })
        return
      }
      set({ isSendingMessage: true, isStreaming: true, streamingContent: '', error: null })
      const isActive = () => get().activeConversationId === id
      try {
        await ctx.data.chat.send(id, text, (e) => {
          if (!isActive()) return
          switch (e.type) {
            case 'started':
              localEdits++
              set((s) => ({ messages: [...s.messages.filter((m) => m.id !== e.userMessage.id), e.userMessage] }))
              break
            case 'delta':
              set((s) => ({ streamingContent: s.streamingContent + e.text }))
              break
            case 'done':
              localEdits++
              set((s) => ({
                messages: [...s.messages.filter((m) => m.id !== e.result.assistantMessage.id), e.result.assistantMessage],
                streamingContent: '',
                conversations: s.conversations
                  .map((c) => (c.id === id ? { ...c, updatedAt: e.result.assistantMessage.createdAt } : c))
                  .sort(byActivity),
              }))
              break
            case 'failed':
              break // surfaced by the rejected promise below
          }
        })
        set({ isSendingMessage: false, isStreaming: false, streamingContent: '' })
      } catch (e) {
        set({ isSendingMessage: false, isStreaming: false, streamingContent: '', error: errorMessage(e) })
        // The stored user message stays (only the reply failed): show what the DB has.
        if (isActive()) void loadMessages(id)
      }
    },

    clearError: () => set({ error: null }),
  }
}
