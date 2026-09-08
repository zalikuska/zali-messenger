// --- ZaliInterface: Профили людей: состояние, загрузка, подписки, дружба, комментарии. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Здесь только модель и
// сетевой слой профиля; отрисовка живёт в profile_ui.js, а векторная стена —
// в autographs.js.
//
// Как это устроено:
//
//   - Профиль открывается поверх всего (оверлей), а не как ещё один "view":
//     на профиль тыкают из списка контактов, из шапки чата и прямо из ленты
//     сообщений, и в каждом из этих мест возвращаться нужно ровно туда, откуда
//     пришёл. Оверлей это даёт бесплатно, отдельный экран — нет.
//
//   - Всё состояние профиля лежит в S.profile одним объектом. Комментарии,
//     автографы и очередь модерации грузятся отдельными запросами, но живут
//     в одном месте, чтобы перерисовка была одна на всех.
//
//   - Данные всегда перезапрашиваются при открытии. Кэшировать профиль между
//     открытиями смысла нет (счётчик подписчиков и статус дружбы меняются
//     чужими действиями), а показать вчерашнее «вы не друзья» и спрятать
//     кнопку — хуже, чем моргнуть скелетоном.
ZaliMixin(ZaliInterface, class {

    /** Пустое состояние. Одна точка правды для конструктора и для закрытия. */
    static get emptyProfileState() {
        return {
            open: false,
            username: '',
            loading: false,
            error: '',
            data: null,
            tab: 'wall',
            editing: false,
            /** Черновик формы редактирования — правки видны сразу, но не уходят на сервер до «Сохранить». */
            draft: null,
            saving: false,
            comments: [],
            commentsLoading: false,
            commentDraft: '',
            commentError: '',
            autographs: [],
            pendingAutographs: [],
            autographsLoading: false,
            /** Режим рисования: см. autographs.js. */
            drawing: null,
            friendRequests: { incoming: [], outgoing: [] },
            friends: [],
            inviteDraft: '',
            inviteStatus: '',
            busy: '',
        };
    }

    /**
     * Типы WS-событий профиля. Список держится здесь, а разбор — в
     * handleProfileEvent: транспорт (voice_transport.js) должен уметь отличить
     * «наше» событие от чужого, не зная, что с ним делать.
     */
    static get PROFILE_EVENT_TYPES() {
        return ['friend_request', 'friend_accepted', 'profile_comment', 'profile_autograph', 'profile_follow', 'autograph_approved'];
    }

    /** Варианты аудитории — один список для всех трёх селекторов политики. */
    static get audienceOptions() {
        return [
            { value: 'anyone', label: 'Любые' },
            { value: 'contacts', label: 'Контакты' },
            { value: 'followers', label: 'Отслеживающие' },
            { value: 'friends', label: 'Друзья' },
        ];
    }

    /** То же плюс «решаю сам» — только для автоодобрения автографов. */
    static get autoApproveOptions() {
        return ZaliInterface.audienceOptions.concat([{ value: 'nobody', label: 'Одобряю сам' }]);
    }

    ensureProfileState() {
        if (!this.S.profile) this.S.profile = ZaliInterface.emptyProfileState;
        return this.S.profile;
    }

    setProfileState(partial = {}) {
        this.S.profile = { ...this.ensureProfileState(), ...partial };
        this.renderProfileOverlay();
    }

    audienceLabel(value) {
        const found = ZaliInterface.autoApproveOptions.find(option => option.value === value);
        return found ? found.label : 'Любые';
    }

    // ------------------------------------------------------------
    // Открытие / закрытие
    // ------------------------------------------------------------

    /**
     * Единственная точка входа в профиль. Все клики по аватаркам ведут сюда.
     * @param {string} username
     * @param {{editing?: boolean, tab?: string}} options
     */
    async openProfile(username, { editing = false, tab = '' } = {}) {
        const name = String(username || '').trim();
        if (!name) return;
        if (!this.S.session?.token) {
            this.addLogEntry({ type: 'WARN', msg: 'Профили доступны только после входа', ts: new Date().toLocaleTimeString() });
            return;
        }

        const isSelf = name === this.myName();
        this.setProfileState({
            ...ZaliInterface.emptyProfileState,
            open: true,
            username: name,
            loading: true,
            editing: editing && isSelf,
            tab: tab || 'wall',
        });
        this.showProfileOverlay();
        await this.refreshProfile();
        // Свои заявки в друзья нужны и на чужом профиле: именно там видно
        // «вам уже написали» и есть чем ответить, не уходя со страницы.
        if (isSelf) void this.loadFriendRequests();
        void this.loadProfileComments();
        void this.loadProfileAutographs();
    }

    closeProfile() {
        // Незавершённый рисунок отменяется вместе с оверлеем: держать его в
        // состоянии до следующего открытия — верный способ показать человеку
        // чужие штрихи на другой стене.
        this.cancelAutographDrawing({ silent: true });
        this.hideProfileOverlay();
        this.S.profile = ZaliInterface.emptyProfileState;
    }

    async refreshProfile() {
        const state = this.ensureProfileState();
        const name = state.username;
        if (!name) return;
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.byUsername(name), { interactive: true });
            if (this.ensureProfileState().username !== name) return;
            if (res.status === 404) {
                this.setProfileState({ loading: false, error: 'Пользователь не найден', data: null });
                return;
            }
            if (!res.ok) {
                this.setProfileState({ loading: false, error: 'Не удалось загрузить профиль' });
                return;
            }
            const data = await res.json();
            this.setProfileState({
                loading: false,
                error: '',
                data,
                // Черновик пересобирается из свежих данных только когда форма не
                // открыта — иначе ответ сервера затёр бы то, что человек печатает.
                draft: this.ensureProfileState().editing ? this.ensureProfileState().draft : this.profileDraftFrom(data),
            });
            this.ensureAvatarLoaded(name);
        } catch (e) {
            this.setProfileState({ loading: false, error: 'Не удалось загрузить профиль' });
        }
    }

    profileDraftFrom(data) {
        return {
            displayName: data?.displayName || '',
            bio: data?.bio || '',
            status: data?.status || '',
            location: data?.location || '',
            accentColor: data?.accentColor || '',
            commentPolicy: data?.commentPolicy || 'anyone',
            autographPolicy: data?.autographPolicy || 'anyone',
            autographAutoApprove: data?.autographAutoApprove || 'nobody',
            links: Array.isArray(data?.links) ? data.links.map(link => ({ ...link })) : [],
        };
    }

    setProfileTab(tab) {
        const next = String(tab || '').trim();
        if (!next) return;
        this.setProfileState({ tab: next });
        if (next === 'moderation') void this.loadPendingAutographs();
        if (next === 'friends') void this.loadFriendRequests();
    }

    // ------------------------------------------------------------
    // Редактирование своего профиля
    // ------------------------------------------------------------

    startProfileEditing() {
        const state = this.ensureProfileState();
        if (!state.data?.isSelf) return;
        this.setProfileState({ editing: true, draft: this.profileDraftFrom(state.data) });
    }

    cancelProfileEditing() {
        const state = this.ensureProfileState();
        this.setProfileState({ editing: false, draft: this.profileDraftFrom(state.data) });
    }

    updateProfileDraft(field, value) {
        const state = this.ensureProfileState();
        const draft = { ...(state.draft || this.profileDraftFrom(state.data)) };
        draft[field] = value;
        // Без перерисовки: поле уже содержит то, что напечатали, а повторный
        // рендер увёл бы каретку в конец строки на каждом символе.
        this.S.profile = { ...state, draft };
    }

    updateProfileDraftLink(index, field, value) {
        const state = this.ensureProfileState();
        const draft = { ...(state.draft || this.profileDraftFrom(state.data)) };
        const links = Array.isArray(draft.links) ? draft.links.map(link => ({ ...link })) : [];
        if (!links[index]) return;
        links[index][field] = value;
        draft.links = links;
        this.S.profile = { ...state, draft };
    }

    addProfileDraftLink() {
        const state = this.ensureProfileState();
        const draft = { ...(state.draft || this.profileDraftFrom(state.data)) };
        const links = Array.isArray(draft.links) ? draft.links.map(link => ({ ...link })) : [];
        if (links.length >= 6) return;
        links.push({ label: '', url: '' });
        this.setProfileState({ draft: { ...draft, links } });
    }

    removeProfileDraftLink(index) {
        const state = this.ensureProfileState();
        const draft = { ...(state.draft || this.profileDraftFrom(state.data)) };
        const links = (Array.isArray(draft.links) ? draft.links : []).filter((_, i) => i !== index);
        this.setProfileState({ draft: { ...draft, links } });
    }

    async saveProfile() {
        const state = this.ensureProfileState();
        if (!state.data?.isSelf || state.saving) return;
        const draft = state.draft || this.profileDraftFrom(state.data);
        this.setProfileState({ saving: true, error: '' });
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.update, {
                method: 'PUT',
                interactive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    displayName: draft.displayName || '',
                    bio: draft.bio || '',
                    status: draft.status || '',
                    location: draft.location || '',
                    accentColor: draft.accentColor || '',
                    commentPolicy: draft.commentPolicy || 'anyone',
                    autographPolicy: draft.autographPolicy || 'anyone',
                    autographAutoApprove: draft.autographAutoApprove || 'nobody',
                    links: (draft.links || []).filter(link => String(link.url || '').trim()),
                }),
            });
            if (!res.ok) {
                const message = await res.text().catch(() => '');
                this.setProfileState({ saving: false, error: message || 'Не удалось сохранить профиль' });
                return;
            }
            const data = await res.json();
            this.setProfileState({ saving: false, editing: false, data, draft: this.profileDraftFrom(data), error: '' });
            this.addLogEntry({ type: 'SUCCESS', msg: 'Профиль сохранён', ts: new Date().toLocaleTimeString() });
        } catch (e) {
            this.setProfileState({ saving: false, error: 'Не удалось сохранить профиль' });
        }
    }

    // ------------------------------------------------------------
    // Подписки и дружба
    // ------------------------------------------------------------

    /**
     * Подписка/отписка. Ответ сервера — уже готовый профиль со свежими
     * счётчиками, поэтому локально ничего досчитывать не надо (и разъехаться
     * с сервером на гонке двух кликов тоже не получится).
     */
    async toggleFollow(username = '') {
        const state = this.ensureProfileState();
        const name = String(username || state.username || '').trim();
        if (!name || state.busy === 'follow') return;
        const following = name === state.username ? !!state.data?.isFollowing : false;
        this.setProfileState({ busy: 'follow' });
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.follow(name), {
                method: following ? 'DELETE' : 'POST',
                interactive: true,
            });
            if (!res.ok) {
                this.setProfileState({ busy: '', error: 'Не удалось изменить подписку' });
                return;
            }
            const data = await res.json();
            if (this.ensureProfileState().username === name) {
                this.setProfileState({ busy: '', data, error: '' });
            } else {
                this.setProfileState({ busy: '' });
            }
            this.addLogEntry({
                type: 'INFO',
                msg: following ? `Вы отписались от ${name}` : `Вы подписались на ${name}`,
                ts: new Date().toLocaleTimeString(),
            });
        } catch (e) {
            this.setProfileState({ busy: '', error: 'Не удалось изменить подписку' });
        }
    }

    /** Подписка из контекстного меню — вне профиля, без его состояния. */
    async followUserDirect(username, unfollow = false) {
        const name = String(username || '').trim();
        if (!name) return;
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.follow(name), {
                method: unfollow ? 'DELETE' : 'POST',
                interactive: true,
            });
            this.addLogEntry({
                type: res.ok ? 'SUCCESS' : 'ERROR',
                msg: res.ok
                    ? (unfollow ? `Вы отписались от ${name}` : `Вы подписались на ${name}`)
                    : `Не удалось изменить подписку на ${name}`,
                ts: new Date().toLocaleTimeString(),
            });
            if (res.ok && this.ensureProfileState().username === name) await this.refreshProfile();
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: `Не удалось изменить подписку на ${name}`, ts: new Date().toLocaleTimeString() });
        }
    }

    /**
     * Отправить заявку в друзья. Сервер сам сводит встречные заявки в дружбу,
     * поэтому здесь достаточно различить два его ответа.
     */
    async requestFriendship(username = '') {
        const state = this.ensureProfileState();
        const name = String(username || state.username || '').trim();
        if (!name || state.busy === 'friend') return;
        this.setProfileState({ busy: 'friend' });
        try {
            const res = await this.apiFetch(this.apiRoutes.friends.requests, {
                method: 'POST',
                interactive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: name }),
            });
            if (!res.ok) {
                const message = await res.text().catch(() => '');
                this.setProfileState({ busy: '', error: message || 'Не удалось отправить заявку' });
                return;
            }
            const body = await res.json().catch(() => ({}));
            this.addLogEntry({
                type: 'SUCCESS',
                msg: body?.status === 'accepted' ? `Теперь вы друзья с ${name}` : `Заявка в друзья отправлена: ${name}`,
                ts: new Date().toLocaleTimeString(),
            });
            this.setProfileState({ busy: '' });
            if (this.ensureProfileState().username === name) await this.refreshProfile();
            void this.loadFriendRequests();
        } catch (e) {
            this.setProfileState({ busy: '', error: 'Не удалось отправить заявку' });
        }
    }

    async respondFriendRequest(requestId, action) {
        const id = String(requestId || '').trim();
        if (!id) return;
        try {
            const res = await this.apiFetch(this.apiRoutes.friends.request(id), {
                method: 'POST',
                interactive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
            });
            if (!res.ok) {
                this.setProfileState({ error: 'Не удалось обработать заявку' });
                return;
            }
            const body = await res.json().catch(() => ({}));
            if (body?.status === 'accepted' && body?.friend) {
                this.addLogEntry({ type: 'SUCCESS', msg: `Теперь вы друзья с ${body.friend}`, ts: new Date().toLocaleTimeString() });
            }
            await this.loadFriendRequests();
            if (this.ensureProfileState().username) await this.refreshProfile();
        } catch (e) {
            this.setProfileState({ error: 'Не удалось обработать заявку' });
        }
    }

    async removeFriend(username) {
        const name = String(username || '').trim();
        if (!name) return;
        try {
            const res = await this.apiFetch(this.apiRoutes.friends.byUsername(name), {
                method: 'DELETE',
                interactive: true,
            });
            if (!res.ok) return;
            await this.loadFriendRequests();
            if (this.ensureProfileState().username) await this.refreshProfile();
        } catch (e) {
            // Молча: список всё равно перечитается при следующем открытии.
        }
    }

    async loadFriendRequests() {
        try {
            const [requestsRes, friendsRes] = await Promise.all([
                this.apiFetch(this.apiRoutes.friends.requests),
                this.apiFetch(this.apiRoutes.friends.list),
            ]);
            const requests = requestsRes.ok ? await requestsRes.json() : { incoming: [], outgoing: [] };
            const friends = friendsRes.ok ? await friendsRes.json() : { friends: [] };
            this.setProfileState({
                friendRequests: {
                    incoming: Array.isArray(requests?.incoming) ? requests.incoming : [],
                    outgoing: Array.isArray(requests?.outgoing) ? requests.outgoing : [],
                },
                friends: Array.isArray(friends?.friends) ? friends.friends : [],
            });
            this.updateFriendRequestBadge();
        } catch (e) {
            // Не критично: заявки перечитаются при следующем открытии вкладки.
        }
    }

    /** Отправить приглашение в друзья по имени из формы «Пригласить». */
    async submitFriendInvite() {
        const state = this.ensureProfileState();
        const name = String(state.inviteDraft || '').trim();
        if (!name) return;
        if (name === this.myName()) {
            this.setProfileState({ inviteStatus: 'Нельзя пригласить самого себя' });
            return;
        }
        this.setProfileState({ inviteStatus: 'Отправляем...' });
        try {
            const res = await this.apiFetch(this.apiRoutes.friends.requests, {
                method: 'POST',
                interactive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ to: name }),
            });
            if (!res.ok) {
                const message = await res.text().catch(() => '');
                this.setProfileState({ inviteStatus: message || 'Не удалось отправить приглашение' });
                return;
            }
            const body = await res.json().catch(() => ({}));
            this.setProfileState({
                inviteDraft: '',
                inviteStatus: body?.status === 'accepted' ? `Теперь вы друзья с ${name}` : `Приглашение отправлено: ${name}`,
            });
            await this.loadFriendRequests();
        } catch (e) {
            this.setProfileState({ inviteStatus: 'Не удалось отправить приглашение' });
        }
    }

    /**
     * Бейдж «есть входящие заявки» на кнопке своего профиля. Считается по уже
     * загруженному списку, отдельного запроса не делает.
     */
    updateFriendRequestBadge() {
        const badge = document.getElementById('meFriendBadge');
        if (!badge) return;
        const count = (this.ensureProfileState().friendRequests?.incoming || []).length;
        badge.textContent = count > 99 ? '99+' : String(count);
        badge.hidden = count === 0;
    }

    // ------------------------------------------------------------
    // Комментарии
    // ------------------------------------------------------------

    async loadProfileComments() {
        const name = this.ensureProfileState().username;
        if (!name) return;
        this.setProfileState({ commentsLoading: true });
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.comments(name));
            if (this.ensureProfileState().username !== name) return;
            if (!res.ok) {
                this.setProfileState({ commentsLoading: false, comments: [] });
                return;
            }
            const body = await res.json();
            this.setProfileState({
                commentsLoading: false,
                comments: Array.isArray(body?.comments) ? body.comments : [],
            });
            (body?.comments || []).forEach(comment => this.ensureAvatarLoaded(comment.author));
        } catch (e) {
            this.setProfileState({ commentsLoading: false });
        }
    }

    async submitProfileComment() {
        const state = this.ensureProfileState();
        const name = state.username;
        const body = String(state.commentDraft || '').trim();
        if (!name || !body || state.busy === 'comment') return;
        this.setProfileState({ busy: 'comment', commentError: '' });
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.comments(name), {
                method: 'POST',
                interactive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ body }),
            });
            if (res.status === 403) {
                this.setProfileState({ busy: '', commentError: 'Владелец закрыл комментарии для вас' });
                return;
            }
            if (!res.ok) {
                this.setProfileState({ busy: '', commentError: 'Не удалось отправить комментарий' });
                return;
            }
            const payload = await res.json();
            this.setProfileState({
                busy: '',
                commentDraft: '',
                commentError: '',
                comments: Array.isArray(payload?.comments) ? payload.comments : state.comments,
            });
        } catch (e) {
            this.setProfileState({ busy: '', commentError: 'Не удалось отправить комментарий' });
        }
    }

    async deleteProfileComment(commentId) {
        const id = String(commentId || '').trim();
        if (!id) return;
        const state = this.ensureProfileState();
        // Оптимистично: строка исчезает сразу, при ошибке список перечитывается.
        this.setProfileState({ comments: (state.comments || []).filter(comment => comment.id !== id) });
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.comment(id), {
                method: 'DELETE',
                interactive: true,
            });
            if (!res.ok) await this.loadProfileComments();
        } catch (e) {
            await this.loadProfileComments();
        }
    }

    // ------------------------------------------------------------
    // Живые события с сервера
    // ------------------------------------------------------------

    /**
     * WS-события профиля (заявка в друзья, новый комментарий, новый автограф).
     * Вызывается из общего разбора входящих событий; неизвестные типы сюда
     * не доходят.
     */
    handleProfileEvent(event = {}) {
        const type = String(event?.type || '');
        const from = String(event?.from || '').trim();
        const state = this.ensureProfileState();

        if (type === 'friend_request') {
            this.addLogEntry({ type: 'INFO', msg: `Заявка в друзья от ${from}`, ts: new Date().toLocaleTimeString() });
            void this.loadFriendRequests();
        } else if (type === 'friend_accepted') {
            this.addLogEntry({ type: 'SUCCESS', msg: `${from} теперь ваш друг`, ts: new Date().toLocaleTimeString() });
            void this.loadFriendRequests();
        } else if (type === 'autograph_approved') {
            this.addLogEntry({ type: 'SUCCESS', msg: `Ваш автограф одобрен: ${event?.wall || ''}`, ts: new Date().toLocaleTimeString() });
        }

        if (!state.open) return;
        // Открыт как раз тот профиль, которого касается событие — обновляем.
        const mine = state.username === this.myName();
        if (type === 'profile_comment' && mine) void this.loadProfileComments();
        if (type === 'profile_autograph' && mine) {
            void this.refreshProfile();
            void this.loadPendingAutographs();
        }
        if ((type === 'profile_follow' || type === 'friend_accepted' || type === 'friend_request') && mine) {
            void this.refreshProfile();
        }
    }

});
