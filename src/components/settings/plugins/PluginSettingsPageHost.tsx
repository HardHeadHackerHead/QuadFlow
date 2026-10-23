/**
 * Renders one plugin settings page (`contributes.settingsPages`,
 * plugin-system.md §5): `custom: true` → the UI module's `settingsPages[id]`
 * component inside the plugin's context; otherwise an auto form over the
 * plugin's `contributes.settings` schema bound to `ctx.settings`.
 * Trusted plugins only (sandboxed settings pages arrive with PL-6).
 */
import { Component, useEffect, useState, type ReactNode } from 'react'
import { PluginContextProvider, type JsonValue } from '@quadflow/plugin-api'
import { Button, EmptyState, FormFromSchema, Spinner, type FormValue, type JsonSchema } from '@quadflow/ui'
import { loadPluginModule, type LoadedPluginModule } from '../../../plugins/loader'
import { usePluginRegistry, type PluginContributions } from '../../../plugins/registry'

export type PluginSettingsPageRef = PluginContributions['settingsPages'][number]

export default function PluginSettingsPageHost({ page }: { page: PluginSettingsPageRef }) {
  const { pluginId, contribution } = page
  const generation = usePluginRegistry((s) => s.generations[pluginId] ?? 0)
  const schema = usePluginRegistry((s) => s.contributions?.settings.find((c) => c.pluginId === pluginId)?.contribution)
  const [state, setState] = useState<{ loaded?: LoadedPluginModule; error?: string }>({})
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({})
    loadPluginModule(pluginId).then(
      (loaded) => !cancelled && setState({ loaded }),
      (e) => !cancelled && setState({ error: e instanceof Error ? e.message : String(e) }),
    )
    return () => {
      cancelled = true
    }
  }, [pluginId, generation, attempt])

  if (state.error) return <PageError message={state.error} onRetry={() => setAttempt((n) => n + 1)} />
  if (!state.loaded) return <Spinner />
  const { loaded } = state

  if (contribution.custom) {
    const Page = loaded.module.settingsPages?.[contribution.id]
    if (!Page) return <PageError message={`Plugin "${pluginId}" does not export settings page "${contribution.id}"`} />
    return (
      <div data-plugin-settings-page={`${pluginId}/${contribution.id}`}>
        <PageErrorBoundary key={`${generation}:${attempt}`} onRetry={() => setAttempt((n) => n + 1)}>
          <PluginContextProvider value={loaded.ctx}>
            <Page ctx={loaded.ctx} />
          </PluginContextProvider>
        </PageErrorBoundary>
      </div>
    )
  }
  if (!schema || typeof schema !== 'object') {
    return <EmptyState title="No settings" description={`${pluginId} declares no settings schema.`} />
  }
  return <SchemaForm loaded={loaded} schema={schema as unknown as JsonSchema} />
}

function SchemaForm({ loaded, schema }: { loaded: LoadedPluginModule; schema: JsonSchema }) {
  const [value, setValue] = useState<FormValue>(() => loaded.ctx.settings.getAll() as FormValue)
  useEffect(() => loaded.ctx.settings.onDidChange(() => setValue(loaded.ctx.settings.getAll() as FormValue)), [loaded])
  return (
    <FormFromSchema
      schema={schema}
      value={value}
      onChange={(next) => {
        setValue(next)
        for (const [k, v] of Object.entries(next)) {
          if (JSON.stringify(v) !== JSON.stringify((value as Record<string, unknown>)[k])) {
            void loaded.ctx.settings.set(k, v as JsonValue).catch((e) => console.error(`[plugins] settings.set ${k}:`, e))
          }
        }
      }}
    />
  )
}

function PageError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <EmptyState
      title="Settings page failed to load"
      description={message}
      action={onRetry ? <Button size="sm" onClick={onRetry}>Retry</Button> : undefined}
    />
  )
}

class PageErrorBoundary extends Component<{ children: ReactNode; onRetry(): void }, { error: Error | null }> {
  state = { error: null as Error | null }
  static getDerivedStateFromError(error: Error) {
    return { error }
  }
  render() {
    return this.state.error ? <PageError message={this.state.error.message} onRetry={this.props.onRetry} /> : this.props.children
  }
}
