// --- ZaliInterface: Отправка сообщений и приём в браузерном режиме. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    async sendInputMessage() {
        // Editing takes over the composer, so the send control saves instead of
        // sending a new message.
        if (this.S.editDraft) {
            await this.submitMessageEdit();
            return;
        }
        const inp = document.getElementById('msgInput');
        const textValue = (inp && inp.value) || '';
        const text = textValue.trim();
        const attachments = this.normalizeAttachments(this.S.draftAttachments);
        if (!text && attachments.length === 0) return;

        // Snapshotted before the first await: the user can dismiss the reply bar
        // (or start another reply) while the key resolution below is in flight.
        const replyQuote = this.S.replyDraft;
        const replyPayload = replyQuote ? JSON.stringify(replyQuote) : '';

        const clientId = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
        const payloadAttachments = attachments.map(att => ({ ...att }));
        const ts = new Date().toISOString();
        const activeMode = this.currentConversationMode();
        const isServers = activeMode === 'servers';
        const server = isServers ? this.currentServer() : null;
        const channel = isServers ? this.currentChannel() : null;
        const conversationKey = isServers ? this.currentServerChatKey() : this.S.current;
        if (isServers && (!server || !channel)) return;
        if (isServers && this.isVoiceChannel(channel)) return;
        if (!isServers && !this.S.current) return;
        this.trace(`sendInputMessage context mode=${activeMode} navMode=${this.S.navMode} activeType=${String(this.S.activeConversationType || 'nil')} current=${String(this.S.current || 'nil')} activeServer=${String(this.S.activeServer || 'nil')} activeChannel=${String(this.S.activeChannel || 'nil')} rendered=${String(this.lastRenderedConversationKey || 'nil')} serverKey=${String(this.currentServerChatKey() || 'nil')}`);
        // Fast path, and the whole point of it: when this device already holds the
        // conversation key — the overwhelmingly common case — nothing between
        // pressing Enter and the message appearing is allowed to await. The old
        // code awaited resolveConversationCryptoKey() unconditionally, and since
        // the composer is only cleared after that point, the typed text sat in the
        // input box for a network round trip and Enter read as not having worked.
        //
        // resolveConversationCryptoKey() returns this exact value on its own fast
        // path; it is still called, unawaited, for the side effects that path has
        // (key display, background reconciliation with the server registry).
        const sendScope = this.conversationScopeKey(
            isServers ? null : this.S.current,
            isServers ? server.id : null,
            isServers ? channel.id : null,
        );
        const storedConversationKey = sendScope ? this.getStoredConversationKey(sendScope) : '';
        const cryptoKey = storedConversationKey || await this.resolveConversationCryptoKey({
            peer: isServers ? null : this.S.current,
            serverId: isServers ? server.id : null,
            channelId: isServers ? channel.id : null,
            reason: 'sendInputMessage'
        });
        if (storedConversationKey) {
            void this.resolveConversationCryptoKey({
                peer: isServers ? null : this.S.current,
                serverId: isServers ? server.id : null,
                channelId: isServers ? channel.id : null,
                reason: 'sendInputMessage:background'
            });
        }
        const keyVersion = 2;
        this.trace(`sendInputMessage start clientId=${clientId} mode=${activeMode} sender=${this.myName()} receiver=${isServers ? channel.id : this.S.current} server=${isServers ? server.id : 'dm'} channel=${isServers ? channel.id : 'dm'} attachments=${payloadAttachments.length} textBytes=${text.length} keySet=${!!cryptoKey} tokenSet=${!!this.S.session?.token}`);

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
            // Same JSON string the archive carries, so the optimistic bubble and
            // the one rebuilt from history render identically.
            reply: replyPayload,
        };

        if (!this.S.session?.token) {
            this.trace(`sendInputMessage missingToken clientId=${clientId}`);
            this.addLogEntry({ type: 'ERROR', msg: 'Для отправки сообщения нужно войти в аккаунт', ts: new Date().toLocaleTimeString() });
            return;
        }

        // Recover the E2E key from the cloud vault BEFORE giving up. A fresh device
        // (or one whose in-memory key was cleared) can still have a recoverable vault
        // snapshot. This used to live after an early `if (!cryptoKey) return`, which
        // made it dead code — sends failed with "нужен E2E-ключ" even when recovery
        // would have succeeded.
        if (!cryptoKey) {
            const recoveredVaultPassphrase = await this.loadVaultUnlockSecret(this.S.session?.token);
            if (recoveredVaultPassphrase) {
                this.S.auth.vaultPassphrase = recoveredVaultPassphrase;
                await this.restoreCloudVaultSnapshot({ reason: 'sendInputMessage' });
                await this.syncCloudVaultPackage({ passphrase: recoveredVaultPassphrase, reason: 'sendInputMessage' });
            }
        }
        const effectiveCryptoKey = cryptoKey || this.loadStoredCryptoKey();
        if (!effectiveCryptoKey) {
            this.trace(`sendInputMessage missingKey clientId=${clientId}`);
            this.addLogEntry({ type: 'ERROR', msg: 'Для отправки сообщения нужен E2E-ключ', ts: new Date().toLocaleTimeString() });
            return;
        }

        if (!isServers && String(this.S.current || '').trim() !== this.myName()) {
            const scope = this.conversationScopeKey(this.S.current);
            if (!this._publishedKeyScopes) this._publishedKeyScopes = new Set();
            if (!this._publishedKeyScopes.has(scope)) {
                this._publishedKeyScopes.add(scope);
                void this.publishConversationKeyToPeer({
                    peer: this.S.current,
                    scope,
                    key: effectiveCryptoKey,
                    reason: 'sendInputMessage',
                }).then(published => {
                    if (published !== true) {
                        // false = transport/server failure, 'no_devices' = peer has no
                        // registered devices yet. Either way the envelope was not
                        // delivered, so allow a retry on the next send.
                        this._publishedKeyScopes.delete(scope);
                        this.trace(`sendInputMessage keyPublishPending peer=${this.S.current} scope=${scope} result=${published}`);
                        if (published === false) {
                            this.addLogEntry({ type: 'WARN', msg: 'E2E-ключ не доставлен собеседнику, повтор при следующей отправке', ts: new Date().toLocaleTimeString() });
                        }
                    }
                });
            }
        }

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
            this.scheduleSaveStoredMessageCache();
            this.scheduleRenderMessages();
            this.renderContacts();
            this.renderServerInterface();
            if (inp) {
                inp.value = '';
                this.resizeComposer();
            }
            this.clearDraftAttachments();
            this.clearComposerReply(replyQuote);
            this.updateSendButtonState();
            inp && inp.focus();

            // No native shell (macOS/Windows) around this WebView — we're running as a
            // plain browser tab. Pack the .zali archive ourselves via the WASM build of
            // core/ (see web/src/modules/wasm_bridge.js) and upload it straight to the
            // server over fetch, instead of just stranding the message locally.
            const sent = await this.browserSendMessage({
                text,
                key: effectiveCryptoKey,
                keyVersion,
                sender: this.myName(),
                receiver: isServers ? channel.id : this.S.current,
                serverId: isServers ? server.id : '',
                channelId: isServers ? channel.id : '',
                clientId,
                attachments: payloadAttachments,
                reply: replyPayload,
            }).catch(error => {
                this.trace(`sendInputMessage browserSendMessage error clientId=${clientId} error=${error?.message || error}`);
                return false;
            });
            if (sent) {
                this.trace(`sendInputMessage browserSendMessage ok clientId=${clientId}`);
                this.addLogEntry({ type: 'SUCCESS', msg: 'Отправлено из браузера (WASM)', ts: new Date().toLocaleTimeString() });
            } else {
                // Queue it for retry instead of stranding it. This branch used to just
                // log and return, so a browser send that failed (offline, server hiccup)
                // was never attempted again — the bubble stayed on "sending" forever and
                // the message was silently lost on the next reload. flushPendingOutbox()
                // now handles browser sends too, so the same backoff/attempt-cap applies.
                this.cachePendingOutboxAttachments(clientId, payloadAttachments);
                this.enqueuePendingOutbox({
                    ...outgoingMessage,
                    key: effectiveCryptoKey,
                    keyVersion,
                    attemptCount: 1,
                    lastAttemptAt: Date.now(),
                    nextRetryAt: Date.now() + 2000,
                    inFlight: false,
                });
                this.scheduleFlushPendingOutbox(2000);
                this.addLogEntry({ type: 'WARN', msg: 'Не удалось отправить сообщение из браузера, оставлено в очереди повтора', ts: new Date().toLocaleTimeString() });
            }
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
        this.scheduleSaveStoredMessageCache();

        this.scheduleRenderMessages();
        this.renderContacts();
        this.renderServerInterface();

        if (inp) {
            inp.value = '';
            this.resizeComposer();
        }

        this.clearDraftAttachments();
        this.clearComposerReply(replyQuote);
        this.updateSendButtonState();
        inp && inp.focus();

        this.cachePendingOutboxAttachments(clientId, payloadAttachments);
        this.enqueuePendingOutbox({
            ...outgoingMessage,
            key: effectiveCryptoKey,
            keyVersion,
            attemptCount: 1,
            lastAttemptAt: Date.now(),
            nextRetryAt: Date.now() + 20000,
            inFlight: true,
        });
        this.scheduleSendWatchdog(outgoingMessage, effectiveCryptoKey);
        this.trace(`sendInputMessage queued clientId=${clientId}`);

        const sentToNative = this.postNativeMessage({
            type: NativeMessageTypes.SEND_MESSAGE,
            text: text,
            reply: replyPayload,
            recipient: isServers ? channel.id : this.S.current,
            serverId: isServers ? server.id : '',
            channelId: isServers ? channel.id : '',
            sender: this.myName(),
            key: effectiveCryptoKey,
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
        if (!sentToNative) {
            this.trace(`sendInputMessage native bridge rejected clientId=${clientId}`);
            this.updatePendingOutboxItem(clientId, {
                inFlight: false,
                nextRetryAt: Date.now() + 1000,
            });
            this.addLogEntry({ type: 'WARN', msg: 'Native bridge не принял сообщение, оставлено в очереди повтора', ts: new Date().toLocaleTimeString() });
            this.scheduleFlushPendingOutbox(1000);
        }
    }

    // --- Browser-only (no native shell) send/receive path, backed by the WASM build
    // of core/ (web/src/modules/wasm_bridge.js packs/unpacks the .zali archive format
    // entirely in-browser — same wire format as the native macOS/Windows clients use).

    async wasmAvailable() {
        return !!(window.ZaliWasm && await window.ZaliWasm.isAvailable());
    }

    async dataUrlToBytes(dataUrl) {
        const res = await fetch(dataUrl);
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf);
    }

    async browserSendMessage({ text, key, keyVersion, sender, receiver, serverId, channelId, clientId, attachments, reply }) {
        if (!key || !receiver) return false;
        if (!(await this.wasmAvailable())) return false;

        const wasmAttachments = [];
        for (const att of (attachments || [])) {
            if (!att?.dataUrl) continue;
            try {
                const bytes = await this.dataUrlToBytes(att.dataUrl);
                wasmAttachments.push({
                    name: att.name || 'attachment',
                    archivePath: `attachments/${att.name || 'attachment'}`,
                    mimeType: att.mimeType || 'application/octet-stream',
                    kind: att.kind || 'file',
                    bytes,
                });
            } catch (e) {
                this.trace(`browserSendMessage attachment decode failed name=${att?.name} error=${e?.message || e}`);
            }
        }

        const archiveBytes = await window.ZaliWasm.packMessage(sender, text, key, keyVersion, wasmAttachments, '', reply || '');
        if (!archiveBytes || !archiveBytes.length) return false;

        const formData = new FormData();
        formData.append('sender', sender || '');
        formData.append('receiver', receiver);
        if (serverId) formData.append('server_id', serverId);
        if (channelId) formData.append('channel_id', channelId);
        if (clientId) formData.append('client_id', clientId);
        formData.append('key_version', String(keyVersion || ''));
        formData.append('file', new Blob([archiveBytes], { type: 'application/octet-stream' }), 'message.zali');

        const res = await this.apiFetch(this.apiRoutes.messages.upload, {
            method: 'POST',
            body: formData,
        });
        return res.ok;
    }

    /**
     * Browser/PWA counterpart of the native EDIT_MESSAGE bridge: re-packs the
     * whole message (text + attachments + quote) into a fresh `.zali` via WASM
     * and PUTs it over the existing one.
     */
    async browserEditMessage({ messageId, text, key, keyVersion, attachments, reply }) {
        const id = String(messageId || '').trim();
        if (!id || !key) return false;
        if (!(await this.wasmAvailable())) {
            this.addLogEntry({ type: 'ERROR', msg: 'Редактирование недоступно: WASM-модуль не загружен', ts: new Date().toLocaleTimeString() });
            return false;
        }

        const wasmAttachments = [];
        for (const att of (attachments || [])) {
            if (!att?.dataUrl) continue;
            try {
                const bytes = await this.dataUrlToBytes(att.dataUrl);
                wasmAttachments.push({
                    name: att.name || 'attachment',
                    archivePath: att.archivePath || `attachments/${att.name || 'attachment'}`,
                    mimeType: att.mimeType || 'application/octet-stream',
                    kind: att.kind || 'file',
                    bytes,
                });
            } catch (e) {
                // Losing an attachment to a decode error would silently strip it
                // from the message, since the edit replaces the archive wholesale.
                this.trace(`browserEditMessage attachment decode failed name=${att?.name} error=${e?.message || e}`);
                throw new Error(`Не удалось перечитать вложение «${att?.name || ''}»`);
            }
        }

        const archiveBytes = await window.ZaliWasm.packMessage(
            this.myName(), text, key, keyVersion, wasmAttachments, '', reply || ''
        );
        if (!archiveBytes || !archiveBytes.length) return false;

        const formData = new FormData();
        formData.append('key_version', String(keyVersion || 2));
        formData.append('file', new Blob([archiveBytes], { type: 'application/octet-stream' }), 'message.zali');

        const res = await this.apiFetch(this.apiRoutes.messages.edit(id), {
            method: 'PUT',
            body: formData,
        });
        if (!res.ok) {
            throw new Error(await res.text().catch(() => '') || `HTTP ${res.status}`);
        }
        return true;
    }

    // Handles a raw `Message` row pushed over the WS connection (no `type` field —
    // see server/src/realtime.rs deliver_to_user/deliver_server_message). Downloads
    // the .zali archive and decrypts it in-browser via WASM, then feeds the result
    // into the same receiveMessage() path the native shells use.
    async handleIncomingBrowserMessage(payload) {
        const id = String(payload?.id || '').trim();
        const sender = String(payload?.sender || '').trim();
        const receiver = String(payload?.receiver || '').trim();
        if (!id || !sender || !receiver) return;

        // Already decoded in THIS page session — skip the whole round trip.
        //
        // loadBrowserDmHistory feeds every history row through here on every sync,
        // and a sync happens on each refreshAfterKey (one per key_envelope_available
        // push), each syncActiveConversation and each reconnect. Without this guard
        // every one of them re-downloaded the archive, re-ran the WASM unpack and
        // wrapped each attachment in a FRESH Blob + object URL — and nothing ever
        // revoked the previous one, so the browser pinned the entire conversation
        // again per sync. Measured by scripts/memory_doctor: 11 syncs of a 20-message
        // 5 MB conversation retained 55 MB and issued 220 downloads. A real session
        // logged 1097 refreshAfterKey calls.
        //
        // Session-scoped on purpose, rather than a lookup in the message cache: a
        // cached `blob:` URL is already dead after a page reload (see the comment in
        // saveStoredMessageCache), and re-fetching is exactly what repairs it. A
        // fresh Set per page load keeps that repair while killing the in-session churn.
        if (!this._decodedBrowserMessageIds) this._decodedBrowserMessageIds = new Set();
        if (this._decodedBrowserMessageIds.has(id)) return;

        if (!(await this.wasmAvailable())) return;

        const serverId = payload?.server_id || null;
        const channelId = payload?.channel_id || null;
        const peer = sender === this.myName() ? receiver : sender;

        let key = this.ensureConversationCryptoKey({
            peer: serverId ? null : peer,
            serverId,
            channelId,
            reason: 'handleIncomingBrowserMessage',
        });
        for (let attempt = 0; !key && attempt < 5; attempt++) {
            await new Promise(resolve => setTimeout(resolve, 400));
            key = await this.resolveConversationCryptoKey({
                peer: serverId ? null : peer,
                serverId,
                channelId,
                reason: 'handleIncomingBrowserMessage',
            });
        }
        if (!key) {
            this.trace(`handleIncomingBrowserMessage missingKey id=${id} peer=${peer}`);
            return;
        }

        try {
            const res = await this.apiFetch(this.apiRoutes.messages.download(id));
            if (!res.ok) return;
            const archiveBytes = new Uint8Array(await res.arrayBuffer());
            const unpacked = await window.ZaliWasm.unpackMessage(archiveBytes, key);
            const attachments = (unpacked.attachments || []).map(att => ({
                name: att.name,
                mimeType: att.mimeType,
                kind: att.kind,
                size: att.bytes?.length || 0,
                // `new Uint8Array(...)` is load-bearing, not defensive tidiness:
                // wasm-bindgen hands `bytes` back as a plain JS **Array** of numbers,
                // and the Blob constructor stringifies any array-like that isn't an
                // ArrayBuffer view. `new Blob([[137,80,78,71,...]])` therefore produced
                // the ASCII text "137,80,78,71,..." instead of the bytes — every
                // attachment received in the browser client came out corrupt and
                // roughly 3x oversized (a 70-byte PNG became 198 bytes of digits).
                dataUrl: att.bytes?.length
                    ? URL.createObjectURL(new Blob(
                        [att.bytes instanceof Uint8Array ? att.bytes : new Uint8Array(att.bytes)],
                        { type: att.mimeType || 'application/octet-stream' },
                    ))
                    : '',
                archivePath: att.archivePath,
            }));
            this.bus.send('zali_interface:receive_message', {
                id,
                // Both spellings on purpose: the live WS payload is a serialized
                // `Message` (snake_case `client_id`), while history rows from
                // GET /api/messages/:user are `MessageResponse`, which renames the
                // field to `clientId`. Reading only the snake_case one left every
                // history row without a clientId, so finalizePendingMessage() never
                // reconciled the locally-echoed copy — after a reload your own sent
                // message showed twice, one of them stuck on "sending" forever.
                clientId: payload?.clientId || payload?.client_id || '',
                sender: unpacked.sender || sender,
                receiver,
                text: unpacked.text,
                // Decrypted by the WASM core alongside the body; without this the
                // browser client would render replies as ordinary messages.
                reply: unpacked.reply || '',
                timestamp: unpacked.timestamp ? unpacked.timestamp * 1000 : payload?.timestamp,
                attachments,
                reactions: payload?.reactions || [],
                myReactions: payload?.myReactions || payload?.my_reactions || [],
                serverId,
                channelId,
            });
            // Only after a delivery that actually succeeded: a message marked here
            // on a failed attempt would never be retried once its key arrives.
            this._decodedBrowserMessageIds.add(id);
            // Ids only (no payload), but a long-lived tab in a busy channel should
            // still not grow this without bound. Dropping the oldest entry costs at
            // most one redundant re-fetch of a message that far back in history.
            if (this._decodedBrowserMessageIds.size > 5000) {
                this._decodedBrowserMessageIds.delete(this._decodedBrowserMessageIds.values().next().value);
            }
        } catch (e) {
            this.trace(`handleIncomingBrowserMessage failed id=${id} error=${e?.message || e}`);
            // Unlike the native shells, this path fails silently otherwise — there
            // is no placeholder message for the render-time hook in
            // detectSystemNotice() to catch, so this is the only place a
            // browser-client decrypt/unpack failure ever gets reported at all.
            void this.reportDecryptFailure({
                reason: 'browser-unpack-failed',
                clientError: `${e?.name || 'Error'}: ${e?.message || e}`,
                messageId: id,
                clientId: payload?.clientId || payload?.client_id || '',
                sender,
                receiver,
                serverId,
                channelId,
                messageTimestamp: payload?.timestamp,
            });
        }
    }

    // Fallback for loading DM history from a plain browser tab (no native shell to do
    // it via REFRESH_HISTORY). Downloads + decrypts each message metadata row returned
    // by GET /api/messages/:user and feeds it through receiveMessage(), same as above.
    async loadBrowserDmHistory(peer, key) {
        if (!peer || !key) return;
        if (!(await this.wasmAvailable())) return;
        try {
            const res = await this.apiFetch(this.apiRoutes.messages.direct(peer));
            if (!res.ok) return;
            const rows = await res.json();
            if (!Array.isArray(rows)) return;
            for (const row of rows) {
                await this.handleIncomingBrowserMessage(row);
            }
        } catch (e) {
            this.trace(`loadBrowserDmHistory failed peer=${peer} error=${e?.message || e}`);
        }
    }

    _getKey() {
        try {
            return this.ensureConversationCryptoKey({
                peer: this.currentConversationMode() === 'servers' ? null : this.S.current,
                serverId: this.currentConversationMode() === 'servers' ? this.currentServer()?.id || null : null,
                channelId: this.currentConversationMode() === 'servers' ? this.currentChannel()?.id || null : null,
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
        const canSend = this.currentConversationMode() === 'servers'
            ? !!(this.currentServer() && channel && !this.isVoiceChannel(channel))
            : !!this.S.current;
        if (btn) btn.disabled = !(hasText || hasAttachments) || !canSend;
    }

    // --- Bus Command Handlers ---

    receiveMessage(payload = {}) {
        // Call records are not chat text and DM-only, so they take their own path
        // instead of being threaded through both branches of the logic below.
        const callRecord = this.parseCallRecordPayload(payload);
        if (callRecord) {
            const clientId = String(payload?.clientId || payload?.client_id || '').trim();
            if (clientId) this.dropPendingOutbox(clientId);
            this.applyCallRecordMessage(callRecord, payload);
            return;
        }
        const {
            id,
            sender,
            receiver,
            text,
            timestamp,
            attachments,
            reactions,
            myReactions,
        } = payload || {};
        // Opaque quote string straight from the archive. This handler rebuilds the
        // stored message field by field (it does not spread the payload), so a
        // field left out here is silently lost on live delivery and only reappears
        // after the next history reload.
        const reply = String(payload?.reply || '');
        const serverId = payload?.serverId || payload?.server_id || null;
        const channelId = payload?.channelId || payload?.channel_id || null;
        const clientId = String(payload?.clientId || payload?.client_id || '').trim();
        this.trace(`receiveMessage id=${String(id || '').trim()} clientId=${clientId || 'none'} sender=${String(sender || '').trim()} receiver=${String(receiver || '').trim()} server=${serverId || 'dm'} channel=${channelId || 'dm'} textBytes=${String(text || '').length} attachments=${Array.isArray(attachments) ? attachments.length : 0} reactions=${Array.isArray(reactions) ? reactions.length : 0}`);
        if (clientId) {
            const reconciled = this.finalizePendingMessage(clientId, id);
            if (reconciled) {
                this.dropPendingOutbox(clientId);
                // The one thing reconciliation must still take from the incoming
                // copy — see adoptAttachmentPayloads().
                const peer = String(sender || '').trim() === this.myName()
                    ? String(receiver || '').trim()
                    : String(sender || '').trim();
                const store = (serverId && channelId)
                    ? this.S.serverChats[`${serverId}:${channelId}`]
                    : this.S.chats[peer];
                this.adoptAttachmentPayloads(store, {
                    msgId: id,
                    clientId,
                    attachments: this.normalizeAttachments(attachments),
                });
                if (serverId && channelId) {
                    this.renderServerInterface();
                } else {
                    this.scheduleRenderMessages();
                    this.renderContacts();
                }
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
                    clientId: clientId || prev.clientId || '',
                    sender: sender || prev.sender || '',
                    receiver: receiver || prev.receiver || '',
                    text: incomingText || prev.text || '',
                    attachments: incomingAttachments.length ? incomingAttachments : this.normalizeAttachments(prev.attachments),
                    reactions: incomingReactions.length ? incomingReactions : this.normalizeReactions(prev.reactions),
                    myReactions: this.normalizeMyReactions(myReactions?.length ? myReactions : prev.myReactions),
                    timestamp: ts || prev.timestamp || new Date().toISOString(),
                    reply: reply || prev.reply || '',
                    serverId: serverId || prev.serverId || '',
                    channelId: channelId || prev.channelId || '',
                };
            } else {
                msgs.push({
                    id: messageId,
                    clientId,
                    sender,
                    receiver,
                    text: incomingText,
                    attachments: incomingAttachments,
                    reactions: incomingReactions,
                    myReactions: this.normalizeMyReactions(myReactions),
                    timestamp: ts,
                    reply,
                    serverId,
                    channelId,
                });
                // "Visible" requires both the matching channel AND the servers view being
                // active — currentServerChatKey() keeps returning the selected channel
                // even while the user is looking at DMs, which used to swallow the
                // notification for messages arriving in that channel.
                const channelVisible = this.isServerChatVisible(key);
                if (!channelVisible) {
                    this.notifyBackgroundMessage({ sender, text: incomingText, attachmentCount: incomingAttachments.length, serverId, channelId });
                }
            }
            this.scheduleSaveStoredMessageCache();
            // Only render the channel's message list when it is actually the visible view.
            // currentServerChatKey() still returns the selected channel while the user is
            // in the DM view, so rendering on that alone painted channel messages into the
            // DM pane (and wasted work). Mirror the notification-visibility check above.
            if (this.isServerChatVisible(key)) {
                this.scheduleRenderMessages();
            } else {
                this.renderServerInterface();
                this.renderContacts();
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
                clientId: clientId || prev.clientId || '',
                sender: sender || prev.sender || '',
                receiver: receiver || prev.receiver || '',
                text: incomingText || prev.text || '',
                attachments: incomingAttachments.length ? incomingAttachments : this.normalizeAttachments(prev.attachments),
                reactions: incomingReactions.length ? incomingReactions : this.normalizeReactions(prev.reactions),
                myReactions: this.normalizeMyReactions(myReactions?.length ? myReactions : prev.myReactions),
                timestamp: ts || prev.timestamp || new Date().toISOString(),
                reply: reply || prev.reply || '',
            };
        } else {
            msgs.push({
                id: messageId,
                clientId,
                sender,
                receiver,
                text: incomingText,
                attachments: incomingAttachments,
                reactions: incomingReactions,
                myReactions: this.normalizeMyReactions(myReactions),
                timestamp: ts,
                reply,
            });
            // A DM is only truly visible when its chat is selected AND the DM view is
            // active — while the user is in the servers view the selected DM peer is
            // off-screen, and this notification used to be swallowed for it.
            const dmVisible = this.isDmChatVisible(peer);
            if (!dmVisible) {
                this.notifyBackgroundMessage({ sender, text: incomingText, attachmentCount: incomingAttachments.length, peer });
            }
        }
        this.scheduleSaveStoredMessageCache();
        if (!this.S.current) {
            this.switchChat(peer);
        }
        if (this.isDmChatVisible(peer)) {
            this.scheduleRenderMessages();
        } else {
            // Unread/notification bookkeeping (own-echo filtering included) already
            // happened above via notifyBackgroundMessage; just refresh the sidebar.
            this.renderContacts();
        }
        this.addLogEntry({ type: 'SUCCESS', msg: `Получено: ${sender} → ${receiver}`, ts: new Date().toLocaleTimeString() });
    }
});
