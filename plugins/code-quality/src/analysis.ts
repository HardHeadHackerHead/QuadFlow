/**
 * Project scan for the Code Quality tile (ported from the shell's lib/codeAnalysis.ts).
 *
 * File access goes through a small {@link ScanFs} adapter over `ctx.fs` with the `project`
 * scope (paths relative to the project root, permission `fs:read:project`), so this module
 * stays pure and testable. `FileAnalysis.path` is still the absolute path for display.
 */
import {
  CodeLanguage,
  FileLineStats,
  FileAnalysis,
  LanguageMetrics,
  TestMetrics,
  ComplexityMetrics,
  QualityScore,
  QualityGrade,
  ScanProgress,
  CodeQualityMetrics,
} from './types'

/** The file access the scan needs (relative paths; `''` = the scan root). */
export interface ScanFs {
  list(path: string): Promise<{ name: string; kind: 'file' | 'dir'; size: number }[]>
  readText(path: string): Promise<string>
  stat(path: string): Promise<{ size: number } | null>
}

const joinRel = (dir: string, name: string) => (dir ? `${dir}/${name}` : name)

// ==================== Language Detection ====================

const EXTENSION_MAP: Record<string, CodeLanguage> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyw: 'python', pyi: 'python',
  rs: 'rust',
  go: 'go',
  java: 'java',
  c: 'c', h: 'c',
  cpp: 'cpp', cxx: 'cpp', cc: 'cpp', hpp: 'cpp', hxx: 'cpp', hh: 'cpp',
  cs: 'csharp',
  rb: 'ruby', rake: 'ruby',
  php: 'php',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala', sc: 'scala',
  dart: 'dart',
  lua: 'lua',
  r: 'r', R: 'r',
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell',
  html: 'html', htm: 'html',
  css: 'css',
  scss: 'scss', sass: 'scss',
  sql: 'sql',
  yaml: 'yaml', yml: 'yaml',
  json: 'json', jsonc: 'json',
  toml: 'toml',
  md: 'markdown', mdx: 'markdown',
  xml: 'xml', svg: 'xml', xhtml: 'xml',
}

const LANGUAGE_COLORS: Record<CodeLanguage, string> = {
  typescript: '#3178c6',
  javascript: '#f7df1e',
  python: '#3776ab',
  rust: '#dea584',
  go: '#00add8',
  java: '#b07219',
  c: '#555555',
  cpp: '#f34b7d',
  csharp: '#178600',
  ruby: '#701516',
  php: '#4f5d95',
  swift: '#f05138',
  kotlin: '#a97bff',
  scala: '#c22d40',
  dart: '#00b4ab',
  lua: '#000080',
  r: '#198ce7',
  shell: '#89e051',
  powershell: '#012456',
  html: '#e34c26',
  css: '#563d7c',
  scss: '#c6538c',
  sql: '#e38c00',
  yaml: '#cb171e',
  json: '#292929',
  toml: '#9c4221',
  markdown: '#083fa1',
  xml: '#0060ac',
  other: '#6b7280',
}

// ==================== Comment Syntax ====================

interface CommentSyntax {
  single: string[]
  blockStart?: string
  blockEnd?: string
  docString?: string // Triple-quote style (Python)
}

const COMMENT_SYNTAX: Partial<Record<CodeLanguage, CommentSyntax>> = {
  typescript: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  javascript: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  python: { single: ['#'], docString: '"""' },
  rust: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  go: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  java: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  c: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  cpp: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  csharp: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  ruby: { single: ['#'], blockStart: '=begin', blockEnd: '=end' },
  php: { single: ['//', '#'], blockStart: '/*', blockEnd: '*/' },
  swift: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  kotlin: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  scala: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  dart: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  lua: { single: ['--'], blockStart: '--[[', blockEnd: ']]' },
  r: { single: ['#'] },
  shell: { single: ['#'] },
  powershell: { single: ['#'], blockStart: '<#', blockEnd: '#>' },
  html: { single: [], blockStart: '<!--', blockEnd: '-->' },
  css: { single: [], blockStart: '/*', blockEnd: '*/' },
  scss: { single: ['//'], blockStart: '/*', blockEnd: '*/' },
  sql: { single: ['--'], blockStart: '/*', blockEnd: '*/' },
  yaml: { single: ['#'] },
  toml: { single: ['#'] },
  xml: { single: [], blockStart: '<!--', blockEnd: '-->' },
}

