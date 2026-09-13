// --- ZaliInterface: Web Push браузера/PWA — присутствие для сервера, отписка, переход из уведомления. ---
// Подписка (subscribeWebPush) и разрешение на уведомления живут в native_bridge.js.
ZaliMixin(ZaliInterface, class {

    // Сервер шлёт Web Push в подписку устройства, только если на нём сейчас не смотрят в
    // приложение (server/src/push.rs::push_suppressed_for). Узнать это ему не от кого,
    // кроме самой вкладки. Раньше правило было «ни одного живого сокета»: открытое
    // приложение на Mac или замороженная фоновая вкладка на телефоне глушили пуш на все
    // устройства пользователя.
    //
    // `attended` можно передать явно — pagehide сообщает «ухожу» до того, как сокет
    // закроется, иначе пуш о сообщении, пришедшем в эти секунды, был бы подавлен.
    reportClientPresence({ force = false, attended = null } = {}) {
        if (this.hasNativeBridge()) return;
        this.installClientPresenceReporting();
        const socket = this.voice?.socket;
        if (!socket || typeof WebSocket === 'undefined' || socket.readyState !== WebSocket.OPEN) return;
        const nextAttended = attended === null ? this.isAppAttended() : !!attended;
        const deviceId = String(this.currentDeviceId?.() || '');
        const key = `${nextAttended}:${deviceId}`;
        if (!force && this._lastReportedClientPresence === key) return;
        try {
            socket.send(JSON.stringify({ type: 'client_presence', attended: nextAttended, deviceId }));
            this._lastReportedClientPresence = key;
        } catch (e) {}
    }

    installClientPresenceReporting() {
        if (this._clientPresenceReportingInstalled) return;
        if (typeof window === 'undefined' || typeof document === 'undefined') return;
        this._clientPresenceReportingInstalled = true;
        const report = () => this.reportClientPresence();
        document.addEventListener('visibilitychange', report);
        window.addEventListener('focus', report);
        // На blur document.hasFocus() уже false — фокус ушёл до вызова обработчика.
        window.addEventListener('blur', report);
        window.addEventListener('pagehide', () => this.reportClientPresence({ force: true, attended: false }));
    }

    // Выход из аккаунта обязан снять подписку этого браузера: иначе пуши о переписке
    // ушедшего пользователя продолжали бы приходить тому, кто войдёт следующим. Заголовки
    // берутся синхронно, до первого await, — logout() сразу после этого стирает токен.
    async unsubscribeWebPush() {
        if (this.hasNativeBridge()) return;
        if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
        const headers = this.apiHeaders({ 'Content-Type': 'application/json' });
        if (!headers.Authorization) return;
        const url = this.apiUrl('/api/push/unsubscribe');
        try {
            const registration = await navigator.serviceWorker.getRegistration();
            const subscription = await registration?.pushManager?.getSubscription();
            if (!subscription) return;
            await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify({ endpoint: subscription.endpoint }),
            }).catch(() => {});
            await subscription.unsubscribe().catch(() => {});
            this.trace('unsubscribeWebPush ok');
        } catch (e) {
            this.trace(`unsubscribeWebPush failed: ${e?.message || e}`);
        }
    }

    // Клик по уведомлению (web/service-worker.js, notificationclick): открытой вкладке
    // приходит postMessage, новая открывается с ?open=… в адресе.
    installWebPushClickRouting() {
        if (this.hasNativeBridge() || this._webPushClickRoutingInstalled) return;
        this._webPushClickRoutingInstalled = true;
        try {
            navigator.serviceWorker?.addEventListener?.('message', (event) => {
                const data = event?.data;
                if (data && data.type === 'zali:open-conversation') {
                    void this.openConversationFromNotification(data);
                }
            });
        } catch (e) {}
        try {
            const params = new URLSearchParams(window.location.search);
            const raw = params.get('open');
            if (!raw) return;
            params.delete('open');
            const query = params.toString();
            window.history?.replaceState?.(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash || ''}`);
            void this.openConversationFromNotification(JSON.parse(raw));
        } catch (e) {
            this.trace(`installWebPushClickRouting: bad open target: ${e?.message || e}`);
        }
    }

    async openConversationFromNotification(target = {}) {
        if (!this.S.session?.token) return;
        const sender = String(target?.sender || '').trim();
        const serverId = String(target?.serverId || '').trim();
        const channelId = String(target?.channelId || '').trim();
        if (serverId && channelId) {
            // На холодном старте список серверов приходит позже сессии — ждём его, но
            // недолго: уведомление могло указывать на сервер, из которого уже вышли.
            for (let attempt = 0; attempt < 20; attempt += 1) {
                const server = (this.S.servers || []).find(item => item?.id === serverId);
                if (server && (server.channels || []).some(channel => channel?.id === channelId)) {
                    this.setActiveServer(serverId);
                    this.setActiveChannel(channelId);
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, 500));
            }
            return;
        }
        if (sender && sender !== this.myName()) this.switchChat(sender);
    }
});
