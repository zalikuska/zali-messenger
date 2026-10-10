// --- ZaliInterface: запуск аддонов хаба — песочница, RPC, «Свернуть». ---
// Часть класса ZaliInterface (см. web/src/interface.js). Дизайн — docs/ADDONS.md.
//
// Аддон работает в <iframe sandbox="allow-scripts allow-pointer-lock" srcdoc>:
// opaque-origin, ни DOM, ни localStorage/IndexedDB, ни глобалов приложения ему
// не видно. Документ собирается здесь: CSP первым тегом, затем SDK `window.zali`
// (modules/addon_sdk.js) и CSS-переменные темы, затем разметка аддона, где его
// скрипты и стили встроены, а картинки/медиа заменены data:-URL. Наружу аддон
// ходит только RPC через postMessage, и только сюда: каждое сообщение
// сверяется с event.source его фрейма, каждый метод — с его разрешениями.
//
// Нативный мост виден всем фреймам вебвью, поэтому песочница запускается лишь
// там, где оболочка закрыла мост от дочерних фреймов (capability `addonFrames`,
// см. скилл security-invariants), или без моста вовсе — в браузере.

const ZALI_ADDON_RPC = 'zali-addon-rpc';
const ZALI_ADDON_EVENT = 'zali-addon-event';
const ZALI_ADDON_MAX_RUNNING = 4;
const ZALI_ADDON_MAX_INFLIGHT = 64;
const ZALI_ADDON_HELLO_TIMEOUT_MS = 15000;
const ZALI_ADDON_KV_PATH = 'kv.json';

