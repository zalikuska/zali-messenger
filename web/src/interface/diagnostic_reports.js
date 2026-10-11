// --- ZaliInterface: Диагностические отчёты на сервер (вручную и при сбоях). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// До этого с устройства на сервер уходили только отчёты о неудачной
// расшифровке (reportDecryptFailure). Звонки, доставка, обрывы соединения и
// ошибки JS оставались в журнале устройства, и разбор начинался с «пришли
// лог». Здесь клиент собирает снимок своего состояния из ограниченных колец
// (журнал, трасса, голосовая диагностика, неудачные запросы, очередь отправки)
// и отправляет его в POST /api/diagnostics/report (server/src/diagnostics.rs):
//   • вручную — кнопка «Отправить диагностику» в Настройках → Журнал событий;
//   • сам — при сбое звонка, зависшей отправке, частых обрывах WS, ошибке JS.
// Читает оператор: scripts/diag_reports.py.
//
// Кольца — короткие строки, без payload-ов и ссылок на объекты (инварианты
// производительности: ничего, что держит память). Длинные токены вычищаются
// перед отправкой (scrubDiagnosticText) — ключи и JWT в отчёт не попадают.

const ZALI_DIAG_RING_LIMIT = 400;
// Сервер принимает до 256 КиБ (server/src/diagnostics.rs); запас на заголовки.
const ZALI_DIAG_MAX_REPORT_BYTES = 240 * 1024;
const ZALI_DIAG_LINE_MAX = 400;
// Один автоматический отчёт каждого вида не чаще, чем раз в столько.
const ZALI_DIAG_AUTO_INTERVAL_MS = 10 * 60 * 1000;
// Сообщение, висящее в очереди дольше этого при живом соединении, — сбой доставки.
const ZALI_DIAG_STUCK_OUTBOX_MS = 2 * 60 * 1000;
// Столько обрывов WS за окно — «нестабильное соединение».
const ZALI_DIAG_WS_DROPS = 5;
const ZALI_DIAG_WS_WINDOW_MS = 10 * 60 * 1000;

