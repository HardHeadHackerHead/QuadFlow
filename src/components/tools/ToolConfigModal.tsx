/**
 * Generic tool config editor (plugin-system.md §5.1): the same form for every
 * tool — name, color, visibility, pinning, display, open mode — plus
 * `FormFromSchema` over the contribution's `configSchema` (TUI executable,
 * terminal shell, agent provider, …). "Add tool" offers every available
 * contribution that allows more than one config (`instanceMultiple`).
 */
import { useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Field, FormFromSchema, Input, Modal, Select, validateSchema, type JsonSchema, type FormValue } from '@quadflow/ui'
import { useToolStore } from '../../stores/toolStore'
import { ToolConfig, ToolOpenMode, ToolPinDisplay, ToolbarSection } from '../../types'
import { TOOL_COLORS } from '../../lib/toolColors'
import {
  ToolIcon,
  configSchemaOf,
  contributionLabel,
  contributionModes,
  getToolContribution,
  groupToolConfigs,
  isActionContribution,
  isInstanceMultiple,
  listContributions,
  supportsMiniWidget,
  useAvailableToolConfigs,
  type ToolContribution,
} from '../../plugins/tools'
import PluginIcon from '../../plugins/PluginIcon'

type View = { kind: 'list' } | { kind: 'edit'; id: string } | { kind: 'add' } | { kind: 'create'; contribution: ToolContribution }

interface Draft {
  name: string
  color: string
  enabled: boolean
  pinned: boolean
  pinSection: ToolbarSection
  pinDisplay: ToolPinDisplay
  quickLaunch: boolean
  openMode: ToolOpenMode
  settings: FormValue
}

function draftOf(c: ToolConfig): Draft {
  return {
    name: c.name,
    color: c.color ?? '',
    enabled: c.enabled,
    pinned: c.pinned,
    pinSection: c.pinSection ?? 'right',
    pinDisplay: c.pinDisplay,
    quickLaunch: c.quickLaunch,
    openMode: c.openMode,
    settings: (c.settings ?? {}) as FormValue,
  }
}

function newDraft(contribution: ToolContribution): Draft {
  return {
    name: contribution.title,
    color: '',
    enabled: true,
    pinned: false,
    pinSection: 'right',
    pinDisplay: 'icon-and-name',
    quickLaunch: false,
    openMode: contributionModes(contribution)[0] ?? 'pane',
    settings: {},
  }
}

function ConfigForm({ contribution, draft, onChange }: { contribution: ToolContribution | undefined; draft: Draft; onChange: (d: Draft) => void }) {
  const schema = configSchemaOf(contribution) as JsonSchema | null
  const modes = contributionModes(contribution)
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => onChange({ ...draft, [k]: v })
  return (
    <div className="flex flex-col gap-4">
      <Field label="Name" required>
        <Input value={draft.name} onChange={(e) => set('name', e.target.value)} autoFocus />
      </Field>

      {schema && (
        <div className="rounded border border-vibe-border p-3" data-tool-settings>
          <div className="mb-2 text-xs uppercase tracking-wide text-vibe-muted">Settings</div>
          <FormFromSchema schema={schema} value={draft.settings} onChange={(v) => set('settings', v)} />
        </div>
      )}

      <Field label="Color">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => set('color', '')}
            className={`h-5 w-5 rounded-full border-2 ${!draft.color ? 'border-vibe-text' : 'border-vibe-border'}`}
            title="No color"
          />
          {TOOL_COLORS.map((c) => (
            <button
              type="button"
              key={c.value}
              onClick={() => set('color', c.value)}
              className={`h-5 w-5 rounded-full border-2 ${draft.color === c.value ? 'border-vibe-text' : 'border-transparent'}`}
              style={{ backgroundColor: c.value }}
              title={c.name}
            />
          ))}
        </div>
      </Field>

      <div className="grid grid-cols-2 gap-3">
        <Checkbox checked={draft.enabled} onChange={(v) => set('enabled', v)} label="Show in Tools menu" />
        <Checkbox checked={draft.quickLaunch} onChange={(v) => set('quickLaunch', v)} label="Quick launch (empty tiles)" />
        <Checkbox checked={draft.pinned} onChange={(v) => set('pinned', v)} label="Pin to toolbar" />
      </div>

      {draft.pinned && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Toolbar section">
            <Select<ToolbarSection>
              value={draft.pinSection}
              onChange={(v) => set('pinSection', v)}
              options={[
                { value: 'left', label: 'Left' },
                { value: 'center', label: 'Center' },
                { value: 'right', label: 'Right' },
              ]}
            />
          </Field>
          <Field label="Button">
            <Select<ToolPinDisplay>
              value={draft.pinDisplay}
              onChange={(v) => set('pinDisplay', v)}
              options={[
                { value: 'icon', label: 'Icon only' },
                { value: 'icon-and-name', label: 'Icon & name' },
                ...(supportsMiniWidget(contribution) ? [{ value: 'mini' as const, label: 'Mini dashboard' }] : []),
              ]}
            />
          </Field>
        </div>
      )}

      {!isActionContribution(contribution) && modes.length > 1 && (
        <Field label="Opens as">
          <Select<ToolOpenMode>
            value={draft.openMode}
            onChange={(v) => set('openMode', v)}
            options={[
              { value: 'pane', label: 'Pane' },
              { value: 'flyout', label: 'Flyout' },
            ]}
          />
        </Field>
      )}
    </div>
  )
}