// ==================== Ignore Patterns ====================

// NOTE: Directories starting with '.' are ALREADY skipped by the walker,
// so dot-prefixed entries here are redundant but kept for documentation.
const IGNORE_DIRS = new Set([
  // Version control
  '.git', '.svn', '.hg',

  // JavaScript / TypeScript — package managers & frameworks
  'node_modules', 'bower_components', 'jspm_packages',
  '.next', '.nuxt', '.svelte-kit', '.angular',
  '.turbo', '.parcel-cache', 'storybook-static',

  // Python — virtual envs, caches, tooling
  '__pycache__', 'venv', '.venv', 'env',
  '.tox', '.nox', '.pytest_cache', '.hypothesis',
  '.mypy_cache', '.pytype', '.ruff_cache',
  '.coverage', 'htmlcov', '.eggs', 'site-packages',

  // Rust
  '.cargo',

  // Go
  // (vendor is shared below)

  // Java / Kotlin / Scala — Gradle & Maven
  '.gradle', '.mvn',

  // C# / .NET
  '.vs', 'TestResults', 'artifacts',

  // C / C++
  'CMakeFiles',

  // iOS / macOS
  'Pods', 'DerivedData',

  // Tauri — generated code, sidecar binaries, installer tools
  'gen', 'binaries', 'icons', 'WixTools',

  // Elixir
  '_build',

  // Haskell
  'dist-newstyle', '.stack-work',

  // General build output
  'dist', 'build', 'target', 'out', 'bin', 'obj',

  // Shared dependency folders
  'vendor',

  // Test & coverage output
  'coverage',

  // IDE & editor
  '.idea', '.vscode', '.vs',

  // Misc caches
  '.cache', '.sass-cache',
])

const MAX_FILE_SIZE = 512 * 1024 // 512KB

// ==================== Gitignore Support ====================

interface GitignoreRule {
  pattern: RegExp
  negated: boolean
  directoryOnly: boolean
  matchBasename: boolean // true = test against basename, false = test against relative path
}

/**
 * Convert a gitignore glob pattern to a RegExp.
 * Handles *, **, ?, and escapes regex special characters.
 */
function convertGlobToRegex(glob: string): RegExp {
  let regex = ''
  let i = 0

  while (i < glob.length) {
    const c = glob[i]

    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        // **/ matches zero or more directories
        regex += '(?:.*/)?'
        i += 3
      } else {
        // ** at end matches everything
        regex += '.*'
        i += 2
      }
    } else if (c === '*') {
      regex += '[^/]*'
      i += 1
    } else if (c === '?') {
      regex += '[^/]'
      i += 1
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      regex += '\\' + c
      i += 1
    } else {
      regex += c
      i += 1
    }
  }

  return new RegExp('^' + regex + '$')
}

function parseGitignoreContent(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []

  for (let line of content.split('\n')) {
    line = line.trimEnd()
    if (!line || line.startsWith('#')) continue

    let negated = false
    if (line.startsWith('!')) {
      negated = true
      line = line.substring(1)
    }

    line = line.trimStart()
    if (!line) continue

    let directoryOnly = false
    if (line.endsWith('/')) {
      directoryOnly = true
      line = line.slice(0, -1)
    }

    // Leading slash anchors to root — handled via matchBasename
    const anchored = line.startsWith('/')
    if (anchored) {
      line = line.substring(1)
    }

    // Pattern without slash matches against basename only;
    // pattern with slash (or anchored) matches against the relative path
    const matchBasename = !anchored && !line.includes('/')

    const pattern = convertGlobToRegex(line)
    rules.push({ pattern, negated, directoryOnly, matchBasename })
  }

  return rules
}

