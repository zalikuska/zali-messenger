// --- ZaliInterface: активность устройства и маршрут уведомлений (server/src/device_activity.rs). ---
//
// Уведомление о сообщении уходит только на те устройства, где человек что-то делал
// последние две минуты; если бездельничают все — на все. Решает сервер: он шлёт
// `notify_route {messageId, devices}` раньше самого сообщения, и только когда
// уведомлять надо не все устройства. Устройство, которого в списке нет, лишь
// наращивает счётчик непрочитанного — ни тоста, ни звука.
//
// О своей активности сервер узнаёт от каждого устройства кадром `client_idle
// {deviceId, idleSeconds}`. Нативные оболочки шлют его сами — по системному простою
// (macOS, Windows) или по касаниям и жизненному циклу (Android): вебвью в свёрнутом
// окне не видит ни мыши, ни клавиатуры, а таймеры ему режут. Отсюда отчитывается
// только браузерная вкладка — по своим событиям ввода, видимости и фокуса.
ZaliMixin(ZaliInterface, class {

    // ------------------------------------------------------------
    // Маршрут уведомлений
    // ------------------------------------------------------------

    rememberNotifyRoute(payload) {
        const id = String(payload?.messageId || '').trim();
        if (!id || !Array.isArray(payload?.devices)) return;
        if (!this._notifyRoutes) this._notifyRoutes = new Map();
        const devices = payload.devices.map(device => String(device || '').trim()).filter(Boolean);
        this._notifyRoutes.set(id, { devices, ts: Date.now() });
        // Маршрут живёт до своего сообщения; осиротевшие (сообщение пришло на другой
        // сокет оболочки раньше или не пришло вовсе) не копим.
        if (this._notifyRoutes.size > 200) {
            const cutoff = Date.now() - 10 * 60 * 1000;
            for (const [key, value] of this._notifyRoutes) if (value.ts < cutoff) this._notifyRoutes.delete(key);
        }
    }

    // Уведомлять ли на этом устройстве о сообщении `messageId`. Без маршрута — да: сервер
    // его не прислал (уведомлять все) или сообщение пришло догрузкой истории.
    notifyRouteAllows(messageId) {
        const id = String(messageId || '').trim();
        const route = id ? this._notifyRoutes?.get(id) : null;
        if (!route) return true;
        const me = String(this.currentDeviceId?.() || '').trim();
        // Своё устройство неизвестно — лучше лишнее уведомление, чем пропавшее.
        if (!me) return true;
        return route.devices.includes(me);
    }

    // ------------------------------------------------------------
    // Открытый чат
    // ------------------------------------------------------------
    //
    // Единственное исключение из маршрута: если переписка открыта прямо сейчас перед
    // глазами (на экране и окно в фокусе — isDmChatAttended/isServerChatAttended), о ней
    // не звенит НИ ОДНО устройство — ни пушем, ни системным уведомлением. Своё уведомление
    // это устройство и так гасит; остальным сервер шлёт пустой notify_route и не шлёт пуш.
    //
    // Шлют все платформы, из веба: что открыто, знает только он. Нативные оболочки
    // пропускают кадр в свой сокет (sendClientActivityFrame). Пока чат открыт —
    // повтор раз в 25 с, иначе сервер через минуту сочтёт отметку устаревшей.

    currentViewedConversation() {
        if (!this.S.session?.token || !this.isAppAttended()) return '';
        if (this.S.navMode === 'servers') {
            const key = this.currentServerChatKey?.() || '';
            return key && this.isServerChatVisible(key) ? key : '';
        }
        const peer = String(this.S.current || '').trim();
        return peer && this.isDmChatVisible(peer) ? `dm:${peer}` : '';
    }

    reportConversationView({ force = false } = {}) {
        this.installConversationViewReporting();
        // До входа сокета нет, а оболочка поставила бы кадр в очередь и полезла
        // подключаться без токена.
        if (!this.S.session?.token) return;
        const conversation = this.currentViewedConversation();
        const deviceId = String(this.currentDeviceId?.() || '').trim();
        const key = `${this.myName?.() || ''}|${deviceId}|${conversation}`;
        const heartbeatDue = conversation
            && Date.now() - Number(this._lastConversationViewAt || 0) >= ZaliInterface.CONVERSATION_VIEW_HEARTBEAT_MS;
        if (!force && key === this._lastConversationViewKey && !heartbeatDue) return;
        const frame = { type: 'client_view', deviceId, conversation: conversation || null };
        if (!this.sendClientActivityFrame?.(frame)) return;
        this._lastConversationViewKey = key;
        this._lastConversationViewAt = Date.now();
    }

    // Переключение чата, вкладки «Хаб»/«Настройки», фокус окна — опрос раз в секунду
    // ловит всё это одним сравнением строки, не расставляя вызовы по десятку мест.
    // Уход окна с экрана сообщается сразу (onNativeAppFocusChange, события ниже):
    // свёрнутой вкладке таймеры режут.
    installConversationViewReporting() {
        if (this._conversationViewReportingInstalled) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        this._conversationViewReportingInstalled = true;
        const report = () => this.reportConversationView();
        setInterval(report, 1000);
        document.addEventListener('visibilitychange', report);
        window.addEventListener('focus', report);
        window.addEventListener('blur', report);
        window.addEventListener('pagehide', report);
    }

    // ------------------------------------------------------------
    // Активность браузерной вкладки
    // ------------------------------------------------------------

    installDeviceActivityReporting() {
        if (this._deviceActivityReportingInstalled) return;
        if (this.hasNativeBridge()) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        this._deviceActivityReportingInstalled = true;
        this._lastLocalActivityAt = Date.now();
        const note = () => this.noteLocalActivity();
        const options = { capture: true, passive: true };
        // pointermove — тоже действие («двигал мышкой»), но на каждое движение ничего не
        // шлётся: noteLocalActivity отправляет не чаще раза в 30 с.
        for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']) {
            document.addEventListener(type, note, options);
        }
        // Переключился на вкладку, ушёл с неё, свернул окно — тоже действие.
        document.addEventListener('visibilitychange', note);
        window.addEventListener('focus', note);
        window.addEventListener('blur', note);
        window.addEventListener('pagehide', note);
    }

    noteLocalActivity() {
        this._lastLocalActivityAt = Date.now();
        this.reportDeviceIdle();
    }

    // Пока человек активен — раз в 30 с; перестал — молчим, простой на сервере растёт
    // сам. force — после (пере)подключения сокета: сервер мог перезапуститься, а
    // device_id браузерного соединения он знает только из кадров.
    reportDeviceIdle({ force = false } = {}) {
        if (this.hasNativeBridge()) return;
        this.installDeviceActivityReporting();
        const lastActivity = Number(this._lastLocalActivityAt || 0);
        if (!lastActivity) return;
        if (!force && lastActivity - Number(this._lastReportedActivityAt || 0) < ZaliInterface.DEVICE_IDLE_REPORT_MS) return;
        const deviceId = String(this.currentDeviceId?.() || '').trim();
        if (!deviceId) return;
        const socket = this.voice?.socket;
        if (!socket || typeof WebSocket === 'undefined' || socket.readyState !== WebSocket.OPEN) return;
        const idleSeconds = Math.max(0, Math.floor((Date.now() - lastActivity) / 1000));
        try {
            socket.send(JSON.stringify({ type: 'client_idle', deviceId, idleSeconds }));
            this._lastReportedActivityAt = lastActivity;
        } catch (e) {}
    }
});

ZaliInterface.DEVICE_IDLE_REPORT_MS = 30 * 1000;
ZaliInterface.CONVERSATION_VIEW_HEARTBEAT_MS = 25 * 1000;
