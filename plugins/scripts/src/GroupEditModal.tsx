/** Create / edit a script group: name, mode, ordered members (+ start delay in parallel mode). */
import { useState, type FormEvent } from 'react'
import type { ScriptGroupMode } from '@quadflow/plugin-api'
import { Modal } from '@quadflow/ui'
import type { Script, ScriptGroup } from './model'

interface Props {
  open: boolean
  group: ScriptGroup | null
  scripts: Script[]
  onSave(g: { name: string; mode: ScriptGroupMode; members: { scriptId: string; delayMs: number }[] }): Promise<void>
  onClose(): void
}

const input =
  'w-full px-3 py-2 bg-vibe-bg-lighter border border-vibe-border rounded-lg text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-indigo-500'

export function GroupEditModal({ open, group, scripts, onSave, onClose }: Props) {
  const [name, setName] = useState(group?.name ?? '')
  const [mode, setMode] = useState<ScriptGroupMode>(group?.mode ?? 'parallel')
  const [members, setMembers] = useState<{ scriptId: string; delayMs: number }[]>(
    (group?.members ?? []).map((m) => ({ scriptId: m.scriptId, delayMs: m.delayMs ?? 0 })),
  )
  const [saving, setSaving] = useState(false)
  const byId = new Map(scripts.map((s) => [s.id, s]))
  const available = scripts.filter((s) => !members.some((m) => m.scriptId === s.id))

  const move = (i: number, d: -1 | 1) =>
    setMembers((ms) => {
      const j = i + d
      if (j < 0 || j >= ms.length) return ms
      const next = [...ms]
      ;[next[i], next[j]] = [next[j], next[i]]
      return next
    })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSaving(true)
    try {
      await onSave({ name: name.trim(), mode, members })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal open={open} onClose={onClose} size="md" overlayId="scripts-group-edit" title={group ? 'Edit Group' : 'New Group'}>
      <form onSubmit={submit} className="qf-scripts">
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-vibe-muted mb-1">Name *</label>
            <input className={input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g., Dev stack" required autoFocus data-field="group-name" />
          </div>
          <div className="flex gap-2">
            {(['parallel', 'sequential'] as ScriptGroupMode[]).map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={`flex-1 px-3 py-2 text-sm rounded-lg border ${
                  mode === m ? 'bg-indigo-600/20 border-indigo-500/50 text-indigo-400' : 'border-vibe-border text-vibe-muted hover:text-vibe-text'
                }`}
              >
                <div className="font-medium capitalize">{m}</div>
                <div className="text-[10px] opacity-75 mt-0.5">{m === 'parallel' ? 'Start all together' : 'One after another; stop on failure'}</div>
              </button>
            ))}
          </div>
          <div>
            <div className="text-sm font-medium text-vibe-muted mb-1">Scripts ({members.length})</div>
            {members.length === 0 && <p className="text-xs text-vibe-muted py-2">Add scripts below.</p>}
            <div className="space-y-1">
              {members.map((m, i) => (
                <div key={m.scriptId} className="flex items-center gap-2 bg-vibe-bg-lighter border border-vibe-border rounded px-2 py-1.5">
                  <span className="text-xs text-vibe-muted w-4">{i + 1}</span>
                  <span className="flex-1 min-w-0 truncate text-sm">{byId.get(m.scriptId)?.name ?? '(missing script)'}</span>
                  {mode === 'parallel' && (
                    <label className="flex items-center gap-1 text-[11px] text-vibe-muted" title="Wait before starting this script">
                      delay
                      <input
                        type="number"
                        min={0}
                        step={100}
                        value={m.delayMs}
                        onChange={(e) => setMembers((ms) => ms.map((x, k) => (k === i ? { ...x, delayMs: Number(e.target.value) || 0 } : x)))}
                        className="w-16 px-1 py-0.5 bg-vibe-bg border border-vibe-border rounded text-vibe-text"
                      />
                      ms
                    </label>
                  )}
                  <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="px-1 text-vibe-muted hover:text-vibe-text disabled:opacity-30" title="Move up">
                    ↑
                  </button>
                  <button type="button" onClick={() => move(i, 1)} disabled={i === members.length - 1} className="px-1 text-vibe-muted hover:text-vibe-text disabled:opacity-30" title="Move down">
                    ↓
                  </button>
                  <button type="button" onClick={() => setMembers((ms) => ms.filter((_, k) => k !== i))} className="px-1 text-vibe-muted hover:text-red-400" title="Remove">
                    ×
                  </button>
                </div>
              ))}
            </div>
            {available.length > 0 && (
              <select
                className={`${input} mt-2 text-sm`}
                value=""
                onChange={(e) => e.target.value && setMembers((ms) => [...ms, { scriptId: e.target.value, delayMs: 0 }])}
                aria-label="Add script"
              >
                <option value="">+ Add a script…</option>
                {available.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            )}
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 mt-4 pt-3 border-t border-vibe-border">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-vibe-muted hover:text-vibe-text">
            Cancel
          </button>
          <button type="submit" disabled={saving || !name.trim()} className="px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white rounded-lg">
            {group ? 'Save' : 'Create Group'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
