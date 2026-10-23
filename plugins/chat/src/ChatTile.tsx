/**
 * The Chat tool: conversations with an OpenAI-compatible endpoint, streamed
 * replies, and a settings dialog. Ported from the shell's old `ChatToolView` /
 * `ChatSettingsModal`; everything goes through `ctx` (see ./model.ts).
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatConversation, ChatMessage, PluginContext, TileProps } from '@quadflow/plugin-api'
import { DropdownMenu, Modal } from '@quadflow/ui'
import { chatModel, errorMessage } from './model'

/** Portal content (modal bodies/footers, menus) needs the style scope too. */
const Scoped = ({ children }: { children: ReactNode }) => <div className="qf-chat">{children}</div>

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const diffMs = Date.now() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  const diffDays = Math.floor(diffMs / 86400000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

/** Code fences and inline code; everything else is plain text. */
function MessageContent({ ctx, content }: { ctx: PluginContext; content: string }) {
  const parts = content.split(/(```[\s\S]*?```)/g)
  return (
    <div className="space-y-2">
      {parts.map((part, i) => {
        if (part.startsWith('```') && part.endsWith('```') && part.length >= 6) {
          const lines = part.slice(3, -3).split('\n')
          const language = lines[0] || ''
          const code = lines.slice(1).join('\n') || lines[0]
          return (
            <div key={i} className="relative group">
              {language && (
                <div className="text-xs text-vibe-muted bg-vibe-bg px-2 py-1 rounded-t border border-b-0 border-vibe-border">{language}</div>
              )}
              <pre className={`bg-vibe-bg p-3 ${language ? 'rounded-b' : 'rounded'} border border-vibe-border overflow-x-auto text-sm`}>
                <code>{code}</code>
              </pre>
              <button
                onClick={() => ctx.clipboard.writeText(code).catch(() => {})}
                className="absolute top-2 right-2 p-1 opacity-0 group-hover:opacity-100 text-vibe-muted hover:text-vibe-text bg-vibe-surface border border-vibe-border rounded transition-opacity"
                title="Copy code"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </button>
            </div>
          )
        }
        const inlineParts = part.split(/(`[^`]+`)/g)
        return (
          <p key={i} className="whitespace-pre-wrap">
            {inlineParts.map((inline, j) =>
              inline.startsWith('`') && inline.endsWith('`') && inline.length > 1 ? (
                <code key={j} className="bg-vibe-bg px-1.5 py-0.5 rounded text-sm font-mono">
                  {inline.slice(1, -1)}
                </code>
              ) : (
                inline
              ),
            )}
          </p>
        )
      })}
    </div>
  )
}

function MessageBubble({ ctx, message }: { ctx: PluginContext; message: ChatMessage }) {
  const isUser = message.role === 'user'
  if (message.role === 'system') {
    return (
      <div className="flex justify-center my-2">
        <div className="bg-vibe-bg/50 text-vibe-muted text-sm px-3 py-1 rounded-full border border-vibe-border/50">{message.content}</div>
      </div>
    )
  }
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-3`} data-chat-message={message.role}>
      <div className={`max-w-[85%] ${isUser ? 'bg-vibe-primary/20 border-vibe-primary/30' : 'bg-vibe-surface border-vibe-border'} border rounded-lg px-4 py-3`}>
        <div className="flex items-center gap-2 mb-1">
          <span className={`text-xs font-medium ${isUser ? 'text-vibe-primary' : 'text-vibe-muted'}`}>{isUser ? 'You' : 'Assistant'}</span>
          <span className="text-xs text-vibe-muted">{formatTime(message.createdAt)}</span>
          {message.tokenCount != null && <span className="text-xs text-vibe-muted">({message.tokenCount} tokens)</span>}
        </div>
        <div className="text-vibe-text">
          <MessageContent ctx={ctx} content={message.content} />
        </div>
      </div>
    </div>
  )
}

function ConversationItem({
  conversation, isActive, onClick, onRename, onDelete,
}: {
  conversation: ChatConversation
  isActive: boolean
  onClick: () => void
  onRename: (newTitle: string) => void
  onDelete: () => void
}) {
  const [isEditing, setIsEditing] = useState(false)
  const [editTitle, setEditTitle] = useState(conversation.title)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    }
  }, [isEditing])

  const handleRename = () => {
    if (editTitle.trim() && editTitle !== conversation.title) onRename(editTitle.trim())
    setIsEditing(false)
  }

  return (
    <div
      className={`group relative flex items-center gap-2 px-3 py-2 rounded-lg cursor-pointer transition-colors ${
        isActive ? 'bg-vibe-primary/20 border border-vibe-primary/30' : 'hover:bg-vibe-border/50 border border-transparent'
      }`}
      onClick={!isEditing ? onClick : undefined}
      data-chat-conversation={conversation.title}
    >
      <svg className="w-4 h-4 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
      </svg>
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          onBlur={handleRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') handleRename()
            if (e.key === 'Escape') {
              setEditTitle(conversation.title)
              setIsEditing(false)
            }
          }}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 bg-vibe-bg border border-vibe-border rounded px-2 py-0.5 text-sm text-vibe-text"
        />
      ) : (
        <div className="flex-1 min-w-0">
          <div className="text-sm text-vibe-text truncate">{conversation.title}</div>
          <div className="text-xs text-vibe-muted">{formatTime(conversation.updatedAt)}</div>
        </div>
      )}
      <span onClick={(e) => e.stopPropagation()}>
        <DropdownMenu
          placement="bottom-end"
          overlayId="chat-conversation-menu"
          items={[
            { id: 'rename', label: 'Rename', onSelect: () => setIsEditing(true) },
            { id: 'delete', label: 'Delete', danger: true, onSelect: onDelete },
          ]}
          trigger={
            <button className="opacity-0 group-hover:opacity-100 p-1 text-vibe-muted hover:text-vibe-text transition-opacity" title="More">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z" />
              </svg>
            </button>
          }
        />
      </span>
    </div>
  )
}

