// --- ZaliInterface: Отрисовка списков контактов, хаба и серверов. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // --- DOM Rendering Methods ---

    renderContacts() {
        const el = document.getElementById('contacts');
        if (!el) return;
        this.updateSidebarModeLabel();
        this.bindMobileListChrome();
        if (this.S.navMode === 'servers') {
            this.renderChatFilter(null);
            this.renderServers(el);
            return;
        }
        this.renderMobileServerCard(null);
        const q = this.S.searchQ.toLowerCase();
        const all = this.S.contacts.filter(contact => contact !== this.myName());
        // «Непрочитанные» — фильтр экрана выбора на телефоне (renderChatFilter).
        // Сбрасывается сам, когда непрочитанных не осталось: иначе список
        // оставался бы пустым без видимой причины.
        const unreadCount = all.filter(contact => (this.S.unread[contact] || 0) > 0).length;
        if (this.S.chatListFilter === 'unread' && unreadCount === 0) this.S.chatListFilter = 'all';
        const onlyUnread = this.S.chatListFilter === 'unread';
        this.renderChatFilter(all.length ? unreadCount : null);
        const list = all
            .filter(contact => (!q || contact.toLowerCase().includes(q)) && (!onlyUnread || (this.S.unread[contact] || 0) > 0))
            .map((contact, index) => ({
                name: contact,
                lastMessageAt: this.conversationLastMessageAt(contact),
                index,
            }))
            .sort((a, b) => b.lastMessageAt - a.lastMessageAt || this.compareContactNames(a.name, b.name) || a.index - b.index)
            .map(item => item.name);

        if (list.length === 0) {
            // contacts-empty-art — иллюстрация «найти → добавить → написать»
            // (оформление «Фокус»); при пустом поиске она не к месту.
            const filtered = q || onlyUnread;
            this.commitListHTML(el, 'contacts', `<div class="contacts-empty">${filtered ? '' : '<div class="contacts-empty-art" aria-hidden="true"></div>'}<span>${q ? 'Ничего не найдено' : (onlyUnread ? 'Всё прочитано' : 'Добавьте первый контакт')}</span>${filtered ? '' : this.emptyActionsHTML('contacts')}</div>`);
            return;
        }

        const rows = list.map(contact => {
            this.initChat(contact);
            const msgs = this.S.chats[contact];
            const last = msgs[msgs.length-1];
            let preview = '<span style="color:var(--text3);font-style:italic;font-size:10px">Начните диалог...</span>';
            if (last) {
                const who = last.sender === this.myName() ? 'Вы: ' : '';
                preview = who + this.esc(this.messageSummary(last));
            }
            const cnt = this.S.unread[contact] || 0;
            const badge = cnt > 0 ? `<div class="badge">${cnt > 99 ? '99+' : cnt}</div>` : '';
            const active = contact === this.S.current ? 'active' : '';
            const muted = this.isPeerMuted(contact);
            // Last-message time for the row's right column (hidden on desktop via
            // CSS, shown on the mobile Telegram-style list). Today → time,
            // otherwise a short date — same helpers the message list uses.
            let timeLabel = '';
            if (last && last.timestamp) {
                // fmtDate() answers «Сегодня» exactly when the row wants a time.
                const day = this.fmtDate(last.timestamp);
                timeLabel = day === 'Сегодня' ? this.fmtTime(last.timestamp) : day;
            }
            // «Играет в …» занимает место превью, пока нет непрочитанного: счётчик и
            // текст новых сообщений важнее. Значок игры в имени остаётся всегда.
            const game = this.gameActivityFor(contact);
            if (game && cnt === 0) {
                preview = `<span class="contact-game"><span class="game-activity-text">${this.esc(this.gameActivityLabel(game))}</span></span>`;
            }
            const gameBadge = game
                ? `<span class="contact-game-badge" title="${this.esc(this.gameActivityLabel(game))}">${this.gameActivityIconHTML()}</span>`
                : '';
            // has-unread — чтобы строку с новым можно было выделить целиком
            // (имя, превью), а не только бейджем в углу.
            return `<div class="contact ${active}${cnt > 0 ? ' has-unread' : ''}" data-name="${this.esc(contact)}">
                <div class="ava"${this.profileOpenAttrs(contact)}>${this.renderAvatarHTML(contact, 'avatar-img', contact)}</div>
                <div class="contact-info">
                    <div class="contact-name">${this.esc(contact)}${gameBadge}</div>
                    <div class="contact-prev">${preview}</div>
                </div>
                <div class="contact-actions">
                    ${timeLabel ? `<span class="contact-time">${this.esc(timeLabel)}</span>` : ''}
                    ${badge}
                    ${muted ? `<span class="contact-mute-indicator" title="Уведомления отключены" aria-label="Уведомления отключены">${this.uiIcon('bell-off')}</span>` : ''}
                    <button class="contact-more" type="button" data-contact-more="${this.esc(contact)}" title="Действия с контактом" aria-label="${this.esc(`Действия с контактом ${contact}`)}" aria-haspopup="menu">${this.uiIcon('more')}</button>
                    <button class="contact-remove" type="button" data-remove-contact="${this.esc(contact)}" title="Удалить контакт">×</button>
                </div>
            </div>`;
        });
        this.commitListRows(el, 'contacts', rows);
    }

    /**
     * «Все / Непрочитанные N» над списком диалогов. Виден только на телефоне
     * (CSS), где список — отдельный экран выбора; null — спрятать (серверы,
     * пустой список контактов).
     */
    renderChatFilter(unreadCount) {
        const box = document.getElementById('chatFilter');
        if (!box) return;
        const show = unreadCount !== null && unreadCount !== undefined;
        if (box.hidden === show) box.hidden = !show;
        if (!show) return;
        const active = this.S.chatListFilter === 'unread' ? 'unread' : 'all';
        const chip = (id, label, extra = '') => `<button type="button" role="tab" class="chat-filter-chip${active === id ? ' is-active' : ''}" data-chat-filter="${this.esc(id)}" aria-selected="${this.esc(String(active === id))}"${extra}>${label}</button>`;
        this.setHTMLIfChanged(box, chip('all', 'Все')
            + chip('unread', `Непрочитанные${unreadCount ? ` <span class="chat-filter-count">${unreadCount > 99 ? '99+' : unreadCount}</span>` : ''}`, unreadCount ? '' : ' disabled'));
    }

    /**
     * Карточка выбранного сервера над его каналами — только телефон (CSS): там
     * у экрана-списка нет шапки чата, и без неё было не видно, чей это список,
     * а меню сервера (казна, приглашение, настройки) пряталось за долгим
     * нажатием на аватарку. null — спрятать.
     */
    renderMobileServerCard(server) {
        const box = document.getElementById('mobileServerCard');
        if (!box) return;
        if (!server) {
            if (!box.hidden) box.hidden = true;
            this.syncMobileServerBar?.();
            return;
        }
        const members = Number(server.memberCount || 0);
        const channels = (server.channels || []).filter(Boolean).length;
        const meta = [
            members > 0 ? `${members} ${this.ruPlural(members, 'участник', 'участника', 'участников')}` : '',
            `${channels} ${this.ruPlural(channels, 'канал', 'канала', 'каналов')}`,
        ].filter(Boolean).join(' · ');
        // «↶» — стрелка, развёрнутая назад: обратно к выбору сервера (лента
        // встаёт на место шапки, mobile_server_bar.js).
        this.setHTMLIfChanged(box, `<button type="button" class="m-server-card-back" data-server-bar="picker" aria-label="Выбрать другой сервер"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M9 14 4 9l5-5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
            ${this.renderServerAvatarHTML(server, 'm-server-card-ava')}
            <span class="m-server-card-copy">
                <strong>${this.esc(server.name || 'Сервер')}</strong>
                <span>${this.esc(meta)}</span>
            </span>
            <button type="button" class="m-server-card-menu" data-server-menu="${this.esc(server.id)}" aria-label="${this.esc(`Меню сервера ${server.name || ''}`)}" aria-haspopup="menu">${this.uiIcon('more')}</button>`);
        if (box.hidden) box.hidden = false;
        this.syncMobileServerBar?.();
    }

    /** Делегированные клики фильтра чатов и кнопки меню сервера — один раз. */
    bindMobileListChrome() {
        const sidebar = document.querySelector('.sidebar');
        if (!sidebar || sidebar.__mobileListChromeBound) return;
        sidebar.__mobileListChromeBound = true;
        sidebar.addEventListener('click', (e) => {
            const filter = e.target.closest('[data-chat-filter]');
            if (filter && !filter.disabled) {
                this.S.chatListFilter = filter.getAttribute('data-chat-filter') === 'unread' ? 'unread' : 'all';
                this.renderContacts();
                return;
            }
            if (e.target.closest('[data-server-bar="picker"]')) {
                e.stopPropagation();
                this.openMobileServerPicker();
                return;
            }
            const menu = e.target.closest('[data-server-menu]');
            if (menu) {
                e.stopPropagation();
                const rect = menu.getBoundingClientRect();
                this.openServerRailContextMenu(menu.getAttribute('data-server-menu'), rect.right, rect.bottom + 4);
            }
        });
    }

    // renderContacts()/renderServers() are called from ~30 places (every incoming
    // message, every async avatar that finishes loading, every nav change), and each
    // call used to reassign innerHTML unconditionally. That rebuilt every row's DOM
    // and re-fired the CSS entry animations (.contact/.server-item `contact-in`,
    // .badge `badge-pop`), which is what made the sidebar visibly twitch and flash
    // avatars while chatting. Writing only on a real content change makes the common
    // case a string compare.
    /**
     * Закрывает то, что накрывает панель чата (профиль, настройки сервера).
     *
     * Модальные слои живут внутри .main и больше не гасят левую навигацию —
     * по контакту или серверу можно щёлкнуть, не закрывая диалог. Без этого
     * переключение происходило бы ЗА окном: чат сменился, а поверх него
     * по-прежнему висит чужой профиль, и человек этого не видит. Поэтому
     * выбор в навигации закрывает модальный слой.
     *
     * Вызывается только из веток навигации в bindContactListEvents(); плитки
     * «создать/присоединиться», которые сами открывают окно, сюда не заходят.
     */
    closeChatPanelModals() {
        if (this.ensureProfileState().open) this.closeProfile();
        const serverOverlay = document.getElementById('serverOverlay');
        if (serverOverlay && !serverOverlay.hidden) this.closeServerOverlay();
        this.closeCoinOverlaysForNavigation?.();
    }

    commitListHTML(el, slot, html) {
        if (!el) return false;
        this._listHTMLCache = this._listHTMLCache || new Map();
        const key = `${slot}`;
        const unchanged = this._listHTMLCache.get(key) === html
            && el.dataset.listSlot === key
            // Guard against the container having been emptied/replaced by something
            // else since we cached — never let the cache hide an empty list.
            && (el.childElementCount > 0 || !html);
        if (unchanged) {
            return false;
        }
        el.dataset.listSlot = key;
        el.innerHTML = html;
        this._listHTMLCache.set(key, html);
        return true;
    }

    // Полная запись списка из строк (одна строка разметки = ровно один элемент
    // верхнего уровня). Запоминает соответствие «строка разметки → узел», если
    // каждая строка дала ровно один узел верхнего уровня; иначе соответствия нет и
    // следующий кадр тоже пишется целиком — как было до точечного обновления.
    writeListRows(el, state, rows, html = rows.join('')) {
        el.innerHTML = html;
        const nodes = el.childNodes;
        if (nodes && nodes.length === rows.length) {
            state.rows = rows;
            state.nodes = Array.from(nodes);
        } else {
            state.rows = null;
            state.nodes = null;
        }
    }

    // Точечное обновление списка (#msgs, сайдбар контактов): узлы строк, которые не изменились, остаются на месте,
    // создаются только новые. Новое сообщение, смена статуса «отправляется»,
    // реакция — это одна-две строки, а раньше каждое такое событие пересоздавало
    // все пузыри окна (и все их <img>/<video>) и заново раскладывало список.
    //
    // Сопоставление — по самой строке разметки, по порядку: для каждой новой строки
    // берётся первый ещё не занятый старый узел с той же разметкой правее
    // предыдущего взятого. Так покрывается и сдвиг виртуального окна (сверху ушла
    // строка, снизу пришла, распорка сменила высоту), а не только правка хвоста.
    //
    // Возвращает false, если патч неприменим, — вызывающий пишет список целиком:
    //  - соответствие строк узлам потеряно (кто-то менял #msgs мимо рендера —
    //    пустое состояние, голосовой канал; проверяется поузлово, а не по флагу);
    //  - новых строк больше половины — полная запись не дороже;
    //  - новые строки разобрались не в один узел на строку.
    patchListRows(box, state, rows) {
        if (!state) return false;
        const prevRows = state.rows;
        const prevNodes = state.nodes;
        if (!Array.isArray(prevRows) || !Array.isArray(prevNodes) || prevRows.length !== prevNodes.length) return false;
        const children = box.childNodes;
        if (!children || children.length !== prevNodes.length) return false;
        for (let i = 0; i < prevNodes.length; i += 1) {
            if (children[i] !== prevNodes[i]) return false;
        }

        const byRow = new Map();
        for (let i = 0; i < prevRows.length; i += 1) {
            const list = byRow.get(prevRows[i]);
            if (list) list.push(i);
            else byRow.set(prevRows[i], [i]);
        }
        const matched = new Array(rows.length);
        const reused = new Uint8Array(prevRows.length);
        // Строка изменилась, но это та же запись (тот же data-message-id /
        // data-name) — пузырь, у которого сменилась позиция в группе, статус
        // доставки или время, строка контакта с новым превью. Раньше такой
        // узел пересоздавался целиком: фото в предыдущем пузыре заново
        // декодировалось и мигало, видео и стикер начинались сначала, аватарка
        // в списке контактов моргала на каждом входящем, бейдж заново «выпрыгивал».
        // Теперь к живому узлу применяется только разница старой и новой разметки.
        const morphFrom = new Array(rows.length).fill(-1);
        const nextRows = new Set(rows);
        const freshRows = [];
        let lastOld = -1;
        for (let i = 0; i < rows.length; i += 1) {
            const list = byRow.get(rows[i]);
            let found = -1;
            if (list) {
                while (list.length && list[0] <= lastOld) list.shift();
                if (list.length) found = list.shift();
            }
            if (found >= 0) {
                matched[i] = prevNodes[found];
                reused[found] = 1;
                lastOld = found;
            } else {
                matched[i] = null;
                const next = lastOld + 1;
                // Старую строку, которая ещё найдётся в новом списке как есть, не трогаем.
                if (next < prevRows.length && !reused[next] && !nextRows.has(prevRows[next])) {
                    const key = this.listRowKey(rows[i]);
                    if (key && key === this.listRowKey(prevRows[next])) {
                        morphFrom[i] = next;
                        reused[next] = 1;
                        lastOld = next;
                    }
                }
                freshRows.push(rows[i]);
            }
        }
        // Порог «дешевле переписать целиком» считается без строк, которые
        // обновятся на месте: в коротком списке (один-два контакта) одна такая
        // строка — уже половина, и полная перезапись вернула бы мигание аватарок.
        const morphCount = morphFrom.reduce((n, from) => n + (from >= 0 ? 1 : 0), 0);
        if ((freshRows.length - morphCount) * 2 > rows.length) return false;

        let fresh = [];
        if (freshRows.length) {
            const tpl = document.createElement('template');
            tpl.innerHTML = freshRows.join('');
            if (tpl.content.childNodes.length !== freshRows.length) return false;
            fresh = Array.from(tpl.content.childNodes);
        }
        let freshCursor = 0;
        const freshFor = new Array(rows.length);
        for (let i = 0; i < rows.length; i += 1) {
            if (matched[i]) continue;
            freshFor[i] = fresh[freshCursor++];
            const from = morphFrom[i];
            if (from < 0) continue;
            if (typeof freshFor[i]?.isEqualNode !== 'function') {
                reused[from] = 0;
                continue;
            }
            const live = prevNodes[from];
            const tpl = document.createElement('template');
            tpl.innerHTML = prevRows[from];
            const before = tpl.content.childNodes.length === 1 ? tpl.content.firstChild : null;
            if (before && this.morphListNode(live, before, freshFor[i]) === true) {
                matched[i] = live;
            } else {
                reused[from] = 0;
            }
        }
        for (let i = 0; i < prevNodes.length; i += 1) {
            if (!reused[i]) prevNodes[i].remove();
        }
        // После удаления в #msgs остались только переиспользованные узлы, уже в
        // нужном порядке; новые вставляются перед следующим переиспользованным.
        let ref = box.firstChild;
        const nodes = new Array(rows.length);
        for (let i = 0; i < rows.length; i += 1) {
            if (matched[i]) {
                nodes[i] = matched[i];
                ref = matched[i].nextSibling;
            } else {
                const node = freshFor[i];
                box.insertBefore(node, ref);
                nodes[i] = node;
            }
        }

        state.rows = rows;
        state.nodes = nodes;
        return true;
    }

    // Ключ строки списка — то, по чему строки одной и той же записи узнаются
    // между кадрами: data-message-id пузыря или data-name контакта в первом теге.
    listRowKey(row) {
        const head = /^\s*<[a-z][^>]*>/i.exec(String(row || ''));
        if (!head) return '';
        const m = /\sdata-(message-id|name)="([^"]*)"/.exec(head[0]);
        return m ? `${m[1]}:${m[2]}` : '';
    }

    // Переносит на живой узел `live` разницу между разметкой, из которой он был
    // собран (`before`), и новой (`after`). Сравниваются именно две разметки, а не
    // живой узел с новой: всё, что код дописал в DOM уже после отрисовки (класс
    // msg-flash, стили из обработчика load у картинки, SVG стикера), там, где
    // разметка не менялась, остаётся нетронутым. Где поменялось строение —
    // заменяется только этот потомок. true — живой узел обновлён на месте;
    // 'replace' — его самого придётся заменить на `after`.
    morphListNode(live, before, after) {
        // Без настоящего DOM (упрощённый DOM perf_doctor) — прежняя замена строки.
        if (typeof before?.isEqualNode !== 'function' || typeof after?.getAttributeNames !== 'function') return 'replace';
        if (before.nodeType !== after.nodeType || before.nodeName !== after.nodeName) return 'replace';
        if (live.nodeType !== before.nodeType || live.nodeName !== before.nodeName) return 'replace';
        if (before.isEqualNode(after)) return true;
        if (before.nodeType === Node.TEXT_NODE || before.nodeType === Node.COMMENT_NODE) {
            live.nodeValue = after.nodeValue;
            return true;
        }
        if (before.nodeType !== Node.ELEMENT_NODE) return 'replace';
        const beforeKids = Array.from(before.childNodes);
        const afterKids = Array.from(after.childNodes);
        const liveKids = Array.from(live.childNodes);
        if (beforeKids.length !== afterKids.length || liveKids.length !== beforeKids.length) return 'replace';
        for (const name of before.getAttributeNames()) {
            if (name === 'class' || after.hasAttribute(name)) continue;
            live.removeAttribute(name);
        }
        for (const name of after.getAttributeNames()) {
            const value = after.getAttribute(name);
            if (name === 'class') continue;
            if (before.getAttribute(name) !== value) live.setAttribute(name, value);
        }
        // Классы — по разнице, а не присваиванием: классы, которые поставил JS,
        // переживают перерисовку.
        if (before.getAttribute('class') !== after.getAttribute('class')) {
            if (live.getAttribute('class') === before.getAttribute('class')) {
                // Чужих классов нет — пишем строку как есть, чтобы результат
                // совпадал с полной отрисовкой побайтно.
                const value = after.getAttribute('class');
                if (value == null) live.removeAttribute('class');
                else live.setAttribute('class', value);
                return this.morphListChildren(live, beforeKids, afterKids, liveKids);
            }
            const was = new Set(before.classList);
            const now = new Set(after.classList);
            for (const name of was) if (!now.has(name)) live.classList.remove(name);
            for (const name of now) if (!was.has(name)) live.classList.add(name);
        }
        return this.morphListChildren(live, beforeKids, afterKids, liveKids);
    }

    morphListChildren(live, beforeKids, afterKids, liveKids) {
        for (let i = 0; i < afterKids.length; i += 1) {
            if (this.morphListNode(liveKids[i], beforeKids[i], afterKids[i]) === 'replace') {
                live.replaceChild(afterKids[i], liveKids[i]);
            }
        }
        return true;
    }

    // Показ слоя с CSS-переходом по классу. Снятие display:none и класс,
    // попавшие в один пересчёт стилей, перехода не дают — слой просто
    // появляется, поэтому между ними читается offsetWidth. Класс ставится сразу,
    // а не в requestAnimationFrame: отложенный класс доезжал и после того, как
    // слой успели закрыть, и закрытый слой вспыхивал поверх интерфейса.
    // Незавершённое скрытие (concealLayer) отменяется — иначе его таймер прятал
    // только что открытый заново слой.
    revealLayer(el, className = 'visible') {
        if (!el) return;
        clearTimeout(el.__zaliConcealTimer);
        el.__zaliConcealTimer = 0;
        if (el.hidden) {
            el.hidden = false;
            void el.offsetWidth;
        }
        el.classList.add(className);
    }

    // Пара к revealLayer(): снимает класс и прячет слой после перехода, если
    // за это время его не открыли снова.
    concealLayer(el, { className = 'visible', delayMs = 180 } = {}) {
        if (!el) return;
        el.classList.remove(className);
        clearTimeout(el.__zaliConcealTimer);
        el.__zaliConcealTimer = 0;
        if (el.hidden) return;
        el.__zaliConcealTimer = setTimeout(() => {
            el.__zaliConcealTimer = 0;
            if (!el.classList.contains(className)) el.hidden = true;
        }, delayMs);
    }

    // commitListHTML() для списков, собранных построчно: та же защёлка «не
    // изменилось — не трогать», но изменение применяется точечно (patchListRows),
    // а не перезаписью всего контейнера. Кэш commitListHTML обновляется тем же
    // значением, чтобы обычная запись в тот же слот (пустое состояние) не сочла
    // себя «неизменившейся» по устаревшей строке.
    commitListRows(el, slot, rows) {
        if (!el) return false;
        const html = rows.join('');
        this._listHTMLCache = this._listHTMLCache || new Map();
        const key = `${slot}`;
        const unchanged = this._listHTMLCache.get(key) === html
            && el.dataset.listSlot === key
            && (el.childElementCount > 0 || !html);
        if (unchanged) return false;
        this._listRowState = this._listRowState || new Map();
        let state = this._listRowState.get(key);
        if (!state) {
            state = {};
            this._listRowState.set(key, state);
        }
        const patched = el.dataset.listSlot === key && this.patchListRows(el, state, rows);
        if (!patched) this.writeListRows(el, state, rows, html);
        el.dataset.listSlot = key;
        this._listHTMLCache.set(key, html);
        return true;
    }

    // Avatars are <img> tags rebuilt from a cached blob/data URL. Reassigning the
    // same markup drops the decoded image and makes the browser decode it again,
    // which is what made avatars blink on every unrelated re-render.
    setHTMLIfChanged(el, html) {
        if (!el) return false;
        const next = String(html == null ? '' : html);
        // WeakMap, not a data-attribute: avatar markup embeds full data: URLs on the
        // native shells, and stashing those in the DOM would double their memory.
        this._htmlSigCache = this._htmlSigCache || new WeakMap();
        // The childElementCount check is load-bearing, not just an empty-list guard:
        // some paths (switchChat, the DM branch of renderServerToolbar) write these
        // same elements with textContent, which leaves no element children and never
        // touches this cache. Without the check, a later HTML write matching the
        // cached signature would be skipped and the plain-text value would stick.
        if (this._htmlSigCache.get(el) === next && (el.childElementCount > 0 || !next)) return false;
        this._htmlSigCache.set(el, next);
        el.innerHTML = next;
        return true;
    }

    // Хаб: три крупные кнопки быстрых переходов и, пока есть обновление, полоса
    // «Доступно обновление». Разметка — строка без чужих данных, кроме версии
    // (через esc); обработчик клика — на #hubGrid (events.js).
    renderHub() {
        const grid = document.getElementById('hubGrid');
        if (!grid) return;
        // Маленькая картинка на кнопке — сцена из scripts/build_decor.py
        // (--decor-hub-*), одноцветная маска, как у больших иллюстраций; тумблер
        // «Иллюстрации» (data-decor-art) прячет и её. Шапку хаба это не трогает.
        const tiles = [
            {
                segment: 'settings',
                art: 'settings',
                title: 'Настройки',
                note: 'Профиль, тема, ключи и журнал событий',
            },
            {
                actionId: 'addons',
                art: 'addons',
                title: 'Аддоны',
                note: 'Упаковщик .zali из ZIP, установка и подпись',
            },
            {
                segment: 'zalicoin',
                art: 'coins',
                title: 'ZaliCoin',
                note: 'Баланс, переводы и карточки',
            },
        ];
        const status = this.S.updateStatus || {};
        let update = '';
        if (status.available) {
            const detail = status.readyToInstall
                ? 'Загружено — установите и перезапустите приложение.'
                : (status.downloading
                    ? `Загрузка… ${Math.round((status.progress || 0) * 100)}%`
                    : 'Доступна новая версия приложения.');
            const cta = status.readyToInstall ? 'Установить и перезапустить' : 'Скачать';
            update = `
            <button class="hub-update" type="button" data-hub-action="update">
                <span class="hub-update-dot" aria-hidden="true"></span>
                <span class="hub-update-text">
                    <strong>Доступно обновление v${this.esc(status.version)}</strong>
                    <span>${this.esc(detail)}</span>
                </span>
                <span class="hub-update-cta">${this.esc(cta)}</span>
            </button>`;
        }
        const chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M9 5l7 7-7 7"/></svg>';
        this.renderHubQuick?.();
        this.setHTMLIfChanged(grid, update + tiles.map(tile => `
            <button class="hub-action" type="button"${tile.segment ? ` data-hub-segment="${this.esc(tile.segment)}"` : ''}${tile.actionId ? ` data-hub-action="${this.esc(tile.actionId)}"` : ''}>
                <span class="hub-action-text">
                    <strong>${this.esc(tile.title)}</strong>
                    <span>${this.esc(tile.note)}</span>
                </span>
                <span class="hub-action-art hub-action-art--${this.esc(tile.art)}" aria-hidden="true"></span>
                <span class="hub-action-go" aria-hidden="true">${chevron}</span>
            </button>`).join(''));
    }

    /**
     * Кнопки пустого состояния. Главное действие одно, залитое; остальное тише.
     * Обработчик — один на документ (bindEmptyActionEvents в events.js), поэтому
     * разметка остаётся статической строкой без интерполяций.
     */
    emptyActionsHTML(kind) {
        if (kind === 'servers') {
            return '<div class="empty-actions">'
                + '<button class="auth-btn primary" type="button" data-empty-action="server-create">Создать сервер</button>'
                + '<button class="btn-flat" type="button" data-empty-action="server-join">Войти по коду</button>'
                + '</div>';
        }
        if (kind === 'contacts') {
            return '<div class="empty-actions">'
                + '<button class="auth-btn primary" type="button" data-empty-action="find-person">Найти человека</button>'
                + '</div>';
        }
        return '';
    }

    renderServers(el = null) {
        const target = el || document.getElementById('contacts');
        if (!target) return;
        this.ensureServersState();
        // The servers themselves are the rail (interface/server_rail.js); the
        // sidebar lists the selected server's channels.
        this.renderServerRails();
        const server = this.currentServer();
        const empty = (title, sub, actions = '') => `<div class="server-empty sidebar-channel-empty">
            <div class="empty-ttl">${title}</div>
            <div class="empty-sub">${sub}</div>
            ${actions}
        </div>`;
        this.renderMobileServerCard(server);
        if (!server) {
            const hasServers = (this.S.servers || []).some(Boolean);
            this.commitListHTML(target, 'servers', hasServers
                ? empty('Выберите сервер', 'Серверы — в ленте сверху')
                : empty('Серверов пока нет', 'Создайте свой сервер или войдите по коду', this.emptyActionsHTML('servers')));
            return;
        }
        const q = String(this.S.searchQ || '').toLowerCase();
        const inCallRoomId = this.voiceLiveCallType?.() === 'channel' ? String(this.voice.roomId || '') : '';
        const rows = (server.channels || [])
            .filter(Boolean)
            .filter(ch => !q || String(ch.name || '').toLowerCase().includes(q))
            .map(ch => {
                const kind = this.normalizeChannelKind(ch.kind);
                const active = ch.id === this.S.activeChannel ? ' active' : '';
                const inCall = kind === 'voice' && !!inCallRoomId && inCallRoomId === this.voiceRoomKeyForChannel(server.id, ch.id);
                const count = kind === 'voice' ? 0 : Number(this.S.channelUnread?.[`${server.id}:${ch.id}`] || 0);
                const badge = count > 0 ? `<div class="badge">${count > 99 ? '99+' : count}</div>` : '';
                const muted = kind !== 'voice' && this.isChannelMuted(server.id, ch.id);
                const sub = ch.topic
                    ? this.esc(ch.topic)
                    : (kind === 'voice' ? (inCall ? 'Вы в канале' : 'Голосовой канал') : 'Текстовый канал');
                // is-generic — подпись лишь повторяет иконку («Текстовый канал»):
                // оформление «Фокус» её прячет, тема канала и «Вы в канале» остаются.
                const genericSub = !ch.topic && !inCall;
                const occupants = kind === 'voice' ? this.voiceChannelOccupants(server, ch) : null;
                const since = occupants ? Math.min(...occupants.names.map(n => occupants.joinedAt?.[n.toLowerCase()] || Infinity)) : Infinity;
                const timer = Number.isFinite(since) ? `<span class="svm-timer" data-voice-since="${this.esc(String(since))}"></span>` : '';
                const membersHTML = occupants ? this.voiceChannelMembersHTML(server, ch, occupants) : '';
                return `<div class="sidebar-channel${active}${inCall ? ' in-call' : ''}${count > 0 ? ' has-unread' : ''}${membersHTML ? ' has-members' : ''}" data-server-id="${this.esc(server.id)}" data-channel-id="${this.esc(ch.id)}" data-channel-kind="${kind}">
                    <span class="sidebar-channel-icon ${kind}">${this.channelKindIcon(kind, 'sidebar-channel-glyph')}</span>
                    <div class="contact-info">
                        <div class="contact-name">${this.esc(ch.name)}</div>
                        <div class="contact-prev${genericSub ? ' is-generic' : ''}">${sub}</div>
                    </div>
                    <div class="contact-actions">
                        ${timer}
                        ${badge}
                        ${muted ? `<span class="contact-mute-indicator" title="Уведомления отключены" aria-label="Уведомления отключены">${this.uiIcon('bell-off')}</span>` : ''}
                    </div>
                </div>${membersHTML}`;
            }).join('');
        const html = rows
            ? `<div class="sidebar-channel-list">${rows}</div>`
            : empty(q ? 'Ничего не найдено' : 'Каналов нет', q ? 'Попробуйте другой запрос' : 'Создайте канал в настройках сервера');
        this.commitListHTML(target, 'servers', html);
        this.fillVoiceChannelTimers();
        if ((server.channels || []).some(ch => ch && this.normalizeChannelKind(ch.kind) === 'voice')) this.ensureServerVoicePoll();
    }

    updateServerSelection() {
        const rows = document.querySelectorAll('.server-item[data-server-id]');
        rows.forEach(row => {
            const serverId = row.getAttribute('data-server-id');
            row.classList.toggle('active', serverId === this.S.activeServer);
        });
    }

    // keepMobileList: picked from the rail on the phone's list screen, where the
    // point is to see that server's channels — not to be pushed into its chat.
    setActiveServer(serverId, { persist = true, keepMobileList = false } = {}) {
        const next = String(serverId || '').trim();
        if (!next) return;
        this.ensureServersState();
        if (!this.S.servers.some(server => server.id === next)) return;
        const stayOnMobileList = keepMobileList && this.isMobileLayout();
        const openChatScreen = () => {
            if (!stayOnMobileList) {
                this.ensureChatViewOpen();
            } else if (!document.getElementById('viewChat')?.classList.contains('active')) {
                this.openChatView({ showList: true });
            }
        };
        const current = this.currentServer();
        const currentChannel = this.currentChannel();
        if (this.S.navMode === 'servers' && this.S.activeServer === next && current && currentChannel) {
            // Same reasoning as setActiveChannel's identical guard: state is
            // already correct, but the click may be asking to return to the chat
            // screen from Hub/ZaliCoin/Settings — see ensureChatViewOpen().
            openChatScreen();
            return;
        }
        // The server rail stays clickable outside the chat screen too (see
        // switchChat's identical call for the DM list).
        openChatScreen();
        this.collapseActiveCallView();
        this.S.activeServer = next;
        this.S.activeConversationType = 'servers';
        this.S.navMode = 'servers';
        const server = this.currentServer();
        if (server) {
            const storedChannel = this.loadStoredActiveChannel();
            const fallbackChannel = (server.channels || [])[0]?.id || null;
            this.S.activeChannel = storedChannel && (server.channels || []).some(ch => ch.id === storedChannel)
                ? storedChannel
                : fallbackChannel;
        }
        if (persist) {
            this.saveStoredNavMode('servers');
            this.saveStoredActiveServer(next);
            this.saveStoredActiveChannel(this.S.activeChannel);
        }
        // A channel call survives switching servers too — see setActiveChannel.
        this.updateNavModeButtons();
        this.renderServerToolbar();
        this.requestMessagesScroll('bottom');
        this.resetMessageWindow();
        this.scheduleRenderMessages();
        this.updateSendButtonState();
        this.updateServerSelection();
        if (this.S.activeServer && this.S.activeChannel) {
            this.requestMessagesScroll('bottom');
            this.loadServerMessages(this.S.activeServer, this.S.activeChannel, { silent: true });
        }
        if (!stayOnMobileList) this.closeMobileSidebar();
        this.syncMobileChrome();
        // The sidebar lists this server's channels.
        this.renderContacts();
        // The new server's channel may or may not be a voice channel, and the
        // strip/voice view depend on exactly that.
        this.renderVoicePanel();
    }
});
