// --- ZaliInterface: Отрисовка тела сообщения, реакции, статусы. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    sanitizeDecryptionErrorText(text) {
        const value = String(text || '').trim();
        if (!value) return '';
        if (/^(?:🚨\s*)?\[Ошибка расшифрования:[^\]]*\]$/.test(value)) {
            return '';
        }
        return text;
    }

    // Recognizes the fixed-format strings the app itself generates for a message
    // body — a ZaliCoin transfer notice (submitCoinTransfer) or a native-layer
    // decryption/download placeholder (WebView.swift / native.rs) — so they can be
    // rendered as a distinct system pill instead of a normal chat bubble. This is a
    // *display-only* affordance, not an authenticity guarantee: it matches on exact
    // wording, so a peer could type the identical string and see the same styling.
    // Good enough to tell "the app posted this" apart from an ordinary message at a
    // glance, not to prove provenance.
    detectSystemNotice(text) {
        const value = String(text || '').trim();
        if (!value) return null;
        // Accepts both the current "💰 <name> перевёл(а) N ZaliCoin" wording and the
        // older nameless one (submitCoinTransfer used to omit the sender), so a
        // transfer notice sent before that changed still renders as a pill instead
        // of reverting to a plain bubble.
        if (/^💰\s*(?:\S+\s+)?[Пп]еревёл\(а\)\s+\d+(?:[.,]\d+)?\s+ZaliCoin$/.test(value)) return 'transfer';
        if (
            /^🔒\s*Сообщение зашифровано другим ключом$/.test(value) ||
            /^🔑\s*Получение ключа…?$/.test(value) ||
            /^📦\s*Файл сообщения превышает допустимый размер$/.test(value) ||
            /^⚠️\s*Не удалось загрузить сообщение$/.test(value) ||
            // The Windows/Rust shell writes its own wording (native/messages.rs's
            // undecryptable_placeholder) and carries no emoji marker. It was missing
            // from this list entirely, so on Windows a message that would not decrypt
            // rendered as an ordinary chat bubble and — far worse — never reached
            // queueDecryptFailureReport, which is what asks the holders to republish.
            // The one mechanism that repairs an unreadable conversation was therefore
            // unreachable on that platform, exactly as it was on Android before the
            // key_republish_request routing was split out.
            /^Не удалось расшифровать сообщение:/.test(value) ||
            /^(?:🚨\s*)?\[Ошибка расшифрования:[^\]]*\]$/.test(value)
        ) return 'decrypt-error';
        return null;
    }

    // Maps a decrypt-error placeholder to a short, stable slug for
    // reportDecryptFailure()'s `reason` field — grouping reports by cause
    // instead of leaving the server to parse (and re-translate) free text.
    decryptFailureReasonSlug(text) {
        const value = String(text || '');
        if (/зашифровано другим ключом/.test(value)) return 'wrong-key';
        if (/Получение ключа/.test(value)) return 'awaiting-key';
        if (/превышает допустимый размер/.test(value)) return 'oversized';
        if (/Не удалось загрузить/.test(value)) return 'download-failed';
        // Windows shell wording; the cause is the same as 'wrong-key' — no key this
        // device holds opened the archive.
        if (/Не удалось расшифровать сообщение/.test(value)) return 'wrong-key';
        if (/Ошибка расшифрования/.test(value)) return 'legacy-decrypt-error';
        return 'unknown';
    }

    // Phones home with everything locally available that could explain a
    // decryption failure — added while chasing "переписки пропадают, растёт
    // число ошибок расшифровки" (2026-07-31). Deliberately best-effort: never
    // throws, never blocks rendering, and is skipped entirely while logged
    // out (the server can't attribute an unauthenticated report to anyone).
    // Only a SHA-256 fingerprint of any key is ever sent — see
    // conversationKeyId() — never the key itself.
    // Render-loop entry point for a decryption failure.
    //
    // _renderMessagesNow() hits one of these per undecryptable message, so a
    // screenful of unreadable history used to fire, from inside the render
    // frame, one POST *and* one canonical-key lookup per message — the lookup
    // has no cache shortcut of its own, so fifty placeholders meant a hundred
    // requests leaving at once, plus a DOM read of the log panel for each. The
    // reports are worth keeping; doing them during the frame is not.
    //
    // Deferred out of the frame, and the whole batch shares a single canonical
    // lookup instead of repeating it per message.
    queueDecryptFailureReport(details = {}) {
        if (!this._decryptFailureQueue) this._decryptFailureQueue = [];
        // Bounded: a very long unreadable history should cost a fixed amount of
        // telemetry, not one request per row.
        if (this._decryptFailureQueue.length >= 50) return;
        this._decryptFailureQueue.push(details);
        if (this._decryptFailureFlushTimer) return;
        this._decryptFailureFlushTimer = setTimeout(() => {
            this._decryptFailureFlushTimer = 0;
            void this.flushDecryptFailureReports();
        }, 300);
    }

    async flushDecryptFailureReports() {
        const batch = this._decryptFailureQueue || [];
        this._decryptFailureQueue = [];
        if (!batch.length) return;
        const scopes = Array.from(new Set(batch
            .map(details => details.scope || this.conversationScopeKey(
                details.sender === this.myName() ? details.receiver : details.sender,
                details.serverId,
                details.channelId,
            ))
            .filter(Boolean)));
        // One lookup for the whole batch; each report below then reads it from
        // the cache instead of asking again.
        try { await this.fetchCanonicalKeyIds(scopes); } catch (e) {}
        for (const details of batch) {
            await this.reportDecryptFailure({ ...details, useCachedCanonicalKeyIds: true });
        }
    }

    async reportDecryptFailure(details = {}) {
        if (!this.S.session?.token) return;
        const key = [
            details.messageId || details.clientId || '',
            details.sender || '',
            details.receiver || '',
            details.serverId || '',
            details.channelId || '',
        ].join('|');
        if (!this._reportedDecryptFailures) this._reportedDecryptFailures = new Set();
        if (key && this._reportedDecryptFailures.has(key)) return;
        if (key) {
            this._reportedDecryptFailures.add(key);
            // Bounded so a long-lived tab doesn't grow this forever.
            if (this._reportedDecryptFailures.size > 500) {
                this._reportedDecryptFailures.delete(this._reportedDecryptFailures.values().next().value);
            }
        }
        try {
            const scope = details.scope || this.conversationScopeKey(
                details.sender === this.myName() ? details.receiver : details.sender,
                details.serverId,
                details.channelId,
            );
            const localKey = scope ? this.getStoredConversationKey(scope) : '';
            const localKeyId = localKey ? await this.conversationKeyId(localKey) : '';
            let canonicalKeyId = '';
            if (scope) {
                try {
                    const canonical = await this.fetchCanonicalKeyIds([scope], {
                        allowCached: !!details.useCachedCanonicalKeyIds,
                    });
                    canonicalKeyId = canonical.get(scope) || '';
                } catch (e) { /* best-effort — see fetchCanonicalKeyIds's own fallback */ }
            }
            const logBody = document.getElementById('logBody');
            const recentLog = logBody
                ? Array.from(logBody.children).slice(-30).map(el => String(el.textContent || '').slice(0, 300))
                : [];
            const payload = {
                reason: details.reason || this.decryptFailureReasonSlug(details.placeholderText || ''),
                placeholderText: String(details.placeholderText || '').slice(0, 200),
                clientError: String(details.clientError || '').slice(0, 500),
                messageId: details.messageId || '',
                clientId: details.clientId || '',
                sender: details.sender || '',
                receiver: details.receiver || '',
                serverId: details.serverId || '',
                channelId: details.channelId || '',
                scope,
                messageTimestamp: details.messageTimestamp || '',
                hasLocalKey: !!localKey,
                localKeyId,
                canonicalKeyId,
                keyMatches: (localKeyId && canonicalKeyId) ? (localKeyId === canonicalKeyId) : null,
                deviceId: this.currentDeviceId(),
                platform: this.hasNativeBridge() ? 'native' : 'browser',
                userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
                recentLog,
                reportedAt: new Date().toISOString(),
            };
            await this.apiFetch(this.apiRoutes.diagnostics.decryptFailure, {
                method: 'POST',
                body: JSON.stringify(payload),
            });
            // Telemetry alone changed nothing for the user: this reported that a
            // message was unreadable and then stopped, while the one mechanism that
            // could fix it — asking the holders to republish — was only ever
            // triggered when a scope had NO key at all. A message that fails to
            // decrypt while we do hold a key for the scope is the exact signal that
            // we are missing some OTHER key of that scope, so ask.
            // Explicitly caught: every helper it calls swallows its own errors today,
            // but this is fire-and-forget from a render path — one future throw in
            // that chain would surface as an unhandled rejection instead of a trace.
            if (scope) {
                this.requestKeyRepublishForDecryptFailure(scope)
                    .catch(err => this.trace(`requestKeyRepublishForDecryptFailure failed error=${err?.message || err}`));
            }
        } catch (e) {
            this.trace(`reportDecryptFailure failed error=${e?.message || e}`);
        }
    }

    // Rate-limited per scope: a screenful of undecryptable history would otherwise
    // fire one request per message, and every request fans out to every device of
    // every participant.
    async requestKeyRepublishForDecryptFailure(scope, { cooldownMs = 60000 } = {}) {
        const scoped = this.canonicalConversationScope(String(scope || '').trim());
        if (!scoped) return false;
        if (!this._republishAskedAt) this._republishAskedAt = new Map();
        const last = Number(this._republishAskedAt.get(scoped) || 0);
        if (last && Date.now() - last < cooldownMs) return false;
        this._republishAskedAt.set(scoped, Date.now());
        const ok = await this.requestKeyRepublish(scoped, { reason: 'decrypt_failure' });
        if (ok) {
            // The answer arrives as envelopes; pick them up without waiting for the
            // next scheduled sync, then re-render so the message stops being a
            // placeholder.
            await this.syncIncomingKeyEnvelopes({ reason: 'decrypt_failure', triggerRefresh: true });
        }
        return ok;
    }

    hydrateGifMedia(root = document) {
        // Animated stickers need the same treatment as GIF-like videos — they can
        // only be booted once their node is in the document — so they piggyback on
        // the single post-render hook every message list already calls.
        window.ZaliTgs?.hydrate(root);

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
                        return;
                    }
                    // Symmetric pause. Without it this observer could only ever
                    // start playback, so a looping clip scrolled out of the
                    // window kept decoding frames for the rest of the session —
                    // in a media-heavy chat, several of them at once. Animated
                    // stickers already do exactly this (modules/tgs.js); a
                    // paused element keeps its current frame, so nothing about
                    // the picture changes, only the work behind it.
                    if (!video.paused) video.pause?.();
                }, { root: null, threshold: 0.15, rootMargin: '160px' });
                observer.observe(video);
                video.dataset.gifObserver = '1';
                return;
            }

            ensurePlaying();
        });

        // Covers every message-attachment image (not just gif-like ones): the shell's
        // box-shaping aspect-ratio is set from mediaSizeCache at render time, but on
        // first render nothing is cached yet, so it falls back to a hardcoded 16:9 box.
        // If the real photo isn't 16:9, its actual (height:auto) box disagrees with that
        // fallback and the shell's `overflow:hidden` crops it. Once the image decodes we
        // know its true size — cache it AND correct the already-rendered shell in place
        // so the crop clears immediately instead of waiting for an unrelated re-render.
        const images = root.querySelectorAll?.('img.media-img:not([data-size-bound="1"])') || [];
        images.forEach(img => {
            if (!(img instanceof HTMLImageElement)) return;
            img.dataset.sizeBound = '1';
            const shell = img.closest('.discord-media-shell');
            const src = img.currentSrc || img.src || img.getAttribute('src') || '';
            const syncFromImage = () => {
                const width = Number(img.naturalWidth || 0);
                const height = Number(img.naturalHeight || 0);
                if (!src || !width || !height) return;
                this.mediaSizeCache.set(src, { width, height });
                if (shell && !img.classList.contains('media-gif-like')) {
                    shell.style.aspectRatio = `${width} / ${height}`;
                }
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

        // Always first in the bubble — the quote is context for everything below it.
        const quoteBlock = this.renderReplyQuote(msg);
        if (quoteBlock) bodyParts.push(quoteBlock);

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
                    // The client gave up on a call it could no longer recover — see
                    // concludeDeadVoiceCallIfNeeded. Without this it read as an
                    // ordinary completed call, which is the one thing it was not.
                    : outcome === 'failed'
                        ? `Звонок прерван`
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
                    <div class="call-card-icon">${outcome === 'completed' ? this.uiIcon('phone') : this.uiIcon('close')}</div>
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
        if (attachments.some(att => att.kind === 'image' || att.kind === 'video' || att.kind === 'gif' || att.kind === 'sticker' || (att.mimeType || '').startsWith('image/') || (att.mimeType || '').startsWith('video/'))) {
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
            // Stickers ride along here so a lone sticker gets the same
            // chrome-less `media-only` treatment a lone GIF does.
            return attachments.every(att =>
                att.kind === 'gif' ||
                att.kind === 'sticker' ||
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

    // A photo/gif/sticker sent with a caption: same "is every attachment
    // image-like" test as messageIsGifOnly(), but for the text-present case that
    // method deliberately excludes. Kept attachment-only (no Tenor/URL-preview
    // variant) — a caption on a bare pasted link is a rarer, lower-value case not
    // worth the extra branching.
    messageIsImageCaption(msg) {
        const text = (msg.text || '').trim();
        if (!text) return false;
        const attachments = this.normalizeAttachments(msg.attachments);
        if (!attachments.length) return false;
        return attachments.every(att =>
            att.kind === 'gif' ||
            att.kind === 'sticker' ||
            att.mimeType === 'image/gif' ||
            (att.mimeType || '').startsWith('image/')
        );
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
            if (first.kind === 'sticker') return 'Стикер';
            if (first.kind === 'video' || first.mimeType.startsWith('video/')) return 'Видео';
            if (first.kind === 'gif' || first.mimeType === 'image/gif') return 'GIF';
            if (first.mimeType.startsWith('image/')) return 'Фото';
            if (first.kind === 'audio' || first.mimeType.startsWith('audio/')) return 'Аудио';
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

    // A user can react to a message with several distinct emoji at once
    // (Discord-style) — myReactions is a set, not a single slot.
    normalizeMyReactions(value) {
        const list = Array.isArray(value) ? value : (value ? [value] : []);
        return Array.from(new Set(list.map(v => String(v || '').trim()).filter(Boolean)));
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
        const myReactions = this.normalizeMyReactions(msg.myReactions);
        return reactions.length
            ? `<div class="reaction-row">
                ${reactions.map(reaction => {
                    const mine = myReactions.includes(reaction.emoji) ? ' mine' : '';
                    return `<span class="reaction-chip${mine}" title="${this.esc(reaction.emoji)}" data-message-id="${this.esc(messageId)}" data-message-reaction="${this.esc(reaction.emoji)}">
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
            `<button class="reaction-btn" type="button" data-menu-reaction="${this.esc(emoji)}" aria-label="${this.esc(emoji)}"><span class="reaction-btn-emoji">${this.esc(emoji)}</span></button>`
        )).join('')
            + `<span class="reaction-menu-sep" aria-hidden="true"></span>`
            + `<button class="reaction-btn reaction-btn-action" type="button" data-menu-reply title="Ответить" aria-label="Ответить на сообщение"><span class="reaction-btn-emoji">↩</span></button>`
            + `<button class="reaction-btn reaction-btn-action" type="button" data-menu-edit title="Изменить" aria-label="Изменить сообщение" hidden><span class="reaction-btn-emoji">✎</span></button>`
            + `<button class="reaction-btn reaction-btn-delete" type="button" data-menu-delete title="Удалить" aria-label="Удалить сообщение" hidden><span class="reaction-btn-emoji">🗑</span></button>`;
        document.body.appendChild(menu);

        menu.addEventListener('click', (e) => {
            const replyBtn = e.target.closest('[data-menu-reply]');
            if (replyBtn) {
                const messageId = menu.getAttribute('data-message-id');
                this.hideReactionMenu();
                if (messageId) this.startReplyToMessage(messageId);
                return;
            }
            const editBtn = e.target.closest('[data-menu-edit]');
            if (editBtn) {
                const messageId = menu.getAttribute('data-message-id');
                this.hideReactionMenu();
                if (messageId) this.startEditMessage(messageId);
                return;
            }
            const deleteBtn = e.target.closest('[data-menu-delete]');
            if (deleteBtn) {
                const messageId = menu.getAttribute('data-message-id');
                this.hideReactionMenu();
                if (messageId) {
                    void this.deleteMessage(messageId);
                }
                return;
            }
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
        const found = this.findMessageById(messageId);
        const deleteBtn = menu.querySelector('[data-menu-delete]');
        if (deleteBtn) {
            deleteBtn.hidden = !this.canDeleteMessage(found?.msg);
        }
        const editBtn = menu.querySelector('[data-menu-edit]');
        if (editBtn) {
            editBtn.hidden = !this.canEditMessage(found?.msg);
        }
        const replyBtn = menu.querySelector('[data-menu-reply]');
        if (replyBtn) {
            // A call record is not something you can quote meaningfully, and a
            // message still in the outbox has no id for the quote to point at.
            replyBtn.hidden = !found?.msg || found.msg.kind === 'call';
        }
        menu.classList.add('visible');
        menu.setAttribute('aria-hidden', 'false');
        menu.style.left = '0px';
        menu.style.top = '0px';
        const menuRect = menu.getBoundingClientRect();
        const anchor = messageEl.querySelector('.bwrap') || messageEl;
        const anchorRect = anchor.getBoundingClientRect();
        const pad = 12;
        const gap = 10;
        const maxLeft = window.innerWidth - menuRect.width - pad;
        const maxTop = window.innerHeight - menuRect.height - pad;
        const preferredLeft = anchorRect.left + (anchorRect.width - menuRect.width) / 2;
        const fallbackLeft = Number.isFinite(x) ? x - menuRect.width / 2 : preferredLeft;
        const left = Math.max(pad, Math.min(Number.isFinite(preferredLeft) ? preferredLeft : fallbackLeft, maxLeft));
        // On mobile the chat app-bar is sticky over the message list, so the
        // menu must never be placed under it — clamp to just below its bottom
        // edge instead of the plain viewport padding.
        const headerBottom = this.isMobileLayout()
            ? (document.querySelector('#viewChat .chat-hdr')?.getBoundingClientRect().bottom || 0) + 8
            : 0;
        const topInset = Math.max(pad, headerBottom);
        const topAbove = anchorRect.top - menuRect.height - gap;
        const topBelow = anchorRect.bottom + gap;
        const preferredTop = topAbove >= topInset ? topAbove : topBelow;
        const fallbackTop = Number.isFinite(y) ? y - menuRect.height - gap : preferredTop;
        const top = Math.max(topInset, Math.min(Number.isFinite(preferredTop) ? preferredTop : fallbackTop, maxTop));
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

    dmSidebarSignature() {
        const q = String(this.S.searchQ || '').toLowerCase();
        const me = this.myName();
        return (this.S.contacts || [])
            .filter(contact => contact !== me && (!q || String(contact || '').toLowerCase().includes(q)))
            .map((contact, index) => ({
                name: contact,
                lastMessageAt: this.conversationLastMessageAt(contact),
                unread: Number(this.S.unread?.[contact] || 0),
                lastKey: this.messageRenderKey((this.S.chats?.[contact] || []).slice(-1)[0] || {}),
                active: contact === this.S.current ? 1 : 0,
                index,
            }))
            .sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }) || a.index - b.index)
            .map(item => `${item.name}:${item.lastMessageAt}:${item.unread}:${item.lastKey}:${item.active}`)
            .join('|');
    }

    messageStableSignature(msg = {}) {
        if (!msg || typeof msg !== 'object') return '';
        const reactions = Array.isArray(msg.reactions) ? msg.reactions.length : 0;
        const attachments = Array.isArray(msg.attachments) ? msg.attachments.length : 0;
        return [
            this.messageRenderKey(msg),
            String(msg.status || ''),
            String(msg.text || '').length,
            // messageRenderKey collapses to `id:<id>` once a message is stored and
            // the text is only sampled by LENGTH above, so an edit that keeps the
            // length would otherwise render as no change at all.
            Number(msg.editRev || 0),
            String(msg.reply || '').length,
            reactions,
            attachments,
            this.normalizeMyReactions(msg.myReactions).slice().sort().join(','),
        ].join(':');
    }

    activeMessagesSignature() {
        if (this.S.navMode === 'servers') {
            const key = this.serverChatKey();
            return (this.S.serverChats?.[key] || []).map(msg => this.messageStableSignature(msg)).join('|');
        }
        const peer = this.S.current;
        return (this.S.chats?.[peer] || []).map(msg => this.messageStableSignature(msg)).join('|');
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
                    delete msgs[i].error;
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
                        delete msgs[i].error;
                        if (serverId) msgs[i].id = serverId;
                        updated = true;
                        break;
                    }
                }
                if (updated) break;
            }
        }
        if (updated && render) {
            this.scheduleRenderMessages();
        }
        return updated;
    }

    applyLocalReaction(found, emoji) {
        if (!found || !found.msg) return;
        const message = found.msg;
        const mine = new Set(this.normalizeMyReactions(message.myReactions));
        const wasMine = mine.has(emoji);
        const map = new Map(this.normalizeReactions(message.reactions).map(item => [item.emoji, item.count]));

        if (wasMine) {
            mine.delete(emoji);
            const nextCount = (map.get(emoji) || 0) - 1;
            if (nextCount > 0) map.set(emoji, nextCount);
            else map.delete(emoji);
        } else {
            mine.add(emoji);
            map.set(emoji, (map.get(emoji) || 0) + 1);
        }

        message.myReactions = Array.from(mine);
        message.reactions = Array.from(map.entries())
            .map(([reactionEmoji, count]) => ({ emoji: reactionEmoji, count }))
            .sort((a, b) => b.count - a.count || a.emoji.localeCompare(b.emoji));

        const shouldRender = found.serverKey
            ? found.serverKey === this.currentServerChatKey()
            : found.peer === this.S.current;
        if (shouldRender) {
            this.scheduleRenderMessages();
        }
    }

    // Toggles a single emoji for the current user on a message — it stacks
    // alongside any other emoji they've already reacted with, rather than
    // replacing them (Discord-style, not a single reaction slot per user).
    async addReaction(messageId, emoji) {
        const id = String(messageId || '').trim();
        const reaction = String(emoji || '').trim();
        if (!id || !reaction) return;

        const found = this.findMessageById(id);
        if (!found) return;

        const hasRealServerId = !!found.msg.id && (!found.msg.clientId || String(found.msg.id) !== String(found.msg.clientId));
        if (!hasRealServerId) {
            this.applyLocalReaction(found, reaction);
            return;
        }

        if (this.nativeSupports('setReaction')) {
            const sent = this.postNativeMessage({
                type: NativeMessageTypes.SET_MESSAGE_REACTION,
                messageId: found.msg.id,
                emoji: reaction,
            });
            if (sent) {
                return;
            }
        }

        try {
            const res = await this.apiFetch(this.apiRoutes.messages.reaction(found.msg.id), {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ emoji: reaction }),
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
});
