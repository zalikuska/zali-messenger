// --- ZaliInterface: управление приложением командами (проверка, автотесты). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Один набор команд для всех способов достучаться до страницы:
//   • вкладка браузера / Playwright — `await window.__zaliControl('state')`;
//   • ссылка разработчика на локальном адресе — `?as=alice&chat=bob` (devBootFromUrl);
//   • нативные оболочки — локальный HTTP-вход с токеном (macOS ControlServer.swift,
//     Windows native/control.rs), включается флагом; клиент — scripts/zali_ctl.py.
// Команды зовут те же методы, что и кнопки, — проверяется настоящий путь приложения,
// а не обходной. Ответ — простой JSON (без DOM-узлов, потоков и Map).
//
// Опасного сверх того, что уже есть, тут нет: window.__ZALI_INTERFACE и так
// открыт любому коду в верхнем фрейме, а аддоны живут в sandbox-фреймах без доступа
// к нему. Нативный вход защищён токеном из файла, доступного только этому
// пользователю, и выключен по умолчанию.

// Пароль тестовых аккаунтов для ссылки разработчика. Работает только на локальном
// адресе страницы и локальном сервере (devBootAllowed) — к настоящим аккаунтам
// отношения не имеет.
const ZALI_DEV_PASSWORD = 'zali-dev-password';

