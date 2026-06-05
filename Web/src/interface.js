class ZaliInterface {
    constructor() {
        this.name = 'zali_interface';
        
        // Private state strictly encapsulated inside the interface module
        this.S = {
            chats:   {},        // { username: [messages] }
            users:   [],
            contacts: [],
            current: null,
            unread:  {},
            wsOn:    false,
            loading: true,
            searchQ: '',
            navMode: 'dm',
            activeServer: null,
            activeChannel: null,
            servers: [],
            publicServers: [],
            serverChats: {},
            draftAttachments: [],
            serverModal: {
                mode: 'create',
                serverId: null,
                activeSection: 'overview',
                colorPickers: {},
                roleCreateOpen: false,
                channelCreateOpen: false,
                members: [],
                roles: [],
                channels: [],
                draftRoles: [],
                joinLink: '',
                selectedChannelId: null,
                channelPermissions: [],
                loading: false,
                saving: false,
                error: '',
            },
            session: {
                username: 'Zalikus',
                token: null,
                guest: true,
            },
            auth: {
                visible: true,
                loading: false,
                error: '',
                mode: 'login',
                fieldsCleared: false,
            },
        };
        this.tenorCache = new Map();
        this.tenorPending = new Set();
        this.nativeAuthRequests = new Map();
        this.nativeRequests = new Map();
        this.avatarCache = new Map();
        this.avatarRequests = new Map();
        this.avatarFetchSeq = new Map();
        this.serverAssetCache = new Map();
        this.serverAssetRequests = new Map();
        this.serverAssetFetchSeq = new Map();
        this.colorWheelBindings = new Set();
        this.messageAnimSeen = new Set();
        this.mediaSizeCache = new Map();
        this.storageWarningSeen = new Set();
        this.reactionOptions = ['👍', '❤️', '😂', '😮', '😢', '🔥'];
        this.voice = {
            supported: !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
            roomId: '',
            roomType: '',
            serverId: '',
            channelId: '',
            targetUser: '',
            inviter: '',
            status: 'idle',
            muted: false,
            localStream: null,
            peerConnections: new Map(),
            remoteAudios: new Map(),
            participants: [],
            outgoingInvite: null,
            incomingInvite: null,
            socket: null,
            socketReady: false,
            callTrack: null,
            audioContext: null,
            playbackUnlocked: false,
            meterRaf: 0,
            meterLocal: null,
            meterRemote: new Map(),
            remotePlaybackNodes: new Map(),
            meterLevels: {
                local: 0,
                remote: 0,
            },
            traceLines: [],
        };
        this.voiceSocketGeneration = 0;
        this.voiceSocketReconnectTimer = null;
        this.voiceSocketReconnectDelayMs = 1000;
        this.pendingMessagesScroll = null;
        this.pendingOutboxFlushTimer = null;
        this.messageSyncTimer = null;
        this.energyMaintenanceBound = false;
        this.conversationSyncAt = new Map();
        this.conversationRefreshTimers = new Map();
        this.historyLoadSeq = 0;
        this.serverHistoryLoadSeq = new Map();
        this.messageWindow = {
            conversationKey: '',
            start: 0,
            end: 0,
            avgHeight: 92,
        };
        this.messageScrollRaf = 0;
        this.messageRenderRaf = 0;
        this.sessionBootstrapInProgress = false;

        const cachedMessages = this.loadStoredMessageCache();
        this.S.chats = cachedMessages.chats || {};
        this.S.serverChats = cachedMessages.serverChats || {};
    }

    init(loader) {
        this.bus = loader.bus;
        try {
            window.__ZALI_INTERFACE = this;
        } catch (e) {}
        this.S.navMode = this.loadStoredNavMode();

        // Register UI update commands on the bus
        this.bus.registerCommand('zali_interface', 'receive_message', (data) => this.receiveMessage(data));
        this.bus.registerCommand('zali_interface', 'set_users', (users) => this.setUsers(users));
        this.bus.registerCommand('zali_interface', 'set_contacts', (contacts) => this.setContacts(contacts));
        this.bus.registerCommand('zali_interface', 'set_session', (session) => this.setSession(session));
        this.bus.registerCommand('zali_interface', 'load_history', (messages) => this.loadHistory(messages));
        this.bus.registerCommand('zali_interface', 'load_server_history', (payload) => this.loadServerHistory(payload));
        this.bus.registerCommand('zali_interface', 'refresh_after_key', () => this.refreshAfterKey());
        this.bus.registerCommand('zali_interface', 'sync_active_conversation', (payload) => this.syncConversationFromNative(payload));
        this.bus.registerCommand('zali_interface', 'set_loading', (on) => this.setLoading(on));
        this.bus.registerCommand('zali_interface', 'set_connection_status', (connected) => this.setConnectionStatus(connected));
        this.bus.registerCommand('zali_interface', 'on_send_success', (clientId) => this.onSendSuccess(clientId));
        this.bus.registerCommand('zali_interface', 'on_send_error', (clientId) => this.onSendError(clientId));
        this.bus.registerCommand('zali_interface', 'reaction_updated', (data) => this.onReactionUpdated(data));
        this.bus.registerCommand('zali_interface', 'avatar_updated', (data) => this.handleAvatarUpdated(data));
        this.bus.registerCommand('zali_interface', 'tenor_resolved', (payload) => this.onTenorResolved(payload));
        this.bus.registerCommand('zali_interface', 'auth_response', (payload) => this.onNativeAuthResponse(payload));
        this.bus.registerCommand('zali_interface', 'native_response', (payload) => this.onNativeResponse(payload));
        this.bus.registerCommand('zali_interface', 'add_log_entry', (data) => this.addLogEntry(data));
        this.bus.registerCommand('zali_interface', 'voice_event', (payload) => this.handleVoiceEvent(payload));

        // Bind events after DOM is loaded
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.bindEvents());
        } else {
            this.bindEvents();
        }

        this.bootstrapSession();
        this.startEnergyAwareMaintenance();
    }

    // --- HTML Helper Utilities ---
    esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
    }

    fmtTime(iso) {
        if (!iso) return '';
        try { return new Date(iso).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}); }
        catch(e) { return ''; }
    }

    messageTimestampValue(iso) {
        const ts = Date.parse(iso || '');
        return Number.isFinite(ts) ? ts : 0;
    }

    messageHoverTimeLabel(msg) {
        const iso = msg?.timestamp || '';
        const time = this.fmtTime(iso);
        if (!time) return '';
        const date = this.fmtDate(iso);
        return date ? `${date}, ${time}` : time;
    }

    messageInlineTimeLabel(msg) {
        return this.fmtTime(msg?.timestamp || '');
    }

    conversationLastMessageAt(peer) {
        const msgs = Array.isArray(this.S.chats?.[peer]) ? this.S.chats[peer] : [];
        let lastTs = 0;
        for (const msg of msgs) {
            const ts = this.messageTimestampValue(msg?.timestamp);
            if (ts > lastTs) lastTs = ts;
        }
        return lastTs;
    }

    fmtDate(iso) {
        if (!iso) return '';
        try {
            const d = new Date(iso), now = new Date();
            const yest = new Date(); yest.setDate(yest.getDate()-1);
            if (d.toDateString() === now.toDateString())  return 'Сегодня';
            if (d.toDateString() === yest.toDateString()) return 'Вчера';
            return d.toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
        } catch(e) { return ''; }
    }

    nativeBridge() {
        return window.__ZALI_NATIVE || null;
    }

    hasNativeBridge() {
        return !!this.nativeBridge()?.available;
    }

    nativeSupports(capability) {
        return !!this.nativeBridge()?.supports?.[capability];
    }

    isWindowsNativeAuth() {
        const transport = this.nativeBridge()?.transport;
        return transport === 'ipc' || transport === 'webview2';
    }

    startEnergyAwareMaintenance() {
        if (!this.energyMaintenanceBound) {
            this.energyMaintenanceBound = true;
            const onVisibilityChange = () => {
                if (document.hidden) {
                    this.stopVoiceMeterLoop();
                    return;
                }
                this.refreshVisibleAvatars();
                this.syncActiveConversation({ force: true });
                if (this.voice.roomId || this.voice.localStream || this.voice.peerConnections.size > 0) {
                    this.ensureVoiceMeterLoop();
                }
            };
            document.addEventListener('visibilitychange', onVisibilityChange);
            window.addEventListener('focus', onVisibilityChange);
        }

        this.scheduleAvatarRefreshPolling();
        this.scheduleConversationSyncPolling();
    }

    scheduleAvatarRefreshPolling() {
        if (this.avatarRefreshTimer) {
            clearTimeout(this.avatarRefreshTimer);
            this.avatarRefreshTimer = null;
        }

        const delay = document.hidden ? 60 * 60 * 1000 : 15 * 60 * 1000;
        this.avatarRefreshTimer = setTimeout(() => {
            this.avatarRefreshTimer = null;
            if (!document.hidden) {
                this.refreshVisibleAvatars();
            }
            this.scheduleAvatarRefreshPolling();
        }, delay);
    }

    scheduleConversationSyncPolling() {
        if (this.messageSyncTimer) {
            clearTimeout(this.messageSyncTimer);
            this.messageSyncTimer = null;
        }

        const delay = document.hidden ? 30 * 60 * 1000 : 10 * 60 * 1000;
        this.messageSyncTimer = setTimeout(() => {
            this.messageSyncTimer = null;
            this.syncActiveConversation();
            this.scheduleConversationSyncPolling();
        }, delay);
    }

    postNativeMessage(payload) {
        const bridge = this.nativeBridge();
        if (!bridge || typeof bridge.postMessage !== 'function') return false;
        return !!bridge.postMessage(payload);
    }

    trace(message) {
        try {
            console.log(`[ZALI][WEB] ${message}`);
        } catch (e) {}
    }

    myName() {
        return this.S.session?.username || 'Zalikus';
    }

    requestMessagesScroll(position = 'bottom') {
        this.pendingMessagesScroll = position === 'top' ? 'top' : 'bottom';
    }

    resetMessageWindow() {
        this.messageWindow = {
            conversationKey: '',
            start: 0,
            end: 0,
            count: 0,
            useWindow: false,
            avgHeight: this.messageWindow?.avgHeight || 92,
        };
    }

    scheduleMessagesRender() {
        if (this.messageRenderRaf) return;
        this.messageRenderRaf = requestAnimationFrame(() => {
            this.messageRenderRaf = 0;
            this.renderMessages();
        });
    }

    onMessagesScroll() {
        const box = document.getElementById('msgs');
        if (!box) return;
        this.pendingMessagesScroll = null;
        if (this.messageScrollRaf) return;
        this.messageScrollRaf = requestAnimationFrame(() => {
            this.messageScrollRaf = 0;
            const msgs = this.getCurrentMessages();
            const conversationKey = this.S.navMode === 'servers'
                ? this.currentServerChatKey()
                : String(this.S.current || '').trim();
            const nextWindow = this.computeMessageWindow(msgs, box, {
                conversationChanged: conversationKey !== (this.messageWindow?.conversationKey || ''),
                stickToBottom: this.isMessagesNearBottom(box),
            });
            const current = this.messageWindow || {};
            if (
                current.conversationKey === conversationKey &&
                current.start === nextWindow.start &&
                current.end === nextWindow.end &&
                current.count === msgs.length &&
                (!!current.useWindow) === (!!nextWindow.useWindow)
            ) {
                return;
            }
            this.renderMessages();
        });
    }

    computeMessageWindow(msgs, box, { conversationChanged = false, stickToBottom = false } = {}) {
        const total = Array.isArray(msgs) ? msgs.length : 0;
        const baseAvg = Math.max(56, Math.min(160, Number(this.messageWindow?.avgHeight || 92)));
        if (total <= 180 || !box) {
            return {
                useWindow: false,
                start: 0,
                end: total,
                topSpacer: 0,
                bottomSpacer: 0,
                avgHeight: baseAvg,
            };
        }

        const viewportCount = Math.max(18, Math.ceil(Math.max(1, box.clientHeight) / baseAvg) + 8);
        const overscan = Math.max(30, Math.floor(viewportCount * 0.7));
        const windowSize = Math.min(total, viewportCount + overscan * 2);
        const nearTop = box.scrollTop <= baseAvg * 4;
        const nearBottom = this.isMessagesNearBottom(box, baseAvg * 2);

        let start = Math.max(0, Math.floor(box.scrollTop / baseAvg) - overscan);
        let end = Math.min(total, start + windowSize);

        if (conversationChanged || stickToBottom || nearBottom) {
            start = Math.max(0, total - windowSize);
            end = total;
        } else if (nearTop) {
            start = 0;
            end = Math.min(total, windowSize);
        }

        if (end - start < windowSize) {
            if (start === 0) {
                end = Math.min(total, windowSize);
            } else if (end === total) {
                start = Math.max(0, total - windowSize);
            }
        }

        return {
            useWindow: true,
            start,
            end,
            topSpacer: start * baseAvg,
            bottomSpacer: Math.max(0, (total - end) * baseAvg),
            avgHeight: baseAvg,
        };
    }

    mobileLayoutQuery() {
        if (!this._mobileLayoutQuery && typeof window.matchMedia === 'function') {
            this._mobileLayoutQuery = window.matchMedia('(max-width: 760px)');
        }
        return this._mobileLayoutQuery || null;
    }

    isMobileLayout() {
        if (typeof window.matchMedia === 'function') {
            return window.matchMedia('(max-width: 760px)').matches;
        }
        return !!this.mobileLayoutQuery()?.matches;
    }

    setMobileSidebarOpen(open) {
        const isOpen = !!open;
        document.body?.classList.toggle('mobile-sidebar-open', isOpen);
        const btn = document.getElementById('mobileMenuBtn');
        if (btn) btn.setAttribute('aria-expanded', String(isOpen));
        const backdrop = document.getElementById('mobileBackdrop');
        if (backdrop) backdrop.hidden = !isOpen;
        return isOpen;
    }

    syncMobileChrome() {
        const isMobile = this.isMobileLayout();
        document.body?.classList.toggle('is-mobile-layout', isMobile);

        const dock = document.getElementById('mobileDock');
        if (dock) {
            dock.classList.toggle('visible', isMobile);
        }

        const settingsActive = !!document.getElementById('viewSettings')?.classList.contains('active');
        const chatsBtn = document.getElementById('mobileChatsBtn');
        const serversBtn = document.getElementById('mobileServersBtn');
        const settingsBtn = document.getElementById('mobileSettingsBtn');

        if (chatsBtn) chatsBtn.classList.toggle('active', !settingsActive && this.S.navMode !== 'servers');
        if (serversBtn) serversBtn.classList.toggle('active', !settingsActive && this.S.navMode === 'servers');
        if (settingsBtn) settingsBtn.classList.toggle('active', settingsActive);

        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        if (mobileMenuBtn) {
            mobileMenuBtn.classList.toggle('active', !!document.body?.classList.contains('mobile-sidebar-open'));
        }

        const backdrop = document.getElementById('mobileBackdrop');
        if (backdrop) backdrop.hidden = !(isMobile && document.body?.classList.contains('mobile-sidebar-open'));
    }

    closeMobileSidebar() {
        this.setMobileSidebarOpen(false);
    }

    openMobileSidebar() {
        this.setMobileSidebarOpen(true);
    }

    toggleMobileSidebar(force = null) {
        const next = force == null ? !document.body?.classList.contains('mobile-sidebar-open') : !!force;
        return this.setMobileSidebarOpen(next);
    }

    openChatView() {
        const cv = document.getElementById('viewChat');
        const sv = document.getElementById('viewSettings');
        if (sv) sv.classList.remove('active');
        if (cv) cv.classList.add('active');
        this.closeMobileSidebar();
        this.renderServerToolbar();
        this.syncMobileChrome();
    }

    openSettingsView() {
        const cv = document.getElementById('viewChat');
        const sv = document.getElementById('viewSettings');
        if (cv) cv.classList.remove('active');
        if (sv) sv.classList.add('active');
        const tbChat = document.getElementById('tbChat');
        if (tbChat) tbChat.textContent = 'Настройки';
        this.applyNetworkConfigToInputs();
        this.closeMobileSidebar();
        this.syncMobileChrome();
    }

    applyPendingMessagesScroll(box) {
        if (!box || !this.pendingMessagesScroll) return;
        const target = this.pendingMessagesScroll;
        this.pendingMessagesScroll = null;
        requestAnimationFrame(() => {
            if (!box.isConnected) return;
            box.scrollTop = target === 'bottom' ? box.scrollHeight : 0;
        });
    }

    captureMessageScrollAnchor(box) {
        if (!box) return null;
        const boxRect = box.getBoundingClientRect?.();
        if (!boxRect) return null;
        const nodes = Array.from(box.querySelectorAll('.msg[data-message-id]'));
        for (const node of nodes) {
            const messageId = String(node.dataset?.messageId || '').trim();
            if (!messageId) continue;
            const rect = node.getBoundingClientRect?.();
            if (!rect || rect.bottom < boxRect.top) continue;
            if (rect.top > boxRect.bottom) break;
            return {
                messageId,
                topOffset: rect.top - boxRect.top,
            };
        }
        return null;
    }

    restoreMessageScrollAnchor(box, anchor) {
        if (!box || !anchor?.messageId) return false;
        const nodes = Array.from(box.querySelectorAll('.msg[data-message-id]'));
        const node = nodes.find(item => String(item.dataset?.messageId || '').trim() === anchor.messageId);
        if (!node) return false;
        const boxRect = box.getBoundingClientRect?.();
        const rect = node.getBoundingClientRect?.();
        if (!boxRect || !rect) return false;
        box.scrollTop += (rect.top - boxRect.top) - Number(anchor.topOffset || 0);
        return true;
    }

    isMessagesNearBottom(box, threshold = 56) {
        if (!box) return true;
        return (box.scrollHeight - (box.scrollTop + box.clientHeight)) <= threshold;
    }

    navModeStorageKey() {
        return 'zali_nav_mode_v1';
    }

    activeServerStorageKey() {
        return 'zali_active_server_v1';
    }

    activeChannelStorageKey() {
        return 'zali_active_channel_v1';
    }

    currentContactStorageKey() {
        return 'zali_current_contact_v1';
    }

    serverChatsStorageKey() {
        return 'zali_server_chats_v1';
    }

    messageCacheStorageKey() {
        return 'zali_message_cache_v1';
    }

    networkConfigStorageKey() {
        return 'zali_network_config_v1';
    }

    cryptoKeyStorageKey() {
        return 'zali_crypto_key_v1';
    }

    authStorageKey() {
        return 'zali_session_v1';
    }

    lastAuthStorageKey() {
        return 'zali_last_session_v1';
    }

    pendingOutboxStorageKey() {
        return 'zali_pending_outbox_v1';
    }

    loadStoredMessageCache() {
        try {
            const raw = localStorage.getItem(this.messageCacheStorageKey());
            if (!raw) return this.loadInjectedMessageCache();
            const parsed = JSON.parse(raw);
            const chats = parsed && typeof parsed === 'object' && parsed.chats && typeof parsed.chats === 'object'
                ? parsed.chats
                : {};
            const serverChats = parsed && typeof parsed === 'object' && parsed.serverChats && typeof parsed.serverChats === 'object'
                ? parsed.serverChats
                : {};
            if (!Object.keys(chats).length && !Object.keys(serverChats).length) {
                return this.loadInjectedMessageCache();
            }
            return {
                chats: Object.fromEntries(Object.entries(chats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
                serverChats: Object.fromEntries(Object.entries(serverChats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
            };
        } catch (e) {
            return this.loadInjectedMessageCache();
        }
    }

    loadInjectedMessageCache() {
        try {
            const raw = window.__ZALI_MESSAGE_CACHE;
            if (!raw) return { chats: {}, serverChats: {} };
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            if (!parsed || typeof parsed !== 'object') return { chats: {}, serverChats: {} };
            const chats = parsed.chats && typeof parsed.chats === 'object' ? parsed.chats : {};
            const serverChats = parsed.serverChats && typeof parsed.serverChats === 'object' ? parsed.serverChats : {};
            return {
                chats: Object.fromEntries(Object.entries(chats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
                serverChats: Object.fromEntries(Object.entries(serverChats).filter(([, msgs]) => Array.isArray(msgs)).map(([peer, msgs]) => [peer, msgs.filter(msg => msg && typeof msg === 'object')])),
            };
        } catch (e) {
            return { chats: {}, serverChats: {} };
        }
    }

    saveStoredMessageCache() {
        const payload = {
            chats: this.S.chats,
            serverChats: this.S.serverChats,
        };
        const json = JSON.stringify(payload);
        try {
            localStorage.setItem(this.messageCacheStorageKey(), json);
        } catch (e) {
            this.trace(`saveStoredMessageCache localStorage failed reason=${e?.name || e?.message || e}`);
            this.warnStorageFallback('message_cache', `Не удалось сохранить кеш сообщений в localStorage: ${e?.name || e?.message || e}`);
        }
        this.saveInjectedMessageCache(json);
        if (this.nativeSupports('saveMessageCache')) {
            this.postNativeMessage({
                type: 'SAVE_MESSAGE_CACHE',
                cache: payload,
            });
        }
    }

    saveInjectedMessageCache(value) {
        try {
            window.__ZALI_MESSAGE_CACHE = typeof value === 'string' ? value : JSON.stringify(value || { chats: {}, serverChats: {} });
        } catch (e) {}
    }

    normalizeDmChatStore() {
        const me = String(this.myName() || '').trim();
        if (!me) return false;

        const normalized = {};
        let changed = false;

        const pushMessage = (peer, msg, originalKey) => {
            const nextPeer = String(peer || '').trim();
            if (!nextPeer) return;
            if (!normalized[nextPeer]) normalized[nextPeer] = [];
            normalized[nextPeer].push(msg);
            if (String(originalKey || '').trim() !== nextPeer) {
                changed = true;
            }
        };

        Object.entries(this.S.chats || {}).forEach(([key, msgs]) => {
            if (!Array.isArray(msgs)) return;
            msgs.forEach(msg => {
                if (!msg || typeof msg !== 'object') return;
                const sender = String(msg.sender || '').trim();
                const receiver = String(msg.receiver || '').trim();
                const canonicalPeer = sender === me
                    ? receiver
                    : (receiver === me ? sender : '');

                if (canonicalPeer) {
                    pushMessage(canonicalPeer, msg, key);
                } else {
                    pushMessage(String(key || '').trim(), msg, key);
                }
            });
        });

        Object.keys(normalized).forEach(peer => {
            normalized[peer].sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        });

        const before = JSON.stringify(this.S.chats || {});
        const after = JSON.stringify(normalized);
        if (before !== after) {
            this.S.chats = normalized;
            this.saveStoredMessageCache();
            this.trace(`normalizeDmChatStore changed peers=${Object.keys(normalized).length}`);
            return true;
        }

        this.S.chats = normalized;
        return changed;
    }

    loadStoredCurrentContact() {
        try {
            const raw = localStorage.getItem(this.currentContactStorageKey());
            const value = String(raw || '').trim();
            return value || null;
        } catch (e) {
            return null;
        }
    }

    saveStoredCurrentContact(name) {
        try {
            const value = String(name || '').trim();
            if (value) {
                localStorage.setItem(this.currentContactStorageKey(), value);
            } else {
                localStorage.removeItem(this.currentContactStorageKey());
            }
        } catch (e) {}
    }

    loadStoredCryptoKey() {
        try {
            const scope = String(this.activeConversationScope || window.__ZALI_ACTIVE_CONVERSATION_SCOPE || '').trim();
            if (scope) {
                const scoped = this.getStoredConversationKey(scope);
                if (scoped) return scoped;
            }
            const stored = (localStorage.getItem(this.cryptoKeyStorageKey()) || '').trim();
            const injected = (window.__ZALI_SAVED_KEY || '').trim();
            const key = stored || injected || '';
            this.trace(`loadStoredCryptoKey stored=${!!stored} injected=${!!injected} keySet=${!!key}`);
            if (stored) return stored;
            if (injected) return injected;
            return '';
        } catch (e) {
            this.trace('loadStoredCryptoKey error fallback empty');
            return (window.__ZALI_SAVED_KEY || '').trim() || '';
        }
    }

    conversationKeysStorageKey() {
        return 'zali_conversation_keys_v1';
    }

    conversationScopeKey(peer = null, serverId = null, channelId = null) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        if (sid && cid) {
            return `server:${sid}:${cid}`;
        }
        const me = String(this.myName() || '').trim();
        const other = String(peer || this.S.current || '').trim();
        if (!me || !other) return '';
        return `dm:${[me, other].sort().join(':')}`;
    }

    loadStoredConversationKeys() {
        try {
            const raw = localStorage.getItem(this.conversationKeysStorageKey());
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    getStoredConversationKey(scope) {
        const key = String(scope || '').trim();
        if (!key) return '';
        const stored = this.loadStoredConversationKeys();
        return String(stored[key] || '').trim();
    }

    saveStoredConversationKeys(keys) {
        try {
            localStorage.setItem(this.conversationKeysStorageKey(), JSON.stringify(keys || {}));
        } catch (e) {}
    }

    async resolveConversationCryptoKey({ peer = null, serverId = null, channelId = null, reason = 'auto' } = {}) {
        const scope = this.conversationScopeKey(peer, serverId, channelId);
        if (!scope) return '';
        this.activeConversationScope = scope;
        try {
            window.__ZALI_ACTIVE_CONVERSATION_SCOPE = scope;
        } catch (e) {}

        const existing = this.getStoredConversationKey(scope);
        if (existing) {
            this.updateCryptoKeyDisplay({
                key: existing,
                peer,
                serverId,
                channelId,
            });
            return existing;
        }

        this.trace(`resolveConversationCryptoKey reason=${reason} scope=${scope}`);
        try {
            const res = await this.apiFetch('/api/conversation-key', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    peer: peer || null,
                    serverId: serverId || null,
                    channelId: channelId || null,
                }),
            });
            if (!res.ok) {
                throw new Error(await res.text());
            }
            const data = await res.json();
            const key = String(data?.key || '').trim();
            if (!key) throw new Error('Пустой ключ переписки');
            const stored = this.loadStoredConversationKeys();
            stored[scope] = key;
            this.saveStoredConversationKeys(stored);
            this.setKey(key);
            this.updateCryptoKeyDisplay({ key, peer, serverId, channelId });
            return key;
        } catch (e) {
            this.trace(`resolveConversationCryptoKey failed reason=${reason} scope=${scope} err=${e?.message || e}`);
            return '';
        }
    }

    ensureConversationCryptoKey({ peer = null, serverId = null, channelId = null, reason = 'auto' } = {}) {
        const scope = this.conversationScopeKey(peer, serverId, channelId);
        if (!scope) return '';
        const stored = this.getStoredConversationKey(scope);
        if (stored) {
            this.activeConversationScope = scope;
            try {
                window.__ZALI_ACTIVE_CONVERSATION_SCOPE = scope;
            } catch (e) {}
            this.updateCryptoKeyDisplay({
                key: stored,
                peer,
                serverId,
                channelId,
            });
            return stored;
        }

        this.trace(`ensureConversationCryptoKey reason=${reason} scope=${scope} missing`);
        void this.resolveConversationCryptoKey({ peer, serverId, channelId, reason });
        this.updateCryptoKeyDisplay({
            key: '',
            peer,
            serverId,
            channelId,
        });
        return '';
    }

    updateCryptoKeyDisplay({ key = null, peer = null, serverId = null, channelId = null } = {}) {
        const valueEl = document.getElementById('currentCryptoKeyValue');
        const metaEl = document.getElementById('currentCryptoKeyMeta');
        const currentKey = String(key || this.loadStoredCryptoKey() || '').trim() || 'не задан';
        if (valueEl) valueEl.textContent = currentKey;
        if (metaEl) {
            if (serverId && channelId) {
                metaEl.textContent = `Контекст: сервер ${serverId} / канал ${channelId}`;
            } else if (peer) {
                metaEl.textContent = `Контекст: диалог с ${peer}`;
            } else {
                metaEl.textContent = 'Контекст: общий ключ';
            }
        }
    }

    updateChatHeaderCryptoKey({ peer = null, serverId = null, channelId = null } = {}) {
        const chatHdrSub = document.getElementById('chatHdrSub');
        if (!chatHdrSub) return;
        const key = this.ensureConversationCryptoKey({ peer, serverId, channelId, reason: 'updateChatHeaderCryptoKey' });
        const desc = serverId && channelId
            ? `${String(serverId).trim()} / ${String(channelId).trim()}`
            : peer
                ? `Диалог с ${String(peer).trim()}`
                : 'Личное сообщение';
        chatHdrSub.innerHTML = `
            <span class="chat-hdr-desc">${this.esc(desc)}</span>
            <span class="chat-hdr-key">${this.esc(`Ключ: ${key}`)}</span>
        `;
    }

    saveStoredCryptoKey(key) {
        try {
            const value = (key || '').trim();
            this.trace(`saveStoredCryptoKey keySet=${!!value} length=${value.length}`);
            if (value) {
                localStorage.setItem(this.cryptoKeyStorageKey(), value);
            } else {
                localStorage.removeItem(this.cryptoKeyStorageKey());
            }
            try {
                window.__ZALI_SAVED_KEY = value;
            } catch (e) {}
            try {
                const scope = String(window.__ZALI_ACTIVE_CONVERSATION_SCOPE || this.activeConversationScope || '').trim();
                if (scope) {
                    const stored = this.loadStoredConversationKeys();
                    if (value) {
                        stored[scope] = value;
                    } else {
                        delete stored[scope];
                    }
                    this.saveStoredConversationKeys(stored);
                }
            } catch (e) {}
            if (this.nativeSupports('setKey')) {
                this.trace(`saveStoredCryptoKey native setKey keySet=${!!value}`);
                this.postNativeMessage({
                    type: 'SET_KEY',
                    key: value,
                });
            }
        } catch (e) {}
    }

    loadStoredSession(key = null) {
        try {
            const raw = localStorage.getItem(key || this.authStorageKey());
            if (!raw) {
                const injected = key ? null : this.loadInjectedSession();
                this.trace(`loadStoredSession key=${key || 'auth'} local=no injected=${!!injected}`);
                return injected;
            }
            const parsed = JSON.parse(raw);
            if (!parsed || typeof parsed !== 'object') return null;
            this.trace(`loadStoredSession key=${key || 'auth'} local=yes`);
            return parsed;
        } catch (e) {
            this.trace(`loadStoredSession key=${key || 'auth'} error`);
            if (!key) {
                return this.loadInjectedSession();
            }
            return null;
        }
    }

    loadInjectedSession() {
        try {
            const raw = window.__ZALI_SAVED_SESSION;
            if (!raw || typeof raw !== 'object') return null;
            return raw;
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
        const playbackNode = peer ? this.voice.remotePlaybackNodes?.get(peer) : null;
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
        const routeValue = playbackNode
            ? 'WebAudio'
            : audio
                ? (audio.paused ? 'audio paused' : 'audio ready')
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
            this.saveInjectedSession(session);
        } catch (e) {
            // ignore storage failures
        }
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

    loadPendingOutbox() {
        try {
            const raw = localStorage.getItem(this.pendingOutboxStorageKey());
            if (!raw) {
                const injected = this.loadInjectedPendingOutbox();
                this.trace(`loadPendingOutbox local=no injected=${injected.length}`);
                return injected;
            }
            const parsed = JSON.parse(raw);
            this.trace(`loadPendingOutbox local=yes count=${Array.isArray(parsed) ? parsed.length : 0}`);
            return Array.isArray(parsed) ? parsed.filter(item => item && typeof item === 'object') : this.loadInjectedPendingOutbox();
        } catch (e) {
            this.trace('loadPendingOutbox error fallback injected');
            return this.loadInjectedPendingOutbox();
        }
    }

    savePendingOutbox(items) {
        const next = Array.isArray(items) ? items : [];
        try {
            localStorage.setItem(this.pendingOutboxStorageKey(), JSON.stringify(next));
        } catch (e) {
            this.trace(`savePendingOutbox localStorage failed reason=${e?.name || e?.message || e}`);
            this.warnStorageFallback('pending_outbox', `Не удалось сохранить очередь отправки в localStorage: ${e?.name || e?.message || e}`);
        }
        this.trace(`savePendingOutbox count=${next.length}`);
        this.saveInjectedPendingOutbox(next);
        if (this.nativeSupports('sessionSync')) {
            this.trace(`savePendingOutbox native sync count=${next.length}`);
            this.postNativeMessage({
                type: 'SAVE_PENDING_OUTBOX',
                items: next,
            });
        }
    }

    pendingOutboxNextRetryDelay() {
        const now = Date.now();
        const currentUser = String(this.myName() || '').trim();
        const pending = this.loadPendingOutbox()
            .filter(item => !currentUser || String(item?.sender || '').trim() === currentUser);
        if (!pending.length) return null;
        let nextDelay = Infinity;
        for (const item of pending) {
            const retryAt = Number(item?.nextRetryAt || 0);
            if (!retryAt) {
                nextDelay = 0;
                break;
            }
            const delta = Math.max(0, retryAt - now);
            if (delta < nextDelay) nextDelay = delta;
        }
        return Number.isFinite(nextDelay) ? nextDelay : null;
    }

    loadInjectedPendingOutbox() {
        try {
            const raw = window.__ZALI_PENDING_OUTBOX;
            if (!Array.isArray(raw)) return [];
            return raw.filter(item => item && typeof item === 'object');
        } catch (e) {
            return [];
        }
    }

    saveInjectedPendingOutbox(items) {
        try {
            window.__ZALI_PENDING_OUTBOX = Array.isArray(items) ? items : [];
        } catch (e) {}
    }

    warnStorageFallback(scope, message) {
        const key = String(scope || 'storage').trim();
        if (!key || this.storageWarningSeen.has(key)) return;
        this.storageWarningSeen.add(key);
        if (typeof this.addLogEntry === 'function') {
            this.addLogEntry({
                type: 'WARN',
                msg: message,
                ts: new Date().toLocaleTimeString(),
            });
        }
    }

    pendingOutboxConversationKey(item) {
        const serverId = String(item?.serverId || '').trim();
        const channelId = String(item?.channelId || '').trim();
        const sender = String(item?.sender || '').trim();
        const receiver = String(item?.receiver || '').trim();
        return serverId && channelId
            ? `server:${serverId}:${channelId}:${sender}:${receiver}`
            : `dm:${sender}:${receiver}`;
    }

    messageConversationKey(msg) {
        const serverId = String(msg?.serverId || msg?.server_id || '').trim();
        const channelId = String(msg?.channelId || msg?.channel_id || '').trim();
        const sender = String(msg?.sender || '').trim();
        const receiver = String(msg?.receiver || '').trim();
        return serverId && channelId
            ? `server:${serverId}:${channelId}:${sender}:${receiver}`
            : `dm:${sender}:${receiver}`;
    }

    pendingOutboxContentKey(item) {
        const attachmentsKey = this.normalizeAttachments(item?.attachments).map(att => `${att.name}:${att.kind}:${att.size}:${att.mimeType}`).join('|');
        return [
            String(item?.text || ''),
            attachmentsKey,
        ].join('::');
    }

    messageContentKey(msg) {
        const attachmentsKey = this.normalizeAttachments(msg?.attachments).map(att => `${att.name}:${att.kind}:${att.size}:${att.mimeType}`).join('|');
        const call = msg?.kind === 'call' ? msg.call || {} : {};
        return [
            String(msg?.kind || ''),
            String(msg?.text || ''),
            String(call.roomId || ''),
            String(call.direction || ''),
            String(call.outcome || ''),
            String(call.peer || ''),
            String(call.durationMs || ''),
            attachmentsKey,
        ].join('::');
    }

    matchPendingOutboxItem(msg) {
        const contentKey = this.messageContentKey(msg);
        const conversationKey = this.messageConversationKey(msg);
        const sender = String(msg?.sender || '').trim();
        const receiver = String(msg?.receiver || '').trim();
        const serverId = String(msg?.serverId || msg?.server_id || '').trim();
        const channelId = String(msg?.channelId || msg?.channel_id || '').trim();
        const pending = this.loadPendingOutbox();
        return pending.find(item => {
            if (!item || typeof item !== 'object') return false;
            if (this.pendingOutboxConversationKey(item) !== conversationKey) return false;
            if (String(item.sender || '').trim() !== sender) return false;
            if (String(item.receiver || '').trim() !== receiver) return false;
            if (serverId && String(item.serverId || '').trim() !== serverId) return false;
            if (channelId && String(item.channelId || '').trim() !== channelId) return false;
            return this.pendingOutboxContentKey(item) === contentKey;
        }) || null;
    }

    enqueuePendingOutbox(message) {
        if (!message || typeof message !== 'object') return;
        const pending = this.loadPendingOutbox();
        const key = String(message.clientId || '').trim();
        if (!key) return;
        if (pending.some(item => String(item.clientId || '').trim() === key)) return;
        this.trace(`enqueuePendingOutbox clientId=${key} sender=${String(message.sender || '').trim()} receiver=${String(message.receiver || '').trim()} server=${String(message.serverId || '').trim()} channel=${String(message.channelId || '').trim()} textBytes=${String(message.text || '').length} attachments=${this.normalizeAttachments(message.attachments).length}`);
        pending.push({
            clientId: key,
            sender: String(message.sender || '').trim(),
            receiver: String(message.receiver || '').trim(),
            serverId: message.serverId ? String(message.serverId).trim() : '',
            channelId: message.channelId ? String(message.channelId).trim() : '',
            text: String(message.text || ''),
            key: String(message.key || ''),
            attachments: this.normalizeAttachments(message.attachments),
            timestamp: String(message.timestamp || new Date().toISOString()),
            attemptCount: 0,
            lastAttemptAt: 0,
            nextRetryAt: 0,
        });
        this.savePendingOutbox(pending);
    }

    dropPendingOutbox(clientId) {
        const pendingId = String(clientId || '').trim();
        if (!pendingId) return;
        this.trace(`dropPendingOutbox clientId=${pendingId}`);
        const pending = this.loadPendingOutbox().filter(item => String(item.clientId || '').trim() !== pendingId);
        this.savePendingOutbox(pending);
    }

    scheduleFlushPendingOutbox(delayMs = 150) {
        if (this.pendingOutboxFlushTimer) {
            clearTimeout(this.pendingOutboxFlushTimer);
        }
        this.pendingOutboxFlushTimer = setTimeout(() => {
            this.pendingOutboxFlushTimer = null;
            this.flushPendingOutbox();
        }, Math.max(0, Number(delayMs || 0)));
    }

    rehydratePendingOutbox() {
        const currentUser = String(this.myName() || '').trim();
        if (!currentUser) return;
        const pending = this.loadPendingOutbox().filter(item => String(item?.sender || '').trim() === currentUser);
        this.trace(`rehydratePendingOutbox currentUser=${currentUser} count=${pending.length} tokenSet=${!!this.S.session?.token} navMode=${this.S.navMode}`);
        let changed = false;

        for (const item of pending) {
            if (!item || typeof item !== 'object') continue;
            const clientId = String(item.clientId || '').trim();
            if (!clientId) continue;
            if (this.findMessageById(clientId)) continue;

            const serverId = String(item.serverId || '').trim();
            const channelId = String(item.channelId || '').trim();
            const isServers = !!(serverId && channelId);
            const conversationKey = isServers ? `${serverId}:${channelId}` : String(item.receiver || '').trim();
            const message = {
                id: clientId,
                sender: String(item.sender || currentUser).trim() || currentUser,
                receiver: String(item.receiver || '').trim(),
                text: String(item.text || ''),
                attachments: this.normalizeAttachments(item.attachments),
                timestamp: String(item.timestamp || new Date().toISOString()),
                status: 'sending',
                clientId,
                serverId: isServers ? serverId : null,
                channelId: isServers ? channelId : null,
            };

            if (isServers) {
                if (!this.S.serverChats[conversationKey]) this.S.serverChats[conversationKey] = [];
                this.S.serverChats[conversationKey].push(message);
            } else {
                this.ensureContact(message.receiver);
                this.initChat(message.receiver);
                this.S.chats[message.receiver].push(message);
            }
            changed = true;
        }

        if (changed) {
            if (this.S.navMode !== 'servers') {
                const currentKey = String(this.S.current || '').trim();
                const currentMsgs = currentKey ? (this.S.chats[currentKey] || []) : [];
                if (!currentKey || !currentMsgs.length) {
                    const preferredPeer = pending
                        .map(item => String(item?.receiver || '').trim())
                        .find(peer => peer && (this.S.chats[peer] || []).length > 0);
                    if (preferredPeer && preferredPeer !== this.S.current) {
                        this.switchChat(preferredPeer);
                    }
                }
            }
            this.renderMessages();
            this.renderContacts();
            this.renderServerInterface();
        }
    }

    isPendingMessageAlreadyLoaded(item) {
        const attachmentsKey = this.normalizeAttachments(item.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
        const text = String(item.text || '');
        const sender = String(item.sender || '');
        const receiver = String(item.receiver || '');
        const serverId = String(item.serverId || '').trim();
        const channelId = String(item.channelId || '').trim();

        if (serverId && channelId) {
            const key = `${serverId}:${channelId}`;
            const msgs = this.S.serverChats[key] || [];
            return msgs.some(msg => {
                const msgAttachments = this.normalizeAttachments(msg.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
                return String(msg.sender || '') === sender &&
                    String(msg.receiver || '') === receiver &&
                    String(msg.text || '') === text &&
                    msgAttachments === attachmentsKey;
            });
        }

        const peer = sender === this.myName() ? receiver : sender;
        const msgs = this.S.chats[peer] || [];
        return msgs.some(msg => {
            const msgAttachments = this.normalizeAttachments(msg.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
            return String(msg.sender || '') === sender &&
                String(msg.receiver || '') === receiver &&
                String(msg.text || '') === text &&
                msgAttachments === attachmentsKey;
        });
    }

    flushPendingOutbox() {
        if (!this.nativeSupports('sendMessage')) return;
        if (!this.S.session?.token) return;
        const currentUser = String(this.myName() || '').trim();
        const now = Date.now();
        const pending = this.loadPendingOutbox();
        if (!pending.length) return;
        this.trace(`flushPendingOutbox currentUser=${currentUser} count=${pending.length} tokenSet=${!!this.S.session?.token}`);
        let sentAny = false;

        for (const item of pending) {
            if (!item || typeof item !== 'object') continue;
            if (currentUser && String(item.sender || '').trim() !== currentUser) continue;
            if (Number(item.nextRetryAt || 0) > now) continue;

            const itemKey = this.pendingOutboxItemKey(item);
            if (!itemKey) {
                this.trace(`flushPendingOutbox missing key clientId=${String(item.clientId || '').trim()}`);
                item.nextRetryAt = now + 5000;
                this.savePendingOutbox(pending);
                continue;
            }

            if (this.isPendingMessageAlreadyLoaded(item)) {
                this.dropPendingOutbox(item.clientId);
                continue;
            }

            item.attemptCount = Number(item.attemptCount || 0) + 1;
            item.lastAttemptAt = now;
            item.nextRetryAt = now + Math.min(30000, Math.max(1500, 1000 * Math.min(item.attemptCount, 6)));
            this.savePendingOutbox(pending);
            sentAny = true;

            this.postNativeMessage({
                type: 'SEND_MESSAGE',
                text: item.text,
                recipient: item.serverId && item.channelId ? item.channelId : item.receiver,
                serverId: item.serverId || '',
                channelId: item.channelId || '',
                sender: item.sender || this.myName(),
                key: itemKey,
                keyVersion: Number(item.keyVersion || 2),
                clientId: item.clientId,
                attachments: this.normalizeAttachments(item.attachments).map(att => ({
                    name: att.name,
                    mimeType: att.mimeType,
                    kind: att.kind,
                    size: att.size,
                    dataUrl: att.dataUrl,
                })),
            });
            this.trace(`flushPendingOutbox send clientId=${String(item.clientId || '').trim()} receiver=${String(item.receiver || '').trim()} server=${String(item.serverId || '').trim()} channel=${String(item.channelId || '').trim()} attempt=${item.attemptCount}`);
        }

        const nextDelay = this.pendingOutboxNextRetryDelay();
        if (nextDelay !== null && this.loadPendingOutbox().some(item => String(item?.sender || '').trim() === currentUser)) {
            this.scheduleFlushPendingOutbox(Math.max(150, sentAny ? Math.min(3000, nextDelay) : nextDelay));
        }
    }

    pendingOutboxItemKey(item) {
        const stored = String(item?.key || '').trim();
        if (stored) return stored;
        const serverId = String(item?.serverId || '').trim();
        const channelId = String(item?.channelId || '').trim();
        const receiver = String(item?.receiver || item?.recipient || '').trim();
        try {
            if (serverId && channelId) {
                return this.ensureConversationCryptoKey({ serverId, channelId, reason: 'pendingOutboxItemKey' });
            }
            if (receiver) {
                return this.ensureConversationCryptoKey({ peer: receiver, reason: 'pendingOutboxItemKey' });
            }
            return this._getKey();
        } catch (e) {
            return '';
        }
    }

    clearLastStoredSession() {
        try {
            localStorage.removeItem(this.lastAuthStorageKey());
        } catch (e) {
            // ignore storage failures
        }
    }

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
                type: 'NETWORK_CONFIG',
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

    getDefaultServers() {
        return [
            this.ensureServerChannels({ id: 'zali-hub', name: 'Zali Hub', icon: 'Z', color: 'linear-gradient(180deg, #cbff00, #96b800)', unread: 4, hint: 'Общий хаб' }),
            this.ensureServerChannels({ id: 'dev-team', name: 'Dev Team', icon: '⚙', color: 'linear-gradient(180deg, #8c7bff, #5c4de8)', unread: 12, hint: 'Разработка' }),
            this.ensureServerChannels({ id: 'friends', name: 'Friends', icon: '🙂', color: 'linear-gradient(180deg, #ff7a59, #ff4d6d)', unread: 0, hint: 'Круг общения' }),
            this.ensureServerChannels({ id: 'music', name: 'Music', icon: '🎵', color: 'linear-gradient(180deg, #00d2ff, #0077ff)', unread: 2, hint: 'Плейлисты' }),
            this.ensureServerChannels({ id: 'games', name: 'Games', icon: '🎮', color: 'linear-gradient(180deg, #1ee28a, #0a9d5b)', unread: 0, hint: 'Игровой чат' }),
            this.ensureServerChannels({ id: 'study', name: 'Study', icon: '📚', color: 'linear-gradient(180deg, #ffcf5a, #ff8f3a)', unread: 1, hint: 'Учеба' }),
        ];
    }

    defaultServerChannels(serverId) {
        const sid = String(serverId || '').trim();
        return [
            { id: `${sid}-general`, name: 'general', topic: 'Общий чат', kind: 'text', position: 0 },
            { id: `${sid}-voice`, name: 'voice', topic: 'Голосовой канал', kind: 'voice', position: 1 },
        ];
    }

    ensureServerChannels(server = {}) {
        const next = { ...server };
        const channels = Array.isArray(next.channels) ? next.channels.filter(Boolean).map(channel => ({ ...channel })) : [];
        if (!channels.length && next.id) {
            next.channels = this.defaultServerChannels(next.id);
            return next;
        }
        next.channels = channels.map((channel, index) => ({
            ...channel,
            kind: String(channel.kind || 'text').trim().toLowerCase() || 'text',
            position: Number.isFinite(Number(channel.position)) ? Number(channel.position) : index,
        })).sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
        return next;
    }

    ensureServersState() {
        if (!Array.isArray(this.S.servers) || this.S.servers.length === 0) {
            this.S.servers = this.getDefaultServers();
        } else {
            this.S.servers = this.S.servers.map(server => this.ensureServerChannels(server));
        }
        const stored = this.loadStoredActiveServer();
        if (stored && this.S.servers.some(s => s.id === stored)) {
            this.S.activeServer = stored;
        } else if (!this.S.activeServer || !this.S.servers.some(s => s.id === this.S.activeServer)) {
            this.S.activeServer = this.S.servers[0]?.id || null;
        }
    }

    updateSidebarModeLabel() {
        const label = document.querySelector('.nav-label');
        if (label) {
            label.textContent = this.S.navMode === 'servers' ? 'Сервера' : 'Диалоги';
        }
    }

    updateNavModeButtons() {
        const dmBtn = document.getElementById('modeDmBtn');
        const serversBtn = document.getElementById('modeServersBtn');
        const isServers = this.S.navMode === 'servers';
        if (dmBtn) {
            dmBtn.classList.toggle('active', !isServers);
            dmBtn.setAttribute('aria-pressed', String(!isServers));
        }
        if (serversBtn) {
            serversBtn.classList.toggle('active', isServers);
            serversBtn.setAttribute('aria-pressed', String(isServers));
        }
        document.body?.setAttribute('data-nav-mode', this.S.navMode);
        const viewChat = document.getElementById('viewChat');
        if (viewChat) viewChat.classList.toggle('server-mode', isServers);
        this.updateSidebarModeLabel();
    }

    normalizeServers(servers) {
        return Array.isArray(servers) ? servers.map(server => ({
            ...server,
            channels: Array.isArray(server.channels) && server.channels.length ? server.channels.map(channel => ({ ...channel })) : [],
            myRole: server.myRole || server.my_role || null,
            memberCount: Number(server.memberCount || server.member_count || 0) || 0,
            joinLink: server.joinLink || server.join_link || '',
        })).map(server => this.ensureServerChannels(server)).filter(Boolean) : [];
    }

    normalizeMemberRole(role) {
        const value = String(role || '').trim().toLowerCase();
        if (value === 'owner') return 'owner';
        if (value === 'admin') return 'admin';
        return 'member';
    }

    roleLabel(role) {
        switch (this.normalizeMemberRole(role)) {
            case 'owner': return 'Владелец';
            case 'admin': return 'Админ';
            default: return 'Участник';
        }
    }

    serverRoleLabel(roleId) {
        const role = String(roleId || '').trim();
        if (!role) return 'Участник';
        if (role === 'owner') return 'Владелец';
        if (role === 'admin') return 'Админ';
        if (role === 'member') return 'Участник';
        const found = (this.S.serverModal.roles || []).find(item => String(item.roleId || '') === role);
        return found?.name || role;
    }

    serverRoleList() {
        return Array.isArray(this.S.serverModal.roles) ? this.S.serverModal.roles : [];
    }

    draftServerRoleList() {
        return Array.isArray(this.S.serverModal.draftRoles) ? this.S.serverModal.draftRoles : [];
    }

    serverRolePermissionDefs() {
        return [
            { key: 'can_view', label: 'Чтение каналов', hint: 'Видеть список и историю сообщений', group: 'Доступ', defaultCreate: true },
            { key: 'can_send', label: 'Отправка сообщений', hint: 'Писать в текстовые каналы', group: 'Доступ', defaultCreate: true },
            { key: 'can_react', label: 'Реакции', hint: 'Ставить реакции на сообщения', group: 'Доступ', defaultCreate: true },
            { key: 'can_attach', label: 'Файлы', hint: 'Прикреплять изображения и файлы', group: 'Доступ', defaultCreate: true },
            { key: 'can_embed', label: 'Ссылки и медиа', hint: 'Встраивать превью ссылок', group: 'Доступ', defaultCreate: true },
            { key: 'can_voice', label: 'Голосовые каналы', hint: 'Входить и говорить в voice', group: 'Доступ', defaultCreate: true },
            { key: 'can_manage', label: 'Управление сервером', hint: 'Общие админские действия', group: 'Управление', defaultCreate: false },
            { key: 'can_manage_channels', label: 'Каналы', hint: 'Создавать и менять каналы', group: 'Управление', defaultCreate: false },
            { key: 'can_manage_roles', label: 'Роли', hint: 'Создавать и менять роли', group: 'Управление', defaultCreate: false },
            { key: 'can_invite', label: 'Приглашения', hint: 'Генерировать инвайты', group: 'Управление', defaultCreate: true },
            { key: 'can_pin', label: 'Закреплять', hint: 'Закреплять важные сообщения', group: 'Управление', defaultCreate: false },
            { key: 'can_mention', label: '@everyone', hint: 'Упоминать всех участников', group: 'Управление', defaultCreate: false },
            { key: 'can_kick', label: 'Исключать', hint: 'Кикать участников из сервера', group: 'Управление', defaultCreate: false },
            { key: 'can_ban', label: 'Бан', hint: 'Блокировать участников', group: 'Управление', defaultCreate: false },
        ];
    }

    serverRolePermissionValue(role, key) {
        if (!role) return false;
        if (Object.prototype.hasOwnProperty.call(role, key)) return !!role[key];
        const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        if (Object.prototype.hasOwnProperty.call(role, camel)) return !!role[camel];
        return false;
    }

    serverModalColorPickerState(key) {
        return !!this.S.serverModal?.colorPickers?.[key];
    }

    setServerModalColorPickerState(key, open) {
        const next = {
            ...(this.S.serverModal.colorPickers || {}),
            [key]: !!open,
        };
        this.setServerModalState({ colorPickers: next });
    }

    toggleServerModalColorPicker(key) {
        const next = !this.serverModalColorPickerState(key);
        this.setServerModalColorPickerState(key, next);
        this.renderServerModal();
    }

    serverRolePermissionsHtml(role, keyPrefix = '', attrName = 'data-role-perm') {
        const defs = this.serverRolePermissionDefs();
        const sections = defs.reduce((acc, def) => {
            if (!acc[def.group]) acc[def.group] = [];
            acc[def.group].push(def);
            return acc;
        }, {});
        return Object.entries(sections).map(([groupName, items]) => {
            const rows = items.map(def => {
                const key = def.key;
                const checked = this.serverRolePermissionValue(role, key) ? 'checked' : '';
                return `<label class="server-perm-row server-perm-row--stacked">
                    <span>
                        <strong>${this.esc(def.label)}</strong>
                        <small>${this.esc(def.hint)}</small>
                    </span>
                    <input type="checkbox" ${attrName}="${this.esc(key)}" ${checked}>
                </label>`;
            }).join('');
            return `<div class="server-perm-group">
                <div class="server-perm-group-title">${this.esc(groupName)}</div>
                <div class="server-perm-grid server-perm-grid--dense">${rows}</div>
            </div>`;
        }).join('');
    }

    serverRolePermissionsCount(role) {
        return this.serverRolePermissionDefs().reduce((total, def) => total + Number(!!this.serverRolePermissionValue(role, def.key)), 0);
    }

    serverRoleCreateDefaults() {
        const defaults = {};
        this.serverRolePermissionDefs().forEach(def => {
            defaults[def.key] = !!def.defaultCreate;
        });
        return defaults;
    }

    applyServerRoleCreateDefaults() {
        const defaults = this.serverRoleCreateDefaults();
        this.serverRolePermissionDefs().forEach(def => {
            const el = document.querySelector(`[data-server-role-perm="${CSS.escape(def.key)}"]`);
            if (el) el.checked = !!defaults[def.key];
        });
    }

    syncDraftServerRolesFromDom() {
        if (this.S.serverModal.mode !== 'create') return this.draftServerRoleList();
        const cards = Array.from(document.querySelectorAll('[data-draft-role-card]'));
        const roles = cards.map(card => {
            const draftId = String(card.getAttribute('data-draft-role-card') || '').trim();
            const permissions = {};
            this.serverRolePermissionDefs().forEach(def => {
                permissions[def.key] = !!card.querySelector(`[data-draft-role-perm="${CSS.escape(def.key)}"]`)?.checked;
            });
            return {
                draftId,
                collapsed: String(card.getAttribute('data-draft-role-collapsed') || '1') !== '0',
                name: String(card.querySelector('[data-draft-role-name]')?.value || '').trim(),
                color: this.normalizeColorValue(card.querySelector('[data-draft-role-color]')?.value || '#cbff00'),
                ...permissions,
            };
        }).filter(role => role.draftId);
        this.setServerModalState({ draftRoles: roles });
        return roles;
    }

    serverRoleOptionsHtml(selected = 'member') {
        const roles = [...this.serverRoleList(), ...this.draftServerRoleList()];
        const options = [
            { roleId: 'member', name: 'Участник' },
            { roleId: 'admin', name: 'Админ' },
            ...roles.filter(role => role.roleId && role.roleId !== 'member' && role.roleId !== 'admin' && role.roleId !== 'owner'),
        ];
        return options.map(role => {
            const roleId = String(role.roleId || '').trim();
            const label = this.esc(role.name || this.serverRoleLabel(roleId));
            const isSelected = roleId === String(selected || '').trim() ? 'selected' : '';
            return `<option value="${this.esc(roleId)}" ${isSelected}>${label}</option>`;
        }).join('');
    }

    normalizeColorValue(value) {
        const raw = String(value || '').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
        return '#cbff00';
    }

    hexToRgb(hex) {
        const value = this.normalizeColorValue(hex).slice(1);
        const num = Number.parseInt(value, 16);
        return {
            r: (num >> 16) & 255,
            g: (num >> 8) & 255,
            b: num & 255,
        };
    }

    rgbToHex(r, g, b) {
        const toHex = (n) => Number(n || 0).toString(16).padStart(2, '0');
        return `#${toHex(Math.max(0, Math.min(255, Math.round(r))))}${toHex(Math.max(0, Math.min(255, Math.round(g))))}${toHex(Math.max(0, Math.min(255, Math.round(b))))}`;
    }

    rgbToHsl(r, g, b) {
        const rn = (r || 0) / 255;
        const gn = (g || 0) / 255;
        const bn = (b || 0) / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const delta = max - min;
        let h = 0;
        let s = 0;
        const l = (max + min) / 2;
        if (delta !== 0) {
            s = delta / (1 - Math.abs(2 * l - 1));
            switch (max) {
                case rn:
                    h = 60 * (((gn - bn) / delta) % 6);
                    break;
                case gn:
                    h = 60 * (((bn - rn) / delta) + 2);
                    break;
                default:
                    h = 60 * (((rn - gn) / delta) + 4);
                    break;
            }
        }
        return {
            h: (h + 360) % 360,
            s: s * 100,
            l: l * 100,
        };
    }

    hslToRgb(h, s, l) {
        const hue = ((h % 360) + 360) % 360;
        const sat = Math.max(0, Math.min(100, Number(s) || 0)) / 100;
        const lig = Math.max(0, Math.min(100, Number(l) || 0)) / 100;
        const c = (1 - Math.abs(2 * lig - 1)) * sat;
        const hp = hue / 60;
        const x = c * (1 - Math.abs((hp % 2) - 1));
        let r1 = 0, g1 = 0, b1 = 0;
        if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
        else if (hp < 2) [r1, g1, b1] = [x, c, 0];
        else if (hp < 3) [r1, g1, b1] = [0, c, x];
        else if (hp < 4) [r1, g1, b1] = [0, x, c];
        else if (hp < 5) [r1, g1, b1] = [x, 0, c];
        else [r1, g1, b1] = [c, 0, x];
        const m = lig - c / 2;
        return {
            r: Math.round((r1 + m) * 255),
            g: Math.round((g1 + m) * 255),
            b: Math.round((b1 + m) * 255),
        };
    }

    hueToHex(hue) {
        const rgb = this.hslToRgb(hue, 100, 50);
        return this.rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    bindColorWheel({ wheelId, hiddenId, hexId, initialValue = '#cbff00' }) {
        const wheel = document.getElementById(wheelId);
        const hidden = document.getElementById(hiddenId);
        const hexInput = document.getElementById(hexId);
        if (!wheel || this.colorWheelBindings.has(wheelId)) return;
        this.colorWheelBindings.add(wheelId);
        const updatePreview = (value) => {
            const normalized = this.normalizeColorValue(value);
            const picker = wheel.closest('.color-picker');
            const preview = picker?.querySelector('.color-picker-preview');
            if (preview) preview.style.background = normalized;
        };

        const setFromPoint = (clientX, clientY) => {
            const rect = wheel.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const dx = clientX - rect.left - rect.width / 2;
            const dy = clientY - rect.top - rect.height / 2;
            const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
            const nextValue = this.hueToHex(angle);
            this.applyColorWheelValue({ wheel, hidden, hexInput, value: nextValue });
            updatePreview(nextValue);
        };

        const onPointerDown = (e) => {
            e.preventDefault();
            try { wheel.setPointerCapture(e.pointerId); } catch (_) {}
            setFromPoint(e.clientX, e.clientY);
        };
        const onPointerMove = (e) => {
            if ((e.buttons || 0) === 0) return;
            setFromPoint(e.clientX, e.clientY);
        };
        const onClick = (e) => {
            if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return;
            setFromPoint(e.clientX, e.clientY);
        };
        const onHexInput = () => {
            const nextValue = hexInput?.value || hidden?.value || initialValue;
            this.applyColorWheelValue({ wheel, hidden, hexInput, value: nextValue });
            updatePreview(nextValue);
        };

        wheel.addEventListener('pointerdown', onPointerDown);
        wheel.addEventListener('pointermove', onPointerMove);
        wheel.addEventListener('mousedown', onPointerDown);
        wheel.addEventListener('click', onClick);
        hexInput?.addEventListener('input', onHexInput);
        hidden?.addEventListener('input', () => {
            this.applyColorWheelValue({ wheel, hidden, hexInput, value: hidden.value });
            updatePreview(hidden.value);
        });
    }

    applyColorWheelValue({ wheel, hidden, hexInput, value }) {
        if (!wheel) return;
        const normalized = this.normalizeColorValue(value);
        const { h } = this.rgbToHsl(...Object.values(this.hexToRgb(normalized)));
        const rect = wheel.getBoundingClientRect();
        const radius = Math.max(20, Math.min(rect.width, rect.height) * 0.36);
        const angle = ((h - 90) * Math.PI) / 180;
        const x = (rect.width / 2) + Math.cos(angle) * radius;
        const y = (rect.height / 2) + Math.sin(angle) * radius;
        wheel.style.setProperty('--thumb-x', `${x}px`);
        wheel.style.setProperty('--thumb-y', `${y}px`);
        wheel.style.setProperty('--wheel-color', normalized);
        if (hidden && hidden.value !== normalized) hidden.value = normalized;
        if (hexInput && hexInput.value.toLowerCase() !== normalized) hexInput.value = normalized;
    }

    canManageServer(server = null) {
        const current = server || this.currentServer();
        const role = this.normalizeMemberRole(current?.myRole || current?.my_role || '');
        return role === 'owner' || role === 'admin';
    }

    openServerOverlay() {
        const overlay = document.getElementById('serverOverlay');
        if (overlay) {
            overlay.hidden = false;
            requestAnimationFrame(() => overlay.classList.add('visible'));
        }
    }

    closeServerOverlay() {
        const overlay = document.getElementById('serverOverlay');
        if (overlay) {
            overlay.classList.remove('visible');
            setTimeout(() => {
                overlay.hidden = true;
            }, 180);
        }
    }

    setServerModalState(partial = {}) {
        this.S.serverModal = {
            ...this.S.serverModal,
            ...partial,
        };
    }

    serverModalSectionsForMode(mode = this.S.serverModal.mode) {
        if (mode === 'discover') return ['discover'];
        if (mode === 'edit') return ['overview', 'channels', 'roles', 'members'];
        return ['overview', 'roles'];
    }

    serverModalDefaultSection(mode = this.S.serverModal.mode) {
        return mode === 'discover' ? 'discover' : 'overview';
    }

    serverModalActiveSection(mode = this.S.serverModal.mode) {
        const allowed = this.serverModalSectionsForMode(mode);
        const current = String(this.S.serverModal.activeSection || '').trim() || this.serverModalDefaultSection(mode);
        return allowed.includes(current) ? current : this.serverModalDefaultSection(mode);
    }

    setServerModalSection(section) {
        const next = String(section || '').trim();
        if (!next) return;
        const allowed = this.serverModalSectionsForMode();
        if (!allowed.includes(next)) return;
        if (this.S.serverModal.activeSection === next) return;
        this.setServerModalState({ activeSection: next });
        this.renderServerModal();
    }

    renderServerModalMembers() {
        const list = document.getElementById('serverMembersList');
        const count = document.getElementById('serverMembersCount');
        const server = this.currentServer();
        const members = Array.isArray(this.S.serverModal.members) ? this.S.serverModal.members : [];
        const canManage = this.canManageServer(server);
        if (count) count.textContent = String(members.length || 0);
        if (!list) return;
        if (this.S.serverModal.loading && members.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Загрузка участников</div>
                <div class="empty-sub">Подождите секунду</div>
            </div>`;
            return;
        }
        if (this.S.serverModal.mode !== 'edit') {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">После создания</div>
                <div class="empty-sub">Здесь появятся участники и роли</div>
            </div>`;
            return;
        }

        if (members.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Нет участников</div>
                <div class="empty-sub">Добавьте первых участников сервера</div>
            </div>`;
            return;
        }

        list.innerHTML = members.map(member => {
            const role = this.normalizeMemberRole(member.role);
            const isOwner = role === 'owner';
            const joined = member.joinedAt ? this.fmtDate(member.joinedAt) || this.fmtTime(member.joinedAt) : '';
            const select = `
                <select class="settings-input server-member-role" data-member-role="${this.esc(member.username)}" ${isOwner ? 'disabled' : ''}>
                    ${isOwner ? '<option value="owner" selected>Владелец</option>' : this.serverRoleOptionsHtml(role)}
                </select>
            `;
            return `<div class="server-member-row ${isOwner ? 'owner' : ''}">
                <div class="server-member-info">
                    <div class="server-member-name">${this.esc(member.username)}</div>
                    <div class="server-member-meta">${this.esc(this.serverRoleLabel(role))}${joined ? ` · ${this.esc(joined)}` : ''}</div>
                </div>
                ${select}
                <button class="server-member-remove" type="button" data-member-remove="${this.esc(member.username)}" ${isOwner || !canManage ? 'disabled' : ''} title="Удалить">×</button>
            </div>`;
        }).join('');
    }

    renderPublicServersModal() {
        const list = document.getElementById('serverDiscoverList');
        const count = document.getElementById('serverDiscoverCount');
        const refreshBtn = document.getElementById('serverDiscoverRefreshBtn');
        const servers = this.renderFilteredPublicServers();
        if (count) count.textContent = String(servers.length || 0);
        if (refreshBtn) refreshBtn.disabled = !!this.S.serverModal.loading;
        if (!list) return;
        if (this.S.serverModal.loading && servers.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Поиск серверов</div>
                <div class="empty-sub">Секунду, подбираем публичные сообщества</div>
            </div>`;
            return;
        }
        if (servers.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Публичных серверов нет</div>
                <div class="empty-sub">Пока что нечего открывать из меню</div>
            </div>`;
            return;
        }

        list.innerHTML = servers.map(server => {
            const memberCount = Number(server.memberCount || server.member_count || 0) || 0;
            const channelCount = Array.isArray(server.channels) ? server.channels.length : 0;
            const role = this.normalizeMemberRole(server.myRole || server.my_role || '');
            const alreadyJoined = role === 'owner' || role === 'admin' || role === 'member';
            const joinTarget = server.joinLink || server.join_link || server.id;
            const actionLabel = alreadyJoined ? 'Открыть' : 'Войти';
            return `<div class="server-discover-row">
                <button class="server-item server-discover-item" type="button" data-public-server-id="${this.esc(server.id)}" title="${this.esc(server.name)}">
                    <span class="server-avatar" style="background:${this.esc(server.color || 'linear-gradient(180deg, #cbff00, #8c8c8c)')}">${this.esc(server.icon || server.name?.[0] || 'S')}</span>
                    <div class="server-meta">
                        <div class="server-name">${this.esc(server.name)}</div>
                        <div class="server-prev">${this.esc(server.description || 'Публичный сервер')}${channelCount ? ` · ${channelCount} каналов` : ''}${memberCount ? ` · ${memberCount} участников` : ''}</div>
                    </div>
                </button>
                <div class="server-discover-actions">
                    <button class="btn-flat" type="button" data-public-server-open="${this.esc(server.id)}">${actionLabel}</button>
                    <button class="btn-flat" type="button" data-public-server-join="${this.esc(joinTarget)}">${alreadyJoined ? 'Перейти' : 'Вступить'}</button>
                </div>
            </div>`;
        }).join('');
    }

    renderServerModal() {
        const server = this.currentServer();
        const mode = this.S.serverModal.mode;
        const isEdit = mode === 'edit';
        const isDiscover = mode === 'discover';
        const activeSection = this.serverModalActiveSection(mode);
        const grid = document.querySelector('.server-modal-grid');
        const nav = document.getElementById('serverModalNav');
        const sidebarTitle = document.getElementById('serverModalSidebarTitle');
        const sidebarHint = document.getElementById('serverModalSidebarHint');
        const basicsCard = document.getElementById('serverBasicsCard');
        const channelsCard = document.getElementById('serverChannelsCard');
        const membersCard = document.getElementById('serverMembersCard');
        const discoverCard = document.getElementById('serverDiscoverCard');
        const overviewPanel = document.getElementById('serverOverviewPanel');
        const channelsPanel = document.getElementById('serverChannelsPanel');
        const rolesPanel = document.getElementById('serverRolesPanel');
        const membersPanel = document.getElementById('serverMembersPanel');
        const discoverPanel = document.getElementById('serverDiscoverPanel');
        const title = document.getElementById('serverModalTitle');
        const hint = document.getElementById('serverModalHint');
        const kicker = document.getElementById('serverModalKicker');
        const modeNote = document.getElementById('serverModalModeNote');
        const saveBtn = document.getElementById('serverSaveBtn');
        const deleteBtn = document.getElementById('serverDeleteBtn');
        const serverModalCancel = document.getElementById('serverModalCancel');
        const nameInput = document.getElementById('serverNameInput');
        const descInput = document.getElementById('serverDescriptionInput');
        const iconInput = document.getElementById('serverIconInput');
        const colorInput = document.getElementById('serverColorInput');
        const publicInput = document.getElementById('serverPublicInput');
        const serverMembersList = document.getElementById('serverMembersList');
        const serverRolesCard = document.getElementById('serverRolesCard');
        const serverJoinLinkInput = document.getElementById('serverJoinLinkInput');
        const serverJoinLinkGenerateBtn = document.getElementById('serverJoinLinkGenerateBtn');
        const serverJoinLinkCopyBtn = document.getElementById('serverJoinLinkCopyBtn');
        const serverChannelCreate = document.querySelector('[data-server-channel-create]');
        const serverChannelCreateBody = document.querySelector('[data-server-channel-create-body]');
        const serverChannelCreateToggleBtn = document.getElementById('serverChannelCreateBtn');
        const serverChannelCreateSubmitBtn = document.getElementById('serverChannelCreateSubmitBtn');
        const serverChannelNameInput = document.getElementById('serverChannelNameInput');
        const serverChannelTopicInput = document.getElementById('serverChannelTopicInput');
        const serverChannelKindInput = document.getElementById('serverChannelKindInput');
        const serverAvatarUploadBtn = document.getElementById('serverAvatarUploadBtn');
        const serverAvatarRemoveBtn = document.getElementById('serverAvatarRemoveBtn');
        const serverBannerUploadBtn = document.getElementById('serverBannerUploadBtn');
        const serverBannerRemoveBtn = document.getElementById('serverBannerRemoveBtn');
        const serverRoleNameInput = document.getElementById('serverRoleNameInput');
        const serverRoleColorInput = document.getElementById('serverRoleColorInput');
        const serverRolePermView = document.getElementById('serverRolePermView');
        const serverRolePermSend = document.getElementById('serverRolePermSend');
        const serverRolePermManage = document.getElementById('serverRolePermManage');
        const serverRoleCreate = document.querySelector('[data-server-role-create]');
        const serverRoleCreateBody = document.querySelector('[data-server-role-create-body]');
        const serverRoleCreateToggleBtn = document.getElementById('serverRoleCreateBtn');
        const serverRoleCreateSubmitBtn = document.getElementById('serverRoleCreateSubmitBtn');
        const discoverQuery = document.getElementById('serverDiscoverQuery');
        const errorBox = document.getElementById('serverModalError');
        const canManage = this.canManageServer(server);
        const current = isEdit && this.S.serverModal.serverId
            ? (this.S.servers || []).find(s => s.id === this.S.serverModal.serverId)
            : null;

        this.S.serverModal.activeSection = activeSection;

        if (grid) grid.classList.toggle('is-discover', isDiscover);
        if (basicsCard) basicsCard.hidden = activeSection !== 'overview';
        if (channelsCard) channelsCard.hidden = activeSection !== 'channels';
        if (membersCard) membersCard.hidden = activeSection !== 'members';
        if (serverRolesCard) serverRolesCard.hidden = activeSection !== 'roles';
        if (discoverCard) discoverCard.hidden = activeSection !== 'discover';
        if (overviewPanel) overviewPanel.hidden = activeSection !== 'overview';
        if (channelsPanel) channelsPanel.hidden = activeSection !== 'channels';
        if (rolesPanel) rolesPanel.hidden = activeSection !== 'roles';
        if (membersPanel) membersPanel.hidden = activeSection !== 'members';
        if (discoverPanel) discoverPanel.hidden = activeSection !== 'discover';
        if (nav) {
            nav.querySelectorAll('[data-server-modal-section]').forEach(btn => {
                const section = btn.getAttribute('data-server-modal-section');
                const visible = isDiscover ? section === 'discover' : section !== 'discover';
                btn.hidden = !visible;
                btn.classList.toggle('active', visible && section === activeSection);
            });
        }
        if (sidebarTitle) sidebarTitle.textContent = isEdit ? (current?.name || server?.name || 'Настройки сервера') : isDiscover ? 'Поиск серверов' : 'Создание сервера';
        if (sidebarHint) sidebarHint.textContent = isEdit
            ? (activeSection === 'overview'
                ? 'Основные параметры сервера и внешний вид.'
                : activeSection === 'channels'
                    ? 'Создавайте, редактируйте и удаляйте каналы.'
                    : activeSection === 'roles'
                        ? 'Настройка ролей и прав доступа.'
                        : 'Управление участниками и их ролями.')
            : isDiscover
                ? 'Подберите сервер и войдите в него из каталога.'
                : activeSection === 'roles'
                    ? 'Соберите роли до создания сервера.'
                    : 'Имя, оформление и базовая конфигурация.';
        if (title) title.textContent = isEdit ? 'Настройки сервера' : isDiscover ? 'Публичные серверы' : 'Создать сервер';
        if (hint) hint.textContent = isEdit
            ? (activeSection === 'overview'
                ? 'Переименуйте сервер, измените оформление и ссылку входа.'
                : activeSection === 'channels'
                    ? 'Управляйте каналами сервера.'
                : activeSection === 'roles'
                    ? 'Управляйте ролями и правами доступа.'
                    : 'Добавляйте участников и назначайте им роли.')
            : isDiscover
                ? 'Выберите публичный сервер и войдите в него через меню без автодобавления в список.'
            : activeSection === 'roles'
                ? 'Настройте роли и доступ перед созданием.'
                : 'Настройте имя, оформление и доступ перед созданием.';
        if (kicker) kicker.textContent = isEdit ? 'Settings' : isDiscover ? 'Discover' : 'Creation';
        if (modeNote) modeNote.textContent = isEdit ? 'edit' : isDiscover ? 'browse' : 'create';
        if (saveBtn) {
            saveBtn.hidden = isDiscover;
            saveBtn.textContent = this.S.serverModal.saving ? 'Сохранение...' : (isEdit ? 'Сохранить' : 'Создать');
            saveBtn.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        }
        if (deleteBtn) deleteBtn.hidden = !isEdit || !canManage || this.normalizeMemberRole(current?.myRole || current?.my_role || '') !== 'owner';
        if (serverModalCancel) serverModalCancel.textContent = isDiscover ? 'Закрыть' : 'Отмена';
        if (nameInput) nameInput.value = current?.name || '';
        if (descInput) descInput.value = current?.description || '';
        if (iconInput) iconInput.value = current?.icon || '';
        const normalizedColor = this.normalizeColorValue(current?.color || '#cbff00');
        if (colorInput) colorInput.value = normalizedColor;
        const colorHexInput = document.getElementById('serverColorHexInput');
        if (colorHexInput) colorHexInput.value = normalizedColor;
        const serverColorPickerPreview = document.querySelector('[data-color-picker-key="server-basics"] .color-picker-preview');
        if (serverColorPickerPreview) serverColorPickerPreview.style.background = normalizedColor;
        this.applyColorWheelValue({
            wheel: document.getElementById('serverColorWheel'),
            hidden: colorInput,
            hexInput: colorHexInput,
            value: normalizedColor,
        });
        if (publicInput) publicInput.checked = current ? !!current.is_public : true;
        if (discoverQuery && !discoverQuery.value) {
            discoverQuery.value = '';
        }
        const editLocked = !isEdit;
        const linkLocked = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.disabled = editLocked;
        if (serverAvatarRemoveBtn) serverAvatarRemoveBtn.disabled = editLocked;
        if (serverBannerUploadBtn) serverBannerUploadBtn.disabled = editLocked;
        if (serverBannerRemoveBtn) serverBannerRemoveBtn.disabled = editLocked;
        if (serverJoinLinkInput) serverJoinLinkInput.disabled = linkLocked;
        if (serverJoinLinkGenerateBtn) serverJoinLinkGenerateBtn.disabled = linkLocked;
        if (serverJoinLinkCopyBtn) serverJoinLinkCopyBtn.disabled = linkLocked;
        if (serverRoleNameInput) serverRoleNameInput.disabled = false;
        if (serverRoleColorInput) serverRoleColorInput.disabled = false;
        const serverRoleColorHexInput = document.getElementById('serverRoleColorHexInput');
        if (serverRoleColorHexInput) serverRoleColorHexInput.disabled = false;
        if (serverRolePermView) serverRolePermView.disabled = false;
        if (serverRolePermSend) serverRolePermSend.disabled = false;
        if (serverRolePermManage) serverRolePermManage.disabled = false;
        const roleCreateOpen = !!this.S.serverModal.roleCreateOpen;
        if (serverRoleCreate) serverRoleCreate.classList.toggle('is-collapsed', !roleCreateOpen);
        if (serverRoleCreateBody) serverRoleCreateBody.hidden = !roleCreateOpen;
        if (serverRoleCreateToggleBtn) serverRoleCreateToggleBtn.textContent = roleCreateOpen ? 'Свернуть' : 'Новая роль';
        if (serverRoleCreateSubmitBtn) serverRoleCreateSubmitBtn.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading || !roleCreateOpen;
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.title = isEdit ? 'Загрузить аватар' : 'Создать сервер сначала';
        if (serverAvatarRemoveBtn) serverAvatarRemoveBtn.title = isEdit ? 'Удалить аватар' : 'Создать сервер сначала';
        if (serverBannerUploadBtn) serverBannerUploadBtn.title = isEdit ? 'Загрузить баннер' : 'Создать сервер сначала';
        if (serverBannerRemoveBtn) serverBannerRemoveBtn.title = isEdit ? 'Удалить баннер' : 'Создать сервер сначала';
        if (errorBox) errorBox.textContent = this.S.serverModal.error || '';
        if (serverMembersList) {
            serverMembersList.classList.toggle('is-loading', !!this.S.serverModal.loading);
        }
        const roleSelect = document.getElementById('serverMemberRole');
        if (roleSelect) {
            roleSelect.innerHTML = this.serverRoleOptionsHtml(roleSelect.value || 'member');
        }
        if (serverRoleColorInput) {
            const roleColor = this.normalizeColorValue(serverRoleColorInput.value || '#cbff00');
            serverRoleColorInput.value = roleColor;
            if (serverRoleColorHexInput) serverRoleColorHexInput.value = roleColor;
            const createPicker = document.querySelector('[data-color-picker-key="server-role-create"]');
            const createPickerOpen = this.serverModalColorPickerState('server-role-create');
            const createPickerPreview = createPicker?.querySelector('.color-picker-preview');
            if (createPickerPreview) createPickerPreview.style.background = roleColor;
            if (createPicker) createPicker.classList.toggle('is-collapsed', !createPickerOpen);
            const createPickerToggle = createPicker?.querySelector('[data-color-picker-toggle="server-role-create"]');
            if (createPickerToggle) createPickerToggle.textContent = createPickerOpen ? 'Свернуть' : 'Развернуть';
            if (activeSection === 'roles') {
                this.applyColorWheelValue({
                    wheel: document.getElementById('serverRoleColorWheel'),
                    hidden: serverRoleColorInput,
                    hexInput: serverRoleColorHexInput,
                    value: roleColor,
                });
            }
        }
        const channelCreateOpen = !!this.S.serverModal.channelCreateOpen;
        if (serverChannelCreate) serverChannelCreate.classList.toggle('is-collapsed', !channelCreateOpen);
        if (serverChannelCreateBody) serverChannelCreateBody.hidden = !channelCreateOpen;
        if (serverChannelCreateToggleBtn) serverChannelCreateToggleBtn.textContent = channelCreateOpen ? 'Свернуть' : 'Новый канал';
        if (serverChannelCreateSubmitBtn) serverChannelCreateSubmitBtn.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading || !channelCreateOpen;
        if (serverChannelNameInput) serverChannelNameInput.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        if (serverChannelTopicInput) serverChannelTopicInput.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        if (serverChannelKindInput) serverChannelKindInput.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        const serverColorPicker = document.querySelector('[data-color-picker-key="server-basics"]');
        if (serverColorPicker) {
            const open = this.serverModalColorPickerState('server-basics');
            serverColorPicker.classList.toggle('is-collapsed', !open);
            const toggle = serverColorPicker.querySelector('[data-color-picker-toggle="server-basics"]');
            if (toggle) toggle.textContent = open ? 'Свернуть' : 'Развернуть';
        }
        if (activeSection === 'overview') {
            this.renderServerJoinLink();
        } else if (activeSection === 'channels') {
            this.renderServerChannels();
        } else if (activeSection === 'roles') {
            this.renderServerRoles();
        } else if (activeSection === 'members') {
            this.renderServerModalMembers();
        } else if (activeSection === 'discover') {
            this.renderPublicServersModal();
        }
        if (isEdit && (this.S.serverModal.serverId || server?.id)) {
            this.syncServerAssetPreview(this.S.serverModal.serverId || server?.id || '');
        } else {
            this.resetServerAssetPreview();
        }
    }

    async loadServerMembers(serverId) {
        const sid = String(serverId || '').trim();
        if (!sid) return [];
        const res = await this.apiFetch(`/api/servers/${encodeURIComponent(sid)}/members`);
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось загрузить участников сервера');
        }
        const data = await res.json();
        const members = Array.isArray(data) ? data : (Array.isArray(data?.members) ? data.members : []);
        return members.map(member => ({
            ...member,
            role: this.normalizeMemberRole(member.role),
        }));
    }

    async loadServerRoles(serverId) {
        const sid = String(serverId || '').trim();
        if (!sid) return [];
        const res = await this.apiFetch(`/api/servers/${encodeURIComponent(sid)}/roles`);
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось загрузить роли сервера');
        }
        const data = await res.json();
        const roles = Array.isArray(data?.roles) ? data.roles : [];
        return roles.map(role => ({
            ...role,
            roleId: String(role.roleId || role.role_id || '').trim(),
            name: String(role.name || '').trim(),
            color: String(role.color || '#cbff00').trim(),
            canView: !!(role.canView ?? role.can_view),
            canSend: !!(role.canSend ?? role.can_send),
            canManage: !!(role.canManage ?? role.can_manage),
            canManageChannels: !!(role.canManageChannels ?? role.can_manage_channels),
            canManageRoles: !!(role.canManageRoles ?? role.can_manage_roles),
            canInvite: !!(role.canInvite ?? role.can_invite),
            canAttach: !!(role.canAttach ?? role.can_attach),
            canEmbed: !!(role.canEmbed ?? role.can_embed),
            canReact: !!(role.canReact ?? role.can_react),
            canPin: !!(role.canPin ?? role.can_pin),
            canMention: !!(role.canMention ?? role.can_mention),
            canVoice: !!(role.canVoice ?? role.can_voice),
            canKick: !!(role.canKick ?? role.can_kick),
            canBan: !!(role.canBan ?? role.can_ban),
            position: Number(role.position || 0) || 0,
        }));
    }

    async loadServerChannels(serverId) {
        const sid = String(serverId || '').trim();
        if (!sid) return [];
        const res = await this.apiFetch(`/api/servers/${encodeURIComponent(sid)}/channels`);
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось загрузить каналы сервера');
        }
        const data = await res.json();
        const channels = Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []);
        return this.normalizeServerChannels(channels);
    }

    normalizeServerChannels(channels) {
        return (Array.isArray(channels) ? channels : [])
            .filter(Boolean)
            .map((channel, index) => ({
                ...channel,
                id: String(channel.id || '').trim(),
                name: String(channel.name || '').trim(),
                topic: String(channel.topic || '').trim(),
                kind: this.normalizeChannelKind(channel.kind),
                position: Number.isFinite(Number(channel.position)) ? Number(channel.position) : index,
            }))
            .sort((a, b) => Number(a.position || 0) - Number(b.position || 0) || String(a.name || '').localeCompare(String(b.name || '')));
    }

    normalizeChannelKind(kind) {
        return String(kind || 'text').trim().toLowerCase() === 'voice' ? 'voice' : 'text';
    }

    channelKindLabel(kind) {
        return this.normalizeChannelKind(kind) === 'voice' ? 'Голосовой' : 'Текстовый';
    }

    renderServerJoinLink() {
        const input = document.getElementById('serverJoinLinkInput');
        if (!input) return;
        input.value = this.S.serverModal.joinLink || '';
    }

    renderServerRoles() {
        const list = document.getElementById('serverRolesList');
        const count = document.getElementById('serverRolesCount');
        const isEdit = this.S.serverModal.mode === 'edit';
        const roles = isEdit ? this.serverRoleList() : this.draftServerRoleList();
        if (count) count.textContent = String(roles.length || 0);
        if (!list) return;
        if (roles.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">${isEdit ? 'Ролей нет' : 'Черновики ролей'}</div>
                <div class="empty-sub">${isEdit ? 'Создайте первую роль' : 'Добавьте роли перед созданием сервера'}</div>
            </div>`;
            return;
        }
        const renderColorPicker = ({ pickerKey, wheelId, colorId, hexId, currentColor, isRoleCard = false }) => {
            const open = this.serverModalColorPickerState(pickerKey);
            return `<div class="color-picker color-picker--compact color-picker--collapsible ${open ? '' : 'is-collapsed'}" data-color-picker-key="${this.esc(pickerKey)}">
                <div class="color-picker-head">
                    <div class="color-picker-summary">
                        <span class="color-picker-preview" style="background:${this.esc(currentColor)}"></span>
                        <div class="color-picker-copy">
                            <div class="color-picker-title">RGB</div>
                            <div class="color-picker-sub">${open ? 'Колесо открыто' : 'Свернуто по умолчанию'}</div>
                        </div>
                    </div>
                    <button class="btn-flat color-picker-toggle" type="button" data-color-picker-toggle="${this.esc(pickerKey)}">${open ? 'Свернуть' : 'Развернуть'}</button>
                </div>
                <div class="color-picker-body">
                    <div class="color-wheel ${isRoleCard ? 'color-wheel--tiny' : 'color-wheel--small'}" id="${this.esc(wheelId)}" tabindex="0" aria-label="Цвет роли">
                        <div class="color-wheel-thumb"></div>
                        <div class="color-wheel-center">${isRoleCard ? '' : 'RGB'}</div>
                    </div>
                    <div class="color-picker-side">
                        <input type="hidden" ${isRoleCard ? `data-role-color="${this.esc(pickerKey)}"` : `data-draft-role-color="${this.esc(pickerKey)}"`} id="${this.esc(colorId)}" value="${this.esc(currentColor)}">
                        <input class="settings-input color-hex-input" type="text" id="${this.esc(hexId)}" maxlength="7" value="${this.esc(currentColor)}" aria-label="HEX цвет роли">
                    </div>
                </div>
            </div>`;
        };
        list.innerHTML = roles.map(role => {
            if (!isEdit) {
                const draftId = String(role.draftId || '').trim();
                const safeDraftId = draftId.replace(/[^a-z0-9_-]/gi, '_');
                const wheelId = `draftRoleColorWheel-${safeDraftId}`;
                const colorId = `draftRoleColorInput-${safeDraftId}`;
                const hexId = `draftRoleColorHexInput-${safeDraftId}`;
                const currentColor = this.normalizeColorValue(role.color || '#cbff00');
                const collapsed = role.collapsed !== false;
                const draftPermCount = this.serverRolePermissionsCount(role);
                return `<div class="server-role-card draft-role ${collapsed ? 'collapsed' : ''}" data-draft-role-card="${this.esc(draftId)}" data-draft-role-collapsed="${collapsed ? '1' : '0'}">
                    <div class="server-role-head server-role-head--draft">
                        <span class="server-role-chip" style="background:${this.esc(currentColor)}"></span>
                        <div>
                            <div class="server-role-name">${this.esc(role.name || 'Новая роль')}</div>
                            <div class="server-role-meta">черновик</div>
                        </div>
                        <button class="btn-flat server-role-toggle" type="button" data-draft-role-toggle="${this.esc(draftId)}">${collapsed ? 'Развернуть' : 'Свернуть'}</button>
                    </div>
                    <div class="server-role-body">
                        <div class="server-role-meta server-role-summary">Права: ${draftPermCount}/${this.serverRolePermissionDefs().length}</div>
                        <div class="server-role-controls">
                        <input class="settings-input" data-draft-role-name="${this.esc(draftId)}" value="${this.esc(role.name || '')}" placeholder="Название роли">
                        ${renderColorPicker({ pickerKey: draftId, wheelId, colorId, hexId, currentColor, isRoleCard: false })}
                        ${this.serverRolePermissionsHtml(role, draftId, 'data-draft-role-perm')}
                        <div class="server-role-actions">
                            <button class="btn-flat" type="button" data-draft-role-delete="${this.esc(draftId)}">Удалить</button>
                        </div>
                        </div>
                    </div>
                </div>`;
            }
            const locked = role.roleId === 'member' || role.roleId === 'admin';
            const safeRoleId = String(role.roleId || '').replace(/[^a-z0-9_-]/gi, '_');
            const wheelId = `roleColorWheel-${safeRoleId}`;
            const colorId = `roleColorInput-${safeRoleId}`;
            const hexId = `roleColorHexInput-${safeRoleId}`;
            const currentColor = this.normalizeColorValue(role.color || '#cbff00');
            const rolePermCount = this.serverRolePermissionsCount(role);
            const colorPickerKey = role.roleId || safeRoleId;
            const options = `
                <div class="server-role-controls">
                    <input class="settings-input" data-role-name="${this.esc(role.roleId)}" value="${this.esc(role.name || '')}">
                    ${renderColorPicker({ pickerKey: colorPickerKey, wheelId, colorId, hexId, currentColor, isRoleCard: true })}
                    <div class="server-role-actions">
                        <button class="btn-flat" type="button" data-role-save="${this.esc(role.roleId)}">Сохранить</button>
                        <button class="btn-flat" type="button" data-role-delete="${this.esc(role.roleId)}" ${locked ? 'disabled' : ''}>Удалить</button>
                    </div>
                </div>
            `;
            return `<div class="server-role-card ${locked ? 'owner-role' : ''}" data-role-card="${this.esc(role.roleId)}">
                <div class="server-role-head">
                    <span class="server-role-chip" style="background:${this.esc(role.color || '#cbff00')}"></span>
                    <div>
                        <div class="server-role-name">${this.esc(role.name || role.roleId)}</div>
                        <div class="server-role-meta">${this.esc(role.roleId)}</div>
                    </div>
                    <span class="server-role-meta">${locked ? 'системная' : 'роль'}</span>
                </div>
                <div class="server-role-meta server-role-summary">Права: ${rolePermCount}/${this.serverRolePermissionDefs().length}</div>
                ${this.serverRolePermissionsHtml(role, role.roleId, 'data-role-perm')}
                ${options}
            </div>`;
        }).join('');
        requestAnimationFrame(() => {
            roles.forEach(role => {
                if (!isEdit) {
                    const draftId = String(role.draftId || '').trim();
                const safeDraftId = draftId.replace(/[^a-z0-9_-]/gi, '_');
                this.colorWheelBindings.delete(`draftRoleColorWheel-${safeDraftId}`);
                this.bindColorWheel({
                    wheelId: `draftRoleColorWheel-${safeDraftId}`,
                    hiddenId: `draftRoleColorInput-${safeDraftId}`,
                    hexId: `draftRoleColorHexInput-${safeDraftId}`,
                    initialValue: this.normalizeColorValue(role.color || '#cbff00'),
                });
                return;
            }
            const safeRoleId = String(role.roleId || '').replace(/[^a-z0-9_-]/gi, '_');
            const wheelId = `roleColorWheel-${safeRoleId}`;
            const colorId = `roleColorInput-${safeRoleId}`;
            const hexId = `roleColorHexInput-${safeRoleId}`;
            this.colorWheelBindings.delete(wheelId);
            this.bindColorWheel({
                wheelId,
                hiddenId: colorId,
                hexId,
                initialValue: this.normalizeColorValue(role.color || '#cbff00'),
            });
            });
        });
    }

    renderServerChannels() {
        const list = document.getElementById('serverChannelsList');
        const count = document.getElementById('serverChannelsCount');
        const isEdit = this.S.serverModal.mode === 'edit';
        const channels = isEdit ? this.normalizeServerChannels(this.S.serverModal.channels || []) : [];
        if (count) count.textContent = String(channels.length || 0);
        if (!list) return;
        if (this.S.serverModal.loading && channels.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Загрузка каналов</div>
                <div class="empty-sub">Подождите секунду</div>
            </div>`;
            return;
        }
        if (!isEdit) {
            list.innerHTML = '';
            return;
        }
        if (channels.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Каналов нет</div>
                <div class="empty-sub">Создайте первый канал</div>
            </div>`;
            return;
        }
        list.innerHTML = channels.map(channel => {
            const safeId = String(channel.id || '').replace(/[^a-z0-9_-]/gi, '_');
            const kind = this.normalizeChannelKind(channel.kind);
            const icon = kind === 'voice' ? '🔊' : '#';
            return `<div class="server-channel-card" data-channel-card="${this.esc(channel.id)}">
                <div class="server-channel-head">
                    <span class="server-channel-chip ${kind}">${this.esc(icon)}</span>
                    <div class="server-channel-copy">
                        <input class="settings-input" data-channel-name="${this.esc(channel.id)}" value="${this.esc(channel.name || '')}" placeholder="Название канала">
                        <div class="server-channel-meta">ID: ${this.esc(channel.id || safeId)} · ${this.esc(this.channelKindLabel(kind))}</div>
                    </div>
                    <select class="settings-input server-channel-kind-select" data-channel-kind="${this.esc(channel.id)}">
                        <option value="text"${kind === 'text' ? ' selected' : ''}>Текстовый</option>
                        <option value="voice"${kind === 'voice' ? ' selected' : ''}>Голосовой</option>
                    </select>
                    <div class="server-channel-controls">
                        <button class="btn-flat" type="button" data-channel-save="${this.esc(channel.id)}">Сохранить</button>
                        <button class="btn-flat" type="button" data-channel-delete="${this.esc(channel.id)}">Удалить</button>
                    </div>
                </div>
                <div class="server-channel-body">
                    <input class="settings-input" data-channel-topic="${this.esc(channel.id)}" value="${this.esc(channel.topic || '')}" placeholder="Тема или описание">
                    <label class="server-channel-position">
                        <span class="server-channel-position-label">Позиция</span>
                        <input class="settings-input" data-channel-position="${this.esc(channel.id)}" type="number" min="0" step="1" value="${this.esc(String(Number.isFinite(Number(channel.position)) ? Number(channel.position) : 0))}" placeholder="0">
                    </label>
                </div>
            </div>`;
        }).join('');
    }

    async openServerModal(mode = 'create', serverId = null) {
        const nextMode = mode === 'edit' ? 'edit' : 'create';
        const sid = nextMode === 'edit' ? String(serverId || this.S.activeServer || '').trim() : null;
        const server = sid ? (this.S.servers || []).find(item => item.id === sid) : null;
        if (nextMode === 'edit' && (!server || !this.canManageServer(server))) {
            return;
        }
        const selectedChannelId = nextMode === 'edit'
            ? ((this.S.activeServer === sid ? this.S.activeChannel : null) || server?.channels?.[0]?.id || null)
            : null;

        this.setServerModalState({
            mode: nextMode,
            serverId: sid,
            activeSection: nextMode === 'edit' ? 'overview' : 'overview',
            colorPickers: {},
            roleCreateOpen: false,
            channelCreateOpen: false,
            members: nextMode === 'edit' ? (server?.members || []) : [],
            roles: [],
            channels: nextMode === 'edit' ? (server?.channels || []) : [],
            draftRoles: [],
            joinLink: nextMode === 'edit' ? (server?.joinLink || server?.join_link || '') : '',
            selectedChannelId,
            channelPermissions: [],
            loading: nextMode === 'edit',
            saving: false,
            error: '',
        });
        this.openServerOverlay();
        this.renderServerModal();
        if (nextMode === 'create') {
            this.applyServerRoleCreateDefaults();
        }

        if (nextMode === 'edit' && sid) {
            try {
                const [members, roles, channels] = await Promise.all([
                    this.loadServerMembers(sid),
                    this.loadServerRoles(sid),
                    this.loadServerChannels(sid),
                ]);
                this.setServerModalState({
                    members,
                    roles,
                    channels,
                    loading: false,
                });
                this.renderServerModal();
            } catch (e) {
                this.setServerModalState({ loading: false, error: e?.message || 'Не удалось загрузить участников' });
                this.renderServerModal();
            }
        }
    }

    async openPublicServersModal() {
        const discoverQuery = document.getElementById('serverDiscoverQuery');
        if (discoverQuery) discoverQuery.value = '';
        this.setServerModalState({
            mode: 'discover',
            serverId: null,
            activeSection: 'discover',
            colorPickers: {},
            members: [],
            roles: [],
            channels: [],
            draftRoles: [],
            joinLink: '',
            selectedChannelId: null,
            channelPermissions: [],
            channelCreateOpen: false,
            loading: true,
            saving: false,
            error: '',
        });
        this.openServerOverlay();
        this.renderServerModal();
        await this.loadPublicServers({ silent: true });
    }

    publicServerFilterValue() {
        const input = document.getElementById('serverDiscoverQuery');
        return String(input?.value || '').trim().toLowerCase();
    }

    renderFilteredPublicServers() {
        const q = this.publicServerFilterValue();
        const servers = Array.isArray(this.S.publicServers) ? this.S.publicServers : [];
        if (!q) return servers;
        return servers.filter(server => {
            const haystack = `${server.name || ''} ${server.description || server.hint || ''} ${server.joinLink || server.join_link || ''}`.toLowerCase();
            return haystack.includes(q);
        });
    }

    async loadPublicServers({ silent = false } = {}) {
        try {
            this.setServerModalState({ loading: true, error: '' });
            this.renderServerModal();
            const res = await this.apiFetch('/api/discover/servers');
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось загрузить публичные серверы');
            }
            const data = await res.json();
            this.S.publicServers = this.normalizeServers(Array.isArray(data?.servers) ? data.servers : []);
            this.setServerModalState({ loading: false, error: '' });
            this.renderServerModal();
        } catch (e) {
            this.S.publicServers = [];
            this.setServerModalState({
                loading: false,
                error: e?.message || 'Не удалось загрузить публичные серверы',
            });
            this.renderServerModal();
            if (!silent) {
                this.addLogEntry({ type: 'ERROR', msg: e?.message || 'Не удалось загрузить публичные серверы', ts: new Date().toLocaleTimeString() });
            }
        }
    }

    async enterPublicServer(serverIdOrLink) {
        const raw = String(serverIdOrLink || '').trim();
        if (!raw) return;
        await this.joinServerByLink(raw);
        if (this.S.serverModal.mode === 'discover') {
            await this.loadPublicServers({ silent: true });
        }
    }

    async submitServerModal() {
        if (this.S.serverModal.saving) return;
        const mode = this.S.serverModal.mode;
        const serverId = this.S.serverModal.serverId;
        const nameInput = document.getElementById('serverNameInput');
        const descInput = document.getElementById('serverDescriptionInput');
        const iconInput = document.getElementById('serverIconInput');
        const colorInput = document.getElementById('serverColorInput');
        const joinLinkInput = document.getElementById('serverJoinLinkInput');
        const publicInput = document.getElementById('serverPublicInput');
        const payload = {
            name: (nameInput?.value || '').trim(),
            description: (descInput?.value || '').trim(),
            icon: (iconInput?.value || '').trim(),
            color: this.normalizeColorValue(colorInput?.value || '#cbff00'),
            join_link: (joinLinkInput?.value || '').trim(),
            is_public: !!publicInput?.checked,
        };
        if (mode !== 'edit') {
            payload.roles = this.syncDraftServerRolesFromDom().map(role => {
                const rolePayload = {
                    name: role.name,
                    color: role.color,
                };
                this.serverRolePermissionDefs().forEach(def => {
                    rolePayload[def.key] = !!role[def.key];
                });
                return rolePayload;
            });
        }

        if (!payload.name) {
            this.setServerModalState({ error: 'Введите название сервера' });
            this.renderServerModal();
            return;
        }

        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();

        try {
            const endpoint = mode === 'edit' && serverId
                ? `/api/servers/${encodeURIComponent(serverId)}`
                : '/api/servers';
            const res = await this.apiFetch(endpoint, {
                method: mode === 'edit' ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось сохранить сервер');
            }
            const data = await res.json();
            this.closeServerOverlay();
            await this.loadServers({ silent: true });
            if (data?.id) {
                this.setActiveServer(data.id, { persist: true });
            }
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось сохранить сервер' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    async uploadServerAsset(kind, file) {
        const serverId = this.S.serverModal.serverId || this.S.activeServer;
        if (!serverId || !file || this.S.serverModal.mode !== 'edit') return;
        const dataUrl = await this.readFileAsDataURL(file);
        const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/assets/${kind}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data_url: dataUrl }),
        });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || `Не удалось обновить ${kind}`);
        }
        this.clearServerAssetCache(serverId, kind);
        await this.syncServerAssetPreview(serverId);
    }

    async removeServerAsset(kind) {
        const serverId = this.S.serverModal.serverId || this.S.activeServer;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/assets/${kind}`, {
            method: 'DELETE',
        });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || `Не удалось удалить ${kind}`);
        }
        this.clearServerAssetCache(serverId, kind);
        await this.syncServerAssetPreview(serverId);
    }

    async generateServerJoinLink() {
        if (this.S.serverModal.saving) return '';
        const mode = this.S.serverModal.mode;
        const server = mode === 'edit'
            ? this.currentServer()
            : null;
        const fallback = mode === 'edit' && server?.id
            ? `zali://server/${server.id}`
            : `zali://server/${(document.getElementById('serverNameInput')?.value || 'server').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        this.setServerModalState({ joinLink: fallback, error: '' });
        this.renderServerModal();
        return fallback;
    }

    async joinServerByLink(link) {
        const raw = String(link || '').trim();
        if (!raw) return;
        const inviteMatch = raw.match(/(?:zali:\/\/invite\/|invite\/)?([a-z0-9]{4,64})/i);
        if (inviteMatch && /invite/i.test(raw)) {
            const inviteCode = inviteMatch[1].toLowerCase();
            try {
                const res = await this.apiFetch(`/api/invites/${encodeURIComponent(inviteCode)}/join`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: inviteCode }),
                });
                if (!res.ok) {
                    throw new Error(await res.text() || 'Не удалось войти по ссылке');
                }
                const data = await res.json();
                await this.loadServers({ silent: true });
                this.closeServerOverlay();
                if (data?.serverId) {
                    this.setActiveServer(data.serverId, { persist: true });
                }
                this.addLogEntry({ type: 'SUCCESS', msg: `Вход по ссылке успешен: ${inviteCode}`, ts: new Date().toLocaleTimeString() });
            } catch (e) {
                this.addLogEntry({ type: 'ERROR', msg: e?.message || 'Не удалось войти по ссылке', ts: new Date().toLocaleTimeString() });
            }
            return;
        }

        try {
            const res = await this.apiFetch('/api/servers/join', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ link: raw }),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось войти по ссылке');
            }
            const data = await res.json();
            await this.loadServers({ silent: true });
            this.closeServerOverlay();
            if (data?.serverId) {
                this.setActiveServer(data.serverId, { persist: true });
            }
            this.addLogEntry({ type: 'SUCCESS', msg: `Вход по ссылке успешен`, ts: new Date().toLocaleTimeString() });
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: e?.message || 'Не удалось войти по ссылке', ts: new Date().toLocaleTimeString() });
        }
    }

    extractInviteCode(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const match = raw.match(/(?:zali:\/\/invite\/|invite\/|zali:\/\/server\/|server\/)?([a-z0-9._-]{2,128})/i);
        return (match && match[1]) ? match[1].toLowerCase() : raw.toLowerCase();
    }

    rolePayloadFromCreateForm() {
        const nameInput = document.getElementById('serverRoleNameInput');
        const colorInput = document.getElementById('serverRoleColorInput');
        const colorHexInput = document.getElementById('serverRoleColorHexInput');
        const permissions = {};
        this.serverRolePermissionDefs().forEach(def => {
            permissions[def.key] = !!document.querySelector(`[data-server-role-perm="${CSS.escape(def.key)}"]`)?.checked;
        });
        return {
            name: (nameInput?.value || '').trim(),
            color: this.normalizeColorValue(colorInput?.value || colorHexInput?.value || '#cbff00'),
            ...permissions,
        };
    }

    rolePayloadFromCard(roleId) {
        const card = document.querySelector(`[data-role-card="${CSS.escape(String(roleId || ''))}"]`);
        if (!card) return null;
        const name = String(card.querySelector(`[data-role-name="${CSS.escape(String(roleId || ''))}"]`)?.value || '').trim();
        const color = this.normalizeColorValue(card.querySelector(`[data-role-color="${CSS.escape(String(roleId || ''))}"]`)?.value || '#cbff00');
        const permissions = {};
        this.serverRolePermissionDefs().forEach(def => {
            permissions[def.key] = !!card.querySelector(`[data-role-perm="${CSS.escape(def.key)}"]`)?.checked;
        });
        return {
            name,
            color,
            ...permissions,
        };
    }

    async createServerRole() {
        const payload = this.rolePayloadFromCreateForm();
        if (!payload.name) {
            this.setServerModalState({ error: 'Введите название роли' });
            this.renderServerModal();
            return;
        }
        if (this.S.serverModal.mode === 'create') {
            const draftRoles = this.syncDraftServerRolesFromDom();
            const draftPermissions = {};
            this.serverRolePermissionDefs().forEach(def => {
                draftPermissions[def.key] = !!payload[def.key];
            });
            draftRoles.push({
                draftId: `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                collapsed: true,
                name: payload.name,
                color: payload.color,
                ...draftPermissions,
            });
            this.setServerModalState({ draftRoles, error: '' });
            const nameInput = document.getElementById('serverRoleNameInput');
            if (nameInput) nameInput.value = '';
            this.applyServerRoleCreateDefaults();
            this.renderServerModal();
            return;
        }
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/roles`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось создать роль');
        }
        const role = await res.json();
        const roles = [role, ...(this.S.serverModal.roles || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
        this.setServerModalState({ roles, error: '' });
        const nameInput = document.getElementById('serverRoleNameInput');
        if (nameInput) nameInput.value = '';
        this.renderServerModal();
        this.applyServerRoleCreateDefaults();
        await this.loadServers({ silent: true });
    }

    async saveServerRole(roleId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const payload = this.rolePayloadFromCard(roleId);
        if (!payload) return;
        const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось сохранить роль');
        }
        const updated = await res.json();
        const roles = (this.S.serverModal.roles || []).map(role => String(role.roleId || '') === roleId ? updated : role);
        this.setServerModalState({ roles, error: '' });
        this.renderServerModal();
        await this.loadServers({ silent: true });
    }

    async deleteServerRole(roleId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`, {
            method: 'DELETE',
        });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || 'Не удалось удалить роль');
        }
        const roles = (this.S.serverModal.roles || []).filter(role => String(role.roleId || '') !== roleId);
        this.setServerModalState({ roles, error: '' });
        this.renderServerModal();
        await this.loadServers({ silent: true });
    }

    async saveServerMembersFromModal() {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        try {
            const members = await this.loadServerMembers(serverId);
            this.setServerModalState({ members });
            this.renderServerModal();
            await this.loadServers({ silent: true });
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось обновить участников' });
            this.renderServerModal();
        }
    }

    channelPayloadFromCreateForm() {
        const nameInput = document.getElementById('serverChannelNameInput');
        const topicInput = document.getElementById('serverChannelTopicInput');
        const kindInput = document.getElementById('serverChannelKindInput');
        return {
            name: (nameInput?.value || '').trim(),
            topic: (topicInput?.value || '').trim(),
            kind: this.normalizeChannelKind(kindInput?.value || 'text'),
        };
    }

    channelPayloadFromCard(channelId) {
        const card = document.querySelector(`[data-channel-card="${CSS.escape(String(channelId || ''))}"]`);
        if (!card) return null;
        const name = String(card.querySelector(`[data-channel-name="${CSS.escape(String(channelId || ''))}"]`)?.value || '').trim();
        const topic = String(card.querySelector(`[data-channel-topic="${CSS.escape(String(channelId || ''))}"]`)?.value || '').trim();
        const kind = this.normalizeChannelKind(card.querySelector(`[data-channel-kind="${CSS.escape(String(channelId || ''))}"]`)?.value || 'text');
        const positionValue = String(card.querySelector(`[data-channel-position="${CSS.escape(String(channelId || ''))}"]`)?.value || '').trim();
        const position = positionValue === '' ? undefined : Number(positionValue);
        return {
            name,
            topic,
            kind,
            position: Number.isFinite(position) ? position : undefined,
        };
    }

    async createServerChannel() {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const payload = this.channelPayloadFromCreateForm();
        if (!payload.name) {
            this.setServerModalState({ error: 'Введите название канала' });
            this.renderServerModal();
            return;
        }
        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();
        try {
            const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/channels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось создать канал');
            }
            const data = await res.json();
            const channels = this.normalizeServerChannels(Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []));
            const nameInput = document.getElementById('serverChannelNameInput');
            const topicInput = document.getElementById('serverChannelTopicInput');
            if (nameInput) nameInput.value = '';
            if (topicInput) topicInput.value = '';
            this.setServerModalState({ channels, error: '' });
            await this.loadServers({ silent: true });
            if (this.S.activeServer === serverId) {
                this.setActiveServer(serverId, { persist: true });
            }
            this.renderServerModal();
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось создать канал' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    async saveServerChannel(channelId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const cid = String(channelId || '').trim();
        const payload = this.channelPayloadFromCard(cid);
        if (!payload || !payload.name) {
            this.setServerModalState({ error: 'Введите название канала' });
            this.renderServerModal();
            return;
        }
        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();
        try {
            const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(cid)}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось сохранить канал');
            }
            const data = await res.json();
            const channels = this.normalizeServerChannels(Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []));
            this.setServerModalState({ channels, error: '' });
            await this.loadServers({ silent: true });
            if (this.S.activeServer === serverId) {
                this.setActiveServer(serverId, { persist: true });
            }
            this.renderServerModal();
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось сохранить канал' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    async deleteServerChannel(channelId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const cid = String(channelId || '').trim();
        const channel = (this.S.serverModal.channels || []).find(item => String(item.id || '') === cid);
        const confirmDelete = confirm(`Удалить канал "${channel?.name || cid}"?`);
        if (!confirmDelete) return;
        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();
        try {
            const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(cid)}`, {
                method: 'DELETE',
            });
            if (!res.ok && res.status !== 204) {
                throw new Error(await res.text() || 'Не удалось удалить канал');
            }
            let channels = [];
            if (res.status !== 204) {
                const data = await res.json();
                channels = this.normalizeServerChannels(Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []));
            }
            this.setServerModalState({ channels, error: '' });
            await this.loadServers({ silent: true });
            if (this.S.activeServer === serverId) {
                this.setActiveServer(serverId, { persist: true });
            }
            this.renderServerModal();
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось удалить канал' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    currentServer() {
        return (this.S.servers || []).find(server => server.id === this.S.activeServer) || null;
    }

    currentChannel() {
        const server = this.currentServer();
        if (!server) return null;
        return (server.channels || []).find(channel => channel.id === this.S.activeChannel) || null;
    }

    currentServerChatKey() {
        if (!this.S.activeServer || !this.S.activeChannel) return '';
        return `${this.S.activeServer}:${this.S.activeChannel}`;
    }

    voiceRoomKeyForDm(peer) {
        const me = String(this.myName() || '').trim();
        const other = String(peer || '').trim();
        const pair = [me, other].filter(Boolean).sort();
        return pair.length === 2 ? `voice:dm:${pair.join(':')}` : '';
    }

    makeDmCallRoomId(peer) {
        const base = this.voiceRoomKeyForDm(peer);
        if (!base) return '';
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        return `${base}:${stamp}`;
    }

    voiceRoomKeyForChannel(serverId, channelId) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        return sid && cid ? `voice:channel:${sid}:${cid}` : '';
    }

    isVoiceChannel(channel = null) {
        return String(channel?.kind || '').trim().toLowerCase() === 'voice';
    }

    currentVoicePeer() {
        if (this.S.navMode === 'dm') {
            return String(this.S.current || '').trim();
        }
        return '';
    }

    shouldInitiateVoiceOffer(peer) {
        const me = String(this.myName() || '').trim();
        const other = String(peer || '').trim();
        if (!me || !other) return false;
        if (this.voice.roomType === 'dm') {
            const direction = String(this.voice.callTrack?.direction || '').trim();
            return direction === 'outgoing' && this.voice.status === 'connected';
        }
        return me.localeCompare(other) < 0;
    }

    voiceEventPayload(payload = {}) {
        return {
            ...payload,
            type: payload.type || 'voice_signal',
        };
    }

    sendVoiceEvent(payload = {}) {
        const event = this.voiceEventPayload(payload);
        this.voiceTrace('send-event', {
            type: event.type || '',
            roomId: event.roomId || '',
            roomType: event.roomType || '',
            to: event.to || '',
            signalType: event.signal?.type || '',
            participants: Array.isArray(this.voice.participants) ? this.voice.participants : [],
        });
        if (!this.nativeSupports('voice')) {
            if (this.voice.socket && this.voice.socket.readyState === WebSocket.OPEN) {
                try {
                    this.voice.socket.send(JSON.stringify(event));
                } catch (error) {
                    this.voiceTrace('send-event-failed', { type: event.type || '', error: error?.message || String(error) }, 'ERROR');
                    return false;
                }
                return true;
            }
            this.addLogEntry({
                type: 'WARN',
                msg: `Voice signal skipped in browser mode: ${event.type}`,
                ts: new Date().toLocaleTimeString(),
            });
            return false;
        }
        this.postNativeMessage({
            type: 'VOICE_EVENT',
            payload: event,
        });
        return true;
    }

    disconnectBrowserVoiceSocket() {
        this.voiceTrace('socket-disconnect', { generation: this.voiceSocketGeneration, hadSocket: !!this.voice.socket });
        this.voiceSocketGeneration += 1;
        this.voiceSocketReconnectDelayMs = 1000;
        if (this.voiceSocketReconnectTimer) {
            clearTimeout(this.voiceSocketReconnectTimer);
            this.voiceSocketReconnectTimer = null;
        }
        if (this.voice.socket) {
            try {
                this.voice.socket.onopen = null;
                this.voice.socket.onmessage = null;
                this.voice.socket.onclose = null;
                this.voice.socket.onerror = null;
                this.voice.socket.close();
            } catch (e) {}
        }
        this.voice.socket = null;
        this.voice.socketReady = false;
    }

    connectBrowserVoiceSocket() {
        if (this.nativeSupports('voice')) return;
        if (typeof WebSocket === 'undefined') return;
        if (this.voice.socket && (this.voice.socket.readyState === WebSocket.OPEN || this.voice.socket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this.disconnectBrowserVoiceSocket();
        const generation = ++this.voiceSocketGeneration;
        let url;
        try {
            url = new URL(this.getWsBaseUrl());
        } catch (error) {
            this.addLogEntry({ type: 'ERROR', msg: `Неверный WS URL: ${error?.message || error}`, ts: new Date().toLocaleTimeString() });
            return;
        }

        const sessionToken = String(this.S.session?.token || '').trim();
        if (sessionToken) {
            url.searchParams.set('token', sessionToken);
        }

        try {
            this.voiceTrace('socket-connect', { url: url.toString(), generation, auth: 'cookie-or-header' });
            const socket = new WebSocket(url.toString());
            this.voice.socket = socket;
            this.voice.socketReady = false;

            socket.onopen = () => {
                if (generation !== this.voiceSocketGeneration) return;
                this.voice.socketReady = true;
                this.voiceSocketReconnectDelayMs = 1000;
                this.voiceTrace('socket-open', { generation, url: url.toString() }, 'SUCCESS');
                this.addLogEntry({ type: 'SUCCESS', msg: 'Browser voice socket connected', ts: new Date().toLocaleTimeString() });
            };

            socket.onmessage = (event) => {
                if (generation !== this.voiceSocketGeneration) return;
                let payload = null;
                try {
                    payload = JSON.parse(event.data);
                } catch (e) {
                    return;
                }
                if (payload && typeof payload === 'object' && String(payload.type || '').startsWith('voice_')) {
                    this.handleVoiceEvent(payload);
                }
            };

            socket.onclose = () => {
                if (generation !== this.voiceSocketGeneration) return;
                this.voice.socketReady = false;
                this.voice.socket = null;
                this.voiceTrace('socket-close', { generation, url: url.toString() }, 'WARN');
                if (!this.nativeSupports('voice')) {
                    const baseDelay = this.voiceSocketReconnectDelayMs || 1000;
                    const jitter = Math.floor(Math.random() * 500);
                    const delay = Math.min(baseDelay + jitter, 30000);
                    this.voiceSocketReconnectDelayMs = Math.min(baseDelay * 2, 30000);
                    this.voiceSocketReconnectTimer = setTimeout(() => {
                        if (generation === this.voiceSocketGeneration) {
                            this.connectBrowserVoiceSocket();
                        }
                    }, delay);
                }
            };

            socket.onerror = () => {
                if (generation !== this.voiceSocketGeneration) return;
                this.voice.socketReady = false;
                this.voiceTrace('socket-error', { generation, url: url.toString() }, 'WARN');
            };
        } catch (error) {
            this.addLogEntry({ type: 'ERROR', msg: `Не удалось подключить browser voice socket: ${error?.message || error}`, ts: new Date().toLocaleTimeString() });
        }
    }

    voiceRoomSummary() {
        const roomLabel = this.voice.roomType === 'channel'
            ? (this.currentChannel() ? `#${this.currentChannel().name}` : 'Голосовой канал')
            : this.voice.roomType === 'dm'
                ? `Звонок с ${this.voice.targetUser || this.voice.inviter || ''}`.trim()
                : 'Голос';
        return roomLabel;
    }

    resetVoiceState({ preserveInvite = false } = {}) {
        this.voiceTrace('reset-state', { preserveInvite, roomId: this.voice.roomId || '', roomType: this.voice.roomType || '', status: this.voice.status || '' });
        for (const entry of this.voice.peerConnections.values()) {
            if (entry.reconnectTimer) {
                clearTimeout(entry.reconnectTimer);
                entry.reconnectTimer = null;
            }
            if (entry.healthTimer) {
                clearTimeout(entry.healthTimer);
                entry.healthTimer = null;
            }
            if (entry.statsTimer) {
                clearInterval(entry.statsTimer);
                entry.statsTimer = null;
            }
            try { entry.pc?.close(); } catch (e) {}
        }
        this.voice.peerConnections.clear();
        for (const audio of this.voice.remoteAudios.values()) {
            try {
                audio.pause?.();
                if (audio.srcObject) {
                    audio.srcObject = null;
                }
                audio.remove?.();
            } catch (e) {}
        }
        this.voice.remoteAudios.clear();
        if (this.voice.localStream) {
            for (const track of this.voice.localStream.getTracks()) {
                try { track.stop(); } catch (e) {}
            }
        }
        this.voice.localStream = null;
        if (this.voice.audioContext) {
            try { this.voice.audioContext.close?.(); } catch (e) {}
        }
        this.voice.audioContext = null;
        this.voice.playbackUnlocked = false;
        this.voice.meterUiRenderedOnce = false;
        this.voice.meterLevels = { local: 0, remote: 0 };
        this.voice.meterLocal = null;
        this.voice.meterRemote.clear();
        if (this.voice.remotePlaybackNodes) {
            for (const node of this.voice.remotePlaybackNodes.values()) {
                try { node?.source?.disconnect?.(); } catch (e) {}
                try { node?.splitter?.disconnect?.(); } catch (e) {}
                try { node?.gain?.disconnect?.(); } catch (e) {}
            }
            this.voice.remotePlaybackNodes.clear();
        }
        this.stopVoiceMeterLoop();
        this.voice.traceLines = [];
        this.voice.roomId = '';
        this.voice.roomType = '';
        this.voice.serverId = '';
        this.voice.channelId = '';
        this.voice.targetUser = '';
        this.voice.inviter = '';
        this.voice.participants = [];
        this.voice.status = 'idle';
        this.voice.muted = false;
        this.voice.callTrack = null;
        if (!preserveInvite) {
            this.voice.incomingInvite = null;
            this.voice.outgoingInvite = null;
        }
        this.renderVoicePanel();
        this.renderMessages();
    }

    async ensureVoiceLocalStream() {
        if (this.voice.localStream) return this.voice.localStream;
        if (!this.voice.supported) {
            throw new Error('Голосовые звонки не поддерживаются в этом окружении');
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        this.voice.localStream = stream;
        this.voice.muted = false;
        this.voiceTrace('local-stream-ready', {
            tracks: stream.getTracks().map(track => `${track.kind}:${track.readyState}:${track.enabled ? 'on' : 'off'}`),
        });
        this.ensureVoiceMeterLoop();
        return stream;
    }

    async unlockVoicePlayback() {
        if (this.voice.playbackUnlocked) return true;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (AudioCtx) {
                if (!this.voice.audioContext) {
                    this.voice.audioContext = new AudioCtx();
                }
            if (this.voice.audioContext.state === 'suspended') {
                await this.voice.audioContext.resume();
            }
            }
            this.voice.playbackUnlocked = true;
            this.ensureVoiceMeterLoop();
            this.voiceTrace('audio-unlock', {
                contextState: this.voice.audioContext?.state || 'none',
            }, 'SUCCESS');
            return true;
        } catch (error) {
            this.voiceTrace('audio-unlock-failed', { error: error?.message || String(error) }, 'WARN');
            return false;
        }
    }

    getVoicePeerEntry(peer) {
        const name = String(peer || '').trim();
        if (!name) return null;
        let entry = this.voice.peerConnections.get(name);
        if (!entry) {
            this.voiceTrace('peer-create', {
                peer: name,
                roomId: this.voice.roomId || '',
                roomType: this.voice.roomType || '',
                supported: this.voice.supported,
            });
            entry = {
                pc: new RTCPeerConnection(this.getVoiceRtcConfig()),
                localTracksAttached: false,
                offerSent: false,
                pendingIceCandidates: [],
                statsTimer: null,
                healthTimer: null,
                audioSender: null,
                generatedIceCandidates: 0,
                receivedIceCandidates: 0,
            };
            const rtcConfig = entry.pc.getConfiguration?.() || this.getVoiceRtcConfig();
            this.voiceTrace('rtc-config', {
                peer: name,
                policy: rtcConfig.iceTransportPolicy || 'all',
                servers: (rtcConfig.iceServers || []).map(server => ({
                    urls: server.urls,
                    username: server.username ? 'set' : '',
                })),
            });
            entry.statsTimer = setInterval(() => this.sampleVoicePeerStats(name), 5000);
            entry.pc.onicecandidate = (event) => {
                if (event.candidate) {
                    entry.generatedIceCandidates = (entry.generatedIceCandidates || 0) + 1;
                    this.voiceTrace('ice-candidate', {
                        peer: name,
                        index: entry.generatedIceCandidates,
                        mid: event.candidate.sdpMid,
                        line: event.candidate.sdpMLineIndex,
                        protocol: this.describeIceCandidate(event.candidate.candidate).protocol,
                        candidateType: this.describeIceCandidate(event.candidate.candidate).type,
                        address: this.describeIceCandidate(event.candidate.candidate).address,
                    });
                    this.renderVoicePanel();
                } else {
                    this.voiceTrace('ice-candidate-end', {
                        peer: name,
                        count: entry.generatedIceCandidates || 0,
                        state: entry.pc.iceGatheringState,
                    });
                }
                if (!event.candidate || !this.voice.roomId) return;
                this.sendVoiceEvent({
                    type: 'voice_signal',
                    roomId: this.voice.roomId,
                    roomType: this.voice.roomType,
                    serverId: this.voice.serverId,
                    channelId: this.voice.channelId,
                    to: name,
                    signal: {
                        type: 'ice',
                        candidate: {
                            candidate: event.candidate.candidate,
                            sdpMid: event.candidate.sdpMid,
                            sdpMLineIndex: event.candidate.sdpMLineIndex,
                            usernameFragment: event.candidate.usernameFragment || null,
                        },
                    },
                });
            };
            entry.pc.onicecandidateerror = (event) => {
                this.voiceTrace('ice-candidate-error', {
                    peer: name,
                    errorCode: event?.errorCode || '',
                    errorText: event?.errorText || '',
                    url: event?.url || '',
                    roomId: this.voice.roomId || '',
                }, 'WARN');
            };
            entry.pc.onicegatheringstatechange = () => {
                this.voiceTrace('ice-gathering', { peer: name, state: entry.pc.iceGatheringState, roomId: this.voice.roomId || '' });
            };
            entry.pc.oniceconnectionstatechange = () => {
                this.voiceTrace('ice-connection', { peer: name, state: entry.pc.iceConnectionState, roomId: this.voice.roomId || '' });
            };
            entry.pc.onsignalingstatechange = () => {
                this.voiceTrace('signaling-state', { peer: name, state: entry.pc.signalingState, roomId: this.voice.roomId || '' });
            };
            entry.pc.ontrack = (event) => {
                const stream = event.streams?.[0] || new MediaStream([event.track]);
                const track = event.track;
                if (track) {
                    track.onunmute = () => this.voiceTrace('remote-track-unmute', { peer: name, kind: track.kind, readyState: track.readyState }, 'INFO');
                    track.onmute = () => this.voiceTrace('remote-track-mute', { peer: name, kind: track.kind, readyState: track.readyState }, 'WARN');
                    track.onended = () => this.voiceTrace('remote-track-ended', { peer: name, kind: track.kind, readyState: track.readyState }, 'WARN');
                }
                this.voiceTrace('remote-track', {
                    peer: name,
                    kind: event.track?.kind || 'unknown',
                    readyState: event.track?.readyState || '',
                    streamId: stream.id || '',
                    transceiverDirection: event.transceiver?.direction || '',
                    transceiverCurrentDirection: event.transceiver?.currentDirection || '',
                    receiverTrack: event.receiver?.track ? `${event.receiver.track.kind}:${event.receiver.track.readyState}:${event.receiver.track.enabled ? 'on' : 'off'}` : '',
                    tracks: stream.getTracks().map(t => `${t.kind}:${t.readyState}:${t.enabled ? 'on' : 'off'}`),
                });
                this.attachRemoteVoiceStream(name, stream);
            };
            entry.pc.onconnectionstatechange = () => {
                const state = entry.pc.connectionState;
                if (entry.lastConnectionState !== state) {
                    this.voiceTrace('pc-state', { peer: name, from: entry.lastConnectionState || '', to: state, roomId: this.voice.roomId || '' });
                    entry.lastConnectionState = state;
                }
                if (state === 'connected' || state === 'completed') {
                    if (entry.reconnectTimer) {
                        clearTimeout(entry.reconnectTimer);
                        entry.reconnectTimer = null;
                    }
                    if (entry.healthTimer) {
                        clearTimeout(entry.healthTimer);
                        entry.healthTimer = null;
                    }
                    if (!entry.statsTimer) {
                        entry.statsTimer = setInterval(() => this.sampleVoicePeerStats(name), 10000);
                    }
                    this.voice.status = 'connected';
                    if (this.voice.callTrack && !this.voice.callTrack.connectedAt) {
                        this.voice.callTrack.connectedAt = Date.now();
                        this.voice.callTrack.outcome = 'connected';
                    }
                    this.renderVoicePanel();
                    return;
                }
                if (state === 'connecting' || state === 'checking') {
                    if (entry.reconnectTimer) {
                        clearTimeout(entry.reconnectTimer);
                        entry.reconnectTimer = null;
                    }
                    if (entry.healthTimer) {
                        clearTimeout(entry.healthTimer);
                        entry.healthTimer = null;
                    }
                    if (this.voice.status !== 'connected') {
                        this.voice.status = 'connecting';
                        this.renderVoicePanel();
                    }
                    const isDmCall = this.voice.roomType === 'dm';
                    const shouldWatchHealth = isDmCall && String(this.voice.callTrack?.direction || '').trim() === 'outgoing';
                    if (shouldWatchHealth && !entry.healthTimer) {
                        entry.healthTimer = setTimeout(async () => {
                            entry.healthTimer = null;
                            const currentState = entry.pc?.connectionState || '';
                            const currentIce = entry.pc?.iceConnectionState || '';
                            const stats = entry.lastStats || {};
                            const hasTraffic = Number(stats.inBytes || 0) > 0 || Number(stats.outBytes || 0) > 0;
                            if (!this.voice.roomId) return;
                            if (['connected', 'completed'].includes(currentState)) return;
                            if (hasTraffic) return;
                            if (!['new', 'checking', 'connecting'].includes(currentState) && !['new', 'checking'].includes(currentIce)) return;
                            this.voiceTrace('health-restart', {
                                peer: name,
                                roomId: this.voice.roomId || '',
                                state: currentState,
                                ice: currentIce,
                                hasTraffic,
                            }, 'WARN');
                            try {
                                await this.restartVoicePeer(name);
                            } catch (error) {
                                this.addLogEntry({
                                    type: 'WARN',
                                    msg: error?.message || `Не удалось выполнить ICE restart для ${name}`,
                                    ts: new Date().toLocaleTimeString(),
                                });
                            }
                        }, 8000);
                    }
                    return;
                }
                if (state === 'disconnected' || state === 'failed') {
                    this.addLogEntry({ type: 'WARN', msg: `Voice peer ${name} connection ${state}`, ts: new Date().toLocaleTimeString() });
                    if (entry.reconnectTimer) {
                        clearTimeout(entry.reconnectTimer);
                    }
                    if (entry.healthTimer) {
                        clearTimeout(entry.healthTimer);
                        entry.healthTimer = null;
                    }
                    if (entry.statsTimer) {
                        clearInterval(entry.statsTimer);
                        entry.statsTimer = null;
                    }
                    const isDmCall = this.voice.roomType === 'dm';
                    const allowAutoRestart = !isDmCall || String(this.voice.callTrack?.direction || '').trim() === 'outgoing';
                    if (allowAutoRestart) {
                        const delay = state === 'failed' ? 8000 : 10000;
                        entry.reconnectTimer = setTimeout(async () => {
                            entry.reconnectTimer = null;
                            if (!this.voice.roomId) return;
                            if (!['disconnected', 'failed'].includes(entry.pc.connectionState)) return;
                            try {
                                await this.restartVoicePeer(name);
                            } catch (error) {
                                this.addLogEntry({ type: 'WARN', msg: error?.message || `Не удалось восстановить голосовую связь с ${name}`, ts: new Date().toLocaleTimeString() });
                            }
                        }, delay);
                    }
                    if (!isDmCall && this.voice.status !== 'connected') {
                        this.voice.status = 'connecting';
                        this.renderVoicePanel();
                    }
                }
            };
            this.voice.peerConnections.set(name, entry);
        }
        return entry;
    }

    async flushPendingVoiceIceCandidates(entry, peer) {
        if (!entry || !entry.pendingIceCandidates?.length) return;
        const pending = entry.pendingIceCandidates.splice(0, entry.pendingIceCandidates.length);
        this.voiceTrace('ice-flush', { peer, count: pending.length, roomId: this.voice.roomId || '' });
        for (const candidate of pending) {
            try {
                await entry.pc.addIceCandidate(candidate);
            } catch (e) {
                console.warn(`Failed to flush ICE candidate for ${peer}`, e);
            }
        }
    }

    async sampleVoicePeerStats(peer) {
        const name = String(peer || '').trim();
        if (!name) return;
        const entry = this.voice.peerConnections.get(name);
        if (!entry?.pc) return;
        try {
            const stats = await entry.pc.getStats();
            const summary = {
                peer: name,
                connection: entry.pc.connectionState,
                ice: entry.pc.iceConnectionState,
                signaling: entry.pc.signalingState,
                localCandidateCount: entry.generatedIceCandidates || 0,
                remoteCandidateCount: entry.receivedIceCandidates || 0,
            };
            const candidatesById = {};
            stats.forEach(report => {
                if (report.type === 'outbound-rtp' && report.kind === 'audio') {
                    summary.outBytes = report.bytesSent;
                    summary.outPackets = report.packetsSent;
                    summary.outAudioLevel = report.audioLevel;
                    summary.outHeaderBytes = report.headerBytesSent;
                }
                if (report.type === 'inbound-rtp' && report.kind === 'audio') {
                    summary.inBytes = report.bytesReceived;
                    summary.inPackets = report.packetsReceived;
                    summary.inAudioLevel = report.audioLevel;
                    summary.inJitter = report.jitter;
                    summary.inHeaderBytes = report.headerBytesReceived;
                }
                if (report.type === 'track' && report.kind === 'audio') {
                    summary.trackAudioLevel = report.audioLevel;
                    summary.trackMuted = report.muted;
                    summary.trackEnded = report.ended;
                }
                if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                    summary.candidatePair = {
                        local: report.localCandidateId || '',
                        remote: report.remoteCandidateId || '',
                        currentRoundTripTime: report.currentRoundTripTime,
                        availableOutgoingBitrate: report.availableOutgoingBitrate,
                        bytesSent: report.bytesSent,
                        bytesReceived: report.bytesReceived,
                    };
                }
                if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
                    const candidate = {
                        candidateType: report.candidateType,
                        ip: report.ip || report.address,
                        port: report.port,
                        protocol: report.protocol,
                        priority: report.priority,
                    };
                    candidatesById[report.id] = candidate;
                    summary[`${report.type.replace('-', '')}_${report.id || 'unknown'}`] = candidate;
                }
            });
            if (summary.candidatePair) {
                const local = candidatesById[summary.candidatePair.local];
                const remote = candidatesById[summary.candidatePair.remote];
                summary.candidatePair.localLabel = local ? `${local.candidateType}/${local.protocol}/${local.ip || ''}:${local.port || ''}` : summary.candidatePair.local;
                summary.candidatePair.remoteLabel = remote ? `${remote.candidateType}/${remote.protocol}/${remote.ip || ''}:${remote.port || ''}` : summary.candidatePair.remote;
            }
            entry.lastStats = summary;
            entry.lastStatsAt = Date.now();
            this.voiceTrace('rtc-stats', summary);
        } catch (error) {
            this.voiceTrace('rtc-stats-error', { peer: name, error: error?.message || String(error) }, 'WARN');
        }
    }

    ensureVoiceAudioContext() {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        if (!this.voice.audioContext) {
            this.voice.audioContext = new AudioCtx();
        }
        return this.voice.audioContext;
    }

    ensureVoiceMeterLoop() {
        if (this.voice.meterRaf) return;
        const tick = async () => {
            if (!this.voice.roomId && !this.voice.localStream && this.voice.peerConnections.size === 0) {
                this.voice.meterRaf = 0;
                return;
            }
            if (document.hidden) {
                this.voice.meterRaf = setTimeout(tick, 1000);
                return;
            }
            try {
                await this.updateVoiceMeters();
            } catch (error) {
                this.voiceTrace('meter-update-error', { error: error?.message || String(error) }, 'WARN');
            }
            this.voice.meterRaf = setTimeout(tick, 125);
        };
        this.voice.meterRaf = setTimeout(tick, 0);
    }

    stopVoiceMeterLoop() {
        if (this.voice.meterRaf) {
            clearTimeout(this.voice.meterRaf);
            this.voice.meterRaf = 0;
        }
    }

    computeAnalyserLevel(analyser) {
        if (!analyser) return 0;
        const bufferLength = analyser.fftSize;
        const data = new Uint8Array(bufferLength);
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) {
            const normalized = (value - 128) / 128;
            sum += normalized * normalized;
        }
        const rms = Math.sqrt(sum / data.length);
        return Math.max(0, Math.min(1, rms * 2.8));
    }

    ensureMeterEntry(key, stream) {
        const ctx = this.ensureVoiceAudioContext();
        if (!ctx || !stream) return null;
        if (key === 'local') {
            const currentId = stream.id || '';
            if (!this.voice.meterLocal || this.voice.meterLocal.streamId !== currentId) {
                try {
                    if (this.voice.meterLocal?.source) this.voice.meterLocal.source.disconnect?.();
                    if (this.voice.meterLocal?.analyser) this.voice.meterLocal.analyser.disconnect?.();
                } catch (e) {}
                const source = ctx.createMediaStreamSource(stream);
                const analyser = ctx.createAnalyser();
                analyser.fftSize = 512;
                analyser.smoothingTimeConstant = 0.8;
                source.connect(analyser);
                this.voice.meterLocal = {
                    streamId: currentId,
                    source,
                    analyser,
                    data: new Uint8Array(analyser.fftSize),
                };
                this.voiceTrace('meter-local-ready', { streamId: currentId, tracks: stream.getTracks().length });
            }
            return this.voice.meterLocal;
        }

        const peer = String(key || '').trim();
        if (!peer) return null;
        const currentId = stream.id || '';
        const existing = this.voice.meterRemote.get(peer);
        if (!existing || existing.streamId !== currentId) {
            try {
                if (existing?.source) existing.source.disconnect?.();
                if (existing?.analyser) existing.analyser.disconnect?.();
            } catch (e) {}
            const source = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.8;
            source.connect(analyser);
            const next = {
                streamId: currentId,
                source,
                analyser,
                data: new Uint8Array(analyser.fftSize),
            };
            this.voice.meterRemote.set(peer, next);
            this.voiceTrace('meter-remote-ready', { peer, streamId: currentId, tracks: stream.getTracks().length });
            return next;
        }
        return existing;
    }

    ensureRemotePlaybackNode(peer, stream) {
        const ctx = this.ensureVoiceAudioContext();
        const name = String(peer || '').trim();
        if (!ctx || !name || !stream) return null;
        const currentId = stream.id || '';
        const existing = this.voice.remotePlaybackNodes?.get(name);
        if (existing && existing.streamId === currentId) return existing;
        try {
            if (existing?.source) existing.source.disconnect?.();
            if (existing?.splitter) existing.splitter.disconnect?.();
            if (existing?.gain) existing.gain.disconnect?.();
        } catch (e) {}
        try {
            const source = ctx.createMediaStreamSource(stream);
            const splitter = ctx.createGain();
            const gain = ctx.createGain();
            splitter.gain.value = 1;
            gain.gain.value = 1;
            source.connect(splitter);
            source.connect(gain);
            splitter.connect(ctx.destination);
            const next = {
                streamId: currentId,
                source,
                splitter,
                gain,
            };
            this.voice.remotePlaybackNodes.set(name, next);
            this.voiceTrace('remote-webaudio-ready', {
                peer: name,
                streamId: currentId,
                contextState: ctx.state || '',
                tracks: stream.getTracks().map(t => `${t.kind}:${t.readyState}:${t.enabled ? 'on' : 'off'}`),
            }, 'SUCCESS');
            return next;
        } catch (error) {
            this.voiceTrace('remote-webaudio-error', { peer: name, error: error?.message || String(error) }, 'ERROR');
            return null;
        }
    }

    updateVoiceMeterDom(kind, percent) {
        const fill = document.getElementById(kind === 'local' ? 'voiceMicLevelFill' : 'voiceServerLevelFill');
        const text = document.getElementById(kind === 'local' ? 'voiceMicLevelText' : 'voiceServerLevelText');
        const row = document.getElementById(kind === 'local' ? 'voiceMicMeter' : 'voiceServerMeter');
        const next = Math.max(0, Math.min(100, Math.round(percent || 0)));
        if (fill) {
            fill.style.width = `${next}%`;
        }
        if (text) {
            text.textContent = `${next}%`;
        }
        if (row) {
            row.dataset.level = String(next);
        }
    }

    async updateVoiceMeters() {
        const localMeter = this.voice.localStream ? this.ensureMeterEntry('local', this.voice.localStream) : null;
        const remoteStreams = [];
        for (const [peer, audio] of this.voice.remoteAudios.entries()) {
            const stream = audio?.srcObject;
            if (stream instanceof MediaStream) {
                remoteStreams.push({ peer, stream });
            }
        }
        const remoteMeters = remoteStreams
            .map(({ peer, stream }) => ({ peer, meter: this.ensureMeterEntry(peer, stream) }))
            .filter(item => item.meter);

        let localLevel = 0;
        if (localMeter?.analyser) {
            localLevel = this.computeAnalyserLevel(localMeter.analyser);
        }

        let remoteLevel = 0;
        for (const item of remoteMeters) {
            const level = this.computeAnalyserLevel(item.meter.analyser);
            remoteLevel = Math.max(remoteLevel, level);
        }

        const nextLocal = Math.round(localLevel * 100);
        const nextRemote = Math.round(remoteLevel * 100);
        const changed = nextLocal !== this.voice.meterLevels.local || nextRemote !== this.voice.meterLevels.remote;
        this.voice.meterLevels = { local: nextLocal, remote: nextRemote };
        if (changed || !this.voice.meterUiRenderedOnce) {
            this.updateVoiceMeterDom('local', nextLocal);
            this.updateVoiceMeterDom('remote', nextRemote);
            this.voice.meterUiRenderedOnce = true;
        }
    }

    async attachLocalVoiceTracks(peer) {
        const entry = this.getVoicePeerEntry(peer);
        if (!entry || !this.voice.localStream || entry.localTracksAttached) return;
        const tracks = this.voice.localStream.getTracks();
        this.voiceTrace('attach-local-tracks', { peer, tracks: tracks.length, roomId: this.voice.roomId || '' });
        const audioTracks = this.voice.localStream.getAudioTracks();
        if (entry.audioSender && audioTracks.length) {
            const track = audioTracks[0];
            try {
                if (entry.audioSender.track !== track) {
                    await entry.audioSender.replaceTrack(track);
                }
                if (typeof entry.audioSender.setStreams === 'function') {
                    try {
                        entry.audioSender.setStreams(this.voice.localStream);
                    } catch (setStreamsError) {
                        this.voiceTrace('set-streams-error', { peer, error: setStreamsError?.message || String(setStreamsError) }, 'WARN');
                    }
                }
                this.voiceTrace('attach-local-sender', {
                    peer,
                    track: `${track.kind}:${track.readyState}:${track.enabled ? 'on' : 'off'}`,
                    senderTrack: entry.audioSender.track ? `${entry.audioSender.track.kind}:${entry.audioSender.track.readyState}:${entry.audioSender.track.enabled ? 'on' : 'off'}` : 'none',
                });
            } catch (error) {
                this.voiceTrace('attach-local-sender-error', { peer, error: error?.message || String(error) }, 'WARN');
            }
        } else {
            for (const track of tracks) {
                const sender = entry.pc.addTrack(track, this.voice.localStream);
                entry.audioSender = sender;
                this.voiceTrace('attach-local-track-added', {
                    peer,
                    track: `${track.kind}:${track.readyState}:${track.enabled ? 'on' : 'off'}`,
                    senderTrack: sender?.track ? `${sender.track.kind}:${sender.track.readyState}:${sender.track.enabled ? 'on' : 'off'}` : 'none',
                });
            }
        }
        entry.localTracksAttached = true;
        this.ensureMeterEntry('local', this.voice.localStream);
        this.ensureVoiceMeterLoop();
    }

    attachRemoteVoiceStream(peer, stream) {
        const name = String(peer || '').trim();
        if (!name || !stream) return;
        let audio = this.voice.remoteAudios.get(name);
        if (!audio) {
            audio = document.createElement('audio');
            audio.autoplay = true;
            audio.playsInline = true;
            audio.hidden = true;
            audio.preload = 'auto';
            audio.muted = true;
            audio.defaultMuted = true;
            audio.volume = 0;
            audio.dataset.peer = name;
            audio.addEventListener('play', () => this.voiceTrace('remote-audio-play', { peer: name, muted: audio.muted, volume: audio.volume }, 'INFO'));
            audio.addEventListener('playing', () => this.voiceTrace('remote-audio-playing', { peer: name, muted: audio.muted, volume: audio.volume }, 'SUCCESS'));
            audio.addEventListener('pause', () => this.voiceTrace('remote-audio-pause', { peer: name }, 'WARN'));
            audio.addEventListener('ended', () => this.voiceTrace('remote-audio-ended', { peer: name }, 'WARN'));
            audio.addEventListener('error', () => this.voiceTrace('remote-audio-error', { peer: name, error: audio.error?.message || audio.error?.code || 'unknown' }, 'ERROR'));
            document.body.appendChild(audio);
            this.voice.remoteAudios.set(name, audio);
        }
        audio.srcObject = stream;
        this.ensureMeterEntry(name, stream);
        this.ensureRemotePlaybackNode(name, stream);
        this.ensureVoiceMeterLoop();
        this.voiceTrace('remote-audio-attach', {
            peer: name,
            streamId: stream.id || '',
            tracks: stream.getTracks().map(t => `${t.kind}:${t.readyState}:${t.enabled ? 'on' : 'off'}`),
            readyState: audio.readyState,
            paused: audio.paused,
            muted: audio.muted,
        });
        const attemptPlay = () => audio.play?.().catch(error => this.voiceTrace('remote-audio-play-failed', { peer: name, error: error?.message || String(error) }, 'WARN'));
        attemptPlay();
        requestAnimationFrame(() => attemptPlay());
        setTimeout(attemptPlay, 250);
    }

    closeVoicePeer(peer) {
        const name = String(peer || '').trim();
        if (!name) return;
        const entry = this.voice.peerConnections.get(name);
        if (entry) {
            this.voiceTrace('peer-close', { peer: name, roomId: this.voice.roomId || '' });
            if (entry.reconnectTimer) {
                clearTimeout(entry.reconnectTimer);
                entry.reconnectTimer = null;
            }
            if (entry.healthTimer) {
                clearTimeout(entry.healthTimer);
                entry.healthTimer = null;
            }
            if (entry.statsTimer) {
                clearInterval(entry.statsTimer);
                entry.statsTimer = null;
            }
            entry.audioSender = null;
            try { entry.pc.close(); } catch (e) {}
            this.voice.peerConnections.delete(name);
        }
        const audio = this.voice.remoteAudios.get(name);
        if (audio) {
            try {
                audio.pause?.();
                audio.srcObject = null;
                audio.remove?.();
            } catch (e) {}
            this.voice.remoteAudios.delete(name);
        }
        const playbackNode = this.voice.remotePlaybackNodes?.get(name);
        if (playbackNode) {
            try { playbackNode.source?.disconnect?.(); } catch (e) {}
            try { playbackNode.splitter?.disconnect?.(); } catch (e) {}
            try { playbackNode.gain?.disconnect?.(); } catch (e) {}
            this.voice.remotePlaybackNodes.delete(name);
        }
        if (this.voice.meterRemote.has(name)) {
            const meter = this.voice.meterRemote.get(name);
            try {
                meter?.source?.disconnect?.();
                meter?.analyser?.disconnect?.();
            } catch (e) {}
            this.voice.meterRemote.delete(name);
        }
        this.voice.meterLevels.remote = 0;
    }

    async sendVoiceOffer(peer) {
        const entry = this.getVoicePeerEntry(peer);
        if (!entry || !this.voice.localStream) return;
        if (entry.offerSent) return;
        this.voiceTrace('send-offer', { peer, roomId: this.voice.roomId || '', roomType: this.voice.roomType || '' });
        await this.attachLocalVoiceTracks(peer);
        const offer = await entry.pc.createOffer();
        await entry.pc.setLocalDescription(offer);
        entry.offerSent = true;
        this.voiceTrace('offer-created', {
            peer,
            roomId: this.voice.roomId || '',
            sdpType: entry.pc.localDescription?.type || 'offer',
            sdpLength: entry.pc.localDescription?.sdp?.length || 0,
        });
        this.sendVoiceEvent({
            type: 'voice_signal',
            roomId: this.voice.roomId,
            roomType: this.voice.roomType,
            serverId: this.voice.serverId,
            channelId: this.voice.channelId,
            to: peer,
            signal: {
                type: 'offer',
                sdp: {
                    type: entry.pc.localDescription?.type || 'offer',
                    sdp: entry.pc.localDescription?.sdp || '',
                },
            },
        });
    }

    async restartVoicePeer(peer) {
        const name = String(peer || '').trim();
        if (!name || !this.voice.roomId) return;
        const entry = this.getVoicePeerEntry(name);
        if (!entry || !this.voice.localStream) return;
        if (entry.healthTimer) {
            clearTimeout(entry.healthTimer);
            entry.healthTimer = null;
        }
        this.voiceTrace('restart-offer', { peer: name, roomId: this.voice.roomId || '' });
        await this.attachLocalVoiceTracks(name);
        const offer = await entry.pc.createOffer({ iceRestart: true });
        await entry.pc.setLocalDescription(offer);
        entry.offerSent = true;
        this.voiceTrace('offer-restart-created', {
            peer: name,
            roomId: this.voice.roomId || '',
            sdpType: entry.pc.localDescription?.type || 'offer',
            sdpLength: entry.pc.localDescription?.sdp?.length || 0,
        });
        this.sendVoiceEvent({
            type: 'voice_signal',
            roomId: this.voice.roomId,
            roomType: this.voice.roomType,
            serverId: this.voice.serverId,
            channelId: this.voice.channelId,
            to: name,
            signal: {
                type: 'offer',
                sdp: {
                    type: entry.pc.localDescription?.type || 'offer',
                    sdp: entry.pc.localDescription?.sdp || '',
                },
            },
        });
    }

    async syncVoicePeers() {
        const participants = Array.isArray(this.voice.participants) ? this.voice.participants : [];
        const peers = participants
            .map(name => String(name || '').trim())
            .filter(Boolean)
            .filter(name => name !== this.myName());
        const nextPeers = new Set(peers);
        this.voiceTrace('sync-peers', {
            roomId: this.voice.roomId || '',
            roomType: this.voice.roomType || '',
            status: this.voice.status || '',
            me: this.myName(),
            peers,
            localStream: !!this.voice.localStream,
        });

        for (const peer of this.voice.peerConnections.keys()) {
            if (!nextPeers.has(peer)) {
                this.closeVoicePeer(peer);
            }
        }

        for (const peer of peers) {
            const entry = this.getVoicePeerEntry(peer);
            await this.attachLocalVoiceTracks(peer);
            if (this.shouldInitiateVoiceOffer(peer) && this.voice.localStream && !entry.offerSent) {
                try {
                    await this.sendVoiceOffer(peer);
                } catch (e) {
                    this.addLogEntry({ type: 'ERROR', msg: `Не удалось начать голосовой обмен с ${peer}`, ts: new Date().toLocaleTimeString() });
                }
            }
        }
        this.renderVoicePanel();
    }

    async joinVoiceChannel({ serverId = null, channelId = null } = {}) {
        const server = this.currentServer();
        const channel = server && channelId ? (server.channels || []).find(ch => ch.id === channelId) : this.currentChannel();
        const sid = String(serverId || server?.id || '').trim();
        const cid = String(channelId || channel?.id || '').trim();
        if (!sid || !cid) return;
        if (!this.isVoiceChannel(channel)) {
            return;
        }
        const roomId = this.voiceRoomKeyForChannel(sid, cid);
        this.voice.roomId = roomId;
        this.voice.roomType = 'channel';
        this.voice.serverId = sid;
        this.voice.channelId = cid;
        this.voice.status = 'connecting';
        this.voice.participants = [];
        this.sendVoiceEvent({
            type: 'voice_join',
            roomId,
            roomType: 'channel',
            serverId: sid,
            channelId: cid,
        });
        this.renderVoicePanel();
    }

    async leaveVoiceRoom({ announce = true, outcome = 'completed' } = {}) {
        const roomId = String(this.voice.roomId || '').trim();
        this.voiceTrace('leave-room', {
            roomId,
            roomType: this.voice.roomType || '',
            announce,
            outcome,
            participants: Array.isArray(this.voice.participants) ? this.voice.participants : [],
        });
        if (this.voice.roomType === 'dm' && roomId && this.voice.callTrack && !this.voice.callTrack.recorded) {
            this.recordVoiceCallHistory({ outcome, endedAt: Date.now() });
        }
        if (announce && roomId) {
            this.sendVoiceEvent({
                type: 'voice_leave',
                roomId,
                roomType: this.voice.roomType,
                serverId: this.voice.serverId,
                channelId: this.voice.channelId,
            });
        }
        this.resetVoiceState();
    }

    async startDirectCall(peer) {
        const target = String(peer || '').trim();
        if (!target) return;
        const me = String(this.myName() || '').trim();
        const roomId = this.makeDmCallRoomId(target);
        if (!roomId) return;
        this.voiceTrace('start-dm-call', { target, me, roomId });
        await this.unlockVoicePlayback();
        this.voice.callTrack = {
            roomId,
            peer: target,
            roomType: 'dm',
            direction: 'outgoing',
            startedAt: Date.now(),
            connectedAt: 0,
            endedAt: 0,
            outcome: 'calling',
            recorded: false,
        };
        this.voice.outgoingInvite = {
            roomId,
            target,
        };
        this.voice.roomId = roomId;
        this.voice.roomType = 'dm';
        this.voice.targetUser = target;
        this.voice.inviter = me;
        this.voice.participants = [me, target].filter(Boolean);
        this.voice.status = 'calling';
        this.sendVoiceEvent({
            type: 'voice_call_invite',
            roomId,
            roomType: 'dm',
            target,
        });
        this.renderVoicePanel();
        try {
            await this.ensureVoiceLocalStream();
            await this.syncVoicePeers();
        } catch (error) {
            this.addLogEntry({
                type: 'WARN',
                msg: error?.message || 'Не удалось подготовить микрофон для звонка',
                ts: new Date().toLocaleTimeString(),
            });
        }
    }

    async acceptIncomingCall() {
        const invite = this.voice.incomingInvite;
        if (!invite?.roomId || !invite?.from) return;
        const me = String(this.myName() || '').trim();
        this.voiceTrace('accept-incoming', { roomId: invite.roomId, from: invite.from, me });
        await this.unlockVoicePlayback();
        this.voice.roomId = String(invite.roomId || '').trim();
        this.voice.roomType = 'dm';
        this.voice.targetUser = String(invite.from || '').trim();
        this.voice.inviter = String(invite.from || '').trim();
        this.voice.participants = [me, String(invite.from || '').trim()].filter(Boolean);
        this.voice.status = 'connecting';
        this.voice.callTrack = {
            roomId: invite.roomId,
            peer: invite.from,
            roomType: 'dm',
            direction: 'incoming',
            startedAt: Date.now(),
            connectedAt: 0,
            endedAt: 0,
            outcome: 'connecting',
            recorded: false,
        };
        this.addLogEntry({
            type: 'INFO',
            msg: `Принимаем звонок ${this.voice.roomId} от ${invite.from}`,
            ts: new Date().toLocaleTimeString(),
        });
        this.renderVoicePanel();
        this.sendVoiceEvent({
            type: 'voice_call_accept',
            roomId: invite.roomId,
            inviter: invite.from,
        });
        this.renderVoicePanel();
        try {
            await this.ensureVoiceLocalStream();
            await this.syncVoicePeers();
        } catch (error) {
            this.addLogEntry({
                type: 'WARN',
                msg: error?.message || 'Не удалось подготовить микрофон для ответа на звонок',
                ts: new Date().toLocaleTimeString(),
            });
        }
    }

    async rejectIncomingCall() {
        const invite = this.voice.incomingInvite;
        if (!invite?.roomId || !invite?.from) return;
        this.voiceTrace('reject-incoming', { roomId: invite.roomId, from: invite.from });
        this.sendVoiceEvent({
            type: 'voice_call_reject',
            roomId: invite.roomId,
            inviter: invite.from,
        });
        this.recordVoiceCallHistory({ outcome: 'rejected', endedAt: Date.now() });
        this.resetVoiceState({ preserveInvite: false });
    }

    toggleVoiceMute() {
        const stream = this.voice.localStream;
        if (!stream) return;
        const nextMuted = !this.voice.muted;
        for (const track of stream.getAudioTracks()) {
            track.enabled = !nextMuted;
        }
        this.voice.muted = nextMuted;
        this.renderVoicePanel();
    }

    recordVoiceCallHistory({ outcome = 'completed', endedAt = Date.now() } = {}) {
        const call = this.voice.callTrack;
        if (!call || call.recorded || call.roomType === 'channel') return;
        const peer = String(call.peer || this.voice.targetUser || this.voice.inviter || '').trim();
        if (!peer) return;
        const direction = String(call.direction || '').trim() || 'outgoing';
        const startMs = Number(call.connectedAt || call.startedAt || endedAt) || endedAt;
        const endMs = Number(endedAt || Date.now()) || Date.now();
        const durationMs = Math.max(0, endMs - startMs);
        const message = {
            id: `call-${call.roomId || peer}-${endMs}`,
            kind: 'call',
            sender: direction === 'outgoing' ? this.myName() : peer,
            receiver: direction === 'outgoing' ? peer : this.myName(),
            text: '',
            attachments: [],
            timestamp: new Date(endMs).toISOString(),
            call: {
                roomId: call.roomId || '',
                peer,
                direction,
                outcome,
                startedAt: new Date(startMs).toISOString(),
                connectedAt: call.connectedAt ? new Date(call.connectedAt).toISOString() : '',
                endedAt: new Date(endMs).toISOString(),
                durationMs,
            },
        };
        const convo = peer;
        this.initChat(convo);
        const arr = this.S.chats[convo];
        const key = this.messageRenderKey(message);
        const exists = arr.some(m => this.messageRenderKey(m) === key);
        if (!exists) {
            arr.push(message);
            arr.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        }
        call.recorded = true;
        this.voice.callTrack = null;
        this.renderContacts();
        if (this.S.navMode === 'dm' && this.S.current === convo) {
            this.renderMessages();
        }
    }

    async handleVoiceSignal(signal = {}) {
        const roomId = String(signal.roomId || '').trim();
        const from = String(signal.from || signal.sender || '').trim();
        const signalPayload = signal.signal || signal.payload || signal;
        if (!roomId || !from || !signalPayload) return;
        this.voiceTrace('signal-recv', {
            roomId,
            from,
            to: signal.to || '',
            signalType: signalPayload.type || '',
            roomType: signal.roomType || this.voice.roomType || '',
        });

        if (signalPayload.type === 'offer') {
            this.voice.roomId = roomId;
            this.voice.roomType = signal.roomType || this.voice.roomType || 'dm';
            this.voice.serverId = signal.serverId || this.voice.serverId || '';
            this.voice.channelId = signal.channelId || this.voice.channelId || '';
            this.voice.targetUser = signal.target || this.voice.targetUser || '';
            this.voice.inviter = signal.from || this.voice.inviter || '';
            this.voice.status = 'connecting';
            const entry = this.getVoicePeerEntry(from);
            try {
                await this.ensureVoiceLocalStream();
            } catch (error) {
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
            }
            await this.attachLocalVoiceTracks(from);
            this.voiceTrace('signal-offer-apply', { roomId, from, localStream: !!this.voice.localStream, peer: from });
            await entry.pc.setRemoteDescription(signalPayload.sdp);
            await this.flushPendingVoiceIceCandidates(entry, from);
            const answer = await entry.pc.createAnswer();
            await entry.pc.setLocalDescription(answer);
            this.voiceTrace('signal-answer-send', {
                roomId,
                from,
                peer: from,
                localDesc: entry.pc.localDescription?.type || 'answer',
                sdpLength: entry.pc.localDescription?.sdp?.length || 0,
            });
            this.sendVoiceEvent({
                type: 'voice_signal',
                roomId,
                roomType: this.voice.roomType,
                serverId: this.voice.serverId,
                channelId: this.voice.channelId,
                to: from,
                signal: {
                    type: 'answer',
                    sdp: {
                        type: entry.pc.localDescription?.type || 'answer',
                        sdp: entry.pc.localDescription?.sdp || '',
                    },
                },
            });
            this.voice.participants = Array.from(new Set([this.myName(), from].concat(this.voice.participants || [])));
            this.renderVoicePanel();
            return;
        }

        const entry = this.getVoicePeerEntry(from);
        if (signalPayload.type === 'answer') {
            this.voiceTrace('signal-answer-apply', {
                roomId,
                from,
                peer: from,
                remoteDesc: !!signalPayload.sdp,
                sdpType: signalPayload.sdp?.type || '',
                sdpLength: signalPayload.sdp?.sdp?.length || 0,
            });
            await entry.pc.setRemoteDescription(signalPayload.sdp);
            await this.flushPendingVoiceIceCandidates(entry, from);
            this.voice.status = 'connected';
            this.renderVoicePanel();
            return;
        }

        if (signalPayload.type === 'ice' && signalPayload.candidate) {
            try {
                entry.receivedIceCandidates = (entry.receivedIceCandidates || 0) + 1;
                const candidateInfo = this.describeIceCandidate(signalPayload.candidate.candidate || '');
                this.voiceTrace('signal-ice-recv', {
                    roomId,
                    from,
                    peer: from,
                    count: entry.receivedIceCandidates,
                    candidateType: candidateInfo.type,
                    protocol: candidateInfo.protocol,
                    address: candidateInfo.address,
                });
                if (entry.pc.remoteDescription) {
                    this.voiceTrace('signal-ice-apply', { roomId, from, peer: from, queued: false });
                    await entry.pc.addIceCandidate(signalPayload.candidate);
                } else {
                    entry.pendingIceCandidates = entry.pendingIceCandidates || [];
                    entry.pendingIceCandidates.push(signalPayload.candidate);
                    this.voiceTrace('signal-ice-queue', { roomId, from, peer: from, queued: true, queueSize: entry.pendingIceCandidates.length });
                }
            } catch (e) {
                console.warn('Failed to add ICE candidate', e);
                this.voiceTrace('signal-ice-error', { roomId, from, peer: from, error: e?.message || String(e) }, 'WARN');
            }
        }
    }

    async handleVoiceEvent(payload = {}) {
        const eventType = String(payload?.type || '').trim();
        if (!eventType) return;
        this.voiceTrace('event-recv', {
            eventType,
            roomId: payload.roomId || '',
            roomType: payload.roomType || '',
            from: payload.from || '',
            target: payload.target || '',
        });

        if (eventType === 'voice_call_invite') {
            const from = String(payload.from || '').trim();
            const roomId = String(payload.roomId || '').trim();
            this.voice.incomingInvite = {
                roomId,
                from,
                roomType: 'dm',
            };
            this.voice.inviter = from;
            this.voice.callTrack = {
                roomId,
                peer: from,
                roomType: 'dm',
                direction: 'incoming',
                startedAt: Date.now(),
                connectedAt: 0,
                endedAt: 0,
                outcome: 'incoming',
                recorded: false,
            };
            this.voice.outgoingInvite = null;
            this.voice.status = 'incoming';
            this.voiceTrace('incoming-invite', { roomId, from });
            this.renderVoicePanel();
            return;
        }

        if (eventType === 'voice_call_outgoing') {
            this.voice.outgoingInvite = {
                roomId: String(payload.roomId || '').trim(),
                target: String(payload.target || '').trim(),
            };
            this.voice.targetUser = String(payload.target || '').trim();
            this.voice.status = 'calling';
            this.voiceTrace('outgoing-ring', { roomId: this.voice.outgoingInvite.roomId, target: this.voice.targetUser });
            this.renderVoicePanel();
            return;
        }

        if (eventType === 'voice_signal') {
            this.voiceTrace('signal-event', {
                roomId: payload.roomId || '',
                from: payload.from || payload.sender || '',
                to: payload.to || '',
                signalType: payload.signal?.type || payload.payload?.type || '',
            });
            await this.handleVoiceSignal(payload);
            return;
        }

        if (eventType === 'voice_call_rejected') {
            if (this.voice.outgoingInvite?.roomId === String(payload.roomId || '').trim()) {
                this.voiceTrace('outgoing-rejected', { roomId: payload.roomId || '', from: payload.from || '' }, 'WARN');
                this.recordVoiceCallHistory({ outcome: 'rejected', endedAt: Date.now() });
                this.resetVoiceState({ preserveInvite: false });
            }
            return;
        }

        if (eventType === 'voice_call_cancelled') {
            if (this.voice.incomingInvite?.roomId === String(payload.roomId || '').trim()) {
                this.voiceTrace('incoming-cancelled', { roomId: payload.roomId || '', from: payload.from || '' }, 'WARN');
                this.recordVoiceCallHistory({ outcome: 'cancelled', endedAt: Date.now() });
                this.resetVoiceState({ preserveInvite: false });
            }
            return;
        }

        if (eventType === 'voice_call_accepted') {
            const roomId = String(payload.roomId || '').trim();
            const me = String(this.myName() || '').trim();
            const from = String(payload.from || '').trim();
            const target = String(payload.target || '').trim();
            const remotePeer = from && from !== me ? from : target;
            const callOwner = target || this.voice.inviter || '';
            const participants = Array.isArray(payload.participants)
                ? payload.participants.map(name => String(name || '').trim()).filter(Boolean)
                : [payload.from, payload.target].map(name => String(name || '').trim()).filter(Boolean);
            this.voice.roomId = roomId || this.voice.roomId;
            this.voice.roomType = 'dm';
            this.voice.targetUser = remotePeer || this.voice.targetUser || '';
            this.voice.inviter = callOwner || this.voice.inviter || '';
            this.voice.participants = participants.length ? participants : this.voice.participants;
            this.voice.status = 'connected';
            if (roomId && String(this.voice.outgoingInvite?.roomId || '').trim() === roomId) {
                this.voice.outgoingInvite = null;
            }
            if (roomId && String(this.voice.incomingInvite?.roomId || '').trim() === roomId) {
                this.voice.incomingInvite = null;
            }
            this.voiceTrace('call-accepted', { roomId, from, target, participants });
            if (this.voice.callTrack) {
                this.voice.callTrack.connectedAt = this.voice.callTrack.connectedAt || Date.now();
                this.voice.callTrack.outcome = 'connected';
            }
            this.renderVoicePanel();
            try {
                await this.ensureVoiceLocalStream();
            } catch (error) {
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
            }
            await this.syncVoicePeers();
            return;
        }

        if (eventType === 'voice_call_connected') {
            const roomId = String(payload.roomId || '').trim();
            const me = String(this.myName() || '').trim();
            const from = String(payload.from || '').trim();
            const target = String(payload.target || '').trim();
            const remotePeer = from && from !== me ? from : target;
            const callOwner = target || this.voice.inviter || '';
            const participants = Array.isArray(payload.participants)
                ? payload.participants.map(name => String(name || '').trim()).filter(Boolean)
                : [payload.from, payload.target].map(name => String(name || '').trim()).filter(Boolean);
            this.voice.roomId = roomId || this.voice.roomId;
            this.voice.roomType = 'dm';
            this.voice.targetUser = remotePeer || this.voice.targetUser || '';
            this.voice.inviter = callOwner || this.voice.inviter || '';
            this.voice.participants = participants.length ? participants : this.voice.participants;
            this.voice.status = 'connected';
            if (roomId && String(this.voice.outgoingInvite?.roomId || '').trim() === roomId) {
                this.voice.outgoingInvite = null;
            }
            if (roomId && String(this.voice.incomingInvite?.roomId || '').trim() === roomId) {
                this.voice.incomingInvite = null;
            }
            this.voiceTrace('call-connected', { roomId, from, target, participants }, 'SUCCESS');
            if (this.voice.callTrack) {
                this.voice.callTrack.connectedAt = this.voice.callTrack.connectedAt || Date.now();
                this.voice.callTrack.outcome = 'connected';
            }
            this.renderVoicePanel();
            try {
                await this.ensureVoiceLocalStream();
            } catch (error) {
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
            }
            await this.syncVoicePeers();
            return;
        }

        if (eventType === 'voice_error') {
            this.addLogEntry({
                type: 'ERROR',
                msg: String(payload.message || 'Ошибка voice'),
                ts: new Date().toLocaleTimeString(),
            });
            return;
        }

        if (eventType === 'voice_room_state') {
            const roomId = String(payload.roomId || '').trim();
            const participants = Array.isArray(payload.participants) ? payload.participants.map(name => String(name || '').trim()).filter(Boolean) : [];
            const currentRoomId = String(this.voice.roomId || '').trim();
            if (this.voice.roomType === 'dm' && currentRoomId && roomId && roomId !== currentRoomId) {
                this.voiceTrace('room-state-stale', { roomId, currentRoomId }, 'INFO');
                return;
            }
            this.voice.roomId = roomId;
            this.voice.roomType = String(payload.roomType || this.voice.roomType || '').trim();
            this.voice.serverId = String(payload.serverId || this.voice.serverId || '').trim();
            this.voice.channelId = String(payload.channelId || this.voice.channelId || '').trim();
            this.voice.participants = participants;
            this.voice.status = participants.includes(this.myName()) ? 'connected' : 'idle';
            this.voiceTrace('room-state', { roomId, roomType: this.voice.roomType || '', participants });
            if (participants.includes(this.myName()) && this.voice.callTrack && !this.voice.callTrack.connectedAt) {
                this.voice.callTrack.connectedAt = Date.now();
                this.voice.callTrack.outcome = 'connected';
            }
            if (String(this.voice.outgoingInvite?.roomId || '').trim() === roomId) {
                this.voice.outgoingInvite = null;
            }
            if (String(this.voice.incomingInvite?.roomId || '').trim() === roomId) {
                this.voice.incomingInvite = null;
            }
            if (participants.includes(this.myName())) {
                try {
                    await this.ensureVoiceLocalStream();
                } catch (error) {
                    this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
                }
                await this.syncVoicePeers();
            } else if (this.voice.roomType === 'dm' && this.voice.roomId === roomId && this.voice.callTrack) {
                this.voice.status = this.voice.status === 'idle' ? 'connecting' : this.voice.status;
            } else {
                this.voiceTrace('room-state-reset', { roomId, participants }, 'WARN');
                this.resetVoiceState({ preserveInvite: true });
            }
            this.renderVoicePanel();
            return;
        }

        if (eventType === 'voice_call_ended') {
            const roomId = String(payload.roomId || '').trim();
            const currentRoomId = String(this.voice.roomId || '').trim();
            if (roomId && currentRoomId && roomId !== currentRoomId) {
                this.voiceTrace('call-ended-stale', { roomId, currentRoomId }, 'INFO');
                return;
            }
            this.voiceTrace('call-ended', { roomId, from: payload.from || '', currentRoomId });
            this.leaveVoiceRoom({ announce: false, outcome: 'completed' });
            return;
        }
    }

    renderVoiceParticipants() {
        const participants = Array.isArray(this.voice.participants) ? this.voice.participants : [];
        if (!participants.length) {
            return '<div class="voice-empty">Пока никого нет</div>';
        }
        return `<div class="voice-participants">` + participants.map(name => {
            const cls = name === this.myName() ? 'mine' : '';
            return `<span class="voice-participant ${cls}">${this.esc(name)}</span>`;
        }).join('') + `</div>`;
    }

    renderVoiceRoomView() {
        const isVoice = this.isVoiceChannel(this.currentChannel());
        const me = String(this.myName() || '').trim().toLowerCase();
        const participants = Array.isArray(this.voice.participants)
            ? this.voice.participants.map(name => String(name || '').trim().toLowerCase()).filter(Boolean)
            : [];
        const participantMatch = me && participants.includes(me);
        const connectedDmRoom = this.voice.roomType === 'dm' && !!String(this.voice.roomId || '').trim() && (this.voice.status === 'connected' || participantMatch);
        const activeRoom = isVoice ? !!this.voice.roomId && participantMatch : connectedDmRoom;
        const outgoingTarget = this.voice.outgoingInvite?.target || this.voice.targetUser || '';
        const incomingFrom = this.voice.incomingInvite?.from || this.voice.inviter || '';
        const voiceHealth = this.getVoiceHealthSnapshot();
        const title = isVoice
            ? `Голосовой канал: ${this.currentChannel()?.name || 'room'}`
            : activeRoom
                ? `Активный звонок${outgoingTarget || incomingFrom ? ` с ${outgoingTarget || incomingFrom}` : ''}`
                : this.voice.status === 'incoming'
                    ? `Входящий звонок от ${incomingFrom}`
                    : this.voice.status === 'calling'
                        ? `Звонок ${outgoingTarget ? `к ${outgoingTarget}` : ''}`
                        : this.voice.status === 'connecting'
                            ? `Соединяемся${outgoingTarget || incomingFrom ? ` с ${outgoingTarget || incomingFrom}` : ''}`
                            : 'Голосовые вызовы';

        const actionButtons = [];
        if (isVoice) {
            if (activeRoom) {
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceLeaveBtn">Покинуть</button>`);
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceMuteBtn">${this.voice.muted ? 'Включить микрофон' : 'Выключить микрофон'}</button>`);
            } else {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceJoinBtn">Присоединиться</button>`);
            }
        } else if (this.S.navMode === 'dm' && this.S.current) {
            if (activeRoom) {
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceLeaveBtn">Завершить</button>`);
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceMuteBtn">${this.voice.muted ? 'Включить микрофон' : 'Выключить микрофон'}</button>`);
            } else if (this.voice.status === 'incoming' && this.voice.incomingInvite?.from) {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceAcceptBtn">Принять</button>`);
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceRejectBtn">Отклонить</button>`);
            } else if (this.voice.status === 'calling') {
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceCancelBtn">Отменить</button>`);
            } else {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceCallBtn">Позвонить</button>`);
            }
        }

        return `
            <div class="voice-room-card ${activeRoom ? 'active' : ''} ${isVoice ? 'voice-channel' : ''}">
                <div class="voice-room-top">
                    <div>
                        <div class="voice-room-title">${this.esc(title)}</div>
                        <div class="voice-room-sub">${this.esc(this.voice.status === 'connected' ? 'Собеседник поднял трубку' : this.voice.status === 'incoming' ? 'Входящий звонок' : this.voice.status === 'calling' ? 'Ожидание ответа' : this.voice.status === 'connecting' ? 'Соединяемся' : 'Голос готов')}</div>
                    </div>
                    <div class="voice-room-state">${this.esc(activeRoom ? 'В эфире' : isVoice ? 'Выбрано' : 'Ожидание')}</div>
                </div>
                <div class="voice-room-actions">${actionButtons.join('')}</div>
                <div class="voice-meter-grid">
                    <div class="voice-meter" id="voiceMicMeter">
                        <div class="voice-meter-head">
                            <span class="voice-meter-name">Микрофон</span>
                            <span class="voice-meter-value" id="voiceMicLevelText">0%</span>
                        </div>
                        <div class="voice-meter-track">
                            <div class="voice-meter-fill" id="voiceMicLevelFill"></div>
                        </div>
                    </div>
                    <div class="voice-meter" id="voiceServerMeter">
                        <div class="voice-meter-head">
                            <span class="voice-meter-name">С сервера</span>
                            <span class="voice-meter-value" id="voiceServerLevelText">0%</span>
                        </div>
                        <div class="voice-meter-track">
                            <div class="voice-meter-fill remote" id="voiceServerLevelFill"></div>
                        </div>
                    </div>
                </div>
                ${voiceHealth.length ? `
                    <div class="voice-health">
                        <div class="voice-room-label">Voice health</div>
                        <div class="voice-health-grid">
                            ${voiceHealth.map(item => `
                                <div class="voice-health-card" data-tone="${this.esc(item.tone)}">
                                    <span class="voice-health-name">${this.esc(item.label)}</span>
                                    <strong class="voice-health-value">${this.esc(item.value)}</strong>
                                    <span class="voice-health-sub">${this.esc(item.sub || '')}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
                <div class="voice-room-participants">
                    <div class="voice-room-label">Участники</div>
                    ${this.renderVoiceParticipants()}
                </div>
                ${Array.isArray(this.voice.traceLines) && this.voice.traceLines.length ? `
                    <div class="voice-trace">
                        <div class="voice-room-label">Трассировка</div>
                        <div class="voice-trace-list">
                            ${this.voice.traceLines.slice(-8).map(line => `
                                <div class="voice-trace-line voice-trace-${this.esc(line.level.toLowerCase())}">
                                    <span class="voice-trace-ts">[${this.esc(line.ts)}]</span>
                                    <span class="voice-trace-stage">${this.esc(line.stage)}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    renderVoicePanel() {
        const panel = document.getElementById('voicePanel');
        if (!panel) return;
        const isServers = this.S.navMode === 'servers';
        const isVoiceChannel = isServers && this.isVoiceChannel(this.currentChannel());
        const hasDmCall = this.voice.roomType === 'dm' || this.voice.status === 'incoming' || this.voice.status === 'calling';
        const hasIncoming = this.voice.status === 'incoming';
        const showPanel = isVoiceChannel || hasDmCall || hasIncoming;
        panel.hidden = !showPanel;
        if (!showPanel) {
            panel.innerHTML = '';
            return;
        }
        if (isVoiceChannel || hasDmCall || hasIncoming || this.voice.roomType === 'dm') {
            panel.innerHTML = this.renderVoiceRoomView();
            return;
        }
        panel.innerHTML = '';
    }

    isOutgoingMessage(msg) {
        return String(msg?.sender || '').trim() === this.myName();
    }

    mergeServerChatMessages(key, incomingMessages) {
        const existing = Array.isArray(this.S.serverChats[key]) ? this.S.serverChats[key] : [];
        const merged = [];
        const mergedByKey = new Map();

        const makeIdentity = (msg) => {
            const normalized = {
                ...msg,
                id: String(msg?.id || '').trim(),
                clientId: String(msg?.clientId || '').trim(),
                serverId: msg?.serverId || msg?.server_id || null,
                channelId: msg?.channelId || msg?.channel_id || null,
            };
            const attachmentKey = this.normalizeAttachments(normalized.attachments)
                .map(att => `${att.name}:${att.kind}:${att.size}:${att.mimeType}`)
                .join('|');
            const identity = normalized.id || normalized.clientId || [
                normalized.sender || '',
                normalized.receiver || '',
                normalized.timestamp || '',
                normalized.text || '',
                attachmentKey,
            ].join('::');
            return { normalized, identity };
        };

        const upsert = (msg) => {
            const { normalized, identity } = makeIdentity(msg);
            const prev = mergedByKey.get(identity);
            const next = prev
                ? {
                    ...prev,
                    ...normalized,
                    attachments: this.normalizeAttachments(normalized.attachments ?? prev.attachments),
                    reactions: this.normalizeReactions(normalized.reactions ?? prev.reactions),
                    myReaction: String(normalized.myReaction ?? prev.myReaction ?? '').trim(),
                }
                : {
                    ...normalized,
                    attachments: this.normalizeAttachments(normalized.attachments),
                    reactions: this.normalizeReactions(normalized.reactions),
                    myReaction: String(normalized.myReaction || '').trim(),
                };
            mergedByKey.set(identity, next);
            if (!prev) merged.push(identity);
        };

        existing.forEach(upsert);
        (Array.isArray(incomingMessages) ? incomingMessages : []).forEach(upsert);

        const next = merged
            .map(identity => mergedByKey.get(identity))
            .sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
        this.S.serverChats[key] = next;
        this.saveStoredServerChats();
        return next;
    }

    ensureServerSelection() {
        this.ensureServersState();
        const servers = Array.isArray(this.S.servers) ? this.S.servers : [];
        if (servers.length === 0) {
            this.S.activeServer = null;
            this.S.activeChannel = null;
            return;
        }

        const storedServer = this.loadStoredActiveServer();
        if (storedServer && servers.some(s => s.id === storedServer)) {
            this.S.activeServer = storedServer;
        } else if (!this.S.activeServer || !servers.some(s => s.id === this.S.activeServer)) {
            this.S.activeServer = servers[0].id;
        }

        const server = this.currentServer();
        const storedChannel = this.loadStoredActiveChannel();
        if (server) {
            if (storedChannel && (server.channels || []).some(ch => ch.id === storedChannel)) {
                this.S.activeChannel = storedChannel;
            } else if (!this.S.activeChannel || !(server.channels || []).some(ch => ch.id === this.S.activeChannel)) {
                this.S.activeChannel = server.channels?.[0]?.id || null;
            }
        }
    }

    async loadServers({ silent = false } = {}) {
        try {
            if (!this.S.session?.token) {
                this.S.servers = this.getDefaultServers().map(server => ({ ...server, channels: [
                    { id: `${server.id}-general`, name: 'general', topic: 'Общий чат', kind: 'text', position: 0 },
                    { id: `${server.id}-voice`, name: 'voice', topic: 'Голосовой канал', kind: 'voice', position: 1 },
                ] }));
                this.ensureServerSelection();
                this.renderContacts();
                this.renderServerInterface();
                this.renderMessages();
                return;
            }
            const res = await this.apiFetch('/api/servers');
            if (!res.ok) {
                this.S.servers = this.getDefaultServers().map(server => ({ ...server, channels: [
                    { id: `${server.id}-general`, name: 'general', topic: 'Общий чат', kind: 'text', position: 0 },
                    { id: `${server.id}-voice`, name: 'voice', topic: 'Голосовой канал', kind: 'voice', position: 1 },
                ] }));
                this.ensureServerSelection();
                this.renderContacts();
                this.renderServerInterface();
                this.renderMessages();
                return;
            }
            const data = await res.json();
            this.S.servers = this.normalizeServers(Array.isArray(data?.servers) ? data.servers : []);
            this.ensureServerSelection();
            this.renderContacts();
            this.renderServerInterface();
            this.renderMessages();
            if (this.S.activeServer && this.S.activeChannel) {
                this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
            }
        } catch (e) {
            if (!silent) {
                this.addLogEntry({ type: 'WARN', msg: 'Не удалось загрузить серверы', ts: new Date().toLocaleTimeString() });
            }
            this.S.servers = this.getDefaultServers().map(server => ({ ...server, channels: [
                { id: `${server.id}-general`, name: 'general', topic: 'Общий чат', kind: 'text', position: 0 },
                { id: `${server.id}-voice`, name: 'voice', topic: 'Голосовой канал', kind: 'voice', position: 1 },
            ] }));
            this.ensureServerSelection();
            this.renderContacts();
            this.renderServerInterface();
            this.renderMessages();
            if (this.S.activeServer && this.S.activeChannel) {
                this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
            }
        }
    }

    async loadServerMessages(serverId, channelId, { silent = false } = {}) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        if (!sid || !cid) return;
        this.trace(`loadServerMessages start server=${sid} channel=${cid} nativeHistory=${this.nativeSupports('serverHistory')}`);
        if (!this.S.session?.token) {
            this.renderMessages();
            return;
        }
        const key = `${sid}:${cid}`;
        if (!Array.isArray(this.S.serverChats[key])) {
            this.S.serverChats[key] = [];
        }
        const channel = (this.currentServer()?.channels || []).find(item => item.id === cid) || null;
        if (this.isVoiceChannel(channel)) {
            this.renderMessages();
            return;
        }
        this.renderMessages();

        if (this.nativeSupports('serverHistory')) {
            const conversationKey = this.ensureConversationCryptoKey({
                serverId: sid,
                channelId: cid,
                reason: 'loadServerMessages',
            });
            this.postNativeMessage({
                type: 'LOAD_SERVER_HISTORY',
                serverId: sid,
                channelId: cid,
                key: conversationKey,
            });
            return;
        }

        try {
            const limit = 200;
            let offset = 0;
            let mergedCount = 0;
            while (true) {
                const res = await this.apiFetch(`/api/servers/${encodeURIComponent(sid)}/channels/${encodeURIComponent(cid)}/messages?limit=${limit}&offset=${offset}`);
                if (!res.ok) {
                    const text = await res.text().catch(() => '');
                    this.trace(`loadServerMessages failed server=${sid} channel=${cid} status=${res.status} offset=${offset} body=${text.slice(0, 300)}`);
                    if (!silent) {
                        this.addLogEntry({ type: 'WARN', msg: `Не удалось загрузить сообщения канала ${cid}`, ts: new Date().toLocaleTimeString() });
                    }
                    return;
                }
                const messages = await res.json();
                const batch = Array.isArray(messages) ? messages : [];
                this.trace(`loadServerMessages success server=${sid} channel=${cid} offset=${offset} count=${batch.length}`);
                const normalized = batch.map(msg => ({
                    id: msg.id,
                    sender: msg.sender,
                    receiver: msg.receiver || cid,
                    text: msg.text || msg.content || 'Зашифрованное сообщение недоступно без нативного моста.',
                    attachments: this.normalizeAttachments(msg.attachments),
                    timestamp: msg.timestamp,
                    serverId: msg.serverId || msg.server_id || sid,
                    channelId: msg.channelId || msg.channel_id || cid,
                    reactions: msg.reactions || [],
                    myReaction: msg.myReaction || msg.my_reaction || '',
                }));
                if (normalized.length > 0) {
                    this.mergeServerChatMessages(key, normalized);
                    mergedCount += normalized.length;
                    this.renderMessages();
                }
                if (batch.length < limit) break;
                offset += limit;
            }
            this.trace(`loadServerMessages merged server=${sid} channel=${cid} count=${mergedCount}`);
        } catch (e) {
            if (!silent) {
                this.addLogEntry({ type: 'ERROR', msg: `Ошибка загрузки канала ${cid}: ${e?.message || e}`, ts: new Date().toLocaleTimeString() });
            }
        }
    }

    loadServerHistory(payload) {
        if (!payload || typeof payload !== 'object') return;
        const serverId = String(payload.serverId || payload.server_id || '').trim();
        const channelId = String(payload.channelId || payload.channel_id || '').trim();
        const messages = Array.isArray(payload.messages) ? payload.messages : [];
        if (!serverId || !channelId) return;
        const queue = messages.filter(msg => msg && typeof msg === 'object');
        this.trace(`loadServerHistory start server=${serverId} channel=${channelId} count=${queue.length}`);
        const key = `${serverId}:${channelId}`;
        const reconciled = [];
        const processBatch = (startIndex = 0) => {
            const startedAt = performance.now();
            let index = startIndex;
            for (; index < queue.length; index += 1) {
                if ((index - startIndex) >= 120) break;
                if ((performance.now() - startedAt) >= 8) break;
                const raw = queue[index];
                const msg = {
                    ...raw,
                    serverId: raw.serverId || raw.server_id || serverId,
                    channelId: raw.channelId || raw.channel_id || channelId,
                };
                const normalizedAttachments = this.normalizeAttachments(msg.attachments);
                const normalizedReactions = this.normalizeReactions(msg.reactions);
                const msgId = String(msg.id || '').trim();
                const clientId = String(msg.clientId || msg.client_id || '').trim();
                if (clientId && this.finalizePendingMessage(clientId, msg.id, { render: false })) {
                    this.dropPendingOutbox(clientId);
                    continue;
                }
                const incomingKey = this.messageRenderKey(msg);
                const existingIndex = msgId
                    ? reconciled.findIndex(m => String(m.id || '').trim() === msgId)
                    : reconciled.findIndex(m => this.messageRenderKey(m) === incomingKey);
                if (existingIndex >= 0) {
                    const prev = reconciled[existingIndex];
                    reconciled[existingIndex] = {
                        ...prev,
                        ...msg,
                        id: msgId || msg.id || prev.id || '',
                        attachments: normalizedAttachments.length ? normalizedAttachments : this.normalizeAttachments(prev.attachments),
                        reactions: normalizedReactions.length ? normalizedReactions : this.normalizeReactions(prev.reactions),
                        myReaction: msg.myReaction || prev.myReaction || '',
                        text: this.sanitizeDecryptionErrorText(msg.text) || prev.text || '',
                        status: 'sent',
                        serverId: msg.serverId || msg.server_id || serverId,
                        channelId: msg.channelId || msg.channel_id || channelId,
                    };
                } else {
                    reconciled.push({
                        ...msg,
                        id: msgId || msg.id || '',
                        attachments: normalizedAttachments,
                        reactions: normalizedReactions,
                        myReaction: msg.myReaction || '',
                        text: this.sanitizeDecryptionErrorText(msg.text),
                        status: 'sent',
                    });
                }
            }
            if (index < queue.length) {
                requestAnimationFrame(() => processBatch(index));
                return;
            }
            this.mergeServerChatMessages(key, reconciled);
            if (this.currentServerChatKey() === key) {
                this.renderMessages();
            }
            this.scheduleFlushPendingOutbox(300);
            this.trace(`loadServerHistory done server=${serverId} channel=${channelId} merged=${reconciled.length}`);
        };
        processBatch(0);
    }

    async refreshAfterKey() {
        if (!this.S.session?.token) {
            this.scheduleFlushPendingOutbox(300);
            return;
        }
        if (this.S.navMode === 'servers') {
            this.ensureServerSelection();
        } else if (!this.S.current) {
            const storedCurrent = this.loadStoredCurrentContact();
            if (storedCurrent) {
                this.S.current = storedCurrent;
                this.ensureContact(storedCurrent);
                this.initChat(storedCurrent);
            }
        }

        if (this.S.navMode === 'servers' && this.S.activeServer && this.S.activeChannel) {
            const key = await this.resolveConversationCryptoKey({
                serverId: this.S.activeServer,
                channelId: this.S.activeChannel,
                reason: 'refreshAfterKey'
            });
            this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
            this.scheduleFlushPendingOutbox(300);
            return;
        }

        if (this.S.current) {
            const key = await this.resolveConversationCryptoKey({ peer: this.S.current, reason: 'refreshAfterKey' });
            if (this.nativeSupports('sendMessage')) {
                this.postNativeMessage({ type: 'REFRESH_HISTORY', key });
            }
        }
        this.scheduleFlushPendingOutbox(300);
    }

    async syncActiveConversation({ force = false } = {}) {
        if (!this.S.session?.token) return;
        if (!force && document.hidden) return;
        if (this.S.navMode === 'servers') {
            const serverId = this.S.activeServer;
            const channelId = this.S.activeChannel;
            if (serverId && channelId) {
                const syncKey = `server:${serverId}:${channelId}`;
                const now = Date.now();
                const lastSyncAt = this.conversationSyncAt.get(syncKey) || 0;
                if (!force && (now - lastSyncAt) < 30000) return;
                this.conversationSyncAt.set(syncKey, now);
                this.trace(`syncActiveConversation server=${serverId} channel=${channelId}`);
                await this.resolveConversationCryptoKey({
                    serverId,
                    channelId,
                    reason: 'syncActiveConversation',
                });
                this.loadServerMessages(serverId, channelId, { silent: true });
            }
            return;
        }

        const peer = String(this.S.current || '').trim();
        if (!peer) return;
        const syncKey = `dm:${peer}`;
        const now = Date.now();
        const lastSyncAt = this.conversationSyncAt.get(syncKey) || 0;
        if (!force && (now - lastSyncAt) < 60000) return;
        this.conversationSyncAt.set(syncKey, now);
        this.trace(`syncActiveConversation peer=${peer} force=${force}`);
        const key = await this.resolveConversationCryptoKey({ peer, reason: 'syncActiveConversation' });
        if (this.nativeSupports('sendMessage')) {
            this.postNativeMessage({ type: 'REFRESH_HISTORY', key });
        }
    }

    async syncConversationFromNative(payload = {}) {
        if (!this.S.session?.token) return;
        const serverId = String(payload?.serverId || '').trim();
        const channelId = String(payload?.channelId || '').trim();
        const peer = String(payload?.peer || '').trim();
        if (serverId && channelId) {
            await this.resolveConversationCryptoKey({ serverId, channelId, reason: 'syncConversationFromNative' });
            this.loadServerMessages(serverId, channelId, { silent: true });
            return;
        }
        if (peer) {
            const key = await this.resolveConversationCryptoKey({ peer, reason: 'syncConversationFromNative' });
            if (this.nativeSupports('sendMessage')) {
                this.postNativeMessage({ type: 'REFRESH_HISTORY', key });
            }
            return;
        }
        this.syncActiveConversation({ force: !!payload?.force });
    }

    scheduleConversationRefresh({ peer = null, serverId = null, channelId = null, reason = 'message', delayMs = 250 } = {}) {
        if (!this.S.session?.token) return;
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        const dmPeer = String(peer || '').trim();
        const key = sid && cid
            ? `server:${sid}:${cid}`
            : dmPeer
                ? `dm:${dmPeer}`
                : '';
        if (!key) return;

        if (this.conversationRefreshTimers.has(key)) {
            clearTimeout(this.conversationRefreshTimers.get(key));
        }

        this.conversationRefreshTimers.set(key, setTimeout(() => {
            this.conversationRefreshTimers.delete(key);
            if (sid && cid) {
                this.trace(`scheduleConversationRefresh fire reason=${reason} server=${sid} channel=${cid}`);
                this.resolveConversationCryptoKey({
                    serverId: sid,
                    channelId: cid,
                    reason: `refresh:${reason}`,
                });
                this.loadServerMessages(sid, cid, { silent: true });
                return;
            }

            if (!dmPeer) return;
            this.trace(`scheduleConversationRefresh fire reason=${reason} peer=${dmPeer}`);
            this.resolveConversationCryptoKey({ peer: dmPeer, reason: `refresh:${reason}` }).then((keyValue) => {
                if (this.nativeSupports('sendMessage')) {
                    this.postNativeMessage({ type: 'REFRESH_HISTORY', key: keyValue });
                }
            });
        }, Math.max(100, Number(delayMs) || 250)));
    }

    renderServerInterface() {
        this.ensureServersState();
        this.ensureServerSelection();
        this.renderServerToolbar();
        this.updateSendButtonState();
    }

    renderServerToolbar() {
        const channelList = document.getElementById('serverChannelList');
        const chatHdr = document.getElementById('chatHdr');
        const chatHdrAva = document.getElementById('chatHdrAva');
        const chatHdrName = document.getElementById('chatHdrName');
        const chatHdrSub = document.getElementById('chatHdrSub');
        const chatCallBtn = document.getElementById('chatCallBtn');
        const serverSettingsBtn = document.getElementById('serverSettingsBtn');
        const tbChat = document.getElementById('tbChat');
        const server = this.currentServer();
        const channel = this.currentChannel();
        const isServers = this.S.navMode === 'servers';
        const canManage = this.canManageServer(server);

        if (chatHdr) chatHdr.classList.toggle('server-mode', isServers);
        if (channelList) channelList.hidden = !isServers;
        if (chatCallBtn) {
            chatCallBtn.hidden = isServers || !this.S.current;
        }
        if (serverSettingsBtn) {
            serverSettingsBtn.hidden = !isServers || !server || !canManage;
            serverSettingsBtn.disabled = !canManage;
        }
        if (!isServers) {
            if (channelList) channelList.innerHTML = '';
            if (chatHdrAva) chatHdrAva.innerHTML = this.renderAvatarHTML(this.S.current || this.myName(), 'avatar-img', this.S.current || this.myName());
            if (chatHdrName) chatHdrName.textContent = this.S.current || 'Выберите чат';
            if (tbChat) tbChat.textContent = this.S.current || (this.S.contacts.length ? 'Выберите чат' : 'Нет контактов');
            if (chatHdrSub) {
                chatHdrSub.innerHTML = '';
                if (this.S.current) {
                    this.updateChatHeaderCryptoKey({ peer: this.S.current });
                } else {
                    chatHdrSub.textContent = 'Личное сообщение';
                }
            }
            return;
        }
        if (!server) {
            if (channelList) channelList.innerHTML = '';
            return;
        }

        if (chatHdrAva) chatHdrAva.innerHTML = this.esc(server.icon || server.name?.[0] || 'S');
        if (chatHdrName) {
            const membersText = Number(server.memberCount || 0) > 0 ? `${Number(server.memberCount)} участников` : '';
            const channelLabel = channel
                ? `${this.isVoiceChannel(channel) ? '🔊 ' : '#'}${channel.name}`
                : server.name;
            chatHdrName.innerHTML = `
                <span class="chat-hdr-title">${this.esc(channelLabel)}</span>
                ${membersText ? `<span class="chat-hdr-count">${this.esc(membersText)}</span>` : ''}
            `;
        }
        if (chatHdrSub) {
            chatHdrSub.textContent = channel
                ? `${server.name}${channel.topic ? ` · ${channel.topic}` : ''}`
                : (server.description || 'Сервер');
        }
        if (tbChat) {
            tbChat.textContent = channel
                ? `${server.name} / ${this.isVoiceChannel(channel) ? '🔊' : '#'}${channel.name}`
                : server.name;
        }

        if (channelList) {
            const channels = Array.isArray(server.channels) ? server.channels : [];
            channelList.innerHTML = channels.map(ch => {
                const active = ch.id === this.S.activeChannel ? 'active' : '';
                const kind = String(ch.kind || 'text').trim().toLowerCase();
                const icon = kind === 'voice' ? '◉' : '#';
                const title = kind === 'voice' ? 'Голосовой канал' : 'Текстовый канал';
                return `<button class="server-channel ${active}" type="button" data-channel-id="${this.esc(ch.id)}" data-channel-kind="${this.esc(kind)}" title="${this.esc(title)}">
                    <span class="server-channel-hash ${kind}">${this.esc(icon)}</span>
                    <span class="server-channel-name">${this.esc(ch.name)}</span>
                </button>`;
            }).join('');

            const activeChannel = channelList.querySelector('.server-channel.active');
            if (activeChannel && typeof activeChannel.scrollIntoView === 'function') {
                requestAnimationFrame(() => {
                    activeChannel.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
                });
            }
        }
    }

    setActiveChannel(channelId, { persist = true } = {}) {
        const next = String(channelId || '').trim();
        const server = this.currentServer();
        if (!server || !next) return;
        const channel = (server.channels || []).find(ch => ch.id === next) || null;
        if (!channel) return;
        if (this.S.navMode === 'servers' && this.S.activeChannel === next) return;
        if (this.voice.roomType === 'channel' && this.voice.roomId) {
            const currentChannelId = String(this.voice.channelId || '').trim();
            if (currentChannelId && currentChannelId !== next) {
                this.leaveVoiceRoom({ announce: true });
            }
        }
        this.S.activeChannel = next;
        if (persist) this.saveStoredActiveChannel(next);
        this.saveStoredNavMode('servers');
        this.renderServerToolbar();
        this.requestMessagesScroll('bottom');
        this.renderMessages();
        this.updateSendButtonState();
        if (this.isVoiceChannel(channel)) {
            const roomId = this.voiceRoomKeyForChannel(server.id, next);
            const alreadyJoined = this.voice.roomId === roomId && this.voice.participants.includes(this.myName());
            if (!alreadyJoined) {
                this.joinVoiceChannel({ serverId: server.id, channelId: next });
            } else {
                this.renderVoicePanel();
            }
            this.renderVoicePanel();
            return;
        }
        this.requestMessagesScroll('bottom');
        this.loadServerMessages(server.id, next, { silent: true });
        this.closeMobileSidebar();
        this.syncMobileChrome();
    }

    setNavMode(mode, { persist = true, refresh = true } = {}) {
        const next = mode === 'servers' ? 'servers' : 'dm';
        if (this.S.navMode === next) {
            this.updateNavModeButtons();
            return;
        }
        this.S.navMode = next;
        if (next === 'servers') {
            this.ensureServersState();
            this.ensureServerSelection();
        }
        if (persist) {
            this.saveStoredNavMode(next);
        }
        this.updateNavModeButtons();
        if (!refresh) return;
        this.resetMessageWindow();
        this.renderServerInterface();
        this.renderContacts();
        this.requestMessagesScroll('bottom');
        this.renderMessages();
        this.renderVoicePanel();
        if (next === 'servers' && this.S.activeServer && this.S.activeChannel) {
            this.requestMessagesScroll('bottom');
            this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
        }
        this.syncMobileChrome();
    }

    avatarCacheKey(username) {
        return String(username || '').trim().toLowerCase();
    }

    loadStoredAvatar(username) {
        const key = this.avatarCacheKey(username);
        return this.avatarCache.has(key) ? this.avatarCache.get(key) : undefined;
    }

    saveStoredAvatar(username, dataUrl) {
        const key = this.avatarCacheKey(username);
        const prev = this.avatarCache.get(key);
        if (prev && typeof prev === 'string' && prev.startsWith('blob:') && prev !== dataUrl) {
            try { URL.revokeObjectURL(prev); } catch (e) {}
        }
        this.avatarFetchSeq.set(key, (this.avatarFetchSeq.get(key) || 0) + 1);
        this.avatarCache.set(key, dataUrl || null);
    }

    clearStoredAvatar(username) {
        const key = this.avatarCacheKey(username);
        const prev = this.avatarCache.get(key);
        if (prev && typeof prev === 'string' && prev.startsWith('blob:')) {
            try { URL.revokeObjectURL(prev); } catch (e) {}
        }
        this.avatarFetchSeq.set(key, (this.avatarFetchSeq.get(key) || 0) + 1);
        this.avatarCache.delete(key);
    }

    avatarFallback(username) {
        const value = String(username || '').trim();
        return value ? value[0].toUpperCase() : 'Z';
    }

    renderAvatarHTML(username, className = 'ava', alt = '') {
        const src = this.loadStoredAvatar(username);
        const fallback = this.avatarFallback(username);
        const safeAlt = this.esc(alt || username || fallback);
        if (src === undefined) {
            this.ensureAvatarLoaded(username);
        } else if (src) {
            const classes = String(className || '')
                .split(/\s+/)
                .filter(Boolean)
                .concat('avatar-img')
                .filter((v, i, arr) => arr.indexOf(v) === i)
                .join(' ');
            return `<img class="${classes}" src="${this.esc(src)}" alt="${safeAlt}">`;
        }
        return `<span class="avatar-fallback">${this.esc(fallback)}</span>`;
    }

    serverAssetCacheKey(serverId, kind) {
        return `${String(serverId || '').trim()}:${kind}`;
    }

    async loadServerAsset(serverId, kind, { force = false } = {}) {
        const sid = String(serverId || '').trim();
        if (!sid) return null;
        const key = this.serverAssetCacheKey(sid, kind);
        if (!force && this.serverAssetCache.has(key)) {
            return this.serverAssetCache.get(key);
        }
        if (this.serverAssetRequests.has(key) && !force) {
            return this.serverAssetRequests.get(key);
        }

        const seq = (this.serverAssetFetchSeq.get(key) || 0) + 1;
        this.serverAssetFetchSeq.set(key, seq);

        const request = (async () => {
            try {
                const res = await this.apiFetch(`/api/servers/${encodeURIComponent(sid)}/assets/${kind}`);
                if (this.serverAssetFetchSeq.get(key) !== seq) return null;
                if (res.status === 404) {
                    this.serverAssetCache.set(key, null);
                    return null;
                }
                if (!res.ok) return null;
                const blob = await res.blob();
                if (!blob || blob.size === 0) {
                    this.serverAssetCache.set(key, null);
                    return null;
                }
                const url = await this.blobToObjectUrl(blob);
                this.serverAssetCache.set(key, url);
                return url;
            } catch (e) {
                return null;
            } finally {
                if (this.serverAssetRequests.get(key) === request) {
                    this.serverAssetRequests.delete(key);
                }
            }
        })();

        this.serverAssetRequests.set(key, request);
        return request;
    }

    clearServerAssetCache(serverId, kind) {
        const key = this.serverAssetCacheKey(serverId, kind);
        const prev = this.serverAssetCache.get(key);
        if (prev && typeof prev === 'string' && prev.startsWith('blob:')) {
            try { URL.revokeObjectURL(prev); } catch (e) {}
        }
        this.serverAssetFetchSeq.set(key, (this.serverAssetFetchSeq.get(key) || 0) + 1);
        this.serverAssetCache.delete(key);
    }

    serverAssetFallback(server, kind) {
        if (kind === 'avatar') {
            return this.esc(server?.icon || server?.name?.[0] || 'S');
        }
        return this.esc((server?.name || 'BAN').slice(0, 3).toUpperCase());
    }

    resetServerAssetPreview() {
        const avatarBox = document.getElementById('serverAvatarPreview');
        const bannerBox = document.getElementById('serverBannerPreview');
        if (avatarBox) {
            avatarBox.innerHTML = '';
            avatarBox.style.backgroundImage = '';
            avatarBox.textContent = 'S';
        }
        if (bannerBox) {
            bannerBox.innerHTML = '';
            bannerBox.style.backgroundImage = '';
            bannerBox.style.backgroundSize = '';
            bannerBox.style.backgroundPosition = '';
            bannerBox.textContent = 'BAN';
        }
    }

    async syncServerAssetPreview(serverId) {
        const sid = String(serverId || '').trim();
        const avatar = await this.loadServerAsset(serverId, 'avatar');
        const banner = await this.loadServerAsset(serverId, 'banner');
        const avatarBox = document.getElementById('serverAvatarPreview');
        const bannerBox = document.getElementById('serverBannerPreview');
        const server = (this.S.servers || []).find(item => item.id === sid) || null;
        if (avatarBox) {
            avatarBox.style.backgroundImage = '';
            if (avatar) {
                avatarBox.innerHTML = `<img class="avatar-img" src="${this.esc(avatar)}" alt="server avatar">`;
            } else {
                avatarBox.innerHTML = '';
                avatarBox.textContent = this.serverAssetFallback(server, 'avatar');
            }
        }
        if (bannerBox) {
            if (banner) {
                bannerBox.innerHTML = '';
                bannerBox.style.backgroundImage = `url('${this.esc(banner)}')`;
                bannerBox.style.backgroundSize = 'cover';
                bannerBox.style.backgroundPosition = 'center';
            } else {
                bannerBox.style.backgroundImage = '';
                bannerBox.innerHTML = '';
                bannerBox.textContent = this.serverAssetFallback(server, 'banner');
            }
        }
    }

    scheduleAvatarRefresh() {
        if (this.avatarRefreshScheduled) return;
        this.avatarRefreshScheduled = true;
        requestAnimationFrame(() => {
            this.avatarRefreshScheduled = false;
            this.renderSidebarProfile();
            this.renderContacts();
        });
    }

    updateAvatarViews() {
        this.renderSidebarProfile();
        this.renderContacts();
        this.renderMessages();
    }

    refreshVisibleAvatars() {
        if (document.hidden) return;
        if (this.nativeSupports('serverHistory') && this.nativeSupports('voice') && this.nativeSupports('downloadAttachment')) return;
        const users = new Set([this.myName(), this.S.current, ...(this.S.contacts || [])].filter(Boolean));
        document.querySelectorAll('.avatar-img[alt]').forEach(img => {
            const name = String(img.getAttribute('alt') || '').trim();
            if (name) users.add(name);
        });
        users.forEach(username => {
            this.ensureAvatarLoaded(username);
        });
    }

    async blobToObjectUrl(blob) {
        return URL.createObjectURL(blob);
    }

    dataUrlToBlob(dataUrl) {
        const value = String(dataUrl || '').trim();
        if (!value.startsWith('data:')) return null;

        const commaIndex = value.indexOf(',');
        if (commaIndex < 0) return null;

        const meta = value.slice(5, commaIndex);
        const payload = value.slice(commaIndex + 1);
        const parts = meta.split(';').filter(Boolean);
        const mimeType = parts[0] || 'application/octet-stream';
        const isBase64 = parts.includes('base64');

        try {
            if (isBase64) {
                const binary = atob(payload);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i += 1) {
                    bytes[i] = binary.charCodeAt(i);
                }
                return new Blob([bytes], { type: mimeType });
            }

            return new Blob([decodeURIComponent(payload)], { type: mimeType });
        } catch (error) {
            console.error('Failed to decode data URL', error);
            return null;
        }
    }

    async downloadAttachmentFromHref(href, filename) {
        const source = String(href || '').trim();
        const safeName = String(filename || 'attachment').trim() || 'attachment';
        if (!source) return false;

        if (this.nativeSupports('downloadAttachment') && source.startsWith('data:')) {
            this.postNativeMessage({
                type: 'DOWNLOAD_ATTACHMENT',
                dataUrl: source,
                filename: safeName,
            });
            return true;
        }

        let objectUrl = source;
        let shouldRevoke = false;

        try {
            if (source.startsWith('data:')) {
                const blob = this.dataUrlToBlob(source);
                if (!blob || blob.size === 0) {
                    throw new Error('Empty attachment payload');
                }
                objectUrl = URL.createObjectURL(blob);
                shouldRevoke = true;
            } else if (!source.startsWith('blob:')) {
                const response = await fetch(source);
                if (!response.ok) {
                    throw new Error(`Unexpected response while downloading attachment: ${response.status}`);
                }
                const blob = await response.blob();
                if (!blob || blob.size === 0) {
                    throw new Error('Empty attachment payload');
                }
                objectUrl = URL.createObjectURL(blob);
                shouldRevoke = true;
            }

            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = safeName;
            link.rel = 'noopener';
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();

            if (shouldRevoke) {
                setTimeout(() => {
                    try { URL.revokeObjectURL(objectUrl); } catch (e) {}
                }, 1000);
            }

            return true;
        } catch (error) {
            console.error('Failed to download attachment', error);
            return false;
        }
    }

    async ensureAvatarLoaded(username, { force = false } = {}) {
        const name = String(username || '').trim();
        if (!name) return null;
        const key = this.avatarCacheKey(name);
        if (!force && this.avatarCache.has(key)) {
            return this.avatarCache.get(key);
        }
        if (this.avatarRequests.has(key)) {
            if (!force) {
                return this.avatarRequests.get(key);
            }
        }

        const seq = (this.avatarFetchSeq.get(key) || 0) + 1;
        this.avatarFetchSeq.set(key, seq);

        const request = (async () => {
            try {
                if (this.nativeSupports('avatarFetch')) {
                    try {
                        const payload = await this.requestNativeAction({
                            type: 'LOAD_AVATAR_REQUEST',
                            username: name,
                        });
                        if (this.avatarFetchSeq.get(key) !== seq) {
                            return null;
                        }
                        const dataUrl = String(payload?.data?.dataUrl || '').trim();
                        if (!dataUrl) {
                            this.saveStoredAvatar(name, null);
                            this.scheduleAvatarRefresh();
                            return null;
                        }
                        this.saveStoredAvatar(name, dataUrl);
                        this.scheduleAvatarRefresh();
                        return dataUrl;
                    } catch (nativeError) {
                        this.trace(`ensureAvatarLoaded native failed username=${name} err=${nativeError?.message || nativeError}`);
                    }
                }

                const res = await this.apiFetch(`/api/avatar/${encodeURIComponent(name)}`);
                if (this.avatarFetchSeq.get(key) !== seq) {
                    return null;
                }
                if (res.status === 404) {
                    this.saveStoredAvatar(name, null);
                    this.scheduleAvatarRefresh();
                    return null;
                }
                if (!res.ok) {
                    return null;
                }

                const blob = await res.blob();
                if (this.avatarFetchSeq.get(key) !== seq) {
                    return null;
                }
                if (!blob || blob.size === 0) {
                    this.saveStoredAvatar(name, null);
                    this.scheduleAvatarRefresh();
                    return null;
                }

                const url = await this.blobToObjectUrl(blob);
                if (this.avatarFetchSeq.get(key) !== seq) {
                    try { URL.revokeObjectURL(url); } catch (e) {}
                    return null;
                }
                this.saveStoredAvatar(name, url);
                this.scheduleAvatarRefresh();
                return url;
            } catch (e) {
                return null;
            } finally {
                if (this.avatarRequests.get(key) === request) {
                    this.avatarRequests.delete(key);
                }
            }
        })();

        this.avatarRequests.set(key, request);
        return request;
    }

    renderSidebarProfile() {
        const meName = document.getElementById('meName');
        const meSub = document.getElementById('meSub');
        const meAva = document.getElementById('meAva');
        const avatarPreview = document.getElementById('avatarPreview');
        const username = this.myName();
        if (meName) meName.textContent = username;
        if (meAva) meAva.innerHTML = this.renderAvatarHTML(username, 'avatar-img', username);
        if (avatarPreview) {
            avatarPreview.innerHTML = this.renderAvatarHTML(username, 'avatar-img', username);
            avatarPreview.title = `Ваш аватар: ${username}`;
        }
        this.ensureAvatarLoaded(username);
        if (meSub) {
            meSub.innerHTML = this.S.session?.token
                ? '<span class="online-dot"></span> В сети'
                : '<span class="online-dot guest"></span> Гостевой режим';
        }
        this.updateContactControls();
        this.renderContactSuggestions();
        this.updateNavModeButtons();
        this.ensureServersState();
    }

    readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
            reader.readAsDataURL(file);
        });
    }

    async setProfileAvatar(file) {
        if (!file) return;
        const target = String(this.myName()).trim();
        if (!file.type || !file.type.startsWith('image/')) {
            throw new Error('Нужен файл изображения');
        }
        const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
        if (file.size > MAX_AVATAR_BYTES) {
            throw new Error('Аватар слишком большой. Выберите изображение до 2 МБ');
        }
        if (this.isWindowsNativeAuth()) {
            const dataUrl = await this.readFileAsDataURL(file);
            await this.requestNativeAction({
                type: 'UPLOAD_AVATAR_REQUEST',
                dataUrl,
                mimeType: file.type || 'image/png',
                filename: file.name || 'avatar.png',
            });
            const objectUrl = URL.createObjectURL(file);
            this.saveStoredAvatar(target, objectUrl);
            this.updateAvatarViews();
            return;
        }
        const formData = new FormData();
        formData.append('file', file, file.name || 'avatar.png');
        const res = await this.apiFetch('/api/avatar', {
            method: 'POST',
            body: formData,
        });
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось сохранить аватар на сервере');
        }
        const objectUrl = URL.createObjectURL(file);
        this.saveStoredAvatar(target, objectUrl);
        this.updateAvatarViews();
    }

    async resetProfileAvatar() {
        const target = String(this.myName()).trim();
        if (this.isWindowsNativeAuth()) {
            await this.requestNativeAction({
                type: 'DELETE_AVATAR_REQUEST',
            });
            this.saveStoredAvatar(target, null);
            this.updateAvatarViews();
            return;
        }
        const res = await this.apiFetch('/api/avatar', { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || 'Не удалось удалить аватар на сервере');
        }
        this.saveStoredAvatar(target, null);
        this.updateAvatarViews();
    }

    apiHeaders(extra = {}) {
        const headers = { ...extra };
        if (this.S.session?.token) {
            headers.Authorization = `Bearer ${this.S.session.token}`;
        }
        return headers;
    }

    async apiFetch(path, options = {}) {
        const method = String(options?.method || 'GET').toUpperCase();
        this.trace(`apiFetch request method=${method} path=${path} auth=${!!this.S.session?.token}`);
        const res = await fetch(this.apiUrl(path), {
            ...options,
            headers: this.apiHeaders(options.headers || {}),
        });
        this.trace(`apiFetch response method=${method} path=${path} status=${res.status} ok=${res.ok}`);
        return res;
    }

    async bootstrapSession() {
        this.trace('bootstrapSession start');
        this.sessionBootstrapInProgress = true;
        try {
            const stored = this.loadStoredSession();
            const lastStored = this.loadStoredSession(this.lastAuthStorageKey());
            const candidates = [stored, lastStored].filter(s => s && s.token);

            let restored = false;
            for (const candidate of candidates) {
                restored = await this.restoreSession(candidate);
                if (restored) break;
            }

            if (!restored) {
                if (stored?.token) this.clearStoredSession();
                if (lastStored?.token) this.clearLastStoredSession();
                this.applySession({ username: 'Zalikus', token: null, guest: true }, { persist: false });
            }

            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;

            if (this.S.session?.token) {
                await this.loadContacts();
                await this.loadUsers();
                await this.loadServers({ silent: true });
            } else {
                this.S.contacts = [];
                this.S.users = [];
                this.S.servers = this.getDefaultServers().map(server => ({ ...server, channels: [
                    { id: `${server.id}-general`, name: 'general', topic: 'Общий чат', kind: 'text', position: 0 },
                    { id: `${server.id}-voice`, name: 'voice', topic: 'Голосовой канал', kind: 'voice', position: 1 },
                ] }));
                this.ensureServerSelection();
                this.renderContacts();
                this.renderServerInterface();
                this.renderMessages();
            }
            this.updateAuthView();
            this.applyNetworkConfigToInputs();
            this.syncNativeNetworkConfig();
            this.updateSendButtonState();
            if (this.nativeSupports('sessionSync')) {
                this.syncNativeSession();
            }
        } finally {
            this.sessionBootstrapInProgress = false;
            this.rehydratePendingOutbox();
            this.scheduleFlushPendingOutbox(300);
            this.trace('bootstrapSession done');
        }
    }

    async restoreSession(session) {
        try {
            const token = session?.token || null;
            if (!token) return false;
            this.trace(`restoreSession start username=${session?.username || ''} tokenSet=${!!token}`);
            const res = await this.apiFetch('/api/auth/me', {
                headers: {
                    Authorization: `Bearer ${token}`,
                },
            });
            if (!res.ok) return false;
            const data = await res.json();
            this.trace(`restoreSession success username=${data.username || session.username || 'Zalikus'}`);
            this.applySession({
                username: data.username || session.username || 'Zalikus',
                token,
                guest: false,
            }, { persist: true, syncNative: true });
            return true;
        } catch (e) {
            this.trace(`restoreSession failed error=${e?.message || e}`);
            return false;
        }
    }

    applySession(session, { persist = true, syncNative = true, connectVoiceSocket = true } = {}) {
        const previousUsername = this.S.session?.username;
        const previousToken = this.S.session?.token;
        const username = session?.username || 'Zalikus';
        const token = session?.token || null;
        const guest = !!session?.guest || !token;
        this.trace(`applySession username=${username} tokenSet=${!!token} guest=${guest} persist=${persist} syncNative=${syncNative}`);

        if (previousUsername !== username || previousToken !== token) {
            this.S.current = null;
            this.S.activeServer = null;
            this.S.activeChannel = null;
            this.S.draftAttachments = [];
            this.resetVoiceState({ preserveInvite: false });
            this.disconnectBrowserVoiceSocket();
            this.setServerModalState({
                mode: 'create',
                serverId: null,
                members: [],
                loading: false,
                saving: false,
                error: '',
            });
            this.closeServerOverlay();
        }

        this.S.session = { username, token, guest };
        if (token) {
            this.S.auth.dismissed = true;
        }
        if (persist) {
            if (token) {
                this.saveStoredSession(this.S.session);
            } else {
                this.clearStoredSession();
            }
        }

        this.updateAuthView();
        const overlay = document.getElementById('authOverlay');
        if (overlay && token) {
            overlay.classList.remove('visible');
        }
        this.normalizeDmChatStore();
        this.renderSidebarProfile();
        this.updateContactControls();
        this.renderContacts();
        this.renderMessages();
        this.updateSendButtonState();
        if (syncNative) {
            this.syncNativeSession();
        }
        if (connectVoiceSocket && !this.nativeSupports('voice')) {
            this.connectBrowserVoiceSocket();
        }
        if (!this.sessionBootstrapInProgress) {
            this.rehydratePendingOutbox();
            this.scheduleFlushPendingOutbox(300);
        }
    }

    clearAuthInputs() {
        const usernameInput = document.getElementById('authUsername');
        const passwordInput = document.getElementById('authPassword');
        if (usernameInput) usernameInput.value = '';
        if (passwordInput) passwordInput.value = '';
    }

    updateContactControls() {
        const enabled = !!this.S.session?.token;
        const contactInput = document.getElementById('contactInput');
        if (contactInput) {
            contactInput.disabled = !enabled;
            contactInput.placeholder = enabled
                ? 'Добавить контакт'
                : 'Войдите, чтобы добавить контакт';
        }
        if (!enabled) {
            this.hideContactSuggestions();
        }
    }

    getContactSuggestions(query = '') {
        const q = String(query || '').trim().toLowerCase();
        const me = this.myName();
        const existing = new Set((this.S.contacts || []).map(u => String(u).toLowerCase()));
        return (this.S.users || [])
            .filter(Boolean)
            .filter(u => u !== me)
            .filter(u => !existing.has(String(u).toLowerCase()))
            .filter(u => !q || String(u).toLowerCase().includes(q))
            .slice(0, 8);
    }

    hideContactSuggestions() {
        const outer = document.getElementById('contactSuggestionsWrap');
        const wrap = document.getElementById('contactSuggestions');
        if (outer) outer.hidden = true;
        if (!wrap) return;
        wrap.hidden = true;
        wrap.innerHTML = '';
    }

    renderContactSuggestions(force = false) {
        const outer = document.getElementById('contactSuggestionsWrap');
        const wrap = document.getElementById('contactSuggestions');
        const input = document.getElementById('contactInput');
        if (!outer || !wrap || !input) return;

        if (!this.S.session?.token) {
            this.hideContactSuggestions();
            return;
        }

        const query = input.value || '';
        const list = this.getContactSuggestions(query);
        const hasFocus = document.activeElement === input;
        const shouldShow = force || hasFocus || query.trim().length > 0;

        if (!shouldShow || list.length === 0) {
            outer.hidden = true;
            wrap.hidden = true;
            wrap.innerHTML = '';
            return;
        }

        outer.hidden = false;
        wrap.hidden = false;
        wrap.innerHTML = list.map(username => {
            return `
                <button class="contact-suggest-item" type="button" data-username="${this.esc(username)}">
                    <div class="contact-suggest-ava">${this.renderAvatarHTML(username, 'avatar-img', username)}</div>
                    <div class="contact-suggest-meta">
                        <div class="contact-suggest-name">${this.esc(username)}</div>
                        <div class="contact-suggest-hint">Добавить и начать чат</div>
                    </div>
                    <div class="contact-suggest-plus">+</div>
                </button>
            `;
        }).join('');
    }

    setAuthMode(mode, { clearInputs = true, focus = true } = {}) {
        this.S.auth.mode = mode === 'register' ? 'register' : 'login';
        this.S.auth.error = '';
        this.S.auth.loading = false;
        this.S.auth.fieldsCleared = false;
        if (clearInputs) {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        }
        this.updateAuthView();
        if (focus) {
            const usernameInput = document.getElementById('authUsername');
            if (usernameInput) usernameInput.focus();
        }
    }

    syncNativeSession() {
        if (!this.nativeSupports('sessionSync')) return;
        this.trace(`syncNativeSession username=${this.S.session.username} tokenSet=${!!this.S.session.token}`);
        this.postNativeMessage({
            type: 'SET_SESSION',
            username: this.S.session.username,
            token: this.S.session.token || '',
            guest: this.S.session.guest,
        });
    }

    async loadContacts() {
        try {
            this.trace(`loadContacts start user=${this.myName()} tokenSet=${!!this.S.session?.token}`);
            if (!this.S.session?.token) {
                this.S.contacts = [];
                this.renderContacts();
                return;
            }
            const res = await this.apiFetch('/api/contacts');
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                this.trace(`loadContacts failed status=${res.status} body=${text.slice(0, 300)}`);
                this.S.contacts = [];
                this.renderContacts();
                return;
            }
            const data = await res.json();
            const contacts = Array.isArray(data?.contacts) ? data.contacts : [];
            this.trace(`loadContacts success count=${contacts.length} contacts=${contacts.join(',')}`);
            this.setContacts(contacts);
        } catch (e) {
            this.trace(`loadContacts error=${e?.message || e}`);
            this.S.contacts = [];
            this.renderContacts();
        }
    }

    async loadUsers() {
        try {
            this.trace(`loadUsers start user=${this.myName()} tokenSet=${!!this.S.session?.token}`);
            if (!this.S.session?.token) {
                this.S.users = [];
                return;
            }
            const res = await this.apiFetch('/api/users');
            if (!res.ok) {
                const text = await res.text().catch(() => '');
                this.trace(`loadUsers failed status=${res.status} body=${text.slice(0, 300)}`);
                return;
            }
            const users = await res.json();
            this.trace(`loadUsers success count=${Array.isArray(users) ? users.length : 0} users=${Array.isArray(users) ? users.join(',') : 'invalid'}`);
            this.setUsers(users);
        } catch (e) {
            this.trace(`loadUsers error=${e?.message || e}`);
        }
    }

    async executeAuth(mode, username, password, { logAttempt = true } = {}) {
        const errorBox = document.getElementById('authError');
        this.S.auth.loading = true;
        this.updateAuthView();

        try {
            if (this.isWindowsNativeAuth()) {
                return await this.executeNativeAuth(mode, username, password, { logAttempt });
            }

            const endpoint = mode === 'register' ? '/api/auth/register' : '/api/auth/login';
            if (mode === 'register' && logAttempt) {
                this.addLogEntry({
                    type: 'INFO',
                    msg: `Попытка регистрации: ${username}`,
                    ts: new Date().toLocaleTimeString()
                });
            }

            const requestAuth = async () => {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 12000);
                try {
                    return await fetch(this.apiUrl(endpoint), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password }),
                        signal: controller.signal,
                    });
                } finally {
                    clearTimeout(timeoutId);
                }
            };

            let res;
            let lastError = null;
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    res = await requestAuth();
                    lastError = null;
                    break;
                } catch (err) {
                    lastError = err;
                    const msg = String(err?.message || err || '');
                    if (!/load failed|failed to fetch|network error/i.test(msg) || attempt === 1) {
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
            }

            if (!res) {
                throw lastError || new Error('Не удалось связаться с сервером');
            }

            if (mode === 'register') {
                if (!res.ok) {
                    const text = await res.text();
                    if (res.status === 409 || /Пользователь уже существует/i.test(text)) {
                        this.addLogEntry({
                            type: 'INFO',
                            msg: `Аккаунт ${username} уже есть, пробуем войти с этим паролем`,
                            ts: new Date().toLocaleTimeString()
                        });

                        const recovered = await this.executeAuth('login', username, password, { logAttempt: false });
                        if (recovered) {
                            this.addLogEntry({
                                type: 'SUCCESS',
                                msg: `Вход восстановлен для ${username}`,
                                ts: new Date().toLocaleTimeString()
                            });
                            return true;
                        }
                    }

                    this.addLogEntry({
                        type: 'WARN',
                        msg: `Регистрация отклонена для ${username}: ${text || res.status}`,
                        ts: new Date().toLocaleTimeString()
                    });
                    throw new Error(text || 'Не удалось зарегистрироваться');
                }

                const data = await res.json();
                this.applySession({
                    username: data.username || username,
                    token: data.token,
                    guest: false,
                });
                this.setAuthMode('login', { clearInputs: true, focus: false });
                await this.loadContacts();
                await this.loadUsers();

                this.addLogEntry({
                    type: 'SUCCESS',
                    msg: `Регистрация успешна, вход выполнен как ${this.myName()}`,
                    ts: new Date().toLocaleTimeString()
                });
                this.clearAuthInputs();
                return true;
            }

            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Не удалось войти');
            }

            const data = await res.json();
            this.applySession({
                username: data.username || username,
                token: data.token,
                guest: false,
            });
            this.setAuthMode('login', { clearInputs: true, focus: false });
            await this.loadContacts();
            await this.loadUsers();
            this.clearAuthInputs();
            this.addLogEntry({ type: 'SUCCESS', msg: `Вход выполнен как ${this.myName()}`, ts: new Date().toLocaleTimeString() });
            return true;
        } catch (e) {
            const raw = e.message || 'Ошибка входа';
            const apiBaseUrl = this.getApiBaseUrl();
            const friendly = /load failed|failed to fetch|network error/i.test(raw)
                ? `Не удалось связаться с сервером (${apiBaseUrl}). Проверь адрес или запусти backend.`
                : raw;
            this.S.auth.error = friendly;
            if (errorBox) errorBox.textContent = friendly;
            if (mode === 'register') {
                this.addLogEntry({
                    type: 'ERROR',
                    msg: `Ошибка регистрации для ${username}: ${friendly}`,
                    ts: new Date().toLocaleTimeString()
                });
            }
            return false;
        } finally {
            this.S.auth.loading = false;
            this.updateAuthView();
        }
    }

    async executeNativeAuth(mode, username, password, { logAttempt = true } = {}) {
        const requestId = `auth-${Date.now()}-${Math.random().toString(16).slice(2)}`;
        const request = {
            type: 'AUTH_REQUEST',
            mode,
            username,
            password,
            requestId,
        };

        if (mode === 'register' && logAttempt) {
            this.addLogEntry({
                type: 'INFO',
                msg: `Попытка регистрации: ${username}`,
                ts: new Date().toLocaleTimeString()
            });
        }

        const payload = await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.nativeAuthRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }, 15000);

            this.nativeAuthRequests.set(requestId, { resolve, reject, timeoutId });

            if (!this.postNativeMessage(request)) {
                clearTimeout(timeoutId);
                this.nativeAuthRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }
        });

        const data = payload?.data || payload;
        this.applySession({
            username: data.username || username,
            token: data.token,
            guest: false,
        });
        this.setAuthMode('login', { clearInputs: true, focus: false });
        this.clearAuthInputs();
        this.addLogEntry({
            type: 'SUCCESS',
            msg: mode === 'register'
                ? `Регистрация успешна, вход выполнен как ${this.myName()}`
                : `Вход выполнен как ${this.myName()}`,
            ts: new Date().toLocaleTimeString()
        });
        return true;
    }

    async requestNativeAction(payload, timeoutMs = 15000) {
        const requestId = String(payload?.requestId || `native-${Date.now()}-${Math.random().toString(16).slice(2)}`);
        const request = { ...payload, requestId };
        return await new Promise((resolve, reject) => {
            const timeoutId = setTimeout(() => {
                this.nativeRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }, timeoutMs);

            this.nativeRequests.set(requestId, { resolve, reject, timeoutId });

            if (!this.postNativeMessage(request)) {
                clearTimeout(timeoutId);
                this.nativeRequests.delete(requestId);
                reject(new Error('Не удалось связаться с сервером'));
            }
        });
    }

    onNativeResponse(payload) {
        if (!payload || typeof payload !== 'object') return;
        const requestId = String(payload.requestId || '').trim();
        if (!requestId) return;
        const pending = this.nativeRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        this.nativeRequests.delete(requestId);
        if (payload.ok) {
            pending.resolve(payload);
        } else {
            pending.reject(new Error(payload.error || 'Операция не удалась'));
        }
    }

    onNativeAuthResponse(payload) {
        if (!payload || typeof payload !== 'object') return;
        const requestId = String(payload.requestId || '').trim();
        if (!requestId) return;
        const pending = this.nativeAuthRequests.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timeoutId);
        this.nativeAuthRequests.delete(requestId);
        if (payload.ok) {
            pending.resolve(payload);
        } else {
            pending.reject(new Error(payload.error || 'Не удалось войти'));
        }
    }

    async submitAuth(mode) {
        if (this.S.auth.loading) {
            return;
        }

        const usernameInput = document.getElementById('authUsername');
        const passwordInput = document.getElementById('authPassword');
        const username = (usernameInput?.value || '').trim();
        const password = passwordInput?.value || '';
        const errorBox = document.getElementById('authError');

        if (errorBox) errorBox.textContent = '';
        this.S.auth.error = '';
        if (!username || !password) {
            const msg = 'Введите логин и пароль';
            this.S.auth.error = msg;
            if (errorBox) errorBox.textContent = msg;
            return;
        }

        if (mode === 'register') {
            if (username.length > 64) {
                const msg = 'Логин слишком длинный: максимум 64 символа';
                this.S.auth.error = msg;
                if (errorBox) errorBox.textContent = msg;
                this.addLogEntry({ type: 'WARN', msg: `Регистрация отклонена для ${username}: ${msg}`, ts: new Date().toLocaleTimeString() });
                return;
            }

            if (password.length < 6) {
                const msg = 'Пароль должен быть не менее 6 символов';
                this.S.auth.error = msg;
                if (errorBox) errorBox.textContent = msg;
                this.addLogEntry({ type: 'WARN', msg: `Регистрация отклонена для ${username}: ${msg}`, ts: new Date().toLocaleTimeString() });
                return;
            }
        }

        const authApiBaseUrl = document.getElementById('authApiBaseUrl');
        const typedApiBaseUrl = String(authApiBaseUrl?.value || '').trim();
        if (typedApiBaseUrl) {
            try {
                const current = this.loadNetworkConfig();
                const typedWsBaseUrl = this.deriveWsBaseUrl(typedApiBaseUrl);
                if (typedApiBaseUrl !== current.apiBaseUrl || typedWsBaseUrl !== current.wsBaseUrl) {
                    this.setNetworkConfig({
                        apiBaseUrl: typedApiBaseUrl,
                        wsBaseUrl: typedWsBaseUrl,
                        iceServers: current.iceServers,
                    });
                }
            } catch (e) {
                const msg = e?.message || 'Не удалось сохранить адрес сервера';
                this.S.auth.error = msg;
                if (errorBox) errorBox.textContent = msg;
                return;
            }
        }

        return this.executeAuth(mode, username, password);
    }

    continueAsGuest() {
        this.S.auth.dismissed = true;
        this.S.auth.error = '';
        this.clearAuthInputs();
        this.S.auth.fieldsCleared = true;
        this.applySession({ username: 'Zalikus', token: null, guest: true }, { persist: false });
        this.loadContacts();
        this.updateAuthView();
    }

    async logout() {
        this.S.auth.dismissed = false;
        this.S.auth.error = '';
        this.setAuthMode('login', { clearInputs: true, focus: false });
        this.clearStoredSession();
        this.applySession({ username: 'Zalikus', token: null, guest: true }, { persist: false, syncNative: false, connectVoiceSocket: false });
        this.S.contacts = [];
        this.S.users = [];
        this.S.current = null;
        this.resetVoiceState({ preserveInvite: false });
        this.disconnectBrowserVoiceSocket();
        this.renderContacts();
        this.renderMessages();
        this.updateAuthView();
        this.addLogEntry({ type: 'WARN', msg: 'Сеанс завершён', ts: new Date().toLocaleTimeString() });
    }

    async addContactFromInput(usernameOverride = null) {
        if (!this.S.session?.token) {
            const msg = 'Сначала войдите в аккаунт, чтобы добавлять контакты';
            this.addLogEntry({ type: 'WARN', msg, ts: new Date().toLocaleTimeString() });
            this.S.auth.error = msg;
            this.updateAuthView();
            return;
        }

        const input = document.getElementById('contactInput');
        const username = (usernameOverride ?? input?.value ?? '').trim();
        if (!username) return;

        try {
            if (this.isWindowsNativeAuth()) {
                const payload = await this.requestNativeAction({
                    type: 'ADD_CONTACT_REQUEST',
                    username,
                });
                this.setContacts(Array.isArray(payload?.data?.contacts) ? payload.data.contacts : []);
                if (input) input.value = '';
                this.hideContactSuggestions();
                this.addLogEntry({ type: 'SUCCESS', msg: `Контакт добавлен: ${username}`, ts: new Date().toLocaleTimeString() });
                return;
            }
            const res = await this.apiFetch('/api/contacts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username }),
            });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Не удалось добавить контакт');
            }
            const data = await res.json();
            this.setContacts(Array.isArray(data?.contacts) ? data.contacts : []);
            if (input) input.value = '';
            this.hideContactSuggestions();
            this.addLogEntry({ type: 'SUCCESS', msg: `Контакт добавлен: ${username}`, ts: new Date().toLocaleTimeString() });
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: e.message || 'Не удалось добавить контакт', ts: new Date().toLocaleTimeString() });
        }
    }

    async removeContact(username) {
        if (!this.S.session?.token) {
            this.addLogEntry({ type: 'WARN', msg: 'Удаление контактов доступно только после входа', ts: new Date().toLocaleTimeString() });
            return;
        }
        try {
            if (this.isWindowsNativeAuth()) {
                const payload = await this.requestNativeAction({
                    type: 'REMOVE_CONTACT_REQUEST',
                    username,
                });
                this.setContacts(Array.isArray(payload?.data?.contacts) ? payload.data.contacts : []);
                return;
            }
            const res = await this.apiFetch(`/api/contacts/${encodeURIComponent(username)}`, { method: 'DELETE' });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(text || 'Не удалось удалить контакт');
            }
            const data = await res.json();
            this.setContacts(Array.isArray(data?.contacts) ? data.contacts : []);
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: e.message || 'Не удалось удалить контакт', ts: new Date().toLocaleTimeString() });
        }
    }

    updateAuthView() {
        const overlay = document.getElementById('authOverlay');
        if (overlay) {
            const shouldShow = !this.S.session?.token && !this.S.auth.dismissed;
            overlay.classList.toggle('visible', shouldShow);
        }

        const authTitle = document.getElementById('authTitle');
        const authHint = document.getElementById('authHint');
        const authError = document.getElementById('authError');
        const loginBtn = document.getElementById('authLoginBtn');
        const regBtn = document.getElementById('authRegisterBtn');
        const guestBtn = document.getElementById('authGuestBtn');
        if (authTitle) authTitle.textContent = this.S.auth.mode === 'register' ? 'Создание аккаунта' : 'Вход в аккаунт';
        if (authHint) authHint.textContent = this.S.auth.mode === 'register'
            ? 'Зарегистрируйтесь, чтобы сохранить контакты и историю.'
            : 'Войдите, чтобы синхронизировать сообщения и контакты.';
        if (authError) authError.textContent = this.S.auth.error || '';
        if (loginBtn) loginBtn.textContent = this.S.auth.loading
            ? 'Входим...'
            : (this.S.auth.mode === 'register' ? 'Создать аккаунт' : 'Войти');
        if (regBtn) regBtn.textContent = this.S.auth.mode === 'register' ? 'Уже есть аккаунт' : 'Создать аккаунт';
        if (loginBtn) loginBtn.disabled = this.S.auth.loading;
        if (regBtn) regBtn.disabled = this.S.auth.loading;
        if (guestBtn) guestBtn.disabled = this.S.auth.loading;
        this.syncAuthNetworkInput();
        if (!this.S.session?.token && overlay && overlay.classList.contains('visible') && !this.S.auth.fieldsCleared && !this.S.auth.loading) {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        }
        this.renderSidebarProfile();
    }

    initChat(name) { 
        if (!this.S.chats[name]) this.S.chats[name] = []; 
    }

    ensureContact(name) {
        if (!name || name === this.myName()) return;
        if (!this.S.contacts.includes(name)) {
            this.S.contacts = [name, ...this.S.contacts];
        }
        this.initChat(name);
    }

    normalizeAttachment(att = {}) {
        const mimeType = att.mimeType || att.mime_type || '';
        const kind = att.kind || (
            mimeType.startsWith('video/') ? 'video' :
            mimeType === 'image/gif' ? 'gif' :
            mimeType.startsWith('image/') ? 'image' : 'file'
        );
        return {
            id: att.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: att.name || 'attachment',
            mimeType,
            kind,
            size: Number(att.size || 0),
            dataUrl: att.dataUrl || att.data_url || att.url || '',
            archivePath: att.archivePath || att.archive_path || '',
        };
    }

    normalizeAttachments(attachments) {
        return Array.isArray(attachments) ? attachments.map(att => this.normalizeAttachment(att)) : [];
    }

    formatFileSize(bytes) {
        const size = Number(bytes || 0);
        if (!Number.isFinite(size) || size <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = size;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }
        const precision = unitIndex === 0 ? 0 : value < 10 ? 1 : 0;
        return `${value.toFixed(precision)} ${units[unitIndex]}`;
    }

    inferMimeType(file) {
        if (file && file.type) return file.type;
        const name = (file && file.name || '').toLowerCase();
        if (name.endsWith('.png')) return 'image/png';
        if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
        if (name.endsWith('.webp')) return 'image/webp';
        if (name.endsWith('.gif')) return 'image/gif';
        if (name.endsWith('.mp4')) return 'video/mp4';
        if (name.endsWith('.webm')) return 'video/webm';
        return 'application/octet-stream';
    }

    fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
            reader.readAsDataURL(file);
        });
    }

    async fileToAttachment(file) {
        const mimeType = this.inferMimeType(file);
        const kind = mimeType.startsWith('video/') ? 'video' : mimeType === 'image/gif' ? 'gif' : mimeType.startsWith('image/') ? 'image' : 'file';
        const dataUrl = await this.fileToDataUrl(file);
        return this.normalizeAttachment({
            name: file.name,
            mimeType,
            kind,
            size: file.size,
            dataUrl,
        });
    }

    async handleFiles(fileList) {
        const files = Array.from(fileList || []);
        if (files.length === 0) return;
        const attachments = await Promise.all(files.map(file => this.fileToAttachment(file)));
        this.S.draftAttachments = this.S.draftAttachments.concat(attachments);
        this.renderDraftAttachments();
        this.updateSendButtonState();
    }

    clearDraftAttachments() {
        this.S.draftAttachments = [];
        this.renderDraftAttachments();
        this.updateSendButtonState();
    }

    renderDraftAttachments() {
        const wrap = document.getElementById('draftAttachments');
        if (!wrap) return;

        if (!this.S.draftAttachments.length) {
            wrap.innerHTML = '';
            wrap.classList.remove('has-items');
            return;
        }

        wrap.classList.add('has-items');
        wrap.innerHTML = this.S.draftAttachments.map(att => {
            const thumb = this.renderAttachmentPreview(att, true);
            return `<div class="draft-att" data-att-id="${this.esc(att.id)}">
                <button class="draft-att-remove" type="button" data-att-id="${this.esc(att.id)}" title="Удалить вложение">×</button>
                ${thumb}
                <div class="draft-att-name">${this.esc(att.name)}</div>
            </div>`;
        }).join('');
    }

    resizeComposer() {
        const inp = document.getElementById('msgInput');
        if (!inp) return;
        inp.style.height = 'auto';
        inp.style.height = `${Math.min(inp.scrollHeight, 140)}px`;
    }

    extractUrls(text) {
        if (!text) return [];
        const re = /https?:\/\/[^\s<>()"]+/gi;
        return String(text).match(re) || [];
    }

    isTenorUrl(url) {
        try {
            const u = new URL(url);
            return /(^|\.)tenor\.com$/.test(u.hostname) || /(^|\.)media\d*\.tenor\.com$/.test(u.hostname) || /(^|\.)c\.tenor\.com$/.test(u.hostname);
        } catch (e) {
            return false;
        }
    }

    tenorCacheKey(url) {
        return `tenor:${url}`;
    }

    requestTenorResolution(url) {
        const key = this.tenorCacheKey(url);
        if (this.tenorCache.has(key) || this.tenorPending.has(key)) return;
        this.tenorPending.add(key);

        if (this.nativeSupports('tenor')) {
            this.postNativeMessage({
                type: 'RESOLVE_TENOR',
                url,
                requestId: key,
            });
        } else {
            this.tenorPending.delete(key);
        }
    }

    onTenorResolved(payload) {
        let data = payload;
        if (typeof payload === 'string') {
            try {
                data = JSON.parse(payload);
            } catch (e) {
                return;
            }
        }

        if (!data || !data.sourceUrl) return;
        const key = this.tenorCacheKey(data.sourceUrl);
        this.tenorPending.delete(key);

        if (data.mediaUrl) {
            this.tenorCache.set(key, {
                mediaUrl: data.mediaUrl,
                mimeType: data.mimeType || '',
                kind: data.kind || '',
            });
            this.renderMessages();
            this.renderContacts();
        }
    }

    isDirectMediaUrl(url) {
        try {
            const u = new URL(url);
            return /\.(gif|png|jpe?g|webp|mp4|webm)(\?.*)?$/i.test(u.pathname);
        } catch (e) {
            return false;
        }
    }

    renderMessageText(text) {
        const urls = this.extractUrls(text);
        if (!urls.length) {
            return this.esc(text).replace(/\n/g, '<br>');
        }

        const escaped = this.esc(text).replace(/\n/g, '<br>');
        return escaped.replace(/https?:\/\/[^\s<>()"]+/gi, (match) => {
            const safe = this.esc(match);
            return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${safe}</a>`;
        });
    }

    mediaShellStyle(src, { gifLike = false, fallbackAspectRatio = '16 / 9' } = {}) {
        if (gifLike) return '';
        const cached = src ? this.mediaSizeCache.get(src) : null;
        const width = Number(cached?.width || 0);
        const height = Number(cached?.height || 0);
        const ratio = width > 0 && height > 0 ? `${width} / ${height}` : fallbackAspectRatio;
        return ratio ? ` style="aspect-ratio: ${ratio};"` : '';
    }

    renderAttachmentPreview(att, compact = false, options = {}) {
        const attachment = this.normalizeAttachment(att);
        const src = attachment.dataUrl || attachment.url || '';
        const gifLike = !!options.gifLike || attachment.kind === 'gif' || attachment.mimeType === 'image/gif';
        const showControls = options.controls !== undefined ? !!options.controls : !gifLike;
        if (!src) {
            return `<div class="media-unknown">${this.esc(attachment.name)}</div>`;
        }

        if (attachment.kind === 'video' || (attachment.mimeType || '').startsWith('video/')) {
            const shellClass = `discord-media-shell discord-media-shell-video${gifLike ? ' discord-media-shell-gif' : ''}${compact ? ' compact' : ''}`;
            const shellStyle = this.mediaShellStyle(src, { gifLike });
            return `<div class="${shellClass}"${shellStyle}>
                <video class="media media-video${compact ? ' compact' : ''}${gifLike ? ' media-gif-like' : ''}" data-gif-like="${gifLike ? '1' : '0'}" src="${this.esc(src)}"${showControls ? ' controls' : ''} autoplay loop muted playsinline preload="${gifLike ? 'auto' : 'metadata'}"></video>
            </div>`;
        }

        if (attachment.kind === 'gif' || attachment.mimeType === 'image/gif' || (attachment.mimeType || '').startsWith('image/')) {
            const gifClass = gifLike ? ' media-gif-like' : '';
            const shellGifClass = gifLike ? ' discord-media-shell-gif' : '';
            const shellStyle = this.mediaShellStyle(src, { gifLike });
            return `<div class="discord-media-shell discord-media-shell-image${shellGifClass}${compact ? ' compact' : ''}"${shellStyle}>
                <img class="media media-img${compact ? ' compact' : ''}${gifClass}" src="${this.esc(src)}" alt="${this.esc(attachment.name)}" loading="lazy" decoding="async" fetchpriority="low">
            </div>`;
        }

        const sizeLabel = this.formatFileSize(attachment.size);
        if (compact) {
            return `<a class="file-chip${compact ? ' compact' : ''}" href="${this.esc(src)}" download="${this.esc(attachment.name)}">
                <span class="file-chip-name">${this.esc(attachment.name)}</span>
                <span class="file-chip-size">${this.esc(sizeLabel)}</span>
            </a>`;
        }

        return `<a class="file-message" href="${this.esc(src)}" download="${this.esc(attachment.name)}">
            <span class="file-message-name">${this.esc(attachment.name)}</span>
            <span class="file-message-size">${this.esc(sizeLabel)}</span>
        </a>`;
    }

    sanitizeDecryptionErrorText(text) {
        const value = String(text || '').trim();
        if (!value) return '';
        if (/^(?:🚨\s*)?\[Ошибка расшифрования:[^\]]*\]$/.test(value)) {
            return '';
        }
        return text;
    }

    hydrateGifMedia(root = document) {
        const videos = root.querySelectorAll?.('video.media-gif-like[data-gif-like="1"]') || [];
        videos.forEach(video => {
            if (!(video instanceof HTMLMediaElement)) return;
            if (video.dataset.gifBound === '1') return;

            video.dataset.gifBound = '1';
            video.loop = true;
            video.muted = true;
            video.playsInline = true;
            video.preload = 'auto';
            video.style.backgroundColor = 'transparent';
            video.style.objectFit = 'contain';
            video.style.width = '100%';
            video.style.height = '100%';
            video.style.removeProperty('aspect-ratio');

            const shell = video.closest('.discord-media-shell');
            const src = video.currentSrc || video.src || video.getAttribute('src') || '';
            const cacheSize = (width, height) => {
                if (!src || !width || !height) return;
                this.mediaSizeCache.set(src, { width, height });
            };

            const ensurePlaying = () => {
                if (video.dataset.userPaused === '1') return;
                if (video.paused) {
                    video.play?.().catch(() => {});
                }
            };

            const syncFromMetadata = () => {
                const width = Number(video.videoWidth || 0);
                const height = Number(video.videoHeight || 0);
                cacheSize(width, height);
                ensurePlaying();
            };

            video.addEventListener('loadedmetadata', syncFromMetadata, { once: true });
            video.addEventListener('loadeddata', syncFromMetadata, { once: true });

            if (window.IntersectionObserver) {
                const observer = new IntersectionObserver((entries) => {
                    const entry = entries[0];
                    if (!entry) return;
                    if (video.dataset.userPaused === '1') return;
                    if (entry.isIntersecting) {
                        ensurePlaying();
                    }
                }, { root: null, threshold: 0.15, rootMargin: '160px' });
                observer.observe(video);
                video.dataset.gifObserver = '1';
                return;
            }

            ensurePlaying();
        });

        const images = root.querySelectorAll?.('img.media-gif-like:not([data-gif-like="1"])') || [];
        images.forEach(img => {
            if (!(img instanceof HTMLImageElement)) return;
            if (img.dataset.gifBound === '1') return;
            img.dataset.gifBound = '1';
            const shell = img.closest('.discord-media-shell');
            const src = img.currentSrc || img.src || img.getAttribute('src') || '';
            const cacheSize = (width, height) => {
                if (!src || !width || !height) return;
                this.mediaSizeCache.set(src, { width, height });
            };
            const syncFromImage = () => {
                const width = Number(img.naturalWidth || 0);
                const height = Number(img.naturalHeight || 0);
                cacheSize(width, height);
            };
            if (img.complete) {
                syncFromImage();
            } else {
                img.addEventListener('load', syncFromImage, { once: true });
            }
        });
    }

    renderUrlPreview(url) {
        if (!url) return '';
        let path = '';
        try {
            path = new URL(url).pathname.toLowerCase();
        } catch (e) {
            path = url.toLowerCase();
        }

        if (this.isTenorUrl(url)) {
            if (this.isDirectMediaUrl(url)) {
                return this.renderAttachmentPreview({
                    name: 'Tenor',
                    mimeType: path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.webm') ? 'video/webm' : 'image/gif',
                    kind: path.endsWith('.mp4') || path.endsWith('.webm') ? 'video' : 'gif',
                    dataUrl: url
                }, false, { gifLike: true });
            }

            const cached = this.tenorCache.get(this.tenorCacheKey(url));
            if (cached?.mediaUrl) {
                const mimeType = cached.mimeType || (path.endsWith('.mp4') ? 'video/mp4' : 'image/gif');
                const kind = cached.kind || (mimeType.startsWith('video/') ? 'video' : 'gif');
                return this.renderAttachmentPreview({
                    name: 'Tenor',
                    mimeType,
                    kind,
                    dataUrl: cached.mediaUrl
                }, false, { gifLike: true });
            }

            this.requestTenorResolution(url);
            return `<div class="media media-tenor media-tenor-pending">
                <div class="tenor-badge">Tenor GIF</div>
                <div class="tenor-hint">Загружаем анимацию...</div>
            </div>`;
        }

        if (this.isDirectMediaUrl(url)) {
            return this.renderAttachmentPreview({
                name: url.split('/').pop() || 'media',
                mimeType: path.endsWith('.mp4') ? 'video/mp4' : path.endsWith('.webm') ? 'video/webm' : path.endsWith('.gif') ? 'image/gif' : 'image/*',
                kind: path.endsWith('.mp4') || path.endsWith('.webm') ? 'video' : 'image',
                dataUrl: url
            });
        }

        return '';
    }

    renderMessageBody(msg) {
        if (msg?.kind === 'call') {
            return this.renderCallMessage(msg);
        }
        const attachments = this.normalizeAttachments(msg.attachments);
        const urls = this.extractUrls(msg.text);
        const isOnlyUrl = (msg.text || '').trim() && urls.length === 1 && (msg.text || '').trim() === urls[0];
        const previewBlocks = urls.map(url => this.renderUrlPreview(url)).filter(Boolean);
        const bodyParts = [];

        if (!isOnlyUrl || previewBlocks.length === 0 || (msg.text || '').trim() !== urls[0]) {
            if (msg.text) {
                bodyParts.push(`<div class="msg-text">${this.renderMessageText(msg.text)}</div>`);
            }
        }

        if (attachments.length) {
            bodyParts.push(`<div class="msg-attachments">${attachments.map(att => this.renderAttachmentPreview(att)).join('')}</div>`);
        }

        if (previewBlocks.length) {
            bodyParts.push(`<div class="msg-attachments msg-link-previews">${previewBlocks.join('')}</div>`);
        }

        return bodyParts.join('');
    }

    renderCallMessage(msg) {
        const call = msg?.call || {};
        const direction = String(call.direction || '').trim() || (this.isOutgoingMessage(msg) ? 'outgoing' : 'incoming');
        const outcome = String(call.outcome || '').trim() || 'completed';
        const peer = String(call.peer || msg.receiver || msg.sender || '').trim();
        const startedAt = call.connectedAt || call.startedAt || msg.timestamp;
        const endedAt = call.endedAt || msg.timestamp;
        const durationMs = Number(call.durationMs || 0) || 0;
        const whenLabel = this.fmtDate(startedAt);
        const timeLabel = this.fmtTime(startedAt || endedAt);
        const durationLabel = this.formatDuration(durationMs);
        const title = outcome === 'missed'
            ? `Пропущенный звонок`
            : outcome === 'rejected'
                ? `Звонок отклонён`
                : outcome === 'cancelled'
                    ? `Звонок отменён`
                    : direction === 'outgoing'
                        ? `Исходящий звонок`
                        : `Входящий звонок`;
        const subject = direction === 'outgoing'
            ? `К ${peer || 'контакту'}`
            : `От ${peer || 'контакта'}`;
        const durationText = durationLabel === '00:00' && outcome !== 'completed'
            ? '00:00'
            : durationLabel;
        return `
            <div class="call-card ${this.esc(outcome)} ${this.esc(direction)}">
                <div class="call-card-top">
                    <div class="call-card-icon">${outcome === 'completed' ? '📞' : '⨯'}</div>
                    <div class="call-card-copy">
                        <div class="call-card-title">${this.esc(title)}</div>
                        <div class="call-card-sub">${this.esc(subject)}</div>
                    </div>
                </div>
                <div class="call-card-meta">
                    <span>Когда: ${this.esc(whenLabel ? `${whenLabel}, ${timeLabel}` : timeLabel)}</span>
                    <span>Длительность: ${this.esc(durationText)}</span>
                </div>
            </div>
        `;
    }

    messageHasMedia(msg) {
        const attachments = this.normalizeAttachments(msg.attachments);
        if (attachments.some(att => att.kind === 'image' || att.kind === 'video' || att.kind === 'gif' || (att.mimeType || '').startsWith('image/') || (att.mimeType || '').startsWith('video/'))) {
            return true;
        }
        const urls = this.extractUrls(msg.text);
        return urls.some(url => this.isTenorUrl(url) || this.isDirectMediaUrl(url));
    }

    messageIsGifOnly(msg) {
        const text = (msg.text || '').trim();
        if (text) return false;

        const attachments = this.normalizeAttachments(msg.attachments);
        if (attachments.length > 0) {
            return attachments.every(att =>
                att.kind === 'gif' ||
                att.mimeType === 'image/gif' ||
                (att.mimeType || '').startsWith('image/')
            );
        }

        const urls = this.extractUrls(msg.text);
        if (urls.length !== 1) return false;

        const url = urls[0];
        if (!this.isTenorUrl(url) && !this.isDirectMediaUrl(url)) return false;
        const path = (() => {
            try { return new URL(url).pathname.toLowerCase(); }
            catch (e) { return url.toLowerCase(); }
        })();
        return path.endsWith('.gif') || this.isTenorUrl(url);
    }

    messageSummary(msg) {
        if (msg?.kind === 'call') {
            const call = msg.call || {};
            const direction = String(call.direction || '').trim();
            const outcome = String(call.outcome || '').trim();
            const peer = String(call.peer || msg.receiver || msg.sender || '').trim();
            const duration = this.formatDuration(call.durationMs || 0);
            if (outcome === 'missed') return `Пропущенный звонок${peer ? ` · ${peer}` : ''}`;
            if (outcome === 'rejected') return `Отклонённый звонок${peer ? ` · ${peer}` : ''}`;
            if (outcome === 'cancelled') return `Отменённый звонок${peer ? ` · ${peer}` : ''}`;
            return `Звонок${peer ? ` · ${peer}` : ''}${duration ? ` · ${duration}` : ''}`;
        }
        const attachments = this.normalizeAttachments(msg.attachments);
        if (attachments.length) {
            const first = attachments[0];
            if (first.kind === 'video' || first.mimeType.startsWith('video/')) return 'Видео';
            if (first.kind === 'gif' || first.mimeType === 'image/gif') return 'GIF';
            if (first.mimeType.startsWith('image/')) return 'Фото';
            return 'Файл';
        }

        const urls = this.extractUrls(msg.text);
        if (urls.some(url => this.isTenorUrl(url))) {
            return 'Tenor GIF';
        }

        const text = (msg.text || '').trim();
        if (!text) return 'Сообщение';
        return text.length > 32 ? `${text.slice(0, 32)}…` : text;
    }

    messageRenderKey(msg) {
        if (!msg || typeof msg !== 'object') return '';
        if (msg.clientId) return `cid:${msg.clientId}`;
        if (msg.id) return `id:${msg.id}`;
        const attachments = this.normalizeAttachments(msg.attachments);
        const attachmentKey = attachments
            .map(att => `${att.name}:${att.kind}:${att.size}:${att.mimeType}`)
            .join('|');
        const call = msg.kind === 'call' ? msg.call || {} : {};
        return [
            msg.kind || '',
            msg.sender || '',
            msg.receiver || '',
            msg.timestamp || '',
            msg.text || '',
            call.roomId || '',
            call.direction || '',
            call.outcome || '',
            call.peer || '',
            call.durationMs || '',
            attachmentKey,
        ].join('::');
    }

    normalizeReactions(reactions) {
        if (!reactions) return [];
        const list = Array.isArray(reactions)
            ? reactions
            : Object.entries(reactions).map(([emoji, count]) => ({ emoji, count }));
        return list
            .map(item => ({
                emoji: String(item?.emoji || '').trim(),
                count: Number(item?.count || 0) || 0,
            }))
            .filter(item => item.emoji && item.count > 0)
            .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));
    }

    findMessageById(messageId) {
        const id = String(messageId || '').trim();
        if (!id) return null;
        for (const [peer, msgs] of Object.entries(this.S.chats)) {
            const index = msgs.findIndex(msg => String(msg.id || '').trim() === id || String(msg.clientId || '').trim() === id);
            if (index >= 0) {
                return { peer, msg: msgs[index], index };
            }
        }
        for (const [key, msgs] of Object.entries(this.S.serverChats || {})) {
            const index = msgs.findIndex(msg => String(msg.id || '').trim() === id || String(msg.clientId || '').trim() === id);
            if (index >= 0) {
                return { peer: key, msg: msgs[index], index, serverKey: key };
            }
        }
        return null;
    }

    renderMessageReactions(msg) {
        const messageId = String(msg?.id || '').trim();
        if (!messageId) return '';

        const reactions = this.normalizeReactions(msg.reactions);
        const myReaction = String(msg.myReaction || '').trim();
        return reactions.length
            ? `<div class="reaction-row">
                ${reactions.map(reaction => {
                    const mine = myReaction && myReaction === reaction.emoji ? ' mine' : '';
                    return `<span class="reaction-chip${mine}" title="${this.esc(reaction.emoji)}">
                        <span class="reaction-emoji">${this.esc(reaction.emoji)}</span>
                        <span class="reaction-count">${reaction.count}</span>
                    </span>`;
                }).join('')}
            </div>`
            : '';
    }

    ensureReactionMenu() {
        let menu = document.getElementById('reactionMenu');
        if (menu) return menu;
        menu = document.createElement('div');
        menu.id = 'reactionMenu';
        menu.className = 'reaction-menu';
        menu.setAttribute('aria-hidden', 'true');
        menu.innerHTML = this.reactionOptions.map(emoji => (
            `<button class="reaction-btn" type="button" data-menu-reaction="${this.esc(emoji)}">${this.esc(emoji)}</button>`
        )).join('');
        document.body.appendChild(menu);

        menu.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-menu-reaction]');
            if (!btn) return;
            const emoji = btn.getAttribute('data-menu-reaction');
            const messageId = menu.getAttribute('data-message-id');
            if (messageId && emoji) {
                this.addReaction(messageId, emoji);
            }
            this.hideReactionMenu();
        });

        return menu;
    }

    showReactionMenu(messageEl, messageId, x, y) {
        const menu = this.ensureReactionMenu();
        if (!menu || !messageEl) return;
        menu.setAttribute('data-message-id', messageId);
        menu.classList.add('visible');
        menu.setAttribute('aria-hidden', 'false');
        menu.style.left = '0px';
        menu.style.top = '0px';
        const rect = menu.getBoundingClientRect();
        const pad = 12;
        const maxLeft = window.innerWidth - rect.width - pad;
        const maxTop = window.innerHeight - rect.height - pad;
        const left = Math.max(pad, Math.min(x, maxLeft));
        const top = Math.max(pad, Math.min(y, maxTop));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;
    }

    hideReactionMenu() {
        const menu = document.getElementById('reactionMenu');
        if (!menu) return;
        menu.classList.remove('visible');
        menu.setAttribute('aria-hidden', 'true');
        menu.removeAttribute('data-message-id');
    }

    markMessageSeen(msg) {
        const key = this.messageRenderKey(msg);
        if (key) this.messageAnimSeen.add(key);
    }

    markMessageStatus(clientId, status) {
        if (!clientId) return;
        let updated = false;
        for (const peer of Object.keys(this.S.chats)) {
            const msgs = this.S.chats[peer];
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].clientId === clientId) {
                    msgs[i].status = status;
                    if (status === 'error') msgs[i].error = true;
                    updated = true;
                    break;
                }
            }
            // No visible status badges in the message UI, so avoid full rerender.
            // The data is still updated for persistence / history consistency.
            if (updated) break;
        }
        if (!updated) {
            for (const key of Object.keys(this.S.serverChats || {})) {
                const msgs = this.S.serverChats[key];
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (msgs[i].clientId === clientId) {
                        msgs[i].status = status;
                        if (status === 'error') msgs[i].error = true;
                        updated = true;
                        break;
                    }
                }
                if (updated) break;
            }
        }
    }

    finalizePendingMessage(clientId, messageId, { render = true } = {}) {
        const pendingId = String(clientId || '').trim();
        if (!pendingId) return false;
        const serverId = String(messageId || '').trim();
        let updated = false;
        for (const peer of Object.keys(this.S.chats)) {
            const msgs = this.S.chats[peer];
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (String(msgs[i].clientId || '').trim() === pendingId) {
                    msgs[i].status = 'sent';
                    if (serverId) msgs[i].id = serverId;
                    updated = true;
                    break;
                }
            }
            if (updated) break;
        }
        if (!updated) {
            for (const key of Object.keys(this.S.serverChats || {})) {
                const msgs = this.S.serverChats[key];
                for (let i = msgs.length - 1; i >= 0; i--) {
                    if (String(msgs[i].clientId || '').trim() === pendingId) {
                        msgs[i].status = 'sent';
                        if (serverId) msgs[i].id = serverId;
                        updated = true;
                        break;
                    }
                }
                if (updated) break;
            }
        }
        if (updated && render) {
            this.renderMessages();
        }
        return updated;
    }

    applyLocalReaction(found, emoji) {
        if (!found || !found.msg) return;
        const message = found.msg;
        const current = String(message.myReaction || '').trim();
        const next = current === emoji ? '' : emoji;
        const map = new Map(this.normalizeReactions(message.reactions).map(item => [item.emoji, item.count]));

        if (current && map.has(current)) {
            const nextCount = (map.get(current) || 0) - 1;
            if (nextCount > 0) map.set(current, nextCount);
            else map.delete(current);
        }
        if (next) {
            map.set(next, (map.get(next) || 0) + 1);
        }

        message.myReaction = next;
        message.reactions = Array.from(map.entries())
            .map(([reactionEmoji, count]) => ({ emoji: reactionEmoji, count }))
            .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));

        const shouldRender = found.serverKey
            ? found.serverKey === this.currentServerChatKey()
            : found.peer === this.S.current;
        if (shouldRender) {
            this.renderMessages();
        }
    }

    async addReaction(messageId, emoji) {
        const id = String(messageId || '').trim();
        const reaction = String(emoji || '').trim();
        if (!id || !reaction) return;

        const found = this.findMessageById(id);
        if (!found) return;

        const current = String(found.msg.myReaction || '').trim();
        const next = current === reaction ? '' : reaction;

        const hasRealServerId = !!found.msg.id && (!found.msg.clientId || String(found.msg.id) !== String(found.msg.clientId));
        if (!hasRealServerId) {
            this.applyLocalReaction(found, reaction);
            return;
        }

        if (this.nativeSupports('setReaction')) {
            const sent = this.postNativeMessage({
                type: 'SET_MESSAGE_REACTION',
                messageId: found.msg.id,
                emoji: next,
            });
            if (sent) {
                return;
            }
        }

        try {
            const res = await this.apiFetch(`/api/message/${encodeURIComponent(found.msg.id)}/reaction`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ emoji: next }),
            });

            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось поставить реакцию');
            }

            const payload = await res.json();
            this.onReactionUpdated(payload);
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: `Реакция не отправлена: ${e.message || e}`, ts: new Date().toLocaleTimeString() });
            this.applyLocalReaction(found, reaction);
        }
    }

    // --- DOM Rendering Methods ---

    renderContacts() {
        const el = document.getElementById('contacts');
        if (!el) return;
        this.updateSidebarModeLabel();
        if (this.S.navMode === 'servers') {
            this.renderServers(el);
            return;
        }
        const q = this.S.searchQ.toLowerCase();
        const list = this.S.contacts
            .filter(u => u !== this.myName() && (!q || u.toLowerCase().includes(q)))
            .map((u, index) => ({
                name: u,
                lastMessageAt: this.conversationLastMessageAt(u),
                index,
            }))
            .sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }) || a.index - b.index)
            .map(item => item.name);

        if (list.length === 0) {
            el.innerHTML = `<div style="text-align:center;color:var(--text3);font-size:11px;padding:24px 0">${q ? 'Ничего не найдено' : 'Добавьте первый контакт'}</div>`;
            return;
        }

        el.innerHTML = list.map(u => {
            this.initChat(u);
            const msgs = this.S.chats[u];
            const last = msgs[msgs.length-1];
            let preview = '<span style="color:var(--text3);font-style:italic;font-size:10px">Начните диалог...</span>';
            if (last) {
                const who = last.sender === this.myName() ? 'Вы: ' : '';
                preview = who + this.esc(this.messageSummary(last));
            }
            const cnt = this.S.unread[u] || 0;
            const badge = cnt > 0 ? `<div class="badge">${cnt > 99 ? '99+' : cnt}</div>` : '';
            const active = u === this.S.current ? 'active' : '';
            return `<div class="contact ${active}" data-name="${this.esc(u)}">
                <div class="ava">${this.renderAvatarHTML(u, 'avatar-img', u)}</div>
                <div class="contact-info">
                    <div class="contact-name">${this.esc(u)}</div>
                    <div class="contact-prev">${preview}</div>
                </div>
                <button class="contact-remove" type="button" data-remove-contact="${this.esc(u)}" title="Удалить контакт">×</button>
                ${badge}
            </div>`;
        }).join('');
    }

    renderServers(el = null) {
        const target = el || document.getElementById('contacts');
        if (!target) return;
        this.ensureServersState();
        const q = this.S.searchQ.toLowerCase();
        const list = (this.S.servers || [])
            .filter(Boolean)
            .filter(server => {
                const haystack = `${server.name || ''} ${server.description || server.hint || ''}`.toLowerCase();
                return !q || haystack.includes(q);
            });

        const createTile = `
            <button class="server-item server-create" type="button" id="createServerBtn" title="Создать сервер" aria-label="Создать сервер">
                <span class="server-avatar server-create-plus">+</span>
                <div class="server-meta">
                    <div class="server-name">Создать сервер</div>
                    <div class="server-prev">Новый сервер, команда или сообщество</div>
                </div>
            </button>
        `;
        const joinTile = `
            <button class="server-item server-join" type="button" id="joinServerBtn" title="Войти по ссылке" aria-label="Войти по ссылке">
                <span class="server-avatar server-create-plus">↗</span>
                <div class="server-meta">
                    <div class="server-name">Войти по ссылке</div>
                    <div class="server-prev">Введите адрес сервера</div>
                </div>
            </button>
        `;
        const publicTile = `
            <button class="server-item server-public" type="button" id="publicServersBtn" title="Открыть публичные серверы" aria-label="Открыть публичные серверы">
                <span class="server-avatar server-create-plus">☰</span>
                <div class="server-meta">
                    <div class="server-name">Публичные серверы</div>
                    <div class="server-prev">Просмотр и вход из меню</div>
                </div>
            </button>
        `;

        target.innerHTML = `
            <div class="server-list">
                ${list.length === 0 ? `<div class="server-empty">
                    <div class="empty-ttl">Сервера не найдены</div>
                    <div class="empty-sub">Попробуйте другой запрос</div>
                </div>` : list.map(server => {
                    const active = server.id === this.S.activeServer ? 'active' : '';
                    const badge = Number(server.unread || 0) > 0
                        ? `<div class="badge server-badge">${Number(server.unread) > 99 ? '99+' : Number(server.unread)}</div>`
                        : '';
                    const preview = server.description || server.hint || 'Сервер';
                    return `
                        <button class="server-item ${active}" type="button" data-server-id="${this.esc(server.id)}" title="${this.esc(server.name)}" aria-label="${this.esc(server.name)}">
                            <span class="server-avatar" style="background:${this.esc(server.color || 'linear-gradient(180deg, #cbff00, #8c8c8c)')}">${this.esc(server.icon || server.name?.[0] || 'S')}</span>
                            <div class="server-meta">
                                <div class="server-name">${this.esc(server.name)}</div>
                                <div class="server-prev">${this.esc(preview)}</div>
                            </div>
                            ${badge}
                        </button>
                    `;
                }).join('')}
                ${createTile}
                ${joinTile}
                ${publicTile}
            </div>
        `;
    }

    updateServerSelection() {
        const rows = document.querySelectorAll('.server-item[data-server-id]');
        rows.forEach(row => {
            const serverId = row.getAttribute('data-server-id');
            row.classList.toggle('active', serverId === this.S.activeServer);
        });
    }

    setActiveServer(serverId, { persist = true } = {}) {
        const next = String(serverId || '').trim();
        if (!next) return;
        this.ensureServersState();
        if (!this.S.servers.some(server => server.id === next)) return;
        const previousVoiceServer = String(this.voice.serverId || '').trim();
        const previousVoiceChannel = String(this.voice.channelId || '').trim();
        const current = this.currentServer();
        const currentChannel = this.currentChannel();
        if (this.S.navMode === 'servers' && this.S.activeServer === next && current && currentChannel) return;
        this.S.activeServer = next;
        this.S.navMode = 'servers';
        const server = this.currentServer();
        if (server) {
            const storedChannel = this.loadStoredActiveChannel();
            const fallbackChannel = (server.channels || [])[0]?.id || null;
            this.S.activeChannel = storedChannel && (server.channels || []).some(ch => ch.id === storedChannel)
                ? storedChannel
                : fallbackChannel;
        }
        if (persist) {
            this.saveStoredNavMode('servers');
            this.saveStoredActiveServer(next);
            this.saveStoredActiveChannel(this.S.activeChannel);
        }
        if (this.voice.roomType === 'channel' && previousVoiceServer && previousVoiceChannel) {
            const nextVoiceChannel = String(this.S.activeChannel || '').trim();
            if (previousVoiceServer !== next || previousVoiceChannel !== nextVoiceChannel) {
                this.leaveVoiceRoom({ announce: true });
            }
        }
        this.updateNavModeButtons();
        this.renderServerToolbar();
        this.requestMessagesScroll('bottom');
        this.resetMessageWindow();
        this.renderMessages();
        this.updateSendButtonState();
        this.updateServerSelection();
        if (this.S.activeServer && this.S.activeChannel) {
            this.requestMessagesScroll('bottom');
            this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
        }
        this.closeMobileSidebar();
        this.syncMobileChrome();
    }

    getCurrentMessages() {
        if (this.S.navMode === 'servers') {
            const key = this.currentServerChatKey();
            return this.S.serverChats[key] || [];
        }
        return this.S.chats[this.S.current] || [];
    }

    ensureConversationLoaded(peer = null) {
        const currentPeer = String(peer || this.S.current || '').trim();
        if (!currentPeer) return false;
        const currentMsgs = this.S.chats[currentPeer];
        if (Array.isArray(currentMsgs) && currentMsgs.length > 0) {
            return true;
        }

        const cache = this.loadStoredMessageCache();
        const cachedMsgs = Array.isArray(cache?.chats?.[currentPeer]) ? cache.chats[currentPeer] : [];
        if (cachedMsgs.length === 0) return false;

        this.S.chats[currentPeer] = cachedMsgs.filter(msg => msg && typeof msg === 'object');
        this.trace(`ensureConversationLoaded peer=${currentPeer} restored=${this.S.chats[currentPeer].length}`);
        return true;
    }

    renderMessages() {
        const box = document.getElementById('msgs');
        if (!box) return;
        this.hideReactionMenu();
        const isServers = this.S.navMode === 'servers';
        const conversationKey = isServers ? this.currentServerChatKey() : String(this.S.current || '').trim();
        const previousConversationKey = this.lastRenderedConversationKey || '';
        const conversationChanged = previousConversationKey !== conversationKey;
        const previousScrollTop = box.scrollTop;
        const previousScrollHeight = box.scrollHeight;
        const stickToBottom = this.isMessagesNearBottom(box);
        const scrollAnchor = this.captureMessageScrollAnchor(box);
        const msgs = this.getCurrentMessages();
        const channel = this.currentChannel();
        const server = this.currentServer();

        if (!isServers && (!Array.isArray(msgs) || msgs.length === 0) && !this.S.loading) {
            const restored = this.ensureConversationLoaded(this.S.current);
            if (restored) {
                this.trace(`renderMessages rerender restored peer=${String(this.S.current || '').trim()}`);
                requestAnimationFrame(() => this.renderMessages());
                return;
            }
        }

        if (isServers && channel && this.isVoiceChannel(channel)) {
            box.innerHTML = this.renderVoiceRoomView();
            this.requestMessagesScroll('top');
            this.applyPendingMessagesScroll(box);
            if (isServers && server) {
                const chatHdrAva = document.getElementById('chatHdrAva');
                const chatHdrName = document.getElementById('chatHdrName');
                const chatHdrSub = document.getElementById('chatHdrSub');
                if (chatHdrAva) chatHdrAva.innerHTML = this.esc(server.icon || server.name?.[0] || 'S');
                if (chatHdrName) chatHdrName.innerHTML = `<span class="chat-hdr-title">${this.esc(`🔊 ${channel.name}`)}</span><span class="chat-hdr-count">${this.esc(`Голосовой канал`)}</span>`;
                if (chatHdrSub) chatHdrSub.textContent = `${server.name}${channel.topic ? ` · ${channel.topic}` : ''}`;
                this.updateChatHeaderCryptoKey({
                    serverId: server.id,
                    channelId: channel?.id || null,
                });
            }
            this.renderVoicePanel();
            return;
        }

        if (msgs.length === 0 && !this.S.loading) {
            if (isServers) {
                box.innerHTML = `<div class="empty-state">
                    <div class="empty-ttl">Нет сообщений в канале</div>
                    <div class="empty-sub">${channel ? `#${this.esc(channel.name)}` : 'Выберите канал'}</div>
                </div>`;
                return;
            }
            box.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Нет сообщений</div>
                <div class="empty-sub">Начните разговор</div>
            </div>`;
            return;
        }

        const windowInfo = this.computeMessageWindow(msgs, box, {
            conversationChanged,
            stickToBottom,
        });
        const renderedMsgs = windowInfo.useWindow ? msgs.slice(windowInfo.start, windowInfo.end) : msgs;
        let html = '';
        if (windowInfo.useWindow && windowInfo.topSpacer > 0) {
            html += `<div class="msg-window-spacer" aria-hidden="true" style="height:${Math.round(windowInfo.topSpacer)}px"></div>`;
        }
        const GROUP_WINDOW_MS = 5 * 60 * 1000;
        const items = renderedMsgs.map(msg => {
            const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : 0;
            const dayKey = ts ? new Date(ts).toDateString() : '';
            return { msg, ts, dayKey, groupPos: 'single' };
        });

        let activeGroup = null;
        items.forEach((item) => {
            const isGroupable = item.msg?.kind !== 'call' && !!item.ts && !!item.dayKey && !!String(item.msg?.sender || '').trim();
            const sameSender = !!(activeGroup && activeGroup.sender === item.msg.sender);
            const sameDay = !!(activeGroup && activeGroup.dayKey === item.dayKey);
            const withinWindow = !!(activeGroup && item.ts && activeGroup.lastTs && (item.ts - activeGroup.lastTs) <= GROUP_WINDOW_MS);

            if (isGroupable && sameSender && sameDay && withinWindow) {
                item.groupPos = 'end';
                if (activeGroup.items.length === 1) {
                    activeGroup.items[0].groupPos = 'start';
                } else if (activeGroup.items.length > 1) {
                    activeGroup.items[activeGroup.items.length - 1].groupPos = 'mid';
                }
                activeGroup.items.push(item);
                activeGroup.lastTs = item.ts;
                return;
            }

            item.groupPos = 'single';
            if (isGroupable) {
                activeGroup = {
                    sender: String(item.msg.sender || '').trim(),
                    dayKey: item.dayKey,
                    lastTs: item.ts,
                    items: [item],
                };
            } else {
                activeGroup = null;
            }
        });

        let lastDate = null;
        items.forEach(item => {
            const msg = item.msg;
            const isOut = this.isOutgoingMessage(msg);
            const isCall = msg.kind === 'call';
            const dateStr = this.fmtDate(msg.timestamp);
            const mediaCard = !isCall && this.messageHasMedia(msg) ? 'media-card' : '';
            const gifOnly = !isCall && this.messageIsGifOnly(msg);
            const isSending = isOut && msg.status === 'sending';
            const messageId = String(msg.id || '').trim();
            const hoverTimeLabel = !isCall ? this.messageHoverTimeLabel(msg) : '';
            const showInlineTime = !isCall && (item.groupPos === 'single' || item.groupPos === 'end');
            const inlineTimeLabel = !isCall ? this.messageInlineTimeLabel(msg) : '';
            if (dateStr && dateStr !== lastDate) {
                html += `<div class="date-sep"><span>${this.esc(dateStr)}</span></div>`;
                lastDate = dateStr;
            }

            const dir = isCall ? (isOut ? 'out' : 'in') : (isOut ? 'out' : 'in');
            const showAvatar = !isCall && !isOut && (item.groupPos === 'single' || item.groupPos === 'end');
            const bubbleClass = isCall ? '' : (gifOnly ? 'media-only msg-time-anchor' : `bubble ${mediaCard} msg-time-anchor`);

            html += `<div class="msg ${dir} ${isCall ? 'call-msg' : `group-${item.groupPos}`} ${isSending ? 'sending' : ''} ${gifOnly ? 'gif-only' : ''} ${showInlineTime ? 'time-visible' : 'time-hidden'}"${messageId ? ` data-message-id="${this.esc(messageId)}"` : ''}>`;
            if (!isCall && !isOut && showAvatar) {
                html += `<div class="msg-ava">${this.renderAvatarHTML(msg.sender, 'avatar-img', msg.sender)}</div>`;
            } else if (!isCall && !isOut) {
                html += `<div class="msg-ava msg-ava-spacer" aria-hidden="true"></div>`;
            }
            html += `<div class="bwrap ${isCall ? 'call-wrap' : ''}">
                ${isCall ? this.renderMessageBody(msg) : `<div class="${bubbleClass}"${hoverTimeLabel ? ` title="${this.esc(hoverTimeLabel)}"` : ''}>${this.renderMessageBody(msg)}${inlineTimeLabel ? `<span class="msg-time" aria-hidden="true">${this.esc(inlineTimeLabel)}</span>` : ''}</div>`}
                ${!isCall ? this.renderMessageReactions(msg) : ''}
            </div></div>`;
        });

        if (this.S.loading) {
            html += `<div class="sk sk-bubble sk-w2"></div>
                     <div class="sk sk-bubble sk-w3 sk-self"></div>
                     <div class="sk sk-bubble sk-w1"></div>
                     <div class="sk sk-bubble sk-w2 sk-self"></div>`;
        }

        if (windowInfo.useWindow && windowInfo.bottomSpacer > 0) {
            html += `<div class="msg-window-spacer" aria-hidden="true" style="height:${Math.round(windowInfo.bottomSpacer)}px"></div>`;
        }

        box.innerHTML = html;
        this.hydrateGifMedia(box);

        const msgNodes = box.querySelectorAll('.msg');
        if (msgNodes.length) {
            const heights = Array.from(msgNodes).map(node => Number(node.getBoundingClientRect?.().height || node.offsetHeight || 0)).filter(Boolean);
            if (heights.length) {
                const avgHeight = heights.reduce((sum, value) => sum + value, 0) / heights.length;
                const current = Number(this.messageWindow?.avgHeight || 92);
                this.messageWindow.avgHeight = Math.max(56, Math.min(160, current * 0.7 + avgHeight * 0.3));
            }
        }
        this.messageWindow.conversationKey = conversationKey;
        this.messageWindow.start = windowInfo.useWindow ? windowInfo.start : 0;
        this.messageWindow.end = windowInfo.useWindow ? windowInfo.end : msgs.length;
        this.messageWindow.count = msgs.length;
        this.messageWindow.useWindow = !!windowInfo.useWindow;

        const preserveScroll = !conversationChanged && !this.pendingMessagesScroll && !stickToBottom;
        if (preserveScroll && previousScrollHeight > 0) {
            const restored = this.restoreMessageScrollAnchor(box, scrollAnchor);
            if (restored && scrollAnchor?.messageId) {
                requestAnimationFrame(() => {
                    if (!box.isConnected) return;
                    this.restoreMessageScrollAnchor(box, scrollAnchor);
                });
            }
            if (!restored) {
                const scrollDelta = box.scrollHeight - previousScrollHeight;
                const nextScrollTop = Math.max(0, previousScrollTop + scrollDelta);
                box.scrollTop = nextScrollTop;
            }
        }

        if (this.pendingMessagesScroll === 'top') {
            this.applyPendingMessagesScroll(box);
        } else if (this.pendingMessagesScroll === 'bottom') {
            const shouldAutoScroll = conversationChanged || stickToBottom || previousScrollHeight <= box.clientHeight;
            if (shouldAutoScroll) {
                this.applyPendingMessagesScroll(box);
            } else {
                this.pendingMessagesScroll = null;
            }
        } else if (!conversationChanged && stickToBottom) {
            requestAnimationFrame(() => {
                if (!box.isConnected) return;
                box.scrollTop = box.scrollHeight;
            });
        }

        if (isServers && server) {
            const chatHdrAva = document.getElementById('chatHdrAva');
            const chatHdrName = document.getElementById('chatHdrName');
            const chatHdrSub = document.getElementById('chatHdrSub');
            if (chatHdrAva) chatHdrAva.innerHTML = this.esc(server.icon || server.name?.[0] || 'S');
            if (chatHdrName) {
                const channelLabel = channel
                    ? `${this.isVoiceChannel(channel) ? '🔊 ' : '#'}${channel.name}`
                    : server.name;
                chatHdrName.innerHTML = `<span class="chat-hdr-title">${this.esc(channelLabel)}</span>`;
            }
            if (chatHdrSub) {
                chatHdrSub.textContent = channel
                    ? `${server.name}${channel.topic ? ` · ${channel.topic}` : ''}`
                    : (server.description || 'Сервер');
            }
        }
        this.lastRenderedConversationKey = conversationKey;
    }

    switchChat(name) {
        const peer = String(name || '').trim();
        if (!peer) return;
        this.trace(`switchChat peer=${peer}`);
        this.S.current = peer;
        this.S.unread[peer] = 0;
        this.initChat(peer);
        this.ensureConversationCryptoKey({ peer, reason: 'switchChat' });
        this.saveStoredCurrentContact(peer);
        this.requestMessagesScroll('bottom');
        const wasServers = this.S.navMode === 'servers';
        this.setNavMode('dm', { refresh: !wasServers });
        this.resetMessageWindow();

        const set = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
        set('tbChat',       peer);
        set('chatHdrName',  peer);
        this.updateChatHeaderCryptoKey({ peer });
        const chatHdrAva = document.getElementById('chatHdrAva');
        if (chatHdrAva) chatHdrAva.innerHTML = this.renderAvatarHTML(peer, 'avatar-img', peer);
        const chatCallBtn = document.getElementById('chatCallBtn');
        if (chatCallBtn) chatCallBtn.hidden = !this.S.current;
        const serverSettingsBtn = document.getElementById('serverSettingsBtn');
        if (serverSettingsBtn) serverSettingsBtn.hidden = true;

        if (wasServers) {
            this.renderServerInterface();
            this.renderContacts();
            this.renderMessages();
            this.renderVoicePanel();
        } else {
            this.renderContacts();
            this.renderMessages();
        }
        this.updateSendButtonState();
        this.syncActiveConversation({ force: true });
        this.closeMobileSidebar();
        this.syncMobileChrome();
    }

    async sendInputMessage() {
        const inp = document.getElementById('msgInput');
        const textValue = (inp && inp.value) || '';
        const text = textValue.trim();
        const attachments = this.normalizeAttachments(this.S.draftAttachments);
        if (!text && attachments.length === 0) return;

        const clientId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const payloadAttachments = attachments.map(att => ({ ...att }));
        const ts = new Date().toISOString();
        const isServers = this.S.navMode === 'servers';
        const server = isServers ? this.currentServer() : null;
        const channel = isServers ? this.currentChannel() : null;
        const conversationKey = isServers ? this.currentServerChatKey() : this.S.current;
        if (isServers && (!server || !channel)) return;
        if (isServers && this.isVoiceChannel(channel)) return;
        if (!isServers && !this.S.current) return;
        const cryptoKey = await this.resolveConversationCryptoKey({
            peer: isServers ? null : this.S.current,
            serverId: isServers ? server.id : null,
            channelId: isServers ? channel.id : null,
            reason: 'sendInputMessage'
        });
        const keyVersion = 2;
        this.trace(`sendInputMessage start clientId=${clientId} sender=${this.myName()} receiver=${isServers ? channel.id : this.S.current} server=${isServers ? server.id : 'dm'} channel=${isServers ? channel.id : 'dm'} attachments=${payloadAttachments.length} textBytes=${text.length} keySet=${!!cryptoKey} tokenSet=${!!this.S.session?.token}`);

        const outgoingMessage = {
            id: clientId,
            sender: this.myName(),
            receiver: isServers ? channel.id : this.S.current,
            text,
            attachments: payloadAttachments,
            timestamp: ts,
            status: 'sending',
            clientId,
            serverId: isServers ? server.id : null,
            channelId: isServers ? channel.id : null,
            keyVersion,
        };

        const bridgeAvailable = this.nativeSupports('sendMessage');
        if (!bridgeAvailable) {
            this.trace(`sendInputMessage noNativeBridge clientId=${clientId}`);
            if (isServers) {
                if (!this.S.serverChats[conversationKey]) this.S.serverChats[conversationKey] = [];
                this.S.serverChats[conversationKey].push(outgoingMessage);
            } else {
                this.ensureContact(this.S.current);
                this.initChat(this.S.current);
                this.S.chats[this.S.current].push(outgoingMessage);
            }
            this.saveStoredMessageCache();
            this.renderMessages();
            this.renderContacts();
            this.renderServerInterface();
            if (inp) {
                inp.value = '';
                this.resizeComposer();
            }
            this.clearDraftAttachments();
            this.updateSendButtonState();
            inp && inp.focus();
            this.addLogEntry({ type: 'WARN', msg: 'Native bridge не обнаружен. Сообщение сохранено только в локальном интерфейсе.', ts: new Date().toLocaleTimeString() });
            return;
        }

        if (!cryptoKey) {
            this.trace(`sendInputMessage missingKey clientId=${clientId}`);
            this.addLogEntry({ type: 'ERROR', msg: 'Для отправки сообщения нужен E2E-ключ', ts: new Date().toLocaleTimeString() });
            return;
        }
        if (!this.S.session?.token) {
            this.trace(`sendInputMessage missingToken clientId=${clientId}`);
            this.addLogEntry({ type: 'ERROR', msg: 'Для отправки сообщения нужно войти в аккаунт', ts: new Date().toLocaleTimeString() });
            return;
        }

        if (isServers) {
            if (!this.S.serverChats[conversationKey]) this.S.serverChats[conversationKey] = [];
            this.S.serverChats[conversationKey].push(outgoingMessage);
        } else {
            this.ensureContact(this.S.current);
            this.initChat(this.S.current);
            this.S.chats[this.S.current].push(outgoingMessage);
        }
        this.saveStoredMessageCache();

        this.renderMessages();
        this.renderContacts();
        this.renderServerInterface();

        if (inp) {
            inp.value = '';
            this.resizeComposer();
        }

        this.clearDraftAttachments();
        this.updateSendButtonState();
        inp && inp.focus();

        this.enqueuePendingOutbox({
            ...outgoingMessage,
            key: cryptoKey,
            keyVersion,
        });
        this.trace(`sendInputMessage queued clientId=${clientId}`);

        this.postNativeMessage({
            type: 'SEND_MESSAGE',
            text: text,
            recipient: isServers ? channel.id : this.S.current,
            serverId: isServers ? server.id : '',
            channelId: isServers ? channel.id : '',
            sender: this.myName(),
            key: cryptoKey,
            keyVersion,
            clientId,
            attachments: payloadAttachments.map(att => ({
                name: att.name,
                mimeType: att.mimeType,
                kind: att.kind,
                size: att.size,
                dataUrl: att.dataUrl,
            }))
        });
    }

    _getKey() {
        try {
            return this.ensureConversationCryptoKey({
                peer: this.S.navMode === 'servers' ? null : this.S.current,
                serverId: this.S.navMode === 'servers' ? this.currentServer()?.id || null : null,
                channelId: this.S.navMode === 'servers' ? this.currentChannel()?.id || null : null,
                reason: '_getKey'
            });
        } catch (e) {
            return '';
        }
    }

    updateSendButtonState() {
        const btn = document.getElementById('sendBtn');
        const inp = document.getElementById('msgInput');
        const hasText = !!(inp && inp.value.trim().length);
        const hasAttachments = this.S.draftAttachments.length > 0;
        const channel = this.currentChannel();
        const canSend = this.S.navMode === 'servers'
            ? !!(this.currentServer() && channel && !this.isVoiceChannel(channel))
            : !!this.S.current;
        if (btn) btn.disabled = !(hasText || hasAttachments) || !canSend;
    }

    // --- Bus Command Handlers ---

    receiveMessage(payload = {}) {
        const {
            id,
            sender,
            receiver,
            text,
            timestamp,
            attachments,
            reactions,
            myReaction,
        } = payload || {};
        const serverId = payload?.serverId || payload?.server_id || null;
        const channelId = payload?.channelId || payload?.channel_id || null;
        const clientId = String(payload?.clientId || payload?.client_id || '').trim();
        this.trace(`receiveMessage id=${String(id || '').trim()} clientId=${clientId || 'none'} sender=${String(sender || '').trim()} receiver=${String(receiver || '').trim()} server=${serverId || 'dm'} channel=${channelId || 'dm'} textBytes=${String(text || '').length} attachments=${Array.isArray(attachments) ? attachments.length : 0} reactions=${Array.isArray(reactions) ? reactions.length : 0}`);
        if (clientId) {
            const reconciled = this.finalizePendingMessage(clientId, id);
            if (reconciled) {
                this.dropPendingOutbox(clientId);
                if (serverId && channelId) {
                    this.renderServerInterface();
                } else {
                    this.renderMessages();
                    this.renderContacts();
                }
                const refreshPeer = sender === this.myName() ? receiver : sender;
                this.scheduleConversationRefresh({
                    peer: refreshPeer,
                    serverId,
                    channelId,
                    reason: 'receiveMessageReconciled',
                });
                this.addLogEntry({ type: 'SUCCESS', msg: `Сообщение подтверждено сервером: ${sender}`, ts: new Date().toLocaleTimeString() });
                return;
            }
        }
        if (serverId && channelId) {
            const key = `${serverId}:${channelId}`;
            const msgs = this.S.serverChats[key] || (this.S.serverChats[key] = []);
            const incomingAttachments = this.normalizeAttachments(attachments);
            const incomingReactions = this.normalizeReactions(reactions);
            const incomingText = this.sanitizeDecryptionErrorText(text);
            const messageId = String(id || '').trim();
            const attachmentKey = incomingAttachments.map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
            const ts = timestamp || new Date().toISOString();
            const existingIndex = messageId
                ? msgs.findIndex(m => String(m.id || '').trim() === messageId)
                : msgs.findIndex(m =>
                    m.sender === sender &&
                    m.text === incomingText &&
                    this.normalizeAttachments(m.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|') === attachmentKey
                );
            if (existingIndex >= 0) {
                const prev = msgs[existingIndex];
                msgs[existingIndex] = {
                    ...prev,
                    id: messageId || prev.id || '',
                    sender: sender || prev.sender || '',
                    receiver: receiver || prev.receiver || '',
                    text: incomingText || prev.text || '',
                    attachments: incomingAttachments.length ? incomingAttachments : this.normalizeAttachments(prev.attachments),
                    reactions: incomingReactions.length ? incomingReactions : this.normalizeReactions(prev.reactions),
                    myReaction: String(myReaction || prev.myReaction || '').trim(),
                    timestamp: ts || prev.timestamp || new Date().toISOString(),
                    serverId: serverId || prev.serverId || '',
                    channelId: channelId || prev.channelId || '',
                };
            } else {
                msgs.push({
                    id: messageId,
                    sender,
                    receiver,
                    text: incomingText,
                    attachments: incomingAttachments,
                    reactions: incomingReactions,
                    myReaction: myReaction || '',
                    timestamp: ts,
                    serverId,
                    channelId,
                });
            }
            this.saveStoredMessageCache();
            if (this.currentServerChatKey() === key) {
                this.renderMessages();
            } else {
                this.renderServerInterface();
            }
            this.scheduleConversationRefresh({
                serverId,
                channelId,
                reason: 'receiveMessageServer',
            });
            this.addLogEntry({ type: 'SUCCESS', msg: `Получено в канале ${serverId}/${channelId}: ${sender}`, ts: new Date().toLocaleTimeString() });
            return;
        }

        const peer = sender === this.myName() ? receiver : sender;
        this.ensureContact(peer);
        this.initChat(peer);
        const msgs = this.S.chats[peer];
        const incomingAttachments = this.normalizeAttachments(attachments);
        const incomingReactions = this.normalizeReactions(reactions);
        const incomingText = this.sanitizeDecryptionErrorText(text);
        const messageId = String(id || '').trim();
        const attachmentKey = incomingAttachments.map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
        const ts = timestamp || new Date().toISOString();
        const existingIndex = messageId
            ? msgs.findIndex(m => String(m.id || '').trim() === messageId)
            : msgs.findIndex(m =>
                m.sender === sender &&
                m.text === incomingText &&
                this.normalizeAttachments(m.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|') === attachmentKey
            );
        if (existingIndex >= 0) {
            const prev = msgs[existingIndex];
            msgs[existingIndex] = {
                ...prev,
                id: messageId || prev.id || '',
                sender: sender || prev.sender || '',
                receiver: receiver || prev.receiver || '',
                text: incomingText || prev.text || '',
                attachments: incomingAttachments.length ? incomingAttachments : this.normalizeAttachments(prev.attachments),
                reactions: incomingReactions.length ? incomingReactions : this.normalizeReactions(prev.reactions),
                myReaction: String(myReaction || prev.myReaction || '').trim(),
                timestamp: ts || prev.timestamp || new Date().toISOString(),
            };
        } else {
            msgs.push({
                id: messageId,
                sender,
                receiver,
                text: incomingText,
                attachments: incomingAttachments,
                reactions: incomingReactions,
                myReaction: myReaction || '',
                timestamp: ts
            });
        }
        this.saveStoredMessageCache();
        if (!this.S.current) {
            this.switchChat(peer);
        }
        if (peer === this.S.current) {
            this.renderMessages();
        } else {
            this.S.unread[peer] = (this.S.unread[peer] || 0) + 1;
            this.renderContacts();
        }
        this.scheduleConversationRefresh({
            peer,
            reason: 'receiveMessageDm',
        });
        this.addLogEntry({ type: 'SUCCESS', msg: `Получено: ${sender} → ${receiver}`, ts: new Date().toLocaleTimeString() });
    }

    handleAvatarUpdated({ username, deleted = false } = {}) {
        const name = String(username || '').trim();
        if (!name) return;

        if (deleted) {
            this.saveStoredAvatar(name, null);
        } else {
            this.clearStoredAvatar(name);
            this.ensureAvatarLoaded(name, { force: true });
        }

        this.scheduleAvatarRefresh();
    }

    setUsers(users) {
        this.S.users = Array.isArray(users) ? users : [];
        this.S.users.forEach(u => this.initChat(u));
        const others = this.S.users.filter(u => u !== this.myName());
        if (this.S.navMode !== 'servers' && !this.S.current && this.S.contacts.length > 0) this.switchChat(this.S.contacts[0]);
        this.trace(`setUsers count=${this.S.users.length} others=${others.join(',')}`);
        this.addLogEntry({ type: 'INFO', msg: `Загружен список пользователей: ${others.join(', ')}`, ts: new Date().toLocaleTimeString() });
        this.renderContactSuggestions();
    }

    setContacts(contacts) {
        const me = this.myName();
        this.S.contacts = Array.isArray(contacts) ? contacts.filter(Boolean).filter(u => u !== me) : [];
        this.S.contacts.forEach(u => this.initChat(u));
        this.trace(`setContacts count=${this.S.contacts.length} me=${me} contacts=${this.S.contacts.join(',')}`);
        if (this.S.navMode !== 'servers') {
            const storedCurrent = this.loadStoredCurrentContact();
            const currentValid = !!(this.S.current && this.S.contacts.includes(this.S.current));
            const storedValid = !!(storedCurrent && this.S.contacts.includes(storedCurrent));

            if (storedValid && (!currentValid || this.S.current !== storedCurrent)) {
                this.switchChat(storedCurrent);
            } else if (currentValid) {
                this.renderMessages();
                this.renderContacts();
            } else if (this.S.contacts.length > 0) {
                this.switchChat(this.S.contacts[0]);
            } else {
                this.S.current = null;
                this.saveStoredCurrentContact(null);
                const set = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
                set('tbChat', 'Нет контактов');
                set('chatHdrAva', 'Z');
                set('chatHdrName', 'Добавьте контакт');
            }
            if (this.S.current) {
                this.ensureConversationCryptoKey({ peer: this.S.current, reason: 'setContacts' });
                this.syncActiveConversation({ force: true });
            }
        }
        this.renderContacts();
        this.renderMessages();
        this.renderContactSuggestions();
    }

    setSession(session) {
        if (!session || typeof session !== 'object') return;
        this.applySession({
            username: session.username || 'Zalikus',
            token: session.token || null,
            guest: !!session.guest || !session.token,
        }, { persist: false, syncNative: false });
        this.loadContacts();
        this.loadUsers();
        this.loadServers({ silent: true });
        this.renderContactSuggestions();
        this.refreshAfterKey();
    }

    loadHistory(messages) {
        const queue = Array.isArray(messages) ? messages.filter(msg => msg && typeof msg === 'object') : [];
        const seq = ++this.historyLoadSeq;
        this.trace(`loadHistory count=${queue.length}`);
        this.addLogEntry({ type: 'INFO', msg: `Загрузка истории чата: ${queue.length} сообщений`, ts: new Date().toLocaleTimeString() });
        const touchedPeers = new Set();
        const processBatch = (startIndex = 0) => {
            if (seq !== this.historyLoadSeq) {
                this.trace(`loadHistory stale seq=${seq} current=${this.historyLoadSeq}`);
                return;
            }
            const startedAt = performance.now();
            let index = startIndex;
            for (; index < queue.length; index += 1) {
                if ((index - startIndex) >= 120) break;
                if ((performance.now() - startedAt) >= 8) break;
                const msg = queue[index];
                const peer = msg.kind === 'call'
                    ? String(msg.call?.peer || msg.receiver || msg.sender || '').trim()
                    : (msg.sender === this.myName() ? msg.receiver : msg.sender);
                if (!peer) continue;
                touchedPeers.add(peer);
                this.ensureContact(peer);
                this.initChat(peer);
                const arr = this.S.chats[peer];
                const normalizedAttachments = this.normalizeAttachments(msg.attachments);
                const normalizedReactions = this.normalizeReactions(msg.reactions);
                const msgId = String(msg.id || '').trim();
                const clientId = String(msg.clientId || msg.client_id || '').trim();
                if (clientId && this.finalizePendingMessage(clientId, msgId, { render: false })) {
                    this.dropPendingOutbox(clientId);
                    this.markMessageSeen(msg);
                    continue;
                }
                const incoming = {
                    ...msg,
                    attachments: normalizedAttachments,
                    reactions: normalizedReactions,
                    myReaction: msg.myReaction || '',
                    text: this.sanitizeDecryptionErrorText(msg.text),
                };
                const incomingKey = this.messageRenderKey(incoming);
                const existingIndex = msgId
                    ? arr.findIndex(m => String(m.id || '').trim() === msgId)
                    : arr.findIndex(m => this.messageRenderKey(m) === incomingKey);
                if (existingIndex >= 0) {
                    const prev = arr[existingIndex];
                    arr[existingIndex] = {
                        ...prev,
                        ...msg,
                        id: msgId || msg.id || prev.id || '',
                        attachments: normalizedAttachments.length ? normalizedAttachments : this.normalizeAttachments(prev.attachments),
                        reactions: normalizedReactions.length ? normalizedReactions : this.normalizeReactions(prev.reactions),
                        myReaction: msg.myReaction || prev.myReaction || '',
                        text: this.sanitizeDecryptionErrorText(msg.text) || prev.text || '',
                        status: 'sent'
                    };
                } else {
                    arr.push({
                        ...msg,
                        id: msgId || msg.id || '',
                        attachments: normalizedAttachments,
                        reactions: normalizedReactions,
                        myReaction: msg.myReaction || '',
                        text: this.sanitizeDecryptionErrorText(msg.text),
                        status: 'sent'
                    });
                }
                this.markMessageSeen(msg);
            }
            if (index < queue.length) {
                requestAnimationFrame(() => processBatch(index));
                return;
            }
            touchedPeers.forEach(peer => {
                const arr = this.S.chats[peer];
                if (Array.isArray(arr)) {
                    arr.sort((a, b) => new Date(a.timestamp || 0) - new Date(b.timestamp || 0));
                }
            });
            this.normalizeDmChatStore();
            this.saveStoredMessageCache();
            if (this.S.navMode !== 'servers') {
                const storedCurrent = this.loadStoredCurrentContact();
                const pendingPeers = this.loadPendingOutbox()
                    .filter(item => String(item?.sender || '').trim() === this.myName())
                    .map(item => String(item?.receiver || '').trim())
                    .filter(Boolean);
                const preferredPeer = (() => {
                    if (storedCurrent && (this.S.chats[storedCurrent] || []).length) return storedCurrent;
                    for (let i = pendingPeers.length - 1; i >= 0; i -= 1) {
                        const peer = pendingPeers[i];
                        if ((this.S.chats[peer] || []).length) return peer;
                    }
                    const populated = Object.entries(this.S.chats)
                        .filter(([, msgs]) => Array.isArray(msgs) && msgs.length > 0)
                        .sort((a, b) => new Date(b[1][b[1].length - 1]?.timestamp || 0) - new Date(a[1][a[1].length - 1]?.timestamp || 0));
                    return populated[0]?.[0] || null;
                })();

                if (!this.S.current && preferredPeer && preferredPeer !== this.S.current) {
                    this.switchChat(preferredPeer);
                }
            }
            this.renderMessages();
            this.renderContacts();
            if (!this.S.current && this.S.contacts.length > 0) {
                this.switchChat(this.S.contacts[0]);
            }
            this.scheduleFlushPendingOutbox(300);
            this.trace(`loadHistory done current=${this.S.current || 'none'} chats=${Object.keys(this.S.chats).length}`);
        };
        processBatch(0);
    }

    setLoading(on) {
        this.S.loading = !!on;
        this.renderMessages();
    }

    setConnectionStatus(connected) {
        this.S.wsOn = !!connected;
        const pill = document.getElementById('wsPill');
        const lbl  = document.getElementById('wsLabel');
        if (pill) pill.className = 'ws-pill' + (connected ? ' on' : '');
        if (lbl)  lbl.textContent = connected ? 'Подключено' : 'Переподключение...';
        this.addLogEntry({ type: connected ? 'SUCCESS' : 'WARN', msg: connected ? 'WebSocket соединение установлено' : 'WebSocket соединение разорвано', ts: new Date().toLocaleTimeString() });
    }

    onSendSuccess(payload) {
        if (payload && typeof payload === 'object') {
            this.trace(`onSendSuccess clientId=${String(payload.clientId || '').trim()} messageId=${String(payload.messageId || '').trim()}`);
            this.finalizePendingMessage(payload.clientId, payload.messageId);
            this.dropPendingOutbox(payload.clientId);
        } else {
            this.trace(`onSendSuccess payload=${String(payload || '').trim()}`);
            this.markMessageStatus(payload, 'sent');
            this.dropPendingOutbox(payload);
        }
        this.addLogEntry({ type: 'SUCCESS', msg: 'Сообщение доставлено адресату', ts: new Date().toLocaleTimeString() });
    }

    onSendError(clientId) {
        this.trace(`onSendError clientId=${String(clientId || '').trim()}`);
        this.markMessageStatus(clientId, 'error');
        this.scheduleFlushPendingOutbox(2000);
        this.addLogEntry({ type: 'ERROR', msg: 'Сообщение отклонено сервером', ts: new Date().toLocaleTimeString() });
    }

    onReactionUpdated(payload) {
        if (!payload || typeof payload !== 'object') return;
        const found = this.findMessageById(payload.messageId);
        if (!found) return;
        found.msg.reactions = this.normalizeReactions(payload.reactions);
        found.msg.myReaction = String(payload.myReaction || '').trim();
        const shouldRender = found.serverKey
            ? found.serverKey === this.currentServerChatKey()
            : found.peer === this.S.current;
        if (shouldRender) {
            this.renderMessages();
        }
    }

    addLogEntry({ type, msg, ts }) {
        const body = document.getElementById('logBody');
        if (body) {
            const div = document.createElement('div');
            div.className = `log-entry log-${type}`;
            div.innerHTML = `<span class="ts">[${ts}]</span>${this.esc(type)}: ${this.esc(msg)}`;
            body.appendChild(div);
            body.scrollTop = body.scrollHeight;
            if (body.childElementCount > 300) body.removeChild(body.firstElementChild);
        }
    }

    voiceTrace(stage, details = {}, level = 'INFO') {
        const ts = new Date().toLocaleTimeString();
        const compact = Object.entries(details)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
            .map(([key, value]) => {
                if (Array.isArray(value)) return `${key}=[${value.join(',')}]`;
                if (typeof value === 'object') {
                    try { return `${key}=${JSON.stringify(value)}`; } catch (e) { return `${key}=[object]`; }
                }
                return `${key}=${String(value)}`;
            })
            .join(' ');
        const message = compact ? `${stage} ${compact}` : stage;
        this.voice.traceLines = Array.isArray(this.voice.traceLines) ? this.voice.traceLines : [];
        this.voice.traceLines.push({ ts, level, stage, message });
        if (this.voice.traceLines.length > 14) {
            this.voice.traceLines.splice(0, this.voice.traceLines.length - 14);
        }
        this.addLogEntry({ type: level, msg: `[VOICE] ${message}`, ts });
        try {
            const fn = level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.debug;
            fn?.('[VOICE]', stage, details);
        } catch (e) {}
    }

    // --- UI Event Binding ---

    bindEvents() {
        // 1. Click on contacts
        const contactsEl = document.getElementById('contacts');
        if (contactsEl) {
            contactsEl.addEventListener('click', (e) => {
                const serverBtn = e.target.closest('.server-item[data-server-id]');
                if (serverBtn) {
                    const serverId = serverBtn.getAttribute('data-server-id');
                    if (serverId) this.setActiveServer(serverId);
                    e.stopPropagation();
                    return;
                }
                const createBtn = e.target.closest('.server-create');
                if (createBtn) {
                    this.openServerModal('create');
                    e.stopPropagation();
                    return;
                }
                const joinBtn = e.target.closest('.server-join');
                if (joinBtn) {
                    const raw = prompt('Введите ссылку на сервер:');
                    const link = this.extractInviteCode(raw);
                    if (link) this.joinServerByLink(link);
                    e.stopPropagation();
                    return;
                }
                const publicBtn = e.target.closest('.server-public');
                if (publicBtn) {
                    this.openPublicServersModal();
                    e.stopPropagation();
                    return;
                }
                const removeBtn = e.target.closest('.contact-remove');
                if (removeBtn) {
                    const username = removeBtn.getAttribute('data-remove-contact');
                    if (username) this.removeContact(username);
                    e.stopPropagation();
                    return;
                }
                const row = e.target.closest('.contact');
                if (row && row.dataset.name) this.switchChat(row.dataset.name);
            });
        }

        const serverChannelList = document.getElementById('serverChannelList');
        if (serverChannelList) {
            serverChannelList.addEventListener('click', (e) => {
                const channelBtn = e.target.closest('.server-channel[data-channel-id]');
                if (!channelBtn) return;
                const channelId = channelBtn.getAttribute('data-channel-id');
                if (channelId) this.setActiveChannel(channelId);
            });
        }

        const voicePanel = document.getElementById('voicePanel');
        if (voicePanel) {
            voicePanel.addEventListener('click', async (e) => {
                const callBtn = e.target.closest('#voiceCallBtn');
                if (callBtn) {
                    await this.startDirectCall(this.S.current);
                    return;
                }
                const joinBtn = e.target.closest('#voiceJoinBtn');
                if (joinBtn) {
                    await this.joinVoiceChannel();
                    return;
                }
                const leaveBtn = e.target.closest('#voiceLeaveBtn');
                if (leaveBtn) {
                    await this.leaveVoiceRoom({ announce: true });
                    return;
                }
                const muteBtn = e.target.closest('#voiceMuteBtn');
                if (muteBtn) {
                    this.toggleVoiceMute();
                    return;
                }
                const acceptBtn = e.target.closest('#voiceAcceptBtn');
                if (acceptBtn) {
                    await this.acceptIncomingCall();
                    return;
                }
                const rejectBtn = e.target.closest('#voiceRejectBtn');
                if (rejectBtn) {
                    await this.rejectIncomingCall();
                    return;
                }
                const cancelBtn = e.target.closest('#voiceCancelBtn');
                if (cancelBtn) {
                    const invite = this.voice.outgoingInvite;
                    if (invite?.roomId && invite?.target) {
                        this.sendVoiceEvent({
                            type: 'voice_call_cancel',
                            roomId: invite.roomId,
                            target: invite.target,
                        });
                    }
                    this.recordVoiceCallHistory({ outcome: 'cancelled', endedAt: Date.now() });
                    this.resetVoiceState({ preserveInvite: false });
                }
            });
        }

        const chatCallBtn = document.getElementById('chatCallBtn');
        if (chatCallBtn) {
            chatCallBtn.addEventListener('click', async () => {
                if (!this.S.current) return;
                await this.startDirectCall(this.S.current);
            });
        }

        const msgsEl = document.getElementById('msgs');
        if (msgsEl) {
            msgsEl.addEventListener('scroll', () => this.onMessagesScroll(), { passive: true });
            msgsEl.addEventListener('click', (e) => {
                const fileLink = e.target.closest('a.file-chip, a.file-message');
                if (fileLink) {
                    e.preventDefault();
                    e.stopPropagation();
                    const href = fileLink.getAttribute('href') || '';
                    const filename = fileLink.getAttribute('download') || fileLink.textContent || 'attachment';
                    this.downloadAttachmentFromHref(href, filename);
                    return;
                }
                const reactionBtn = e.target.closest('[data-message-reaction]');
                if (reactionBtn) {
                    const messageId = reactionBtn.getAttribute('data-message-id');
                    const emoji = reactionBtn.getAttribute('data-message-reaction');
                    if (messageId && emoji) {
                        this.addReaction(messageId, emoji);
                    }
                    e.stopPropagation();
                    return;
                }
                this.hideReactionMenu();
            });
            msgsEl.addEventListener('contextmenu', (e) => {
                const msgEl = e.target.closest('.msg[data-message-id]');
                if (!msgEl) return;
                const messageId = msgEl.getAttribute('data-message-id');
                if (!messageId) return;
                e.preventDefault();
                this.showReactionMenu(msgEl, messageId, e.clientX, e.clientY);
                e.stopPropagation();
            });
        }

        document.addEventListener('click', (e) => {
            const menu = document.getElementById('reactionMenu');
            if (!menu || !menu.classList.contains('visible')) return;
            if (menu.contains(e.target)) return;
            if (e.target.closest('.msg[data-message-id]')) return;
            this.hideReactionMenu();
        });
        window.addEventListener('blur', () => this.hideReactionMenu());

        const contactInput = document.getElementById('contactInput');
        if (contactInput) {
            contactInput.addEventListener('input', () => this.renderContactSuggestions(true));
            contactInput.addEventListener('focus', () => this.renderContactSuggestions(true));
            contactInput.addEventListener('blur', () => {
                setTimeout(() => this.hideContactSuggestions(), 120);
            });
            contactInput.addEventListener('keydown', (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.hideContactSuggestions();
                    contactInput.blur();
                    return;
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.addContactFromInput();
                }
            });
        }

        const contactSuggestions = document.getElementById('contactSuggestions');
        if (contactSuggestions) {
            contactSuggestions.addEventListener('pointerdown', (e) => {
                const item = e.target.closest('.contact-suggest-item');
                if (!item) return;
                e.preventDefault();
                const username = item.getAttribute('data-username');
                if (username) {
                    this.addContactFromInput(username);
                }
            });
        }

        // 2. Click send button & keyboard listener
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) sendBtn.addEventListener('click', () => this.sendInputMessage());

        const attachBtn = document.getElementById('attachBtn');
        const attachmentInput = document.getElementById('attachmentInput');
        if (attachBtn && attachmentInput) {
            attachBtn.addEventListener('click', () => attachmentInput.click());
            attachmentInput.addEventListener('change', (e) => {
                this.handleFiles(e.target.files || []);
                e.target.value = '';
            });
        }

        const msgInput = document.getElementById('msgInput');
        if (msgInput) {
            msgInput.addEventListener('input', () => {
                this.resizeComposer();
                this.updateSendButtonState();
            });
            msgInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) { 
                    e.preventDefault(); 
                    this.sendInputMessage(); 
                }
            });
            msgInput.addEventListener('paste', (e) => {
                const files = Array.from(e.clipboardData?.files || []).filter(Boolean);
                if (files.length > 0) {
                    e.preventDefault();
                    this.handleFiles(files);
                }
            });
        }

        const inputBar = document.getElementById('inputBar');
        if (inputBar) {
            inputBar.addEventListener('dragover', (e) => {
                e.preventDefault();
                inputBar.classList.add('drop-active');
            });
            inputBar.addEventListener('dragleave', () => {
                inputBar.classList.remove('drop-active');
            });
            inputBar.addEventListener('drop', (e) => {
                e.preventDefault();
                inputBar.classList.remove('drop-active');
                const files = Array.from(e.dataTransfer?.files || []).filter(Boolean);
                if (files.length > 0) this.handleFiles(files);
            });
        }

        const draftAttachments = document.getElementById('draftAttachments');
        if (draftAttachments) {
            draftAttachments.addEventListener('click', (e) => {
                const btn = e.target.closest('.draft-att-remove');
                if (!btn) return;
                const id = btn.getAttribute('data-att-id');
                this.S.draftAttachments = this.S.draftAttachments.filter(att => att.id !== id);
                this.renderDraftAttachments();
                this.updateSendButtonState();
            });
        }

        // 3. Search filter input
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                this.S.searchQ = e.target.value;
                this.renderContacts();
            });
        }

        const modeDmBtn = document.getElementById('modeDmBtn');
        const modeServersBtn = document.getElementById('modeServersBtn');
        if (modeDmBtn) modeDmBtn.addEventListener('click', () => this.setNavMode('dm'));
        if (modeServersBtn) modeServersBtn.addEventListener('click', () => this.setNavMode('servers'));

        const authForm = document.getElementById('authForm');
        const authLoginBtn = document.getElementById('authLoginBtn');
        if (authForm) {
            authForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitAuth(this.S.auth.mode);
            });
        }
        if (authLoginBtn) {
            authLoginBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.submitAuth(this.S.auth.mode);
            });
        }

        const authRegisterBtn = document.getElementById('authRegisterBtn');
        if (authRegisterBtn) authRegisterBtn.addEventListener('click', () => {
            this.setAuthMode(this.S.auth.mode === 'register' ? 'login' : 'register');
        });

        const authNetworkSaveBtn = document.getElementById('authNetworkSaveBtn');
        const authApiBaseUrl = document.getElementById('authApiBaseUrl');
        if (authApiBaseUrl) {
            authApiBaseUrl.addEventListener('input', () => {
                authApiBaseUrl.dataset.dirty = '1';
                const authNote = document.getElementById('authNetworkNote');
                const value = String(authApiBaseUrl.value || '').trim();
                if (authNote) {
                    authNote.textContent = value ? `Будет использован: ${value}` : 'Автоматически подставляется из настроек';
                }
            });
            authApiBaseUrl.addEventListener('blur', () => {
                this.syncAuthNetworkInput();
            });
        }
        if (authNetworkSaveBtn) {
            authNetworkSaveBtn.addEventListener('click', () => {
                const apiBaseUrl = String(authApiBaseUrl?.value || '').trim();
                if (!apiBaseUrl) {
                    this.addLogEntry({
                        type: 'ERROR',
                        msg: 'Укажите адрес API сервера',
                        ts: new Date().toLocaleTimeString(),
                    });
                    return;
                }
                const current = this.loadNetworkConfig();
                this.setNetworkConfig({
                    apiBaseUrl,
                    wsBaseUrl: this.deriveWsBaseUrl(apiBaseUrl),
                    iceServers: current.iceServers,
                });
                if (authApiBaseUrl) {
                    authApiBaseUrl.dataset.dirty = '0';
                }
                this.addLogEntry({
                    type: 'SUCCESS',
                    msg: `Адрес сервера обновлён: ${apiBaseUrl}`,
                    ts: new Date().toLocaleTimeString(),
                });
                this.updateAuthView();
            });
        }

        const authGuestBtn = document.getElementById('authGuestBtn');
        if (authGuestBtn) authGuestBtn.addEventListener('click', () => this.continueAsGuest());

        const authUsername = document.getElementById('authUsername');
        const authPassword = document.getElementById('authPassword');
        if (authUsername) {
            authUsername.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.submitAuth(this.S.auth.mode);
                }
            });
        }
        if (authPassword) {
            authPassword.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.submitAuth(this.S.auth.mode);
                }
            });
        }
        if (authApiBaseUrl) {
            authApiBaseUrl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    authNetworkSaveBtn?.click();
                }
            });
        }

        requestAnimationFrame(() => {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        });
        setTimeout(() => {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        }, 120);

        const settingsBtn = document.getElementById('settingsBtn');
        const serverSettingsBtn = document.getElementById('serverSettingsBtn');
        const serverOverlay = document.getElementById('serverOverlay');
        const serverModalClose = document.getElementById('serverModalClose');
        const serverModalCancel = document.getElementById('serverModalCancel');
        const serverSaveBtn = document.getElementById('serverSaveBtn');
        const serverDeleteBtn = document.getElementById('serverDeleteBtn');
        const serverMemberAddBtn = document.getElementById('serverMemberAddBtn');
        const serverJoinLinkGenerateBtn = document.getElementById('serverJoinLinkGenerateBtn');
        const serverJoinLinkCopyBtn = document.getElementById('serverJoinLinkCopyBtn');
        const serverAvatarUploadBtn = document.getElementById('serverAvatarUploadBtn');
        const serverAvatarRemoveBtn = document.getElementById('serverAvatarRemoveBtn');
        const serverBannerUploadBtn = document.getElementById('serverBannerUploadBtn');
        const serverBannerRemoveBtn = document.getElementById('serverBannerRemoveBtn');
        const serverRoleCreateBtn = document.getElementById('serverRoleCreateBtn');
        const serverRoleNameInput = document.getElementById('serverRoleNameInput');
        const settingsLogoutBtn = document.getElementById('settingsLogoutBtn');
        const clearLogsBtn = document.getElementById('clearLogs');
        const closeSettings = document.getElementById('closeSettings');
        const networkConfigSaveBtn = document.getElementById('networkConfigSaveBtn');
        const networkConfigResetBtn = document.getElementById('networkConfigResetBtn');
        const networkTurnApplyBtn = document.getElementById('networkTurnApplyBtn');
        const networkTurnFillBtn = document.getElementById('networkTurnFillBtn');
        const inputApiBaseUrl = document.getElementById('inputApiBaseUrl');
        const inputWsBaseUrl = document.getElementById('inputWsBaseUrl');
        const inputIceServers = document.getElementById('inputIceServers');
        const avatarUploadBtn = document.getElementById('avatarUploadBtn');
        const avatarResetBtn = document.getElementById('avatarResetBtn');
        const meAva = document.getElementById('meAva');

        const openAvatarPicker = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            input.style.top = '0';
            input.style.width = '1px';
            input.style.height = '1px';
            input.style.opacity = '0';
            input.setAttribute('aria-hidden', 'true');
            document.body.appendChild(input);

            const cleanup = () => {
                input.removeEventListener('change', onChange);
                input.remove();
            };

            const onChange = async () => {
                const file = input.files && input.files[0];
                cleanup();
                if (!file) return;
                try {
                    await this.setProfileAvatar(file, this.myName());
                    this.addLogEntry({ type: 'SUCCESS', msg: `Аватар обновлён: ${this.myName()}`, ts: new Date().toLocaleTimeString() });
                } catch (err) {
                    this.addLogEntry({ type: 'ERROR', msg: err?.message || 'Не удалось обновить аватар', ts: new Date().toLocaleTimeString() });
                }
            };

            input.addEventListener('change', onChange, { once: true });
            input.click();
        };

        const showChatView = () => {
            this.openChatView();
        };

        const showSettingsView = () => {
            this.openSettingsView();
        };

        if (settingsBtn) settingsBtn.addEventListener('click', () => {
            this.applyNetworkConfigToInputs();
            showSettingsView();
        });
        if (serverSettingsBtn) {
            serverSettingsBtn.addEventListener('click', () => {
                if (this.canManageServer()) {
                    this.openServerModal('edit', this.S.activeServer);
                }
            });
        }
        if (serverOverlay) {
            serverOverlay.addEventListener('click', (e) => {
                if (e.target === serverOverlay) {
                    this.closeServerOverlay();
                }
            });
        }
        const serverModalNav = document.getElementById('serverModalNav');
        if (serverModalNav) {
            serverModalNav.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-server-modal-section]');
                if (!btn || btn.hidden) return;
                const section = btn.getAttribute('data-server-modal-section');
                this.setServerModalSection(section);
            });
        }
        const serverModal = document.getElementById('serverModal');
        if (serverModal) {
            serverModal.addEventListener('click', (e) => {
                const toggle = e.target.closest('[data-color-picker-toggle]');
                if (!toggle) return;
                const key = String(toggle.getAttribute('data-color-picker-toggle') || '').trim();
                if (!key) return;
                this.toggleServerModalColorPicker(key);
            });
        }
        const serverDiscoverQuery = document.getElementById('serverDiscoverQuery');
        if (serverDiscoverQuery) {
            serverDiscoverQuery.addEventListener('input', () => this.renderPublicServersModal());
        }
        const serverDiscoverRefreshBtn = document.getElementById('serverDiscoverRefreshBtn');
        if (serverDiscoverRefreshBtn) {
            serverDiscoverRefreshBtn.addEventListener('click', () => this.loadPublicServers({ silent: true }));
        }
        if (serverModalClose) serverModalClose.addEventListener('click', () => this.closeServerOverlay());
        if (serverModalCancel) serverModalCancel.addEventListener('click', () => this.closeServerOverlay());
        if (serverSaveBtn) serverSaveBtn.addEventListener('click', () => this.submitServerModal());
        if (serverDeleteBtn) {
            serverDeleteBtn.addEventListener('click', async () => {
                const serverId = this.S.serverModal.serverId || this.S.activeServer;
                const server = (this.S.servers || []).find(item => item.id === serverId);
                if (!server || this.normalizeMemberRole(server.myRole || server.my_role || '') !== 'owner') return;
                const confirmDelete = confirm(`Удалить сервер "${server.name}"?`);
                if (!confirmDelete) return;
                try {
                    const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}`, { method: 'DELETE' });
                    if (!res.ok && res.status !== 204) {
                        throw new Error(await res.text() || 'Не удалось удалить сервер');
                    }
                    this.closeServerOverlay();
                    await this.loadServers({ silent: true });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось удалить сервер' });
                    this.renderServerModal();
                }
            });
        }
        if (serverMemberAddBtn) {
            serverMemberAddBtn.addEventListener('click', async () => {
                const serverId = this.S.serverModal.serverId;
                const input = document.getElementById('serverMemberInput');
                const roleSelect = document.getElementById('serverMemberRole');
                const username = (input?.value || '').trim();
                const role = roleSelect?.value || 'member';
                if (!serverId || !username) return;
                try {
                    const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/members`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, role }),
                    });
                    if (!res.ok) {
                        throw new Error(await res.text() || 'Не удалось добавить участника');
                    }
                    if (input) input.value = '';
                    const data = await res.json();
                    this.setServerModalState({
                        members: Array.isArray(data?.members) ? data.members : this.S.serverModal.members,
                        error: '',
                    });
                    this.renderServerModal();
                    await this.loadServers({ silent: true });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось добавить участника' });
                    this.renderServerModal();
                }
            });
        }
        const serverChannelsList = document.getElementById('serverChannelsList');
        if (serverChannelsList) {
            serverChannelsList.addEventListener('click', async (e) => {
                const saveBtn = e.target.closest('[data-channel-save]');
                if (saveBtn) {
                    const channelId = saveBtn.getAttribute('data-channel-save');
                    try {
                        await this.saveServerChannel(channelId);
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось сохранить канал' });
                        this.renderServerModal();
                    }
                    return;
                }
                const deleteBtn = e.target.closest('[data-channel-delete]');
                if (deleteBtn) {
                    const channelId = deleteBtn.getAttribute('data-channel-delete');
                    if (!channelId) return;
                    try {
                        await this.deleteServerChannel(channelId);
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось удалить канал' });
                        this.renderServerModal();
                    }
                }
            });
        }
        if (serverJoinLinkGenerateBtn) {
            serverJoinLinkGenerateBtn.addEventListener('click', async () => {
                try {
                    const link = await this.generateServerJoinLink();
                    if (link) {
                        this.addLogEntry({ type: 'SUCCESS', msg: `Ссылка сервера обновлена`, ts: new Date().toLocaleTimeString() });
                    }
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось обновить ссылку' });
                    this.renderServerModal();
                }
            });
        }
        if (serverJoinLinkCopyBtn) {
            serverJoinLinkCopyBtn.addEventListener('click', async () => {
                const text = this.S.serverModal.joinLink || '';
                if (!text) return;
                try {
                    await navigator.clipboard.writeText(text);
                    this.addLogEntry({ type: 'SUCCESS', msg: 'Ссылка сервера скопирована', ts: new Date().toLocaleTimeString() });
                } catch (e) {
                    this.addLogEntry({ type: 'WARN', msg: 'Не удалось скопировать ссылку сервера', ts: new Date().toLocaleTimeString() });
                }
            });
        }
        const serverDiscoverList = document.getElementById('serverDiscoverList');
        if (serverDiscoverList) {
            serverDiscoverList.addEventListener('click', async (e) => {
                const card = e.target.closest('[data-public-server-id]');
                if (card && card.classList.contains('server-discover-item')) {
                    const serverId = card.getAttribute('data-public-server-id');
                    if (!serverId) return;
                    const server = (this.S.publicServers || []).find(item => String(item.id || '') === serverId);
                    if (!server) return;
                    const role = this.normalizeMemberRole(server.myRole || server.my_role || '');
                    if (role === 'owner' || role === 'admin' || role === 'member') {
                        this.closeServerOverlay();
                        this.setActiveServer(serverId);
                    } else {
                        await this.enterPublicServer(server.joinLink || server.join_link || server.id);
                    }
                    return;
                }
                const openBtn = e.target.closest('[data-public-server-open]');
                if (openBtn) {
                    const serverId = openBtn.getAttribute('data-public-server-open');
                    if (!serverId) return;
                    const server = (this.S.publicServers || []).find(item => String(item.id || '') === serverId);
                    if (!server) return;
                    if (this.normalizeMemberRole(server.myRole || server.my_role || '') === 'owner'
                        || this.normalizeMemberRole(server.myRole || server.my_role || '') === 'admin'
                        || this.normalizeMemberRole(server.myRole || server.my_role || '') === 'member') {
                        this.closeServerOverlay();
                        this.setActiveServer(serverId);
                        return;
                    }
                    await this.enterPublicServer(server.joinLink || server.join_link || server.id);
                    return;
                }
                const joinBtn = e.target.closest('[data-public-server-join]');
                if (joinBtn) {
                    await this.enterPublicServer(joinBtn.getAttribute('data-public-server-join'));
                }
            });
        }
        if (serverRoleCreateBtn) {
            serverRoleCreateBtn.addEventListener('click', async () => {
                const roleCreateOpen = !this.S.serverModal.roleCreateOpen;
                this.setServerModalState({ roleCreateOpen });
                this.renderServerModal();
            });
        }
        const serverChannelCreateBtn = document.getElementById('serverChannelCreateBtn');
        if (serverChannelCreateBtn) {
            serverChannelCreateBtn.addEventListener('click', async () => {
                if (this.S.serverModal.mode !== 'edit') return;
                const channelCreateOpen = !this.S.serverModal.channelCreateOpen;
                this.setServerModalState({ channelCreateOpen, error: '' });
                this.renderServerModal();
            });
        }
        const serverChannelCreateSubmitBtn = document.getElementById('serverChannelCreateSubmitBtn');
        if (serverChannelCreateSubmitBtn) {
            serverChannelCreateSubmitBtn.addEventListener('click', async () => {
                try {
                    await this.createServerChannel();
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось создать канал' });
                    this.renderServerModal();
                }
            });
        }
        const serverRoleCreateSubmitBtn = document.getElementById('serverRoleCreateSubmitBtn');
        if (serverRoleCreateSubmitBtn) {
            serverRoleCreateSubmitBtn.addEventListener('click', async () => {
                try {
                    const mode = this.S.serverModal.mode;
                    await this.createServerRole();
                    this.addLogEntry({
                        type: 'SUCCESS',
                        msg: mode === 'create' ? 'Черновик роли добавлен' : 'Роль создана',
                        ts: new Date().toLocaleTimeString(),
                    });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось создать роль' });
                    this.renderServerModal();
                }
            });
        }
        const pickServerAsset = (kind) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            input.style.top = '0';
            document.body.appendChild(input);
            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                input.remove();
                if (!file) return;
                try {
                    await this.uploadServerAsset(kind, file);
                    this.addLogEntry({ type: 'SUCCESS', msg: `${kind === 'avatar' ? 'Аватар' : 'Баннер'} сервера обновлён`, ts: new Date().toLocaleTimeString() });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось обновить медиа сервера' });
                    this.renderServerModal();
                }
            }, { once: true });
            input.click();
        };
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.addEventListener('click', () => pickServerAsset('avatar'));
        if (serverBannerUploadBtn) serverBannerUploadBtn.addEventListener('click', () => pickServerAsset('banner'));
        if (serverAvatarRemoveBtn) {
            serverAvatarRemoveBtn.addEventListener('click', async () => {
                try {
                    await this.removeServerAsset('avatar');
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось удалить аватар' });
                    this.renderServerModal();
                }
            });
        }
        if (serverBannerRemoveBtn) {
            serverBannerRemoveBtn.addEventListener('click', async () => {
                try {
                    await this.removeServerAsset('banner');
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось удалить баннер' });
                    this.renderServerModal();
                }
            });
        }
        if (settingsLogoutBtn) settingsLogoutBtn.addEventListener('click', () => this.logout());
        if (avatarUploadBtn) {
            avatarUploadBtn.addEventListener('click', () => openAvatarPicker());
        }
        if (avatarResetBtn) {
            avatarResetBtn.addEventListener('click', async () => {
                try {
                    await this.resetProfileAvatar(this.myName());
                    this.addLogEntry({ type: 'SUCCESS', msg: 'Аватар профиля удалён', ts: new Date().toLocaleTimeString() });
                } catch (err) {
                    this.addLogEntry({ type: 'ERROR', msg: err?.message || 'Не удалось удалить аватар', ts: new Date().toLocaleTimeString() });
                }
            });
        }
        if (meAva) {
            meAva.title = 'Нажмите, чтобы сменить свой аватар';
            meAva.addEventListener('click', () => openAvatarPicker());
        }
        if (clearLogsBtn) {
            clearLogsBtn.addEventListener('click', () => {
                const logBody = document.getElementById('logBody');
                if (logBody) logBody.innerHTML = '';
            });
        }
        if (closeSettings) closeSettings.addEventListener('click', () => showChatView());
        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        if (mobileMenuBtn) {
            mobileMenuBtn.addEventListener('click', () => this.toggleMobileSidebar());
        }
        const mobileBackdrop = document.getElementById('mobileBackdrop');
        if (mobileBackdrop) {
            mobileBackdrop.addEventListener('click', () => this.closeMobileSidebar());
        }
        const mobileChatsBtn = document.getElementById('mobileChatsBtn');
        if (mobileChatsBtn) {
            mobileChatsBtn.addEventListener('click', () => {
                this.setNavMode('dm');
                showChatView();
                this.openMobileSidebar();
            });
        }
        const mobileServersBtn = document.getElementById('mobileServersBtn');
        if (mobileServersBtn) {
            mobileServersBtn.addEventListener('click', () => {
                this.setNavMode('servers');
                showChatView();
                this.openMobileSidebar();
            });
        }
        const mobileSettingsBtn = document.getElementById('mobileSettingsBtn');
        if (mobileSettingsBtn) {
            mobileSettingsBtn.addEventListener('click', () => {
                this.applyNetworkConfigToInputs();
                showSettingsView();
            });
        }
        if (networkConfigSaveBtn) {
            networkConfigSaveBtn.addEventListener('click', () => {
                let iceServers = [];
                try {
                    iceServers = this.parseIceServersText(inputIceServers?.value || '');
                } catch (error) {
                    this.addLogEntry({
                        type: 'ERROR',
                        msg: `Не удалось сохранить network config: ${error?.message || error}`,
                        ts: new Date().toLocaleTimeString(),
                    });
                    return;
                }
                const turnUrl = String(document.getElementById('inputTurnUrl')?.value || '').trim();
                if (turnUrl) {
                    try {
                        iceServers = this.appendTurnPresetToIceServers(iceServers);
                    } catch (error) {
                        this.addLogEntry({
                            type: 'ERROR',
                            msg: `Не удалось добавить TURN: ${error?.message || error}`,
                            ts: new Date().toLocaleTimeString(),
                        });
                        return;
                    }
                }
                this.setNetworkConfig({
                    apiBaseUrl: inputApiBaseUrl?.value || '',
                    wsBaseUrl: inputWsBaseUrl?.value || '',
                    iceServers,
                });
            });
        }
        if (networkConfigResetBtn) {
            networkConfigResetBtn.addEventListener('click', () => this.resetNetworkConfig());
        }
        if (networkTurnApplyBtn) {
            networkTurnApplyBtn.addEventListener('click', () => {
                try {
                    const nextIceServers = this.appendTurnPresetToIceServers(
                        this.parseIceServersText(inputIceServers?.value || '')
                    );
                    this.setNetworkConfig({
                        apiBaseUrl: inputApiBaseUrl?.value || '',
                        wsBaseUrl: inputWsBaseUrl?.value || '',
                        iceServers: nextIceServers,
                    });
                } catch (error) {
                    this.addLogEntry({
                        type: 'ERROR',
                        msg: `Не удалось добавить TURN: ${error?.message || error}`,
                        ts: new Date().toLocaleTimeString(),
                    });
                }
            });
        }
        if (networkTurnFillBtn) {
            networkTurnFillBtn.addEventListener('click', () => {
                const turnUrlInput = document.getElementById('inputTurnUrl');
                const turnUsernameInput = document.getElementById('inputTurnUsername');
                const turnCredentialInput = document.getElementById('inputTurnCredential');
                const turnRelayOnlyInput = document.getElementById('inputTurnRelayOnly');
                if (turnUrlInput) turnUrlInput.value = 'turns:turn.example.com:5349';
                if (turnUsernameInput) turnUsernameInput.value = 'user';
                if (turnCredentialInput) turnCredentialInput.value = 'pass';
                if (turnRelayOnlyInput) turnRelayOnlyInput.checked = true;
            });
        }

        this.bindColorWheel({
            wheelId: 'serverColorWheel',
            hiddenId: 'serverColorInput',
            hexId: 'serverColorHexInput',
            initialValue: '#cbff00',
        });
        this.bindColorWheel({
            wheelId: 'serverRoleColorWheel',
            hiddenId: 'serverRoleColorInput',
            hexId: 'serverRoleColorHexInput',
            initialValue: '#cbff00',
        });

        // 6. Dynamic styler selector events
        document.querySelectorAll('.btn-theme').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const themeName = e.target.getAttribute('data-theme');
                this.bus.send('zali_styler:set_theme', themeName);
            });
        });

        const serverMembersList = document.getElementById('serverMembersList');
        if (serverMembersList) {
            serverMembersList.addEventListener('change', async (e) => {
                const roleSelect = e.target.closest('select[data-member-role]');
                if (!roleSelect) return;
                const serverId = this.S.serverModal.serverId;
                const username = roleSelect.getAttribute('data-member-role');
                if (!serverId || !username) return;
                try {
                    const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(username)}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, role: roleSelect.value }),
                    });
                    if (!res.ok) {
                        throw new Error(await res.text() || 'Не удалось изменить роль');
                    }
                    const data = await res.json();
                    this.setServerModalState({
                        members: Array.isArray(data?.members) ? data.members : this.S.serverModal.members,
                        error: '',
                    });
                    this.renderServerModal();
                    await this.loadServers({ silent: true });
                } catch (err) {
                    this.setServerModalState({ error: err?.message || 'Не удалось изменить роль' });
                    this.renderServerModal();
                }
            });

            serverMembersList.addEventListener('click', async (e) => {
                const removeBtn = e.target.closest('[data-member-remove]');
                if (!removeBtn) return;
                const serverId = this.S.serverModal.serverId;
                const username = removeBtn.getAttribute('data-member-remove');
                if (!serverId || !username) return;
                try {
                    const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(username)}`, {
                        method: 'DELETE',
                    });
                    if (!res.ok && res.status !== 204) {
                        throw new Error(await res.text() || 'Не удалось удалить участника');
                    }
                    if (res.status === 204) {
                        this.setServerModalState({
                            members: (this.S.serverModal.members || []).filter(member => String(member.username || '') !== username),
                            error: '',
                        });
                        this.renderServerModal();
                        await this.loadServers({ silent: true });
                        return;
                    }
                    const data = await res.json();
                    this.setServerModalState({
                        members: Array.isArray(data?.members) ? data.members : this.S.serverModal.members,
                        error: '',
                    });
                    this.renderServerModal();
                    await this.loadServers({ silent: true });
                } catch (err) {
                    this.setServerModalState({ error: err?.message || 'Не удалось удалить участника' });
                    this.renderServerModal();
                }
            });
        }

        const serverRolesList = document.getElementById('serverRolesList');
        if (serverRolesList) {
            serverRolesList.addEventListener('input', () => {
                if (this.S.serverModal.mode !== 'create') return;
                this.syncDraftServerRolesFromDom();
            });
            serverRolesList.addEventListener('click', async (e) => {
                const draftToggleBtn = e.target.closest('[data-draft-role-toggle]');
                if (draftToggleBtn) {
                    if (this.S.serverModal.mode !== 'create') return;
                    const draftId = String(draftToggleBtn.getAttribute('data-draft-role-toggle') || '').trim();
                    if (!draftId) return;
                    const nextRoles = this.syncDraftServerRolesFromDom().map(role => {
                        if (String(role.draftId || '') !== draftId) return role;
                        return {
                            ...role,
                            collapsed: !role.collapsed,
                        };
                    });
                    this.setServerModalState({ draftRoles: nextRoles, error: '' });
                    this.renderServerModal();
                    return;
                }
                const draftHead = e.target.closest('.server-role-head--draft');
                if (draftHead) {
                    if (this.S.serverModal.mode !== 'create') return;
                    const card = draftHead.closest('[data-draft-role-card]');
                    const draftId = String(card?.getAttribute('data-draft-role-card') || '').trim();
                    if (!draftId) return;
                    const nextRoles = this.syncDraftServerRolesFromDom().map(role => {
                        if (String(role.draftId || '') !== draftId) return role;
                        return {
                            ...role,
                            collapsed: !role.collapsed,
                        };
                    });
                    this.setServerModalState({ draftRoles: nextRoles, error: '' });
                    this.renderServerModal();
                    return;
                }
                const draftDeleteBtn = e.target.closest('[data-draft-role-delete]');
                if (draftDeleteBtn) {
                    if (this.S.serverModal.mode !== 'create') return;
                    const draftId = String(draftDeleteBtn.getAttribute('data-draft-role-delete') || '').trim();
                    if (!draftId) return;
                    const nextRoles = this.syncDraftServerRolesFromDom().filter(role => String(role.draftId || '') !== draftId);
                    this.setServerModalState({ draftRoles: nextRoles, error: '' });
                    this.renderServerModal();
                    return;
                }
                const saveBtn = e.target.closest('[data-role-save]');
                if (saveBtn) {
                    const roleId = saveBtn.getAttribute('data-role-save');
                    try {
                        await this.saveServerRole(roleId);
                        this.addLogEntry({ type: 'SUCCESS', msg: `Роль обновлена: ${roleId}`, ts: new Date().toLocaleTimeString() });
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось сохранить роль' });
                        this.renderServerModal();
                    }
                    return;
                }
                const deleteBtn = e.target.closest('[data-role-delete]');
                if (deleteBtn) {
                    const roleId = deleteBtn.getAttribute('data-role-delete');
                    if (!roleId) return;
                    const role = (this.S.serverModal.roles || []).find(item => String(item.roleId || '') === roleId);
                    const confirmDelete = confirm(`Удалить роль "${role?.name || roleId}"?`);
                    if (!confirmDelete) return;
                    try {
                        await this.deleteServerRole(roleId);
                        this.addLogEntry({ type: 'SUCCESS', msg: `Роль удалена: ${role?.name || roleId}`, ts: new Date().toLocaleTimeString() });
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось удалить роль' });
                        this.renderServerModal();
                    }
                }
            });
        }

        const sliderRadius = document.getElementById('sliderRadius');
        if (sliderRadius) {
            sliderRadius.addEventListener('input', (e) => {
                const radius = e.target.value;
                const radiusValText = document.getElementById('radiusVal');
                if (radiusValText) radiusValText.textContent = `${radius}px`;
                this.bus.send('zali_styler:set_border_radius', radius);
            });
        }

        const sliderMsgGap = document.getElementById('sliderMsgGap');
        if (sliderMsgGap) {
            const currentMsgGap = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--msg-gap'), 10);
            if (!Number.isNaN(currentMsgGap)) {
                sliderMsgGap.value = String(currentMsgGap);
                const out = document.getElementById('msgGapVal');
                if (out) out.textContent = `${currentMsgGap}px`;
            }
            sliderMsgGap.addEventListener('input', (e) => {
                const gap = e.target.value;
                const out = document.getElementById('msgGapVal');
                if (out) out.textContent = `${gap}px`;
                this.bus.send('zali_styler:set_variable', '--msg-gap', gap);
            });
        }

        const sliderSuggestHeight = document.getElementById('sliderSuggestHeight');
        if (sliderSuggestHeight) {
            sliderSuggestHeight.addEventListener('input', (e) => {
                const height = `${e.target.value}px`;
                const out = document.getElementById('suggestHeightVal');
                if (out) out.textContent = height;
                this.bus.send('zali_styler:set_variable', '--contact-suggest-max-h', height);
            });
        }

        const sliderSuggestContrast = document.getElementById('sliderSuggestContrast');
        if (sliderSuggestContrast) {
            sliderSuggestContrast.addEventListener('input', (e) => {
                const percent = Number(e.target.value) || 0;
                const bgAlpha = Math.min(0.98, Math.max(0.72, 0.58 + (percent / 100) * 0.32));
                const borderAlpha = Math.min(0.95, Math.max(0.18, 0.08 + (percent / 100) * 0.28));
                const shadowAlpha = Math.min(0.65, Math.max(0.24, 0.12 + (percent / 100) * 0.5));
                const bg = `rgba(8,10,14,${bgAlpha.toFixed(3)})`;
                const border = `rgba(255,255,255,${borderAlpha.toFixed(3)})`;
                const shadow = `0 22px 48px rgba(0,0,0,${shadowAlpha.toFixed(3)})`;
                const out = document.getElementById('suggestContrastVal');
                if (out) out.textContent = `${percent}%`;
                this.bus.send('zali_styler:set_variable', '--contact-suggest-bg', bg);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-border', border);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-shadow', shadow);
            });
        }

        const sliderSuggestDensity = document.getElementById('sliderSuggestDensity');
        if (sliderSuggestDensity) {
            sliderSuggestDensity.addEventListener('input', (e) => {
                const density = Number(e.target.value) || 0;
                const padY = Math.max(8, 16 - Math.round(density / 3));
                const padX = Math.max(10, 16 - Math.round(density / 4));
                const gap = Math.max(4, 12 - Math.round(density / 3));
                const font = Math.min(16, 13 + Math.round(density / 8));
                const hint = Math.max(0.34, Math.min(0.72, 0.42 + density / 60));
                const out = document.getElementById('suggestDensityVal');
                if (out) out.textContent = String(density);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-item-pad-y', `${padY}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-item-pad-x', `${padX}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-gap', `${gap}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-font', `${font}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-hint', `rgba(255,255,255,${hint.toFixed(3)})`);
            });
        }

        // 7. Cryptography setting custom key
        // Routes through zali_styler which proxies to Swift → Rust backend
        const inputCryptoKey = document.getElementById('inputCryptoKey');
        if (inputCryptoKey) {
            const storedKey = this.loadStoredCryptoKey();
            if (storedKey && !inputCryptoKey.value.trim()) {
                inputCryptoKey.value = storedKey;
            }
            inputCryptoKey.addEventListener('input', (e) => {
                const newKey = e.target.value.trim();
                this.saveStoredCryptoKey(newKey);
                this.bus.send('zali_styler:set_key', newKey);
            });
        }

        // 8. Title bar drag helper
        const titlebar = document.getElementById('titlebar');
        if (titlebar && this.nativeSupports('windowDrag')) {
            titlebar.addEventListener('mousedown', (e) => {
                if (!e.target.closest('.ws-pill') && !e.target.closest('.hdr-btn')) {
                    this.postNativeMessage({ type: 'START_DRAG' });
                }
            });
        }

        // Report app loaded
        this.addLogEntry({ type: 'INFO', msg: 'ZaliMessenger v6.0 (Rust Backend) запущен — шифрование и сетевой стек работают в Rust', ts: new Date().toLocaleTimeString() });
        this.resizeComposer();
        this.syncMobileChrome();
        const mobileQuery = this.mobileLayoutQuery();
        if (mobileQuery) {
            const onMobileChange = () => {
                if (!this.isMobileLayout()) {
                    this.closeMobileSidebar();
                }
                this.syncMobileChrome();
            };
            if (typeof mobileQuery.addEventListener === 'function') {
                mobileQuery.addEventListener('change', onMobileChange);
            } else if (typeof mobileQuery.addListener === 'function') {
                mobileQuery.addListener(onMobileChange);
            }
        }
        window.addEventListener('resize', () => {
            if (!this.isMobileLayout()) {
                this.closeMobileSidebar();
            }
            this.syncMobileChrome();
        }, { passive: true });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isMobileLayout() && document.body?.classList.contains('mobile-sidebar-open')) {
                this.closeMobileSidebar();
            }
        });
    }
}
window.ZaliInterface = ZaliInterface;