ZaliMixin(ZaliInterface, class {

    pushDiagRing(name, line) {
        const ring = this[name] || (this[name] = []);
        ring.push(String(line).slice(0, ZALI_DIAG_LINE_MAX));
        if (ring.length > ZALI_DIAG_RING_LIMIT) ring.shift();
    }

    // Неудачный HTTP-запрос (статус ≥ 400 или транспортная ошибка) — для отчёта.
    // request_id тот же, что в логе сервера: по нему видна вторая половина.
    noteFailedRequest({ method, path, status = 0, requestId = '', error = '' }) {
        // 404 на необязательный ресурс — норма, а не сбой: у большинства контактов
        // нет аватарки, у серверов — баннера. Без фильтра такие строки вытесняли
        // из кольца единственный 500/таймаут, который и объяснял проблему.
        if (status === 404 && /\/api\/(avatar|profile)\/|\/assets\//.test(String(path || ''))) return;
        const at = new Date().toISOString();
        this.pushDiagRing('_requestFailureRing',
            `${at} ${method} ${String(path || '').split('?')[0]} status=${status}${error ? ` err=${error}` : ''} request_id=${requestId}`);
    }

    // Ключи, токены, base64 — длинные непрерывные строки. Id сообщений (uuid с
    // дефисами) короче порога и остаются: без них отчёт нельзя сопоставить.
    scrubDiagnosticText(value) {
        return String(value || '')
            .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
            .replace(/[A-Za-z0-9+/_=]{40,}/g, '[redacted]');
    }

    diagnosticPlatform() {
        const transport = String(this.nativeBridge()?.transport || 'none');
        const ua = (typeof navigator !== 'undefined' && navigator.userAgent) || '';
        if (transport === 'webkit') return /iPhone|iPad|iPod/.test(ua) ? 'ios' : 'macos';
        if (transport === 'webview2') return 'windows';
        if (transport === 'ipc') return /Windows/.test(ua) ? 'windows' : 'rust-shell';
        if (transport === 'android') return 'android';
        return /Mobi|Android|iPhone/.test(ua) ? 'browser-mobile' : 'browser';
    }

    collectDiagnosticsSnapshot(kind, extra = {}) {
        const scrubLines = (ring, tail) => (Array.isArray(ring) ? ring.slice(-tail) : [])
            .map(line => this.scrubDiagnosticText(line));
        let outbox = [];
        try { outbox = this.loadPendingOutbox() || []; } catch (e) {}
        const now = Date.now();
        const voiceLines = (Array.isArray(this._voiceDiagRing) ? this._voiceDiagRing : [])
            .slice(-200)
            .map(line => this.scrubDiagnosticText(`[${line.ts}] ${line.level} ${line.message}`).slice(0, ZALI_DIAG_LINE_MAX));
        const memory = (typeof performance !== 'undefined' && performance.memory)
            ? { usedMb: Math.round(performance.memory.usedJSHeapSize / 1048576), limitMb: Math.round(performance.memory.jsHeapSizeLimit / 1048576) }
            : null;
        return {
            kind,
            appVersion: String(window.__ZALI_NATIVE_APP_VERSION || '').trim() || 'web',
            platform: this.diagnosticPlatform(),
            reportedAt: new Date().toISOString(),
            userAgent: (typeof navigator !== 'undefined' && navigator.userAgent) || '',
            deviceId: this.currentDeviceId?.() || '',
            designMode: (document.body?.dataset?.designGlow === 'on' ? 'focus-glow' : document.body?.dataset?.designMode) || '',
            online: typeof navigator !== 'undefined' ? navigator.onLine : null,
            visible: !document.hidden,
            uptimeSec: Math.round((typeof performance !== 'undefined' ? performance.now() : 0) / 1000),
            ws: { connected: !!this.S.wsOn, recentDrops: (this._wsDropTimes || []).length },
            navMode: this.S.navMode || '',
            activeChat: this.S.current || '',
            voice: {
                status: this.voice?.status || '',
                roomId: this.voice?.roomId || '',
                peers: this.voice?.peerConnections?.size || 0,
            },
            outbox: {
                count: outbox.length,
                oldestAgeSec: outbox.length
                    ? Math.round(Math.max(...outbox.map(item => now - (Date.parse(item.timestamp) || now))) / 1000)
                    : 0,
                items: outbox.slice(0, 20).map(item => ({
                    clientId: item.clientId,
                    receiver: item.receiver,
                    serverId: item.serverId || '',
                    attempts: item.attemptCount || 0,
                    ageSec: Math.round((now - (Date.parse(item.timestamp) || now)) / 1000),
                    inFlight: !!item.inFlight,
                })),
            },
            memory,
            failedRequests: scrubLines(this._requestFailureRing, 60),
            journal: scrubLines(this._journalRing, 200),
            // Строки трассы начинаются с performance.now() в мс (дёшево на горячем
            // пути, см. trace()); абсолютное время = traceTimeOrigin + это число.
            traceTimeOrigin: typeof performance !== 'undefined' ? Math.round(performance.timeOrigin || 0) : 0,
            trace: scrubLines(this._traceRing, 300),
            voiceDiag: voiceLines,
            ...extra,
        };
    }

    // Сервер не примет больше 256 КиБ (413) — и отчёт, нужный сильнее всего
    // (после долгого плохого звонка), пропал бы целиком. Режем самые объёмные
    // кольца с головы (старое), пока не влезет; свежий хвост остаётся.
    fitDiagnosticReport(snapshot) {
        const LIMIT = ZALI_DIAG_MAX_REPORT_BYTES;
        const bytes = (value) => new Blob([value]).size;
        let body = JSON.stringify(snapshot);
        for (let round = 0; round < 8 && bytes(body) > LIMIT; round += 1) {
            for (const key of ['trace', 'journal', 'voiceDiag', 'failedRequests']) {
                const list = snapshot[key];
                if (Array.isArray(list) && list.length > 10) snapshot[key] = list.slice(Math.floor(list.length / 2));
            }
            snapshot.truncated = true;
            body = JSON.stringify(snapshot);
        }
        return body;
    }

    // Отправляет отчёт. Автоматические — не чаще раза в 10 минут на вид;
    // ручной — всегда. Возвращает id отчёта на сервере или '' (не отправлен).
    async sendDiagnosticReport(kind, extra = {}, { manual = false } = {}) {
        if (!this.S.session?.token || this.S.session?.guest) return '';
        this._diagLastReportStatus = 0;
        if (!manual) {
            const last = (this._diagLastAutoReportAt || (this._diagLastAutoReportAt = {}))[kind] || 0;
            if (Date.now() - last < ZALI_DIAG_AUTO_INTERVAL_MS) return '';
            this._diagLastAutoReportAt[kind] = Date.now();
        }
        try {
            this.flushTrace?.();
            const body = this.fitDiagnosticReport(this.collectDiagnosticsSnapshot(kind, extra));
            const res = await this.apiFetch(this.apiRoutes.diagnostics.report, { method: 'POST', body });
            this._diagLastReportStatus = res.status;
            if (!res.ok) {
                this.trace(`sendDiagnosticReport kind=${kind} status=${res.status}`);
                return '';
            }
            const data = await res.json().catch(() => ({}));
            const id = String(data?.id || '');
            this.trace(`sendDiagnosticReport kind=${kind} id=${id} bytes=${body.length}`);
            return id;
        } catch (e) {
            this.trace(`sendDiagnosticReport failed kind=${kind} error=${e?.message || e}`);
            return '';
        }
    }

    // Кнопка в Настройках. Id отчёта показываем человеку — его называют,
    // когда описывают проблему, и по нему оператор находит снимок.
    async sendManualDiagnosticReport() {
        const btn = document.getElementById('sendDiagnosticsBtn');
        const note = document.getElementById('sendDiagnosticsNote');
        if (btn) btn.disabled = true;
        if (note) note.textContent = 'Отправляем…';
        const id = await this.sendDiagnosticReport('manual', {}, { manual: true });
        if (btn) btn.disabled = false;
        if (note) {
            note.textContent = id
                ? `Отправлено. Номер отчёта: ${id.slice(0, 8)}`
                : this._diagLastReportStatus === 429
                    ? 'Слишком много отчётов за последний час — попробуйте позже.'
                    : 'Не удалось отправить — проверьте соединение и попробуйте ещё раз.';
        }
        this.addLogEntry({
            type: id ? 'SUCCESS' : 'WARN',
            msg: id ? `Диагностика отправлена, отчёт ${id}` : 'Диагностику отправить не удалось',
            ts: new Date().toLocaleTimeString(),
        });
    }

    // Обрыв WS: ZALI_DIAG_WS_DROPS обрывов за окно — отчёт ws_unstable.
    noteRealtimeDrop() {
        const now = Date.now();
        const drops = (this._wsDropTimes || []).filter(t => now - t < ZALI_DIAG_WS_WINDOW_MS);
        drops.push(now);
        this._wsDropTimes = drops;
        if (drops.length >= ZALI_DIAG_WS_DROPS) {
            void this.sendDiagnosticReport('ws_unstable', { drops: drops.length, windowMin: ZALI_DIAG_WS_WINDOW_MS / 60000 });
        }
    }

    // Сообщение висит в очереди дольше двух минут, хотя соединение есть, —
    // значит, оно не уходит не из-за сети. Отчёт один на сообщение.
    //
    // Возраст считается от момента, когда проверка впервые увидела сообщение при
    // живом соединении, а не от времени самого сообщения: написанное офлайн
    // (самолёт) иначе считалось «зависшим» сразу после переподключения, ещё до
    // того, как очередь успела уйти. Пока соединения нет — отсчёт сбрасывается.
    // Сообщение с вложениями, которое прямо сейчас загружается, не в счёт:
    // большой файл законно грузится дольше двух минут.
    checkStuckOutbox() {
        const seen = this._diagOutboxSeenAt || (this._diagOutboxSeenAt = new Map());
        if (!this.S.wsOn || !this.S.session?.token) {
            seen.clear();
            return;
        }
        let outbox = [];
        try { outbox = this.loadPendingOutbox() || []; } catch (e) { return; }
        const now = Date.now();
        const present = new Set(outbox.map(item => String(item.clientId || '')));
        for (const id of seen.keys()) if (!present.has(id)) seen.delete(id);
        for (const id of present) if (!seen.has(id)) seen.set(id, now);
        const reported = this._diagStuckReported || (this._diagStuckReported = new Set());
        const stuck = outbox.filter(item => {
            const id = String(item.clientId || '');
            const uploading = item.inFlight && Array.isArray(item.attachments) && item.attachments.length > 0;
            return !uploading && now - (seen.get(id) || now) > ZALI_DIAG_STUCK_OUTBOX_MS && !reported.has(id);
        });
        if (!stuck.length) return;
        for (const item of stuck) reported.add(String(item.clientId || ''));
        if (reported.size > 500) reported.delete(reported.values().next().value);
        void this.sendDiagnosticReport('delivery_failed', {
            stuck: stuck.slice(0, 10).map(item => ({
                clientId: item.clientId,
                receiver: item.receiver,
                serverId: item.serverId || '',
                attempts: item.attemptCount || 0,
                ageSec: Math.round((now - (Date.parse(item.timestamp) || now)) / 1000),
                hasCall: !!item.call,
                attachments: Array.isArray(item.attachments) ? item.attachments.length : 0,
            })),
        });
    }

    // Ставится один раз при запуске (bindNativeBridgeEvents).
    installDiagnosticAutoReports() {
        if (this._diagAutoInstalled) return;
        this._diagAutoInstalled = true;
        const onJsError = (message, stack) => {
            const text = this.scrubDiagnosticText(String(message || '')).slice(0, 500);
            if (!text) return;
            this.pushDiagRing('_traceRing', `[JS-ERROR] ${text}`);
            void this.sendDiagnosticReport('js_error', {
                error: text,
                stack: this.scrubDiagnosticText(String(stack || '')).slice(0, 4000),
            });
        };
        window.addEventListener('error', (event) => {
            onJsError(event?.message || event?.error?.message, event?.error?.stack
                || `${event?.filename || ''}:${event?.lineno || ''}:${event?.colno || ''}`);
        });
        window.addEventListener('unhandledrejection', (event) => {
            const reason = event?.reason;
            onJsError(`unhandledrejection: ${reason?.message || reason}`, reason?.stack || '');
        });
        if (this._diagOutboxTimer) clearInterval(this._diagOutboxTimer);
        this._diagOutboxTimer = setInterval(() => this.checkStuckOutbox(), 60 * 1000);
    }
});
