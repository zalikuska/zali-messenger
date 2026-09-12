// --- ZaliInterface: Казна сервера: баланс, пополнение, выплаты людям, серверам и ролям. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Всё решает сервер
// (server/src/treasury.rs): права, остаток, состав роли, повтор запроса. Здесь —
// модалка из ПКМ по серверу, ключ идемпотентности и живое обновление по
// server_treasury_updated / coin_server_payout.
ZaliMixin(ZaliInterface, class {

    static get TREASURY_NOTE_MAX_CHARS() { return 140; }

    async openTreasuryModal(serverId) {
        const sid = String(serverId || '').trim();
        const modal = document.getElementById('treasuryModal');
        if (!sid || !modal) return;
        // Модалка живёт в <body>, а не внутри .main: ПКМ по серверу на телефоне
        // открывается с экрана-списка, где .main уехал за край вместе со всем, что в нём.
        if (modal.parentElement !== document.body) document.body.appendChild(modal);
        this.bindTreasuryModalEvents();
        const server = (this.S.servers || []).find(item => item.id === sid);
        this._treasury = {
            serverId: sid,
            name: server?.name || 'Сервер',
            data: null,
            managed: [],
            tab: 'deposit',
            target: 'user',
            key: this.zaliCoinNewIdempotencyKey(),
            lastPayload: '',
            inFlight: false,
            loadSeq: 0,
        };
        ['treasuryDepositAmount', 'treasuryDepositNote', 'treasuryPayoutAmount', 'treasuryPayoutNote', 'treasuryUserInput']
            .forEach(id => { const input = document.getElementById(id); if (input) input.value = ''; });
        const submit = document.getElementById('treasurySubmitBtn');
        if (submit) submit.disabled = false;
        this.setTreasuryStatus('');
        this.renderTreasuryModal();
        modal.hidden = false;
        document.getElementById('treasuryDepositAmount')?.focus({ preventScroll: true });

        const t = this._treasury;
        // Источники пополнения — казны, которыми распоряжаюсь, и свой баланс для подписи.
        const extras = Promise.all([
            this.loadZaliCoinBalance(),
            this.apiFetch(this.apiRoutes.coins.managedTreasuries, { interactive: true })
                .then(res => (res.ok ? res.json() : null))
                .then(data => { if (data && this._treasury === t) t.managed = Array.isArray(data.treasuries) ? data.treasuries : []; })
                .catch(e => this.trace(`treasury managed error=${e}`)),
        ]).then(() => { if (this._treasury === t) this.renderTreasuryModal(); });
        await Promise.all([this.loadTreasury(), extras]);
    }

    closeTreasuryModal() {
        const modal = document.getElementById('treasuryModal');
        if (modal) modal.hidden = true;
        clearTimeout(this._treasuryReloadTimer);
        this._treasury = null;
    }

    async loadTreasury() {
        const t = this._treasury;
        if (!t) return;
        const seq = ++t.loadSeq;
        try {
            const res = await this.apiFetch(this.apiRoutes.servers.treasury(t.serverId), { interactive: true });
            // Опоздавший ответ не должен перетирать более свежий — и чужую, уже закрытую модалку.
            if (this._treasury !== t || seq !== t.loadSeq) return;
            if (!res.ok) {
                this.setTreasuryStatus(await this.treasuryErrorMessage(res, 'Не удалось загрузить казну'));
                return;
            }
            const data = await res.json();
            if (this._treasury !== t || seq !== t.loadSeq) return;
            t.data = data;
            if (data?.name) t.name = data.name;
            this.renderTreasuryModal();
        } catch (e) {
            if (this._treasury !== t) return;
            this.trace(`loadTreasury error=${e}`);
            this.setTreasuryStatus('Не удалось связаться с сервером');
        }
    }

    async treasuryErrorMessage(res, fallback) {
        const text = await res.text().catch(() => '');
        try {
            const data = JSON.parse(text);
            if (data?.message) return String(data.message);
        } catch (_) {}
        return text && text.length < 200 ? text : fallback;
    }

    setTreasuryStatus(message, tone = '') {
        const status = document.getElementById('treasuryStatus');
        if (!status) return;
        status.textContent = message || '';
        status.hidden = !message;
        status.classList.toggle('is-ok', tone === 'ok');
    }

    formatTreasuryTime(iso) {
        const date = new Date(iso);
        if (!iso || Number.isNaN(date.getTime())) return '';
        return date.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    }

    // Селекты пересобираются только при изменении набора: иначе живое обновление
    // казны сбрасывало бы раскрытый список прямо под рукой.
    setTreasuryOptions(select, html, fallbackValue) {
        if (!select) return;
        const previous = select.value;
        if (select.__treasuryHtml !== html) {
            select.innerHTML = html;
            select.__treasuryHtml = html;
        }
        const values = Array.from(select.options).filter(option => !option.disabled).map(option => option.value);
        select.value = values.includes(previous) ? previous : (values.includes(fallbackValue) ? fallbackValue : (values[0] || ''));
    }

    renderTreasuryModal() {
        const t = this._treasury;
        if (!t) return;
        const data = t.data;
        const canManage = !!data?.canManage;
        if (!canManage && t.tab === 'payout') t.tab = 'deposit';

        const name = document.getElementById('treasuryServerName');
        if (name) name.textContent = t.name;
        const balance = document.getElementById('treasuryBalanceValue');
        if (balance) balance.textContent = data ? this.formatCoinAmount(data.balance) : '—';
        const payoutTab = document.getElementById('treasuryPayoutTab');
        if (payoutTab) payoutTab.hidden = !canManage;
        document.querySelectorAll('#treasuryModal [data-treasury-tab]').forEach(tab => {
            const active = tab.getAttribute('data-treasury-tab') === t.tab;
            tab.classList.toggle('is-active', active);
            tab.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        document.querySelectorAll('#treasuryModal [data-treasury-pane]').forEach(pane => {
            pane.hidden = pane.getAttribute('data-treasury-pane') !== t.tab;
        });
        const hint = document.getElementById('treasuryDepositHint');
        if (hint) hint.hidden = !data || canManage;
        const submit = document.getElementById('treasurySubmitBtn');
        if (submit) {
            submit.hidden = t.tab === 'history';
            submit.textContent = t.tab === 'payout' ? 'Выплатить' : 'Пополнить';
        }

        this.renderTreasuryDepositSources();
        this.renderTreasuryPayoutTargets();
        this.renderTreasuryHistory();
        this.updateTreasurySummary();
    }

    renderTreasuryDepositSources() {
        const t = this._treasury;
        if (!t) return;
        const own = `<option value="user">Мои ZaliCoin · ${this.formatCoinAmount(this.S.zaliCoinBalance)} ZC</option>`;
        const servers = t.managed
            .filter(item => item.serverId !== t.serverId)
            .map(item => `<option value="server:${this.esc(item.serverId)}">Казна «${this.esc(item.name)}» · ${this.formatCoinAmount(item.balance)} ZC</option>`)
            .join('');
        this.setTreasuryOptions(document.getElementById('treasuryDepositSource'), own + servers, 'user');
    }

    renderTreasuryPayoutTargets() {
        const t = this._treasury;
        if (!t) return;
        const data = t.data || {};
        document.querySelectorAll('#treasuryModal [data-treasury-target]').forEach(button => {
            const active = button.getAttribute('data-treasury-target') === t.target;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        const fields = { user: 'treasuryUserField', server: 'treasuryServerField', role: 'treasuryRoleField' };
        Object.entries(fields).forEach(([kind, id]) => {
            const field = document.getElementById(id);
            if (field) field.hidden = t.target !== kind;
        });
        const amountLabel = document.getElementById('treasuryPayoutAmountLabel');
        if (amountLabel) amountLabel.textContent = t.target === 'role' ? 'Сумма каждому (ZC)' : 'Сумма (ZC)';

        const datalist = document.getElementById('treasuryMembersList');
        if (datalist) {
            const html = (Array.isArray(data.members) ? data.members : [])
                .map(username => `<option value="${this.esc(username)}"></option>`)
                .join('');
            if (datalist.__treasuryHtml !== html) {
                datalist.innerHTML = html;
                datalist.__treasuryHtml = html;
            }
        }
        const otherServers = (this.S.servers || []).filter(server => server && server.id !== t.serverId);
        const serverOptions = otherServers.length
            ? otherServers.map(server => `<option value="${this.esc(server.id)}">${this.esc(server.name || 'Сервер')}</option>`).join('')
            : '<option value="" disabled>Других серверов у вас нет</option>';
        this.setTreasuryOptions(document.getElementById('treasuryServerSelect'), serverOptions, '');
        const roles = Array.isArray(data.roles) ? data.roles : [];
        const roleOptions = roles.map(role => {
            const count = Number(role.members) || 0;
            return `<option value="${this.esc(role.roleId)}">${this.esc(role.name)} · ${count} ${this.coinPlural(count, ['участник', 'участника', 'участников'])}</option>`;
        }).join('');
        this.setTreasuryOptions(document.getElementById('treasuryRoleSelect'), roleOptions, '*');
    }

    renderTreasuryHistory() {
        const t = this._treasury;
        const list = document.getElementById('treasuryHistory');
        if (!t || !list) return;
        const operations = Array.isArray(t.data?.operations) ? t.data.operations : [];
        if (!t.data) {
            list.innerHTML = '<div class="treasury-history-empty">Загрузка…</div>';
            return;
        }
        if (!operations.length) {
            list.innerHTML = '<div class="treasury-history-empty">Операций с казной пока не было</div>';
            return;
        }
        list.innerHTML = operations.map(op => {
            const incoming = op.targetKind === 'server' && op.targetId === t.serverId;
            let title;
            if (incoming) {
                title = op.sourceKind === 'user' ? `${op.sourceName} пополнил(а) казну` : `Из казны «${op.sourceName}»`;
            } else if (op.targetKind === 'user') {
                title = `Выплата ${op.targetName}`;
            } else if (op.targetKind === 'server') {
                title = `В казну «${op.targetName}»`;
            } else {
                const count = Number(op.recipients) || 0;
                title = `Роли «${op.targetName}»: ${count} ${this.coinPlural(count, ['участнику', 'участникам', 'участникам'])} по ${this.formatCoinAmount(op.amount)} ZC`;
            }
            const byActor = incoming && op.sourceKind === 'user' ? '' : op.actor;
            const meta = [byActor, this.formatTreasuryTime(op.createdAt)].filter(Boolean).join(' · ');
            return `<div class="treasury-op ${incoming ? 'is-in' : 'is-out'}">
                <div class="treasury-op-main">
                    <span class="treasury-op-title">${this.esc(title)}</span>
                    <span class="treasury-op-meta">${this.esc(meta)}</span>
                    ${op.note ? `<span class="treasury-op-note">${this.esc(op.note)}</span>` : ''}
                </div>
                <span class="treasury-op-amount">${incoming ? '+' : '−'}${this.formatCoinAmount(op.total)} ZC</span>
            </div>`;
        }).join('');
    }

    updateTreasurySummary() {
        const t = this._treasury;
        const summary = document.getElementById('treasuryPayoutSummary');
        if (!summary) return;
        const roles = Array.isArray(t?.data?.roles) ? t.data.roles : [];
        const role = roles.find(item => item.roleId === document.getElementById('treasuryRoleSelect')?.value);
        if (!t || t.tab !== 'payout' || t.target !== 'role' || !role) {
            summary.hidden = true;
            return;
        }
        const count = Number(role.members) || 0;
        const amount = Math.trunc(Number(document.getElementById('treasuryPayoutAmount')?.value));
        const people = this.coinPlural(count, ['участник', 'участника', 'участников']);
        if (count === 0) {
            summary.textContent = 'У этой роли пока нет участников — выплачивать некому.';
        } else if (Number.isFinite(amount) && amount > 0) {
            const total = amount * count;
            const short = total > (Number(t.data?.balance) || 0) ? ' Столько в казне нет.' : '';
            summary.textContent = `Получат ${count} ${people} — по ${this.formatCoinAmount(amount)} ZC, всего ${this.formatCoinAmount(total)} ZC из казны.${short}`;
        } else {
            summary.textContent = `Получат ${count} ${people}, каждому — указанная сумма.`;
        }
        summary.hidden = false;
    }

    async submitTreasury() {
        const t = this._treasury;
        if (!t || t.inFlight || t.tab === 'history') return;
        const isPayout = t.tab === 'payout';
        const amountInput = document.getElementById(isPayout ? 'treasuryPayoutAmount' : 'treasuryDepositAmount');
        const noteInput = document.getElementById(isPayout ? 'treasuryPayoutNote' : 'treasuryDepositNote');
        const amount = Math.trunc(Number(amountInput?.value));
        const note = String(noteInput?.value || '').trim().slice(0, ZaliInterface.TREASURY_NOTE_MAX_CHARS);
        if (!Number.isFinite(amount) || amount <= 0) {
            this.setTreasuryStatus('Укажите сумму больше нуля');
            return;
        }

        let path;
        let payload;
        if (!isPayout) {
            const source = document.getElementById('treasuryDepositSource')?.value || 'user';
            payload = source.startsWith('server:')
                ? { source: 'server', sourceServerId: source.slice('server:'.length), amount, note }
                : { source: 'user', amount, note };
            path = this.apiRoutes.servers.treasuryDeposit(t.serverId);
        } else {
            const to = t.target === 'user'
                ? String(document.getElementById('treasuryUserInput')?.value || '').trim()
                : String(document.getElementById(t.target === 'server' ? 'treasuryServerSelect' : 'treasuryRoleSelect')?.value || '');
            if (!to) {
                this.setTreasuryStatus({ user: 'Укажите получателя', server: 'Выберите сервер', role: 'Выберите роль' }[t.target]);
                return;
            }
            payload = { target: t.target, to, amount, note };
            path = this.apiRoutes.servers.treasuryPayout(t.serverId);
        }

        // Ключ описывает один точный запрос (как в submitCoinTransfer): изменили
        // получателя или сумму после сетевой ошибки — ключ новый, иначе повтор
        // вернул бы как «успех» ту операцию, что прошла со старыми данными.
        const signature = JSON.stringify([t.tab, payload]);
        if (t.lastPayload && t.lastPayload !== signature) t.key = this.zaliCoinNewIdempotencyKey();
        t.lastPayload = signature;

        const submit = document.getElementById('treasurySubmitBtn');
        t.inFlight = true;
        if (submit) submit.disabled = true;
        this.setTreasuryStatus('Отправка...');
        let res;
        try {
            res = await this.coinPostWithRetry(path, { ...payload, idempotencyKey: t.key });
        } catch (e) {
            this.trace(`submitTreasury transport_error=${e}`);
            if (this._treasury !== t) return;
            t.inFlight = false;
            if (submit) submit.disabled = false;
            this.setTreasuryStatus('Не удалось связаться с сервером, попробуйте ещё раз');
            return;
        }
        if (this._treasury === t) {
            t.inFlight = false;
            if (submit) submit.disabled = false;
        }
        if (!res.ok) {
            const message = await this.treasuryErrorMessage(res, isPayout ? 'Не удалось выполнить выплату' : 'Не удалось пополнить казну');
            if (this._treasury === t) this.setTreasuryStatus(message);
            return;
        }

        // Операция проведена — дальше ничто не должно выглядеть как её провал.
        const data = await res.json().catch(() => null);
        const operation = data?.operation || null;
        if (Number.isFinite(Number(data?.balance))) this.S.zaliCoinBalance = Number(data.balance);
        this.scheduleZaliCoinRefresh();
        const logMessage = isPayout
            ? `Казна «${t.name}»: выплачено ${operation?.total ?? amount} ZaliCoin`
            : `Казна «${t.name}» пополнена на ${amount} ZaliCoin`;
        this.addLogEntry({ type: 'INFO', msg: logMessage, ts: new Date().toLocaleTimeString() });
        if (this._treasury !== t) return;

        t.key = this.zaliCoinNewIdempotencyKey();
        t.lastPayload = '';
        (Array.isArray(data?.treasuries) ? data.treasuries : []).forEach(item => {
            if (item.serverId === t.serverId && t.data) t.data.balance = Number(item.balance) || 0;
            const managed = t.managed.find(entry => entry.serverId === item.serverId);
            if (managed) managed.balance = Number(item.balance) || 0;
        });
        if (operation && t.data) {
            const operations = Array.isArray(t.data.operations) ? t.data.operations : [];
            if (!operations.some(op => op.id === operation.id)) t.data.operations = [operation, ...operations];
        }
        if (amountInput) amountInput.value = '';
        if (noteInput) noteInput.value = '';
        let done;
        if (!isPayout) {
            done = `Казна пополнена на ${this.formatCoinAmount(amount)} ZC`;
        } else if (operation?.targetKind === 'role') {
            const count = Number(operation.recipients) || 0;
            done = `Выплачено ${count} ${this.coinPlural(count, ['участнику', 'участникам', 'участникам'])} — всего ${this.formatCoinAmount(operation.total)} ZC`;
        } else {
            done = `Выплачено ${this.formatCoinAmount(amount)} ZC`;
        }
        this.renderTreasuryModal();
        this.setTreasuryStatus(done, 'ok');
    }

    // Новый остаток казны. Событие несёт только баланс, поэтому история
    // перечитывается — схлопнуто, пачка операций даёт один запрос.
    handleTreasuryRealtime(payload) {
        const serverId = String(payload?.serverId || '');
        const balance = Number(payload?.balance);
        const t = this._treasury;
        if (!t || !serverId || !Number.isFinite(balance)) return;
        const managed = t.managed.find(entry => entry.serverId === serverId);
        if (managed) managed.balance = balance;
        if (t.serverId === serverId) {
            if (t.data) t.data.balance = balance;
            clearTimeout(this._treasuryReloadTimer);
            this._treasuryReloadTimer = setTimeout(() => void this.loadTreasury(), 400);
        }
        this.renderTreasuryModal();
    }

    // Сервер перечислил вам ZaliCoin из казны — раздел «От серверов».
    handleServerPayoutRealtime(payload) {
        const payout = payload?.payout;
        if (!payout?.operationId) return;
        const list = Array.isArray(this.S.zaliCoinServerPayouts) ? this.S.zaliCoinServerPayouts : [];
        if (list.some(item => item.operationId === payout.operationId)) return;
        this.S.zaliCoinServerPayouts = [payout, ...list];
        this.addLogEntry({
            type: 'INFO',
            msg: `Сервер «${payout.serverName}» перечислил вам ${payout.amount} ZaliCoin`,
            ts: new Date().toLocaleTimeString(),
        });
        if (this.isZaliCoinViewActive()) {
            this.renderServerPayouts();
            this.scheduleZaliCoinRefresh();
        }
    }

    bindTreasuryModalEvents() {
        const modal = document.getElementById('treasuryModal');
        if (!modal || modal.__treasuryBound) return;
        modal.__treasuryBound = true;
        modal.addEventListener('click', (e) => {
            if (e.target === modal) { this.closeTreasuryModal(); return; }
            const t = this._treasury;
            if (!t) return;
            const tab = e.target.closest('[data-treasury-tab]');
            if (tab) {
                t.tab = tab.getAttribute('data-treasury-tab') || 'deposit';
                this.setTreasuryStatus('');
                this.renderTreasuryModal();
                return;
            }
            const target = e.target.closest('[data-treasury-target]');
            if (target) {
                t.target = target.getAttribute('data-treasury-target') || 'user';
                this.setTreasuryStatus('');
                this.renderTreasuryModal();
            }
        });
        document.getElementById('treasuryCloseBtn')?.addEventListener('click', () => this.closeTreasuryModal());
        document.getElementById('treasuryCancelBtn')?.addEventListener('click', () => this.closeTreasuryModal());
        document.getElementById('treasurySubmitBtn')?.addEventListener('click', () => this.submitTreasury());
        const refreshSummary = (e) => {
            if (e.target.matches?.('#treasuryPayoutAmount, #treasuryRoleSelect')) this.updateTreasurySummary();
        };
        modal.addEventListener('input', refreshSummary);
        modal.addEventListener('change', refreshSummary);
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.closeTreasuryModal();
                return;
            }
            if (e.key === 'Enter' && e.target.matches?.('input')) {
                e.preventDefault();
                this.submitTreasury();
            }
        });
    }
});
