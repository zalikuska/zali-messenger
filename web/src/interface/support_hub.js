// --- ZaliInterface: хаб → «Поддержка»: состояние аккаунта, нарушения, жалобы. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Источник — GET /api/moderation/standing (server/src/moderation.rs).
//
// Страница собрана по рецептам docs/UI_GUIDELINES.md, §4:
//   • состояние — «крупная плитка-значение» (как баланс казны): метка, статус,
//     пояснение, шкала из четырёх ячеек и одноцветная иллюстрация справа;
//   • нарушения — плитки-переходы (как разделы хаба): слева знак тяжести на
//     нейтральной плитке, заголовок — тяжесть, подпись — за что, справа — сколько
//     ещё действует. Цвет тяжести — только у глифа и у шкалы («цвет без пятна»);
//   • жалобы — список-плитки с подписями дней;
//   • «как устроены меры» — плитки-факты и группы пунктов по исходу.
// Страница нарушения (data-hub-pane="violation") — «окно-страница»: крупная плитка
// со сроком, итоги тремя плитками, группы «Решение» и «Возражение», справа —
// фрагмент переписки с отмеченными сообщениями.
//
// Разметка — только через setHTMLIfChanged: состояние приходит по WS
// (moderation_standing) в любой момент, перерисовка не должна мигать.
ZaliMixin(ZaliInterface, class {

    static get SUPPORT_TIER_SIGN() {
        return { warning: 'tier-warning', violation: 'tier-violation', serious: 'tier-serious' };
    }

    supportState() {
        if (!this._support) {
            this._support = {
                standing: null,
                loading: null,
                error: '',
                detailId: '',
                detail: null,
                detailError: '',
                appealOpen: false,
                appealSending: false,
                appealError: '',
            };
        }
        return this._support;
    }

    openSupportHub() {
        this.openHubView?.();
        this.setHubTab('support');
    }

    // Из onGameActivityConnected: вход и каждый реконнект — нужно знать об
    // ограничениях до первой попытки что-то отправить.
    moderationOnConnected() {
        void this.loadModerationStanding({ silent: true });
    }

    handleModerationRealtime(payload) {
        void this.loadModerationStanding({ silent: true });
        const st = this.supportState();
        if (payload?.type === 'moderation_standing' && st.detailId && this._hubTab === 'violation') {
            void this.loadViolationDetail(st.detailId);
        }
    }

    async loadModerationStanding({ silent = false } = {}) {
        if (!this.S.session?.token) return;
        const st = this.supportState();
        if (st.loading) return st.loading;
        st.loading = (async () => {
            try {
                const res = await this.apiFetch('/api/moderation/standing', { interactive: !silent });
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                st.standing = await res.json();
                st.error = '';
            } catch (e) {
                // Старый сервер без модерации или нет связи: тихо, раздел просто пуст.
                if (!st.standing) st.error = 'Не удалось загрузить состояние аккаунта';
            } finally {
                st.loading = null;
            }
            this.renderHubSupport();
            this.renderComposerModerationNote();
        })();
        return st.loading;
    }

    // ---- Форматирование ----

    supportFormatDate(iso, { year = false, time = false } = {}) {
        const date = new Date(iso || '');
        if (Number.isNaN(date.getTime())) return '';
        const sameYear = date.getFullYear() === new Date().getFullYear();
        const options = { day: 'numeric', month: 'long' };
        if (year || !sameYear) options.year = 'numeric';
        if (time) {
            options.hour = '2-digit';
            options.minute = '2-digit';
        }
        try {
            return new Intl.DateTimeFormat('ru-RU', options).format(date).replace(' г.', '');
        } catch (e) {
            return date.toLocaleDateString();
        }
    }

    supportDaysLeft(iso) {
        const end = Date.parse(iso || '');
        if (!Number.isFinite(end)) return null;
        return Math.max(0, Math.ceil((end - Date.now()) / 86400000));
    }

    supportDaysWord(n) {
        return this.ruPlural(n, 'день', 'дня', 'дней');
    }

    supportTile(sign, size, extraClass = '') {
        const cls = ['sup-tile', `sup-tile--${size}`, extraClass].filter(Boolean).join(' ');
        return `<span class="${this.esc(cls)}" aria-hidden="true">${this.zaliSign(sign)}</span>`;
    }

    supportChevron() {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M9 5l7 7-7 7"/></svg>';
    }

    /** Значение справа на карточке: сколько ещё действует или чем закончилось. */
    supportCardValue(v) {
        if (v.revoked) return { value: 'Снято', meta: this.supportFormatDate(v.createdAt) };
        if (!v.expiresAt) return { value: 'Бессрочно', meta: 'п. 6.2 Правил' };
        if (!v.active) return { value: 'Истекло', meta: this.supportFormatDate(v.expiresAt) };
        const days = this.supportDaysLeft(v.expiresAt);
        return {
            value: days > 0 ? `${days} ${this.supportDaysWord(days)}` : 'Сегодня',
            meta: `до ${this.supportFormatDate(v.expiresAt)}`,
        };
    }

    // ---- «Поддержка» ----

    supportStatusHTML(s) {
        const level = String(s?.level || 'ok');
        const counted = Math.min(3, Number(s?.counted || 0));
        const filled = level === 'suspended' ? 4 : (level === 'restricted' ? 3 : (level === 'warnings' ? counted : 0));
        const until = s?.until ? this.supportFormatDate(s.until, { time: true }) : '';
        let note;
        if (level === 'ok') {
            note = 'Действующих нарушений нет. Предупреждения на состояние не влияют.';
        } else if (level === 'warnings') {
            const left = 3 - counted;
            note = `Ещё ${left} ${this.ruPlural(left, 'нарушение', 'нарушения', 'нарушений')} — и отправка сообщений будет ограничена. Нарушение сгорает через 2 месяца.`;
        } else if (level === 'restricted') {
            note = `До ${until} нельзя писать, ставить реакции, добавлять людей и менять профиль. Читать и звонить можно.`;
        } else {
            note = `${until ? `До ${until}` : 'Бессрочно'} можно только читать переписки и удалять своё.${s?.reviewPending ? ' Решение ещё проверит администрация.' : ''}`;
        }
        // На узком экране первые две ячейки подписаны цифрами (полные подписи не влезают).
        const labels = [['1 нарушение', '1'], ['2 нарушения', '2'], ['Ограничения', 'Ограничения'], ['Приостановка', 'Приостановка']];
        const cells = labels.map(([full, short], i) => `
            <span class="sup-meter-cell${i < filled ? ' is-on' : ''}${i === 3 ? ' is-last' : ''}">
                <i></i><span><span class="sup-meter-full">${this.esc(full)}</span><span class="sup-meter-short">${this.esc(short)}</span></span>
            </span>`).join('');
        return `
            <section class="sup-hero" data-level="${this.esc(level)}" aria-labelledby="supStatusTitle">
                <div class="sup-hero-copy">
                    <span class="sup-hero-label">Состояние аккаунта</span>
                    <h3 class="sup-hero-title" id="supStatusTitle">${this.esc(s?.title || 'С аккаунтом все отлично!')}</h3>
                    <p class="sup-hero-meta">${this.esc(note)}</p>
                    <div class="sup-meter" role="meter" aria-label="Нарушения на шкале" aria-valuemin="0" aria-valuemax="4" aria-valuenow="${this.esc(String(filled))}">${cells}</div>
                </div>
                <span class="sup-hero-art" aria-hidden="true"></span>
            </section>`;
    }

    supportCardHTML(v) {
        const tier = String(v.tier || 'violation');
        const sign = ZaliInterface.SUPPORT_TIER_SIGN[tier] || 'tier-violation';
        const { value, meta } = this.supportCardValue(v);
        return `
            <button class="sup-card" type="button" data-violation-open="${this.esc(v.id)}" data-tier="${this.esc(tier)}"${v.active ? '' : ' data-inactive'}>
                ${this.supportTile(sign, 'card')}
                <span class="sup-card-text">
                    <strong>${this.esc(v.tierTitle || 'Нарушение')}</strong>
                    <span>${this.esc(v.rule ? `${v.rule} · ${v.title}` : v.title)}</span>
                </span>
                <span class="sup-card-value">
                    <strong>${this.esc(value)}</strong>
                    <span>${this.esc(meta)}</span>
                </span>
                <span class="hub-action-go" aria-hidden="true">${this.supportChevron()}</span>
            </button>`;
    }

    supportReportsHTML(reports) {
        let lastDay = '';
        return reports.map((r) => {
            const day = this.fmtDate(r.createdAt);
            const dayLabel = day && day !== lastDay ? `<span class="sup-day">${this.esc(day)}</span>` : '';
            lastDay = day || lastDay;
            return `${dayLabel}
                <div class="sup-row">
                    ${this.supportTile('flag', 'row')}
                    <span class="sup-row-text">
                        <strong>На ${this.esc(r.accused)}</strong>
                        <span>${this.esc(r.rule || this.fmtTime(r.createdAt))}</span>
                    </span>
                    <span class="sup-chip" data-status="${this.esc(r.status)}">${this.esc(r.statusLabel)}</span>
                </div>`;
        }).join('');
    }

    /** «За что какая мера» — пункты Правил, сгруппированные по исходу. */
    supportPolicyHTML(policy) {
        const groups = [
            {
                tier: 'serious',
                title: 'Сразу серьёзное нарушение',
                note: 'Приостановка на 3 месяца, за п. 3.1.1 — бессрочно',
                items: policy.filter(p => p.base === 'serious'),
            },
            {
                tier: 'violation',
                title: 'Нарушение, грубое — серьёзное',
                note: '2 месяца на шкале; грубый случай сразу приостанавливает',
                items: policy.filter(p => p.base === 'violation' && !p.lenientFirst && p.gross === 'serious'),
            },
            {
                tier: 'warning',
                title: 'Впервые — предупреждение',
                note: 'При чистой истории; повтор или грубый случай — нарушение',
                items: policy.filter(p => p.lenientFirst),
            },
        ].filter(g => g.items.length);
        return groups.map(g => `
            <div class="sup-policy-block" data-tier="${this.esc(g.tier)}">
                <div class="sup-policy-head">
                    ${this.supportTile(ZaliInterface.SUPPORT_TIER_SIGN[g.tier], 'row')}
                    <span class="sup-policy-head-text">
                        <strong>${this.esc(g.title)}</strong>
                        <span>${this.esc(g.note)}</span>
                    </span>
                </div>
                <ul class="sup-policy-list">${g.items.map(p => `
                    <li><b>${this.esc(p.rule)}</b><span>${this.esc(p.title)}</span></li>`).join('')}
                </ul>
            </div>`).join('') + `
            <div class="sup-policy-block" data-tier="ok">
                <div class="sup-policy-head">
                    ${this.supportTile('shield-check', 'row')}
                    <span class="sup-policy-head-text">
                        <strong>Не нарушение — мер нет</strong>
                        <span>Оскорбления, ругань, ссоры, троллинг, шутки и шутливые «угрозы», надоедливые сообщения, 18+ между взрослыми (п. 1.4 Правил)</span>
                    </span>
                </div>
            </div>`;
    }

    renderHubSupport() {
        const body = document.getElementById('hubSupportBody');
        if (!body) return;
        this.bindSupportHubEvents();
        const st = this.supportState();
        const s = st.standing;
        if (!s) {
            // Пока данные в пути — тишина (§2 п. 3), ошибка — одной фразой.
            this.setHTMLIfChanged(body, st.error ? `<p class="sup-empty">${this.esc(st.error)}</p>` : '');
            return;
        }
        const violations = Array.isArray(s.violations) ? s.violations : [];
        const active = violations.filter(v => v.active);
        const ordered = active.concat(violations.filter(v => !v.active));
        const reports = Array.isArray(s.reports) ? s.reports : [];
        const tiers = Array.isArray(s.tiers) ? s.tiers : [];
        const policy = Array.isArray(s.policy) ? s.policy : [];
        const touch = this.isMobileLayout?.() || window.matchMedia?.('(hover: none)').matches;
        const quota = s.reportQuota || {};
        const hourLeft = Number(quota.hourLeft ?? 3);
        let quotaNote;
        if (quota.cooldownUntil) {
            quotaNote = `Подача жалоб приостановлена до ${this.supportFormatDate(quota.cooldownUntil, { time: true })}: несколько жалоб подряд оказались необоснованными.`;
        } else if (hourLeft <= 0) {
            quotaNote = 'Лимит жалоб на этот час исчерпан — следующую можно будет отправить позже.';
        } else {
            quotaNote = `В этот час можно отправить ещё ${hourLeft} ${this.ruPlural(hourLeft, 'жалобу', 'жалобы', 'жалоб')}.`;
        }
        const tierShort = {
            warning: 'не влияет на состояние',
            violation: 'три действующих — ограничения',
            serious: 'аккаунт приостановлен',
        };
        const tierFacts = tiers.map((t) => {
            const months = Math.round(Number(t.ttlDays || 0) / 30);
            return `
                <li class="sup-fact" data-tier="${this.esc(t.key)}">
                    ${this.supportTile(ZaliInterface.SUPPORT_TIER_SIGN[t.key] || 'tier-violation', 'fact')}
                    <span class="sup-fact-copy">
                        <strong>${this.esc(t.title)}</strong>
                        <span>${this.esc(`${months} ${this.ruPlural(months, 'месяц', 'месяца', 'месяцев')} · ${tierShort[t.key] || t.effect}`)}</span>
                    </span>
                </li>`;
        }).join('');

        this.setHTMLIfChanged(body, `
            ${this.supportStatusHTML(s)}
            <section class="sup-section" aria-labelledby="supViolationsTitle">
                <div class="sup-section-head">
                    <h3 id="supViolationsTitle">Нарушения</h3>
                    ${active.length ? `<span class="sm-count hub-count">${active.length}</span>` : ''}
                </div>
                ${ordered.length
                    ? `<div class="sup-cards">${ordered.map(v => this.supportCardHTML(v)).join('')}</div>`
                    : '<p class="sup-empty">Нарушений нет.</p>'}
            </section>
            <section class="sup-section" aria-labelledby="supReportsTitle">
                <div class="sup-section-head">
                    <h3 id="supReportsTitle">Мои жалобы</h3>
                    ${reports.length ? `<span class="sm-count hub-count">${reports.length}</span>` : ''}
                </div>
                ${reports.length
                    ? `<div class="sup-rows">${this.supportReportsHTML(reports)}</div>`
                    : `<p class="sup-empty">Жалоб пока не было. ${touch ? 'Удерживайте' : 'Нажмите правой кнопкой на'} чужое сообщение и выберите «Пожаловаться».</p>`}
                <p class="sup-note">${this.esc(quotaNote)}</p>
            </section>
            <section class="sup-section" aria-labelledby="supTiersTitle">
                <div class="sup-section-head"><h3 id="supTiersTitle">Как устроены меры</h3></div>
                <ul class="sup-facts">${tierFacts}</ul>
                <details class="sup-policy">
                    <summary><span>За что какая мера</span><span class="sm-count hub-count">${policy.length}</span><span class="sup-policy-chevron" aria-hidden="true">${this.supportChevron()}</span></summary>
                    <div class="sup-policy-body">
                        ${this.supportPolicyHTML(policy)}
                        <p class="sup-note">Решение принимает нейросеть по жалобе. Спорные случаи и все приостановки проверяет администрация; с любым решением можно не согласиться на странице нарушения.</p>
                    </div>
                </details>
            </section>`);
    }

    // ---- Страница нарушения ----

    openViolation(id) {
        const st = this.supportState();
        if (st.detailId !== id) {
            st.detail = null;
            st.detailError = '';
            st.appealOpen = false;
            st.appealError = '';
            st.appealDraft = '';
        }
        st.detailId = id;
        this.setHubTab('violation');
        void this.loadViolationDetail(id);
    }

    async loadViolationDetail(id) {
        const st = this.supportState();
        try {
            const res = await this.apiFetch(`/api/moderation/violations/${encodeURIComponent(id)}`, { interactive: true });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const detail = await res.json();
            if (st.detailId !== id) return;
            st.detail = detail;
            st.detailError = '';
        } catch (e) {
            if (st.detailId !== id) return;
            st.detailError = 'Не удалось открыть нарушение';
        }
        this.renderHubViolation();
    }

    supportPlaceValueHTML(place) {
        if (place?.kind === 'dm') {
            return `<span class="sup-place"><span class="sup-place-ava">${this.renderAvatarHTML(place.peer, 'sup-place-img')}</span><span>${this.esc(place.peer || '')}</span></span>`;
        }
        if (place?.kind === 'channel') {
            const server = (this.S.servers || []).find(sv => String(sv.id) === String(place.serverId));
            const avatar = server
                ? this.renderServerAvatarHTML(server, 'sup-place-server')
                : `<span class="sup-place-hash">${this.uiIcon('hash')}</span>`;
            return `<span class="sup-place">${avatar}<span>#${this.esc(place.channelName || 'канал')}</span></span>`;
        }
        return '<span class="sup-place"><span>Переписка</span></span>';
    }

    /** Фрагмент переписки: как лента чата, отмеченные сообщения — на рельсе зоны. */
    static get APPEAL_MIN_CHARS() { return 10; }

    supportAppealHint(draft) {
        const n = String(draft || '').trim().length;
        const min = ZaliInterface.APPEAL_MIN_CHARS;
        if (n < min) {
            const left = min - n;
            return `Ещё ${left} ${this.ruPlural(left, 'символ', 'символа', 'символов')}`;
        }
        return `${String(draft).length} из 1000 · ${/Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl'}+Enter — отправить`;
    }

    supportFragmentHTML(detail) {
        const me = String(this.myName?.() || '').trim();
        const fragment = Array.isArray(detail.fragment) ? detail.fragment : [];
        const isChannel = detail.place?.kind === 'channel';
        const zoneOf = (m) => (m?.zone === 'red' || m?.zone === 'orange' ? m.zone : '');
        let prevZone = null;
        let prevSender = null;
        const rows = fragment.map((m, i) => {
            const sender = String(m.sender || '');
            const mine = sender === me;
            const zone = zoneOf(m);
            const startsZone = zone && zone !== prevZone;
            const endsZone = zone && zoneOf(fragment[i + 1]) !== zone;
            const edge = startsZone && endsZone ? 'both' : (startsZone ? 'start' : (endsZone ? 'end' : ''));
            const grouped = sender === prevSender && zone === prevZone;
            prevZone = zone;
            prevSender = sender;
            const attachments = Array.isArray(m.attachments) ? m.attachments : [];
            const attach = attachments.length
                ? `<span class="sup-msg-attach">${this.uiIcon('paperclip')}${this.esc(attachments.map(a => a.name || 'Вложение').join(', '))}</span>`
                : '';
            return `
                <div class="sup-msg${mine ? ' is-mine' : ''}${grouped ? ' is-grouped' : ''}" data-zone="${this.esc(zone)}" data-zone-edge="${this.esc(edge)}">
                    ${startsZone ? `<span class="sup-msg-zone">${zone === 'red' ? 'Нарушение' : 'Важный контекст'}</span>` : ''}
                    <div class="sup-msg-line">
                        ${mine ? '' : `<span class="sup-msg-ava">${grouped ? '' : this.renderAvatarHTML(sender, 'sup-msg-img')}</span>`}
                        <div class="sup-msg-bubble">
                            ${!mine && !grouped && isChannel ? `<span class="sup-msg-name">${this.esc(sender)}</span>` : ''}
                            ${m.text ? `<span class="sup-msg-text">${this.esc(m.text)}</span>` : ''}
                            ${attach}
                            <time class="sup-msg-time">${this.esc(this.fmtTime(m.ts))}</time>
                        </div>
                    </div>
                </div>`;
        }).join('');
        const place = detail.place || {};
        const title = place.kind === 'dm' ? String(place.peer || '') : `#${place.channelName || 'канал'}`;
        const sub = place.kind === 'dm' ? 'Личная переписка' : String(place.serverName || 'Сервер');
        const headAvatar = place.kind === 'dm'
            ? `<span class="sup-preview-ava">${this.renderAvatarHTML(place.peer, 'sup-preview-img')}</span>`
            : `<span class="sup-preview-ava is-channel">${this.uiIcon('hash')}</span>`;
        return `
            <section class="sup-preview" aria-label="Место нарушения">
                <header class="sup-preview-head">
                    ${headAvatar}
                    <span class="sup-preview-title"><strong>${this.esc(title)}</strong><span>${this.esc(sub)}</span></span>
                    <span class="sup-preview-date">${this.esc(this.fmtDate(fragment[0]?.ts))}</span>
                </header>
                <div class="sup-preview-body">${rows || '<p class="sup-preview-empty">Фрагмент не сохранился.</p>'}</div>
                <p class="sup-preview-foot">Так переписка выглядела, когда рассматривали жалобу</p>
            </section>`;
    }

    /** Крупная плитка срока — главное число страницы: сколько ещё провисит. */
    supportTermHTML(d) {
        const total = Number(d.ttlDays || 0);
        let label;
        let value;
        let unit = '';
        let meta;
        let share = 0;
        if (d.revoked) {
            label = 'Мера снята';
            value = 'Не действует';
            meta = d.revokedReason ? `Причина: ${d.revokedReason}` : 'На аккаунт больше не влияет';
        } else if (!d.expiresAt) {
            label = 'Срок';
            value = 'Бессрочно';
            meta = 'По п. 6.2 Правил срока у этой меры нет';
            share = 1;
        } else if (!d.active) {
            label = 'Истекло';
            value = this.supportFormatDate(d.expiresAt, { year: true });
            meta = 'На аккаунт больше не влияет';
            share = 1;
        } else {
            const days = this.supportDaysLeft(d.expiresAt);
            label = 'Действует ещё';
            value = String(Math.max(days, 0));
            unit = this.supportDaysWord(days);
            meta = `до ${this.supportFormatDate(d.expiresAt, { year: true })} · срок ${total} ${this.supportDaysWord(total)}`;
            share = total ? Math.min(1, Math.max(0, 1 - days / total)) : 0;
        }
        const numeric = /^\d+$/.test(value);
        return `
            <div class="sup-term">
                <div class="sup-term-copy">
                    <span class="sup-hero-label">${this.esc(label)}</span>
                    <span class="sup-term-value${numeric ? ' is-number' : ''}"><span>${this.esc(value)}</span>${unit ? `<em>${this.esc(unit)}</em>` : ''}</span>
                    <span class="sup-hero-meta">${this.esc(meta)}</span>
                </div>
                ${d.revoked ? '' : `<span class="sup-term-bar" aria-hidden="true"><i style="width:${this.esc(String(Math.round(share * 100)))}%"></i></span>`}
            </div>`;
    }

    supportAppealHTML(d) {
        const st = this.supportState();
        if (d.revoked) return '';
        let body;
        if (d.appealStatus === 'pending') {
            body = `
                <p class="sup-group-text">Возражение отправлено. Его рассмотрит администрация — решение появится здесь.</p>
                ${d.appealText ? `<blockquote class="sup-quote">${this.esc(d.appealText)}</blockquote>` : ''}`;
        } else if (d.appealStatus === 'declined') {
            body = '<p class="sup-group-text">Возражение рассмотрено: мера оставлена.</p>';
        } else if (!d.active) {
            return '';
        } else if (!st.appealOpen) {
            body = `
                <div class="sup-appeal-row">
                    <p class="sup-group-text">Если решение ошибочно, опишите почему — возражение рассмотрит администрация.</p>
                    <button class="btn-flat" type="button" data-appeal-open>Оспорить</button>
                </div>`;
        } else {
            // Черновик живёт в состоянии: перерисовка (ошибка, «Отправляем…», свежие
            // данные с сервера) не стирает набранное. Главная кнопка выключена, пока
            // текст короче минимума сервера, — с подсказкой, сколько осталось.
            const draft = String(st.appealDraft || '');
            const ready = draft.trim().length >= ZaliInterface.APPEAL_MIN_CHARS;
            body = `
                <label class="sup-field">
                    <span>Почему мера ошибочна</span>
                    <textarea data-appeal-text maxlength="1000" rows="4" placeholder="Например: это цитата, а не угроза; собеседник сам предложил шутку…"${st.appealSending ? ' readonly' : ''}>${this.esc(draft)}</textarea>
                </label>
                ${st.appealError ? `<p class="sup-group-text is-error" role="alert">${this.esc(st.appealError)}</p>` : ''}
                <div class="sup-appeal-actions">
                    <span class="sup-appeal-hint" data-appeal-hint>${this.esc(this.supportAppealHint(draft))}</span>
                    <button class="btn-flat" type="button" data-appeal-cancel>Отмена</button>
                    <button class="auth-btn primary" type="button" data-appeal-send${st.appealSending || !ready ? ' disabled' : ''}>${st.appealSending ? 'Отправляем…' : 'Отправить возражение'}</button>
                </div>`;
        }
        return `
            <div class="sup-appeal" role="group" aria-labelledby="supAppealTitle">
                <h4 class="sup-appeal-title" id="supAppealTitle">Не согласны с решением?</h4>
                ${body}
            </div>`;
    }

    renderHubViolation() {
        const body = document.getElementById('hubViolationBody');
        if (!body) return;
        this.bindSupportHubEvents();
        const st = this.supportState();
        const d = st.detail;
        if (!d) {
            this.setHTMLIfChanged(body, st.detailError ? `<p class="sup-empty">${this.esc(st.detailError)}</p>` : '');
            return;
        }
        const tier = String(d.tier || 'violation');
        const sign = ZaliInterface.SUPPORT_TIER_SIGN[tier] || 'tier-violation';
        let state = 'active';
        let stateLabel = 'Действует';
        if (d.revoked) { state = 'off'; stateLabel = 'Снято'; }
        else if (!d.active) { state = 'off'; stateLabel = 'Истекло'; }
        else if (d.reviewPending) { state = 'review'; stateLabel = 'Ждёт проверки'; }
        const counted = Math.min(3, Number(st.standing?.counted || 0));
        // Итоги — короткие значения (18/700 в плитке шириной ~160 px): пояснение — в метке.
        let impactLabel = 'Влияние';
        let impact;
        if (!d.active || tier === 'warning') impact = 'Не влияет';
        else if (tier === 'violation') { impactLabel = 'На шкале'; impact = `${counted} из 3`; }
        else impact = 'Приостановка';
        const decided = d.source === 'operator' ? 'Администрация' : 'Нейросеть Jev по жалобе';
        const decidedSub = d.source === 'operator'
            ? 'Решение принято вручную'
            : (d.reviewPending ? 'Ждёт проверки администрацией' : 'Автоматическое решение');
        const decidedSign = d.source === 'operator' ? 'person' : (d.reviewPending ? 'hourglass' : 'shield-check');
        // Окно-страница (§4): шапка с знаком тяжести на всю ширину; слева — сводка
        // (срок + факты одной плиткой) и группа «Решение» с возражением; справа —
        // фрагмент переписки, липкий.
        this.setHTMLIfChanged(body, `
            <div class="sup-detail" data-tier="${this.esc(tier)}">
                <header class="sup-detail-head">
                    ${this.supportTile(sign, 'head')}
                    <div class="sup-detail-title">
                        <h2>${this.esc(d.gross ? `${d.tierTitle} · грубое` : d.tierTitle)}</h2>
                        <p>${d.rule ? `<b>п. ${this.esc(d.rule)}</b> · ` : ''}${this.esc(d.title)}</p>
                    </div>
                    <span class="sup-state" data-state="${this.esc(state)}">${this.esc(stateLabel)}</span>
                </header>
                <div class="sup-detail-main">
                    <section class="sup-summary" aria-label="Срок и обстоятельства">
                        ${this.supportTermHTML(d)}
                        <div class="sup-stats">
                            <div class="sup-stat">
                                <span>${d.place?.kind === 'channel' ? this.esc(d.place.serverName || 'Сервер') : 'Личная переписка'}</span>
                                <strong>${this.supportPlaceValueHTML(d.place)}</strong>
                            </div>
                            <div class="sup-stat" title="${this.esc(this.supportFormatDate(d.createdAt, { year: true, time: true }))}">
                                <span>Получено в ${this.esc(this.fmtTime(d.createdAt))}</span>
                                <strong>${this.esc(this.supportFormatDate(d.createdAt))}</strong>
                            </div>
                            <div class="sup-stat">
                                <span>${this.esc(impactLabel)}</span>
                                <strong>${this.esc(impact)}</strong>
                            </div>
                        </div>
                    </section>
                    <section class="sup-group" aria-labelledby="supDecisionTitle">
                        <h3 class="sup-group-title" id="supDecisionTitle">Решение</h3>
                        <div class="sup-line">
                            ${this.supportTile(decidedSign, 'row')}
                            <span class="sup-line-text">
                                <strong>${this.esc(decided)}</strong>
                                <span>${this.esc(decidedSub)}</span>
                            </span>
                        </div>
                        <p class="sup-group-text">${this.esc(d.effect)}.</p>
                        ${this.supportAppealHTML(d)}
                    </section>
                </div>
                <aside class="sup-detail-aside">${this.supportFragmentHTML(d)}</aside>
            </div>`);
    }

    async submitAppeal() {
        const st = this.supportState();
        const field = document.querySelector('#hubViolationBody [data-appeal-text]');
        if (field) st.appealDraft = field.value;
        const text = String(st.appealDraft || '').trim();
        if (st.appealSending) return;
        if (text.length < ZaliInterface.APPEAL_MIN_CHARS) {
            st.appealError = 'Опишите, почему мера ошибочна, — хотя бы пару слов.';
            this.renderHubViolation();
            return;
        }
        st.appealSending = true;
        st.appealError = '';
        this.renderHubViolation();
        const id = st.detailId;
        try {
            const res = await this.apiFetch(`/api/moderation/violations/${encodeURIComponent(id)}/appeal`, {
                method: 'POST',
                body: JSON.stringify({ text }),
                interactive: true,
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
            st.appealOpen = false;
            st.appealDraft = '';
            if (st.detail && st.detailId === id) st.detail = { ...st.detail, appealStatus: 'pending', appealText: text };
        } catch (e) {
            st.appealError = String(e?.message || 'Не удалось отправить возражение');
        } finally {
            st.appealSending = false;
        }
        this.renderHubViolation();
    }

    bindSupportHubEvents() {
        if (this._supportEventsBound) return;
        const supportBody = document.getElementById('hubSupportBody');
        const violationBody = document.getElementById('hubViolationBody');
        if (!supportBody || !violationBody) return;
        this._supportEventsBound = true;
        supportBody.addEventListener('click', (e) => {
            const card = e.target.closest('[data-violation-open]');
            if (card) {
                this.openViolation(card.getAttribute('data-violation-open'));
                return;
            }
        });
        violationBody.addEventListener('click', (e) => {
            const st = this.supportState();
            if (e.target.closest('[data-appeal-open]')) {
                st.appealOpen = true;
                st.appealError = '';
                this.renderHubViolation();
                if (!this.isMobileLayout?.()) violationBody.querySelector('[data-appeal-text]')?.focus();
                return;
            }
            if (e.target.closest('[data-appeal-cancel]')) {
                st.appealOpen = false;
                st.appealError = '';
                st.appealDraft = '';
                this.renderHubViolation();
                return;
            }
            if (e.target.closest('[data-appeal-send]')) void this.submitAppeal();
        });
        violationBody.addEventListener('input', (e) => {
            if (!e.target.matches?.('[data-appeal-text]')) return;
            const st = this.supportState();
            st.appealDraft = e.target.value;
            // Без перерисовки: курсор и выделение в поле остаются на месте.
            const send = violationBody.querySelector('[data-appeal-send]');
            if (send && !st.appealSending) send.disabled = st.appealDraft.trim().length < ZaliInterface.APPEAL_MIN_CHARS;
            const hint = violationBody.querySelector('[data-appeal-hint]');
            const text = this.supportAppealHint(st.appealDraft);
            if (hint && hint.textContent !== text) hint.textContent = text;
        });
        violationBody.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' || !(e.metaKey || e.ctrlKey) || !e.target.matches?.('[data-appeal-text]')) return;
            e.preventDefault();
            void this.submitAppeal();
        });
    }

    // ---- Над полем ввода: «отправка ограничена» ----

    // Сообщение стоит ВМЕСТО содержимого облака поля ввода (скрепка, поле, отправка),
    // а соседние полосы композера (ответ, правка, вложения, «в игре») скрыты: писать
    // всё равно нельзя, и второе облако над полем только дублировало бы запрет.
    renderComposerModerationNote() {
        const area = document.querySelector('#viewChat .input-area');
        const bar = area?.querySelector('#inputBar');
        if (!area || !bar) return;
        const s = this.supportState().standing;
        const level = s?.level;
        let note = bar.querySelector('.composer-mod-note');
        const show = level === 'restricted' || level === 'suspended';
        area.classList.toggle('is-mod-blocked', show);
        if (!show) {
            if (note) note.hidden = true;
            return;
        }
        if (!note) {
            note = document.createElement('div');
            note.className = 'composer-mod-note';
            note.setAttribute('role', 'status');
            note.addEventListener('click', (e) => {
                if (e.target.closest('[data-mod-note-open]')) this.openSupportHub();
            });
            bar.insertBefore(note, bar.firstChild);
        }
        const until = s.until ? this.supportFormatDate(s.until, { time: true }) : '';
        const title = level === 'suspended' ? 'Аккаунт приостановлен' : 'Отправка сообщений ограничена';
        const sub = until ? `до ${until}` : 'бессрочно';
        this.setHTMLIfChanged(note, `
            ${this.supportTile(level === 'suspended' ? 'lock' : 'hourglass', 'row', level === 'suspended' ? 'is-red' : 'is-orange')}
            <span class="composer-mod-text"><strong>${this.esc(title)}</strong><span>${this.esc(sub)}</span></span>
            <button class="composer-mod-btn" type="button" data-mod-note-open>Подробнее</button>`);
        note.hidden = false;
    }
});
