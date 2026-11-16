// --- ZaliInterface: «Общий браузер» — активность звонка. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Запустивший открывает скрытый встроенный браузер оболочки (macOS: WKWebView,
// Windows: WebView2) — со СВОИМ профилем приложения, не Safari/Chrome и не профилем
// самого мессенджера. Его кадры идут в звонок обычной демонстрацией экрана
// (startScreenShare({browser})), у всех — плитка с адресной строкой и курсорами.
//
// Профиль (куки):
// - «мой» — выделенный профиль на компьютере запустившего (оболочка хранит сама);
// - «сообщества» — куки с сервера (server/src/browser_profiles.rs): берутся при
//   запуске, сохраняются после загрузки страниц, раз в минуту и при закрытии.
//   Не E2E: сервер их видит — это сказано в окне запуска.
//
// Ввод (звезда через запустившего):
// - участник → запустивший: канал данных 'zali-sb' (создаёт участник, как 'zali-rc'),
//   события в долях кадра: move/down/up/wheel/key/text/nav/leave;
// - запустивший → участникам: {t:'cursors'} — курсоры всех, кроме адресата, ~20 Гц;
// - без канала (ещё не открылся) — через сервер сигналом `sb-input`, но только мышь
//   и навигация: клавиши и вставку текста сервер видеть не должен.
// - Сигналы `sb-state` (адрес, заголовок, «управляют все») и `sb-end` — от запустившего.
//
// Что фильтруется до оболочки (sanitizeSharedBrowserInput): только известные поля,
// доли кадра в [0..1], сочетания с Cmd/Ctrl — только безопасные (без вставки и
// копирования: вставка отдала бы буфер обмена запустившего, копирование — подменило бы
// его). Свой текст участник вставляет как {t:'text'} из СВОЕГО буфера.
// Оболочка сама не пускает браузер в локальную сеть, на file:, к загрузкам, файлам,
// камере и микрофону.
ZaliMixin(ZaliInterface, class {

    static get SB_VIEW_WIDTH() { return 1280; }
    static get SB_VIEW_HEIGHT() { return 720; }
    // 0 — частота экрана запустившего (60/120/144 Гц): её выбирает оболочка.
    static get SB_FPS() { return 0; }
    static get SB_CURSOR_BROADCAST_MS() { return 50; }
    static get SB_CURSOR_TTL_MS() { return 6000; }
    static get SB_AUTOSAVE_MS() { return 60000; }
    static get SB_HOME_URL() { return 'https://www.google.com/'; }
    static get SB_PREF_KEY() { return 'zali_shared_browser_pref_v1'; }

    sbState() {
        if (!this._sb) {
            this._sb = {
                host: null,           // мы запустили: { stream, url, title, canBack, canForward, loading, profile, serverId, allowOthers, cursors, … }
                remote: new Map(),    // peer → браузер собеседника: { url, title, …, cursors, channel, channelPc }
                channels: new Map(),  // запустивший: peer → входящий 'zali-sb'
                launching: false,
                local: { buttons: new Set(), keys: new Set(), pendingMove: null, frame: 0 },
                colors: new Map(),
                keyHook: null,
                raf: 0,
            };
        }
        return this._sb;
    }

    // ------------------------------------------------------------------ общее

    sharedBrowserLaunchAvailable() {
        return !!(this.voice?.roomId && this.nativeCaptureAvailable?.('browser'));
    }

    sbNotice(type, msg) {
        this.addLogEntry?.({ type, msg, ts: new Date().toLocaleTimeString() });
    }

    /** Точка входа из handleVoiceSignal: все сигналы `sb-*`. */
    handleSharedBrowserSignal(from, signal = {}) {
        const peer = String(from || '').trim();
        if (!peer) return;
        switch (signal.type) {
            case 'sb-state': this.onRemoteSharedBrowserState(peer, signal); break;
            case 'sb-end': this.onRemoteSharedBrowserEnded(peer); break;
            case 'sb-input': this.applySharedBrowserInput(peer, signal.e, 'relay'); break;
            default: break;
        }
    }

    /** Доля кадра → [0..1] или null. */
    sbUnit(v) {
        const n = Number(v);
        return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
    }

    /** Адрес из строки ввода: схема https по умолчанию, не-адрес — поиск. Только http(s). */
    normalizeSharedBrowserUrl(raw) {
        const text = String(raw || '').trim().slice(0, 2048);
        if (!text) return '';
        if (/^https?:\/\//i.test(text)) {
            try {
                const u = new URL(text);
                return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : '';
            } catch (e) { return ''; }
        }
        // Другая схема (file:, javascript:, zali:) — не адрес, а запрос в поиск.
        const looksLikeHost = !/\s/.test(text) && /^[^:/?#]+\.[^:/?#]{2,}([/?#:].*)?$/.test(text) && !/^[a-z][a-z0-9+.-]*:/i.test(text);
        if (looksLikeHost) {
            try { return new URL(`https://${text}`).href; } catch (e) { return ''; }
        }
        return `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
    }

    /** Только известные поля и допустимые значения — дальше это уходит в инъекцию ввода. */
    sanitizeSharedBrowserInput(raw) {
        if (!raw || typeof raw !== 'object') return null;
        const unit = (v) => this.sbUnit(v);
        switch (raw.t) {
            case 'move': {
                const x = unit(raw.x), y = unit(raw.y);
                return x === null || y === null ? null : { t: 'move', x, y };
            }
            case 'down':
            case 'up': {
                const x = unit(raw.x), y = unit(raw.y);
                const b = Number(raw.b);
                if (x === null || y === null || ![0, 1, 2].includes(b)) return null;
                const n = Math.max(1, Math.min(3, Number(raw.n) || 1));
                return { t: raw.t, x, y, b, n };
            }
            case 'wheel': {
                const x = unit(raw.x), y = unit(raw.y);
                const clamp = (v) => {
                    const n = Number(v);
                    return Number.isFinite(n) ? Math.max(-2000, Math.min(2000, Math.round(n))) : 0;
                };
                const dx = clamp(raw.dx), dy = clamp(raw.dy);
                if (x === null || y === null || (!dx && !dy)) return null;
                return { t: 'wheel', x, y, dx, dy };
            }
            case 'key': {
                const code = String(raw.code || '');
                if (!/^[A-Za-z0-9]{1,24}$/.test(code)) return null;
                const key = String(raw.key ?? '');
                if (key.length > 24 || /[\u0000-\u001f\u007f]/.test(key)) return null;
                const m = Number(raw.m) & 15;
                // Cmd/Ctrl + что-то: только редактирование и навигация по тексту.
                // Вставка/копирование/вырезание трогали бы буфер обмена запустившего.
                if (m & (2 | 8)) {
                    const allowed = ['KeyA', 'KeyZ', 'KeyY', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
                        'Backspace', 'Delete', 'Home', 'End', 'Enter', 'Minus', 'Equal', 'Digit0'];
                    if (!allowed.includes(code)) return null;
                }
                if (code === 'Insert' && (m & 1)) return null;
                return { t: 'key', code, key, d: raw.d ? 1 : 0, m };
            }
            case 'text': {
                const s = String(raw.s ?? '').replace(/\r\n?/g, '\n').slice(0, 2000);
                return s ? { t: 'text', s } : null;
            }
            case 'nav': {
                const a = String(raw.a || '');
                if (a === 'go') {
                    const url = this.normalizeSharedBrowserUrl(raw.url);
                    return url ? { t: 'nav', a, url } : null;
                }
                return ['back', 'forward', 'reload', 'stop'].includes(a) ? { t: 'nav', a } : null;
            }
            case 'leave':
                return { t: 'leave' };
            case 'release':
                return { t: 'release' };
            default:
                return null;
        }
    }

    // --------------------------------------------------------- цвет курсора

    /** Цвет курсора — под аватарку: самый насыщенный тон картинки или цвет из имени. */
    sharedBrowserCursorColor(name) {
        const key = String(name || '').trim().toLowerCase();
        const sb = this.sbState();
        const cached = sb.colors.get(key);
        if (cached && cached.color) return cached.color;
        const fallback = this.sbFallbackColor(key);
        if (!cached) {
            sb.colors.set(key, { color: '', pending: true });
            void this.computeSharedBrowserAvatarColor(key).then((color) => {
                sb.colors.set(key, { color: color || fallback });
            });
        }
        return fallback;
    }

    sbFallbackColor(key) {
        let h = 0;
        for (const ch of String(key || 'z')) h = (h * 31 + ch.codePointAt(0)) >>> 0;
        return `hsl(${h % 360} 82% 58%)`;
    }

    async computeSharedBrowserAvatarColor(key) {
        try {
            if (typeof document === 'undefined' || typeof Image === 'undefined') return '';
            let src = this.loadStoredAvatar?.(key);
            if (src === undefined && this.ensureAvatarLoaded) {
                await this.ensureAvatarLoaded(key);
                src = this.loadStoredAvatar?.(key);
            }
            if (!src) return '';
            const img = new Image();
            img.decoding = 'async';
            img.src = src;
            await img.decode();
            const size = 24;
            const canvas = document.createElement('canvas');
            canvas.width = size;
            canvas.height = size;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.drawImage(img, 0, 0, size, size);
            const data = ctx.getImageData(0, 0, size, size).data;
            // Гистограмма тонов, взвешенная насыщенностью×яркостью: аватарка с
            // красной курткой на сером фоне даёт красный, а не серо-бурое среднее.
            const buckets = new Array(24).fill(null).map(() => ({ w: 0, r: 0, g: 0, b: 0 }));
            for (let i = 0; i < data.length; i += 4) {
                const r = data[i] / 255, g = data[i + 1] / 255, b = data[i + 2] / 255, a = data[i + 3] / 255;
                const max = Math.max(r, g, b), min = Math.min(r, g, b);
                const s = max === 0 ? 0 : (max - min) / max;
                const w = s * s * max * a;
                if (w < 0.02) continue;
                let hue = 0;
                if (max !== min) {
                    if (max === r) hue = ((g - b) / (max - min)) % 6;
                    else if (max === g) hue = (b - r) / (max - min) + 2;
                    else hue = (r - g) / (max - min) + 4;
                }
                const idx = Math.floor((((hue * 60) + 360) % 360) / 15);
                const bucket = buckets[idx];
                bucket.w += w; bucket.r += r * w; bucket.g += g * w; bucket.b += b * w;
            }
            const best = buckets.reduce((a, b) => (b.w > a.w ? b : a));
            if (best.w < 0.5) return '';
            const r = best.r / best.w, g = best.g / best.w, b = best.b / best.w;
            // Яркий вариант того же тона: на любом сайте курсор должен читаться.
            const max = Math.max(r, g, b), min = Math.min(r, g, b);
            let hue = 0;
            if (max !== min) {
                if (max === r) hue = ((g - b) / (max - min)) % 6;
                else if (max === g) hue = (b - r) / (max - min) + 2;
                else hue = (r - g) / (max - min) + 4;
            }
            return `hsl(${Math.round(((hue * 60) + 360) % 360)} 85% 56%)`;
        } catch (e) {
            return '';
        }
    }

    // ---------------------------------------------------------- запустивший

    openSharedBrowserLauncher() {
        if (this.sbState().host) { this.focusSharedBrowser(''); return; }
        if (!this.sharedBrowserLaunchAvailable()) {
            this.sbNotice('WARN', 'Общий браузер можно запустить только в приложении для macOS или Windows во время звонка');
            return;
        }
        if (document.getElementById('voicePickerOverlay')) return;
        let pref = {};
        try { pref = JSON.parse(localStorage.getItem(ZaliInterface.SB_PREF_KEY) || '{}') || {}; } catch (e) { pref = {}; }
        const serverId = String(this.voice?.serverId || '');
        const server = serverId ? (this.S.servers || []).find(s => s.id === serverId) : null;
        let profile = serverId && pref.profile === 'community' ? 'community' : 'own';
        const seg = (items, current) => `<div class="voice-picker-seg sb-profile-seg" data-seg="profile" role="radiogroup">${items.map(it => `<button type="button" role="radio" class="voice-picker-seg-btn${it.v === current ? ' is-selected' : ''}" aria-checked="${this.esc(String(it.v === current))}" data-v="${this.esc(it.v)}">${this.esc(it.l)}</button>`).join('')}</div>`;
        const profiles = [{ v: 'own', l: 'Мой' }];
        if (serverId) profiles.push({ v: 'community', l: 'Сообщества' });
        const noteFor = (p) => p === 'community'
            ? `Куки общие для участников «${server?.name || 'сообщества'}»: войдёте один раз — войдут все, кто запускает браузер здесь. Хранятся на сервере без сквозного шифрования.`
            : 'Отдельный профиль приложения на этом компьютере — не Safari и не Chrome. Участники будут действовать от имени ваших входов в нём.';
        this.mountVoicePicker({
            title: 'Общий браузер',
            confirmLabel: 'Запустить',
            bodyHtml: `
                <div class="voice-picker-field"><span class="voice-picker-label">Адрес</span>
                    <input class="sb-launch-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" placeholder="Адрес или запрос" value="${this.esc(pref.url || ZaliInterface.SB_HOME_URL)}">
                </div>
                <div class="voice-picker-field"><span class="voice-picker-label">Профиль</span>${seg(profiles, profile)}</div>
                <div class="voice-picker-note sb-launch-note">${this.esc(noteFor(profile))}</div>
                <div class="voice-picker-note">Браузер появится трансляцией в звонке. Управлять им смогут все участники — у каждого свой курсор.</div>`,
            onMount: (overlay) => {
                overlay.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-seg="profile"] [data-v]');
                    if (!btn) return;
                    profile = btn.dataset.v;
                    for (const el of overlay.querySelectorAll('[data-seg="profile"] [data-v]')) {
                        const on = el === btn;
                        el.classList.toggle('is-selected', on);
                        el.setAttribute('aria-checked', String(on));
                    }
                    const note = overlay.querySelector('.sb-launch-note');
                    if (note) note.textContent = noteFor(profile);
                });
                const input = overlay.querySelector('.sb-launch-url');
                input?.addEventListener('keydown', (e) => {
                    if (e.key !== 'Enter') return;
                    e.preventDefault();
                    overlay.querySelector('#voicePickerConfirm')?.click();
                });
                setTimeout(() => { input?.focus(); input?.select(); }, 30);
            },
            onConfirm: (overlay) => {
                const raw = (overlay || document).querySelector?.('.sb-launch-url')?.value || '';
                const url = this.normalizeSharedBrowserUrl(raw) || ZaliInterface.SB_HOME_URL;
                try { localStorage.setItem(ZaliInterface.SB_PREF_KEY, JSON.stringify({ url: raw.trim().slice(0, 512), profile })); } catch (e) {}
                void this.launchSharedBrowser({ url, profile });
                return true;
            },
        });
    }

    async launchSharedBrowser({ url, profile = 'own' } = {}) {
        const sb = this.sbState();
        if (sb.host || sb.launching) return false;
        if (!this.sharedBrowserLaunchAvailable()) return false;
        if (this.voice.screenSharing) {
            this.sbNotice('WARN', 'Сначала остановите показ экрана — общий браузер идёт той же трансляцией');
            return false;
        }
        const serverId = profile === 'community' ? String(this.voice.serverId || '') : '';
        if (profile === 'community' && !serverId) profile = 'own';
        sb.launching = true;
        this.renderVoicePanel?.();
        // Пока грузился профиль или открывался браузер, звонок мог кончиться.
        const roomId = this.voice.roomId;
        const callAlive = () => !!roomId && this.voice.roomId === roomId;
        try {
            let cookies = [];
            let revision = 0;
            if (serverId) {
                try {
                    const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/browser-profile`);
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const body = await res.json();
                    cookies = Array.isArray(body?.cookies) ? body.cookies : [];
                    revision = Number(body?.revision) || 0;
                } catch (error) {
                    this.sbNotice('WARN', `Не удалось загрузить профиль сообщества: ${error?.message || error}`);
                    return false;
                }
            }
            if (!callAlive()) return false;
            await this.startScreenShare({
                browser: {
                    url,
                    profile: serverId ? 'community' : 'own',
                    cookies,
                    width: ZaliInterface.SB_VIEW_WIDTH,
                    height: ZaliInterface.SB_VIEW_HEIGHT,
                    fps: ZaliInterface.SB_FPS,
                },
                height: ZaliInterface.SB_VIEW_HEIGHT,
                audio: 0,
            });
            if (!callAlive()) {
                // resetVoiceState уже прошёл — трансляцию, открытую после него, гасим сами.
                if (this.voice.screenActivity === 'browser') this.stopScreenShare();
                return false;
            }
            if (!this.voice.screenSharing || this.voice.screenActivity !== 'browser' || !this.voice.screenNativeStream) {
                this.sbNotice('WARN', 'Общий браузер не запустился');
                return false;
            }
            sb.host = {
                stream: this.voice.screenNativeStream,
                url, title: '', canBack: false, canForward: false, loading: true,
                profile: serverId ? 'community' : 'own',
                serverId,
                allowOthers: true,
                since: Date.now(),
                cursors: new Map(),
                events: 0,
                relayed: 0,
                savedHash: serverId ? this.sbCookiesHash(cookies) : '',
                revision,
                cursorsDirty: false,
            };
            sb.host.broadcastTimer = setInterval(() => this.broadcastSharedBrowserCursors(), ZaliInterface.SB_CURSOR_BROADCAST_MS);
            if (serverId) sb.host.saveTimer = setInterval(() => { void this.saveSharedBrowserProfile('autosave'); }, ZaliInterface.SB_AUTOSAVE_MS);
            for (const peer of this.voice.peerConnections.keys()) this.sendSharedBrowserState(peer);
            this.voiceTrace('sb-started', { profile: sb.host.profile, stream: sb.host.stream, cookies: cookies.length, fps: this.voice.screenFps || 0 });
            this.focusSharedBrowser('');
            this.syncSharedBrowserUi();
            return true;
        } finally {
            sb.launching = false;
            this.renderVoicePanel?.();
        }
    }

    /** «Закрыть браузер»: сначала сохранить куки сообщества, потом гасить трансляцию. */
    async closeSharedBrowser() {
        const host = this.sbState().host;
        if (!host) return;
        if (host.serverId) await this.saveSharedBrowserProfile('close');
        if (this.sbState().host === host) this.stopScreenShare();
    }

    sbCookiesHash(cookies) {
        const text = JSON.stringify((cookies || []).map(c => [c.domain, c.path, c.name, c.value, c.expires]).sort());
        let h = 2166136261 >>> 0;
        for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
        return `${text.length}:${h}`;
    }

    /**
     * Сохранения идут по одному. Автосохранение при идущем — пропускается; закрытие —
     * дожидается идущего и сохраняет ещё раз: иначе браузер закрылся бы раньше, чем
     * оболочка отдала куки, и вход пропал бы.
     */
    async saveSharedBrowserProfile(reason) {
        const host = this.sbState().host;
        if (!host?.serverId) return false;
        if (host.savePromise) {
            if (reason !== 'close') return false;
            await host.savePromise.catch(() => {});
        }
        const run = this.saveSharedBrowserProfileNow(host, reason);
        host.savePromise = run;
        try { return await run; } finally { if (host.savePromise === run) host.savePromise = null; }
    }

    async saveSharedBrowserProfileNow(host, reason) {
        try {
            const res = await this.nativeMediaRequest('browser_cookies', { stream: host.stream }, 8000);
            const cookies = Array.isArray(res?.cookies) ? res.cookies : [];
            const hash = this.sbCookiesHash(cookies);
            if (hash === host.savedHash) return true;
            const put = await this.apiFetch(`/api/servers/${encodeURIComponent(host.serverId)}/browser-profile`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                // Ревизия, от которой начали: устарела — сервер сольёт, а не затрёт чужие входы.
                body: JSON.stringify({ cookies, baseRevision: host.revision || 0 }),
            });
            if (!put.ok) throw new Error(`HTTP ${put.status}`);
            const saved = await put.json().catch(() => ({}));
            if (Number(saved?.revision)) host.revision = Number(saved.revision);
            host.savedHash = hash;
            this.voiceTrace('sb-profile-saved', { reason, cookies: cookies.length });
            return true;
        } catch (error) {
            this.voiceTrace('sb-profile-save-failed', { reason, error: error?.message || String(error) }, 'WARN');
            if (reason === 'close') this.sbNotice('WARN', 'Не удалось сохранить профиль сообщества');
            return false;
        }
    }

    /** stopScreenShare: трансляция гаснет — браузер закрыт, участникам `sb-end`. */
    onSharedBrowserShareStopping(reason = 'screen-stop') {
        const sb = this.sbState();
        const host = sb.host;
        if (!host) return;
        sb.host = null;
        clearInterval(host.broadcastTimer);
        clearInterval(host.saveTimer);
        clearTimeout(host.loadSaveTimer);
        for (const peer of this.voice?.peerConnections?.keys?.() || []) this.sendVoicePeerSignal(peer, { type: 'sb-end', reason });
        for (const ch of sb.channels.values()) { try { ch.close(); } catch (e) {} }
        sb.channels.clear();
        this.voiceTrace('sb-stopped', {
            reason,
            seconds: Math.round((Date.now() - host.since) / 1000),
            events: host.events,
            relayed: host.relayed,
        });
        // Кнопка «Браузер» меняет состояние — здесь панель перерисовать нужно.
        this.renderVoicePanel?.();
        this.syncSharedBrowserUi();
    }

    /** Новый участник получил дорожку трансляции — ему же состояние браузера. */
    onSharedBrowserPeerAttached(peer) {
        if (this.sbState().host) this.sendSharedBrowserState(peer);
    }

    sendSharedBrowserState(peer) {
        const host = this.sbState().host;
        if (!host) return;
        this.sendVoicePeerSignal(peer, {
            type: 'sb-state',
            url: host.url,
            title: host.title,
            canBack: host.canBack,
            canForward: host.canForward,
            loading: host.loading,
            allowOthers: host.allowOthers,
            profile: host.profile,
        });
    }

    /** media_event 'browser_state' — адрес, заголовок и история скрытого браузера. */
    onNativeSharedBrowserState(payload = {}) {
        const host = this.sbState().host;
        if (!host || Number(payload.stream) !== Number(host.stream)) return;
        const wasLoading = host.loading;
        host.url = String(payload.url || '').slice(0, 2048);
        host.title = String(payload.title || '').slice(0, 300);
        host.canBack = !!payload.canBack;
        host.canForward = !!payload.canForward;
        host.loading = !!payload.loading;
        clearTimeout(host.stateTimer);
        // Сигнал — через сервер, поэтому не на каждое событие загрузки.
        host.stateTimer = setTimeout(() => {
            for (const peer of this.voice?.peerConnections?.keys?.() || []) this.sendSharedBrowserState(peer);
        }, 150);
        // Вход на сайте обычно кончается загрузкой страницы — тогда и сохраняем куки.
        if (host.serverId && wasLoading && !host.loading) {
            clearTimeout(host.loadSaveTimer);
            host.loadSaveTimer = setTimeout(() => { void this.saveSharedBrowserProfile('loaded'); }, 4000);
        }
        this.syncSharedBrowserUi();
    }

    setSharedBrowserAllowOthers(allow) {
        const host = this.sbState().host;
        if (!host) return;
        host.allowOthers = !!allow;
        for (const peer of this.voice?.peerConnections?.keys?.() || []) this.sendSharedBrowserState(peer);
        this.syncSharedBrowserUi();
    }

    /** pc.ondatachannel с меткой 'zali-sb' (через onVoiceDataChannel). */
    onSharedBrowserDataChannel(peer, channel) {
        const sb = this.sbState();
        const name = String(peer || '').trim();
        try { sb.channels.get(name)?.close(); } catch (e) {}
        sb.channels.set(name, channel);
        channel.onmessage = (event) => {
            if (typeof event.data !== 'string' || event.data.length > 4096) return;
            let input = null;
            try { input = JSON.parse(event.data); } catch (e) { return; }
            this.applySharedBrowserInput(name, input, 'channel');
        };
        channel.onclose = () => {
            if (sb.channels.get(name) === channel) sb.channels.delete(name);
        };
        this.voiceTrace('sb-channel-incoming', { peer: name });
    }

    /** Ввод от участника (или свой, via='local') → курсор + браузер оболочки. */
    applySharedBrowserInput(from, raw, via) {
        const host = this.sbState().host;
        if (!host) return;
        const input = this.sanitizeSharedBrowserInput(raw);
        if (!input) return;
        const me = String(this.myName() || '');
        const who = via === 'local' ? me : String(from || '');
        if (!who) return;
        if ('x' in input) {
            host.cursors.set(who, { x: input.x, y: input.y, at: Date.now(), down: input.t === 'down' });
            host.cursorsDirty = true;
        } else if (input.t === 'leave') {
            if (host.cursors.delete(who)) host.cursorsDirty = true;
            return;
        }
        // Клавиши и вставка — только из канала данных (см. шапку файла).
        if (via === 'relay' && (input.t === 'key' || input.t === 'text')) return;
        if (via !== 'local' && !host.allowOthers) return;
        host.events += 1;
        if (via === 'relay') host.relayed += 1;
        if (input.t === 'nav') {
            this.postNativeMessage({ type: NativeMessageTypes.MEDIA_REQUEST, op: 'browser_nav', stream: host.stream, options: { action: input.a, url: input.url || '' } });
            return;
        }
        this.postNativeMessage({ type: NativeMessageTypes.MEDIA_REQUEST, op: 'browser_input', stream: host.stream, options: input });
    }

    /** ~20 Гц: каждому участнику — курсоры всех остальных (включая запустившего). */
    broadcastSharedBrowserCursors() {
        const sb = this.sbState();
        const host = sb.host;
        if (!host) return;
        const now = Date.now();
        for (const [name, c] of host.cursors) {
            if (now - c.at > ZaliInterface.SB_CURSOR_TTL_MS) { host.cursors.delete(name); host.cursorsDirty = true; }
        }
        if (!host.cursorsDirty) return;
        host.cursorsDirty = false;
        const all = Array.from(host.cursors.entries()).map(([name, c]) => [name, Math.round(c.x * 10000) / 10000, Math.round(c.y * 10000) / 10000, c.down ? 1 : 0]);
        for (const [peer, ch] of sb.channels) {
            if (ch.readyState !== 'open' || ch.bufferedAmount > 64 * 1024) continue;
            const list = all.filter(c => c[0] !== peer);
            try { ch.send(JSON.stringify({ t: 'cursors', c: list })); } catch (e) {}
        }
    }

    // ------------------------------------------------------------- участник

    onRemoteSharedBrowserState(peer, signal) {
        const sb = this.sbState();
        const fresh = !sb.remote.has(peer);
        const entry = sb.remote.get(peer) || { cursors: new Map(), channel: null, channelPc: null, channelFailed: false, since: Date.now() };
        entry.url = String(signal.url || '').slice(0, 2048);
        entry.title = String(signal.title || '').slice(0, 300);
        entry.canBack = !!signal.canBack;
        entry.canForward = !!signal.canForward;
        entry.loading = !!signal.loading;
        entry.allowOthers = signal.allowOthers !== false;
        entry.profile = signal.profile === 'community' ? 'community' : 'own';
        sb.remote.set(peer, entry);
        // Канал сразу, а не по первому вводу: курсоры остальных приходят по нему же.
        this.ensureSharedBrowserChannel(peer);
        if (fresh) {
            this.sbNotice('INFO', `${peer} запустил общий браузер — разверните его, чтобы управлять`);
            this.voiceTrace('sb-remote-started', { peer });
        }
        this.syncSharedBrowserUi();
    }

    onRemoteSharedBrowserEnded(peer) {
        const sb = this.sbState();
        const entry = sb.remote.get(peer);
        if (!entry) return;
        sb.remote.delete(peer);
        try { entry.channel?.close(); } catch (e) {}
        this.voiceTrace('sb-remote-ended', { peer });
        this.syncSharedBrowserUi();
    }

    /** closeVoicePeer: соединение закрыто — канал на нём мёртв, курсор ушёл. */
    onSharedBrowserPeerClosed(peer) {
        const sb = this.sbState();
        const name = String(peer || '').trim();
        try { sb.channels.get(name)?.close(); } catch (e) {}
        sb.channels.delete(name);
        if (sb.host?.cursors.delete(name)) sb.host.cursorsDirty = true;
        const entry = sb.remote.get(name);
        if (entry) {
            entry.channel = null;
            entry.channelPc = null;
            entry.channelFailed = false;
            entry.cursors.clear();
        }
    }

    /** Конец звонка: всё сбросить без сигналов — комнаты уже нет. */
    resetSharedBrowser(reason = 'call-end') {
        const sb = this.sbState();
        if (sb.host) this.onSharedBrowserShareStopping(reason);
        for (const entry of sb.remote.values()) { try { entry.channel?.close(); } catch (e) {} }
        sb.remote.clear();
        sb.local.buttons.clear();
        sb.local.keys.clear();
        this.syncSharedBrowserUi();
    }

    ensureSharedBrowserChannel(peer) {
        const entry = this.sbState().remote.get(peer);
        if (!entry) return null;
        const pcEntry = this.voice?.peerConnections?.get(peer);
        if (!pcEntry?.pc) return null;
        if (entry.channelPc === pcEntry.pc) return entry.channelFailed ? null : entry.channel;
        entry.channelPc = pcEntry.pc;
        entry.channelFailed = false;
        let channel;
        try {
            channel = pcEntry.pc.createDataChannel('zali-sb', { ordered: true });
        } catch (error) {
            entry.channelFailed = true;
            this.voiceTrace('sb-channel-failed', { peer, error: error?.message || String(error) }, 'WARN');
            return null;
        }
        entry.channel = channel;
        channel.onopen = () => this.voiceTrace('sb-channel-open', { peer, ms: Date.now() - (entry.since || Date.now()) });
        channel.onclose = () => { if (entry.channel === channel) entry.channel = null; };
        channel.onmessage = (event) => {
            if (typeof event.data !== 'string' || event.data.length > 16384) return;
            let msg = null;
            try { msg = JSON.parse(event.data); } catch (e) { return; }
            if (msg?.t !== 'cursors' || !Array.isArray(msg.c)) return;
            const now = Date.now();
            const next = new Map();
            for (const item of msg.c.slice(0, 32)) {
                if (!Array.isArray(item)) continue;
                const name = String(item[0] || '').slice(0, 64);
                const x = this.sbUnit(item[1]), y = this.sbUnit(item[2]);
                if (!name || x === null || y === null) continue;
                next.set(name, { x, y, at: now, down: !!item[3] });
            }
            entry.cursors = next;
        };
        // Первый канал данных на соединении требует нового offer (m=application).
        this.renegotiateVoicePeer(peer).catch(() => {});
        return channel;
    }

    /** Свой ввод в браузер владельца `owner` ('' — наш собственный браузер). */
    sendSharedBrowserInput(owner, input) {
        if (!owner) {
            this.applySharedBrowserInput('', input, 'local');
            return;
        }
        const entry = this.sbState().remote.get(owner);
        if (!entry) return;
        const channel = this.ensureSharedBrowserChannel(owner);
        if (channel && channel.readyState === 'open') {
            if (input.t === 'move' && channel.bufferedAmount > 64 * 1024) return;
            try { channel.send(JSON.stringify(input)); return; } catch (e) {}
        }
        // Без канала — через сервер, только мышь и навигация; движения не шлём вовсе.
        if (input.t === 'key' || input.t === 'text') {
            if (!entry.keysNoticeShown) {
                entry.keysNoticeShown = true;
                this.sbNotice('INFO', 'Клавиатура заработает, когда установится прямое соединение с запустившим браузер');
            }
            return;
        }
        if (input.t === 'move' || input.t === 'leave') return;
        this.sendVoicePeerSignal(owner, { type: 'sb-input', e: input });
    }

    // ------------------------------------------------------------- интерфейс

    /** Чей браузер на плитке/в фокусе: '' — наш, имя — собеседника, null — не браузер. */
    sharedBrowserOwnerFor(screenPeer) {
        const sb = this.sbState();
        const peer = String(screenPeer ?? '');
        if (peer === '') return sb.host ? '' : null;
        return sb.remote.has(peer) ? peer : null;
    }

    sharedBrowserInfo(owner) {
        const sb = this.sbState();
        return owner === '' ? sb.host : sb.remote.get(owner) || null;
    }

    /** Кнопка в панели звонка: только где оболочка умеет, или пока браузер идёт. */
    sharedBrowserButtonHtml() {
        const sb = this.sbState();
        if (!sb.host && !this.sharedBrowserLaunchAvailable()) return '';
        const label = sb.host ? 'Открыть общий браузер' : (sb.launching ? 'Общий браузер запускается…' : 'Запустить общий браузер');
        return this.callCtrlBtn({ id: 'voiceSharedBrowserBtn', kind: 'globe', label, short: 'Браузер', active: !!sb.host });
    }

    onSharedBrowserButton() {
        const sb = this.sbState();
        if (sb.launching) return;
        if (sb.host) this.focusSharedBrowser('');
        else this.openSharedBrowserLauncher();
    }

    focusSharedBrowser(owner) {
        const label = owner === '' ? 'Общий браузер' : `Общий браузер · ${owner}`;
        this.openVoiceFocus?.('screen', owner, label);
    }

    /** Открыт ли сейчас на весь экран браузер (и чей). */
    sharedBrowserFocusOwner() {
        const focus = this._voiceFocus;
        if (focus?.kind !== 'screen') return null;
        return this.sharedBrowserOwnerFor(focus.peer);
    }

    /** Плитка, фокус и курсоры — без перерисовки всей панели (её зовут только смены кнопки). */
    syncSharedBrowserUi() {
        const stage = document.getElementById('voiceStage');
        if (stage) this.syncSharedBrowserStage(stage);
        const root = document.getElementById('voiceFocus');
        if (root) this.syncSharedBrowserFocus(root);
        this.ensureSharedBrowserCursorLoop();
    }

    /** Плитки сцены: подпись «Общий браузер · сайт» и курсоры участников. */
    syncSharedBrowserStage(stage) {
        for (const tile of Array.from(stage.children)) {
            if (tile.dataset?.kind !== 'screen') continue;
            const owner = this.sharedBrowserOwnerFor(tile.dataset.peer || '');
            tile.classList.toggle('is-shared-browser', owner !== null);
            let badge = tile.querySelector('.sb-tile-badge');
            let layer = tile.querySelector(':scope > .sb-cursors');
            if (owner === null) {
                badge?.remove();
                layer?.remove();
                continue;
            }
            const info = this.sharedBrowserInfo(owner);
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'sb-tile-badge';
                tile.appendChild(badge);
            }
            let host = '';
            try { host = info?.url ? new URL(info.url).host : ''; } catch (e) { host = ''; }
            const text = `Общий браузер${host ? ` · ${host}` : ''}`;
            if (badge.textContent !== text) badge.textContent = text;
            if (!layer) {
                layer = document.createElement('div');
                layer.className = 'sb-cursors';
                tile.appendChild(layer);
            }
        }
    }

    /** Фокус на браузере: панель адреса, захват ввода, курсоры. */
    syncSharedBrowserFocus(root) {
        const owner = this.sharedBrowserFocusOwner();
        const active = owner !== null;
        root.classList.toggle('is-shared-browser', active);
        let bar = root.querySelector('.sb-bar');
        let layer = root.querySelector(':scope > .sb-cursors');
        if (!active) {
            bar?.remove();
            layer?.remove();
            return;
        }
        const info = this.sharedBrowserInfo(owner);
        if (!info) return;
        const media = root.querySelector('.voice-focus-media');
        this.bindSharedBrowserCapture(media);
        this.ensureSharedBrowserKeyHook();
        if (!layer) {
            layer = document.createElement('div');
            layer.className = 'sb-cursors';
            root.appendChild(layer);
        }
        if (!bar) {
            bar = document.createElement('div');
            bar.className = 'sb-bar';
            bar.innerHTML = `
                <button type="button" class="sb-btn" data-sb="back" title="Назад" aria-label="Назад"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>
                <button type="button" class="sb-btn" data-sb="forward" title="Вперёд" aria-label="Вперёд"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
                <button type="button" class="sb-btn" data-sb="reload" title="Обновить" aria-label="Обновить"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></svg></button>
                <form class="sb-url-form"><input class="sb-url" type="text" inputmode="url" autocomplete="off" spellcheck="false" aria-label="Адрес"></form>
                <span class="sb-profile"></span>
                <button type="button" class="sb-btn sb-allow" data-sb="allow"></button>
                <button type="button" class="sb-btn sb-close" data-sb="close">Закрыть браузер</button>`;
            // Оверлей сворачивается по клику — панель свои клики не отдаёт.
            bar.addEventListener('click', (event) => {
                event.stopPropagation();
                const btn = event.target.closest('[data-sb]');
                if (!btn) return;
                const own = this.sharedBrowserFocusOwner();
                if (own === null) return;
                const action = btn.dataset.sb;
                if (action === 'close') { void this.closeSharedBrowser(); return; }
                if (action === 'allow') { this.setSharedBrowserAllowOthers(!this.sbState().host?.allowOthers); return; }
                this.sendSharedBrowserInput(own, { t: 'nav', a: action });
            });
            bar.addEventListener('pointerdown', (event) => event.stopPropagation());
            bar.querySelector('.sb-url-form').addEventListener('submit', (event) => {
                event.preventDefault();
                const own = this.sharedBrowserFocusOwner();
                const input = bar.querySelector('.sb-url');
                const url = this.normalizeSharedBrowserUrl(input.value);
                if (own === null || !url) return;
                this.sendSharedBrowserInput(own, { t: 'nav', a: 'go', url });
                input.blur();
            });
            root.insertBefore(bar, root.firstChild);
        }
        const isHost = owner === '';
        const urlInput = bar.querySelector('.sb-url');
        if (urlInput && document.activeElement !== urlInput && urlInput.value !== (info.url || '')) urlInput.value = info.url || '';
        bar.classList.toggle('is-loading', !!info.loading);
        const back = bar.querySelector('[data-sb="back"]');
        const fwd = bar.querySelector('[data-sb="forward"]');
        const mayControl = isHost || info.allowOthers !== false;
        if (back) back.disabled = !info.canBack || !mayControl;
        if (fwd) fwd.disabled = !info.canForward || !mayControl;
        const reload = bar.querySelector('[data-sb="reload"]');
        if (reload) reload.disabled = !mayControl;
        if (urlInput) urlInput.disabled = !mayControl;
        const profile = bar.querySelector('.sb-profile');
        const profileText = info.profile === 'community' ? 'Профиль сообщества' : (isHost ? 'Ваш профиль' : `Профиль ${owner}`);
        if (profile && profile.textContent !== profileText) profile.textContent = profileText;
        const allow = bar.querySelector('.sb-allow');
        if (allow) {
            allow.hidden = !isHost;
            const text = info.allowOthers ? 'Управляют все' : 'Управляю только я';
            if (allow.textContent !== text) allow.textContent = text;
            allow.classList.toggle('is-active', !!info.allowOthers);
            allow.title = info.allowOthers ? 'Нажмите, чтобы управлять браузером могли только вы' : 'Нажмите, чтобы браузером снова могли управлять все участники';
        }
        const close = bar.querySelector('.sb-close');
        if (close) close.hidden = !isHost;
        root.classList.toggle('is-sb-readonly', !mayControl);
    }

    /** Мышь над кадром браузера → ввод владельцу; курсор — всем. */
    bindSharedBrowserCapture(media) {
        if (!media || media.dataset.sbBound) return;
        media.dataset.sbBound = '1';
        const sb = this.sbState();
        const video = () => media.querySelector('video');
        const owner = () => this.sharedBrowserFocusOwner();
        const point = (event) => this.remoteControlPoint?.(video(), event.clientX, event.clientY);
        const mayControl = (own) => own === '' || this.sbState().remote.get(own)?.allowOthers !== false;
        const guard = (event) => {
            if (owner() === null) return false;
            event.preventDefault();
            event.stopPropagation();
            return true;
        };
        media.addEventListener('pointermove', (event) => {
            const own = owner();
            if (own === null) return;
            const p = point(event);
            if (!p || (!p.inside && !sb.local.buttons.size)) return;
            sb.local.pendingMove = { owner: own, input: { t: 'move', x: p.cx, y: p.cy } };
            if (!sb.local.frame) {
                sb.local.frame = requestAnimationFrame(() => {
                    sb.local.frame = 0;
                    const move = sb.local.pendingMove;
                    sb.local.pendingMove = null;
                    if (move) this.sendSharedBrowserInput(move.owner, move.input);
                });
            }
        });
        media.addEventListener('pointerleave', () => {
            const own = owner();
            if (own !== null && !sb.local.buttons.size) this.sendSharedBrowserInput(own, { t: 'leave' });
        });
        media.addEventListener('pointerdown', (event) => {
            if (!guard(event)) return;
            const own = owner();
            // Фокус с адресной строки — обратно на кадр: клавиши снова идут в браузер.
            if (document.activeElement?.closest?.('.sb-bar')) document.activeElement.blur();
            if (!mayControl(own)) return;
            const p = point(event);
            const b = event.button;
            if (!p || !p.inside || ![0, 1, 2].includes(b)) return;
            try { media.setPointerCapture(event.pointerId); } catch (e) {}
            sb.local.buttons.add(b);
            this.sendSharedBrowserInput(own, { t: 'down', x: p.cx, y: p.cy, b, n: Math.max(1, Math.min(3, event.detail || 1)) });
        });
        media.addEventListener('pointerup', (event) => {
            if (!guard(event)) return;
            const b = event.button;
            if (!sb.local.buttons.has(b)) return;
            sb.local.buttons.delete(b);
            const p = point(event);
            this.sendSharedBrowserInput(owner(), { t: 'up', x: p ? p.cx : 0, y: p ? p.cy : 0, b, n: Math.max(1, Math.min(3, event.detail || 1)) });
        });
        media.addEventListener('pointercancel', () => this.releaseSharedBrowserInputs());
        media.addEventListener('click', (event) => { guard(event); });
        media.addEventListener('dblclick', (event) => { guard(event); });
        media.addEventListener('contextmenu', (event) => { guard(event); });
        media.addEventListener('wheel', (event) => {
            if (!guard(event)) return;
            const own = owner();
            if (!mayControl(own)) return;
            const p = point(event);
            if (!p) return;
            const k = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? 400 : 1);
            this.sendSharedBrowserInput(own, { t: 'wheel', x: p.cx, y: p.cy, dx: Math.round(event.deltaX * k), dy: Math.round(event.deltaY * k) });
        }, { passive: false });
    }

    releaseSharedBrowserInputs() {
        const sb = this.sbState();
        const own = this.sharedBrowserFocusOwner();
        const hadAny = sb.local.buttons.size || sb.local.keys.size;
        sb.local.buttons.clear();
        sb.local.keys.clear();
        if (hadAny && own !== null) this.sendSharedBrowserInput(own, { t: 'release' });
    }

    /**
     * Клавиатура — на window в фазе захвата (раньше хоткеев и Esc оверлея).
     * Cmd/Ctrl+V не отправляется: фокус уходит в скрытое поле, браузер вставляет туда
     * СВОЙ буфер участника, и текст уходит владельцу как {t:'text'}.
     */
    ensureSharedBrowserKeyHook() {
        const sb = this.sbState();
        if (sb.keyHook) return;
        const sink = document.createElement('textarea');
        sink.className = 'sb-paste-sink';
        sink.setAttribute('aria-hidden', 'true');
        sink.tabIndex = -1;
        document.body.appendChild(sink);
        sink.addEventListener('paste', (event) => {
            const own = this.sharedBrowserFocusOwner();
            const text = event.clipboardData?.getData('text/plain') || '';
            event.preventDefault();
            sink.value = '';
            sink.blur();
            if (own !== null && text) this.sendSharedBrowserInput(own, { t: 'text', s: text.slice(0, 2000) });
        });
        sb.keyHook = (event) => {
            const own = this.sharedBrowserFocusOwner();
            if (own === null) return;
            const target = event.target;
            // Адресная строка — обычное поле ввода.
            if (target?.closest?.('.sb-bar')) return;
            if (!event.code || event.isComposing) return;
            const mod = (event.shiftKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
            if ((event.metaKey || event.ctrlKey) && event.code === 'KeyV') {
                if (event.type === 'keydown') sink.focus();
                event.stopImmediatePropagation();
                return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            if (own !== '' && sb.remote.get(own)?.allowOthers === false) return;
            const down = event.type === 'keydown';
            if (down) sb.local.keys.add(event.code);
            else if (!sb.local.keys.delete(event.code)) return;
            const key = String(event.key || '').length <= 24 ? String(event.key || '') : '';
            this.sendSharedBrowserInput(own, { t: 'key', code: event.code, key, d: down ? 1 : 0, m: mod });
        };
        sb.blurHook = () => this.releaseSharedBrowserInputs();
        window.addEventListener('keydown', sb.keyHook, true);
        window.addEventListener('keyup', sb.keyHook, true);
        window.addEventListener('blur', sb.blurHook);
    }

    /** Цикл отрисовки курсоров — только пока есть хоть один браузер. */
    ensureSharedBrowserCursorLoop() {
        const sb = this.sbState();
        const any = !!sb.host || sb.remote.size > 0;
        if (!any) {
            if (sb.raf) cancelAnimationFrame(sb.raf);
            sb.raf = 0;
            return;
        }
        if (sb.raf || typeof requestAnimationFrame !== 'function') return;
        const tick = () => {
            sb.raf = 0;
            if (!sb.host && !sb.remote.size) return;
            this.renderSharedBrowserCursors();
            sb.raf = requestAnimationFrame(tick);
        };
        sb.raf = requestAnimationFrame(tick);
    }

    /** Курсоры: слой поверх области кадра (с учётом полей object-fit: contain). */
    renderSharedBrowserCursors() {
        const sb = this.sbState();
        const me = String(this.myName() || '');
        const now = Date.now();
        const layers = document.querySelectorAll('.sb-cursors');
        for (const layer of layers) {
            const container = layer.parentElement;
            if (!container) continue;
            const isFocus = container.id === 'voiceFocus';
            const peer = isFocus ? (this._voiceFocus?.peer ?? null) : (container.dataset.peer ?? null);
            const owner = peer === null ? null : this.sharedBrowserOwnerFor(peer);
            const video = isFocus ? container.querySelector('.voice-focus-media video') : container.querySelector('video');
            if (owner === null || !video || !video.videoWidth) { layer.style.display = 'none'; continue; }
            const rect = video.getBoundingClientRect();
            const box = container.getBoundingClientRect();
            const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
            const w = video.videoWidth * scale, h = video.videoHeight * scale;
            const left = rect.left - box.left + (rect.width - w) / 2;
            const top = rect.top - box.top + (rect.height - h) / 2;
            layer.style.display = '';
            layer.style.left = `${left}px`;
            layer.style.top = `${top}px`;
            layer.style.width = `${w}px`;
            layer.style.height = `${h}px`;
            const cursors = owner === '' ? sb.host?.cursors : sb.remote.get(owner)?.cursors;
            const seen = new Set();
            for (const [name, c] of cursors || []) {
                if (name === me || now - c.at > ZaliInterface.SB_CURSOR_TTL_MS) continue;
                seen.add(name);
                let el = layer.querySelector(`[data-sb-cursor="${CSS.escape(name)}"]`);
                if (!el) {
                    el = document.createElement('div');
                    el.className = 'sb-cursor';
                    el.dataset.sbCursor = name;
                    el.innerHTML = `<svg class="sb-cursor-arrow" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 2.5 19.5 12l-6.6 1.6-3.4 6.4Z" stroke-linejoin="round"/></svg><span class="sb-cursor-name"></span>`;
                    el.querySelector('.sb-cursor-name').textContent = name;
                    layer.appendChild(el);
                }
                const color = this.sharedBrowserCursorColor(name);
                if (el.dataset.color !== color) {
                    el.dataset.color = color;
                    el.style.setProperty('--sb-cursor', color);
                }
                el.classList.toggle('is-down', !!c.down);
                el.classList.toggle('is-idle', now - c.at > 2500);
                el.style.transform = `translate(${(c.x * w).toFixed(1)}px, ${(c.y * h).toFixed(1)}px)`;
            }
            for (const el of Array.from(layer.children)) {
                if (!seen.has(el.dataset.sbCursor)) el.remove();
            }
        }
    }
});
