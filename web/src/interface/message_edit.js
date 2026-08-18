// --- ZaliInterface: Ответы, редактирование и удаление сообщений. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // ---- Reply quotes -------------------------------------------------
    //
    // A quote is a *snapshot* taken at send time and carried inside the
    // encrypted archive (MessageContent.reply in core/src/net.rs), not a
    // pointer resolved at render time. That is what lets a reply still show
    // what it answered after the original is deleted, edited, or simply scrolled
    // out of the loaded history window.

    /** Longest quote excerpt carried in an archive. */
    static get REPLY_QUOTE_MAX_CHARS() { return 280; }

    /** Builds the payload stored in the archive for a reply to `msg`. */
    buildReplyQuote(msg) {
        if (!msg || typeof msg !== 'object') return null;
        const id = String(msg.id || msg.clientId || '').trim();
        const sender = String(msg.sender || '').trim();
        if (!id || !sender) return null;
        const attachments = this.normalizeAttachments(msg.attachments);
        const text = String(msg.text || '').trim().slice(0, ZaliInterface.REPLY_QUOTE_MAX_CHARS);
        return { id, sender, text, attachmentCount: attachments.length };
    }

    /**
     * Parses the archive's `reply` field. Accepts an already-parsed object too,
     * because the local echo of our own outgoing message never round-trips
     * through JSON.
     */
    normalizeReplyQuote(value) {
        if (!value) return null;
        let parsed = value;
        if (typeof value === 'string') {
            const raw = value.trim();
            if (!raw) return null;
            try {
                parsed = JSON.parse(raw);
            } catch (e) {
                // A malformed quote must not take the whole bubble down with it.
                this.trace('normalizeReplyQuote invalid json');
                return null;
            }
        }
        if (!parsed || typeof parsed !== 'object') return null;
        const sender = String(parsed.sender || '').trim();
        if (!sender) return null;
        return {
            id: String(parsed.id || '').trim(),
            sender,
            text: String(parsed.text || '').slice(0, ZaliInterface.REPLY_QUOTE_MAX_CHARS),
            attachmentCount: Number(parsed.attachmentCount || 0) || 0,
        };
    }

    /** One-line preview of a quoted message, for both the bubble and the composer bar. */
    replyQuotePreview(quote) {
        const text = String(quote?.text || '').replace(/\s+/g, ' ').trim();
        if (text) return text;
        const count = Number(quote?.attachmentCount || 0) || 0;
        if (count > 0) return count === 1 ? 'Вложение' : `Вложения (${count})`;
        return 'Сообщение';
    }

    renderReplyQuote(msg) {
        const quote = this.normalizeReplyQuote(msg?.reply);
        if (!quote) return '';
        // data-reply-target drives the click-to-scroll below; absent when the
        // original is not in this client's history at all.
        const target = quote.id ? ` data-reply-target="${this.esc(quote.id)}"` : '';
        return `<div class="msg-quote"${target} role="button" tabindex="0">
            <span class="msg-quote-author">${this.esc(quote.sender)}</span>
            <span class="msg-quote-text">${this.esc(this.replyQuotePreview(quote))}</span>
        </div>`;
    }

    startReplyToMessage(messageId) {
        const found = this.findMessageById(messageId);
        if (!found) return;
        const quote = this.buildReplyQuote(found.msg);
        if (!quote) return;
        // Replying while editing would be ambiguous — the edit wins its own bar,
        // so starting a reply ends the edit.
        this.S.editDraft = null;
        this.S.replyDraft = quote;
        this.renderComposerContext();
        const input = document.getElementById('msgInput');
        if (input) input.focus();
    }

    /** Scrolls to the quoted original and flashes it, when it is still loaded. */
    scrollToMessage(messageId) {
        const id = String(messageId || '').trim();
        if (!id) return false;
        const box = document.getElementById('msgs');
        const node = box?.querySelector(`.msg[data-message-id="${CSS.escape(id)}"]`);
        if (!node) {
            this.addLogEntry({ type: 'INFO', msg: 'Исходное сообщение не загружено в этом чате', ts: new Date().toLocaleTimeString() });
            return false;
        }
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        node.classList.remove('msg-flash');
        // Reading offsetWidth forces the class removal to take effect before it is
        // re-added, so a second click on the same quote replays the animation
        // instead of doing nothing.
        void node.offsetWidth;
        node.classList.add('msg-flash');
        setTimeout(() => node.classList.remove('msg-flash'), 1600);
        return true;
    }

    // ---- Editing ------------------------------------------------------

    /**
     * Only the author edits, and only a message the server actually has.
     * Channel managers can *delete* other people's messages (canDeleteMessage),
     * but rewriting someone's words under their name is forgery — the server
     * refuses it too (PUT /api/message/:id checks the sender).
     */
    canEditMessage(msg) {
        if (!msg || msg.kind === 'call') return false;
        if (String(msg.sender || '').trim() !== this.myName()) return false;
        const id = String(msg.id || '').trim();
        if (!id) return false;
        // Still in the outbox (id === clientId) — there is nothing on the server
        // to replace yet.
        return !msg.clientId || id !== String(msg.clientId).trim();
    }

    startEditMessage(messageId) {
        const found = this.findMessageById(messageId);
        if (!found || !this.canEditMessage(found.msg)) return;
        this.S.replyDraft = null;
        this.S.editDraft = {
            id: String(found.msg.id || '').trim(),
            originalText: String(found.msg.text || ''),
        };
        const input = document.getElementById('msgInput');
        if (input) {
            input.value = String(found.msg.text || '');
            this.resizeComposer();
            input.focus();
            // Caret to the end — the common intent is to append or fix a typo,
            // not to overwrite from the start.
            const end = input.value.length;
            try { input.setSelectionRange(end, end); } catch (e) {}
        }
        this.renderComposerContext();
        this.updateSendButtonState();
    }

    /**
     * Clears the reply bar after a send, but only if it still holds the quote
     * that send used — the user may have started replying to something else
     * while the send was in flight, and clearing that would lose their intent.
     */
    clearComposerReply(usedQuote) {
        if (!usedQuote) return;
        if (this.S.replyDraft && this.S.replyDraft.id !== usedQuote.id) return;
        this.S.replyDraft = null;
        this.renderComposerContext();
    }

    cancelComposerContext({ restoreInput = true } = {}) {
        const wasEditing = !!this.S.editDraft;
        this.S.replyDraft = null;
        this.S.editDraft = null;
        if (wasEditing && restoreInput) {
            const input = document.getElementById('msgInput');
            if (input) {
                input.value = '';
                this.resizeComposer();
            }
        }
        this.renderComposerContext();
        this.updateSendButtonState();
    }

    /** Renders the reply/edit bar sitting above the composer. */
    renderComposerContext() {
        const wrap = document.getElementById('composerContext');
        if (!wrap) return;
        const reply = this.S.replyDraft;
        const edit = this.S.editDraft;
        if (!reply && !edit) {
            wrap.hidden = true;
            wrap.innerHTML = '';
            return;
        }
        const title = edit ? 'Редактирование' : `Ответ ${this.esc(reply.sender)}`;
        const preview = edit
            ? this.replyQuotePreview({ text: edit.originalText })
            : this.replyQuotePreview(reply);
        wrap.hidden = false;
        wrap.innerHTML = `<div class="composer-context-body">
                <span class="composer-context-title">${title}</span>
                <span class="composer-context-text">${this.esc(preview)}</span>
            </div>
            <button class="composer-context-close" type="button" data-composer-context-cancel aria-label="Отменить">✕</button>`;
    }

    /**
     * Applies an edit to local state right away, so the bubble updates without
     * waiting for the server round-trip and the following history refresh.
     */
    applyLocalMessageEdit(messageId, text) {
        const found = this.findMessageById(messageId);
        if (!found) return false;
        const list = found.serverKey ? this.S.serverChats[found.serverKey] : this.S.chats[found.peer];
        if (!Array.isArray(list)) return false;
        list[found.index] = {
            ...list[found.index],
            text,
            // messageRenderKey collapses to `id:<id>` for a stored message and
            // messageStableSignature only samples the text *length*, so an edit
            // that keeps the length would otherwise never trigger a re-render.
            editRev: Number(list[found.index].editRev || 0) + 1,
            editedAt: new Date().toISOString(),
        };
        this.scheduleSaveStoredMessageCache();
        const shouldRender = found.serverKey
            ? found.serverKey === this.currentServerChatKey()
            : found.peer === this.S.current;
        if (shouldRender) this.scheduleRenderMessages();
        return true;
    }

    /**
     * Sends the edit. The archive is replaced wholesale server-side, so the
     * message's attachments have to be re-packed along with the new text —
     * omitting them here would silently strip them from the message.
     */
    async submitMessageEdit() {
        const draft = this.S.editDraft;
        if (!draft) return false;
        const input = document.getElementById('msgInput');
        const text = String((input && input.value) || '').trim();
        const found = this.findMessageById(draft.id);
        if (!found) {
            this.cancelComposerContext();
            return false;
        }
        const attachments = this.normalizeAttachments(found.msg.attachments);
        if (!text && attachments.length === 0) {
            this.addLogEntry({ type: 'WARN', msg: 'Пустое сообщение нельзя сохранить — удалите его', ts: new Date().toLocaleTimeString() });
            return false;
        }
        if (text === String(found.msg.text || '')) {
            // Nothing changed — don't burn a chain version on a no-op edit.
            this.cancelComposerContext();
            return true;
        }

        const isServers = !!found.msg.serverId;
        const cryptoKey = await this.resolveConversationCryptoKey({
            peer: isServers ? null : (found.msg.sender === this.myName() ? found.msg.receiver : found.msg.sender),
            serverId: found.msg.serverId || null,
            channelId: found.msg.channelId || null,
            reason: 'submitMessageEdit',
        }) || this.loadStoredCryptoKey();
        if (!cryptoKey) {
            this.addLogEntry({ type: 'ERROR', msg: 'Для редактирования нужен E2E-ключ', ts: new Date().toLocaleTimeString() });
            return false;
        }

        const keyVersion = Number(found.msg.keyVersion || 2) || 2;
        // The quote and the call record ride along unchanged: an edit changes the
        // text, not what the message was a reply to.
        const replyPayload = found.msg.reply
            ? (typeof found.msg.reply === 'string' ? found.msg.reply : JSON.stringify(found.msg.reply))
            : '';

        const previousText = String(found.msg.text || '');
        // Optimistic, then rolled back on failure — an edit that silently did
        // nothing is worse than one that visibly reverts.
        this.applyLocalMessageEdit(draft.id, text);
        this.cancelComposerContext();

        try {
            if (this.nativeSupports('editMessage')) {
                await this.requestNativeAction({
                    type: NativeMessageTypes.EDIT_MESSAGE,
                    messageId: draft.id,
                    text,
                    key: cryptoKey,
                    keyVersion,
                    reply: replyPayload,
                    attachments: attachments.map(att => ({
                        name: att.name,
                        mimeType: att.mimeType,
                        kind: att.kind,
                        size: att.size,
                        dataUrl: att.dataUrl,
                    })),
                }, 30000);
            } else {
                const ok = await this.browserEditMessage({
                    messageId: draft.id,
                    text,
                    key: cryptoKey,
                    keyVersion,
                    reply: replyPayload,
                    attachments,
                });
                if (!ok) throw new Error('Не удалось отправить изменения');
            }
            this.addLogEntry({ type: 'SUCCESS', msg: 'Сообщение изменено', ts: new Date().toLocaleTimeString() });
            return true;
        } catch (e) {
            this.applyLocalMessageEdit(draft.id, previousText);
            this.addLogEntry({ type: 'ERROR', msg: `Не удалось изменить сообщение: ${e?.message || e}`, ts: new Date().toLocaleTimeString() });
            return false;
        }
    }

    /**
     * Reaction to someone else's edit (or our own from another device). The event
     * carries no plaintext, so the only thing to do is re-fetch and re-decrypt
     * that conversation — exactly the path a newly received message takes.
     */
    onMessageEdited(payload) {
        if (!payload || typeof payload !== 'object') return;
        const messageId = String(payload.messageId || payload.message_id || '').trim();
        if (!messageId) return;
        const found = this.findMessageById(messageId);
        if (!found) return;
        this.trace(`onMessageEdited id=${messageId} peer=${found.serverKey || found.peer}`);
        // Bumped so the render signature changes even if the new text happens to
        // be the same length as the old one.
        const list = found.serverKey ? this.S.serverChats[found.serverKey] : this.S.chats[found.peer];
        if (Array.isArray(list)) {
            list[found.index] = {
                ...list[found.index],
                editRev: Number(list[found.index].editRev || 0) + 1,
            };
        }
        // syncActiveConversation only ever refreshes whatever is on screen, so
        // there is nothing to do for an edit in a conversation the user is not
        // looking at — it is re-fetched when they open it.
        const isVisible = found.serverKey
            ? found.serverKey === this.currentServerChatKey()
            : found.peer === this.S.current;
        if (isVisible) {
            void this.syncActiveConversation({ force: true });
        }
    }

    async deleteMessage(messageId) {
        const id = String(messageId || '').trim();
        if (!id) return;
        const found = this.findMessageById(id);
        if (!found || !this.canDeleteMessage(found.msg)) return;
        if (!confirm('Удалить сообщение?')) return;

        const hasRealServerId = !!found.msg.id && (!found.msg.clientId || String(found.msg.id) !== String(found.msg.clientId));
        if (!hasRealServerId) {
            // Never made it past the outbox (still pending/failed to upload) —
            // nothing exists server-side to delete, just drop it locally.
            this.removeMessageFromState(id);
            return;
        }

        try {
            const res = await this.apiFetch(this.apiRoutes.messages.remove(found.msg.id), { method: 'DELETE' });
            if (!res.ok && res.status !== 204) {
                throw new Error(await res.text() || 'Не удалось удалить сообщение');
            }
            this.removeMessageFromState(id);
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: `Не удалось удалить сообщение: ${e.message || e}`, ts: new Date().toLocaleTimeString() });
        }
    }
});
