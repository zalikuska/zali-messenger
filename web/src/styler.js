// @ts-check
class ZaliStyler {
    constructor() {
        this.name = 'zali_styler';
        this.currentKey = '';
        
        // Тёмные схемы — исходные (2026-11-15 пользователь вернул их «к самому
        // началу» после попытки «тёмной бумаги»: тонированный холст, графитовый лист,
        // приглушённый акцент — не понравилось). Не перестраивать без запроса.
        this.themes = {
            lime: {
                '--accent-rgb': '203,255,0',
                '--lime': '#cbff00',
                '--lime-dim': 'rgba(203,255,0,.1)',
                '--lime-glow': 'rgba(203,255,0,.25)',
                '--lime-soft': 'rgba(203,255,0,.06)',
                '--bg': '#090b0e',
                '--sidebar': 'rgba(11,13,16,.9)',
                '--text': '#f2f2f2',
                '--text2': 'rgba(255,255,255,0.65)',
                '--text3': 'rgba(255,255,255,0.5)',
                '--border': 'rgba(255,255,255,.07)',
            },
            cyber: {
                '--accent-rgb': '255,0,85',
                '--lime': '#ff0055',
                '--lime-dim': 'rgba(255,0,85,.15)',
                '--lime-glow': 'rgba(255,0,85,.35)',
                '--lime-soft': 'rgba(255,0,85,.08)',
                '--bg': '#0a0512',
                '--sidebar': 'rgba(20,10,32,.92)',
                '--text': '#00ffcc',
                '--text2': 'rgba(0,255,204,0.65)',
                '--text3': 'rgba(0,255,204,0.5)',
                '--border': 'rgba(0,255,204,.15)',
            },
            matrix: {
                '--accent-rgb': '0,255,51',
                '--lime': '#00ff33',
                '--lime-dim': 'rgba(0,255,51,.15)',
                '--lime-glow': 'rgba(0,255,51,.35)',
                '--lime-soft': 'rgba(0,255,51,.07)',
                '--bg': '#020502',
                '--sidebar': 'rgba(4,16,6,.95)',
                '--text': '#39ff14',
                '--text2': 'rgba(57,255,20,0.65)',
                '--text3': 'rgba(57,255,20,0.5)',
                '--border': 'rgba(57,255,20,.2)',
            },
            ocean: {
                '--accent-rgb': '0,210,255',
                '--lime': '#00d2ff',
                '--lime-dim': 'rgba(0,210,255,.15)',
                '--lime-glow': 'rgba(0,210,255,.3)',
                '--lime-soft': 'rgba(0,210,255,.07)',
                '--bg': '#050f1e',
                '--sidebar': 'rgba(6,22,38,.93)',
                '--text': '#e0f5ff',
                '--text2': 'rgba(224,245,255,0.65)',
                '--text3': 'rgba(224,245,255,0.5)',
                '--border': 'rgba(224,245,255,.1)',
            },
            mono: {
                '--accent-rgb': '255,255,255',
                '--lime': '#ffffff',
                '--lime-dim': 'rgba(255,255,255,.15)',
                '--lime-glow': 'rgba(255,255,255,.25)',
                '--lime-soft': 'rgba(255,255,255,.05)',
                '--bg': '#121212',
                '--sidebar': 'rgba(26,26,26,.9)',
                '--text': '#ffffff',
                '--text2': 'rgba(255,255,255,0.65)',
                '--text3': 'rgba(255,255,255,0.5)',
                '--border': 'rgba(255,255,255,.12)',
            },
            ember: {
                '--accent-rgb': '255,122,46',
                '--lime': '#ff7a2e',
                '--lime-dim': 'rgba(255,122,46,.14)',
                '--lime-glow': 'rgba(255,122,46,.34)',
                '--lime-soft': 'rgba(255,122,46,.08)',
                '--bg': '#120805',
                '--sidebar': 'rgba(27,12,8,.93)',
                '--text': '#fff0e5',
                '--text2': 'rgba(255,240,229,0.65)',
                '--text3': 'rgba(255,240,229,0.5)',
                '--border': 'rgba(255,194,150,.13)',
            },
            aurora: {
                '--accent-rgb': '91,255,196',
                '--lime': '#5bffc4',
                '--lime-dim': 'rgba(91,255,196,.13)',
                '--lime-glow': 'rgba(91,255,196,.32)',
                '--lime-soft': 'rgba(91,255,196,.07)',
                '--bg': '#041012',
                '--sidebar': 'rgba(5,22,24,.94)',
                '--text': '#e8fff8',
                '--text2': 'rgba(232,255,248,0.65)',
                '--text3': 'rgba(232,255,248,0.5)',
                '--border': 'rgba(128,255,221,.12)',
            },
            graphite: {
                '--accent-rgb': '180,190,205',
                '--lime': '#b4becd',
                '--lime-dim': 'rgba(180,190,205,.14)',
                '--lime-glow': 'rgba(180,190,205,.26)',
                '--lime-soft': 'rgba(180,190,205,.06)',
                '--bg': '#0b0d10',
                '--sidebar': 'rgba(17,20,25,.94)',
                '--text': '#f4f6f8',
                '--text2': 'rgba(244,246,248,0.65)',
                '--text3': 'rgba(244,246,248,0.5)',
                '--border': 'rgba(244,246,248,.1)',
            },
            rose: {
                '--accent-rgb': '255,115,151',
                '--lime': '#ff7397',
                '--lime-dim': 'rgba(255,115,151,.14)',
                '--lime-glow': 'rgba(255,115,151,.32)',
                '--lime-soft': 'rgba(255,115,151,.07)',
                '--bg': '#12070c',
                '--sidebar': 'rgba(28,10,17,.93)',
                '--text': '#fff0f4',
                '--text2': 'rgba(255,240,244,0.65)',
                '--text3': 'rgba(255,240,244,0.5)',
                '--border': 'rgba(255,178,198,.13)',
            },
            violet: {
                '--accent-rgb': '174,92,255',
                '--lime': '#ae5cff',
                '--lime-dim': 'rgba(174,92,255,.16)',
                '--lime-glow': 'rgba(174,92,255,.34)',
                '--lime-soft': 'rgba(174,92,255,.08)',
                '--bg': '#0d0718',
                '--sidebar': 'rgba(18,10,34,.94)',
                '--text': '#f6efff',
                '--text2': 'rgba(246,239,255,0.65)',
                '--text3': 'rgba(246,239,255,0.5)',
                '--border': 'rgba(208,174,255,.14)',
            }
        };

        // Светлые варианты тех же схем. Тёмные выше — как были, к ним только
        // добавляются служебные токены (_darkPalette).
        //
        // Светлая тема — «бумага», а не белый экран: холст (bg) — приглушённый
        // каменный тон со своим оттенком у каждой схемы (лён у ember, сиреневый
        // у violet…), поверхности (surface: панель чата, карточки, меню) —
        // молочные, на ступень светлее, чистого #fff нет нигде. Текст — тёплый
        // графит (ink), не чёрный. Поэтому экран не слепит и схемы различаются
        // не одной точкой акцента.
        //   fill   — акцент-заливка для мелких мест (кнопки, бейджи, отправка);
        //   fg     — акцент как текст/иконка, ≥4,8:1 и на холсте, и на поверхности;
        //   on     — текст на fill (у mono/graphite/violet fill тёмный — текст светлый);
        //   bubble — исходящий пузырь: плотная пастель акцента (не прозрачность!),
        //            большие пятна флуоресцентного лайма на светлом режут глаз;
        //            у mono/graphite — тёмный графит со светлым текстом (bubbleOn).
        this.lightThemes = {
            // Лайм на светлой бумаге почти той же яркости, что фон (1,1:1): пятна
            // растворялись («крайне низко контрастная»). Роли не переворачиваем —
            // бренд это лаймовая заливка с чёрным знаком, — а берём лайм насыщеннее
            // и глубже (#b6ea00 вместо #cbff00), исходящие — тот же плотный лайм, не
            // пастель. Край пятен — еле заметная кромка (edge, style.css → --accent-edge).
            lime:     { bg: '#e7e7e0', surface: '246,246,241', ink: '36,38,30', fill: '182,234,0',   fg: '58,104,0',   on: '18,22,0', bubble: '190,240,20', edge: .05 },
            cyber:    { bg: '#ebe3ea', surface: '248,243,247', ink: '42,22,46', fill: '255,0,85',    fg: '196,0,72',   on: '26,4,14', bubbleMix: .3 },
            matrix:   { bg: '#e0e8e1', surface: '242,247,242', ink: '16,44,22', fill: '0,214,56',    fg: '0,112,40',   on: '2,22,8', bubbleMix: .32 },
            ocean:    { bg: '#e0e7ec', surface: '243,246,248', ink: '18,36,50', fill: '0,168,222',   fg: '0,98,145',   on: '2,22,34', bubbleMix: .32 },
            mono:     { bg: '#e6e6e5', surface: '246,246,245', ink: '30,30,30', fill: '38,38,37',    fg: '30,30,30',   on: '246,246,245', bubble: '46,46,45', bubbleOn: '244,244,243' },
            ember:    { bg: '#ece4dc', surface: '249,244,239', ink: '46,30,20', fill: '240,104,32',  fg: '166,64,6',   on: '34,14,2', bubbleMix: .36 },
            aurora:   { bg: '#dfe9e5', surface: '242,247,245', ink: '18,40,33', fill: '20,200,140',  fg: '0,112,78',   on: '1,24,16', bubbleMix: .34 },
            graphite: { bg: '#e3e6e9', surface: '244,245,247', ink: '28,32,38', fill: '70,81,98',    fg: '64,74,90',   on: '244,245,247', bubble: '70,81,98', bubbleOn: '243,245,248' },
            rose:     { bg: '#ece2e6', surface: '249,243,245', ink: '48,24,34', fill: '232,64,116',  fg: '184,36,82',  on: '34,6,16', bubbleMix: .34 },
            violet:   { bg: '#e6e2ee', surface: '246,244,250', ink: '34,24,56', fill: '128,58,240',  fg: '108,44,214', on: '255,255,255', bubbleMix: .3 },
        };

        // 'dark' | 'light' | 'system' — что выбрал пользователь; resolvedAppearance()
        // — что на экране сейчас (system разворачивается по prefers-color-scheme).
        this.appearance = 'dark';
        this.currentTheme = 'lime';
        this._systemQuery = null;

        // CSS variable defaults that can be modified by the styler
        this.currentVars = {};
        this.currentRadius = 18;
        this.saveTimer = null;
    }

