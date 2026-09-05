// Один «клиент» = настоящий экземпляр ZaliInterface, у которого живой только
// путь отрисовки списка сообщений и персиста кэша. Ничего в web/src не
// подменяется: стабы стоят ровно на границах браузера (DOM-узел #msgs,
// localStorage, нативный мост), а всё, что считает стоимость — esc(),
// renderAttachmentPreview(), renderAvatarHTML(), saveStoredMessageCache() —
// это боевые методы прототипа.
//
// Меряем не «сколько миллисекунд», а размерность работы: сколько символов
// проходит через экранирование, какой длины строка HTML уходит в innerHTML,
// сколько байт сериализуется в кэш. Время зависит от машины, размерность —
// от кода.
import { loadZaliInterface } from '../../voice_doctor/lib/load_interface.mjs';

/** data:-URL нужной длины — ровно та форма, в которой вложения приходят от
 *  macOS/Windows-шелла (WebView.swift makeDataURL / native.rs). */
export function dataUrlOfBytes(bytes, mimeType = 'image/png') {
    const base64Len = Math.ceil(bytes / 3) * 4;
    return `data:${mimeType};base64,${'A'.repeat(base64Len)}`;
}

class BoxStub {
    constructor() {
        this.scrollTop = 0;
        this.clientHeight = 800;
        this.childElementCount = 0;
        this.style = {};
        this.dataset = {};
        this.writes = 0;
        this.writtenChars = 0;
        this._html = '';
    }
    set innerHTML(value) {
        const next = String(value == null ? '' : value);
        this.writes += 1;
        this.writtenChars += next.length;
        this._html = next;
        this.childElementCount = next ? 1 : 0;
    }
    get innerHTML() { return this._html; }
    // Высота списка выводится из средней высоты сообщения: без неё
    // computeMessageWindow() решил бы, что прокручивать нечего.
    get scrollHeight() { return Math.max(this.clientHeight, this._html.length / 40); }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    getBoundingClientRect() { return { top: 0, bottom: this.clientHeight, left: 0, right: 400 }; }
    addEventListener() {}
    removeEventListener() {}
}

export class RenderClient {
    /**
     * @param {object} opts { me, peer }
     */
    constructor(opts = {}) {
        this.me = opts.me || 'alice';
        this.peer = opts.peer || 'bob';
        this.box = new BoxStub();
        this.escChars = 0;
        this.escCalls = 0;
        this.persistedBytes = 0;
        this.persistCalls = 0;
        this.nativeBridgeBytes = 0;

        const { ZaliInterface, sandbox, apiRoutes } = loadZaliInterface({ Blob });
        this.sandbox = sandbox;
        sandbox.document.getElementById = (id) => (id === 'msgs' ? this.box : null);

        const api = Object.create(ZaliInterface.prototype);
        this.api = api;
        api.S = {
            navMode: 'dm',
            current: this.peer,
            loading: false,
            session: { token: 'token', username: this.me },
            auth: {},
            chats: { [this.peer]: [] },
            serverChats: {},
            contacts: [this.peer],
            unread: {},
            searchQ: '',
            draftAttachments: [],
        };
        api.apiRoutes = apiRoutes;
        api.messageWindow = { conversationKey: '', start: 0, end: 0, count: 0, useWindow: false, avgHeight: 92 };
        api.mediaSizeCache = new Map();
        api.avatarCache = new Map();
        api.avatarFetchSeq = new Map();
        api.avatarRequests = new Map();
        api.tenorCache = new Map();
        api.tenorPending = new Set();
        api._listHTMLCache = new Map();

        api.myName = () => this.me;
        api.trace = () => {};
        api.addLogEntry = () => {};
        api.nativeSupports = (cap) => cap === 'saveMessageCache';
        api.hasNativeBridge = () => true;
        api.hideReactionMenu = () => {};
        api.renderVoicePanel = () => {};
        api.hydrateGifMedia = () => {};
        api.updateChatHeaderCryptoKey = () => {};
        api.setHTMLIfChanged = () => false;
        api.reportDecryptFailure = async () => {};
        api.queueDecryptFailureReport = () => {};
        api.currentChannel = () => null;
        api.currentServer = () => null;
        api.currentServerChatKey = () => '';
        api.isVoiceChannel = () => false;
        api.ensureConversationLoaded = () => false;
        api.ensureAvatarLoaded = () => null;
        api.initChat = (peer) => { if (!api.S.chats[peer]) api.S.chats[peer] = []; };
        api.isPeerMuted = () => false;
        api.uiIcon = () => '';
        api.updateSidebarModeLabel = () => {};
        api.renderMessageReactions = () => '';
        api.postNativeMessage = (payload) => {
            // Мост копирует полезную нагрузку целиком — это её реальная цена.
            try { this.nativeBridgeBytes += JSON.stringify(payload).length; } catch (e) {}
            return true;
        };

        // esc() остаётся настоящим — оборачиваем только для счётчика: он и есть
        // предмет измерения (пять regex-проходов по каждой переданной строке).
        const realEsc = ZaliInterface.prototype.esc;
        api.esc = (value) => {
            this.escCalls += 1;
            this.escChars += value == null ? 0 : String(value).length;
            return realEsc.call(api, value);
        };

        // localStorage сандбокса реальный (Map), но нам нужен размер записи.
        const store = sandbox.localStorage;
        const realSetItem = store.setItem.bind(store);
        store.setItem = (key, value) => {
            if (String(key).startsWith('zali_message_cache')) {
                this.persistCalls += 1;
                this.persistedBytes += String(value).length;
            }
            return realSetItem(key, value);
        };
    }

