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
        // Открытый на экране чат прочитан: стоящие в шторке уведомления о нём (сообщения,
        // пропущенные звонки) больше не нужны. Не зависит от того, ушёл ли кадр по сокету.
        if (conversation !== this._lastClearedConversation) {
            this._lastClearedConversation = conversation;
            if (conversation) this.clearConversationNotifications?.(conversation);
        }
        const key = `${this.myName?.() || ''}|${deviceId}|${conversation}`;
        const heartbeatDue = conversation
            && Date.now() - Number(this._lastConversationViewAt || 0) >= ZaliInterface.CONVERSATION_VIEW_HEARTBEAT_MS;
        if (!force && key === this._lastConversationViewKey && !heartbeatDue) return;
        const frame = { type: 'client_view', deviceId, conversation: conversation || null };
        if (!this.sendClientActivityFrame?.(frame)) return;
        this._lastConversationViewKey = key;
        this._lastConversationViewAt = Date.now();
    }

    // Нативный шелл снимает свои уведомления сам (CLEAR_NOTIFICATIONS, пока только Android);
    // в браузере их ставит service worker — закрываем через регистрацию. Ключ — тот же,
    // что у client_view: `dm:<собеседник>` / `<сервер>:<канал>`.
    clearConversationNotifications(conversation) {
        if (this.nativeSupports('clearNotifications')) {
            this.postNativeMessage({ type: NativeMessageTypes.CLEAR_NOTIFICATIONS, conversation });
            return;
        }
        if (!this.hasNativeBridge()) void this.closeBrowserNotifications(conversation);
    }

    async closeBrowserNotifications(conversation) {
        try {
            if (typeof navigator === 'undefined' || !navigator.serviceWorker?.getRegistration) return;
            const registration = await navigator.serviceWorker.getRegistration();
            if (!registration?.getNotifications) return;
            const wanted = String(conversation || '').toLowerCase();
            for (const notification of await registration.getNotifications()) {
                const data = notification.data || {};
                let key = '';
                if (data.serverId && data.channelId) key = `${data.serverId}:${data.channelId}`;
                else if (data.kind === 'call_end' && data.from) key = `dm:${data.from}`;
                else if (data.sender) key = `dm:${data.sender}`;
                if (key && key.toLowerCase() === wanted) notification.close();
            }
        } catch (e) { /* уведомления — удобство, не повод для ошибки */ }
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
            // Окно активности сервер выбирает по типу: вкладке — минута (DeviceKind).
            socket.send(JSON.stringify({ type: 'client_idle', deviceId, idleSeconds, kind: 'browser' }));
            this._lastReportedActivityAt = lastActivity;
        } catch (e) {}
    }

    // ------------------------------------------------------------
    // Статус на своей аватарке: в сети / неактивен (фазы луны) / нет соединения
    // ------------------------------------------------------------
    //
    // «Неактивен» — то же правило, по которому сервер выбирает, куда слать
    // уведомления: ни одно моё устройство не активно (server/src/device_activity.rs,
    // DeviceKind: компьютер — 5 минут после последнего действия, телефон и браузер —
    // минута). Спрашиваем сервер, потому что только он видит все устройства, а
    // вебвью в нативной оболочке не видит даже системного простоя своей машины.
    // Ввод в самом окне — активность этого устройства по определению: луна
    // снимается сразу, не дожидаясь отчёта оболочки и следующего опроса.
    //
    // Луна — с 15 минут простоя (с последнего действия на любом устройстве), и чем
    // он дольше, тем толще серп: ME_MOON_PHASES.

    updateMeStatusDot() {
        this.installMeStatusPolling();
        const dot = document.getElementById('meStatusDot');
        if (!dot) return;
        const known = typeof this.S.wsOn === 'boolean';
        let state = '';
        let phase = 0;
        if (known && !this.S.wsOn) state = 'off';
        else if (known) {
            const idleMinutes = this.meIdleMinutes();
            // Фаза — сколько порогов ME_MOON_PHASES пройдено; до первого (15 мин) луны нет.
            phase = idleMinutes === null
                ? 0
                : ZaliInterface.ME_MOON_PHASES.filter(minutes => idleMinutes >= minutes).length;
            state = phase > 0 ? 'idle' : 'on';
        }
        const cls = 'me-status-dot' + (state ? ` ${state}` : '');
        if (dot.className !== cls) dot.className = cls;
        const phaseAttr = state === 'idle' ? String(phase) : '';
        if ((dot.dataset.phase || '') !== phaseAttr) {
            if (phaseAttr) dot.dataset.phase = phaseAttr;
            else delete dot.dataset.phase;
        }
        const btn = document.getElementById('meAvaBtn');
        const label = state === 'idle'
            ? `неактивен ${this.formatMeIdle(this.meIdleMinutes())}`
            : { on: 'в сети', off: 'нет соединения' }[state];
        if (btn) btn.title = 'Аватар и настройки профиля' + (label ? ` · ${label}` : '');
        // Своя строка в участниках сервера показывает то же (presence.js).
        this.updatePresenceSlots?.(document.getElementById('serverMembersList'));
    }

    // Окно активности этого устройства — то же, что сервер берёт по его типу.
    meActiveWindowMs() {
        const transport = this.nativeBridge?.()?.transport;
        if (transport === 'android' || !this.hasNativeBridge()) return ZaliInterface.MOBILE_ACTIVE_WINDOW_MS;
        return ZaliInterface.DESKTOP_ACTIVE_WINDOW_MS;
    }

    // Сколько минут я ничего не делаю, или null — активен (или неизвестно: старый
    // сервер, ошибка запроса; «неактивен» утверждает факт). Простой — от последнего
    // действия на любом устройстве: сервер отдаёт его по каждому, своё окно — точнее.
    meIdleMinutes() {
        const activity = this._meDeviceActivity;
        if (!activity || activity.anyActive) return null;
        const sinceInput = Date.now() - Number(this._meLocalInputAt || 0);
        if (sinceInput < this.meActiveWindowMs()) return null;
        const localMinutes = Math.floor(sinceInput / 60000);
        return Math.min(localMinutes, activity.minIdleMinutes ?? localMinutes);
    }

    formatMeIdle(minutes) {
        if (!Number.isFinite(minutes)) return '';
        if (minutes < 60) return `${Math.max(1, minutes)} мин`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours} ч`;
        return `${Math.floor(hours / 24)} д`;
    }

    // Ввод засчитывается, только пока на окно смотрят: mousemove над фоновым окном
    // на Mac приходит и без фокуса.
    noteMeActivity() {
        if (!this.isAppAttended()) return;
        const wasIdle = this.meIdleMinutes() !== null;
        this._meLocalInputAt = Date.now();
        if (wasIdle) this.updateMeStatusDot();
    }

    async refreshMeDeviceActivity() {
        if (this._meActivityInFlight) return;
        if (!this.S.session?.token || !this.S.wsOn) return;
        this._meActivityInFlight = true;
        try {
            const res = await this.apiFetch(this.apiRoutes.devices.activity);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            const devices = Array.isArray(data?.devices) ? data.devices : null;
            if (!devices) throw new Error('no devices');
            const idle = devices.map(device => Number(device?.idleMinutes)).filter(Number.isFinite);
            this._meDeviceActivity = {
                anyActive: devices.some(device => device?.active === true),
                minIdleMinutes: idle.length ? Math.min(...idle) : null,
            };
        } catch (e) {
            this._meDeviceActivity = null;
        } finally {
            this._meActivityInFlight = false;
        }
        this.updateMeStatusDot();
    }

    installMeStatusPolling() {
        if (this._meStatusPollingInstalled) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        this._meStatusPollingInstalled = true;
        this._meLocalInputAt = Date.now();
        let lastMove = 0;
        const note = () => this.noteMeActivity();
        const options = { capture: true, passive: true };
        for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
            document.addEventListener(type, note, options);
        }
        document.addEventListener('pointermove', () => {
            const now = Date.now();
            if (now - lastMove < 5000) return;
            lastMove = now;
            note();
        }, options);
        window.addEventListener('focus', note);
        document.addEventListener('visibilitychange', note);
        setInterval(() => void this.refreshMeDeviceActivity(), ZaliInterface.ME_STATUS_POLL_MS);
        void this.refreshMeDeviceActivity();
    }
});

ZaliInterface.DEVICE_IDLE_REPORT_MS = 30 * 1000;
// Зеркало DeviceKind::active_window_secs (server/src/device_activity.rs).
ZaliInterface.DESKTOP_ACTIVE_WINDOW_MS = 5 * 60 * 1000;
ZaliInterface.MOBILE_ACTIVE_WINDOW_MS = 60 * 1000; // телефон и браузер
ZaliInterface.ME_STATUS_POLL_MS = 30 * 1000;
// С каких минут простоя на аватарке луна и её следующие фазы: с 15 мин — тонкий
// серп, дальше толще, с 6 часов — полный серп (data-phase 1–4). Раньше 15 мин
// простоя — точка «в сети», хотя для маршрута уведомлений устройство уже неактивно.
ZaliInterface.ME_MOON_PHASES = [15, 30, 120, 360];
ZaliInterface.CONVERSATION_VIEW_HEARTBEAT_MS = 25 * 1000;
