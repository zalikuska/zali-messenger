// --- ZaliInterface: розыгрыши ZaliCoin — карточка в канале и конструктор. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Сервер — server/src/raffles.rs.
//
// Карточка — сообщение вида «🎲 …\n[zc-raffle:<id>]»; состояние живёт на сервере
// и приходит по `raffle_updated`. Как и у карточек-подарков, карточка — ссылка:
// если розыгрыш создал не автор сообщения или он из другого канала, она
// показывается недоступной. Секрет приза (промокод) сервер отдаёт только
// победителю и создателю, поэтому клиент ничего не «прячет» сам.
//
// Оформление — языком «Фокуса»: поверхность тоном, без рамок, градиентов и
// свечения; сплошной лайм только на «моём» и главном действии.

const ZALI_RAFFLE_MAX_RANGES = 8;
const ZALI_RAFFLE_ID_RE = /^[A-Za-z0-9-]{8,64}$/;

ZaliMixin(ZaliInterface, class {

    raffleStore() {
        if (!this._raffles) {
            this._raffles = {
                states: new Map(),    // id -> { state, missing, fetchedAt }
                queue: new Set(),
                inFlight: new Set(),
                flushTimer: null,
                pending: new Map(),   // id -> 'join' | 'cancel'
                notes: new Map(),     // id -> ошибка в карточке
                confirmId: null,
                confirmTimer: null,
                ticker: null,
                dueRefetch: new Set(),
            };
        }
        return this._raffles;
    }

    // ---- Текст карточки ----

    raffleCardText(raffle) {
        const title = String(raffle.title || 'Розыгрыш').replace(/\s+/g, ' ').trim();
        return `🎲 ${this.myName()} запустил(а) розыгрыш: ${title}\n[zc-raffle:${raffle.id}]`;
    }

    parseRaffleCard(text) {
        const match = String(text || '').trim().match(/^🎲[^\n]*?:\s*([^\n]*)\n\[zc-raffle:([A-Za-z0-9-]{8,64})\]$/u);
        return match ? { kind: 'raffle', title: match[1], id: match[2] } : null;
    }

    // ---- Состояние ----

    ensureRaffleState(id, { force = false } = {}) {
        if (!ZALI_RAFFLE_ID_RE.test(String(id || ''))) return;
        const store = this.raffleStore();
        if (store.inFlight.has(id) || store.queue.has(id)) return;
        const entry = store.states.get(id);
        if (entry && !force) {
            const status = entry.state?.status;
            if (status && status !== 'active') return;
            const ttl = entry.state ? 60000 : (entry.missing ? 300000 : 15000);
            if (Date.now() - entry.fetchedAt < ttl) return;
        }
        store.queue.add(id);
        if (!store.flushTimer) {
            store.flushTimer = setTimeout(() => {
                store.flushTimer = null;
                void this.flushRaffleQueue();
            }, 40);
        }
    }

    async flushRaffleQueue() {
        const store = this.raffleStore();
        const ids = Array.from(store.queue).slice(0, 50);
        if (!ids.length) return;
        ids.forEach(id => { store.queue.delete(id); store.inFlight.add(id); });
        try {
            const res = await this.apiFetch(this.apiRoutes.raffles.lookup(ids));
            if (res.ok) {
                const data = await res.json();
                const found = new Set();
                (Array.isArray(data?.raffles) ? data.raffles : []).forEach((raffle) => {
                    if (!raffle?.id) return;
                    found.add(raffle.id);
                    this.applyRaffleState(raffle, { patch: false });
                });
                const now = Date.now();
                ids.forEach((id) => {
                    if (!found.has(id)) store.states.set(id, { state: null, missing: true, fetchedAt: now });
                });
            }
        } catch (e) {
            this.trace(`flushRaffleQueue error=${e}`);
        }
        ids.forEach(id => store.inFlight.delete(id));
        ids.forEach(id => this.patchRaffleCards(id));
        if (store.queue.size && !store.flushTimer) {
            store.flushTimer = setTimeout(() => {
                store.flushTimer = null;
                void this.flushRaffleQueue();
            }, 40);
        }
    }

    applyRaffleState(raffle, { patch = true } = {}) {
        if (!raffle?.id) return;
        const store = this.raffleStore();
        const id = String(raffle.id);
        const prev = store.states.get(id)?.state;
        // Состояние только движется вперёд: активный → итог/отмена, участников не
        // становится меньше. Опоздавший ответ не должен вернуть кнопку «Участвую».
        const rank = (s) => (String(s?.status || 'active') === 'active' ? 0 : 1);
        if (prev && (rank(raffle) < rank(prev)
            || (rank(raffle) === rank(prev) && (Number(raffle.participants) || 0) < (Number(prev.participants) || 0)))) {
            store.states.get(id).fetchedAt = Date.now();
            return;
        }
        store.states.set(id, { state: raffle, missing: false, fetchedAt: Date.now() });
        if (patch) this.patchRaffleCards(id);
    }

    handleRaffleRealtime(payload) {
        const id = String(payload?.raffleId || '');
        if (!ZALI_RAFFLE_ID_RE.test(id)) return;
        // Содержимое у каждого своё (`you`), поэтому перечитываем, а не берём из кадра.
        this.ensureRaffleState(id, { force: true });
        if (String(payload?.status || '') !== 'active') this.scheduleZaliCoinRefresh?.();
    }

    raffleCardNodes(id) {
        if (!ZALI_RAFFLE_ID_RE.test(String(id || ''))) return [];
        return Array.from(document.querySelectorAll(`[data-raffle="${id}"]`));
    }

    patchRaffleCards(id) {
        this.raffleCardNodes(id).forEach((node) => {
            const parts = this.raffleCardParts({
                id,
                sender: node.dataset.raffleSender || '',
                serverId: node.dataset.raffleServer || '',
                channelId: node.dataset.raffleChannel || '',
                time: node.dataset.raffleTime || '',
                title: node.dataset.raffleTitle || '',
            });
            if (node.className !== parts.className) node.className = parts.className;
            node.innerHTML = parts.inner;
        });
    }

    // ---- Отрисовка ----

    /** Часы обратного отсчёта: М:СС, Ч:ММ:СС, а от суток — «3 д 4 ч». */
    raffleRemainingLabel(endsAt) {
        const left = Math.max(0, Number(endsAt) - Date.now());
        const s = Math.ceil(left / 1000);
        const d = Math.floor(s / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        if (d >= 1) return `${d} д ${h} ч`;
        const pad = (n) => String(n).padStart(2, '0');
        return h >= 1 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
    }

    /** Доля прошедшего времени, 0–100: для тонкой полоски отсчёта. */
    raffleElapsedPct(createdAt, endsAt) {
        const total = Number(endsAt) - Number(createdAt);
        if (!(total > 0)) return 100;
        return Math.min(100, Math.max(0, ((Date.now() - Number(createdAt)) / total) * 100));
    }

    rafflePlacesLabel(prize) {
        return prize.from === prize.to ? `${prize.from}` : `${prize.from}–${prize.to}`;
    }

    renderRaffleCard(card, msg) {
        const time = msg?.timestamp ? this.fmtTime(msg.timestamp) : '';
        const sender = String(msg?.sender || '').trim();
        const inChannel = this.currentConversationMode() === 'servers';
        const serverId = String(msg?.serverId || (inChannel ? this.S.activeServer : '') || '');
        const channelId = String(msg?.channelId || (inChannel ? this.S.activeChannel : '') || '');
        this.ensureRaffleState(card.id);
        this.ensureRaffleTicker();
        const desc = { id: card.id, sender, serverId, channelId, time, title: card.title };
        const parts = this.raffleCardParts(desc);
        return `<div class="${this.esc(parts.className)}" data-raffle="${this.esc(card.id)}" data-raffle-sender="${this.esc(sender)}" data-raffle-server="${this.esc(serverId)}" data-raffle-channel="${this.esc(channelId)}" data-raffle-time="${this.esc(time)}" data-raffle-title="${this.esc(card.title)}">${parts.inner}</div>`;
    }

    raffleGiftIcon() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="9" width="17" height="11" rx="2"/><path d="M12 9v11M3.5 13h17"/><path d="M12 9c-1.2-3.6-5-3.4-5-1.2 0 1.4 2.2 1.2 5 1.2zm0 0c1.2-3.6 5-3.4 5-1.2 0 1.4-2.2 1.2-5 1.2z"/></svg>';
    }

    raffleCoinIcon() {
        return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="12" r="6.4" stroke="currentColor" stroke-width="1" opacity=".35"/><path d="M9.7 9.3h4.6l-4.6 5.4h4.6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.6 12h2.8" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
    }

    raffleClockIcon() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
    }

    /** Рассыпанное конфетти в углу шапки — тёмным по лаймовому, едва заметно. */
    raffleConfettiSvg() {
        return '<svg class="rf-confetti" viewBox="0 0 160 120" aria-hidden="true" focusable="false"><g fill="currentColor"><circle cx="118" cy="22" r="6"/><circle cx="146" cy="58" r="4"/><circle cx="96" cy="84" r="3"/><rect x="128" y="86" width="12" height="5" rx="2.5" transform="rotate(-28 134 88)"/><rect x="88" y="14" width="10" height="4" rx="2" transform="rotate(35 93 16)"/></g><g fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M104 46l9 5-9 5"/><path d="M140 18v10M135 23h10"/><path d="M70 40q6-8 12 0t12 0"/></g></svg>';
    }

    raffleCardParts(desc) {
        const store = this.raffleStore();
        const entry = store.states.get(desc.id);
        const state = entry?.state || null;
        const me = this.myName();
        const foreign = !!state && (state.creator !== desc.sender
            || state.serverId !== desc.serverId
            || state.channelId !== desc.channelId);
        const live = state && !foreign ? state : null;
        const missing = !!entry?.missing || foreign;
        const pending = store.pending.get(desc.id) || '';
        const note = store.notes.get(desc.id)?.text || '';
        const status = live ? String(live.status) : '';
        const isCreator = !!live && live.creator === me;
        const you = live?.you || { joined: false };
        const people = Number(live?.participants) || 0;
        const peopleLabel = `${people} ${this.coinPlural(people, ['участник', 'участника', 'участников'])}`;
        const tiers = live ? (live.prizes || []) : [];
        const placesTotal = tiers.length ? Math.max(...tiers.map(p => p.to)) : 0;
        const won = !!(live && status === 'drawn' && you.joined && you.prize);
        const title = live?.title || desc.title || 'Розыгрыш';

        const button = (label, tone, { join = '', cancel = '', disabled = false, icon = '' } = {}) =>
            `<button type="button" class="rf-btn ${this.esc(tone)}"${join ? ` data-raffle-join="${this.esc(join)}"` : ''}${cancel ? ` data-raffle-cancel="${this.esc(cancel)}"` : ''}${disabled ? ' disabled' : ''}>${icon}<span>${this.esc(label)}</span></button>`;

        let action = '';
        if (pending === 'join') action = button('Записываем…', 'is-quiet', { disabled: true });
        else if (pending === 'cancel') action = button('Отмена…', 'is-quiet', { disabled: true });
        else if (!live) action = missing ? '' : button('Участвую', 'is-quiet', { disabled: true });
        else if (status === 'active') {
            if (isCreator) {
                const confirming = store.confirmId === desc.id;
                action = button(confirming ? 'Точно отменить?' : 'Отменить розыгрыш', confirming ? 'is-danger' : 'is-quiet', { cancel: desc.id });
            } else if (you.joined) {
                action = button('Вы участвуете', 'is-done', { disabled: true, icon: this.coinCheckIcon() });
            } else {
                action = button('Участвую', 'is-primary', { join: desc.id });
            }
        }

        // Шапка: яркая, пока розыгрыш идёт или человек выиграл; после итога без
        // приза и при отмене — приглушённая.
        let kicker = 'Розыгрыш';
        if (placesTotal) kicker += ` · ${placesTotal} ${this.coinPlural(placesTotal, ['место', 'места', 'мест'])}`;
        let heroClass = '';
        let heroFoot = '';
        if (live && status === 'active') {
            const pct = this.raffleElapsedPct(live.createdAt, live.endsAt);
            heroFoot = `<div class="rf-clock"><span class="rf-clock-ico">${this.raffleClockIcon()}</span><span class="rf-left" data-raffle-end="${this.esc(live.endsAt)}" data-raffle-id="${this.esc(desc.id)}">${this.esc(this.raffleRemainingLabel(live.endsAt))}</span><span class="rf-people">${this.esc(peopleLabel)}</span></div>
                <div class="rf-bar" aria-hidden="true"><i data-raffle-bar="${this.esc(desc.id)}" data-raffle-from="${this.esc(live.createdAt)}" data-raffle-to="${this.esc(live.endsAt)}" style="width:${Number(pct.toFixed(1))}%"></i></div>`;
        } else if (won) {
            kicker = 'Вы выиграли!';
            heroClass = ' is-won';
            heroFoot = `<div class="rf-clock"><strong class="rf-place">${this.esc(you.place)} место</strong><span class="rf-people">${this.esc(you.prize)}</span></div>`;
        } else if (live && status === 'drawn') {
            heroClass = ' is-muted';
            heroFoot = `<div class="rf-clock"><span class="rf-left">Итоги подведены</span><span class="rf-people">${this.esc(you.joined && you.place ? `ваше место — ${you.place}` : peopleLabel)}</span></div>`;
        } else if (live && status === 'cancelled') {
            heroClass = ' is-muted';
            heroFoot = '<div class="rf-clock"><span class="rf-left">Отменён</span></div>';
        } else {
            heroClass = ' is-muted';
        }

        // Призы: яркий номер места слева, приз справа; у монет — значок монеты.
        let tiersHtml = '';
        if (tiers.length && status !== 'cancelled') {
            tiersHtml = `<div class="rf-tiers">${tiers.map((p) => {
                const icon = p.kind === 'coins' ? this.coinGiftIcon() : `<span class="rf-gift">${this.raffleGiftIcon()}</span>`;
                return `<div class="rf-tier"><span class="rf-tier-places">${this.esc(this.rafflePlacesLabel(p))}</span><span class="rf-tier-prize">${this.esc(p.label)}</span><span class="rf-tier-icon">${icon}</span></div>`;
            }).join('')}</div>`;
        }

        let result = '';
        if (won && you.secret) {
            result += `<div class="rf-secret"><span>Ваш приз</span><code class="rf-code">${this.esc(you.secret)}</code></div>`;
        }
        if (live && status === 'drawn') {
            const winners = Array.isArray(live.winners) ? live.winners : [];
            if (winners.length) {
                const shown = winners.slice(0, 3);
                result += `<div class="rf-winners">${shown.map(w => `<div class="rf-winner"><span class="rf-winner-place">${this.esc(w.place)}</span><span class="rf-winner-name">${this.esc(this.messageSenderLabel(w.username))}</span><span class="rf-winner-prize">${this.esc(w.prize)}</span></div>`).join('')}${winners.length > shown.length ? `<div class="rf-more">и ещё ${this.esc(winners.length - shown.length)}</div>` : ''}</div>`;
            }
            if (isCreator && Number(live.refunded) > 0) {
                result += `<div class="rf-note">Вернулось ${this.esc(this.formatCoinAmount(live.refunded))} ZC</div>`;
            }
        }

        let footnote = '';
        if (note) footnote = `<div class="rf-note is-error">${this.esc(note)}</div>`;
        else if (missing) footnote = '<div class="rf-note">Розыгрыш не найден или вам недоступен</div>';

        const stateClass = live ? `is-${status}` : (missing ? 'is-missing' : 'is-loading');
        const inner = `<div class="rf-hero${this.esc(heroClass)}">
                ${this.raffleConfettiSvg()}
                <div class="rf-hero-top"><span class="rf-kicker">${this.esc(kicker)}</span>${desc.time ? `<span class="rf-time">${this.esc(desc.time)}</span>` : ''}</div>
                <div class="rf-name">${this.esc(title)}</div>
                ${heroFoot}
            </div>
            <div class="rf-body">
                ${tiersHtml}
                ${result}
                ${action}
                ${footnote}
            </div>`;
        return {
            className: `zc-card zc-card--raffle rf-card ${stateClass}${won ? ' is-won' : ''}`,
            inner,
        };
    }

    /** Обратный отсчёт — один таймер на все карточки в ленте. */
    ensureRaffleTicker() {
        const store = this.raffleStore();
        if (store.ticker) return;
        store.ticker = setInterval(() => {
            const nodes = document.querySelectorAll('[data-raffle-end]');
            if (!nodes.length) {
                clearInterval(store.ticker);
                store.ticker = null;
                return;
            }
            nodes.forEach((node) => {
                const endsAt = Number(node.getAttribute('data-raffle-end'));
                node.textContent = this.raffleRemainingLabel(endsAt);
                const bar = node.closest('.rf-card')?.querySelector('[data-raffle-bar]');
                if (bar) {
                    bar.style.width = `${this.raffleElapsedPct(bar.getAttribute('data-raffle-from'), bar.getAttribute('data-raffle-to')).toFixed(1)}%`;
                }
                const id = node.getAttribute('data-raffle-id') || '';
                // Время вышло: сервер подведёт итог сам, нужно лишь перечитать карточку.
                if (endsAt <= Date.now() && id && !store.dueRefetch.has(id)) {
                    store.dueRefetch.add(id);
                    setTimeout(() => {
                        this.ensureRaffleState(id, { force: true });
                        store.dueRefetch.delete(id);
                    }, 1500);
                }
            });
        }, 1000);
    }

    // ---- Действия ----

    setRaffleNote(id, text) {
        const store = this.raffleStore();
        store.notes.set(id, { text, at: Date.now() });
        this.patchRaffleCards(id);
        setTimeout(() => {
            const note = store.notes.get(id);
            if (note && Date.now() - note.at >= 5000) {
                store.notes.delete(id);
                this.patchRaffleCards(id);
            }
        }, 5200);
    }

    async joinRaffle(id) {
        const store = this.raffleStore();
        if (store.pending.has(id)) return;
        store.pending.set(id, 'join');
        store.notes.delete(id);
        this.patchRaffleCards(id);
        try {
            // Один автоповтор при сбое сети: запись идемпотентна (один аккаунт — одна запись).
            const res = await this.coinPostWithRetry(this.apiRoutes.raffles.join(id), {});
            const data = await res.json().catch(() => null);
            if (data?.raffle) this.applyRaffleState(data.raffle, { patch: false });
            if (!res.ok) this.setRaffleNote(id, String(data?.message || 'Не удалось записаться'));
        } catch (e) {
            this.trace(`joinRaffle transport_error=${e}`);
            this.setRaffleNote(id, 'Нет связи с сервером — проверьте подключение и попробуйте ещё раз');
        } finally {
            store.pending.delete(id);
            this.patchRaffleCards(id);
        }
    }

    onRaffleCancelClick(id) {
        const store = this.raffleStore();
        if (store.pending.has(id)) return;
        if (store.confirmId !== id) {
            store.confirmId = id;
            clearTimeout(store.confirmTimer);
            store.confirmTimer = setTimeout(() => {
                if (store.confirmId === id) {
                    store.confirmId = null;
                    this.patchRaffleCards(id);
                }
            }, 4000);
            this.patchRaffleCards(id);
            return;
        }
        store.confirmId = null;
        clearTimeout(store.confirmTimer);
        void this.cancelRaffle(id);
    }

    async cancelRaffle(id) {
        const store = this.raffleStore();
        store.pending.set(id, 'cancel');
        this.patchRaffleCards(id);
        try {
            // Автоповтор после сбоя сети: если первый запрос дошёл, повтор получит
            // «уже завершён» — это не ошибка, карточка просто перечитывается.
            const res = await this.coinPostWithRetry(this.apiRoutes.raffles.cancel(id), {});
            const data = await res.json().catch(() => null);
            if (data?.raffle) this.applyRaffleState(data.raffle, { patch: false });
            if (res.ok) {
                this.scheduleZaliCoinRefresh?.();
            } else if (data?.code === 'finished') {
                this.ensureRaffleState(id, { force: true });
                this.scheduleZaliCoinRefresh?.();
            } else {
                this.setRaffleNote(id, String(data?.message || `Не удалось отменить (${res.status})`));
            }
        } catch (e) {
            this.trace(`cancelRaffle transport_error=${e}`);
            this.setRaffleNote(id, 'Нет связи с сервером — розыгрыш не отменён, проверьте подключение и попробуйте ещё раз');
        } finally {
            store.pending.delete(id);
            this.patchRaffleCards(id);
        }
    }

    // ---- Конструктор ----
    // Призы — список категорий: вид приза и сколько победителей. Места не
    // вводятся руками, а выводятся из порядка: первая категория берёт места
    // с 1-го, следующая — следом. Порядок меняется перетаскиванием (тем же
    // поведением, что у списка каналов в настройках сервера, row_reorder.js),
    // а диапазон мест у каждой категории пересчитывается на глазах.

    openRaffleBuilder() {
        const server = this.currentServer();
        const channel = this.currentChannel();
        const modal = document.getElementById('raffleModal');
        if (!modal || !server || !channel || this.isVoiceChannel(channel)) {
            this.addLogEntry?.({ type: 'WARN', msg: 'Розыгрыш запускается в текстовом канале сервера', ts: new Date().toLocaleTimeString() });
            return;
        }
        const ctx = { serverId: server.id, channelId: channel.id };
        let uid = 0;
        const newCat = (kind = 'coins', count = 1) => ({
            id: `c${++uid}`,
            kind,
            count: String(count),
            amount: kind === 'coins' ? '100' : '',
            label: 'Промокод',
            secret: '',
        });
        const model = { title: '', secs: 3600, rows: [newCat('coins', 1)] };
        let key = this.zaliCoinNewIdempotencyKey();
        let lastPayload = '';
        let busy = false;
        const $ = (id) => document.getElementById(id);
        const toInt = (v) => Math.trunc(Number(String(v).replace(/\s+/g, '')));
        const grip = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';

        $('raffleTarget').textContent = this.coinGiftChannelLabel({ serverId: ctx.serverId, channelId: ctx.channelId });
        $('raffleTitleInput').value = '';
        modal.querySelectorAll('[data-rf-secs]').forEach(b => b.classList.toggle('is-active', b.getAttribute('data-rf-secs') === '3600'));

        const placesLabel = (from, to) => (from === to ? `${from}` : `${from}–${to}`);

        // Места выводятся из порядка и количества: накопительная сумма.
        const compute = () => {
            let next = 1;
            return model.rows.map((r) => {
                const count = toInt(r.count);
                const ok = Number.isFinite(count) && count >= 1;
                const from = next;
                const to = ok ? next + count - 1 : next;
                if (ok) next = to + 1;
                return { ...r, countN: ok ? count : 0, amountN: toInt(r.amount), from, to, countOk: ok };
            });
        };

        const hintFor = (r) => {
            if (!r.countOk) return { text: 'Укажите, сколько победителей получат этот приз', error: true };
            if (r.to > 1000) return { text: 'Всего мест — не больше 1000', error: true };
            const placesText = `${r.countN} ${this.coinPlural(r.countN, ['победитель', 'победителя', 'победителей'])}`;
            if (r.kind === 'coins') {
                if (!Number.isFinite(r.amountN) || r.amountN < 1) return { text: 'Укажите, сколько ZaliCoin получит каждый', error: true };
                return { text: `${placesText} · по ${this.formatCoinAmount(r.amountN)} ZC = ${this.formatCoinAmount(r.amountN * r.countN)} ZC`, error: false };
            }
            if (!String(r.label).trim()) return { text: 'Дайте призу название', error: true };
            return { text: `${placesText} · код ${String(r.secret).trim() ? 'скрыт до итогов' : 'не указан'}`, error: false };
        };

        const rowHtml = (r, i, many) => {
            const hint = hintFor(r);
            const isCoins = r.kind === 'coins';
            const toggleTitle = isCoins ? 'ZaliCoin — нажмите, чтобы выдавать промокод' : 'Промокод — нажмите, чтобы выдавать ZaliCoin';
            return `<div class="rf-cat" data-rf-row="${Number(i)}" data-rf-id="${this.esc(r.id)}">
                <span class="rf-grip" aria-hidden="true" title="Перетащите, чтобы поменять места">${grip}</span>
                <div class="rf-cat-main">
                    <div class="rf-cat-top">
                        <span class="rf-cat-places" data-rf-places="${Number(i)}" title="Места">${this.esc(r.countOk ? placesLabel(r.from, r.to) : '—')}</span>
                        <input type="text" class="settings-input rf-count" data-rf-field="count" inputmode="numeric" autocomplete="off" placeholder="Кол-во" value="${this.esc(r.count)}" aria-label="Сколько победителей" title="Сколько победителей">
                        <button type="button" class="rf-kind-toggle${isCoins ? '' : ' is-item'}" data-rf-kind-toggle title="${this.esc(toggleTitle)}" aria-label="${this.esc(toggleTitle)}">${isCoins ? this.raffleCoinIcon() : this.raffleGiftIcon()}</button>
                        <span class="rf-kind-name">${isCoins ? 'ZaliCoin' : 'Промокод'}</span>
                        ${many ? `<button type="button" class="rf-del" data-rf-del aria-label="Убрать категорию" title="Убрать категорию">${this.uiIcon ? this.uiIcon('trash', 'rf-del-icon') : '×'}</button>` : ''}
                    </div>
                    ${isCoins
                        ? `<input type="text" class="settings-input" data-rf-field="amount" inputmode="numeric" autocomplete="off" placeholder="Сколько ZaliCoin получит каждый" value="${this.esc(r.amount)}" aria-label="Сколько ZaliCoin каждому">`
                        : `<input type="text" class="settings-input" data-rf-field="label" maxlength="60" autocomplete="off" placeholder="Название приза" value="${this.esc(r.label)}" aria-label="Название приза">
                           <input type="text" class="settings-input" data-rf-field="secret" maxlength="300" autocomplete="off" placeholder="Сам промокод — увидит только победитель" value="${this.esc(r.secret)}" aria-label="Промокод">`}
                    <div class="rf-hint${hint.error ? ' is-error' : ''}"><span data-rf-hint="${Number(i)}">${this.esc(hint.text)}</span></div>
                </div>
            </div>`;
        };

        const analyze = () => {
            const rows = compute();
            let escrow = 0;
            let places = 0;
            let error = '';
            if (!String(model.title).trim()) error = 'Введите название';
            rows.forEach((r) => {
                const h = hintFor(r);
                if (h.error && !error) error = h.text;
                if (h.error) return;
                if (r.kind === 'coins') escrow += r.amountN * r.countN;
                places = Math.max(places, r.to);
            });
            return { rows, escrow, places, error };
        };

        const setSummary = (text, tone = '', caption = '') => {
            const el = $('raffleSummary');
            el.innerHTML = `<b></b>${caption ? '<span></span>' : ''}`;
            el.firstChild.textContent = text;
            if (caption) el.lastChild.textContent = caption;
            el.className = `rf-total${tone ? ` ${tone}` : ''}`;
        };

        const refresh = ({ rerender = false } = {}) => {
            const a = analyze();
            if (rerender) {
                $('raffleRows').innerHTML = a.rows.map((r, i) => rowHtml(r, i, a.rows.length > 1)).join('');
            } else {
                // Без перерисовки строк: иначе поле теряет фокус на каждом знаке.
                a.rows.forEach((r, i) => {
                    const hintEl = modal.querySelector(`[data-rf-hint="${i}"]`);
                    const h = hintFor(r);
                    if (hintEl) {
                        hintEl.textContent = h.text;
                        hintEl.parentElement.classList.toggle('is-error', h.error);
                    }
                    const placesEl = modal.querySelector(`[data-rf-places="${i}"]`);
                    if (placesEl) placesEl.textContent = r.countOk ? placesLabel(r.from, r.to) : '—';
                });
            }
            $('raffleAddBtn').hidden = model.rows.length >= ZALI_RAFFLE_MAX_RANGES;
            const rawBalance = this.S.zaliCoinBalance;
            const known = rawBalance !== undefined && rawBalance !== null && Number.isFinite(Number(rawBalance));
            const balance = known ? Math.max(0, Math.trunc(Number(rawBalance))) : 0;
            const short = known && a.escrow > balance;
            if (short) {
                setSummary(`Не хватает ${this.formatCoinAmount(a.escrow - balance)} ZC — на балансе ${this.formatCoinAmount(balance)}`, 'is-error');
            } else if (a.escrow > 0) {
                setSummary(`${this.formatCoinAmount(a.escrow)} ZC`, 'is-coins', `заморозится на призы · всего мест: ${a.places}`);
            } else {
                setSummary(`Всего мест: ${a.places}`, '', 'призы без монет ничего не замораживают');
            }
            const submit = $('raffleSubmitBtn');
            submit.disabled = busy || !!a.error || short;
            submit.textContent = busy ? 'Запуск…' : 'Запустить';
            return a;
        };

        // Перетаскивание: пока строка в движении, подписи мест уже показывают
        // будущий расклад, а по отпускании порядок записывается в модель.
        const reorderPreview = (ids) => {
            const byId = new Map(model.rows.map(r => [r.id, r]));
            const order = ids.map(id => byId.get(id)).filter(Boolean);
            if (order.length !== model.rows.length) return;
            let next = 1;
            const spans = {};
            order.forEach((r) => {
                const count = toInt(r.count);
                if (Number.isFinite(count) && count >= 1) {
                    spans[r.id] = placesLabel(next, next + count - 1);
                    next += count;
                } else {
                    spans[r.id] = '—';
                }
            });
            modal.querySelectorAll('.rf-cat').forEach((el) => {
                const label = spans[el.getAttribute('data-rf-id')];
                const target = el.querySelector('[data-rf-places]');
                if (target && label !== undefined) target.textContent = label;
            });
        };
        ZaliRowReorder.bind($('raffleRows'), {
            rowSelector: '.rf-cat',
            idAttr: 'data-rf-id',
            ignore: 'input, textarea, select',
            onPreview: reorderPreview,
            onReorder: (ids) => {
                const byId = new Map(model.rows.map(r => [r.id, r]));
                const order = ids.map(id => byId.get(id)).filter(Boolean);
                if (order.length === model.rows.length) model.rows = order;
                refresh({ rerender: true });
            },
        });

        refresh({ rerender: true });

        const close = () => {
            modal.hidden = true;
            document.removeEventListener('keydown', onKey, true);
            modal.removeEventListener('click', onClick);
            modal.removeEventListener('input', onInput);
            const opener = this._raffleOpener;
            this._raffleOpener = null;
            if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
        };
        const onKey = (e) => {
            if (e.key === 'Escape' && !busy) {
                e.preventDefault();
                e.stopPropagation();
                close();
            } else if (e.key === 'Enter' && e.target?.tagName === 'INPUT' && !$('raffleSubmitBtn').disabled) {
                e.preventDefault();
                void send();
            }
        };
        const onInput = (e) => {
            const t = e.target;
            if (t.id === 'raffleTitleInput') model.title = t.value;
            else if (t.dataset?.rfField) {
                const i = Number(t.closest('[data-rf-row]')?.getAttribute('data-rf-row'));
                if (model.rows[i]) model.rows[i][t.dataset.rfField] = t.value;
            }
            refresh();
        };
        const onClick = (e) => {
            if (e.target === modal || e.target.closest('#raffleCloseBtn') || e.target.closest('#raffleCancelBtn')) {
                if (!busy) close();
                return;
            }
            const secs = e.target.closest('[data-rf-secs]');
            if (secs) {
                model.secs = Number(secs.getAttribute('data-rf-secs')) || 3600;
                modal.querySelectorAll('[data-rf-secs]').forEach(b => b.classList.toggle('is-active', b === secs));
                refresh();
                return;
            }
            const toggle = e.target.closest('[data-rf-kind-toggle]');
            if (toggle) {
                const i = Number(toggle.closest('[data-rf-row]')?.getAttribute('data-rf-row'));
                const row = model.rows[i];
                if (row) {
                    row.kind = row.kind === 'coins' ? 'item' : 'coins';
                    if (row.kind === 'coins' && !String(row.amount).trim()) row.amount = '100';
                    refresh({ rerender: true });
                    modal.querySelector(`[data-rf-row="${i}"] [data-rf-field="${row.kind === 'coins' ? 'amount' : 'secret'}"]`)?.focus();
                }
                return;
            }
            if (e.target.closest('#raffleAddBtn')) {
                if (model.rows.length < ZALI_RAFFLE_MAX_RANGES) {
                    model.rows.push(newCat('coins', 1));
                    refresh({ rerender: true });
                    const list = $('raffleRows');
                    list.lastElementChild?.scrollIntoView({ block: 'nearest' });
                    list.lastElementChild?.querySelector('[data-rf-field="amount"]')?.focus();
                }
                return;
            }
            const del = e.target.closest('[data-rf-del]');
            if (del) {
                const i = Number(del.closest('[data-rf-row]')?.getAttribute('data-rf-row'));
                if (model.rows.length > 1 && model.rows[i]) {
                    model.rows.splice(i, 1);
                    refresh({ rerender: true });
                }
                return;
            }
            if (e.target.closest('#raffleSubmitBtn') && !$('raffleSubmitBtn').disabled) void send();
        };

        const send = async () => {
            const a = analyze();
            if (a.error || busy) return;
            const prizes = a.rows.map(r => r.kind === 'coins'
                ? { from: r.from, to: r.to, kind: 'coins', amount: r.amountN }
                : { from: r.from, to: r.to, kind: 'item', label: String(r.label).trim(), secret: String(r.secret || '').trim() });
            const payload = { serverId: ctx.serverId, channelId: ctx.channelId, title: String(model.title).trim(), endsInSecs: model.secs, prizes };
            // Один ключ на одно и то же содержимое: повтор не заморозит призы дважды.
            const signature = JSON.stringify(payload);
            if (lastPayload && lastPayload !== signature) key = this.zaliCoinNewIdempotencyKey();
            lastPayload = signature;
            busy = true;
            refresh();
            let res;
            try {
                res = await this.coinPostWithRetry(this.apiRoutes.raffles.base, { ...payload, idempotencyKey: key });
            } catch (e) {
                busy = false;
                refresh();
                setSummary('Не удалось связаться с сервером — попробуйте ещё раз', 'is-error');
                return;
            }
            const data = await res.json().catch(() => null);
            if (!res.ok || !data?.raffle?.id) {
                busy = false;
                refresh();
                setSummary(String(data?.message || 'Не удалось создать розыгрыш'), 'is-error');
                return;
            }
            this.applyRaffleState(data.raffle, { patch: false });
            if (Number.isFinite(Number(data.balance))) this.S.zaliCoinBalance = Number(data.balance);
            if (Number.isFinite(Number(data.held))) this.S.zaliCoinHeld = Number(data.held);
            this.scheduleZaliCoinRefresh?.();
            busy = false;
            close();
            const stillHere = this.currentConversationMode() === 'servers'
                && this.S.activeServer === ctx.serverId
                && this.S.activeChannel === ctx.channelId;
            if (!stillHere) {
                this.addLogEntry?.({ type: 'WARN', msg: 'Розыгрыш создан, но канал сменился — карточка не отправлена. Призы вернутся после итога или при отмене', ts: new Date().toLocaleTimeString() });
                return;
            }
            await this.postCoinCardMessage(
                this.raffleCardText(data.raffle),
                'Розыгрыш создан, но карточка не отправлена в чат',
            );
        };

        this._raffleOpener = document.activeElement;
        modal.addEventListener('click', onClick);
        modal.addEventListener('input', onInput);
        document.addEventListener('keydown', onKey, true);
        modal.hidden = false;
        $('raffleTitleInput').focus();
        // Баланс на экране мог устареть — уточняем, блокируя отправку только по свежему.
        void this.loadZaliCoinBalance().then(() => { if (!modal.hidden) refresh(); });
    }
});
