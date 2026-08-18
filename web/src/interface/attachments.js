// --- ZaliInterface: Вложения, Tenor, предпросмотр медиа. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // A .tgs is a gzipped Lottie animation (Telegram animated sticker). Peers and
    // older builds of this app label it anything from application/gzip to
    // application/octet-stream, so detection leans on the filename too — see
    // ZaliTgs.isTgsAttachment in web/src/modules/tgs.js.
    isStickerAttachment(att) {
        if (window.ZaliTgs?.isTgsAttachment) return window.ZaliTgs.isTgsAttachment(att);
        const name = String(att?.name || att?.archivePath || att?.archive_path || '');
        const mimeType = String(att?.mimeType || att?.mime_type || '').toLowerCase();
        return att?.kind === 'sticker' || mimeType === 'application/x-tgsticker' || /\.tgs$/i.test(name.trim());
    }

    attachmentKindFor(att) {
        if (this.isStickerAttachment(att)) return 'sticker';
        const mimeType = String(att?.mimeType || att?.mime_type || '');
        if (mimeType.startsWith('video/')) return 'video';
        if (mimeType === 'image/gif') return 'gif';
        if (mimeType.startsWith('image/')) return 'image';
        if (mimeType.startsWith('audio/')) return 'audio';
        return '';
    }

    // The extension shown on the generic file icon when there's no richer preview
    // for a type (a .docx, .zip, .py, ...). Capped at 4 chars so it still fits the
    // icon glyph — long "extensions" past that are usually not real extensions
    // (a dotted version number, a filename with no extension at all) anyway.
    fileExtensionLabel(name) {
        const clean = String(name || '').trim();
        const dot = clean.lastIndexOf('.');
        if (dot <= 0 || dot === clean.length - 1) return '';
        return clean.slice(dot + 1).toUpperCase().slice(0, 4);
    }

    renderFileIcon(name) {
        const ext = this.fileExtensionLabel(name);
        return `<span class="file-icon" aria-hidden="true">${ext ? this.esc(ext) : ''}</span>`;
    }

    normalizeAttachment(att = {}) {
        const mimeType = att.mimeType || att.mime_type || '';
        // Stickers override an incoming `kind` on purpose: a peer that predates
        // .tgs support labels them 'file', and honouring that would render an
        // animated sticker as a download chip.
        const kind = this.isStickerAttachment(att)
            ? 'sticker'
            : (att.kind || this.attachmentKindFor(att) || 'file');
        return {
            id: att.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: att.name || 'attachment',
            mimeType,
            kind,
            size: Number(att.size || 0),
            dataUrl: att.dataUrl || att.data_url || att.url || '',
            archivePath: att.archivePath || att.archive_path || '',
        };
    }

    normalizeAttachments(attachments) {
        return Array.isArray(attachments) ? attachments.map(att => this.normalizeAttachment(att)) : [];
    }

    formatFileSize(bytes) {
        const size = Number(bytes || 0);
        if (!Number.isFinite(size) || size <= 0) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        let value = size;
        let unitIndex = 0;
        while (value >= 1024 && unitIndex < units.length - 1) {
            value /= 1024;
            unitIndex += 1;
        }
        const precision = unitIndex === 0 ? 0 : value < 10 ? 1 : 0;
        return `${value.toFixed(precision)} ${units[unitIndex]}`;
    }

    inferMimeType(file) {
        if (file && file.type) return file.type;
        const name = (file && file.name || '').toLowerCase();
        if (name.endsWith('.png')) return 'image/png';
        if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
        if (name.endsWith('.webp')) return 'image/webp';
        if (name.endsWith('.gif')) return 'image/gif';
        if (name.endsWith('.mp4')) return 'video/mp4';
        if (name.endsWith('.webm')) return 'video/webm';
        // The OS has no mapping for .tgs, so `file.type` arrives empty and the
        // extension is the only signal. Stamping the real type here is what lets
        // the receiving side recognise the sticker without re-sniffing the name.
        if (name.endsWith('.tgs')) return window.ZaliTgs?.TGS_MIME || 'application/x-tgsticker';
        return 'application/octet-stream';
    }

    fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(reader.error || new Error('Не удалось прочитать файл'));
            reader.readAsDataURL(file);
        });
    }

    async fileToAttachment(file) {
        const mimeType = this.inferMimeType(file);
        const kind = this.attachmentKindFor({ name: file.name, mimeType }) || 'file';
        const dataUrl = await this.fileToDataUrl(file);
        return this.normalizeAttachment({
            name: file.name,
            mimeType,
            kind,
            size: file.size,
            dataUrl,
        });
    }

    async handleFiles(fileList) {
        const files = Array.from(fileList || []);
        if (files.length === 0) return;
        const attachments = await Promise.all(files.map(file => this.fileToAttachment(file)));
        this.S.draftAttachments = this.S.draftAttachments.concat(attachments);
        this.renderDraftAttachments();
        this.updateSendButtonState();
    }

    clearDraftAttachments() {
        this.S.draftAttachments = [];
        this.renderDraftAttachments();
        this.updateSendButtonState();
    }

    renderDraftAttachments() {
        const wrap = document.getElementById('draftAttachments');
        if (!wrap) return;

        if (!this.S.draftAttachments.length) {
            wrap.innerHTML = '';
            wrap.classList.remove('has-items');
            // Reaps the sticker animation that was just detached, so its rAF loop
            // stops instead of running against an orphaned node.
            window.ZaliTgs?.hydrate(wrap);
            return;
        }

        wrap.classList.add('has-items');
        wrap.innerHTML = this.S.draftAttachments.map(att => {
            const thumb = this.renderAttachmentPreview(att, true);
            return `<div class="draft-att" data-att-id="${this.esc(att.id)}">
                <button class="draft-att-remove" type="button" data-att-id="${this.esc(att.id)}" title="Удалить вложение">×</button>
                ${thumb}
                <div class="draft-att-name">${this.esc(att.name)}</div>
            </div>`;
        }).join('');

        window.ZaliTgs?.hydrate(wrap);
    }

    resizeComposer() {
        const inp = document.getElementById('msgInput');
        if (!inp) return;
        inp.style.height = 'auto';
        inp.style.height = `${Math.min(inp.scrollHeight, 140)}px`;
    }

    extractUrls(text) {
        if (!text) return [];
        const re = /https?:\/\/[^\s<>()"]+/gi;
        return String(text).match(re) || [];
    }

    isTenorUrl(url) {
        try {
            const u = new URL(url);
            return /(^|\.)tenor\.com$/.test(u.hostname) || /(^|\.)media\d*\.tenor\.com$/.test(u.hostname) || /(^|\.)c\.tenor\.com$/.test(u.hostname);
        } catch (e) {
            return false;
        }
    }

    tenorCacheKey(url) {
        return `tenor:${url}`;
    }

    requestTenorResolution(url) {
        const key = this.tenorCacheKey(url);
        if (this.tenorCache.has(key) || this.tenorPending.has(key)) return;
        this.tenorPending.add(key);

        if (this.nativeSupports('tenor')) {
            this.postNativeMessage({
                type: NativeMessageTypes.RESOLVE_TENOR,
                url,
                requestId: key,
            });
        } else {
            this.tenorPending.delete(key);
        }
    }

    onTenorResolved(payload) {
        let data = payload;
        if (typeof payload === 'string') {
            try {
                data = JSON.parse(payload);
            } catch (e) {
                return;
            }
        }

        if (!data || !data.sourceUrl) return;
        const key = this.tenorCacheKey(data.sourceUrl);
        this.tenorPending.delete(key);

        if (data.mediaUrl) {
            this.tenorCache.set(key, {
                mediaUrl: data.mediaUrl,
                mimeType: data.mimeType || '',
                kind: data.kind || '',
            });
            this.scheduleRenderMessages();
            this.renderContacts();
        }
    }

    isDirectMediaUrl(url) {
        try {
            const u = new URL(url);
            return /\.(gif|png|jpe?g|webp|mp4|webm)(\?.*)?$/i.test(u.pathname);
        } catch (e) {
            return false;
        }
    }

    renderMessageText(text) {
        const urls = this.extractUrls(text);
        if (!urls.length) {
            return this.esc(text).replace(/\n/g, '<br>');
        }

        const escaped = this.esc(text).replace(/\n/g, '<br>');
        return escaped.replace(/https?:\/\/[^\s<>()"]+/gi, (match) => {
            const rawUrl = match.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"');
            const safeHref = this.esc(rawUrl);
            return `<a href="${safeHref}" target="_blank" rel="noopener noreferrer">${match}</a>`;
        });
    }

    mediaShellStyle(src, { gifLike = false, fallbackAspectRatio = '16 / 9' } = {}) {
        if (gifLike) return '';
        const cached = src ? this.mediaSizeCache.get(src) : null;
        const width = Number(cached?.width || 0);
        const height = Number(cached?.height || 0);
        const ratio = width > 0 && height > 0 ? `${width} / ${height}` : fallbackAspectRatio;
        return ratio ? ` style="aspect-ratio: ${ratio};"` : '';
    }

    safeAttachmentUrl(url) {
        const value = String(url || '').trim();
        if (!value) return '';
        if (/^(data|blob):/i.test(value)) return value;
        try {
            const parsed = new URL(value, window.location.href);
            return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : '';
        } catch (e) {
            return '';
        }
    }

    renderAttachmentPreview(att, compact = false, options = {}) {
        const attachment = this.normalizeAttachment(att);
        const src = this.safeAttachmentUrl(attachment.dataUrl || attachment.url || '');
        const gifLike = !!options.gifLike || attachment.kind === 'gif' || attachment.mimeType === 'image/gif';
        const showControls = options.controls !== undefined ? !!options.controls : !gifLike;
        if (!src) {
            return `<div class="media-unknown">${this.esc(attachment.name)}</div>`;
        }

        // Animated stickers are decoded and played by web/src/modules/tgs.js after
        // the message list is in the DOM — all this renders is the stage plus a
        // download link that stays hidden unless the animation fails to load.
        if (attachment.kind === 'sticker') {
            const sizeLabel = this.formatFileSize(attachment.size);
            return `<div class="media media-sticker${compact ? ' compact' : ''}" data-tgs-src="${this.esc(src)}">
                <div class="media-sticker-stage" aria-label="${this.esc(attachment.name)}" role="img"></div>
                <a class="file-chip media-sticker-fallback${compact ? ' compact' : ''}" href="${this.esc(src)}" download="${this.esc(attachment.name)}" hidden>
                    <span class="file-chip-name">${this.esc(attachment.name)}</span>
                    <span class="file-chip-size">${this.esc(sizeLabel)}</span>
                </a>
            </div>`;
        }

        if (attachment.kind === 'video' || (attachment.mimeType || '').startsWith('video/')) {
            const shellClass = `discord-media-shell discord-media-shell-video${gifLike ? ' discord-media-shell-gif' : ''}${compact ? ' compact' : ''}`;
            const shellStyle = this.mediaShellStyle(src, { gifLike });
            return `<div class="${shellClass}"${shellStyle}>
                <video class="media media-video${compact ? ' compact' : ''}${gifLike ? ' media-gif-like' : ''}" data-gif-like="${gifLike ? '1' : '0'}" src="${this.esc(src)}"${showControls ? ' controls' : ''} autoplay loop muted playsinline preload="${gifLike ? 'auto' : 'metadata'}"></video>
            </div>`;
        }

        if (attachment.kind === 'gif' || attachment.mimeType === 'image/gif' || (attachment.mimeType || '').startsWith('image/')) {
            const gifClass = gifLike ? ' media-gif-like' : '';
            const shellGifClass = gifLike ? ' discord-media-shell-gif' : '';
            const shellStyle = this.mediaShellStyle(src, { gifLike });
            return `<div class="discord-media-shell discord-media-shell-image${shellGifClass}${compact ? ' compact' : ''}"${shellStyle}>
                <img class="media media-img${compact ? ' compact' : ''}${gifClass}" src="${this.esc(src)}" alt="${this.esc(attachment.name)}" loading="lazy" decoding="async" fetchpriority="low">
            </div>`;
        }

        // Audio has no visual frame to preview, but it's the one remaining kind
        // that can still play inline rather than falling back to a download link.
        if (attachment.kind === 'audio' || (attachment.mimeType || '').startsWith('audio/')) {
            const sizeLabel = this.formatFileSize(attachment.size);
            return `<div class="media-audio${compact ? ' compact' : ''}">
                <audio class="media-audio-player" controls preload="metadata" src="${this.esc(src)}"></audio>
                <div class="media-audio-meta">
                    <span class="media-audio-name">${this.esc(attachment.name)}</span>
                    <span class="media-audio-size">${this.esc(sizeLabel)}</span>
                </div>
            </div>`;
        }

        // No format-specific preview (a .pdf, .docx, .zip, ...) — a neutral icon
        // carrying the extension stands in for one, same idea as Telegram/Slack's
        // file glyphs, so the type is readable at a glance instead of only in the
        // filename text.
        const sizeLabel = this.formatFileSize(attachment.size);
        const fileIcon = this.renderFileIcon(attachment.name);
        if (compact) {
            // No name here: this is only ever used by the draft-attachment
            // thumbnail, which already prints the filename underneath
            // (.draft-att-name) — repeating it inside the chip too just wrapped
            // ugly in the narrow thumbnail.
            return `<a class="file-chip${compact ? ' compact' : ''}" href="${this.esc(src)}" download="${this.esc(attachment.name)}">
                ${fileIcon}
                <span class="file-chip-size">${this.esc(sizeLabel)}</span>
            </a>`;
        }

        return `<a class="file-message" href="${this.esc(src)}" download="${this.esc(attachment.name)}">
            ${fileIcon}
            <span class="file-message-info">
                <span class="file-message-name">${this.esc(attachment.name)}</span>
                <span class="file-message-size">${this.esc(sizeLabel)}</span>
            </span>
        </a>`;
    }
});
