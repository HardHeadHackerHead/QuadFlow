import { useEffect, useState, useRef, useCallback, useMemo } from 'react'
import { useYouTubeLiveStore } from './store'
import type { SlotPull, YouTubeUserStats } from './types'
import { avatarColor } from './avatar'

// Fallback emojis used when DB symbols haven't loaded yet
const FALLBACK_SYMBOL_EMOJIS: Record<string, string> = {
  cherry: '\uD83C\uDF52',
  lemon: '\uD83C\uDF4B',
  orange: '\uD83C\uDF4A',
  plum: '\uD83E\uDED0',
  bell: '\uD83D\uDD14',
  bar: '\uD83C\uDF2D',
  seven: '7\uFE0F\u20E3',
}

function getEmoji(symbol: string, symbolMap: Record<string, string>): string {
  return symbolMap[symbol] || FALLBACK_SYMBOL_EMOJIS[symbol] || symbol
}

function PointsBadge({ points_change, size = 'sm' }: { points_change: number | null | undefined; size?: 'sm' | 'lg' }) {
  if (points_change == null) return null
  const isPositive = points_change > 0
  const sizeClass = size === 'lg' ? 'text-sm px-3 py-1' : 'text-xs px-2 py-0.5'
  return (
    <span className={`font-bold rounded-full ${sizeClass} ${
      isPositive
        ? 'bg-green-500/20 text-green-400 border border-green-500/30'
        : 'bg-red-500/20 text-red-400 border border-red-500/30'
    }`}>
      {isPositive ? '+' : ''}{points_change}
    </span>
  )
}

const MEDALS = ['\uD83E\uDD47', '\uD83E\uDD48', '\uD83E\uDD49']

type AnimationPhase = 'idle' | 'spinning' | 'revealing' | 'result'

// --- Chase lights for the cabinet header ---
const LIGHT_COLORS = ['#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#a855f7']

function ChaseLights({ active, jackpot, side }: { active: boolean; jackpot: boolean; side: 'left' | 'right' }) {
  return (
    <div className="flex items-center gap-1.5">
      {LIGHT_COLORS.map((color, i) => {
        const idx = side === 'right' ? LIGHT_COLORS.length - 1 - i : i
        return (
          <div
            key={i}
            className="w-2 h-2 rounded-full"
            style={{
              backgroundColor: jackpot ? '#facc15' : color,
              opacity: active ? undefined : 0.2,
              animationName: active ? 'cabinetLights' : 'none',
              animationDuration: active ? '0.6s' : undefined,
              animationTimingFunction: active ? 'ease-in-out' : undefined,
              animationIterationCount: active ? 'infinite' : undefined,
              animationDelay: active ? `${idx * 0.1}s` : '0s',
            }}
          />
        )
      })}
    </div>
  )
}

// --- Payline indicator ---
function PaylineIndicator({ active, jackpot }: { active: boolean; jackpot: boolean }) {
  const color = jackpot ? 'rgba(250,204,21,0.8)' : 'rgba(239,68,68,0.7)'
  return (
    <div
      className={`absolute left-0 right-0 top-1/2 -translate-y-1/2 z-20 pointer-events-none flex items-center ${active ? 'animate-paylinePulse' : ''}`}
      style={{ opacity: active ? undefined : 0.5 }}
    >
      {/* Left arrow */}
      <div
        className="w-0 h-0 flex-shrink-0"
        style={{
          borderTop: '6px solid transparent',
          borderBottom: '6px solid transparent',
          borderLeft: `8px solid ${color}`,
        }}
      />
      {/* Line */}
      <div className="flex-1 h-[2px]" style={{ backgroundColor: color }} />
      {/* Right arrow */}
      <div
        className="w-0 h-0 flex-shrink-0"
        style={{
          borderTop: '6px solid transparent',
          borderBottom: '6px solid transparent',
          borderRight: `8px solid ${color}`,
        }}
      />
    </div>
  )
}

// --- Vertical reel strip ---
const CELL_HEIGHT = 60
const REEL_DURATIONS = [1200, 1800, 2400]
const REEL_STRIP_LENGTHS = [15, 22, 30]

function buildReelStrip(targetSymbol: string, length: number, allSymbols: string[]): string[] {
  const symbols = allSymbols.length > 0 ? allSymbols : Object.keys(FALLBACK_SYMBOL_EMOJIS)
  const strip: string[] = []
  for (let i = 0; i < length - 1; i++) {
    strip.push(symbols[Math.floor(Math.random() * symbols.length)])
  }
  // Target symbol — the reel will stop with this in the center
  strip.push(targetSymbol)
  // One more symbol below the payline ("what they almost got next")
  strip.push(symbols[Math.floor(Math.random() * symbols.length)])
  return strip
}

