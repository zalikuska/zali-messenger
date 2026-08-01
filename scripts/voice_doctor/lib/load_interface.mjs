// Loads the REAL web/src/interface.js into a Node VM context, so the checks
// exercise the shipping ZaliInterface methods rather than a copy of them.
//
// Only browser I/O is stubbed (DOM, storage, media, RTC). Nothing in the
// negotiation logic is replaced — if a check fails, it failed in production code.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(here, '..', '..', '..');
export const INTERFACE_PATH = path.join(REPO_ROOT, 'web', 'src', 'interface.js');

function stubElement() {
    const el = {
        style: {}, dataset: {}, children: [], hidden: false,
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, removeEventListener() {},
        appendChild(c) { el.children.push(c); return c; },
        removeChild() {}, remove() {}, querySelector: () => null,
        querySelectorAll: () => [], setAttribute() {}, getAttribute: () => null,
        insertAdjacentHTML() {}, focus() {}, blur() {}, scrollIntoView() {},
        play: () => Promise.resolve(), pause() {},
        set innerHTML(v) { el._html = v; }, get innerHTML() { return el._html || ''; },
        textContent: '', value: '', paused: true, muted: false, volume: 1, readyState: 4,
        srcObject: null, autoplay: false, playsInline: false, defaultMuted: false,
    };
    return el;
}

function stubStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => { map.set(String(k), String(v)); },
        removeItem: (k) => { map.delete(k); },
        key: (i) => Array.from(map.keys())[i] ?? null,
        get length() { return map.size; },
        clear: () => map.clear(),
    };
}

/**
 * @param {object} extraGlobals globals injected into the sandbox (RTCPeerConnection, …)
 * @returns {{ ZaliInterface: Function, sandbox: object }}
 */
export function loadZaliInterface(extraGlobals = {}, clock = null) {
    const src = fs.readFileSync(INTERFACE_PATH, 'utf8');
    const win = {};
    const doc = {
        body: stubElement(),
        documentElement: stubElement(),
        hidden: false,
        addEventListener() {}, removeEventListener() {},
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        createElement: () => stubElement(),
        createDocumentFragment: () => stubElement(),
    };
    const sandbox = {
        window: win,
        document: doc,
        localStorage: stubStorage(),
        sessionStorage: stubStorage(),
        navigator: { userAgent: 'voice-doctor', mediaDevices: { enumerateDevices: async () => [] }, onLine: true },
        console,
        setTimeout: clock ? clock.setTimeout.bind(clock) : setTimeout,
        clearTimeout: clock ? clock.clearTimeout.bind(clock) : clearTimeout,
        setInterval: clock ? clock.setInterval.bind(clock) : setInterval,
        clearInterval: clock ? clock.clearInterval.bind(clock) : clearInterval,
        queueMicrotask,
        requestAnimationFrame: (fn) => (clock ? clock.setTimeout(() => fn(clock.now), 0) : setTimeout(() => fn(Date.now()), 0)),
        cancelAnimationFrame: clock ? clock.clearTimeout.bind(clock) : clearTimeout,
        URL, URLSearchParams, TextEncoder, TextDecoder,
        btoa, atob, Uint8Array, ArrayBuffer, JSON, Math, Date, Promise, Error, Object, Array, Map, Set, String, Number, Boolean,
        crypto: globalThis.crypto,
        fetch: async () => { throw new Error('network disabled in voice-doctor'); },
        WebSocket: class { constructor() { throw new Error('WebSocket disabled in voice-doctor'); } },
        Event: class { constructor(t) { this.type = t; } },
        CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o?.detail; } },
        ...extraGlobals,
    };
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    Object.assign(win, {
        addEventListener() {}, removeEventListener() {},
        location: { href: 'http://localhost/', hostname: 'localhost', protocol: 'http:' },
        crypto: globalThis.crypto,
        matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
        innerWidth: 1440, innerHeight: 900,
        localStorage: sandbox.localStorage,
        sessionStorage: sandbox.sessionStorage,
        navigator: sandbox.navigator,
        document: doc,
        ...extraGlobals,
    });
    vm.createContext(sandbox);
    vm.runInContext(src, sandbox, { filename: 'web/src/interface.js' });
    if (typeof win.ZaliInterface !== 'function') {
        throw new Error('interface.js did not export window.ZaliInterface');
    }
    // `DefaultApiRoutes` is a module-scope const, not exported to window — but it
    // is a lexical binding of this context, so the context can hand it over.
    // Instances built with Object.create() skip the constructor that assigns it.
    let apiRoutes = null;
    try { apiRoutes = vm.runInContext('DefaultApiRoutes', sandbox); } catch (e) {}
    return { ZaliInterface: win.ZaliInterface, sandbox, apiRoutes };
}