    init(loader) {
        this.bus = loader.bus;

        // Register commands on the bus
        this.bus.registerCommand('zali_styler', 'set_theme',         (themeName) => this.setTheme(themeName));
        this.bus.registerCommand('zali_styler', 'set_variable',      (name, val) => this.setVariable(name, val));
        this.bus.registerCommand('zali_styler', 'get_themes',        ()          => Object.keys(this.themes));
        this.bus.registerCommand('zali_styler', 'save_style',        ()          => this.saveStyleToNative());
        this.bus.registerCommand('zali_styler', 'set_key',           (key)       => this.setKey(key));
        this.bus.registerCommand('zali_styler', 'set_appearance',    (mode)      => this.setAppearance(mode));
        this.bus.registerCommand('zali_styler', 'get_appearance',    ()          => ({ mode: this.appearance, resolved: this.resolvedAppearance() }));
        // Фон окна оболочки сменился без смены схемы (подкраска фона, prefs.js).
        this.bus.registerCommand('zali_styler', 'sync_native_appearance', () => this._applyAppearanceAttrs());

        this.appearance = this.loadStoredAppearance();
        this._watchSystemAppearance();

        // Load saved style from UserDefaults if available
        const restoredSavedStyle = this._loadSavedStyle();

        const storedKey = this._loadStoredKey();
        if (storedKey) {
            this.setKey(storedKey);
        }

        const storedTheme = this.loadStoredThemeName();
        if (storedTheme && this.themes[storedTheme]) {
            this.setTheme(storedTheme, { persist: false, remember: false });
        } else if (!restoredSavedStyle || this.resolvedAppearance() === 'light') {
            // Сохранённый CSS без имени схемы — тёмная lime из старых сборок;
            // в светлой теме он не годится, поэтому ставим схему явно.
            this.setTheme('lime', { persist: false, remember: false });
        } else {
            this.markActiveThemeButton(storedTheme || '');
            this._applyAppearanceAttrs();
        }
        this.markActiveAppearanceButton();
    }

