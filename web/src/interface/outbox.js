// --- ZaliInterface: Очередь неотправленных сообщений и её досылка. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

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
                type: NativeMessageTypes.SAVE_PENDING_OUTBOX,
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

    cachePendingOutboxAttachments(clientId, attachments) {
        const key = String(clientId || '').trim();
        if (!key) return;
        // localStorage persists outbox attachments without dataUrl (quota), so the
        // payload needed for a retry lives only in this in-session cache.
        const withData = this.normalizeAttachments(attachments).filter(att => att.dataUrl);
        if (!withData.length) return;
        if (!this._outboxAttachmentCache) this._outboxAttachmentCache = new Map();
        this._outboxAttachmentCache.set(key, withData);
    }

    getPendingOutboxAttachments(clientId) {
        const key = String(clientId || '').trim();
        if (!key || !this._outboxAttachmentCache) return [];
        return this._outboxAttachmentCache.get(key) || [];
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
            // Opaque structured payload (call records). Rides the normal outbox so it
            // inherits retries, dedupe by clientId and offline queueing.
            call: String(message.call || ''),
            // Same treatment for the reply quote — a retried send that dropped it
            // would arrive as an ordinary message with no visible connection to
            // what it was answering.
            reply: String(message.reply || ''),
            attachments: this.normalizeAttachments(message.attachments).map(att => ({
                id: att.id,
                name: att.name,
                mimeType: att.mimeType,
                kind: att.kind,
                size: att.size,
                archivePath: att.archivePath,
            })),
            timestamp: String(message.timestamp || new Date().toISOString()),
            attemptCount: Number(message.attemptCount || 0),
            lastAttemptAt: Number(message.lastAttemptAt || 0),
            nextRetryAt: Number(message.nextRetryAt || 0),
            // Persist the encryption key (and its version) the optimistic message was
            // queued with. Previously this field was silently dropped, so every retry
            // re-derived the *current* conversation key via pendingOutboxItemKey — after
            // a key rotation a retry could ship under a different key than its bubble.
            key: message.key ? String(message.key) : '',
            keyVersion: Number(message.keyVersion || 2),
            inFlight: !!message.inFlight,
        });
        this.savePendingOutbox(pending);
    }

    updatePendingOutboxItem(clientId, patch = {}) {
        const pendingId = String(clientId || '').trim();
        if (!pendingId) return false;
        const pending = this.loadPendingOutbox();
        const index = pending.findIndex(item => String(item?.clientId || '').trim() === pendingId);
        if (index < 0) return false;
        pending[index] = {
            ...pending[index],
            ...(patch && typeof patch === 'object' ? patch : {}),
        };
        this.savePendingOutbox(pending);
        return true;
    }

    dropPendingOutbox(clientId) {
        const pendingId = String(clientId || '').trim();
        if (!pendingId) return;
        this.trace(`dropPendingOutbox clientId=${pendingId}`);
        this.clearSendWatchdog(pendingId);
        if (this._outboxAttachmentCache) this._outboxAttachmentCache.delete(pendingId);
        const pending = this.loadPendingOutbox().filter(item => String(item.clientId || '').trim() !== pendingId);
        this.savePendingOutbox(pending);
    }

    clearSendWatchdog(clientId) {
        const pendingId = String(clientId || '').trim();
        if (!pendingId) return;
        const timer = this.sendWatchdogTimers.get(pendingId);
        if (timer) {
            clearTimeout(timer);
            this.sendWatchdogTimers.delete(pendingId);
        }
    }

    scheduleSendWatchdog(message, key) {
        const clientId = String(message?.clientId || '').trim();
        if (!clientId) return;
        this.clearSendWatchdog(clientId);
        const timer = setTimeout(() => {
            this.sendWatchdogTimers.delete(clientId);
            const found = this.findMessageById(clientId);
            if (!found || String(found.msg?.status || '').trim() !== 'sending') return;
            const pending = this.loadPendingOutbox();
            const existing = pending.find(item => String(item?.clientId || '').trim() === clientId);
            if (!existing) {
                this.trace(`sendWatchdog requeue clientId=${clientId}`);
                this.enqueuePendingOutbox({
                    ...message,
                    key: '',
                    nextRetryAt: 0,
                    attemptCount: (message.attemptCount || 0) + 1,
                    lastAttemptAt: 0,
                });
                this.scheduleFlushPendingOutbox(150);
                return;
            }
            this.updatePendingOutboxItem(clientId, {
                inFlight: false,
                nextRetryAt: Date.now(),
            });
            this.scheduleFlushPendingOutbox(150);
        }, 20000);
        this.sendWatchdogTimers.set(clientId, timer);
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
            this.scheduleRenderMessages();
            this.renderContacts();
            this.renderServerInterface();
        }
    }

    recoverOrphanSendingMessages() {
        const currentUser = String(this.myName() || '').trim();
        if (!currentUser || !this.S.session?.token) return;
        const maxAgeMs = 2 * 60 * 60 * 1000;
        const now = Date.now();
        const pendingIds = new Set(this.loadPendingOutbox().map(item => String(item?.clientId || '').trim()).filter(Boolean));
        let recovered = 0;

        const shouldRecover = (msg) => {
            const clientId = String(msg?.clientId || '').trim();
            if (!clientId || pendingIds.has(clientId)) return false;
            if (String(msg?.sender || '').trim() !== currentUser) return false;
            if (String(msg?.status || '').trim() !== 'sending') return false;
            const timestamp = Date.parse(String(msg?.timestamp || ''));
            if (!Number.isFinite(timestamp) || (now - timestamp) > maxAgeMs) return false;
            return true;
        };

        const recoverMessage = (msg, serverId = null, channelId = null) => {
            const receiver = String(msg?.receiver || '').trim();
            if (!receiver) return;
            const key = serverId && channelId
                ? this.ensureConversationCryptoKey({ serverId, channelId, reason: 'recoverOrphanSendingMessages' })
                : this.ensureConversationCryptoKey({ peer: receiver, reason: 'recoverOrphanSendingMessages' });
            this.cachePendingOutboxAttachments(msg?.clientId, msg?.attachments);
            this.enqueuePendingOutbox({
                ...msg,
                receiver,
                serverId: serverId || null,
                channelId: channelId || null,
                key,
                keyVersion: Number(msg?.keyVersion || 2),
                nextRetryAt: 0,
                attemptCount: 0,
                lastAttemptAt: 0,
            });
            this.scheduleSendWatchdog(msg, key);
            recovered += 1;
        };

        for (const msgs of Object.values(this.S.chats || {})) {
            for (const msg of Array.isArray(msgs) ? msgs : []) {
                if (shouldRecover(msg)) recoverMessage(msg);
            }
        }
        for (const [key, msgs] of Object.entries(this.S.serverChats || {})) {
            const [serverId, channelId] = String(key || '').split(':');
            if (!serverId || !channelId) continue;
            for (const msg of Array.isArray(msgs) ? msgs : []) {
                if (shouldRecover(msg)) recoverMessage(msg, serverId, channelId);
            }
        }

        if (recovered > 0) {
            this.trace(`recoverOrphanSendingMessages recovered=${recovered}`);
            this.addLogEntry({ type: 'WARN', msg: `Восстановлено зависших сообщений: ${recovered}`, ts: new Date().toLocaleTimeString() });
            this.scheduleFlushPendingOutbox(150);
        }
    }

    isPendingMessageAlreadyLoaded(item) {
        const clientId = String(item.clientId || '').trim();
        const attachmentsKey = this.normalizeAttachments(item.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
        const text = String(item.text || '');
        const sender = String(item.sender || '');
        const receiver = String(item.receiver || '');
        const serverId = String(item.serverId || '').trim();
        const channelId = String(item.channelId || '').trim();

        const matchesDelivered = (msg) => {
            if (String(msg.status || '').trim() !== 'sent') return false;
            if (msg.error) return false;
            if (clientId) {
                // Only the same clientId echoed back by the server proves delivery.
                // Content equality is not proof: two distinct messages with identical
                // text/attachments would wrongly drop the second one from the outbox,
                // leaving its bubble stuck in "sending" forever.
                return String(msg.clientId || msg.client_id || '').trim() === clientId;
            }
            const msgAttachments = this.normalizeAttachments(msg.attachments).map(att => `${att.name}:${att.kind}:${att.size}`).join('|');
            return String(msg.sender || '') === sender &&
                String(msg.receiver || '') === receiver &&
                String(msg.text || '') === text &&
                msgAttachments === attachmentsKey;
        };

        if (serverId && channelId) {
            const msgs = this.S.serverChats[`${serverId}:${channelId}`] || [];
            return msgs.some(matchesDelivered);
        }

        const peer = sender === this.myName() ? receiver : sender;
        return (this.S.chats[peer] || []).some(matchesDelivered);
    }

    flushPendingOutbox() {
        // Deliberately NOT gated on nativeSupports('sendMessage') any more. The browser/PWA
        // client has its own send path (browserSendMessage, WASM-packed .zali over fetch),
        // but this whole retry queue used to bail out on the first line for it — so a send
        // that failed in a browser tab was logged once and never retried, and the message
        // sat in the UI as permanently "sending". The per-item branch below picks the
        // right transport; everything else (backoff, attempt cap, attachment recovery,
        // stall detection) is transport-independent and now applies to both.
        if (!this.S.session?.token) return;
        const currentUser = String(this.myName() || '').trim();
        const now = Date.now();
        const pending = this.loadPendingOutbox();
        if (!pending.length) return;
        this.trace(`flushPendingOutbox currentUser=${currentUser} count=${pending.length} tokenSet=${!!this.S.session?.token}`);
        let sentAny = false;

        // Cap concurrent sends. Firing the whole backlog at once saturates the
        // connection pool to the host, which makes unrelated API calls (device trust,
        // contacts, key sync) queue behind it and time out at 12s. The rest of the
        // queue goes out on the next flush cycle.
        const MAX_CONCURRENT_SENDS = 3;
        let inFlightCount = pending.reduce((n, it) => n + (it && it.inFlight ? 1 : 0), 0);

        for (const item of pending) {
            if (!item || typeof item !== 'object') continue;
            if (currentUser && String(item.sender || '').trim() !== currentUser) continue;
            if (Number(item.nextRetryAt || 0) > now) continue;
            if (item.inFlight) {
                // A native send result can get lost (bridge reloaded mid-send, response
                // dropped). Without this, the item stays inFlight forever and the message
                // is only retried after a WS reconnect kick or app restart.
                const stalledMs = now - Number(item.lastAttemptAt || 0);
                if (!Number.isFinite(stalledMs) || stalledMs < 45000) continue;
                this.trace(`flushPendingOutbox stalled inFlight cleared clientId=${String(item.clientId || '').trim()} stalledMs=${Math.round(stalledMs)}`);
                item.inFlight = false;
                // Reclaim the concurrency slot this stalled item was holding. Without
                // this, when MAX_CONCURRENT_SENDS items are all stalled at once,
                // inFlightCount never drops below the cap, so the throttle check below
                // always breaks the loop — the queue deadlocks and nothing is retried.
                inFlightCount = Math.max(0, inFlightCount - 1);
            }
            if (inFlightCount >= MAX_CONCURRENT_SENDS) {
                this.trace(`flushPendingOutbox throttled inFlight=${inFlightCount} cap=${MAX_CONCURRENT_SENDS}`);
                this.scheduleFlushPendingOutbox(800);
                break;
            }

            const itemKey = this.pendingOutboxItemKey(item);
            if (!itemKey) {
                this.trace(`flushPendingOutbox missing key clientId=${String(item.clientId || '').trim()}`);
                item.nextRetryAt = now + 5000;
                this.savePendingOutbox(pending);
                continue;
            }

            const MAX_OUTBOX_ATTEMPTS = 50;
            if ((item.attemptCount || 0) >= MAX_OUTBOX_ATTEMPTS) {
                this.markMessageStatus(item.clientId, 'error');
                this.dropPendingOutbox(item.clientId);
                continue;
            }

            if (this.isPendingMessageAlreadyLoaded(item)) {
                this.dropPendingOutbox(item.clientId);
                continue;
            }

            const declaredAttachments = this.normalizeAttachments(item.attachments);
            let outAttachments = declaredAttachments.filter(att => att.dataUrl);
            if (declaredAttachments.length && !outAttachments.length) {
                outAttachments = this.getPendingOutboxAttachments(item.clientId).filter(att => att.dataUrl);
            }
            if (declaredAttachments.length && !outAttachments.length) {
                // The attachment bytes are gone (dataUrl is not persisted across
                // restarts). Sending now would deliver the message without its files —
                // or completely empty for attachment-only messages. Fail it visibly
                // instead of silently delivering wrong content.
                this.trace(`flushPendingOutbox attachments lost clientId=${String(item.clientId || '').trim()} declared=${declaredAttachments.length}`);
                this.markMessageStatus(item.clientId, 'error');
                this.dropPendingOutbox(item.clientId);
                this.addLogEntry({ type: 'ERROR', msg: 'Вложения сообщения утеряны после перезапуска, отправка отменена. Прикрепите файлы заново.', ts: new Date().toLocaleTimeString() });
                continue;
            }

            item.attemptCount = Number(item.attemptCount || 0) + 1;
            item.lastAttemptAt = now;
            item.nextRetryAt = now + Math.min(30000, Math.max(1500, 1000 * Math.min(item.attemptCount, 6)));
            item.inFlight = true;
            inFlightCount += 1;
            this.savePendingOutbox(pending);
            sentAny = true;

            // Browser/PWA has no native shell to hand the send to — pack and upload it
            // here, the same way sendInputMessage's browser branch does. The item stays
            // in the queue either way: on success the server's own-device echo comes back
            // over the WS and finalizePendingMessage() drops it by clientId, exactly like
            // the native path; on failure it just becomes the next retry.
            if (!this.nativeSupports('sendMessage')) {
                const pendingId = String(item.clientId || '').trim();
                const requeue = () => this.updatePendingOutboxItem(pendingId, {
                    inFlight: false,
                    nextRetryAt: Date.now() + 2000,
                });
                this.browserSendMessage({
                    text: item.text,
                    key: itemKey,
                    keyVersion: Number(item.keyVersion || 2),
                    sender: item.sender || this.myName(),
                    receiver: item.serverId && item.channelId ? item.channelId : item.receiver,
                    serverId: item.serverId || '',
                    channelId: item.channelId || '',
                    clientId: item.clientId,
                    attachments: outAttachments,
                    reply: String(item.reply || ''),
                }).then(ok => {
                    if (!ok) {
                        this.trace(`flushPendingOutbox browserSendMessage failed clientId=${pendingId}`);
                        requeue();
                    }
                }).catch(error => {
                    this.trace(`flushPendingOutbox browserSendMessage error clientId=${pendingId} error=${error?.message || error}`);
                    requeue();
                });
                continue;
            }

            const sentToNative = this.postNativeMessage({
                type: NativeMessageTypes.SEND_MESSAGE,
                text: item.text,
                recipient: item.serverId && item.channelId ? item.channelId : item.receiver,
                serverId: item.serverId || '',
                channelId: item.channelId || '',
                sender: item.sender || this.myName(),
                key: itemKey,
                keyVersion: Number(item.keyVersion || 2),
                clientId: item.clientId,
                call: String(item.call || ''),
                reply: String(item.reply || ''),
                attachments: outAttachments.map(att => ({
                    name: att.name,
                    mimeType: att.mimeType,
                    kind: att.kind,
                    size: att.size,
                    dataUrl: att.dataUrl,
                })),
            });
            if (!sentToNative) {
                this.trace(`flushPendingOutbox native bridge rejected clientId=${String(item.clientId || '').trim()}`);
                item.inFlight = false;
                inFlightCount -= 1;
                item.nextRetryAt = Date.now() + 2000;
                this.savePendingOutbox(pending);
            }
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
});
