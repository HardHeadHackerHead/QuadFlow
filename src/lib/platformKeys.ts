/**
 * App-shortcut modifier per platform: ⌘ on macOS, Ctrl elsewhere.
 *
 * On macOS Ctrl+K / Ctrl+B / Ctrl+W are shell keys (kill line, back one char,
 * delete word) that a terminal must receive, and users expect ⌘ for app
 * shortcuts; on Windows and Linux Ctrl stays the app modifier.
 */
export const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || '')

/** True when the platform's app-shortcut modifier is held (⌘ on macOS, Ctrl elsewhere). */
export function isModKey(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return IS_MAC ? e.metaKey : e.ctrlKey
}

/** Label of the app-shortcut modifier for key hints. */
export const MOD_LABEL = IS_MAC ? '⌘' : 'Ctrl'

/** "Ctrl+K" / "⌘K" style shortcut text for titles and copy. */
export function shortcut(...keys: string[]): string {
  return IS_MAC ? [MOD_LABEL, ...keys].join('') : [MOD_LABEL, ...keys].join('+')
}
