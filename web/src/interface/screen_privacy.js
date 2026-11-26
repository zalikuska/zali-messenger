// --- ZaliInterface: скрытые приложения в трансляции и глобальные горячие клавиши. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Скрытые приложения. Список живёт только на этом устройстве (не в settings_sync.js:
// id приложений у каждой ОС свои — bundle id на macOS, имя .exe на Windows) в
// `zali_screen_privacy_v1`: { hidingEnabled, style, warnWhenOff, apps: [{id, name, icon,
// hideVideo, muteAudio, style?}] }. Оболочка получает его в options.privacy старта
// захвата экрана (voice_media.js) и на лету — MEDIA_REQUEST op `set_privacy`; картинку
// и звук вырезает/закрывает она сама (macOS ScreenCapture.swift → ScreenPrivacy.swift,
// Windows screen.rs → privacy.rs). Android: картинку закрыть нельзя (MediaProjection
// отдаёт весь экран одним кадром), звук экрана Android не передаёт вовсе — раздел там
// только поясняет это.
//
// Горячие клавиши. Назначения — `zali_hotkeys_v1` { bindings: {mic, deafen, screen,
// hiding}, shareSource }. Оболочка регистрирует их глобально (op `set_hotkeys`, ответ —
// какие не удалось занять) и шлёт `media_event {event:'hotkey', action}`; состояние
// микрофона/наушников/трансляции живёт здесь, в voice_*.js. Отклик при скрытом окне —
// короткая нативная подсказка поверх всех окон (op `overlay`, id `hud`), которая не
// попадает в трансляцию. Той же op держится плашка «скрытие выключено».
//
// Формат сочетания: модификаторы в порядке Ctrl, Alt, Shift, Meta + KeyboardEvent.code
// ("Ctrl+Shift+KeyM"). Код, а не символ: на русской раскладке «M» — это «Ь».

const ZALI_SCREEN_PRIVACY_KEY = 'zali_screen_privacy_v1';
const ZALI_HOTKEYS_KEY = 'zali_hotkeys_v1';
const ZALI_HOTKEY_ACTIONS = [
    { id: 'mic', label: 'Микрофон', note: 'Включить или выключить свой микрофон в звонке' },
    { id: 'deafen', label: 'Звук собеседников', note: 'Наушники: заглушить или вернуть голоса звонка' },
    { id: 'screen', label: 'Трансляция', note: 'Начать или остановить показ экрана' },
    { id: 'hiding', label: 'Скрытие приложений', note: 'Включить или выключить скрытие в трансляции' },
];
// Клавиши, которые умеют все оболочки (таблицы — HotkeyManager.swift и hotkey_codes.rs).
const ZALI_HOTKEY_CODE_LABELS = (() => {
    const map = {
        Space: 'Пробел', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
        Home: 'Home', End: 'End', PageUp: 'PgUp', PageDown: 'PgDn', Insert: 'Ins', Delete: 'Del',
        Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Backslash: '\\',
        Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backquote: '`',
    };
    for (let c = 65; c <= 90; c++) map[`Key${String.fromCharCode(c)}`] = String.fromCharCode(c);
    for (let d = 0; d <= 9; d++) {
        map[`Digit${d}`] = String(d);
        map[`Numpad${d}`] = `Num ${d}`;
    }
    // Операторы цифровой клавиатуры — отдельные клавиши, не те же, что в основном ряду.
    Object.assign(map, { NumpadAdd: 'Num +', NumpadSubtract: 'Num −', NumpadMultiply: 'Num *', NumpadDivide: 'Num /', NumpadDecimal: 'Num .' });
    for (let f = 1; f <= 20; f++) map[`F${f}`] = `F${f}`;
    return map;
})();

