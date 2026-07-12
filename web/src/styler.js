// @ts-check
class ZaliStyler {
    constructor() {
        this.name = 'zali_styler';
        this.currentKey = '';
        
        // Custom premium themes matching rich aesthetics
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
                '--text2': 'rgba(255,255,255,.5)',
                '--text3': 'rgba(255,255,255,.25)',
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
                '--text2': 'rgba(0,255,204,.6)',
                '--text3': 'rgba(0,255,204,.3)',
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
                '--text2': 'rgba(57,255,20,.65)',
                '--text3': 'rgba(57,255,20,.35)',
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
                '--text2': 'rgba(224,245,255,.6)',
                '--text3': 'rgba(224,245,255,.3)',
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
                '--text2': 'rgba(255,255,255,.6)',
                '--text3': 'rgba(255,255,255,.35)',
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
                '--text2': 'rgba(255,240,229,.62)',
                '--text3': 'rgba(255,240,229,.32)',
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
                '--text2': 'rgba(232,255,248,.6)',
                '--text3': 'rgba(232,255,248,.3)',
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
                '--text2': 'rgba(244,246,248,.58)',
                '--text3': 'rgba(244,246,248,.3)',
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
                '--text2': 'rgba(255,240,244,.62)',
                '--text3': 'rgba(255,240,244,.32)',
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
                '--text2': 'rgba(246,239,255,.62)',
                '--text3': 'rgba(246,239,255,.32)',
                '--border': 'rgba(208,174,255,.14)',
            }
        };

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

        // Load saved style from UserDefaults if available
        const restoredSavedStyle = this._loadSavedStyle();

        const storedKey = this._loadStoredKey();
        if (storedKey) {
            this.setKey(storedKey);
        }

        const storedTheme = this.loadStoredThemeName();
        if (storedTheme && this.themes[storedTheme]) {
            this.setTheme(storedTheme, { persist: false, remember: false });
        } else if (!restoredSavedStyle) {
            this.setTheme('lime', { persist: false, remember: false });
        } else {
            this.markActiveThemeButton(storedTheme || '');
        }
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
        const theme = this.themes[themeName];
        if (!theme) {
            console.warn(`[zali_styler] Тема "${themeName}" не найдена`);
            return false;
        }

        for (const [key, val] of Object.entries(theme)) {
            this.setVariable(key, val, { persist: false });
            this.currentVars[key] = val;
        }

        if (options.remember !== false) {
            this.saveStoredThemeName(themeName);
        }
        this.markActiveThemeButton(themeName);
        console.log(`[zali_styler] Установлена цветовая схема "${themeName}"`);
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
        try {
            const scope = String(window.__ZALI_ACTIVE_CONVERSATION_SCOPE || '').trim();
            if (scope) {
                const convKey = this._conversationKeysStorageKey();
                const raw = sessionStorage.getItem(convKey) || localStorage.getItem(convKey);
                const stored = raw ? (JSON.parse(raw) || {}) : {};
                if (this.currentKey) {
                    stored[scope] = this.currentKey;
                } else {
                    delete stored[scope];
                }
                sessionStorage.setItem(convKey, JSON.stringify(stored));
                localStorage.removeItem(convKey);
            }
        } catch (e) {}

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
