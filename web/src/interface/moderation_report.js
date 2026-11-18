// --- ZaliInterface: жалоба на сообщение — выбор зон прямо в ленте чата. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// ПКМ по чужому сообщению → «Пожаловаться» (ensureReactionMenu) включает режим
// жалобы в самом чате, без окна. Два режима выбора — сегменты в панели жалобы:
//   • «Нарушение» — одна непрерывная зона, всегда содержит сообщение, по которому
//     нажали (его автор — обвиняемый: так проверяет и сервер). Нажатие на
//     сообщение дотягивает зону до него;
//   • «Важный контекст» — до 5 отрезков где угодно: до нарушения, после, вперемешку.
//     Нажатие на сообщение добавляет его в контекст, повторное — убирает отрезок.
// Каждую зону обрамляет тонкая скобка слева от ленты: вертикальная линия и
// палочки на концах — их тянут мышью, пальцем и стрелками клавиатуры. У зон
// встык одна общая ручка: за середину тянется стык, за верхний/нижний край —
// разлепляет (двигается край только своей зоны; клавиатурой — Shift+стрелка). Полоса
// зоны лежит ПОД сообщениями (слой .rp-under под #msgs, лента прозрачная), а то,
// что не уйдёт на проверку, приглушено. Вместо поля ввода — панель жалобы.
// На сервер уходят зоны и по 20 сообщений вокруг каждого отрезка (объединение) —
// server/src/moderation.rs, POST /api/moderation/reports. Тексты личной переписки
// сервер прочитать не может, поэтому клиент шлёт их расшифрованными.
//
// Лента перерисовывается сама (новые сообщения, окно виртуализации), поэтому
// границы зон хранятся id сообщений, а разметка режима (классы строк, слои)
// пересобирается из них после каждой перерисовки (MutationObserver на #msgs).
ZaliMixin(ZaliInterface, class {

    static get REPORT_CONTEXT_EACH_SIDE() { return 20; }
    /** Не больше сообщений в зоне нарушения и во всём контексте вместе. */
    static get REPORT_MAX_ZONE() { return 30; }
    static get REPORT_MAX_CONTEXT_ZONES() { return 5; }
    /** Ширина колонки скобок слева от ленты. */

    /** Пункт «Пожаловаться» — только у чужого сообщения, уже записанного сервером. */
    canReportMessage(msg) {
        if (!msg || !String(msg.id || '').trim()) return false;
        const me = String(this.myName?.() || '').trim();
        return !!me && String(msg.sender || '').trim() !== me;
    }

    reportConversationKey() {
        return this.S.navMode === 'servers'
            ? `srv:${this.currentServerChatKey?.() || ''}`
            : `dm:${this.S.current || ''}`;
    }

    /** Лента текущей переписки: только записанные сервером, по времени. */
    reportCurrentList() {
        return (this.getCurrentMessages() || [])
            .filter(m => String(m?.id || '').trim())
            .slice()
            .sort((a, b) => this.compareMessagesByTime(a, b));
    }

    static get REPORT_GUTTER() { return 52; }

    // Меню сообщения зовёт по старому имени — режим в ленте его заменил.
    openReportDialog(messageId) {
        this.startReportMode(messageId);
    }

    closeReportDialog() {
        this.closeReportMode();
    }

    isReporting() {
        return !!this._report;
    }

    /** Разовое движение на виде чата: класс на время анимации, потом снимается. */
    reportFlash(view, cls, ms = 260) {
        if (!view) return;
        view.classList.remove(cls);
        // Перезапуск анимации, если класс ещё висит с прошлого раза.
        void view.offsetWidth;
        view.classList.add(cls);
        clearTimeout(view[`_${cls}`]);
        view[`_${cls}`] = setTimeout(() => view.classList.remove(cls), ms);
    }

    /**
     * Дискретная правка зон (нажатие, клавиши, переключатель) — полосы и ручки
     * доезжают до нового места. Во время перетаскивания и прокрутки позиции идут
     * за пальцем без задержки, поэтому переход включается только на этот миг.
     */
    reportAnimate() {
        const st = this._report;
        if (!st || st.drag) return;
        this.reportFlash(st.view, 'is-report-anim', 240);
    }

    startReportMode(messageId) {
        const id = String(messageId || '').trim();
        const list = this.reportCurrentList();
        const anchor = list.find(m => String(m.id).trim() === id);
        if (!anchor || !this.canReportMessage(anchor)) return;
        const view = document.getElementById('viewChat');
        const msgs = document.getElementById('msgs');
        const area = view?.querySelector('.input-area');
        if (!view || !msgs || !area) return;
        this.closeReportMode();
        this.hideReactionMenu?.();

        const st = {
            key: this.reportConversationKey(),
            anchorId: id,
            accused: String(anchor.sender || '').trim(),
            // Границы — id сообщений: лента перерисовывается, индексы плывут.
            red: [id, id],
            orange: [],
            active: 'red',
            list,
            index: new Map(),
            sending: false,
            error: '',
            done: null,
            drag: null,
            view,
            msgs,
            area,
            cleanup: [],
        };
        this._report = st;
        this.reportReindex(st);

        // Колонка под скобки и место под панель — инлайном, чтобы точно вернуть как было.
        st.saved = {
            paddingLeft: msgs.style.paddingLeft,
            paddingBottom: msgs.style.paddingBottom,
            noSwipe: msgs.hasAttribute('data-no-swipe'),
        };
        st.basePad = parseFloat(getComputedStyle(msgs).paddingLeft) || 0;
        // Колонка слева под рельс с ручками: лента сдвигается, пузыри не перекрыты.
        msgs.style.paddingLeft = `${st.basePad + ZaliInterface.REPORT_GUTTER}px`;
        if (!st.saved.noSwipe) msgs.setAttribute('data-no-swipe', '');
        view.classList.add('is-reporting');
        area.classList.add('is-reporting');
        // Вход: лента отъезжает под колонку рельса, зона раскрывается, панель встаёт
        // на место поля ввода.
        view.style.setProperty('--rp-gutter', `${ZaliInterface.REPORT_GUTTER}px`);
        this.reportFlash(view, 'is-report-enter', 420);

        st.under = document.createElement('div');
        st.under.className = 'rp-under';
        st.under.setAttribute('aria-hidden', 'true');
        st.over = document.createElement('div');
        st.over.className = 'rp-over';
        st.over.innerHTML = '<span class="rp-anchor" aria-hidden="true"></span><span class="rp-tag" aria-hidden="true" hidden></span>';
        view.appendChild(st.under);
        view.appendChild(st.over);

        st.bar = document.createElement('div');
        st.bar.className = 'report-bar';
        st.bar.setAttribute('role', 'region');
        st.bar.setAttribute('aria-label', `Жалоба на ${st.accused}`);
        area.appendChild(st.bar);
        this.renderReportBar();

        // Перерисовка ленты, прокрутка, изменение размеров — пересобрать разметку режима.
        const schedule = () => this.scheduleReportSync();
        const mo = new MutationObserver(schedule);
        mo.observe(msgs, { childList: true, subtree: true });
        const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null;
        ro?.observe(msgs);
        ro?.observe(st.bar);
        msgs.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule);
        const onMsgsClick = (e) => this.handleReportFeedClick(e);
        const onMsgsMenu = (e) => {
            // ПКМ в режиме жалобы — не меню сообщения, а то же, что нажатие.
            if (!e.target.closest?.('.msg[data-message-id]')) return;
            e.preventDefault();
            e.stopPropagation();
            this.handleReportFeedClick(e);
        };
        msgs.addEventListener('click', onMsgsClick, true);
        msgs.addEventListener('contextmenu', onMsgsMenu, true);
        const onKey = (e) => {
            if (e.key !== 'Escape' || !this._report) return;
            e.preventDefault();
            e.stopPropagation();
            this.closeReportMode({ animate: true });
        };
        document.addEventListener('keydown', onKey, true);
        st.over.addEventListener('pointerdown', (e) => this.reportStartDrag(e));
        // Наведение на край ручки стыка — та половинка отходит: её можно оторвать.
        st.over.addEventListener('pointermove', (e) => {
            if (st.drag || e.pointerType === 'touch') return;
            const joint = e.target.closest?.('.rp-joint');
            if (!joint) return;
            const part = this.reportJointPart(joint, e.clientY);
            if (part) joint.dataset.part = part;
            else delete joint.dataset.part;
        });
        st.over.addEventListener('pointerout', (e) => {
            const joint = e.target.closest?.('.rp-joint');
            if (joint && !st.drag && !joint.contains(e.relatedTarget)) delete joint.dataset.part;
        });
        st.over.addEventListener('keydown', (e) => this.handleReportGripKey(e));
        st.cleanup.push(() => {
            mo.disconnect();
            ro?.disconnect();
            msgs.removeEventListener('scroll', schedule);
            window.removeEventListener('resize', schedule);
            msgs.removeEventListener('click', onMsgsClick, true);
            msgs.removeEventListener('contextmenu', onMsgsMenu, true);
            document.removeEventListener('keydown', onKey, true);
        });

        this.syncReportMode();
        // Отмеченное сообщение — в видимую часть ленты, над панелью. Через два кадра
        // и ещё раз чуть позже: новый нижний отступ под панель сначала отрабатывает
        // якорь ленты (setupMessagesViewportAnchor держит низ).
        requestAnimationFrame(() => requestAnimationFrame(() => this.reportRevealAnchor()));
        setTimeout(() => this.reportRevealAnchor(), 180);
    }

    reportRevealAnchor() {
        const st = this._report;
        const row = st && this.reportRowEl(st.anchorId);
        if (!row) return;
        const mr = st.msgs.getBoundingClientRect();
        const rr = row.getBoundingClientRect();
        const overlay = getComputedStyle(st.area).position === 'absolute';
        const free = mr.height - (overlay ? st.bar.offsetHeight + 24 : 0);
        if (rr.top < mr.top + 8 || rr.bottom > mr.top + free) {
            st.msgs.scrollTop += rr.top - mr.top - Math.max(16, free / 2 - rr.height / 2);
        }
    }

    closeReportMode({ animate = false } = {}) {
        const st = this._report;
        if (!st) return;
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        if (animate && !reduce) {
            // Слои зон гаснут сами, лента возвращается на место, поле ввода — обратно.
            [st.under, st.over].forEach((layer) => {
                if (!layer) return;
                layer.classList.add('is-leaving');
                setTimeout(() => layer.remove(), 200);
            });
            st.under = null;
            st.over = null;
            this.reportFlash(st.view, 'is-report-leave', 300);
        }
        this.reportEndDrag();
        if (st.raf) cancelAnimationFrame(st.raf);
        st.cleanup.forEach(fn => { try { fn(); } catch (e) { /* уже снято */ } });
        st.msgs.querySelectorAll('.msg.rp-out, .msg.rp-in-zone').forEach((row) => {
            row.classList.remove('rp-out', 'rp-in-zone');
            row.removeAttribute('data-rp-zone');
        });
        st.msgs.style.paddingLeft = st.saved.paddingLeft;
        st.msgs.style.paddingBottom = st.saved.paddingBottom;
        if (!st.saved.noSwipe) st.msgs.removeAttribute('data-no-swipe');
        st.view.classList.remove('is-reporting', 'is-report-done', 'is-report-dragging');
        st.area.classList.remove('is-reporting');
        st.under?.remove();
        st.over?.remove();
        st.bar?.remove();
        this._report = null;
        if (!this.isMobileLayout?.()) document.getElementById('msgInput')?.focus({ preventScroll: true });
    }

    // ---- Модель зон ----

    reportReindex(st) {
        st.index = new Map(st.list.map((m, i) => [String(m.id).trim(), i]));
    }

    reportIdsToRange(st, ids) {
        const a = st.index.get(ids?.[0]);
        const b = st.index.get(ids?.[1]);
        if (a === undefined || b === undefined) return null;
        return [Math.min(a, b), Math.max(a, b)];
    }

    reportRangeToIds(st, range) {
        return [String(st.list[range[0]].id), String(st.list[range[1]].id)];
    }

    /** Зона нарушения; пропавшую границу (сообщение удалили) — к отмеченному. */
    reportRedRange(st) {
        const range = this.reportIdsToRange(st, st.red);
        if (range) return range;
        const anchor = st.index.get(st.anchorId);
        return anchor === undefined ? null : [anchor, anchor];
    }

    /** Отрезки контекста по порядку; пропавшие (удалённые сообщения) отбрасываются. */
    reportOrangeRanges(st) {
        return st.orange
            .map(ids => this.reportIdsToRange(st, ids))
            .filter(Boolean)
            .sort((a, b) => a[0] - b[0]);
    }

    /** Ключ зоны: `red` или `o<номер отрезка по порядку>`. */
    /**
     * Стык двух соседних зон: `boundary` — индекс первого сообщения нижней зоны.
     * Двигает границу у обеих сразу; каждая зона сохраняет хотя бы одно сообщение,
     * красная — отмеченное сообщение и лимит, контекст — общий лимит.
     */
    reportMoveJoint(upKey, downKey, boundary) {
        const st = this._report;
        if (!st) return;
        const zones = this.reportZones(st);
        const up = zones.find(z => z.key === upKey);
        const down = zones.find(z => z.key === downKey);
        if (!up || !down || up.range[1] + 1 !== down.range[0]) return;
        const old = down.range[0];
        const max = ZaliInterface.REPORT_MAX_ZONE;
        const anchor = st.index.get(st.anchorId);
        const orangeOthers = this.reportOrangeTotal(st)
            - [up, down].filter(z => z.kind === 'orange').reduce((n, z) => n + z.range[1] - z.range[0] + 1, 0);
        const valid = (b) => {
            const a = [up.range[0], b - 1];
            const c = [b, down.range[1]];
            if (a[1] < a[0] || c[1] < c[0]) return false;
            let orange = orangeOthers;
            for (const [zone, r] of [[up, a], [down, c]]) {
                const n = r[1] - r[0] + 1;
                if (zone.kind === 'red') {
                    if (anchor < r[0] || anchor > r[1] || n > max) return false;
                } else {
                    orange += n;
                }
            }
            return orange <= max;
        };
        let b = Math.max(up.range[0] + 1, Math.min(down.range[1], boundary));
        const step = b > old ? -1 : 1;
        while (b !== old && !valid(b)) b += step;
        if (b === old) return;
        this.reportAnimate();
        const ranges = this.reportOrangeRanges(st);
        const apply = (zone, r) => {
            if (zone.kind === 'red') st.red = this.reportRangeToIds(st, r);
            else ranges[Number(zone.key.slice(1))] = r;
        };
        apply(up, [up.range[0], b - 1]);
        apply(down, [b, down.range[1]]);
        // Сначала красная: контекст отфильтровывается по уже новой красной зоне.
        this.reportSetOrange(st, ranges);
        st.error = '';
        this.syncReportMode();
    }

    /** Пары зон, стоящих встык (без сообщения между ними). */
    reportJoints(st) {
        const zones = this.reportZones(st).slice().sort((a, b) => a.range[0] - b.range[0]);
        const joints = [];
        for (let k = 0; k + 1 < zones.length; k += 1) {
            if (zones[k].range[1] + 1 === zones[k + 1].range[0]) joints.push({ up: zones[k], down: zones[k + 1] });
        }
        return joints;
    }

    /** Граница под указателем: индекс сообщения, с которого начнётся нижняя зона. */
    reportBoundaryAtY(clientY) {
        const st = this._report;
        const rows = Array.from(st?.msgs?.querySelectorAll('.msg[data-message-id]') || []);
        let last = null;
        for (const row of rows) {
            const i = st.index.get(row.getAttribute('data-message-id'));
            if (i === undefined) continue;
            const r = row.getBoundingClientRect();
            if (clientY < r.top + r.height / 2) return i;
            last = i;
        }
        return last === null ? null : last + 1;
    }

    /**
     * Какую часть общей ручки стыка взяли: середину — `''` (тянется стык целиком),
     * верхний край — `'up'` (только конец верхней зоны), нижний — `'down'` (только
     * начало нижней). Края — по четверти высоты пилюли от центра.
     */
    reportJointPart(grip, clientY) {
        const pill = grip.querySelector('i') || grip;
        const r = pill.getBoundingClientRect();
        const dy = clientY - (r.top + r.height / 2);
        const edge = Math.max(4, r.height / 4);
        if (dy < -edge) return 'up';
        if (dy > edge) return 'down';
        return '';
    }

    /**
     * Ручку стыка взяли за край: отводим от соседа только свою зону, между ними
     * появляется зазор. Потянули к соседу — пока зоны встык, двигается стык целиком
     * (соседа подвинуть можно, перепрыгнуть — нет).
     */
    reportDragSplit(clientY) {
        const st = this._report;
        const { upKey, downKey, part } = st.drag.split;
        const zones = this.reportZones(st);
        const up = zones.find(z => z.key === upKey);
        const down = zones.find(z => z.key === downKey);
        if (!up || !down) return;
        const index = this.reportRowIndexAtY(clientY);
        if (index === null) return;
        const adjacent = up.range[1] + 1 === down.range[0];
        const towardNeighbour = part === 'up' ? index >= down.range[0] : index <= up.range[1];
        if (adjacent && towardNeighbour) {
            const b = this.reportBoundaryAtY(clientY);
            if (b !== null) this.reportMoveJoint(upKey, downKey, b);
            return;
        }
        if (part === 'up') this.reportMoveEdge(upKey, 'bottom', index);
        else this.reportMoveEdge(downKey, 'top', index);
    }

    /** Ручку тянут: край зоны или стык двух зон. */
    reportDragTo(clientY) {
        const st = this._report;
        const drag = st?.drag;
        if (!drag) return;
        if (drag.split) {
            this.reportDragSplit(clientY);
            return;
        }
        if (drag.joint) {
            const b = this.reportBoundaryAtY(clientY);
            if (b !== null) this.reportMoveJoint(drag.joint[0], drag.joint[1], b);
            return;
        }
        const index = this.reportRowIndexAtY(clientY);
        if (index !== null) this.reportMoveEdge(drag.key, drag.edge, index);
    }

    reportZones(st) {
        const zones = [];
        const red = this.reportRedRange(st);
        if (red) zones.push({ key: 'red', kind: 'red', range: red });
        this.reportOrangeRanges(st).forEach((range, i) => zones.push({ key: `o${i}`, kind: 'orange', range }));
        return zones;
    }

    reportZoneAt(st, i) {
        const zone = this.reportZones(st).find(z => i >= z.range[0] && i <= z.range[1]);
        return zone ? zone.kind : '';
    }

    reportOrangeTotal(st) {
        return this.reportOrangeRanges(st).reduce((n, r) => n + r[1] - r[0] + 1, 0);
    }

    /** Записать отрезки контекста: по порядку, соседние и перекрытые — слить. */
    reportSetOrange(st, ranges) {
        const red = this.reportRedRange(st);
        const sorted = ranges
            .map(r => [Math.min(r[0], r[1]), Math.max(r[0], r[1])])
            .filter(r => !red || r[1] < red[0] || r[0] > red[1])
            .sort((a, b) => a[0] - b[0]);
        // Красная зона между отрезками сама даёт зазор, поэтому через неё они не сольются.
        const merged = [];
        for (const r of sorted) {
            const last = merged[merged.length - 1];
            if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
            else merged.push([...r]);
        }
        st.orange = merged.map(r => this.reportRangeToIds(st, r));
    }

    /** Что уйдёт на сервер: зоны и по 20 вокруг каждого отрезка, объединением. */
    reportPayloadIndices(st) {
        const side = ZaliInterface.REPORT_CONTEXT_EACH_SIDE;
        const last = st.list.length - 1;
        const picked = new Set();
        this.reportZones(st).forEach(({ range }) => {
            for (let i = Math.max(0, range[0] - side); i <= Math.min(last, range[1] + side); i += 1) picked.add(i);
        });
        return Array.from(picked).sort((a, b) => a - b);
    }

    reportMessageText(msg) {
        if (msg?.kind === 'call') return String(msg.text || 'Звонок');
        return String(msg?.text || '');
    }

    reportRowEl(id) {
        const st = this._report;
        if (!st) return null;
        for (const row of st.msgs.querySelectorAll('.msg[data-message-id]')) {
            if (row.getAttribute('data-message-id') === id) return row;
        }
        return null;
    }

    /** Сдвинуть край зоны `key` к сообщению `index`: без пересечений и сверх лимитов. */
    reportMoveEdge(key, edge, index) {
        const st = this._report;
        if (!st) return;
        const zones = this.reportZones(st);
        const zone = zones.find(z => z.key === key);
        if (!zone) return;
        const [oldStart, oldEnd] = zone.range;
        let [start, end] = zone.range;
        const target = Math.max(0, Math.min(st.list.length - 1, index));
        if (edge === 'top') start = Math.min(target, end);
        else end = Math.max(target, start);
        // Соседние зоны — стены: край упирается в них, а не перепрыгивает.
        const others = zones.filter(z => z.key !== key);
        const wallAbove = others.filter(z => z.range[1] < oldStart).reduce((m, z) => Math.max(m, z.range[1]), -1);
        const wallBelow = others.filter(z => z.range[0] > oldEnd).reduce((m, z) => Math.min(m, z.range[0]), st.list.length);
        start = Math.max(start, wallAbove + 1);
        end = Math.min(end, wallBelow - 1);
        const max = ZaliInterface.REPORT_MAX_ZONE;
        if (zone.kind === 'red') {
            const anchor = st.index.get(st.anchorId);
            start = Math.min(start, anchor);
            end = Math.max(end, anchor);
            if (end - start + 1 > max) {
                if (edge === 'top') start = end - max + 1;
                else end = start + max - 1;
            }
        } else {
            // Весь контекст вместе — не больше 30 сообщений.
            const room = max - (this.reportOrangeTotal(st) - (oldEnd - oldStart + 1));
            if (end - start + 1 > room) {
                if (edge === 'top') start = end - room + 1;
                else end = start + room - 1;
            }
        }
        if (start > end || (start === oldStart && end === oldEnd)) return;
        this.reportAnimate();
        if (zone.kind === 'red') {
            st.red = this.reportRangeToIds(st, [start, end]);
        } else {
            const ranges = this.reportOrangeRanges(st);
            ranges[Number(key.slice(1))] = [start, end];
            this.reportSetOrange(st, ranges);
        }
        st.error = '';
        this.syncReportMode();
    }

    /** Нажатие на сообщение — по выбранному режиму. */
    handleReportFeedClick(e) {
        const st = this._report;
        if (!st || st.done) return;
        const row = e.target.closest?.('.msg[data-message-id]');
        if (!row) return;
        e.preventDefault();
        e.stopPropagation();
        const i = st.index.get(row.getAttribute('data-message-id'));
        if (i === undefined) return;
        const zones = this.reportZones(st);
        const hit = zones.find(z => i >= z.range[0] && i <= z.range[1]);
        if (st.active === 'red') {
            if (hit) return;
            const red = zones.find(z => z.key === 'red');
            if (red) this.reportMoveEdge('red', i < red.range[0] ? 'top' : 'bottom', i);
            return;
        }
        // Режим контекста: нажатие по отрезку убирает его, по свободному — добавляет.
        if (hit?.kind === 'red') return;
        this.reportAnimate();
        const ranges = this.reportOrangeRanges(st);
        if (hit?.kind === 'orange') {
            ranges.splice(Number(hit.key.slice(1)), 1);
            this.reportSetOrange(st, ranges);
        } else {
            if (this.reportOrangeTotal(st) >= ZaliInterface.REPORT_MAX_ZONE) {
                st.error = `Контекст — не больше ${ZaliInterface.REPORT_MAX_ZONE} сообщений`;
                this.syncReportBar();
                return;
            }
            const touches = ranges.some(r => i === r[0] - 1 || i === r[1] + 1);
            if (!touches && ranges.length >= ZaliInterface.REPORT_MAX_CONTEXT_ZONES) {
                st.error = `Контекст — не больше ${ZaliInterface.REPORT_MAX_CONTEXT_ZONES} отрезков: расширьте один из них`;
                this.syncReportBar();
                return;
            }
            ranges.push([i, i]);
            this.reportSetOrange(st, ranges);
        }
        st.error = '';
        this.syncReportMode();
    }

    // ---- Разметка режима ----

    scheduleReportSync() {
        const st = this._report;
        if (!st || st.raf) return;
        st.raf = requestAnimationFrame(() => {
            st.raf = 0;
            this.syncReportMode();
        });
    }

    /** Состояние режима → строки ленты, слои, панель. Разметку ленты не создаёт. */
    syncReportMode() {
        const st = this._report;
        if (!st) return;
        // Ушли в другую переписку — жалоба относится к прежней.
        if (this.reportConversationKey() !== st.key || !document.contains(st.msgs)) {
            this.closeReportMode();
            return;
        }
        const fresh = this.reportCurrentList();
        if (fresh.length !== st.list.length || fresh[fresh.length - 1] !== st.list[st.list.length - 1]) {
            st.list = fresh;
            this.reportReindex(st);
        }
        if (!st.index.has(st.anchorId)) {
            // Сообщение, на которое жаловались, удалено — жаловаться больше не на что.
            this.closeReportMode();
            return;
        }
        const sent = new Set(this.reportPayloadIndices(st));
        const rows = [];
        st.msgs.querySelectorAll('.msg[data-message-id]').forEach((row) => {
            const i = st.index.get(row.getAttribute('data-message-id'));
            const zone = i === undefined ? '' : this.reportZoneAt(st, i);
            row.classList.toggle('rp-out', i === undefined || !sent.has(i));
            row.classList.toggle('rp-in-zone', !!zone);
            if ((row.getAttribute('data-rp-zone') || '') !== zone) {
                if (zone) row.setAttribute('data-rp-zone', zone);
                else row.removeAttribute('data-rp-zone');
            }
            if (i !== undefined) rows.push({ i, row });
        });
        // Там, где композер парит над лентой (компьютер), лента прокручивается и
        // под панель; на телефоне поле ввода стоит в потоке и само сдвигает границу.
        if (getComputedStyle(st.area).position === 'absolute') {
            const pad = `${Math.max(st.bar.offsetHeight + 28, 92)}px`;
            if (st.msgs.style.paddingBottom !== pad) st.msgs.style.paddingBottom = pad;
        } else if (st.msgs.style.paddingBottom !== st.saved.paddingBottom) {
            st.msgs.style.paddingBottom = st.saved.paddingBottom;
        }
        this.positionReportLayers(rows);
        this.syncReportBar();
    }

    /** Рамка зоны и две ручки (как у выделения текста): создать недостающие, лишние убрать. */
    reportZoneEls(st, key, kind) {
        st.zoneEls = st.zoneEls || new Map();
        let els = st.zoneEls.get(key);
        if (!els || els.kind !== kind) {
            els?.zone.remove();
            els?.band.remove();
            const label = kind === 'red' ? 'нарушения' : 'контекста';
            const zone = document.createElement('div');
            zone.className = 'rp-zone';
            zone.dataset.zone = kind;
            zone.innerHTML = '<span class="rp-rail" aria-hidden="true"></span>'
                + ['top', 'bottom'].map(edge => `<button class="rp-grip" type="button" role="slider" data-key="${this.esc(key)}" data-edge="${this.esc(edge)}" aria-label="${this.esc(`${edge === 'top' ? 'Начало' : 'Конец'} ${label}`)}"><i aria-hidden="true"></i></button>`).join('');
            const band = document.createElement('div');
            band.className = 'rp-band';
            band.dataset.zone = kind;
            st.over.insertBefore(zone, st.over.firstChild);
            st.under.appendChild(band);
            els = { zone, band, kind };
            st.zoneEls.set(key, els);
        }
        return els;
    }

    positionReportLayers(rows) {
        const st = this._report;
        const vr = st.view.getBoundingClientRect();
        const mr = st.msgs.getBoundingClientRect();
        const width = st.msgs.clientWidth;
        const box = `left:${mr.left - vr.left}px;top:${mr.top - vr.top}px;width:${width}px;height:${mr.height}px`;
        st.under.style.cssText = box;
        st.over.style.cssText = box;
        // Рельс — посередине колонки слева; полоса зоны идёт от него до края ленты.
        const railX = Math.round(st.basePad / 2 + ZaliInterface.REPORT_GUTTER / 2 + 2);
        const left = railX;
        const right = width - 6;
        const firstRendered = rows[0]?.i;
        const lastRendered = rows[rows.length - 1]?.i;
        const geometry = (range) => {
            const k0 = rows.findIndex(r => r.i >= range[0] && r.i <= range[1]);
            if (k0 < 0) return null;
            let k1 = k0;
            while (k1 + 1 < rows.length && rows[k1 + 1].i <= range[1]) k1 += 1;
            const first = rows[k0].row.getBoundingClientRect();
            const last = rows[k1].row.getBoundingClientRect();
            const cutTop = rows[k0].i !== range[0] && range[0] < firstRendered;
            const cutBottom = rows[k1].i !== range[1] && range[1] > lastRendered;
            // Поле вокруг сообщений — не больше половины зазора до соседа: рамка не
            // режет соседний пузырь, который в зону не входит.
            const above = rows[k0 - 1] ? first.top - rows[k0 - 1].row.getBoundingClientRect().bottom : 12;
            const below = rows[k1 + 1] ? rows[k1 + 1].row.getBoundingClientRect().top - last.bottom : 12;
            return {
                top: (cutTop ? mr.top - 40 : first.top - Math.min(6, Math.max(0, above / 2))) - mr.top,
                bottom: (cutBottom ? mr.bottom + 40 : last.bottom + Math.min(6, Math.max(0, below / 2))) - mr.top,
                cutTop,
                cutBottom,
            };
        };
        const zones = this.reportZones(st);
        const geo = zones.map(zone => ({ zone, g: geometry(zone.range) }));
        // Соседние зоны: граница — посередине зазора, одна на двоих (без нахлёста
        // полос). Ручки на близких границах расходятся от линии, чтобы не лечь
        // одна на другую.
        const GRIP = 11;
        const placed = geo.filter(x => x.g).sort((x, y) => x.g.top - y.g.top);
        placed.forEach((x) => { x.gripTop = x.g.top; x.gripBottom = x.g.bottom; });
        for (let k = 0; k + 1 < placed.length; k += 1) {
            const up = placed[k];
            const down = placed[k + 1];
            const gap = down.g.top - up.g.bottom;
            if (gap < 14) {
                const mid = Math.round((up.g.bottom + down.g.top) / 2);
                up.g.bottom = mid;
                down.g.top = mid;
                up.g.joinBottom = true;
                down.g.joinTop = true;
            }
            if (down.g.top - up.g.bottom < GRIP * 2 + 4) {
                const mid = (up.g.bottom + down.g.top) / 2;
                up.gripBottom = Math.min(up.g.bottom, mid - GRIP - 1);
                down.gripTop = Math.max(down.g.top, mid + GRIP + 1);
            }
        }
        // Встык (без сообщения между): вместо двух ручек — одна общая на линии.
        const joints = this.reportJoints(st);
        const jointed = new Set();
        joints.forEach(({ up, down }) => { jointed.add(`${up.key}:bottom`); jointed.add(`${down.key}:top`); });
        geo.forEach((x) => {
            if (!x.g) return;
            if (jointed.has(`${x.zone.key}:bottom`)) x.gripBottom = x.g.bottom;
            if (jointed.has(`${x.zone.key}:top`)) x.gripTop = x.g.top;
        });
        const keep = new Set();
        geo.forEach((x) => {
            const { zone, g } = x;
            keep.add(zone.key);
            const els = this.reportZoneEls(st, zone.key, zone.kind);
            els.zone.hidden = !g;
            els.band.hidden = !g;
            if (!g) return;
            const active = st.active === zone.kind;
            els.zone.classList.toggle('is-active', active);
            els.band.classList.toggle('is-active', active);
            els.band.style.cssText = `left:${left}px;width:${right - left}px;transform:translateY(${g.top}px);height:${Math.max(12, g.bottom - g.top)}px`;
            els.band.dataset.cut = `${g.cutTop ? 'top' : ''}${g.cutBottom ? 'bottom' : ''}`;
            els.band.dataset.join = `${g.joinTop ? 'top' : ''}${g.joinBottom ? 'bottom' : ''}`;
            // Рельс между ручками, ручки — на линиях границ зоны.
            const rail = els.zone.querySelector('.rp-rail');
            const top = els.zone.querySelector('[data-edge="top"]');
            const bottom = els.zone.querySelector('[data-edge="bottom"]');
            rail.style.transform = `translate(${railX - 2}px, ${x.gripTop}px)`;
            rail.style.height = `${Math.max(0, x.gripBottom - x.gripTop)}px`;
            top.hidden = g.cutTop || jointed.has(`${zone.key}:top`);
            bottom.hidden = g.cutBottom || jointed.has(`${zone.key}:bottom`);
            top.style.transform = `translate(${railX - 22}px, ${x.gripTop - 22}px)`;
            bottom.style.transform = `translate(${railX - 22}px, ${x.gripBottom - 22}px)`;
        });
        st.jointEls = st.jointEls || new Map();
        const keepJoints = new Set();
        joints.forEach(({ up, down }) => {
            const g = geo.find(x => x.zone.key === down.key)?.g;
            if (!g || g.cutTop) return;
            const id = `${up.key}|${down.key}`;
            keepJoints.add(id);
            let el = st.jointEls.get(id);
            if (!el || el.dataset.a !== up.kind || el.dataset.b !== down.kind) {
                el?.remove();
                el = document.createElement('button');
                el.type = 'button';
                el.className = 'rp-grip rp-joint';
                el.setAttribute('role', 'slider');
                el.dataset.joint = id;
                el.dataset.a = up.kind;
                el.dataset.b = down.kind;
                el.setAttribute('aria-label', 'Граница между зонами');
                el.innerHTML = '<i aria-hidden="true"></i>';
                st.over.appendChild(el);
                st.jointEls.set(id, el);
            }
            el.hidden = false;
            el.classList.toggle('is-dragging', st.drag?.grip === el);
            el.style.transform = `translate(${railX - 22}px, ${g.top - 22}px)`;
        });
        for (const [id, el] of st.jointEls) {
            if (keepJoints.has(id)) continue;
            // Ручку держат, а стык на миг распался — не отрываем указатель.
            if (st.drag?.grip === el) { el.hidden = true; continue; }
            el.remove();
            st.jointEls.delete(id);
        }
        for (const [key, els] of st.zoneEls || []) {
            if (keep.has(key)) continue;
            // Убранный отрезок гаснет, а не пропадает рывком.
            [els.zone, els.band].forEach((el) => {
                el.classList.add('is-leaving');
                setTimeout(() => el.remove(), 180);
            });
            st.zoneEls.delete(key);
        }
        // Точка у левого края зоны — сообщение, на которое жалуются.
        const dot = st.over.querySelector('.rp-anchor');
        const anchorRow = rows.find(r => String(st.list[r.i].id) === st.anchorId)?.row;
        dot.hidden = !anchorRow;
        if (anchorRow) {
            const ar = anchorRow.getBoundingClientRect();
            // Место — свойством translate: оно не масштабируется анимацией появления (scale).
            dot.style.translate = `${railX}px ${ar.top - mr.top + Math.min(ar.height / 2, 20)}px`;
        }
        this.positionReportTag();
    }

    /** Подпись у тянущейся палочки: какая зона и сколько в ней сообщений. */
    positionReportTag() {
        const st = this._report;
        const tag = st?.over?.querySelector('.rp-tag');
        if (!tag) return;
        const drag = st.drag;
        const zone = drag && !drag.joint && this.reportZones(st).find(z => z.key === drag.key);
        const grip = zone && st.over.querySelector(`.rp-grip[data-key="${drag.key}"][data-edge="${drag.edge}"]`);
        if (!zone || !grip || grip.hidden) {
            tag.hidden = true;
            return;
        }
        const n = zone.range[1] - zone.range[0] + 1;
        tag.textContent = `${zone.kind === 'red' ? 'Нарушение' : 'Контекст'} · ${n} ${this.ruPlural(n, 'сообщение', 'сообщения', 'сообщений')}`;
        tag.dataset.zone = zone.kind;
        const or = st.over.getBoundingClientRect();
        const gr = grip.getBoundingClientRect();
        tag.style.transform = `translate(${gr.right - or.left + 12}px, ${gr.top - or.top + gr.height / 2}px)`;
        tag.hidden = false;
    }

    // ---- Панель жалобы ----

    reportHint(st) {
        const touch = this.isMobileLayout?.() || window.matchMedia?.('(hover: none)').matches;
        if (st.active === 'orange') {
            return touch
                ? 'Касайтесь сообщений, важных для понимания. Повторное касание убирает.'
                : 'Нажимайте на сообщения, важные для понимания, — до и после нарушения. Повторное нажатие убирает отрезок.';
        }
        return touch
            ? 'Тяните ручки на рельсе слева или коснитесь сообщения.'
            : 'Тяните ручки на рельсе слева или нажмите на сообщение — зона дотянется до него.';
    }

    renderReportBar() {
        const st = this._report;
        if (!st?.bar) return;
        if (st.done) {
            st.bar.classList.add('is-done');
            // Та же строка облака поля ввода: знак, итог, два действия.
            st.bar.innerHTML = `
                <span class="rb-done-sign" aria-hidden="true">${this.zaliSign('shield-check')}</span>
                <span class="rb-done-text" title="${this.esc(st.done.merged
                    ? 'На эти сообщения уже жаловались — ваша жалоба добавлена к той же проверке.'
                    : 'Нейросеть проверит отмеченное за несколько минут.')}">
                    <strong>Жалоба отправлена</strong>
                    <span>Результат появится в «Поддержке»</span>
                </span>
                <button class="btn-flat rb-done-open" type="button" data-report-open-support>Открыть</button>
                <button class="auth-btn primary" type="button" data-report-done>Готово</button>`;
            st.bar.onclick = (e) => {
                if (e.target.closest('[data-report-open-support]')) {
                    this.closeReportMode();
                    this.openSupportHub?.();
                } else if (e.target.closest('[data-report-done]')) {
                    this.closeReportMode({ animate: true });
                }
            };
            if (!this.isMobileLayout?.()) st.bar.querySelector('[data-report-done]')?.focus({ preventScroll: true });
            return;
        }
        // Одна строка в облаке поля ввода — режим жалобы живёт в самой ленте, панель
        // только переключает, что отмечаем, и отправляет. Подсказка и итог — в
        // подписях (title), ошибка — плашкой над облаком: высота не растёт.
        st.bar.classList.remove('is-done');
        st.bar.innerHTML = `
            <button class="rb-close" type="button" data-report-cancel aria-label="Отменить жалобу" title="Отменить жалобу (Esc)">${this.uiIcon('close')}</button>
            <div class="rb-seg" role="radiogroup" aria-label="Что отмечаете в ленте">
                <button class="rb-seg-btn" type="button" role="radio" data-zone="red" data-report-zone="red">
                    <i aria-hidden="true"></i><span>Нарушение</span><b data-rb-count="red"></b>
                </button>
                <button class="rb-seg-btn" type="button" role="radio" data-zone="orange" data-report-zone="orange">
                    <i aria-hidden="true"></i><span><em>Важный </em>контекст</span><b data-rb-count="orange"></b>
                </button>
            </div>
            <input class="rb-input" type="text" maxlength="500" data-report-comment autocomplete="off"
                   placeholder="Комментарий" aria-label="Комментарий для модерации, по желанию">
            <button class="auth-btn primary rb-submit" type="button" data-report-send>Отправить</button>
            <p class="rb-error" data-rb-error role="alert" hidden></p>`;
        st.bar.onclick = (e) => this.handleReportBarClick(e);
        st.bar.onkeydown = (e) => {
            if (e.key === 'Enter' && e.target.matches?.('[data-report-comment]')) {
                e.preventDefault();
                void this.submitReport();
            }
        };
    }

    syncReportBar() {
        const st = this._report;
        if (!st?.bar || st.done) return;
        const red = this.reportRedRange(st);
        const orangeTotal = this.reportOrangeTotal(st);
        const set = (sel, text) => {
            const el = st.bar.querySelector(sel);
            if (el && el.textContent !== text) el.textContent = text;
        };
        const bump = (sel, text) => {
            const el = st.bar.querySelector(sel);
            if (!el || el.textContent === text) return;
            const first = el.textContent === '';
            el.textContent = text;
            if (!first) {
                el.classList.remove('is-bump');
                void el.offsetWidth;
                el.classList.add('is-bump');
            }
        };
        bump('[data-rb-count="red"]', String(red ? red[1] - red[0] + 1 : 0));
        bump('[data-rb-count="orange"]', String(orangeTotal));
        const hint = this.reportHint(st);
        st.bar.querySelectorAll('[data-report-zone]').forEach((btn) => {
            if (btn.title !== hint) btn.title = hint;
        });
        st.bar.querySelectorAll('[data-report-zone]').forEach((btn) => {
            const on = btn.getAttribute('data-report-zone') === st.active;
            btn.setAttribute('aria-checked', on ? 'true' : 'false');
            btn.classList.toggle('is-active', on);
        });
        const total = this.reportPayloadIndices(st).length;
        const sendTitle = `На проверку уйдёт ${total} ${this.ruPlural(total, 'сообщение', 'сообщения', 'сообщений')} — зоны и по ${ZaliInterface.REPORT_CONTEXT_EACH_SIDE} вокруг каждой`;
        const sendBtn = st.bar.querySelector('[data-report-send]');
        if (sendBtn && sendBtn.title !== sendTitle) sendBtn.title = sendTitle;
        const error = st.bar.querySelector('[data-rb-error]');
        if (error) {
            error.hidden = !st.error;
            if (error.textContent !== st.error) error.textContent = st.error;
        }
        const send = st.bar.querySelector('[data-report-send]');
        if (send) {
            send.disabled = !!st.sending;
            set('[data-report-send]', st.sending ? 'Отправляем…' : 'Отправить');
        }
        st.over.querySelectorAll('.rp-grip').forEach((grip) => {
            const zone = this.reportZones(st).find(z => z.key === grip.dataset.key);
            if (!zone) return;
            const i = grip.dataset.edge === 'top' ? zone.range[0] : zone.range[1];
            grip.setAttribute('aria-valuemin', '1');
            grip.setAttribute('aria-valuemax', String(st.list.length));
            grip.setAttribute('aria-valuenow', String(i + 1));
            grip.setAttribute('aria-valuetext', `сообщение ${i + 1} из ${st.list.length}`);
        });
    }

    handleReportBarClick(e) {
        const st = this._report;
        if (!st) return;
        if (e.target.closest('[data-report-cancel]')) {
            this.closeReportMode({ animate: true });
            return;
        }
        const zoneBtn = e.target.closest('[data-report-zone]');
        if (zoneBtn) {
            st.active = zoneBtn.getAttribute('data-report-zone');
            st.error = '';
            this.reportAnimate();
            this.syncReportMode();
            return;
        }
        if (e.target.closest('[data-report-send]')) void this.submitReport();
    }

    // ---- Палочки: мышь, палец, клавиатура ----

    reportRowIndexAtY(clientY) {
        const st = this._report;
        const rows = Array.from(st?.msgs?.querySelectorAll('.msg[data-message-id]') || []);
        let fallback = null;
        for (const row of rows) {
            const i = st.index.get(row.getAttribute('data-message-id'));
            if (i === undefined) continue;
            fallback = i;
            if (clientY < row.getBoundingClientRect().bottom) return i;
        }
        return fallback;
    }

    reportStartDrag(e) {
        const grip = e.target.closest?.('.rp-grip');
        const st = this._report;
        if (!grip || !st || st.done || e.button > 0) return;
        e.preventDefault();
        try { grip.setPointerCapture(e.pointerId); } catch (err) { /* указатель уже отпущен */ }
        grip.focus({ preventScroll: true });
        const joint = grip.dataset.joint ? grip.dataset.joint.split('|') : null;
        let key = grip.dataset.key;
        let edge = grip.dataset.edge;
        // Стык, взятый за край пилюли, — разлепить: дальше это край одной зоны.
        const part = joint ? this.reportJointPart(grip, e.clientY) : '';
        const split = part ? { upKey: joint[0], downKey: joint[1], part } : null;
        if (split) {
            key = part === 'up' ? joint[0] : joint[1];
            edge = part === 'up' ? 'bottom' : 'top';
            grip.dataset.part = part;
        }
        if (!joint || split) st.active = key === 'red' ? 'red' : 'orange';
        st.drag = { key, joint, split, edge, grip, pointerId: e.pointerId, y: e.clientY };
        st.view.classList.add('is-report-dragging');
        grip.closest('.rp-zone')?.classList.add('is-dragging');
        const move = (ev) => {
            if (!st.drag || ev.pointerId !== st.drag.pointerId) return;
            st.drag.y = ev.clientY;
            this.reportDragTo(ev.clientY);
            this.positionReportTag();
        };
        const up = (ev) => {
            if (st.drag && ev.pointerId === st.drag.pointerId) this.reportEndDrag();
        };
        st.drag.cleanup = () => {
            grip.removeEventListener('pointermove', move);
            grip.removeEventListener('pointerup', up);
            grip.removeEventListener('pointercancel', up);
        };
        grip.addEventListener('pointermove', move);
        grip.addEventListener('pointerup', up);
        grip.addEventListener('pointercancel', up);
        this.syncReportMode();
        this.reportAutoScroll();
    }

    /** Палочку дотянули до края ленты — лента едет сама, пока палочку держат там. */
    reportAutoScroll() {
        const st = this._report;
        if (!st?.drag) return;
        const rect = st.msgs.getBoundingClientRect();
        const overlay = getComputedStyle(st.area).position === 'absolute';
        const bottomEdge = rect.bottom - (overlay ? st.bar.offsetHeight + 24 : 0);
        const zone = 44;
        const y = st.drag.y;
        let delta = 0;
        if (y < rect.top + zone) delta = -Math.ceil((rect.top + zone - y) / 3);
        else if (y > bottomEdge - zone) delta = Math.ceil((y - bottomEdge + zone) / 3);
        if (delta) {
            st.msgs.scrollTop += Math.max(-20, Math.min(20, delta));
            this.reportDragTo(Math.max(rect.top, Math.min(y, bottomEdge)));
        }
        st.drag.raf = requestAnimationFrame(() => this.reportAutoScroll());
    }

    reportEndDrag() {
        const st = this._report;
        if (!st?.drag) return;
        if (st.drag.raf) cancelAnimationFrame(st.drag.raf);
        st.drag.cleanup?.();
        if (st.drag.split) delete st.drag.grip.dataset.part;
        st.over?.querySelectorAll('.rp-zone.is-dragging').forEach(r => r.classList.remove('is-dragging'));
        st.drag = null;
        st.view.classList.remove('is-report-dragging');
        this.positionReportTag();
    }

    handleReportGripKey(e) {
        const grip = e.target.closest?.('.rp-grip');
        const st = this._report;
        if (!grip || !st) return;
        if (grip.dataset.joint) {
            const [upKey, downKey] = grip.dataset.joint.split('|');
            const zones = this.reportZones(st);
            const up = zones.find(z => z.key === upKey);
            const down = zones.find(z => z.key === downKey);
            const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, PageUp: -5, PageDown: 5 }[e.key];
            if (!up || !down || !step) return;
            e.preventDefault();
            // Shift — разлепить: вверх укорачивает верхнюю зону, вниз — нижнюю.
            if (e.shiftKey) {
                st.active = (step < 0 ? up : down).kind;
                if (step < 0) this.reportMoveEdge(upKey, 'bottom', up.range[1] + step);
                else this.reportMoveEdge(downKey, 'top', down.range[0] + step);
                return;
            }
            this.reportMoveJoint(upKey, downKey, down.range[0] + step);
            return;
        }
        const zone = this.reportZones(st).find(z => z.key === grip.dataset.key);
        if (!zone) return;
        const current = grip.dataset.edge === 'top' ? zone.range[0] : zone.range[1];
        const step = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1, PageUp: -5, PageDown: 5 }[e.key];
        let target = null;
        if (step) target = current + step;
        else if (e.key === 'Home') target = 0;
        else if (e.key === 'End') target = st.list.length - 1;
        if (target === null) return;
        e.preventDefault();
        st.active = zone.kind;
        this.reportMoveEdge(zone.key, grip.dataset.edge, target);
        // Граница ушла за видимую часть ленты — догоняем её.
        const moved = this.reportZones(st).find(z => z.key === zone.key);
        if (moved) {
            const id = String(st.list[grip.dataset.edge === 'top' ? moved.range[0] : moved.range[1]].id);
            this.reportRowEl(id)?.scrollIntoView?.({ block: 'nearest' });
        }
    }

    // ---- Отправка ----

    async submitReport() {
        const st = this._report;
        if (!st || st.sending || st.done) return;
        st.sending = true;
        st.error = '';
        this.syncReportBar();
        const payload = {
            anchorMessageId: st.anchorId,
            comment: String(st.bar.querySelector('[data-report-comment]')?.value || '').trim().slice(0, 500),
            messages: this.reportPayloadIndices(st).map((i) => {
                const msg = st.list[i];
                return {
                    id: String(msg.id),
                    text: this.reportMessageText(msg).slice(0, 2000),
                    zone: this.reportZoneAt(st, i) || 'context',
                    attachments: (Array.isArray(msg.attachments) ? msg.attachments : []).slice(0, 10).map(a => ({
                        name: String(a?.name || ''),
                        kind: String(a?.kind || 'file'),
                    })),
                };
            }),
        };
        let res = null;
        let data = {};
        try {
            res = await this.apiFetch('/api/moderation/reports', {
                method: 'POST',
                body: JSON.stringify(payload),
                interactive: true,
            });
            data = await res.json().catch(() => ({}));
        } catch (err) {
            res = null;
        }
        if (this._report !== st) return;
        st.sending = false;
        if (!res || !res.ok) {
            st.error = data?.message || (res ? `Не удалось отправить жалобу (${res.status})` : 'Нет связи с сервером — попробуйте ещё раз');
            this.syncReportBar();
            return;
        }
        st.done = { merged: !!data.merged };
        this.addLogEntry?.({ type: 'INFO', msg: `Жалоба на ${st.accused} отправлена`, ts: new Date().toLocaleTimeString() });
        // Слои зон больше не нужны: лента снова обычная, панель говорит, что дальше.
        st.view.classList.add('is-report-done');
        this.renderReportBar();
        this.syncReportMode();
        void this.loadModerationStanding?.({ silent: true });
    }
});