    // ── Светлота ────────────────────────────────────────────────────────────

    appearanceStorageKey() {
        return 'zali_appearance_v1';
    }

    loadStoredAppearance() {
        try {
            const raw = String(localStorage.getItem(this.appearanceStorageKey()) || '').trim();
            return ['dark', 'light', 'system'].includes(raw) ? raw : 'dark';
        } catch (e) {
            return 'dark';
        }
    }

    resolvedAppearance() {
        if (this.appearance === 'light') return 'light';
        if (this.appearance === 'system') {
            try {
                return window.matchMedia?.('(prefers-color-scheme: light)')?.matches ? 'light' : 'dark';
            } catch (e) { return 'dark'; }
        }
        return 'dark';
    }

    _watchSystemAppearance() {
        try {
            this._systemQuery = window.matchMedia?.('(prefers-color-scheme: light)') || null;
            const onChange = () => {
                if (this.appearance === 'system') this.setTheme(this.currentTheme, { remember: false });
            };
            if (this._systemQuery?.addEventListener) this._systemQuery.addEventListener('change', onChange);
            else if (this._systemQuery?.addListener) this._systemQuery.addListener(onChange);
        } catch (e) {}
    }

    setAppearance(mode) {
        const next = ['dark', 'light', 'system'].includes(mode) ? mode : 'dark';
        this.appearance = next;
        try { localStorage.setItem(this.appearanceStorageKey(), next); } catch (e) {}
        this.setTheme(this.currentTheme, { remember: false });
        this.markActiveAppearanceButton();
        return true;
    }