    /** Диалог из `count` сообщений, каждое `withAttachmentEvery`-е — с вложением. */
    seedConversation({ count, attachmentBytes = 0, withAttachmentEvery = 1, avatarBytes = 0 } = {}) {
        if (avatarBytes > 0) {
            // Через боевой saveStoredAvatar(), а не прямой записью в Map: именно
            // он решает, в каком виде аватар лежит в кэше, и проверять надо его.
            this.api.saveStoredAvatar(this.peer, dataUrlOfBytes(avatarBytes, 'image/jpeg'));
            this.api.saveStoredAvatar(this.me, dataUrlOfBytes(avatarBytes, 'image/jpeg'));
        }
        const msgs = [];
        for (let i = 0; i < count; i += 1) {
            const hasAttachment = attachmentBytes > 0 && (i % withAttachmentEvery === 0);
            msgs.push({
                id: `msg-${i}`,
                clientId: `client-${i}`,
                sender: i % 2 === 0 ? this.me : this.peer,
                receiver: i % 2 === 0 ? this.peer : this.me,
                text: `сообщение номер ${i}`,
                timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
                attachments: hasAttachment ? [{
                    id: `att-${i}`,
                    name: `photo-${i}.png`,
                    mimeType: 'image/png',
                    kind: 'image',
                    size: attachmentBytes,
                    dataUrl: dataUrlOfBytes(attachmentBytes),
                }] : [],
                reactions: [],
                myReactions: [],
            });
        }
        this.api.S.chats[this.peer] = msgs;
        return msgs;
    }

    /** Байты вложений в состоянии — знаменатель для всех коэффициентов. */
    attachmentBytesInState() {
        let total = 0;
        for (const msgs of Object.values(this.api.S.chats)) {
            for (const msg of msgs || []) {
                for (const att of msg.attachments || []) total += Number(att.size || 0);
            }
        }
        return total;
    }

    resetCounters() {
        this.escChars = 0;
        this.escCalls = 0;
        this.persistedBytes = 0;
        this.persistCalls = 0;
        this.nativeBridgeBytes = 0;
        this.box.writes = 0;
        this.box.writtenChars = 0;
    }

    /** Один кадр отрисовки — ровно то, что делает scheduleRenderMessages(). */
    render() {
        this.api._renderMessagesNow();
    }
}
