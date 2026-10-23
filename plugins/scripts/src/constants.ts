/** Static tables of the Scripts tool (templates, agent skills, limits). */
import type { ScriptInput_Deserialize, TargetPlatform } from '@quadflow/plugin-api'

export interface ScriptTemplate {
  name: string
  description: string
  platform: TargetPlatform | 'all'
  template: ScriptInput_Deserialize
}

const CUDA_ENV = {
  CUDA_PATH: 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.6',
  CUDA_HOME: 'C:\\Program Files\\NVIDIA GPU Computing Toolkit\\CUDA\\v12.6',
}
const VCVARS = 'call "C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\VC\\Auxiliary\\Build\\vcvarsall.bat" x64'

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [
  {
    name: 'Tauri Dev (CUDA)',
    description: 'Build Tauri app with CUDA GPU support (Windows)',
    platform: 'windows',
    template: {
      name: 'Tauri Dev (CUDA)',
      description: 'Build Tauri app with CUDA GPU acceleration enabled',
      command: 'npm run tauri dev',
      env: CUDA_ENV,
      setupCommands: [VCVARS],
      platforms: ['windows'],
    },
  },
  {
    name: 'Tauri Build (CUDA)',
    description: 'Production build with CUDA (Windows)',
    platform: 'windows',
    template: {
      name: 'Tauri Build (CUDA)',
      description: 'Production build of Tauri app with CUDA GPU acceleration',
      command: 'npm run tauri build',
      env: CUDA_ENV,
      setupCommands: [VCVARS],
      platforms: ['windows'],
    },
  },
  {
    name: 'Tauri Dev (Metal)',
    description: 'Build Tauri app with Metal GPU support (macOS)',
    platform: 'macos',
    template: { name: 'Tauri Dev (Metal)', description: 'Build Tauri app with Metal GPU acceleration enabled', command: 'npm run tauri dev', platforms: ['macos'] },
  },
  {
    name: 'Tauri Build (Metal)',
    description: 'Production build with Metal (macOS)',
    platform: 'macos',
    template: { name: 'Tauri Build (Metal)', description: 'Production build of Tauri app with Metal GPU acceleration', command: 'npm run tauri build', platforms: ['macos'] },
  },
  {
    name: 'Clean Build',
    description: 'Clean and rebuild the project',
    platform: 'all',
    template: {
      name: 'Clean Build',
      description: 'Delete build artifacts and rebuild from scratch',
      command: 'npm run build',
      setupCommands: ['npm run clean || echo "No clean script"', 'npm ci'],
    },
  },
  {
    name: 'Docker Build',
    description: 'Build Docker image for the project',
    platform: 'all',
    template: { name: 'Docker Build', description: 'Build a Docker image tagged with project name', command: 'docker build -t myapp:latest .' },
  },
]

export interface AiSkill {
  id: string
  name: string
  description: string
  command: string
  icon: string
  color: string
}

export const AI_SKILLS: AiSkill[] = [
  {
    id: 'detect-environments',
    name: 'Detect Environments',
    description: 'Scan for VS, Git Bash, etc.',
    command: '/detect-environments',
    icon: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
    color: 'text-blue-400',
  },
  {
    id: 'setup-scripts',
    name: 'Setup Build Scripts',
    description: 'Auto-create scripts for project',
    command: '/setup-scripts',
    icon: 'M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4',
    color: 'text-purple-400',
  },
  {
    id: 'script-summary',
    name: 'Get Summary',
    description: 'Overview of scripts & environments',
    command: '/script-summary',
    icon: 'M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    color: 'text-teal-400',
  },
  {
    id: 'setup-environment',
    name: 'Create Environment',
    description: 'Create custom environment',
    command: '/setup-environment',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z M15 12a3 3 0 11-6 0 3 3 0 016 0z',
    color: 'text-amber-400',
  },
  {
    id: 'assign-environment',
    name: 'Assign Environment',
    description: 'Link environment to script',
    command: '/assign-environment',
    icon: 'M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1',
    color: 'text-green-400',
  },
]

/** Auto-fix limits (the agent wait is measured from its start, not from its last output). */
export const AUTO_FIX = {
  maxAttempts: 5,
  /** No agent output for this long = the agent is done. */
  idleMs: 15_000,
  /** Give up waiting for the agent this long after it started. */
  maxWaitMs: 5 * 60_000,
  marker: 'FIXES COMPLETE',
}

/** Most runs kept in the output panel; the oldest finished one is closed first. */
export const MAX_RUNS = 10
/** Output kept per run (for failure detection and as the view of a stopped run). */
export const OUTPUT_TAIL = 64 * 1024
