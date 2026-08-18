// --- ZaliInterface: Сетевая конфигурация: API/WS адреса, ICE/TURN. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    loadStoredNavMode() {
        try {
            const raw = localStorage.getItem(this.navModeStorageKey());
            return raw === 'servers' ? 'servers' : 'dm';
        } catch (e) {
            return 'dm';
        }
    }

    saveStoredNavMode(mode) {
        try {
            localStorage.setItem(this.navModeStorageKey(), mode);
        } catch (e) {
            // ignore storage failures
        }
    }

    loadStoredActiveServer() {
        try {
            const raw = localStorage.getItem(this.activeServerStorageKey());
            return raw ? String(raw) : null;
        } catch (e) {
            return null;
        }
    }

    saveStoredActiveServer(serverId) {
        try {
            if (serverId) {
                localStorage.setItem(this.activeServerStorageKey(), serverId);
            } else {
                localStorage.removeItem(this.activeServerStorageKey());
            }
        } catch (e) {
            // ignore storage failures
        }
    }

    loadStoredActiveChannel() {
        try {
            const raw = localStorage.getItem(this.activeChannelStorageKey());
            return raw ? String(raw) : null;
        } catch (e) {
            return null;
        }
    }

    saveStoredActiveChannel(channelId) {
        try {
            if (channelId) {
                localStorage.setItem(this.activeChannelStorageKey(), channelId);
            } else {
                localStorage.removeItem(this.activeChannelStorageKey());
            }
        } catch (e) {
            // ignore storage failures
        }
    }

    loadStoredServerChats() {
        return {};
    }

    saveStoredServerChats() {
        // Server history now comes from the backend; keep this as a no-op
        // so local optimistic state doesn't get duplicated after restart.
    }

    loadStoredMutedChats() {
        try {
            const raw = localStorage.getItem(this.mutedChatsStorageKey());
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    saveStoredMutedChats() {
        try {
            localStorage.setItem(this.mutedChatsStorageKey(), JSON.stringify(this.S.mutedChats || {}));
        } catch (e) {
            // ignore storage failures
        }
    }

    loadStoredNetworkConfig() {
        try {
            const raw = localStorage.getItem(this.networkConfigStorageKey());
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    isDefaultableNetworkUrl(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (!raw) return true;
        return (
            raw.startsWith('http://localhost') ||
            raw.startsWith('https://localhost') ||
            raw.startsWith('http://127.0.0.1') ||
            raw.startsWith('https://127.0.0.1') ||
            raw.startsWith('http://[::1]') ||
            raw.startsWith('https://[::1]') ||
            raw.startsWith('http://89.108.76.89:3000') ||
            raw.startsWith('https://89.108.76.89:3000')
        );
    }

    trimTrailingSlash(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    isPlaceholderNetworkUrl(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (!raw) return false;
        return (
            raw.includes('chat.example.com') ||
            raw.includes('turn.example.com') ||
            raw.includes('example.com')
        );
    }

    normalizeLocalApiAddress(value) {
        const raw = this.trimTrailingSlash(value);
        if (!raw) return '';
        try {
            const parsed = new URL(raw);
            const host = parsed.hostname.toLowerCase();
            const isLocalHost = ['localhost', '127.0.0.1', '::1'].includes(host);
            if (isLocalHost && !parsed.port) {
                parsed.port = '3000';
            }
            if (host === 'localhost' || host === '::1') {
                parsed.hostname = '127.0.0.1';
            }
            return parsed.toString().replace(/\/$/, '');
        } catch (e) {
            if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?:[\/?#]|$)/i.test(raw) && !/:\d+(?:[\/?#]|$)/.test(raw)) {
                return raw
                    .replace(/^(https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]))(?=[:\/?#]|$)/i, '$1:3000')
                    .replace(/^https?:\/\/(?:localhost|\[::1\])(?=:3000(?:[\/?#]|$))/i, 'http://127.0.0.1');
            }
            if (/^https?:\/\/(?:localhost|\[::1\])(?=[:\/?#]|$)/i.test(raw)) {
                return raw.replace(
                    /^(https?:\/\/)(?:localhost|\[::1\])(?=[:\/?#]|$)/i,
                    '$1127.0.0.1'
                );
            }
            return raw;
        }
    }

    normalizeApiBaseUrl(value) {
        const normalized = this.normalizeLocalApiAddress(value);
        if (!normalized) return '';
        if (this.isPlaceholderNetworkUrl(normalized)) return '';
        return normalized;
    }

    normalizeWsBaseUrl(value) {
        const normalized = this.trimTrailingSlash(value);
        if (!normalized) return '';
        if (this.isPlaceholderNetworkUrl(normalized)) return '';
        return normalized;
    }

    saveStoredNetworkConfig(config) {
        try {
            localStorage.setItem(this.networkConfigStorageKey(), JSON.stringify(config || {}));
        } catch (e) {
            // ignore storage failures
        }
    }

    hasStoredNetworkConfig() {
        try {
            return !!localStorage.getItem(this.networkConfigStorageKey());
        } catch (e) {
            return false;
        }
    }

    defaultApiBaseUrl() {
        if (window.__ZALI_CONFIG?.apiBaseUrl) {
            return this.normalizeApiBaseUrl(window.__ZALI_CONFIG.apiBaseUrl);
        }
        return 'https://msgs.zalikus.org';
    }

    defaultWsBaseUrl() {
        if (window.__ZALI_CONFIG?.wsBaseUrl) {
            return this.normalizeWsBaseUrl(window.__ZALI_CONFIG.wsBaseUrl);
        }
        const api = this.defaultApiBaseUrl();
        if (api.startsWith('https://')) return api.replace(/^https:\/\//, 'wss://') + '/ws';
        if (api.startsWith('http://')) return api.replace(/^http:\/\//, 'ws://') + '/ws';
        return 'wss://msgs.zalikus.org/ws';
    }

    deriveWsBaseUrl(apiBaseUrl) {
        const api = this.normalizeApiBaseUrl(apiBaseUrl || '');
        if (api.startsWith('https://')) return api.replace(/^https:\/\//, 'wss://') + '/ws';
        if (api.startsWith('http://')) return api.replace(/^http:\/\//, 'ws://') + '/ws';
        return this.defaultWsBaseUrl();
    }

    defaultTurnUrls() {
        const fromConfig = window.__ZALI_CONFIG?.turn?.url;
        if (fromConfig) {
            const urls = Array.isArray(fromConfig) ? fromConfig : [fromConfig];
            return urls.map(item => String(item || '').trim()).filter(Boolean);
        }

        const stored = this.loadStoredNetworkConfig();
        const apiBase = this.normalizeApiBaseUrl(stored.apiBaseUrl || '') || this.defaultApiBaseUrl();
        let host = '127.0.0.1';
        try {
            host = new URL(apiBase).hostname || host;
        } catch (e) {}

        if (host === 'localhost' || host === '127.0.0.1' || host === '::1') {
            return [
                'turn:127.0.0.1:3478?transport=udp',
                'turn:127.0.0.1:3478?transport=tcp',
                'turn:localhost:3478?transport=udp',
                'turn:localhost:3478?transport=tcp',
            ];
        }

        const safeHost = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
        return [
            `turn:${safeHost}:3478?transport=udp`,
            `turn:${safeHost}:3478?transport=tcp`,
        ];
    }

    defaultIceServers() {
        const injected = window.__ZALI_CONFIG?.iceServers;
        if (Array.isArray(injected) && injected.length) {
            return injected;
        }
        const turnConfig = window.__ZALI_CONFIG?.turn;
        if (turnConfig && turnConfig.url) {
            const urls = Array.isArray(turnConfig.url) ? turnConfig.url : [turnConfig.url];
            const turnServer = {
                urls: urls.map(item => String(item || '').trim()).filter(Boolean),
            };
            if (turnServer.urls.length) {
                if (turnConfig.username) turnServer.username = String(turnConfig.username).trim();
                if (turnConfig.credential) turnServer.credential = String(turnConfig.credential).trim();
                if (turnConfig.relayOnly !== undefined) turnServer.relayOnly = !!turnConfig.relayOnly;
                const servers = [turnServer];
                if (!turnServer.relayOnly) {
                    servers.push(
                        { urls: 'stun:stun.l.google.com:19302' },
                        { urls: 'stun:stun1.l.google.com:19302' },
                    );
                }
                return servers;
            }
        }
        return [
            {
                urls: this.defaultTurnUrls(),
                username: 'zali',
                credential: 'turnpass',
            },
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
        ];
    }

    defaultTurnPreset() {
        const turn = window.__ZALI_CONFIG?.turn || {};
        const defaultUrls = this.defaultTurnUrls().join(', ');
        return {
            url: String(turn.url || defaultUrls).trim(),
            username: String(turn.username || 'zali').trim(),
            credential: String(turn.credential || 'turnpass').trim(),
            relayOnly: turn.relayOnly !== undefined ? !!turn.relayOnly : false,
        };
    }

    normalizeIceServers(value) {
        const list = Array.isArray(value) ? value : [];
        return list.map(item => {
            if (typeof item === 'string') {
                return { urls: item.trim() };
            }
            if (item && typeof item === 'object') {
                const urls = Array.isArray(item.urls) ? item.urls : item.urls ? [item.urls] : [];
                const next = { ...item, urls: urls.map(url => String(url || '').trim()).filter(Boolean) };
                return next.urls.length ? next : null;
            }
            return null;
        }).filter(Boolean);
    }

    parseIceServersText(raw) {
        const text = String(raw || '').trim();
        if (!text) return [];
        const parsed = JSON.parse(text);
        if (!Array.isArray(parsed)) {
            throw new Error('ICE servers должен быть JSON-массивом');
        }
        return this.normalizeIceServers(parsed);
    }

    loadNetworkConfig() {
        const stored = this.loadStoredNetworkConfig();
        const storedApiBaseUrl = this.normalizeApiBaseUrl(stored.apiBaseUrl || '');
        const storedWsBaseUrl = this.normalizeWsBaseUrl(stored.wsBaseUrl || '');
        const useDefaultApi = this.isDefaultableNetworkUrl(storedApiBaseUrl);
        const apiBaseUrl = useDefaultApi ? this.defaultApiBaseUrl() : (storedApiBaseUrl || this.defaultApiBaseUrl());
        const wsBaseUrl = useDefaultApi
            ? this.defaultWsBaseUrl()
            : (storedWsBaseUrl || this.defaultWsBaseUrl());
        let iceServers = this.normalizeIceServers(stored.iceServers);
        if (!iceServers.length) {
            iceServers = this.normalizeIceServers(this.defaultIceServers());
        }
        return { apiBaseUrl, wsBaseUrl, iceServers };
    }

    getApiBaseUrl() {
        return this.loadNetworkConfig().apiBaseUrl;
    }

    getWsBaseUrl() {
        return this.loadNetworkConfig().wsBaseUrl;
    }

    getIceServers() {
        return this.loadNetworkConfig().iceServers;
    }

    getVoiceRtcConfig() {
        const config = this.loadNetworkConfig();
        const defaultTurn = {
            urls: this.defaultTurnUrls(),
            username: 'zali',
            credential: 'turnpass',
        };
        const iceServers = this.normalizeIceServers([defaultTurn, ...config.iceServers]);
        const seenUrls = new Set();
        const uniqueServers = iceServers.map(server => {
            const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
            const nextUrls = urls
                .map(url => String(url || '').trim())
                .filter(Boolean)
                .filter(url => {
                    const key = url.toLowerCase();
                    if (seenUrls.has(key)) return false;
                    seenUrls.add(key);
                    return true;
                });
            return nextUrls.length ? { ...server, urls: nextUrls } : null;
        }).filter(Boolean);
        return {
            iceServers: uniqueServers.map(server => {
                const { relayOnly, ...iceServer } = server || {};
                return iceServer;
            }),
            iceCandidatePoolSize: 4,
            iceTransportPolicy: 'all',
        };
    }

    apiUrl(path = '') {
        const base = String(this.getApiBaseUrl() || '').trim().replace(/\/+$/, '');
        const nextPath = String(path || '').trim();
        if (!base) return nextPath;
        if (!nextPath) return base;
        return `${base}${nextPath.startsWith('/') ? nextPath : `/${nextPath}`}`;
    }

    setNetworkConfig(config = {}) {
        const next = {
            apiBaseUrl: this.normalizeApiBaseUrl(config.apiBaseUrl || ''),
            wsBaseUrl: this.normalizeWsBaseUrl(config.wsBaseUrl || ''),
            iceServers: this.normalizeIceServers(config.iceServers),
        };
        this.saveStoredNetworkConfig(next);
        this.applyNetworkConfigToInputs();
        this.syncNativeNetworkConfig({ force: true });
        this.connectBrowserVoiceSocket();
        this.addLogEntry({ type: 'SUCCESS', msg: 'Network configuration updated', ts: new Date().toLocaleTimeString() });
    }

    resetNetworkConfig() {
        try {
            localStorage.removeItem(this.networkConfigStorageKey());
        } catch (e) {}
        this.applyNetworkConfigToInputs();
        this.syncNativeNetworkConfig({ force: true });
        this.connectBrowserVoiceSocket();
        this.addLogEntry({ type: 'WARN', msg: 'Network configuration reset to defaults', ts: new Date().toLocaleTimeString() });
    }

    applyNetworkConfigToInputs() {
        const config = this.loadNetworkConfig();
        const apiInput = document.getElementById('inputApiBaseUrl');
        const wsInput = document.getElementById('inputWsBaseUrl');
        const iceInput = document.getElementById('inputIceServers');
        const turnUrlInput = document.getElementById('inputTurnUrl');
        const turnUsernameInput = document.getElementById('inputTurnUsername');
        const turnCredentialInput = document.getElementById('inputTurnCredential');
        const turnRelayOnlyInput = document.getElementById('inputTurnRelayOnly');
        if (apiInput) apiInput.value = config.apiBaseUrl;
        if (wsInput) wsInput.value = config.wsBaseUrl;
        if (iceInput) iceInput.value = JSON.stringify(config.iceServers, null, 2);
        const turn = this.defaultTurnPreset();
        if (turnUrlInput) turnUrlInput.value = turn.url;
        if (turnUsernameInput) turnUsernameInput.value = turn.username;
        if (turnCredentialInput) turnCredentialInput.value = turn.credential;
        if (turnRelayOnlyInput) turnRelayOnlyInput.checked = turn.relayOnly;
        const authApiInput = document.getElementById('authApiBaseUrl');
        const authNote = document.getElementById('authNetworkNote');
        if (authApiInput && document.activeElement !== authApiInput && authApiInput.dataset.dirty !== '1') {
            authApiInput.value = config.apiBaseUrl;
        }
        if (authNote) {
            authNote.textContent = `Текущий API: ${config.apiBaseUrl || 'не задан'}`;
        }
    }

    syncAuthNetworkInput({ force = false } = {}) {
        const authApiInput = document.getElementById('authApiBaseUrl');
        const authNote = document.getElementById('authNetworkNote');
        if (!authApiInput) return;
        const config = this.loadNetworkConfig();
        const isTyping = document.activeElement === authApiInput;
        const isDirty = authApiInput.dataset.dirty === '1';
        if (force || (!isTyping && !isDirty)) {
            authApiInput.value = config.apiBaseUrl;
        }
        if (authNote) {
            authNote.textContent = `Текущий API: ${config.apiBaseUrl || 'не задан'}`;
        }
    }

    buildTurnIceServerFromInputs() {
        const turnUrlInput = document.getElementById('inputTurnUrl');
        const turnUsernameInput = document.getElementById('inputTurnUsername');
        const turnCredentialInput = document.getElementById('inputTurnCredential');
        const turnRelayOnlyInput = document.getElementById('inputTurnRelayOnly');
        const urls = String(turnUrlInput?.value || '').trim();
        if (!urls) {
            throw new Error('Укажите TURN URL');
        }
        const urlList = urls.split(',').map(item => item.trim()).filter(Boolean);
        if (!urlList.length) {
            throw new Error('TURN URL не должен быть пустым');
        }
        const entry = {
            urls: urlList.length === 1 ? urlList[0] : urlList,
        };
        const username = String(turnUsernameInput?.value || '').trim();
        const credential = String(turnCredentialInput?.value || '').trim();
        if (username) entry.username = username;
        if (credential) entry.credential = credential;
        if (turnRelayOnlyInput) entry.relayOnly = !!turnRelayOnlyInput.checked;
        return entry;
    }

    appendTurnPresetToIceServers(baseIceServers = null) {
        const iceInput = document.getElementById('inputIceServers');
        const current = Array.isArray(baseIceServers)
            ? this.normalizeIceServers(baseIceServers)
            : this.normalizeIceServers(this.loadNetworkConfig().iceServers);
        const turnEntry = this.buildTurnIceServerFromInputs();
        const next = [...current.filter(server => {
            const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            const turnUrls = Array.isArray(turnEntry.urls) ? turnEntry.urls : [turnEntry.urls];
            return !urls.some(url => turnUrls.includes(url));
        }), turnEntry];
        if (iceInput) {
            iceInput.value = JSON.stringify(next, null, 2);
        }
        return next;
    }

    syncNativeNetworkConfig({ force = false } = {}) {
        if (!this.nativeSupports('networkConfig')) return;
        const injected = window.__ZALI_CONFIG || {};
        const hasInjectedNetworkConfig = !!(injected.apiBaseUrl || injected.wsBaseUrl || (Array.isArray(injected.iceServers) && injected.iceServers.length));
        if (!force && !this.hasStoredNetworkConfig() && !hasInjectedNetworkConfig) return;
        const config = this.loadNetworkConfig();
        try {
            this.postNativeMessage({
                type: NativeMessageTypes.NETWORK_CONFIG,
                apiBaseUrl: config.apiBaseUrl,
                wsBaseUrl: config.wsBaseUrl,
                iceServers: config.iceServers,
            });
        } catch (error) {
            this.addLogEntry({
                type: 'WARN',
                msg: `Не удалось синхронизировать сеть с native app: ${error?.message || error}`,
                ts: new Date().toLocaleTimeString(),
            });
        }
    }
});
