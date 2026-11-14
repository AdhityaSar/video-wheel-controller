// ==UserScript==
// @name         Video Wheel Controller
// @namespace    https://github.com/AdhityaSar/video-wheel-controller
// @version      2026-11-14
// @description  Custom video seeking (1s Shift, 5s normal, 1m Ctrl), F key fullscreen, and 3x3 mouse wheel grid controls (playback rate / seek / volume) with RMB frame stepping and video/chapter navigation.
// @author       AdhityaSar
// @license      GPL-3.0-or-later
// @homepageURL  https://github.com/AdhityaSar/video-wheel-controller
// @supportURL   https://github.com/AdhityaSar/video-wheel-controller/issues
// @match        *://*/*
// @run-at       document-end
// @icon         data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    // -------------------------------------------------------------
    // 0. CONFIGURATION (tweak freely)
    // -------------------------------------------------------------
    const CONFIG = {
        // Zone boundaries, relative to the *video content box* (0.0 - 1.0)
        colRateMax: 1 / 3,  // relX < 1/3  -> LEFT   (playback rate)
        colNavMax: 2 / 3,   // relX < 2/3  -> MIDDLE (seek / navigation)
                            // relX >= 2/3 -> RIGHT  (volume)
        rowTopMax: 1 / 3,   // relY < 1/3  -> TOP row
        rowMidMax: 2 / 3,   // relY < 2/3  -> MIDDLE row
                            // relY >= 2/3 -> BOTTOM row

        // LEFT column: playback rate step per row [top, middle, bottom]
        rateSteps: [0.5, 0.25, 0.1],

        // RIGHT column: volume step per row [top, middle, bottom]
        volumeSteps: [0.1, 0.05, 0.01],

        // MIDDLE column (plain scroll = seeking)
        seekTopFraction: 0.05,  // TOP row   : 5% of the video duration
        seekMidSeconds: 5,      // MIDDLE row: 5 seconds
        seekBottomSeconds: 1,   // BOTTOM row: 1 second

        // MIDDLE column BOTTOM row + RMB = frame stepping
        frameFallbackFps: 30,      // used when the real frame rate cannot be measured
        frameProbeSamples: 20,     // frame deltas required before trusting the measurement
        frameProbeTimeoutMs: 8000, // give up (and retry on the next play) after this
        frameProbeMinDelta: 0.001, // 1000 fps ceiling: rejects duplicate/zero deltas
        frameProbeMaxDelta: 0.2,   // 5 fps floor: rejects stalls and seek jumps

        // Playback rate bounds. NOTE: Chrome mutes audio above ~4x, so anything
        // past 4 is effectively silent, video-only fast-forwarding.
        rateMin: 0.1,
        rateMax: 16,

        // Wheel gesture normalisation. A trackpad emits dozens of small events
        // per flick; without accumulation one flick becomes dozens of steps.
        wheelNotchPx: 50,          // delta that counts as one deliberate step
        wheelLinePx: 16,           // deltaMode === 1 (lines) -> px
        wheelPagePx: 100,          // deltaMode === 2 (pages) -> px
        maxStepsPerWheelEvent: 4,
        // A gesture that pauses longer than this is over: its leftover delta
        // must not combine with a later flick into one accidental step.
        wheelGestureGapMs: 400,

        // RMB is a modifier here: suppress the native menu only shortly after an
        // RMB + scroll on the SAME video.
        rmbMenuWindowMs: 1500,

        // getBoundingClientRect cache lifetime (ms)
        boxCacheMs: 120,

        // How many ancestors above the video still count as "player chrome"
        // when deciding whether an overlay belongs to this video.
        overlayAncestorDepth: 4
    };

    // -------------------------------------------------------------
    // 0a. SMALL HELPERS
    // -------------------------------------------------------------
    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    function round2(value) {
        return Math.round(value * 100) / 100;
    }

    function isVideoNode(node) {
        return !!node && node.nodeType === 1 && node.tagName === 'VIDEO';
    }

    function viewOf(el) {
        return (el && el.ownerDocument && el.ownerDocument.defaultView) || window;
    }

    function styleOf(el) {
        try {
            return viewOf(el).getComputedStyle(el);
        } catch (err) {
            return { display: 'block', visibility: 'visible', opacity: '1', objectFit: 'fill', overflowY: 'visible' };
        }
    }

    function isVisible(el) {
        if (!el || typeof el.getBoundingClientRect !== 'function') return false;
        const cs = styleOf(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
        if (Number(cs.opacity) === 0) return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }

    function allVideos() {
        try {
            return document.querySelectorAll('video');
        } catch (err) {
            return [];
        }
    }

    // Returns the real duration, or null for live streams / not-yet-loaded media
    function getDuration(video) {
        const d = video.duration;
        return (typeof d === 'number' && isFinite(d) && d > 0) ? d : null;
    }

    // Seek bounds: prefer the media duration, fall back to the seekable range
    // (DVR / live streams report duration === Infinity).
    function seekBounds(video) {
        const duration = getDuration(video);
        if (duration !== null) return { start: 0, end: duration };

        try {
            const s = video.seekable;
            if (s && s.length) {
                const start = s.start(0);
                const end = s.end(s.length - 1);
                if (isFinite(start) && isFinite(end) && end > start) return { start, end };
            }
        } catch (err) { /* ignore */ }

        return { start: 0, end: null };
    }

    // Returns true only when currentTime actually moved, so the caller can leave
    // the event alone (page scroll / native key behaviour) when nothing happened.
    function seekBy(video, seconds) {
        const current = Number(video.currentTime);
        if (!isFinite(current)) return false;

        const bounds = seekBounds(video);
        let target = current + seconds;
        if (!isFinite(target)) return false;
        if (bounds.end !== null) target = Math.min(target, bounds.end);
        if (target < bounds.start) target = bounds.start;
        if (target === current) return false;

        try {
            video.currentTime = target;
        } catch (err) {
            return false;
        }
        return true;
    }

    function changeRate(video, delta) {
        const next = clamp(round2(video.playbackRate + delta), CONFIG.rateMin, CONFIG.rateMax);
        if (next === video.playbackRate) return false;
        video.playbackRate = next;
        return true;
    }

    function changeVolume(video, delta) {
        const next = clamp(round2(video.volume + delta), 0, 1);
        // Raising the volume out of a mute state is an action even when the
        // numeric volume cannot move any further.
        if (delta > 0 && video.muted) {
            video.muted = false;
            if (next !== video.volume) video.volume = next;
            return true;
        }
        if (next === video.volume) return false;
        video.volume = next;
        return true;
    }

    // -------------------------------------------------------------
    // 0b. FRAME DURATION (for the "1 frame" step)
    //
    // Measured with requestVideoFrameCallback when the browser supports it,
    // otherwise falls back to CONFIG.frameFallbackFps.
    //
    // mediaTime advances with the media clock, so the measurement stays valid at
    // any playbackRate. The probe is bound to a "generation": a pause, a src
    // change or a newer probe cancels it, so the probing flag can never stick.
    // -------------------------------------------------------------
    function frameDuration(video) {
        return video.__ccvFrameDuration || (1 / CONFIG.frameFallbackFps);
    }

    function stepFrames(video, frames) {
        return seekBy(video, frames * frameDuration(video));
    }

    function cancelProbe(video, dropMeasurement) {
        video.__ccvGen = (video.__ccvGen || 0) + 1;
        video.__ccvProbing = false;
        if (dropMeasurement) delete video.__ccvFrameDuration;
    }

    function probeFrameDuration(video) {
        if (!video || typeof video.requestVideoFrameCallback !== 'function') return;
        if (video.__ccvProbing) return;

        const gen = (video.__ccvGen || 0) + 1;
        video.__ccvGen = gen;
        video.__ccvProbing = true;

        const samples = [];
        let last = null;
        let done = false;
        let timer = null;

        const finish = () => {
            if (done) return;
            done = true;
            if (timer !== null) { clearTimeout(timer); timer = null; }
            if (video.__ccvGen !== gen) return;   // superseded by a cancel/newer probe
            video.__ccvProbing = false;
            if (samples.length >= 5) {
                // Median, not mean: one buffering stall must not skew the frame
                // duration for the rest of the session.
                const sorted = samples.slice().sort((a, b) => a - b);
                video.__ccvFrameDuration = sorted[Math.floor(sorted.length / 2)];
            }
        };

        const onFrame = (now, metadata) => {
            if (done || video.__ccvGen !== gen) return;
            const t = metadata && metadata.mediaTime;
            if (typeof t === 'number' && isFinite(t)) {
                if (last !== null) {
                    const delta = t - last;
                    if (delta >= CONFIG.frameProbeMinDelta && delta <= CONFIG.frameProbeMaxDelta) {
                        samples.push(delta);
                    }
                }
                last = t;
            }
            if (samples.length >= CONFIG.frameProbeSamples) { finish(); return; }
            video.requestVideoFrameCallback(onFrame);
        };

        timer = setTimeout(finish, CONFIG.frameProbeTimeoutMs);
        video.requestVideoFrameCallback(onFrame);
    }

    document.addEventListener('play', (e) => {
        if (isVideoNode(e.target)) probeFrameDuration(e.target);
    }, true);
    document.addEventListener('playing', (e) => {
        if (isVideoNode(e.target)) probeFrameDuration(e.target);
    }, true);
    document.addEventListener('pause', (e) => {
        if (isVideoNode(e.target)) cancelProbe(e.target, false);
    }, true);
    document.addEventListener('ended', (e) => {
        if (isVideoNode(e.target)) cancelProbe(e.target, false);
    }, true);
    // A new media resource invalidates both the running probe and the cached
    // frame rate from the previous video.
    document.addEventListener('loadstart', (e) => {
        if (isVideoNode(e.target)) cancelProbe(e.target, true);
    }, true);
    document.addEventListener('emptied', (e) => {
        if (isVideoNode(e.target)) cancelProbe(e.target, true);
    }, true);

    // Videos that were already playing before this script was injected.
    function probeExistingVideos() {
        const videos = allVideos();
        for (let i = 0; i < videos.length; i++) {
            if (videos[i] && videos[i].paused === false) probeFrameDuration(videos[i]);
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', probeExistingVideos, { once: true });
    } else {
        probeExistingVideos();
    }

    // -------------------------------------------------------------
    // 0c. TARGET RESOLUTION
    //
    // Never `document.querySelector('video')`: on any page with a preload / ad /
    // thumbnail / tracking video earlier in the DOM that targets the wrong
    // element, and a hidden video would hijack the whole page.
    // -------------------------------------------------------------
    const boxCache = new WeakMap();

    function contentBox(video) {
        const rect = video.getBoundingClientRect();
        if (!(rect.width > 0 && rect.height > 0)) return null;

        let box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };

        // `object-fit: contain` letterboxes the picture: map the 3x3 grid onto
        // the visible picture, not onto the black bars.
        const fit = styleOf(video).objectFit || 'fill';
        if (fit === 'contain' || fit === 'scale-down' || fit === 'cover') {
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            if (vw > 0 && vh > 0) {
                let scale = fit === 'cover'
                    ? Math.max(rect.width / vw, rect.height / vh)
                    : Math.min(rect.width / vw, rect.height / vh);
                if (fit === 'scale-down') scale = Math.min(scale, 1);
                box = {
                    left: rect.left + (rect.width - vw * scale) / 2,
                    top: rect.top + (rect.height - vh * scale) / 2,
                    width: vw * scale,
                    height: vh * scale
                };
            }
        }
        return box;
    }

    function videoBox(video) {
        const now = Date.now();
        const scrollX = window.scrollX || window.pageXOffset || 0;
        const scrollY = window.scrollY || window.pageYOffset || 0;
        const hit = boxCache.get(video);

        if (hit && now - hit.at < CONFIG.boxCacheMs && hit.scrollX === scrollX && hit.scrollY === scrollY) {
            return hit.box;
        }

        const box = contentBox(video);
        boxCache.set(video, { at: now, box, scrollX, scrollY });
        return box;
    }

    function containsPoint(el, x, y) {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    function overlapArea(a, b) {
        const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        return (w > 0 && h > 0) ? w * h : 0;
    }

    // The topmost element under the cursor, descending into open shadow roots.
    function elementAtPoint(x, y) {
        let el = null;
        try { el = document.elementFromPoint(x, y); } catch (err) { el = null; }

        let guard = 0;
        while (el && el.shadowRoot && guard++ < 8) {
            let inner = null;
            try { inner = el.shadowRoot.elementFromPoint(x, y); } catch (err) { inner = null; }
            if (!inner || inner === el) break;
            el = inner;
        }
        return el;
    }

    function ancestorChain(node, limit) {
        const out = [];
        let p = node;
        let guard = 0;
        while (p && guard++ < (limit || 80)) {
            out.push(p);
            p = p.parentElement;
        }
        return out;
    }

    // Ancestors minus the document-level wrappers (<html>, <body>): those are
    // shared by every element on the page and prove nothing about ownership.
    function ownedChain(node) {
        return ancestorChain(node).filter((n) => {
            const tag = (n.tagName || '').toUpperCase();
            return tag !== 'BODY' && tag !== 'HTML';
        });
    }

    // Which video (if any) is the surface under (x, y)?
    //
    // Accepts a video when the pointer is on it / on a descendant, or when the
    // topmost element is drawn *over* the video and shares a non-root ancestor
    // with it (player chrome, overlays). Text lying next to a video inside the
    // same wrapper no longer counts: it does not overlap the picture.
    function videoFromPoint(x, y) {
        const el = elementAtPoint(x, y);
        if (!el) return null;

        if (el.nodeType === 1) {
            const owner = el.closest ? el.closest('video') : null;
            if (owner && isVisible(owner)) return owner;
            if (isVideoNode(el) && isVisible(el)) return el;
        }

        if (typeof el.getBoundingClientRect !== 'function') return null;

        const overlayRect = el.getBoundingClientRect();
        const chain = new Set(ownedChain(el));

        const videos = allVideos();
        for (let i = 0; i < videos.length; i++) {
            const v = videos[i];
            if (!isVisible(v)) continue;
            if (!containsPoint(v, x, y)) continue;
            if (!overlapArea(overlayRect, v.getBoundingClientRect())) continue;

            const vChain = ownedChain(v);
            // Only a wrapper close to the video counts as "player chrome"; a
            // page-level container shared by unrelated subtrees does not.
            const limit = Math.min(vChain.length, CONFIG.overlayAncestorDepth);
            for (let j = 0; j < limit; j++) {
                if (chain.has(vChain[j])) return v;
            }
        }

        return null;
    }

    // The keyboard has no pointer: act on the last hovered video, else on a
    // playing visible one, else the first visible one.
    let lastHoveredVideo = null;

    function activeVideo() {
        if (lastHoveredVideo && lastHoveredVideo.isConnected !== false && isVisible(lastHoveredVideo)) {
            return lastHoveredVideo;
        }
        const videos = allVideos();
        let firstVisible = null;
        for (let i = 0; i < videos.length; i++) {
            const v = videos[i];
            if (!isVisible(v)) continue;
            if (v.paused === false) return v;
            if (!firstVisible) firstVisible = v;
        }
        return firstVisible;
    }

    window.addEventListener('mouseover', (e) => {
        if (isVideoNode(e.target)) lastHoveredVideo = e.target;
    }, true);

    // -------------------------------------------------------------
    // 0d. NAVIGATION ACTIONS (MIDDLE column + RMB)
    //
    // Each helper returns true only when it acted, so the wheel handler can give
    // the scroll back to the page when there is nothing to navigate.
    // -------------------------------------------------------------
    const SITE_NAV = [
        {
            host: /(^|\.)youtube\.com$/,
            next: ['a.ytp-next-button', 'button.ytp-next-button'],
            prev: ['a.ytp-prev-button', 'button.ytp-prev-button']
        },
        {
            host: /(^|\.)bilibili\.com$/,
            next: ['.bpx-player-ctrl-next', '.squirtle-next'],
            prev: ['.bpx-player-ctrl-prev', '.squirtle-prev']
        }
    ];

    const NAV_TEXT = {
        next: /(next|forward)\s*(video|episode|part|clip)/i,
        prev: /(prev|previous|back)\s*(video|episode|part|clip)/i
    };

    function isClickable(el) {
        return isVisible(el) && !el.disabled;
    }

    function clickFirst(scope, selectors) {
        if (!scope || !scope.querySelector) return false;
        for (let i = 0; i < selectors.length; i++) {
            let node = null;
            try { node = scope.querySelector(selectors[i]); } catch (err) { node = null; }
            if (node && isClickable(node)) { node.click(); return true; }
        }
        return false;
    }

    function siteEntry() {
        const host = (window.location && window.location.hostname) || '';
        for (let i = 0; i < SITE_NAV.length; i++) {
            if (SITE_NAV[i].host.test(host)) return SITE_NAV[i];
        }
        return null;
    }

    // Generic fallback: scan the player chrome (a few levels up from the video)
    // for a control whose accessible name says "next video" / "previous video".
    function findNavControl(video, pattern) {
        let scope = video;
        for (let depth = 0; depth < 4 && scope; depth++) {
            let nodes = [];
            try { nodes = scope.querySelectorAll('button, a, [role="button"]'); } catch (err) { nodes = []; }

            for (let i = 0; i < nodes.length; i++) {
                const n = nodes[i];
                const label = [
                    n.getAttribute ? (n.getAttribute('aria-label') || '') : '',
                    n.getAttribute ? (n.getAttribute('title') || '') : '',
                    n.textContent || ''
                ].join(' ').replace(/\s+/g, ' ').trim();

                if (label && pattern.test(label) && isClickable(n)) return n;
            }
            scope = scope.parentElement;
        }
        return null;
    }

    function navigateVideo(video, dir) {
        const entry = siteEntry();
        if (entry) {
            const selectors = dir > 0 ? entry.next : entry.prev;
            let scope = video;
            for (let depth = 0; depth < 4 && scope; depth++) {
                if (clickFirst(scope, selectors)) return true;
                scope = scope.parentElement;
            }
        }
        const control = findNavControl(video, dir > 0 ? NAV_TEXT.next : NAV_TEXT.prev);
        if (control) { control.click(); return true; }
        return false;
    }

    // Chapters come from the page's own player response (YouTube). Read-only.
    function chapterStarts() {
        const out = [];
        try {
            const response = window.ytInitialPlayerResponse;
            if (!response) return out;

            const overlay = response.playerOverlays && response.playerOverlays.playerOverlayRenderer;
            const bar = overlay && overlay.decoratedPlayerBarRenderer &&
                overlay.decoratedPlayerBarRenderer.decoratedPlayerBarRenderer;
            const markers = bar && bar.playerBar && bar.playerBar.multiMarkersPlayerBarRenderer;
            const map = (markers && markers.markersMap) || [];

            for (let i = 0; i < map.length; i++) {
                const entry = map[i];
                if (!entry || entry.key !== 'DESCRIPTION_CHAPTERS') continue;
                const chapters = (entry.value && entry.value.chapters) || [];
                for (let j = 0; j < chapters.length; j++) {
                    const renderer = chapters[j] && chapters[j].chapterRenderer;
                    const start = renderer && renderer.timeRangeStartMillis;
                    if (typeof start === 'number' && isFinite(start)) out.push(start / 1000);
                }
                break;
            }
        } catch (err) { /* malformed page data == no chapters */ }

        return out.filter((v) => isFinite(v)).sort((a, b) => a - b);
    }

    function navigateChapter(video, dir) {
        const starts = chapterStarts();
        if (starts.length < 2) return false;

        const now = Number(video.currentTime);
        if (!isFinite(now)) return false;

        // Small tolerance so standing on a chapter start still moves.
        const eps = 0.35;
        let index = -1;
        for (let i = 0; i < starts.length; i++) {
            if (starts[i] <= now + eps) index = i;
        }

        const target = dir > 0 ? index + 1 : (index <= 0 ? -1 : index - 1);
        if (target < 0 || target >= starts.length) return false;

        return seekBy(video, starts[target] - now);
    }

    function nextVideo(video) { return navigateVideo(video, 1); }
    function prevVideo(video) { return navigateVideo(video, -1); }
    function nextChapter(video) { return navigateChapter(video, 1); }
    function prevChapter(video) { return navigateChapter(video, -1); }

    // -------------------------------------------------------------
    // 0e. RMB CONTEXT-MENU SUPPRESSION
    //
    // Scoped per video and time-bounded: an RMB + scroll on video A must not keep
    // swallowing the menu over video B minutes later.
    // -------------------------------------------------------------
    window.addEventListener('contextmenu', (e) => {
        const video = videoFromPoint(e.clientX, e.clientY);
        if (!video) return;

        const at = video.__ccvRmbAt || 0;
        if (!at || Date.now() - at > CONFIG.rmbMenuWindowMs) return;

        e.preventDefault();
        e.stopPropagation();
    }, true);

    // -------------------------------------------------------------
    // 1. KEYBOARD CONTROLS
    // -------------------------------------------------------------
    const NON_TEXT_INPUT_TYPES = new Set(['button', 'submit', 'reset', 'file', 'image', 'color', 'checkbox', 'radio', 'range']);
    const TEXTUAL_ROLES = /^(textbox|searchbox|combobox|listbox|option|slider|spinbutton|menu|menubar|menuitem|tab|tablist|treeitem)$/;

    // `document.activeElement` reports the shadow HOST for an input inside a
    // shadow root, so the check has to start from the real event target.
    function isTypingTarget(e) {
        let el;
        try {
            const path = e.composedPath ? e.composedPath() : null;
            el = (path && path.length) ? path[0] : e.target;
        } catch (err) {
            el = e.target;
        }

        if (el && el.nodeType === 3) el = el.parentElement;
        if (!el || el.nodeType !== 1) return false;

        let depth = 0;
        while (el && el.nodeType === 1 && depth++ < 30) {
            const tag = (el.tagName || '').toLowerCase();

            if (tag === 'textarea' || tag === 'select' || tag === 'summary') return true;
            if (el.isContentEditable === true) return true;
            if (el.hasAttribute && el.hasAttribute('contenteditable')) return true;

            if (tag === 'input') {
                const type = (el.type || 'text').toLowerCase();
                return !NON_TEXT_INPUT_TYPES.has(type);
            }

            const role = (el.getAttribute && el.getAttribute('role')) || '';
            if (role && TEXTUAL_ROLES.test(role)) return true;

            el = el.parentElement;
        }
        return false;
    }

    function toggleFullscreen(video) {
        const doc = video.ownerDocument || document;

        if (doc.fullscreenElement || doc.webkitFullscreenElement) {
            const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
            if (!exit) return false;
            try {
                const p = exit.call(doc);
                if (p && p.catch) p.catch(() => {});
            } catch (err) { return false; }
            return true;
        }

        const target = (video.closest && video.closest('.videoplayer, .html5-video-player')) || video;
        const request = target.requestFullscreen || target.webkitRequestFullscreen ||
            video.requestFullscreen || video.webkitRequestFullscreen;
        if (!request) return false;

        try {
            const p = request.call(target);
            if (p && p.catch) p.catch(() => {});
        } catch (err) {
            return false;
        }
        return true;
    }

    function handleVideoControls(e) {
        if (e.defaultPrevented) return;
        if (e.altKey || e.metaKey) return;      // leave OS/browser shortcuts alone
        if (isTypingTarget(e)) return;

        // F: fullscreen toggle (the page's own handler wins when there is one).
        if (e.code === 'KeyF') {
            if (e.ctrlKey || e.shiftKey) return;
            const video = activeVideo();
            if (!video) return;
            if (!toggleFullscreen(video)) return;
            e.preventDefault();
            e.stopPropagation();
            return;
        }

        if (e.code !== 'ArrowRight' && e.code !== 'ArrowLeft') return;

        const video = activeVideo();
        if (!video) return;

        let amount = CONFIG.seekMidSeconds;
        if (e.ctrlKey) amount = 60;
        else if (e.shiftKey) amount = 1;

        const signed = e.code === 'ArrowRight' ? amount : -amount;
        if (!seekBy(video, signed)) return;    // nothing to do: keep the key native

        e.preventDefault();
        e.stopPropagation();
    }

    // One registration, capture phase, keydown only. A keyup listener combined
    // with stopImmediatePropagation would hide every key release from the page.
    window.addEventListener('keydown', handleVideoControls, true);

    // -------------------------------------------------------------
    // 2. MOUSE WHEEL 3x3 GRID CONTROLS
    //
    //   +----------------+--------------------+----------------+
    //   | Playback Rate  |   Seek / Navigate  |      Volume    |
    //   |   (left 1/3)   |     (middle 1/3)   |   (right 1/3)  |
    //   +----------------+--------------------+----------------+
    //   Rows: top 1/3 | middle 1/3 | bottom 1/3
    //   Hold RMB + scroll for the navigation actions.
    // -------------------------------------------------------------
    const wheelState = { video: null, acc: 0, at: 0 };

    // Converts a wheel event into a signed step count (+ = increase).
    // A deliberate notch is one step; trackpad micro-events have to add up.
    function takeWheelSteps(e, video) {
        let delta = e.deltaY;
        const mode = e.deltaMode || 0;
        if (mode === 1) delta *= CONFIG.wheelLinePx;
        else if (mode === 2) delta *= CONFIG.wheelPagePx;

        const now = Date.now();
        const stale = now - wheelState.at > CONFIG.wheelGestureGapMs;

        if (wheelState.video !== video || stale) {
            wheelState.video = video;
            wheelState.acc = 0;
        }
        wheelState.at = now;
        if (delta === 0) return 0;

        if (Math.abs(delta) >= CONFIG.wheelNotchPx) {
            wheelState.acc = 0;
            return delta < 0 ? 1 : -1;
        }

        // Direction flip restarts the accumulation so jitter cannot add up.
        if (wheelState.acc !== 0 && (wheelState.acc < 0) !== (delta < 0)) wheelState.acc = 0;
        wheelState.acc += delta;

        let steps = 0;
        while (wheelState.acc <= -CONFIG.wheelNotchPx) { wheelState.acc += CONFIG.wheelNotchPx; steps += 1; }
        while (wheelState.acc >= CONFIG.wheelNotchPx) { wheelState.acc -= CONFIG.wheelNotchPx; steps -= 1; }

        return clamp(steps, -CONFIG.maxStepsPerWheelEvent, CONFIG.maxStepsPerWheelEvent);
    }

    // Scrollable panels drawn on top of the video (playlists, live chat,
    // comments) keep their native scrolling: the video box must not become a
    // scroll trap for them.
    function isInsideScrollablePanel(e, video) {
        let path;
        try { path = e.composedPath ? e.composedPath() : null; } catch (err) { path = null; }
        if (!path || !path.length) path = [e.target];

        for (let i = 0; i < path.length; i++) {
            const node = path[i];
            if (!node || node.nodeType !== 1) continue;
            if (isVideoNode(node)) return false;
            // An ancestor of the video is the page/player wrapper, not an overlay.
            if (node.contains && node.contains(video)) return false;

            const tag = (node.tagName || '').toLowerCase();
            if (tag === 'body' || tag === 'html') return false;

            const oy = styleOf(node).overflowY;
            if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') &&
                node.scrollHeight > node.clientHeight + 1) {
                return true;
            }
        }
        return false;
    }

    window.addEventListener('wheel', (e) => {
        // Pinch-zoom and browser zoom stay native. Ctrl/Cmd + wheel is never ours.
        if (e.ctrlKey || e.metaKey) return;
        if (!e.deltaY) return;
        // Horizontal-dominant gestures (shift+wheel, tilt wheels) stay native.
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX || 0)) return;

        const video = videoFromPoint(e.clientX, e.clientY);
        if (!video) return;

        const box = videoBox(video);
        if (!box || box.width <= 0 || box.height <= 0) return;

        lastHoveredVideo = video;

        if (isInsideScrollablePanel(e, video)) return;

        const relX = (e.clientX - box.left) / box.width;
        const relY = (e.clientY - box.top) / box.height;

        // Letterbox bars are not a control surface.
        if (relX < 0 || relX > 1 || relY < 0 || relY > 1) return;

        const rmb = (e.buttons & 2) !== 0;
        const row = relY < CONFIG.rowTopMax ? 0 : (relY < CONFIG.rowMidMax ? 1 : 2);
        const steps = takeWheelSteps(e, video);

        let acted = false;

        if (relX < CONFIG.colRateMax) {
            // LEFT COLUMN: playback rate. RMB is not a modifier here.
            if (steps !== 0) {
                acted = changeRate(video, steps > 0 ? CONFIG.rateSteps[row] : -CONFIG.rateSteps[row]);
            }
        } else if (relX >= CONFIG.colNavMax) {
            // RIGHT COLUMN: volume. RMB is not a modifier here.
            if (steps !== 0) {
                acted = changeVolume(video, steps > 0 ? CONFIG.volumeSteps[row] : -CONFIG.volumeSteps[row]);
            }
        } else if (rmb) {
            // MIDDLE COLUMN + RMB: navigation / frame stepping.
            if (steps !== 0) {
                if (row === 0) acted = steps > 0 ? nextVideo(video) : prevVideo(video);
                else if (row === 1) acted = steps > 0 ? nextChapter(video) : prevChapter(video);
                else acted = stepFrames(video, steps);
            }
            // Remember the gesture so the context menu can be suppressed for this
            // video within the window.
            if (acted) video.__ccvRmbAt = Date.now();
        } else if (steps !== 0) {
            // MIDDLE COLUMN: seeking.
            if (row === 0) {
                const duration = getDuration(video);
                const base = duration !== null
                    ? round2(duration * CONFIG.seekTopFraction)
                    : CONFIG.seekMidSeconds;
                acted = seekBy(video, steps > 0 ? base : -base);
            } else if (row === 1) {
                acted = seekBy(video, steps > 0 ? CONFIG.seekMidSeconds : -CONFIG.seekMidSeconds);
            } else {
                acted = seekBy(video, steps > 0 ? CONFIG.seekBottomSeconds : -CONFIG.seekBottomSeconds);
            }
        }

        // Swallow the scroll when we did something, or while a trackpad gesture is
        // still building up (so a half-flick does not jitter the page). When the
        // action was impossible (bound reached, no next video, nothing to seek)
        // the page keeps its scroll.
        if (acted || (steps === 0 && wheelState.acc !== 0)) {
            e.preventDefault();
            e.stopPropagation();
        }
    }, { passive: false, capture: true });
})();
