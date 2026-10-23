import { useState, useEffect, useMemo, useRef } from 'react'
import { useWorkspaceActions } from '../../hooks/useWorkspaceActions'
import { TemplateLayoutPreview, useTemplateToolOptions, templateSummary } from '../workspace/WorkspaceLayoutPreview'
import { LAYOUT_PRESETS } from '../../lib/layoutUtils'
import WorkspaceList from '../workspace/WorkspaceList'
import GlobalWorkspaceSection from './GlobalWorkspaceSection'

interface WorkspaceSectionProps {
  searchQuery: string
}

export default function WorkspaceSection({ searchQuery }: WorkspaceSectionProps) {
  const actions = useWorkspaceActions()
  const templateToolOptions = useTemplateToolOptions()

  const {
    projectWorkspaces, activeSession, templates,
    switchWorkspace, togglePin, renameWorkspace, deleteWorkspace, resetWorkspace,
    launchBlank, createFromTemplate, loadSessions, reloadTemplates,
    defaultSaved, saveCurrentAsDefault, handleResetTemplates,
    updateTemplate, deleteTemplate, addTemplate, cycleLayoutPreset, toggleTemplateTile,
  } = actions

  const [newMenuOpen, setNewMenuOpen] = useState(false)
  const [showTemplates, setShowTemplates] = useState(false)
  const [isEditing, setIsEditing] = useState(false)
  const [workspaceName, setWorkspaceName] = useState('')
  const menuRef = useRef<HTMLDivElement>(null)
  const menuBtnRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    loadSessions()
    reloadTemplates()
  }, [loadSessions, reloadTemplates])

  // Close dropdown on click outside
  useEffect(() => {
    if (!newMenuOpen) return
    const handleMouseDown = (e: MouseEvent) => {
      if (
        menuRef.current && !menuRef.current.contains(e.target as Node) &&
        menuBtnRef.current && !menuBtnRef.current.contains(e.target as Node)
      ) {
        setNewMenuOpen(false)
      }
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [newMenuOpen])

  const filteredWorkspaces = useMemo(() => {
    if (!searchQuery.trim()) return projectWorkspaces
    const q = searchQuery.toLowerCase()
    return projectWorkspaces.filter(s => s.name.toLowerCase().includes(q))
  }, [projectWorkspaces, searchQuery])

  const handleCreateFromTemplate = async (template: typeof templates[0]) => {
    await createFromTemplate(template, workspaceName || undefined)
    setWorkspaceName('')
    setShowTemplates(false)
  }

  return (
    <>
      {/* Section header */}
      <div className="px-2 pt-2 pb-1 flex items-center justify-between flex-shrink-0">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-vibe-muted">
          Workspaces ({projectWorkspaces.length})
        </div>
        <div className="relative">
          <button
            ref={menuBtnRef}
            onClick={() => setNewMenuOpen(!newMenuOpen)}
            className="flex items-center gap-0.5 text-[10px] text-vibe-muted hover:text-vibe-primary transition-colors"
            title="New workspace"
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New
            <svg className="w-2.5 h-2.5 ml-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {newMenuOpen && (
            <div
              ref={menuRef}
              className="absolute right-0 top-full mt-1 w-40 bg-vibe-surface border border-vibe-border rounded-md shadow-lg z-50 py-1"
            >
              <button
                className="w-full px-3 py-1.5 text-xs text-left text-vibe-text hover:bg-vibe-border/50 transition-colors"
                onClick={() => {
                  launchBlank()
                  setNewMenuOpen(false)
                }}
              >
                Blank Workspace
              </button>
              <button
                className="w-full px-3 py-1.5 text-xs text-left text-vibe-text hover:bg-vibe-border/50 transition-colors"
                onClick={() => {
                  setShowTemplates(true)
                  setNewMenuOpen(false)
                }}
              >
                From Template...
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Workspace list */}
      <WorkspaceList
        workspaces={filteredWorkspaces}
        activeSessionId={activeSession?.id || null}
        onSwitch={switchWorkspace}
        onTogglePin={togglePin}
        onRename={renameWorkspace}
        onDelete={deleteWorkspace}
        onReset={resetWorkspace}
        compact
      />

      {/* Inline template picker (shown when "From Template..." is clicked) */}
      {showTemplates && (
        <div className="px-2 pb-2 border-t border-vibe-border">
          <div className="flex items-center justify-between pt-1.5 pb-1">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-vibe-muted">Templates</div>
            <button
              onClick={() => { setShowTemplates(false); setIsEditing(false) }}
              className="text-[10px] text-vibe-muted hover:text-vibe-text transition-colors"
            >
              Close
            </button>
          </div>

          {isEditing ? (
            /* Template editor */
            <div className="space-y-2">
              {templates.map(template => (
                <div key={template.id} className="p-2 bg-vibe-bg border border-vibe-border rounded">
                  {/* Layout preview + name */}
                  <div className="flex items-center gap-2 mb-1.5">
                    <button
                      onClick={() => cycleLayoutPreset(template.id, template.layoutPreset)}
                      className="flex-shrink-0 w-10 h-8 flex items-center justify-center border border-vibe-border rounded hover:border-vibe-primary/50 transition-colors bg-vibe-surface"
                      title={`Layout: ${LAYOUT_PRESETS.find(p => p.type === template.layoutPreset)?.name || template.layoutPreset} (click to change)`}
                    >
                      <TemplateLayoutPreview template={template} />
                    </button>
                    <input
                      type="text"
                      value={template.name}
                      onChange={e => updateTemplate(template.id, { name: e.target.value })}
                      className="flex-1 px-1.5 py-0.5 bg-vibe-surface border border-vibe-border rounded text-xs text-vibe-text focus:outline-none focus:border-vibe-primary min-w-0"
                    />
                    {templates.length > 1 && (
                      <button
                        onClick={() => deleteTemplate(template.id)}
                        className="p-0.5 text-vibe-muted hover:text-red-400 rounded transition-colors flex-shrink-0"
                        title="Delete template"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {/* Agent/Terminal steppers */}
                  <div className="flex items-center gap-3 mb-1.5">
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-vibe-muted w-10">Agents</span>
                      <button
                        onClick={() => updateTemplate(template.id, { agentCount: Math.max(0, template.agentCount - 1) })}
                        className="w-5 h-5 flex items-center justify-center text-xs text-vibe-muted hover:text-vibe-text bg-vibe-surface border border-vibe-border rounded transition-colors"
                      >-</button>
                      <span className="w-4 text-center text-xs text-vibe-text">{template.agentCount}</span>
                      <button
                        onClick={() => updateTemplate(template.id, { agentCount: Math.min(6, template.agentCount + 1) })}
                        className="w-5 h-5 flex items-center justify-center text-xs text-vibe-muted hover:text-vibe-text bg-vibe-surface border border-vibe-border rounded transition-colors"
                      >+</button>
                    </div>
                    <div className="flex items-center gap-1">
                      <span className="text-[10px] text-vibe-muted w-10">Terms</span>
                      <button
                        onClick={() => updateTemplate(template.id, { terminalCount: Math.max(0, template.terminalCount - 1) })}
                        className="w-5 h-5 flex items-center justify-center text-xs text-vibe-muted hover:text-vibe-text bg-vibe-surface border border-vibe-border rounded transition-colors"
                      >-</button>
                      <span className="w-4 text-center text-xs text-vibe-text">{template.terminalCount}</span>
                      <button
                        onClick={() => updateTemplate(template.id, { terminalCount: Math.min(6, template.terminalCount + 1) })}
                        className="w-5 h-5 flex items-center justify-center text-xs text-vibe-muted hover:text-vibe-text bg-vibe-surface border border-vibe-border rounded transition-colors"
                      >+</button>
                    </div>
                  </div>

                  {/* Tool type checkboxes */}
                  <div className="flex flex-wrap gap-1">
                    {templateToolOptions.map(opt => (
                      <label key={opt.type} className="flex items-center gap-1 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={template.tiles.includes(opt.type)}
                          onChange={() => toggleTemplateTile(template.id, opt.type)}
                          className="w-3 h-3 rounded border-vibe-border text-vibe-primary focus:ring-0 focus:ring-offset-0"
                        />
                        <span className="text-[10px] text-vibe-muted">{opt.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}

              {/* Add new template */}
              <button
                onClick={addTemplate}
                className="w-full flex items-center justify-center gap-1 py-1.5 border border-dashed border-vibe-border rounded hover:border-vibe-primary/50 hover:bg-vibe-primary/5 transition-colors"
              >
                <svg className="w-3.5 h-3.5 text-vibe-muted" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                <span className="text-[10px] text-vibe-muted">Add Template</span>
              </button>

              {/* Save as Default + Reset + Done */}
              <div className="flex items-center gap-1.5 pt-1 border-t border-vibe-border/50">
                <button
                  onClick={saveCurrentAsDefault}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] font-medium transition-all ${
                    defaultSaved
                      ? 'bg-green-500/20 text-green-400 border border-green-500/30'
                      : 'bg-vibe-bg border border-vibe-border text-vibe-muted hover:text-vibe-text hover:border-vibe-primary/50'
                  }`}
                  title="Save the current workspace layout as the default for new projects"
                >
                  {defaultSaved ? (
                    <>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Saved
                    </>
                  ) : (
                    <>
                      <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-3m-1 4l-3 3m0 0l-3-3m3 3V4" />
                      </svg>
                      Set as Default
                    </>
                  )}
                </button>
                <button
                  onClick={handleResetTemplates}
                  className="text-[10px] text-vibe-muted hover:text-vibe-text transition-colors px-2 py-1"
                  title="Reset templates to defaults"
                >
                  Reset
                </button>
                <div className="flex-1" />
                <button
                  onClick={() => setIsEditing(false)}
                  className="text-[10px] text-vibe-primary hover:text-vibe-primary/70 transition-colors px-2 py-1 font-medium"
                >
                  Done
                </button>
              </div>
            </div>
          ) : (
            /* Template picker grid */
            <>
              <div className="grid grid-cols-2 gap-1.5">
                {templates.map(template => (
                  <button
                    key={template.id}
                    onClick={() => handleCreateFromTemplate(template)}
                    className="flex flex-col items-center gap-1 p-2 bg-vibe-bg border border-vibe-border rounded hover:border-vibe-primary/50 hover:bg-vibe-primary/5 transition-colors text-center"
                    title={template.description}
                  >
                    <div className="w-10 h-7 flex items-center justify-center rounded bg-vibe-surface border border-vibe-border/50">
                      <TemplateLayoutPreview template={template} />
                    </div>
                    <div className="text-[11px] font-medium text-vibe-text leading-tight truncate w-full">{template.name}</div>
                    <div className="text-[9px] text-vibe-muted leading-tight truncate w-full">{templateSummary(template)}</div>
                  </button>
                ))}
              </div>

              {/* Name input + edit button */}
              <div className="flex items-center gap-1.5 mt-2">
                <input
                  type="text"
                  value={workspaceName}
                  onChange={e => setWorkspaceName(e.target.value)}
                  placeholder="Workspace name (optional)..."
                  className="flex-1 px-2 py-1 bg-vibe-bg border border-vibe-border rounded text-xs text-vibe-text focus:outline-none focus:border-vibe-primary min-w-0"
                />
                <button
                  onClick={() => setIsEditing(true)}
                  className="p-1 text-vibe-muted hover:text-vibe-text rounded transition-colors flex-shrink-0"
                  title="Edit templates"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                  </svg>
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {/* Global workspaces — same controls that previously lived in the
          toolbar's Global button popover, now consolidated here. */}
      <GlobalWorkspaceSection searchQuery={searchQuery} />
    </>
  )
}
