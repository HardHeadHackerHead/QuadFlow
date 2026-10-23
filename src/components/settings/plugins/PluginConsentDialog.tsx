/**
 * Consent dialog (plugin-system.md §11.2): plugin, source, version and the
 * requested permissions grouped by risk. Updates show the permission diff
 * (+ added / − revoked). Critical permissions need "I trust this plugin".
 */
import { useEffect, useState } from 'react'
import { Badge, Button, Checkbox, Modal, type Tone } from '@quadflow/ui'
import type { PermissionInfo, Risk } from '../../../generated/bindings'

export interface ConsentRequest {
  title: string
  pluginName: string
  pluginId: string
  version?: string | null
  fromVersion?: string | null
  sourceName?: string | null
  isolation?: string | null
  permissions: PermissionInfo[]
  /** Highlighted as new (update diff). */
  added?: string[]
  /** Shown as revoked (update diff). */
  removed?: string[]
  notes?: string | null
  confirmLabel: string
}

const RISK_ORDER: Risk[] = ['critical', 'high', 'medium', 'low']
const RISK_TONE: Record<Risk, Tone> = { critical: 'error', high: 'warning', medium: 'primary', low: 'neutral' }
const RISK_LABEL: Record<Risk, string> = { critical: 'Critical', high: 'High risk', medium: 'Medium risk', low: 'Low risk' }

export function PluginConsentDialog({
  request,
  busy,
  onConfirm,
  onCancel,
}: {
  request: ConsentRequest | null
  busy?: boolean
  onConfirm: () => void
  onCancel: () => void
}) {
  const [trusted, setTrusted] = useState(false)
  useEffect(() => setTrusted(false), [request])
  if (!request) return null
  const critical = request.permissions.some((p) => p.risk === 'critical')
  const added = new Set(request.added ?? [])
  const groups = RISK_ORDER.map((risk) => ({ risk, items: request.permissions.filter((p) => p.risk === risk) })).filter(
    (g) => g.items.length > 0,
  )

  return (
    <Modal
      open
      onClose={onCancel}
      overlayId="plugin-consent-dialog"
      title={request.title}
      description={
        <span>
          <span className="font-medium text-qf-text">{request.pluginName}</span>{' '}
          <span className="font-mono text-xs">({request.pluginId})</span>
          {request.version && (
            <>
              {' '}
              {request.fromVersion ? `${request.fromVersion} → ${request.version}` : request.version}
            </>
          )}
          {request.sourceName && <> from {request.sourceName}</>}
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={critical ? 'danger' : 'primary'}
            onClick={onConfirm}
            loading={busy}
            disabled={busy || (critical && !trusted)}
            data-testid="plugin-consent-confirm"
          >
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm" data-testid="plugin-consent-dialog">
        {request.isolation && (
          <p className="text-qf-text-muted">
            Runs {request.isolation === 'sandboxed' ? 'sandboxed (isolated frame)' : 'as a trusted first-party plugin'}.
          </p>
        )}
        {groups.length === 0 ? (
          <p className="text-qf-text-muted">This plugin requests no permissions.</p>
        ) : (
          groups.map((g) => (
            <div key={g.risk}>
              <div className="mb-1.5 flex items-center gap-2">
                <Badge tone={RISK_TONE[g.risk]}>{RISK_LABEL[g.risk]}</Badge>
              </div>
              <ul className="space-y-1">
                {g.items.map((p) => (
                  <li key={p.permission} className="flex items-start gap-2">
                    <span className={`mt-0.5 w-3 font-mono ${added.has(p.permission) ? 'text-qf-warning' : 'text-transparent'}`}>
                      +
                    </span>
                    <div>
                      <div className="text-qf-text">{p.description}</div>
                      <div className="font-mono text-xs text-qf-text-muted">
                        {p.permission}
                        {added.has(p.permission) && <span className="ml-2 text-qf-warning">new</span>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        {request.removed && request.removed.length > 0 && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-qf-text-muted">Revoked (no longer requested)</div>
            <ul className="space-y-0.5 font-mono text-xs text-qf-text-muted">
              {request.removed.map((p) => (
                <li key={p}>− {p}</li>
              ))}
            </ul>
          </div>
        )}
        {request.notes && <p className="whitespace-pre-wrap text-qf-text-muted">{request.notes}</p>}
        {critical && (
          <Checkbox
            checked={trusted}
            onChange={setTrusted}
            label="I trust this plugin"
            description="It requests critical permissions that give it broad access to your machine."
          />
        )}
      </div>
    </Modal>
  )
}
