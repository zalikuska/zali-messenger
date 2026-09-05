// --- ZaliInterface: Отрисовка профиля: шапка, вкладки, комментарии, друзья, модерация. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Модель и сеть — в
// profiles.js, векторная стена — в autographs.js.
//
// Оверлей перерисовывается целиком, но через setHTMLIfChanged: одинаковая
// разметка не вызывает записи в DOM. Это важно во время рисования — черновые
// штрихи живут в отдельном слое и в эту разметку не попадают, поэтому каждый
// новый штрих НЕ пересоздаёт поверхность рисования и не срывает захват
// указателя (см. bindAutographSurface).
//
// Поля ввода намеренно не перерисовываются на каждый символ: обработчики input
// пишут в черновик мимо рендера (updateProfileDraft), иначе каретка прыгала бы
// в конец строки на каждой букве.
ZaliMixin(ZaliInterface, class {

    showProfileOverlay() {
        const overlay = document.getElementById('profileOverlay');
        if (!overlay) return;
        overlay.hidden = false;
        requestAnimationFrame(() => overlay.classList.add('visible'));
        this.renderProfileOverlay();
    }

    hideProfileOverlay() {
        const overlay = document.getElementById('profileOverlay');
        if (!overlay) return;
        overlay.classList.remove('visible');
        setTimeout(() => {
            if (!this.ensureProfileState().open) overlay.hidden = true;
        }, 180);
    }

    /**
     * SQLite отдаёт CURRENT_TIMESTAMP как «YYYY-MM-DD HH:MM:SS» без указания
     * зоны, а это UTC. Без явного «Z» браузер прочитал бы её как местное время
     * и сдвинул бы все даты на смещение часового пояса.
     */
    profileTimestampLabel(raw) {
        const value = String(raw || '').trim();
        if (!value) return '';
        const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
            ? `${value.replace(' ', 'T')}Z`
            : value;
        const date = this.fmtDate(iso);
        const time = this.fmtTime(iso);
        if (!date && !time) return '';
        return date ? `${date}, ${time}` : time;
    }

    renderProfileOverlay() {
        const overlay = document.getElementById('profileOverlay');
        if (!overlay) return;
        const state = this.ensureProfileState();
        if (!state.open) {
            this.hideProfileOverlay();
            return;
        }
        const body = document.getElementById('profileBody');
        if (!body) return;
        this.setHTMLIfChanged(body, this.renderProfileBody(state));
        // Порядок обязателен: сначала черновые штрихи в свежий слой, потом
        // подписка на указатель — на тот элемент, который сейчас в документе.
        this.renderAutographDraft();
        this.bindAutographSurface();
    }

    renderProfileBody(state) {
        if (state.loading && !state.data) {
            return `<div class="profile-loading"><div class="sk sk-contact"></div><div class="sk sk-contact"></div></div>`;
        }
        if (state.error && !state.data) {
            return `<div class="profile-error">${this.esc(state.error)}</div>`;
        }
        const data = state.data;
        if (!data) return '';

        return `
            ${this.renderProfileHeader(state, data)}
            ${this.renderProfileTabs(state, data)}
            <div class="profile-tab-body">${this.renderProfileTabContent(state, data)}</div>
        `;
    }

    // ------------------------------------------------------------
    // Шапка
    // ------------------------------------------------------------

    renderProfileHeader(state, data) {
        const username = data.username || '';
        const accent = this.safeCssColor(data.accentColor) || '';
        const title = data.displayName || username;
        const counters = [
            { key: 'followers', value: data.followers, label: this.ruPlural(data.followers, 'подписчик', 'подписчика', 'подписчиков') },
            { key: 'following', value: data.following, label: 'подписок' },
            { key: 'friends', value: data.friends, label: this.ruPlural(data.friends, 'друг', 'друга', 'друзей') },
        ];

        return `<header class="profile-head"${accent ? ` style="--profile-accent:${this.esc(accent)}"` : ''}>
            <div class="profile-head-ava">${this.renderAvatarHTML(username, 'avatar-img', username)}</div>
            <div class="profile-head-copy">
                <h2 class="profile-name" id="profileModalName">${this.esc(title)}</h2>
                <div class="profile-handle">@${this.esc(username)}</div>
                ${data.status ? `<div class="profile-status">${this.esc(data.status)}</div>` : ''}
                <div class="profile-counters">
                    ${counters.map(counter => `
                        <span class="profile-counter">
                            <strong>${Number(counter.value) || 0}</strong>
                            <span>${this.esc(counter.label)}</span>
                        </span>
                    `).join('')}
                </div>
            </div>
            <div class="profile-head-actions">${this.renderProfileActions(state, data)}</div>
        </header>`;
    }

    renderProfileActions(state, data) {
        if (data.isSelf) {
            if (state.editing) {
                return `
                    <button class="auth-btn primary" type="button" data-profile-action="save"${state.saving ? ' disabled' : ''}>${state.saving ? 'Сохраняем...' : 'Сохранить'}</button>
                    <button class="btn-flat" type="button" data-profile-action="cancel-edit">Отмена</button>
                `;
            }
            return `<button class="auth-btn primary" type="button" data-profile-action="edit">Редактировать профиль</button>`;
        }

        const followLabel = data.isFollowing ? 'Вы отслеживаете' : 'Отслеживать';
        const busy = state.busy;

        // Кнопка дружбы — одна, но с четырьмя разными состояниями. Показывать
        // «Добавить в друзья» тому, кто уже прислал вам заявку, значило бы
        // отправить встречную вместо простого «принять».
        let friendButton;
        if (data.isFriend) {
            friendButton = `<button class="btn-flat profile-friend-btn is-friend" type="button" data-profile-action="remove-friend">Вы друзья</button>`;
        } else if (data.friendRequest?.direction === 'incoming') {
            friendButton = `
                <button class="auth-btn primary" type="button" data-profile-action="accept-friend" data-request-id="${this.esc(data.friendRequest.id)}">Принять заявку</button>
                <button class="btn-flat" type="button" data-profile-action="decline-friend" data-request-id="${this.esc(data.friendRequest.id)}">Отклонить</button>
            `;
        } else if (data.friendRequest?.direction === 'outgoing') {
            friendButton = `<button class="btn-flat" type="button" data-profile-action="cancel-friend" data-request-id="${this.esc(data.friendRequest.id)}">Заявка отправлена</button>`;
        } else {
            friendButton = `<button class="btn-flat profile-friend-btn" type="button" data-profile-action="add-friend"${busy === 'friend' ? ' disabled' : ''}>Попроситься в друзья</button>`;
        }

        return `
            <button class="auth-btn primary profile-follow-btn${data.isFollowing ? ' following' : ''}" type="button" data-profile-action="toggle-follow"${busy === 'follow' ? ' disabled' : ''}>${this.esc(followLabel)}</button>
            ${friendButton}
            <button class="btn-flat" type="button" data-profile-action="message">Написать</button>
        `;
    }

    // ------------------------------------------------------------
    // Вкладки
    // ------------------------------------------------------------

    profileTabsFor(state, data) {
        const tabs = [
            { key: 'about', label: 'О себе' },
            { key: 'wall', label: 'Стена' },
            { key: 'comments', label: 'Комментарии' },
        ];
        if (data.isSelf) {
            const pending = Number(data.pendingAutographs) || 0;
            tabs.push({ key: 'moderation', label: 'Модерация', badge: pending });
            tabs.push({ key: 'friends', label: 'Друзья', badge: (state.friendRequests?.incoming || []).length });
        }
        return tabs;
    }

    renderProfileTabs(state, data) {
        const tabs = this.profileTabsFor(state, data);
        const active = tabs.some(tab => tab.key === state.tab) ? state.tab : 'about';
        return `<nav class="profile-tabs" role="tablist">
            ${tabs.map(tab => `
                <button class="profile-tab${tab.key === active ? ' active' : ''}" type="button" role="tab" aria-selected="${tab.key === active}" data-profile-tab="${this.esc(tab.key)}">
                    <span>${this.esc(tab.label)}</span>
                    ${tab.badge ? `<span class="profile-tab-badge">${Number(tab.badge)}</span>` : ''}
                </button>
            `).join('')}
        </nav>`;
    }

    renderProfileTabContent(state, data) {
        const tabs = this.profileTabsFor(state, data).map(tab => tab.key);
        const active = tabs.includes(state.tab) ? state.tab : 'about';
        if (active === 'wall') return this.renderProfileWallTab(state, data);
        if (active === 'comments') return this.renderProfileCommentsTab(state, data);
        if (active === 'moderation') return this.renderProfileModerationTab(state, data);
        if (active === 'friends') return this.renderProfileFriendsTab(state, data);
        return this.renderProfileAboutTab(state, data);
    }

    // ------------------------------------------------------------
    // Вкладка «О себе» (просмотр и редактирование)
    // ------------------------------------------------------------

    renderProfileAboutTab(state, data) {
        if (state.editing && data.isSelf) return this.renderProfileEditor(state);

        const links = Array.isArray(data.links) ? data.links : [];
        const rows = [
            data.location ? { label: 'Где', value: data.location } : null,
        ].filter(Boolean);

        return `<div class="profile-about">
            ${data.bio
                ? `<p class="profile-bio">${this.esc(data.bio)}</p>`
                : `<p class="profile-bio muted">${data.isSelf ? 'Расскажите о себе — нажмите «Редактировать профиль».' : 'Пользователь пока ничего о себе не написал.'}</p>`}
            ${rows.length ? `<dl class="profile-facts">${rows.map(row => `
                <div class="profile-fact"><dt>${this.esc(row.label)}</dt><dd>${this.esc(row.value)}</dd></div>
            `).join('')}</dl>` : ''}
            ${links.length ? `<ul class="profile-links">${links.map(link => `
                <li><a href="${this.esc(link.url)}" target="_blank" rel="noopener noreferrer">${this.esc(link.label || link.url)}</a></li>
            `).join('')}</ul>` : ''}
            <div class="profile-policy-summary">
                <span class="profile-policy-chip">Комментарии: <strong>${this.esc(this.audienceLabel(data.commentPolicy))}</strong></span>
                <span class="profile-policy-chip">Автографы: <strong>${this.esc(this.audienceLabel(data.autographPolicy))}</strong></span>
                <span class="profile-policy-chip">Одобрение: <strong>${this.esc(this.audienceLabel(data.autographAutoApprove))}</strong></span>
            </div>
        </div>`;
    }

    renderAudienceSelect(name, value, options) {
        return `<select class="profile-select" data-profile-field="${this.esc(name)}">
            ${options.map(option => `<option value="${this.esc(option.value)}"${option.value === value ? ' selected' : ''}>${this.esc(option.label)}</option>`).join('')}
        </select>`;
    }

    renderProfileEditor(state) {
        const draft = state.draft || this.profileDraftFrom(state.data);
        const links = Array.isArray(draft.links) ? draft.links : [];
        return `<div class="profile-editor">
            ${state.error ? `<p class="profile-error">${this.esc(state.error)}</p>` : ''}
            <label class="profile-field">
                <span>Отображаемое имя</span>
                <input type="text" maxlength="64" data-profile-field="displayName" value="${this.esc(draft.displayName || '')}" placeholder="${this.esc(state.username)}">
            </label>
            <label class="profile-field">
                <span>Статус</span>
                <input type="text" maxlength="120" data-profile-field="status" value="${this.esc(draft.status || '')}" placeholder="Чем занимаетесь">
            </label>
            <label class="profile-field">
                <span>О себе</span>
                <textarea rows="4" maxlength="600" data-profile-field="bio" placeholder="Пара слов о вас">${this.esc(draft.bio || '')}</textarea>
            </label>
            <label class="profile-field">
                <span>Где вы</span>
                <input type="text" maxlength="64" data-profile-field="location" value="${this.esc(draft.location || '')}" placeholder="Город">
            </label>
            <div class="profile-field">
                <span>Аватар</span>
                <div class="profile-avatar-editor">
                    <div class="ava profile-avatar-preview">${this.renderAvatarHTML(state.username, 'avatar-img', state.username)}</div>
                    <button class="btn-flat" type="button" data-profile-action="change-avatar">Сменить картинку</button>
                </div>
            </div>
            <label class="profile-field profile-field-color">
                <span>Акцентный цвет</span>
                <input type="color" data-profile-field="accentColor" value="${this.esc(this.safeCssColor(draft.accentColor) || '#cbff00')}">
            </label>

            <div class="profile-field">
                <span>Ссылки</span>
                <div class="profile-links-editor">
                    ${links.map((link, index) => `
                        <div class="profile-link-row">
                            <input type="text" maxlength="48" placeholder="Название" data-profile-link-field="label" data-profile-link-index="${index}" value="${this.esc(link.label || '')}">
                            <input type="url" maxlength="300" placeholder="https://" data-profile-link-field="url" data-profile-link-index="${index}" value="${this.esc(link.url || '')}">
                            <button class="profile-link-remove" type="button" data-profile-action="remove-link" data-profile-link-index="${index}" aria-label="Удалить ссылку">${this.uiIcon('close')}</button>
                        </div>
                    `).join('')}
                    ${links.length < 6 ? `<button class="btn-flat" type="button" data-profile-action="add-link">Добавить ссылку</button>` : ''}
                </div>
                <small class="profile-help">Принимаются только http/https-ссылки.</small>
            </div>

            <div class="profile-policies">
                <label class="profile-field">
                    <span>Кто может комментировать</span>
                    ${this.renderAudienceSelect('commentPolicy', draft.commentPolicy, ZaliInterface.audienceOptions)}
                </label>
                <label class="profile-field">
                    <span>Кто может оставлять автографы</span>
                    ${this.renderAudienceSelect('autographPolicy', draft.autographPolicy, ZaliInterface.audienceOptions)}
                </label>
                <label class="profile-field">
                    <span>Чьи автографы публиковать сразу</span>
                    ${this.renderAudienceSelect('autographAutoApprove', draft.autographAutoApprove, ZaliInterface.autoApproveOptions)}
                    <small class="profile-help">«Одобряю сам» — каждый автограф ждёт вашего «да» на вкладке «Модерация».</small>
                </label>
            </div>
        </div>`;
    }

    // ------------------------------------------------------------
    // Вкладка «Стена»
    // ------------------------------------------------------------

    renderProfileWallTab(state, data) {
        const drawing = state.drawing;
        const canDraw = !!data.canAutograph;

        const toolbar = drawing
            ? `<div class="autograph-toolbar">
                <div class="autograph-colors" role="group" aria-label="Цвет">
                    ${ZaliInterface.autographPalette.map(color => `
                        <button class="autograph-color${color === drawing.color ? ' active' : ''}" type="button" data-autograph-color="${this.esc(color)}" style="--swatch:${this.esc(color)}" aria-label="Цвет ${this.esc(color)}"></button>
                    `).join('')}
                </div>
                <label class="autograph-width">
                    <span>Толщина</span>
                    <input type="range" min="1" max="24" step="1" value="${Number(drawing.width) || 4}" data-autograph-width class="settings-range">
                </label>
                <div class="autograph-tool-actions">
                    <button class="btn-flat" type="button" data-profile-action="undo-stroke">Отменить штрих</button>
                    <button class="btn-flat" type="button" data-profile-action="clear-strokes">Очистить</button>
                    <button class="btn-flat" type="button" data-profile-action="cancel-drawing">Выйти</button>
                    <button class="auth-btn primary" type="button" data-profile-action="submit-autograph"${drawing.submitting ? ' disabled' : ''}>${drawing.submitting ? 'Отправляем...' : 'Оставить автограф'}</button>
                </div>
                ${drawing.error ? `<p class="profile-error">${this.esc(drawing.error)}</p>` : ''}
                <p class="profile-help">Рисуйте прямо на стене в любом месте — автограф сохранится вектором.</p>
            </div>`
            : `<div class="autograph-toolbar">
                ${canDraw
                    ? `<button class="auth-btn primary" type="button" data-profile-action="start-drawing">Оставить автограф</button>`
                    : `<p class="profile-help">${this.esc(data.isSelf ? 'Это ваша стена — здесь появляются автографы других людей.' : 'Владелец закрыл автографы для вас.')}</p>`}
                ${canDraw && !data.isSelf && data.autographAutoApprove === 'nobody'
                    ? `<span class="profile-policy-chip">Автографы публикуются после одобрения владельца</span>`
                    : ''}
            </div>`;

        return `<div class="profile-wall">
            ${toolbar}
            ${this.renderAutographWall()}
            ${this.renderWallLegend(state)}
        </div>`;
    }

    /** Подписи под стеной: кто оставил автограф и чем его можно убрать. */
    renderWallLegend(state) {
        const list = Array.isArray(state.autographs) ? state.autographs : [];
        if (!list.length) return '';
        return `<ul class="autograph-legend">
            ${list.map(item => `
                <li>
                    <span class="autograph-legend-author">${this.esc(item.author || '')}</span>
                    <span class="autograph-legend-date">${this.esc(this.profileTimestampLabel(item.createdAt))}</span>
                    ${item.canRemove ? `<button class="profile-link-remove" type="button" data-profile-action="remove-autograph" data-autograph-id="${this.esc(item.id)}" aria-label="Убрать автограф">${this.uiIcon('close')}</button>` : ''}
                </li>
            `).join('')}
        </ul>`;
    }

    // ------------------------------------------------------------
    // Вкладка «Комментарии»
    // ------------------------------------------------------------

    renderProfileCommentsTab(state, data) {
        const comments = Array.isArray(state.comments) ? state.comments : [];
        const composer = data.canComment
            ? `<div class="profile-comment-composer">
                <textarea rows="3" maxlength="2000" data-profile-field="commentDraft" placeholder="Написать комментарий">${this.esc(state.commentDraft || '')}</textarea>
                <div class="profile-comment-actions">
                    ${state.commentError ? `<span class="profile-error">${this.esc(state.commentError)}</span>` : '<span></span>'}
                    <button class="auth-btn primary" type="button" data-profile-action="submit-comment"${state.busy === 'comment' ? ' disabled' : ''}>Отправить</button>
                </div>
            </div>`
            : `<p class="profile-help">Владелец разрешил комментарии только для группы «${this.esc(this.audienceLabel(data.commentPolicy))}».</p>`;

        return `<div class="profile-comments">
            ${composer}
            ${state.commentsLoading && !comments.length ? '<div class="sk sk-contact"></div>' : ''}
            ${comments.length
                ? `<ul class="profile-comment-list">${comments.map(comment => `
                    <li class="profile-comment" data-comment-id="${this.esc(comment.id)}">
                        <div class="profile-comment-ava" data-profile-open="${this.esc(comment.author)}">${this.renderAvatarHTML(comment.author, 'avatar-img', comment.author)}</div>
                        <div class="profile-comment-body">
                            <div class="profile-comment-head">
                                <span class="profile-comment-author" data-profile-open="${this.esc(comment.author)}">${this.esc(comment.author)}</span>
                                <span class="profile-comment-date">${this.esc(this.profileTimestampLabel(comment.createdAt))}</span>
                                ${comment.canDelete ? `<button class="profile-link-remove" type="button" data-profile-action="delete-comment" data-comment-id="${this.esc(comment.id)}" aria-label="Удалить комментарий">${this.uiIcon('close')}</button>` : ''}
                            </div>
                            <p class="profile-comment-text">${this.esc(comment.body)}</p>
                        </div>
                    </li>
                `).join('')}</ul>`
                : (!state.commentsLoading ? '<p class="profile-help">Комментариев пока нет.</p>' : '')}
        </div>`;
    }

    // ------------------------------------------------------------
    // Вкладка «Модерация» (только владелец)
    // ------------------------------------------------------------

    renderProfileModerationTab(state) {
        const pending = Array.isArray(state.pendingAutographs) ? state.pendingAutographs : [];
        if (!pending.length) {
            return `<p class="profile-help">Неодобренных автографов нет. Всё, что приходит, появится здесь — по одному, с кнопками «да» и «нет».</p>`;
        }
        return `<div class="profile-moderation">
            <p class="profile-help">Ниже — автографы, ждущие вашего решения. Одобренные попадут на стену, отклонённые исчезнут.</p>
            <ul class="moderation-list">
                ${pending.map(item => `
                    <li class="moderation-card">
                        <div class="moderation-preview">${this.renderAutographPreview(item)}</div>
                        <div class="moderation-meta">
                            <span class="moderation-author">${this.esc(item.author || '')}</span>
                            <span class="moderation-date">${this.esc(this.profileTimestampLabel(item.createdAt))}</span>
                        </div>
                        <div class="moderation-actions">
                            <button class="auth-btn primary" type="button" data-profile-action="approve-autograph" data-autograph-id="${this.esc(item.id)}">Да</button>
                            <button class="btn-flat" type="button" data-profile-action="reject-autograph" data-autograph-id="${this.esc(item.id)}">Нет</button>
                        </div>
                    </li>
                `).join('')}
            </ul>
        </div>`;
    }

    // ------------------------------------------------------------
    // Вкладка «Друзья» (только свой профиль)
    // ------------------------------------------------------------

    renderProfileFriendsTab(state) {
        const incoming = state.friendRequests?.incoming || [];
        const outgoing = state.friendRequests?.outgoing || [];
        const friends = state.friends || [];

        return `<div class="profile-friends">
            <section class="profile-friends-block">
                <h3>Пригласить в друзья</h3>
                <div class="profile-invite">
                    <input type="text" placeholder="Имя пользователя" data-profile-field="inviteDraft" value="${this.esc(state.inviteDraft || '')}" autocomplete="off">
                    <button class="auth-btn primary" type="button" data-profile-action="send-invite">Отправить</button>
                </div>
                ${state.inviteStatus ? `<p class="profile-help">${this.esc(state.inviteStatus)}</p>` : ''}
            </section>

            <section class="profile-friends-block">
                <h3>Входящие заявки${incoming.length ? ` (${incoming.length})` : ''}</h3>
                ${incoming.length
                    ? `<ul class="profile-people">${incoming.map(request => `
                        <li class="profile-person">
                            <div class="profile-person-ava" data-profile-open="${this.esc(request.requester)}">${this.renderAvatarHTML(request.requester, 'avatar-img', request.requester)}</div>
                            <div class="profile-person-copy">
                                <span class="profile-person-name" data-profile-open="${this.esc(request.requester)}">${this.esc(request.requester)}</span>
                                ${request.message ? `<span class="profile-person-note">${this.esc(request.message)}</span>` : ''}
                            </div>
                            <div class="profile-person-actions">
                                <button class="auth-btn primary" type="button" data-profile-action="accept-friend" data-request-id="${this.esc(request.id)}">Принять</button>
                                <button class="btn-flat" type="button" data-profile-action="decline-friend" data-request-id="${this.esc(request.id)}">Отклонить</button>
                            </div>
                        </li>
                    `).join('')}</ul>`
                    : '<p class="profile-help">Новых заявок нет.</p>'}
            </section>

            <section class="profile-friends-block">
                <h3>Отправленные заявки${outgoing.length ? ` (${outgoing.length})` : ''}</h3>
                ${outgoing.length
                    ? `<ul class="profile-people">${outgoing.map(request => `
                        <li class="profile-person">
                            <div class="profile-person-ava" data-profile-open="${this.esc(request.target)}">${this.renderAvatarHTML(request.target, 'avatar-img', request.target)}</div>
                            <div class="profile-person-copy">
                                <span class="profile-person-name" data-profile-open="${this.esc(request.target)}">${this.esc(request.target)}</span>
                                <span class="profile-person-note">Ждём ответа</span>
                            </div>
                            <div class="profile-person-actions">
                                <button class="btn-flat" type="button" data-profile-action="cancel-friend" data-request-id="${this.esc(request.id)}">Отозвать</button>
                            </div>
                        </li>
                    `).join('')}</ul>`
                    : '<p class="profile-help">Вы никому не отправляли заявок.</p>'}
            </section>

            <section class="profile-friends-block">
                <h3>Друзья${friends.length ? ` (${friends.length})` : ''}</h3>
                ${friends.length
                    ? `<ul class="profile-people">${friends.map(friend => `
                        <li class="profile-person">
                            <div class="profile-person-ava" data-profile-open="${this.esc(friend)}">${this.renderAvatarHTML(friend, 'avatar-img', friend)}</div>
                            <div class="profile-person-copy">
                                <span class="profile-person-name" data-profile-open="${this.esc(friend)}">${this.esc(friend)}</span>
                            </div>
                            <div class="profile-person-actions">
                                <button class="btn-flat" type="button" data-profile-action="remove-friend-named" data-username="${this.esc(friend)}">Удалить</button>
                            </div>
                        </li>
                    `).join('')}</ul>`
                    : '<p class="profile-help">Пока никого.</p>'}
            </section>
        </div>`;
    }

    // ------------------------------------------------------------
    // События оверлея
    // ------------------------------------------------------------

    /**
     * Один делегированный слушатель на весь оверлей — разметка перерисовывается
     * целиком, и вешать обработчики на кнопки поштучно значило бы перевешивать
     * их после каждого рендера (и терять при первом же пропущенном вызове).
     * Вызывается один раз из bindEvents().
     */
    bindProfileEvents() {
        const overlay = document.getElementById('profileOverlay');
        if (!overlay || overlay.dataset.profileBound === '1') return;
        overlay.dataset.profileBound = '1';

        overlay.addEventListener('click', (event) => {
            // Клик по затемнению, а не по карточке — закрыть.
            if (event.target === overlay) {
                this.closeProfile();
                return;
            }
            if (event.target.closest('#profileCloseBtn')) {
                this.closeProfile();
                return;
            }

            const openTarget = event.target.closest('[data-profile-open]');
            if (openTarget) {
                const name = openTarget.getAttribute('data-profile-open');
                if (name) void this.openProfile(name);
                return;
            }

            const tabBtn = event.target.closest('[data-profile-tab]');
            if (tabBtn) {
                this.setProfileTab(tabBtn.getAttribute('data-profile-tab'));
                return;
            }

            const colorBtn = event.target.closest('[data-autograph-color]');
            if (colorBtn) {
                this.setAutographColor(colorBtn.getAttribute('data-autograph-color'));
                return;
            }

            const actionBtn = event.target.closest('[data-profile-action]');
            if (!actionBtn) return;
            this.handleProfileAction(actionBtn.getAttribute('data-profile-action'), actionBtn);
        });

        // input — для текста и ползунков, change — для select и палитры цвета
        // (в них input тоже приходит, но change гарантирован везде).
        overlay.addEventListener('input', (event) => this.handleProfileInput(event));
        overlay.addEventListener('change', (event) => this.handleProfileInput(event));

        overlay.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeProfile();
                return;
            }
            // Ctrl/Cmd+Enter отправляет комментарий, как и в композере чата.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                const field = event.target.getAttribute?.('data-profile-field');
                if (field === 'commentDraft') void this.submitProfileComment();
            }
            if (event.key === 'Enter' && event.target.getAttribute?.('data-profile-field') === 'inviteDraft') {
                event.preventDefault();
                void this.submitFriendInvite();
            }
        });
    }

    handleProfileInput(event) {
        const target = event.target;
        if (!target) return;

        const linkIndex = target.getAttribute?.('data-profile-link-index');
        const linkField = target.getAttribute?.('data-profile-link-field');
        if (linkIndex !== null && linkIndex !== undefined && linkField) {
            this.updateProfileDraftLink(Number(linkIndex), linkField, target.value);
            return;
        }

        if (target.hasAttribute?.('data-autograph-width')) {
            this.setAutographWidth(target.value);
            return;
        }

        const field = target.getAttribute?.('data-profile-field');
        if (!field) return;

        if (field === 'commentDraft') {
            // Мимо setProfileState: перерисовка увела бы каретку в конец.
            this.S.profile = { ...this.ensureProfileState(), commentDraft: target.value };
            return;
        }
        if (field === 'inviteDraft') {
            this.S.profile = { ...this.ensureProfileState(), inviteDraft: target.value };
            return;
        }
        if (field.endsWith('Policy') || field === 'autographAutoApprove') {
            // Селекты перерисовывать безопасно и нужно: от них зависят подсказки.
            const state = this.ensureProfileState();
            const draft = { ...(state.draft || this.profileDraftFrom(state.data)) };
            draft[field] = target.value;
            this.setProfileState({ draft });
            return;
        }
        this.updateProfileDraft(field, target.value);
    }

    handleProfileAction(action, element) {
        const state = this.ensureProfileState();
        const requestId = element?.getAttribute('data-request-id') || '';
        const autographId = element?.getAttribute('data-autograph-id') || '';

        switch (action) {
            case 'edit': this.startProfileEditing(); break;
            // Выбор файла живёт в bindSettingsEvents (там же, где кроппер и
            // загрузка); здесь мы только зовём его, чтобы не заводить второй
            // конвейер обработки картинки.
            case 'change-avatar': this.openAvatarPicker?.(); break;
            case 'cancel-edit': this.cancelProfileEditing(); break;
            case 'save': void this.saveProfile(); break;
            case 'add-link': this.addProfileDraftLink(); break;
            case 'remove-link':
                this.removeProfileDraftLink(Number(element?.getAttribute('data-profile-link-index')));
                break;
            case 'toggle-follow': void this.toggleFollow(); break;
            case 'add-friend': void this.requestFriendship(); break;
            case 'accept-friend': void this.respondFriendRequest(requestId, 'accept'); break;
            case 'decline-friend': void this.respondFriendRequest(requestId, 'decline'); break;
            case 'cancel-friend': void this.respondFriendRequest(requestId, 'cancel'); break;
            case 'remove-friend': void this.removeFriend(state.username); break;
            case 'remove-friend-named': void this.removeFriend(element?.getAttribute('data-username')); break;
            case 'send-invite': void this.submitFriendInvite(); break;
            case 'message':
                // Переход в диалог — это уход с профиля, оверлей должен закрыться.
                this.closeProfile();
                this.switchChat(state.username);
                break;
            case 'submit-comment': void this.submitProfileComment(); break;
            case 'delete-comment': void this.deleteProfileComment(element?.getAttribute('data-comment-id')); break;
            case 'start-drawing': this.startAutographDrawing(); break;
            case 'cancel-drawing': this.cancelAutographDrawing(); break;
            case 'undo-stroke': this.undoAutographStroke(); break;
            case 'clear-strokes': this.clearAutographStrokes(); break;
            case 'submit-autograph': void this.submitAutograph(); break;
            case 'approve-autograph': void this.moderateAutograph(autographId, 'approve'); break;
            case 'reject-autograph': void this.moderateAutograph(autographId, 'reject'); break;
            case 'remove-autograph': void this.removeAutograph(autographId); break;
            default: break;
        }
    }

});
