import { ReactNode, createElement } from 'react'
import { useTerminalStore } from '../stores/terminalStore'
import { useToolStore } from '../stores/toolStore'
import { useAppSettingsStore } from '../stores/appSettingsStore'
import { useSessionStore } from '../stores/sessionStore'
import { useAgentPromptStore } from '../stores/agentPromptStore'
import { useProjectStore } from '../stores/projectStore'
import { useProjectSidebarStore } from '../stores/projectSidebarStore'
import { LAYOUT_PRESETS } from './layoutUtils'
import { isToolLeaf } from './layoutIds'
import { terminalApi } from './tauri-api'
import { confirmTerminalClose } from './terminalUtils'
import { openNewTerminal, pickAndOpenProject } from './shellActions'
import { showOnboarding } from '../onboarding/onboardingStore'
import { usePluginRegistry } from '../plugins/registry'
import { runPluginCommand } from '../plugins/commands'
import { ToolIcon, activateTool, canOpenInPane, contributionModes, ensureToolConfig, getToolContribution } from '../plugins/tools'
import PluginIcon from '../plugins/PluginIcon'
import type { PaletteProviderHit } from '../plugins/palette'
import { getProviderInfo, providerShortName, useAgentProvidersStore } from '../agents/providers'

// ==================== Types ====================

export type CommandCategory = 'navigation' | 'action' | 'entity' | 'skill'

export interface Command {
  id: string
  title: string
  subtitle?: string
  category: CommandCategory
  categoryLabel: string
  icon?: ReactNode
  keywords?: string[]
  shortcut?: string
  execute: () => void | Promise<void>
}

export interface ScoredCommand {
  command: Command
  score: number
  matchIndices: number[] // Indices in title that matched, for highlighting
}

// ==================== Fuzzy Search ====================

function fuzzyScore(query: string, text: string): { score: number; indices: number[] } | null {
  const lowerQuery = query.toLowerCase()
  const lowerText = text.toLowerCase()
  const indices: number[] = []
  let score = 0
  let qi = 0

  for (let ti = 0; ti < lowerText.length && qi < lowerQuery.length; ti++) {
    if (lowerText[ti] === lowerQuery[qi]) {
      indices.push(ti)

      // Bonus for consecutive matches
      if (indices.length > 1 && indices[indices.length - 1] === indices[indices.length - 2] + 1) {
        score += 5
      }

      // Bonus for word boundary match (start of word)
      if (ti === 0 || lowerText[ti - 1] === ' ' || lowerText[ti - 1] === '-' || lowerText[ti - 1] === '_') {
        score += 10
      }

      // Bonus for prefix match (first char matches first char)
      if (qi === 0 && ti === 0) {
        score += 15
      }

      score += 1 // Base score per matched char
      qi++
    }
  }

  // All query chars must match
  if (qi < lowerQuery.length) return null

  return { score, indices }
}

function scoreCommand(query: string, command: Command): ScoredCommand | null {
  // Try title first
  const titleResult = fuzzyScore(query, command.title)
  if (titleResult) {
    return { command, score: titleResult.score, matchIndices: titleResult.indices }
  }

  // Try keywords
  if (command.keywords) {
    for (const keyword of command.keywords) {
      const kwResult = fuzzyScore(query, keyword)
      if (kwResult) {
        return { command, score: kwResult.score * 0.7, matchIndices: [] }
      }
    }
  }

  // Try subtitle
  if (command.subtitle) {
    const subResult = fuzzyScore(query, command.subtitle)
    if (subResult) {
      return { command, score: subResult.score * 0.5, matchIndices: [] }
    }
  }

  return null
}

// ==================== Static Commands ====================

