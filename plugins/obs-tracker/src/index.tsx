/**
 * `obs-tracker` — moves an OBS webcam source to follow this tile (first-party, optional:
 * not bundled; Windows-only).
 *
 * Contributions: tile `tracker` (./ObsTrackerTile.tsx, ported from the shell's
 * ObsTrackerToolView). The OBS WebSocket connection (obws) and the DirectShow webcam list
 * live in the Rust sidecar (sidecar/); the OBS password is a plugin secret. The tile's
 * position comes from `ctx.native.tileGeometry` (absolute physical pixels).
 *
 * Windows-only because webcams are enumerated with DirectShow and the sources it creates
 * are OBS `dshow_input`s; macOS (`macos-avcapture`) and Linux (`v4l2_input`) use other
 * input kinds and device properties this tracker does not drive yet.
 */
import { definePlugin, type TileProps } from '@quadflow/plugin-api'
import { bindContext } from './api'
import ObsTrackerTile from './ObsTrackerTile'
import './styles.css'

function Tracker(props: TileProps) {
  bindContext(props.ctx)
  return (
    <div className="qf-obs-tracker">
      <ObsTrackerTile {...props} />
    </div>
  )
}

export default definePlugin({
  activate(ctx) {
    bindContext(ctx)
  },
  tiles: { tracker: Tracker },
})
