/**
 * `youtube-shorts` — a YouTube Shorts player tile with auto-scroll, skip and volume
 * (first-party, optional: not bundled). No sidecar, no YouTube API key: it is the
 * YouTube mobile site in a child webview (`native:webview`).
 *
 * Contributions: tile `player` (./ShortsTile.tsx) and commands to drive it while the
 * video covers the tile (next, auto-scroll, mute, controls).
 */
import { definePlugin, type TileProps } from '@quadflow/plugin-api'
import { bindLog, next, toggleAuto, toggleMute, useShorts } from './model'
import { ShortsTile, setControlsOpen } from './ShortsTile'
import './styles.css'

function Player(props: TileProps) {
  bindLog(props.ctx)
  return (
    <div className="qf-youtube-shorts">
      <ShortsTile {...props} />
    </div>
  )
}

export default definePlugin({
  tiles: { player: Player },
  commands: {
    next: () => next(),
    'toggle-auto-scroll': () => toggleAuto(),
    'toggle-mute': () => toggleMute(),
    'toggle-controls': (ctx) => setControlsOpen(ctx, !useShorts.getState().controlsOpen),
  },
})
