// --- ZaliInterface: Казна сервера: окно с балансом, итогами, операциями и историей. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Всё решает сервер
// (server/src/treasury.rs): права, остаток, состав роли, повтор запроса, итоги
// за всё время. Здесь — окно из ПКМ по серверу (и кнопки меню сервера), ключ
// идемпотентности и живое обновление по server_treasury_updated /
// coin_server_payout.
//
// Окно — полноценная страница в языке «Фокуса» (docs/UI_GUIDELINES.md): шапка
// с аватаркой сервера → крупный баланс → три итога → операция (пополнить /
// выплатить) → история по дням с фильтром; справа — кто пополнял и правила.
// На компьютере слой живёт в .main, как настройки сервера, — сайдбар остаётся
// виден и кликабелен; на телефоне он переносится в <body>: там лента серверов
// живёт на экране-списке, где .main вместе со всем содержимым уехал за край.
ZaliMixin(ZaliInterface, class {

    static get TREASURY_NOTE_MAX_CHARS() { return 140; }
    /** Быстрые суммы под полем «Сумма»; последняя кнопка — «Всё». */
    static get TREASURY_QUICK_AMOUNTS() { return [100, 500, 1000, 10000]; }

    placeTreasuryModal(modal) {
        const phone = typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 760px)').matches;
        const host = phone ? document.body : (document.querySelector('.app .main') || document.body);
        if (modal.parentElement !== host) host.appendChild(modal);
        modal.classList.toggle('is-floating', host === document.body);
    }

    async openTreasuryModal(serverId) {
        const sid = String(serverId || '').trim();
        const modal = document.getElementById('treasuryModal');
        if (!sid || !modal) return;
        this.placeTreasuryModal(modal);
        this.bindTreasuryModalEvents();
        const server = (this.S.servers || []).find(item => item.id === sid);
        this._treasury = {
            serverId: sid,
            name: server?.name || 'Сервер',
            data: null,
            managed: [],
            tab: 'deposit',
            target: 'user',
            filter: 'all',
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
        modal.querySelector('.tr-body')?.scrollTo?.(0, 0);
        // На телефоне фокус поднял бы клавиатуру поверх баланса и итогов сразу
        // при открытии — там человек сначала смотрит, а потом решает, что делать.
        if (!modal.classList.contains('is-floating')) document.getElementById('treasuryDepositAmount')?.focus({ preventScroll: true });

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
        const date = this.treasuryDate(iso);
        if (!date) return '';
        return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    }

    /**
     * SQLite отдаёт время как «YYYY-MM-DD HH:MM:SS» без зоны, а это UTC: без
     * явного «Z» браузер сдвинул бы всё на смещение часового пояса.
     */
    treasuryDate(raw) {
        const value = String(raw || '').trim();
        if (!value) return null;
        const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
        const date = new Date(iso);
        return Number.isNaN(date.getTime()) ? null : date;
    }

    treasuryDayLabel(date) {
        const day = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        if (day === today) return 'Сегодня';
        if (day === today - 86400000) return 'Вчера';
        const sameYear = date.getFullYear() === now.getFullYear();
        return date.toLocaleDateString('ru-RU', sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
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

    treasuryCanManage() {
        const t = this._treasury;
        if (!t) return false;
        // Права приходят вместе с казной. Пока данных нет (нет сети, сервер не
        // ответил), владелец и админ всё равно видят «Выплатить»: роль известна
        // из списка серверов, а отказ скажет сама выплата.
        if (t.data) return !!t.data.canManage;
        const knownServer = (this.S.servers || []).find(item => item.id === t.serverId);
        return this.canManageServer(knownServer);
    }

    renderTreasuryModal() {
        const t = this._treasury;
        if (!t) return;
        const data = t.data;
        const canManage = this.treasuryCanManage();
        if (!canManage && t.tab === 'payout') t.tab = 'deposit';

        this.renderTreasuryHead();
        const balance = document.getElementById('treasuryBalanceValue');
        if (balance) balance.textContent = data ? this.formatCoinAmount(data.balance) : '—';
        const meta = document.getElementById('treasuryBalanceMeta');
        if (meta) {
            const supply = Number(this.S.zaliCoinTotalSupply) || ZaliInterface.ZALICOIN_DEFAULT_SUPPLY;
            const share = data && supply > 0 ? (Number(data.balance) || 0) / supply * 100 : 0;
            meta.textContent = !data ? 'Загрузка…'
                : share === 0 ? 'Казна пуста — её пополняют участники сервера'
                    : `${share < 0.01 ? '<0,01' : share.toLocaleString('ru-RU', { maximumFractionDigits: 2 })} % всей эмиссии ZaliCoin`;
        }

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
        const submit = document.getElementById('treasurySubmitBtn');
        if (submit) submit.textContent = t.tab === 'payout' ? 'Выплатить' : 'Пополнить';

        this.renderTreasuryStats();
        this.renderTreasuryDepositSources();
        this.renderTreasuryPayoutTargets();
        this.renderTreasuryChips();
        this.renderTreasuryHistory();
        this.renderTreasuryContributors();
        this.renderTreasuryYou();
        this.updateTreasurySummary();
    }

    /** Шапка: аватарка сервера — тем же путём, что в рейке и шапке канала. */
    renderTreasuryHead() {
        const t = this._treasury;
        if (!t) return;
        const server = (this.S.servers || []).find(item => item.id === t.serverId) || { id: t.serverId, name: t.name };
        this.paintServerAvatar(document.getElementById('treasuryServerAvatar'), server);
        const name = document.getElementById('treasuryServerName');
        if (name) {
            const members = Number(server.memberCount || 0);
            const text = members > 0
                ? `${t.name} · ${members} ${this.ruPlural(members, 'участник', 'участника', 'участников')}`
                : t.name;
            if (name.textContent !== text) name.textContent = text;
        }
    }

    /**
     * Итоги за всё время — с сервера (stats). Старый сервер их не отдаёт: тогда
     * считаем по загруженной истории и честно подписываем «за последние N».
     */
    treasuryStats() {
        const t = this._treasury;
        const data = t?.data;
        if (!data) return null;
        if (data.stats && typeof data.stats === 'object') {
            return {
                totalIn: Number(data.stats.totalIn) || 0,
                totalOut: Number(data.stats.totalOut) || 0,
                operations: Number(data.stats.operations) || 0,
                contributors: Array.isArray(data.stats.contributors) ? data.stats.contributors : [],
                partial: false,
            };
        }
        const operations = Array.isArray(data.operations) ? data.operations : [];
        const byUser = new Map();
        let totalIn = 0;
        let totalOut = 0;
        operations.forEach(op => {
            const total = Number(op.total) || 0;
            if (this.treasuryOpIsIncoming(op)) {
                totalIn += total;
                if (op.sourceKind === 'user') {
                    const entry = byUser.get(op.sourceId) || { username: op.sourceId, total: 0, count: 0 };
                    entry.total += total;
                    entry.count += 1;
                    byUser.set(op.sourceId, entry);
                }
            } else {
                totalOut += total;
            }
        });
        const contributors = [...byUser.values()].sort((a, b) => b.total - a.total).slice(0, 5);
        return { totalIn, totalOut, operations: operations.length, contributors, partial: true };
    }

    treasuryOpIsIncoming(op) {
        const t = this._treasury;
        return !!t && op?.targetKind === 'server' && op?.targetId === t.serverId;
    }

    renderTreasuryStats() {
        const stats = this.treasuryStats();
        const set = (id, text) => {
            const el = document.getElementById(id);
            if (el && el.textContent !== text) el.textContent = text;
        };
        set('treasuryStatIn', stats ? `${this.formatCoinAmount(stats.totalIn)} ZC` : '—');
        set('treasuryStatOut', stats ? `${this.formatCoinAmount(stats.totalOut)} ZC` : '—');
        set('treasuryStatOps', stats ? this.formatCoinAmount(stats.operations) : '—');
        const wrap = document.querySelector('#treasuryModal .tr-stats');
        if (wrap) wrap.title = stats?.partial ? 'По загруженной истории — сервер не прислал итоги за всё время' : '';
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
        if (amountLabel) amountLabel.textContent = t.target === 'role' ? 'Каждому' : 'Сумма';

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

    /** Сколько можно потратить в текущей операции — для кнопки «Всё». */
    treasuryAvailable() {
        const t = this._treasury;
        if (!t) return 0;
        if (t.tab === 'payout') {
            const balance = Number(t.data?.balance) || 0;
            if (t.target !== 'role') return balance;
            const role = (t.data?.roles || []).find(item => item.roleId === document.getElementById('treasuryRoleSelect')?.value);
            const count = Number(role?.members) || 0;
            return count > 0 ? Math.floor(balance / count) : 0;
        }
        const source = document.getElementById('treasuryDepositSource')?.value || 'user';
        if (source.startsWith('server:')) {
            const managed = t.managed.find(item => `server:${item.serverId}` === source);
            return Number(managed?.balance) || 0;
        }
        return Number(this.S.zaliCoinBalance) || 0;
    }

    renderTreasuryChips() {
        const t = this._treasury;
        const box = document.querySelector(`#treasuryModal [data-treasury-chips="${t?.tab || 'deposit'}"]`);
        if (!t || !box) return;
        const available = this.treasuryAvailable();
        const html = ZaliInterface.TREASURY_QUICK_AMOUNTS
            .map(amount => `<button type="button" class="tr-chip" data-treasury-amount="${this.esc(String(amount))}"${amount > available ? ' disabled' : ''}>${this.formatCoinAmount(amount)}</button>`)
            .join('')
            + `<button type="button" class="tr-chip" data-treasury-amount="all"${available > 0 ? '' : ' disabled'}>Всё · ${this.formatCoinAmount(available)}</button>`;
        this.setHTMLIfChanged(box, html);
    }

    renderTreasuryHistory() {
        const t = this._treasury;
        const list = document.getElementById('treasuryHistory');
        if (!t || !list) return;
        document.querySelectorAll('#treasuryModal [data-treasury-filter]').forEach(button => {
            const active = button.getAttribute('data-treasury-filter') === t.filter;
            button.classList.toggle('is-active', active);
            button.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        const count = document.getElementById('treasuryHistoryCount');
        if (!t.data) {
            if (count) count.textContent = '…';
            // Пока история в пути — тишина, а не «Загрузка…» (гайдлайны §4).
            this.setHTMLIfChanged(list, '');
            return;
        }
        const all = Array.isArray(t.data.operations) ? t.data.operations : [];
        const operations = all.filter(op => t.filter === 'all' || (t.filter === 'in') === this.treasuryOpIsIncoming(op));
        if (count) count.textContent = String(operations.length);
        if (!operations.length) {
            const empty = !all.length ? 'Операций с казной пока не было'
                : t.filter === 'in' ? 'Поступлений пока не было' : 'Выплат пока не было';
            this.setHTMLIfChanged(list, `<p class="tr-empty">${empty}</p>`);
            return;
        }
        let lastDay = '';
        const rows = [];
        operations.forEach(op => {
            const date = this.treasuryDate(op.createdAt);
            const day = date ? this.treasuryDayLabel(date) : '';
            if (day && day !== lastDay) {
                rows.push(`<div class="tr-day">${this.esc(day)}</div>`);
                lastDay = day;
            }
            rows.push(this.renderTreasuryOperation(op));
        });
        // История ограничена на сервере (TREASURY_HISTORY_LIMIT) — об этом стоит сказать.
        if (all.length >= 50 && t.filter === 'all') rows.push('<p class="tr-empty">Показаны последние 50 операций</p>');
        this.setHTMLIfChanged(list, rows.join(''));
    }

    renderTreasuryOperation(op) {
        const t = this._treasury;
        const incoming = this.treasuryOpIsIncoming(op);
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
        // Плитка строки — знак второй стороны операции (гайдлайны §4, «Знаки»):
        // человек, казна другого сервера или люди роли. Направление говорят
        // знак суммы (+/−) и акцентный глиф у входящих.
        const counterpart = incoming ? op.sourceKind : op.targetKind;
        const sign = counterpart === 'user' ? 'person' : counterpart === 'server' ? 'chest' : 'people';
        const glyph = this.zaliSign(sign);
        return `<div class="tr-op ${incoming ? 'is-in' : 'is-out'}">
            <span class="tr-op-ico">${glyph}</span>
            <span class="tr-op-main">
                <span class="tr-op-title">${this.esc(title)}</span>
                <span class="tr-op-meta">${this.esc(meta)}</span>
                ${op.note ? `<span class="tr-op-note">${this.esc(op.note)}</span>` : ''}
            </span>
            <span class="tr-op-amount">${incoming ? '+' : '−'}${this.formatCoinAmount(op.total)} <em>ZC</em></span>
        </div>`;
    }

    renderTreasuryContributors() {
        const box = document.getElementById('treasuryContributors');
        if (!box) return;
        const stats = this.treasuryStats();
        if (!stats) {
            this.setHTMLIfChanged(box, '');
            return;
        }
        if (!stats.contributors.length) {
            this.setHTMLIfChanged(box, '<p class="tr-empty">Пока никто не пополнял — станьте первым</p>');
            return;
        }
        const me = this.myName();
        const html = stats.contributors.map((person, index) => {
            const name = String(person.username || '');
            const count = Number(person.count) || 0;
            return `<div class="tr-person${name === me ? ' is-me' : ''}">
                <span class="tr-person-rank">${index + 1}</span>
                <span class="ava tr-person-ava">${this.renderAvatarHTML(name, 'avatar-img', name)}</span>
                <span class="tr-person-main">
                    <span class="tr-person-name">${this.esc(this.messageSenderLabel(name))}${name === me ? ' <em>вы</em>' : ''}</span>
                    ${count ? `<span class="tr-person-meta">${count} ${this.coinPlural(count, ['пополнение', 'пополнения', 'пополнений'])}</span>` : ''}
                </span>
                <span class="tr-person-total">${this.formatCoinAmount(person.total)} <em>ZC</em></span>
            </div>`;
        }).join('');
        this.setHTMLIfChanged(box, html);
    }

    /** «Ваши права» — чтобы не гадать, почему нет вкладки «Выплатить». */
    renderTreasuryYou() {
        const box = document.getElementById('treasuryYou');
        if (!box) return;
        const canManage = this.treasuryCanManage();
        const html = `<div class="tr-you-row">
                <span>Ваш баланс</span>
                <strong>${this.formatCoinAmount(this.S.zaliCoinBalance)} ZC</strong>
            </div>
            <div class="tr-you-row">
                <span>Ваши права</span>
                <strong>${canManage ? 'Пополнять и выплачивать' : 'Пополнять'}</strong>
            </div>`;
        this.setHTMLIfChanged(box, html);
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
        summary.classList.remove('is-warn');
        if (count === 0) {
            summary.textContent = 'У этой роли пока нет участников — выплачивать некому.';
            summary.classList.add('is-warn');
        } else if (Number.isFinite(amount) && amount > 0) {
            const total = amount * count;
            const short = total > (Number(t.data?.balance) || 0);
            summary.textContent = `Получат ${count} ${people} — по ${this.formatCoinAmount(amount)} ZC, всего ${this.formatCoinAmount(total)} ZC из казны.${short ? ' Столько в казне нет.' : ''}`;
            summary.classList.toggle('is-warn', short);
        } else {
            summary.textContent = `Получат ${count} ${people}, каждому — указанная сумма.`;
        }
        summary.hidden = false;
    }

    async submitTreasury() {
        const t = this._treasury;
        if (!t || t.inFlight) return;
        const isPayout = t.tab === 'payout';
        const amountInput = document.getElementById(isPayout ? 'treasuryPayoutAmount' : 'treasuryDepositAmount');
        const noteInput = document.getElementById(isPayout ? 'treasuryPayoutNote' : 'treasuryDepositNote');
        const amount = Math.trunc(Number(amountInput?.value));
        const note = String(noteInput?.value || '').trim().slice(0, ZaliInterface.TREASURY_NOTE_MAX_CHARS);
        if (!Number.isFinite(amount) || amount <= 0) {
            this.setTreasuryStatus('Укажите сумму больше нуля');
            amountInput?.focus();
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
        this.setTreasuryStatus('Отправка…');
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
        // Итоги и «кто пополнял» — агрегаты сервера: перечитываем казну, чтобы
        // они сошлись с только что проведённой операцией.
        clearTimeout(this._treasuryReloadTimer);
        this._treasuryReloadTimer = setTimeout(() => void this.loadTreasury(), 300);
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
                document.getElementById(t.tab === 'payout' ? 'treasuryPayoutAmount' : 'treasuryDepositAmount')?.focus({ preventScroll: true });
                return;
            }
            const target = e.target.closest('[data-treasury-target]');
            if (target) {
                t.target = target.getAttribute('data-treasury-target') || 'user';
                this.setTreasuryStatus('');
                this.renderTreasuryModal();
                return;
            }
            const filter = e.target.closest('[data-treasury-filter]');
            if (filter) {
                t.filter = filter.getAttribute('data-treasury-filter') || 'all';
                this.renderTreasuryHistory();
                return;
            }
            const chip = e.target.closest('[data-treasury-amount]');
            if (chip && !chip.disabled) {
                const raw = chip.getAttribute('data-treasury-amount');
                const value = raw === 'all' ? this.treasuryAvailable() : Number(raw);
                const input = document.getElementById(t.tab === 'payout' ? 'treasuryPayoutAmount' : 'treasuryDepositAmount');
                if (input && value > 0) {
                    input.value = String(value);
                    this.updateTreasurySummary();
                    input.focus({ preventScroll: true });
                }
            }
        });
        document.getElementById('treasuryCloseBtn')?.addEventListener('click', () => this.closeTreasuryModal());
        document.getElementById('treasurySubmitBtn')?.addEventListener('click', () => this.submitTreasury());
        const refresh = (e) => {
            if (e.target.matches?.('#treasuryPayoutAmount, #treasuryRoleSelect')) this.updateTreasurySummary();
            // «Всё» зависит от выбранного источника/роли.
            if (e.target.matches?.('#treasuryDepositSource, #treasuryRoleSelect')) this.renderTreasuryChips();
        };
        modal.addEventListener('input', refresh);
        modal.addEventListener('change', refresh);
        modal.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                this.closeTreasuryModal();
                return;
            }
            if (e.key === 'Enter' && e.target.matches?.('input')) {
                // Выбран пункт подсказки получателя — Enter достаётся ей
                // (user_suggest.js слушает document, то есть уже после нас).
                const suggest = this._userSuggest;
                if (suggest && suggest.active >= 0 && suggest.items?.[suggest.active]) return;
                e.preventDefault();
                this.submitTreasury();
            }
        });
    }
});
