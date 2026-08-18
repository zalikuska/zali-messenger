// @ts-check

const API_VERSION_PREFIX = '/api';
const AUTH_REQUEST_TIMEOUT_MS = 6500;
const SESSION_RESTORE_TIMEOUT_MS = 12000;
const API_REQUEST_TIMEOUT_MS = 8000;

const NativeMessageTypes = window.ZaliNativeMessageTypes || Object.freeze({
    SEND_MESSAGE: 'SEND_MESSAGE',
    SET_SESSION: 'SET_SESSION',
    REFRESH_HISTORY: 'REFRESH_HISTORY',
    LOAD_SERVER_HISTORY: 'LOAD_SERVER_HISTORY',
    SAVE_STYLE: 'SAVE_STYLE',
    SAVE_MESSAGE_CACHE: 'SAVE_MESSAGE_CACHE',
    SAVE_PENDING_OUTBOX: 'SAVE_PENDING_OUTBOX',
    DOWNLOAD_ATTACHMENT: 'DOWNLOAD_ATTACHMENT',
    OPEN_EXTERNAL_URL: 'OPEN_EXTERNAL_URL',
    START_DRAG: 'START_DRAG',
    MINIMIZE_WINDOW: 'MINIMIZE_WINDOW',
    MAXIMIZE_WINDOW: 'MAXIMIZE_WINDOW',
    CLOSE_WINDOW: 'CLOSE_WINDOW',
    RESOLVE_TENOR: 'RESOLVE_TENOR',
    SET_KEY: 'SET_KEY',
    SET_MESSAGE_REACTION: 'SET_MESSAGE_REACTION',
    NETWORK_CONFIG: 'NETWORK_CONFIG',
    VOICE_EVENT: 'VOICE_EVENT',
    AUTH_REQUEST: 'AUTH_REQUEST',
    API_REQUEST: 'API_REQUEST',
    ADD_CONTACT_REQUEST: 'ADD_CONTACT_REQUEST',
    REMOVE_CONTACT_REQUEST: 'REMOVE_CONTACT_REQUEST',
    UPLOAD_AVATAR_REQUEST: 'UPLOAD_AVATAR_REQUEST',
    DELETE_AVATAR_REQUEST: 'DELETE_AVATAR_REQUEST',
    LOAD_AVATAR_REQUEST: 'LOAD_AVATAR_REQUEST',
    SHOW_NOTIFICATION: 'SHOW_NOTIFICATION',
    PERSIST_DEVICE_IDENTITY: 'PERSIST_DEVICE_IDENTITY',
    DOWNLOAD_UPDATE_REQUEST: 'DOWNLOAD_UPDATE_REQUEST',
    INSTALL_UPDATE_REQUEST: 'INSTALL_UPDATE_REQUEST',
    MOBILE_NAV_PROGRESS: 'MOBILE_NAV_PROGRESS',
});

const apiRoute = (path) => `${API_VERSION_PREFIX}${path}`;

/**
 * @typedef {Object} ZaliServerModalState
 * @property {'create'|'edit'} mode
 * @property {string|null} serverId
 * @property {string} activeSection
 * @property {Record<string, string>} colorPickers
 * @property {boolean} roleCreateOpen
 * @property {boolean} channelCreateOpen
 * @property {Array<any>} members
 * @property {Array<any>} roles
 * @property {Array<any>} channels
 * @property {Array<any>} draftRoles
 * @property {{name: string, description: string, icon: string, color: string, joinLink: string, isPublic: boolean}|null} createDraft
 * @property {string} joinLink
 * @property {string|null} selectedChannelId
 * @property {Array<any>} channelPermissions
 * @property {boolean} loading
 * @property {boolean} saving
 * @property {string} error
 */

/**
 * @typedef {Object} ZaliSessionState
 * @property {string} username
 * @property {string|null} token
 * @property {boolean} guest
 */

/**
 * @typedef {Object} ZaliAuthState
 * @property {boolean} visible
 * @property {boolean} loading
 * @property {string} error
 * @property {'login'|'register'} mode
 * @property {boolean} fieldsCleared
 * @property {string} vaultPassphrase
 * @property {boolean} cloudVaultSyncEnabled
 */

/**
 * @typedef {Object} ZaliDeviceTrustState
 * @property {any|null} current
 * @property {Array<any>} devices
 * @property {string} exportPackage
 * @property {string} exportCode
 * @property {string} importPackage
 * @property {string} importCode
 * @property {string} status
 */

