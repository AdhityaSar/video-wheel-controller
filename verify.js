'use strict';

/*
 * Headless verification for video-wheel-controller.user.js
 * ------------------------------------------------
 * Runs the userscript inside a mini DOM (rectangles + computed styles +
 * elementFromPoint hit-testing) and drives it with synthetic wheel / keyboard
 * / media events.
 *
 * The mini DOM exists so the cheap regressions are caught without a browser:
 * multiple videos, hidden preload videos, text in the same wrapper, scrollable
 * overlays, letterboxing, display:none videos, shadow-root inputs,
 * trackpad-sized wheel deltas, and the frame-probe lifecycle.
 *
 *   node verify.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_PATH = path.join(__dirname, 'video-wheel-controller.user.js');
const source = fs.readFileSync(SCRIPT_PATH, 'utf8');

// =================================================================
// MINI DOM
// =================================================================
let DOC_INDEX = 0;

function parseSimple(sel) {
    const out = { tag: null, classes: [], attrs: [] };
    const re = /(\[[^\]]+\])|(^[a-zA-Z][\w-]*)|(\.[\w-]+)/g;
    let m;
    while ((m = re.exec(sel.trim()))) {
        if (m[1]) {
            const inner = m[1].slice(1, -1);
            const eq = inner.indexOf('=');
            if (eq === -1) out.attrs.push([inner, null]);
            else out.attrs.push([inner.slice(0, eq), inner.slice(eq + 1).replace(/^"|"$/g, '')]);
        } else if (m[2]) {
            out.tag = m[2].toUpperCase();
        } else if (m[3]) {
            out.classes.push(m[3].slice(1));
        }
    }
    return out;
}

function matchOne(el, spec) {
    if (spec.tag && el.tagName !== spec.tag) return false;
    for (const c of spec.classes) if (!el.classList.has(c)) return false;
    for (const pair of spec.attrs) {
        const key = pair[0];
        if (!(key in el.attrs)) return false;
        if (pair[1] !== null && el.attrs[key] !== pair[1]) return false;
    }
    return true;
}

function matches(el, selector) {
    return selector.split(',').some((s) => s.trim() && matchOne(el, parseSimple(s)));
}

class El {
    constructor(tag, opts) {
        opts = opts || {};
        this.tagName = String(tag).toUpperCase();
        this.nodeType = 1;
        this.children = [];
        this.parentElement = null;
        this.classList = new Set(String(opts.cls || '').split(/\s+/).filter(Boolean));
        this.attrs = opts.attrs || {};
        this._rect = Object.assign({ left: 0, top: 0, width: 0, height: 0 }, opts.rect || {});
        this.css = Object.assign({
            display: 'block', visibility: 'visible', opacity: '1', objectFit: 'fill', overflowY: 'visible'
        }, opts.css || {});
        this.z = opts.z === undefined ? 0 : opts.z;
        this.index = DOC_INDEX++;
        this.scrollTop = 0;
        this.scrollHeight = opts.scrollHeight || 0;
        this.clientHeight = opts.clientHeight === undefined ? this._rect.height : opts.clientHeight;
        this.disabled = !!opts.disabled;
        this.clicked = 0;
        this.shadowRoot = null;
        this.ownerDocument = null;
        this.isContentEditable = !!opts.contentEditable;
        this.isConnected = true;
        this._text = opts.text || '';
        this._type = opts.type;
        this.paused = true;
    }

    get textContent() {
        let s = this._text;
        for (const c of this.children) s += c.textContent;
        return s;
    }

    get type() { return this._type; }

    set type(v) { this._type = v; }

    getBoundingClientRect() {
        const r = this._rect;
        return {
            left: r.left, top: r.top, width: r.width, height: r.height,
            right: r.left + r.width, bottom: r.top + r.height
        };
    }

    appendChild(child) {
        child.parentElement = this;
        child.ownerDocument = this.ownerDocument;
        this.children.push(child);
        return child;
    }

    getAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    }

    hasAttribute(name) {
        return Object.prototype.hasOwnProperty.call(this.attrs, name);
    }

    setAttribute(name, value) {
        this.attrs[name] = String(value);
    }

    contains(node) {
        let p = node;
        while (p) {
            if (p === this) return true;
            p = p.parentElement;
        }
        return false;
    }

    closest(selector) {
        let p = this;
        while (p && p.nodeType === 1) {
            if (matches(p, selector)) return p;
            p = p.parentElement;
        }
        return null;
    }

    querySelectorAll(selector) {
        const out = [];
        const walk = (node) => {
            for (const c of node.children) {
                if (matches(c, selector)) out.push(c);
                walk(c);
            }
        };
        walk(this);
        return out;
    }

    querySelector(selector) {
        return this.querySelectorAll(selector)[0] || null;
    }

    click() {
        this.clicked += 1;
        if (typeof this.onclick === 'function') this.onclick(this);
    }

    addEventListener() { /* element-level listeners are not used by the script */ }
}

function makeVideo(opts) {
    opts = opts || {};
    const v = new El('video', opts);
    v.duration = opts.duration === undefined ? 200 : opts.duration;
    v.volume = opts.volume === undefined ? 0.5 : opts.volume;
    v.muted = !!opts.muted;
    v.playbackRate = opts.playbackRate === undefined ? 1 : opts.playbackRate;
    v.videoWidth = opts.videoWidth || 640;
    v.videoHeight = opts.videoHeight || 360;
    v.seekable = opts.seekable || { length: 0, start: () => 0, end: () => 0 };
    v.hits = [];

    let t = opts.currentTime === undefined ? 100 : opts.currentTime;
    Object.defineProperty(v, 'currentTime', {
        configurable: true,
        get() { return t; },
        set(x) {
            if (!isFinite(x)) {
                throw new TypeError("Failed to set the 'currentTime' property: non-finite");
            }
            v.hits.push(x);
            t = x;
        }
    });
    return v;
}

