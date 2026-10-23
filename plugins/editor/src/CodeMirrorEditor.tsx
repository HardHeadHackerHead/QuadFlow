import { useRef, useEffect, useCallback } from 'react'
import { EditorView, keymap, drawSelection, highlightActiveLine, highlightSpecialChars, lineNumbers, highlightActiveLineGutter } from '@codemirror/view'
import { EditorState, Compartment } from '@codemirror/state'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput, syntaxHighlighting, defaultHighlightStyle, foldGutter, foldKeymap } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search'
import { oneDark } from '@codemirror/theme-one-dark'
import { loadLanguage } from './languages'
import { editorTheme } from './theme'

interface CodeMirrorEditorProps {
  content: string
  extension: string
  readOnly: boolean
  /** Follows the app theme (`ctx.ui.theme().mode`). */
  dark: boolean
  onChange?: (content: string) => void
  onSave?: () => void
}

function themeExtensions(dark: boolean) {
  return dark ? [oneDark, editorTheme(true)] : [editorTheme(false)]
}

export default function CodeMirrorEditor({
  content,
  extension,
  readOnly,
  dark,
  onChange,
  onSave,
}: CodeMirrorEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const languageCompartment = useRef(new Compartment())
  const readOnlyCompartment = useRef(new Compartment())
  const themeCompartment = useRef(new Compartment())
  const contentRef = useRef(content)
  const onChangeRef = useRef(onChange)
  const onSaveRef = useRef(onSave)

  // Keep refs up to date
  onChangeRef.current = onChange
  onSaveRef.current = onSave

  // Save keybinding
  const saveKeymap = useCallback(() => {
    return keymap.of([{
      key: 'Mod-s',
      run: () => {
        onSaveRef.current?.()
        return true
      },
    }])
  }, [])

  // Create editor on mount
  useEffect(() => {
    if (!containerRef.current) return

    const startState = EditorState.create({
      doc: content,
      extensions: [
        // Line numbers, fold gutter, etc
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        drawSelection(),
        highlightActiveLine(),
        highlightSpecialChars(),
        highlightSelectionMatches(),
        // Editing support
        history(),
        bracketMatching(),
        closeBrackets(),
        indentOnInput(),
        // Syntax highlighting
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        // Theme (dark: One Dark highlighting; both: QuadFlow's surface colors)
        themeCompartment.current.of(themeExtensions(dark)),
        // Keymaps
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          indentWithTab,
        ]),
        saveKeymap(),
        // Compartments for dynamic reconfiguration
        languageCompartment.current.of([]),
        readOnlyCompartment.current.of(EditorState.readOnly.of(readOnly)),
        // Update listener
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            const newContent = update.state.doc.toString()
            contentRef.current = newContent
            onChangeRef.current?.(newContent)
          }
        }),
      ],
    })

    const view = new EditorView({
      state: startState,
      parent: containerRef.current,
    })

    viewRef.current = view

    return () => {
      view.destroy()
      viewRef.current = null
    }
    // Only run on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load language when extension changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    let cancelled = false
    loadLanguage(extension).then((lang) => {
      if (cancelled || !viewRef.current) return
      viewRef.current.dispatch({
        effects: languageCompartment.current.reconfigure(lang ? [lang] : []),
      })
    })

    return () => { cancelled = true }
  }, [extension])

  // Toggle readOnly when prop changes
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: readOnlyCompartment.current.reconfigure(EditorState.readOnly.of(readOnly)),
    })
  }, [readOnly])

  // Follow light/dark theme changes
  useEffect(() => {
    viewRef.current?.dispatch({ effects: themeCompartment.current.reconfigure(themeExtensions(dark)) })
  }, [dark])

  // Replace document when content changes externally (different from what's in the editor)
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    // Only replace if the external content differs from what we last emitted
    if (content !== contentRef.current) {
      contentRef.current = content
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: content,
        },
      })
    }
  }, [content])

  return (
    <div ref={containerRef} className="h-full w-full overflow-hidden" data-testid="editor-codemirror" />
  )
}