    markActiveAppearanceButton() {
        try {
            document.querySelectorAll('[data-appearance-option]').forEach(btn => {
                const active = btn.getAttribute('data-appearance-option') === this.appearance;
                btn.classList.toggle('is-active', active);
                btn.setAttribute('aria-checked', String(active));
            });
        } catch (e) {}
    }

    /** Палитра светлой «бумаги»: холст, поверхность, чернила, акцент-заливка,
     *  акцент-текст, текст на акценте, исходящий пузырь. Ключи те же, что у
     *  _darkPalette, чтобы при переключении инлайн-значения не оставались на <html>.
     *  (Параметр light и тёмные ветки — след попытки «тёмной бумаги», которую
     *  пользователь отверг; сейчас вызывается только с light = true.) */
    _paperPalette(p, light) {
        const hex = p.bg.replace('#', '');
        const bg = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) || 0);
        const rgb = (str) => str.split(',').map(Number);
        // «Ниже фона» (панель ввода, низ модалки, подложка обложки) живёт внутри листа.
        // В тёмной — от листа (нейтральный графит), иначе поле ввода красилось в тон
        // холста; в светлой — как было, от холста.
        const deep = light
            ? bg.map(c => Math.max(0, c - 8)).join(',')
            : rgb(p.surface).map(c => Math.round(c * 0.72)).join(',');
        const toHex = (str) => '#' + rgb(str).map(c => c.toString(16).padStart(2, '0')).join('');
        // Пастель — смесь акцента с поверхностью, а не альфа: плотный цвет без
        // просвечивания, на любом подложенном фоне одинаковый.
        const mixRgb = (a, b, t) => rgb(a).map((c, i) => Math.round(c * t + rgb(b)[i] * (1 - t))).join(',');
        // Исходящий: в светлой — пастель (большие пятна флуоресцентного цвета на
        // светлом режут глаз), в тёмной — заливка на тон глубже (92% акцента).
        const bubble = p.bubble || mixRgb(p.fill, p.surface, p.bubbleMix ?? (light ? .4 : .92));
        const bubbleOn = p.bubbleOn || (light ? p.ink : p.on);
        return {
            '--accent-rgb': p.fill,
            '--lime': toHex(p.fill),
            '--lime-dim': `rgba(${p.fill},${light ? .18 : .14})`,
            '--lime-glow': `rgba(${p.fill},${light ? .32 : .3})`,
            '--lime-soft': `rgba(${p.fill},${light ? .1 : .07})`,
            '--bg': p.bg,
            '--sidebar': `rgba(${bg.join(',')},.94)`,
            '--text': `rgb(${p.ink})`,
            // Серые. Светлая: .7 ≈ 6:1, .62 ≈ 4,3:1 на поверхности.
            // Тёмная: .68 ≈ 8:1, .54 ≈ 5:1 на поверхности (прежние .65/.5 на чёрном).
            '--text2': `rgba(${p.ink},${light ? .7 : .68})`,
            '--text3': `rgba(${p.ink},${light ? .62 : .54})`,
            '--border': `rgba(${p.ink},${light ? .1 : .08})`,
            '--ink-rgb': p.ink,
            '--accent-fg': `rgb(${p.fg})`,
            '--accent-fg-rgb': p.fg,
            '--on-accent': `rgb(${p.on})`,
            '--on-accent-rgb': p.on,
            '--bg-rgb': bg.join(','),
            '--surface-rgb': p.surface,
            '--deep-rgb': deep,
            '--bubble-out': `rgb(${bubble})`,
            '--bubble-out-on': `rgb(${bubbleOn})`,
            '--bubble-out-on-rgb': bubbleOn,
            // Еле заметная кромка сплошных акцентных пятен — только светлой: там
            // заливка по яркости почти как бумага (лайм — чуть заметнее).
            '--accent-edge': light ? `rgba(${p.ink},${p.edge ?? .035})` : 'transparent',
        };
    }

    /** Тёмная схема — исходные значения плюс служебные токены светлоты, равные
     *  прежним литералам style.css (белые чернила, поверхность 17,19,24, текст на
     *  акценте #050505), — тёмная выглядит ровно как до появления светлой. Те же
     *  имена ключей, что у светлой, чтобы её инлайн-значения не оставались на <html>. */
    _darkPalette(name) {
        const t = this.themes[name] || this.themes.lime;
        const hex = String(t['--bg'] || '#090b0e').replace('#', '');
        const bg = [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16) || 0);
        return {
            ...t,
            '--ink-rgb': '255,255,255',
            '--accent-fg': t['--lime'],
            '--accent-fg-rgb': t['--accent-rgb'],
            '--on-accent': '#050505',
            '--on-accent-rgb': '5,5,5',
            '--bg-rgb': bg.join(','),
            '--surface-rgb': '17,19,24',
            '--deep-rgb': '10,12,16',
            '--bubble-out': t['--lime'],
            '--bubble-out-on': '#050505',
            '--bubble-out-on-rgb': '5,5,5',
            '--accent-edge': 'transparent',
        };
    }

    _lightPalette(name) {
        return this._paperPalette(this.lightThemes[name] || this.lightThemes.lime, true);
    }

    themePalette(name, appearance = this.resolvedAppearance()) {
        return appearance === 'light' ? this._lightPalette(name) : this._darkPalette(name);
    }

    _applyAppearanceAttrs() {
        const resolved = this.resolvedAppearance();
        const root = document.documentElement;
        root.setAttribute('data-appearance', resolved);
        root.style.colorScheme = resolved;
        try {
            document.querySelectorAll('meta[name="theme-color"]').forEach(m => m.setAttribute('content', this.currentVars['--bg'] || (resolved === 'light' ? '#e7e7e0' : '#090b0e')));
            document.querySelectorAll('meta[name="color-scheme"]').forEach(m => m.setAttribute('content', resolved));
        } catch (e) {}
        // Окно оболочки (фон под WebView, кнопки заголовка, полосы Android) —
        // иначе светлое приложение сидит в тёмной раме и мигает тёмным при ресайзе.
        if (this.nativeSupports('appearance')) this._scheduleNativeAppearance();
    }

    // Фон окна читается из вычисленного стиля body (в «спокойном фоне» он не равен
    // --bg схемы). Чтение — через кадр, когда браузер сам уже пересчитал стили после
    // смены переменных: прочитать сразу значило бы принудительно пересчитать стили
    // всего документа внутри клика. Повтор отсекается по фактическому фону, а не по
    // схеме: «Подкраска фона» меняет фон без смены схемы.
    _scheduleNativeAppearance() {
        if (this._nativeAppearanceQueued) return;
        this._nativeAppearanceQueued = true;
        const run = () => {
            if (!this._nativeAppearanceQueued) return;
            this._nativeAppearanceQueued = false;
            const resolved = this.resolvedAppearance();
            const background = this.nativeBackgroundColor(resolved);
            const key = `${resolved}|${background}`;
            if (key === this._lastNativeAppearance) return;
            this._lastNativeAppearance = key;
            this.postNativeMessage({ type: 'SET_APPEARANCE', appearance: resolved, background });
        };
        // rAF не идёт в свёрнутом/скрытом окне — запасной таймер.
        try { requestAnimationFrame(() => setTimeout(run, 0)); } catch (e) {}
        setTimeout(run, 120);
    }

    /** Цвет фона окна, как его видит пользователь (body в «спокойном фоне»). */
    nativeBackgroundColor(resolved = this.resolvedAppearance()) {
        try {
            const c = getComputedStyle(document.body || document.documentElement).backgroundColor;
            const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c || '');
            if (m) return '#' + [m[1], m[2], m[3]].map(v => Number(v).toString(16).padStart(2, '0')).join('');
        } catch (e) {}
        return this.currentVars['--bg'] || (resolved === 'light' ? '#e7e7e0' : '#090b0e');
    }

    _cryptoKeyStorageKey() {
        return window.__ZALI_INTERFACE?.cryptoKeyStorageKey?.() || 'zali_crypto_key_v2';
    }

    _conversationKeysStorageKey() {
        return window.__ZALI_INTERFACE?.conversationKeysStorageKey?.() || 'zali_conversation_keys_v2';
    }

    _loadStoredKey() {
        try {
            const scope = String(window.__ZALI_ACTIVE_CONVERSATION_SCOPE || '').trim();
            if (scope) {
                const convKey = this._conversationKeysStorageKey();
                const rawMap = sessionStorage.getItem(convKey) || localStorage.getItem(convKey);
                if (rawMap) {
                    const storedMap = JSON.parse(rawMap) || {};
                    const scoped = String(storedMap[scope] || '').trim();
                    if (scoped) return scoped;
                }
            }
            const keyName = this._cryptoKeyStorageKey();
            const stored = (sessionStorage.getItem(keyName) || localStorage.getItem(keyName) || '').trim();
            if (stored) {
                try {
                    sessionStorage.setItem(keyName, stored);
                    localStorage.removeItem(keyName);
                } catch (e) {}
            }
            if (stored) return stored;
        } catch (e) {}
        return '';
    }

    /**
     * Try to load persisted custom CSS from the app's saved state.
     * The native layer can inject `window.__ZALI_SAVED_CSS` at startup.
     */
    _loadSavedStyle() {
        if (window.__ZALI_SAVED_CSS) {
            // Inject the saved CSS blob as a <style> tag override
            let styleTag = document.getElementById('zali-custom-style');
            if (!styleTag) {
                styleTag = document.createElement('style');
                styleTag.id = 'zali-custom-style';
                document.head.appendChild(styleTag);
            }
            styleTag.textContent = window.__ZALI_SAVED_CSS;
            this._ingestSavedVars(window.__ZALI_SAVED_CSS);
            console.log('[zali_styler] Восстановлены сохраненные стили из UserDefaults');
            return true;
        }
        return false;
    }

    _ingestSavedVars(cssText) {
        const varRegex = /(--[A-Za-z0-9-_]+)\s*:\s*([^;]+);/g;
        let match;
        while ((match = varRegex.exec(cssText)) !== null) {
            const [, name, value] = match;
            this.currentVars[name] = value.trim();
        }

        const radiusValue = this.currentVars['--r-msg'];
        if (radiusValue) {
            const parsed = parseInt(radiusValue, 10);
            if (!Number.isNaN(parsed)) {
                this.currentRadius = parsed;
            }
        }
    }

    nativeBridge() {
        return window.__ZALI_NATIVE || null;
    }

    nativeSupports(capability) {
        return !!this.nativeBridge()?.supports?.[capability];
    }

    postNativeMessage(payload) {
        const bridge = this.nativeBridge();
        if (!bridge || typeof bridge.postMessage !== 'function') return false;
        return !!bridge.postMessage(payload);
    }

    themeStorageKey() {
        return 'zali_theme_name_v1';
    }

    loadStoredThemeName() {
        try {
            return String(localStorage.getItem(this.themeStorageKey()) || '').trim();
        } catch (e) {
            return '';
        }
    }

    saveStoredThemeName(themeName) {
        try {
            localStorage.setItem(this.themeStorageKey(), String(themeName || '').trim());
        } catch (e) {}
    }

    markActiveThemeButton(themeName) {
        try {
            document.querySelectorAll('.btn-theme[data-theme]').forEach(btn => {
                const active = String(btn.getAttribute('data-theme') || '') === String(themeName || '');
                btn.classList.toggle('active', active);
                btn.setAttribute('aria-pressed', String(active));
            });
        } catch (e) {}
    }

    setTheme(themeName, options = {}) {
        if (!this.themes[themeName]) {
            console.warn(`[zali_styler] Тема "${themeName}" не найдена`);
            return false;
        }
        this.currentTheme = themeName;
        const theme = this.themePalette(themeName);

        for (const [key, val] of Object.entries(theme)) {
            this.setVariable(key, val, { persist: false });
            this.currentVars[key] = val;
        }

        if (options.remember !== false) {
            this.saveStoredThemeName(themeName);
        }
        this.markActiveThemeButton(themeName);
        this._applyAppearanceAttrs();
        console.log(`[zali_styler] Установлена цветовая схема "${themeName}" (${this.resolvedAppearance()})`);
        if (options.persist !== false) this.saveStyleToNative();
        return true;
    }

    setVariable(name, val, options = {}) {
        document.documentElement.style.setProperty(name, val);
        this.currentVars[name] = val;
        if (options.persist !== false) {
            this.queueSaveStyle();
        }
    }

    queueSaveStyle() {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.saveStyleToNative();
        }, 120);
    }

    setKey(key) {
        this.currentKey = (key || '').trim();
        try {
            const keyName = this._cryptoKeyStorageKey();
            if (this.currentKey) {
                sessionStorage.setItem(keyName, this.currentKey);
                localStorage.removeItem(keyName);
            } else {
                sessionStorage.removeItem(keyName);
                localStorage.removeItem(keyName);
            }
        } catch (e) {}

        try {
            window.__ZALI_SAVED_KEY = this.currentKey;
        } catch (e) {}

        // No per-scope conversation-key write here anymore. This used to read
        // window.__ZALI_ACTIVE_CONVERSATION_SCOPE — a single shared global — and
        // stamp `key` into the conversation-keys map under whatever scope that
        // global happened to hold *at the moment this ran*, not necessarily the
        // scope `key` actually belongs to. Every real caller of
        // ZaliInterface.setKey() (interface.js's resolveConversationCryptoKey /
        // reconcileConversationKey) already writes the correct scope->key mapping
        // itself, with the explicit scope it just resolved, before calling this.
        // With two conversations resolving concurrently (e.g. fast chat-switching,
        // or the background reconcile this session added), the global scope value
        // can flip to the *other* conversation between that correct write and this
        // call — so this block would silently overwrite one conversation's key
        // with a different conversation's key. Confirmed live: two scopes resolved
        // via Promise.all ended up sharing the same stored key, traced to this
        // exact write. It also blew away the durable localStorage copy
        // (`localStorage.removeItem(convKey)`) on every call, which defeated the
        // "keys survive a browser restart" fix in interface.js's
        // loadStoredConversationKeys(). Not needed for correctness or for display
        // (updateKeyDisplay() below reads this.currentKey directly) — just remove it.

        const input = document.getElementById('inputCryptoKey');
        if (input && input.value !== this.currentKey) {
            input.value = this.currentKey;
        }
        this.updateKeyDisplay();

        console.log('[zali_styler] Ключ E2E обновлён в UI');
    }

    updateKeyDisplay(meta = null) {
        const valueEl = document.getElementById('currentCryptoKeyValue');
        const metaEl = document.getElementById('currentCryptoKeyMeta');
        const key = (this.currentKey || '').trim();
        if (valueEl) valueEl.textContent = key ? `задан (${key.length} символов)` : 'не задан';
        if (metaEl) {
            metaEl.textContent = meta || 'Контекст: общий ключ';
        }
    }

    /**
     * Compiles all current CSS variable overrides into a :root {} block
     * and sends them to the native Swift layer for persistence in Web/style.css.
     */
    saveStyleToNative() {
        if (!this.nativeSupports('saveStyle')) {
            console.log('[zali_styler] Native bridge не обнаружен, сохранение пропущено');
            return;
        }

        // Build :root override block from all current vars
        const varLines = Object.entries(this.currentVars)
            .map(([k, v]) => `    ${k}: ${v};`)
            .join('\n');

        const cssBlock = `:root {\n${varLines}\n    --r-msg: ${this.currentRadius}px;\n}\n`;

        this.postNativeMessage({
            type: 'SAVE_STYLE',
            css: cssBlock
        });

        console.log('[zali_styler] Стили отправлены на сохранение в Web/style.css');
    }
}
window.ZaliStyler = ZaliStyler;