// =================================================================
// SCENE / SANDBOX
// =================================================================
function makeScene(setup) {
    const doc = {
        readyState: 'complete',
        activeElement: null,
        fullscreenElement: null,
        _listeners: {},
        _body: null,
        defaultView: null,
        addEventListener(type, fn) {
            (this._listeners[type] = this._listeners[type] || []).push(fn);
        },
        removeEventListener() {},
        querySelectorAll(selector) {
            const out = [];
            const walk = (node) => {
                for (const c of node.children) {
                    if (matches(c, selector)) out.push(c);
                    walk(c);
                }
            };
            if (this._body) {
                if (matches(this._body, selector)) out.push(this._body);
                walk(this._body);
            }
            return out;
        },
        querySelector(selector) {
            return this.querySelectorAll(selector)[0] || null;
        },
        elementFromPoint(x, y) {
            return scene.elementFromPoint(x, y);
        },
        exitFullscreen() {
            doc.fullscreenElement = null;
            return Promise.resolve();
        }
    };

    const scene = {
        doc,
        hitList: [],
        body: null,
        elementFromPoint(x, y) {
            let best = null;
            for (const el of scene.hitList) {
                const r = el._rect;
                if (r.width <= 0 || r.height <= 0) continue;
                if (x < r.left || x > r.left + r.width || y < r.top || y > r.top + r.height) continue;
                const cs = el.css;
                if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
                if (!best || el.z > best.z || (el.z === best.z && el.index > best.index)) best = el;
            }
            return best;
        },
        add(el) {
            scene.hitList.push(el);
            return el;
        }
    };

    const body = new El('body', { rect: { left: 0, top: 0, width: 1000, height: 2000 }, z: -100 });
    body.ownerDocument = doc;
    doc._body = body;
    scene.body = body;
    body.css.display = 'block';
    scene.add(body);

    const windowMock = {
        _listeners: {},
        addEventListener(type, fn, opts) {
            const list = (this._listeners[type] = this._listeners[type] || []);
            if (opts && opts.once) {
                const wrapped = (ev) => {
                    this._listeners[type] = this._listeners[type].filter((f) => f !== wrapped);
                    fn(ev);
                };
                list.push(wrapped);
                return;
            }
            list.push(fn);
        },
        removeEventListener() {},
        getComputedStyle(el) { return el.css; },
        scrollX: 0,
        scrollY: 0,
        scrollTo(x, y) { this.scrollX = x; this.scrollY = y; },
        location: { hostname: 'example.test', href: 'https://example.test/watch' },
        document: doc
    };
    doc.defaultView = windowMock;
    scene.window = windowMock;

    // Controllable clock: the userscript reads Date.now() for gesture timing.
    let fakeNow = 1700000000000;
    const FakeDate = function () { return new Date(fakeNow); };
    FakeDate.now = () => fakeNow;
    FakeDate.prototype = Date.prototype;
    scene.advance = (ms) => { fakeNow += ms; };
    scene.setClock = (ms) => { fakeNow = ms; };
    scene.resetClock = () => { fakeNow = 1700000000000; };

    const ctx = { window: windowMock, document: doc, console, setTimeout, clearTimeout, Date: FakeDate, Math, isFinite, Number, String, Object, Array, Set, WeakMap, Error, TypeError };
    scene.ctx = ctx;
    ctx.globalThis = ctx;
    vm.createContext(ctx);

    if (setup) setup(scene, El, makeVideo);

    return scene;
}

function loadScript(scene) {
    vm.runInContext(source, scene.ctx, { filename: SCRIPT_PATH });
}

function fire(scene, kind, type, ev) {
    const store = kind === 'window' ? scene.window._listeners : scene.doc._listeners;
    const list = (store[type] || []).slice();
    for (const fn of list) fn(ev);
    return ev;
}

function makeEvent(extra) {
    const ev = Object.assign({
        clientX: 0, clientY: 0, deltaX: 0, deltaY: 0, deltaMode: 0, buttons: 0, button: 0,
        ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
        code: '', key: '', type: 'keydown', defaultPrevented: false, target: null,
        stopPropagation() { this.stopped = true; },
        stopImmediatePropagation() { this.stopped = true; this.immediateStopped = true; },
        composedPath() { return this.path || (this.target ? [this.target] : []); },
        getModifierState() { return false; }
    }, extra);
    ev.prevented = false;
    ev.defaultPrevented = false;
    ev.preventDefault = function () { ev.prevented = true; ev.defaultPrevented = true; };
    return ev;
}

// =================================================================
// ASSERTIONS
// =================================================================
let passed = 0;
let failed = 0;
const failures = [];

function check(name, fn) {
    try {
        fn();
        passed++;
        console.log('  PASS  ' + name);
    } catch (err) {
        failed++;
        failures.push(name + ' :: ' + err.message);
        console.log('  FAIL  ' + name + '\n         ' + err.message);
    }
}

function eq(actual, expected, label) {
    if (actual !== expected) {
        throw new Error((label || 'value') + ': expected ' + expected + ', got ' + actual);
    }
}

function near(actual, expected, label, eps) {
    const e = eps === undefined ? 1e-6 : eps;
    if (!(Math.abs(actual - expected) <= e)) {
        throw new Error((label || 'value') + ': expected ~' + expected + ', got ' + actual);
    }
}

function ok(value, label) {
    if (!value) throw new Error((label || 'assertion') + ': expected truthy, got ' + value);
}

// A standard scene: one 900x600 player at the origin.
function standardScene(setup) {
    return makeScene((scene, El, makeVideo) => {
        const wrap = new El('div', { cls: 'videoplayer', rect: { left: 0, top: 0, width: 900, height: 600 }, z: 1 });
        wrap.ownerDocument = scene.doc;
        scene.body.appendChild(wrap);
        const v = makeVideo({ rect: { left: 0, top: 0, width: 900, height: 600 }, z: 2 });
        v.ownerDocument = scene.doc;
        wrap.appendChild(v);
        scene.add(wrap);
        scene.add(v);
        scene.video = v;
        scene.wrap = wrap;
        if (setup) setup(scene, El, makeVideo);
    });
}

function wheelAt(scene, x, y, opts) {
    const o = opts || {};
    const hit = scene.elementFromPoint(x, y);
    const ev = makeEvent(Object.assign({
        clientX: x, clientY: y,
        deltaY: o.deltaY === undefined ? (o.up === false ? 100 : -100) : o.deltaY,
        buttons: o.rmb ? 2 : 0,
        ctrlKey: !!o.ctrlKey,
        target: hit,
        path: hit ? [hit, hit.parentElement, scene.body, scene.doc, scene.window] : []
    }, o.extra || {}));
    if (scene.advance && o.gap !== undefined) scene.advance(o.gap);
    fire(scene, 'window', 'wheel', ev);
    return ev;
}

function keydown(scene, extra) {
    const el = scene.doc.activeElement || scene.body;
    const ev = makeEvent(Object.assign({
        code: 'ArrowRight', key: 'ArrowRight', type: 'keydown',
        target: el,
        path: [el, el.parentElement, scene.body, scene.doc, scene.window]
    }, extra));
    fire(scene, 'window', 'keydown', ev);
    return ev;
}

// =================================================================
// A. LEFT COLUMN - playback rate
// =================================================================
console.log('\nA. LEFT COLUMN (playback rate)');

