// --- ZaliInterface: Экран ZaliCoin: баланс, распределение, переводы, карточки в чатах. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // ============================================================
    // ZALICOIN — fixed-supply (100 000) in-app currency. Balance/distribution
    // come from /api/coins/*; transfers are server-authoritative (balance
    // checks + double-spend protection live in server/src/coins.rs), this is
    // just presentation + the idempotency key that makes a retried submit safe.
    //
    // Карточки. В канале (где собеседников много) ZaliCoin уходит не переводом, а
    // карточкой: сервер снимает сумму на удержание и выдаёт её по одному заряду на
    // аккаунт по кнопке «Получить». В личном чате карточка лишь сообщает о
    // переводе, который уже состоялся. В зашифрованном сообщении едет только
    // человекочитаемая строка и id операции (parseCoinCard) — суммы, остаток и
    // статус карточка берёт с сервера, поэтому напечатать «поддельную» карточку
    // можно, а получить по ней деньги или выдать чужой перевод за свой — нет.
    // ============================================================

    static get COIN_GIFT_MAX_CLAIMS() { return 100; }
    /** Больше полосок в карточку не помещается — дальше один общий индикатор. */
    static get COIN_CHARGE_SEGMENTS_MAX() { return 20; }
    /** Длительность «вспышки» заполнившегося заряда и шаг между соседними. */
    static get COIN_CHARGE_POP_MS() { return 620; }
    static get COIN_CHARGE_POP_STAGGER_MS() { return 90; }

    async refreshZaliCoinView() {
        await Promise.all([this.loadZaliCoinBalance(), this.loadZaliCoinDistribution(), this.loadMyCoinGifts()]);
        this.renderZaliCoinView();
    }

    async loadZaliCoinBalance() {
        try {
            const res = await this.apiFetch(this.apiRoutes.coins.balance, { interactive: true });
            if (!res.ok) return;
            const data = await res.json();
            this.S.zaliCoinBalance = Number(data.balance) || 0;
            this.S.zaliCoinHeld = Number(data.held) || 0;
        } catch (e) {
            this.trace(`loadZaliCoinBalance error=${e}`);
        }
    }

    async loadZaliCoinDistribution() {
        try {
            const res = await this.apiFetch(this.apiRoutes.coins.distribution, { interactive: true });
            if (!res.ok) return;
            const data = await res.json();
            this.S.zaliCoinTotalSupply = Number(data.totalSupply) || 100000;
            this.S.zaliCoinHolders = Array.isArray(data.holders) ? data.holders : [];
            this.S.zaliCoinHeldTotal = Number(data.held) || 0;
        } catch (e) {
            this.trace(`loadZaliCoinDistribution error=${e}`);
        }
    }

    // Активные карточки отправителя — страховка для удержанного: если сообщение с
    // карточкой не дошло до чата или его удалили, вернуть деньги можно отсюда.
    async loadMyCoinGifts() {
        try {
            const res = await this.apiFetch(this.apiRoutes.coins.myGifts, { interactive: true });
            if (!res.ok) return;
            const data = await res.json();
            const gifts = Array.isArray(data.gifts) ? data.gifts : [];
            gifts.forEach(gift => this.applyCoinGiftState(gift, { patch: false }));
            this.S.zaliCoinMyGifts = gifts.map(gift => gift.id).filter(Boolean);
        } catch (e) {
            this.trace(`loadMyCoinGifts error=${e}`);
        }
    }

    isZaliCoinViewActive() {
        return !!document.getElementById('viewZaliCoin')?.classList.contains('active');
    }

    // Карточку активировали/отменили — балансы и «На удержании» на открытом
    // экране ZaliCoin устарели. Схлопывается: пачка событий даёт один запрос.
    scheduleZaliCoinRefresh() {
        if (!this.isZaliCoinViewActive()) return;
        clearTimeout(this._zaliCoinRefreshTimer);
        this._zaliCoinRefreshTimer = setTimeout(() => void this.refreshZaliCoinView(), 400);
    }

    // Fixed categorical order (never reassigned by rank) — a holder keeps its
    // slot as long as it stays in the top-8-by-balance ranking; overflow folds
    // into a single muted "other" bucket instead of generating a 9th hue.
    zaliCoinSeriesVar(index) {
        const slot = (index % 8) + 1;
        return `var(--zc-series-${slot})`;
    }

    renderZaliCoinView() {
        const view = document.getElementById('viewZaliCoin');
        if (!view) return;
        const totalSupply = this.S.zaliCoinTotalSupply || 100000;
        const balance = this.S.zaliCoinBalance || 0;
        const holders = Array.isArray(this.S.zaliCoinHolders) ? this.S.zaliCoinHolders : [];
        const heldTotal = Math.max(0, Number(this.S.zaliCoinHeldTotal) || 0);
        const me = this.myName();

        const balanceValue = document.getElementById('zaliCoinBalanceValue');
        if (balanceValue) balanceValue.textContent = balance.toLocaleString('ru-RU');
        const balanceShare = document.getElementById('zaliCoinBalanceShare');
        if (balanceShare) {
            const pct = totalSupply > 0 ? (balance / totalSupply) * 100 : 0;
            // Never round a partial share to a whole 100/0 — that reads as
            // "all" or "none" when it's actually e.g. 99.97% or 0.04%. toFixed
            // alone would do exactly that at the extremes, so clamp the
            // formatted value away from the whole numbers unless exact.
            let shareText;
            if (pct === 0 || pct === 100) {
                shareText = String(pct);
            } else {
                shareText = pct.toFixed(1);
                if (shareText === '100.0') shareText = '>99.9';
                if (shareText === '0.0') shareText = '<0.1';
            }
            balanceShare.textContent = `${shareText}% от эмиссии`;
        }
        const heldValue = document.getElementById('zaliCoinHeldValue');
        if (heldValue) {
            const held = Math.max(0, Number(this.S.zaliCoinHeld) || 0);
            heldValue.textContent = `На удержании ${held.toLocaleString('ru-RU')} ZC`;
            heldValue.hidden = held <= 0;
        }

        const MAX_SEGMENTS = 8;
        const top = holders.slice(0, MAX_SEGMENTS);
        const rest = holders.slice(MAX_SEGMENTS);
        const restTotal = rest.reduce((sum, h) => sum + (Number(h.balance) || 0), 0);
        // Удержанное — не чей-то баланс, но и не «ничьё»: без него эти монеты
        // попадали бы в «Не распределено», хотя у них есть хозяин и назначение.
        const accounted = top.reduce((sum, h) => sum + (Number(h.balance) || 0), 0) + restTotal + heldTotal;
        const unassigned = Math.max(0, totalSupply - accounted);

        const segments = top.map((holder, index) => ({
            label: holder.username,
            value: Number(holder.balance) || 0,
            isMe: holder.username === me,
            color: this.zaliCoinSeriesVar(index),
        }));
        if (restTotal > 0) {
            segments.push({ label: `Остальные (${rest.length})`, value: restTotal, isMe: false, color: 'var(--zc-series-other)' });
        }
        if (heldTotal > 0) {
            segments.push({ label: 'На удержании', value: heldTotal, isMe: false, color: 'var(--zc-series-held)' });
        }
        if (unassigned > 0) {
            segments.push({ label: 'Не распределено', value: unassigned, isMe: false, color: 'var(--zc-series-unassigned)' });
        }

        const bar = document.getElementById('zaliCoinBar');
        if (bar) {
            bar.innerHTML = segments.map(seg => {
                const pct = totalSupply > 0 ? (seg.value / totalSupply) * 100 : 0;
                if (pct <= 0) return '';
                const title = `${seg.label}: ${seg.value.toLocaleString('ru-RU')} ZC (${pct.toFixed(1)}%)`;
                return `<button type="button" class="zc-segment${seg.isMe ? ' zc-segment--me' : ''}" style="flex-basis:${pct}%;background:${seg.color}" title="${this.esc(title)}" data-zc-label="${this.esc(seg.label)}" data-zc-value="${seg.value}" data-zc-pct="${pct.toFixed(2)}"></button>`;
            }).join('');
        }

        const legend = document.getElementById('zaliCoinLegend');
        if (legend) {
            legend.innerHTML = segments.map(seg => {
                const pct = totalSupply > 0 ? (seg.value / totalSupply) * 100 : 0;
                return `<div class="zc-legend-item">
                    <span class="zc-legend-swatch" style="background:${seg.color}"></span>
                    <span class="zc-legend-label">${this.esc(seg.label)}${seg.isMe ? ' (вы)' : ''}</span>
                    <span class="zc-legend-value">${seg.value.toLocaleString('ru-RU')} · ${pct.toFixed(1)}%</span>
                </div>`;
            }).join('') || '<div class="zc-legend-empty">Пока никто не держит ZaliCoin</div>';
        }

        this.renderMyCoinGifts();
    }

    renderMyCoinGifts() {
        const card = document.getElementById('zaliCoinGiftsCard');
        const list = document.getElementById('zaliCoinGiftsList');
        if (!card || !list) return;
        const store = this.coinGiftStore();
        const me = this.myName();
        const gifts = (this.S.zaliCoinMyGifts || [])
            .map(id => store.states.get(id)?.state)
            .filter(gift => gift && gift.sender === me && gift.status === 'active');
        card.hidden = gifts.length === 0;
        list.innerHTML = gifts.map(gift => {
            const id = String(gift.id);
            const total = Number(gift.totalClaims) || 1;
            const remaining = Math.max(0, total - (Number(gift.claimedCount) || 0));
            const meta = `${this.formatCoinAmount(gift.amount)} ZC × ${remaining}${total > 1 ? ` из ${total}` : ''} · ${this.coinGiftChannelLabel(gift)}`;
            const pending = store.pending.get(id);
            const confirming = store.confirmId === id;
            const label = pending === 'cancel' ? 'Отмена…' : (confirming ? 'Точно отменить?' : 'Отменить');
            return `<div class="zc-gift-row">
                <div class="zc-gift-row-main">
                    <span class="zc-gift-row-amount">${this.formatCoinAmount(gift.held)} ZC</span>
                    <span class="zc-gift-row-meta">${this.esc(meta)}</span>
                </div>
                <button type="button" class="zc-card-btn zc-gift-row-btn ${confirming ? 'is-confirm' : 'is-ghost'}" data-zc-gift-cancel="${this.esc(id)}"${pending ? ' disabled' : ''}><span>${label}</span></button>
            </div>`;
        }).join('');
    }

    coinGiftChannelLabel(gift) {
        const server = (this.S.servers || []).find(item => item.id === gift?.serverId);
        const channel = (server?.channels || []).find(item => item.id === gift?.channelId);
        if (!server) return 'канал';
        return channel ? `${server.name} · #${channel.name}` : server.name;
    }

    formatCoinAmount(value) {
        return (Number(value) || 0).toLocaleString('ru-RU');
    }

    coinPlural(n, forms) {
        const abs = Math.abs(Number(n) || 0) % 100;
        const last = abs % 10;
        if (abs > 10 && abs < 20) return forms[2];
        if (last > 1 && last < 5) return forms[1];
        if (last === 1) return forms[0];
        return forms[2];
    }

    zaliCoinNewIdempotencyKey() {
        return this.randomBase64(16).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    // ---- Модалка: перевод (личный чат, кошелёк) и карточка (канал) ----

    openCoinTransferModal(prefillRecipient = '') {
        this.openCoinModal({ mode: 'transfer', recipient: prefillRecipient });
    }

    openCoinGiftModal() {
        const server = this.currentServer();
        const channel = this.currentChannel();
        if (!server || !channel || this.isVoiceChannel(channel)) {
            this.openCoinTransferModal();
            return;
        }
        this.openCoinModal({ mode: 'gift', serverId: server.id, channelId: channel.id });
    }

    openCoinModal({ mode = 'transfer', recipient = '', serverId = '', channelId = '' } = {}) {
        const modal = document.getElementById('coinTransferModal');
        if (!modal) return;
        const isGift = mode === 'gift';
        this._coinModal = { mode, serverId, channelId, fromWallet: !isGift && !recipient };
        this._coinTransferIdempotencyKey = this.zaliCoinNewIdempotencyKey();
        // clientId будущей карточки перевода. Живёт в паре с ключом: повтор того же
        // перевода обязан сослаться на ту же карточку, иначе сервер вернёт перевод,
        // привязанный к одному id, а в чат уйдёт сообщение с другим.
        this._coinTransferCardClientId = this.zaliCoinNewIdempotencyKey();
        // The key above is only valid for one exact payload — see
        // submitCoinTransfer, which rotates it whenever the payload changes.
        this._coinTransferLastPayload = '';
        this._coinTransferInFlight = false;
        const title = document.getElementById('coinTransferTitle');
        const recipientField = document.getElementById('coinTransferRecipientField');
        const recipientInput = document.getElementById('coinTransferRecipientInput');
        const amountLabel = document.getElementById('coinTransferAmountLabel');
        const amountInput = document.getElementById('coinTransferAmountInput');
        const claimsField = document.getElementById('coinGiftClaimsField');
        const claimsInput = document.getElementById('coinGiftClaimsInput');
        const submitBtn = document.getElementById('coinTransferSubmitBtn');
        const status = document.getElementById('coinTransferStatus');
        if (title) title.textContent = isGift ? 'ZaliCoin-карточка' : 'Перевести ZaliCoin';
        if (recipientField) recipientField.hidden = isGift;
        if (recipientInput) {
            recipientInput.value = recipient || '';
            recipientInput.disabled = !!recipient;
        }
        if (amountLabel) amountLabel.textContent = isGift ? 'Сумма на одного (ZC)' : 'Сумма (ZC)';
        if (amountInput) amountInput.value = '';
        if (claimsField) claimsField.hidden = !isGift;
        if (claimsInput) {
            claimsInput.value = '1';
            claimsInput.max = String(ZaliInterface.COIN_GIFT_MAX_CLAIMS);
        }
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = isGift ? 'Отправить карточку' : 'Отправить';
        }
        if (status) { status.textContent = ''; status.hidden = true; }
        this.updateCoinGiftSummary();
        modal.hidden = false;
        (isGift || recipient ? amountInput : recipientInput)?.focus();
    }

    closeCoinTransferModal() {
        const modal = document.getElementById('coinTransferModal');
        if (modal) modal.hidden = true;
    }

    coinGiftClaimsValue() {
        const raw = Math.trunc(Number(document.getElementById('coinGiftClaimsInput')?.value));
        if (!Number.isFinite(raw)) return 1;
        return Math.min(ZaliInterface.COIN_GIFT_MAX_CLAIMS, Math.max(1, raw));
    }

    stepCoinGiftClaims(delta) {
        const input = document.getElementById('coinGiftClaimsInput');
        if (!input) return;
        input.value = String(Math.min(ZaliInterface.COIN_GIFT_MAX_CLAIMS, Math.max(1, this.coinGiftClaimsValue() + delta)));
        this.updateCoinGiftSummary();
    }

    updateCoinGiftSummary() {
        const summary = document.getElementById('coinGiftSummary');
        if (!summary) return;
        if (this._coinModal?.mode !== 'gift') {
            summary.hidden = true;
            return;
        }
        const amount = Math.trunc(Number(document.getElementById('coinTransferAmountInput')?.value));
        const claims = this.coinGiftClaimsValue();
        const people = this.coinPlural(claims, ['человек', 'человека', 'человек']);
        if (!Number.isFinite(amount) || amount <= 0) {
            summary.textContent = claims > 1
                ? `Карточку смогут получить ${claims} ${people} — по одному разу на аккаунт.`
                : 'Карточку сможет получить один человек.';
        } else if (claims > 1) {
            summary.textContent = `Каждый из ${claims} получит ${this.formatCoinAmount(amount)} ZC. На удержание уйдёт ${this.formatCoinAmount(amount * claims)} ZC — неполученное вернётся, если отменить карточку.`;
        } else {
            summary.textContent = `На удержание уйдёт ${this.formatCoinAmount(amount)} ZC — они вернутся, если отменить карточку до того, как её получат.`;
        }
        summary.hidden = false;
    }

    async submitCoinTransfer() {
        const modal = document.getElementById('coinTransferModal');
        if (!modal || modal.hidden) return;
        // The Enter-key path calls this directly, bypassing the disabled submit
        // button — without this guard a held/repeated Enter fires concurrent
        // submits (server-side idempotency makes the money safe, but the client
        // would close/re-log/post the chat notice once per call).
        if (this._coinTransferInFlight) return;
        if (this._coinModal?.mode === 'gift') {
            await this.submitCoinGift();
            return;
        }
        const recipientInput = document.getElementById('coinTransferRecipientInput');
        const amountInput = document.getElementById('coinTransferAmountInput');
        const submitBtn = document.getElementById('coinTransferSubmitBtn');
        const setStatus = (msg) => this.setCoinModalStatus(msg);

        const to = String(recipientInput?.value || '').trim();
        const amount = Math.trunc(Number(amountInput?.value));
        if (!to) { setStatus('Укажите получателя'); return; }
        if (!Number.isFinite(amount) || amount <= 0) { setStatus('Укажите сумму больше нуля'); return; }
        if (to === this.myName()) { setStatus('Нельзя перевести самому себе'); return; }

        // The idempotency key must identify one exact payload. If the user got a
        // transport error, then edited the recipient/amount and resubmitted, the
        // old key could replay a transfer that DID commit server-side — the server
        // would answer "success" for the old payload while the user believes the
        // edited one went through. Rotate the key whenever the payload changes;
        // keep it only for a true retry of the identical payload.
        const payloadSignature = `${to}\0${amount}`;
        if (this._coinTransferLastPayload && this._coinTransferLastPayload !== payloadSignature) {
            this._coinTransferIdempotencyKey = this.zaliCoinNewIdempotencyKey();
            this._coinTransferCardClientId = this.zaliCoinNewIdempotencyKey();
        }
        this._coinTransferLastPayload = payloadSignature;

        this._coinTransferInFlight = true;
        if (submitBtn) submitBtn.disabled = true;
        setStatus('Отправка...');

        // The network call is isolated from everything after it: a timeout or
        // dropped connection here doesn't tell us whether the server already
        // committed the transfer, so a transport-level failure gets one safe
        // automatic retry with the *same* idempotencyKey before we tell the
        // user anything failed — the server's UNIQUE (from_user, idempotencyKey)
        // constraint makes a resubmit a no-op if the first attempt actually
        // landed, and returns the definitive current balance either way.
        let res;
        try {
            res = await this.transferCoinsRequest(to, amount);
        } catch (e) {
            setStatus('Не удалось связаться с сервером, попробуйте ещё раз');
            this.trace(`submitCoinTransfer transport_error=${e}`);
            this._coinTransferInFlight = false;
            if (submitBtn) submitBtn.disabled = false;
            return;
        }

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            setStatus(text || 'Не удалось выполнить перевод');
            this._coinTransferInFlight = false;
            if (submitBtn) submitBtn.disabled = false;
            return;
        }

        // From here on the transfer is authoritatively done — nothing below
        // should be able to make this look like a failed transfer anymore.
        const data = await res.json().catch(() => null);
        if (data && Number.isFinite(Number(data.balance))) {
            this.S.zaliCoinBalance = Number(data.balance);
        }
        const transactionId = String(data?.transactionId || '').trim();
        const fromWallet = !!this._coinModal?.fromWallet;
        const cardClientId = this._coinTransferCardClientId;
        this._coinTransferInFlight = false;
        if (submitBtn) submitBtn.disabled = false;
        setStatus('');
        this.closeCoinTransferModal();
        this.addLogEntry({ type: 'INFO', msg: `Отправлено ${amount} ZaliCoin пользователю ${to}`, ts: new Date().toLocaleTimeString() });
        this.refreshZaliCoinView();

        // Post a transfer card so the transfer shows up in the conversation —
        // only when it's the peer of the chat the button was opened from; a
        // wallet-tab transfer to an arbitrary user may have no open conversation
        // to post into, so it's skipped there. Its own failure (e.g. a flaky send
        // right after) is logged, not surfaced as a transfer error — the money
        // already moved.
        if (!fromWallet && to === this.S.current && this.currentConversationMode() !== 'servers') {
            await this.postCoinCardMessage(
                this.coinTransferCardText(amount, transactionId),
                'ZaliCoin переведён, но не удалось отправить сообщение об этом в чат',
                cardClientId,
            );
        }
    }

    async submitCoinGift() {
        const ctx = this._coinModal || {};
        const amountInput = document.getElementById('coinTransferAmountInput');
        const submitBtn = document.getElementById('coinTransferSubmitBtn');
        const setStatus = (msg) => this.setCoinModalStatus(msg);

        const amount = Math.trunc(Number(amountInput?.value));
        const claims = this.coinGiftClaimsValue();
        if (!ctx.serverId || !ctx.channelId) { setStatus('Откройте текстовый канал'); return; }
        if (!Number.isFinite(amount) || amount <= 0) { setStatus('Укажите сумму больше нуля'); return; }
        if (amount * claims > (this.S.zaliCoinTotalSupply || 100000)) { setStatus('Это больше, чем всего существует ZaliCoin'); return; }

        // Same rule as the transfer above: one idempotency key per exact payload.
        const payloadSignature = `gift\0${ctx.serverId}\0${ctx.channelId}\0${amount}\0${claims}`;
        if (this._coinTransferLastPayload && this._coinTransferLastPayload !== payloadSignature) {
            this._coinTransferIdempotencyKey = this.zaliCoinNewIdempotencyKey();
        }
        this._coinTransferLastPayload = payloadSignature;

        this._coinTransferInFlight = true;
        if (submitBtn) submitBtn.disabled = true;
        setStatus('Отправка...');

        let res;
        try {
            res = await this.coinPostWithRetry(this.apiRoutes.coins.gifts, {
                serverId: ctx.serverId,
                channelId: ctx.channelId,
                amount,
                claims,
                idempotencyKey: this._coinTransferIdempotencyKey,
            });
        } catch (e) {
            setStatus('Не удалось связаться с сервером, попробуйте ещё раз');
            this.trace(`submitCoinGift transport_error=${e}`);
            this._coinTransferInFlight = false;
            if (submitBtn) submitBtn.disabled = false;
            return;
        }
        const data = await res.json().catch(() => null);
        const gift = data?.gift;
        if (!res.ok || !gift?.id) {
            setStatus(data?.message || 'Не удалось создать карточку');
            this._coinTransferInFlight = false;
            if (submitBtn) submitBtn.disabled = false;
            return;
        }

        // Деньги уже на удержании — дальше ничто не должно выглядеть как неудача.
        this.applyCoinGiftState(gift);
        if (Number.isFinite(Number(data.balance))) this.S.zaliCoinBalance = Number(data.balance);
        if (Number.isFinite(Number(data.held))) this.S.zaliCoinHeld = Number(data.held);
        this._coinTransferInFlight = false;
        if (submitBtn) submitBtn.disabled = false;
        setStatus('');
        this.closeCoinTransferModal();
        this.addLogEntry({ type: 'INFO', msg: `Карточка ZaliCoin: ${amount} ZC × ${claims}`, ts: new Date().toLocaleTimeString() });
        this.scheduleZaliCoinRefresh();

        // sendInputMessage пишет в канал, открытый СЕЙЧАС. Если пользователь успел
        // переключиться, карточка ушла бы не туда — а получить её могут только те,
        // кто видит исходный канал. Удержанное при этом не теряется: карточка
        // живёт на сервере и отменяется с экрана ZaliCoin.
        const stillHere = this.currentConversationMode() === 'servers'
            && this.S.activeServer === ctx.serverId
            && this.S.activeChannel === ctx.channelId;
        if (!stillHere) {
            this.addLogEntry({ type: 'WARN', msg: 'Карточка ZaliCoin создана, но канал сменился — сообщение не отправлено. Отменить карточку можно на экране ZaliCoin', ts: new Date().toLocaleTimeString() });
            return;
        }
        await this.postCoinCardMessage(
            this.coinGiftCardText(gift),
            'Карточка ZaliCoin создана, но не отправлена в чат — отменить её можно на экране ZaliCoin',
        );
    }

    setCoinModalStatus(msg) {
        const status = document.getElementById('coinTransferStatus');
        if (!status) return;
        status.textContent = msg;
        status.hidden = !msg;
    }

    async postCoinCardMessage(text, failureMessage, clientId = '') {
        try {
            await this.sendInputMessage({ systemText: text, clientId });
            return true;
        } catch (e) {
            this.trace(`postCoinCardMessage failed=${e}`);
            this.addLogEntry({ type: 'WARN', msg: failureMessage, ts: new Date().toLocaleTimeString() });
            return false;
        }
    }

    async transferCoinsRequest(to, amount) {
        return this.coinPostWithRetry(this.apiRoutes.coins.transfer, {
            to,
            amount,
            idempotencyKey: this._coinTransferIdempotencyKey,
            // Из кошелька карточка в чат не уходит — и привязывать перевод не к чему.
            cardClientId: this._coinModal?.fromWallet ? '' : this._coinTransferCardClientId,
        });
    }

    // One automatic retry after a transport error. Safe for every ZaliCoin POST:
    // transfers and gift creation carry an idempotency key, a claim is one per
    // account and a cancel of a cancelled card is a no-op on the server.
    async coinPostWithRetry(path, payload) {
        const body = JSON.stringify(payload || {});
        try {
            return await this.apiFetch(path, { method: 'POST', body, interactive: true });
        } catch (firstError) {
            this.trace(`coinPostWithRetry retrying after transport error=${firstError}`);
            return await this.apiFetch(path, { method: 'POST', body, interactive: true });
        }
    }

    // ---- Карточки в ленте сообщений ----

    // Первая строка — для людей и для клиентов, которые карточек ещё не знают
    // (они покажут её обычным текстом); вторая — id операции на сервере.
    coinGiftCardText(gift) {
        return `🎁 ${this.myName()} отправил(а) ZaliCoin: ${gift.amount} ZC × ${gift.totalClaims}\n[zc-gift:${gift.id}]`;
    }

    coinTransferCardText(amount, transactionId) {
        const head = `💰 ${this.myName()} перевёл(а) ${amount} ZaliCoin`;
        return transactionId ? `${head}\n[zc-tx:${transactionId}]` : head;
    }

    /**
     * Узнаёт в тексте сообщения карточку ZaliCoin. Имя из текста не используется:
     * отправитель берётся из самого сообщения (его ставит сервер), суммы и статус
     * карточки — с сервера. Старое уведомление о переводе без id тоже карточка,
     * просто без сверки.
     */
    parseCoinCard(text) {
        const value = String(text || '').trim();
        if (!value) return null;
        if (value.startsWith('🎁')) {
            const match = value.match(/^🎁[^\n]*?(\d+)\s+ZC\s+×\s+(\d+)\n\[zc-gift:([A-Za-z0-9-]{8,64})\]$/u);
            if (match) return { kind: 'gift', amount: Number(match[1]), claims: Number(match[2]), id: match[3] };
            return null;
        }
        if (value.startsWith('💰')) {
            const match = value.match(/^💰\s*(?:\S+\s+)?[Пп]еревёл\(а\)\s+(\d+)\s+ZaliCoin(?:\n\[zc-tx:([A-Za-z0-9-]{8,64})\])?$/u);
            if (match) return { kind: 'transfer', amount: Number(match[1]), id: match[2] || '' };
        }
        return null;
    }

    /** Строка карточки для превью в списке чатов, цитаты ответа и уведомления. */
    coinCardSummary(text) {
        const card = this.parseCoinCard(text);
        if (!card) return '';
        return card.kind === 'gift'
            ? `🎁 ZaliCoin-карточка · ${this.formatCoinAmount(card.amount)} ZC`
            : `💸 Перевод · ${this.formatCoinAmount(card.amount)} ZC`;
    }

    renderCoinCard(card, msg) {
        const time = msg?.timestamp ? this.fmtTime(msg.timestamp) : '';
        const sender = String(msg?.sender || '').trim();
        if (card.kind === 'gift') {
            // Лента всегда рисует текущую переписку, так что при отсутствии полей в
            // самом сообщении канал берётся из неё. В личке канала нет вовсе.
            const inChannel = this.currentConversationMode() === 'servers';
            const serverId = String(msg?.serverId || (inChannel ? this.S.activeServer : '') || '');
            const channelId = String(msg?.channelId || (inChannel ? this.S.activeChannel : '') || '');
            const desc = { id: card.id, amount: card.amount, claims: card.claims, sender, serverId, channelId, time };
            this.ensureCoinGiftState(card.id);
            const parts = this.coinGiftCardParts(desc);
            return `<div class="${this.esc(parts.className)}" data-zc-gift="${this.esc(card.id)}" data-zc-amount="${this.esc(card.amount)}" data-zc-claims="${this.esc(card.claims)}" data-zc-sender="${this.esc(sender)}" data-zc-server="${this.esc(serverId)}" data-zc-channel="${this.esc(channelId)}" data-zc-time="${this.esc(time)}">${parts.inner}</div>`;
        }
        // В канале receiver — это id канала, а не человек.
        const to = msg?.serverId ? '' : String(msg?.receiver || '').trim();
        const clientId = String(msg?.clientId || '').trim();
        const desc = { id: card.id, amount: card.amount, from: sender, to, time, clientId };
        if (card.id) this.ensureCoinTransferReceipt(card.id);
        return `<div class="zc-card zc-card--transfer" data-zc-tx="${this.esc(card.id)}" data-zc-amount="${this.esc(card.amount)}" data-zc-from="${this.esc(sender)}" data-zc-to="${this.esc(to)}" data-zc-time="${this.esc(time)}" data-zc-client="${this.esc(clientId)}">${this.coinTransferCardInner(desc)}</div>`;
    }

    coinGiftStore() {
        if (!this._coinGifts) {
            this._coinGifts = {
                states: new Map(),      // id -> { state, missing, fetchedAt }
                queue: new Set(),
                inFlight: new Set(),
                flushTimer: null,
                pending: new Map(),     // id -> 'claim' | 'cancel'
                notes: new Map(),       // id -> ошибка, показываемая в карточке
                confirmId: null,
                confirmTimer: null,
                receipts: new Map(),    // transfer id -> { ok, ...receipt, fetchedAt }
                receiptsInFlight: new Set(),
                seenClaims: new Map(),  // id -> сколько зарядов было заполнено при прошлой отрисовке
                pops: new Map(),        // id -> { from, to, at } — заряды, которые сейчас «вспыхивают»
            };
        }
        return this._coinGifts;
    }

    coinCardNodes(attribute, id) {
        if (!/^[A-Za-z0-9-]{8,64}$/.test(String(id || ''))) return [];
        return Array.from(document.querySelectorAll(`[${attribute}="${id}"]`));
    }

    // Монета ZaliCoin: кольцо, тонкий внутренний ободок и «Ƶ» — Z с перечёркивающей
    // чертой, как у знаков валют. Тот же глиф, что у кнопки в композере
    // (index.html), у сегмента хаба (prefs.js) и на экране ZaliCoin.
    coinGiftIcon() {
        return '<span class="zc-card-coin" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" focusable="false"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="12" r="6.7" stroke="currentColor" stroke-width="1" opacity=".32"/><path d="M9.7 9.3h4.6l-4.6 5.4h4.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.6 12h2.8" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"/></svg></span>';
    }

    coinCheckIcon() {
        return '<svg class="zc-card-check" viewBox="0 0 16 16" fill="none" aria-hidden="true" focusable="false"><path d="M3.5 8.4 6.6 11.4 12.5 4.8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    }

    coinCardHead(caption, time) {
        return `<div class="zc-card-head">${this.coinGiftIcon()}<div class="zc-card-titles"><span class="zc-card-title">ZaliCoin</span><span class="zc-card-caption">${this.esc(caption)}</span></div>${time ? `<span class="zc-card-time">${this.esc(time)}</span>` : ''}</div>`;
    }

    coinGiftView(desc) {
        const me = this.myName();
        const entry = this.coinGiftStore().states.get(desc.id);
        const state = entry?.state;
        // Карточка — это ссылка из сообщения на операцию на сервере. Если операцию
        // создал не автор сообщения или она из другого канала, это чужая карточка,
        // переотправленная от своего имени: показываем её недоступной.
        const foreign = !!state && (state.sender !== desc.sender
            || state.serverId !== desc.serverId
            || state.channelId !== desc.channelId);
        if (state && !foreign) {
            const claims = Array.isArray(state.claims) ? state.claims : [];
            const claimers = claims.map(claim => claim.username);
            return {
                loaded: true,
                missing: false,
                amount: Number(state.amount) || 0,
                total: Math.max(1, Number(state.totalClaims) || 1),
                claimed: Number(state.claimedCount) || 0,
                status: String(state.status || 'active'),
                claims,
                claimers,
                claimedByMe: claimers.includes(me),
                isSender: state.sender === me,
                refunded: Number(state.refunded) || 0,
            };
        }
        return {
            loaded: false,
            missing: !!entry?.missing || foreign,
            amount: desc.amount,
            total: Math.max(1, desc.claims),
            claimed: 0,
            status: 'unknown',
            claims: [],
            claimers: [],
            claimedByMe: false,
            isSender: desc.sender === me,
            refunded: 0,
        };
    }

    // Какие заряды сейчас «вспыхивают». Анимация играет только при РОСТЕ числа
    // активаций, увиденном этим клиентом: первая отрисовка карточки (история,
    // перезагрузка) заполняет полоски молча. Перерисовка ленты посреди анимации
    // пересоздаёт узел — отрицательная задержка продолжает её с того же места,
    // а не запускает заново.
    coinChargePop(id, claimed) {
        const store = this.coinGiftStore();
        const now = Date.now();
        const seen = store.seenClaims.get(id);
        store.seenClaims.set(id, Math.max(claimed, seen || 0));
        if (seen !== undefined && claimed > seen) {
            store.pops.set(id, { from: seen, to: claimed, at: now });
        }
        const pop = store.pops.get(id);
        if (!pop) return null;
        const lasts = ZaliInterface.COIN_CHARGE_POP_MS + (pop.to - pop.from) * ZaliInterface.COIN_CHARGE_POP_STAGGER_MS;
        if (now - pop.at > lasts) {
            store.pops.delete(id);
            return null;
        }
        return { ...pop, elapsed: now - pop.at };
    }

    coinChargesHtml(desc, view) {
        const total = view.total;
        const claimed = Math.min(view.claimed, total);
        const pop = view.loaded ? this.coinChargePop(desc.id, claimed) : null;
        const stagger = ZaliInterface.COIN_CHARGE_POP_STAGGER_MS;
        let counter = '';
        if (total > 1) {
            const bumpDelay = pop ? Math.round((pop.to - pop.from - 1) * stagger - pop.elapsed) : 0;
            counter = `<span class="${this.esc(pop ? 'zc-charges-count is-bump' : 'zc-charges-count')}"${pop ? ` style="--zc-pop-delay:${this.esc(bumpDelay)}ms"` : ''}>${claimed}/${total}</span>`;
        }

        if (total > ZaliInterface.COIN_CHARGE_SEGMENTS_MAX) {
            const names = view.claims.slice(0, 6).map(claim => this.messageSenderLabel(claim.username));
            const more = claimed - names.length;
            const tip = claimed ? `Получили: ${names.join(', ')}${more > 0 ? ` и ещё ${more}` : ''}` : '';
            const pct = ((claimed / total) * 100).toFixed(2);
            const popDelay = pop ? Math.round(-pop.elapsed) : 0;
            return `<div class="zc-charges"><span class="${this.esc(pop ? 'zc-charges-meter is-pop' : 'zc-charges-meter')}"${tip ? ` tabindex="0" data-zc-tip="${this.esc(tip)}"` : ''}${pop ? ` style="--zc-pop-delay:${this.esc(popDelay)}ms"` : ''}><i style="width:${this.esc(pct)}%"></i></span>${counter}</div>`;
        }

        // Заряды заполняются в порядке активаций, поэтому i-я полоска — это i-я
        // запись в claims (сервер отдаёт их по времени), и подсказка знает, кому ушло.
        const segments = Array.from({ length: total }, (_, i) => {
            if (i >= claimed) return '<span class="zc-charge"></span>';
            const claim = view.claims[i];
            const tip = claim ? `${this.messageSenderLabel(claim.username)} · ${this.formatCoinAmount(claim.amount)} ZC` : '';
            const popping = !!pop && i >= pop.from && i < pop.to;
            const delay = popping ? Math.round((i - pop.from) * stagger - pop.elapsed) : 0;
            return `<span class="${this.esc(popping ? 'zc-charge is-on is-pop' : 'zc-charge is-on')}"${tip ? ` tabindex="0" data-zc-tip="${this.esc(tip)}" aria-label="${this.esc(`Заряд ${i + 1}: ${tip}`)}"` : ''}${popping ? ` style="--zc-pop-delay:${this.esc(delay)}ms"` : ''}></span>`;
        }).join('');
        return `<div class="zc-charges"><div class="zc-charges-track">${segments}</div>${counter}</div>`;
    }

    coinGiftCardParts(desc) {
        const view = this.coinGiftView(desc);
        const store = this.coinGiftStore();
        const multi = view.total > 1;
        const pending = store.pending.get(desc.id) || '';
        const note = store.notes.get(desc.id)?.text || '';
        const button = (label, tone, { claim = '', cancel = '', disabled = false, icon = '' } = {}) =>
            `<button type="button" class="zc-card-btn ${this.esc(tone)}"${claim ? ` data-zc-gift-claim="${this.esc(claim)}"` : ''}${cancel ? ` data-zc-gift-cancel="${this.esc(cancel)}"` : ''}${disabled ? ' disabled' : ''}>${icon}<span>${this.esc(label)}</span></button>`;

        let action;
        if (pending === 'claim') action = button('Получение…', 'is-busy', { disabled: true });
        else if (pending === 'cancel') action = button('Отмена…', 'is-busy', { disabled: true });
        else if (!view.loaded) action = view.missing
            ? button('Недоступна', 'is-off', { disabled: true })
            : button(view.isSender ? 'Отменить' : 'Получить', 'is-busy', { disabled: true });
        else if (view.claimedByMe) action = button('Получено', 'is-done', { disabled: true, icon: this.coinCheckIcon() });
        else if (view.status === 'cancelled') action = button('Отменено', 'is-off', { disabled: true });
        else if (view.status === 'exhausted') action = button('Активировано', 'is-off', { disabled: true, icon: this.coinCheckIcon() });
        else if (view.isSender) {
            const confirming = store.confirmId === desc.id;
            action = button(confirming ? 'Точно отменить?' : 'Отменить', confirming ? 'is-confirm' : 'is-ghost', { cancel: desc.id });
        } else action = button('Получить', 'is-primary', { claim: desc.id });

        // Подсказка на полоске работает только наведением; на телефоне «кому ушло»
        // у одноразовой карточки должно читаться и без него.
        let footnote = '';
        if (note) {
            footnote = `<div class="zc-card-note is-error">${this.esc(note)}</div>`;
        } else if (view.missing) {
            footnote = '<div class="zc-card-note">Карточка не найдена или вам недоступна</div>';
        } else if (view.loaded && !multi && view.status === 'exhausted' && view.claimers[0] && !view.claimedByMe) {
            footnote = `<div class="zc-card-note">Получил(а) ${this.esc(this.messageSenderLabel(view.claimers[0]))}</div>`;
        } else if (view.loaded && view.status === 'cancelled' && view.isSender && view.refunded > 0) {
            footnote = `<div class="zc-card-note">Возвращено ${this.formatCoinAmount(view.refunded)} ZC</div>`;
        }

        const caption = multi
            ? `карточка · ${view.total} ${this.coinPlural(view.total, ['заряд', 'заряда', 'зарядов'])}`
            : 'карточка · один заряд';
        const sub = multi
            ? `каждому · всего ${this.formatCoinAmount(view.amount * view.total)} ZC`
            : 'одному получателю';
        const stateClass = view.loaded ? `is-${view.status}` : (view.missing ? 'is-missing' : 'is-loading');
        const inner = `${this.coinCardHead(caption, desc.time)}
            <div class="zc-card-amount"><span class="zc-card-value">${this.formatCoinAmount(view.amount)}</span><span class="zc-card-unit">ZC</span></div>
            <div class="zc-card-sub">${this.esc(sub)}</div>
            ${this.coinChargesHtml(desc, view)}
            ${action}
            ${footnote}`;
        return {
            className: `zc-card zc-card--gift ${stateClass}${view.claimedByMe ? ' is-mine' : ''}`,
            inner,
        };
    }

    coinTransferCardInner(desc) {
        let status = '';
        if (!desc.id) {
            // Без id сверять не с чем: такой текст мог набрать кто угодно.
            status = '<div class="zc-card-status is-warn">Не подтверждён сервером</div>';
        } else {
            const receipt = this.coinGiftStore().receipts.get(desc.id);
            if (receipt?.ok === true) {
                // Квитанция подтверждает ровно одно сообщение: то, чей clientId сервер
                // запомнил при переводе. Повтор текста получает новый clientId, а второе
                // сообщение с тем же id в ту же переписку сервер не пропустит. Пустая или
                // отсутствующая привязка (перевод из кошелька или до привязки) карточек
                // не порождала — такую карточку мог нарисовать только кто-то руками.
                const matches = Number(receipt.amount) === Number(desc.amount)
                    && receipt.from === desc.from
                    && receipt.to === desc.to
                    && !!receipt.cardClientId
                    && receipt.cardClientId === desc.clientId;
                status = matches
                    ? `<div class="zc-card-status is-ok">${this.coinCheckIcon()}<span>Зачислено</span></div>`
                    : '<div class="zc-card-status is-warn">Не совпадает с переводом на сервере</div>';
            } else if (receipt?.ok === false) {
                status = '<div class="zc-card-status is-warn">Перевод не подтверждён сервером</div>';
            } else if (!receipt) {
                status = '<div class="zc-card-status">Проверка…</div>';
            }
        }
        const route = desc.from && desc.to
            ? `<div class="zc-card-sub">${this.esc(this.messageSenderLabel(desc.from))}<span class="zc-card-arrow" aria-hidden="true">→</span>${this.esc(this.messageSenderLabel(desc.to))}</div>`
            : '';
        return `${this.coinCardHead('перевод', desc.time)}
            <div class="zc-card-amount"><span class="zc-card-value">${this.formatCoinAmount(desc.amount)}</span><span class="zc-card-unit">ZC</span></div>
            ${route}
            ${status}`;
    }

    // Состояние карточек запрашивается пачкой: отрисовка ленты ставит id в
    // очередь, а один таймер собирает всё, что набралось за кадр, в один запрос.
    ensureCoinGiftState(id) {
        if (!/^[A-Za-z0-9-]{8,64}$/.test(String(id || ''))) return;
        const store = this.coinGiftStore();
        if (store.inFlight.has(id) || store.queue.has(id)) return;
        const entry = store.states.get(id);
        if (entry) {
            const status = entry.state?.status;
            // Отменённая и исчерпанная карточка больше не меняется.
            if (status && status !== 'active') return;
            // Живые изменения приходят по WS (coin_gift_updated); перезапрос — только
            // страховка на случай пропущенного события.
            const ttl = entry.state ? 60000 : (entry.missing ? 300000 : 15000);
            if (Date.now() - entry.fetchedAt < ttl) return;
        }
        store.queue.add(id);
        if (!store.flushTimer) {
            store.flushTimer = setTimeout(() => {
                store.flushTimer = null;
                void this.flushCoinGiftQueue();
            }, 40);
        }
    }

    async flushCoinGiftQueue() {
        const store = this.coinGiftStore();
        const ids = Array.from(store.queue).slice(0, 50);
        if (!ids.length) return;
        ids.forEach(id => { store.queue.delete(id); store.inFlight.add(id); });
        let ok = false;
        try {
            const res = await this.apiFetch(this.apiRoutes.coins.giftsLookup(ids));
            if (res.ok) {
                const data = await res.json();
                const found = new Set();
                (Array.isArray(data?.gifts) ? data.gifts : []).forEach(gift => {
                    if (!gift?.id) return;
                    found.add(gift.id);
                    this.applyCoinGiftState(gift, { patch: false });
                });
                const now = Date.now();
                ids.forEach(id => {
                    if (!found.has(id)) store.states.set(id, { state: null, missing: true, fetchedAt: now });
                });
                ok = true;
            }
        } catch (e) {
            this.trace(`flushCoinGiftQueue error=${e}`);
        }
        ids.forEach(id => store.inFlight.delete(id));
        if (!ok) {
            const now = Date.now();
            ids.forEach(id => {
                const entry = store.states.get(id);
                if (entry) entry.fetchedAt = now;
                else store.states.set(id, { state: null, missing: false, fetchedAt: now });
            });
            // Лента может больше не перерисоваться сама — повтор не должен от неё зависеть.
            setTimeout(() => ids.forEach(id => {
                if (this.coinCardNodes('data-zc-gift', id).length) this.ensureCoinGiftState(id);
            }), 16000);
        }
        ids.forEach(id => this.patchCoinGiftCards(id));
        if (store.queue.size && !store.flushTimer) {
            store.flushTimer = setTimeout(() => {
                store.flushTimer = null;
                void this.flushCoinGiftQueue();
            }, 40);
        }
    }

    // Состояние карточки только движется вперёд: активная → исчерпана/отменена,
    // и число активаций не убывает. Иначе опоздавший ответ lookup, пришедший
    // после WS-события, вернул бы карточке кнопку «Получить».
    isNewerCoinGiftState(previous, next) {
        const rank = (state) => (String(state?.status || 'active') === 'active' ? 0 : 1);
        if (rank(next) !== rank(previous)) return rank(next) > rank(previous);
        return (Number(next?.claimedCount) || 0) >= (Number(previous?.claimedCount) || 0);
    }

    applyCoinGiftState(gift, { patch = true } = {}) {
        if (!gift?.id) return;
        const store = this.coinGiftStore();
        const id = String(gift.id);
        const entry = store.states.get(id);
        const now = Date.now();
        if (entry?.state && !this.isNewerCoinGiftState(entry.state, gift)) {
            entry.fetchedAt = now;
            return;
        }
        store.states.set(id, { state: gift, missing: false, fetchedAt: now });
        if (gift.sender === this.myName() && gift.status === 'active') {
            if (!Array.isArray(this.S.zaliCoinMyGifts)) this.S.zaliCoinMyGifts = [];
            if (!this.S.zaliCoinMyGifts.includes(id)) this.S.zaliCoinMyGifts.unshift(id);
        }
        if (patch) this.patchCoinGiftCards(id);
    }

    // Точечная замена карточек в DOM вместо перерисовки всей ленты: полный
    // рендер пересобирает каждый пузырь и перезапускает гидратацию медиа, а
    // здесь изменилась одна кнопка. Следующий обычный рендер соберёт ту же
    // разметку из того же кэша, так что расхождения не будет.
    patchCoinGiftCards(id) {
        this.coinCardNodes('data-zc-gift', id).forEach(node => {
            const data = node.dataset;
            const parts = this.coinGiftCardParts({
                id,
                amount: Number(data.zcAmount) || 0,
                claims: Number(data.zcClaims) || 1,
                sender: data.zcSender || '',
                serverId: data.zcServer || '',
                channelId: data.zcChannel || '',
                time: data.zcTime || '',
            });
            if (node.className !== parts.className) node.className = parts.className;
            node.innerHTML = parts.inner;
        });
        if (this.isZaliCoinViewActive()) this.renderMyCoinGifts();
    }

    handleCoinGiftRealtime(payload) {
        const gift = payload?.gift;
        if (!gift?.id) return;
        this.applyCoinGiftState(gift);
        this.scheduleZaliCoinRefresh();
    }

    setCoinGiftNote(id, text) {
        const store = this.coinGiftStore();
        const note = { text, at: Date.now() };
        store.notes.set(id, note);
        setTimeout(() => {
            if (store.notes.get(id) === note) {
                store.notes.delete(id);
                this.patchCoinGiftCards(id);
            }
        }, 6000);
    }

    async claimCoinGift(id) {
        const store = this.coinGiftStore();
        if (!id || store.pending.has(id)) return;
        store.pending.set(id, 'claim');
        store.notes.delete(id);
        this.patchCoinGiftCards(id);
        try {
            const res = await this.coinPostWithRetry(this.apiRoutes.coins.giftClaim(id), {});
            const data = await res.json().catch(() => null);
            if (data?.gift) this.applyCoinGiftState(data.gift, { patch: false });
            if (res.ok) {
                if (Number.isFinite(Number(data?.balance))) this.S.zaliCoinBalance = Number(data.balance);
                this.addLogEntry({ type: 'SUCCESS', msg: `Получено ${this.formatCoinAmount(data?.gift?.amount)} ZaliCoin`, ts: new Date().toLocaleTimeString() });
            } else if (data?.code !== 'already_claimed') {
                // already_claimed после потерянного ответа — это успех прошлой
                // попытки: состояние в data.gift уже показывает «Получено».
                this.setCoinGiftNote(id, data?.message || 'Не удалось получить ZaliCoin');
            }
        } catch (e) {
            this.trace(`claimCoinGift transport_error=${e}`);
            this.setCoinGiftNote(id, 'Нет связи с сервером, попробуйте ещё раз');
        } finally {
            store.pending.delete(id);
            this.patchCoinGiftCards(id);
            this.scheduleZaliCoinRefresh();
        }
    }

    // Отмена необратима для получателей, поэтому в два нажатия: первое превращает
    // кнопку в «Точно отменить?» на 4 секунды.
    onCoinGiftCancelClick(id) {
        const store = this.coinGiftStore();
        if (!id || store.pending.has(id)) return;
        clearTimeout(store.confirmTimer);
        if (store.confirmId !== id) {
            const previous = store.confirmId;
            store.confirmId = id;
            store.confirmTimer = setTimeout(() => {
                if (store.confirmId !== id) return;
                store.confirmId = null;
                this.patchCoinGiftCards(id);
                this.renderMyCoinGifts();
            }, 4000);
            if (previous) this.patchCoinGiftCards(previous);
            this.patchCoinGiftCards(id);
            this.renderMyCoinGifts();
            return;
        }
        store.confirmId = null;
        void this.cancelCoinGift(id);
    }

    async cancelCoinGift(id) {
        const store = this.coinGiftStore();
        if (!id || store.pending.has(id)) return;
        store.pending.set(id, 'cancel');
        store.notes.delete(id);
        this.patchCoinGiftCards(id);
        this.renderMyCoinGifts();
        try {
            const res = await this.coinPostWithRetry(this.apiRoutes.coins.giftCancel(id), {});
            const data = await res.json().catch(() => null);
            if (data?.gift) this.applyCoinGiftState(data.gift, { patch: false });
            if (res.ok) {
                if (Number.isFinite(Number(data?.balance))) this.S.zaliCoinBalance = Number(data.balance);
                if (Number.isFinite(Number(data?.held))) this.S.zaliCoinHeld = Number(data.held);
                this.addLogEntry({ type: 'INFO', msg: `Карточка ZaliCoin отменена, возвращено ${this.formatCoinAmount(data?.refunded)} ZC`, ts: new Date().toLocaleTimeString() });
            } else if (data?.code !== 'gift_cancelled') {
                this.setCoinGiftNote(id, data?.message || 'Не удалось отменить карточку');
            }
        } catch (e) {
            this.trace(`cancelCoinGift transport_error=${e}`);
            this.setCoinGiftNote(id, 'Нет связи с сервером, попробуйте ещё раз');
        } finally {
            store.pending.delete(id);
            this.patchCoinGiftCards(id);
            this.renderMyCoinGifts();
            this.scheduleZaliCoinRefresh();
        }
    }

    // Квитанция перевода: карточка в личном чате сверяет свою сумму и отправителя
    // с записью на сервере. Нет записи (или она чужая) — карточка так и говорит.
    ensureCoinTransferReceipt(id) {
        if (!/^[A-Za-z0-9-]{8,64}$/.test(String(id || ''))) return;
        const store = this.coinGiftStore();
        if (store.receiptsInFlight.has(id)) return;
        const cached = store.receipts.get(id);
        if (cached && (cached.ok !== null || Date.now() - cached.fetchedAt < 30000)) return;
        store.receiptsInFlight.add(id);
        void (async () => {
            try {
                const res = await this.apiFetch(this.apiRoutes.coins.transferReceipt(id));
                if (res.ok) {
                    const data = await res.json();
                    store.receipts.set(id, { ...data, ok: true, fetchedAt: Date.now() });
                } else if (res.status === 404) {
                    store.receipts.set(id, { ok: false, fetchedAt: Date.now() });
                } else {
                    store.receipts.set(id, { ok: null, fetchedAt: Date.now() });
                }
            } catch (e) {
                this.trace(`ensureCoinTransferReceipt error=${e}`);
                store.receipts.set(id, { ok: null, fetchedAt: Date.now() });
            } finally {
                store.receiptsInFlight.delete(id);
                this.coinCardNodes('data-zc-tx', id).forEach(node => {
                    const data = node.dataset;
                    node.innerHTML = this.coinTransferCardInner({
                        id,
                        amount: Number(data.zcAmount) || 0,
                        from: data.zcFrom || '',
                        to: data.zcTo || '',
                        time: data.zcTime || '',
                        clientId: data.zcClient || '',
                    });
                });
            }
        })();
    }
});