/**
 * @typedef {Object} ZaliMessageWindowState
 * @property {string} conversationKey
 * @property {number} start
 * @property {number} end
 * @property {number} avgHeight
 * @property {number} [count]
 * @property {boolean} [useWindow]
 */

/**
 * @typedef {Object} ZaliInterfaceState
 * @property {Record<string, any[]>} chats
 * @property {string[]} users
 * @property {string[]} contacts
 * @property {string|null} current
 * @property {Record<string, number>} unread
 * @property {boolean} wsOn
 * @property {boolean} loading
 * @property {string} searchQ
 * @property {'dm'|'servers'} navMode
 * @property {string|null} activeServer
 * @property {string|null} activeChannel
 * @property {Array<any>} servers
 * @property {Array<any>} publicServers
 * @property {Record<string, any[]>} serverChats
 * @property {Array<any>} draftAttachments
 * @property {{id: string, sender: string, text: string, attachmentCount: number}|null} replyDraft
 * @property {{id: string, originalText: string}|null} editDraft
 * @property {ZaliServerModalState} serverModal
 * @property {ZaliSessionState} session
 * @property {ZaliAuthState} auth
 * @property {ZaliDeviceTrustState} deviceTrust
 */

const DefaultApiRoutes = Object.freeze({
    devices: {
        list: apiRoute('/devices'),
        byId: (id) => apiRoute(`/devices/${encodeURIComponent(id)}`),
        approve: apiRoute('/devices/approve'),
        publicByUser: (username) => apiRoute(`/users/${encodeURIComponent(username)}/devices`),
    },
    vault: {
        events: apiRoute('/vault/events'),
    },
    keyEnvelopes: {
        list: (deviceId = '') => apiRoute(`/key-envelopes${deviceId ? `?deviceId=${encodeURIComponent(deviceId)}` : ''}`),
        base: apiRoute('/key-envelopes'),
    },
    conversationKeys: {
        lookup: (scopes) => apiRoute(`/conversation-keys?scopes=${encodeURIComponent(scopes)}`),
        claim: apiRoute('/conversation-keys/claim'),
        republish: apiRoute('/conversation-keys/republish'),
    },
    historyTickets: apiRoute('/history-tickets'),
    discover: {
        servers: apiRoute('/discover/servers'),
    },
    auth: {
        me: apiRoute('/auth/me'),
        register: apiRoute('/auth/register'),
        login: apiRoute('/auth/login'),
        wsTicket: apiRoute('/auth/ws-ticket'),
    },
    contacts: {
        list: apiRoute('/contacts'),
        byUsername: (username) => apiRoute(`/contacts/${encodeURIComponent(username)}`),
    },
    users: {
        search: (query) => apiRoute(`/users?q=${encodeURIComponent(query)}`),
    },
    avatar: {
        base: apiRoute('/avatar'),
        byUsername: (username) => apiRoute(`/avatar/${encodeURIComponent(username)}`),
    },
    invites: {
        join: (code) => apiRoute(`/invites/${encodeURIComponent(code)}/join`),
    },
    messages: {
        direct: (user) => apiRoute(`/messages/${encodeURIComponent(user)}`),
        reaction: (id) => apiRoute(`/message/${encodeURIComponent(id)}/reaction`),
        remove: (id) => apiRoute(`/message/${encodeURIComponent(id)}`),
        edit: (id) => apiRoute(`/message/${encodeURIComponent(id)}`),
        download: (id) => apiRoute(`/download/${encodeURIComponent(id)}`),
    },
    servers: {
        list: apiRoute('/servers'),
        join: apiRoute('/servers/join'),
        byId: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}`),
        channels: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels`),
        channel: (serverId, channelId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}`),
        channelMessages: (serverId, channelId, limit, offset) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/messages?limit=${limit}&offset=${offset}`),
        assets: (serverId, kind) => apiRoute(`/servers/${encodeURIComponent(serverId)}/assets/${kind}`),
        members: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/members`),
        member: (serverId, username) => apiRoute(`/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(username)}`),
        roles: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/roles`),
        role: (serverId, roleId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(roleId)}`),
        invites: (serverId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/invites`),
        permissions: (serverId, channelId) => apiRoute(`/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/permissions`),
    },
    coins: {
        balance: apiRoute('/coins/balance'),
        distribution: apiRoute('/coins/distribution'),
        transfer: apiRoute('/coins/transfer'),
    },
});