(function () {
    const Z = { leftTop: [100, 100], leftMid: [100, 300], leftBottom: [100, 500] };

    function run(name, zone, opts, field, expected) {
        check(name, () => {
            const s = standardScene();
            loadScript(s);
            wheelAt(s, Z[zone][0], Z[zone][1], opts);
            eq(s.video[field], expected, field);
        });
    }

    run('LEFT-TOP up    -> +0.5x', 'leftTop', {}, 'playbackRate', 1.5);
    run('LEFT-TOP down  -> -0.5x', 'leftTop', { up: false }, 'playbackRate', 0.5);
    run('LEFT-MID up    -> +0.25x', 'leftMid', {}, 'playbackRate', 1.25);
    run('LEFT-MID down  -> -0.25x', 'leftMid', { up: false }, 'playbackRate', 0.75);
    run('LEFT-BOT up    -> +0.1x', 'leftBottom', {}, 'playbackRate', 1.1);
    run('LEFT-BOT down  -> -0.1x', 'leftBottom', { up: false }, 'playbackRate', 0.9);

    check('LEFT rate clamped at max (16) and the scroll is released', () => {
        const s = standardScene();
        loadScript(s);
        s.video.playbackRate = 16;
        const ev = wheelAt(s, 100, 100);
        eq(s.video.playbackRate, 16, 'rate');
        eq(ev.prevented, false, 'prevented (no-op must release the scroll)');
    });

    check('LEFT rate clamped at min (0.1)', () => {
        const s = standardScene();
        loadScript(s);
        s.video.playbackRate = 0.1;
        wheelAt(s, 100, 500, { up: false });
        eq(s.video.playbackRate, 0.1, 'rate');
    });

    check('LEFT does not touch currentTime / volume', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 100, 100);
        eq(s.video.currentTime, 100, 'currentTime');
        eq(s.video.volume, 0.5, 'volume');
    });

    check('LEFT still works while RMB is held (RMB only modifies the middle column)', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 100, 100, { rmb: true });
        eq(s.video.playbackRate, 1.5, 'rate');
    });
})();

// =================================================================
// B. RIGHT COLUMN - volume
// =================================================================
console.log('\nB. RIGHT COLUMN (volume)');

(function () {
    function run(name, x, y, opts, expected) {
        check(name, () => {
            const s = standardScene();
            loadScript(s);
            wheelAt(s, x, y, opts);
            eq(s.video.volume, expected, 'volume');
        });
    }

    run('RIGHT-TOP up    -> +10%', 800, 100, {}, 0.6);
    run('RIGHT-TOP down  -> -10%', 800, 100, { up: false }, 0.4);
    run('RIGHT-MID up    -> +5%', 800, 300, {}, 0.55);
    run('RIGHT-MID down  -> -5%', 800, 300, { up: false }, 0.45);
    run('RIGHT-BOT up    -> +1%', 800, 500, {}, 0.51);
    run('RIGHT-BOT down  -> -1%', 800, 500, { up: false }, 0.49);

    check('RIGHT volume clamps to 1 (0.99 -> 1 is still an action)', () => {
        const s = standardScene();
        loadScript(s);
        s.video.volume = 0.99;
        const ev = wheelAt(s, 800, 100);
        eq(s.video.volume, 1, 'volume');
        eq(ev.prevented, true, 'prevented');
    });

    check('RIGHT at volume 1 releases the scroll (true no-op)', () => {
        const s = standardScene();
        loadScript(s);
        s.video.volume = 1;
        const ev = wheelAt(s, 800, 100);
        eq(s.video.volume, 1, 'volume');
        eq(ev.prevented, false, 'prevented');
    });

    check('RIGHT volume clamped at 0', () => {
        const s = standardScene();
        loadScript(s);
        s.video.volume = 0.005;
        wheelAt(s, 800, 500, { up: false });
        eq(s.video.volume, 0, 'volume');
    });

    check('RIGHT raising volume unmutes', () => {
        const s = standardScene();
        loadScript(s);
        s.video.muted = true;
        wheelAt(s, 800, 100);
        eq(s.video.muted, false, 'muted');
    });

    check('RIGHT unmutes even when volume is already 1', () => {
        const s = standardScene();
        loadScript(s);
        s.video.muted = true;
        s.video.volume = 1;
        const ev = wheelAt(s, 800, 100);
        eq(s.video.muted, false, 'muted');
        eq(ev.prevented, true, 'prevented (unmuting is an action)');
    });

    check('RIGHT lowering volume keeps the muted state', () => {
        const s = standardScene();
        loadScript(s);
        s.video.muted = true;
        wheelAt(s, 800, 100, { up: false });
        eq(s.video.muted, true, 'muted');
    });

    check('RIGHT does not touch currentTime / rate', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 800, 100);
        eq(s.video.currentTime, 100, 'currentTime');
        eq(s.video.playbackRate, 1, 'rate');
    });
})();

// =================================================================
// C. MIDDLE COLUMN - seeking (plain scroll)
// =================================================================
console.log('\nC. MIDDLE COLUMN (seeking, plain scroll)');

(function () {
    function run(name, x, y, opts, expected) {
        check(name, () => {
            const s = standardScene();
            loadScript(s);
            wheelAt(s, x, y, opts);
            eq(s.video.currentTime, expected, 'currentTime');
        });
    }

    run('MIDDLE-TOP up    -> +5% of duration (200s -> +10s)', 450, 100, {}, 110);
    run('MIDDLE-TOP down  -> -5% of duration', 450, 100, { up: false }, 90);
    run('MIDDLE-MID up    -> +5s', 450, 300, {}, 105);
    run('MIDDLE-MID down  -> -5s', 450, 300, { up: false }, 95);
    run('MIDDLE-BOT up    -> +1s', 450, 500, {}, 101);
    run('MIDDLE-BOT down  -> -1s', 450, 500, { up: false }, 99);

    check('MIDDLE-TOP clamps to duration', () => {
        const s = standardScene();
        loadScript(s);
        s.video.currentTime = 199;
        wheelAt(s, 450, 100);
        eq(s.video.currentTime, 200, 'currentTime');
    });

    check('MIDDLE-BOT clamps to 0 (0.5s -> 0 is still a seek)', () => {
        const s = standardScene();
        loadScript(s);
        s.video.currentTime = 0.5;
        const ev = wheelAt(s, 450, 500, { up: false });
        eq(s.video.currentTime, 0, 'currentTime');
        eq(ev.prevented, true, 'prevented');
    });

    check('MIDDLE-BOT at 0s releases the scroll (true no-op)', () => {
        const s = standardScene();
        loadScript(s);
        s.video.currentTime = 0;
        const ev = wheelAt(s, 450, 500, { up: false });
        eq(s.video.currentTime, 0, 'currentTime');
        eq(ev.prevented, false, 'prevented');
    });

    check('MIDDLE-TOP falls back to 5s when duration is Infinity (live)', () => {
        const s = standardScene();
        loadScript(s);
        s.video.duration = Infinity;
        wheelAt(s, 450, 100);
        eq(s.video.currentTime, 105, 'currentTime');
    });

    check('MIDDLE-TOP falls back to 5s when duration is NaN', () => {
        const s = standardScene();
        loadScript(s);
        s.video.duration = NaN;
        wheelAt(s, 450, 100);
        eq(s.video.currentTime, 105, 'currentTime');
    });

    check('MIDDLE seeking uses the seekable range on a live stream', () => {
        const s = standardScene();
        loadScript(s);
        s.video.duration = Infinity;
        s.video.seekable = { length: 1, start: () => 40, end: () => 400 };
        s.video.currentTime = 50;
        wheelAt(s, 450, 500, { up: false });
        eq(s.video.currentTime, 49, 'currentTime');
        wheelAt(s, 450, 100, { up: false });
        eq(s.video.currentTime, 44, 'currentTime (live duration -> fixed 5s step)');
        s.video.currentTime = 42;
        wheelAt(s, 450, 100, { up: false });
        eq(s.video.currentTime, 40, 'currentTime clamped to the seekable start');
    });

    check('MIDDLE seeking does not touch rate / volume', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 450, 300);
        eq(s.video.playbackRate, 1, 'rate');
        eq(s.video.volume, 0.5, 'volume');
    });
})();

