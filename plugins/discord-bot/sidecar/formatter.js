/**
 * formatter.js - Strip ANSI codes and format terminal output for Discord
 */

// Dynamic import for strip-ansi (ESM module)
let stripAnsi = null;

async function loadStripAnsi() {
  if (!stripAnsi) {
    const mod = await import('strip-ansi');
    stripAnsi = mod.default;
  }
  return stripAnsi;
}

/**
 * Redact PII from text before sending to Discord.
 * @param {string} text - Cleaned text (ANSI already stripped)
 * @returns {string} Text with PII redacted
 */
function redactPII(text) {
  let result = text;

  // 1. Emails
  result = result.replace(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g, '***@***.***');

  // 2. Windows paths (C:\Users\username)
  result = result.replace(/C:\\Users\\[^\\]+/gi, 'C:\\Users\\***');

  // 3. Unix paths (/home/user or /Users/user)
  result = result.replace(/(\/home\/|\/Users\/)[^\/\s]+/g, '$1***');

  // 4. JWT tokens
  result = result.replace(/eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}/g, '[REDACTED]');

  // 5. Long hex/API keys (40+ contiguous alphanumeric chars)
  result = result.replace(/\b[A-Za-z0-9]{40,}\b/g, '[REDACTED]');

  // 6. Env var secrets (TOKEN=, API_KEY=, SECRET=, PASSWORD=, etc.)
  result = result.replace(/(?<=(?:TOKEN|API_KEY|SECRET|PASSWORD|PRIVATE_KEY|ACCESS_KEY|CLIENT_SECRET)=).+/gi, '[REDACTED]');

  return result;
}

/**
 * Fit terminal output for Discord's narrower display (~55 char code blocks).
 * Truncates separator/decoration lines, collapses excessive blank lines,
 * and cleans up wide formatting that wraps badly.
 * @param {string} text - Cleaned text
 * @returns {string} Text fitted for Discord width
 */
