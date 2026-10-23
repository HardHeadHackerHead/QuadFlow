import { useEffect, useState, useRef, useMemo } from 'react'
import { useYouTubeLiveStore, getEnabledPages } from './store'
import { youtubeLiveApi } from './api'
import type { ChatIdea, YouTubeUserStats, StreamGoal, TrackedStream } from './types'
import { avatarColor } from './avatar'
import SlotMachine from './SlotMachine'

type PageTab = 'goals' | 'ideas' | 'slots' | 'leaderboard' | 'messages' | 'subscribers' | 'polls' | 'points'

const PAGE_CONFIG: Record<PageTab, { label: string; color: string; dotColor: string }> = {
  goals: { label: 'Goals', color: 'emerald', dotColor: 'bg-emerald-400' },
  ideas: { label: 'Ideas', color: 'purple', dotColor: 'bg-purple-400' },
  slots: { label: 'Slots', color: 'blue', dotColor: 'bg-blue-400' },
  leaderboard: { label: 'Leaderboard', color: 'yellow', dotColor: 'bg-yellow-400' },
  messages: { label: 'Messages', color: 'green', dotColor: 'bg-green-400' },
  subscribers: { label: 'Subscribers', color: 'red', dotColor: 'bg-red-400' },
  polls: { label: 'Polls', color: 'orange', dotColor: 'bg-orange-400' },
  points: { label: 'How to Earn', color: 'amber', dotColor: 'bg-amber-400' },
}

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / 60000)
  const diffHours = Math.floor(diffMs / 3600000)
  if (diffMins < 1) return 'just now'
  if (diffMins < 60) return `${diffMins}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  return date.toLocaleDateString()
}

// Avatar with image fallback
function Avatar({ src, name, size = 'w-8 h-8' }: { src?: string; name: string; size?: string }) {
  const [failed, setFailed] = useState(false)

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        className={`${size} rounded-full flex-shrink-0`}
        onError={() => setFailed(true)}
      />
    )
  }

  const textSize = size.includes('w-12') ? 'text-lg' : size.includes('w-9') ? 'text-sm' : 'text-xs'

  return (
    <div className={`${size} rounded-full flex items-center justify-center flex-shrink-0 ${avatarColor(name)}`}>
      <span className={`${textSize} font-bold text-white`}>{name.charAt(0).toUpperCase()}</span>
    </div>
  )
}

// ---- Connection Dot ----
function ConnectionDot() {
  const { pollStatus } = useYouTubeLiveStore()
  const isPolling = pollStatus?.is_polling

  return (
    <div className="flex items-center gap-1.5" title={isPolling ? (pollStatus.stream_title || 'Connected') : 'Not connected'}>
      <span className={`w-2.5 h-2.5 rounded-full flex-shrink-0 transition-colors ${
        isPolling
          ? 'bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)]'
          : 'bg-red-500/60'
      }`} />
      {isPolling && pollStatus.stream_title && (
        <span className="text-[10px] text-vibe-muted truncate max-w-[120px]">{pollStatus.stream_title}</span>
      )}
    </div>
  )
}

// ---- Page-specific Command Banner ----
function CommandBanner({ page }: { page: PageTab }) {
  const { settings, chatIdeas, leaderboard, goals, subscribers, activeStream, activePoll, streamPolls } = useYouTubeLiveStore()

  if (page === 'goals') {
    const streamGoals = activeStream
      ? goals.filter(g => g.stream_id === activeStream.id)
      : goals
    const completed = streamGoals.filter(g => g.completed).length
    const total = streamGoals.length
    return (
      <div className="relative rounded-xl overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-emerald-600/20 via-emerald-500/10 to-teal-500/20" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />
        <div className="relative border border-emerald-500/25 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <span className="text-[10px] uppercase tracking-widest text-emerald-400/90 font-bold">Stream Goals</span>
              <p className="text-lg font-mono font-bold text-emerald-200 mt-0.5">
                {total === 0 ? 'Set your goals for today' : `${completed}/${total} completed`}
              </p>
            </div>
            {total > 0 && (
              <div className="flex-shrink-0 ml-3">
                <div className="w-12 h-12 relative">
                  <svg className="w-12 h-12 -rotate-90" viewBox="0 0 36 36">
                    <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="2" className="text-emerald-900/30" />
                    <circle cx="18" cy="18" r="15.5" fill="none" stroke="currentColor" strokeWidth="2"
                      strokeDasharray={`${total > 0 ? (completed / total) * 97.5 : 0} 97.5`}
                      className="text-emerald-400 transition-all duration-500" />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] font-bold text-emerald-300">
                    {total > 0 ? Math.round((completed / total) * 100) : 0}%
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (page === 'ideas') {
    const ideaPrefix = settings?.command_prefix || '!idea'
    const pendingCount = chatIdeas.filter(i => i.status === 'pending').length
    return (
      <div className="relative rounded-xl overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-purple-600/20 via-purple-500/10 to-fuchsia-500/20" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />
        <div className="relative border border-purple-500/25 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <span className="text-[10px] uppercase tracking-widest text-purple-400/90 font-bold">Submit an Idea</span>
              <p className="text-lg font-mono font-bold text-purple-200 truncate mt-0.5">{ideaPrefix} <span className="text-purple-400/40 font-normal italic">your idea here</span></p>
            </div>
            {pendingCount > 0 && (
              <div className="flex-shrink-0 flex flex-col items-center ml-3">
                <span className="text-2xl font-black text-purple-300">{pendingCount}</span>
                <span className="text-[9px] text-purple-400/60 uppercase tracking-wider">pending</span>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  if (page === 'slots') {
    const slotPrefix = settings?.slot_command_prefix || '!pull'
    const slotEnabled = settings?.slot_enabled ?? true
    if (!slotEnabled) return null
    return (
      <div className="relative rounded-xl overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-blue-600/20 via-indigo-500/10 to-blue-500/20" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />
        <div className="relative border border-blue-500/25 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase tracking-widest text-blue-400/90 font-bold">Try Your Luck</span>
              <p className="text-lg font-mono font-bold text-blue-200 mt-0.5">{slotPrefix}</p>
            </div>
            <div className="flex gap-1 text-2xl opacity-60">
              <span>🎰</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (page === 'leaderboard') {
    const topUser = leaderboard.length > 0 ? leaderboard[0] : null
    return (
      <div className="relative rounded-xl overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-yellow-600/15 via-amber-500/10 to-yellow-500/15" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />
        <div className="relative border border-yellow-500/20 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase tracking-widest text-yellow-400/90 font-bold">Top Players</span>
              <p className="text-lg font-bold text-yellow-200 mt-0.5">Leaderboard</p>
            </div>
            <div className="flex items-center gap-2">
              {topUser && (
                <span className="text-[10px] text-yellow-500/60 hidden sm:block">{topUser.author_name} leads</span>
              )}
              <span className="text-2xl">🏆</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (page === 'subscribers') {
    return (
      <div className="relative rounded-xl overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-red-600/20 via-rose-500/10 to-red-500/20" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />
        <div className="relative border border-red-500/25 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-[10px] uppercase tracking-widest text-red-400/90 font-bold">Recent Subscribers</span>
              <p className="text-lg font-bold text-red-200 mt-0.5">Subscribers</p>
            </div>
            <div className="flex items-center gap-2">
              {subscribers.length > 0 && (
                <span className="text-[10px] text-red-500/60">{subscribers.length} recent</span>
              )}
              <span className="text-2xl">🔔</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  if (page === 'polls') {
    const hasActivePoll = activePoll && activePoll.status === 'active'
    return (
      <div className="relative rounded-xl overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-orange-600/20 via-amber-500/10 to-orange-500/20" />
        <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />
        <div className="relative border border-orange-500/25 rounded-xl px-4 py-3">
          <div className="flex items-center justify-between">
            <div className="min-w-0">
              <span className="text-[10px] uppercase tracking-widest text-orange-400/90 font-bold">Live Polls</span>
              <p className="text-lg font-bold text-orange-200 mt-0.5 truncate">
                {hasActivePoll ? activePoll.question : 'No active poll'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {streamPolls.length > 0 && (
                <span className="text-[10px] text-orange-500/60">{streamPolls.length} this stream</span>
              )}
              <span className="text-2xl">📊</span>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Messages page
  const totalMessages = leaderboard.reduce((sum, u) => sum + u.total_messages, 0)
  return (
    <div className="relative rounded-xl overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-r from-green-600/20 via-emerald-500/10 to-green-500/20" />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20" />
      <div className="relative border border-green-500/25 rounded-xl px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[10px] uppercase tracking-widest text-green-400/90 font-bold">Chat Activity</span>
            <p className="text-lg font-bold text-green-200 mt-0.5">Messages</p>
          </div>
          <div className="flex items-center gap-2">
            {totalMessages > 0 && (
              <span className="text-[10px] text-green-500/60">{totalMessages.toLocaleString()} total</span>
            )}
            <span className="text-2xl">💬</span>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---- Cycle Progress Bar ----
function CycleProgressBar() {
  const { cycleProgress, cyclePaused, settings, activeTab } = useYouTubeLiveStore()
  if (!settings?.tab_auto_cycle) return null

  const config = PAGE_CONFIG[activeTab]
  const gradientMap: Record<string, string> = {
    purple: 'from-purple-500 to-fuchsia-500',
    blue: 'from-blue-500 to-indigo-500',
    yellow: 'from-yellow-500 to-amber-500',
    green: 'from-green-500 to-emerald-500',
    red: 'from-red-500 to-rose-500',
    emerald: 'from-emerald-500 to-teal-500',
    orange: 'from-orange-500 to-amber-500',
  }

  return (
    <div className={`w-full h-0.5 bg-vibe-border/20 ${cyclePaused ? 'animate-pulse' : ''}`}>
      <div
        className={`h-full bg-gradient-to-r ${gradientMap[config.color]} transition-[width] duration-100 ease-linear`}
        style={{ width: `${cycleProgress}%` }}
      />
    </div>
  )
}

// ---- Page Indicator with clickable dots and nav arrows ----
function PageIndicator() {
  const { activeTab, setActiveTab, settings, cyclePaused, toggleCyclePause } = useYouTubeLiveStore()
  const config = PAGE_CONFIG[activeTab]
  const enabledPages = useMemo(() => getEnabledPages(settings), [settings])

  const goToPrev = () => {
    const idx = enabledPages.indexOf(activeTab)
    const prev = enabledPages[(idx - 1 + enabledPages.length) % enabledPages.length]
    setActiveTab(prev)
  }

  const goToNext = () => {
    const idx = enabledPages.indexOf(activeTab)
    const next = enabledPages[(idx + 1) % enabledPages.length]
    setActiveTab(next)
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={goToPrev}
        className="p-0.5 text-vibe-muted/40 hover:text-vibe-muted transition-colors"
        aria-label="Previous page"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
        </svg>
      </button>

      <div className="flex gap-1.5">
        {enabledPages.map((page) => (
          <button
            key={page}
            onClick={() => setActiveTab(page)}
            className={`rounded-full transition-all duration-300 ${
              activeTab === page
                ? `${PAGE_CONFIG[page].dotColor} w-4 h-1.5`
                : 'bg-vibe-border hover:bg-vibe-muted/50 w-1.5 h-1.5'
            }`}
            title={PAGE_CONFIG[page].label}
            aria-label={`Switch to ${PAGE_CONFIG[page].label}`}
          />
        ))}
      </div>

      <button
        onClick={goToNext}
        className="p-0.5 text-vibe-muted/40 hover:text-vibe-muted transition-colors"
        aria-label="Next page"
      >
        <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
        </svg>
      </button>

      <span className="text-[10px] text-vibe-muted font-semibold uppercase tracking-widest">
        {config.label}
      </span>

      {/* Pause/Play button - pauses tab rotation + auto-scrolling */}
      {settings?.tab_auto_cycle && (
        <button
          onClick={toggleCyclePause}
          className={`p-0.5 transition-colors ${
            cyclePaused
              ? 'text-vibe-muted hover:text-vibe-text'
              : 'text-vibe-muted/40 hover:text-vibe-muted'
          }`}
          title={cyclePaused ? 'Resume auto-cycle' : 'Pause auto-cycle'}
          aria-label={cyclePaused ? 'Resume' : 'Pause'}
        >
          {cyclePaused ? (
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          ) : (
            <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 24 24">
              <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
            </svg>
          )}
        </button>
      )}
    </div>
  )
}

// ---- Overlay Idea Card ----
function OverlayIdeaCard({ idea, isHero, index, onPromote, onDismiss, onHide, isPromoting }: {
  idea: ChatIdea
  isHero?: boolean
  index?: number
  onPromote?: (id: string) => void
  onDismiss?: (id: string) => void
  onHide?: (id: string) => void
  isPromoting?: boolean
}) {
  const avatarSize = isHero ? 'w-12 h-12' : 'w-8 h-8'

  return (
    <div className={`
      animate-slideIn rounded-xl transition-all relative group
      ${isHero
        ? 'bg-gradient-to-br from-purple-500/10 via-vibe-surface to-fuchsia-500/5 border-2 border-purple-500/30 shadow-[0_0_25px_rgba(168,85,247,0.08)] p-4'
        : 'bg-vibe-surface/40 border border-vibe-border/50 hover:border-vibe-border p-3'}
    `}>
      {/* Hide (X) button - top-right corner */}
      {onHide && (
        <button
          onClick={() => onHide(idea.id)}
          className="absolute top-1.5 right-1.5 p-0.5 text-vibe-muted/0 group-hover:text-vibe-muted/40 hover:!text-vibe-muted transition-colors"
          title="Hide idea"
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}

      <div className="flex items-start gap-3">
        {/* Idea number for non-hero */}
        {!isHero && index != null && (
          <span className="text-[10px] font-mono text-purple-400/40 font-bold mt-1 w-4 text-right flex-shrink-0">{index}</span>
        )}

        <Avatar src={idea.author_profile_image} name={idea.author_name} size={avatarSize} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`font-semibold text-vibe-text truncate ${isHero ? 'text-base' : 'text-sm'}`}>{idea.author_name}</span>
            <span className={`text-vibe-muted flex-shrink-0 ${isHero ? 'text-xs' : 'text-[10px]'}`}>{formatTime(idea.published_at)}</span>
            {/* Status badges */}
            {idea.status === 'promoted_issue' && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-500/15 text-green-400 font-medium flex-shrink-0">Approved</span>
            )}
            {idea.status === 'dismissed' && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-gray-500/15 text-gray-400 font-medium flex-shrink-0">Denied</span>
            )}
            {idea.project_name && (
              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-blue-500/15 text-blue-400 font-medium flex-shrink-0 truncate max-w-[120px]" title={idea.project_name}>{idea.project_name}</span>
            )}
          </div>
          <p className={`text-vibe-text mt-1 leading-relaxed ${isHero ? 'text-base' : 'text-sm'}`}>{idea.idea_content}</p>

          {/* Action buttons for pending ideas */}
          {idea.status === 'pending' && onPromote && onDismiss && (
            <div className="flex items-center gap-1.5 mt-1.5">
              <button
                onClick={() => onPromote(idea.id)}
                disabled={isPromoting}
                className="text-[10px] px-2 py-0.5 rounded bg-green-500/15 text-green-400/80 hover:bg-green-500/25 hover:text-green-400 transition-colors disabled:opacity-50"
              >
                {isPromoting ? '...' : 'Approve'}
              </button>
              <button
                onClick={() => onDismiss(idea.id)}
                className="text-[10px] px-2 py-0.5 rounded bg-red-500/10 text-red-400/60 hover:bg-red-500/20 hover:text-red-400 transition-colors"
              >
                Deny
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ---- Goals Overlay ----
function GoalsOverlay() {
  const { goals, createGoal, toggleGoal, deleteGoal, moveGoalToStream, cyclePaused, toggleCyclePause, settings, activeStream, trackedStreams } = useYouTubeLiveStore()
  const [showModal, setShowModal] = useState(false)
  const [newGoalTitle, setNewGoalTitle] = useState('')
  const [showOtherStreams, setShowOtherStreams] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const didAutoPauseRef = useRef(false)

  const openModal = () => {
    // Auto-pause cycling/scrolling when opening the goal modal
    if (settings?.tab_auto_cycle && !cyclePaused) {
      toggleCyclePause()
      didAutoPauseRef.current = true
    }
    setShowModal(true)
  }

  const closeModal = () => {
    setShowModal(false)
    setNewGoalTitle('')
    // Resume cycling if we were the ones who paused it
    if (didAutoPauseRef.current) {
      didAutoPauseRef.current = false
      toggleCyclePause()
    }
  }

  const handleSubmit = async () => {
    const title = newGoalTitle.trim()
    if (!title) return
    await createGoal(title)
    closeModal()
  }

  useEffect(() => {
    if (showModal && inputRef.current) {
      inputRef.current.focus()
    }
  }, [showModal])

  // Group goals by stream context
  const currentStreamGoals = activeStream
    ? goals.filter((g) => g.stream_id === activeStream.id)
    : goals
  const otherGoals = activeStream
    ? goals.filter((g) => g.stream_id !== activeStream.id)
    : []

  const currentIncomplete = currentStreamGoals.filter((g) => !g.completed)
  const currentCompleted = currentStreamGoals.filter((g) => g.completed)

  // Group other goals by stream for the collapsed section
  const otherByStream = useMemo(() => {
    const groups: Record<string, { title: string; goals: StreamGoal[] }> = {}
    for (const g of otherGoals) {
      const key = g.stream_id || '__unassigned__'
      if (!groups[key]) {
        const stream = trackedStreams.find((s) => s.id === g.stream_id)
        groups[key] = { title: stream?.title || 'Unassigned', goals: [] }
      }
      groups[key].goals.push(g)
    }
    return Object.entries(groups)
  }, [otherGoals, trackedStreams])

  return (
    <div className="flex flex-col gap-3 h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-emerald-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm font-semibold text-vibe-text">Stream Goals</span>
          <span className="text-xs text-vibe-muted">
            {currentIncomplete.length > 0 ? `${currentCompleted.length}/${currentStreamGoals.length} done` : currentStreamGoals.length === 0 ? '' : 'All done!'}
          </span>
        </div>
        <button
          onClick={openModal}
          className="flex items-center gap-1 px-2 py-1 text-xs font-medium rounded-md bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30 transition-colors"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
          Add Goal
        </button>
      </div>

      {/* Goal list */}
      {currentStreamGoals.length === 0 && otherGoals.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-vibe-muted/50 gap-2">
          <svg className="w-10 h-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="text-sm">No goals yet</span>
          <span className="text-xs">Click "Add Goal" to set your first stream goal</span>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
          {/* Current stream goals */}
          {currentIncomplete.map((goal) => (
            <GoalItem key={goal.id} goal={goal} onToggle={toggleGoal} onDelete={deleteGoal} onMoveToStream={moveGoalToStream} streams={trackedStreams} />
          ))}
          {currentCompleted.length > 0 && currentIncomplete.length > 0 && (
            <div className="border-t border-vibe-border/30 my-1" />
          )}
          {currentCompleted.map((goal) => (
            <GoalItem key={goal.id} goal={goal} onToggle={toggleGoal} onDelete={deleteGoal} onMoveToStream={moveGoalToStream} streams={trackedStreams} />
          ))}

          {/* Other streams section (only when connected to a stream) */}
          {activeStream && otherGoals.length > 0 && (
            <>
              <button
                onClick={() => setShowOtherStreams(!showOtherStreams)}
                className="flex items-center gap-2 mt-3 px-2 py-1.5 text-xs text-vibe-muted hover:text-vibe-text transition-colors"
              >
                <svg
                  className={`w-3 h-3 transition-transform ${showOtherStreams ? 'rotate-90' : ''}`}
                  fill="none" stroke="currentColor" viewBox="0 0 24 24"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                Other streams ({otherGoals.length})
              </button>
              {showOtherStreams && otherByStream.map(([key, group]) => (
                <div key={key} className="ml-2">
                  <div className="text-[10px] uppercase tracking-wider text-vibe-muted/60 font-semibold px-2 py-1 truncate">
                    {group.title}
                  </div>
                  {group.goals.map((goal) => (
                    <GoalItem key={goal.id} goal={goal} onToggle={toggleGoal} onDelete={deleteGoal} onMoveToStream={moveGoalToStream} streams={trackedStreams} dimmed />
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {/* Add Goal Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={closeModal}>
          <div
            className="bg-vibe-bg border border-vibe-border rounded-xl p-5 w-80 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-sm font-semibold text-vibe-text mb-3">New Stream Goal</h3>
            {activeStream && (
              <p className="text-[10px] text-vibe-muted mb-2 truncate">
                For: {activeStream.title}
              </p>
            )}
            <input
              ref={inputRef}
              type="text"
              value={newGoalTitle}
              onChange={(e) => setNewGoalTitle(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSubmit() }}
              placeholder="e.g. Finish the auth module"
              className="w-full px-3 py-2 text-sm rounded-lg bg-vibe-bg border border-vibe-border text-vibe-text placeholder-vibe-muted/50 focus:outline-none focus:border-emerald-500/50"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={closeModal}
                className="px-3 py-1.5 text-xs rounded-md text-vibe-muted hover:text-vibe-text transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSubmit}
                disabled={!newGoalTitle.trim()}
                className="px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-500 text-white hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                Add Goal
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function GoalItem({
  goal,
  onToggle,
  onDelete,
  onMoveToStream,
  streams,
  dimmed,
}: {
  goal: StreamGoal
  onToggle: (id: string, completed: boolean) => void
  onDelete: (id: string) => void
  onMoveToStream: (goalId: string, streamId: string | null) => void
  streams: TrackedStream[]
  dimmed?: boolean
}) {
  const [hovered, setHovered] = useState(false)
  const [showStreamPicker, setShowStreamPicker] = useState(false)
  const pickerRef = useRef<HTMLDivElement>(null)

  const createdDate = new Date(goal.created_at + 'Z')
  const dateStr = createdDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  const streamTitle = goal.stream_id
    ? streams.find((s) => s.id === goal.stream_id)?.title
    : null

  // Close picker on outside click
  useEffect(() => {
    if (!showStreamPicker) return
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setShowStreamPicker(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showStreamPicker])

  return (
    <div
      className={`group flex items-center gap-3 px-3 py-2 rounded-lg transition-colors ${
        dimmed ? 'opacity-50' : ''
      } ${
        goal.completed ? 'bg-vibe-surface/30' : 'bg-vibe-surface/60 hover:bg-vibe-surface'
      }`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Checkbox */}
      <button
        onClick={() => onToggle(goal.id, !goal.completed)}
        className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
          goal.completed
            ? 'bg-emerald-500 border-emerald-500'
            : 'border-vibe-border hover:border-emerald-400'
        }`}
      >
        {goal.completed && (
          <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </button>

      {/* Title + stream badge */}
      <div className="flex-1 min-w-0">
        <span className={`text-sm ${goal.completed ? 'line-through text-vibe-muted/50' : 'text-vibe-text'}`}>
          {goal.title}
        </span>
        {/* Stream badge / picker */}
        <div className="relative inline-block ml-2" ref={pickerRef}>
          <button
            onClick={() => setShowStreamPicker(!showStreamPicker)}
            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[9px] rounded bg-vibe-surface/80 text-vibe-muted hover:text-vibe-text hover:bg-vibe-surface transition-colors align-middle"
            title="Move to stream"
          >
            <span className="truncate max-w-[80px]">{streamTitle || 'Unassigned'}</span>
            <svg className="w-2.5 h-2.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {showStreamPicker && (
            <div className="absolute left-0 top-full mt-1 z-50 w-48 bg-vibe-bg border border-vibe-border rounded-lg shadow-xl py-1 max-h-40 overflow-y-auto" style={{ scrollbarWidth: 'none' }}>
              <button
                onClick={() => { onMoveToStream(goal.id, null); setShowStreamPicker(false) }}
                className={`w-full text-left px-3 py-1.5 text-xs hover:bg-vibe-surface transition-colors ${!goal.stream_id ? 'text-emerald-400' : 'text-vibe-text'}`}
              >
                Unassigned
              </button>
              {streams.map((s) => (
                <button
                  key={s.id}
                  onClick={() => { onMoveToStream(goal.id, s.id); setShowStreamPicker(false) }}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-vibe-surface transition-colors truncate ${goal.stream_id === s.id ? 'text-emerald-400' : 'text-vibe-text'}`}
                >
                  {s.title}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Date / Delete */}
      {hovered ? (
        <button
          onClick={() => onDelete(goal.id)}
          className="flex-shrink-0 p-0.5 text-red-400/60 hover:text-red-400 transition-colors"
          title="Delete goal"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      ) : (
        <span className="flex-shrink-0 text-[10px] text-vibe-muted/40">{dateStr}</span>
      )}
    </div>
  )
}

// ---- Ideas Overlay ----
function IdeasOverlay() {
  const { chatIdeas, settings, promoteToIssue, dismissIdea, hideIdea, activeStream, currentHeroIdea, ideaQueue } = useYouTubeLiveStore()
  const [promotingId, setPromotingId] = useState<string | null>(null)
  const visibleIdeas = chatIdeas.filter((i) => {
    if (i.status === 'hidden') return false
    // Hide ideas that were reviewed (approved/denied) before the current stream started
    if ((i.status === 'promoted_issue' || i.status === 'dismissed') &&
        i.reviewed_at != null &&
        activeStream &&
        i.reviewed_at < activeStream.started_tracking_at) {
      return false
    }
    return true
  })
  // Use queue-managed hero if available, otherwise fall back to most recent visible
  const heroIdea = currentHeroIdea || (visibleIdeas.length > 0 ? visibleIdeas[0] : null)
  const recentIdeas = visibleIdeas.filter((i) => i.id !== heroIdea?.id).slice(0, 7)

  const handlePromote = async (id: string) => {
    setPromotingId(id)
    await promoteToIssue({ idea_id: id })
    setPromotingId(null)
  }

  const handleDismiss = async (id: string) => {
    await dismissIdea(id)
  }

  const handleHide = async (id: string) => {
    await hideIdea(id)
  }

  if (visibleIdeas.length === 0 && !heroIdea) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        <div className="relative mb-4">
          <div className="absolute inset-0 bg-purple-500/10 rounded-full blur-xl" />
          <svg className="w-16 h-16 text-purple-400/25 relative" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        </div>
        <p className="text-lg text-vibe-muted/60 font-semibold">Waiting for ideas...</p>
        <p className="text-sm text-vibe-muted/40 mt-2">
          Type <code className="bg-purple-500/10 px-2 py-0.5 rounded-md text-purple-400 font-mono border border-purple-500/20">{settings?.command_prefix || '!idea'}</code> in chat
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {/* Hero idea */}
      {heroIdea && (
        <div className="relative">
          <div className="flex items-center gap-2 mb-2">
            <div className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
            <span className="text-[10px] uppercase tracking-widest text-purple-400/70 font-bold">Latest Idea</span>
            {/* Queue count badge */}
            {ideaQueue.length > 0 && (
              <span className="ml-auto bg-purple-500 text-white text-[10px] font-bold rounded-full px-1.5 py-0.5 leading-none">
                +{ideaQueue.length} queued
              </span>
            )}
          </div>
          <OverlayIdeaCard
            key={heroIdea.id}
            idea={heroIdea}
            isHero
            onPromote={handlePromote}
            onDismiss={handleDismiss}
            onHide={handleHide}
            isPromoting={promotingId === heroIdea.id}
          />
        </div>
      )}

      {/* Recent ideas */}
      {recentIdeas.length > 0 && (
        <div className="space-y-1.5">
          {recentIdeas.map((idea, i) => (
            <OverlayIdeaCard
              key={idea.id}
              idea={idea}
              index={i + 2}
              onPromote={handlePromote}
              onDismiss={handleDismiss}
              onHide={handleHide}
              isPromoting={promotingId === idea.id}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Auto-Scrolling Leaderboard ----
const BOARD_MEDALS = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49']
const BOARD_COLORS = [
  { bg: 'from-yellow-500/15 to-yellow-500/5', border: 'border-yellow-500/30', text: 'text-yellow-400', ring: 'ring-yellow-500/40' },
  { bg: 'from-gray-400/10 to-gray-400/5', border: 'border-gray-400/20', text: 'text-gray-300', ring: 'ring-gray-400/30' },
  { bg: 'from-amber-700/15 to-amber-700/5', border: 'border-amber-700/25', text: 'text-amber-500', ring: 'ring-amber-600/30' },
]

function AutoScrollBoard({
  users,
  isActive,
  primaryStat,
  emptyIcon,
  emptyTitle,
  emptySubtitle,
}: {
  users: YouTubeUserStats[]
  isActive: boolean
  primaryStat: 'points' | 'messages'
  emptyIcon: React.ReactNode
  emptyTitle: string
  emptySubtitle: string
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const { cyclePaused } = useYouTubeLiveStore()

  const sorted = useMemo(() => {
    if (primaryStat === 'messages') {
      return [...users].filter(u => u.total_messages > 0).sort((a, b) => b.total_messages - a.total_messages)
    }
    return users
  }, [users, primaryStat])

  const top3 = sorted.slice(0, 3)
  const rest = sorted.slice(3)

  useAutoScroll(scrollRef, isActive && rest.length > 0, cyclePaused)

  if (sorted.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6">
        {emptyIcon}
        <p className="text-lg text-vibe-muted/60 font-semibold">{emptyTitle}</p>
        <p className="text-sm text-vibe-muted/40 mt-2">{emptySubtitle}</p>
      </div>
    )
  }

  const primaryValue = (user: YouTubeUserStats) =>
    primaryStat === 'messages' ? user.total_messages.toLocaleString() : user.points.toLocaleString()
  const primaryLabel = primaryStat === 'messages' ? 'msgs' : 'pts'

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Top 3 - always visible */}
      <div className="flex-shrink-0 space-y-2">
        {top3.map((user, i) => {
          const colors = BOARD_COLORS[i]
          return (
            <div key={user.author_channel_id} className={`relative rounded-xl border overflow-hidden bg-gradient-to-r ${colors.bg} ${colors.border} ${i === 0 ? 'animate-shimmer' : ''}`}>
              <div className="flex items-center gap-3 px-4 py-3">
                <span className="text-xl flex-shrink-0">{BOARD_MEDALS[i]}</span>
                {user.profile_image_url ? (
                  <img src={user.profile_image_url} alt={user.author_name} className={`w-9 h-9 rounded-full flex-shrink-0 ring-2 ring-offset-1 ring-offset-gray-900 ${colors.ring}`} />
                ) : (
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ring-2 ring-offset-1 ring-offset-gray-900 ${colors.ring} ${avatarColor(user.author_name)}`}>
                    <span className="text-sm font-bold text-white">{user.author_name.charAt(0).toUpperCase()}</span>
                  </div>
                )}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-sm font-semibold truncate ${i === 0 ? 'text-yellow-300' : 'text-white'}`}>{user.author_name}</span>
                    {user.is_owner && <span className="text-[10px] flex-shrink-0" title="Owner">👑</span>}
                    {user.is_moderator && <span className="text-[10px] flex-shrink-0" title="Moderator">🛡️</span>}
                    {user.is_member && <span className="text-[10px] flex-shrink-0" title="Member">⭐</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    {primaryStat === 'points' ? (
                      <>
                        <span className="text-[10px] text-gray-500">{user.total_pulls} pulls</span>
                        {user.total_jackpots > 0 && <span className="text-[10px] text-yellow-500/70">{user.total_jackpots} jp</span>}
                        {user.total_messages > 0 && <span className="text-[10px] text-gray-500">{user.total_messages} msgs</span>}
                      </>
                    ) : (
                      <>
                        <span className="text-[10px] text-gray-500">{user.points} pts</span>
                        {user.total_ideas_submitted > 0 && <span className="text-[10px] text-purple-400/70">{user.total_ideas_submitted} ideas</span>}
                      </>
                    )}
                  </div>
                </div>
                <div className="text-right flex-shrink-0">
                  <span className={`text-lg font-black ${colors.text} ${i === 0 ? 'animate-goldPulse' : ''}`}>{primaryValue(user)}</span>
                  <span className="text-[10px] text-gray-500 block">{primaryLabel}</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Scrollable rest - auto-scrolls when active */}
      {rest.length > 0 && (
        <div ref={scrollRef} className="flex-1 mt-3 overflow-y-auto min-h-0 rounded-xl border border-gray-700/30 bg-gray-800/30" style={{ scrollbarWidth: 'none' }}>
          {rest.map((user, i) => (
            <div key={user.author_channel_id} className={`flex items-center gap-3 px-4 py-2.5 ${i < rest.length - 1 ? 'border-b border-gray-700/20' : ''}`}>
              <span className="text-xs font-mono text-gray-600 w-5 text-right flex-shrink-0">{i + 4}</span>
              {user.profile_image_url ? (
                <img src={user.profile_image_url} alt={user.author_name} className="w-6 h-6 rounded-full flex-shrink-0" />
              ) : (
                <div className={`w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 ${avatarColor(user.author_name)}`}>
                  <span className="text-[10px] font-bold text-white">{user.author_name.charAt(0).toUpperCase()}</span>
                </div>
              )}
              <div className="flex items-center gap-1 flex-1 min-w-0">
                <span className="text-sm text-gray-300 truncate">{user.author_name}</span>
                {user.is_owner && <span className="text-[9px] flex-shrink-0" title="Owner">👑</span>}
                {user.is_moderator && <span className="text-[9px] flex-shrink-0" title="Moderator">🛡️</span>}
                {user.is_member && <span className="text-[9px] flex-shrink-0" title="Member">⭐</span>}
              </div>
              <span className="text-sm font-semibold text-gray-300 w-16 text-right flex-shrink-0">{primaryValue(user)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ---- Leaderboard Overlay ----
function LeaderboardOverlay() {
  const { leaderboard, activeTab, cyclePaused, toggleCyclePause } = useYouTubeLiveStore()
  const [search, setSearch] = useState('')
  const [isFocused, setIsFocused] = useState(false)
  const idleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const wasPausedBySearch = useRef(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const resetIdleTimer = () => {
    if (idleTimer.current) clearTimeout(idleTimer.current)
    idleTimer.current = setTimeout(() => {
      setSearch('')
      if (inputRef.current) inputRef.current.blur()
    }, 30000)
  }

  const handleFocus = () => {
    setIsFocused(true)
    if (!cyclePaused) {
      toggleCyclePause()
      wasPausedBySearch.current = true
    }
    resetIdleTimer()
  }

  const handleBlur = () => {
    setIsFocused(false)
    if (idleTimer.current) clearTimeout(idleTimer.current)
    // Resume cycle after a short delay (let click events settle)
    setTimeout(() => {
      if (wasPausedBySearch.current) {
        wasPausedBySearch.current = false
        toggleCyclePause()
      }
    }, 100)
    // Clear search when losing focus if empty
    if (!search) setSearch('')
  }

  const handleChange = (value: string) => {
    setSearch(value)
    resetIdleTimer()
  }

  // Cleanup timer on unmount
  useEffect(() => {
    return () => { if (idleTimer.current) clearTimeout(idleTimer.current) }
  }, [])

  const filtered = useMemo(() => {
    if (!search.trim()) return leaderboard
    const q = search.trim().toLowerCase()
    return leaderboard.filter(u => u.author_name.toLowerCase().includes(q))
  }, [leaderboard, search])

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Search bar */}
      <div className="flex-shrink-0 mb-3">
        <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors ${isFocused ? 'bg-vibe-surface border-yellow-500/40' : 'bg-vibe-bg/50 border-vibe-border/30'}`}>
          <svg className={`w-4 h-4 flex-shrink-0 transition-colors ${isFocused ? 'text-yellow-400' : 'text-vibe-muted/40'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={search}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={handleFocus}
            onBlur={handleBlur}
            placeholder="Search viewer..."
            className="flex-1 bg-transparent text-sm text-vibe-text placeholder:text-vibe-muted/30 outline-none"
          />
          {search && (
            <button
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setSearch(''); inputRef.current?.focus() }}
              className="text-vibe-muted/40 hover:text-vibe-muted transition-colors flex-shrink-0"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>
        {search && (
          <p className="text-[10px] text-vibe-muted/40 mt-1 text-center">
            {filtered.length === 0 ? 'No viewers found' : `${filtered.length} viewer${filtered.length === 1 ? '' : 's'} found`}
          </p>
        )}
      </div>

      <AutoScrollBoard
        users={filtered}
        isActive={activeTab === 'leaderboard'}
        primaryStat="points"
        emptyIcon={
          <div className="relative mb-4">
            <div className="absolute inset-0 bg-yellow-500/10 rounded-full blur-xl" />
            <span className="text-5xl relative block">🏆</span>
          </div>
        }
        emptyTitle={search ? 'No viewers match' : 'No players yet'}
        emptySubtitle={search ? `No results for "${search}"` : 'Leaderboard populates as viewers interact'}
      />
    </div>
  )
}

// ---- Messages Overlay ----
function MessagesOverlay() {
  const { leaderboard, activeTab } = useYouTubeLiveStore()

  return (
    <AutoScrollBoard
      users={leaderboard}
      isActive={activeTab === 'messages'}
      primaryStat="messages"
      emptyIcon={
        <div className="relative mb-4">
          <div className="absolute inset-0 bg-green-500/10 rounded-full blur-xl" />
          <span className="text-5xl relative block">💬</span>
        </div>
      }
      emptyTitle="No chatters yet"
      emptySubtitle="Message counts update as viewers chat"
    />
  )
}

// ---- Polls Overlay ----
function PollsOverlay() {
  const {
    activePoll,
    streamPolls,
    pollTemplates,
    isLoadingPolls,
    settings,
    createPoll,
    createPollFromTemplate,
    generateAiPoll,
    closePoll,
    loadPollTemplates,
  } = useYouTubeLiveStore()

  const [showCreateForm, setShowCreateForm] = useState(false)
  const [question, setQuestion] = useState('')
  const [options, setOptions] = useState(['', ''])
  const [selectedTemplateId, setSelectedTemplateId] = useState('')
  const [countdown, setCountdown] = useState<number | null>(null)
  const [isGeneratingAi, setIsGeneratingAi] = useState(false)

  // Load templates on mount
  useEffect(() => {
    loadPollTemplates()
  }, [loadPollTemplates])

  // Countdown timer for active poll
  useEffect(() => {
    if (activePoll?.time_remaining_secs && activePoll.status === 'active') {
      setCountdown(activePoll.time_remaining_secs)
      const timer = setInterval(() => {
        setCountdown(prev => {
          if (prev === null || prev <= 0) {
            clearInterval(timer)
            return 0
          }
          return prev - 1
        })
      }, 1000)
      return () => clearInterval(timer)
    } else {
      setCountdown(null)
    }
  }, [activePoll?.time_remaining_secs, activePoll?.status])

  const hasOAuth = settings?.oauth_access_token && settings.oauth_access_token.length > 0
  const hasActivePoll = activePoll && activePoll.status === 'active'

  const handleCreatePoll = async () => {
    const validOptions = options.filter(o => o.trim())
    if (question.trim() && validOptions.length >= 2) {
      await createPoll({
        question: question.trim(),
        options: validOptions,
        duration_secs: settings?.yt_poll_default_duration_secs || 60,
      })
      setQuestion('')
      setOptions(['', ''])
      setShowCreateForm(false)
    }
  }

  const handleCreateFromTemplate = async () => {
    if (selectedTemplateId) {
      await createPollFromTemplate(selectedTemplateId, settings?.yt_poll_default_duration_secs)
      setSelectedTemplateId('')
    }
  }

  const handleGenerateAiPoll = async () => {
    setIsGeneratingAi(true)
    try {
      const generated = await generateAiPoll({
        use_chat_context: true,
      })
      if (generated) {
        // Pre-fill the form with AI-generated content
        setQuestion(generated.question)
        setOptions(generated.options)
        setShowCreateForm(true)
      }
    } finally {
      setIsGeneratingAi(false)
    }
  }

  const addOption = () => {
    if (options.length < 4) {
      setOptions([...options, ''])
    }
  }

  const removeOption = (index: number) => {
    if (options.length > 2) {
      setOptions(options.filter((_, i) => i !== index))
    }
  }

  const formatCountdown = (secs: number) => {
    const mins = Math.floor(secs / 60)
    const seconds = secs % 60
    return `${mins}:${seconds.toString().padStart(2, '0')}`
  }

  // No OAuth - show setup message
  if (!hasOAuth) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
        <div className="relative mb-4">
          <div className="absolute inset-0 bg-orange-500/10 rounded-full blur-xl" />
          <span className="text-5xl relative block">📊</span>
        </div>
        <h3 className="text-lg font-bold text-vibe-text mb-1">OAuth Required</h3>
        <p className="text-xs text-vibe-muted max-w-[220px]">
          Add an OAuth token in settings to create polls and view voting results.
        </p>
      </div>
    )
  }

  // Active poll - show results
  if (hasActivePoll) {
    const totalVotes = activePoll.total_votes || 0
    return (
      <div className="space-y-4">
        {/* Active Poll Card */}
        <div className="rounded-xl border border-orange-500/30 bg-gradient-to-r from-orange-500/10 via-amber-500/5 to-orange-500/10 p-4">
          {/* Timer */}
          {countdown !== null && countdown > 0 && (
            <div className="flex items-center justify-between mb-3">
              <span className="text-[10px] uppercase tracking-widest text-orange-400/80 font-bold">Active Poll</span>
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-orange-300 font-mono">{formatCountdown(countdown)}</span>
                <span className="w-1.5 h-1.5 rounded-full bg-orange-400 animate-pulse" />
              </div>
            </div>
          )}

          {/* Question */}
          <h3 className="text-base font-bold text-orange-100 mb-3">{activePoll.question}</h3>

          {/* Options with bar chart */}
          <div className="space-y-2">
            {activePoll.options.map((opt, idx) => {
              const percentage = activePoll.percentages?.[idx] || 0
              const isWinner = activePoll.winner_index === idx
              return (
                <div key={idx} className="relative">
                  {/* Background bar */}
                  <div
                    className={`absolute inset-0 rounded-lg transition-all duration-500 ${
                      isWinner ? 'bg-orange-500/30' : 'bg-orange-500/15'
                    }`}
                    style={{ width: `${percentage}%` }}
                  />
                  {/* Content */}
                  <div className="relative flex items-center justify-between px-3 py-2">
                    <span className={`text-sm truncate ${isWinner ? 'text-orange-100 font-semibold' : 'text-orange-200/80'}`}>
                      {opt.text}
                    </span>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      <span className="text-xs text-orange-300/60">{opt.tally} votes</span>
                      <span className={`text-xs font-mono ${isWinner ? 'text-orange-200 font-bold' : 'text-orange-300/80'}`}>
                        {percentage.toFixed(1)}%
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Total votes + close button */}
          <div className="flex items-center justify-between mt-4 pt-3 border-t border-orange-500/20">
            <span className="text-xs text-orange-400/60">{totalVotes} total votes</span>
            <button
              onClick={() => closePoll(activePoll.poll_id)}
              disabled={isLoadingPolls}
              className="px-3 py-1 text-xs bg-orange-500/20 hover:bg-orange-500/30 text-orange-200 rounded-lg transition-colors disabled:opacity-50"
            >
              End Poll
            </button>
          </div>

          {/* Note about voting */}
          <p className="text-[10px] text-orange-400/40 mt-2 text-center">
            Viewers vote via YouTube's native poll UI in live chat
          </p>
        </div>

        {/* Stream poll history */}
        {streamPolls.filter(p => p.id !== activePoll.poll_id).length > 0 && (
          <PollHistory polls={streamPolls.filter(p => p.id !== activePoll.poll_id)} />
        )}
      </div>
    )
  }

  // No active poll - show create form
  return (
    <div className="space-y-4">
      {/* Create Poll Section */}
      {showCreateForm ? (
        <div className="rounded-xl border border-orange-500/20 bg-vibe-surface/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-bold text-orange-200">Create Poll</span>
            <button
              onClick={() => setShowCreateForm(false)}
              className="text-vibe-muted hover:text-vibe-text transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Question input */}
          <input
            type="text"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Enter your question..."
            className="w-full bg-vibe-bg/50 border border-vibe-border/30 rounded-lg px-3 py-2 text-sm text-vibe-text placeholder:text-vibe-muted/50 mb-3"
          />

          {/* Options */}
          <div className="space-y-2 mb-3">
            {options.map((opt, idx) => (
              <div key={idx} className="flex items-center gap-2">
                <input
                  type="text"
                  value={opt}
                  onChange={(e) => {
                    const newOpts = [...options]
                    newOpts[idx] = e.target.value
                    setOptions(newOpts)
                  }}
                  placeholder={`Option ${idx + 1}`}
                  className="flex-1 bg-vibe-bg/50 border border-vibe-border/30 rounded-lg px-3 py-1.5 text-sm text-vibe-text placeholder:text-vibe-muted/50"
                />
                {options.length > 2 && (
                  <button
                    onClick={() => removeOption(idx)}
                    className="text-vibe-muted hover:text-red-400 transition-colors"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            ))}
          </div>

          {/* Add option + Create buttons */}
          <div className="flex items-center gap-2">
            {options.length < 4 && (
              <button
                onClick={addOption}
                className="flex-1 px-3 py-1.5 text-xs bg-vibe-bg/50 hover:bg-vibe-bg/70 text-vibe-muted border border-vibe-border/30 rounded-lg transition-colors"
              >
                + Add Option
              </button>
            )}
            <button
              onClick={handleCreatePoll}
              disabled={isLoadingPolls || !question.trim() || options.filter(o => o.trim()).length < 2}
              className="flex-1 px-3 py-1.5 text-xs bg-orange-500/20 hover:bg-orange-500/30 text-orange-200 rounded-lg transition-colors disabled:opacity-50"
            >
              Create Poll
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {/* Top row: Create Custom + AI Generate */}
          <div className="flex items-stretch gap-2">
            <button
              onClick={() => setShowCreateForm(true)}
              className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-orange-500/15 to-amber-500/15 border border-orange-500/20 text-orange-200 hover:from-orange-500/20 hover:to-amber-500/20 transition-colors"
            >
              <span className="text-lg mb-1 block">📝</span>
              <span className="text-xs font-semibold">Create Custom</span>
            </button>

            <button
              onClick={handleGenerateAiPoll}
              disabled={isGeneratingAi || isLoadingPolls}
              className="flex-1 px-4 py-3 rounded-xl bg-gradient-to-r from-purple-500/15 to-fuchsia-500/15 border border-purple-500/20 text-purple-200 hover:from-purple-500/20 hover:to-fuchsia-500/20 transition-colors disabled:opacity-50"
            >
              <span className="text-lg mb-1 block">{isGeneratingAi ? '...' : '🤖'}</span>
              <span className="text-xs font-semibold">{isGeneratingAi ? 'Generating...' : 'AI Generate'}</span>
            </button>
          </div>

          {/* Bottom row: Template selector */}
          {pollTemplates.length > 0 && (
            <div className="flex items-center gap-2">
              <select
                value={selectedTemplateId}
                onChange={(e) => setSelectedTemplateId(e.target.value)}
                className="flex-1 bg-vibe-bg/50 border border-vibe-border/30 rounded-lg px-3 py-2 text-sm text-vibe-text"
              >
                <option value="">Select template...</option>
                {pollTemplates.map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
              <button
                onClick={handleCreateFromTemplate}
                disabled={!selectedTemplateId || isLoadingPolls}
                className="px-4 py-2 text-xs bg-orange-500/20 hover:bg-orange-500/30 text-orange-200 rounded-lg transition-colors disabled:opacity-50"
              >
                Use
              </button>
            </div>
          )}
        </div>
      )}

      {/* Stream poll history */}
      {streamPolls.length > 0 ? (
        <PollHistory polls={streamPolls} />
      ) : (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
          <div className="relative mb-4">
            <div className="absolute inset-0 bg-orange-500/10 rounded-full blur-xl" />
            <span className="text-5xl relative block">📊</span>
          </div>
          <h3 className="text-lg font-bold text-vibe-text mb-1">No polls yet</h3>
          <p className="text-xs text-vibe-muted max-w-[220px]">
            Create a poll to engage your viewers!
          </p>
        </div>
      )}
    </div>
  )
}

// Poll history component
function PollHistory({ polls }: { polls: { id: string; question: string; options: { text: string; tally: number }[]; status: string; created_at: number }[] }) {
  return (
    <div className="space-y-2">
      <span className="text-[10px] uppercase tracking-widest text-vibe-muted font-bold">Poll History</span>
      {polls.map((poll) => {
        const totalVotes = poll.options.reduce((sum, o) => sum + o.tally, 0)
        const winner = poll.options.reduce((max, opt, idx, arr) =>
          opt.tally > (arr[max]?.tally || 0) ? idx : max
        , 0)
        return (
          <div key={poll.id} className="rounded-lg border border-vibe-border/20 bg-vibe-surface/30 p-3">
            <div className="flex items-start justify-between gap-2 mb-2">
              <span className="text-sm text-vibe-text font-medium line-clamp-2">{poll.question}</span>
              <span className={`text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${
                poll.status === 'active' ? 'bg-orange-500/20 text-orange-300' : 'bg-vibe-muted/20 text-vibe-muted'
              }`}>
                {poll.status}
              </span>
            </div>
            <div className="flex items-center gap-2 text-[10px] text-vibe-muted">
              <span>{totalVotes} votes</span>
              <span>•</span>
              <span>Winner: {poll.options[winner]?.text || 'N/A'}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---- Points Info Overlay ----

const SLOT_SYMBOL_EMOJIS: Record<string, string> = {
  cherry: '\uD83C\uDF52', lemon: '\uD83C\uDF4B', orange: '\uD83C\uDF4A',
  plum: '\uD83E\uDED0', bell: '\uD83D\uDD14', bar: '\uD83C\uDF2D', seven: '7\uFE0F\u20E3',
}

function PointsInfoOverlay() {
  const { settings, payTable } = useYouTubeLiveStore()
  if (!settings) return null

  const enabledEntries = payTable.filter(e => e.enabled).sort((a, b) => a.priority - b.priority)

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="text-center pb-2">
        <p className="text-2xl font-bold text-amber-400">How to Earn Points</p>
        <p className="text-xs text-vibe-muted mt-1">Start with <span className="text-amber-300 font-bold">{settings.starting_points}</span> points on your first interaction</p>
      </div>

      {/* Earning methods */}
      <div className="space-y-2">
        {/* Chat XP */}
        {settings.chat_xp_enabled && (
          <div className="flex items-center gap-3 p-3 bg-vibe-surface border border-vibe-border rounded-lg">
            <span className="text-2xl flex-shrink-0">💬</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-vibe-text">Chat in Stream</p>
              <p className="text-xs text-vibe-muted">
                Send a message in chat
                {settings.chat_xp_cooldown_secs > 0 && ` (every ${settings.chat_xp_cooldown_secs}s)`}
              </p>
            </div>
            <span className="text-sm font-bold text-green-400 flex-shrink-0">+{settings.chat_xp_amount}</span>
          </div>
        )}

        {/* Submit Idea */}
        <div className="flex items-center gap-3 p-3 bg-vibe-surface border border-vibe-border rounded-lg">
          <span className="text-2xl flex-shrink-0">💡</span>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-vibe-text">Submit an Idea</p>
            <p className="text-xs text-vibe-muted">
              Type <code className="bg-vibe-bg px-1 rounded text-vibe-text">{settings.command_prefix} your idea</code>
            </p>
          </div>
          <span className="text-sm font-bold text-green-400 flex-shrink-0">+{settings.idea_points_reward}</span>
        </div>

        {/* Idea Approved */}
        {settings.idea_approve_bonus > 0 && (
          <div className="flex items-center gap-3 p-3 bg-vibe-surface border border-purple-500/30 rounded-lg">
            <span className="text-2xl flex-shrink-0">⭐</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-vibe-text">Idea Gets Approved</p>
              <p className="text-xs text-vibe-muted">Streamer picks your idea</p>
            </div>
            <span className="text-sm font-bold text-green-400 flex-shrink-0">+{settings.idea_approve_bonus}</span>
          </div>
        )}

        {/* Slot Machine */}
        {settings.slot_enabled && (
          <div className="flex items-center gap-3 p-3 bg-vibe-surface border border-blue-500/30 rounded-lg">
            <span className="text-2xl flex-shrink-0">🎰</span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-vibe-text">Pull the Slot Machine</p>
              <p className="text-xs text-vibe-muted">
                Type <code className="bg-vibe-bg px-1 rounded text-vibe-text">{settings.slot_command_prefix}</code> to try your luck
              </p>
            </div>
            <span className="text-sm font-bold text-red-400 flex-shrink-0">-{settings.slot_pull_cost}</span>
          </div>
        )}
      </div>

      {/* Pay Table */}
      {settings.slot_enabled && enabledEntries.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-bold text-amber-400 text-center pt-1">Slot Machine Prizes</p>
          <div className="space-y-1.5">
            {enabledEntries.map((entry) => (
              <div key={entry.id} className="flex items-center gap-3 px-3 py-2 bg-vibe-surface border border-vibe-border rounded-lg">
                <span className="text-xl flex-shrink-0">
                  {entry.match_type === 'triple_specific' && entry.symbol
                    ? `${SLOT_SYMBOL_EMOJIS[entry.symbol] || entry.symbol}${SLOT_SYMBOL_EMOJIS[entry.symbol] || entry.symbol}${SLOT_SYMBOL_EMOJIS[entry.symbol] || entry.symbol}`
                    : entry.match_type === 'triple_any'
                    ? '🔥🔥🔥'
                    : '🔥🔥'}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-vibe-text truncate">
                    {entry.prize_name || (
                      entry.match_type === 'triple_specific' ? `Triple ${entry.symbol || '?'}` :
                      entry.match_type === 'triple_any' ? 'Any Triple' : 'Partial Match'
                    )}
                  </p>
                  <p className="text-[10px] text-vibe-muted">
                    {entry.match_type === 'triple_specific' ? 'Three matching symbols' :
                     entry.match_type === 'triple_any' ? 'Any three of a kind' : 'Two matching symbols'}
                  </p>
                </div>
                <span className="text-sm font-bold text-green-400 flex-shrink-0">
                  {entry.prize_type === 'real' ? '🎁 Prize!' : `+${entry.points_amount}`}
                </span>
              </div>
            ))}
          </div>

          {/* Jackpot fallback */}
          {settings.slot_jackpot_bonus > 0 && (
            <p className="text-[10px] text-vibe-muted text-center">
              No match on the pay table? Triple anything still wins <span className="text-green-400 font-bold">+{settings.slot_jackpot_bonus}</span> points!
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ---- Subscribers Overlay ----
function SubscribersOverlay() {
  const { subscribers, settings } = useYouTubeLiveStore()
  const hasOAuth = settings?.oauth_access_token && settings.oauth_access_token.length > 0

  if (subscribers.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-8">
        <div className="relative mb-4">
          <div className="absolute inset-0 bg-red-500/10 rounded-full blur-xl" />
          <span className="text-5xl relative block">🔔</span>
        </div>
        <h3 className="text-lg font-bold text-vibe-text mb-1">No subscribers yet</h3>
        <p className="text-xs text-vibe-muted max-w-[220px]">
          {hasOAuth
            ? 'Waiting for new subscribers to appear...'
            : 'Add an OAuth token in settings to see subscriber names. Without it, generic alerts fire when the sub count increases.'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {subscribers.map((sub, index) => {
        const isHero = index === 0
        return (
          <div
            key={sub.id}
            className={`rounded-xl border transition-all ${
              isHero
                ? 'bg-gradient-to-r from-red-500/15 via-rose-500/10 to-red-500/15 border-red-500/30 p-4'
                : 'bg-vibe-surface/50 border-vibe-border/30 p-3'
            }`}
          >
            <div className="flex items-center gap-3">
              <Avatar
                src={sub.thumbnail_url || undefined}
                name={sub.channel_title || '?'}
                size={isHero ? 'w-12 h-12' : 'w-8 h-8'}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className={`font-bold truncate ${isHero ? 'text-red-200 text-base' : 'text-vibe-text text-sm'}`}>
                    {sub.channel_title || 'Unknown'}
                  </span>
                  {isHero && (
                    <span className="text-[10px] bg-red-500/20 text-red-300 px-1.5 py-0.5 rounded-full font-semibold">NEW</span>
                  )}
                </div>
                <span className="text-[10px] text-vibe-muted">
                  {formatTime(new Date(sub.detected_at).getTime())}
                </span>
              </div>
              <span className="text-lg flex-shrink-0">🔔</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ---- Main View ----
// ---- Alert Overlay ----
const ALERT_STYLES: Record<string, { gradient: string; icon: string; label: string }> = {
  super_chat: { gradient: 'from-yellow-500/90 to-amber-600/90', icon: '💰', label: 'Super Chat' },
  new_member: { gradient: 'from-emerald-500/90 to-green-600/90', icon: '🎉', label: 'New Member' },
  milestone: { gradient: 'from-purple-500/90 to-violet-600/90', icon: '🏆', label: 'Milestone' },
  gift_membership: { gradient: 'from-blue-500/90 to-cyan-600/90', icon: '🎁', label: 'Gift' },
  super_sticker: { gradient: 'from-orange-500/90 to-red-500/90', icon: '✨', label: 'Super Sticker' },
  new_subscriber: { gradient: 'from-red-500/90 to-rose-600/90', icon: '🔔', label: 'New Subscriber' },
}

function AlertOverlay() {
  const { currentAlert, dismissAlert } = useYouTubeLiveStore()

  if (!currentAlert) return null

  const style = ALERT_STYLES[currentAlert.alert_type] || ALERT_STYLES.super_chat

  return (
    <div
      className="absolute top-2 left-2 right-2 z-50 animate-alertSlideIn cursor-pointer"
      onClick={dismissAlert}
    >
      <div className={`bg-gradient-to-r ${style.gradient} rounded-xl p-3 shadow-2xl border border-white/20 backdrop-blur-sm`}>
        <div className="flex items-center gap-3">
          <div className="text-2xl flex-shrink-0">{style.icon}</div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-white font-bold text-sm truncate">{currentAlert.author_name}</span>
              <span className="text-white/60 text-xs">{style.label}</span>
            </div>
            {currentAlert.amount && (
              <div className="text-white font-bold text-lg">{currentAlert.amount}</div>
            )}
            {currentAlert.message && (
              <div className="text-white/90 text-xs mt-0.5 line-clamp-2">{currentAlert.message}</div>
            )}
          </div>
          {currentAlert.author_profile_image && (
            <Avatar src={currentAlert.author_profile_image} name={currentAlert.author_name} size="w-10 h-10" />
          )}
        </div>
      </div>
    </div>
  )
}

// ---- Live Stats Bar ----
function LiveStatsBar() {
  const { videoStats, channelStats } = useYouTubeLiveStore()

  if (!videoStats && !channelStats) return null

  const formatCount = (n: number): string => {
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M'
    if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K'
    return n.toString()
  }

  return (
    <div className="flex items-center gap-4 px-4 py-2 border-b border-vibe-border/30 text-vibe-text text-lg font-semibold">
      {videoStats && (
        <>
          {videoStats.concurrent_viewers != null && (
            <span className="flex items-center gap-1.5" title="Watching now">
              <svg className="w-5 h-5 text-red-500" fill="currentColor" viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" /></svg>
              {formatCount(videoStats.concurrent_viewers)}
            </span>
          )}
          <span className="flex items-center gap-1.5" title="Total views">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
            {formatCount(videoStats.view_count)}
          </span>
          <span className="flex items-center gap-1.5" title="Likes">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 10h4.764a2 2 0 011.789 2.894l-3.5 7A2 2 0 0115.263 21h-4.017c-.163 0-.326-.02-.485-.06L7 20m7-10V5a2 2 0 00-2-2h-.095c-.5 0-.905.405-.905.905 0 .714-.211 1.412-.608 2.006L7 11v9m7-10h-2M7 20H5a2 2 0 01-2-2v-6a2 2 0 012-2h2.5" /></svg>
            {formatCount(videoStats.like_count)}
          </span>
        </>
      )}
      {channelStats && !channelStats.hidden_subscriber_count && (
        <span className="flex items-center gap-1.5 ml-auto" title="Subscribers">
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
          {formatCount(channelStats.subscriber_count)}
        </span>
      )}
    </div>
  )
}

// ---- Auto-scroll hook ----
function useAutoScroll(ref: React.RefObject<HTMLDivElement | null>, isActive: boolean, frozen?: boolean) {
  useEffect(() => {
    if (!isActive || frozen) return
    const el = ref.current
    if (!el) return

    el.scrollTop = 0
    let animId: number
    let lastTime = 0
    let accumulated = 0
    const SPEED = 30 // px per second
    let paused = false
    let pauseTimer: ReturnType<typeof setTimeout>

    const tick = (time: number) => {
      if (paused) return
      const currentEl = ref.current
      if (!currentEl) return
      // Wait for scrollable content
      if (currentEl.scrollHeight <= currentEl.clientHeight + 1) {
        lastTime = 0
        accumulated = 0
        animId = requestAnimationFrame(tick)
        return
      }
      if (lastTime === 0) lastTime = time
      const dt = time - lastTime
      lastTime = time
      // Accumulate fractional pixels (scrollTop is integer-only)
      accumulated += (SPEED * dt) / 1000
      if (accumulated >= 1) {
        const px = Math.floor(accumulated)
        accumulated -= px
        currentEl.scrollTop += px
      }
      if (currentEl.scrollTop >= currentEl.scrollHeight - currentEl.clientHeight - 1) {
        paused = true
        pauseTimer = setTimeout(() => {
          if (!ref.current) return
          ref.current.scrollTop = 0
          paused = false
          lastTime = 0
          accumulated = 0
          animId = requestAnimationFrame(tick)
        }, 3000)
        return
      }
      animId = requestAnimationFrame(tick)
    }

    const startTimer = setTimeout(() => {
      animId = requestAnimationFrame(tick)
    }, 2000)

    return () => {
      clearTimeout(startTimer)
      clearTimeout(pauseTimer)
      cancelAnimationFrame(animId)
    }
  }, [isActive, frozen])
}

const HIDDEN_SCROLLBAR: React.CSSProperties = { scrollbarWidth: 'none' }

export default function YouTubeLiveToolView() {
  const { init, cleanup, activeTab, setActiveTab, cyclePaused, toggleCyclePause, settings } = useYouTubeLiveStore()
  const prevTabRef = useRef(activeTab)
  const ideasRef = useRef<HTMLDivElement>(null)
  const slotsRef = useRef<HTMLDivElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const enabledPages = useMemo(() => getEnabledPages(settings), [settings])

  useAutoScroll(ideasRef, activeTab === 'ideas', cyclePaused)
  useAutoScroll(slotsRef, activeTab === 'slots', cyclePaused)

  useEffect(() => {
    init()
    return () => cleanup()
  }, [])

  // If current tab is disabled, switch to the first enabled page
  useEffect(() => {
    if (enabledPages.length > 0 && !enabledPages.includes(activeTab)) {
      setActiveTab(enabledPages[0])
    }
  }, [enabledPages, activeTab, setActiveTab])

  // Keyboard shortcuts: Space = play/pause, Arrow keys = switch pages
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return
      if (e.code === 'Space' && !e.repeat) {
        e.preventDefault()
        toggleCyclePause()
      } else if (e.code === 'ArrowLeft' && !e.repeat) {
        e.preventDefault()
        const idx = enabledPages.indexOf(activeTab)
        setActiveTab(enabledPages[(idx - 1 + enabledPages.length) % enabledPages.length])
      } else if (e.code === 'ArrowRight' && !e.repeat) {
        e.preventDefault()
        const idx = enabledPages.indexOf(activeTab)
        setActiveTab(enabledPages[(idx + 1) % enabledPages.length])
      }
    }
    el.addEventListener('keydown', handleKeyDown)
    return () => el.removeEventListener('keydown', handleKeyDown)
  }, [toggleCyclePause, activeTab, setActiveTab, enabledPages])

  useEffect(() => {
    prevTabRef.current = activeTab
  }, [activeTab])

  const getPageTransform = (page: PageTab) => {
    if (page === activeTab) return 'translateX(0)'
    const currentIdx = enabledPages.indexOf(activeTab)
    const pageIdx = enabledPages.indexOf(page)
    return pageIdx < currentIdx ? 'translateX(-30px)' : 'translateX(30px)'
  }

  return (
    <div ref={containerRef} tabIndex={-1} className="h-full flex flex-col bg-vibe-bg relative outline-none">
      {/* Alert Overlay */}
      <AlertOverlay />

      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-vibe-border/50">
        <ConnectionDot />
        <PageIndicator />
        <button
          onClick={async () => { try { await youtubeLiveApi.openSettingsWindow() } catch {} }}
          className="p-1 text-vibe-muted/30 hover:text-vibe-muted rounded transition-colors"
          title="Settings"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* Live Stats Bar */}
      <LiveStatsBar />

      {/* Cycle Progress Bar */}
      <CycleProgressBar />

      {/* Page-specific Command Banner */}
      <div className="px-4 pt-3">
        <CommandBanner page={activeTab} />
      </div>

      {/* Content - page transitions */}
      <div className="flex-1 overflow-hidden relative">
        {/* Goals view */}
        {enabledPages.includes('goals') && (
          <div
            className="absolute inset-0 overflow-y-auto p-4 transition-all duration-500 ease-in-out"
            style={{
              ...HIDDEN_SCROLLBAR,
              opacity: activeTab === 'goals' ? 1 : 0,
              transform: getPageTransform('goals'),
              pointerEvents: activeTab === 'goals' ? 'auto' : 'none',
            }}
          >
            <GoalsOverlay />
          </div>
        )}

        {/* Ideas view */}
        {enabledPages.includes('ideas') && (
          <div
            ref={ideasRef}
            className="absolute inset-0 overflow-y-auto p-4 transition-all duration-500 ease-in-out"
            style={{
              ...HIDDEN_SCROLLBAR,
              opacity: activeTab === 'ideas' ? 1 : 0,
              transform: getPageTransform('ideas'),
              pointerEvents: activeTab === 'ideas' ? 'auto' : 'none',
            }}
          >
            <IdeasOverlay />
          </div>
        )}

        {/* Slots view */}
        {enabledPages.includes('slots') && (
          <div
            ref={slotsRef}
            className="absolute inset-0 overflow-y-auto transition-all duration-500 ease-in-out"
            style={{
              ...HIDDEN_SCROLLBAR,
              opacity: activeTab === 'slots' ? 1 : 0,
              transform: getPageTransform('slots'),
              pointerEvents: activeTab === 'slots' ? 'auto' : 'none',
            }}
          >
            <SlotMachine />
          </div>
        )}

        {/* Leaderboard view */}
        <div
          className="absolute inset-0 p-4 flex flex-col transition-all duration-500 ease-in-out"
          style={{
            opacity: activeTab === 'leaderboard' ? 1 : 0,
            transform: getPageTransform('leaderboard'),
            pointerEvents: activeTab === 'leaderboard' ? 'auto' : 'none',
          }}
        >
          <LeaderboardOverlay />
        </div>

        {/* Messages view */}
        <div
          className="absolute inset-0 p-4 flex flex-col transition-all duration-500 ease-in-out"
          style={{
            opacity: activeTab === 'messages' ? 1 : 0,
            transform: getPageTransform('messages'),
            pointerEvents: activeTab === 'messages' ? 'auto' : 'none',
          }}
        >
          <MessagesOverlay />
        </div>

        {/* Subscribers view */}
        <div
          className="absolute inset-0 overflow-y-auto p-4 transition-all duration-500 ease-in-out"
          style={{
            ...HIDDEN_SCROLLBAR,
            opacity: activeTab === 'subscribers' ? 1 : 0,
            transform: getPageTransform('subscribers'),
            pointerEvents: activeTab === 'subscribers' ? 'auto' : 'none',
          }}
        >
          <SubscribersOverlay />
        </div>

        {/* Polls view */}
        {enabledPages.includes('polls') && (
          <div
            className="absolute inset-0 overflow-y-auto p-4 transition-all duration-500 ease-in-out"
            style={{
              ...HIDDEN_SCROLLBAR,
              opacity: activeTab === 'polls' ? 1 : 0,
              transform: getPageTransform('polls'),
              pointerEvents: activeTab === 'polls' ? 'auto' : 'none',
            }}
          >
            <PollsOverlay />
          </div>
        )}

        {/* Points info view */}
        <div
          className="absolute inset-0 overflow-y-auto p-4 transition-all duration-500 ease-in-out"
          style={{
            ...HIDDEN_SCROLLBAR,
            opacity: activeTab === 'points' ? 1 : 0,
            transform: getPageTransform('points'),
            pointerEvents: activeTab === 'points' ? 'auto' : 'none',
          }}
        >
          <PointsInfoOverlay />
        </div>
      </div>
    </div>
  )
}