// =================================================================
// D. MIDDLE COLUMN + RMB - frame step / navigation
// =================================================================
console.log('\nD. MIDDLE COLUMN + RMB (frame step / navigation)');

(function () {
    check('MIDDLE-BOT + RMB up   -> +1 frame (measured 25fps)', () => {
        const s = standardScene();
        loadScript(s);
        s.video.__ccvFrameDuration = 1 / 25;
        wheelAt(s, 450, 500, { rmb: true });
        near(s.video.currentTime, 100.04, 'currentTime');
    });

    check('MIDDLE-BOT + RMB down -> -1 frame (measured 25fps)', () => {
        const s = standardScene();
        loadScript(s);
        s.video.__ccvFrameDuration = 1 / 25;
        wheelAt(s, 450, 500, { rmb: true, up: false });
        near(s.video.currentTime, 99.96, 'currentTime');
    });

    check('MIDDLE-BOT + RMB uses the 30fps fallback when unmeasured', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 450, 500, { rmb: true });
        near(s.video.currentTime, 100 + 1 / 30, 'currentTime');
    });

    check('MIDDLE-BOT + RMB detects RMB via the buttons bitmask (=3)', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 450, 500, { rmb: true, extra: { buttons: 3 } });
        near(s.video.currentTime, 100 + 1 / 30, 'currentTime');
    });

    check('MIDDLE-BOT with LMB only (buttons=1) stays a plain seek', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 450, 500, { extra: { buttons: 1 } });
        eq(s.video.currentTime, 101, 'currentTime');
    });

    check('MIDDLE-TOP + RMB navigates to the next video (aria-label control)', () => {
        const s = standardScene((scene, El) => {
            const btn = new El('button', {
                rect: { left: 700, top: 560, width: 40, height: 30 }, z: 3,
                attrs: { 'aria-label': 'Next video' }
            });
            btn.ownerDocument = scene.doc;
            scene.wrap.appendChild(btn);
            scene.add(btn);
            scene.nextBtn = btn;
        });
        loadScript(s);
        wheelAt(s, 450, 100, { rmb: true });
        eq(s.nextBtn.clicked, 1, 'next button clicks');
        eq(s.video.currentTime, 100, 'currentTime (navigation must not seek)');
    });

    check('MIDDLE-TOP + RMB down clicks the previous-video control', () => {
        const s = standardScene((scene, El) => {
            const btn = new El('button', {
                rect: { left: 640, top: 560, width: 40, height: 30 }, z: 3,
                attrs: { title: 'Previous video' }
            });
            btn.ownerDocument = scene.doc;
            scene.wrap.appendChild(btn);
            scene.add(btn);
            scene.prevBtn = btn;
        });
        loadScript(s);
        wheelAt(s, 450, 100, { rmb: true, up: false });
        eq(s.prevBtn.clicked, 1, 'previous button clicks');
    });

    check('MIDDLE-TOP + RMB releases the scroll when there is no next video', () => {
        const s = standardScene();
        loadScript(s);
        const ev = wheelAt(s, 450, 100, { rmb: true });
        eq(ev.prevented, false, 'prevented');
        eq(s.video.currentTime, 100, 'currentTime');
    });

    check('MIDDLE-MID + RMB steps through YouTube chapters', () => {
        const s = standardScene();
        s.window.ytInitialPlayerResponse = {
            playerOverlays: {
                playerOverlayRenderer: {
                    decoratedPlayerBarRenderer: {
                        decoratedPlayerBarRenderer: {
                            playerBar: {
                                multiMarkersPlayerBarRenderer: {
                                    markersMap: [{
                                        key: 'DESCRIPTION_CHAPTERS',
                                        value: {
                                            chapters: [
                                                { chapterRenderer: { timeRangeStartMillis: 0 } },
                                                { chapterRenderer: { timeRangeStartMillis: 30000 } },
                                                { chapterRenderer: { timeRangeStartMillis: 90000 } }
                                            ]
                                        }
                                    }]
                                }
                            }
                        }
                    }
                }
            }
        };
        loadScript(s);
        s.video.currentTime = 10;
        wheelAt(s, 450, 300, { rmb: true });
        eq(s.video.currentTime, 30, 'currentTime -> next chapter');
        wheelAt(s, 450, 300, { rmb: true });
        eq(s.video.currentTime, 90, 'currentTime -> next chapter again');
        wheelAt(s, 450, 300, { rmb: true });
        eq(s.video.currentTime, 90, 'currentTime stays on the last chapter');
        wheelAt(s, 450, 300, { rmb: true, up: false });
        eq(s.video.currentTime, 30, 'currentTime -> previous chapter');
    });

    check('MIDDLE-MID + RMB releases the scroll when the page has no chapters', () => {
        const s = standardScene();
        loadScript(s);
        const ev = wheelAt(s, 450, 300, { rmb: true });
        eq(ev.prevented, false, 'prevented');
    });

    check('RMB zones do not leak into rate or volume', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 450, 100, { rmb: true });
        wheelAt(s, 450, 300, { rmb: true });
        eq(s.video.playbackRate, 1, 'rate');
        eq(s.video.volume, 0.5, 'volume');
    });
})();

// =================================================================
// E. Bounds + guards
// =================================================================
console.log('\nE. Bounds + guards');