async function loadGitignoreRules(fs: ScanFs): Promise<GitignoreRule[]> {
  try {
    const content = await fs.readText('.gitignore')
    return parseGitignoreContent(content)
  } catch {
    return [] // No .gitignore or can't read it
  }
}

function isGitignored(
  relativePath: string,
  basename: string,
  isDirectory: boolean,
  rules: GitignoreRule[],
): boolean {
  let ignored = false
  const normalizedPath = relativePath.replace(/\\/g, '/')

  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue

    const testStr = rule.matchBasename ? basename : normalizedPath
    if (rule.pattern.test(testStr)) {
      ignored = !rule.negated
    }
  }

  return ignored
}

// ==================== Core Functions ====================

function detectLanguage(fileName: string): CodeLanguage {
  const ext = fileName.split('.').pop()?.toLowerCase()
  if (!ext) return 'other'
  return EXTENSION_MAP[ext] || 'other'
}

export function analyzeLines(content: string, language: CodeLanguage): FileLineStats {
  const lines = content.split('\n')
  const stats: FileLineStats = { code: 0, comment: 0, blank: 0, total: lines.length }
  const syntax = COMMENT_SYNTAX[language]

  if (!syntax) {
    // For languages without comment syntax (json, markdown, other), count code/blank
    for (const line of lines) {
      if (line.trim() === '') {
        stats.blank++
      } else {
        stats.code++
      }
    }
    return stats
  }

  let inBlock = false
  let inDocString = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === '') {
      stats.blank++
      continue
    }

    // Handle docstrings (Python)
    if (syntax.docString) {
      const docCount = (trimmed.match(new RegExp('"""', 'g')) || []).length
      if (inDocString) {
        stats.comment++
        if (trimmed.includes(syntax.docString)) {
          inDocString = false
        }
        continue
      }
      if (trimmed.startsWith(syntax.docString)) {
        stats.comment++
        // If triple-quote opens and closes on same line
        if (docCount >= 2) {
          continue
        }
        inDocString = true
        continue
      }
    }

    // Handle block comments
    if (inBlock) {
      stats.comment++
      if (syntax.blockEnd && trimmed.includes(syntax.blockEnd)) {
        inBlock = false
      }
      continue
    }

    if (syntax.blockStart && trimmed.startsWith(syntax.blockStart)) {
      stats.comment++
      if (syntax.blockEnd && !trimmed.includes(syntax.blockEnd)) {
        inBlock = true
      }
      continue
    }

    // Handle single-line comments
    if (syntax.single.some(prefix => trimmed.startsWith(prefix))) {
      stats.comment++
      continue
    }

    stats.code++
  }

  return stats
}

export function estimateComplexity(content: string, language: CodeLanguage): number {
  // Skip non-code languages
  const nonCodeLangs: CodeLanguage[] = ['html', 'css', 'scss', 'json', 'yaml', 'toml', 'markdown', 'xml', 'sql']
  if (nonCodeLangs.includes(language)) return 1

  let complexity = 1 // Base complexity

  // Language-specific keyword patterns
  const patterns: RegExp[] = [
    /\bif\b/g,
    /\belse\s+if\b/g,
    /\belif\b/g,
    /\bfor\b/g,
    /\bwhile\b/g,
    /\bswitch\b/g,
    /\bmatch\b/g,
    /\bcatch\b/g,
    /\bexcept\b/g,
    /\b\?\s*[^:]*:/g,  // Ternary
    /&&/g,
    /\|\|/g,
  ]

  for (const pattern of patterns) {
    const matches = content.match(pattern)
    if (matches) {
      complexity += matches.length
    }
  }

  return complexity
}

