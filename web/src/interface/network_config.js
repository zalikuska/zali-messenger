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

    // Только "по-настоящему мёртвый" адрес — голый IP прод-сервера на :3000,
    // оставшийся от эпохи до nginx/TLS (сейчас прод только по HTTPS через
    // msgs.zalikus.org). localhost/127.0.0.1/[::1] здесь раньше тоже считались
    // "дефолтными" и на каждой загрузке конфига незаметно подменялись обратно
    // на прод — именно на эти адреса рассчитана normalizeLocalApiAddress()
    // ниже (сама дописывает :3000, канонизирует localhost -> 127.0.0.1), так
    // что кнопка «Сохранить» на экране входа не могла сохранить локальный
    // адрес НИКОГДА: значение переживало один цикл рендера и тут же
    // откатывалось на прод при следующем applyNetworkConfigToInputs()/
    // loadNetworkConfig(). Явно сохранённый через форму адрес теперь всегда
    // уважается — эвристика восстановления актуальна только для мёртвого
    // IP-адреса ниже.
    isDefaultableNetworkUrl(value) {
        const raw = String(value || '').trim().toLowerCase();
        if (!raw) return true;
        return (
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
            // 3478 is the first port a corporate or guest network blocks, and with
            // only 3478 offered there is no relay at all on such a network — the call
            // simply fails for anyone who needs one. 5349 is the registered TURN-over-
            // TLS port; 443 is the one that survives a firewall that allows nothing
            // but web traffic. A port with nothing listening costs a failed gathering
            // attempt, which onicecandidateerror now records by name, so adding them
            // is safe whether or not the deployment answers there.
            `turns:${safeHost}:5349?transport=tcp`,
            `turns:${safeHost}:443?transport=tcp`,
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
        // Short-lived credentials issued by the server (RFC 5766 REST scheme) when
        // the deployment has coturn in use-auth-secret mode, otherwise the static
        // pair below. The static pair is shipped inside every client, so it is a
        // relay anyone who has ever opened the bundle can use for as long as it
        // exists, and rotating it means rebuilding every client. Rotating creds fix
        // that — but only where the TURN server is configured for them, so the
        // static pair stays as the fallback rather than being removed.
        const rotating = this.voiceTurnCredentials();
        const defaultTurn = rotating || {
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
            // 1, not 4. The pool is pre-gathered per RTCPeerConnection, and a mesh
            // call builds one connection per participant — so a pool of 4 in an
            // eight-person room asks the TURN server for dozens of allocations
            // nobody will use, all against a single credential. One pre-gathered set
            // still covers the latency the pool exists for.
            iceCandidatePoolSize: 1,
            iceTransportPolicy: 'all',
        };
    }

    // Cached in memory only, never persisted: these expire, and a stale credential
    // read from disk on next launch would be worse than no credential at all (it
    // fails 401 at the TURN server, which looks exactly like a broken relay).
    voiceTurnCredentials() {
        const creds = this._voiceTurnCredentials;
        if (!creds) return null;
        if (!creds.urls?.length || !creds.username || !creds.credential) return null;
        if (Number(creds.expiresAt || 0) <= Date.now()) return null;
        return { urls: creds.urls, username: creds.username, credential: creds.credential };
    }

    // Fire-and-forget from the call-setup paths. Deliberately NOT awaited anywhere:
    // getVoiceRtcConfig is synchronous (it is called from `new RTCPeerConnection`),
    // so making credentials a precondition would mean putting a network round trip
    // in front of every call — and failing the call when it times out. If the fetch
    // lands first the rotating credential is used; if it does not, the static pair
    // is, and the call proceeds either way.
    async refreshVoiceTurnCredentials({ force = false } = {}) {
        if (!this.S?.session?.token) return null;
        // window.ZaliApiRoutes may come from an older cached bundle that predates
        // this route; reading through it unguarded would throw inside call setup.
        const route = this.apiRoutes?.voice?.turnCredentials;
        if (!route) return null;
        const existing = this.voiceTurnCredentials();
        // Refresh once the credential is inside its last quarter, so a call starting
        // now cannot outlive it by much.
        if (!force && existing && Number(this._voiceTurnCredentials?.refreshAfter || 0) > Date.now()) {
            return existing;
        }
        if (this._voiceTurnFetchInFlight) return this._voiceTurnFetchInFlight;
        const pending = (async () => {
            try {
                const res = await this.apiFetch(route, { method: 'GET' });
                if (res.status === 404) {
                    // Route absent or disabled: this deployment has no rotating
                    // credentials configured. Not an error, and not worth retrying
                    // hard — the static pair works.
                    this._voiceTurnCredentials = null;
                    this.voiceTrace('turn-credentials-unavailable', { status: res.status });
                    return null;
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const data = await res.json().catch(() => null);
                const urls = this.normalizeIceServers([{ urls: data?.urls }])[0]?.urls || [];
                const username = String(data?.username || '').trim();
                const credential = String(data?.credential || '').trim();
                const ttl = Math.max(60, Number(data?.ttl || 0) || 3600);
                if (!urls.length || !username || !credential) {
                    throw new Error('incomplete turn credentials');
                }
                const expiresAt = Date.now() + ttl * 1000;
                this._voiceTurnCredentials = {
                    urls,
                    username,
                    credential,
                    expiresAt,
                    refreshAfter: Date.now() + Math.floor(ttl * 0.75) * 1000,
                };
                this.voiceDiag('turn-credentials-refreshed', { urls: urls.length, ttl });
                return this.voiceTurnCredentials();
            } catch (error) {
                this.voiceDiag('turn-credentials-failed', { error: error?.message || String(error) }, 'WARN');
                return null;
            } finally {
                this._voiceTurnFetchInFlight = null;
            }
        })();
        this._voiceTurnFetchInFlight = pending;
        return pending;
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