(function () {
    check('wheel outside the video bounds is ignored', () => {
        const s = standardScene();
        loadScript(s);
        const ev = wheelAt(s, -10, 100);
        eq(ev.prevented, false, 'prevented');
        eq(s.video.currentTime, 100, 'currentTime');
        eq(s.video.playbackRate, 1, 'rate');
    });

    check('wheel below the video bounds is ignored', () => {
        const s = standardScene();
        loadScript(s);
        const ev = wheelAt(s, 450, 601);
        eq(ev.prevented, false, 'prevented');
        eq(s.video.currentTime, 100, 'currentTime');
    });

    check('wheel inside the video bounds prevents page scroll', () => {
        const s = standardScene();
        loadScript(s);
        const ev = wheelAt(s, 450, 300);
        eq(ev.prevented, true, 'prevented');
        eq(ev.stopped, true, 'stopped');
    });

    check('deltaY === 0 is ignored (no preventDefault, no action)', () => {
        const s = standardScene();
        loadScript(s);
        const ev = wheelAt(s, 100, 100, { deltaY: 0 });
        eq(ev.prevented, false, 'prevented');
        eq(s.video.playbackRate, 1, 'rate');
    });

    check('no <video> on the page -> no action, no preventDefault', () => {
        const s = makeScene((scene, El) => {
            const p = new El('p', { rect: { left: 0, top: 0, width: 900, height: 300 }, z: 1 });
            p.ownerDocument = scene.doc;
            scene.body.appendChild(p);
            scene.add(p);
        });
        loadScript(s);
        const ev = wheelAt(s, 450, 150);
        eq(ev.prevented, false, 'prevented');
    });

    check('ctrl+wheel (browser zoom) is never intercepted', () => {
        const s = standardScene();
        loadScript(s);
        const ev = wheelAt(s, 450, 300, { ctrlKey: true });
        eq(ev.prevented, false, 'prevented');
        eq(s.video.currentTime, 100, 'currentTime');
    });

    check('meta+wheel is never intercepted', () => {
        const s = standardScene();
        loadScript(s);
        const ev = wheelAt(s, 450, 300, { extra: { metaKey: true } });
        eq(ev.prevented, false, 'prevented');
    });

    check('horizontal-dominant wheel gestures stay native', () => {
        const s = standardScene();
        loadScript(s);
        const ev = wheelAt(s, 450, 300, { extra: { deltaX: -120, deltaY: -20 } });
        eq(ev.prevented, false, 'prevented');
    });
})();

// =================================================================
// F. Exact zone boundaries (1/3 and 2/3)
// =================================================================
console.log('\nF. Exact zone boundaries');

(function () {
    check('x = 300px is the MIDDLE column', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 300, 100);
        eq(s.video.currentTime, 110, 'currentTime');
        eq(s.video.playbackRate, 1, 'rate');
    });

    check('x = 599px is still the MIDDLE column', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 599, 100);
        eq(s.video.currentTime, 110, 'currentTime');
    });

    check('x = 600px is the RIGHT column', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 600, 100);
        eq(s.video.volume, 0.6, 'volume');
        eq(s.video.currentTime, 100, 'currentTime');
    });

    check('x = 299px is the LEFT column', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 299, 100);
        eq(s.video.playbackRate, 1.5, 'rate');
    });

    check('y = 200px is the MIDDLE row', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 100, 200);
        eq(s.video.playbackRate, 1.25, 'rate');
    });

    check('y = 400px is the BOTTOM row', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 100, 400);
        eq(s.video.playbackRate, 1.1, 'rate');
    });

    check('y = 199px is the TOP row', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 100, 199);
        eq(s.video.playbackRate, 1.5, 'rate');
    });
})();

// =================================================================
// G. RMB context-menu suppression
// =================================================================
console.log('\nG. RMB context-menu suppression');

(function () {
    function contextmenuAt(scene, x, y) {
        const hit = scene.elementFromPoint(x, y);
        return fire(scene, 'window', 'contextmenu', makeEvent({
            clientX: x, clientY: y, target: hit, path: hit ? [hit, hit.parentElement, scene.body] : []
        }));
    }

    check('contextmenu suppressed after an RMB + frame step on that video', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 450, 500, { rmb: true });
        eq(contextmenuAt(s, 450, 500).prevented, true, 'prevented');
    });

    check('contextmenu NOT suppressed without a preceding action', () => {
        const s = standardScene();
        loadScript(s);
        eq(contextmenuAt(s, 450, 500).prevented, false, 'prevented');
    });

    check('contextmenu NOT suppressed outside the video bounds', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 450, 500, { rmb: true });
        eq(contextmenuAt(s, -5, -5).prevented, false, 'prevented');
    });

    check('contextmenu suppression is scoped to the video that saw the gesture', () => {
        const s = standardScene((scene, El, makeVideo) => {
            const v2 = makeVideo({ rect: { left: 0, top: 700, width: 900, height: 600 }, z: 2 });
            v2.ownerDocument = scene.doc;
            scene.body.appendChild(v2);
            scene.add(v2);
            scene.video2 = v2;
        });
        loadScript(s);
        wheelAt(s, 450, 500, { rmb: true });
        eq(contextmenuAt(s, 450, 800).prevented, false, 'contextmenu on video 2 stays native');
        eq(contextmenuAt(s, 450, 500).prevented, true, 'contextmenu on video 1 is suppressed');
    });

    check('RMB that does nothing does not suppress the menu', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 450, 100, { rmb: true });
        eq(contextmenuAt(s, 450, 100).prevented, false, 'prevented');
    });
})();

// =================================================================
// H. Keyboard
// =================================================================
console.log('\nH. Keyboard controls');

