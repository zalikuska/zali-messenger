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

    // The URL an attachment is RENDERED with. A `data:` URL is swapped for a
    // `blob:` one once and reused from then on.
    //
    // This is not micro-tuning. The native shells hand attachments to the WebView
    // as `data:` URLs (WebView.swift makeDataURL / native/util.rs make_data_url),
    // and that value used to go straight into the message-list HTML. Measured on a
    // 60-message conversation with 6 MB of photos: the rendered string was 10.5 MB
    // for 1070 characters of text, all of it base64 — scanned five times by esc()
    // on the way in and held a second time in _lastMessagesHTML. A `blob:` URL is
    // ~40 characters, and unlike a data: URL rebuilt from scratch on each
    // innerHTML write, the browser can reuse the image it already decoded behind
    // it, so media stops flickering on unrelated re-renders. See
    // scripts/perf_doctor.
    //
    // Called from renderAttachmentPreview() and nowhere else, deliberately: doing
    // it in normalizeAttachment() would also fire from saveStoredMessageCache(),
    // which walks EVERY attachment of EVERY conversation and would then hold a
    // Blob copy of an archive most of which is not on screen and may never be.
    //
    // Keyed by the payload string rather than by the attachment object: the same
    // photo appears as several distinct objects (state, a normalised copy, an
    // outbox entry), and one decoded copy should serve all of them.
    attachmentDisplayUrl(rawUrl) {
        const value = String(rawUrl || '');
        if (!value.startsWith('data:')) return value;
        if (!this._attachmentBlobUrls) this._attachmentBlobUrls = new Map();
        if (!this._attachmentBlobPayloads) this._attachmentBlobPayloads = new Map();
        const cached = this._attachmentBlobUrls.get(value);
        if (cached) return cached;
        let size = null;
        const blob = this.dataUrlToBlob(value, {
            onBytes: (bytes, mimeType) => {
                if (/^image\//i.test(mimeType)) size = this.imageSizeFromBytes(bytes);
            },
        });
        if (!blob) return value;
        let url;
        try {
            url = URL.createObjectURL(blob);
        } catch (e) {
            return value;
        }
        this._attachmentBlobUrls.set(value, url);
        // Размер картинки известен до её загрузки: рамка (mediaShellStyle) и <img>
        // (width/height) с первой же отрисовки нужной формы. Раньше кеш размеров
        // заполнялся только после декодирования и жил в памяти — после каждого запуска
        // любая картинка сначала стояла в рамке 16:9, а потом прыгала до своей формы.
        if (size) this.mediaSizeCache.set(url, size);
        // Reverse lookup: the native download bridge needs the payload back — see
        // downloadAttachmentFromHref().
        this._attachmentBlobPayloads.set(url, value);
        return url;
    }

    normalizeAttachment(att = {}) {
        // Already normalised — hand it straight back. renderMessageBody() maps an
        // array that normalizeAttachments() has just produced, and
        // renderAttachmentPreview() normalises each element again, so every
        // attachment was rebuilt (and its sticker-detection regex re-run) one
        // extra time per bubble per frame.
        if (att && att.__zaliNormalizedShape === true) return att;
        const mimeType = att.mimeType || att.mime_type || '';
        // Stickers override an incoming `kind` on purpose: a peer that predates
        // .tgs support labels them 'file', and honouring that would render an
        // animated sticker as a download chip.
        const kind = this.isStickerAttachment(att)
            ? 'sticker'
            : (att.kind || this.attachmentKindFor(att) || 'file');
        const dataUrl = att.dataUrl || att.data_url || att.url || '';
        const normalized = {
            id: att.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: att.name || 'attachment',
            mimeType,
            kind,
            size: Number(att.size || 0),
            // The payload. Sending, editing, persistence and the renderer all
            // read this one; the renderer passes it through
            // attachmentDisplayUrl() first.
            dataUrl,
            archivePath: att.archivePath || att.archive_path || '',
        };
        // Non-enumerable: this object is spread into the persisted cache and into
        // the native bridge payload, and the marker has no business in either.
        Object.defineProperty(normalized, '__zaliNormalizedShape', { value: true });
        return normalized;
    }

    // Memoised against the exact array it was given. Rendering one message calls
    // this three times — messageHasMedia(), messageIsGifOnly()/
    // messageIsImageCaption() and renderMessageBody() each normalise the same
    // attachments independently — so every bubble used to rebuild its attachment
    // objects and re-run the sticker-detection regex three times per frame.
    //
    // The cache is validated, not trusted: it is discarded unless every source
    // object and every payload string is still the identical reference. That
    // covers the one in-place mutation that exists (restoreAttachmentPayloads
    // filling `dataUrl` back in at load time) without needing to know about it.
    normalizeAttachments(attachments) {
        if (!Array.isArray(attachments)) return [];
        if (!attachments.length) return [];
        const cached = attachments.__zaliNormalized;
        if (cached
            && cached.raw.length === attachments.length
            && cached.raw.every((att, i) => att === attachments[i] && cached.payloads[i] === (attachments[i]?.dataUrl || attachments[i]?.data_url || attachments[i]?.url || ''))) {
            return cached.value;
        }
        const value = attachments.map(att => this.normalizeAttachment(att));
        try {
            Object.defineProperty(attachments, '__zaliNormalized', {
                value: {
                    raw: attachments.slice(),
                    payloads: attachments.map(att => att?.dataUrl || att?.data_url || att?.url || ''),
                    value,
                },
                writable: true,
                configurable: true,
                enumerable: false,
            });
        } catch (e) { /* frozen array — just skip the memo */ }
        return value;
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
        const name = (file && file.name || '').toLowerCase();
        // .tgs — раньше file.type: файловые провайдеры Android отдают его как
        // application/octet-stream или application/gzip, и стикер уходил бы файлом.
        if (name.endsWith('.tgs')) return window.ZaliTgs?.TGS_MIME || 'application/x-tgsticker';
        if (file && file.type) return file.type;
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
        const all = Array.from(fileList || []);
        if (all.length === 0) return;
        // Стикер .tgs — как в Telegram: уходит сразу отдельным сообщением, без
        // карточки над полем ввода и кнопки «Отправить». Остальное — в черновик.
        const isSticker = (file) => this.isStickerAttachment({ name: file?.name, mimeType: file?.type });
        const stickers = all.filter(isSticker);
        const files = all.filter(file => !isSticker(file));
        for (const file of stickers) {
            try {
                const attachment = await this.fileToAttachment(file);
                await this.sendInputMessage({ attachments: [attachment] });
            } catch (e) {
                this.addLogEntry?.({ type: 'WARN', msg: `Стикер не отправлен: ${e?.message || e}`, ts: new Date().toLocaleTimeString() });
            }
        }
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

    // `typing: true` — вызов из обработчика ввода. Высоту нужно сбрасывать в auto,
    // только когда текст мог стать короче: сброс сжимает поле до одной строки, и
    // чтение scrollHeight следом заставляет браузер разложить колонку чата в
    // этом промежуточном состоянии — раскладка на каждое нажатие клавиши, а на
    // телефоне поле стоит в потоке и тянет за собой высоту ленты. Пока текст
    // растёт, scrollHeight и без сброса не меньше нужной высоты.
    resizeComposer({ typing = false } = {}) {
        const inp = document.getElementById('msgInput');
        if (!inp) return;
        const value = inp.value;
        const length = value.length;
        let breaks = 0;
        for (let i = value.indexOf('\n'); i !== -1; i = value.indexOf('\n', i + 1)) breaks += 1;
        // «Вырос» — стало не короче и не меньше переносов (замена выделенных
        // пустых строк текстом длиннее их самих делает поле ниже).
        // Пустое поле всегда меряется заново: иначе высота, оставшаяся от прошлого текста
        // (62 px от двух строк), держится на пустом поле — плейсхолдер уезжает вверх.
        const grew = typing && length > 0 && !!inp.style.height
            && length >= (this._composerTextLength || 0)
            && breaks >= (this._composerTextBreaks || 0);
        this._composerTextLength = length;
        this._composerTextBreaks = breaks;
        if (!grew) inp.style.height = 'auto';
        const scrollHeight = inp.scrollHeight;
        const cap = this.composerMaxHeight(inp);
        const h = Math.min(scrollHeight, cap);
        inp.style.height = `${h}px`;
        // Прокрутка только когда текст реально не влезает (иначе 1px-округление даёт лишний скролл).
        inp.style.overflowY = scrollHeight > cap + 1 ? 'auto' : 'hidden';
        this.alignComposerScroll(inp);
    }

    // Прокрутка поля: без переполнения — к началу; с переполнением — к началу строки.
    // Текст начинается после padding-top, поэтому границы строк — padTop + k·lineHeight.
    // Браузер двигает scrollTop на каретку уже после обработчика input (Backspace
    // давал 11,5 px и текст уходил вверх), поэтому выравнивание повторяется в следующем кадре.
    alignComposerScroll(inp) {
        const snap = () => {
            const max = inp.scrollHeight - inp.clientHeight;
            if (max <= 0) {
                if (inp.scrollTop) inp.scrollTop = 0;
                return;
            }
            const cs = getComputedStyle(inp);
            const lineHeight = parseFloat(cs.lineHeight);
            const padTop = parseFloat(cs.paddingTop) || 0;
            const top = Math.min(inp.scrollTop, max);
            if (lineHeight > 0) {
                const target = top < padTop ? 0 : padTop + Math.floor((top - padTop) / lineHeight) * lineHeight;
                if (target !== inp.scrollTop) inp.scrollTop = target;
            }
        };
        snap();
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(snap);
    }

    // Потолок поля — целое число строк. Жёсткие 140px при строке 22px и отступах
    // 9+9 на телефоне давали 5,5 строки: на шестой строке поле упиралось в
    // потолок с полосой прокрутки и обрезанной посередине строкой (на десктопе —
    // 6,2 строки). Стили к этому моменту уже посчитаны чтением scrollHeight,
    // так что getComputedStyle лишней раскладки не добавляет.
    composerMaxHeight(inp) {
        const fallback = 140;
        let cs;
        try { cs = getComputedStyle(inp); } catch (e) { return fallback; }
        const lineHeight = parseFloat(cs.lineHeight);
        const limit = parseFloat(cs.maxHeight) || fallback;
        if (!(lineHeight > 0)) return limit;
        const chrome = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
            + (cs.boxSizing === 'border-box'
                ? (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
                : 0);
        const lines = Math.max(1, Math.floor((limit - chrome + 0.5) / lineHeight));
        return chrome + lines * lineHeight;
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

    /**
     * Размер картинки из заголовка файла, без декодирования: PNG, GIF, WebP, BMP и JPEG
     * (с поворотом из EXIF — браузер рисует снимок с телефона повёрнутым, и
     * naturalWidth/naturalHeight тоже уже повёрнутые). { width, height } или null.
     */
    imageSizeFromBytes(b) {
        if (!b || b.length < 24) return null;
        const ok = (w, h) => (w > 0 && h > 0 && w < 100000 && h < 100000 ? { width: w, height: h } : null);
        const u16be = (i) => (b[i] << 8) | b[i + 1];
        const u32be = (i) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
        const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
        // PNG: подпись + IHDR.
        if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return ok(u32be(16), u32be(20));
        // GIF87a/89a.
        if (ascii(0, 4) === 'GIF8') return ok(b[6] | (b[7] << 8), b[8] | (b[9] << 8));
        // BMP.
        if (b[0] === 0x42 && b[1] === 0x4D) {
            const w = b[18] | (b[19] << 8) | (b[20] << 16) | (b[21] << 24);
            const h = b[22] | (b[23] << 8) | (b[24] << 16) | (b[25] << 24);
            return ok(Math.abs(w), Math.abs(h));
        }
        // WebP: VP8 / VP8L / VP8X.
        if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP' && b.length >= 30) {
            const chunk = ascii(12, 4);
            if (chunk === 'VP8 ') return ok((b[26] | (b[27] << 8)) & 0x3FFF, (b[28] | (b[29] << 8)) & 0x3FFF);
            if (chunk === 'VP8L') {
                return ok(1 + (((b[22] & 0x3F) << 8) | b[21]), 1 + (((b[24] & 0x0F) << 10) | (b[23] << 2) | ((b[22] & 0xC0) >> 6)));
            }
            if (chunk === 'VP8X') return ok(1 + (b[24] | (b[25] << 8) | (b[26] << 16)), 1 + (b[27] | (b[28] << 8) | (b[29] << 16)));
            return null;
        }
        // JPEG: идём по сегментам до SOFn, по пути читаем ориентацию из EXIF (APP1).
        if (b[0] === 0xFF && b[1] === 0xD8) {
            let i = 2;
            let orientation = 1;
            while (i + 9 < b.length) {
                if (b[i] !== 0xFF) { i += 1; continue; }
                const marker = b[i + 1];
                if (marker === 0xFF) { i += 1; continue; }
                if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
                const len = u16be(i + 2);
                if (len < 2) return null;
                if (marker === 0xE1 && ascii(i + 4, 4) === 'Exif') orientation = this.jpegExifOrientation(b, i + 10, len - 8) || orientation;
                if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
                    const h = u16be(i + 5);
                    const w = u16be(i + 7);
                    return orientation >= 5 && orientation <= 8 ? ok(h, w) : ok(w, h);
                }
                if (marker === 0xDA) return null;
                i += 2 + len;
            }
        }
        return null;
    }

    /** Ориентация из TIFF-блока EXIF (тег 0x0112), начинающегося с байта start. */
    jpegExifOrientation(b, start, length) {
        const end = Math.min(b.length, start + Math.max(0, length));
        if (start + 8 > end) return 0;
        const little = b[start] === 0x49 && b[start + 1] === 0x49;
        if (!little && !(b[start] === 0x4D && b[start + 1] === 0x4D)) return 0;
        const u16 = (i) => (little ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
        const u32 = (i) => (little
            ? (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16)) + (b[i + 3] << 24 >>> 0)
            : ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3]);
        const ifd = start + u32(start + 4);
        if (ifd + 2 > end) return 0;
        const count = u16(ifd);
        for (let k = 0; k < count; k += 1) {
            const entry = ifd + 2 + k * 12;
            if (entry + 12 > end) return 0;
            if (u16(entry) === 0x0112) return u16(entry + 8);
        }
        return 0;
    }

    mediaShellStyle(src, { gifLike = false, fallbackAspectRatio = '16 / 9' } = {}) {
        if (gifLike) return '';
        const cached = src ? this.mediaSizeCache.get(src) : null;
        const width = Number(cached?.width || 0);
        const height = Number(cached?.height || 0);
        const ratio = width > 0 && height > 0 ? `${width} / ${height}` : fallbackAspectRatio;
        return ratio ? ` style="aspect-ratio: ${ratio};"` : '';
    }

    // Свой API-сервер и CDN Tenor — туда клиент и так ходит сам.
    isTrustedAttachmentHost(url) {
        try {
            const host = new URL(url, window.location.href).hostname.toLowerCase();
            if (host === window.location.hostname.toLowerCase()) return true;
            try {
                const apiHost = new URL(this.getApiBaseUrl()).hostname.toLowerCase();
                if (apiHost && host === apiHost) return true;
            } catch (e) {}
            return host === 'tenor.com' || host.endsWith('.tenor.com');
        } catch (e) {
            return false;
        }
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
        // Through attachmentDisplayUrl(): the payload never belongs in the markup.
        const src = this.safeAttachmentUrl(
            this.attachmentDisplayUrl(attachment.dataUrl || attachment.url || ''),
        );
        const gifLike = !!options.gifLike || attachment.kind === 'gif' || attachment.mimeType === 'image/gif';
        const showControls = options.controls !== undefined ? !!options.controls : !gifLike;
        if (!src) {
            return `<div class="media-unknown">${this.esc(attachment.name)}</div>`;
        }

        // Вложение из архива сообщения, указывающее на чужой http(s)-адрес, сам не
        // грузим: <img>/<video> сходили бы туда при одном показе переписки и выдали
        // отправителю IP получателя и момент прочтения. Настоящие вложения приезжают
        // внутри архива (data:/blob:). Ссылки из текста (renderUrlPreview) — отдельный
        // случай: адрес там виден в самом сообщении, они передают trustedRemote.
        if (!options.trustedRemote && /^https?:/i.test(src) && !this.isTrustedAttachmentHost(src)) {
            return `<a class="file-message" href="${this.esc(src)}" target="_blank" rel="noopener noreferrer">
            ${this.renderFileIcon(attachment.name)}
            <span class="file-message-info">
                <span class="file-message-name">${this.esc(attachment.name)}</span>
                <span class="file-message-size">${this.esc(src)}</span>
            </span>
        </a>`;
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
            // autoplay/loop/muted belong to gif-like clips only. They used to be
            // set unconditionally, so every ordinary video message in the window
            // decoded and looped at once, forever, whether or not anyone had
            // asked it to play — and, being muted by default, an actual video
            // also started silent. A real video now waits for the play button.
            const gifPlayback = gifLike ? ' autoplay loop muted' : '';
            return `<div class="${shellClass}"${shellStyle}>
                <video class="media media-video${compact ? ' compact' : ''}${gifLike ? ' media-gif-like' : ''}" data-gif-like="${gifLike ? '1' : '0'}" src="${this.esc(src)}"${showControls ? ' controls' : ''}${gifPlayback} playsinline preload="${gifLike ? 'auto' : 'metadata'}"></video>
            </div>`;
        }

        if (attachment.kind === 'gif' || attachment.mimeType === 'image/gif' || (attachment.mimeType || '').startsWith('image/')) {
            const gifClass = gifLike ? ' media-gif-like' : '';
            const shellGifClass = gifLike ? ' discord-media-shell-gif' : '';
            const shellStyle = this.mediaShellStyle(src, { gifLike });
            // width/height — пропорции до загрузки: и у рамки фото, и у GIF без рамки
            // (там размер задаёт сама картинка, и до загрузки она была 0×0).
            const known = this.mediaSizeCache.get(src);
            let sizeAttrs = '';
            if (known) {
                const w = Math.round(known.width);
                const h = Math.round(known.height);
                // Ширина задаётся явно: пузырь подстраивается под содержимое, а CSS даёт
                // картинке width: 100% от него же — до загрузки ширину брать было неоткуда,
                // строка схлопывалась в полоску (26 px вместо 640) и прыгала при загрузке.
                // Натуральная ширина + max-width: 100% дают ровно ту ширину, что и после
                // загрузки. GIF без рамки — тот же предел, что в CSS (360 px / 72vw по
                // ширине, 340 px по высоте), иначе ограничение по высоте исказило бы рамку.
                const width = gifLike
                    ? `min(${w}px, 360px, 72vw, ${(340 * w / h).toFixed(1)}px)`
                    : `${w}px`;
                sizeAttrs = ` width="${this.esc(String(w))}" height="${this.esc(String(h))}" style="width: ${this.esc(width)};"`;
            }
            // Картинка из памяти (data:/blob:) — без ленивой загрузки и пониженного
            // приоритета: качать нечего, а «лениво» значило «нарисую, когда доскроллишь» —
            // фото проявлялись уже на экране.
            const inMemory = /^(blob|data):/i.test(src);
            const loadAttrs = inMemory ? '' : ' loading="lazy" decoding="async" fetchpriority="low"';
            return `<div class="discord-media-shell discord-media-shell-image${shellGifClass}${compact ? ' compact' : ''}"${shellStyle}>
                <img class="media media-img${compact ? ' compact' : ''}${gifClass}" src="${this.esc(src)}" alt="${this.esc(attachment.name)}"${sizeAttrs}${loadAttrs}>
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
