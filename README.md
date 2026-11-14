# Video Wheel Controller

A userscript that turns the mouse wheel over any HTML5 video into a 3×3 grid of controls: playback rate on the left third, seeking and navigation in the middle, volume on the right — plus frame stepping, chapter and next-video jumping, and `F` for fullscreen.

No dependencies, no external requests, nothing stored.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or Violentmonkey).
2. Open [the raw userscript][raw] — the manager sees a `==UserScript==` header and offers to install it.

Updating is manual: reinstall from the same URL. The header has no `@updateURL`/`@downloadURL`, so the manager does not poll for changes.

[raw]: https://raw.githubusercontent.com/AdhityaSar/video-wheel-controller/main/video-wheel-controller.user.js

## The grid

Point at the video and scroll. The third the cursor sits in decides what the wheel does. Rows and columns are measured against the **video content box**, so a 4:3 clip letterboxed inside a 16:9 player divides the picture, not the black bars.

```text
            left 1/3              middle 1/3                right 1/3

 top        rate  ±0.5           seek  ±5% of duration     volume ±0.10
 1/3

 mid        rate  ±0.25          seek  ±5 s                volume ±0.05
 1/3

 bottom     rate  ±0.1           seek  ±1 s                volume ±0.01
 1/3
```

Scroll up to increase, down to decrease. Anything outside the picture — padding, letterbox bars, the surrounding page — is not a control surface.

Rate is clamped to 0.1×–16× and rounded to two decimals; volume is clamped to 0–1 and rounded to two decimals, so the steps compound exactly. Raising volume while muted also unmutes.

## Middle third + right mouse button

Hold RMB and scroll in the middle column for the actions that do not fit on a plain scroll:

| Middle third + RMB | Scroll up | Scroll down |
|---|---|---|
| **Top row** | next video | previous video |
| **Middle row** | next chapter | previous chapter |
| **Bottom row** | next frame | previous frame |

On the left and right thirds RMB is not a modifier: rate and volume behave identically with or without it.

## Keyboard

| Key | Action |
|---|---|
| `→` / `←` | seek ±5 s |
| `Shift` + `→` / `←` | seek ±1 s |
| `Ctrl` + `→` / `←` | seek ±60 s |
| `F` | fullscreen toggle |

The keyboard has no pointer, so it acts on the last hovered video; failing that, the first visible video that is playing; failing that, the first visible video.

Keys are skipped while typing in an input, textarea, `<select>`, or contenteditable — including inside a shadow root. `Alt`/`Meta` combinations (`⌘←` back, `Alt+←`) and `Ctrl`/`Shift` + `F` are left untouched. When a seek or a fullscreen request cannot be performed, the event is not consumed and the page keeps its own behaviour — an arrow at the end of a video still scrolls, and `F` still does whatever the site does with it.

## What works where

| Feature | Scope |
|---|---|
| Wheel grid (rate / seek / volume) | every site — only touches `<video>` properties |
| Keyboard seeking | every site |
| `F` fullscreen | every site; prefers the player wrapper over the bare `<video>` |
| Frame stepping | every site, via `requestVideoFrameCallback` |
| **Next / previous video** | YouTube and Bilibili by player selector; other sites by scanning up to 4 ancestors for a control labelled "next video", "previous video", "next episode" and similar |
| **Next / previous chapter** | **YouTube only**, read from `window.ytInitialPlayerResponse` |

There is no `@noframes`, so controls appear inside embedded players too. Where a page has no previous/next control and no chapter markers, the middle row + RMB does nothing and the page keeps the scroll.

## Behaviour you might not expect

- **Trackpads are normalised.** A flick emits dozens of tiny wheel events. They accumulate into one deliberate notch (50 px), so a flick is one step, not twenty. A direction flip or a pause longer than 400 ms restarts the accumulation, and leftover partial deltas never combine across a pause.
- **Scrollable panels keep scrolling.** A playlist, comment column, or chat drawn over the video scrolls natively instead of being captured.
- **The page's own controls still work.** Scrolling over the player's control bar drives the video rather than being swallowed, and clicking those controls is untouched.
- **Videos are targeted per element.** The wheel acts on the video under the cursor, not the first `<video>` in the DOM. Hidden preload, ad, and thumbnail videos are skipped.
- **Impossible actions release the scroll.** At 0 volume, at the end of the media, or with no next video, the page scrolls as usual.
- **Live streams and DVR** fall back to the seekable range when `duration` is `Infinity`, and the top row falls back to a 5 s step.
- **`Ctrl`/`Cmd` + wheel is never intercepted**, so browser zoom still works. Horizontal-dominant gestures (tilt wheels, `Shift` + wheel) stay native.
- **Above ~4× the audio is silent.** Chrome mutes audio past that point; it is a browser limit, not the script's.
- **The RMB context menu is suppressed** only on the video you actually scrolled, and only for 1.5 s after the gesture — not globally, not permanently.

## Frame stepping

The frame duration is measured with `requestVideoFrameCallback` from `mediaTime` deltas, so the measurement stays valid at any playback rate, and the **median** of up to 20 samples is kept so a single buffering stall cannot skew it. The cache is dropped on `loadstart`/`emptied`; a running probe is cancelled on `pause`/`ended`.

Where the API is unavailable (Safari before 15.4, older Firefox), it falls back to `frameFallbackFps` (30), which is wrong for 24/25/60 fps content until measured. Steps are seeks, so precision is bounded by the browser's seek granularity.

## Configuration

Every tunable lives in the `CONFIG` object at the top of the file: zone boundaries, per-row step sizes, rate and volume bounds, wheel-normalisation thresholds, frame-probe limits, and the RMB menu window. Edit the file and let the manager reload it.

The per-row arrays (`rateSteps`, `volumeSteps`) and the seek values (`seekTopFraction`, `seekMidSeconds`, `seekBottomSeconds`) are indexed by row, so the three rows diverge freely without touching anything else.

## Development

Node.js only; no packages to install.

```sh
node verify.js
```

`verify.js` loads the userscript into a mini DOM — rectangles, computed styles, `elementFromPoint` hit-testing, synthetic wheel and keyboard events — and asserts **105 behaviours** across zone mapping, the exact 1/3 and 2/3 boundaries, clamping, per-video targeting, overlays and scrollable panels, letterboxing, trackpad accumulation, the frame probe, RMB menu suppression, and media-helper edge cases (NaN duration, throwing setters, 0×0 video). The exit code is non-zero on failure, so it drops straight into CI.

`test.html` is a manual harness: open it in a browser, drop in a local video or generate the built-in 10 s clip, and toggle the overlay that draws the zone map to check the labels against where you actually are.

## License

GNU General Public License v3.0 or later — see [LICENSE](LICENSE). The userscript header carries `@license GPL-3.0-or-later`.
