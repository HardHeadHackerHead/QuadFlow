/**
 * Streamer Mode - Secret Redaction for Terminal Output
 *
 * Redacts API keys, database connection strings, passwords, tokens,
 * and other sensitive data from terminal output before rendering.
 *
 * Designed to be safe with ANSI escape sequences - strips them before
 * pattern matching, then reapplies them to the redacted output.
 */

const REDACTED_PLAIN = '[REDACTED]'

// ─── Prefixed API Keys & Tokens (high confidence) ───────────────────────

const PREFIXED_KEY_PATTERNS: RegExp[] = [
  // Anthropic
  /sk-ant-[a-zA-Z0-9_-]{20,}/g,
  // OpenAI
  /sk-proj-[a-zA-Z0-9_-]{20,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  // AWS Access Key ID
  /AKIA[A-Z0-9]{16}/g,
  // GitHub tokens
  /ghp_[a-zA-Z0-9]{36,}/g,
  /gho_[a-zA-Z0-9]{36,}/g,
  /ghu_[a-zA-Z0-9]{36,}/g,
  /ghs_[a-zA-Z0-9]{36,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  // Slack
  /xox[bpras]-[a-zA-Z0-9-]{10,}/g,
  // Google API
  /AIza[a-zA-Z0-9_-]{35}/g,
  // GitLab
  /glpat-[a-zA-Z0-9_-]{20,}/g,
  // npm
  /npm_[a-zA-Z0-9]{36,}/g,
  // PyPI
  /pypi-[a-zA-Z0-9]{50,}/g,
  // Stripe
  /sk_live_[a-zA-Z0-9]{20,}/g,
  /pk_live_[a-zA-Z0-9]{20,}/g,
  /rk_live_[a-zA-Z0-9]{20,}/g,
  // Twilio
  /SK[a-f0-9]{32}/g,
  // SendGrid
  /SG\.[a-zA-Z0-9_-]{22,}\.[a-zA-Z0-9_-]{10,}/g,
  // Mailgun
  /key-[a-f0-9]{32}/g,
  // Heroku
  /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/g,
  // Supabase
  /sbp_[a-f0-9]{40,}/g,
  // Vercel
  /vercel_[a-zA-Z0-9_-]{20,}/g,
]

// ─── Database Connection Strings ────────────────────────────────────────

const DB_CONNECTION_PATTERNS: RegExp[] = [
  // URLs with credentials: protocol://user:password@host
  // Covers PostgreSQL, MySQL, MongoDB, Redis, AMQP, etc.
  /((?:postgresql|postgres|mysql|mongodb|mongodb\+srv|redis|rediss|amqp|amqps|mssql):\/\/[^:]*:)([^@\s]{1,}?)(@)/gi,
  // ODBC/ADO/SQL Server connection string passwords
  /((?:Password|Pwd|password|pwd)\s*=\s*)([^;\s'"]{1,})/gi,
  // Azure storage connection strings (AccountKey)
  /(AccountKey\s*=\s*)([^;\s'"]{1,})/gi,
  // AWS secret access key in config
  /(aws_secret_access_key\s*[=:]\s*)([^\s'"]{1,})/gi,
  // Azure/AWS connection strings with SharedAccessKey
  /(SharedAccessKey\s*=\s*)([^;\s'"]{1,})/gi,
]

// ─── Auth Patterns ──────────────────────────────────────────────────────

const AUTH_PATTERNS: RegExp[] = [
  // Bearer tokens
  /(Bearer\s+)([a-zA-Z0-9._\-]{20,})/g,
  // Basic auth
  /(Basic\s+)([A-Za-z0-9+/=]{10,})/g,
  // JWT tokens (three base64 parts separated by dots)
  /eyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
]

// ─── Key=Value Patterns (env vars, config output) ───────────────────────

// Labels that indicate secrets - matched case-insensitively
const SECRET_LABELS = [
  'password', 'passwd', 'pwd', 'pass',
  'secret', 'secret_key', 'secret_token', 'client_secret',
  'api_key', 'apikey', 'api-key', 'api_secret',
  'access_token', 'auth_token', 'refresh_token',
  'token', 'access_key', 'secret_access_key',
  'credential', 'credentials',
  'private_key', 'encryption_key', 'signing_key', 'master_key',
  'connection_string', 'conn_str', 'database_url', 'db_url', 'db_password',
  'smtp_password', 'mail_password', 'email_password',
  'webhook_secret', 'webhook_url',
  'auth', 'authorization',
].join('|')

// Match: LABEL = value or LABEL: value (with optional quotes)
const KEY_VALUE_PATTERN = new RegExp(
  `((?:${SECRET_LABELS})[\\s]*[=:][\\s]*['"]?)([^\\s'";]{8,})`,
  'gi'
)

// ─── Private Key Blocks ─────────────────────────────────────────────────

const PRIVATE_KEY_PATTERN = /(-----BEGIN\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----)([\s\S]*?)(-----END\s+(?:RSA\s+|EC\s+|DSA\s+|OPENSSH\s+|ENCRYPTED\s+)?PRIVATE\s+KEY-----)/g

// ─── Generic High-Entropy ───────────────────────────────────────────────

// Long hex strings (40+ chars, standalone)
const LONG_HEX_PATTERN = /\b[0-9a-f]{40,}\b/g

// ─── ANSI Escape Sequence Handling ──────────────────────────────────────

// Match ANSI escape sequences (CSI sequences, OSC sequences, etc.)
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;]*[a-zA-Z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[0-9;]*[mGHJKsu]|[()][AB012]|\x1b|[78DEHM]|\[[\?]?[0-9;]*[hlr])/g

interface TextSegment {
  type: 'text' | 'ansi'
  value: string
}

/**
 * Split terminal data into text segments and ANSI escape sequences.
 * This ensures we only apply regex redaction to visible text content,
 * never corrupting escape sequences.
 */
function splitAnsi(data: string): TextSegment[] {
  const segments: TextSegment[] = []
  let lastIndex = 0

  // Reset lastIndex to be safe
  ANSI_ESCAPE_RE.lastIndex = 0

  let match: RegExpExecArray | null
  while ((match = ANSI_ESCAPE_RE.exec(data)) !== null) {
    // Text before this escape sequence
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: data.slice(lastIndex, match.index) })
    }
    // The escape sequence itself
    segments.push({ type: 'ansi', value: match[0] })
    lastIndex = match.index + match[0].length
  }

  // Remaining text after last escape sequence
  if (lastIndex < data.length) {
    segments.push({ type: 'text', value: data.slice(lastIndex) })
  }

  return segments
}

/**
 * Apply redaction patterns to a plain text string (no ANSI escapes).
 */
function redactPlainText(text: string): string {
  let result = text

  // 1. Private key blocks (must go first - multiline)
  result = result.replace(PRIVATE_KEY_PATTERN, `$1\n${REDACTED_PLAIN}\n$3`)

  // 2. Prefixed API keys (highest confidence, no capturing groups needed)
  for (const pattern of PREFIXED_KEY_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, REDACTED_PLAIN)
  }

  // 3. Database connection strings (redact password portion only)
  for (const pattern of DB_CONNECTION_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, `$1${REDACTED_PLAIN}$3`)
  }

  // 4. Auth patterns
  for (const pattern of AUTH_PATTERNS) {
    pattern.lastIndex = 0
    // JWT tokens have no capturing groups - replace whole match
    if (pattern.source.startsWith('eyJ')) {
      result = result.replace(pattern, REDACTED_PLAIN)
    } else {
      // Bearer/Basic - preserve the prefix, redact the token
      result = result.replace(pattern, `$1${REDACTED_PLAIN}`)
    }
  }

  // 5. Key=Value patterns (preserve label, redact value)
  KEY_VALUE_PATTERN.lastIndex = 0
  result = result.replace(KEY_VALUE_PATTERN, `$1${REDACTED_PLAIN}`)

  // 6. Long hex strings (lower confidence, apply last)
  LONG_HEX_PATTERN.lastIndex = 0
  result = result.replace(LONG_HEX_PATTERN, REDACTED_PLAIN)

  return result
}

/**
 * Redact secrets from terminal output data.
 *
 * Safely handles ANSI escape sequences by:
 * 1. Splitting data into text segments and escape sequences
 * 2. Applying redaction only to text segments
 * 3. Reassembling the output with escape sequences intact
 *
 * @param data Raw terminal output (may contain ANSI escape sequences)
 * @returns Data with secrets replaced by [REDACTED]
 */
export function redactSecrets(data: string): string {
  // Fast path: if no text content, return as-is
  if (!data || data.length === 0) return data

  const segments = splitAnsi(data)

  // If there are no ANSI sequences, just process the whole string
  if (segments.length === 1 && segments[0].type === 'text') {
    return redactPlainText(data)
  }

  // Process each segment: redact text, pass through ANSI
  return segments
    .map(segment => {
      if (segment.type === 'ansi') return segment.value
      return redactPlainText(segment.value)
    })
    .join('')
}