(function () {
    check('ArrowRight seeks +5s', () => {
        const s = standardScene();
        loadScript(s);
        keydown(s, {});
        eq(s.video.currentTime, 105, 'currentTime');
    });

    check('Shift+ArrowRight seeks +1s', () => {
        const s = standardScene();
        loadScript(s);
        keydown(s, { shiftKey: true });
        eq(s.video.currentTime, 101, 'currentTime');
    });

    check('Ctrl+ArrowLeft seeks -60s', () => {
        const s = standardScene();
        loadScript(s);
        keydown(s, { code: 'ArrowLeft', key: 'ArrowLeft', ctrlKey: true });
        eq(s.video.currentTime, 40, 'currentTime');
    });

    check('keydown is single-registered (no duplicate seeks)', () => {
        const s = standardScene();
        loadScript(s);
        eq((s.window._listeners.keydown || []).length, 1, 'window keydown listeners');
        keydown(s, {});
        eq(s.video.currentTime, 105, 'currentTime');
    });

    check('no keyup listener is registered (the page must see key releases)', () => {
        const s = standardScene();
        loadScript(s);
        eq((s.window._listeners.keyup || []).length, 0, 'window keyup listeners');
        eq((s.doc._listeners.keyup || []).length, 0, 'document keyup listeners');
    });

    check('a page-level keydown listener still fires (no stopImmediatePropagation)', () => {
        const s = standardScene();
        loadScript(s);
        let pageSaw = 0;
        s.window.addEventListener('keydown', () => { pageSaw++; }, false);
        keydown(s, {});
        eq(pageSaw, 1, 'page keydown handlers');
    });

    check('ArrowRight at the end of the media is not swallowed', () => {
        const s = standardScene();
        loadScript(s);
        s.video.currentTime = 200;
        const ev = keydown(s, {});
        eq(s.video.currentTime, 200, 'currentTime');
        eq(ev.prevented, false, 'prevented');
    });

    check('arrows are ignored while typing in a text input', () => {
        const s = standardScene((scene, El) => {
            const input = new El('input', { rect: { left: 0, top: 650, width: 200, height: 30 }, z: 5, type: 'text' });
            input.ownerDocument = scene.doc;
            scene.body.appendChild(input);
            scene.add(input);
            scene.doc.activeElement = input;
        });
        loadScript(s);
        const ev = keydown(s, {});
        eq(s.video.currentTime, 100, 'currentTime');
        eq(ev.prevented, false, 'prevented');
    });

    check('arrows are ignored for an input inside a shadow root', () => {
        const s = standardScene((scene, El) => {
            const host = new El('my-widget', { rect: { left: 0, top: 650, width: 200, height: 40 }, z: 5 });
            host.ownerDocument = scene.doc;
            scene.body.appendChild(host);
            scene.add(host);
            const input = new El('input', { rect: { left: 0, top: 650, width: 200, height: 30 }, z: 6, type: 'search' });
            input.ownerDocument = scene.doc;
            input.parentElement = host;
            scene.shadowInput = input;
            scene.shadowHost = host;
            // activeElement reports the HOST, not the inner input
            scene.doc.activeElement = host;
        });
        loadScript(s);
        const input = s.shadowInput;
        const ev = makeEvent({
            code: 'ArrowRight', key: 'ArrowRight', type: 'keydown',
            target: input, path: [input, s.shadowHost, s.body, s.doc, s.window]
        });
        fire(s, 'window', 'keydown', ev);
        eq(s.video.currentTime, 100, 'currentTime');
        eq(ev.prevented, false, 'prevented');
    });

    check('arrows are ignored for a contenteditable region', () => {
        const s = standardScene((scene, El) => {
            const box = new El('div', {
                rect: { left: 0, top: 650, width: 400, height: 100 }, z: 5, contentEditable: true
            });
            box.ownerDocument = scene.doc;
            scene.body.appendChild(box);
            scene.add(box);
            scene.doc.activeElement = box;
        });
        loadScript(s);
        keydown(s, {});
        eq(s.video.currentTime, 100, 'currentTime');
    });

    check('arrows are ignored for a focused <select> (native list navigation)', () => {
        const s = standardScene((scene, El) => {
            const sel = new El('select', { rect: { left: 0, top: 650, width: 200, height: 30 }, z: 5 });
            sel.ownerDocument = scene.doc;
            scene.body.appendChild(sel);
            scene.add(sel);
            scene.doc.activeElement = sel;
        });
        loadScript(s);
        const ev = keydown(s, {});
        eq(s.video.currentTime, 100, 'currentTime');
        eq(ev.prevented, false, 'prevented');
    });

    check('arrows target the hovered video, not the first one in the DOM', () => {
        const s = standardScene((scene, El, makeVideo) => {
            const v2 = makeVideo({ rect: { left: 0, top: 700, width: 900, height: 600 }, z: 2 });
            v2.ownerDocument = scene.doc;
            scene.body.appendChild(v2);
            scene.add(v2);
            scene.video2 = v2;
        });
        loadScript(s);
        fire(s, 'window', 'mouseover', makeEvent({ target: s.video2, path: [s.video2, s.body] }));
        keydown(s, {});
        eq(s.video2.currentTime, 105, 'hovered video');
        eq(s.video.currentTime, 100, 'first video untouched');
    });

    check('F toggles fullscreen and F again exits it', () => {
        const s = standardScene();
        let requested = 0;
        s.video.requestFullscreen = function () {
            requested++;
            s.doc.fullscreenElement = s.wrap;
            return Promise.resolve();
        };
        loadScript(s);
        const ev = keydown(s, { code: 'KeyF', key: 'f' });
        eq(requested, 1, 'requestFullscreen calls');
        eq(s.doc.fullscreenElement, s.wrap, 'fullscreen element');
        eq(ev.prevented, true, 'prevented');
        keydown(s, { code: 'KeyF', key: 'f' });
        eq(s.doc.fullscreenElement, null, 'fullscreen element after the second press');
    });

    check('F is left native when the browser refuses fullscreen', () => {
        const s = standardScene();
        loadScript(s);
        const ev = keydown(s, { code: 'KeyF', key: 'f' });
        eq(ev.prevented, false, 'prevented');
    });
})();

// =================================================================
// I. Frame-rate probe
// =================================================================
console.log('\nI. Frame-rate probe (requestVideoFrameCallback)');

(function () {
    function paint(video) {
        const cbs = [];
        video.requestVideoFrameCallback = (fn) => { cbs.push(fn); };
        video.paused = false;
        return {
            frames(times) {
                for (let i = 0; i < times.length; i++) {
                    const fn = cbs.shift();
                    if (fn) fn(0, { mediaTime: times[i] });
                }
            }
        };
    }

    check('play starts the probe when the API is available', () => {
        const s = standardScene();
        loadScript(s);
        let calls = 0;
        s.video.requestVideoFrameCallback = () => { calls++; };
        fire(s, 'document', 'play', makeEvent({ target: s.video }));
        eq(calls, 1, 'requestVideoFrameCallback calls');
    });

    check('probe stores the MEDIAN frame duration after enough samples', () => {
        const s = standardScene();
        loadScript(s);
        const p = paint(s.video);
        fire(s, 'document', 'play', makeEvent({ target: s.video }));
        const times = [0, 1 / 30, 2 / 30, 3 / 30, 3 / 30 + 0.15];
        for (let i = 1; i <= 24; i++) times.push(3 / 30 + 0.15 + i / 30);
        p.frames(times);
        ok(s.video.__ccvFrameDuration, 'frame duration recorded');
        near(1 / s.video.__ccvFrameDuration, 30, 'implied fps', 0.5);
        eq(s.video.__ccvProbing, false, 'probing flag');
    });

    check('a stalled probe is cancelled by pause and can restart', () => {
        const s = standardScene();
        loadScript(s);
        s.video.requestVideoFrameCallback = () => {};
        fire(s, 'document', 'play', makeEvent({ target: s.video }));
        eq(s.video.__ccvProbing, true, 'probing after play');
        fire(s, 'document', 'pause', makeEvent({ target: s.video }));
        eq(s.video.__ccvProbing, false, 'probing after pause');
        s.video.requestVideoFrameCallback = () => {};
        fire(s, 'document', 'play', makeEvent({ target: s.video }));
        eq(s.video.__ccvProbing, true, 'probing restarts on the next play');
    });

    check('an in-flight probe cannot overwrite a newer measurement', () => {
        const s = standardScene();
        loadScript(s);
        const cbs = [];
        s.video.requestVideoFrameCallback = (fn) => { cbs.push(fn); };
        fire(s, 'document', 'play', makeEvent({ target: s.video }));
        fire(s, 'document', 'play', makeEvent({ target: s.video }));
        const stale = cbs.shift();
        s.video.__ccvFrameDuration = 1 / 60;
        if (stale) {
            for (let i = 0; i < 40; i++) stale(0, { mediaTime: i / 30 });
        }
        near(1 / (s.video.__ccvFrameDuration || 1 / 30), 30, 'stale probe is ignored');
    });

    check('a new media resource drops the cached frame duration', () => {
        const s = standardScene();
        loadScript(s);
        s.video.__ccvFrameDuration = 1 / 24;
        fire(s, 'document', 'loadstart', makeEvent({ target: s.video }));
        eq(s.video.__ccvFrameDuration, undefined, 'frame duration');
    });

    check('stepFrames uses the measured duration once available', () => {
        const s = standardScene();
        loadScript(s);
        s.video.__ccvFrameDuration = 1 / 60;
        wheelAt(s, 450, 500, { rmb: true });
        near(s.video.currentTime, 100 + 1 / 60, 'currentTime');
    });
})();

