// --- ZaliInterface: Экран ZaliCoin: баланс, распределение, переводы. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // ============================================================
    // ZALICOIN — fixed-supply (100 000) in-app currency. Balance/distribution
    // come from /api/coins/*; transfers are server-authoritative (balance
    // checks + double-spend protection live in server/src/coins.rs), this is
    // just presentation + the idempotency key that makes a retried submit safe.
    // ============================================================

    async refreshZaliCoinView() {
        await Promise.all([this.loadZaliCoinBalance(), this.loadZaliCoinDistribution()]);
        this.renderZaliCoinView();
    }

    async loadZaliCoinBalance() {
        try {
            const res = await this.apiFetch(this.apiRoutes.coins.balance, { interactive: true });
            if (!res.ok) return;
            const data = await res.json();
            this.S.zaliCoinBalance = Number(data.balance) || 0;
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
        } catch (e) {
            this.trace(`loadZaliCoinDistribution error=${e}`);
        }
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

        const MAX_SEGMENTS = 8;
        const top = holders.slice(0, MAX_SEGMENTS);
        const rest = holders.slice(MAX_SEGMENTS);
        const restTotal = rest.reduce((sum, h) => sum + (Number(h.balance) || 0), 0);
        const accounted = top.reduce((sum, h) => sum + (Number(h.balance) || 0), 0) + restTotal;
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
    }

    zaliCoinNewIdempotencyKey() {
        return this.randomBase64(16).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    openCoinTransferModal(prefillRecipient = '') {
        const modal = document.getElementById('coinTransferModal');
        if (!modal) return;
        this._coinTransferIdempotencyKey = this.zaliCoinNewIdempotencyKey();
        // The key above is only valid for one exact (to, amount) payload — see
        // submitCoinTransfer, which rotates it whenever the payload changes.
        this._coinTransferLastPayload = '';
        this._coinTransferInFlight = false;
        this._coinTransferFromWallet = !prefillRecipient;
        const recipientInput = document.getElementById('coinTransferRecipientInput');
        const amountInput = document.getElementById('coinTransferAmountInput');
        const submitBtn = document.getElementById('coinTransferSubmitBtn');
        const status = document.getElementById('coinTransferStatus');
        if (recipientInput) {
            recipientInput.value = prefillRecipient || '';
            recipientInput.disabled = !!prefillRecipient;
        }
        if (amountInput) amountInput.value = '';
        if (submitBtn) submitBtn.disabled = false;
        if (status) { status.textContent = ''; status.hidden = true; }
        modal.hidden = false;
        (prefillRecipient ? amountInput : recipientInput)?.focus();
    }

    closeCoinTransferModal() {
        const modal = document.getElementById('coinTransferModal');
        if (modal) modal.hidden = true;
    }

    async submitCoinTransfer() {
        const modal = document.getElementById('coinTransferModal');
        if (!modal || modal.hidden) return;
        // The Enter-key path calls this directly, bypassing the disabled submit
        // button — without this guard a held/repeated Enter fires concurrent
        // submits (server-side idempotency makes the money safe, but the client
        // would close/re-log/post the chat notice once per call).
        if (this._coinTransferInFlight) return;
        const recipientInput = document.getElementById('coinTransferRecipientInput');
        const amountInput = document.getElementById('coinTransferAmountInput');
        const submitBtn = document.getElementById('coinTransferSubmitBtn');
        const status = document.getElementById('coinTransferStatus');
        const setStatus = (msg) => { if (status) { status.textContent = msg; status.hidden = !msg; } };

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
        this._coinTransferInFlight = false;
        if (submitBtn) submitBtn.disabled = false;
        this.closeCoinTransferModal();
        this.addLogEntry({ type: 'INFO', msg: `Отправлено ${amount} ZaliCoin пользователю ${to}`, ts: new Date().toLocaleTimeString() });
        this.refreshZaliCoinView();

        // Post a normal chat message so the transfer shows up in the
        // conversation — only when it's the peer of the chat the button
        // was opened from; a wallet-tab transfer to an arbitrary user may
        // have no open conversation to post into, so it's skipped there.
        // Its own failure (e.g. a flaky send right after) is logged, not
        // surfaced as a transfer error — the money already moved.
        if (!this._coinTransferFromWallet && to === this.S.current) {
            const input = document.getElementById('msgInput');
            // A half-typed draft may be sitting in the composer — the transfer
            // notice must not silently destroy (or worse, replace-and-send) it.
            const draft = input ? input.value : '';
            try {
                if (input) {
                    // Named explicitly: this renders as a centered system pill
                    // (detectSystemNotice), not a left/right bubble, so there's no
                    // avatar or sender-side layout to imply who sent it — without
                    // the name in the text itself it read as anonymous.
                    input.value = `💰 ${this.myName()} перевёл(а) ${amount} ZaliCoin`;
                    this.updateSendButtonState?.();
                    await this.sendInputMessage();
                }
            } catch (e) {
                this.trace(`submitCoinTransfer chat_message_post_failed=${e}`);
                this.addLogEntry({ type: 'WARN', msg: 'ZaliCoin переведён, но не удалось отправить сообщение об этом в чат', ts: new Date().toLocaleTimeString() });
            } finally {
                if (input && draft) {
                    input.value = draft;
                    this.updateSendButtonState?.();
                }
            }
        }
    }

    async transferCoinsRequest(to, amount) {
        const body = JSON.stringify({ to, amount, idempotencyKey: this._coinTransferIdempotencyKey });
        try {
            return await this.apiFetch(this.apiRoutes.coins.transfer, { method: 'POST', body });
        } catch (firstError) {
            this.trace(`transferCoinsRequest retrying after transport error=${firstError}`);
            return await this.apiFetch(this.apiRoutes.coins.transfer, { method: 'POST', body });
        }
    }
});
