// Checkpoint types (moved from the shell's src/types/index.ts).

export interface Checkpoint {
  id: string
  name: string
  description: string | null
  commitSha: string
  branch: string
  tagName: string              // e.g. "qf-cp/before-refactor"
  filesChanged: number
  hadUncommittedChanges: boolean
  projectPath: string
  createdAt: number
}

export interface CheckpointDiffSummary {
  filesChanged: number
  additions: number
  deletions: number
  files: { path: string; status: string; additions: number; deletions: number }[]
}