function getStaticCommands(): Command[] {
  const commands: Command[] = []

  // --- Navigation: one entry per tool config, generated from its plugin
  // contribution (§5.5 `core/open:<toolConfigId>`): tiles get "Open X" (and
  // "Open X in Flyout"), toolbar items run their command.
  const toolStore = useToolStore.getState()
  const enabledTools = Array.from(toolStore.toolConfigs.values())
    .filter(t => t.enabled)
    .sort((a, b) => a.order - b.order)

  for (const tool of enabledTools) {
    const c = getToolContribution(tool)
    if (!c) continue // plugin disabled / unsupported / uninstalled
    const icon = createElement(ToolIcon, { config: tool })
    const keywords = [c.title, tool.name, tool.pluginId, tool.contributionId]
    if (c.kind === 'toolbar') {
      commands.push({
        id: `core/open:${tool.id}`,
        title: tool.name,
        subtitle: c.title,
        category: 'action',
        categoryLabel: 'Tools',
        icon,
        keywords,
        execute: () => activateTool(tool, { source: 'palette' }),
      })
      continue
    }
    if (canOpenInPane(c)) {
      commands.push({
        id: `core/open:${tool.id}`,
        title: `Open ${tool.name}`,
        subtitle: c.title,
        category: 'navigation',
        categoryLabel: 'Tools',
        icon,
        keywords,
        execute: () => activateTool(tool, { source: 'palette', mode: 'pane' }),
      })
    }
    if (contributionModes(c).includes('flyout')) {
      commands.push({
        id: `core/open-flyout:${tool.id}`,
        title: `Open ${tool.name} in Flyout`,
        subtitle: c.title,
        category: 'navigation',
        categoryLabel: 'Tools',
        icon,
        keywords: [...keywords, 'flyout'],
        execute: () => activateTool(tool, { source: 'palette', mode: 'flyout' }),
      })
    }
  }

  // --- Tiles nobody has a config for yet (no `defaultToolConfig`, e.g. the
  // `hello` example): opening one creates its config on first use.
  const allConfigs = Array.from(toolStore.toolConfigs.values())
  for (const { pluginId, contribution: tile } of usePluginRegistry.getState().contributions?.tiles ?? []) {
    if (allConfigs.some(c => c.pluginId === pluginId && c.contributionId === tile.id)) continue
    for (const mode of tile.modes?.length ? tile.modes : (['pane', 'flyout'] as const)) {
      commands.push({
        id: `core/open-tile:${pluginId}/${tile.id}:${mode}`,
        title: mode === 'pane' ? `Open ${tile.title}` : `Open ${tile.title} in Flyout`,
        subtitle: `plugin ${pluginId}`,
        category: 'navigation',
        categoryLabel: 'Tools',
        icon: createElement(PluginIcon, { pluginId, contributionId: tile.id, size: 16 }),
        keywords: ['plugin', pluginId, tile.id, tile.title, mode],
        execute: async () => {
          const config = await ensureToolConfig(pluginId, tile.id)
          await activateTool(config, { source: 'palette', mode })
        },
      })
    }
  }

  // --- Plugin commands (`contributes.commands`, palette !== false) ---
  for (const { pluginId, contribution: cmd } of usePluginRegistry.getState().contributions?.commands ?? []) {
    if (cmd.palette === false) continue
    commands.push({
      id: `${pluginId}/${cmd.id}`,
      title: cmd.title,
      subtitle: cmd.category ?? pluginId,
      category: 'action',
      categoryLabel: 'Actions',
      keywords: [pluginId, ...(cmd.keywords ?? [])],
      shortcut: cmd.shortcut ?? undefined,
      execute: async () => {
        try {
          await runPluginCommand(pluginId, cmd.id)
        } catch (e) {
          console.error(`Command ${pluginId}/${cmd.id} failed:`, e)
        }
      },
    })
  }

  // --- Navigation: Open Settings ---
  commands.push({
    id: 'nav:settings',
    title: 'Open Settings',
    category: 'navigation',
    categoryLabel: 'Navigation',
    keywords: ['preferences', 'configuration', 'config'],
    execute: () => {
      useAppSettingsStore.getState().setShowSettingsModal(true)
    },
  })

  // --- Navigation: Open Workspace Manager ---
  commands.push({
    id: 'nav:workspaces',
    title: 'Project & Workspaces',
    category: 'navigation',
    categoryLabel: 'Navigation',
    keywords: ['session', 'workspace', 'layout', 'project', 'folder'],
    execute: () => {
      useProjectSidebarStore.getState().open()
    },
  })

  // --- Navigation: Toggle Project Sidebar ---
  commands.push({
    id: 'nav:project-sidebar',
    title: 'Toggle Project Sidebar',
    category: 'navigation',
    categoryLabel: 'Navigation',
    shortcut: 'Ctrl+Shift+B',
    keywords: ['project', 'sidebar', 'panel', 'switch', 'directory'],
    execute: () => {
      useProjectSidebarStore.getState().toggle()
    },
  })

  // --- Actions: New agents (one per provider, agent-providers.md §11) ---
  for (const p of useAgentProvidersStore.getState().providers) {
    commands.push({
      id: `core/launch-agent:${p.id}`,
      title: `New ${p.displayName} Agent`,
      category: 'action',
      categoryLabel: 'Actions',
      keywords: ['agent', 'ai', 'new', p.id, ...(p.shortName ? [p.shortName.toLowerCase()] : [])],
      execute: () => {
        useAgentPromptStore.getState().openModal(p.id)
      },
    })
  }

  // --- Actions: Close active pane ---
  const termStore = useTerminalStore.getState()
  if (termStore.activeTerminalId) {
    commands.push({
      id: 'action:close-pane',
      title: 'Close Active Pane',
      category: 'action',
      categoryLabel: 'Actions',
      shortcut: 'Ctrl+W',
      keywords: ['close', 'remove', 'kill', 'pane'],
      execute: async () => {
        const ts = useTerminalStore.getState()
        const tools = useToolStore.getState()
        const activeId = ts.activeTerminalId
        if (!activeId) return

        if (isToolLeaf(activeId)) {
          if (tools.isToolLocked(activeId)) return
          const { removeTerminalFromTree } = await import('./layoutUtils')
          const newTree = removeTerminalFromTree(ts.layoutTree, activeId)
          ts.setLayoutTree(newTree)
          tools.closeTool(activeId)
        } else {
          if (ts.isTerminalLocked(activeId)) return
          const terminal = ts.terminals.get(activeId)
          if (terminal && !(await confirmTerminalClose(terminal))) return
          try { await terminalApi.kill(activeId) } catch { /* ignore */ }
          ts.removeTerminal(activeId)
        }
      },
    })

    // --- Actions: Minimize active pane ---
    commands.push({
      id: 'action:minimize-pane',
      title: 'Minimize Active Pane',
      category: 'action',
      categoryLabel: 'Actions',
      keywords: ['minimize', 'hide', 'pane'],
      execute: () => {
        const ts = useTerminalStore.getState()
        const tools = useToolStore.getState()
        const activeId = ts.activeTerminalId
        if (!activeId) return

        if (isToolLeaf(activeId)) {
          tools.minimizeTool(activeId)
        } else {
          ts.minimizeTerminal(activeId)
        }
      },
    })

    // --- Actions: Toggle lock active pane ---
    commands.push({
      id: 'action:toggle-lock',
      title: 'Toggle Lock Active Pane',
      category: 'action',
      categoryLabel: 'Actions',
      keywords: ['lock', 'unlock', 'pin', 'pane'],
      execute: () => {
        const ts = useTerminalStore.getState()
        const tools = useToolStore.getState()
        const activeId = ts.activeTerminalId
        if (!activeId) return

        if (isToolLeaf(activeId)) {
          tools.toggleToolLock(activeId)
        } else {
          ts.toggleTerminalLock(activeId)
        }
      },
    })
  }

  // --- Actions: Layout presets ---
  for (let i = 0; i < LAYOUT_PRESETS.length; i++) {
    const preset = LAYOUT_PRESETS[i]
    commands.push({
      id: `layout:${preset.type}`,
      title: `Layout: ${preset.name}`,
      subtitle: preset.description,
      category: 'action',
      categoryLabel: 'Layout',
      keywords: ['layout', preset.type, preset.name.toLowerCase()],
      execute: () => {
        useTerminalStore.getState().setLayoutPreset(preset.type)
      },
    })
  }

  // --- Actions: Reset layout ---
  commands.push({
    id: 'action:reset-layout',
    title: 'Reset Layout (Restore All)',
    category: 'action',
    categoryLabel: 'Actions',
    keywords: ['reset', 'restore', 'layout', 'minimized'],
    execute: () => {
      useTerminalStore.getState().resetLayout()
    },
  })

  // --- Actions: New terminal ---
  commands.push({
    id: 'action:new-terminal',
    title: 'New Terminal',
    category: 'action',
    categoryLabel: 'Actions',
    keywords: ['terminal', 'shell', 'console', 'new'],
    execute: () => openNewTerminal(),
  })

  // --- Actions: Switch project ---
  commands.push({
    id: 'action:switch-project',
    title: 'Switch Project...',
    category: 'action',
    categoryLabel: 'Actions',
    keywords: ['project', 'directory', 'folder', 'switch', 'open'],
    execute: async () => {
      await pickAndOpenProject()
    },
  })

  // --- Navigation: first-run welcome ---
  commands.push({
    id: 'nav:show-welcome',
    title: 'Show Welcome',
    subtitle: 'First-run setup: agents, project, CLI, plugins',
    category: 'navigation',
    categoryLabel: 'Navigation',
    keywords: ['welcome', 'onboarding', 'setup', 'getting started', 'tour', 'first run'],
    execute: () => showOnboarding(),
  })

  // --- Skills ---
  const skills = [
    { name: '/organize-ideas', desc: 'Categorize and tag all ideas' },
    { name: '/brainstorm', desc: 'Generate related ideas around a topic' },
    { name: '/triage-issues', desc: 'Prioritize and triage issues' },
    { name: '/organize-issues', desc: 'Categorize and label all issues' },
    { name: '/run-script', desc: 'Run a saved build script' },
    { name: '/suggest-improvements', desc: 'Suggest text improvements for ideas' },
    { name: '/find-related-code', desc: 'Search codebase for code related to ideas' },
    { name: '/check-implemented', desc: 'Check if ideas have been implemented' },
    { name: '/plan-from-idea', desc: 'Create an implementation plan from an idea' },
    { name: '/idea-summary', desc: 'Quick summary of all ideas' },
    { name: '/issue-summary', desc: 'Quick summary of all issues' },
    { name: '/plan-summary', desc: 'Summary of all plans and progress' },
    { name: '/setup-scripts', desc: 'Auto-create build scripts for the project' },
    { name: '/weekly-digest', desc: 'Weekly summary of idea activity' },
  ]

  for (const skill of skills) {
    commands.push({
      id: `skill:${skill.name}`,
      title: skill.name,
      subtitle: `${skill.desc} - Run in an agent terminal`,
      category: 'skill',
      categoryLabel: 'Skills',
      keywords: [skill.name.replace('/', ''), ...skill.desc.toLowerCase().split(' ')],
      execute: () => {
        // Focus an active agent terminal if one exists
        const ts = useTerminalStore.getState()
        const agentTerminal = Array.from(ts.terminals.values()).find(t => t.agent && t.status === 'active')
        if (agentTerminal) {
          ts.setActiveTerminal(agentTerminal.id)
        }
      },
    })
  }

  return commands
}

