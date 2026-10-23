/**
 * Chat on the Rust core (data-layer.md §7.3, §7.4): conversations/messages in
 * the app DB, endpoint + tuning in settings `chat`, the API key in the OS
 * keystore. The key is write-only from here: `setChatApiKey` / `clearChatApiKey`
 * store or remove it, `ChatSettings.hasApiKey` says whether one is set — no
 * command ever returns it.
 */
import { Channel } from '@tauri-apps/api/core'
import {
  commands,
  type ChatConversation,
  type ChatConversationCreate,
  type ChatSendResult,
  type ChatSettings,
  type ChatSettingsPatch_Deserialize,
  type ChatStreamEvent,
  type ChatStreamEvent_Deserialize,
} from '../../generated/bindings'
import { call } from './index'

export type {
  ChatConversation,
  ChatMessage,
  ChatRole,
  ChatSettings,
  ChatSendResult,
  ChatStreamEvent,
  ChatEndpointInfo,
  ChatDiscoveryResult,
} from '../../generated/bindings'
export type ChatSettingsPatch = ChatSettingsPatch_Deserialize

/** Secret key of the chat endpoint's API key. */
export const CHAT_API_KEY_SECRET = 'chat.apiKey'
/** Secret key of the OpenAI API key (text-to-speech). */
export const OPENAI_API_KEY_SECRET = 'openai.apiKey'

export const chatCore = {
  listConversations: (projectRootKey: string | null = null) =>
    call(commands.chatConversationsList(projectRootKey)),
  createConversation: (input: Partial<ChatConversationCreate> = {}) =>
    call(
      commands.chatConversationsCreate({
        title: input.title ?? null,
        model: input.model ?? null,
        systemPrompt: input.systemPrompt ?? null,
        projectRootKey: input.projectRootKey ?? null,
      }),
    ),
  getConversation: (id: string) => call(commands.chatConversationsGet(id)),
  renameConversation: (id: string, title: string) => call(commands.chatConversationsRename(id, title)),
  deleteConversation: (id: string) => call(commands.chatConversationsDelete(id)),
  listMessages: (conversationId: string) => call(commands.chatMessagesList(conversationId)),

  getSettings: (): Promise<ChatSettings> => call(commands.chatSettingsGet()),
  updateSettings: (patch: ChatSettingsPatch): Promise<ChatSettings> => call(commands.chatSettingsUpdate(patch)),
  listModels: (timeoutMs: number | null = null) => call(commands.chatModels(timeoutMs)),
  discoverEndpoints: (port: number | null = null, timeoutMs: number | null = null) =>
    call(commands.chatDiscoverEndpoints(port, timeoutMs)),
  checkEndpoint: (url: string, timeoutMs: number | null = null) => call(commands.chatCheckEndpoint(url, timeoutMs)),

  setApiKey: (value: string) => call(commands.secretsSet(CHAT_API_KEY_SECRET, value)),
  clearApiKey: () => call(commands.secretsDelete(CHAT_API_KEY_SECRET)),

  /**
   * Send a message. `onEvent` receives `started` (user message stored),
   * `delta`s, then `done` or `failed`. Resolves with the final result; rejects
   * with `CoreCallError` on failure (after the `failed` event).
   */
  send: (conversationId: string, content: string, onEvent?: (e: ChatStreamEvent) => void): Promise<ChatSendResult> => {
    const channel = new Channel<ChatStreamEvent_Deserialize>()
    if (onEvent) channel.onmessage = onEvent
    return call(commands.chatSend(conversationId, content, channel))
  },

  /** One-off question in a throwaway conversation (deleted afterwards). */
  ask: async (question: string, systemPrompt?: string): Promise<string> => {
    const conv: ChatConversation = await chatCore.createConversation({ title: 'One-off question', systemPrompt })
    try {
      const r = await chatCore.send(conv.id, question)
      return r.assistantMessage.content
    } finally {
      await chatCore.deleteConversation(conv.id).catch(() => {})
    }
  },
}
