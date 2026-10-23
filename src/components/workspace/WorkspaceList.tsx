import { useState } from 'react'
import { useTerminalStore } from '../../stores/terminalStore'
import { WorkspaceLayoutPreview } from './WorkspaceLayoutPreview'
import type { Session } from '../../types'

interface WorkspaceListProps {
  workspaces: Session[]
  activeSessionId: string | null
  onSwitch: (sessionId: string) => void
  onTogglePin: (sessionId: string) => void
  onRename: (id: string, name: string) => void
  onDelete: (id: string) => void
  onReset: () => void
  compact?: boolean
}

export default function WorkspaceList({
  workspaces, activeSessionId, onSwitch, onTogglePin, onRename, onDelete, onReset,
  compact = false,
}: WorkspaceListProps) {
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const getSerializedLayoutTree = useTerminalStore(s => s.getSerializedLayoutTree)

  const handleStartRename = (session: Session) => {
    setEditingId(session.id)
    setEditName(session.name)
  }

  const handleSaveRename = () => {
    if (editingId && editName.trim()) {
      onRename(editingId, editName.trim())
    }
    setEditingId(null)
    setEditName('')
  }

  return (
    <div className={compact ? 'overflow-y-auto' : 'max-h-52 overflow-y-auto'}>
      {workspaces.map(session => (
        <div
          key={session.id}
          className={`group flex items-center gap-2 ${compact ? 'px-2' : 'px-3'} py-1.5 transition-colors ${
            activeSessionId === session.id
              ? 'bg-vibe-primary/10'
              : 'hover:bg-vibe-border/30'
          }`}
        >
          {editingId === session.id ? (
            <input
              type="text"
              value={editName}
              onChange={e => setEditName(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') handleSaveRename()
                if (e.key === 'Escape') { setEditingId(null); setEditName('') }
              }}
              onBlur={handleSaveRename}
              autoFocus
              className="flex-1 px-1.5 py-0.5 bg-vibe-bg border border-vibe-border rounded text-xs text-vibe-text focus:outline-none focus:border-vibe-primary min-w-0"
            />
          ) : (
            <>
              {/* Layout preview thumbnail */}
              <div className={`flex-shrink-0 rounded border p-0.5 ${
                activeSessionId === session.id
                  ? 'border-vibe-primary/50 bg-vibe-primary/5'
                  : 'border-vibe-border/50 bg-vibe-bg'
              }`}>
                <WorkspaceLayoutPreview
                  layoutTree={
                    activeSessionId === session.id
                      ? getSerializedLayoutTree()
                      : session.layoutTree
                  }
                />
              </div>

              {/* Name + date — click to switch */}
              <div
                className={`flex-1 min-w-0 ${activeSessionId === session.id ? '' : 'cursor-pointer'}`}
                onClick={() => onSwitch(session.id)}
              >
                <div className={`${compact ? 'text-xs' : 'text-sm'} text-vibe-text truncate`}>{session.name}</div>
                <div className="text-[10px] text-vibe-muted">
                  {new Date(session.updatedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>

              {/* Hover actions */}
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
                <button
                  onClick={() => onTogglePin(session.id)}
                  className={`p-0.5 rounded transition-colors ${
                    session.pinned
                      ? 'text-vibe-primary hover:text-vibe-primary/70'
                      : 'text-vibe-muted hover:text-vibe-text'
                  }`}
                  title={session.pinned ? 'Unpin from toolbar' : 'Pin to toolbar'}
                >
                  <svg className="w-3.5 h-3.5" fill={session.pinned ? 'currentColor' : 'none'} stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z" />
                  </svg>
                </button>
                <button
                  onClick={() => handleStartRename(session)}
                  className="p-0.5 text-vibe-muted hover:text-vibe-text rounded transition-colors"
                  title="Rename"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
                {activeSessionId === session.id ? (
                  <button
                    onClick={onReset}
                    className="p-0.5 text-vibe-muted hover:text-amber-400 rounded transition-colors"
                    title="Reset workspace"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                  </button>
                ) : (
                  <button
                    onClick={() => onDelete(session.id)}
                    className="p-0.5 text-vibe-muted hover:text-red-400 rounded transition-colors"
                    title="Delete"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                    </svg>
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      ))}
      {workspaces.length === 0 && (
        <div className="px-3 py-2 text-xs text-vibe-muted">No workspaces yet</div>
      )}
    </div>
  )
}