// ==================== Entity Providers ====================

function getEntityCommands(query: string): Command[] {
  if (query.length < 2) return []

  const commands: Command[] = []
  const maxPerCategory = 10

  // Issues and plans: palette providers of plugins/issues and plugins/plans.

  // --- Projects ---
  const projectStore = useProjectStore.getState()
  let projectCount = 0
  for (const project of projectStore.projects) {
    if (projectCount >= maxPerCategory) break
    commands.push({
      id: `entity:project:${project.id}`,
      title: project.name,
      subtitle: project.workingDirectory,
      category: 'entity',
      categoryLabel: 'Projects',
      keywords: [project.workingDirectory],
      execute: async () => {
        const { switchProject } = await import('./workspaceSave')
        await switchProject(project)
      },
    })
    projectCount++
  }

  // --- Terminals ---
  const termStore = useTerminalStore.getState()
  let termCount = 0
  for (const terminal of termStore.terminals.values()) {
    if (termCount >= maxPerCategory) break
    const isMinimized = termStore.minimizedTerminals.includes(terminal.id)
    commands.push({
      id: `entity:terminal:${terminal.id}`,
      title: terminal.title,
      subtitle: [
        terminal.agent ? providerShortName(getProviderInfo(terminal.agent.providerId), terminal.agent.providerId) : 'terminal',
        terminal.role || '',
        isMinimized ? '(minimized)' : '',
      ].filter(Boolean).join(' | '),
      category: 'entity',
      categoryLabel: 'Terminals',
      keywords: [terminal.agent?.providerId || '', terminal.role || '', terminal.title],
      execute: () => {
        const ts = useTerminalStore.getState()
        if (ts.minimizedTerminals.includes(terminal.id)) {
          ts.restoreTerminal(terminal.id)
        }
        ts.setActiveTerminal(terminal.id)
      },
    })
    termCount++
  }

  // --- Workspaces ---
  const sessionStore = useSessionStore.getState()
  let wsCount = 0
  for (const session of sessionStore.sessions) {
    if (wsCount >= maxPerCategory) break
    commands.push({
      id: `entity:workspace:${session.id}`,
      title: session.name,
      subtitle: session.id === sessionStore.activeSession?.id ? 'Active' : undefined,
      category: 'entity',
      categoryLabel: 'Workspaces',
      keywords: [session.name],
      execute: async () => {
        const { switchWorkspace } = await import('./workspaceSave')
        await switchWorkspace(session.id)
      },
    })
    wsCount++
  }

  return commands
}

