// --- ZaliInterface: Сессия и токен, недавние аккаунты, снапшот здоровья звонка. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    loadStoredSession(key = null) {
        try {
            const raw = localStorage.getItem(key || this.authStorageKey());
            if (!raw) {
                const injected = key ? null : this.loadInjectedSession();
                this.trace(`loadStoredSession key=${key || 'auth'} local=no injected=${!!injected}`);
                return this.normalizeSession(injected);
            }
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            const normalized = this.normalizeSession(parsed);
            const token = String(normalized?.token || '').trim();
            if (!token) {
                const injected = key ? null : this.loadInjectedSession();
                this.trace(`loadStoredSession key=${key || 'auth'} local=tokenless injected=${!!injected}`);
                return this.normalizeSession(injected) || null;
            }
            this.trace(`loadStoredSession key=${key || 'auth'} local=yes`);
            return normalized;
        } catch (e) {
            this.trace(`loadStoredSession key=${key || 'auth'} error`);
            if (!key) {
                return this.normalizeSession(this.loadInjectedSession());
            }
            return null;
        }
    }

    normalizeSession(session) {
        if (!session || typeof session !== 'object') return null;
        const username = String(session.username || session.user || '').trim();
        const token = String(
            session.token
            || session.authToken
            || session.accessToken
            || session.sessionToken
            || session.jwt
            || ''
        ).trim();
        if (!token) return null;
        return {
            username,
            token,
            guest: !!session.guest || false,
            tokenExpiresAt: Number(session.tokenExpiresAt || this.tokenExpiresAt(token) || 0),
        };
    }

    decodeJwtPayload(token) {
        try {
            const parts = String(token || '').split('.');
            if (parts.length < 2) return null;
            const normalized = parts[1].replace(/-/g, '+').replace(/_/g, '/');
            const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
            return JSON.parse(atob(padded));
        } catch (e) {
            return null;
        }
    }

    tokenExpiresAt(token) {
        const payload = this.decodeJwtPayload(token);
        const exp = Number(payload?.exp || 0);
        return exp > 0 ? exp * 1000 : 0;
    }

    isTokenExpired(token, skewMs = 30000) {
        const expiresAt = this.tokenExpiresAt(token);
        return expiresAt > 0 && expiresAt <= Date.now() + skewMs;
    }

    loadInjectedSession() {
        try {
            const raw = window.__ZALI_SAVED_SESSION;
            if (!raw || typeof raw !== 'object') return null;
            if (raw.token && this.isTokenExpired(raw.token)) return null;
            return this.normalizeSession(raw);
        } catch (e) {
            return null;
        }
    }

    formatDuration(ms) {
        const total = Math.max(0, Math.floor(Number(ms || 0) / 1000));
        const hours = Math.floor(total / 3600);
        const minutes = Math.floor((total % 3600) / 60);
        const seconds = total % 60;
        const pad = (v) => String(v).padStart(2, '0');
        return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
    }

    formatBytes(bytes) {
        const value = Math.max(0, Number(bytes || 0));
        if (!value) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let idx = 0;
        let current = value;
        while (current >= 1024 && idx < units.length - 1) {
            current /= 1024;
            idx += 1;
        }
        const digits = current >= 100 || idx === 0 ? 0 : current >= 10 ? 1 : 2;
        return `${current.toFixed(digits)} ${units[idx]}`;
    }

    describeIceCandidate(candidateLine) {
        const parts = String(candidateLine || '').trim().split(/\s+/);
        const typIndex = parts.indexOf('typ');
        return {
            protocol: String(parts[2] || '').toLowerCase(),
            address: parts[4] && parts[5] ? `${parts[4]}:${parts[5]}` : '',
            type: typIndex >= 0 ? String(parts[typIndex + 1] || '') : '',
        };
    }

    getVoicePrimaryPeerName() {
        const peers = Array.from(this.voice.peerConnections.keys()).map(name => String(name || '').trim()).filter(Boolean);
        const me = String(this.myName() || '').trim();
        const preferred = String(this.voice.targetUser || this.voice.inviter || '').trim();
        if (preferred && peers.includes(preferred)) return preferred;
        if (this.voice.roomType === 'dm') {
            const nonMe = peers.find(name => name !== me);
            if (nonMe) return nonMe;
        }
        return peers[0] || preferred || '';
    }

    getVoiceHealthSnapshot() {
        const peer = this.getVoicePrimaryPeerName();
        const entry = peer ? this.voice.peerConnections.get(peer) : null;
        const stats = entry?.lastStats || {};
        const audio = peer ? this.voice.remoteAudios.get(peer) : null;
        const remoteStream = audio?.srcObject instanceof MediaStream ? audio.srcObject : null;
        const localStream = this.voice.localStream;
        const connectionState = String(entry?.pc?.connectionState || 'idle').trim() || 'idle';
        const iceState = String(entry?.pc?.iceConnectionState || 'idle').trim() || 'idle';
        const signalingState = String(entry?.pc?.signalingState || 'idle').trim() || 'idle';
        const hasOut = Number(stats.outBytes || 0) > 0 || Number(stats.outPackets || 0) > 0;
        const hasIn = Number(stats.inBytes || 0) > 0 || Number(stats.inPackets || 0) > 0;
        const candidatePair = stats.candidatePair || null;
        const localCandidates = Number(stats.localCandidateCount || entry?.generatedIceCandidates || 0);
        const remoteCandidates = Number(stats.remoteCandidateCount || entry?.receivedIceCandidates || 0);
        const remoteTrackCount = remoteStream ? remoteStream.getAudioTracks().length : 0;
        const routeValue = audio
            ? (audio.muted ? 'audio muted' : audio.paused ? 'audio paused' : 'audio ready')
            : remoteTrackCount
                ? 'stream only'
                : 'нет трека';
        const playbackValue = audio
            ? (audio.paused ? 'paused' : audio.readyState >= 2 ? 'playing' : 'waiting')
            : 'none';
        const micValue = localStream
            ? `${localStream.getAudioTracks().length} track${localStream.getAudioTracks().length === 1 ? '' : 's'}`
            : 'нет микрофона';

        const toneByState = (state, activeTone = 'good') => {
            const s = String(state || '').toLowerCase();
            if (['connected', 'completed', 'playing', 'ready', 'live'].includes(s)) return 'good';
            if (['connecting', 'checking', 'new', 'waiting', 'idle'].includes(s)) return 'warn';
            if (['disconnected', 'failed', 'closed', 'paused'].includes(s)) return 'bad';
            return activeTone;
        };

        return [
            {
                label: 'ICE',
                value: iceState,
                sub: connectionState === 'connected' ? 'канал поднят' : 'ожидаем согласование',
                tone: toneByState(iceState),
            },
            {
                label: 'RTP out',
                value: hasOut ? `${this.formatBytes(stats.outBytes || 0)} · ${stats.outPackets || 0} pkts` : '0 B',
                sub: hasOut ? 'уходит в сеть' : 'пока тишина',
                tone: hasOut ? 'good' : toneByState(connectionState, 'warn'),
            },
            {
                label: 'RTP in',
                value: hasIn ? `${this.formatBytes(stats.inBytes || 0)} · ${stats.inPackets || 0} pkts` : '0 B',
                sub: hasIn ? 'приходит с удалённой стороны' : 'не получаем RTP',
                tone: hasIn ? 'good' : 'bad',
            },
            {
                label: 'Candidate pair',
                value: candidatePair ? `${candidatePair.localLabel || candidatePair.local || 'local'} → ${candidatePair.remoteLabel || candidatePair.remote || 'remote'}` : 'не выбран',
                sub: candidatePair ? `rtt ${candidatePair.currentRoundTripTime ?? 'n/a'} · ${this.formatBytes(candidatePair.bytesSent || 0)} / ${this.formatBytes(candidatePair.bytesReceived || 0)}` : `local ${localCandidates} / remote ${remoteCandidates}`,
                tone: candidatePair ? 'good' : 'warn',
            },
            {
                label: 'Audio route',
                value: routeValue,
                sub: remoteTrackCount ? `tracks: ${remoteTrackCount}` : 'ждём remote-track',
                tone: remoteTrackCount ? 'good' : 'warn',
            },
            {
                label: 'Playback',
                value: playbackValue,
                sub: micValue,
                tone: audio ? (audio.paused ? 'warn' : 'good') : 'idle',
            },
        ];
    }

    saveStoredSession(session) {
        try {
            localStorage.setItem(this.authStorageKey(), JSON.stringify(session));
            localStorage.setItem(this.lastAuthStorageKey(), JSON.stringify(session));
            this.rememberRecentAccount(session);
            this.saveInjectedSession(session);
        } catch (e) {
            // ignore storage failures
        }
    }

    loadRecentAccounts() {
        try {
            const raw = localStorage.getItem(this.recentAccountsStorageKey());
            const parsed = raw ? JSON.parse(raw) : [];
            if (!Array.isArray(parsed)) return [];
            const seenUsers = new Set();
            const seenTokens = new Set();
            return parsed
                .map(item => ({
                    ...this.normalizeSession(item),
                    lastUsedAt: Number(item?.lastUsedAt || 0),
                }))
                .filter(item => item?.token && !item.guest && !this.isTokenExpired(item.token))
                .sort((a, b) => Number(b.lastUsedAt || 0) - Number(a.lastUsedAt || 0))
                .filter(item => {
                    const userKey = String(item.username || '').trim().toLowerCase();
                    const tokenKey = String(item.token || '').trim();
                    if (!userKey || !tokenKey || seenUsers.has(userKey) || seenTokens.has(tokenKey)) return false;
                    seenUsers.add(userKey);
                    seenTokens.add(tokenKey);
                    return true;
                })
                .slice(0, 6);
        } catch (e) {
            return [];
        }
    }

    saveRecentAccounts(accounts) {
        try {
            const seenUsers = new Set();
            const seenTokens = new Set();
            const normalized = [];
            for (const account of Array.isArray(accounts) ? accounts : []) {
                const session = this.normalizeSession(account);
                if (!session?.token || session.guest) continue;
                if (this.isTokenExpired(session.token)) continue;
                const key = String(session.username || '').trim().toLowerCase();
                const tokenKey = String(session.token || '').trim();
                if (!key || !tokenKey || seenUsers.has(key) || seenTokens.has(tokenKey)) continue;
                seenUsers.add(key);
                seenTokens.add(tokenKey);
                normalized.push({
                    username: session.username,
                    token: session.token,
                    guest: false,
                    lastUsedAt: Number(account?.lastUsedAt || Date.now()),
                    tokenExpiresAt: Number(session.tokenExpiresAt || this.tokenExpiresAt(session.token) || 0),
                });
                if (normalized.length >= 6) break;
            }
            localStorage.setItem(this.recentAccountsStorageKey(), JSON.stringify(normalized));
        } catch (e) {
            // ignore storage failures
        }
    }

    rememberRecentAccount(session) {
        const normalized = this.normalizeSession(session);
        if (!normalized?.token || normalized.guest) return;
        const key = String(normalized.username || '').trim().toLowerCase();
        if (!key) return;
        const rest = this.loadRecentAccounts()
            .filter(item => String(item.username || '').trim().toLowerCase() !== key);
        this.saveRecentAccounts([
            {
                username: normalized.username,
                token: normalized.token,
                guest: false,
                lastUsedAt: Date.now(),
                tokenExpiresAt: Number(normalized.tokenExpiresAt || this.tokenExpiresAt(normalized.token) || 0),
            },
            ...rest,
        ]);
        this.renderRecentAccounts();
    }

    forgetRecentAccount(username) {
        const key = String(username || '').trim().toLowerCase();
        if (!key) return;
        const next = this.loadRecentAccounts()
            .filter(item => String(item.username || '').trim().toLowerCase() !== key);
        this.saveRecentAccounts(next);
        this.renderRecentAccounts();
    }

    forgetRecentAccountEntry(username, token = '') {
        const userKey = String(username || '').trim().toLowerCase();
        const tokenKey = String(token || '').trim();
        if (!userKey && !tokenKey) return;
        const next = this.loadRecentAccounts()
            .filter(item => {
                const itemUser = String(item.username || '').trim().toLowerCase();
                const itemToken = String(item.token || '').trim();
                return (!userKey || itemUser !== userKey) && (!tokenKey || itemToken !== tokenKey);
            });
        this.saveRecentAccounts(next);
        this.renderRecentAccounts();
    }

    async verifyRecentAccountSession(session) {
        try {
            const token = String(session?.token || '').trim();
            if (!token) return { ok: false, invalidate: true };
            const res = await this.apiFetch(this.apiRoutes.auth.me, {
                timeoutMs: SESSION_RESTORE_TIMEOUT_MS,
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!res.ok) {
                const status = Number(res.status || 0);
                return {
                    ok: false,
                    invalidate: status === 401 || status === 403,
                };
            }
            const data = await res.json();
            return {
                ok: true,
                invalidate: false,
                username: String(data?.username || session?.username || '').trim(),
                token,
                cloudVaultSyncEnabled: data?.cloudVaultSyncEnabled,
            };
        } catch (e) {
            return { ok: false, invalidate: false };
        }
    }

    formatRecentAccountTime(ts) {
        const value = Number(ts || 0);
        if (!value) return 'недавний вход';
        try {
            return `вход ${new Date(value).toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: 'short',
                hour: '2-digit',
                minute: '2-digit',
            })}`;
        } catch (e) {
            return 'недавний вход';
        }
    }

    renderRecentAccounts() {
        const box = document.getElementById('recentAccounts');
        if (!box) return;
        const accounts = this.loadRecentAccounts();
        if (!accounts.length) {
            box.innerHTML = '<div class="recent-accounts-empty">После входа аккаунты появятся здесь для быстрого переключения на этом Mac.</div>';
            return;
        }
        const current = String(this.S.session?.username || '').trim().toLowerCase();
        const rows = accounts.map(account => {
            const username = String(account.username || '').trim();
            const active = username.toLowerCase() === current && !!this.S.session?.token;
            return `
                <div class="recent-account-row ${active ? 'is-active' : ''}">
                    <div class="recent-account-main">
                        <div class="recent-account-name">${this.esc(username)}</div>
                        <div class="recent-account-meta">${active ? 'текущий аккаунт' : this.esc(this.formatRecentAccountTime(account.lastUsedAt))}</div>
                    </div>
                    <div class="recent-account-actions">
                        <button class="btn-flat recent-account-switch" type="button" data-switch-account="${this.esc(username)}" ${active ? 'disabled' : ''}>${active ? 'Активен' : 'Войти'}</button>
                        <button class="btn-flat recent-account-remove" type="button" data-remove-recent-account="${this.esc(username)}" title="Убрать из быстрых аккаунтов">×</button>
                    </div>
                </div>
            `;
        }).join('');
        box.innerHTML = `<div class="recent-accounts-title">Недавние аккаунты</div>${rows}`;
    }

    async switchRecentAccount(username) {
        const key = String(username || '').trim().toLowerCase();
        if (!key) return;
        const account = this.loadRecentAccounts()
            .find(item => String(item.username || '').trim().toLowerCase() === key);
        if (!account?.token) {
            this.forgetRecentAccount(username);
            return;
        }
        if (this.isTokenExpired(account.token)) {
            this.forgetRecentAccountEntry(account.username, account.token);
            const expiredMsg = `Сохранённый вход ${account.username} истёк. Войдите заново.`;
            this.addLogEntry({ type: 'WARN', msg: expiredMsg, ts: new Date().toLocaleTimeString() });
            this.S.auth.error = expiredMsg;
            this.updateAuthView();
            return;
        }

        this.addLogEntry({ type: 'INFO', msg: `Входим как ${account.username}...`, ts: new Date().toLocaleTimeString() });
        // Токен проверен локально — применяем сессию напрямую без HTTP round-trip.
        // Если токен окажется невалидным на сервере, первый же API-запрос вернёт 401
        // и handleUnauthorizedApiResponse инвалидирует сессию.
        this.applySession({
            username: account.username,
            token: account.token,
            guest: false,
        }, { persist: true, syncNative: true });

        // Account switch must run the same post-auth setup as a normal login:
        // register the device, pull incoming key envelopes (so this account adopts
        // the peer's conversation key) and re-publish our own. Without this the
        // switched-in account cannot decrypt the peer's messages — they show up as
        // "🔒 зашифровано другим ключом".
        this.startPostAuthSetup({ reason: 'switchAccount', restoreStoredUnlockSecret: true });

        // Show the chat immediately. Previously the switch awaited loadContacts +
        // loadUsers + loadServers + key sync sequentially (4 round-trips) before
        // opening the chat, which caused a ~15s delay. None of the sidebar data is
        // needed to render the active conversation.
        this.openChatView();
        this.addLogEntry({ type: 'SUCCESS', msg: `Аккаунт переключён: ${this.myName()}`, ts: new Date().toLocaleTimeString() });

        // refreshAfterKey pulls incoming key envelopes, resolves the conversation key
        // and reloads the active chat history — this is the only thing needed to show
        // the peer's messages, so it runs on its own (non-blocking) path.
        void this.timeStage('switch→чат готов (refreshAfterKey)', () => this.refreshAfterKey());

        // Sidebar data fills in afterwards in the background.
        void Promise.allSettled([
            this.loadContacts(),
            this.loadUsers(),
            this.loadServers({ silent: true }),
        ]).then(() => this.renderRecentAccounts());
    }

    saveInjectedSession(session) {
        try {
            window.__ZALI_SAVED_SESSION = session && typeof session === 'object' ? session : null;
        } catch (e) {}
    }

    clearStoredSession() {
        try {
            localStorage.removeItem(this.authStorageKey());
            this.saveInjectedSession(null);
        } catch (e) {
            // ignore storage failures
        }
    }
});
