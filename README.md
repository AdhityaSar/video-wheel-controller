# Video Wheel Controller

A userscript that turns the mouse wheel over any HTML5 video into a 3×3 grid of controls: playback rate on the left, seeking and navigation in the middle, volume on the right — plus frame stepping, chapter/video jumping, and `F` for fullscreen.

Works on every site (`@match *://*/*`), no page hooks, no external requests, nothing stored.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open [`video-wheel-controller.user.js`](video-wheel-controller.user.js) and confirm the install.

## The 3×3 wheel grid

Point at the video and scroll. Which cell the cursor is in decides what the wheel does. Columns and rows are thirds of the **video content box** — letterbox bars are ignored, so a 4:3 clip inside a 16:9 player still divides the picture, not the black bars.

|  | Left third | Middle third | Right third |
|---|---|---|---|
| **Top row** | playback rate ±0.5 | seek ±5% of duration | volume ±0.10 |
| **Middle row** | playback rate ±0.25 | seek ±5 s | volume ±0.05 |
| **Bottom row** | playback rate ±0.1 | seek ±1 s | volume ±0.01 |

Playback rate is clamped to 0.1×–16×; volume to 0–1. Scrolling up increases, scrolling down decreases. Raising volume out of a mute state unmutes the video.

### Middle third + right mouse button

Hold RMB and scroll in the middle column for the actions that don't fit on a plain scroll:

| Middle third + RMB | Scroll up | Scroll down |
|---|---|---|
| **Top row** | next video | previous video |
| **Middle row** | next chapter | previous chapter |
| **Bottom row** | next frame | previous frame |

The frame step uses the real frame duration, measured with `requestVideoFrameCallback`, and falls back to 30 fps when the browser can't measure it. The page's context menu is suppressed only for the video you actually scrolled on, and only for 1.5 s afterwards.

On the left and right columns RMB is not a modifier — rate and volume behave the same with or without it.

## Keyboard

| Key | Action |
|---|---|
| `→` / `←` | seek ±5 s |
| `Shift` + `→` / `←` | seek ±1 s |
| `Ctrl` + `→` / `←` | seek ±60 s |
| `F` | fullscreen toggle (page's own handler wins when it has one) |

Keyboard handling is skipped while typing in an input, textarea, or contenteditable, and `Alt`/`Meta` combinations are left to the browser and OS.

## Behaviour you might not expect

- **Trackpads are normalised.** A flick emits dozens of tiny wheel events; they accumulate until they equal one deliberate notch (50 px), so one flick is one step, not twenty. Direction flips and pauses longer than 400 ms reset the accumulation.
- **Scrollable panels keep scrolling.** A playlist, comment column, or live chat drawn over the video scrolls natively instead of being captured.
- **Overlay controls still work.** Clicking the page's own control bar over the video is not hijacked.
- **Multiple videos are handled per-video.** The wheel targets the video under the cursor, not the first `<video>` in the DOM; hidden preload elements are skipped.
- **Impossible actions don't swallow the scroll.** At 0 volume, at the end of the video, or with no next video, the page scrolls as normal.
- **Live streams / DVR** fall back to the seekable range when `duration` is `Infinity`.

## Configuration

All tunables live in the `CONFIG` object at the top of the script: zone boundaries, per-row step sizes, rate bounds, wheel normalisation, frame-probe limits, and the RMB menu window. Edit and reload.

## Development

```sh
node verify.js
```

`verify.js` runs the script inside a mini DOM (rectangles, computed styles, `elementFromPoint` hit-testing) and drives it with synthetic wheel and keyboard events — 105 assertions covering zone mapping, per-video targeting, overlays, letterboxing, trackpad accumulation, and media-helper edge cases.

`test.html` is a manual harness: open it in a browser, load a local video (or generate the built-in 10 s demo clip), toggle the grid overlay, and watch live state in the side panel.

## License

GNU General Public License v3.0 or later — see [LICENSE](LICENSE).