export function ChatTile({ ctx }: TileProps) {
  const model = chatModel(ctx)
  useEffect(() => model.retain(), [model])
  const s = model.use()
  const [inputMessage, setInputMessage] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [showConversations, setShowConversations] = useState(true)
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [s.messages, s.streamingContent])

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputMessage(e.target.value)
    e.target.style.height = 'auto'
    e.target.style.height = Math.min(e.target.scrollHeight, 200) + 'px'
  }

  const handleSend = useCallback(async () => {
    const text = inputMessage.trim()
    if (!text || s.isSendingMessage) return
    try {
      if (!s.activeConversationId) await model.createConversation({ title: text.slice(0, 50) })
    } catch {
      return
    }
    setInputMessage('')
    if (inputRef.current) inputRef.current.style.height = 'auto'
    await model.sendMessage(text)
  }, [inputMessage, s.isSendingMessage, s.activeConversationId, model])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

  const activeConversation = s.conversations.find((c) => c.id === s.activeConversationId)

  return (
    <div className="flex h-full bg-vibe-bg" data-testid="chat-tool">
      {showConversations && (
        <div className="w-64 flex-shrink-0 border-r border-vibe-border flex flex-col bg-vibe-surface">
          <div className="p-3 border-b border-vibe-border flex items-center justify-between">
            <span className="font-medium text-vibe-text">Conversations</span>
            <button
              onClick={() => void model.createConversation({ title: 'New Conversation' }).catch(() => {})}
              className="p-1.5 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors"
              title="New conversation"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {s.isLoadingConversations && s.conversations.length === 0 ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-vibe-muted border-t-vibe-primary rounded-full animate-spin" />
              </div>
            ) : s.conversations.length === 0 ? (
              <div className="text-center py-8 text-vibe-muted text-sm">
                No conversations yet.
                <br />
                Start typing to begin!
              </div>
            ) : (
              s.conversations.map((conv) => (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  isActive={conv.id === s.activeConversationId}
                  onClick={() => void model.setActiveConversation(conv.id)}
                  onRename={(t) => void model.renameConversation(conv.id, t)}
                  onDelete={() => setDeleteConfirm(conv.id)}
                />
              ))
            )}
          </div>

          <div className="p-2 border-t border-vibe-border">
            <button
              onClick={() => {
                void model.loadSettings()
                setShowSettings(true)
              }}
              className="w-full flex items-center gap-2 px-3 py-2 text-sm text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded-lg transition-colors"
              data-testid="chat-open-settings"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
              Settings
            </button>
          </div>
        </div>
      )}

      <div className="flex-1 flex flex-col min-w-0">
        <div className="flex items-center gap-3 px-4 py-2 border-b border-vibe-border bg-vibe-surface">
          <button
            onClick={() => setShowConversations(!showConversations)}
            className="p-1.5 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded transition-colors"
            title={showConversations ? 'Hide sidebar' : 'Show sidebar'}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>

          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-vibe-text truncate">{activeConversation?.title || 'New Chat'}</div>
            {s.settings ? (
              <div className="text-xs text-vibe-muted truncate">
                {activeConversation?.model || s.settings.defaultModel} @ {s.settings.endpoint}
              </div>
            ) : activeConversation?.model ? (
              <div className="text-xs text-vibe-muted truncate">{activeConversation.model}</div>
            ) : null}
          </div>

          {s.isStreaming ? (
            <div className="flex items-center gap-1 text-xs text-vibe-primary" data-testid="chat-streaming">
              <span className="w-2 h-2 bg-vibe-primary rounded-full animate-pulse" />
              Streaming
            </div>
          ) : s.isLoadingModels ? (
            <div className="w-4 h-4 border-2 border-vibe-muted border-t-vibe-primary rounded-full animate-spin" />
          ) : s.availableModels.length > 0 ? (
            <div className="flex items-center gap-1 text-xs text-green-400" data-testid="chat-connection-status">
              <span className="w-2 h-2 bg-green-400 rounded-full animate-pulse" />
              Connected
            </div>
          ) : (
            <div className="flex items-center gap-1 text-xs text-yellow-400" title={s.modelsError ?? undefined} data-testid="chat-connection-status">
              <span className="w-2 h-2 bg-yellow-400 rounded-full" />
              Disconnected
            </div>
          )}
        </div>

        {s.error && (
          <div className="px-4 py-2 bg-red-500/10 border-b border-red-500/30 flex items-center gap-2" data-testid="chat-error">
            <svg className="w-4 h-4 text-red-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span className="text-sm text-red-400 flex-1 break-words">{s.error}</span>
            <button onClick={model.clearError} className="text-red-400 hover:text-red-300" title="Dismiss">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4" data-testid="chat-messages">
          {s.isLoadingMessages ? (
            <div className="flex items-center justify-center h-full">
              <div className="w-8 h-8 border-2 border-vibe-muted border-t-vibe-primary rounded-full animate-spin" />
            </div>
          ) : s.messages.length === 0 && !s.isSendingMessage ? (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <svg className="w-16 h-16 text-vibe-border mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
              </svg>
              <div className="text-lg font-medium text-vibe-text mb-2">Start a conversation</div>
              <div className="text-sm text-vibe-muted max-w-md">
                Chat with your local LLM for brainstorming, coding help, and more. Configure the endpoint under Settings in the sidebar (or Settings &gt; Integrations).
              </div>
            </div>
          ) : (
            <>
              {s.messages.map((msg) => (
                <MessageBubble key={msg.id} ctx={ctx} message={msg} />
              ))}
              {s.isStreaming && s.streamingContent && (
                <div className="flex justify-start mb-3" data-chat-message="streaming">
                  <div className="max-w-[85%] bg-vibe-surface border-vibe-border border rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-xs font-medium text-vibe-muted">Assistant</span>
                      <span className="w-2 h-2 bg-vibe-primary rounded-full animate-pulse" />
                    </div>
                    <div className="text-vibe-text">
                      <MessageContent ctx={ctx} content={s.streamingContent} />
                    </div>
                  </div>
                </div>
              )}
              {s.isSendingMessage && !s.streamingContent && (
                <div className="flex justify-start mb-3">
                  <div className="bg-vibe-surface border-vibe-border border rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-medium text-vibe-muted">Assistant</span>
                      <div className="flex gap-1">
                        {[0, 150, 300].map((d) => (
                          <div key={d} className="w-1.5 h-1.5 bg-vibe-muted rounded-full animate-bounce" style={{ animationDelay: `${d}ms` }} />
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>

        <div className="border-t border-vibe-border p-4 bg-vibe-surface">
          <div className="flex items-end gap-2">
            <textarea
              ref={inputRef}
              value={inputMessage}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              placeholder="Type your message... (Shift+Enter for new line)"
              rows={1}
              disabled={s.isSendingMessage}
              data-testid="chat-input"
              className="flex-1 bg-vibe-bg border border-vibe-border rounded-lg px-4 py-3 text-vibe-text placeholder-vibe-muted resize-none focus:outline-none focus:border-vibe-primary/50 disabled:opacity-50"
              style={{ minHeight: '48px', maxHeight: '200px' }}
            />
            <button
              onClick={() => void handleSend()}
              disabled={!inputMessage.trim() || s.isSendingMessage}
              title="Send"
              data-testid="chat-send"
              className="flex items-center justify-center w-12 h-12 bg-vibe-primary text-white rounded-lg hover:bg-vibe-primary/80 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {s.isSendingMessage ? (
                <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>

      {showSettings && <ChatSettingsDialog ctx={ctx} onClose={() => setShowSettings(false)} />}

      <Modal open={deleteConfirm != null} onClose={() => setDeleteConfirm(null)} title="Delete conversation?" size="sm" overlayId="chat-delete"
        footer={
          <Scoped>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDeleteConfirm(null)} className="px-4 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 rounded-lg transition-colors">Cancel</button>
              <button
                onClick={async () => {
                  const id = deleteConfirm
                  setDeleteConfirm(null)
                  if (id) await model.deleteConversation(id)
                }}
                className="px-4 py-2 text-sm bg-red-500 text-white rounded-lg hover:bg-red-600 transition-colors"
              >
                Delete
              </button>
            </div>
          </Scoped>
        }
      >
        <Scoped>
          <p className="text-sm text-vibe-muted">This will permanently delete this conversation and all its messages.</p>
        </Scoped>
      </Modal>
    </div>
  )
}

/** Endpoint, write-only API key, model and tuning (settings namespace `chat`). */
function ChatSettingsDialog({ ctx, onClose }: { ctx: PluginContext; onClose: () => void }) {
  const model = chatModel(ctx)
  const { settings, hasApiKey, availableModels, isLoadingModels, modelsError } = model.use()
  const [endpoint, setEndpoint] = useState(settings?.endpoint || 'http://localhost:11434/v1')
  const [defaultModel, setDefaultModel] = useState(settings?.defaultModel || 'llama3.2')
  const [temperature, setTemperature] = useState(settings?.temperature ?? 0.7)
  const [maxTokens, setMaxTokens] = useState(settings?.maxTokens ?? 2048)
  const [systemPrompt, setSystemPrompt] = useState(settings?.systemPrompt || '')
  const [timeoutSeconds, setTimeoutSeconds] = useState(settings?.timeoutSeconds ?? 60)
  // Write-only: the stored key is never read back, only whether one was set.
  const [apiKeyInput, setApiKeyInput] = useState('')
  const [isSaving, setIsSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Settings arrive after the dialog opened (first open).
  const loadedFor = useRef<string | null>(settings ? 'initial' : null)
  useEffect(() => {
    if (!settings || loadedFor.current) return
    loadedFor.current = 'loaded'
    setEndpoint(settings.endpoint)
    setDefaultModel(settings.defaultModel)
    setTemperature(settings.temperature ?? 0.7)
    setMaxTokens(settings.maxTokens)
    setSystemPrompt(settings.systemPrompt ?? '')
    setTimeoutSeconds(settings.timeoutSeconds)
  }, [settings])

  const handleSave = async () => {
    setIsSaving(true)
    setSaveError(null)
    try {
      await model.updateSettings({
        endpoint: endpoint.trim(),
        defaultModel,
        temperature,
        maxTokens,
        timeoutSeconds,
        systemPrompt: systemPrompt.trim() ? systemPrompt : null,
      })
      if (apiKeyInput.trim()) await model.setApiKey(apiKeyInput.trim())
      onClose()
    } catch (e) {
      setSaveError(errorMessage(e))
    } finally {
      setIsSaving(false)
    }
  }

  const inputClass = 'w-full bg-vibe-bg border border-vibe-border rounded-lg px-3 py-2 text-vibe-text focus:outline-none focus:border-vibe-primary/50'

  return (
    <Modal open onClose={onClose} title="Chat Settings" size="lg" overlayId="chat-settings"
      footer={
        <Scoped>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 text-sm text-vibe-text hover:bg-vibe-border/50 rounded-lg transition-colors">Cancel</button>
            <button
              onClick={() => void handleSave()}
              disabled={isSaving}
              className="px-4 py-2 text-sm bg-vibe-primary text-white rounded-lg hover:bg-vibe-primary/80 disabled:opacity-50 transition-colors"
              data-testid="chat-settings-save"
            >
              {isSaving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </Scoped>
      }
    >
      <Scoped>
        <div className="space-y-4" data-testid="chat-settings">
          <div>
              <label className="block text-sm font-medium text-vibe-text mb-1">Endpoint URL</label>
              <input
                type="text"
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="http://localhost:11434/v1"
                className={`${inputClass} font-mono text-sm`}
                data-testid="chat-endpoint-input"
              />
              <p className="text-xs text-vibe-muted mt-1">Any OpenAI-compatible API (Ollama, LM Studio, OpenRouter, OpenAI, …).</p>
            </div>

          <div>
            <label className="block text-sm font-medium text-vibe-text mb-1">API Key (optional)</label>
            <div className="flex gap-2">
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={hasApiKey ? 'A key is stored — type to replace it' : 'Not required for local Ollama'}
                className={`${inputClass} font-mono text-sm`}
                autoComplete="off"
                data-testid="chat-api-key-input"
              />
              {hasApiKey && (
                <button
                  onClick={() => void model.clearApiKey()}
                  className="px-3 py-2 bg-red-500/10 border border-red-500/30 text-red-400 rounded-lg text-sm hover:bg-red-500/20"
                  title="Remove the stored API key"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-xs text-vibe-muted mt-1">Stored in the system keystore{hasApiKey ? ' (a key is set)' : ''}; it is never shown again.</p>
          </div>

              <div>
                <label className="block text-sm font-medium text-vibe-text mb-1">Model</label>
                <div className="flex gap-2">
                  {availableModels.length > 0 ? (
                    <select value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} className={`flex-1 ${inputClass}`}>
                      {!availableModels.includes(defaultModel) && <option value={defaultModel}>{defaultModel}</option>}
                      {availableModels.map((m) => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  ) : (
                    <input type="text" value={defaultModel} onChange={(e) => setDefaultModel(e.target.value)} className={`flex-1 ${inputClass}`} />
                  )}
                    <button
                      onClick={() => void model.loadModels()}
                      disabled={isLoadingModels}
                      className="px-3 py-2 bg-vibe-bg border border-vibe-border rounded-lg text-vibe-muted hover:text-vibe-text disabled:opacity-50 transition-colors"
                      title="Refresh models from the saved endpoint"
                    >
                      <svg className={`w-5 h-5 ${isLoadingModels ? 'animate-spin' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                      </svg>
                    </button>
                </div>
                {availableModels.length > 0 ? (
                  <p className="text-xs text-green-400 mt-1">
                    {availableModels.length} model{availableModels.length !== 1 ? 's' : ''} available
                  </p>
                ) : modelsError ? (
                  <p className="text-xs text-yellow-400 mt-1" data-testid="chat-models-error">{modelsError}</p>
                ) : null}
              </div>

              <div>
                <label className="block text-sm font-medium text-vibe-text mb-1">Temperature: {temperature.toFixed(2)}</label>
                <input type="range" min="0" max="2" step="0.1" value={temperature} onChange={(e) => setTemperature(parseFloat(e.target.value))} className="w-full accent-vibe-primary" />
                <p className="text-xs text-vibe-muted mt-1">Lower = more focused, higher = more creative</p>
              </div>

              <div>
                <label className="block text-sm font-medium text-vibe-text mb-1">Max Tokens</label>
                <input type="number" min="1" max="128000" value={maxTokens} onChange={(e) => setMaxTokens(parseInt(e.target.value) || 2048)} className={inputClass} />
              </div>

              <div>
                <label className="block text-sm font-medium text-vibe-text mb-1">Timeout (seconds)</label>
                <input
                  type="number"
                  min="1"
                  max="600"
                  value={timeoutSeconds}
                  onChange={(e) => setTimeoutSeconds(parseInt(e.target.value) || 60)}
                  className={inputClass}
                  data-testid="chat-timeout-input"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-vibe-text mb-1">Default System Prompt (optional)</label>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  placeholder="You are a helpful assistant..."
                  rows={3}
                  className={`${inputClass} placeholder-vibe-muted resize-none`}
                />
              </div>

          {saveError && (
            <div className="px-3 py-2 bg-red-500/10 border border-red-500/30 rounded-lg text-sm text-red-400" data-testid="chat-settings-error">
              {saveError}
            </div>
          )}
        </div>
      </Scoped>
    </Modal>
  )
}
