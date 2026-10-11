// --- ZaliInterface: ссылки на сервер и профиль (…/server/<код>, …/profile/<имя>). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Один формат на все случаи:
//   https://msg.zalikus.org/server/<код приглашения или id публичного сервера>
//   https://msg.zalikus.org/profile/<имя пользователя>
// Раньше жили `zali://server/<id>` и `zali://invite/<код>` — они по-прежнему
// принимаются, но показывать и копировать мы больше их не будем.
//
// Откуда ссылка попадает в приложение:
//   1) адресная строка веб-клиента (msg.zalikus.org/server/…) — запоминается и
//      отрабатывается после входа;
//   2) клик по ссылке в сообщении — перехватывается, не уходит в браузер;
//   3) «Войти по коду» — принимает и ссылку, и голый код.
//
// Право вступить определяет сервер: по приглашению — любой, по id — только
// в публичный сервер. Клиент лишь разбирает ссылку и показывает результат.

const ZALI_LINK_BASE = 'https://msg.zalikus.org';
const ZALI_PENDING_LINK_KEY = 'zali_pending_link_v1';
const ZALI_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

ZaliMixin(ZaliInterface, class {

    serverLink(token) {
        return `${ZALI_LINK_BASE}/server/${encodeURIComponent(String(token || '').trim())}`;
    }

    profileLink(username) {
        return `${ZALI_LINK_BASE}/profile/${encodeURIComponent(String(username || '').trim())}`;
    }

    /**
     * Разбирает ссылку любого из принимаемых видов.
     * @returns {{kind: 'server'|'profile', token: string}|null}
     */
    parseZaliLink(text) {
        const raw = String(text || '').trim();
        if (!raw || /\s/.test(raw)) return null;
        const origins = [ZALI_LINK_BASE];
        try {
            if (/^https?:$/i.test(location.protocol)) origins.push(location.origin);
        } catch (e) { /* без location */ }
        let rest = raw;
        const stripped = origins.some((origin) => {
            const host = origin.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
            const re = new RegExp(`^(?:https?:\\/\\/)?(?:www\\.)?${host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\/`, 'i');
            if (re.test(rest)) {
                rest = rest.replace(re, '');
                return true;
            }
            return false;
        });
        if (!stripped) rest = rest.replace(/^zali:\/\/(?:localhost\/)?/i, '').replace(/^\/+/, '');
        const match = rest.match(/^(server|invite|profile)\/([^\s?#\/]+)\/?(?:[?#].*)?$/i);
        if (!match) return null;
        let token = match[2];
        try { token = decodeURIComponent(token); } catch (e) { /* оставляем как есть */ }
        token = token.trim();
        if (!token || token.length > 128) return null;
        return { kind: match[1].toLowerCase() === 'profile' ? 'profile' : 'server', token };
    }

    /** Ссылка, с которой открыли страницу (msg.zalikus.org/server/…): запоминаем и чистим адрес. */
    captureLaunchLink() {
        let parsed = null;
        try {
            if (!/^https?:$/i.test(location.protocol)) return;
            parsed = this.parseZaliLink(`${location.origin}${location.pathname}`);
            if (!parsed) return;
            sessionStorage.setItem(ZALI_PENDING_LINK_KEY, JSON.stringify(parsed));
            history.replaceState(null, '', `/${location.search || ''}`);
        } catch (e) { /* без sessionStorage/history ссылка просто не откроется сама */ }
    }

    takePendingLink() {
        try {
            const raw = sessionStorage.getItem(ZALI_PENDING_LINK_KEY);
            if (!raw) return null;
            sessionStorage.removeItem(ZALI_PENDING_LINK_KEY);
            const parsed = JSON.parse(raw);
            return parsed && (parsed.kind === 'server' || parsed.kind === 'profile') && parsed.token ? parsed : null;
        } catch (e) {
            return null;
        }
    }

    /** Вызывается при каждой перерисовке входа; работает один раз, когда сессия уже есть. */
    scheduleDeepLinkConsume() {
        if (!this.S.session?.token || this._deepLinkTimer) return;
        let pending = false;
        try { pending = !!sessionStorage.getItem(ZALI_PENDING_LINK_KEY); } catch (e) { /* нет хранилища */ }
        if (!pending) return;
        this._deepLinkTimer = setTimeout(async () => {
            this._deepLinkTimer = 0;
            const link = this.takePendingLink();
            if (link) await this.openZaliLink(link, { confirm: true });
        }, 700);
    }

    /**
     * Открывает ссылку внутри приложения.
     * @param {string|{kind: string, token: string}} link
     * @param {{confirm?: boolean}} options confirm — спросить перед вступлением
     * @returns {Promise<boolean>} false, если это не наша ссылка
     */
    async openZaliLink(link, { confirm = true } = {}) {
        const parsed = typeof link === 'string' ? this.parseZaliLink(link) : link;
        if (!parsed) return false;
        if (!this.S.session?.token) {
            // Без входа ссылку нельзя отработать — запоминаем до входа.
            try { sessionStorage.setItem(ZALI_PENDING_LINK_KEY, JSON.stringify(parsed)); } catch (e) { /* не критично */ }
            return true;
        }
        if (parsed.kind === 'profile') {
            await this.openProfile(parsed.token);
            return true;
        }
        await this.joinServerFromLink(parsed.token, { confirm });
        return true;
    }

    /** Вступление по токену: код приглашения (любой сервер) или id публичного сервера. */
    async joinServerFromLink(token, { confirm = true } = {}) {
        const value = String(token || '').trim();
        if (!value) return false;
        if (!(this.S.servers || []).length) {
            try { await this.loadServers({ silent: true }); } catch (e) { /* список не обязателен */ }
        }
        const known = (this.S.servers || []).find(server => server.id === value);
        if (known) {
            this.closeServerOverlay?.();
            this.setActiveServer(known.id, { persist: true });
            return true;
        }
        if (confirm) {
            const ok = await this.confirmAction({
                title: 'Вступить на сервер?',
                message: 'Вы открыли ссылку-приглашение. После вступления сервер появится в вашем списке.',
                confirmLabel: 'Вступить',
                cancelLabel: 'Отмена',
                danger: false,
            });
            if (!ok) return false;
        }
        const request = (url, body) => this.apiFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        try {
            let res = null;
            const looksLikeId = ZALI_UUID_RE.test(value);
            if (!looksLikeId && /^[a-z0-9]{4,64}$/i.test(value)) {
                const code = value.toLowerCase();
                res = await request(this.apiRoutes.invites.join(code), { code });
            }
            // Не приглашение (или код не найден) — это может быть id/своя ссылка публичного сервера.
            if (!res || res.status === 404) {
                res = await request(this.apiRoutes.servers.join, { link: value });
            }
            if (!res.ok) {
                const hint = {
                    403: 'Сервер закрытый: вступить можно только по ссылке-приглашению.',
                    404: 'Ссылка не найдена. Возможно, приглашение отозвано.',
                    410: 'Приглашение истекло или уже использовано максимальное число раз.',
                }[res.status];
                throw new Error(hint || (await res.text()) || 'Не удалось вступить по ссылке');
            }
            const data = await res.json();
            await this.loadServers({ silent: true });
            this.closeServerOverlay?.();
            if (data?.serverId) this.setActiveServer(data.serverId, { persist: true });
            this.addLogEntry({ type: 'SUCCESS', msg: 'Вход по ссылке успешен', ts: new Date().toLocaleTimeString() });
            return true;
        } catch (err) {
            const message = String(err?.message || 'Не удалось вступить по ссылке');
            this.addLogEntry({ type: 'ERROR', msg: message, ts: new Date().toLocaleTimeString() });
            await this.confirmAction({
                title: 'Не удалось вступить',
                message,
                confirmLabel: 'Понятно',
                cancelLabel: 'Закрыть',
                danger: false,
            });
            return false;
        }
    }

    /** Клик по ссылке на сервер или профиль в любом месте интерфейса открывает её внутри приложения. */
    bindDeepLinkEvents() {
        if (this._deepLinkBound) return;
        this._deepLinkBound = true;
        // Захват: раньше обработчика внешних ссылок (он отправил бы её в браузер).
        document.addEventListener('click', (e) => {
            if (e.defaultPrevented || e.button > 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
            const anchor = e.target.closest?.('a[href]');
            if (!anchor) return;
            const parsed = this.parseZaliLink(anchor.getAttribute('href') || '');
            if (!parsed) return;
            e.preventDefault();
            e.stopPropagation();
            void this.openZaliLink(parsed, { confirm: true });
        }, true);
        this.captureLaunchLink();
        this.scheduleDeepLinkConsume();
    }
});
