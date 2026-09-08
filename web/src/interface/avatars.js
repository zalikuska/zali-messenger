// --- ZaliInterface: Аватары и ассеты серверов: кэш, загрузка, кроппер, даунскейл. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    avatarCacheKey(username) {
        return String(username || '').trim().toLowerCase();
    }

    loadStoredAvatar(username) {
        const key = this.avatarCacheKey(username);
        return this.avatarCache.has(key) ? this.avatarCache.get(key) : undefined;
    }

    // The single place an avatar enters the cache, and therefore the single
    // place that decides what shape it is kept in.
    //
    // Whatever arrives here is normalised to a blob: URL, because this value is
    // inlined into the markup of every contact row and of every incoming message
    // that opens or closes a group. The native bridge hands avatars over as
    // data: URLs, and one 64 KB avatar measured 30 copies of its own base64 —
    // 2.5 MB — inside a single render of a 60-message conversation. A blob: URL
    // is ~40 characters and, unlike a data: URL rebuilt on each innerHTML write,
    // lets the browser reuse the image it already decoded, so avatars stop
    // blinking on unrelated re-renders. The network branch of
    // ensureAvatarLoaded() has always produced a blob: URL; this makes the
    // native branch agree instead of each caller deciding for itself.
    saveStoredAvatar(username, dataUrl) {
        const key = this.avatarCacheKey(username);
        const next = this.toAvatarObjectUrl(dataUrl);
        const prev = this.avatarCache.get(key);
        if (prev && typeof prev === 'string' && prev.startsWith('blob:') && prev !== next) {
            try { URL.revokeObjectURL(prev); } catch (e) {}
        }
        this.avatarFetchSeq.set(key, (this.avatarFetchSeq.get(key) || 0) + 1);
        this.avatarCache.set(key, next || null);
    }

    toAvatarObjectUrl(value) {
        const source = String(value || '');
        if (!source.startsWith('data:')) return value;
        const blob = this.dataUrlToBlob(source);
        if (!blob) return value;
        try {
            return URL.createObjectURL(blob);
        } catch (e) {
            return value;
        }
    }

    clearStoredAvatar(username) {
        const key = this.avatarCacheKey(username);
        const prev = this.avatarCache.get(key);
        if (prev && typeof prev === 'string' && prev.startsWith('blob:')) {
            try { URL.revokeObjectURL(prev); } catch (e) {}
        }
        this.avatarFetchSeq.set(key, (this.avatarFetchSeq.get(key) || 0) + 1);
        this.avatarCache.delete(key);
    }

    avatarFallback(username) {
        const value = String(username || '').trim();
        return value ? value[0].toUpperCase() : 'Z';
    }

    renderAvatarHTML(username, className = 'ava', alt = '') {
        const src = this.loadStoredAvatar(username);
        const fallback = this.avatarFallback(username);
        const safeAlt = this.esc(alt || username || fallback);
        if (src === undefined) {
            this.ensureAvatarLoaded(username);
        } else if (src) {
            const classes = String(className || '')
                .split(/\s+/)
                .filter(Boolean)
                .concat('avatar-img')
                .filter((v, i, arr) => arr.indexOf(v) === i)
                .join(' ');
            return `<img class="${classes}" src="${this.esc(src)}" alt="${safeAlt}">`;
        }
        return `<span class="avatar-fallback">${this.esc(fallback)}</span>`;
    }

    serverAssetCacheKey(serverId, kind) {
        return `${String(serverId || '').trim()}:${kind}`;
    }

    async loadServerAsset(serverId, kind, { force = false } = {}) {
        const sid = String(serverId || '').trim();
        if (!sid) return null;
        const key = this.serverAssetCacheKey(sid, kind);
        if (!force && this.serverAssetCache.has(key)) {
            return this.serverAssetCache.get(key);
        }
        if (this.serverAssetRequests.has(key) && !force) {
            return this.serverAssetRequests.get(key);
        }

        const seq = (this.serverAssetFetchSeq.get(key) || 0) + 1;
        this.serverAssetFetchSeq.set(key, seq);

        const request = (async () => {
            try {
                // Binary body — see TRANSFER_REQUEST_TIMEOUT_MS.
                const res = await this.apiFetch(this.apiRoutes.servers.assets(sid, kind), {
                    timeoutMs: TRANSFER_REQUEST_TIMEOUT_MS,
                });
                if (this.serverAssetFetchSeq.get(key) !== seq) return null;
                if (res.status === 404) {
                    this.serverAssetCache.set(key, null);
                    return null;
                }
                if (!res.ok) return null;
                const blob = await res.blob();
                if (!blob || blob.size === 0) {
                    this.serverAssetCache.set(key, null);
                    return null;
                }
                const url = await this.blobToObjectUrl(blob);
                this.serverAssetCache.set(key, url);
                return url;
            } catch (e) {
                return null;
            } finally {
                if (this.serverAssetRequests.get(key) === request) {
                    this.serverAssetRequests.delete(key);
                }
            }
        })();

        this.serverAssetRequests.set(key, request);
        return request;
    }

    clearServerAssetCache(serverId, kind) {
        const key = this.serverAssetCacheKey(serverId, kind);
        const prev = this.serverAssetCache.get(key);
        if (prev && typeof prev === 'string' && prev.startsWith('blob:')) {
            try { URL.revokeObjectURL(prev); } catch (e) {}
        }
        this.serverAssetFetchSeq.set(key, (this.serverAssetFetchSeq.get(key) || 0) + 1);
        this.serverAssetCache.delete(key);
    }

    serverAssetFallback(server, kind) {
        if (kind === 'avatar') {
            return this.esc(server?.icon || server?.name?.[0] || 'S');
        }
        return this.esc((server?.name || 'BAN').slice(0, 3).toUpperCase());
    }

    serverAvatarBackground(server) {
        return this.safeCssColor(server?.color) || 'linear-gradient(180deg, #cbff00, #8c8c8c)';
    }

    // Shared by the server rail, the public-servers modal, and the chat header —
    // those used to fall back to the icon/color forever and never rendered the
    // uploaded server avatar image; only the settings-modal preview did.
    serverAvatarInnerHTML(server) {
        const id = String(server?.id || '').trim();
        const fallback = () => this.esc(server?.icon || server?.name?.[0] || 'S');
        if (!id) return fallback();
        const key = this.serverAssetCacheKey(id, 'avatar');
        if (!this.serverAssetCache.has(key)) {
            this.loadServerAsset(id, 'avatar').then(() => this.scheduleServerAssetRefresh());
            return fallback();
        }
        const cached = this.serverAssetCache.get(key);
        return cached
            ? `<img class="avatar-img" src="${this.esc(cached)}" alt="${this.esc(server?.name || '')}">`
            : fallback();
    }

    renderServerAvatarHTML(server, extraClass = '') {
        const classes = `server-avatar${extraClass ? ` ${extraClass}` : ''}`;
        return `<span class="${classes}" style="background:${this.serverAvatarBackground(server)}">${this.serverAvatarInnerHTML(server)}</span>`;
    }

    scheduleServerAssetRefresh() {
        if (this.serverAssetRefreshScheduled) return;
        this.serverAssetRefreshScheduled = true;
        requestAnimationFrame(() => {
            this.serverAssetRefreshScheduled = false;
            this.renderServers();
            this.renderServerToolbar();
        });
    }

    resetServerAssetPreview() {
        const avatarBox = document.getElementById('serverAvatarPreview');
        const bannerBox = document.getElementById('serverBannerPreview');
        if (avatarBox) {
            avatarBox.innerHTML = '';
            avatarBox.style.backgroundImage = '';
            avatarBox.textContent = 'S';
        }
        if (bannerBox) {
            bannerBox.innerHTML = '';
            bannerBox.style.backgroundImage = '';
            bannerBox.style.backgroundSize = '';
            bannerBox.style.backgroundPosition = '';
            bannerBox.textContent = 'BAN';
        }
    }

    async syncServerAssetPreview(serverId) {
        const sid = String(serverId || '').trim();
        const avatar = await this.loadServerAsset(serverId, 'avatar');
        const banner = await this.loadServerAsset(serverId, 'banner');
        const avatarBox = document.getElementById('serverAvatarPreview');
        const bannerBox = document.getElementById('serverBannerPreview');
        const server = (this.S.servers || []).find(item => item.id === sid) || null;
        if (avatarBox) {
            avatarBox.style.backgroundImage = '';
            if (avatar) {
                avatarBox.innerHTML = `<img class="avatar-img" src="${this.esc(avatar)}" alt="server avatar">`;
            } else {
                avatarBox.innerHTML = '';
                avatarBox.textContent = this.serverAssetFallback(server, 'avatar');
            }
        }
        if (bannerBox) {
            if (banner) {
                bannerBox.innerHTML = '';
                bannerBox.style.backgroundImage = `url('${this.esc(banner)}')`;
                bannerBox.style.backgroundSize = 'cover';
                bannerBox.style.backgroundPosition = 'center';
            } else {
                bannerBox.style.backgroundImage = '';
                bannerBox.innerHTML = '';
                bannerBox.textContent = this.serverAssetFallback(server, 'banner');
            }
        }
    }

    scheduleAvatarRefresh() {
        if (this.avatarRefreshScheduled) return;
        this.avatarRefreshScheduled = true;
        requestAnimationFrame(() => {
            this.avatarRefreshScheduled = false;
            this.renderSidebarProfile();
            this.renderContacts();
            // The chat header avatar (own avatar in the empty/DM state, peer avatar in a
            // DM) is rendered by renderServerToolbar; without refreshing it here it keeps
            // the fallback letter it drew before the avatar finished loading async.
            this.renderServerToolbar();
        });
    }

    updateAvatarViews() {
        this.renderSidebarProfile();
        this.renderContacts();
        this.renderServerToolbar();
        this.scheduleRenderMessages();
    }

    refreshVisibleAvatars() {
        if (document.hidden) return;
        if (this.nativeSupports('serverHistory') && this.nativeSupports('voice') && this.nativeSupports('downloadAttachment')) return;
        const users = new Set([this.myName(), this.S.current, ...(this.S.contacts || [])].filter(Boolean));
        document.querySelectorAll('.avatar-img[alt]').forEach(img => {
            const name = String(img.getAttribute('alt') || '').trim();
            if (name) users.add(name);
        });
        users.forEach(username => {
            this.ensureAvatarLoaded(username);
        });
    }

    async blobToObjectUrl(blob) {
        return URL.createObjectURL(blob);
    }

    dataUrlToBlob(dataUrl) {
        const value = String(dataUrl || '').trim();
        if (!value.startsWith('data:')) return null;

        const commaIndex = value.indexOf(',');
        if (commaIndex < 0) return null;

        const meta = value.slice(5, commaIndex);
        const payload = value.slice(commaIndex + 1);
        const parts = meta.split(';').filter(Boolean);
        const mimeType = parts[0] || 'application/octet-stream';
        const isBase64 = parts.includes('base64');

        try {
            if (isBase64) {
                const binary = atob(payload);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i += 1) {
                    bytes[i] = binary.charCodeAt(i);
                }
                return new Blob([bytes], { type: mimeType });
            }

            return new Blob([decodeURIComponent(payload)], { type: mimeType });
        } catch (error) {
            console.error('Failed to decode data URL', error);
            return null;
        }
    }

    async downloadAttachmentFromHref(href, filename) {
        const source = String(href || '').trim();
        const safeName = String(filename || 'attachment').trim() || 'attachment';
        if (!source) return false;

        // Attachments are rendered through a blob: URL (attachmentDisplayUrl), so
        // the href on the link is no longer the payload. The native save bridge
        // wants the payload — recover it from the same map that minted the URL,
        // otherwise a native shell would silently fall through to the browser
        // `<a download>` path, which WKWebView/WebView2 do not honour.
        const nativePayload = source.startsWith('data:')
            ? source
            : (this._attachmentBlobPayloads?.get(source) || '');
        if (this.nativeSupports('downloadAttachment') && nativePayload) {
            this.postNativeMessage({
                type: NativeMessageTypes.DOWNLOAD_ATTACHMENT,
                dataUrl: nativePayload,
                filename: safeName,
            });
            return true;
        }

        let objectUrl = source;
        let shouldRevoke = false;

        try {
            if (source.startsWith('data:')) {
                const blob = this.dataUrlToBlob(source);
                if (!blob || blob.size === 0) {
                    throw new Error('Empty attachment payload');
                }
                objectUrl = URL.createObjectURL(blob);
                shouldRevoke = true;
            } else if (!source.startsWith('blob:')) {
                const response = await fetch(source);
                if (!response.ok) {
                    throw new Error(`Unexpected response while downloading attachment: ${response.status}`);
                }
                const blob = await response.blob();
                if (!blob || blob.size === 0) {
                    throw new Error('Empty attachment payload');
                }
                objectUrl = URL.createObjectURL(blob);
                shouldRevoke = true;
            }

            const link = document.createElement('a');
            link.href = objectUrl;
            link.download = safeName;
            link.rel = 'noopener';
            link.style.display = 'none';
            document.body.appendChild(link);
            link.click();
            link.remove();

            if (shouldRevoke) {
                setTimeout(() => {
                    try { URL.revokeObjectURL(objectUrl); } catch (e) {}
                }, 1000);
            }

            return true;
        } catch (error) {
            console.error('Failed to download attachment', error);
            return false;
        }
    }

    async ensureAvatarLoaded(username, { force = false } = {}) {
        const name = String(username || '').trim();
        if (!name) return null;
        const key = this.avatarCacheKey(name);
        if (!force && this.avatarCache.has(key)) {
            return this.avatarCache.get(key);
        }
        if (this.avatarRequests.has(key)) {
            if (!force) {
                return this.avatarRequests.get(key);
            }
        }

        const seq = (this.avatarFetchSeq.get(key) || 0) + 1;
        this.avatarFetchSeq.set(key, seq);

        const request = (async () => {
            try {
                if (this.nativeSupports('avatarFetch')) {
                    try {
                        const payload = await this.requestNativeAction({
                            type: NativeMessageTypes.LOAD_AVATAR_REQUEST,
                            username: name,
                        });
                        if (this.avatarFetchSeq.get(key) !== seq) {
                            return null;
                        }
                        const dataUrl = String(payload?.data?.dataUrl || '').trim();
                        if (!dataUrl) {
                            this.saveStoredAvatar(name, null);
                            this.scheduleAvatarRefresh();
                            return null;
                        }
                        // saveStoredAvatar() converts the bridge's data: URL to a
                        // blob: one and returns it through the cache — see the
                        // comment there for why the payload must not survive
                        // into the markup.
                        this.saveStoredAvatar(name, dataUrl);
                        this.scheduleAvatarRefresh();
                        return this.loadStoredAvatar(name);
                    } catch (nativeError) {
                        this.trace(`ensureAvatarLoaded native failed username=${name} err=${nativeError?.message || nativeError}`);
                    }
                }

                // Binary body — see TRANSFER_REQUEST_TIMEOUT_MS.
                const res = await this.apiFetch(this.apiRoutes.avatar.byUsername(name), {
                    timeoutMs: TRANSFER_REQUEST_TIMEOUT_MS,
                });
                if (this.avatarFetchSeq.get(key) !== seq) {
                    return null;
                }
                if (res.status === 404) {
                    this.saveStoredAvatar(name, null);
                    this.scheduleAvatarRefresh();
                    return null;
                }
                if (!res.ok) {
                    return null;
                }

                const blob = await res.blob();
                if (this.avatarFetchSeq.get(key) !== seq) {
                    return null;
                }
                if (!blob || blob.size === 0) {
                    this.saveStoredAvatar(name, null);
                    this.scheduleAvatarRefresh();
                    return null;
                }

                const url = await this.blobToObjectUrl(blob);
                if (this.avatarFetchSeq.get(key) !== seq) {
                    try { URL.revokeObjectURL(url); } catch (e) {}
                    return null;
                }
                this.saveStoredAvatar(name, url);
                this.scheduleAvatarRefresh();
                return url;
            } catch (e) {
                return null;
            } finally {
                if (this.avatarRequests.get(key) === request) {
                    this.avatarRequests.delete(key);
                }
            }
        })();

        this.avatarRequests.set(key, request);
        return request;
    }

    renderSidebarProfile() {
        const meName = document.getElementById('meName');
        const meSub = document.getElementById('meSub');
        const meAva = document.getElementById('meAva');
        const avatarPreview = document.getElementById('avatarPreview');
        const username = this.myName();
        if (meName) meName.textContent = username;
        if (meAva) this.setHTMLIfChanged(meAva, this.renderAvatarHTML(username, 'avatar-img', username));
        if (avatarPreview) {
            this.setHTMLIfChanged(avatarPreview, this.renderAvatarHTML(username, 'avatar-img', username));
            avatarPreview.title = `Ваш аватар: ${username}`;
        }
        this.ensureAvatarLoaded(username);
        if (meSub) {
            meSub.innerHTML = this.S.session?.token
                ? '<span class="online-dot"></span> В сети'
                : '<span class="online-dot guest"></span> Гостевой режим';
        }
        this.updateContactControls();
        this.renderContactSuggestions();
        this.updateNavModeButtons();
        this.ensureServersState();
    }

    readFileAsDataURL(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ''));
            reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
            reader.readAsDataURL(file);
        });
    }

    // Shared re-encode-to-JPEG core: iterates dimension/quality attempts down until the
    // encoded bytes fit targetBytes, keeping the largest/best-quality result that fits.
    // Best-effort: returns the original file if the canvas pipeline is unavailable or
    // nothing beats the original size.
    async downscaleImageFile(file, { targetBytes, attempts, baseNameFallback = 'image', traceLabel = 'downscaleImage' }) {
        try {
            if (typeof document === 'undefined' || typeof document.createElement !== 'function') return file;
            const dataUrl = await this.readFileAsDataURL(file);
            const img = await new Promise((resolve, reject) => {
                const im = new Image();
                im.onload = () => resolve(im);
                im.onerror = () => reject(new Error('decode failed'));
                im.src = dataUrl;
            });
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            if (!w || !h) return file;
            const baseName = String(file.name || baseNameFallback).replace(/\.[^.]+$/, '') || baseNameFallback;
            const encode = async (dim, q) => {
                const scale = Math.min(1, dim / Math.max(w, h));
                const cw = Math.max(1, Math.round(w * scale));
                const ch = Math.max(1, Math.round(h * scale));
                const canvas = document.createElement('canvas');
                canvas.width = cw;
                canvas.height = ch;
                const ctx = canvas.getContext('2d');
                if (!ctx) return null;
                ctx.drawImage(img, 0, 0, cw, ch);
                return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', q));
            };
            // Progressively smaller/lower-quality until under budget. Ordered largest→smallest
            // so we keep the best quality that still fits.
            let best = null;
            for (const [dim, q] of attempts) {
                const blob = await encode(dim, q);
                if (!blob || blob.size === 0) continue;
                best = blob;
                if (blob.size <= targetBytes) break;
            }
            if (!best || best.size >= file.size) {
                // Couldn't beat the original (already tiny, or encode unavailable).
                if (best && best.size < file.size) {
                    return new File([best], `${baseName}.jpg`, { type: 'image/jpeg' });
                }
                return file;
            }
            this.trace(`${traceLabel} ${file.size}B -> ${best.size}B`);
            return new File([best], `${baseName}.jpg`, { type: 'image/jpeg' });
        } catch (e) {
            this.trace(`${traceLabel} failed, using original: ${e?.message || e}`);
            return file;
        }
    }

    // Re-encode an avatar to a SMALL JPEG before upload, iterating dimension/quality
    // down until the encoded bytes fit a tight budget (~14 KB). Avatars render as tiny
    // circles, so this costs no visible quality — and it is the difference between the
    // avatar loading or not over a low-MTU / lossy path (e.g. a VPN with MTU 1280):
    // there the server's response stalls once it exceeds roughly the TCP initial window
    // (~12–30 KB with MSS 1240), so a 31 KB avatar never finishes downloading while a
    // ~10 KB one arrives in the first round-trip.
    async downscaleAvatarFile(file, targetBytes = 14 * 1024) {
        const attempts = [[256, 0.8], [224, 0.72], [192, 0.66], [160, 0.62], [128, 0.6], [96, 0.55]];
        return this.downscaleImageFile(file, { targetBytes, attempts, baseNameFallback: 'avatar', traceLabel: 'downscaleAvatar' });
    }

    // Same idea as downscaleAvatarFile but tuned for a wide server banner/cover image
    // instead of a tiny round avatar: much larger max dimension and byte budget, since a
    // banner needs to stay legible at full width. Server avatar/banner uploads used to
    // skip downscaling entirely and PUT the raw picked file (often several MB straight
    // off a camera) as a base64 JSON body through the generic API-request path, which
    // carries a fixed ~8-12s timeout meant for ordinary JSON calls — large enough images
    // (or a slow/VPN-throttled link) blew that budget and surfaced as a raw transport
    // error ("error sending request for url ...") instead of a real upload failure.
    async downscaleServerAssetFile(file, kind) {
        if (kind === 'avatar') {
            const attempts = [[512, 0.82], [384, 0.75], [256, 0.7], [192, 0.65]];
            return this.downscaleImageFile(file, { targetBytes: 60 * 1024, attempts, baseNameFallback: 'server-avatar', traceLabel: 'downscaleServerAvatar' });
        }
        const attempts = [[1600, 0.82], [1280, 0.78], [1024, 0.72], [768, 0.66], [512, 0.6]];
        return this.downscaleImageFile(file, { targetBytes: 300 * 1024, attempts, baseNameFallback: 'server-banner', traceLabel: 'downscaleServerBanner' });
    }

    // Interactive pan/zoom crop before upload. Without this, a fixed center-square
    // crop can slice straight through whatever the source photo happens to frame at
    // its edges (e.g. a vignette/fisheye shot), producing a circle avatar that reads
    // as "cropped into a strange shape" instead of a clean headshot. Resolves to a
    // square JPEG File, or null if the user cancels.
    openAvatarCropper(file) {
        return new Promise((resolve) => {
            const overlay = document.getElementById('avatarCropOverlay');
            const stage = document.getElementById('avatarCropStage');
            const img = document.getElementById('avatarCropImg');
            const circleGuide = document.getElementById('avatarCropCircleGuide');
            const zoomInput = document.getElementById('avatarCropZoom');
            const saveBtn = document.getElementById('avatarCropSaveBtn');
            const cancelBtn = document.getElementById('avatarCropCancelBtn');
            const closeBtn = document.getElementById('avatarCropCloseBtn');
            if (!overlay || !stage || !img || !circleGuide || !zoomInput || !saveBtn || !cancelBtn || !closeBtn) {
                resolve(null);
                return;
            }

            const objectUrl = URL.createObjectURL(file);
            // left/top position the image relative to the SQUARE stage, but coverage
            // is only required over the circle guide inset within it — the ring
            // between circle and stage edge is deliberately allowed to show
            // (dimmed) whatever part of the photo falls outside the crop.
            const state = { scale: 1, minScale: 1, maxScale: 1, left: 0, top: 0, naturalW: 0, naturalH: 0 };
            const listeners = [];
            const on = (el, type, handler, opts) => {
                el.addEventListener(type, handler, opts);
                listeners.push(() => el.removeEventListener(type, handler, opts));
            };

            let settled = false;
            const finish = (result) => {
                if (settled) return;
                settled = true;
                listeners.forEach(off => off());
                overlay.classList.remove('visible');
                setTimeout(() => { overlay.hidden = true; }, 180);
                URL.revokeObjectURL(objectUrl);
                img.removeAttribute('src');
                resolve(result);
            };

            const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

            const circleBounds = () => {
                const stageSize = stage.clientWidth;
                const circleSize = circleGuide.clientWidth || stageSize;
                const margin = (stageSize - circleSize) / 2;
                return { stageSize, circleSize, margin };
            };

            const applyTransform = () => {
                img.style.width = `${state.naturalW * state.scale}px`;
                img.style.height = `${state.naturalH * state.scale}px`;
                img.style.left = `${state.left}px`;
                img.style.top = `${state.top}px`;
            };

            const clampPosition = () => {
                const { circleSize, margin } = circleBounds();
                const displayedW = state.naturalW * state.scale;
                const displayedH = state.naturalH * state.scale;
                state.left = clamp(state.left, margin + circleSize - displayedW, margin);
                state.top = clamp(state.top, margin + circleSize - displayedH, margin);
            };

            const setScale = (nextScale, focalStageX, focalStageY) => {
                const { stageSize } = circleBounds();
                const fx = focalStageX ?? stageSize / 2;
                const fy = focalStageY ?? stageSize / 2;
                const prevScale = state.scale;
                // Keep the point under the focal coordinate stable while zooming.
                const naturalFocalX = (fx - state.left) / prevScale;
                const naturalFocalY = (fy - state.top) / prevScale;
                state.scale = clamp(nextScale, state.minScale, state.maxScale);
                state.left = fx - naturalFocalX * state.scale;
                state.top = fy - naturalFocalY * state.scale;
                clampPosition();
                applyTransform();
            };

            img.onload = () => {
                // Unhide first — stage/circleGuide report clientWidth 0 while
                // display:none, which would collapse every size computed below.
                overlay.hidden = false;

                state.naturalW = img.naturalWidth || 1;
                state.naturalH = img.naturalHeight || 1;
                const { stageSize, circleSize } = circleBounds();
                state.minScale = circleSize / Math.min(state.naturalW, state.naturalH);
                state.maxScale = state.minScale * 3;
                state.scale = state.minScale;
                state.left = (stageSize - state.naturalW * state.scale) / 2;
                state.top = (stageSize - state.naturalH * state.scale) / 2;
                applyTransform();
                zoomInput.min = '0';
                zoomInput.max = '1000';
                zoomInput.value = '0';

                requestAnimationFrame(() => overlay.classList.add('visible'));
            };
            img.onerror = () => finish(null);
            img.src = objectUrl;

            on(zoomInput, 'input', () => {
                const t = Number(zoomInput.value) / 1000;
                setScale(state.minScale + t * (state.maxScale - state.minScale));
            });

            let dragging = false;
            let dragStartX = 0;
            let dragStartY = 0;
            let dragStartLeft = 0;
            let dragStartTop = 0;

            on(stage, 'pointerdown', (e) => {
                dragging = true;
                stage.classList.add('dragging');
                stage.setPointerCapture?.(e.pointerId);
                dragStartX = e.clientX;
                dragStartY = e.clientY;
                dragStartLeft = state.left;
                dragStartTop = state.top;
            });
            on(stage, 'pointermove', (e) => {
                if (!dragging) return;
                state.left = dragStartLeft + (e.clientX - dragStartX);
                state.top = dragStartTop + (e.clientY - dragStartY);
                clampPosition();
                applyTransform();
            });
            const stopDrag = (e) => {
                dragging = false;
                stage.classList.remove('dragging');
                if (e && stage.releasePointerCapture) {
                    try { stage.releasePointerCapture(e.pointerId); } catch (err) { /* noop */ }
                }
            };
            on(stage, 'pointerup', stopDrag);
            on(stage, 'pointercancel', stopDrag);
            on(stage, 'wheel', (e) => {
                e.preventDefault();
                const rect = stage.getBoundingClientRect();
                const focalX = e.clientX - rect.left;
                const focalY = e.clientY - rect.top;
                const factor = Math.exp(-e.deltaY * 0.0015);
                setScale(state.scale * factor, focalX, focalY);
                const t = (state.scale - state.minScale) / (state.maxScale - state.minScale || 1);
                zoomInput.value = String(Math.round(clamp(t, 0, 1) * 1000));
            }, { passive: false });

            on(cancelBtn, 'click', () => finish(null));
            on(closeBtn, 'click', () => finish(null));
            on(document, 'keydown', (e) => {
                if (e.key === 'Escape') finish(null);
            });
            on(saveBtn, 'click', () => {
                const { circleSize, margin } = circleBounds();
                const OUTPUT_SIZE = 512;
                const sx = (margin - state.left) / state.scale;
                const sy = (margin - state.top) / state.scale;
                const sSize = circleSize / state.scale;
                const canvas = document.createElement('canvas');
                canvas.width = OUTPUT_SIZE;
                canvas.height = OUTPUT_SIZE;
                const ctx = canvas.getContext('2d');
                if (!ctx) { finish(file); return; }
                ctx.drawImage(img, sx, sy, sSize, sSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
                canvas.toBlob((blob) => {
                    if (!blob) { finish(file); return; }
                    const baseName = String(file.name || 'avatar').replace(/\.[^.]+$/, '') || 'avatar';
                    finish(new File([blob], `${baseName}.jpg`, { type: 'image/jpeg' }));
                }, 'image/jpeg', 0.92);
            });
        });
    }

    async setProfileAvatar(inputFile) {
        if (!inputFile) return;
        const target = String(this.myName()).trim();
        if (!inputFile.type || !inputFile.type.startsWith('image/')) {
            throw new Error('Нужен файл изображения');
        }
        const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
        if (inputFile.size > MAX_AVATAR_BYTES) {
            throw new Error('Аватар слишком большой. Выберите изображение до 2 МБ');
        }
        const file = await this.downscaleAvatarFile(inputFile);
        if (this.hasNativeAvatarBridge()) {
            const dataUrl = await this.readFileAsDataURL(file);
            await this.requestNativeAction({
                type: NativeMessageTypes.UPLOAD_AVATAR_REQUEST,
                dataUrl,
                mimeType: file.type || 'image/png',
                filename: file.name || 'avatar.png',
            });
            const objectUrl = URL.createObjectURL(file);
            this.saveStoredAvatar(target, objectUrl);
            this.updateAvatarViews();
            return;
        }
        const formData = new FormData();
        formData.append('file', file, file.name || 'avatar.png');
        const res = await this.apiFetch(this.apiRoutes.avatar.base, {
            method: 'POST',
            body: formData,
        });
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось сохранить аватар на сервере');
        }
        const objectUrl = URL.createObjectURL(file);
        this.saveStoredAvatar(target, objectUrl);
        this.updateAvatarViews();
    }

    async resetProfileAvatar() {
        const target = String(this.myName()).trim();
        if (this.hasNativeAvatarBridge()) {
            await this.requestNativeAction({
                type: NativeMessageTypes.DELETE_AVATAR_REQUEST,
            });
            this.saveStoredAvatar(target, null);
            this.updateAvatarViews();
            return;
        }
        const res = await this.apiFetch(this.apiRoutes.avatar.base, { method: 'DELETE' });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || 'Не удалось удалить аватар на сервере');
        }
        this.saveStoredAvatar(target, null);
        this.updateAvatarViews();
    }
});
