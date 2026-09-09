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
        if (this.S.navMode === 'servers') {
            this.renderServers(el);
            return;
        }
        const q = this.S.searchQ.toLowerCase();
        const list = this.S.contacts
            .filter(contact => contact !== this.myName() && (!q || contact.toLowerCase().includes(q)))
            .map((contact, index) => ({
                name: contact,
                lastMessageAt: this.conversationLastMessageAt(contact),
                index,
            }))
            .sort((a, b) => b.lastMessageAt - a.lastMessageAt || a.name.localeCompare(b.name, 'ru', { sensitivity: 'base' }) || a.index - b.index)
            .map(item => item.name);

        if (list.length === 0) {
            this.commitListHTML(el, 'contacts', `<div style="text-align:center;color:var(--text3);font-size:11px;padding:24px 0">${q ? 'Ничего не найдено' : 'Добавьте первый контакт'}</div>`);
            return;
        }

        const html = list.map(contact => {
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
                const d = new Date(last.timestamp);
                const now = new Date();
                timeLabel = d.toDateString() === now.toDateString()
                    ? this.fmtTime(last.timestamp)
                    : this.fmtDate(last.timestamp);
            }
            return `<div class="contact ${active}" data-name="${this.esc(contact)}">
                <div class="ava" data-profile-open="${this.esc(contact)}" title="${this.esc(`Профиль: ${contact}`)}">${this.renderAvatarHTML(contact, 'avatar-img', contact)}</div>
                <div class="contact-info">
                    <div class="contact-name">${this.esc(contact)}</div>
                    <div class="contact-prev">${preview}</div>
                </div>
                <div class="contact-actions">
                    ${timeLabel ? `<span class="contact-time">${this.esc(timeLabel)}</span>` : ''}
                    ${badge}
                    ${muted ? `<span class="contact-mute-indicator" title="Уведомления отключены" aria-label="Уведомления отключены">${this.uiIcon('bell-off')}</span>` : ''}
                    <button class="contact-remove" type="button" data-remove-contact="${this.esc(contact)}" title="Удалить контакт">×</button>
                </div>
            </div>`;
        }).join('');
        this.commitListHTML(el, 'contacts', html);
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

    componentRegistry() {
        const componentVersion = (track, update, serverCompat, moduleVersion) =>
            `${track}0.1.${update}s${serverCompat}l${moduleVersion}`;
        return [
            {
                name: 'Zali Interface',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Web UI',
                description: 'Основной интерфейс: чаты, хаб, настройки, контакты, серверы и composer.',
                dependencies: ['ZaliBus', 'ZaliStyler', 'NetworkService', 'Rust Core'],
            },
            {
                name: 'Zali Styler',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Web UI',
                description: 'Темы, CSS-переменные, радиусы, сохранение выбранной схемы и динамическая кастомизация.',
                dependencies: ['localStorage', 'Swift UserDefaults bridge'],
            },
            {
                name: 'ZaliBus',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Runtime',
                description: 'Командная шина между веб-модулями, Swift WebView и нативными обработчиками.',
                dependencies: ['bootstrap.js', 'native_types.js'],
            },
            {
                name: 'Messaging Module',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Web UI',
                description: 'Отправка сообщений, вложения, реакции, история, локальная очередь и realtime-обновления.',
                dependencies: ['api_routes.js', 'NetworkService', 'Rust Core', 'WebSocket'],
            },
            {
                name: 'Contacts Module',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Web UI',
                description: 'Список диалогов, поиск пользователей, добавление контактов и аватары.',
                dependencies: ['api_routes.js', 'Avatar API', 'Message Cache'],
            },
            {
                name: 'Servers Module',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Web UI',
                description: 'Серверы, каналы, роли, участники, публичные серверы и настройки сервера.',
                dependencies: ['api_routes.js', 'Server API', 'Roles API'],
            },
            {
                name: 'Voice Module',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Realtime',
                description: 'Голосовые комнаты и прямые звонки через WebRTC-сигналинг.',
                dependencies: ['WebRTC', 'Voice WebSocket', 'TURN config'],
            },
            {
                name: 'Rust Core',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Core',
                description: 'Шифрование, упаковка сообщений, файловые операции и нативная core-логика.',
                dependencies: ['Swift bridge', 'ZaliCrypto', 'FileManager'],
            },
            {
                name: 'NetworkService',
                version: componentVersion('b', 1, 1, 1),
                layer: 'macOS Native',
                description: 'HTTP/WebSocket-клиент macOS, загрузка вложений, realtime и связка с сервером.',
                dependencies: ['URLSession', 'UserDefaults', 'Zali Server API'],
            },
            {
                name: 'Windows Native Shell',
                version: componentVersion('b', 2, 1, 2),
                layer: 'Windows Native',
                description: 'Wry/Tao оболочка Windows, WebView2, AppUserModelID, native bridge и сборка exe.',
                dependencies: ['WebView2', 'windows-sys', 'ZaliBus', 'Rust Core'],
            },
            {
                name: 'Native Notifications',
                version: componentVersion('b', 1, 1, 1),
                layer: 'macOS Native',
                description: 'Права macOS, доставка уведомлений и перепроверка статуса при активации приложения.',
                dependencies: ['UNUserNotificationCenter', 'ZaliMessenger.app bundle'],
            },
            {
                name: 'Zali Server',
                version: componentVersion('b', 1, 1, 1),
                layer: 'Backend',
                description: 'REST API, WebSocket realtime, SQLite-хранилище, авторизация и uploads.',
                dependencies: ['axum 0.7', 'tokio 1.0', 'sqlx 0.7', 'jsonwebtoken 9.0'],
            },
        ];
    }

    renderHubComponents() {
        const box = document.getElementById('hubComponents');
        if (!box) return;
        const components = this.componentRegistry();
        box.innerHTML = `
            <div class="hub-components-head">
                <div>
                    <span class="settings-kicker">Components</span>
                    <h3>Компоненты приложения</h3>
                </div>
                <span>${components.length} модулей</span>
            </div>
            <div class="hub-components-list">
                ${components.map(component => `
                    <article class="hub-component-item">
                        <div class="hub-component-main">
                            <div class="hub-component-top">
                                <strong>${this.esc(component.name)}</strong>
                                <span>${this.esc(component.layer)}</span>
                            </div>
                            <p>${this.esc(component.description)}</p>
                        </div>
                        <div class="hub-component-meta">
                            <span class="hub-component-version">${this.esc(component.version)}</span>
                            <small>${component.dependencies.map(dep => this.esc(dep)).join(' / ')}</small>
                        </div>
                    </article>
                `).join('')}
            </div>
        `;
    }

    renderHub() {
        const grid = document.getElementById('hubGrid');
        if (!grid) return;
        const unreadTotal = Object.values(this.S.unread || {}).reduce((sum, value) => sum + Number(value || 0), 0);
        const contactsCount = Array.isArray(this.S.contacts) ? this.S.contacts.length : 0;
        const serversCount = Array.isArray(this.S.servers) ? this.S.servers.length : 0;
        const onlineLabel = this.S.wsOn ? 'WebSocket активен' : 'WebSocket не подключён';
        const cards = [
            {
                kind: 'news',
                title: 'Главные новости',
                value: 'UI v2',
                body: 'Новая сегментная навигация живёт отдельно от протокола сообщений.',
                action: 'Открыть ЛС',
                segment: 'dm',
            },
            {
                kind: 'notifications',
                title: 'Уведомления',
                value: unreadTotal ? `${unreadTotal}` : '0',
                body: unreadTotal ? 'Есть непрочитанные сообщения.' : 'Новых уведомлений пока нет.',
                action: 'К диалогам',
                segment: 'dm',
            },
            (() => {
                const status = this.S.updateStatus || {};
                if (status.available) {
                    return {
                        kind: 'updates',
                        title: 'Обновления',
                        value: `v${status.version}`,
                        body: status.readyToInstall
                            ? 'Загружено — установите и перезапустите приложение.'
                            : (status.downloading
                                ? `Загрузка… ${Math.round((status.progress || 0) * 100)}%`
                                : 'Доступна новая версия приложения.'),
                        action: status.readyToInstall ? 'Установить и перезапустить' : 'Скачать',
                        actionId: 'update',
                    };
                }
                return {
                    kind: 'updates',
                    title: 'Обновления',
                    value: 'Актуально',
                    body: `${onlineLabel}. Контактов: ${contactsCount}. Серверов: ${serversCount}.`,
                    action: 'Сервера',
                    segment: 'servers',
                };
            })(),
            {
                kind: 'apps',
                title: 'Подприложения',
                value: 'Плитки',
                body: 'Будущий дом для мини-модулей, виджетов и быстрых действий.',
                action: 'Открыть хаб',
                segment: 'hub',
            },
            {
                kind: 'components',
                title: 'Компоненты',
                value: 'Модули',
                body: 'Список частей приложения, их версий, зависимостей и зон ответственности.',
                action: 'Смотреть список',
                actionId: 'components',
            },
            {
                kind: 'settings',
                title: 'Настройки',
                value: 'Control',
                body: 'Профиль, тема, ключи, быстрые аккаунты и журнал событий.',
                action: 'Открыть настройки',
                segment: 'settings',
            },
        ];
        grid.innerHTML = cards.map(card => `
            <button class="hub-card hub-card--${this.esc(card.kind)}" type="button"${card.segment ? ` data-hub-segment="${this.esc(card.segment)}"` : ''}${card.actionId ? ` data-hub-action="${this.esc(card.actionId)}"` : ''}>
                <span class="hub-card-kicker">${this.esc(card.title)}</span>
                <strong>${this.esc(card.value)}</strong>
                <span>${this.esc(card.body)}</span>
                <em>${this.esc(card.action)}</em>
            </button>
        `).join('');
        this.renderHubComponents();
    }

    renderServers(el = null) {
        const target = el || document.getElementById('contacts');
        if (!target) return;
        this.ensureServersState();
        const q = this.S.searchQ.toLowerCase();
        const list = (this.S.servers || [])
            .filter(Boolean)
            .filter(server => {
                const haystack = `${server.name || ''} ${server.description || server.hint || ''}`.toLowerCase();
                return !q || haystack.includes(q);
            });

        const createTile = `
            <button class="server-item server-create" type="button" id="createServerBtn" title="Создать сервер" aria-label="Создать сервер">
                <span class="server-avatar server-create-plus">+</span>
                <div class="server-meta">
                    <div class="server-name">Создать сервер</div>
                    <div class="server-prev">Новый сервер, команда или сообщество</div>
                </div>
            </button>
        `;
        const joinTile = `
            <button class="server-item server-join" type="button" id="joinServerBtn" title="Войти по коду" aria-label="Войти по коду">
                <span class="server-avatar server-create-plus">↗</span>
                <div class="server-meta">
                    <div class="server-name">Войти по коду</div>
                    <div class="server-prev">Введите код или ссылку сервера</div>
                </div>
            </button>
        `;
        const publicTile = `
            <button class="server-item server-public" type="button" id="publicServersBtn" title="Открыть публичные серверы" aria-label="Открыть публичные серверы">
                <span class="server-avatar server-create-plus">☰</span>
                <div class="server-meta">
                    <div class="server-name">Публичные серверы</div>
                    <div class="server-prev">Просмотр и вход из меню</div>
                </div>
            </button>
        `;

        const html = `
            <div class="server-list">
                ${list.length === 0 ? `<div class="server-empty">
                    <div class="empty-ttl">Сервера не найдены</div>
                    <div class="empty-sub">Попробуйте другой запрос</div>
                </div>` : list.map(server => {
                    const active = server.id === this.S.activeServer ? 'active' : '';
                    // server.unread is never populated by the backend — the real
                    // per-channel counts live in S.channelUnread, so sum those up
                    // for the aggregate badge instead of reading a field that's
                    // always undefined.
                    const serverUnreadCount = (server.channels || []).reduce(
                        (sum, ch) => sum + Number(this.S.channelUnread?.[`${server.id}:${ch.id}`] || 0),
                        0
                    );
                    const badge = serverUnreadCount > 0
                        ? `<div class="badge server-badge">${serverUnreadCount > 99 ? '99+' : serverUnreadCount}</div>`
                        : '';
                    const preview = server.description || server.hint || 'Сервер';
                    return `
                        <button class="server-item ${active}" type="button" data-server-id="${this.esc(server.id)}" title="${this.esc(server.name)}" aria-label="${this.esc(server.name)}">
                            ${this.renderServerAvatarHTML(server)}
                            <div class="server-meta">
                                <div class="server-name">${this.esc(server.name)}</div>
                                <div class="server-prev">${this.esc(preview)}</div>
                            </div>
                            ${badge}
                        </button>
                    `;
                }).join('')}
                ${createTile}
                ${joinTile}
                ${publicTile}
            </div>
        `;
        this.commitListHTML(target, 'servers', html);
    }

    updateServerSelection() {
        const rows = document.querySelectorAll('.server-item[data-server-id]');
        rows.forEach(row => {
            const serverId = row.getAttribute('data-server-id');
            row.classList.toggle('active', serverId === this.S.activeServer);
        });
    }

    setActiveServer(serverId, { persist = true } = {}) {
        const next = String(serverId || '').trim();
        if (!next) return;
        this.ensureServersState();
        if (!this.S.servers.some(server => server.id === next)) return;
        const previousVoiceServer = String(this.voice.serverId || '').trim();
        const previousVoiceChannel = String(this.voice.channelId || '').trim();
        const current = this.currentServer();
        const currentChannel = this.currentChannel();
        if (this.S.navMode === 'servers' && this.S.activeServer === next && current && currentChannel) {
            // Same reasoning as setActiveChannel's identical guard: state is
            // already correct, but the click may be asking to return to the chat
            // screen from Hub/ZaliCoin/Settings — see ensureChatViewOpen().
            this.ensureChatViewOpen();
            return;
        }
        // The server list in the sidebar stays clickable outside the chat screen
        // too (see switchChat's identical call for the DM list).
        this.ensureChatViewOpen();
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
        if (this.voice.roomType === 'channel' && previousVoiceServer && previousVoiceChannel) {
            const nextVoiceChannel = String(this.S.activeChannel || '').trim();
            if (previousVoiceServer !== next || previousVoiceChannel !== nextVoiceChannel) {
                this.leaveVoiceRoom({ announce: true });
            }
        }
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
        this.closeMobileSidebar();
        this.syncMobileChrome();
    }
});