// =================================================================
// J. Multiple videos / wrong-target regressions
// =================================================================
console.log('\nJ. Multiple videos (wrong-target regressions)');

(function () {
    function twoVideos() {
        return standardScene((scene, El, makeVideo) => {
            const v2 = makeVideo({ rect: { left: 0, top: 700, width: 900, height: 600 }, z: 2 });
            v2.ownerDocument = scene.doc;
            scene.body.appendChild(v2);
            scene.add(v2);
            scene.video2 = v2;
        });
    }

    check('wheel over the SECOND video controls that video', () => {
        const s = twoVideos();
        loadScript(s);
        wheelAt(s, 100, 800);
        eq(s.video2.playbackRate, 1.5, 'second video rate');
        eq(s.video.playbackRate, 1, 'first video rate');
    });

    check('wheel over the second video seeks the second video', () => {
        const s = twoVideos();
        loadScript(s);
        wheelAt(s, 450, 800);
        eq(s.video2.currentTime, 110, 'second video currentTime');
        eq(s.video.currentTime, 100, 'first video currentTime');
    });

    check('a hidden preload video earlier in the DOM is never targeted', () => {
        const s = makeScene((scene, El, makeVideo) => {
            const hidden = makeVideo({
                rect: { left: 0, top: 0, width: 1, height: 1 }, z: 0, css: { display: 'none' }
            });
            hidden.ownerDocument = scene.doc;
            scene.body.appendChild(hidden);
            scene.add(hidden);
            scene.hidden = hidden;

            const wrap = new El('div', { cls: 'videoplayer', rect: { left: 0, top: 100, width: 900, height: 600 }, z: 1 });
            wrap.ownerDocument = scene.doc;
            scene.body.appendChild(wrap);
            const v = makeVideo({ rect: { left: 0, top: 100, width: 900, height: 600 }, z: 2 });
            v.ownerDocument = scene.doc;
            wrap.appendChild(v);
            scene.add(wrap);
            scene.add(v);
            scene.video = v;
            scene.wrap = wrap;
        });
        loadScript(s);
        wheelAt(s, 100, 200);
        eq(s.video.playbackRate, 1.5, 'visible video rate');
        eq(s.hidden.playbackRate, 1, 'hidden video rate');
        eq(s.hidden.currentTime, 100, 'hidden video currentTime');
    });

    check('keyboard falls back to the visible video when a hidden one comes first', () => {
        const s = makeScene((scene, El, makeVideo) => {
            const hidden = makeVideo({ rect: { left: 0, top: 0, width: 1, height: 1 }, css: { display: 'none' } });
            hidden.ownerDocument = scene.doc;
            scene.body.appendChild(hidden);
            scene.add(hidden);
            scene.hidden = hidden;

            const v = makeVideo({ rect: { left: 0, top: 100, width: 900, height: 600 }, z: 2 });
            v.ownerDocument = scene.doc;
            scene.body.appendChild(v);
            scene.add(v);
            scene.video = v;
        });
        loadScript(s);
        keydown(s, {});
        eq(s.video.currentTime, 105, 'visible video');
        eq(s.hidden.currentTime, 100, 'hidden video untouched');
    });
})();

// =================================================================
// K. Overlays, wrappers and letterboxing
// =================================================================
console.log('\nK. Overlays, wrappers and letterboxing');

(function () {
    check('text next to a video in the same wrapper scrolls the page', () => {
        const s = makeScene((scene, El, makeVideo) => {
            const wrap = new El('div', { cls: 'videoplayer', rect: { left: 0, top: 0, width: 900, height: 1200 }, z: 1 });
            wrap.ownerDocument = scene.doc;
            scene.body.appendChild(wrap);
            const v = makeVideo({ rect: { left: 0, top: 0, width: 900, height: 600 }, z: 2 });
            v.ownerDocument = scene.doc;
            wrap.appendChild(v);
            const p = new El('p', { rect: { left: 0, top: 700, width: 900, height: 300 }, z: 2 });
            p.ownerDocument = scene.doc;
            wrap.appendChild(p);
            [wrap, v, p].forEach((el) => scene.add(el));
            scene.video = v;
            scene.para = p;
        });
        loadScript(s);
        const ev = wheelAt(s, 450, 800);
        eq(ev.prevented, false, 'prevented');
        eq(s.video.currentTime, 100, 'currentTime');
        eq(s.video.playbackRate, 1, 'rate');
    });

    check('a scrollable panel drawn over the video keeps its native scroll', () => {
        const s = standardScene((scene, El) => {
            const panel = new El('div', {
                rect: { left: 700, top: 20, width: 180, height: 200 }, z: 6,
                css: { overflowY: 'auto' }, scrollHeight: 800, clientHeight: 200
            });
            panel.ownerDocument = scene.doc;
            scene.wrap.appendChild(panel);
            const item = new El('div', { rect: { left: 700, top: 20, width: 180, height: 40 }, z: 7 });
            item.ownerDocument = scene.doc;
            panel.appendChild(item);
            scene.add(panel);
            scene.add(item);
        });
        loadScript(s);
        const ev = wheelAt(s, 780, 40);
        eq(ev.prevented, false, 'prevented');
        eq(s.video.volume, 0.5, 'volume untouched');
        eq(s.video.currentTime, 100, 'currentTime untouched');
    });

    check('letterbox bars are not a control surface', () => {
        const s = makeScene((scene, El, makeVideo) => {
            const v = makeVideo({
                rect: { left: 0, top: 0, width: 800, height: 450 }, z: 2,
                css: { objectFit: 'contain' }, videoWidth: 640, videoHeight: 480
            });
            v.ownerDocument = scene.doc;
            scene.body.appendChild(v);
            scene.add(v);
            scene.video = v;
        });
        loadScript(s);
        const bar = wheelAt(s, 20, 200);
        eq(bar.prevented, false, 'prevented in the bar');
        eq(s.video.playbackRate, 1, 'rate in the bar');
        const pic = wheelAt(s, 150, 200);
        eq(pic.prevented, true, 'prevented on the picture');
        eq(s.video.playbackRate, 1.25, 'rate on the picture (middle row)');
        const top = wheelAt(s, 150, 50);
        eq(top.prevented, true, 'prevented on the top row');
        eq(s.video.playbackRate, 1.75, 'rate on the picture (top row)');
    });

    check('an overlay control inside the player still drives the video', () => {
        const s = standardScene((scene, El) => {
            const bar = new El('div', {
                rect: { left: 0, top: 520, width: 900, height: 80 }, z: 6, css: { overflowY: 'visible' }
            });
            bar.ownerDocument = scene.doc;
            scene.wrap.appendChild(bar);
            scene.add(bar);
        });
        loadScript(s);
        wheelAt(s, 100, 540);
        eq(s.video.playbackRate, 1.1, 'rate (bottom row of the video)');
    });
})();

