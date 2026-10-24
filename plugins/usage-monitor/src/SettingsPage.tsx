/**
 * Settings → Usage Monitor (`contributes.settingsPages[usage-monitor]`, custom):
 * the toolbar mini widget (style, which providers and windows it shows, with a
 * live preview), then the schema form for refresh and thresholds. Everything
 * is stored with `ctx.settings` (schema in quadflow-plugin.json).
 */
import { useEffect, useState } from 'react'
import type { JsonValue, SettingsPageProps } from '@quadflow/plugin-api'
import { Button, Checkbox, FormFromSchema, Select, type FormValue, type JsonSchema } from '@quadflow/ui'
import manifest from '../quadflow-plugin.json'
import { MiniView } from './MiniWidget'
import { MINI_STYLES, isHidden, miniGroups, providerRows, toggleHidden, visibleMax, windowKey, type MiniStyle } from './model'
import { bind, ensureProviders, refresh, useUsageStore } from './store'

const MINI_KEYS = new Set(['miniStyle', 'miniHidden'])
const settingsSchema = manifest.contributes.settings as unknown as JsonSchema & { properties: Record<string, JsonSchema> }
/** The auto form covers everything except the mini widget keys (edited above it). */
const FORM_SCHEMA: JsonSchema = {
  ...settingsSchema,
  properties: Object.fromEntries(Object.entries(settingsSchema.properties).filter(([k]) => !MINI_KEYS.has(k))),
}

export default function UsageMonitorSettingsPage({ ctx }: SettingsPageProps) {
  const providers = useUsageStore((s) => s.providers)
  const usage = useUsageStore((s) => s.usage)
  const settings = useUsageStore((s) => s.settings)
  const refreshing = useUsageStore((s) => s.refreshing)
  const [form, setForm] = useState<FormValue>(() => ctx.settings.getAll() as FormValue)

  useEffect(() => {
    bind(ctx)
    void ensureProviders()
    return ctx.settings.onDidChange(() => setForm(ctx.settings.getAll() as FormValue))
  }, [ctx])

  const set = (key: string, value: JsonValue) => void ctx.settings.set(key, value).catch((e) => ctx.log.error(`settings.set ${key}:`, e))
  const setHidden = (key: string, hide: boolean) => set('miniHidden', toggleHidden(settings.miniHidden, key, hide))

  const rows = providerRows(providers ?? [], usage)
  const groups = miniGroups(rows, settings)
  const noData = rows.every((r) => (r.snapshot?.windows.length ?? 0) === 0)

  return (
    <div className="qf-um-settings" data-testid="usage-settings-page">
      <section className="qf-um-settings__section">
        <h3 className="qf-um-settings__title">Toolbar mini widget</h3>
        <p className="qf-um__muted">
          Pin Usage Monitor to the toolbar as a mini widget (right-click its toolbar button → Mini Dashboard) to see these windows at a glance. The
          gear in the widget opens this page.
        </p>
        <label className="qf-um__field">
          <span>Style</span>
          <Select
            size="sm"
            aria-label="Mini widget style"
            value={settings.miniStyle}
            options={MINI_STYLES.map((m) => ({ value: m.value, label: m.label, description: m.description }))}
            onChange={(v) => set('miniStyle', v as MiniStyle)}
          />
        </label>
        <div className="qf-um-settings__preview" data-testid="usage-mini-preview">
          <span className="qf-um-settings__preview-label">Preview</span>
          <span className={`qf-um-mini qf-um-mini--style-${settings.miniStyle}`}>
            <MiniView groups={groups} settings={settings} max={visibleMax(groups)} now={Date.now()} />
          </span>
        </div>
        <div className="qf-um-settings__providers">
          {rows.length === 0 && <p className="qf-um__muted">No agent provider reports usage.</p>}
          {rows.map((r) => {
            const providerHidden = isHidden(settings.miniHidden, r.provider.id)
            const windows = r.snapshot?.windows ?? []
            return (
              <div key={r.provider.id} className="qf-um-settings__provider" data-testid="usage-settings-provider" data-provider={r.provider.id}>
                <Checkbox checked={!providerHidden} onChange={(on) => setHidden(r.provider.id, !on)} label={r.provider.name} />
                <div className="qf-um-settings__windows">
                  {windows.map((w) => (
                    <Checkbox
                      key={w.id}
                      disabled={providerHidden}
                      checked={!isHidden(settings.miniHidden, r.provider.id, w.id)}
                      onChange={(on) => setHidden(windowKey(r.provider.id, w.id), !on)}
                      label={w.label}
                    />
                  ))}
                  {windows.length === 0 && <span className="qf-um__muted">No windows read yet.</span>}
                </div>
              </div>
            )
          })}
        </div>
        {noData && rows.length > 0 && (
          <div>
            <Button size="sm" disabled={refreshing} onClick={() => void refresh({ force: true })}>
              {refreshing ? 'Checking…' : 'Check usage now'}
            </Button>
          </div>
        )}
      </section>
      <section className="qf-um-settings__section">
        <h3 className="qf-um-settings__title">Refresh and warnings</h3>
        <FormFromSchema
          schema={FORM_SCHEMA}
          value={form}
          onChange={(next) => {
            setForm(next)
            for (const [k, v] of Object.entries(next)) {
              if (MINI_KEYS.has(k)) continue
              if (JSON.stringify(v) !== JSON.stringify((form as Record<string, unknown>)[k])) set(k, v as JsonValue)
            }
          }}
        />
      </section>
    </div>
  )
}