ZaliMixin(ZaliInterface, class {

    /** Справка: команда → аргументы. */
    static get CONTROL_HELP() {
        return {
            help: '',
            state: '',
            login: '{user, password, register?}',
            logout: '',
            chats: '',
            open: '{chat} | {server, channel}',
            messages: '{chat | server+channel, limit=20} — по умолчанию открытый разговор',
            send: '{text, chat? | server+channel?}',
            view: '{name: chat|settings|hub|coin}',
            'contact.add': '{user}',
            'server.create': '{name}',
            'channel.create': '{server, name, kind: text|voice}',
            'voice.join': '{server, channel}',
            'voice.call': '{user, video?}',
            'voice.accept': '{video?}',
            'voice.reject': '',
            'voice.leave': '',
            'voice.mute': '{on?} — без on переключает',
            'voice.deafen': '{on?}',
            'voice.camera': '{on, device?}',
            'voice.state': '',
            devices: '',
            'screen.sources': '{thumbs?: false, thumbWidth?: 320}',
            'screen.start': '{source: id | номер | часть названия, kind?: display|window, height?, fps?, audio?}',
            'screen.stop': '',
            logs: '{n=60, kind: voice|journal}',
            api: '{method, path, body?}',
            eval: '{code} — тело async-функции, this = интерфейс',
            wait: '{code, timeout=10000} — ждёт истинного результата выражения',
        };
    }

    async control(cmd, args = {}) {
        const name = String(cmd || '').trim();
        const a = args && typeof args === 'object' ? args : {};
        const handlers = this.controlHandlers();
        const fn = handlers[name];
        if (!fn) return { ok: false, error: `unknown command: ${name}`, commands: Object.keys(handlers) };
        try {
            const result = await fn.call(this, a);
            return { ok: true, result: result === undefined ? null : this.controlPlain(result) };
        } catch (error) {
            return { ok: false, error: error?.message || String(error) };
        }
    }

    controlHandlers() {
        return {
            help: () => ZaliInterface.CONTROL_HELP,
            state: () => this.controlState(),
            login: (a) => this.controlLogin(a),
            logout: async () => { await this.logout(); return this.controlState(); },
            chats: () => this.controlChats(),
            open: (a) => this.controlOpen(a),
            messages: (a) => this.controlMessages(a),
            send: (a) => this.controlSend(a),
            view: (a) => this.controlView(a),
            'contact.add': async (a) => {
                await this.addContactFromInput(this.controlRequire(a.user, 'user'));
                return { contacts: this.S.contacts.slice() };
            },
            'server.create': (a) => this.controlCreateServer(a),
            'channel.create': (a) => this.controlCreateChannel(a),
            'voice.join': (a) => this.controlVoiceJoin(a),
            'voice.call': async (a) => {
                await this.startDirectCall(this.controlRequire(a.user, 'user'), { video: !!a.video });
                return this.controlVoiceState();
            },
            'voice.accept': async (a) => { await this.acceptIncomingCall({ video: !!a.video }); return this.controlVoiceState(); },
            'voice.reject': async () => { await this.rejectIncomingCall(); return this.controlVoiceState(); },
            'voice.leave': async () => {
                if (this.voice.status === 'outgoing' || this.voice.outgoingInvite) this.cancelOutgoingVoiceCall();
                else await this.leaveVoiceRoom();
                return this.controlVoiceState();
            },
            'voice.mute': (a) => {
                if (a.on === undefined || !!a.on !== !!this.voice.muted) this.toggleVoiceMute();
                return { muted: !!this.voice.muted, hasStream: !!this.voice.localStream };
            },
            'voice.deafen': (a) => {
                if (a.on === undefined || !!a.on !== !!this.voice.deafened) this.toggleVoiceDeafen();
                return { deafened: !!this.voice.deafened };
            },
            'voice.camera': async (a) => {
                if (a.device) await this.switchVoiceCamera(String(a.device));
                await this.setVoiceCameraEnabled(a.on === undefined ? !this.voice.cameraOn : !!a.on);
                return this.controlVoiceState();
            },
            'voice.state': () => this.controlVoiceState(),
            devices: () => this.controlDevices(),
            'screen.sources': (a) => this.controlScreenSources(a),
            'screen.start': (a) => this.controlScreenStart(a),
            'screen.stop': () => { this.stopScreenShare(); return this.controlVoiceState(); },
            logs: (a) => this.controlLogs(a),
            api: (a) => this.controlApi(a),
            eval: (a) => this.controlEval(a),
            wait: (a) => this.controlWait(a),
        };
    }

    controlRequire(value, name) {
        const v = String(value ?? '').trim();
        if (!v) throw new Error(`missing argument: ${name}`);
        return v;
    }

    /** JSON-безопасная копия: Map/Set → объект/массив, узлы и потоки → описание. */
    controlPlain(value, depth = 0) {
        if (value === null || value === undefined) return value ?? null;
        if (depth > 6) return '[depth]';
        const t = typeof value;
        if (t === 'string' || t === 'number' || t === 'boolean') return value;
        if (t === 'bigint') return String(value);
        if (t === 'function') return '[function]';
        if (typeof Node !== 'undefined' && value instanceof Node) return `[${value.nodeName}]`;
        if (typeof MediaStream !== 'undefined' && value instanceof MediaStream) {
            return { stream: value.id, tracks: value.getTracks().map(tr => ({ kind: tr.kind, label: tr.label, state: tr.readyState, enabled: tr.enabled })) };
        }
        if (value instanceof Map) {
            const out = {};
            for (const [k, v] of value) out[String(k)] = this.controlPlain(v, depth + 1);
            return out;
        }
        if (value instanceof Set) return Array.from(value, v => this.controlPlain(v, depth + 1));
        if (Array.isArray(value)) return value.map(v => this.controlPlain(v, depth + 1));
        if (value instanceof Error) return { error: value.message };
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            if (typeof v === 'function') continue;
            out[k] = this.controlPlain(v, depth + 1);
        }
        return out;
    }

    controlActiveView() {
        for (const id of ['viewSettings', 'viewHub', 'viewZaliCoin', 'viewChat']) {
            if (document.getElementById(id)?.classList.contains('active')) return id.replace(/^view/, '').toLowerCase();
        }
        return '';
    }

    controlState() {
        const net = (() => { try { return this.loadNetworkConfig(); } catch (e) { return {}; } })();
        const mode = this.currentConversationMode();
        return {
            user: this.myName() || null,
            loggedIn: !!this.S.session?.token,
            booting: !!this.sessionBootstrapInProgress,
            platform: window.__ZALI_NATIVE_PLATFORM || 'browser',
            version: window.__ZALI_NATIVE_APP_VERSION || '',
            api: net.apiBaseUrl || '',
            connected: !!this.S.connected,
            view: this.controlActiveView(),
            nav: this.S.navMode,
            conversation: mode === 'servers'
                ? { server: this.currentServer()?.name || this.S.activeServer, serverId: this.S.activeServer, channel: this.currentChannel()?.name || this.S.activeChannel, channelId: this.S.activeChannel }
                : { chat: this.S.current || null },
            hidden: document.hidden,
            nativeCapture: {
                mic: !!this.nativeCaptureAvailable?.('mic'),
                camera: !!this.nativeCaptureAvailable?.('camera'),
                screen: !!this.nativeCaptureAvailable?.('screen'),
            },
            voice: { status: this.voice.status, room: this.voice.roomId || null },
        };
    }

    async controlLogin({ user, password, register = false } = {}) {
        const name = this.controlRequire(user, 'user');
        const pass = this.controlRequire(password, 'password');
        if (this.S.session?.token && this.myName() === name) return this.controlState();
        if (this.S.session?.token) await this.logout();
        const ok = await this.executeAuth(register ? 'register' : 'login', name, pass, { logAttempt: false, silent: true });
        if (!ok) {
            throw new Error(this.S.auth?.error || (register
                ? `не удалось войти как ${name}: логин занят с другим паролем или сервер недоступен`
                : `не удалось войти как ${name}: неверный пароль или сервер недоступен`));
        }
        return this.controlState();
    }

    controlChats() {
        const dms = (this.S.contacts || []).map(peer => {
            const msgs = this.S.chats?.[peer] || [];
            const last = msgs[msgs.length - 1];
            return { chat: peer, unread: this.S.unread?.[peer] || 0, messages: msgs.length, last: last ? this.controlMessage(last) : null };
        });
        const servers = (this.S.servers || []).map(server => ({
            id: server.id,
            name: server.name,
            channels: (server.channels || []).map(ch => ({
                id: ch.id,
                name: ch.name,
                kind: ch.kind || 'text',
                occupants: this.isVoiceChannel(ch) ? (this.voiceChannelOccupants?.(server, ch)?.names || this.voiceChannelOccupants?.(server, ch) || []) : undefined,
            })),
        }));
        return { dms, servers };
    }

    /** Сервер и канал по id или имени (без учёта регистра). */
    controlFindChannel(serverRef, channelRef) {
        const sref = this.controlRequire(serverRef, 'server').toLowerCase();
        const servers = this.S.servers || [];
        const server = servers.find(s => String(s.id).toLowerCase() === sref)
            || servers.find(s => String(s.name || '').toLowerCase() === sref)
            || servers.find(s => String(s.name || '').toLowerCase().includes(sref));
        if (!server) throw new Error(`server not found: ${serverRef}`);
        if (channelRef === undefined || channelRef === null || channelRef === '') return { server, channel: null };
        const cref = String(channelRef).trim().toLowerCase();
        const channels = server.channels || [];
        const channel = channels.find(c => String(c.id).toLowerCase() === cref)
            || channels.find(c => String(c.name || '').toLowerCase() === cref)
            || channels.find(c => String(c.name || '').toLowerCase().includes(cref));
        if (!channel) throw new Error(`channel not found: ${channelRef} in ${server.name}`);
        return { server, channel };
    }

    async controlOpen({ chat, server, channel } = {}) {
        if (chat) {
            this.switchChat(String(chat));
        } else if (server) {
            const found = this.controlFindChannel(server, channel);
            this.setActiveServer(found.server.id);
            if (found.channel) this.setActiveChannel(found.channel.id);
        } else {
            throw new Error('open needs {chat} or {server, channel}');
        }
        return this.controlState().conversation;
    }

    controlMessage(msg) {
        return {
            id: msg.id || null,
            clientId: msg.clientId || null,
            from: msg.sender || '',
            text: msg.text || '',
            ts: msg.ts || msg.timestamp || msg.time || '',
            status: msg.status || '',
            attachments: Array.isArray(msg.attachments) ? msg.attachments.map(att => ({ kind: att.kind || '', name: att.name || att.fileName || '', mime: att.mimeType || att.mime || '' })) : [],
            call: msg.call || undefined,
            edited: msg.edited || undefined,
        };
    }

    async controlMessages({ chat, server, channel, limit = 20 } = {}) {
        if (chat || server) await this.controlOpen({ chat, server, channel });
        const isServers = this.currentConversationMode() === 'servers';
        const list = isServers ? (this.S.serverChats?.[this.currentServerChatKey()] || []) : (this.S.chats?.[this.S.current] || []);
        const n = Math.max(1, Math.min(500, Number(limit) || 20));
        return { conversation: this.controlState().conversation, total: list.length, messages: list.slice(-n).map(m => this.controlMessage(m)) };
    }

    async controlSend({ text, chat, server, channel } = {}) {
        const body = this.controlRequire(text, 'text');
        if (chat || server) await this.controlOpen({ chat, server, channel });
        const clientId = (window.crypto?.randomUUID?.()) || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        // systemText: композер не трогаем (ни набранный черновик, ни вложения, ни цитата),
        // остальной путь отправки тот же, что у Enter.
        await this.sendInputMessage({ systemText: body, clientId });
        const findMsg = () => {
            const isServers = this.currentConversationMode() === 'servers';
            const list = isServers ? (this.S.serverChats?.[this.currentServerChatKey()] || []) : (this.S.chats?.[this.S.current] || []);
            return list.find(m => m.clientId === clientId) || null;
        };
        const deadline = Date.now() + 8000;
        let msg = findMsg();
        while (Date.now() < deadline && (!msg || !['sent', 'delivered', 'read', 'error'].includes(msg.status))) {
            await new Promise(r => setTimeout(r, 150));
            msg = findMsg();
        }
        return msg ? this.controlMessage(msg) : { clientId, status: 'not-found' };
    }

    controlView({ name = 'chat' } = {}) {
        const v = String(name).toLowerCase();
        if (v === 'settings') this.openSettingsView();
        else if (v === 'hub') this.openHubView();
        else if (v === 'coin' || v === 'zalicoin') this.openZaliCoinView();
        else if (v === 'chat') this.openChatView();
        else throw new Error(`unknown view: ${name}`);
        return { view: this.controlActiveView() };
    }

    async controlApiJson(path, { method = 'GET', body } = {}) {
        const res = await this.apiFetch(path, {
            method,
            headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
            body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        });
        const text = await res.text();
        let data = text;
        try { data = JSON.parse(text); } catch (e) {}
        return { status: res.status, ok: res.ok, body: data };
    }

    async controlCreateServer({ name } = {}) {
        const res = await this.controlApiJson(this.apiRoutes.servers.list, { method: 'POST', body: { name: this.controlRequire(name, 'name') } });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
        await this.loadServers({ silent: true });
        return res.body;
    }

    async controlCreateChannel({ server, name, kind = 'text' } = {}) {
        const found = this.controlFindChannel(server);
        const res = await this.controlApiJson(this.apiRoutes.servers.channels(found.server.id), {
            method: 'POST',
            body: { name: this.controlRequire(name, 'name'), kind: kind === 'voice' ? 'voice' : 'text' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
        await this.loadServers({ silent: true });
        return this.controlFindChannel(found.server.id, name).channel;
    }

    async controlVoiceJoin({ server, channel } = {}) {
        const found = this.controlFindChannel(server, this.controlRequire(channel, 'channel'));
        if (!this.isVoiceChannel(found.channel)) throw new Error(`not a voice channel: ${found.channel.name}`);
        this.setActiveServer(found.server.id);
        this.setActiveChannel(found.channel.id);
        await this.joinVoiceChannel({ serverId: found.server.id, channelId: found.channel.id });
        return this.controlVoiceState();
    }

    controlVoiceState() {
        const v = this.voice;
        const peers = {};
        for (const [peer, entry] of v.peerConnections || []) {
            const pc = entry?.pc || entry?.connection || entry;
            peers[peer] = {
                connection: pc?.connectionState || '',
                ice: pc?.iceConnectionState || '',
                signaling: pc?.signalingState || '',
                screen: v.remoteScreens?.has?.(peer) || false,
                video: v.remoteVideos?.has?.(peer) || false,
            };
        }
        const localAudio = v.localStream?.getAudioTracks?.()[0] || null;
        const screenTrack = v.localScreenStream?.getVideoTracks?.()[0] || null;
        return {
            status: v.status,
            room: v.roomId || null,
            type: v.roomType || null,
            serverId: v.serverId || null,
            channelId: v.channelId || null,
            participants: Array.isArray(v.participants) ? v.participants.slice() : [],
            muted: !!v.muted,
            deafened: !!v.deafened,
            camera: !!v.cameraOn,
            mic: localAudio ? { label: localAudio.label, state: localAudio.readyState, native: this.isNativeMediaStream?.(v.localStream) || false } : null,
            micError: v.micError || '',
            screen: v.screenSharing ? { label: screenTrack?.label || '', audio: !!v.screenAudioShared, native: this.isNativeMediaStream?.(v.localScreenStream) || false } : null,
            incoming: v.incomingInvite ? { from: v.incomingInvite.from || v.incomingInvite.inviter || '', room: v.incomingInvite.roomId || '' } : null,
            outgoing: v.outgoingInvite ? { to: v.outgoingInvite.target || v.targetUser || '', room: v.outgoingInvite.roomId || '' } : null,
            peers,
        };
    }

    async controlDevices() {
        if (this.nativeCaptureAvailable?.('mic') || this.nativeCaptureAvailable?.('camera')) {
            return { source: 'native', ...(await this.listNativeMediaDevices()) };
        }
        const list = await navigator.mediaDevices?.enumerateDevices?.() || [];
        const pick = kind => list.filter(d => d.kind === kind).map(d => ({ id: d.deviceId, label: d.label }));
        return { source: 'browser', audioinput: pick('audioinput'), videoinput: pick('videoinput'), audiooutput: pick('audiooutput') };
    }

    async controlScreenSources({ thumbs = false, thumbWidth = 320 } = {}) {
        if (!this.nativeCaptureAvailable?.('screen')) {
            throw new Error('no native screen capture here: the browser shows its own picker, use screen.start {kind}');
        }
        const sources = await this.listNativeScreenSources({ thumbWidth: Number(thumbWidth) || 320 });
        return sources.map((src, index) => ({
            index,
            id: src.id,
            kind: src.kind,
            title: src.title || '',
            app: src.app || '',
            own: !!src.own,
            width: src.width || 0,
            height: src.height || 0,
            ...(thumbs ? { thumb: src.thumb || '' } : {}),
        }));
    }

    async controlScreenStart({ source, kind, height = 1080, fps = 30, audio = true } = {}) {
        if (this.voice.screenSharing) this.stopScreenShare();
        const choice = { height: Number(height) || 0, fps: Number(fps) || 30, audio: audio ? 1 : 0 };
        if (this.nativeCaptureAvailable?.('screen')) {
            const sources = await this.controlScreenSources({});
            const wantKind = kind === 'window' || kind === 'display' ? kind : null;
            const pool = wantKind ? sources.filter(s => s.kind === wantKind) : sources;
            const ref = source === undefined || source === null ? '' : String(source).trim();
            let src = null;
            if (!ref) src = pool[0] || null;
            else if (/^\d+$/.test(ref) && !pool.some(s => s.id === ref)) src = pool[Number(ref)] || null;
            if (!src) src = pool.find(s => s.id === ref) || null;
            if (!src) {
                const needle = ref.toLowerCase();
                src = pool.find(s => `${s.title} ${s.app}`.toLowerCase().includes(needle)) || null;
            }
            if (!src) throw new Error(`screen source not found: ${ref || '(first)'}; see screen.sources`);
            await this.startScreenShare({ ...choice, sourceId: src.id, sourceKind: src.kind, own: src.own });
        } else {
            // Браузер: конкретное окно выбирает системный диалог, сюда приходит только категория.
            await this.startScreenShare({ ...choice, surface: kind === 'window' ? 'window' : 'monitor' });
        }
        if (!this.voice.screenSharing) throw new Error('screen share did not start (see logs {kind: voice})');
        return this.controlVoiceState();
    }

    controlLogs({ n = 60, kind = 'voice' } = {}) {
        const count = Math.max(1, Math.min(2000, Number(n) || 60));
        if (kind === 'journal') return (this._journalRing || []).slice(-count);
        return (this._voiceDiagRing || []).slice(-count).map(line => (typeof line === 'string' ? line : `${line.ts} ${line.level} ${line.message}`));
    }

    async controlApi({ method = 'GET', path, body } = {}) {
        const p = this.controlRequire(path, 'path');
        return this.controlApiJson(p.startsWith('/api/') ? p : `/api/${p.replace(/^\/+/, '')}`, { method: String(method).toUpperCase(), body });
    }

    async controlEval({ code } = {}) {
        const src = this.controlRequire(code, 'code');
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        // Одно выражение — его значение; иначе тело функции с явным return.
        let fn;
        try { fn = new AsyncFunction(`return (${src});`); } catch (e) { fn = new AsyncFunction(src); }
        return fn.call(this);
    }

    async controlWait({ code, timeout = 10000 } = {}) {
        const deadline = Date.now() + Math.max(100, Number(timeout) || 10000);
        let last;
        while (Date.now() < deadline) {
            last = await this.controlEval({ code });
            if (last) return last;
            await new Promise(r => setTimeout(r, 150));
        }
        throw new Error(`timeout waiting for: ${code} (last=${JSON.stringify(this.controlPlain(last))})`);
    }

    // --- Карточка «Управление из терминала» (нативные оболочки) ----------------------
    //
    // Вход включает и выключает сама оболочка по CONTROL_REQUEST {op}: status | enable
    // | disable | rotate. Токен создаёт и хранит оболочка (ключ на запуск не меняется,
    // пока его не сбросят), сверяет на каждом запросе; страница его только показывает.
    // Ответ: data = {enabled, running, port, token, url, error?}.

    controlServerSupported() {
        return this.hasNativeBridge() && this.nativeSupports('controlServer');
    }

    async renderControlSettings() {
        const card = document.getElementById('controlSettingsCard');
        if (!card) return;
        const supported = this.controlServerSupported();
        card.hidden = !supported;
        if (!supported) return;
        this.bindControlSettings();
        this.applyControlStatus();
        await this.controlSettingsRequest('status');
    }

    bindControlSettings() {
        if (this._controlSettingsBound) return;
        this._controlSettingsBound = true;
        document.getElementById('inputControlServer')?.addEventListener('change', (event) => {
            void this.controlSettingsRequest(event.target.checked ? 'enable' : 'disable');
        });
        document.getElementById('btnControlRotate')?.addEventListener('click', () => {
            void this.controlSettingsRequest('rotate');
        });
        document.getElementById('btnControlCopy')?.addEventListener('click', async () => {
            const url = this._controlStatus?.url || '';
            if (!url) return;
            try {
                await navigator.clipboard.writeText(url);
                this._controlNote = 'Скопировано';
            } catch (e) {
                this._controlNote = 'Не удалось скопировать — выделите строку вручную';
            }
            this.applyControlStatus();
        });
    }

    async controlSettingsRequest(op) {
        if (this._controlBusy) return;
        this._controlBusy = true;
        this._controlNote = '';
        this.applyControlStatus();
        try {
            const res = await this.requestNativeAction({ type: NativeMessageTypes.CONTROL_REQUEST, op }, 5000);
            this._controlStatus = res?.data || null;
            this._controlError = res?.data?.error || '';
        } catch (error) {
            this._controlError = error?.message || String(error);
        } finally {
            this._controlBusy = false;
        }
        this.applyControlStatus();
    }

    applyControlStatus() {
        const st = this._controlStatus;
        const input = document.getElementById('inputControlServer');
        if (input) {
            input.checked = !!st?.enabled;
            input.disabled = !!this._controlBusy || !st;
        }
        const pair = document.getElementById('controlSettingsPair');
        const showPair = !!(st?.enabled && st?.url);
        if (pair) pair.hidden = !showPair;
        const code = document.getElementById('controlSettingsUrl');
        if (code && code.textContent !== (st?.url || '')) code.textContent = st?.url || '';
        for (const id of ['btnControlCopy', 'btnControlRotate']) {
            const btn = document.getElementById(id);
            if (btn) btn.disabled = !!this._controlBusy || !showPair;
        }
        const text = document.getElementById('controlSettingsStatus');
        if (!text) return;
        if (this._controlError) {
            text.textContent = `Ошибка: ${this._controlError}`;
        } else if (!st) {
            text.textContent = 'Проверяю…';
        } else if (!st.enabled) {
            text.textContent = 'Выключено: приложение не принимает команды.';
        } else if (!st.running) {
            text.textContent = 'Включено, но вход не запущен — см. журнал приложения.';
        } else {
            const note = this._controlNote ? `${this._controlNote}. ` : '';
            text.textContent = `${note}Работает на 127.0.0.1:${st.port}. Подключение: python3 scripts/zali_ctl.py pair '<строка>'. «Новый токен» сразу отключает все прежние подключения.`;
        }
    }

    // --- Ссылка разработчика -------------------------------------------------------
    //
    // http://127.0.0.1:8090/?as=alice&chat=bob — сразу в нужный экран, без формы
    // входа: аккаунт заводится (или входит) на локальном сервере сам. Параметры:
    //   as=<логин>               войти/зарегистрироваться (пароль ZALI_DEV_PASSWORD)
    //   pw=<пароль>              другой пароль (аккаунт, заведённый не этой ссылкой)
    //   api=<url>                адрес API (по умолчанию http://<хост страницы>:3000)
    //   contact=<a,b>            добавить контакты
    //   chat=<peer>              открыть личный чат
    //   channel=<server>/<channel> открыть канал сервера
    // (не `open` — это имя занято переходом из пуш-уведомления, web_push.js)
    //   view=settings|hub|coin|chat
    //   voice=<server>/<channel> зайти в голосовой канал
    //   run=<JSON [[cmd,args],…]> произвольные команды после всего остального
    // Только для страницы на loopback-адресе и API на loopback/частной сети: на
    // настоящем клиенте (msg.zalikus.org, нативные оболочки) параметры игнорируются.

    devBootParams() {
        try {
            const params = new URLSearchParams(location.search);
            const keys = ['as', 'pw', 'api', 'contact', 'chat', 'channel', 'view', 'voice', 'run'];
            return keys.some(k => params.has(k)) ? params : null;
        } catch (e) {
            return null;
        }
    }

    devBootAllowed() {
        if (window.__ZALI_NATIVE_PLATFORM) return false;
        const host = String(location.hostname || '').toLowerCase();
        return location.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host.endsWith('.localhost'));
    }

    /** До конструктора интерфейса: адрес API должен лежать в хранилище раньше, чем его прочтут. */
    static devBootPrepareNetwork() {
        try {
            const proto = ZaliInterface.prototype;
            if (!proto.devBootAllowed.call(null) || !proto.devBootParams.call(null)) return;
            const params = new URLSearchParams(location.search);
            const api = (params.get('api') || `http://${location.hostname}:3000`).replace(/\/+$/, '');
            const parsed = new URL(api);
            const h = parsed.hostname;
            const privateHost = h === '127.0.0.1' || h === 'localhost' || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h);
            if (!privateHost) return;
            const key = 'zali_network_config_v1';
            const current = JSON.parse(localStorage.getItem(key) || '{}');
            if (current.apiBaseUrl === api) return;
            localStorage.setItem(key, JSON.stringify({
                ...current,
                apiBaseUrl: api,
                wsBaseUrl: `${parsed.protocol === 'https:' ? 'wss' : 'ws'}://${parsed.host}/ws`,
                iceServers: Array.isArray(current.iceServers) ? current.iceServers : [],
            }));
        } catch (e) {}
    }

    async devBootFromUrl() {
        const params = this.devBootParams();
        if (!params || !this.devBootAllowed()) return;
        const steps = [];
        const run = async (cmd, args) => {
            const res = await this.control(cmd, args);
            steps.push({ cmd, ok: res.ok, error: res.error });
            if (!res.ok) console.warn('[ZALI][DEV]', cmd, res.error);
            return res;
        };
        // Сессия с прошлого раза поднимается сама — дождаться её, иначе вход ниже
        // наложится на восстановление.
        for (let i = 0; i < 100 && this.sessionBootstrapInProgress; i += 1) await new Promise(r => setTimeout(r, 100));
        const as = params.get('as');
        if (as) {
            const res = await run('login', { user: as, password: params.get('pw') || ZALI_DEV_PASSWORD, register: true });
            if (!res.ok) { this.devBootResult = steps; return; }
        }
        for (let i = 0; i < 20 && !(this.S.servers || []).length && this.S.session?.token; i += 1) await new Promise(r => setTimeout(r, 100));
        for (const peer of String(params.get('contact') || '').split(',').map(s => s.trim()).filter(Boolean)) {
            if (!(this.S.contacts || []).includes(peer)) await run('contact.add', { user: peer });
        }
        if (params.get('chat')) await run('open', { chat: params.get('chat') });
        if (params.get('channel')) {
            const [server, ...rest] = params.get('channel').split('/');
            await run('open', { server, channel: rest.join('/') });
        }
        const voice = params.get('voice');
        if (voice) { const [server, channel] = voice.split('/'); await run('voice.join', { server, channel }); }
        if (params.get('view')) await run('view', { name: params.get('view') });
        const extra = params.get('run');
        if (extra) {
            try {
                for (const [cmd, args] of JSON.parse(extra)) await run(cmd, args || {});
            } catch (e) {
                steps.push({ cmd: 'run', ok: false, error: e?.message || String(e) });
            }
        }
        this.devBootResult = steps;
        console.log('[ZALI][DEV] boot', JSON.stringify(steps));
    }
});

// Точки входа без знания класса: браузерная вкладка, Playwright, нативные оболочки.
window.__zaliControl = async (cmd, args) => {
    const ui = window.__ZALI_INTERFACE;
    if (!ui) return { ok: false, error: 'interface not ready' };
    return ui.control(cmd, args);
};
// Windows/WRY: evaluate_script не ждёт промисов — результат кладётся сюда по id и
// забирается вторым вызовом (apps/windows/src/native/control.rs).
window.__zaliControlResults = window.__zaliControlResults || {};
window.__zaliControlStart = (id, cmd, args) => {
    const key = String(id);
    window.__zaliControlResults[key] = null;
    window.__zaliControl(cmd, args)
        .then(res => { window.__zaliControlResults[key] = JSON.stringify(res); })
        .catch(error => { window.__zaliControlResults[key] = JSON.stringify({ ok: false, error: String(error?.message || error) }); });
    return true;
};
window.__zaliControlTake = (id) => {
    const key = String(id);
    const value = window.__zaliControlResults[key];
    if (typeof value !== 'string') return null;
    delete window.__zaliControlResults[key];
    return value;
};
ZaliInterface.devBootPrepareNetwork();
