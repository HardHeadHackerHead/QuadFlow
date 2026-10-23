import type { ReactNode } from 'react'
import { usePluginContext } from '@quadflow/plugin-api'

/** A link that opens in the system browser (`ctx.shell.openExternal`, `shell:open-external`). */
export default function ExternalLink({ href, className, children, title }: { href: string; className?: string; children: ReactNode; title?: string }) {
  const ctx = usePluginContext()
  return (
    <a
      href={href}
      title={title}
      className={className}
      onClick={(e) => {
        e.preventDefault()
        ctx.shell.openExternal(href).catch((err) => ctx.log.warn('openExternal failed', err))
      }}
    >
      {children}
    </a>
  )
}
