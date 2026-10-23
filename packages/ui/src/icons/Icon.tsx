import type { SVGProps } from 'react'
import { TOOL_ICON_PATHS } from './toolPaths'
import { UI_ICON_PATHS } from './uiPaths'
import type { IconDef } from './types'

export type { IconDef } from './types'

/** Every built-in icon, keyed by name (tool ids such as `issues` plus UI glyphs). */
export const ICONS: Record<string, IconDef> = { ...TOOL_ICON_PATHS, ...UI_ICON_PATHS }

export type IconName = keyof typeof UI_ICON_PATHS | keyof typeof TOOL_ICON_PATHS | (string & {})

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  /** Built-in icon name; unknown names fall back to `custom`. */
  name: IconName
  /** Tailwind size classes; default `w-4 h-4`. */
  className?: string
  /** Accessible label; omit for decorative icons. */
  label?: string
}

export function Icon({ name, className = 'w-4 h-4', label, ...rest }: IconProps) {
  const def = ICONS[name] ?? ICONS.custom
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill={def.filled ? 'currentColor' : 'none'}
      stroke={def.filled ? undefined : 'currentColor'}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      {...rest}
    >
      {def.d.map((d, i) =>
        def.filled ? (
          <path key={i} d={d} />
        ) : (
          <path key={i} strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={d} />
        ),
      )}
    </svg>
  )
}

/** Register additional icons (e.g. a plugin's own glyph set). */
export function registerIcons(defs: Record<string, IconDef>) {
  Object.assign(ICONS, defs)
}