ZaliMixin(ZaliInterface, class {

    addonsSandboxAvailable() {
        return !this.hasNativeBridge() || this.nativeSupports('addonFrames');
    }

    /** 'macos' | 'windows' | 'android' | 'ios' | 'web' */
    addonPlatform() {
        const bridge = this.nativeBridge();
        if (!bridge?.available) return 'web';
        if (bridge.transport === 'android') return 'android';
        const ua = navigator.userAgent || '';
        const touchMac = /Macintosh/.test(ua) && Number(navigator.maxTouchPoints || 0) > 1;
        if (bridge.transport === 'webkit') return /iPhone|iPad|iPod/.test(ua) || touchMac ? 'ios' : 'macos';
        return /Macintosh|Mac OS X/.test(ua) ? 'macos' : 'windows';
    }

    /** Может ли эта сборка выдать разрешение (повышенные — только с нативной поддержкой). */
    addonPermissionSupported(permission, manifest = null) {
        switch (permission) {
            case 'fs.read':
            case 'fs.write':
                return this.nativeSupports('addonFs');
            case 'launch':
                return this.nativeSupports('addonLaunch');
            case 'process': {
                if (!this.nativeSupports('addonProcess')) return false;
                const os = this.addonPlatform();
                const commands = manifest?.backend?.commands || {};
                return Object.keys(commands).some(key => key.startsWith(`${os}-`));
            }
            case 'microphone':
                return !!(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
            default:
                return true;
        }
    }

    addonInstances() {
        if (!this._addonInstances) this._addonInstances = new Map();
        return this._addonInstances;
    }

    expandedAddonInstance() {
        for (const instance of this.addonInstances().values()) {
            if (instance.expanded) return instance;
        }
        return null;
    }

    addonError(code, message) {
        return Object.assign(new Error(message), { code });
    }

    // ---- Запуск и жизненный цикл ----

    async launchAddon(id) {
        const running = this.addonInstances().get(id);
        if (running) {
            this.expandAddon(id);
            return running;
        }
        if (!this.addonsSandboxAvailable()) throw this.addonError('unsupported', 'Аддоны недоступны в этой версии приложения');
        if (this.addonInstances().size >= ZALI_ADDON_MAX_RUNNING) {
            throw this.addonError('busy', `Работает уже ${ZALI_ADDON_MAX_RUNNING} аддона — остановите один из них в хабе`);
        }
        const meta = (this._addonsList || []).find(item => item.id === id);
        if (!meta) throw this.addonError('not_found', 'Аддон не установлен');

        const F = window.ZaliAddonFormat;
        const bytes = await this.addonStoreGetArchive(id);
        // Файл перепроверяется при каждом запуске: в хранилище он мог быть
        // подменён, а права выдавались конкретному отпечатку.
        const info = await F.inspect(bytes);
        if (meta.sha256 && info.sha256 && meta.sha256 !== info.sha256) {
            throw this.addonError('tampered', 'Файл аддона изменился после установки — переустановите его');
        }
        if (info.manifest.id !== id) throw this.addonError('tampered', 'Файл аддона не совпадает с установленным');
        for (const permission of info.manifest.permissions) {
            if (!this.addonPermissionSupported(permission, info.manifest)) {
                throw this.addonError('unsupported', `Нужно разрешение «${F.permissionInfo(permission)?.title || permission}», а здесь его нет`);
            }
        }

        const instance = {
            id,
            manifest: info.manifest,
            sha256: info.sha256,
            files: info.files,
            iframe: null,
            wrap: null,
            expanded: false,
            ready: false,
            title: '',
            loadCount: 0,
            inflight: 0,
            kv: null,
            kvWrite: Promise.resolve(),
            startedAt: Date.now(),
            collapsedAt: 0,
            helloTimer: 0,
        };
        this.addonInstances().set(id, instance);
        try {
            await this.addonSessionStart?.(instance);
            this.mountAddonFrame(instance);
        } catch (error) {
            this.addonInstances().delete(id);
            throw error;
        }
        this.expandAddon(id);
        this.renderHubAddons?.();
        return instance;
    }

    mountAddonFrame(instance) {
        this.installAddonMessageListener();
        const stage = document.getElementById('addonStage');
        if (!stage) throw this.addonError('failed', 'Нет места для аддона в разметке');
        const wrap = document.createElement('div');
        wrap.className = 'addon-frame-wrap is-loading';
        wrap.dataset.addonId = instance.id;
        wrap.hidden = true;
        wrap.innerHTML = `
            <div class="addon-frame-state" role="status" aria-live="polite">
                <span class="addon-frame-spinner" aria-hidden="true"></span>
                <span class="addon-frame-state-text"></span>
                <button class="auth-btn primary addon-frame-close" type="button" hidden>Закрыть аддон</button>
            </div>`;
        wrap.querySelector('.addon-frame-state-text').textContent = `Запуск «${instance.manifest.name}»…`;
        wrap.querySelector('.addon-frame-close').addEventListener('click', () => this.stopAddon(instance.id));

        const iframe = document.createElement('iframe');
        iframe.className = 'addon-frame';
        // Без allow-same-origin: opaque-origin. Без allow-popups/-top-navigation/
        // -forms/-downloads/-modals: окна, уход приложения, формы, загрузки и
        // alert идут только через SDK. Пустой allow — никаких возможностей
        // (камера, микрофон, геолокация) фрейму не делегируется.
        iframe.setAttribute('sandbox', 'allow-scripts allow-pointer-lock');
        iframe.setAttribute('allow', '');
        iframe.setAttribute('referrerpolicy', 'no-referrer');
        iframe.setAttribute('title', instance.manifest.name);
        iframe.addEventListener('load', () => {
            instance.loadCount += 1;
            // Первый load — наш srcdoc. Любой следующий — аддон увёл свой фрейм
            // (location, ссылка, reload): там уже не наш документ и не наш CSP.
            if (instance.loadCount > 1) {
                this.failAddon(instance, 'Аддон попытался открыть другую страницу и был остановлен.');
            }
        });
        iframe.srcdoc = this.buildAddonDocument(instance);
        wrap.appendChild(iframe);
        stage.appendChild(wrap);
        instance.iframe = iframe;
        instance.wrap = wrap;
        instance.helloTimer = setTimeout(() => {
            if (!instance.ready) this.failAddon(instance, 'Аддон не запустился: документ не загрузился.');
        }, ZALI_ADDON_HELLO_TIMEOUT_MS);
    }

    failAddon(instance, message) {
        if (!this.addonInstances().has(instance.id)) return;
        clearTimeout(instance.helloTimer);
        instance.ready = false;
        // Фрейм выгружается сразу: чужой документ в нём не должен жить ни секунды.
        try { instance.iframe?.remove(); } catch (e) { /* уже нет */ }
        instance.iframe = null;
        this.addonSessionEnd?.(instance);
        const wrap = instance.wrap;
        if (wrap) {
            wrap.classList.remove('is-loading');
            wrap.classList.add('is-error');
            const text = wrap.querySelector('.addon-frame-state-text');
            if (text) text.textContent = message;
            const close = wrap.querySelector('.addon-frame-close');
            if (close) close.hidden = false;
        }
        this.addLogEntry?.({ type: 'WARN', msg: `Аддон ${instance.id}: ${message}`, ts: new Date().toLocaleTimeString() });
        this.renderHubAddons?.();
    }

    expandAddon(id) {
        const target = this.addonInstances().get(id);
        if (!target) return;
        for (const instance of this.addonInstances().values()) {
            const show = instance === target;
            if (instance.expanded !== show) {
                instance.expanded = show;
                if (!show) instance.collapsedAt = Date.now();
                this.emitAddonEvent(instance, 'visibility', { visible: show });
            }
            if (instance.wrap) instance.wrap.hidden = !show;
        }
        const stage = document.getElementById('addonStage');
        if (stage) stage.hidden = false;
        this.closeMobileSidebar?.();
        this.renderAddonTitlebar();
        requestAnimationFrame(() => {
            try { target.iframe?.focus(); } catch (e) { /* фрейма уже нет */ }
        });
    }

    collapseAddon() {
        const instance = this.expandedAddonInstance();
        if (!instance) return false;
        instance.expanded = false;
        instance.collapsedAt = Date.now();
        if (instance.wrap) instance.wrap.hidden = true;
        const stage = document.getElementById('addonStage');
        if (stage) stage.hidden = true;
        this.emitAddonEvent(instance, 'visibility', { visible: false });
        this.renderAddonTitlebar();
        this.renderHubAddons?.();
        return true;
    }

    /** Навигация приложения (хаб, чаты, настройки, нижняя панель) прячет аддон. */
    collapseAddonForNavigation() {
        if (this.expandedAddonInstance()) this.collapseAddon();
    }

    /** Входящий звонок важнее аддона: сворачиваем один раз на звонок, дальше — как решит пользователь. */
    collapseAddonForIncomingCall(invite) {
        if (!invite || this._addonCallInvite === invite) return;
        this._addonCallInvite = invite;
        this.collapseAddonForNavigation();
    }

    stopAddon(id) {
        const instance = this.addonInstances().get(id);
        if (!instance) return;
        clearTimeout(instance.helloTimer);
        this.addonInstances().delete(id);
        this.addonStopRecorder?.(instance);
        this.addonSessionEnd?.(instance);
        try { instance.iframe?.remove(); } catch (e) { /* уже нет */ }
        try { instance.wrap?.remove(); } catch (e) { /* уже нет */ }
        if (!this.expandedAddonInstance()) {
            const stage = document.getElementById('addonStage');
            if (stage) stage.hidden = true;
        }
        this.renderAddonTitlebar();
        this.renderHubAddons?.();
    }

    // ---- Документ песочницы ----

    addonDirname(path) {
        const index = String(path || '').lastIndexOf('/');
        return index > 0 ? path.slice(0, index) : '';
    }

    /** Ссылка из разметки/CSS → путь файла в архиве, или '' (внешняя, якорь, нет файла). */
    resolveAddonPath(instance, ref, fromDir) {
        let value = String(ref || '').trim();
        if (!value || value.startsWith('#')) return '';
        if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//')) return '';
        value = value.split('#')[0].split('?')[0];
        try { value = decodeURIComponent(value); } catch (e) { /* как есть */ }
        const parts = value.startsWith('/') || !fromDir ? [] : fromDir.split('/');
        for (const segment of value.split('/')) {
            if (!segment || segment === '.') continue;
            if (segment === '..') {
                if (!parts.length) return '';
                parts.pop();
            } else {
                parts.push(segment);
            }
        }
        const path = parts.join('/');
        return instance.files.has(path) ? path : '';
    }

    addonText(instance, path) {
        return new TextDecoder().decode(instance.files.get(path) || new Uint8Array());
    }

    addonDataUrl(instance, path, mimeOverride = '') {
        const mime = mimeOverride || window.ZaliAddonFormat.mimeForPath(path);
        return `data:${mime};base64,${this.addonBytesToBase64(instance.files.get(path) || new Uint8Array())}`;
    }

    rewriteAddonCss(instance, css, fromDir, depth = 0) {
        const toUrl = (path) => {
            if (window.ZaliAddonFormat.extOf(path) === 'css' && depth < 4) {
                const nested = this.rewriteAddonCss(instance, this.addonText(instance, path), this.addonDirname(path), depth + 1);
                return `data:text/css;base64,${this.addonBytesToBase64(new TextEncoder().encode(nested))}`;
            }
            return this.addonDataUrl(instance, path);
        };
        return String(css || '')
            .replace(/@import\s+(['"])([^'"]+)\1/gi, (match, quote, ref) => {
                const path = this.resolveAddonPath(instance, ref, fromDir);
                return path ? `@import url("${toUrl(path)}")` : match;
            })
            .replace(/url\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (match, quote, ref) => {
                const path = this.resolveAddonPath(instance, ref, fromDir);
                return path ? `url("${toUrl(path)}")` : match;
            });
    }

    addonCsp(manifest) {
        const hosts = (manifest.permissions.includes('network') ? manifest.network : [])
            .flatMap(host => [`https://${host}`, `wss://${host}`]);
        const remote = hosts.length ? ` ${hosts.join(' ')}` : '';
        const httpsHosts = hosts.filter(h => h.startsWith('https://'));
        const remoteMedia = httpsHosts.length ? ` ${httpsHosts.join(' ')}` : '';
        return [
            "default-src 'none'",
            "script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
            "style-src 'unsafe-inline' blob: data:",
            `img-src data: blob:${remoteMedia}`,
            `media-src data: blob: mediastream:${remoteMedia}`,
            'font-src data: blob:',
            `connect-src data: blob:${remote}`,
            'worker-src blob:',
            'child-src blob:',
            "frame-src 'none'",
            "object-src 'none'",
            "manifest-src 'none'",
            "form-action 'none'",
            "base-uri 'none'",
        ].join('; ');
    }

    addonThemeCss() {
        const root = getComputedStyle(document.documentElement);
        const safe = (value, fallback) => {
            const text = String(value || '').trim();
            return text && !/[<>{};\\]/.test(text) ? text : fallback;
        };
        const get = (name, fallback) => safe(root.getPropertyValue(name), fallback);
        const font = safe(getComputedStyle(document.body || document.documentElement).fontFamily, 'system-ui, sans-serif');
        return [
            ':root{color-scheme:dark;',
            `--zali-accent:${get('--lime', '#cbff00')};`,
            `--zali-accent-rgb:${get('--accent-rgb', '203,255,0')};`,
            `--zali-bg:${get('--bg', '#090b0e')};`,
            '--zali-surface:rgba(255,255,255,.04);',
            `--zali-text:${get('--text', '#f2f2f2')};`,
            `--zali-text2:${get('--text2', 'rgba(255,255,255,.65)')};`,
            `--zali-text3:${get('--text3', 'rgba(255,255,255,.5)')};`,
            `--zali-border:${get('--border', 'rgba(255,255,255,.07)')};`,
            `--zali-danger:${get('--red', '#ff4d6d')};`,
            '--zali-radius:14px;',
            `--zali-font:${font}}`,
            'html{background:var(--zali-bg);color:var(--zali-text);font-family:var(--zali-font)}',
            'body{margin:0}',
        ].join('');
    }

    buildAddonDocument(instance) {
        const { manifest } = instance;
        const baseDir = this.addonDirname(manifest.entry);
        const doc = new DOMParser().parseFromString(this.addonText(instance, manifest.entry), 'text/html');
        const resolve = (ref, dir = baseDir) => this.resolveAddonPath(instance, ref, dir);
        // Текст встраиваемого скрипта/стиля не должен закрыть свой тег раньше времени.
        const escapeClosing = (text, tag) => text.replace(new RegExp(`</(${tag})`, 'gi'), '<\\/$1');

        // <base> переписал бы разрешение ссылок, http-equiv — CSP или refresh-навигацию.
        doc.querySelectorAll('base, meta[http-equiv]').forEach(el => el.remove());

        const deferred = [];
        for (const script of Array.from(doc.querySelectorAll('script[src]'))) {
            const path = resolve(script.getAttribute('src'));
            script.removeAttribute('src');
            // Внешний скрипт — это код, которого не было в проверенном файле.
            if (!path) {
                script.remove();
                continue;
            }
            script.textContent = escapeClosing(this.addonText(instance, path), 'script');
            // Встроенный скрипт выполняется сразу, defer у него не работает —
            // такой переезжает в конец <body>, где defer и выполнил бы его.
            const isModule = String(script.getAttribute('type') || '').toLowerCase() === 'module';
            if (script.hasAttribute('defer') && !isModule) {
                script.removeAttribute('defer');
                script.remove();
                deferred.push(script);
            }
        }
        for (const script of deferred) doc.body.appendChild(script);
        for (const link of Array.from(doc.querySelectorAll('link[href]'))) {
            const rel = String(link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
            const path = resolve(link.getAttribute('href'));
            if (rel.includes('stylesheet') && path) {
                const style = doc.createElement('style');
                style.textContent = escapeClosing(this.rewriteAddonCss(instance, this.addonText(instance, path), this.addonDirname(path)), 'style');
                link.replaceWith(style);
            } else if (rel.includes('icon') && path) {
                link.setAttribute('href', this.addonDataUrl(instance, path));
            } else {
                link.remove();
            }
        }
        for (const style of Array.from(doc.querySelectorAll('style'))) {
            style.textContent = escapeClosing(this.rewriteAddonCss(instance, style.textContent, baseDir), 'style');
        }
        for (const el of Array.from(doc.querySelectorAll('[style]'))) {
            el.setAttribute('style', this.rewriteAddonCss(instance, el.getAttribute('style'), baseDir));
        }
        const mediaAttrs = [
            ['img', 'src'], ['audio', 'src'], ['video', 'src'], ['video', 'poster'], ['source', 'src'],
            ['track', 'src'], ['input', 'src'], ['image', 'href'], ['image', 'xlink:href'], ['embed', 'src'],
        ];
        for (const [tag, attr] of mediaAttrs) {
            for (const el of Array.from(doc.getElementsByTagName(tag))) {
                if (!el.hasAttribute(attr)) continue;
                const path = resolve(el.getAttribute(attr));
                if (path) el.setAttribute(attr, this.addonDataUrl(instance, path));
            }
        }

        const csp = doc.createElement('meta');
        csp.setAttribute('http-equiv', 'Content-Security-Policy');
        csp.setAttribute('content', this.addonCsp(manifest));
        const theme = doc.createElement('style');
        theme.textContent = this.addonThemeCss();
        const sdk = doc.createElement('script');
        sdk.textContent = escapeClosing(window.ZaliAddonSdk.source(), 'script');
        doc.head.prepend(csp, theme, sdk);
        return `<!doctype html>\n${doc.documentElement.outerHTML}`;
    }

    // ---- RPC ----

    installAddonMessageListener() {
        if (this._addonMessageListener) return;
        this._addonMessageListener = (event) => this.onAddonWindowMessage(event);
        window.addEventListener('message', this._addonMessageListener);
    }

    addonInstanceBySource(source) {
        if (!source) return null;
        for (const instance of this.addonInstances().values()) {
            if (instance.iframe && instance.iframe.contentWindow === source) return instance;
        }
        return null;
    }

    postToAddon(instance, message, transfer = []) {
        const target = instance?.iframe?.contentWindow;
        if (!target) return;
        try {
            target.postMessage(message, '*', transfer);
        } catch (error) {
            // Непередаваемый результат — ответить ошибкой, а не оставить промис висеть.
            if (message.channel === ZALI_ADDON_RPC && message.ok) {
                target.postMessage({ channel: ZALI_ADDON_RPC, id: message.id, ok: false, error: { code: 'failed', message: String(error?.message || error) } }, '*');
            }
        }
    }

    emitAddonEvent(instance, event, data, transfer = []) {
        this.postToAddon(instance, { channel: ZALI_ADDON_EVENT, event, data }, transfer);
    }

    onAddonWindowMessage(event) {
        const msg = event.data;
        if (!msg || typeof msg !== 'object' || msg.channel !== ZALI_ADDON_RPC) return;
        const instance = this.addonInstanceBySource(event.source);
        if (!instance) return;
        const id = Number(msg.id);
        if (!Number.isSafeInteger(id) || id <= 0) return;
        const method = String(msg.method || '');
        const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
        if (instance.inflight >= ZALI_ADDON_MAX_INFLIGHT) {
            this.postToAddon(instance, { channel: ZALI_ADDON_RPC, id, ok: false, error: { code: 'busy', message: 'Слишком много одновременных вызовов' } });
            return;
        }
        instance.inflight += 1;
        Promise.resolve()
            .then(() => this.dispatchAddonRpc(instance, method, params))
            .then((outcome) => {
                const result = outcome && typeof outcome === 'object' && 'result' in outcome ? outcome.result : outcome;
                const transfer = outcome && typeof outcome === 'object' && Array.isArray(outcome.transfer) ? outcome.transfer : [];
                this.postToAddon(instance, { channel: ZALI_ADDON_RPC, id, ok: true, result: result === undefined ? null : result }, transfer);
            }, (error) => {
                this.postToAddon(instance, {
                    channel: ZALI_ADDON_RPC,
                    id,
                    ok: false,
                    error: { code: String(error?.code || 'failed'), message: String(error?.message || error || 'Ошибка') },
                });
            })
            .finally(() => { instance.inflight = Math.max(0, instance.inflight - 1); });
    }

    /**
     * Таблица методов SDK: разрешение, без которого метод не вызвать, и
     * обработчик. Ответ — значение или {result, transfer}.
     */
    addonRpcMethods() {
        if (this._addonRpcMethods) return this._addonRpcMethods;
        const methods = {
            hello: { run: (instance) => this.addonHello(instance) },
            'ui.collapse': { run: () => { this.collapseAddon(); return true; } },
            'ui.close': { run: (instance) => { setTimeout(() => this.stopAddon(instance.id), 0); return true; } },
            'ui.setTitle': {
                run: (instance, params) => {
                    instance.title = String(params.title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 64);
                    this.renderAddonTitlebar();
                    return true;
                },
            },
            'storage.get': { run: (i, p) => this.addonKvGet(i, p) },
            'storage.set': { run: (i, p) => this.addonKvSet(i, p) },
            'storage.remove': { run: (i, p) => this.addonKvRemove(i, p) },
            'storage.keys': { run: (i) => this.addonKvKeys(i) },
            'storage.clear': { run: (i) => this.addonKvClear(i) },
            'assets.read': {
                run: (instance, params) => {
                    const path = String(params.path || '').replace(/^\/+/, '');
                    const bytes = instance.files.get(path);
                    if (!bytes) throw this.addonError('not_found', `Нет файла «${path.slice(0, 80)}» в аддоне`);
                    const data = bytes.slice().buffer;
                    return { result: { data, mimeType: window.ZaliAddonFormat.mimeForPath(path) }, transfer: [data] };
                },
            },
        };
        Object.assign(methods, this.addonRpcExtraMethods?.() || {});
        this._addonRpcMethods = methods;
        return methods;
    }

    async dispatchAddonRpc(instance, method, params) {
        const entry = Object.prototype.hasOwnProperty.call(this.addonRpcMethods(), method) ? this.addonRpcMethods()[method] : null;
        if (!entry) throw this.addonError('unknown_method', `Метода «${method.slice(0, 40)}» нет в этой версии приложения`);
        if (entry.permission && !instance.manifest.permissions.includes(entry.permission)) {
            const title = window.ZaliAddonFormat.permissionInfo(entry.permission)?.title || entry.permission;
            throw this.addonError('permission_denied', `Аддон не просил разрешение «${title}»`);
        }
        return await entry.run(instance, params);
    }

    addonHello(instance) {
        if (!instance.ready) {
            instance.ready = true;
            clearTimeout(instance.helloTimer);
            instance.wrap?.classList.remove('is-loading');
        }
        const m = instance.manifest;
        const root = getComputedStyle(document.documentElement);
        return {
            id: m.id,
            name: m.name,
            version: m.version,
            permissions: m.permissions.slice(),
            network: m.network.slice(),
            platform: this.addonPlatform(),
            visible: !!instance.expanded,
            theme: {
                accent: root.getPropertyValue('--lime').trim() || '#cbff00',
                background: root.getPropertyValue('--bg').trim() || '#090b0e',
                text: root.getPropertyValue('--text').trim() || '#f2f2f2',
            },
        };
    }

    // ---- zali.storage: один kv.json на аддон, до 1 МБ ----

    async addonKvLoad(instance) {
        if (instance.kv) return instance.kv;
        const bytes = await this.addonDataRead(instance.id, ZALI_ADDON_KV_PATH).catch(() => null);
        let data = {};
        if (bytes) {
            try {
                const parsed = JSON.parse(new TextDecoder().decode(bytes));
                if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
            } catch (e) { /* испорченный файл — начать заново */ }
        }
        instance.kv = Object.assign(Object.create(null), data);
        return instance.kv;
    }

    addonKvPersist(instance) {
        const json = JSON.stringify(instance.kv || {});
        const bytes = new TextEncoder().encode(json);
        if (bytes.length > window.ZaliAddonFormat.LIMITS.storageBytes) {
            throw this.addonError('quota', 'Настройки аддона больше 1 МБ — сохраняйте крупное через zali.cache');
        }
        // Записи по очереди: иначе поздняя могла бы лечь раньше ранней.
        instance.kvWrite = instance.kvWrite.catch(() => {}).then(() => this.addonDataWrite(instance.id, ZALI_ADDON_KV_PATH, bytes));
        return instance.kvWrite;
    }

    addonKvKey(params) {
        const key = String(params.key ?? '');
        if (!key || key.length > 256) throw this.addonError('bad_params', 'Ключ — строка от 1 до 256 символов');
        return key;
    }

    async addonKvGet(instance, params) {
        const kv = await this.addonKvLoad(instance);
        const key = this.addonKvKey(params);
        return Object.prototype.hasOwnProperty.call(kv, key) ? JSON.stringify(kv[key]) : null;
    }

    async addonKvSet(instance, params) {
        const kv = await this.addonKvLoad(instance);
        const key = this.addonKvKey(params);
        let value;
        try { value = JSON.parse(String(params.json ?? 'null')); } catch (e) {
            throw this.addonError('bad_params', 'Значение не JSON');
        }
        const previous = Object.prototype.hasOwnProperty.call(kv, key) ? kv[key] : undefined;
        kv[key] = value;
        try {
            await this.addonKvPersist(instance);
        } catch (error) {
            if (previous === undefined) delete kv[key]; else kv[key] = previous;
            throw error;
        }
        return true;
    }

    async addonKvRemove(instance, params) {
        const kv = await this.addonKvLoad(instance);
        const key = this.addonKvKey(params);
        if (!Object.prototype.hasOwnProperty.call(kv, key)) return false;
        delete kv[key];
        await this.addonKvPersist(instance);
        return true;
    }

    async addonKvKeys(instance) {
        return Object.keys(await this.addonKvLoad(instance));
    }

    async addonKvClear(instance) {
        instance.kv = Object.create(null);
        await this.addonKvPersist(instance);
        return true;
    }

    // ---- Верхняя полоса: «Свернуть» и плашка свёрнутого аддона ----

    /**
     * Ставит слот кнопки «сразу после трёх кнопок окна»: в Windows кнопки окна
     * свои, справа — слот встаёт вплотную к ним; в macOS светофор нативный,
     * слева — слот в левой колонке, отодвинутый от него (.has-traffic-lights).
     * В браузере и на телефонах — в начале полосы.
     */
    placeAddonTitlebarSlot() {
        const titlebar = document.getElementById('titlebar');
        const slot = document.getElementById('tbAddon');
        if (!titlebar || !slot) return;
        const winControls = document.getElementById('winControls');
        if (this.nativeSupports('windowControls') && winControls?.parentElement) {
            winControls.parentElement.insertBefore(slot, winControls);
            titlebar.classList.add('tb-addon-right');
            return;
        }
        if (this.addonPlatform() === 'macos') titlebar.classList.add('has-traffic-lights');
    }

    renderAddonTitlebar() {
        const titlebar = document.getElementById('titlebar');
        const slot = document.getElementById('tbAddon');
        const titleEl = document.getElementById('tbAddonTitle');
        if (!titlebar || !slot) return;
        const expanded = this.expandedAddonInstance();
        const running = Array.from(this.addonInstances().values());
        titlebar.classList.toggle('addon-expanded', !!expanded);
        document.body.classList.toggle('addon-expanded', !!expanded);
        if (titleEl) titleEl.textContent = expanded ? (expanded.title || expanded.manifest.name) : '';
        if (expanded) {
            const name = expanded.manifest.name;
            slot.innerHTML = `<button class="tb-addon-btn" type="button" data-addon-tb="collapse" title="Свернуть «${this.esc(name)}»" aria-label="Свернуть аддон «${this.esc(name)}»">
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 6.25 8 10.75l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                <span class="tb-addon-btn-label">Свернуть</span>
            </button>`;
        } else if (running.length) {
            const last = running.slice().sort((a, b) => b.collapsedAt - a.collapsedAt)[0];
            const more = running.length - 1;
            slot.innerHTML = `<button class="tb-addon-chip" type="button" data-addon-tb="expand" data-addon-id="${this.esc(last.id)}" title="Развернуть «${this.esc(last.manifest.name)}»" aria-label="Развернуть аддон «${this.esc(last.manifest.name)}»">
                <span class="tb-addon-dot" aria-hidden="true"></span>
                <span class="tb-addon-chip-name">${this.esc(last.title || last.manifest.name)}</span>
                ${more > 0 ? `<span class="tb-addon-more">+${Number(more)}</span>` : ''}
            </button>`;
        } else {
            slot.innerHTML = '';
        }
        slot.hidden = !expanded && !running.length;
        // Телефон: верхней полосы нет (style.css, ≤760px) — та же кнопка в полоске сцены.
        const stageBar = document.getElementById('addonStageBar');
        if (stageBar) {
            stageBar.innerHTML = expanded
                ? `<button class="tb-addon-btn" type="button" data-addon-tb="collapse" aria-label="Свернуть аддон «${this.esc(expanded.manifest.name)}»">
                    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3.5 6.25 8 10.75l4.5-4.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
                    <span class="tb-addon-btn-label">Свернуть</span>
                </button>
                <span class="addon-stage-title">${this.esc(expanded.title || expanded.manifest.name)}</span>`
                : '';
        }
    }
});