ZaliMixin(ZaliInterface, class {

    // ------------------------------------------------------------ хранение

    screenPrivacyPrefs() {
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(ZALI_SCREEN_PRIVACY_KEY) || 'null'); } catch (e) { raw = null; }
        const src = raw && typeof raw === 'object' ? raw : {};
        const style = (v) => (v === 'blur' || v === 'plate' ? v : '');
        const apps = (Array.isArray(src.apps) ? src.apps : [])
            .filter(a => a && typeof a.id === 'string' && a.id.trim())
            .slice(0, 64)
            .map(a => ({
                id: String(a.id).slice(0, 256),
                name: String(a.name || a.id).slice(0, 120),
                icon: typeof a.icon === 'string' && a.icon.startsWith('data:image/') && a.icon.length < 60000 ? a.icon : '',
                hideVideo: a.hideVideo !== false,
                muteAudio: a.muteAudio !== false,
                ...(style(a.style) ? { style: a.style } : {}),
            }));
        return {
            hidingEnabled: src.hidingEnabled !== false,
            style: style(src.style) || 'plate',
            warnWhenOff: src.warnWhenOff !== false,
            apps,
        };
    }

    saveScreenPrivacyPrefs(prefs) {
        try { localStorage.setItem(ZALI_SCREEN_PRIVACY_KEY, JSON.stringify(prefs)); } catch (e) { /* без хранилища — только до перезагрузки */ }
        this._screenPrivacyCache = null;
        this.pushScreenPrivacy();
        this.renderScreenPrivacySettings();
    }

    updateScreenPrivacy(mutator) {
        const prefs = this.screenPrivacyPrefs();
        mutator(prefs);
        this.saveScreenPrivacyPrefs(prefs);
        return prefs;
    }

    /** То, что уходит оболочке: только приложения, у которых что-то скрыто. */
    screenPrivacyNativePayload() {
        const prefs = this.screenPrivacyPrefs();
        return {
            hidingEnabled: prefs.hidingEnabled,
            style: prefs.style,
            hiddenApps: prefs.apps
                .filter(a => a.hideVideo || a.muteAudio)
                .map(a => ({ id: a.id, name: a.name, hideVideo: a.hideVideo, muteAudio: a.muteAudio, ...(a.style ? { style: a.style } : {}) })),
        };
    }

    screenPrivacySupported() {
        return this.nativeSupports('nativeScreenPrivacy');
    }

    pushScreenPrivacy() {
        if (this.screenPrivacySupported()) {
            this.postNativeMessage({ type: NativeMessageTypes.MEDIA_REQUEST, op: 'set_privacy', options: this.screenPrivacyNativePayload() });
        }
        this.syncScreenPrivacyWarning();
    }

    hotkeyPrefs() {
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(ZALI_HOTKEYS_KEY) || 'null'); } catch (e) { raw = null; }
        const src = raw && typeof raw === 'object' ? raw : {};
        const bindings = {};
        for (const action of ZALI_HOTKEY_ACTIONS) {
            const accel = this.normalizeHotkeyAccel(src.bindings?.[action.id]);
            if (accel) bindings[action.id] = accel;
        }
        return { bindings, shareSource: typeof src.shareSource === 'string' ? src.shareSource.slice(0, 300) : '' };
    }

    saveHotkeyPrefs(prefs) {
        try { localStorage.setItem(ZALI_HOTKEYS_KEY, JSON.stringify(prefs)); } catch (e) { /* только до перезагрузки */ }
    }

    // ------------------------------------------------------------ сочетания

    /** Каноничная строка или '' (неизвестная клавиша / нет модификатора у обычной клавиши). */
    normalizeHotkeyAccel(value) {
        if (typeof value !== 'string' || !value) return '';
        const parts = value.split('+').map(p => p.trim()).filter(Boolean);
        const code = parts.pop();
        if (!code || !ZALI_HOTKEY_CODE_LABELS[code]) return '';
        const mods = ['Ctrl', 'Alt', 'Shift', 'Meta'].filter(m => parts.includes(m));
        if (mods.length !== parts.length) return '';
        // Буква без модификатора сломала бы набор текста во всей системе; F-клавиши и
        // цифровая клавиатура (ею почти не печатают) — можно.
        if (!mods.length && !/^(F\d+|Numpad[A-Za-z0-9]+)$/.test(code)) return '';
        return [...mods, code].join('+');
    }

    hotkeyAccelFromEvent(e) {
        if (['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight', 'MetaLeft', 'MetaRight', 'OSLeft', 'OSRight'].includes(e.code)) return null;
        const mods = [];
        if (e.ctrlKey) mods.push('Ctrl');
        if (e.altKey) mods.push('Alt');
        if (e.shiftKey) mods.push('Shift');
        if (e.metaKey) mods.push('Meta');
        return [...mods, e.code].join('+');
    }

    hotkeyAccelLabel(accel) {
        if (!accel) return '';
        const mac = window.__ZALI_NATIVE_PLATFORM === 'macos';
        const parts = accel.split('+');
        const code = parts.pop();
        const key = ZALI_HOTKEY_CODE_LABELS[code] || code;
        if (mac) {
            const sym = { Ctrl: '⌃', Alt: '⌥', Shift: '⇧', Meta: '⌘' };
            return parts.map(p => sym[p] || p).join('') + key;
        }
        const names = { Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Meta: 'Win' };
        return [...parts.map(p => names[p] || p), key].join('+');
    }

    hotkeysSupported() {
        return this.nativeSupports('nativeHotkeys');
    }

    /** Отдать назначения оболочке; ответ — какие сочетания заняты. suspend — снять все на время записи. */
    async pushHotkeys({ suspend = false } = {}) {
        if (!this.hotkeysSupported()) return null;
        const bindings = suspend ? {} : this.hotkeyPrefs().bindings;
        try {
            const res = await this.nativeMediaRequest('set_hotkeys', { options: { bindings } }, 4000);
            const results = res?.results && typeof res.results === 'object' ? res.results : {};
            if (!suspend) this._hotkeyResults = results;
            return results;
        } catch (e) {
            this.voiceTrace?.('hotkeys-push-failed', { error: e?.message || String(e) }, 'WARN');
            return null;
        }
    }

    // ------------------------------------------------------------ отклик

    /** Короткая подсказка поверх всех окон (видна и когда мессенджер свёрнут). */
    showNativeHud(text) {
        if (this.nativeSupports('nativeOverlay')) {
            this.postNativeMessage({ type: NativeMessageTypes.MEDIA_REQUEST, op: 'overlay', options: { id: 'hud', text: String(text), visible: true, timeoutMs: 1600 } });
        } else {
            this.showToast?.({ text: String(text), timeoutMs: 2500 });
        }
    }

    /** Плашка «скрытие выключено»: трансляция идёт, есть кого скрывать, скрытие выключено, предупреждать — да. */
    syncScreenPrivacyWarning() {
        if (!this.nativeSupports('nativeOverlay')) return;
        const prefs = this.screenPrivacyPrefs();
        const visible = !!this.voice?.screenSharing
            && prefs.apps.some(a => a.hideVideo || a.muteAudio)
            && !prefs.hidingEnabled
            && prefs.warnWhenOff;
        if (this._screenPrivacyWarningShown === visible) return;
        this._screenPrivacyWarningShown = visible;
        this.postNativeMessage({
            type: NativeMessageTypes.MEDIA_REQUEST,
            op: 'overlay',
            options: { id: 'privacy-warning', visible, text: 'Скрытие приложений выключено — зрители видят всё' },
        });
    }

    // ------------------------------------------------------------ действия клавиш

    onNativeHotkey(action) {
        this.voiceTrace?.('hotkey', { action });
        const inCall = !!this.voice?.roomId;
        if (action === 'mic') {
            if (!this.voice?.localStream) return this.showNativeHud('Нет активного звонка');
            this.toggleVoiceMute();
            this.showNativeHud(this.voice.muted ? 'Микрофон выключен' : 'Микрофон включён');
        } else if (action === 'deafen') {
            if (!inCall) return this.showNativeHud('Нет активного звонка');
            this.toggleVoiceDeafen();
            this.showNativeHud(this.voice.deafened ? 'Звук собеседников выключен' : 'Звук собеседников включён');
        } else if (action === 'screen') {
            if (this.voice?.screenSharing) {
                this.stopScreenShare();
                this.showNativeHud('Трансляция остановлена');
                return;
            }
            if (!inCall) return this.showNativeHud('Трансляцию можно начать только в звонке');
            void this.startHotkeyScreenShare();
        } else if (action === 'hiding') {
            const prefs = this.updateScreenPrivacy(p => { p.hidingEnabled = !p.hidingEnabled; });
            this.showNativeHud(prefs.hidingEnabled ? 'Скрытие приложений включено' : 'Скрытие приложений выключено');
        }
    }

    /** Трансляция источника по умолчанию из настроек клавиш. Окна нет — не стартуем. */
    async startHotkeyScreenShare() {
        if (this.voice.screenShareRequestInFlight) return;
        const pref = this.loadVoiceDevicePref(ZaliInterface.VOICE_SCREEN_PREF_KEY);
        const base = { height: pref.height ?? 1080, fps: pref.fps ?? 30, audio: pref.audio ?? 1 };
        if (!this.nativeCaptureAvailable?.('screen')) {
            // Без нативного захвата источник выбирает система — открываем обычный путь.
            this.openVoiceScreenPicker?.();
            return;
        }
        const target = this.hotkeyPrefs().shareSource;
        let sources = [];
        try { sources = await this.listNativeScreenSources({ thumbWidth: 0 }); } catch (e) { sources = []; }
        let source = null;
        if (target.startsWith('app:')) {
            const app = target.slice(4);
            source = sources.find(s => s.kind === 'window' && !s.own && s.app === app) || null;
            if (!source) {
                this.showNativeHud(`Окно «${app}» не найдено — трансляция не начата`);
                this.showToast?.({ title: 'Трансляция не начата', text: `Окно приложения «${app}» сейчас не открыто. Источник по умолчанию меняется в «Настройки → Трансляция».`, tone: 'warn', timeoutMs: 8000 });
                return;
            }
        } else {
            const displays = sources.filter(s => s.kind === 'display');
            source = displays.find(s => s.id === target) || displays[0] || null;
            if (!source) {
                this.showNativeHud('Экран не найден — трансляция не начата');
                return;
            }
        }
        await this.startScreenShare({ ...base, sourceId: source.id, sourceKind: source.kind, own: !!source.own });
        this.showNativeHud(this.voice.screenSharing
            ? `Трансляция: ${source.kind === 'window' ? source.app || source.title : source.title}`
            : 'Трансляцию начать не удалось');
    }

    // ------------------------------------------------------------ настройки: разметка

    bindScreenPrivacySettings() {
        const card = document.getElementById('screenPrivacySettingsCard');
        if (!card || card.dataset.spBound) return;
        card.dataset.spBound = '1';
        document.getElementById('inputScreenHidingEnabled')?.addEventListener('change', (e) => {
            this.updateScreenPrivacy(p => { p.hidingEnabled = !!e.target.checked; });
        });
        document.getElementById('inputScreenHidingWarn')?.addEventListener('change', (e) => {
            this.updateScreenPrivacy(p => { p.warnWhenOff = !!e.target.checked; });
        });
        document.getElementById('inputScreenHidingStyle')?.addEventListener('change', (e) => {
            this.updateScreenPrivacy(p => { p.style = e.target.value === 'blur' ? 'blur' : 'plate'; });
        });
        document.getElementById('screenPrivacyAddBtn')?.addEventListener('click', () => void this.toggleScreenPrivacyPicker());
        const apps = document.getElementById('screenPrivacyApps');
        apps?.addEventListener('change', (e) => {
            const row = e.target.closest('[data-sp-app]');
            if (!row) return;
            const id = row.getAttribute('data-sp-app');
            const field = e.target.getAttribute('data-sp-field');
            this.updateScreenPrivacy(p => {
                const app = p.apps.find(a => a.id === id);
                if (!app) return;
                if (field === 'hideVideo' || field === 'muteAudio') app[field] = !!e.target.checked;
            });
        });
        apps?.addEventListener('click', (e) => {
            const seg = e.target.closest('[data-sp-style]');
            if (seg) {
                const id = seg.closest('[data-sp-app]')?.getAttribute('data-sp-app');
                const value = seg.getAttribute('data-sp-style');
                this.updateScreenPrivacy(p => {
                    const app = p.apps.find(a => a.id === id);
                    if (!app) return;
                    if (value === 'blur' || value === 'plate') app.style = value;
                    else delete app.style;
                });
                return;
            }
            const btn = e.target.closest('[data-sp-remove]');
            if (!btn) return;
            const id = btn.getAttribute('data-sp-remove');
            this.updateScreenPrivacy(p => { p.apps = p.apps.filter(a => a.id !== id); });
        });
        document.getElementById('screenPrivacyPicker')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-sp-add]');
            if (!btn) return;
            const app = (this._screenPrivacyRunning || []).find(a => a.id === btn.getAttribute('data-sp-add'));
            if (!app) return;
            this.updateScreenPrivacy(p => {
                if (!p.apps.some(a => a.id === app.id)) {
                    p.apps.push({ id: app.id, name: app.name || app.id, icon: app.icon || '', hideVideo: true, muteAudio: true });
                }
            });
            this.renderScreenPrivacyPicker();
        });
        this.bindHotkeySettings();
        this.renderScreenPrivacySettings();
        // Оболочке — текущее состояние: она могла перезапустить страницу посреди трансляции.
        this.pushScreenPrivacy();
        void this.pushHotkeys().then(() => this.renderHotkeySettings());
    }

    renderScreenPrivacySettings() {
        const card = document.getElementById('screenPrivacySettingsCard');
        const hotkeysCard = document.getElementById('hotkeysSettingsCard');
        if (!card) return;
        const supported = this.screenPrivacySupported();
        const android = window.__ZALI_NATIVE_PLATFORM === 'android';
        card.hidden = !supported && !android;
        if (hotkeysCard) hotkeysCard.hidden = !this.hotkeysSupported();
        const controls = document.getElementById('screenPrivacyControls');
        if (controls) controls.hidden = !supported;
        const note = document.getElementById('screenPrivacyNote');
        if (note) {
            let text = '';
            if (android) {
                text = 'На Android скрыть отдельное приложение нельзя: система отдаёт трансляции весь экран одним кадром — ни плашкой, ни размытием его не закрыть, а звук экрана с телефона в трансляцию не идёт. Перед показом экрана закройте то, что не должны видеть.';
            } else if (window.__ZALI_NATIVE_PLATFORM === 'windows') {
                text = 'На Windows картинка закрывается по положению окон с запасом по краям — жёсткой гарантии нет: при очень быстром перетаскивании край окна может мелькнуть на кадр. Звук скрытого приложения не передаётся; программа, которая сама запустила скрытое приложение (лаунчер игры), тоже звучать в трансляции не будет.';
            } else if (supported) {
                text = 'Плашка вырезает окна приложения из захвата целиком, размытие оставляет их на месте, но делает текст нечитаемым. Звук скрытого приложения не передаётся при любом стиле.';
            }
            if (note.textContent !== text) note.textContent = text;
        }
        if (!supported) return;
        const prefs = this.screenPrivacyPrefs();
        const enabled = document.getElementById('inputScreenHidingEnabled');
        if (enabled) enabled.checked = prefs.hidingEnabled;
        const warn = document.getElementById('inputScreenHidingWarn');
        if (warn) warn.checked = prefs.warnWhenOff;
        const style = document.getElementById('inputScreenHidingStyle');
        if (style) style.value = prefs.style;
        const list = document.getElementById('screenPrivacyApps');
        if (list) {
            const html = prefs.apps.length
                ? prefs.apps.map(app => this.screenPrivacyAppRowHTML(app)).join('')
                : '<div class="sp-empty">Список пуст — добавьте приложения, которые зрители не должны видеть.</div>';
            if (this.setHTMLIfChanged) this.setHTMLIfChanged(list, html);
            else if (list.innerHTML !== html) list.innerHTML = html;
        }
        this.renderHotkeySettings();
    }

    screenPrivacyAppIconHTML(app) {
        if (app.icon) return `<img class="sp-app-icon" src="${this.esc(app.icon)}" alt="" draggable="false">`;
        return `<span class="sp-app-icon sp-app-icon--letter">${this.esc((app.name || app.id || '?').trim().charAt(0).toUpperCase())}</span>`;
    }

    screenPrivacyAppRowHTML(app) {
        const styleValue = app.style || '';
        return `<div class="sp-app" data-sp-app="${this.esc(app.id)}">
            ${this.screenPrivacyAppIconHTML(app)}
            <div class="sp-app-main">
                <strong class="sp-app-name">${this.esc(app.name)}</strong>
                <div class="sp-app-opts">
                    <label class="sp-chip"><input type="checkbox" data-sp-field="hideVideo"${app.hideVideo ? ' checked' : ''}><span>Скрыть картинку</span></label>
                    <label class="sp-chip"><input type="checkbox" data-sp-field="muteAudio"${app.muteAudio ? ' checked' : ''}><span>Не передавать звук</span></label>
                    <div class="sp-seg" role="radiogroup" aria-label="Как закрывать «${this.esc(app.name)}»">
                        ${[['', 'Как у всех'], ['plate', 'Плашка'], ['blur', 'Размытие']].map(([v, l]) => `<button type="button" role="radio" class="sp-seg-btn${styleValue === v ? ' is-selected' : ''}" aria-checked="${this.esc(String(styleValue === v))}" data-sp-style="${this.esc(v)}">${this.esc(l)}</button>`).join('')}
                    </div>
                </div>
            </div>
            <button type="button" class="sp-icon-btn" data-sp-remove="${this.esc(app.id)}" aria-label="Убрать «${this.esc(app.name)}» из списка" title="Убрать из списка">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
            </button>
        </div>`;
    }

    async toggleScreenPrivacyPicker() {
        const picker = document.getElementById('screenPrivacyPicker');
        if (!picker) return;
        if (!picker.hidden) {
            picker.hidden = true;
            return;
        }
        picker.hidden = false;
        picker.innerHTML = '<div class="sp-empty">Ищем запущенные приложения…</div>';
        try {
            const res = await this.nativeMediaRequest('list_apps', {}, 6000);
            this._screenPrivacyRunning = Array.isArray(res?.apps) ? res.apps.filter(a => a && a.id) : [];
            // Добавленные раньше без значка (старая сборка Windows отдавала только имя .exe) —
            // подтянуть значок и человеческое имя.
            const fresh = new Map(this._screenPrivacyRunning.filter(a => a.icon).map(a => [a.id, a]));
            if (this.screenPrivacyPrefs().apps.some(a => !a.icon && fresh.has(a.id))) {
                this.updateScreenPrivacy(p => {
                    for (const a of p.apps) {
                        const f = fresh.get(a.id);
                        if (!a.icon && f) { a.icon = f.icon; a.name = f.name || a.name; }
                    }
                });
            }
        } catch (e) {
            this._screenPrivacyRunning = [];
            picker.innerHTML = `<div class="sp-empty">Не удалось получить список приложений: ${this.esc(e?.message || String(e))}</div>`;
            return;
        }
        this.renderScreenPrivacyPicker();
    }

    renderScreenPrivacyPicker() {
        const picker = document.getElementById('screenPrivacyPicker');
        if (!picker || picker.hidden) return;
        const added = new Set(this.screenPrivacyPrefs().apps.map(a => a.id));
        const items = (this._screenPrivacyRunning || []).filter(a => !added.has(a.id))
            .sort((a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id), 'ru'));
        picker.innerHTML = items.length
            ? `<div class="sp-picker-title">Запущенные приложения</div>${items.map(app => `
                <button type="button" class="sp-pick" data-sp-add="${this.esc(app.id)}">
                    ${this.screenPrivacyAppIconHTML(app)}
                    <span class="sp-app-name">${this.esc(app.name || app.id)}</span>
                    <span class="sp-pick-add">Скрыть</span>
                </button>`).join('')}`
            : '<div class="sp-empty">Все запущенные приложения уже в списке. Запустите нужное и нажмите «Добавить приложение» ещё раз.</div>';
    }

    // ------------------------------------------------------------ настройки: клавиши

    bindHotkeySettings() {
        const list = document.getElementById('hotkeysList');
        if (!list || list.dataset.hkBound) return;
        list.dataset.hkBound = '1';
        list.addEventListener('click', (e) => {
            const reset = e.target.closest('[data-hk-reset]');
            if (reset) {
                const id = reset.getAttribute('data-hk-reset');
                const prefs = this.hotkeyPrefs();
                delete prefs.bindings[id];
                this.saveHotkeyPrefs(prefs);
                this._hotkeyErrors = { ...(this._hotkeyErrors || {}), [id]: '' };
                void this.pushHotkeys().then(() => this.renderHotkeySettings());
                this.renderHotkeySettings();
                return;
            }
            const field = e.target.closest('[data-hk-record]');
            if (field) this.startHotkeyRecording(field.getAttribute('data-hk-record'));
        });
        document.getElementById('inputHotkeyShareSource')?.addEventListener('change', (e) => {
            const prefs = this.hotkeyPrefs();
            prefs.shareSource = String(e.target.value || '');
            this.saveHotkeyPrefs(prefs);
        });
        // Список экранов и окон — только по намерению человека (открыл список): на macOS он
        // требует доступа к записи экрана, и запрос при старте приложения выскочил бы у тех,
        // кто экран никогда не показывал.
        const sourceField = document.getElementById('inputHotkeyShareSource')?.closest('.settings-field');
        const refresh = () => {
            if (Date.now() - (this._hotkeySourcesAt || 0) < 3000) return;
            this._hotkeySourcesAt = Date.now();
            void this.refreshHotkeyShareSources();
        };
        sourceField?.addEventListener('pointerdown', refresh, true);
        sourceField?.addEventListener('focusin', refresh);
    }

    startHotkeyRecording(action) {
        if (!ZALI_HOTKEY_ACTIONS.some(a => a.id === action)) return;
        this.stopHotkeyRecording();
        this._hotkeyRecording = action;
        this._hotkeyErrors = { ...(this._hotkeyErrors || {}), [action]: '' };
        // Сочетание, уже занятое оболочкой глобально, до страницы не доходит — снимаем
        // все на время записи.
        void this.pushHotkeys({ suspend: true });
        const onKey = (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (e.code === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) {
                this._hotkeyErrors[action] = '';
                this.stopHotkeyRecording();
                return;
            }
            const raw = this.hotkeyAccelFromEvent(e);
            if (!raw) return; // пока только модификаторы — ждём клавишу
            const accel = this.normalizeHotkeyAccel(raw);
            if (!accel) {
                const code = raw.split('+').pop();
                this._hotkeyErrors[action] = ZALI_HOTKEY_CODE_LABELS[code]
                    ? 'Добавьте Ctrl, Alt, Shift или ⌘/Win — одна клавиша мешала бы печатать'
                    : 'Эта клавиша не поддерживается';
                this.renderHotkeySettings();
                return;
            }
            const prefs = this.hotkeyPrefs();
            const taken = ZALI_HOTKEY_ACTIONS.find(a => a.id !== action && prefs.bindings[a.id] === accel);
            if (taken) {
                this._hotkeyErrors[action] = `Уже назначено действию «${taken.label}»`;
                this.renderHotkeySettings();
                return;
            }
            const previous = prefs.bindings[action] || '';
            prefs.bindings[action] = accel;
            this.saveHotkeyPrefs(prefs);
            this.stopHotkeyRecording({ push: false });
            void this.pushHotkeys().then((results) => {
                if (results && results[action] && results[action] !== 'ok') {
                    // Сочетание занято системой или другой программой — возвращаем прежнее.
                    const back = this.hotkeyPrefs();
                    if (previous) back.bindings[action] = previous;
                    else delete back.bindings[action];
                    this.saveHotkeyPrefs(back);
                    this._hotkeyErrors[action] = results[action] === 'conflict'
                        ? `${this.hotkeyAccelLabel(accel)} уже занято системой или другой программой`
                        : `${this.hotkeyAccelLabel(accel)} не удалось назначить`;
                    void this.pushHotkeys().then(() => this.renderHotkeySettings());
                }
                this.renderHotkeySettings();
            });
        };
        const onBlur = () => this.stopHotkeyRecording();
        window.addEventListener('keydown', onKey, true);
        window.addEventListener('blur', onBlur);
        this._hotkeyRecordingCleanup = () => {
            window.removeEventListener('keydown', onKey, true);
            window.removeEventListener('blur', onBlur);
        };
        this.renderHotkeySettings();
    }

    stopHotkeyRecording({ push = true } = {}) {
        if (!this._hotkeyRecording) return;
        this._hotkeyRecording = '';
        this._hotkeyRecordingCleanup?.();
        this._hotkeyRecordingCleanup = null;
        if (push) void this.pushHotkeys().then(() => this.renderHotkeySettings());
        this.renderHotkeySettings();
    }

    renderHotkeySettings() {
        const list = document.getElementById('hotkeysList');
        if (!list || !this.hotkeysSupported()) return;
        const prefs = this.hotkeyPrefs();
        const errors = this._hotkeyErrors || {};
        const results = this._hotkeyResults || {};
        const html = ZALI_HOTKEY_ACTIONS.map((action) => {
            const accel = prefs.bindings[action.id] || '';
            const recording = this._hotkeyRecording === action.id;
            const status = !recording && accel && results[action.id] && results[action.id] !== 'ok'
                ? 'Сочетание сейчас не работает: занято системой или другой программой' : '';
            const error = errors[action.id] || status;
            return `<div class="sp-hotkey${recording ? ' is-recording' : ''}">
                <div class="sp-hotkey-text">
                    <strong>${this.esc(action.label)}</strong>
                    <small>${this.esc(action.note)}</small>
                    ${error ? `<small class="sp-hotkey-error">${this.esc(error)}</small>` : ''}
                </div>
                <button type="button" class="sp-hotkey-field${accel ? '' : ' is-empty'}" data-hk-record="${this.esc(action.id)}">${recording ? 'Нажмите сочетание…' : this.esc(accel ? this.hotkeyAccelLabel(accel) : 'Не назначено')}</button>
                <button type="button" class="sp-icon-btn" data-hk-reset="${this.esc(action.id)}" aria-label="Сбросить сочетание «${this.esc(action.label)}»" title="Сбросить"${accel ? '' : ' disabled'}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7"/><path d="M4 4v4h4"/></svg>
                </button>
            </div>`;
        }).join('');
        if (this.setHTMLIfChanged) this.setHTMLIfChanged(list, html);
        else if (list.innerHTML !== html) list.innerHTML = html;
        this.renderHotkeyShareSourceOptions();
    }

    async refreshHotkeyShareSources() {
        if (!this.nativeCaptureAvailable?.('screen')) return;
        try {
            const sources = await this.listNativeScreenSources({ thumbWidth: 0 });
            this._hotkeySources = sources;
        } catch (e) { /* остаётся прежний список */ }
        this.renderHotkeyShareSourceOptions();
    }

    renderHotkeyShareSourceOptions() {
        const select = document.getElementById('inputHotkeyShareSource');
        if (!select) return;
        const current = this.hotkeyPrefs().shareSource;
        const sources = this._hotkeySources || [];
        const options = [{ value: '', label: 'Весь экран (основной)' }];
        for (const s of sources.filter(s => s.kind === 'display')) options.push({ value: s.id, label: s.title || 'Экран' });
        const apps = [...new Set(sources.filter(s => s.kind === 'window' && !s.own && s.app).map(s => s.app))].sort((a, b) => a.localeCompare(b, 'ru'));
        for (const app of apps) options.push({ value: `app:${app}`, label: `Окно приложения «${app}»` });
        if (current && !options.some(o => o.value === current)) {
            options.push({ value: current, label: current.startsWith('app:') ? `Окно приложения «${current.slice(4)}» (не открыто)` : 'Выбранный ранее экран (не подключён)' });
        }
        const html = options.map(o => `<option value="${this.esc(o.value)}"${o.value === current ? ' selected' : ''}>${this.esc(o.label)}</option>`).join('');
        if (select.innerHTML !== html) select.innerHTML = html;
        select.value = current;
    }
});