export function isTestFile(fileName: string, filePath: string): boolean {
  const lowerName = fileName.toLowerCase()
  const lowerPath = filePath.toLowerCase().replace(/\\/g, '/')

  // Name patterns
  if (/\.(test|spec|tests|specs)\.[^.]+$/.test(lowerName)) return true
  if (/^test_/.test(lowerName)) return true
  if (/_test\.[^.]+$/.test(lowerName)) return true
  if (/_spec\.[^.]+$/.test(lowerName)) return true

  // Directory patterns
  if (lowerPath.includes('/__tests__/')) return true
  if (lowerPath.includes('/tests/')) return true
  if (lowerPath.includes('/test/')) return true
  if (lowerPath.includes('/spec/')) return true
  if (lowerPath.includes('/__test__/')) return true

  return false
}

// ==================== Path Validation ====================

export interface PathValidationResult {
  safe: boolean
  warnings: string[]
}

// Common project root markers — if none exist, it's probably not a project directory
const PROJECT_MARKERS = [
  // Version control
  '.git', '.hg', '.svn',
  // JavaScript / TypeScript
  'package.json', 'deno.json', 'deno.jsonc',
  // Rust
  'Cargo.toml',
  // Python
  'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile',
  // Go
  'go.mod',
  // Java / Kotlin / Scala
  'pom.xml', 'build.gradle', 'build.gradle.kts',
  // C / C++
  'Makefile', 'CMakeLists.txt', 'meson.build',
  // Ruby
  'Gemfile',
  // PHP
  'composer.json',
  // Dart / Flutter
  'pubspec.yaml',
  // Elixir
  'mix.exs',
  // Haskell
  'stack.yaml', 'cabal.project',
  // .NET
  'global.json', 'Directory.Build.props',
  // Tauri
  'tauri.conf.json',
  // Containers
  'Dockerfile', 'docker-compose.yml', 'docker-compose.yaml',
]

export async function validateProjectPath(projectPath: string, fs: ScanFs): Promise<PathValidationResult> {
  const warnings: string[] = []
  const normalized = projectPath.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')

  // 1. Drive roots — scanning an entire drive
  if (/^[a-z]:?\/?$/.test(normalized) || normalized === '') {
    warnings.push('This is a drive root. Scanning here would include your entire drive.')
    return { safe: false, warnings }
  }

  // 2. User home directories
  const homePatterns = [
    /^[a-z]:\/users\/[^/]+$/,             // Windows: C:\Users\Name
    /^\/home\/[^/]+$/,                     // Linux: /home/name
    /^\/users\/[^/]+$/,                    // macOS: /Users/Name
    /^\/root$/,                            // Linux root home
  ]
  if (homePatterns.some(p => p.test(normalized))) {
    warnings.push('This appears to be a home directory. Scanning here would include all your personal files and folders.')
    return { safe: false, warnings }
  }

  // 3. System directories
  const systemPaths = [
    /^[a-z]:\/windows/,
    /^[a-z]:\/program files/,
    /^[a-z]:\/programdata/,
    /^\/usr$/,    /^\/etc$/,    /^\/var$/,
    /^\/system/,  /^\/library$/,
    /^\/opt$/,    /^\/bin$/,    /^\/sbin$/,
  ]
  if (systemPaths.some(p => p.test(normalized))) {
    warnings.push('This appears to be a system directory. Scanning here is not recommended.')
    return { safe: false, warnings }
  }

  // 4. Common broad personal folders (Desktop, Documents, Downloads, etc.)
  const segments = normalized.split('/').filter(Boolean)
  const lastSegment = segments[segments.length - 1]
  const broadFolders = [
    'desktop', 'documents', 'downloads', 'pictures', 'music', 'videos',
    'onedrive', 'dropbox', 'google drive', 'icloud drive',
  ]
  if (lastSegment && broadFolders.includes(lastSegment)) {
    warnings.push(`"${lastSegment}" is typically a personal folder containing many unrelated projects and files.`)
  }

  // 5. Check for project markers — if none found, warn
  if (warnings.length === 0) {
    let hasMarker = false
    for (const marker of PROJECT_MARKERS) {
      try {
        if (await fs.stat(marker)) {
          hasMarker = true
          break
        }
      } catch {
        // Marker doesn't exist
      }
    }

    if (!hasMarker) {
      warnings.push('No project files detected (package.json, Cargo.toml, go.mod, etc.). This may not be a project root directory.')
    }
  }

  return { safe: warnings.length === 0, warnings }
}

