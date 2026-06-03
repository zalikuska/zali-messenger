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
        this.bus.registerCommand('zali_styler', 'set_border_radius', (radius)    => this.setBorderRadius(radius));
        this.bus.registerCommand('zali_styler', 'set_variable',      (name, val) => this.setVariable(name, val));
        this.bus.registerCommand('zali_styler', 'get_themes',        ()          => Object.keys(this.themes));
        this.bus.registerCommand('zali_styler', 'save_style',        ()          => this.saveStyleToNative());
        this.bus.registerCommand('zali_styler', 'set_key',           (key)       => this.setKey(key));

        // Load saved style from UserDefaults if available
        this._loadSavedStyle();

        const storedKey = this._loadStoredKey();
        if (storedKey) {
            this.setKey(storedKey);
        }

        // Initial setup with the lime theme as default
        this.setTheme('lime', { persist: false });
    }

    _loadStoredKey() {
        try {
            const stored = (localStorage.getItem('zali_crypto_key_v1') || '').trim();
            if (stored) return stored;
        } catch (e) {}
        return (window.__ZALI_SAVED_KEY || '').trim() || 'ZALI_SECRET_E2E_KEY_2026';
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
        }
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

        console.log(`[zali_styler] Установлена цветовая схема "${themeName}"`);
        if (options.persist !== false) this.saveStyleToNative();
        return true;
    }

    setBorderRadius(radius) {
        const radStr = String(radius).endsWith('px') ? radius : `${radius}px`;
        this.currentRadius = parseInt(radius, 10);
        this.setVariable('--r-msg', radStr, { persist: false });
        this.currentVars['--r-msg'] = radStr;
        console.log(`[zali_styler] Закругление углов сообщений: ${radStr}`);
        this.saveStyleToNative();
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
            if (this.currentKey) {
                localStorage.setItem('zali_crypto_key_v1', this.currentKey);
            } else {
                localStorage.removeItem('zali_crypto_key_v1');
            }
        } catch (e) {}

        try {
            window.__ZALI_SAVED_KEY = this.currentKey;
        } catch (e) {}

        const input = document.getElementById('inputCryptoKey');
        if (input && input.value !== this.currentKey) {
            input.value = this.currentKey;
        }
        this.updateKeyDisplay();

        // Notify native Swift layer to update the decryption key
        if (this.nativeSupports('setKey')) {
            this.postNativeMessage({
                type: 'SET_KEY',
                key: this.currentKey
            });
        }
        if (this.bus) {
            this.bus.send('zali_interface:refresh_after_key');
        }
        console.log('[zali_styler] Ключ E2E обновлён и передан в native backend');
    }

    updateKeyDisplay(meta = null) {
        const valueEl = document.getElementById('currentCryptoKeyValue');
        const metaEl = document.getElementById('currentCryptoKeyMeta');
        const key = (this.currentKey || '').trim() || (window.__ZALI_SAVED_KEY || '').trim() || 'не задан';
        if (valueEl) valueEl.textContent = key;
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
