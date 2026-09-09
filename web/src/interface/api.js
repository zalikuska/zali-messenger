// --- ZaliInterface: HTTP-конвейер: заголовки, слоты параллелизма, apiFetch. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    apiHeaders(extra = {}, { includeDeviceId = false } = {}) {
        const headers = { ...extra };
        if (this.S.session?.token && !headers.Authorization) {
            headers.Authorization = `Bearer ${this.S.session.token}`;
        }
        const deviceId = includeDeviceId ? this.currentDeviceId() : '';
        if (deviceId) {
            headers['X-Zali-Device-ID'] = deviceId;
        }
        return headers;
    }

    /**
     * Ответ нативного моста в оболочке, совместимой с `fetch`.
     *
     * **Почему у ответа два тела.** Мост — это JSON-канал, по нему ходят строки.
     * Пока бинарные ответы ехали тем же полем `body`, что и текстовые, они
     * необратимо портились: на macOS `String(data:encoding:.utf8)` возвращает nil
     * на первом же байте PNG, который не является валидным UTF-8, — тело
     * приезжало ПУСТЫМ; на Android `body.string()` подставляет replacement-символы
     * — тело приезжало битым. `res.blob()` при этом честно заворачивал строку в
     * Blob, и картинка не открывалась. Так на всех нативных оболочках молча не
     * работали иконки и баннеры серверов (`loadServerAsset`) — единственное место,
     * где через мост шёл настоящий бинарь, — а `res.arrayBuffer()` вообще
     * отсутствовал, из-за чего браузерный путь скачивания архива был на нативе
     * нерабочим в принципе.
     *
     * Теперь оболочка сама решает по Content-Type: текст едет в `body`, всё
     * остальное — в `bodyBase64`. Старое поле осталось на месте, поэтому свежий
     * веб на старой оболочке ведёт себя ровно как раньше.
     */
    nativeApiResponse(payload) {
        const data = payload?.data && typeof payload.data === 'object' ? payload.data : {};
        const status = Number(data.status || 0) || 0;
        const body = String(data.body || '');
        const bodyBase64 = typeof data.bodyBase64 === 'string' ? data.bodyBase64 : '';
        const headers = data.headers && typeof data.headers === 'object' ? data.headers : {};
        const contentType = String(headers['content-type'] || headers['Content-Type'] || 'application/octet-stream');

        // Декодируется один раз и лениво: у текстовых ответов (то есть почти у всех)
        // этот путь не исполняется вовсе.
        let bytes = null;
        const asBytes = () => {
            if (bytes) return bytes;
            if (bodyBase64) {
                try {
                    const binary = atob(bodyBase64);
                    const out = new Uint8Array(binary.length);
                    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
                    bytes = out;
                } catch (e) {
                    bytes = new Uint8Array(0);
                }
            } else {
                bytes = new TextEncoder().encode(body);
            }
            return bytes;
        };
        const asText = () => (bodyBase64 ? new TextDecoder().decode(asBytes()) : body);

        return {
            ok: !!data.ok || (status >= 200 && status < 300),
            status,
            headers,
            text: async () => asText(),
            json: async () => JSON.parse(asText() || 'null'),
            arrayBuffer: async () => {
                const view = asBytes();
                return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
            },
            blob: async () => new Blob([asBytes()], { type: contentType }),
        };
    }

    async nativeApiFetch(path, { method = 'GET', headers = {}, body = null, includeDeviceId = false, timeoutMs = API_REQUEST_TIMEOUT_MS } = {}) {
        // Native owns the per-attempt timeout AND the retry, because only it can force a
        // brand-new connection (a half-open HTTP/2 connection is otherwise reused and
        // stalls again). Give the JS bridge a generous abandon timeout so it does not
        // give up before native has finished its short retries.
        const payload = await this.requestNativeAction({
            type: NativeMessageTypes.API_REQUEST,
            method,
            path,
            headers,
            body: typeof body === 'string' ? body : '',
            includeDeviceId: !!includeDeviceId,
            timeoutMs,
        }, timeoutMs + 5000);
        return this.nativeApiResponse(payload);
    }

    async _acquireApiSlot(interactive = false) {
        const MAX = 5;
        if (!this._apiWaiters) this._apiWaiters = [];
        if (!this._apiWaitersHigh) this._apiWaitersHigh = [];
        if ((this._apiInFlight || 0) < MAX) {
            this._apiInFlight = (this._apiInFlight || 0) + 1;
            return;
        }
        // Interactive (user-clicked) requests jump ahead of queued background
        // maintenance calls (contacts/users/servers refresh, key republish, cloud
        // vault backup — all fired in bursts from postAuthSetup) instead of waiting
        // behind however many of those already queued first. Without this, clicking
        // "add contact" during that startup burst could sit queued long enough to
        // look like the click did nothing, when it was really just stuck in line.
        const queue = interactive ? this._apiWaitersHigh : this._apiWaiters;
        await new Promise(resolve => queue.push(resolve));
        // The slot was handed to us by _releaseApiSlot (count already reserved).
    }

    _releaseApiSlot() {
        const next = (this._apiWaitersHigh && this._apiWaitersHigh.length)
            ? this._apiWaitersHigh.shift()
            : (this._apiWaiters && this._apiWaiters.length) ? this._apiWaiters.shift() : null;
        if (next) {
            next(); // hand the in-flight slot straight to the next waiter
        } else {
            this._apiInFlight = Math.max(0, (this._apiInFlight || 0) - 1);
        }
    }

    // Global concurrency limit. On macOS every apiFetch goes through the native
    // URLSession pool (≈6 connections/host); a burst of background requests (cloud
    // vault tickets, key republish) would exhaust it and make the NEXT request stall
    // for the full 12s timeout. Capping in-flight requests keeps the pool healthy.
    async apiFetch(path, options = {}) {
        await this._acquireApiSlot(!!options.interactive);
        try {
            return await this._apiFetchImpl(path, options);
        } finally {
            this._releaseApiSlot();
        }
    }

    async _apiFetchImpl(path, options = {}) {
        const method = String(options?.method || 'GET').toUpperCase();
        const requestId = this.newRequestId();
        this.trace(`apiFetch request method=${method} path=${path} request_id=${requestId} auth=${!!this.S.session?.token}`);
        const {
            includeDeviceId = false,
            allowSessionInvalidation = false,
            timeoutMs = 0,
            interactive = false,
            headers: optionHeaders,
            ...fetchOptions
        } = options || {};
        const headers = this.apiHeaders(
            { 'X-Request-ID': requestId, ...(optionHeaders || {}) },
            { includeDeviceId: !!includeDeviceId },
        );
        if (options.body && typeof options.body === 'string' && !headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
        }
        if (this.nativeSupports('apiRequest') && !(options.body instanceof FormData)) {
            const res = await this.nativeApiFetch(path, {
                method,
                headers,
                body: options.body,
                includeDeviceId,
                timeoutMs: timeoutMs || API_REQUEST_TIMEOUT_MS,
            });
            this.trace(`apiFetch native response method=${method} path=${path} request_id=${requestId} status=${res.status} ok=${res.ok}`);
            this.handleUnauthorizedApiResponse(res, headers, { allowSessionInvalidation });
            return res;
        }
        // The native path has always bounded itself (nativeApiFetch above falls back to
        // API_REQUEST_TIMEOUT_MS); the browser path only had a timeout when a caller
        // remembered to ask for one, and almost none did. `fetch` has no timeout of its
        // own, so one stalled request sat in an apiFetch concurrency slot until the
        // browser gave up minutes later — including the deliberately-prioritised
        // envelope sync, which is the one call that can repair a wrong key.
        //
        // Bulk transfers get their own, much larger budget rather than the request
        // default: a multi-megabyte attachment legitimately outlives it, and cutting
        // those off would trade a rare stall for a routine failure. Uploads are
        // detected here by their multipart body; DOWNLOADS cannot be detected from the
        // request, so the handful of call sites that pull binary (message archives,
        // avatars, server assets) pass TRANSFER_REQUEST_TIMEOUT_MS explicitly.
        //
        // An explicit `timeoutMs` from the caller always wins; anything falsy means
        // "use the default for this kind of request", which is what every existing
        // call site was silently getting as "none at all".
        const isMultipartBody = typeof FormData !== 'undefined' && options.body instanceof FormData;
        const effectiveTimeoutMs = timeoutMs > 0
            ? timeoutMs
            : (isMultipartBody ? TRANSFER_REQUEST_TIMEOUT_MS : API_REQUEST_TIMEOUT_MS);
        let timeoutId = null;
        let abortController = null;
        let abortForwarder = null;
        const originalSignal = fetchOptions.signal;
        if (effectiveTimeoutMs > 0 && typeof AbortController !== 'undefined') {
            abortController = new AbortController();
            fetchOptions.signal = abortController.signal;
            timeoutId = setTimeout(() => abortController.abort(), effectiveTimeoutMs);
            if (originalSignal) {
                if (originalSignal.aborted) {
                    abortController.abort();
                } else {
                    abortForwarder = () => abortController.abort();
                    originalSignal.addEventListener('abort', abortForwarder, { once: true });
                }
            }
        }
        try {
            const res = await fetch(this.apiUrl(path), {
                ...fetchOptions,
                headers,
            });
            this.trace(`apiFetch response method=${method} path=${path} request_id=${requestId} status=${res.status} ok=${res.ok}`);
            this.handleUnauthorizedApiResponse(res, headers, { allowSessionInvalidation });
            return res;
        } catch (error) {
            this.trace(`apiFetch transport_error method=${method} path=${path} request_id=${requestId} err=${error?.message || error}`);
            throw error;
        } finally {
            if (timeoutId) clearTimeout(timeoutId);
            if (originalSignal && abortForwarder) {
                originalSignal.removeEventListener('abort', abortForwarder);
            }
        }
    }

    handleUnauthorizedApiResponse(res, headers = {}, { allowSessionInvalidation = false } = {}) {
        const status = Number(res?.status || 0);
        if (status === 403) {
            this.trace('apiFetch forbidden status=403 keep_session=true');
            return;
        }
        if (status !== 401) return;
        if (!allowSessionInvalidation) {
            this.trace('apiFetch unauthorized status=401 keep_session=true');
            return;
        }
        const currentToken = String(this.S.session?.token || '').trim();
        const headerToken = String(headers?.Authorization || '').replace(/^Bearer\s+/i, '').trim();
        if (!currentToken || headerToken !== currentToken || this.sessionBootstrapInProgress) return;
        if (this.sessionInvalidationInProgress) return;
        this.sessionInvalidationInProgress = true;
        this.forgetRecentAccountEntry(this.S.session?.username, currentToken);
        this.clearStoredSession();
        this.S.auth.dismissed = false;
        this.S.auth.error = 'Сессия истекла. Войдите заново.';
        this.applySession({ username: '', token: null, guest: true }, {
            persist: false,
            syncNative: true,
            connectVoiceSocket: false,
        });
        this.addLogEntry({
            type: 'WARN',
            msg: 'Сессия истекла или токен стал недействительным. Выполните вход заново.',
            ts: new Date().toLocaleTimeString()
        });
        setTimeout(() => {
            this.sessionInvalidationInProgress = false;
        }, 1000);
    }
});