// ==================== Directory Walk ====================

async function walkDirectory(
  fs: ScanFs,
  onProgress?: (progress: ScanProgress) => void,
): Promise<{ rel: string; size: number }[]> {
  const filePaths: { rel: string; size: number }[] = []
  let filesFound = 0

  // Load .gitignore rules from project root
  const gitignoreRules = await loadGitignoreRules(fs)

  async function walk(dirPath: string): Promise<void> {
    try {
      const entries = await fs.list(dirPath)

      for (const entry of entries) {
        const relativePath = joinRel(dirPath, entry.name)

        if (entry.kind === 'dir') {
          // Skip hardcoded ignore dirs and hidden directories
          if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) {
            continue
          }

          // Skip directories matched by .gitignore
          if (gitignoreRules.length > 0 && isGitignored(relativePath, entry.name, true, gitignoreRules)) {
            continue
          }

          await walk(relativePath)
        } else {
          const lang = detectLanguage(entry.name)
          if (lang === 'other') continue

          // Skip files matched by .gitignore
          if (gitignoreRules.length > 0 && isGitignored(relativePath, entry.name, false, gitignoreRules)) {
            continue
          }

          filePaths.push({ rel: relativePath, size: entry.size })
          filesFound++

          if (onProgress && filesFound % 50 === 0) {
            onProgress({
              phase: 'scanning',
              filesFound,
              filesAnalyzed: 0,
              currentFile: entry.name,
            })
            // Yield to UI thread
            await new Promise(resolve => setTimeout(resolve, 0))
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  await walk('')
  return filePaths
}

// ==================== Main Orchestrator ====================

export async function scanProject(
  projectPath: string,
  fs: ScanFs,
  onProgress?: (progress: ScanProgress) => void,
): Promise<CodeQualityMetrics> {
  const sep = projectPath.includes('\\') ? '\\' : '/'
  const absolute = (rel: string) => `${projectPath.replace(/[/\\]+$/, '')}${sep}${rel.split('/').join(sep)}`
  const startTime = Date.now()

  // Phase 1: Scan directory
  onProgress?.({ phase: 'scanning', filesFound: 0, filesAnalyzed: 0 })
  const filePaths = await walkDirectory(fs, onProgress)

  // Phase 2: Analyze files
  onProgress?.({ phase: 'analyzing', filesFound: filePaths.length, filesAnalyzed: 0 })
  const files: FileAnalysis[] = []
  let analyzed = 0

  for (const { rel, size: sizeBytes } of filePaths) {
    try {
      const filePath = absolute(rel)

      // Skip files that are too large
      if (sizeBytes > MAX_FILE_SIZE) continue

      const fileName = filePath.split(/[/\\]/).pop() || ''
      const language = detectLanguage(fileName)
      const content = await fs.readText(rel)

      // Skip files with very long lines (likely minified)
      const firstLines = content.substring(0, 5000)
      if (firstLines.includes('\n')) {
        const avgLineLength = firstLines.length / firstLines.split('\n').length
        if (avgLineLength > 500) continue
      } else if (content.length > 1000) {
        continue // Single very long line = minified
      }

      const lines = analyzeLines(content, language)
      const complexity = estimateComplexity(content, language)
      const test = isTestFile(fileName, filePath)

      files.push({ path: filePath, fileName, language, lines, complexity, isTest: test, sizeBytes })

      analyzed++
      if (onProgress && analyzed % 25 === 0) {
        onProgress({
          phase: 'analyzing',
          filesFound: filePaths.length,
          filesAnalyzed: analyzed,
          currentFile: fileName,
        })
        await new Promise(resolve => setTimeout(resolve, 0))
      }
    } catch {
      // Skip files we can't read
    }
  }

  // Phase 3: Compute metrics
  onProgress?.({ phase: 'computing', filesFound: filePaths.length, filesAnalyzed: analyzed })

  const totalLines = files.reduce<FileLineStats>(
    (acc, f) => ({
      code: acc.code + f.lines.code,
      comment: acc.comment + f.lines.comment,
      blank: acc.blank + f.lines.blank,
      total: acc.total + f.lines.total,
    }),
    { code: 0, comment: 0, blank: 0, total: 0 }
  )

  // Language metrics
  const langMap = new Map<CodeLanguage, FileAnalysis[]>()
  for (const file of files) {
    const arr = langMap.get(file.language) || []
    arr.push(file)
    langMap.set(file.language, arr)
  }

  const languages: LanguageMetrics[] = Array.from(langMap.entries())
    .map(([language, langFiles]) => {
      const lines = langFiles.reduce<FileLineStats>(
        (acc, f) => ({
          code: acc.code + f.lines.code,
          comment: acc.comment + f.lines.comment,
          blank: acc.blank + f.lines.blank,
          total: acc.total + f.lines.total,
        }),
        { code: 0, comment: 0, blank: 0, total: 0 }
      )
      const avgComplexity = langFiles.reduce((s, f) => s + f.complexity, 0) / langFiles.length
      const testFileCount = langFiles.filter(f => f.isTest).length

      return {
        language,
        fileCount: langFiles.length,
        lines,
        avgComplexity: Math.round(avgComplexity * 10) / 10,
        testFileCount,
        color: LANGUAGE_COLORS[language],
      }
    })
    .sort((a, b) => b.lines.code - a.lines.code)

  // Test metrics
  const testFiles = files.filter(f => f.isTest)
  const sourceFiles = files.filter(f => !f.isTest)
  const languageBreakdown: Record<string, { testFiles: number; sourceFiles: number }> = {}
  for (const lang of languages) {
    const langTestCount = lang.testFileCount
    const langSourceCount = lang.fileCount - langTestCount
    if (langSourceCount > 0 || langTestCount > 0) {
      languageBreakdown[lang.language] = { testFiles: langTestCount, sourceFiles: langSourceCount }
    }
  }

  const testMetrics: TestMetrics = {
    testFiles: testFiles.length,
    sourceFiles: sourceFiles.length,
    testToSourceRatio: sourceFiles.length > 0 ? testFiles.length / sourceFiles.length : 0,
    languageBreakdown,
  }

  // Complexity metrics
  const complexities = files.filter(f =>
    !['html', 'css', 'scss', 'json', 'yaml', 'toml', 'markdown', 'xml', 'sql'].includes(f.language)
  )
  const avgComplexity = complexities.length > 0
    ? complexities.reduce((s, f) => s + f.complexity, 0) / complexities.length
    : 0

  const complexityMetrics: ComplexityMetrics = {
    average: Math.round(avgComplexity * 10) / 10,
    distribution: {
      low: complexities.filter(f => f.complexity <= 5).length,
      moderate: complexities.filter(f => f.complexity > 5 && f.complexity <= 10).length,
      high: complexities.filter(f => f.complexity > 10 && f.complexity <= 20).length,
      veryHigh: complexities.filter(f => f.complexity > 20).length,
    },
    topFiles: [...complexities].sort((a, b) => b.complexity - a.complexity).slice(0, 20),
  }

  // Quality score
  const qualityScore = computeQualityScore(files, languages, testMetrics, complexityMetrics)

  const scanDuration = Date.now() - startTime
  onProgress?.({ phase: 'done', filesFound: filePaths.length, filesAnalyzed: analyzed })

  return {
    totalFiles: files.length,
    totalLines,
    languages,
    testMetrics,
    complexityMetrics,
    qualityScore,
    files,
    scanDuration,
    projectPath,
  }
}

// ==================== Quality Score ====================

function computeQualityScore(
  files: FileAnalysis[],
  _languages: LanguageMetrics[],
  testMetrics: TestMetrics,
  complexityMetrics: ComplexityMetrics,
): QualityScore {
  const totalCode = files.reduce((s, f) => s + f.lines.code, 0)
  const totalComments = files.reduce((s, f) => s + f.lines.comment, 0)

  // Comment ratio score (20%) — target: 10-25% comments
  const commentRatio = totalCode > 0 ? totalComments / totalCode : 0
  let commentScore: number
  if (commentRatio >= 0.10 && commentRatio <= 0.25) {
    commentScore = 100
  } else if (commentRatio < 0.10) {
    commentScore = Math.round((commentRatio / 0.10) * 100)
  } else {
    commentScore = Math.max(50, Math.round(100 - ((commentRatio - 0.25) / 0.25) * 50))
  }

  // Test coverage score (30%) — ratio of test files to source files
  const testRatio = testMetrics.testToSourceRatio
  let testScore: number
  if (testRatio >= 0.5) {
    testScore = 100
  } else if (testRatio >= 0.3) {
    testScore = 80 + Math.round(((testRatio - 0.3) / 0.2) * 20)
  } else if (testRatio >= 0.1) {
    testScore = 40 + Math.round(((testRatio - 0.1) / 0.2) * 40)
  } else {
    testScore = Math.round((testRatio / 0.1) * 40)
  }

  // Complexity score (30%) — lower is better
  const avgComplexity = complexityMetrics.average
  let complexityScore: number
  if (avgComplexity <= 5) {
    complexityScore = 100
  } else if (avgComplexity <= 10) {
    complexityScore = 100 - Math.round(((avgComplexity - 5) / 5) * 30)
  } else if (avgComplexity <= 20) {
    complexityScore = 70 - Math.round(((avgComplexity - 10) / 10) * 40)
  } else {
    complexityScore = Math.max(10, 30 - Math.round(((avgComplexity - 20) / 20) * 20))
  }

  // Organization score (20%) — file structure quality
  const totalFiles = files.length
  const veryHighRatio = totalFiles > 0 ? complexityMetrics.distribution.veryHigh / totalFiles : 0
  const hasTests = testMetrics.testFiles > 0
  const hasMixedLanguages = _languages.length > 1

  let orgScore = 50 // Base
  if (hasTests) orgScore += 20
  if (veryHighRatio < 0.05) orgScore += 15
  if (hasMixedLanguages) orgScore += 5
  if (totalFiles > 5) orgScore += 10
  orgScore = Math.min(100, orgScore)

  // Weighted total
  const overall = Math.round(
    commentScore * 0.20 +
    testScore * 0.30 +
    complexityScore * 0.30 +
    orgScore * 0.20
  )

  // Grade
  let grade: QualityGrade
  if (overall >= 85) grade = 'A'
  else if (overall >= 70) grade = 'B'
  else if (overall >= 55) grade = 'C'
  else if (overall >= 40) grade = 'D'
  else grade = 'F'

  return {
    overall,
    grade,
    breakdown: {
      commentRatio: { score: commentScore, weight: 0.20, value: Math.round(commentRatio * 100) },
      testCoverage: { score: testScore, weight: 0.30, value: Math.round(testRatio * 100) },
      complexity: { score: complexityScore, weight: 0.30, value: Math.round(avgComplexity * 10) / 10 },
      organization: { score: orgScore, weight: 0.20, value: orgScore },
    },
  }
}