// ==================== Search ====================

const CATEGORY_ORDER: Record<string, number> = {
  'Navigation': 0,
  'Tools': 1,
  'Actions': 2,
  'Layout': 3,
  'Issues': 4,
  'Ideas': 5,
  'Plans': 6,
  'Projects': 7,
  'Discovery': 7.5,
  'Terminals': 8,
  'Workspaces': 9,
  'Skills': 10,
}

/** Plugin palette-provider results (src/plugins/palette.ts) as entity commands. */
export function paletteHitsToCommands(hits: PaletteProviderHit[]): Command[] {
  return hits.map((h) => ({
    id: `entity:plugin:${h.pluginId}/${h.providerId}:${h.item.id}`,
    title: h.item.title,
    subtitle: h.item.subtitle,
    category: 'entity' as const,
    categoryLabel: h.title,
    icon: h.icon,
    keywords: h.item.keywords,
    execute: () => h.item.run(),
  }))
}

/**
 * `extra`: entity commands that were already matched by their source (plugin
 * palette providers); they are kept even when the fuzzy title match fails.
 */
export function searchCommands(query: string, extra: Command[] = []): ScoredCommand[] {
  // Strip prefix mode chars for filtering
  let effectiveQuery = query.trim()
  let filterCategory: string | null = null

  if (effectiveQuery.startsWith('>')) {
    filterCategory = 'action-nav'
    effectiveQuery = effectiveQuery.slice(1).trim()
  } else if (effectiveQuery.startsWith('#')) {
    filterCategory = 'Issues'
    effectiveQuery = effectiveQuery.slice(1).trim()
  } else if (effectiveQuery.startsWith('@')) {
    filterCategory = 'Terminals'
    effectiveQuery = effectiveQuery.slice(1).trim()
  }

  const staticCmds = getStaticCommands()
  const entityCmds = getEntityCommands(effectiveQuery || query)
  const allCommands = [...staticCmds, ...entityCmds]

  // Filter by prefix mode
  let filteredCommands = allCommands
  if (filterCategory === 'action-nav') {
    filteredCommands = allCommands.filter(c => c.category === 'action' || c.category === 'navigation')
  } else if (filterCategory) {
    filteredCommands = allCommands.filter(c => c.categoryLabel === filterCategory)
  }

  if (!effectiveQuery) {
    // No query: return static commands only, grouped by category
    return filteredCommands
      .filter(c => c.category !== 'entity')
      .map(c => ({ command: c, score: 0, matchIndices: [] }))
      .sort((a, b) => {
        const catA = CATEGORY_ORDER[a.command.categoryLabel] ?? 99
        const catB = CATEGORY_ORDER[b.command.categoryLabel] ?? 99
        return catA - catB
      })
  }

  // Score and filter
  const scored: ScoredCommand[] = []
  for (const cmd of filteredCommands) {
    const result = scoreCommand(effectiveQuery, cmd)
    if (result) {
      scored.push(result)
    }
  }
  if (!filterCategory || filterCategory !== 'action-nav') {
    for (const cmd of extra) {
      if (filterCategory && cmd.categoryLabel !== filterCategory) continue
      scored.push(scoreCommand(effectiveQuery, cmd) ?? { command: cmd, score: 1, matchIndices: [] })
    }
  }

  // Sort by score descending, then by category order
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const catA = CATEGORY_ORDER[a.command.categoryLabel] ?? 99
    const catB = CATEGORY_ORDER[b.command.categoryLabel] ?? 99
    return catA - catB
  })

  return scored
}

export function groupByCategory(results: ScoredCommand[]): { label: string; items: ScoredCommand[] }[] {
  const groups = new Map<string, ScoredCommand[]>()

  for (const result of results) {
    const label = result.command.categoryLabel
    if (!groups.has(label)) {
      groups.set(label, [])
    }
    groups.get(label)!.push(result)
  }

  // Sort groups by category order
  return Array.from(groups.entries())
    .sort(([a], [b]) => (CATEGORY_ORDER[a] ?? 99) - (CATEGORY_ORDER[b] ?? 99))
    .map(([label, items]) => ({ label, items }))
}