// =================================================================
// L. Wheel gesture normalisation (trackpad)
// =================================================================
console.log('\nL. Wheel gesture normalisation');

(function () {
    check('a burst of tiny trackpad events does not become a burst of steps', () => {
        const s = standardScene();
        loadScript(s);
        for (let i = 0; i < 10; i++) wheelAt(s, 100, 100, { deltaY: -4 });
        eq(s.video.playbackRate, 1, 'rate after 40px');
    });

    check('the same burst keeps accumulating until one notch is reached', () => {
        const s = standardScene();
        loadScript(s);
        for (let i = 0; i < 10; i++) wheelAt(s, 100, 100, { deltaY: -4 });
        for (let i = 0; i < 3; i++) wheelAt(s, 100, 100, { deltaY: -4 });
        eq(s.video.playbackRate, 1.5, 'rate after one notch');
    });

    check('a direction flip restarts the accumulation', () => {
        const s = standardScene();
        loadScript(s);
        for (let i = 0; i < 10; i++) wheelAt(s, 100, 100, { deltaY: -4 });
        wheelAt(s, 100, 100, { deltaY: 4 });
        for (let i = 0; i < 10; i++) wheelAt(s, 100, 100, { deltaY: -4 });
        eq(s.video.playbackRate, 1, 'rate');
    });

    check('a paused gesture does not combine with a later flick', () => {
        const s = standardScene();
        loadScript(s);
        for (let i = 0; i < 8; i++) wheelAt(s, 100, 100, { deltaY: -6 });    // 48px, then a pause
        s.advance(1500);
        for (let i = 0; i < 8; i++) wheelAt(s, 100, 100, { deltaY: -6 });    // 48px of a new gesture
        eq(s.video.playbackRate, 1, 'rate (no notch in either gesture)');
        s.advance(1500);
        wheelAt(s, 100, 100, { deltaY: -60 });
        eq(s.video.playbackRate, 1.5, 'rate after a single deliberate notch');
    });

    check('a deliberate mouse notch is exactly one step', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 100, 100, { deltaY: -100 });
        eq(s.video.playbackRate, 1.5, 'rate');
        wheelAt(s, 100, 100, { deltaY: -100 });
        eq(s.video.playbackRate, 2, 'rate');
    });

    check('deltaMode lines (Firefox) are normalised to pixels', () => {
        const s = standardScene();
        loadScript(s);
        wheelAt(s, 100, 100, { deltaY: -3, extra: { deltaMode: 1 } });
        eq(s.video.playbackRate, 1, 'rate after 48px');
        wheelAt(s, 100, 100, { deltaY: -3, extra: { deltaMode: 1 } });
        eq(s.video.playbackRate, 1.5, 'rate after 96px');
    });

    check('accumulation is per video', () => {
        const s = standardScene((scene, El, makeVideo) => {
            const v2 = makeVideo({ rect: { left: 0, top: 700, width: 900, height: 600 }, z: 2 });
            v2.ownerDocument = scene.doc;
            scene.body.appendChild(v2);
            scene.add(v2);
            scene.video2 = v2;
        });
        loadScript(s);
        for (let i = 0; i < 10; i++) wheelAt(s, 100, 100, { deltaY: -4 });
        wheelAt(s, 100, 800, { deltaY: -100 });
        eq(s.video.playbackRate, 1, 'video 1 rate');
        eq(s.video2.playbackRate, 1.5, 'video 2 rate');
    });
})();

// =================================================================
// M. Robustness of the media helpers
// =================================================================
console.log('\nM. Media helpers');

(function () {
    check('a video whose metadata has not loaded yet (currentTime NaN) is a no-op', () => {
        const s = standardScene();
        loadScript(s);
        Object.defineProperty(s.video, 'currentTime', { get() { return NaN; }, set() { throw new Error('must not be set'); } });
        const ev = wheelAt(s, 450, 300);
        eq(ev.prevented, false, 'prevented');
        const kev = keydown(s, {});
        eq(kev.prevented, false, 'keydown prevented');
    });

    check('a throwing currentTime setter never escapes the script', () => {
        const s = standardScene();
        loadScript(s);
        Object.defineProperty(s.video, 'currentTime', {
            get() { return 100; },
            set() { throw new TypeError('non-finite'); }
        });
        const ev = wheelAt(s, 450, 300);
        eq(ev.prevented, false, 'prevented');
    });

    check('a 0x0 (collapsed) video is never targeted', () => {
        const s = makeScene((scene, El, makeVideo) => {
            const v = makeVideo({ rect: { left: 0, top: 0, width: 0, height: 0 }, z: 2 });
            v.ownerDocument = scene.doc;
            scene.body.appendChild(v);
            scene.add(v);
            scene.video = v;
            const p = new El('p', { rect: { left: 0, top: 0, width: 900, height: 300 }, z: 1 });
            p.ownerDocument = scene.doc;
            scene.body.appendChild(p);
            scene.add(p);
        });
        loadScript(s);
        const ev = wheelAt(s, 450, 150);
        eq(ev.prevented, false, 'prevented');
        eq(s.video.playbackRate, 1, 'rate');
    });
})();

// =================================================================
// Summary
// =================================================================
console.log('\n' + '='.repeat(64));
console.log('  ' + passed + ' passed, ' + failed + ' failed');
if (failed) {
    console.log('-'.repeat(64));
    failures.forEach((f) => console.log('  * ' + f));
}
console.log('='.repeat(64));

process.exit(failed === 0 ? 0 : 1);
