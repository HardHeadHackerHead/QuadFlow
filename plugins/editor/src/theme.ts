/**
 * CodeMirror theme on QuadFlow's theme tokens (`--qf-*` CSS variables, plugin-system.md §14.1),
 * so the editor follows the app's light/dark theme and custom themes.
 */
import { EditorView } from '@codemirror/view'

const tok = (name: string, alpha?: number) => (alpha === undefined ? `rgb(var(--qf-${name}))` : `rgb(var(--qf-${name}) / ${alpha})`)

export function editorTheme(dark: boolean) {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        backgroundColor: tok('bg'),
        color: tok('text'),
        fontSize: '13px',
      },
      '.cm-scroller, .cm-content': {
        fontFamily: "'JetBrains Mono', 'Fira Code', Consolas, monospace",
      },
      '.cm-content': { caretColor: tok('primary') },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: tok('primary') },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: tok('primary', 0.25),
      },
      '.cm-activeLine': { backgroundColor: tok('text', 0.04) },
      '.cm-activeLineGutter': { backgroundColor: tok('text', 0.06) },
      '.cm-gutters': {
        backgroundColor: tok('bg-elevated'),
        color: tok('text-muted'),
        border: 'none',
        borderRight: `1px solid ${tok('border')}`,
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 4px', minWidth: '32px' },
      '.cm-foldGutter .cm-gutterElement': { padding: '0 4px' },
      '.cm-panels': { backgroundColor: tok('surface'), color: tok('text') },
      '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${tok('border')}` },
      '.cm-searchMatch': { backgroundColor: tok('warning', 0.25), outline: `1px solid ${tok('warning', 0.5)}` },
      '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: tok('primary', 0.3) },
    },
    { dark },
  )
}
