// --- ZaliInterface: Приём состояния от нативного слоя: пользователи, история, статус связи. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    setUsers(users) {
        this.S.users = Array.isArray(users) ? users : [];
        this.S.users.forEach(contact => this.initChat(contact));
        const others = this.S.users.filter(contact => contact !== this.myName());
        if (this.S.navMode !== 'servers' && !this.S.current && this.S.contacts.length > 0) this.switchChat(this.S.contacts[0]);
        this.trace(`setUsers count=${this.S.users.length} others=${others.join(',')}`);
        this.addLogEntry({ type: 'INFO', msg: `Загружен список пользователей: ${others.join(', ')}`, ts: new Date().toLocaleTimeString() });
        this.renderContactSuggestions();
    }

    setContacts(contacts) {
        const me = this.myName();
        const remoteContacts = Array.isArray(contacts) ? contacts.filter(Boolean) : [];
        const localContacts = this.localConversationContacts();
        this.S.contacts = Array.from(new Set([...remoteContacts, ...localContacts]))
            .filter(contact => contact !== me);
        this.saveStoredContacts(this.S.contacts);
        this.S.contacts.forEach(contact => this.initChat(contact));
        this.trace(`setContacts count=${this.S.contacts.length} me=${me} contacts=${this.S.contacts.join(',')}`);
        if (this.S.navMode !== 'servers') {
            const storedCurrent = this.loadStoredCurrentContact();
            const currentValid = !!(this.S.current && this.S.contacts.includes(this.S.current));
            const storedValid = !!(storedCurrent && this.S.contacts.includes(storedCurrent));

            if (storedValid && (!currentValid || this.S.current !== storedCurrent)) {
                this.switchChat(storedCurrent);
            } else if (currentValid) {
                this.scheduleRenderMessages();
                this.renderContacts();
            } else if (this.S.contacts.length > 0) {
                this.switchChat(this.S.contacts[0]);
            } else {
                this.S.current = null;
                this.saveStoredCurrentContact(null);
                const set = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
                set('tbChat', 'Нет контактов');
                // Render the user's own avatar here (same as renderServerToolbar's empty
                // state) rather than hard-coding the fallback letter — otherwise this
                // clobbers the just-loaded avatar image and it flashes then disappears.
                const avaEl = document.getElementById('chatHdrAva');
                if (avaEl) avaEl.innerHTML = this.renderAvatarHTML(this.myName(), 'avatar-img', this.myName());
                set('chatHdrName', 'Добавьте контакт');
            }
            if (this.S.current) {
                this.ensureConversationCryptoKey({ peer: this.S.current, reason: 'setContacts' });
                this.syncActiveConversation({ force: true });
            }
        }
        this.renderContacts();
        this.scheduleRenderMessages();
        this.renderContactSuggestions();
    }

    setSession(session) {
        if (!session || typeof session !== 'object') return;
        this.applySession({
            username: session.username || '',
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
        const sidebarBefore = this.dmSidebarSignature();
        const activeMessagesBefore = this.activeMessagesSignature();
        const currentBefore = this.S.current;
        this.trace(`loadHistory count=${queue.length}`);
        this.addLogEntry({ type: 'INFO', msg: `Загрузка истории чата: ${queue.length} сообщений`, ts: new Date().toLocaleTimeString() });
        const touchedPeers = new Set();
        // Snapshot taken once for the whole call (not re-checked per message): a
        // peer's first-ever loadHistory batch can span many messages across several
        // requestAnimationFrame slices, and re-checking _historyPrimedPeers per
        // message would treat everything after the first message of a brand new
        // peer as "already primed" and notify for the rest of that same initial load.
        const peersPrimedBeforeThisCall = new Set(this._historyPrimedPeers);
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
                const peerAlreadyPrimed = peersPrimedBeforeThisCall.has(peer);
                this._historyPrimedPeers.add(peer);
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
                    myReactions: this.normalizeMyReactions(msg.myReactions),
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
                        myReactions: this.normalizeMyReactions(msg.myReactions?.length ? msg.myReactions : prev.myReactions),
                        text: this.sanitizeDecryptionErrorText(msg.text) || prev.text || '',
                        status: 'sent'
                    };
                } else {
                    arr.push({
                        ...msg,
                        id: msgId || msg.id || '',
                        attachments: normalizedAttachments,
                        reactions: normalizedReactions,
                        myReactions: this.normalizeMyReactions(msg.myReactions),
                        text: this.sanitizeDecryptionErrorText(msg.text),
                        status: 'sent'
                    });
                    // Catch-up sweeps (reconnect, background contact refresh) land here
                    // too, not just the live WS push — this is the root fix for
                    // notifications that used to silently vanish whenever a message
                    // arrived while the socket was down. Skip the peer's very first
                    // sync this session (peerAlreadyPrimed=false) so opening a chat
                    // with existing history doesn't replay it as a notification flood.
                    if (peerAlreadyPrimed && msg.kind !== 'call' && !this.isDmChatVisible(peer)) {
                        this.notifyBackgroundMessage({
                            sender: msg.sender,
                            text: this.sanitizeDecryptionErrorText(msg.text),
                            attachmentCount: normalizedAttachments.length,
                            peer,
                        });
                    }
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
            const sidebarAfter = this.dmSidebarSignature();
            const activeMessagesAfter = this.activeMessagesSignature();
            const currentChanged = currentBefore !== this.S.current;
            const sidebarChanged = sidebarBefore !== sidebarAfter;
            const activeMessagesChanged = activeMessagesBefore !== activeMessagesAfter || currentChanged;
            if (activeMessagesChanged) {
                this.scheduleRenderMessages();
            }
            if (sidebarChanged) {
                this.renderContacts();
            }
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
        this.scheduleRenderMessages();
    }

    setConnectionStatus(connected) {
        const wasOn = !!this.S.wsOn;
        this.S.wsOn = !!connected;
        const pill = document.getElementById('wsPill');
        const lbl  = document.getElementById('wsLabel');
        if (pill) pill.className = 'ws-pill' + (connected ? ' on' : '');
        if (lbl)  lbl.textContent = connected ? 'Подключено' : 'Переподключение...';
        // Body-level flag so the mobile shell can surface a slim reconnect strip
        // (the desktop #wsPill is hidden on mobile). Only marks "not connected"
        // once a first status has arrived, so the strip doesn't flash on boot.
        document.body?.classList.toggle('ws-offline', !connected);
        this.addLogEntry({ type: connected ? 'SUCCESS' : 'WARN', msg: connected ? 'WebSocket соединение установлено' : 'WebSocket соединение разорвано', ts: new Date().toLocaleTimeString() });
        if (connected) {
            // Connection (re)established — drain the outbox immediately instead of
            // waiting out each message's retry backoff (which grows up to 30s). This
            // was the cause of the long send delay after an account switch / blip.
            this.kickPendingOutboxNow('reconnect');
            // Don't wait out the keepalive tick to get back into the voice room: if
            // the blip outlasted the server's 12 s eviction window we are already out
            // of it, and every second here is a second of one-sided silence.
            if (!wasOn) this.sendVoiceRoomPresence();
            // The server only PUSHES messages in real time; anything that arrived
            // while we were offline is never re-sent. So on (re)connect we must pull
            // the active conversation to catch up — otherwise a message sent while the
            // recipient was disconnected is confirmed on the sender but never shows
            // here. Debounced so WS flapping collapses into a single refresh.
            if (!wasOn || !this._reconnectCaughtUp) {
                this._reconnectCaughtUp = true;
                if (this._reconnectRefreshTimer) clearTimeout(this._reconnectRefreshTimer);
                this._reconnectRefreshTimer = setTimeout(() => {
                    this._reconnectRefreshTimer = null;
                    void this.syncActiveConversation({ force: true });
                    // Only the ACTIVE conversation was ever caught up above — a message
                    // sent to any OTHER contact while we were offline had nothing pulling
                    // it in: no WS push (we were offline when it fired) and no history
                    // refresh (only the open chat gets one). It sat on the server
                    // forever, invisible, until the user happened to click that exact
                    // contact — which also explains "contact doesn't appear when someone
                    // writes to you first" for a brand-new sender. Confirmed live
                    // 2026-07-04: a message server-confirmed as delivered to test1 never
                    // reached test3 across a reconnect because test3's client never had
                    // that DM open. Catch up every other known contact too, same as the
                    // active one; loadHistory() is peer-generic (ensureContact + merge
                    // into S.chats[peer]) so this is safe for any contact, not just the
                    // open one.
                    // Throttle the full-sweep catch-ups: each walks every contact and
                    // every channel of every server with sequential history refreshes.
                    // On a flaky link that flaps repeatedly, running the whole sweep on
                    // every reconnect saturates the connection pool ("чат не грузит").
                    // At most once per window is enough to catch up missed history.
                    const catchUpNow = Date.now();
                    if (catchUpNow - (this._lastReconnectCatchUpAt || 0) >= 20000) {
                        this._lastReconnectCatchUpAt = catchUpNow;
                        void this.catchUpBackgroundContactsAfterReconnect();
                        // Same class of bug as the DM catch-up above, for server channels:
                        // deliver_server_message (src/main.rs) only pushes to currently
                        // connected viewers via WS — a channel message posted while this
                        // client was offline, or simply in a channel/server you weren't
                        // looking at, has nothing pulling it in afterwards. Only the
                        // actively open channel got a history refresh; every other channel
                        // in every other server the user belongs to stayed stale until
                        // manually clicked.
                        void this.catchUpBackgroundChannelsAfterReconnect();
                    }
                }, 500);
            }
        } else {
            this._reconnectCaughtUp = false;
        }
    }

    async catchUpBackgroundContactsAfterReconnect() {
        if (!this.S.session?.token) return;
        // this.S.contacts may still be empty here: bootstrapSession's own loadContacts()
        // is an independent async call racing against this reconnect timer, and on a
        // fresh launch/reconnect right after login it hadn't necessarily resolved yet —
        // an empty list made this whole catch-up silently iterate zero peers. Refresh
        // it ourselves first so the contact list is authoritative regardless of timing.
        await this.loadContacts();
        const activePeer = String(this.S.current || '').trim();
        const peers = (this.S.contacts || []).filter(peer => peer && peer !== activePeer);
        for (const peer of peers) {
            try {
                const key = await this.resolveConversationCryptoKey({ peer, reason: 'reconnectCatchUp' });
                // Browser/PWA has no native shell to service REFRESH_HISTORY, so this
                // whole catch-up used to be gated off for it: after a WS drop, chats
                // other than the open one never re-synced, leaving their sidebar preview
                // and unread badge stuck on pre-disconnect state until you clicked in.
                if (this.nativeSupports('sendMessage')) {
                    this.postNativeMessage({ type: NativeMessageTypes.REFRESH_HISTORY, key, peer });
                } else {
                    await this.loadBrowserDmHistory(peer, key);
                }
            } catch (e) {
                this.trace(`catchUpBackgroundContactsAfterReconnect failed peer=${peer} error=${e?.message || e}`);
            }
        }
    }

    async catchUpBackgroundChannelsAfterReconnect() {
        if (!this.S.session?.token) return;
        // Same staleness-on-launch race as loadContacts() above: refresh the server
        // list ourselves rather than trusting whatever bootstrapSession's independent
        // loadServers() call has resolved by now.
        await this.loadServers({ silent: true });
        const activeServer = String(this.S.activeServer || '').trim();
        const activeChannel = String(this.S.activeChannel || '').trim();
        for (const server of this.S.servers || []) {
            const sid = String(server?.id || '').trim();
            if (!sid) continue;
            for (const channel of server.channels || []) {
                const cid = String(channel?.id || '').trim();
                if (!cid || this.isVoiceChannel(channel)) continue;
                if (sid === activeServer && cid === activeChannel) continue;
                try {
                    await this.loadServerMessages(sid, cid, { silent: true });
                } catch (e) {
                    this.trace(`catchUpBackgroundChannelsAfterReconnect failed server=${sid} channel=${cid} error=${e?.message || e}`);
                }
            }
        }
    }

    kickPendingOutboxNow(reason = 'manual') {
        const pending = this.loadPendingOutbox();
        if (!pending.length) return;
        const now = Date.now();
        let changed = false;
        for (const item of pending) {
            if (!item || typeof item !== 'object') continue;
            // Any in-flight request was tied to the old connection and is now dead;
            // clear it and the backoff so the item is sent right away. The server
            // deduplicates by client_id, so an accidental resend is harmless.
            if (item.inFlight || Number(item.nextRetryAt || 0) > now) {
                item.inFlight = false;
                item.nextRetryAt = 0;
                changed = true;
            }
        }
        if (changed) this.savePendingOutbox(pending);
        this.trace(`kickPendingOutboxNow reason=${reason} count=${pending.length}`);
        this.scheduleFlushPendingOutbox(50);
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
        this.addLogEntry({ type: 'SUCCESS', msg: 'Сообщение подтверждено сервером', ts: new Date().toLocaleTimeString() });
    }

    onSendError(payload) {
        const clientId = String(payload?.clientId || payload || '').trim();
        const statusCode = Number(payload?.statusCode || 0);
        const responseBody = String(payload?.responseBody || '').trim();
        const permanentError = statusCode >= 400 && statusCode < 500;
        this.trace(`onSendError clientId=${clientId} status=${statusCode || 'n/a'} body=${responseBody.slice(0, 120)}`);
        if (clientId) {
            if (permanentError) {
                this.markMessageStatus(clientId, 'error');
                this.dropPendingOutbox(clientId);
            } else {
                this.markMessageStatus(clientId, 'sending');
                this.updatePendingOutboxItem(clientId, {
                    inFlight: false,
                    nextRetryAt: Date.now() + 2000,
                });
                this.scheduleFlushPendingOutbox(2000);
            }
        } else if (!permanentError) {
            this.scheduleFlushPendingOutbox(2000);
        }
        const networkError = !statusCode || statusCode <= 0;
        this.addLogEntry({
            type: permanentError ? 'ERROR' : 'WARN',
            msg: permanentError
                ? 'Сообщение отклонено сервером без ретрая'
                : (networkError
                    ? 'Сбой сети при отправке, повтор автоматически'
                    : 'Сервер временно недоступен, повтор отправки'),
            ts: new Date().toLocaleTimeString()
        });
    }

    onReactionUpdated(payload) {
        if (!payload || typeof payload !== 'object') return;
        const messageId = String(payload.messageId || payload.message_id || '').trim();
        if (!messageId) return;

        const normalizedReactions = this.normalizeReactions(payload.reactions);
        const normalizedMyReactions = this.normalizeMyReactions(payload.myReactions || payload.my_reactions);
        let updated = false;

        const applyToList = (list) => {
            if (!Array.isArray(list)) return;
            for (const msg of list) {
                if (!msg || typeof msg !== 'object') continue;
                const sameId = String(msg.id || '').trim() === messageId;
                const sameClientId = String(msg.clientId || '').trim() === messageId;
                if (!sameId && !sameClientId) continue;
                msg.reactions = normalizedReactions;
                msg.myReactions = normalizedMyReactions;
                updated = true;
            }
        };

        for (const msgs of Object.values(this.S.chats || {})) {
            applyToList(msgs);
        }
        for (const msgs of Object.values(this.S.serverChats || {})) {
            applyToList(msgs);
        }

        if (updated) {
            this.scheduleSaveStoredMessageCache();
            const currentServerKey = this.currentServerChatKey();
            const currentPeer = String(this.S.current || '').trim();
            const payloadServerKey = String(payload.serverId || payload.server_id || '').trim() && String(payload.channelId || payload.channel_id || '').trim()
                ? `${String(payload.serverId || payload.server_id).trim()}:${String(payload.channelId || payload.channel_id).trim()}`
                : '';
            const shouldRender = payloadServerKey
                ? payloadServerKey === currentServerKey
                : currentPeer && (
                    currentPeer === String(payload.sender || '').trim() ||
                    currentPeer === String(payload.receiver || '').trim()
                );
            if (shouldRender) {
                this.scheduleRenderMessages();
            }
            return;
        }

        const serverId = String(payload.serverId || payload.server_id || '').trim();
        const channelId = String(payload.channelId || payload.channel_id || '').trim();
        const peer = String(payload.sender || payload.receiver || '').trim();
        if (serverId && channelId) {
            this.scheduleConversationRefresh({
                serverId,
                channelId,
                reason: 'reaction-miss',
                delayMs: 150,
            });
        } else if (peer) {
            this.scheduleConversationRefresh({
                peer,
                reason: 'reaction-miss',
                delayMs: 150,
            });
        }
    }

    // Whether the current user is allowed to delete `msg` — mirrors the
    // server's can_delete_message (server/src/messages.rs): always the
    // author, plus anyone with manage rights on the server a channel message
    // belongs to. The server is the actual authority (this only gates
    // whether the UI offers the button); a wrong "yes" here just means the
    // request 403s.
    canDeleteMessage(msg) {
        if (!msg) return false;
        if (String(msg.sender || '').trim() === this.myName()) return true;
        const serverId = String(msg.serverId || msg.server_id || '').trim();
        if (!serverId) return false;
        const server = (this.S.servers || []).find(s => s.id === serverId) || this.currentServer();
        return this.canManageServer(server);
    }

    // Removes a message from whichever bucket (DM or server chat) holds it and
    // re-renders only if that conversation is the one currently on screen.
    // Shared by the local "I just deleted this" path (deleteMessage) and the
    // message_deleted broadcast arriving for the peer/another device.
    removeMessageFromState(messageId) {
        const id = String(messageId || '').trim();
        if (!id) return false;
        const found = this.findMessageById(id);
        if (!found) return false;
        const list = found.serverKey ? this.S.serverChats[found.serverKey] : this.S.chats[found.peer];
        if (!Array.isArray(list)) return false;
        list.splice(found.index, 1);
        this.scheduleSaveStoredMessageCache();
        this.hideReactionMenu();
        const shouldRender = found.serverKey
            ? found.serverKey === this.currentServerChatKey()
            : found.peer === this.S.current;
        if (shouldRender) {
            this.scheduleRenderMessages();
        }
        return true;
    }

    onMessageDeleted(payload) {
        if (!payload || typeof payload !== 'object') return;
        const messageId = String(payload.messageId || payload.message_id || '').trim();
        if (!messageId) return;
        this.removeMessageFromState(messageId);
    }
});
