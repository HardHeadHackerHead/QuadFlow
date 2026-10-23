export type CodeLanguage =
  | 'typescript' | 'javascript' | 'python' | 'rust' | 'go' | 'java'
  | 'c' | 'cpp' | 'csharp' | 'ruby' | 'php' | 'swift' | 'kotlin'
  | 'scala' | 'dart' | 'lua' | 'r' | 'shell' | 'powershell'
  | 'html' | 'css' | 'scss' | 'sql' | 'yaml' | 'json' | 'toml'
  | 'markdown' | 'xml' | 'other'

export interface FileLineStats {
  code: number
  comment: number
  blank: number
  total: number
}

export interface FileAnalysis {
  path: string
  fileName: string
  language: CodeLanguage
  lines: FileLineStats
  complexity: number
  isTest: boolean
  sizeBytes: number
}

export interface LanguageMetrics {
  language: CodeLanguage
  fileCount: number
  lines: FileLineStats
  avgComplexity: number
  testFileCount: number
  color: string
}

export interface TestMetrics {
  testFiles: number
  sourceFiles: number
  testToSourceRatio: number
  languageBreakdown: Record<string, { testFiles: number; sourceFiles: number }>
}

export interface ComplexityMetrics {
  average: number
  distribution: {
    low: number      // 1-5
    moderate: number  // 6-10
    high: number      // 11-20
    veryHigh: number  // 21+
  }
  topFiles: FileAnalysis[]
}

export type QualityGrade = 'A' | 'B' | 'C' | 'D' | 'F'

export interface QualityScore {
  overall: number  // 0-100
  grade: QualityGrade
  breakdown: {
    commentRatio: { score: number; weight: number; value: number }
    testCoverage: { score: number; weight: number; value: number }
    complexity: { score: number; weight: number; value: number }
    organization: { score: number; weight: number; value: number }
  }
}

export interface ScanProgress {
  phase: 'idle' | 'scanning' | 'analyzing' | 'computing' | 'done'
  filesFound: number
  filesAnalyzed: number
  currentFile?: string
}

export interface CodeQualityMetrics {
  totalFiles: number
  totalLines: FileLineStats
  languages: LanguageMetrics[]
  testMetrics: TestMetrics
  complexityMetrics: ComplexityMetrics
  qualityScore: QualityScore
  files: FileAnalysis[]
  scanDuration: number
  projectPath: string
  llmInsight?: string
}

