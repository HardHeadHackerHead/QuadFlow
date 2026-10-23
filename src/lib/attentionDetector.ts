/**
 * Attention Detection Utility
 *
 * Detects when an agent terminal is waiting for user input and should trigger
 * an attention notification. Generic patterns live here; providers add their
 * own via manifest `attention.patterns` (agent-providers.md §8.6).
 */

// Patterns that indicate an agent is asking a question or waiting for input
// These are checked against the LAST LINE of output
const LAST_LINE_PATTERNS = [
  /\?\s*$/,                           // Ends with question mark
  /\[Y\/n\]/i,                        // Yes/No prompt (default yes)
  /\[y\/N\]/i,                        // Yes/No prompt (default no)
  /\(y\/n\)/i,                        // Alternative yes/no format
  /\(Y\/n\)/i,                        // Alternative yes/no format (default yes)
  /\(y\/N\)/i,                        // Alternative yes/no format (default no)
  /Press Enter/i,                     // Press enter to continue
  /waiting for/i,                     // "Waiting for approval" or similar
  /approve\?/i,                       // Approval requests
  /continue\?/i,                      // Continue prompts
  /proceed\?/i,                       // Proceed prompts
  /\[Enter\]/i,                       // Enter key prompt
  /\(yes\/no\)/i,                     // Full yes/no prompt
]

// Patterns checked against the FULL OUTPUT (any line): question formats that
// count only when the output also looks like a selection menu.
const FULL_OUTPUT_PATTERNS = [
  /Which .+ should/i,                 // "Which X should we..."
  /Do you want to/i,                  // Common question pattern
  /Would you like to/i,               // Common question pattern
  /Should I/i,                        // AI asking for permission
  /May I/i,                           // AI asking for permission
  /Can I/i,                           // AI asking for permission (when asking permission, not ability)
  /permission to/i,                   // Permission request
  /allow me to/i,                     // Permission request
  /confirm/i,                         // Confirmation prompts
]

// ANSI escape code pattern for stripping colors/formatting
const ANSI_ESCAPE_PATTERN = /\x1b\[[0-9;]*m/g

// Additional escape sequences agent TUIs use (cursor moves, OSC, DCS)
const EXTENDED_ESCAPE_PATTERN = /\x1b\[\??\d*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[PX^_].*?\x1b\\|\x1b\[[\d;]*[Hf]/g

/**
 * Strip ANSI escape codes from text
 */
function stripAnsiCodes(text: string): string {
  return text
    .replace(ANSI_ESCAPE_PATTERN, '')
    .replace(EXTENDED_ESCAPE_PATTERN, '')
}

/**
 * Get the last N meaningful lines from output (ignoring empty lines)
 */
function getLastMeaningfulLines(output: string, count: number = 5): string[] {
  const lines = output.trim().split('\n')
  const meaningful: string[] = []

  for (let i = lines.length - 1; i >= 0 && meaningful.length < count; i--) {
    const line = lines[i].trim()
    if (line.length > 0) {
      meaningful.unshift(line)
    }
  }

  return meaningful
}

const providerPatternCache = new Map<string, RegExp | null>()

function compileProviderPattern(p: string): RegExp | null {
  if (!providerPatternCache.has(p)) {
    let re: RegExp | null = null
    try { re = new RegExp(p, 'm') } catch { re = null }
    providerPatternCache.set(p, re)
  }
  return providerPatternCache.get(p) ?? null
}

/**
 * Check if the output indicates the terminal needs user attention.
 *
 * @param output - The terminal output to check
 * @param providerPatterns - The provider's `attention.patterns` (regex sources)
 * @returns true if the output suggests the terminal is waiting for user input
 */
export function shouldTriggerAttention(output: string, providerPatterns: readonly string[] = []): boolean {
  // Strip ANSI codes first
  const cleanOutput = stripAnsiCodes(output)

  for (const p of providerPatterns) {
    if (compileProviderPattern(p)?.test(cleanOutput)) return true
  }

  // Get the last few meaningful lines for last-line patterns
  const lastLines = getLastMeaningfulLines(cleanOutput, 5)
  const lastLine = lastLines[lastLines.length - 1] || ''

  // Check last line patterns
  if (LAST_LINE_PATTERNS.some(pattern => pattern.test(lastLine))) {
    return true
  }

  // Check full output patterns (looks at entire output)
  if (FULL_OUTPUT_PATTERNS.some(pattern => pattern.test(cleanOutput))) {
    // Additional check: make sure it looks like a selection menu
    // (has multiple numbered options or selection cursor)
    const hasSelectionCursor = /^\s*>\s*\d+\./m.test(cleanOutput)
    const hasNumberedOptions = /^\s*\d+\.\s+\w+/m.test(cleanOutput)
    const hasCheckbox = /^\s*\[\s*\]\s*\w+/m.test(cleanOutput)

    if (hasSelectionCursor || hasCheckbox || hasNumberedOptions) {
      return true
    }
  }

  return false
}

/**
 * Check if output appears to be an active response (not waiting for input)
 * This helps avoid false positives when the AI is mid-response
 */
export function isActiveResponse(output: string): boolean {
  const cleanOutput = stripAnsiCodes(output)
  const lastLines = getLastMeaningfulLines(cleanOutput, 3)
  const lastLine = lastLines[lastLines.length - 1] || ''

  // If the line ends with common continuation characters, it's likely mid-response
  const continuationPatterns = [
    /\.\.\.$/,           // Ellipsis
    /```$/,              // Code block start/end
  ]

  return continuationPatterns.some(pattern => pattern.test(lastLine))
}

/**
 * More conservative check that requires multiple conditions
 */
export function shouldDefinitelyTriggerAttention(output: string, providerPatterns: readonly string[] = []): boolean {
  if (!shouldTriggerAttention(output, providerPatterns)) return false
  if (isActiveResponse(output)) return false
  return true
}
