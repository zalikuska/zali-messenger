// --- ZaliInterface: Мост к нативной оболочке: доступность, IPC, разрешения, трассировка. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    nativeBridge() {
        return window.__ZALI_NATIVE || null;
    }

    hasNativeBridge() {
        return !!this.nativeBridge()?.available;
    }

    nativeSupports(capability) {
        return !!this.nativeBridge()?.supports?.[capability];
    }

    // Native shells (macOS WKWebView, Windows WebView2) either silently swallow
    // target="_blank" navigation or try to load it inside the app's own webview
    // — there is no separate "browser" for it to land in. Routes the click
    // through the native bridge instead, which hands it to the OS's configured
    // default browser (NSWorkspace.shared.open / ShellExecuteW). Returns false
    // (and does nothing) in plain-browser/PWA mode, where target="_blank"
    // already does the right thing on its own.
    openExternalLink(url) {
        const href = String(url || '').trim();
        if (!/^https?:\/\//i.test(href)) return false;
        if (!this.nativeSupports('openExternalUrl')) return false;
        return this.postNativeMessage({ type: NativeMessageTypes.OPEN_EXTERNAL_URL, url: href });
    }

    isStandalonePwa() {
        return window.matchMedia?.('(display-mode: standalone)')?.matches
            || window.navigator?.standalone === true;
    }

    isIosSafariBrowserTab() {
        if (this.hasNativeBridge() || this.isStandalonePwa()) return false;
        const ua = window.navigator?.userAgent || '';
        const isIos = /iphone|ipad|ipod/i.test(ua)
            || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
        const isSafari = /safari/i.test(ua) && !/crios|fxios|edgios|opios/i.test(ua);
        return isIos && isSafari;
    }

    urlBase64ToUint8Array(base64) {
        const padding = '='.repeat((4 - (base64.length % 4)) % 4);
        const base64Safe = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
        const raw = atob(base64Safe);
        const output = new Uint8Array(raw.length);
        for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
        return output;
    }

    // Asks for OS notification permission. Deliberately separate from (and ahead of)
    // the Web Push subscription: showBrowserNotification() needs only this permission,
    // so gating it behind a configured VAPID keypair left a server without
    // VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY with no browser notifications whatsoever —
    // not even the local ones that work fine with no push service involved.
    async ensureNotificationPermission() {
        if (this.hasNativeBridge()) return false;
        if (typeof Notification === 'undefined') return false;
        try {
            if (Notification.permission === 'default') {
                await Notification.requestPermission();
            }
        } catch (e) {
            this.trace(`ensureNotificationPermission failed: ${e?.message || e}`);
        }
        return Notification.permission === 'granted';
    }

    async subscribeWebPush() {
        if (this.hasNativeBridge()) return;
        if (!('serviceWorker' in navigator)) return;
        if (!this.S.session?.token) return;
        const granted = await this.ensureNotificationPermission();
        if (!('PushManager' in window)) return;
        if (!granted) return;
        try {
            const keyRes = await fetch(this.apiUrl('/api/push/vapid-public-key'));
            if (!keyRes.ok) return;
            const { publicKey } = await keyRes.json();
            if (!publicKey) return;

            const registration = await navigator.serviceWorker.ready;
            let subscription = await registration.pushManager.getSubscription();
            if (!subscription) {
                subscription = await registration.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey: this.urlBase64ToUint8Array(publicKey),
                });
            }
            await this.apiFetch('/api/push/subscribe', {
                method: 'POST',
                body: JSON.stringify(subscription.toJSON()),
            });
            this.trace('subscribeWebPush ok');
        } catch (e) {
            this.trace(`subscribeWebPush failed: ${e?.message || e}`);
        }
    }

    initA2hsBanner() {
        if (!this.isIosSafariBrowserTab()) return;
        if (localStorage.getItem('zali_a2hs_dismissed') === '1') return;
        const banner = document.getElementById('a2hsBanner');
        const text = document.getElementById('a2hsBannerText');
        const closeBtn = document.getElementById('a2hsBannerClose');
        if (!banner || !text || !closeBtn) return;
        text.innerHTML = 'Установите <b>ZaliMessenger</b> на экран «Домой»: нажмите <b>Поделиться</b>&nbsp;↑ внизу экрана, затем «На экран «Домой»».';
        banner.classList.add('visible');
        closeBtn.addEventListener('click', () => {
            banner.classList.remove('visible');
            localStorage.setItem('zali_a2hs_dismissed', '1');
        });
    }

    setKey(key) {
        if (this.bus?.send) {
            return this.bus.send('zali_styler:set_key', key);
        }
        return false;
    }

    isWindowsNativeAuth() {
        const transport = this.nativeBridge()?.transport;
        return transport === 'ipc' || transport === 'webview2';
    }

    hasNativeAvatarBridge() {
        // 'android' входит сюда наравне с остальными, и это не расширение
        // возможностей, а починка: Android объявляет avatarFetch и обрабатывает
        // UPLOAD_AVATAR_REQUEST / DELETE_AVATAR_REQUEST у себя в мосте — просто эта
        // проверка его не пускала, и обработчики никогда не вызывались. Загрузка
        // уходила в браузерный фолбэк с FormData, то есть мимо моста, из
        // `file://`-документа с `Origin: null`, который сервер отвергает по CORS.
        // Итог: поставить или снять аватар с телефона было нельзя вообще.
        const transport = this.nativeBridge()?.transport;
        return transport === 'ipc' || transport === 'webview2' || transport === 'webkit' || transport === 'android';
    }

    startEnergyAwareMaintenance() {
        if (!this.energyMaintenanceBound) {
            this.energyMaintenanceBound = true;
            const onVisibilityChange = () => {
                if (document.hidden) {
                    this.stopVoiceMeterLoop();
                    // Счётчики обращений копятся в памяти и уходят на диск по
                    // таймеру (см. interface/cache.js). Уход в фон — последний
                    // момент, когда таймер ещё точно сработает: дальше его
                    // душит браузер, а на мобильных вкладку могут и выгрузить,
                    // и тогда кеш забудет, чем пользовались весь сеанс.
                    void this.flushCacheStats();
                    return;
                }
                this.refreshVisibleAvatars();
                this.syncActiveConversation({ force: !this.nativeSupports('sendMessage') });
                if (this.voice.roomId || this.voice.localStream || this.voice.peerConnections.size > 0) {
                    this.ensureVoiceMeterLoop();
                    // Timers were throttled while hidden, so the voice socket's own
                    // ping is overdue and a link that died meanwhile hasn't been
                    // noticed yet. Probe now instead of waiting out the next tick.
                    this.probeVoiceSocketLiveness();
                }
            };
            document.addEventListener('visibilitychange', onVisibilityChange);
            window.addEventListener('focus', onVisibilityChange);
            // Debounced message-cache saves must land before the page goes away.
            window.addEventListener('pagehide', () => { this.flushTrace(); this.flushPendingMessageCacheSave(); void this.flushCacheStats(); });
            window.addEventListener('beforeunload', () => { this.flushTrace(); this.flushPendingMessageCacheSave(); void this.flushCacheStats(); });
            window.addEventListener('error', () => this.flushTrace());
        }

        this.scheduleAvatarRefreshPolling();
        this.scheduleConversationSyncPolling();
    }

    scheduleAvatarRefreshPolling() {
        if (this.avatarRefreshTimer) {
            clearTimeout(this.avatarRefreshTimer);
            this.avatarRefreshTimer = null;
        }

        const delay = document.hidden ? 60 * 60 * 1000 : 15 * 60 * 1000;
        this.avatarRefreshTimer = setTimeout(() => {
            this.avatarRefreshTimer = null;
            if (!document.hidden) {
                this.refreshVisibleAvatars();
            }
            this.scheduleAvatarRefreshPolling();
        }, delay);
    }

    scheduleConversationSyncPolling() {
        if (this.messageSyncTimer) {
            clearTimeout(this.messageSyncTimer);
            this.messageSyncTimer = null;
        }

        const hasNativeWs = this.nativeSupports('sendMessage');
        const delay = document.hidden || hasNativeWs ? 5 * 60 * 1000 : 15 * 1000;
        this.messageSyncTimer = setTimeout(() => {
            this.messageSyncTimer = null;
            this.syncActiveConversation({ force: !document.hidden && !hasNativeWs });
            this.scheduleConversationSyncPolling();
        }, delay);
    }

    postNativeMessage(payload) {
        const bridge = this.nativeBridge();
        if (!bridge || typeof bridge.postMessage !== 'function') return false;
        if (!this.validateNativePayload(payload)) return false;
        return !!bridge.postMessage(payload);
    }

    validateNativePayload(payload) {
        if (!payload || typeof payload !== 'object') {
            console.error('[bridge] Invalid native payload:', payload);
            return false;
        }

        const type = String(payload.type || '').trim();
        if (!type) {
            console.error('[bridge] Native payload missing type:', payload);
            return false;
        }

        if (!this.bridgeProtocol) {
            return true;
        }

        const schema = this.bridgeProtocol?.messages?.[type];
        if (!schema) {
            console.error('[bridge] Unknown native message type:', type);
            return false;
        }

        const fields = Array.isArray(schema.fields) ? schema.fields : [];
        if (fields.length > 0 && typeof console !== 'undefined' && console.warn) {
            const missing = fields.filter((field) => !(field in payload));
            if (missing.length > 0) {
                console.warn('[bridge] Missing fields for', type, ':', missing);
            }
        }

        return true;
    }

    // Every console.log is mirrored to zali-debug.log through the native bridge on
    // the macOS/iOS shells, so each trace used to cost a synchronous IPC hop. The
    // hot paths (history batches, per-message decrypt, key resolution) emit these in
    // bursts, which showed up as stutter. Coalesce a frame's worth of traces into one
    // console call — same lines, same order, one hop.
    trace(message) {
        const line = `[ZALI][WEB] ${message}`;
        this._traceBuffer = this._traceBuffer || [];
        this._traceBuffer.push(line);
        if (this._traceBuffer.length >= 64) {
            this.flushTrace();
            return;
        }
        if (this._traceFlushScheduled) return;
        this._traceFlushScheduled = true;
        const schedule = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame
            : (cb) => setTimeout(cb, 16);
        schedule(() => {
            this._traceFlushScheduled = false;
            this.flushTrace();
        });
    }

    flushTrace() {
        const buffer = this._traceBuffer;
        if (!buffer || buffer.length === 0) return;
        this._traceBuffer = [];
        try {
            console.log(buffer.length === 1 ? buffer[0] : buffer.join('\n'));
        } catch (e) {}
    }

    // Per-call correlation ID for apiFetch — logged locally and sent as the
    // X-Request-ID header, which the server echoes back and tags every one of
    // its own log lines for that request with. `grep request_id=<id>` across
    // both the browser console and the server log then shows one request's
    // entire lifecycle end to end, instead of guessing which server-side log
    // line matches which client-side action.
    newRequestId() {
        return (window.crypto && window.crypto.randomUUID)
            ? window.crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    }

    nowMs() {
        return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    }

    async timeStage(label, fn) {
        const t0 = this.nowMs();
        try {
            return await fn();
        } finally {
            const ms = Math.round(this.nowMs() - t0);
            this.addLogEntry({ type: ms > 1500 ? 'WARN' : 'INFO', msg: `⏱ ${label}: ${ms} мс`, ts: new Date().toLocaleTimeString() });
        }
    }

    myName() {
        return this.S.session?.username || '';
    }
});