const DISCORD_WIDTH = 50;
const SEPARATOR_CHARS = /^[\s\-=_~*+#.─═━┄┈╌╍┅┉╼╾╶╴─│┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬║░▒▓█▄▀]+$/;

function fitForDiscord(text) {
  const lines = text.split('\n');
  const result = [];
  let blankCount = 0;

  for (const line of lines) {
    // Collapse consecutive blank lines to max 1
    if (!line.trim()) {
      blankCount++;
      if (blankCount <= 1) result.push('');
      continue;
    }
    blankCount = 0;

    // Truncate lines that are purely separator/decoration characters
    if (line.length > DISCORD_WIDTH && SEPARATOR_CHARS.test(line)) {
      result.push(line.substring(0, DISCORD_WIDTH));
      continue;
    }

    // Truncate lines that are mostly a single repeated character (e.g., "--- title ---")
    if (line.length > DISCORD_WIDTH) {
      const stripped = line.trim();
      // Count the most frequent character
      const charCounts = {};
      for (const ch of stripped) {
        if (ch !== ' ') charCounts[ch] = (charCounts[ch] || 0) + 1;
      }
      const maxCount = Math.max(...Object.values(charCounts));
      const nonSpaceLen = stripped.replace(/\s/g, '').length;
      // If one character makes up >60% of the non-space content, it's decorative
      if (nonSpaceLen > 0 && maxCount / nonSpaceLen > 0.6) {
        result.push(line.substring(0, DISCORD_WIDTH));
        continue;
      }
    }

    result.push(line);
  }

  return result.join('\n');
}

/**
 * Detect if text contains a prompt that can be answered via reactions.
 * @param {string} text - Cleaned text to analyze
 * @returns {null|{type: string, question: string, options: Array<{label: string, value: string, emoji: string}>}}
 */
function detectPrompt(text) {
  const lines = text.trim().split('\n');
  const lastLines = lines.slice(-10).join('\n');

  // Y/N detection: (Y/n), (y/N), [Y/n], [y/N]
  const ynMatch = lastLines.match(/[(\[][Yy]\/[Nn][)\]]|[(\[][Yy]\/[Nn][)\]]/);
  if (ynMatch) {
    // Extract the question (the line containing the Y/N prompt)
    const ynLine = lines.filter(l => /[(\[][Yy]\/[Nn][)\]]/.test(l)).pop() || lastLines;
    return {
      type: 'yn',
      question: ynLine.trim(),
      options: [
        { label: 'Yes', value: 'Y', emoji: '\u2705' },
        { label: 'No', value: 'N', emoji: '\u274C' },
      ],
    };
  }

  // Numbered list detection: lines starting with 1., 2., 3. etc.
  const numberEmojis = ['1\uFE0F\u20E3', '2\uFE0F\u20E3', '3\uFE0F\u20E3', '4\uFE0F\u20E3', '5\uFE0F\u20E3', '6\uFE0F\u20E3', '7\uFE0F\u20E3', '8\uFE0F\u20E3', '9\uFE0F\u20E3'];
  const numberedLines = lines.filter(l => /^\s*\d+\.\s+/.test(l));
  if (numberedLines.length >= 2) {
    const options = numberedLines.slice(0, 9).map((line, i) => {
      const label = line.replace(/^\s*\d+\.\s+/, '').trim();
      return { label, value: `${i + 1}`, emoji: numberEmojis[i] };
    });
    // Question is the line before the first numbered item
    const firstIdx = lines.findIndex(l => /^\s*\d+\.\s+/.test(l));
    const question = firstIdx > 0 ? lines[firstIdx - 1].trim() : 'Select an option:';
    return { type: 'numbered', question, options };
  }

  // Lettered list detection: lines starting with a), b), c) etc.
  const letterEmojis = [
    '\uD83C\uDDE6', '\uD83C\uDDE7', '\uD83C\uDDE8', '\uD83C\uDDE9', '\uD83C\uDDEA',
    '\uD83C\uDDEB', '\uD83C\uDDEC', '\uD83C\uDDED', '\uD83C\uDDEE',
  ];
  const letteredLines = lines.filter(l => /^\s*[a-i]\)\s+/i.test(l));
  if (letteredLines.length >= 2) {
    const options = letteredLines.slice(0, 9).map((line, i) => {
      const label = line.replace(/^\s*[a-i]\)\s+/i, '').trim();
      const letter = String.fromCharCode(97 + i); // a, b, c...
      return { label, value: `${letter}`, emoji: letterEmojis[i] };
    });
    const firstIdx = lines.findIndex(l => /^\s*[a-i]\)\s+/i.test(l));
    const question = firstIdx > 0 ? lines[firstIdx - 1].trim() : 'Select an option:';
    return { type: 'lettered', question, options };
  }

  return null;
}

/**
 * Strip ANSI codes and split into Discord-safe chunks wrapped in code blocks.
 * Each chunk is ≤1900 chars to stay under the 2000 char Discord limit.
 * @param {string} rawText - Raw terminal output with ANSI codes
 * @returns {Promise<{chunks: string[], cleanedText: string}>} Formatted chunks and cleaned text
 */
async function stripAndFormat(rawText) {
  const strip = await loadStripAnsi();
  const cleaned = strip(rawText);

  // Skip empty output
  if (!cleaned.trim()) return { chunks: [], cleanedText: '' };

  const redacted = redactPII(cleaned);
  const fitted = fitForDiscord(redacted);

  // Use ansi hint for better Discord rendering of terminal output
  const codePrefix = '```ansi\n';
  const codeSuffix = '\n```';
  const wrapLen = codePrefix.length + codeSuffix.length;
  const MAX_CONTENT_LEN = 1900 - wrapLen;
  const lines = fitted.split('\n');
  const chunks = [];
  let current = '';

  for (const line of lines) {
    const candidate = current ? current + '\n' + line : line;
    if (candidate.length > MAX_CONTENT_LEN) {
      if (current) {
        chunks.push(codePrefix + current + codeSuffix);
        current = line.length > MAX_CONTENT_LEN ? line.substring(0, MAX_CONTENT_LEN) : line;
      } else {
        // Single line exceeds limit, truncate it
        chunks.push(codePrefix + line.substring(0, MAX_CONTENT_LEN) + codeSuffix);
        current = '';
      }
    } else {
      current = candidate;
    }
  }

  if (current) {
    chunks.push(codePrefix + current + codeSuffix);
  }

  return { chunks, cleanedText: fitted };
}

export { stripAndFormat, redactPII, detectPrompt, fitForDiscord };