export default function ToolConfigModal() {
  const {
    showToolConfigModal,
    setShowToolConfigModal,
    toolConfigs,
    editingToolId,
    setEditingToolId,
    addToolConfig,
    updateToolConfig,
    deleteToolConfig,
    resetToDefaults,
  } = useToolStore()

  const [view, setView] = useState<View>({ kind: 'list' })
  const [draft, setDraft] = useState<Draft | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const available = useAvailableToolConfigs()

  // Opening the modal with `editingToolId` set (toolbar / menu "Configure…")
  // goes straight to that config.
  useEffect(() => {
    if (!showToolConfigModal) return
    const c = editingToolId ? toolConfigs.get(editingToolId) : undefined
    if (c) {
      setView({ kind: 'edit', id: c.id })
      setDraft(draftOf(c))
    } else {
      setView({ kind: 'list' })
      setDraft(null)
    }
    setError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showToolConfigModal, editingToolId])

  const close = () => {
    setShowToolConfigModal(false)
    setEditingToolId(null)
  }

  const editing = view.kind === 'edit' ? toolConfigs.get(view.id) : undefined
  const contribution = view.kind === 'create' ? view.contribution : view.kind === 'edit' ? getToolContribution(editing) : undefined
  const addable = useMemo(() => (view.kind === 'add' ? listContributions().filter(isInstanceMultiple) : []), [view.kind])

  const save = async () => {
    if (!draft) return
    const schema = configSchemaOf(contribution) as JsonSchema | null
    if (!draft.name.trim()) return setError('Name is required')
    if (schema && Object.keys(validateSchema(schema, draft.settings)).length > 0) return setError('Check the settings')
    setBusy(true)
    setError(null)
    try {
      const fields = {
        name: draft.name.trim(),
        color: draft.color || undefined,
        enabled: draft.enabled,
        pinned: draft.pinned,
        pinSection: draft.pinSection,
        pinDisplay: draft.pinDisplay,
        quickLaunch: draft.quickLaunch,
        openMode: draft.openMode,
        settings: draft.settings as Record<string, unknown>,
      }
      if (view.kind === 'create') {
        const c = await addToolConfig(fields.name, { pluginId: view.contribution.pluginId, contributionId: view.contribution.id }, {
          settings: fields.settings,
          pinned: fields.pinned,
          openMode: fields.openMode,
          pinDisplay: fields.pinDisplay,
          color: fields.color,
          quickLaunch: fields.quickLaunch,
        })
        await updateToolConfig(c.id, { pinSection: fields.pinSection, enabled: fields.enabled })
      } else if (view.kind === 'edit') {
        await updateToolConfig(view.id, fields)
      }
      setView({ kind: 'list' })
      setDraft(null)
      setEditingToolId(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!editing || editing.builtIn) return
    if (!window.confirm(`Delete "${editing.name}"?`)) return
    await deleteToolConfig(editing.id)
    setView({ kind: 'list' })
    setDraft(null)
  }

  const title =
    view.kind === 'list' ? 'Configure Tools' : view.kind === 'add' ? 'Add Tool' : view.kind === 'create' ? `New ${view.contribution.title}` : `Edit ${editing?.name ?? ''}`

  const footer =
    view.kind === 'list' ? (
      <div className="flex w-full items-center justify-between">
        <Button
          variant="ghost"
          onClick={async () => {
            if (window.confirm('Reset all built-in tools to their default names, colors, order and pin settings?\n\nTools you added are not affected.')) {
              await resetToDefaults()
            }
          }}
        >
          Reset Defaults
        </Button>
        <Button variant="primary" onClick={() => setView({ kind: 'add' })}>
          Add Tool
        </Button>
      </div>
    ) : view.kind === 'add' ? (
      <Button variant="secondary" onClick={() => setView({ kind: 'list' })}>
        Back
      </Button>
    ) : (
      <div className="flex w-full items-center justify-between">
        <div>
          {editing && !editing.builtIn && (
            <Button variant="danger" onClick={remove}>
              Delete
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => { setView({ kind: 'list' }); setDraft(null); setEditingToolId(null) }}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Save
          </Button>
        </div>
      </div>
    )

  return (
    <Modal open={showToolConfigModal} onClose={close} title={title} size="lg" overlayId="tool-config-modal" footer={footer}>
      <div className="max-h-[60vh] overflow-y-auto pr-1" data-tool-config-modal={view.kind}>
        {view.kind === 'list' &&
          groupToolConfigs(available).map((group) => (
            <div key={group.id} className="mb-3">
              <div className="px-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-vibe-muted">{group.label}</div>
              {group.tools.map((tool) => (
                <button
                  key={tool.id}
                  onClick={() => {
                    setView({ kind: 'edit', id: tool.id })
                    setDraft(draftOf(tool))
                  }}
                  className="flex w-full items-center gap-3 rounded px-2 py-1.5 text-left hover:bg-vibe-border/50"
                  data-tool-config={tool.id}
                >
                  <span className="flex" style={tool.color ? { color: tool.color } : undefined}>
                    <ToolIcon config={tool} />
                  </span>
                  <span className={`flex-1 text-sm ${tool.enabled ? 'text-vibe-text' : 'text-vibe-muted line-through'}`}>{tool.name}</span>
                  <span className="text-xs text-vibe-muted">{contributionLabel(tool)}</span>
                  {tool.pinned && <span className="text-[10px] text-vibe-primary">pinned</span>}
                </button>
              ))}
            </div>
          ))}

        {view.kind === 'add' && (
          <div className="flex flex-col gap-1">
            {addable.length === 0 && <p className="text-sm text-vibe-muted">No installed plugin offers additional tools.</p>}
            {addable.map((c) => (
              <button
                key={`${c.pluginId}/${c.id}`}
                onClick={() => {
                  setView({ kind: 'create', contribution: c })
                  setDraft(newDraft(c))
                }}
                className="flex w-full items-center gap-3 rounded px-2 py-2 text-left hover:bg-vibe-border/50"
                data-tool-ref={`${c.pluginId}/${c.id}`}
              >
                <PluginIcon pluginId={c.pluginId} contributionId={c.id} className="h-4 w-4" />
                <span className="flex-1">
                  <span className="block text-sm text-vibe-text">{c.title}</span>
                  {c.kind === 'tile' && c.tile.description && <span className="block text-xs text-vibe-muted">{c.tile.description}</span>}
                </span>
                <span className="text-xs text-vibe-muted">{c.pluginId}</span>
              </button>
            ))}
          </div>
        )}

        {(view.kind === 'edit' || view.kind === 'create') && draft && (
          <>
            {view.kind === 'edit' && !contribution && (
              <p className="mb-3 text-sm text-vibe-muted">The plugin providing this tool is not active.</p>
            )}
            <ConfigForm contribution={contribution} draft={draft} onChange={setDraft} />
            {error && <p className="mt-3 text-sm text-vibe-error">{error}</p>}
          </>
        )}
      </div>
    </Modal>
  )
}