/**
 * ZaliInterface — весь клиентский UI. Здесь только каркас: конструктор и init().
 * Тело класса разложено по web/src/interface/ и подключается через ZaliMixin
 * (см. web/src/mixin.js). Порядок загрузки — web/src/manifest.json, группа
 * "interface"; тот же список читают харнессы scripts/*_doctor и bridge_check.sh.
 *
 * Добавляя функциональность, кладите метод в подходящую часть, а новый файл
 * впишите в манифест — больше нигде список файлов не продублирован.
 *
 * Карта частей (строк / методов — ориентировочно, счётчики не обновляются сами):
 *
 *   format.js               104 /  11  Экранирование, иконки, форматирование времени и дат.
 *   native_bridge.js        300 /  24  Мост к нативной оболочке: доступность, IPC, разрешения, трассировка.
 *   viewport.js             324 /  17  Окно прокрутки списка сообщений, класс производительности, якоря скролла.
 *   mobile.js               575 /  20  Мобильная раскладка, жесты навигации, переключение экранов.
 *   zalicoin.js             270 /  10  Экран ZaliCoin: баланс, распределение, переводы.
 *   prefs.js                452 /  39  Пользовательские настройки: тема, звук, устройства ввода/вывода, сегменты хаба.
 *   storage.js              405 /  31  Ключи localStorage, кэш сообщений, персист контактов.
 *   conversation_keys.js    762 /  44  Реестр ключей разговоров и облачный vault-снапшот.
 *   key_resolution.js       771 /  28  Разрешение ключа разговора, идентичность устройства, крипто-примитивы конвертов и vault.
 *   key_envelopes.js        749 /  21  Публикация/приём ключевых конвертов, доверие устройств.
 *   session.js              463 /  23  Сессия и токен, недавние аккаунты, снапшот здоровья звонка.
 *   outbox.js               632 /  25  Очередь неотправленных сообщений и её досылка.
 *   network_config.js       515 /  40  Сетевая конфигурация: API/WS адреса, ICE/TURN.
 *   servers_model.js        391 /  31  Модель серверов и ролей, работа с цветом.
 *   server_modal.js        1361 /  52  Модалка настроек сервера: роли, каналы, участники, инвайты.
 *   voice_transport.js      505 /  17  Голосовые комнаты и транспорт сигналинга.
 *   voice_media.js         1482 /  45  Захват микрофона/камеры/экрана, треки, индикаторы уровня.
 *   voice_negotiation.js    664 /  18  Жизненный цикл пира: offer/answer, рестарты, супервизор связи.
 *   voice_call.js           440 /  19  Управление звонком и записи о звонках.
 *   voice_signal.js         768 /   4  Обработка входящих voice_* сигналов и событий.
 *   voice_ui.js             396 /  10  Отрисовка голосовой панели, плиток и развёрнутого звонка.
 *   server_messages.js      700 /  15  Загрузка сообщений серверов/каналов, синхронизация активного разговора.
 *   avatars.js              771 /  31  Аватары и ассеты серверов: кэш, загрузка, кроппер, даунскейл.
 *   api.js                  198 /   8  HTTP-конвейер: заголовки, слоты параллелизма, apiFetch.
 *   auth.js                1157 /  31  Бутстрап сессии, вход/регистрация, контакты.
 *   attachments.js          349 /  24  Вложения, Tenor, предпросмотр медиа.
 *   message_render.js       861 /  29  Отрисовка тела сообщения, реакции, статусы.
 *   render_shell.js         460 /   9  Отрисовка списков контактов, хаба и серверов.
 *   updates.js              261 /  16  Встроенный апдейтер клиента.
 *   message_list.js         466 /   7  Окно сообщений, рендер списка, переключение чата.
 *   message_send.js         719 /  10  Отправка сообщений и приём в браузерном режиме.
 *   notifications.js        455 /  24  Мьюты, звуки, уведомления, бейдж непрочитанного.
 *   state_sync.js           529 /  15  Приём состояния от нативного слоя: пользователи, история, статус связи.
 *   message_edit.js         376 /  15  Ответы, редактирование и удаление сообщений.
 *   diagnostics.js          157 /   5  Журнал диагностики и голосовая телеметрия.
 *   events.js              1651 /  16  Привязка DOM-событий и инерция прокрутки.
 */
