import type { LanguageSupport } from '@codemirror/language'

type LanguageLoader = () => Promise<LanguageSupport>

const EXTENSION_MAP: Record<string, LanguageLoader> = {
  // JavaScript / TypeScript
  '.js': () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  '.jsx': () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true })),
  '.ts': () => import('@codemirror/lang-javascript').then(m => m.javascript({ typescript: true })),
  '.tsx': () => import('@codemirror/lang-javascript').then(m => m.javascript({ jsx: true, typescript: true })),
  '.mjs': () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  '.cjs': () => import('@codemirror/lang-javascript').then(m => m.javascript()),
  // Python
  '.py': () => import('@codemirror/lang-python').then(m => m.python()),
  '.pyw': () => import('@codemirror/lang-python').then(m => m.python()),
  // Rust
  '.rs': () => import('@codemirror/lang-rust').then(m => m.rust()),
  // CSS / SCSS
  '.css': () => import('@codemirror/lang-css').then(m => m.css()),
  '.scss': () => import('@codemirror/lang-css').then(m => m.css()),
  '.less': () => import('@codemirror/lang-css').then(m => m.css()),
  // HTML
  '.html': () => import('@codemirror/lang-html').then(m => m.html()),
  '.htm': () => import('@codemirror/lang-html').then(m => m.html()),
  '.svelte': () => import('@codemirror/lang-html').then(m => m.html()),
  '.vue': () => import('@codemirror/lang-html').then(m => m.html()),
  // JSON
  '.json': () => import('@codemirror/lang-json').then(m => m.json()),
  '.jsonl': () => import('@codemirror/lang-json').then(m => m.json()),
  // Markdown
  '.md': () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  '.markdown': () => import('@codemirror/lang-markdown').then(m => m.markdown()),
  // XML / YAML
  '.xml': () => import('@codemirror/lang-xml').then(m => m.xml()),
  '.yaml': () => import('@codemirror/lang-xml').then(m => m.xml()),
  '.yml': () => import('@codemirror/lang-xml').then(m => m.xml()),
  '.toml': () => import('@codemirror/lang-xml').then(m => m.xml()),
  // SQL
  '.sql': () => import('@codemirror/lang-sql').then(m => m.sql()),
  // C / C++
  '.c': () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  '.cpp': () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  '.cc': () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  '.h': () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  '.hpp': () => import('@codemirror/lang-cpp').then(m => m.cpp()),
  // Java
  '.java': () => import('@codemirror/lang-java').then(m => m.java()),
  '.kt': () => import('@codemirror/lang-java').then(m => m.java()),
  // PHP
  '.php': () => import('@codemirror/lang-php').then(m => m.php()),
}

const LANGUAGE_NAMES: Record<string, string> = {
  '.js': 'JavaScript', '.jsx': 'JSX', '.ts': 'TypeScript', '.tsx': 'TSX',
  '.mjs': 'JavaScript', '.cjs': 'JavaScript',
  '.py': 'Python', '.pyw': 'Python',
  '.rs': 'Rust',
  '.css': 'CSS', '.scss': 'SCSS', '.less': 'Less',
  '.html': 'HTML', '.htm': 'HTML', '.svelte': 'Svelte', '.vue': 'Vue',
  '.json': 'JSON', '.jsonl': 'JSON Lines',
  '.md': 'Markdown', '.markdown': 'Markdown',
  '.xml': 'XML', '.yaml': 'YAML', '.yml': 'YAML', '.toml': 'TOML',
  '.sql': 'SQL',
  '.c': 'C', '.cpp': 'C++', '.cc': 'C++', '.h': 'C/C++ Header', '.hpp': 'C++ Header',
  '.java': 'Java', '.kt': 'Kotlin',
  '.php': 'PHP',
}

export async function loadLanguage(extension: string): Promise<LanguageSupport | null> {
  const loader = EXTENSION_MAP[extension.toLowerCase()]
  if (!loader) return null
  try {
    return await loader()
  } catch {
    return null
  }
}

export function getLanguageName(extension: string): string {
  return LANGUAGE_NAMES[extension.toLowerCase()] || extension.replace('.', '').toUpperCase() || 'Plain Text'
}
