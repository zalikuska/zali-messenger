// --- ZaliInterface: «Восстановить переписку» через собеседника. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Сервер —
// server/src/history_recovery.rs.
//
// Ключи личной переписки есть у обоих её участников. Потерял их один — сбросил
// пароль (облачный vault удаляется вместе со старым паролем), вошёл с нового
// устройства, очистил хранилище — правой кнопкой по собеседнику → «Восстановить
// переписку». Запрос ждёт на сервере, и как только собеседник появится в сети,
// его приложение само пришлёт все ключи этой переписки на устройства спросившего
// (тот же путь, что ответ на key_republish_request: handleKeyRepublishRequest) и
// отметит запрос выполненным. Спросившему приходит history_recovery_update — он
// забирает конверты и перерисовывает сообщения.
ZaliMixin(ZaliInterface, class {

    canonicalDmScope(a, b) {
        const x = String(a || '').trim().toLowerCase();
        const y = String(b || '').trim().toLowerCase();
        if (!x || !y) return '';
        return x <= y ? `dm:${x}:${y}` : `dm:${y}:${x}`;
    }

    historyRecoveryStatus(peer) {
        return this.S.historyRecovery?.[String(peer || '').trim().toLowerCase()] || null;
    }

    async requestHistoryRecovery(peer) {
        const name = String(peer || '').trim();
        if (!name || !this.S.session?.token || this.S.session?.guest || name === this.myName()) return;
        const confirmed = await this.confirmAction({
            title: 'Восстановить переписку',
            message: `Попросим ${name} прислать ключи вашей переписки. Как только ${name} будет в сети, приложение отправит их само — нажимать ничего не придётся, а сообщения снова откроются.`,
            confirmLabel: 'Отправить запрос',
            cancelLabel: 'Отмена',
            danger: false,
        });
        if (!confirmed) return;
        const startedAt = Date.now();
        try {
            const res = await this.apiFetch(this.apiRoutes.historyRecovery.base, {
                method: 'POST',
                body: JSON.stringify({ peer: name }),
                interactive: true,
            });
            if (!res.ok) throw new Error(await this.readApiError(res, 'Не удалось отправить запрос'));
            const data = await res.json();
            const key = String(data?.peer || name).toLowerCase();
            // Собеседник в сети может ответить раньше, чем придёт ответ на сам запрос:
            // его history_recovery_update тогда уже записал итог — не затираем его «ждём».
            const prev = this.S.historyRecovery?.[key];
            const answered = prev && prev.id === data?.id && prev.status !== 'pending' && prev.at >= startedAt;
            if (!answered) {
                this.S.historyRecovery = { ...(this.S.historyRecovery || {}), [key]: { id: data?.id, status: 'pending', at: Date.now() } };
            }
            this.addLogEntry({ type: 'INFO', msg: `Запрос на восстановление переписки отправлен ${name}`, ts: new Date().toLocaleTimeString() });
            this.showToast({
                title: 'Запрос отправлен',
                text: data?.peerOnline
                    ? `${name} в сети — ключи придут через несколько секунд.`
                    : `Переписка восстановится, когда ${name} появится в сети.`,
                tone: 'success',
            });
        } catch (e) {
            this.showToast({
                title: 'Не удалось отправить запрос',
                text: this.networkErrorText(e, 'Попробуйте ещё раз.'),
                tone: 'error',
            });
        }
    }

    /** Собеседник просит ключи. Пока ключи этого устройства не восстановлены — ждём. */
    handleHistoryRecoveryRequest(payload) {
        const id = String(payload?.id || '').trim();
        if (!id) return;
        if (!this._historyRecoveryReady) {
            // processPendingHistoryRecovery() после postAuthSetup заберёт его списком.
            this.trace(`historyRecovery deferred id=${id} reason=keys_not_ready`);
            return;
        }
        void this.answerHistoryRecovery(payload);
    }

    async answerHistoryRecovery(payload) {
        const id = String(payload?.id || '').trim();
        const requester = String(payload?.requester || '').trim();
        const scope = String(payload?.scope || '').trim();
        const me = String(this.myName() || '').trim();
        if (!id || !requester || !scope || !me || !this.S.session?.token) return;
        // Только наша личная переписка и только с самим спросившим: иначе подменённое
        // событие («пришли alice ключи вашей переписки с bob») уводило бы чужие ключи.
        if (requester.toLowerCase() === me.toLowerCase() || scope !== this.canonicalDmScope(me, requester)) {
            this.trace(`historyRecovery rejected id=${id} scope=${scope} requester=${requester}`);
            return;
        }
        this._historyRecoveryInFlight = this._historyRecoveryInFlight || new Set();
        if (this._historyRecoveryInFlight.has(id)) return;
        this._historyRecoveryInFlight.add(id);
        try {
            const held = this.conversationKeyCandidates(this.loadStoredConversationKeys(), scope);
            if (!held.length) {
                // Ключей нет здесь — они могут быть на другом устройстве собеседника:
                // запрос остаётся ждать его, а не закрывается «нечего прислать».
                this.trace(`historyRecovery no local keys id=${id} scope=${scope}`);
                return;
            }
            const sent = await this.handleKeyRepublishRequest({ scope, requester });
            if (!sent) {
                this.trace(`historyRecovery publish failed id=${id} — повторим при следующем подключении`);
                return;
            }
            const res = await this.apiFetch(this.apiRoutes.historyRecovery.fulfill(id), {
                method: 'POST',
                body: JSON.stringify({ result: 'sent' }),
            });
            if (res.ok) {
                this.addLogEntry({ type: 'INFO', msg: `По запросу ${requester} отправлены ключи вашей переписки`, ts: new Date().toLocaleTimeString() });
                // Видимо, а не молча: если аккаунт собеседника угнали, лучше узнать сразу.
                this.showToast({
                    title: 'Переписка восстановлена',
                    text: `${requester} потерял ключи вашей переписки — приложение отправило их на его устройства.`,
                    timeoutMs: 8000,
                });
            }
        } catch (e) {
            this.trace(`historyRecovery answer failed id=${id} error=${e?.message || e}`);
        } finally {
            this._historyRecoveryInFlight.delete(id);
        }
    }

    /** После postAuthSetup: ключи загружены — ответить на всё, что ждёт, и узнать свои запросы. */
    async processPendingHistoryRecovery() {
        if (!this.S.session?.token || this.S.session?.guest) return;
        this._historyRecoveryReady = true;
        try {
            const res = await this.apiFetch(this.apiRoutes.historyRecovery.base);
            if (!res.ok) return;
            const data = await res.json();
            const outgoing = {};
            for (const row of Array.isArray(data?.outgoing) ? data.outgoing : []) {
                const peer = String(row?.peer || '').toLowerCase();
                if (peer) outgoing[peer] = { id: row.id, status: row.status, at: Number(row.updatedAt || 0) * 1000 };
            }
            this.S.historyRecovery = outgoing;
            for (const row of Array.isArray(data?.incoming) ? data.incoming : []) {
                await this.answerHistoryRecovery(row);
            }
        } catch (e) {
            this.trace(`processPendingHistoryRecovery failed error=${e?.message || e}`);
        }
    }

    /** Ответ собеседника на наш запрос. */
    async handleHistoryRecoveryUpdate(payload) {
        const peer = String(payload?.peer || '').trim();
        const status = String(payload?.status || '');
        if (!peer) return;
        this.S.historyRecovery = {
            ...(this.S.historyRecovery || {}),
            [peer.toLowerCase()]: { id: payload?.id, status, at: Date.now() },
        };
        if (status === 'fulfilled') {
            try {
                await this.syncIncomingKeyEnvelopes({ reason: 'history_recovery' });
            } catch (e) {
                this.trace(`historyRecovery sync failed error=${e?.message || e}`);
            }
            void this.refreshAfterKey?.();
            this.addLogEntry({ type: 'SUCCESS', msg: `${peer} прислал ключи — переписка восстановлена`, ts: new Date().toLocaleTimeString() });
            this.showToast({ title: 'Переписка восстановлена', text: `${peer} прислал ключи, сообщения снова читаются.`, tone: 'success' });
        } else if (status === 'no_key') {
            this.showToast({ title: 'Не удалось восстановить', text: `У ${peer} тоже нет ключей этой переписки.`, tone: 'error' });
        }
    }
});
