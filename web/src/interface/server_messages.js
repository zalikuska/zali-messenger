// --- ZaliInterface: Загрузка сообщений серверов/каналов, синхронизация активного разговора. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

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

        // Which identities were already known BEFORE this merge, so an incoming
        // message under a brand new identity can be told apart from a status/metadata
        // update to something we already had. Filled during the `existing` pass below
        // rather than by a separate map(): makeIdentity spreads the message object and
        // normalises its attachments, so precomputing the set ran that over the whole
        // channel history a second time — on every single incoming WS message.
        const existingIdentities = new Set();
        const newlyInserted = [];

        const upsert = (msg, { fromIncoming = false } = {}) => {
            const { normalized, identity } = makeIdentity(msg);
            const prev = mergedByKey.get(identity);
            const next = prev
                ? {
                    ...prev,
                    ...normalized,
                    attachments: this.normalizeAttachments(normalized.attachments ?? prev.attachments),
                    reactions: this.normalizeReactions(normalized.reactions ?? prev.reactions),
                    myReactions: this.normalizeMyReactions(normalized.myReactions ?? prev.myReactions),
                }
                : {
                    ...normalized,
                    attachments: this.normalizeAttachments(normalized.attachments),
                    reactions: this.normalizeReactions(normalized.reactions),
                    myReactions: this.normalizeMyReactions(normalized.myReactions),
                };
            mergedByKey.set(identity, next);
            if (!prev) merged.push(identity);
            if (fromIncoming) {
                if (!existingIdentities.has(identity)) newlyInserted.push(next);
            } else {
                // The `existing` pass runs to completion before any incoming message
                // is upserted, so the set is fully populated by the time it is read.
                existingIdentities.add(identity);
            }
        };

        existing.forEach(msg => upsert(msg));
        (Array.isArray(incomingMessages) ? incomingMessages : []).forEach(msg => upsert(msg, { fromIncoming: true }));

        const next = merged
            .map(identity => mergedByKey.get(identity))
            .sort((a, b) => this.compareMessagesByTime(a, b));
        this.S.serverChats[key] = next;
        this.saveStoredServerChats();

        // First time this channel is ever merged in this session (initial history
        // load / first open), just prime the baseline silently — otherwise opening a
        // channel with months of history would replay it all as notifications. Only
        // merges AFTER that baseline (reconnect catch-up, background refreshes)
        // notify for genuinely new messages, same rule as loadHistory() for DMs.
        const alreadyPrimed = this._historyPrimedChannels.has(key);
        if (!alreadyPrimed) {
            this._historyPrimedChannels.add(key);
        } else if (newlyInserted.length && !this.isServerChatVisible(key)) {
            newlyInserted.forEach(msg => {
                this.notifyBackgroundMessage({
                    sender: msg.sender,
                    text: msg.text,
                    attachmentCount: this.normalizeAttachments(msg.attachments).length,
                    serverId: msg.serverId,
                    channelId: msg.channelId,
                });
            });
            this.renderServerInterface();
            this.renderContacts();
        }
        return next;
    }

    ensureServerSelection() {
        this.ensureServersState();
        const servers = Array.isArray(this.S.servers) ? this.S.servers : [];
        if (servers.length === 0) {
            this.S.activeServer = null;
            this.S.activeChannel = null;
            this.S.activeConversationType = 'dm';
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
                this.S.servers = [];
                this.ensureServerSelection();
                this.renderContacts();
                this.renderServerInterface();
                this.scheduleRenderMessages();
                return;
            }
            const res = await this.apiFetch(this.apiRoutes.servers.list);
            if (!res.ok) {
                this.S.servers = [];
                this.ensureServerSelection();
                this.renderContacts();
                this.renderServerInterface();
                this.scheduleRenderMessages();
                return;
            }
            const data = await res.json();
            this.S.servers = this.normalizeServers(Array.isArray(data?.servers) ? data.servers : []);
            this.ensureServerSelection();
            this.renderContacts();
            this.renderServerInterface();
            this.scheduleRenderMessages();
            if (this.S.activeServer && this.S.activeChannel) {
                this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
            }
        } catch (e) {
            if (!silent) {
                this.addLogEntry({ type: 'WARN', msg: 'Не удалось загрузить серверы', ts: new Date().toLocaleTimeString() });
            }
            this.S.servers = [];
            this.ensureServerSelection();
            this.renderContacts();
            this.renderServerInterface();
            this.scheduleRenderMessages();
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
            this.scheduleRenderMessages();
            return;
        }
        const key = `${sid}:${cid}`;
        if (!Array.isArray(this.S.serverChats[key])) {
            this.S.serverChats[key] = [];
        }
        const channel = (this.currentServer()?.channels || []).find(item => item.id === cid) || null;
        if (this.isVoiceChannel(channel)) {
            this.scheduleRenderMessages();
            return;
        }
        this.scheduleRenderMessages();

        if (this.nativeSupports('serverHistory')) {
            const conversationKey = this.ensureConversationCryptoKey({
                serverId: sid,
                channelId: cid,
                reason: 'loadServerMessages',
            });
            this.postNativeMessage({
                type: NativeMessageTypes.LOAD_SERVER_HISTORY,
                serverId: sid,
                channelId: cid,
                key: conversationKey,
            });
            return;
        }

        // No native shell to decrypt channel history for us — each row here is just
        // server-known metadata (id/sender/receiver/filename/timestamp), same as a DM
        // history row. Route it through the same WASM download+unpack path used for
        // live-received messages instead of showing "encrypted, needs native bridge".
        if (!(await this.wasmAvailable())) {
            if (!silent) {
                this.addLogEntry({ type: 'WARN', msg: 'WASM недоступен: сообщения канала не будут расшифрованы', ts: new Date().toLocaleTimeString() });
            }
            return;
        }
        try {
            const limit = 200;
            let offset = 0;
            let mergedCount = 0;
            while (true) {
                const res = await this.apiFetch(this.apiRoutes.servers.channelMessages(sid, cid, limit, offset));
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
                for (const msg of batch) {
                    await this.handleIncomingBrowserMessage(msg);
                }
                mergedCount += batch.length;
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
                        myReactions: this.normalizeMyReactions(msg.myReactions?.length ? msg.myReactions : prev.myReactions),
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
                        myReactions: this.normalizeMyReactions(msg.myReactions),
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
                this.scheduleRenderMessages();
            }
            this.scheduleFlushPendingOutbox(300);
            this.trace(`loadServerHistory done server=${serverId} channel=${channelId} merged=${reconciled.length}`);
        };
        processBatch(0);
    }

    async refreshAfterKey() {
        if (this._refreshAfterKeyInFlight) {
            this._refreshAfterKeyQueued = true;
            return;
        }
        this._refreshAfterKeyInFlight = true;
        try {
            await this._refreshAfterKeyImpl();
        } finally {
            this._refreshAfterKeyInFlight = false;
            if (this._refreshAfterKeyQueued) {
                this._refreshAfterKeyQueued = false;
                void this.refreshAfterKey();
            }
        }
    }

    async _refreshAfterKeyImpl() {
        if (!this.S.session?.token) {
            this.scheduleFlushPendingOutbox(300);
            return;
        }
        // Pull newly published key envelopes (e.g. after a key_envelope_available
        // WS notification) so a stale self-generated key can be replaced before we
        // resolve and re-decrypt the active conversation. triggerRefresh=false
        // avoids re-entering this method.
        await this.syncIncomingKeyEnvelopes({ reason: 'refreshAfterKey', triggerRefresh: false });
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
                this.postNativeMessage({ type: NativeMessageTypes.REFRESH_HISTORY, key, peer: this.S.current });
            } else {
                void this.loadBrowserDmHistory(this.S.current, key);
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
            this.postNativeMessage({ type: NativeMessageTypes.REFRESH_HISTORY, key, peer });
        } else {
            void this.loadBrowserDmHistory(peer, key);
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
                this.postNativeMessage({ type: NativeMessageTypes.REFRESH_HISTORY, key, peer });
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
                    this.postNativeMessage({ type: NativeMessageTypes.REFRESH_HISTORY, key: keyValue, peer: dmPeer });
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
        const chatVideoCallBtn = document.getElementById('chatVideoCallBtn');
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
        if (chatVideoCallBtn) {
            chatVideoCallBtn.hidden = isServers || !this.S.current;
        }
        if (serverSettingsBtn) {
            serverSettingsBtn.hidden = !isServers || !server || !canManage;
            serverSettingsBtn.disabled = !canManage;
        }
        if (!isServers) {
            if (channelList) channelList.innerHTML = '';
            if (chatHdrAva) {
                chatHdrAva.style.background = '';
                const who = this.S.current || this.myName();
                this.setHTMLIfChanged(chatHdrAva, this.renderAvatarHTML(who, 'avatar-img', who));
            }
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

        if (chatHdrAva) {
            chatHdrAva.style.background = this.serverAvatarBackground(server);
            this.setHTMLIfChanged(chatHdrAva, this.serverAvatarInnerHTML(server));
        }
        if (chatHdrName) {
            const membersText = Number(server.memberCount || 0) > 0 ? `${Number(server.memberCount)} ${this.ruPlural(server.memberCount, 'участник', 'участника', 'участников')}` : '';
            const channelTitle = channel
                ? `${this.channelKindIcon(channel.kind, 'chat-hdr-channel-icon')}<span>${this.esc(channel.name)}</span>`
                : this.esc(server.name);
            this.setHTMLIfChanged(chatHdrName, `
                <span class="chat-hdr-title">${channelTitle}</span>
                ${membersText ? `<span class="chat-hdr-count">${this.esc(membersText)}</span>` : ''}
            `);
        }
        if (chatHdrSub) {
            chatHdrSub.textContent = channel
                ? `${server.name}${channel.topic ? ` · ${channel.topic}` : ''}`
                : (server.description || 'Сервер');
        }
        if (tbChat) {
            tbChat.textContent = channel
                ? `${server.name} / ${this.channelKindLabel(channel.kind)}: ${channel.name}`
                : server.name;
        }

        if (channelList) {
            const channels = Array.isArray(server.channels) ? server.channels : [];
            const channelsHTML = channels.map(ch => {
            const active = ch.id === this.S.activeChannel ? 'active' : '';
            const kind = String(ch.kind || 'text').trim().toLowerCase();
            const title = kind === 'voice' ? 'Голосовой канал' : 'Текстовый канал';
            const chKey = `${server.id}:${ch.id}`;
            const cnt = kind === 'voice' ? 0 : Number(this.S.channelUnread?.[chKey] || 0);
            const badge = cnt > 0 ? `<span class="badge">${cnt > 99 ? '99+' : cnt}</span>` : '';
            const muted = kind !== 'voice' && this.isChannelMuted(server.id, ch.id);
            const muteToggle = muted ? `<span class="channel-mute-indicator" title="Уведомления отключены" aria-label="Уведомления отключены">${this.uiIcon('bell-off')}</span>` : '';
            return `<div class="server-channel ${active}" data-server-id="${this.esc(server.id)}" data-channel-id="${this.esc(ch.id)}" data-channel-kind="${this.esc(kind)}" title="${this.esc(title)}">
                    <span class="server-channel-hash ${kind}">${this.channelKindIcon(kind, 'server-channel-list-icon')}</span>
                    <span class="server-channel-name">${this.esc(ch.name)}</span>
                    ${muteToggle}
                    ${badge}
                </div>`;
        }).join('');

            this.commitListHTML(channelList, `channels:${server.id}`, channelsHTML);

            // renderServerToolbar() runs on every avatar that finishes loading, every
            // nav refresh and every toolbar sync. Firing a *smooth* scrollIntoView on
            // each of those made the channel rail (and, since scrollIntoView walks
            // every scrollable ancestor, whatever else was scrollable around it) drift
            // on its own — the unexplained jumps while just reading a channel. Only
            // scroll when the selected channel actually changed.
            const activeChannelKey = `${server.id}:${String(this.S.activeChannel || '')}`;
            if (this._lastScrolledChannelKey !== activeChannelKey) {
                this._lastScrolledChannelKey = activeChannelKey;
                const activeChannel = channelList.querySelector('.server-channel.active');
                if (activeChannel && typeof activeChannel.scrollIntoView === 'function') {
                    requestAnimationFrame(() => {
                        activeChannel.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
                    });
                }
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
        this.collapseActiveCallView();
        if (this.voice.roomType === 'channel' && this.voice.roomId) {
            const currentChannelId = String(this.voice.channelId || '').trim();
            if (currentChannelId && currentChannelId !== next) {
                this.leaveVoiceRoom({ announce: true });
            }
        }
        this.cancelComposerContext();
        this.S.activeChannel = next;
        // Selecting the channel makes it visible again — clear whatever unread
        // counter it accrued while it wasn't the active one, mirroring switchChat's
        // S.unread[peer] = 0 for DMs.
        this.S.channelUnread = this.S.channelUnread || {};
        this.S.channelUnread[`${server.id}:${next}`] = 0;
        this.syncTaskbarBadge();
        if (persist) this.saveStoredActiveChannel(next);
        this.saveStoredNavMode('servers');
        this.renderServerToolbar();
        this.requestMessagesScroll('bottom');
        this.scheduleRenderMessages();
        this.updateSendButtonState();
        if (this.isVoiceChannel(channel)) {
            // Selecting a voice channel only opens its panel (with a "Присоединиться"
            // button) — it must NOT auto-connect the call. Auto-joining on click also
            // left the panel stuck rendering the connected-call state after switching
            // to any other channel, since nothing ever re-rendered it away from there.
            this.renderVoicePanel();
            return;
        }
        this.requestMessagesScroll('bottom');
        this.loadServerMessages(server.id, next, { silent: true });
        this.closeMobileSidebar();
        this.syncMobileChrome();
        this.renderVoicePanel();
    }

    setNavMode(mode, { persist = true, refresh = true } = {}) {
        const next = mode === 'servers' ? 'servers' : 'dm';
        this.S.activeConversationType = next;
        if (next === 'servers') {
            this.ensureServersState();
            this.ensureServerSelection();
        } else {
            this.clearActiveServerSelection({ persist });
        }
        if (this.S.navMode === next) {
            this.updateNavModeButtons();
            if (next === 'dm') {
                this.renderServerInterface();
                this.updateSendButtonState();
            }
            return;
        }
        this.S.navMode = next;
        if (persist) {
            this.saveStoredNavMode(next);
        }
        // Returning to the DM view makes the selected chat visible again — clear the
        // unread counter it may have accrued while the servers view was covering it.
        if (next === 'dm' && this.S.current) {
            this.S.unread[this.S.current] = 0;
        }
        // Mirror for the servers view: the already-selected channel becomes visible
        // again, so clear whatever it accrued while the DM view was covering it.
        if (next === 'servers' && this.S.activeServer && this.S.activeChannel) {
            this.S.channelUnread = this.S.channelUnread || {};
            this.S.channelUnread[`${this.S.activeServer}:${this.S.activeChannel}`] = 0;
        }
        this.syncTaskbarBadge();
        this.updateNavModeButtons();
        if (!refresh) return;
        this.resetMessageWindow();
        this.renderServerInterface();
        this.renderContacts();
        this.requestMessagesScroll('bottom');
        this.scheduleRenderMessages();
        this.renderVoicePanel();
        if (next === 'servers' && this.S.activeServer && this.S.activeChannel) {
            this.requestMessagesScroll('bottom');
            this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
        }
        this.syncMobileChrome();
    }
});
