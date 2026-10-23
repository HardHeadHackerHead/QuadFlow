/**
 * Player state shared by the tile and the palette commands (the commands are how the
 * player is controlled while the child webview covers the tile, see ShortsTile.tsx).
 */
import { create } from 'zustand'
import type { ChildWebview, PluginContext } from '@quadflow/plugin-api'

export const SHORTS_URL = 'https://m.youtube.com/shorts'
export const HOME_URL = 'https://m.youtube.com'
/** The mobile layout (vertical feed) needs a phone user agent. */
export const MOBILE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'

export function searchUrl(query: string): string {
  return `https://m.youtube.com/results?search_query=${encodeURIComponent(query.trim() + ' #shorts')}&sp=EgIYAQ%253D%253D`
}

export function volumeScript(volume: number, muted: boolean): string {
  const v = Math.max(0, Math.min(100, volume)) / 100
  return `(function(){var v=document.querySelector('video');if(v){v.volume=${v};v.muted=${muted ? 'true' : 'false'};}})();`
}

/** Next short: YouTube's own button, else ArrowDown, else scroll one screen. */
export const NEXT_SHORT_SCRIPT = `(function(){
  var b=document.querySelector('button[aria-label*="Next"]')||document.querySelector('.navigation-button-down')||document.querySelector('[data-tooltip="Next video"]');
  if(b){b.click();return;}
  var e=new KeyboardEvent('keydown',{key:'ArrowDown',code:'ArrowDown',keyCode:40,which:40,bubbles:true,cancelable:true});
  document.dispatchEvent(e);document.body.dispatchEvent(e);
  var c=document.querySelector('ytm-shorts-player-controller')||document.querySelector('.shorts-video-player-container')||document.querySelector('#player-container')||document.querySelector('ytm-app');
  (c||window).scrollBy({top:window.innerHeight,behavior:'smooth'});
})();`

export function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return mins > 0 ? `${mins}:${secs.toString().padStart(2, '0')}` : `${secs}s`
}

interface ShortsState {
  url: string
  webview: ChildWebview | null
  autoScroll: boolean
  interval: number
  remaining: number
  volume: number
  muted: boolean
  /** Controls shown over the video (registered as an overlay so the webview hides). */
  controlsOpen: boolean
}

export const useShorts = create<ShortsState>(() => ({
  url: SHORTS_URL,
  webview: null,
  autoScroll: false,
  interval: 30,
  remaining: 30,
  volume: 100,
  muted: false,
  controlsOpen: false,
}))

let log: PluginContext['log'] | null = null
export function bindLog(ctx: PluginContext) {
  log = ctx.log
}

export function run(js: string) {
  useShorts.getState().webview?.eval(js).catch((e) => log?.warn('youtube-shorts: eval failed', e))
}

export function applyVolume() {
  const { volume, muted } = useShorts.getState()
  run(volumeScript(volume, muted))
}

/** Videos load lazily: re-apply the volume a few times after a navigation. */
export function applyVolumeSoon() {
  for (const ms of [500, 1000, 1500, 2500, 4000]) setTimeout(applyVolume, ms)
}

export function next() {
  run(NEXT_SHORT_SCRIPT)
  useShorts.setState((s) => ({ remaining: s.interval }))
  setTimeout(applyVolume, 500)
}

export function navigate(url: string) {
  useShorts.setState({ url })
  useShorts.getState().webview?.navigate(url).then(applyVolumeSoon).catch((e) => log?.warn('youtube-shorts: navigate failed', e))
}

export function setVolume(volume: number) {
  useShorts.setState((s) => ({ volume, muted: volume > 0 ? false : s.muted }))
  applyVolume()
}

export function toggleMute() {
  useShorts.setState((s) => ({ muted: !s.muted }))
  applyVolume()
}

export function toggleAuto() {
  useShorts.setState((s) => ({ autoScroll: !s.autoScroll, remaining: s.interval }))
}

export function setIntervalSecs(interval: number) {
  const v = Math.max(5, Math.min(120, interval))
  useShorts.setState({ interval: v, remaining: v })
}

let timer: ReturnType<typeof setInterval> | null = null

/** One 1 s ticker drives the countdown and the auto-scroll (keeps them in step). */
export function startTicker() {
  if (timer) return
  timer = setInterval(() => {
    const s = useShorts.getState()
    if (!s.autoScroll || !s.webview) return
    if (s.remaining <= 1) next()
    else useShorts.setState({ remaining: s.remaining - 1 })
  }, 1000)
}

export function stopTicker() {
  if (timer) clearInterval(timer)
  timer = null
}
