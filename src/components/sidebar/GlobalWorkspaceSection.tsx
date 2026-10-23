import { useMemo, useState } from 'react'
import { useGlobalWorkspaceStore } from '../../stores/globalWorkspaceStore'

interface Props {
  searchQuery?: string
}

/**
 * Sidebar-styled section that surfaces the same controls previously exposed
 * by the toolbar's GlobalWorkspaceButton + GlobalWorkspaceManager popover.
 * Lets the user create/rename/delete/disable/minimize workspaces and toggle
 * the global feature on/off — all from inside ProjectSidebar.
 */
export default function GlobalWorkspaceSection({ searchQuery = '' }: Props) {
  const workspaces = useGlobalWorkspaceStore(s => s.workspaces)
  const globallyEnabled = useGlobalWorkspaceStore(s => s.globallyEnabled)
  const createWorkspace = useGlobalWorkspaceStore(s => s.createWorkspace)
  const renameWorkspace = useGlobalWorkspaceStore(s => s.renameWorkspace)
  const deleteWorkspace = useGlobalWorkspaceStore(s => s.deleteWorkspace)
  const setEnabled = useGlobalWorkspaceStore(s => s.setWorkspaceEnabled)
  const setMinimized = useGlobalWorkspaceStore(s => s.setWorkspaceMinimized)
  const setGloballyEnabled = useGlobalWorkspaceStore(s => s.setGloballyEnabled)

  const [newName, setNewName] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const list = useMemo(() => {
    const all = Array.from(workspaces.values()).sort((a, b) => a.displayOrder - b.displayOrder)
    if (!searchQuery.trim()) return all
    const q = searchQuery.toLowerCase()
    return all.filter(w => w.name.toLowerCase().includes(q))
  }, [workspaces, searchQuery])

  const totalCount = workspaces.size
  const visibleCount = Array.from(workspaces.values()).filter(w => w.enabled && !w.minimized).length

  const handleCreate = async () => {
    const name = newName.trim() || `Workspace ${list.length + 1}`
    await createWorkspace(name)
    setNewName('')
  }

  const startEdit = (id: string, current: string) => {
    setEditingId(id)
    setEditingName(current)
  }

  const commitEdit = async () => {
    if (editingId && editingName.trim()) {
      await renameWorkspace(editingId, editingName.trim())
    }
    setEditingId(null)
    setEditingName('')
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete workspace "${name}"? Tools inside will be removed.`)) return
    await deleteWorkspace(id)
  }

  return (
    <div className="border-t border-vibe-border/50 mt-1 pt-1">
      {/* Section header */}
      <div className="px-2 pt-2 pb-1 flex items-center justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-vibe-muted flex items-center gap-1.5">
          <GlobeIcon size={11} />
          Global Workspaces
          {totalCount > 0 && (
            <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${
              globallyEnabled
                ? 'bg-cyan-500/20 text-cyan-300'
                : 'bg-vibe-border text-vibe-muted line-through'
            }`}>
              {visibleCount}/{totalCount}
            </span>
          )}
        </div>
        {/* Global on/off toggle */}
        <label className="flex items-center gap-1 cursor-pointer text-[10px] text-vibe-muted hover:text-vibe-text" title="Enable / disable the global workspaces feature">
          <input
            type="checkbox"
            checked={globallyEnabled}
            onChange={(e) => setGloballyEnabled(e.target.checked)}
            className="w-3 h-3 rounded border-vibe-border text-cyan-500 focus:ring-0 focus:ring-offset-0"
          />
          <span>{globallyEnabled ? 'On' : 'Off'}</span>
        </label>
      </div>

      {/* List */}
      <div className="px-1 pb-1">
        {list.length === 0 ? (
          <div className="px-2 py-2 text-[11px] text-vibe-muted">
            {searchQuery.trim() ? 'No matches.' : 'No global workspaces yet.'}
          </div>
        ) : (
          list.map((ws) => (
            <div
              key={ws.id}
              className="flex items-center gap-1 px-1.5 py-1 text-xs hover:bg-vibe-border/30 rounded group"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                  !ws.enabled ? 'bg-gray-500' : ws.minimized ? 'bg-amber-400' : 'bg-cyan-400'
                }`}
                title={!ws.enabled ? 'disabled' : ws.minimized ? 'minimized' : 'visible'}
              />
              {editingId === ws.id ? (
                <input
                  autoFocus
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitEdit()
                    if (e.key === 'Escape') { setEditingId(null); setEditingName('') }
                  }}
                  className="flex-1 min-w-0 px-1 py-0.5 text-xs bg-vibe-bg border border-vibe-border rounded text-vibe-text"
                />
              ) : (
                <button
                  onDoubleClick={() => startEdit(ws.id, ws.name)}
                  className="flex-1 min-w-0 text-left text-vibe-text truncate"
                  title="Double-click to rename"
                >
                  {ws.name}
                </button>
              )}
              <button
                onClick={() => setMinimized(ws.id, !ws.minimized)}
                className="p-0.5 text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50 rounded opacity-60 group-hover:opacity-100 transition-opacity"
                title={ws.minimized ? 'Restore' : 'Minimize'}
              >
                {ws.minimized ? <RestoreIcon /> : <MinimizeIcon />}
              </button>
              <button
                onClick={() => setEnabled(ws.id, !ws.enabled)}
                className={`p-0.5 rounded opacity-60 group-hover:opacity-100 transition-opacity ${
                  ws.enabled
                    ? 'text-vibe-muted hover:text-vibe-text hover:bg-vibe-border/50'
                    : 'text-amber-400 bg-amber-400/20 hover:bg-amber-400/30 opacity-100'
                }`}
                title={ws.enabled ? 'Disable' : 'Enable'}
              >
                {ws.enabled ? <EyeIcon /> : <EyeOffIcon />}
              </button>
              <button
                onClick={() => handleDelete(ws.id, ws.name)}
                className="p-0.5 text-vibe-muted hover:text-red-400 hover:bg-red-400/10 rounded opacity-60 group-hover:opacity-100 transition-opacity"
                title="Delete"
              >
                <TrashIcon />
              </button>
            </div>
          ))
        )}
      </div>

      {/* Create input */}
      <div className="flex items-center gap-1 px-2 pb-2">
        <input
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleCreate() }}
          placeholder="New global workspace…"
          className="flex-1 min-w-0 px-1.5 py-1 text-[11px] bg-vibe-bg border border-vibe-border rounded text-vibe-text placeholder:text-vibe-muted/60 focus:outline-none focus:border-cyan-500/50"
        />
        <button
          onClick={handleCreate}
          className="px-2 py-1 text-[11px] bg-cyan-600 hover:bg-cyan-500 text-white rounded transition-colors flex-shrink-0"
          title="Add a new global workspace"
        >
          +
        </button>
      </div>
    </div>
  )
}

// ---------- Icons (inline SVG; no external icon lib in repo) ----------

function GlobeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <path d="M2 12h20" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  )
}
function MinimizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <line x1="4" y1="12" x2="20" y2="12" />
    </svg>
  )
}
function RestoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </svg>
  )
}
function EyeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
function EyeOffIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-10-7-10-7a18.5 18.5 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 10 7 10 7a18.5 18.5 0 0 1-2.16 3.19" />
      <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <line x1="2" y1="2" x2="22" y2="22" />
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  )
}
