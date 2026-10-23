import { providerColor, providerShortName, useProviderInfo } from './providers'

/** Small colored badge with a provider's short name (from its manifest). */
export default function ProviderBadge({ providerId, className = '' }: { providerId: string | null | undefined; className?: string }) {
  const p = useProviderInfo(providerId)
  if (!providerId) return null
  return (
    <span
      className={`px-1 py-0.5 rounded text-xs font-medium text-white flex-shrink-0 ${className}`}
      style={{ backgroundColor: providerColor(p) }}
      title={p?.displayName ?? providerId}
    >
      {providerShortName(p, providerId)}
    </span>
  )
}