class ZaliInterface {
    constructor() {
        this.name = 'zali_interface';
        // Must run before ANY stored state is read below (message cache, conversation
        // keys, session, device identity) — the server database was reset at this
        // instant, so everything written before it refers to accounts, message ids and
        // key envelopes that no longer exist.
        this.localResetApplied = this.applyLocalDataResetIfNeeded();

        const stateSlices = window.ZaliStateSlices || {};
        /** @type {ZaliInterfaceState} */
        this.S = Object.assign(
            {},
            stateSlices.auth?.createState?.() || {},
            stateSlices.contacts?.createState?.() || {},
            stateSlices.messaging?.createState?.() || {},
            stateSlices.servers?.createState?.() || {},
        );
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
        this.voiceSocketGeneration = 0;
        this.voiceSocketReconnectTimer = null;
        this.voiceSocketReconnectDelayMs = 1000;
        this.voiceSocketPingTimer = null;
        this.pendingMessagesScroll = null;
        this.pendingOutboxFlushTimer = null;
        this.sendWatchdogTimers = new Map();
        this.messageSyncTimer = null;
        this.energyMaintenanceBound = false;
        this.conversationSyncAt = new Map();
        this.conversationRefreshTimers = new Map();
        this.historyLoadSeq = 0;
        this.serverHistoryLoadSeq = new Map();
        this.messageScrollRaf = 0;
        this.messageRenderRaf = 0;
        this.sessionBootstrapInProgress = false;
        this.cloudVaultSyncTimer = 0;
        this.cloudVaultSyncInFlight = false;
        this.bridgeProtocol = window.__ZALI_BRIDGE_PROTOCOL__ || null;
        this.apiRoutes = window.ZaliApiRoutes || DefaultApiRoutes;
        this.clearLegacyKeyMaterial();
        this.S.auth.cloudVaultSyncEnabled = this.loadVaultCloudSyncEnabled();
        /** @type {ZaliMessageWindowState} */
        this.messageWindow = {
            conversationKey: '',
            start: 0,
            end: 0,
            avgHeight: 92,
        };
        this.postAuthSetupInFlight = false;
        this.postAuthSetupRunId = 0;
        this.lastNativeConversationKeySignature = '';
        this.voice = stateSlices.voice?.createState?.() || {
            supported: !!(window.RTCPeerConnection && navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
            roomId: '',
            roomType: '',
            serverId: '',
            channelId: '',
            targetUser: '',
            inviter: '',
            status: 'idle',
            muted: false,
            deafened: false,
            expanded: false,
            activeSince: 0,
            barTimerInterval: 0,
            localStream: null,
            localStreamInFlight: null,
            micError: '',
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
            meterLevels: {
                local: 0,
                remote: 0,
            },
            traceLines: [],
        };
        this.audioPrefs = this.loadAudioPrefs();
        // Independent of this.voice.audioContext (which lives only for the
        // duration of an active call, see resetVoiceState) — UI sounds (message
        // chime, ringtone) need a context that survives across calls and can
        // fire while the window is minimized/unfocused. Created lazily and
        // unlocked on the first user gesture (see installSoundUnlock) since
        // AudioContext.resume() silently stays 'suspended' without one.
        this.sound = { ctx: null, bus: null, unlocked: false, ringTimer: null, ringing: false };
        this.installSoundUnlock();

        const cachedMessages = this.loadStoredMessageCache();
        this.S.chats = cachedMessages.chats || {};
        this.S.serverChats = cachedMessages.serverChats || {};
        this.S.mutedChats = this.loadStoredMutedChats();
        // Per-peer/per-channel "have we already synced this at least once this
        // session" markers. A history merge (catch-up sweep, active-conversation
        // refresh, etc.) only fires a notification for a NEWLY inserted message once
        // the peer/channel has been primed once already — otherwise the very first
        // history load (login, opening a new chat) would replay the entire backlog
        // as a flood of notifications instead of being silently primed as baseline.
        this._historyPrimedPeers = new Set();
        this._historyPrimedChannels = new Set();
        this.uiV2Enabled = this.loadUiV2Enabled();
        this.uiV2Segments = this.loadUiV2Segments();
        this.experimentalDesign = this.loadExperimentalDesign();
        this.voiceTraceEnabled = this.loadVoiceTraceEnabled();
    }

    init(loader) {
        this.bus = loader.bus;
        try {
            window.__ZALI_INTERFACE = this;
        } catch (e) {}
        this.S.navMode = this.loadStoredNavMode();

        // Register UI update commands on the bus
        const E = window.ZaliBusEvents || {};
        this.bus.registerCommand('zali_interface', E.RECEIVE_MESSAGE || 'receive_message', (data) => this.receiveMessage(data));
        this.bus.registerCommand('zali_interface', E.SET_USERS || 'set_users', (users) => this.setUsers(users));
        this.bus.registerCommand('zali_interface', E.SET_CONTACTS || 'set_contacts', (contacts) => this.setContacts(contacts));
        this.bus.registerCommand('zali_interface', E.SET_SESSION || 'set_session', (session) => this.setSession(session));
        this.bus.registerCommand('zali_interface', E.LOAD_HISTORY || 'load_history', (messages) => this.loadHistory(messages));
        this.bus.registerCommand('zali_interface', E.LOAD_SERVER_HISTORY || 'load_server_history', (payload) => this.loadServerHistory(payload));
        this.bus.registerCommand('zali_interface', E.REFRESH_AFTER_KEY || 'refresh_after_key', () => this.refreshAfterKey());
        this.bus.registerCommand('zali_interface', E.RETRY_PUBLISH_KEYS || 'retry_publish_keys', () => this.retryPublishConversationKeys({ reason: 'device_approved_push' }));
        // Scope-targeted, and deliberately NOT folded into the sweep above. Both
        // native shells used to route `key_republish_request` into retryPublishKeys()
        // on the theory that the sweep is a superset — it is not. The sweep publishes
        // each scope's ACTIVE key only, while the requester is asking precisely
        // because the messages it cannot read were encrypted under a key we have
        // since demoted to an `alt:` candidate. handleKeyRepublishRequest answers
        // with every candidate, so it is the only path that can deliver a historical
        // key — and on macOS/Windows it was unreachable, which is why "перебрано
        // ключей N, ни один не подошёл" survived every previous fix.
        this.bus.registerCommand('zali_interface', E.KEY_REPUBLISH_REQUEST || 'key_republish_request', (payload) => this.handleKeyRepublishRequest(payload));
        this.bus.registerCommand('zali_interface', E.SYNC_ACTIVE_CONVERSATION || 'sync_active_conversation', (payload) => this.syncConversationFromNative(payload));
        this.bus.registerCommand('zali_interface', E.SET_LOADING || 'set_loading', (on) => this.setLoading(on));
        this.bus.registerCommand('zali_interface', E.SET_CONNECTION_STATUS || 'set_connection_status', (connected) => this.setConnectionStatus(connected));
        this.bus.registerCommand('zali_interface', E.ON_SEND_SUCCESS || 'on_send_success', (clientId) => this.onSendSuccess(clientId));
        this.bus.registerCommand('zali_interface', E.ON_SEND_ERROR || 'on_send_error', (payload) => this.onSendError(payload));
        this.bus.registerCommand('zali_interface', E.REACTION_UPDATED || 'reaction_updated', (data) => this.onReactionUpdated(data));
        this.bus.registerCommand('zali_interface', E.MESSAGE_DELETED || 'message_deleted', (data) => this.onMessageDeleted(data));
        this.bus.registerCommand('zali_interface', E.MESSAGE_EDITED || 'message_edited', (data) => this.onMessageEdited(data));
        this.bus.registerCommand('zali_interface', E.AVATAR_UPDATED || 'avatar_updated', (data) => this.handleAvatarUpdated(data));
        this.bus.registerCommand('zali_interface', E.TENOR_RESOLVED || 'tenor_resolved', (payload) => this.onTenorResolved(payload));
        this.bus.registerCommand('zali_interface', E.AUTH_RESPONSE || 'auth_response', (payload) => this.onNativeAuthResponse(payload));
        this.bus.registerCommand('zali_interface', E.NATIVE_RESPONSE || 'native_response', (payload) => this.onNativeResponse(payload));
        this.bus.registerCommand('zali_interface', E.ADD_LOG_ENTRY || 'add_log_entry', (data) => this.addLogEntry(data));
        this.bus.registerCommand('zali_interface', E.VOICE_EVENT || 'voice_event', (payload) => this.handleVoiceEvent(payload));
        this.bus.registerCommand('zali_interface', E.UPDATE_EVENT || 'update_event', (payload) => this.handleUpdateEvent(payload));
        this.bus.registerCommand('zali_interface', E.SCREEN_CAPTURE_FRAME || 'screen_capture_frame', (payload) => this.onNativeScreenCaptureFrame(payload));
        this.bus.registerCommand('zali_interface', E.SCREEN_CAPTURE_ERROR || 'screen_capture_error', (payload) => this.onNativeScreenCaptureError(payload));

        // Bind events after DOM is loaded
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.bindEvents());
        } else {
            this.bindEvents();
        }

        this.bootstrapSession();
        setTimeout(() => this.syncNativeConversationKeys(), 0);
        this.startEnergyAwareMaintenance();
        // Resolves the tier once and stamps data-perf-tier on <html> before the
        // first message list is built, so the very first render already uses the
        // right window size instead of re-windowing a frame later.
        this.perfTier();
        this.probeDisplayRefreshRate();
    }
}
window.ZaliInterface = ZaliInterface;