function ReelStrip({
  finalSymbol,
  reelIndex,
  phase,
  onRevealed,
  spinKey,
  allSymbols,
  symbolMap,
  wildNames,
  rarityTiers,
  isNearMiss,
}: {
  finalSymbol: string
  reelIndex: number
  phase: AnimationPhase
  onRevealed: () => void
  spinKey: string
  allSymbols: string[]
  symbolMap: Record<string, string>
  wildNames: Set<string>
  rarityTiers: Record<string, 'gold' | 'purple' | 'common'>
  isNearMiss?: boolean
}) {
  const stripLength = REEL_STRIP_LENGTHS[reelIndex]
  const duration = REEL_DURATIONS[reelIndex]

  // Generate the strip of symbols once per spin
  const strip = useMemo(
    () => buildReelStrip(finalSymbol, stripLength, allSymbols),
    [spinKey, finalSymbol, stripLength, allSymbols]
  )

  const [offset, setOffset] = useState(0)
  const [transitioning, setTransitioning] = useState(false)
  const [landed, setLanded] = useState(false)
  const stripRef = useRef<HTMLDivElement>(null)
  const fallbackRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const revealedRef = useRef(false)

  // The target is at index (strip.length - 2) — second to last, with one "near miss"
  // symbol below it. We center it in the visible window (3 rows, center = row index 1).
  // So the translateY target = -((strip.length - 2) - 1) * CELL_HEIGHT
  const targetOffset = (strip.length - 3) * CELL_HEIGHT

  // Reset when a new spin starts
  useEffect(() => {
    if (phase === 'spinning') {
      revealedRef.current = false
      setLanded(false)
      setOffset(0)
      setTransitioning(false)

      // Small delay to ensure browser paints at position 0 before transitioning
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          setTransitioning(true)
          setOffset(targetOffset)
        })
      })

      // Fallback timeout in case transitionend doesn't fire
      fallbackRef.current = setTimeout(() => {
        if (!revealedRef.current) {
          revealedRef.current = true
          setLanded(true)
          setTransitioning(false)
          onRevealed()
        }
      }, duration + 200)
    }

    return () => {
      if (fallbackRef.current) {
        clearTimeout(fallbackRef.current)
        fallbackRef.current = null
      }
    }
  }, [phase, spinKey])

  const handleTransitionEnd = useCallback(() => {
    if (!revealedRef.current) {
      revealedRef.current = true
      setLanded(true)
      setTransitioning(false)
      if (fallbackRef.current) {
        clearTimeout(fallbackRef.current)
        fallbackRef.current = null
      }
      onRevealed()
    }
  }, [onRevealed])

  // For idle/result without a spin, show static symbols
  const isActive = phase === 'spinning' || phase === 'revealing'

  return (
    <div className="flex-1 relative">
      <div
        className={`h-[${CELL_HEIGHT * 3}px] overflow-hidden relative`}
        style={{ height: CELL_HEIGHT * 3 }}
      >
        {isActive || landed ? (
          <div
            ref={stripRef}
            onTransitionEnd={handleTransitionEnd}
            style={{
              transform: `translateY(-${offset}px)`,
              transition: transitioning
                ? `transform ${duration}ms cubic-bezier(0.12, 0.8, 0.3, 1)`
                : 'none',
            }}
          >
            {strip.map((sym, i) => {
              const rarity = rarityTiers[sym]
              const rarityClass = wildNames.has(sym) ? 'animate-wildShimmer' : rarity === 'gold' ? 'animate-rarityGold' : rarity === 'purple' ? 'animate-rarityPurple' : ''
              return (
                <div
                  key={i}
                  className="flex items-center justify-center"
                  style={{ height: CELL_HEIGHT }}
                >
                  <span className={`text-4xl rounded-lg ${rarityClass}`}>
                    {getEmoji(sym, symbolMap)}
                  </span>
                </div>
              )
            })}
          </div>
        ) : (
          // Static display: show the final symbol centered
          <div>
            <div className="flex items-center justify-center" style={{ height: CELL_HEIGHT }}>
              <span className="text-4xl opacity-30">{getEmoji(allSymbols[0] || 'cherry', symbolMap)}</span>
            </div>
            <div className="flex items-center justify-center" style={{ height: CELL_HEIGHT }}>
              <span className={`text-4xl rounded-lg ${phase === 'result' ? 'opacity-100' : 'opacity-30'} ${wildNames.has(finalSymbol) && phase === 'result' ? 'animate-wildShimmer' : phase === 'result' && rarityTiers[finalSymbol] === 'gold' ? 'animate-rarityGold' : phase === 'result' && rarityTiers[finalSymbol] === 'purple' ? 'animate-rarityPurple' : ''}`}>
                {getEmoji(finalSymbol, symbolMap)}
              </span>
            </div>
            <div className="flex items-center justify-center" style={{ height: CELL_HEIGHT }}>
              <span className="text-4xl opacity-30">{getEmoji(allSymbols[2] || 'bell', symbolMap)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Reel land bounce */}
      {landed && (
        <div className="absolute inset-0 pointer-events-none animate-reelLand" />
      )}
      {/* Near-miss flash */}
      {isNearMiss && (
        <div className="absolute inset-0 pointer-events-none animate-nearMissFlash rounded-lg" />
      )}
    </div>
  )
}

// --- Avatar with image fallback (matches leaderboard/messages pages) ---
function PullAvatar({ src, name, size = 'w-8 h-8', ring, textSize = 'text-xs' }: {
  src?: string
  name: string
  size?: string
  ring?: string
  textSize?: string
}) {
  const [failed, setFailed] = useState(false)

  if (src && !failed) {
    return (
      <img
        src={src}
        alt={name}
        className={`${size} rounded-full flex-shrink-0 ${ring || ''}`}
        onError={() => setFailed(true)}
      />
    )
  }

  return (
    <div className={`${size} rounded-full flex items-center justify-center flex-shrink-0 ${ring || ''} ${avatarColor(name)}`}>
      <span className={`${textSize} font-bold text-white`}>{name.charAt(0).toUpperCase()}</span>
    </div>
  )
}

// --- Cabinet-framed active pull display ---
const RESULT_DISPLAY_MS = 8000

function ActivePullDisplay({ pull, profileImage, spinReady, onComplete, allSymbols, symbolMap, wildNames, rarityTiers }: { pull: SlotPull; profileImage?: string; spinReady: boolean; onComplete?: () => void; allSymbols: string[]; symbolMap: Record<string, string>; wildNames: Set<string>; rarityTiers: Record<string, 'gold' | 'purple' | 'common'> }) {
  const [phase, setPhase] = useState<AnimationPhase>('idle')
  const [revealedCount, setRevealedCount] = useState(0)
  const pullIdRef = useRef(pull.id)
  const [spinKey, setSpinKey] = useState(pull.id)
  const [waitingForSpin, setWaitingForSpin] = useState(false)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  // When a new pull arrives, prepare to spin but wait for spinReady
  useEffect(() => {
    if (pull.id !== pullIdRef.current) {
      pullIdRef.current = pull.id
      setRevealedCount(0)
      setSpinKey(pull.id)
      if (spinReady) {
        setPhase('spinning')
        setWaitingForSpin(false)
      } else {
        setPhase('idle')
        setWaitingForSpin(true)
      }
    } else if (phase === 'idle' && !waitingForSpin) {
      setRevealedCount(0)
      setSpinKey(pull.id)
      setPhase('spinning')
    }
  }, [pull.id])

  // Start spinning once TTS begins playing
  useEffect(() => {
    if (waitingForSpin && spinReady) {
      setWaitingForSpin(false)
      setPhase('spinning')
    }
  }, [spinReady, waitingForSpin])

  useEffect(() => {
    if (revealedCount >= 3 && phase !== 'result') {
      setPhase('result')
    }
  }, [revealedCount, phase])

  // Auto-advance queue after result is displayed for RESULT_DISPLAY_MS
  useEffect(() => {
    if (phase === 'result' && onCompleteRef.current) {
      const timer = setTimeout(() => onCompleteRef.current?.(), RESULT_DISPLAY_MS)
      return () => clearTimeout(timer)
    }
  }, [phase, spinKey])

  const handleRevealed = useCallback(() => {
    setRevealedCount((prev) => prev + 1)
  }, [])

  const isJackpotResult = pull.is_jackpot && phase === 'result'
  const isSpinning = phase === 'spinning' || phase === 'revealing'
  const hasPartialMatch = pull.symbols[0] === pull.symbols[1] || pull.symbols[1] === pull.symbols[2] || pull.symbols[0] === pull.symbols[2]
  // Near-miss: find the odd-one-out reel index when 2 match but not a triple
  const nearMissReelIndex = (!pull.is_jackpot && hasPartialMatch && phase === 'result')
    ? (pull.symbols[0] === pull.symbols[1] ? 2 : pull.symbols[1] === pull.symbols[2] ? 0 : 1)
    : -1
  // Determine if this is a rare symbol triple (for epic win animation)
  const isRareTriple = isJackpotResult && pull.symbols[0] && (rarityTiers[pull.symbols[0]] === 'gold' || rarityTiers[pull.symbols[0]] === 'purple')
  // Progressive jackpot win detection
  const isProgressiveWin = isJackpotResult && pull.progressive_pool != null && pull.progressive_pool > 0 && pull.match_type === 'progressive'

  // Win animation class
  const winAnimClass = isProgressiveWin ? 'animate-progressiveWin' : isRareTriple ? 'animate-epicWin' : isJackpotResult ? 'animate-jackpotGlow' : hasPartialMatch && phase === 'result' ? 'animate-winGlow' : ''

  return (
    <div className={winAnimClass}>
      {/* Metallic cabinet border */}
      <div className={`
        rounded-2xl p-[2px]
        ${isJackpotResult
          ? 'bg-gradient-to-b from-yellow-400 via-yellow-600 to-yellow-400'
          : 'bg-gradient-to-b from-gray-500 via-gray-700 to-gray-500'}
      `}>
        <div className="bg-gray-900 rounded-2xl overflow-hidden">
          {/* Cabinet Header */}
          <div className={`
            flex items-center justify-between px-4 py-2.5 border-b
            ${isJackpotResult
              ? 'border-yellow-500/30 bg-gradient-to-r from-yellow-900/30 via-gray-900 to-yellow-900/30'
              : 'border-gray-800 bg-gray-950'}
          `}>
            <ChaseLights active={isSpinning || isJackpotResult} jackpot={isJackpotResult} side="left" />
            <div className="flex flex-col items-center gap-0.5">
              <span className={`text-xs font-bold tracking-[0.2em] uppercase ${isJackpotResult ? 'text-yellow-400' : 'text-gray-400'}`}>
                Slot Machine
              </span>
              {/* Status badges row */}
              <div className="flex items-center gap-1.5">
                {pull.is_free_spin && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 animate-pulse">
                    FREE SPIN{pull.free_spins_remaining != null && pull.free_spins_remaining > 0 ? ` (${pull.free_spins_remaining} left)` : ''}
                  </span>
                )}
                {pull.progressive_pool != null && pull.progressive_pool > 0 && (
                  <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-500/20 text-amber-400 border border-amber-500/30">
                    {'\uD83C\uDFC6'} {pull.progressive_pool}
                  </span>
                )}
              </div>
            </div>
            <ChaseLights active={isSpinning || isJackpotResult} jackpot={isJackpotResult} side="right" />
          </div>

          {/* Reel Window */}
          <div className="px-4 py-4">
            <div className="relative rounded-xl bg-gradient-to-b from-gray-950 to-black border border-gray-700/50 shadow-[inset_0_4px_16px_rgba(0,0,0,0.8)] overflow-hidden">
              {/* Top/bottom gradient fade */}
              <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-gray-950/90 to-transparent z-10 pointer-events-none" />
              <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-gray-950/90 to-transparent z-10 pointer-events-none" />

              {/* Payline */}
              <PaylineIndicator active={isSpinning} jackpot={isJackpotResult} />

              {/* Reels with metal dividers */}
              <div className="flex items-stretch" style={{ height: CELL_HEIGHT * 3 }}>
                {pull.symbols.map((symbol, i) => (
                  <div key={i} className="flex flex-1">
                    {i > 0 && (
                      <div className="w-[1px] bg-gradient-to-b from-transparent via-gray-600/40 to-transparent flex-shrink-0" />
                    )}
                    <ReelStrip
                      finalSymbol={symbol}
                      reelIndex={i}
                      phase={phase}
                      onRevealed={handleRevealed}
                      spinKey={spinKey}
                      allSymbols={allSymbols}
                      symbolMap={symbolMap}
                      wildNames={wildNames}
                      rarityTiers={rarityTiers}
                      isNearMiss={nearMissReelIndex === i}
                    />
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Info Panel */}
          <div className={`
            px-4 py-3 border-t flex items-center gap-3
            ${isJackpotResult
              ? 'border-yellow-500/30 bg-gradient-to-r from-yellow-500/10 via-yellow-500/20 to-yellow-500/10'
              : 'border-gray-800 bg-gray-900/50'}
          `}>
            {/* Player avatar + name */}
            <PullAvatar
              src={profileImage}
              name={pull.author_name}
              size="w-8 h-8"
              ring={`ring-2 ring-offset-1 ring-offset-gray-900 ${isJackpotResult ? 'ring-yellow-500/50' : 'ring-gray-700'}`}
            />
            <div className="flex-1 min-w-0">
              <span className={`text-sm font-semibold truncate block ${isJackpotResult ? 'text-yellow-300' : 'text-white'}`}>
                {pull.author_name}
              </span>
              {phase === 'result' && (
                <span className="text-[10px] text-gray-500 block">
                  {pull.new_balance != null ? `${pull.new_balance} pts remaining` : ''}
                </span>
              )}
            </div>

            {/* Result text */}
            <div className="text-center flex-shrink-0">
              {phase === 'result' ? (
                pull.is_jackpot ? (
                  <div className="animate-jackpotBurst">
                    <p className="text-lg font-black text-yellow-400 animate-goldPulse leading-tight">
                      {pull.match_type === 'triple_specific' ? `JACKPOT!` : 'JACKPOT!'}
                    </p>
                    <p className="text-[10px] text-yellow-500/70">
                      {pull.prize_name ? (
                        <>
                          {pull.prize_log_id && <span className="mr-0.5">{'\uD83C\uDF81'}</span>}
                          {pull.prize_name}
                        </>
                      ) : (
                        <>Triple {getEmoji(pull.symbols[0], symbolMap)}</>
                      )}
                      {pull.points_change != null && pull.points_change > 0 && (
                        <span className="ml-1 font-bold">+{pull.points_change}</span>
                      )}
                    </p>
                  </div>
                ) : (pull.match_type === 'partial' && pull.prize_name) ? (
                  <div>
                    <p className="text-xs text-blue-400/80 font-medium">Partial Match!</p>
                    <p className="text-[10px] text-blue-400/60">
                      {pull.prize_name}
                      {pull.points_change != null && pull.points_change > 0 && (
                        <span className="ml-1 font-bold">+{pull.points_change}</span>
                      )}
                    </p>
                  </div>
                ) : hasPartialMatch ? (
                  <p className="text-xs text-blue-400/80 font-medium">Partial match!</p>
                ) : (
                  <p className="text-xs text-gray-500">No match</p>
                )
              ) : isSpinning ? (
                <p className="text-xs text-gray-500 animate-pulse">Spinning...</p>
              ) : null}
            </div>

            {/* Free spins won badge */}
            {phase === 'result' && pull.free_spins_won != null && pull.free_spins_won > 0 && (
              <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 animate-pulse">
                +{pull.free_spins_won} Free Spin{pull.free_spins_won > 1 ? 's' : ''}!
              </span>
            )}
            {/* Points badge */}
            {phase === 'result' && <PointsBadge points_change={pull.points_change} size="lg" />}
          </div>
        </div>
      </div>
    </div>
  )
}

// Compact pull card for the recent list
function PullCard({ pull, rank, profileImage, symbolMap }: { pull: SlotPull; rank: number; profileImage?: string; symbolMap: Record<string, string> }) {
  return (
    <div
      className={`
        flex items-center gap-2 px-3 py-2 rounded-lg transition-colors
        ${pull.is_jackpot
          ? 'bg-yellow-500/10 border border-yellow-500/20'
          : 'bg-gray-800/50 border border-gray-700/30 hover:border-gray-600/50'}
      `}
    >
      <span className="text-[10px] text-gray-600 font-mono w-4 text-right flex-shrink-0">{rank}</span>
      <PullAvatar src={profileImage} name={pull.author_name} size="w-6 h-6" textSize="text-[10px]" />
      <span className="text-xs text-gray-300 truncate flex-1 min-w-0">{pull.author_name}</span>
      <div className="flex gap-0.5 flex-shrink-0">
        {pull.symbols.map((sym, i) => (
          <span key={i} className="text-sm">{getEmoji(sym, symbolMap)}</span>
        ))}
      </div>
      <PointsBadge points_change={pull.points_change} />
      {pull.prize_name && pull.prize_log_id && (
        <span className="text-[10px] text-purple-400 flex-shrink-0" title={pull.prize_name}>{'\uD83C\uDF81'}</span>
      )}
      {pull.is_jackpot && (
        <span className="text-[10px] text-yellow-400 font-black flex-shrink-0">JP!</span>
      )}
    </div>
  )
}

// Leaderboard component with podium-style top 3
export function Leaderboard({ users }: { users: YouTubeUserStats[] }) {
  if (users.length === 0) return null

  const top3 = users.slice(0, 3)
  const rest = users.slice(3)

  const podiumColors = [
    { bg: 'from-yellow-500/15 to-yellow-500/5', border: 'border-yellow-500/30', text: 'text-yellow-400', ring: 'ring-yellow-500/40', badge: 'bg-yellow-500/20 text-yellow-300' },
    { bg: 'from-gray-400/10 to-gray-400/5', border: 'border-gray-400/20', text: 'text-gray-300', ring: 'ring-gray-400/30', badge: 'bg-gray-400/15 text-gray-300' },
    { bg: 'from-amber-700/15 to-amber-700/5', border: 'border-amber-700/25', text: 'text-amber-500', ring: 'ring-amber-600/30', badge: 'bg-amber-700/20 text-amber-400' },
  ]

  return (
    <div className="space-y-3">
      {/* Top 3 podium cards */}
      <div className="space-y-2">
        {top3.map((user, i) => {
          const colors = podiumColors[i]
          return (
            <div
              key={user.author_channel_id}
              className={`
                relative rounded-xl border overflow-hidden
                bg-gradient-to-r ${colors.bg} ${colors.border}
                ${i === 0 ? 'animate-shimmer' : ''}
              `}
            >
              <div className="flex items-center gap-3 px-4 py-3">
                {/* Medal */}
                <span className="text-xl flex-shrink-0">{MEDALS[i]}</span>

                {/* Avatar */}
                {user.profile_image_url ? (
                  <img src={user.profile_image_url} alt={user.author_name} className={`w-9 h-9 rounded-full flex-shrink-0 ring-2 ring-offset-1 ring-offset-gray-900 ${colors.ring}`} />
                ) : (
                  <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ring-2 ring-offset-1 ring-offset-gray-900 ${colors.ring} ${avatarColor(user.author_name)}`}>
                    <span className="text-sm font-bold text-white">{user.author_name.charAt(0).toUpperCase()}</span>
                  </div>
                )}

                {/* Name + stats */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`text-sm font-semibold truncate ${i === 0 ? 'text-yellow-300' : 'text-white'}`}>{user.author_name}</span>
                    {user.is_owner && <span className="text-[10px] flex-shrink-0" title="Owner">👑</span>}
                    {user.is_moderator && <span className="text-[10px] flex-shrink-0" title="Moderator">🛡️</span>}
                    {user.is_member && <span className="text-[10px] flex-shrink-0" title="Member">⭐</span>}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    <span className="text-[10px] text-gray-500">{user.total_pulls} pulls</span>
                    {user.total_jackpots > 0 && (
                      <span className="text-[10px] text-yellow-500/70">{user.total_jackpots} jackpot{user.total_jackpots !== 1 ? 's' : ''}</span>
                    )}
                    {user.total_ideas_submitted > 0 && (
                      <span className="text-[10px] text-purple-400/70">{user.total_ideas_submitted} idea{user.total_ideas_submitted !== 1 ? 's' : ''}</span>
                    )}
                    {user.total_messages > 0 && (
                      <span className="text-[10px] text-gray-500">{user.total_messages} msg{user.total_messages !== 1 ? 's' : ''}</span>
                    )}
                  </div>
                </div>

                {/* Points */}
                <div className="text-right flex-shrink-0">
                  <span className={`text-lg font-black ${colors.text} ${i === 0 ? 'animate-goldPulse' : ''}`}>{user.points.toLocaleString()}</span>
                  <span className="text-[10px] text-gray-500 block">pts</span>
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Remaining players */}
      {rest.length > 0 && (
        <div className="rounded-xl border border-gray-700/30 overflow-hidden bg-gray-800/30">
          {rest.map((user, i) => (
            <div
              key={user.author_channel_id}
              className={`flex items-center gap-3 px-4 py-2.5 ${
                i < rest.length - 1 ? 'border-b border-gray-700/20' : ''
              }`}
            >
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
              <span className="text-[10px] text-gray-600 flex-shrink-0">{user.total_pulls}x</span>
              <span className="text-sm font-semibold text-gray-300 w-16 text-right flex-shrink-0">{user.points.toLocaleString()}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// --- Idle cabinet (no pulls yet) ---
function IdleCabinet({ enabled, commandPrefix, symbolMap, idleSymbols }: { enabled: boolean; commandPrefix: string; symbolMap: Record<string, string>; idleSymbols: string[] }) {
  return (
    <div className="rounded-2xl p-[2px] bg-gradient-to-b from-gray-500 via-gray-700 to-gray-500">
      <div className="bg-gray-900 rounded-2xl overflow-hidden">
        {/* Cabinet Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-gray-800 bg-gray-950">
          <ChaseLights active={false} jackpot={false} side="left" />
          <span className="text-xs font-bold tracking-[0.2em] uppercase text-gray-500">
            Slot Machine
          </span>
          <ChaseLights active={false} jackpot={false} side="right" />
        </div>

        {/* Reel Window — static idle symbols */}
        <div className="px-4 py-4">
          <div className="relative rounded-xl bg-gradient-to-b from-gray-950 to-black border border-gray-700/50 shadow-[inset_0_4px_16px_rgba(0,0,0,0.8)] overflow-hidden">
            <div className="absolute inset-x-0 top-0 h-10 bg-gradient-to-b from-gray-950/90 to-transparent z-10 pointer-events-none" />
            <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-gray-950/90 to-transparent z-10 pointer-events-none" />
            <PaylineIndicator active={false} jackpot={false} />

            <div className="flex items-stretch" style={{ height: CELL_HEIGHT * 3 }}>
              {idleSymbols.map((sym, i) => (
                <div key={i} className="flex flex-1">
                  {i > 0 && (
                    <div className="w-[1px] bg-gradient-to-b from-transparent via-gray-600/40 to-transparent flex-shrink-0" />
                  )}
                  <div className="flex-1 flex items-center justify-center">
                    <span className="text-4xl opacity-20">{getEmoji(sym, symbolMap)}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Info Panel — idle message */}
        <div className="px-4 py-3 border-t border-gray-800 bg-gray-900/50 text-center">
          <p className="text-sm text-gray-400 font-medium">
            {enabled ? 'Waiting for pulls...' : 'Slot machine is disabled'}
          </p>
          {enabled && (
            <p className="text-xs text-gray-600 mt-0.5">
              Type <code className="bg-gray-800 px-1.5 py-0.5 rounded text-blue-400 font-mono text-[11px] border border-gray-700/50">{commandPrefix}</code> in chat
            </p>
          )}
        </div>
      </div>
    </div>
  )
}

export default function SlotMachine() {
  const { slotPulls, slotSpinReady, settings, leaderboard, currentSlotPull, slotPullQueue, advanceSlotQueue, slotSymbols } = useYouTubeLiveStore()
  // Use queue-managed pull if available, otherwise fall back to most recent (static)
  const displayPull = currentSlotPull || (slotPulls.length > 0 ? slotPulls[0] : null)
  const isLive = !!currentSlotPull
  const recentPulls = slotPulls.filter((p) => p.id !== displayPull?.id).slice(0, 19)

  // Engagement features state
  const [symbolOfDay, setSymbolOfDay] = useState<{ name: string; emoji: string; multiplier: number } | null>(null)
  const [slotStats, setSlotStats] = useState<{ total_pulls: number; total_jackpots: number; jackpot_rate: string; biggest_win: number; biggest_winner: string | null; luckiest_user: string | null; luckiest_user_wins: number } | null>(null)
  const [showStats, setShowStats] = useState(false)
  const [isLuckyHour, setIsLuckyHour] = useState(false)

  // Load engagement data
  useEffect(() => {
    const loadEngagement = async () => {
      try {
        if (settings?.slot_symbol_of_day_enabled) {
          const { youtubeLiveApi } = await import('./api')
          const sod = await youtubeLiveApi.getSymbolOfDay()
          if (sod) setSymbolOfDay({ name: sod.symbol_name, emoji: sod.emoji, multiplier: sod.multiplier })
        }
        if (settings?.slot_stats_enabled) {
          const { youtubeLiveApi } = await import('./api')
          const stats = await youtubeLiveApi.getSlotStats()
          setSlotStats(stats)
        }
      } catch { /* ignore */ }
    }
    loadEngagement()
  }, [settings?.slot_symbol_of_day_enabled, settings?.slot_stats_enabled])

  // Check lucky hour status
  useEffect(() => {
    if (!settings?.slot_lucky_hour_enabled) { setIsLuckyHour(false); return }
    const check = () => {
      const now = new Date()
      const hh = String(now.getHours()).padStart(2, '0')
      const mm = String(now.getMinutes()).padStart(2, '0')
      const current = `${hh}:${mm}`
      const start = settings.slot_lucky_hour_start || '20:00'
      const end = settings.slot_lucky_hour_end || '21:00'
      if (start <= end) {
        setIsLuckyHour(current >= start && current < end)
      } else {
        setIsLuckyHour(current >= start || current < end)
      }
    }
    check()
    const interval = setInterval(check, 30000) // check every 30s
    return () => clearInterval(interval)
  }, [settings?.slot_lucky_hour_enabled, settings?.slot_lucky_hour_start, settings?.slot_lucky_hour_end])

  // Build dynamic symbol name -> emoji map from DB symbols
  const { symbolMap, allSymbolNames, wildNames, rarityTiers } = useMemo(() => {
    const map: Record<string, string> = { ...FALLBACK_SYMBOL_EMOJIS }
    const names: string[] = []
    const wilds = new Set<string>()
    const tiers: Record<string, 'gold' | 'purple' | 'common'> = {}
    for (const sym of slotSymbols) {
      map[sym.name] = sym.emoji
      names.push(sym.name)
      if (sym.is_wild) wilds.add(sym.name)
    }
    // Compute rarity tiers based on weight (lower weight = rarer)
    if (slotSymbols.length > 0) {
      const sorted = [...slotSymbols].sort((a, b) => a.weight - b.weight)
      const top20 = Math.max(1, Math.ceil(sorted.length * 0.2))
      const top40 = Math.max(2, Math.ceil(sorted.length * 0.4))
      sorted.forEach((sym, i) => {
        if (i < top20) tiers[sym.name] = 'gold'
        else if (i < top40) tiers[sym.name] = 'purple'
        else tiers[sym.name] = 'common'
      })
    }
    return { symbolMap: map, allSymbolNames: names.length > 0 ? names : Object.keys(FALLBACK_SYMBOL_EMOJIS), wildNames: wilds, rarityTiers: tiers }
  }, [slotSymbols])

  // Pick 3 representative symbols for idle display
  const idleSymbols = useMemo(() => {
    if (allSymbolNames.length >= 3) return [allSymbolNames[0], allSymbolNames[Math.floor(allSymbolNames.length / 2)], allSymbolNames[allSymbolNames.length - 1]]
    return allSymbolNames.slice(0, 3)
  }, [allSymbolNames])

  // Build a lookup map from channel ID to profile image URL
  const profileImages = useMemo(() => {
    const map: Record<string, string> = {}
    for (const user of leaderboard) {
      if (user.profile_image_url) {
        map[user.author_channel_id] = user.profile_image_url
      }
    }
    return map
  }, [leaderboard])

  return (
    <div className="p-4 space-y-4">
      {/* Active pull display */}
      {displayPull ? (
        <div className="relative">
          <ActivePullDisplay
            key={displayPull.id}
            pull={displayPull}
            profileImage={profileImages[displayPull.author_channel_id]}
            spinReady={isLive ? slotSpinReady : true}
            onComplete={isLive ? advanceSlotQueue : undefined}
            allSymbols={allSymbolNames}
            symbolMap={symbolMap}
            wildNames={wildNames}
            rarityTiers={rarityTiers}
          />
          {/* Queue count badge */}
          {slotPullQueue.length > 0 && (
            <div className="absolute -top-2 -right-2 bg-blue-500 text-white text-[10px] font-bold rounded-full w-5 h-5 flex items-center justify-center shadow-lg z-30">
              {slotPullQueue.length}
            </div>
          )}
        </div>
      ) : (
        <IdleCabinet
          enabled={!!settings?.slot_enabled}
          commandPrefix={settings?.slot_command_prefix || '!pull'}
          symbolMap={symbolMap}
          idleSymbols={idleSymbols}
        />
      )}

      {/* Engagement badges row */}
      {(symbolOfDay || isLuckyHour || settings?.progressive_jackpot_enabled) && (
        <div className="flex items-center gap-2 flex-wrap">
          {symbolOfDay && (
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-xs">
              <span>{'\u2B50'}</span>
              <span className="text-amber-400 font-semibold">Symbol of the Day:</span>
              <span className="text-lg leading-none">{symbolOfDay.emoji}</span>
              <span className="text-amber-300 font-bold">{symbolOfDay.multiplier}x</span>
            </div>
          )}
          {isLuckyHour && (
            <div className="flex items-center gap-1 px-2 py-1 rounded-full bg-yellow-500/10 border border-yellow-500/20 text-xs animate-luckyHourPulse">
              <span>{'\uD83C\uDF1F'}</span>
              <span className="text-yellow-400 font-bold">LUCKY HOUR</span>
            </div>
          )}
        </div>
      )}

      {/* Stats panel */}
      {settings?.slot_stats_enabled && (
        <div>
          <button
            onClick={() => { setShowStats(!showStats); }}
            className="text-[10px] text-gray-500 hover:text-gray-300 transition-colors flex items-center gap-1"
          >
            <svg className={`w-3 h-3 transition-transform ${showStats ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            Stats
          </button>
          {showStats && slotStats && (
            <div className="mt-1 p-2 rounded-lg bg-gray-900/50 border border-gray-800 grid grid-cols-3 gap-2 text-center">
              <div>
                <p className="text-[10px] text-gray-500">Total Pulls</p>
                <p className="text-sm font-bold text-white">{slotStats.total_pulls}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500">Jackpots</p>
                <p className="text-sm font-bold text-yellow-400">{slotStats.total_jackpots}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500">Jackpot Rate</p>
                <p className="text-sm font-bold text-blue-400">{slotStats.jackpot_rate}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500">Biggest Win</p>
                <p className="text-sm font-bold text-green-400">{slotStats.biggest_win}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500">Biggest Winner</p>
                <p className="text-xs font-medium text-gray-300 truncate">{slotStats.biggest_winner || '-'}</p>
              </div>
              <div>
                <p className="text-[10px] text-gray-500">Luckiest</p>
                <p className="text-xs font-medium text-gray-300 truncate">{slotStats.luckiest_user || '-'} ({slotStats.luckiest_user_wins})</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Recent pulls */}
      {recentPulls.length > 0 && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-xs text-gray-500 font-semibold uppercase tracking-wider">Recent Pulls</span>
            <span className="text-[10px] text-gray-600">{slotPulls.length} total</span>
          </div>
          <div className="space-y-1 max-h-[300px] overflow-y-auto">
            {recentPulls.map((pull, i) => (
              <PullCard key={pull.id} pull={pull} rank={i + 2} profileImage={profileImages[pull.author_channel_id]} symbolMap={symbolMap} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
