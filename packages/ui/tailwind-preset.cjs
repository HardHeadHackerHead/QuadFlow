/**
 * @quadflow/ui Tailwind preset (plugin-system.md §14.1).
 *
 * Maps the legacy `vibe-*` color names onto the `--qf-*` CSS variables from
 * src/tokens.css so existing classes (`bg-vibe-surface`, `text-vibe-muted/50`,
 * …) keep working and follow the active theme. The `qf-*` names are the same
 * tokens under their canonical names, for new code.
 *
 * Consumers must still list `@quadflow/ui` sources in their own `content`
 * globs (Tailwind replaces, not merges, `content` from presets):
 *   content: ['./src/**\/*.{ts,tsx}', './node_modules/@quadflow/ui/src/**\/*.{ts,tsx}']
 *
 * @type {import('tailwindcss').Config}
 */
const v = (name) => `rgb(var(--qf-${name}) / <alpha-value>)`

/** token name -> legacy Tailwind name */
const LEGACY = {
  bg: 'bg',
  'bg-elevated': 'bg-lighter',
  surface: 'surface',
  border: 'border',
  'border-strong': 'border-bright',
  primary: 'primary',
  'primary-hover': 'primary-hover',
  secondary: 'secondary',
  text: 'text',
  'text-muted': 'muted',
  success: 'success',
  warning: 'warning',
  error: 'error',
}

const vibe = {}
const qf = {}
for (const [token, legacy] of Object.entries(LEGACY)) {
  vibe[legacy] = v(token)
  qf[token] = v(token)
}
qf['on-primary'] = v('on-primary')
qf.scrim = v('scrim')

module.exports = {
  theme: {
    extend: {
      colors: { vibe, qf },
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'Consolas', 'monospace'],
      },
      borderRadius: {
        panel: 'var(--qf-radius-panel)',
      },
      spacing: {
        panel: 'var(--qf-gap-panel)',
      },
    },
  },
}
