import { useState, useRef, useEffect, useCallback, useMemo } from 'react'
import { isModKey } from '../../lib/platformKeys'
import { useCommandPaletteStore } from '../../stores/commandPaletteStore'
import { searchCommands, groupByCategory, paletteHitsToCommands, ScoredCommand, type Command } from '../../lib/commandRegistry'
import { searchPaletteProviders } from '../../plugins/palette'
import { useOverlayRegistration } from '../../stores/overlayStore'
import CommandPaletteItem from './CommandPaletteItem'
import { usePluginRegistry } from '../../plugins/registry'
import { useToolStore } from '../../stores/toolStore'

export default function CommandPalette() {
  const { isOpen, initialFilter, close } = useCommandPaletteStore()
  useOverlayRegistration('command-palette', isOpen)
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)

  // Reset state when opened
  useEffect(() => {
    if (isOpen) {
      setQuery(initialFilter)
      setSelectedIndex(0)
      // Focus input on next tick
      requestAnimationFrame(() => {
        inputRef.current?.focus()
      })
    }
  }, [isOpen, initialFilter])

  // Compute results. The command list is derived from the plugin registry and
  // the tool configs, which may still be loading when the palette opens (cold
  // start): recompute when either changes, not only when the query does.
  const contributions = usePluginRegistry((s) => s.contributions)
  const toolConfigs = useToolStore((s) => s.toolConfigs)
  // Entity results from plugin palette providers (async, debounced).
  const [providerCmds, setProviderCmds] = useState<Command[]>([])
  useEffect(() => {
    const q = query.trim().replace(/^[>#@]/, '').trim()
    if (!isOpen || q.length < 2 || query.trim().startsWith('>')) {
      setProviderCmds([])
      return
    }
    let cancelled = false
    const t = setTimeout(() => {
      void searchPaletteProviders(q).then((hits) => {
        if (!cancelled) setProviderCmds(paletteHitsToCommands(hits))
      })
    }, 120)
    return () => {
      cancelled = true
      clearTimeout(t)
    }
  }, [query, isOpen, contributions])
  const results = useMemo(() => searchCommands(query, providerCmds), [query, providerCmds, contributions, toolConfigs])
  const groups = useMemo(() => groupByCategory(results), [results])

  // Flat list for keyboard navigation
  const flatResults = useMemo(() => {
    const flat: ScoredCommand[] = []
    for (const group of groups) {
      flat.push(...group.items)
    }
    return flat
  }, [groups])

  // Clamp selectedIndex when results change
  useEffect(() => {
    if (selectedIndex >= flatResults.length) {
      setSelectedIndex(Math.max(0, flatResults.length - 1))
    }
  }, [flatResults.length, selectedIndex])

  const executeSelected = useCallback(() => {
    if (flatResults[selectedIndex]) {
      const cmd = flatResults[selectedIndex].command
      close()
      // Execute after close to avoid UI glitches
      requestAnimationFrame(() => {
        cmd.execute()
      })
    }
  }, [flatResults, selectedIndex, close])

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    // Nothing typed in the palette reaches the window-level shortcuts (Ctrl+W, …),
    // except Ctrl+K, which toggles the palette closed (App.tsx).
    if (!(isModKey(e) && e.key === 'k')) e.nativeEvent.stopPropagation()
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex(i => Math.min(i + 1, flatResults.length - 1))
        break
      case 'ArrowUp':
        e.preventDefault()
        e.stopPropagation()
        setSelectedIndex(i => Math.max(i - 1, 0))
        break
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        executeSelected()
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        close()
        break
      case 'Tab':
        // Prevent tab from moving focus out
        e.preventDefault()
        e.stopPropagation()
        break
    }
  }, [flatResults.length, executeSelected, close])

  // Click on overlay to close
  const handleOverlayClick = useCallback((e: React.MouseEvent) => {
    if (e.target === overlayRef.current) {
      close()
    }
  }, [close])

  // Block all keyboard events from reaching terminals
  useEffect(() => {
    if (!isOpen) return

    const blockKeys = (e: KeyboardEvent) => {
      // Allow Ctrl+K to toggle closed
      if (isModKey(e) && e.key === 'k') {
        return // Let App.tsx handle this
      }
      // Escape closes the palette even before its input has focus (focus moves
      // on the next frame; until then keys still target the previous element).
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close()
        return
      }
      // Keys aimed at the palette itself must reach its React onKeyDown (Enter,
      // Escape, arrows): React listens at the root, below this capture listener.
      if (e.target instanceof Node && overlayRef.current?.contains(e.target)) return
      // Block everything else from propagating
      e.stopPropagation()
    }

    // Capture phase to intercept before terminals get the event
    window.addEventListener('keydown', blockKeys, true)
    return () => window.removeEventListener('keydown', blockKeys, true)
  }, [isOpen, close])

  if (!isOpen) return null

  // Compute flat index offsets for each group
  let runningIndex = 0

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 bg-black/50"
      onClick={handleOverlayClick}
    >
      <div className="max-w-xl mt-[15vh] mx-auto bg-vibe-surface border border-vibe-border rounded-lg shadow-2xl overflow-hidden flex flex-col">
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-vibe-border">
          <svg className="w-5 h-5 text-vibe-muted flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setSelectedIndex(0)
            }}
            onKeyDown={handleKeyDown}
            placeholder="Type a command or search..."
            className="flex-1 bg-transparent text-base text-vibe-text placeholder-vibe-muted outline-none"
            autoComplete="off"
            spellCheck={false}
          />
          {query && (
            <button
              onClick={() => { setQuery(''); setSelectedIndex(0) }}
              className="text-vibe-muted hover:text-vibe-text transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* Results */}
        <div className="max-h-[60vh] overflow-y-auto scrollbar-thin">
          {flatResults.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-vibe-muted">
              No results found
            </div>
          ) : (
            groups.map((group) => {
              const groupStartIndex = runningIndex
              const groupItems = group.items.map((item, i) => {
                const flatIndex = groupStartIndex + i
                return (
                  <CommandPaletteItem
                    key={item.command.id}
                    scored={item}
                    selected={flatIndex === selectedIndex}
                    onExecute={() => {
                      close()
                      requestAnimationFrame(() => {
                        item.command.execute()
                      })
                    }}
                    onHover={() => setSelectedIndex(flatIndex)}
                  />
                )
              })
              runningIndex += group.items.length

              return (
                <div key={group.label}>
                  <div className="sticky top-0 px-4 py-1.5 text-xs uppercase tracking-wider text-vibe-muted bg-vibe-surface/95 backdrop-blur-sm border-b border-vibe-border/50">
                    {group.label}
                  </div>
                  {groupItems}
                </div>
              )
            })
          )}
        </div>

        {/* Footer with keyboard hints */}
        <div className="px-4 py-2 border-t border-vibe-border flex items-center gap-4 text-xs text-vibe-muted">
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-vibe-bg border border-vibe-border rounded text-[10px]">↑↓</kbd>
            navigate
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-vibe-bg border border-vibe-border rounded text-[10px]">↵</kbd>
            select
          </span>
          <span className="flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-vibe-bg border border-vibe-border rounded text-[10px]">esc</kbd>
            close
          </span>
          <span className="ml-auto flex items-center gap-1">
            <kbd className="px-1 py-0.5 bg-vibe-bg border border-vibe-border rounded text-[10px]">&gt;</kbd>
            actions
            <kbd className="px-1 py-0.5 bg-vibe-bg border border-vibe-border rounded text-[10px] ml-2">#</kbd>
            issues
            <kbd className="px-1 py-0.5 bg-vibe-bg border border-vibe-border rounded text-[10px] ml-2">@</kbd>
            terminals
          </span>
        </div>
      </div>
    </div>
  )
}
