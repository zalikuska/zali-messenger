// --- ZaliInterface: Окно сообщений, рендер списка, переключение чата. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    getCurrentMessages() {
        if (this.S.navMode === 'servers') {
            const key = this.currentServerChatKey();
            return this.S.serverChats[key] || [];
        }
        return this.S.chats[this.S.current] || [];
    }

    // Fast negative answer to "is this peer present in the persisted cache?".
    //
    // ensureConversationLoaded runs inside the message-render frame, and its
    // loadStoredMessageCache() call JSON.parses the ENTIRE persisted store — every
    // conversation, not just this one — rebuilding the whole object graph. For an
    // account with real history that is a main-thread stall on every render of an
    // empty chat, and it almost always ends in "peer not found" anyway: the chat is
    // usually empty because it genuinely has no cached history.
    //
    // The raw text is scanned for the peer's own quoted JSON key first. A miss there
    // is conclusive (the key would have to appear verbatim if it were stored), and
    // a raw string scan is cheaper than a parse by orders of magnitude. A hit falls
    // through to the real parse, so nothing that used to be found stops being found.
    // Misses are additionally memoised against the exact raw string, so repeated
    // renders of the same empty chat cost nothing at all until the cache is rewritten.
    persistedCacheMightHavePeer(raw, peer) {
        if (!raw) return false;
        if (this._msgCacheMissRaw !== raw) {
            this._msgCacheMissRaw = raw;
            this._msgCacheMissPeers = new Set();
        }
        if (this._msgCacheMissPeers.has(peer)) return false;
        if (raw.indexOf(JSON.stringify(peer)) !== -1) return true;
        this._msgCacheMissPeers.add(peer);
        return false;
    }

    ensureConversationLoaded(peer = null) {
        const currentPeer = String(peer || this.S.current || '').trim();
        if (!currentPeer) return false;
        const currentMsgs = this.S.chats[currentPeer];
        if (Array.isArray(currentMsgs) && currentMsgs.length > 0) {
            return true;
        }

        let rawCache = null;
        try {
            rawCache = localStorage.getItem(this.messageCacheStorageKey());
        } catch (e) {
            rawCache = null;
        }
        // No persisted store at all still has to go through the loader below, which
        // falls back to the native-injected cache (window.__ZALI_MESSAGE_CACHE).
        if (rawCache && !this.persistedCacheMightHavePeer(rawCache, currentPeer)) {
            return false;
        }

        const cache = this.loadStoredMessageCache();
        const cachedMsgs = Array.isArray(cache?.chats?.[currentPeer]) ? cache.chats[currentPeer] : [];
        if (cachedMsgs.length === 0) return false;

        this.S.chats[currentPeer] = cachedMsgs.filter(msg => msg && typeof msg === 'object');
        this.trace(`ensureConversationLoaded peer=${currentPeer} restored=${this.S.chats[currentPeer].length}`);
        return true;
    }

    // Mirror of ensureConversationLoaded() for server channels. applySession()
    // already bulk-restores S.serverChats from the same persisted cache at login,
    // but it does that once, synchronously, from whatever the cache held at that
    // exact moment — it is not consulted again afterward. Anything that reaches
    // S.serverChats[key] empty at render time (a channel switch racing that
    // restore, a key that only later gets recognized once the server/channel list
    // itself finishes loading) fell straight through to the "Нет сообщений в
    // канале" empty state with nothing to catch it, then re-rendered a moment
    // later once loadServerMessages()'s network round-trip landed — the
    // empty-then-full flash ("промигивание") reported when opening a channel.
    ensureServerConversationLoaded(serverId = null, channelId = null) {
        const sid = String(serverId || this.S.activeServer || '').trim();
        const cid = String(channelId || this.S.activeChannel || '').trim();
        if (!sid || !cid) return false;
        const key = `${sid}:${cid}`;
        const currentMsgs = this.S.serverChats[key];
        if (Array.isArray(currentMsgs) && currentMsgs.length > 0) {
            return true;
        }

        let rawCache = null;
        try {
            rawCache = localStorage.getItem(this.messageCacheStorageKey());
        } catch (e) {
            rawCache = null;
        }
        if (rawCache && !this.persistedCacheMightHavePeer(rawCache, key)) {
            return false;
        }

        const cache = this.loadStoredMessageCache();
        const cachedMsgs = Array.isArray(cache?.serverChats?.[key]) ? cache.serverChats[key] : [];
        if (cachedMsgs.length === 0) return false;

        this.S.serverChats[key] = cachedMsgs.filter(msg => msg && typeof msg === 'object');
        this.trace(`ensureServerConversationLoaded key=${key} restored=${this.S.serverChats[key].length}`);
        return true;
    }

    scheduleRenderMessages() {
        if (this.messageRenderRaf) return;
        this.messageRenderRaf = requestAnimationFrame(() => {
            this.messageRenderRaf = 0;
            this._renderMessagesNow();
        });
    }

    renderMessages() {
        this.scheduleRenderMessages();
    }

    _renderMessagesNow() {
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
        // Capturing the anchor walks message nodes reading getBoundingClientRect() —
        // a forced layout per node. It is only ever consumed by the `preserveScroll`
        // branch below, so skip the work outright in the cases that branch can't run
        // (conversation switch, queued scroll, or we're pinned to the bottom).
        const scrollAnchor = (conversationChanged || this.pendingMessagesScroll || stickToBottom)
            ? null
            : this.captureMessageScrollAnchor(box);
        const msgs = this.getCurrentMessages();
        const channel = this.currentChannel();
        const server = this.currentServer();

        if (!isServers && (!Array.isArray(msgs) || msgs.length === 0) && !this.S.loading) {
            const restored = this.ensureConversationLoaded(this.S.current);
            if (restored) {
                this.trace(`renderMessages rerender restored peer=${String(this.S.current || '').trim()}`);
                this.scheduleRenderMessages();
                return;
            }
        }

        if (isServers && (!Array.isArray(msgs) || msgs.length === 0) && !this.S.loading) {
            const restored = this.ensureServerConversationLoaded(this.S.activeServer, this.S.activeChannel);
            if (restored) {
                this.trace(`renderMessages rerender restored server key=${this.currentServerChatKey()}`);
                this.scheduleRenderMessages();
                return;
            }
        }

        if (isServers && channel && this.isVoiceChannel(channel)) {
            this._lastMessagesHTML = null;
            // The call UI lives in #voicePanel (renderVoicePanel(), called below) —
            // this used to ALSO render the identical renderVoiceRoomView() into the
            // message box, so a voice channel showed two full copies of the same
            // call card stacked on top of each other, together consuming the whole
            // screen and then some. Voice channels have no text chat of their own
            // (sendInputMessage() no-ops for them), so this box just says that
            // instead of duplicating the call view.
            box.innerHTML = '<div class="voice-empty voice-channel-no-chat">Голосовые каналы не поддерживают текстовые сообщения</div>';
            if (isServers && server) {
                const chatHdrAva = document.getElementById('chatHdrAva');
                const chatHdrName = document.getElementById('chatHdrName');
                const chatHdrSub = document.getElementById('chatHdrSub');
                if (chatHdrAva) {
                    chatHdrAva.style.background = this.serverAvatarBackground(server);
                    this.setHTMLIfChanged(chatHdrAva, this.serverAvatarInnerHTML(server));
                }
                if (chatHdrName) this.setHTMLIfChanged(chatHdrName, `<span class="chat-hdr-title">${this.channelKindIcon('voice', 'chat-hdr-channel-icon')}<span>${this.esc(channel.name)}</span></span><span class="chat-hdr-count">${this.esc(`Голосовой канал`)}</span>`);
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
            this._lastMessagesHTML = null;
            this.lastRenderedConversationKey = conversationKey;
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
            const isGroupable = item.msg?.kind !== 'call' && !this.detectSystemNotice(item.msg?.text) && !!item.ts && !!item.dayKey && !!String(item.msg?.sender || '').trim();
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
            const noticeType = !isCall ? this.detectSystemNotice(msg.text) : null;
            const isNotice = !!noticeType;
            const isImageCaption = !isCall && !isNotice && this.messageIsImageCaption(msg);
            const dateStr = this.fmtDate(msg.timestamp);
            const mediaCard = !isCall && this.messageHasMedia(msg) ? 'media-card' : '';
            const gifOnly = !isCall && this.messageIsGifOnly(msg);
            const isSending = isOut && msg.status === 'sending';
            const messageId = String(msg.id || '').trim();
            const hoverTimeLabel = !isCall ? this.messageHoverTimeLabel(msg) : '';
            const showInlineTime = !isCall && (item.groupPos === 'single' || item.groupPos === 'end');
            const inlineTimeLabel = !isCall ? this.messageInlineTimeLabel(msg) : '';
            const dir = isCall ? (isOut ? 'out' : 'in') : (isOut ? 'out' : 'in');
            const showAvatar = !isCall && !isOut && (item.groupPos === 'single' || item.groupPos === 'end');
            if (dateStr && dateStr !== lastDate) {
                html += `<div class="date-sep"><span>${this.esc(dateStr)}</span></div>`;
                lastDate = dateStr;
            }

            // System notices (a ZaliCoin transfer receipt, a decryption/download
            // placeholder) are generated by the app itself, not typed by either
            // party — render them as a centered pill instead of a left/right chat
            // bubble so they read as distinct from a human-written message with the
            // same wording. See detectSystemNotice() for the caveat on what this
            // does and doesn't guarantee.
            const showSender = this.shouldShowMessageSender(msg, {
                isOut,
                isCall,
                isNotice,
                groupPos: item.groupPos,
                isServers,
            });
            const senderLabelHtml = showSender ? this.renderMessageSenderLabel(msg) : '';

            if (isNotice) {
                if (noticeType === 'decrypt-error') {
                    // Queued, not awaited-and-fired here: see
                    // queueDecryptFailureReport() for why this must not happen
                    // inside the render frame.
                    this.queueDecryptFailureReport({
                        placeholderText: msg.text,
                        messageId: msg.id,
                        clientId: msg.clientId,
                        sender: msg.sender,
                        receiver: msg.receiver,
                        serverId: msg.serverId,
                        channelId: msg.channelId,
                        messageTimestamp: msg.timestamp,
                    });
                }
                html += `<div class="msg notice notice-${noticeType}"${messageId ? ` data-message-id="${this.esc(messageId)}"` : ''}>
                    <div class="notice-stack">
                        ${senderLabelHtml}
                        <div class="notice-pill"${hoverTimeLabel ? ` title="${this.esc(hoverTimeLabel)}"` : ''}>
                            <span class="notice-icon" aria-hidden="true">${noticeType === 'transfer' ? '💸' : '🔐'}</span>
                            <span class="notice-text">${this.renderMessageText(msg.text)}</span>
                        </div>
                    </div>
                </div>`;
                return;
            }

            // A photo (or gif/sticker) with a caption: the image stands on its own,
            // chrome-less and square-bottomed, and the caption sits below it in a
            // separate bubble sized to match — a small gap between the two instead
            // of both crammed into one padded card (the old `bubble media-card`
            // layout, still used below for mixed/file attachments).
            if (isImageCaption) {
                const attachments = this.normalizeAttachments(msg.attachments);
                const mediaHtml = attachments.map(att => this.renderAttachmentPreview(att)).join('');
                html += `<div class="msg ${dir} image-caption group-${item.groupPos} ${isSending ? 'sending' : ''} ${showInlineTime ? 'time-visible' : 'time-hidden'}"${messageId ? ` data-message-id="${this.esc(messageId)}"` : ''}>`;
                if (!isOut && showAvatar) {
                    html += `<div class="msg-ava" data-profile-open="${this.esc(msg.sender)}" title="${this.esc(`Профиль: ${msg.sender}`)}">${this.renderAvatarHTML(msg.sender, 'avatar-img', msg.sender)}</div>`;
                } else if (!isOut) {
                    html += `<div class="msg-ava msg-ava-spacer" aria-hidden="true"></div>`;
                }
                html += `<div class="bwrap image-caption-wrap">
                    ${senderLabelHtml}
                    <div class="image-caption-media">${mediaHtml}</div>
                    <div class="bubble image-caption-text msg-time-anchor"${hoverTimeLabel ? ` title="${this.esc(hoverTimeLabel)}"` : ''}>${this.renderMessageText(msg.text)}${inlineTimeLabel ? `<span class="msg-time" aria-hidden="true">${this.esc(inlineTimeLabel)}</span>` : ''}</div>
                    ${this.renderMessageReactions(msg)}
                </div></div>`;
                return;
            }

            const bubbleClass = isCall ? '' : (gifOnly ? 'media-only msg-time-anchor' : `bubble ${mediaCard} msg-time-anchor`);

            html += `<div class="msg ${dir} ${isCall ? 'call-msg' : `group-${item.groupPos}`} ${isSending ? 'sending' : ''} ${gifOnly ? 'gif-only' : ''} ${showInlineTime ? 'time-visible' : 'time-hidden'}"${messageId ? ` data-message-id="${this.esc(messageId)}"` : ''}>`;
            if (!isCall && !isOut && showAvatar) {
                html += `<div class="msg-ava" data-profile-open="${this.esc(msg.sender)}" title="${this.esc(`Профиль: ${msg.sender}`)}">${this.renderAvatarHTML(msg.sender, 'avatar-img', msg.sender)}</div>`;
            } else if (!isCall && !isOut) {
                html += `<div class="msg-ava msg-ava-spacer" aria-hidden="true"></div>`;
            }
            html += `<div class="bwrap ${isCall ? 'call-wrap' : ''}">
                ${senderLabelHtml}
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

        // Redundant re-renders are common (an avatar finishing its fetch, an unrelated
        // state sync). Reassigning identical innerHTML would still destroy and rebuild
        // every bubble, restart the media hydration and re-run the height probe — and
        // on WebKit it also resets scrollTop mid-scroll. Compare first.
        const htmlChanged = this._lastMessagesHTML !== html || conversationChanged || box.childElementCount === 0;
        if (htmlChanged) {
            box.innerHTML = html;
            this._lastMessagesHTML = html;
            this.hydrateGifMedia(box);

            // Sampling the whole list meant one forced layout per message node on
            // every render. A dozen evenly spread samples give the same running
            // average for the virtual-window estimate at a fraction of the cost.
            const msgNodes = box.querySelectorAll('.msg');
            if (msgNodes.length) {
                const SAMPLES = 12;
                const step = Math.max(1, Math.floor(msgNodes.length / SAMPLES));
                let total = 0;
                let counted = 0;
                for (let i = 0; i < msgNodes.length && counted < SAMPLES; i += step) {
                    const height = Number(msgNodes[i].offsetHeight || 0);
                    if (height > 0) {
                        total += height;
                        counted += 1;
                    }
                }
                if (counted > 0) {
                    const avgHeight = total / counted;
                    const current = Number(this.messageWindow?.avgHeight || 92);
                    this.messageWindow.avgHeight = Math.max(56, Math.min(160, current * 0.7 + avgHeight * 0.3));
                }
            }
        }
        this.messageWindow.conversationKey = conversationKey;
        this.messageWindow.start = windowInfo.useWindow ? windowInfo.start : 0;
        this.messageWindow.end = windowInfo.useWindow ? windowInfo.end : msgs.length;
        this.messageWindow.count = msgs.length;
        this.messageWindow.useWindow = !!windowInfo.useWindow;

        const preserveScroll = !conversationChanged && !this.pendingMessagesScroll && !stickToBottom;
        if (preserveScroll && previousScrollHeight > 0 && htmlChanged) {
            // Holding a position in history is the opposite of following the bottom.
            this._bottomIntent = false;
            this.markProgrammaticScroll();
            const restored = this.restoreMessageScrollAnchor(box, scrollAnchor);
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
        } else if (!conversationChanged && stickToBottom && htmlChanged) {
            this.markProgrammaticScroll();
            box.scrollTop = box.scrollHeight;
            this.pinToBottomAfterLayout(box);
        } else if (conversationChanged) {
            // A conversation switch with no queued scroll used to leave the old
            // chat's scrollTop in place over freshly written content — the classic
            // "opened a chat somewhere in the middle of last week" jump. Opening at
            // the newest message is the only correct default here.
            this.markProgrammaticScroll();
            box.scrollTop = box.scrollHeight;
            this.pinToBottomAfterLayout(box);
        }

        if (isServers && server) {
            const chatHdrAva = document.getElementById('chatHdrAva');
            const chatHdrName = document.getElementById('chatHdrName');
            const chatHdrSub = document.getElementById('chatHdrSub');
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
        }
        this.lastRenderedConversationKey = conversationKey;
    }

    switchChat(name) {
        const peer = String(name || '').trim();
        if (!peer) return;
        this.trace(`switchChat peer=${peer}`);
        // A contact row in the sidebar is clickable from Hub/ZaliCoin/Settings too
        // (the sidebar never hides) — bring the chat screen back if one of those
        // was open, otherwise picking a conversation from there looked like a
        // no-op.
        this.ensureChatViewOpen();
        this.collapseActiveCallView();
        this.clearActiveServerSelection();
        // A reply quote and an edit both point at a message in the conversation
        // being left; carrying them over would send the reply into the wrong chat
        // (or, worse, apply the edit to a message the composer no longer shows).
        this.cancelComposerContext();
        this.S.current = peer;
        // NB: lastRenderedConversationKey must NOT be pre-set to the new peer here.
        // _renderMessagesNow() derives `conversationChanged` from it, and that flag
        // drives (a) the virtual-window reset, (b) whether the pending
        // "scroll to bottom" is honoured and (c) whether the *previous* chat's
        // scroll anchor gets restored. Pre-setting it made every chat switch look
        // like an in-place update: the new conversation opened at whatever scroll
        // offset the old one had, i.e. the random jumps between chats.
        this.S.unread[peer] = 0;
        this.syncTaskbarBadge();
        this.initChat(peer);
        this.ensureConversationCryptoKey({ peer, reason: 'switchChat' });
        this.saveStoredCurrentContact(peer);
        this.requestMessagesScroll('bottom');
        const wasServers = this.S.navMode === 'servers';
        this.setNavMode('dm', { refresh: !wasServers });
        this.resetMessageWindow();

        const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
        set('tbChat',       peer);
        set('chatHdrName',  peer);
        this.updateChatHeaderCryptoKey({ peer });
        const chatHdrAva = document.getElementById('chatHdrAva');
        if (chatHdrAva) {
            chatHdrAva.style.background = '';
            this.setHTMLIfChanged(chatHdrAva, this.renderAvatarHTML(peer, 'avatar-img', peer));
        }
        const chatCallBtn = document.getElementById('chatCallBtn');
        if (chatCallBtn) chatCallBtn.hidden = !this.S.current;
        const chatVideoCallBtn = document.getElementById('chatVideoCallBtn');
        if (chatVideoCallBtn) chatVideoCallBtn.hidden = !this.S.current;
        const serverSettingsBtn = document.getElementById('serverSettingsBtn');
        if (serverSettingsBtn) serverSettingsBtn.hidden = true;

        if (wasServers) {
            this.renderServerInterface();
            this.renderContacts();
            this.scheduleRenderMessages();
            this.renderVoicePanel();
        } else {
            this.renderContacts();
            this.scheduleRenderMessages();
        }
        this.updateSendButtonState();
        this.syncActiveConversation({ force: true });
        this.closeMobileSidebar();
        this.syncMobileChrome();
    }
});
