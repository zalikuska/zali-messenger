// --- ZaliInterface: Модалка настроек сервера: роли, каналы, участники, инвайты. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    canManageServer(server = null) {
        const current = server || this.currentServer();
        const role = this.normalizeMemberRole(current?.myRole || current?.my_role || '');
        return role === 'owner' || role === 'admin';
    }

    openServerOverlay() {
        const overlay = document.getElementById('serverOverlay');
        if (overlay) {
            overlay.hidden = false;
            requestAnimationFrame(() => overlay.classList.add('visible'));
        }
    }

    closeServerOverlay() {
        const overlay = document.getElementById('serverOverlay');
        if (overlay) {
            overlay.classList.remove('visible');
            setTimeout(() => {
                overlay.hidden = true;
            }, 180);
        }
    }

    setServerModalState(partial = {}) {
        this.S.serverModal = {
            ...this.S.serverModal,
            ...partial,
        };
    }

    serverModalSectionsForMode(mode = this.S.serverModal.mode) {
        if (mode === 'discover') return ['discover'];
        if (mode === 'edit') return ['overview', 'channels', 'roles', 'members'];
        return ['overview', 'channels', 'roles', 'members'];
    }

    serverModalDefaultSection(mode = this.S.serverModal.mode) {
        return mode === 'discover' ? 'discover' : 'overview';
    }

    serverModalActiveSection(mode = this.S.serverModal.mode) {
        const allowed = this.serverModalSectionsForMode(mode);
        const current = String(this.S.serverModal.activeSection || '').trim() || this.serverModalDefaultSection(mode);
        return allowed.includes(current) ? current : this.serverModalDefaultSection(mode);
    }

    setServerModalSection(section) {
        const next = String(section || '').trim();
        if (!next) return;
        const allowed = this.serverModalSectionsForMode();
        if (!allowed.includes(next)) return;
        if (this.S.serverModal.activeSection === next) return;
        this.setServerModalState({ activeSection: next });
        this.renderServerModal();
    }

    renderServerModalMembers() {
        const list = document.getElementById('serverMembersList');
        const count = document.getElementById('serverMembersCount');
        const server = this.currentServer();
        const members = Array.isArray(this.S.serverModal.members) ? this.S.serverModal.members : [];
        const canManage = this.canManageServer(server);
        if (count) count.textContent = String(members.length || 0);
        if (!list) return;
        if (this.S.serverModal.loading && members.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Загрузка участников</div>
                <div class="empty-sub">Подождите секунду</div>
            </div>`;
            return;
        }
        if (this.S.serverModal.mode !== 'edit') {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">После создания</div>
                <div class="empty-sub">Здесь появятся участники и роли</div>
            </div>`;
            return;
        }

        if (members.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Нет участников</div>
                <div class="empty-sub">Добавьте первых участников сервера</div>
            </div>`;
            return;
        }

        list.innerHTML = members.map(member => {
            const role = this.normalizeMemberRole(member.role);
            const isOwner = role === 'owner';
            const joined = member.joinedAt ? this.fmtDate(member.joinedAt) || this.fmtTime(member.joinedAt) : '';
            const select = `
                <select class="settings-input server-member-role" data-member-role="${this.esc(member.username)}" ${isOwner ? 'disabled' : ''}>
                    ${isOwner ? '<option value="owner" selected>Владелец</option>' : this.serverRoleOptionsHtml(role)}
                </select>
            `;
            return `<div class="server-member-row ${isOwner ? 'owner' : ''}">
                <div class="server-member-info">
                    <div class="server-member-name">${this.esc(member.username)}</div>
                    <div class="server-member-meta">${this.esc(this.serverRoleLabel(role))}${joined ? ` · ${this.esc(joined)}` : ''}</div>
                </div>
                ${select}
                <button class="server-member-remove" type="button" data-member-remove="${this.esc(member.username)}" ${isOwner || !canManage ? 'disabled' : ''} title="Удалить">×</button>
            </div>`;
        }).join('');
    }

    renderPublicServersModal() {
        const list = document.getElementById('serverDiscoverList');
        const count = document.getElementById('serverDiscoverCount');
        const refreshBtn = document.getElementById('serverDiscoverRefreshBtn');
        const servers = this.renderFilteredPublicServers();
        if (count) count.textContent = String(servers.length || 0);
        if (refreshBtn) refreshBtn.disabled = !!this.S.serverModal.loading;
        if (!list) return;
        if (this.S.serverModal.loading && servers.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Поиск серверов</div>
                <div class="empty-sub">Секунду, подбираем публичные сообщества</div>
            </div>`;
            return;
        }
        if (servers.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Публичных серверов нет</div>
                <div class="empty-sub">Пока что нечего открывать из меню</div>
            </div>`;
            return;
        }

        list.innerHTML = servers.map(server => {
            const memberCount = Number(server.memberCount || server.member_count || 0) || 0;
            const channelCount = Array.isArray(server.channels) ? server.channels.length : 0;
            const role = this.normalizeMemberRole(server.myRole || server.my_role || '');
            const alreadyJoined = role === 'owner' || role === 'admin' || role === 'member';
            const joinTarget = server.joinLink || server.join_link || server.id;
            const actionLabel = alreadyJoined ? 'Открыть' : 'Войти';
            return `<div class="server-discover-row">
                <button class="server-item server-discover-item" type="button" data-public-server-id="${this.esc(server.id)}" title="${this.esc(server.name)}">
                    ${this.renderServerAvatarHTML(server)}
                    <div class="server-meta">
                        <div class="server-name">${this.esc(server.name)}</div>
                        <div class="server-prev">${this.esc(server.description || 'Публичный сервер')}${channelCount ? ` · ${channelCount} каналов` : ''}${memberCount ? ` · ${memberCount} участников` : ''}</div>
                    </div>
                </button>
                <div class="server-discover-actions">
                    <button class="btn-flat" type="button" data-public-server-open="${this.esc(server.id)}">${actionLabel}</button>
                    <button class="btn-flat" type="button" data-public-server-join="${this.esc(joinTarget)}">${alreadyJoined ? 'Перейти' : 'Вступить'}</button>
                </div>
            </div>`;
        }).join('');
    }

    renderServerModal() {
        const server = this.currentServer();
        const mode = this.S.serverModal.mode;
        const isEdit = mode === 'edit';
        const isDiscover = mode === 'discover';
        const activeSection = this.serverModalActiveSection(mode);
        const createDraft = !isEdit && !isDiscover ? this.syncServerCreateDraftFromDom() : null;
        const createDraftView = !isEdit && !isDiscover ? (createDraft || this.serverCreateDraft()) : null;
        const grid = document.querySelector('.server-modal-grid');
        const nav = document.getElementById('serverModalNav');
        const sidebarTitle = document.getElementById('serverModalSidebarTitle');
        const sidebarHint = document.getElementById('serverModalSidebarHint');
        const basicsCard = document.getElementById('serverBasicsCard');
        const channelsCard = document.getElementById('serverChannelsCard');
        const membersCard = document.getElementById('serverMembersCard');
        const discoverCard = document.getElementById('serverDiscoverCard');
        const overviewPanel = document.getElementById('serverOverviewPanel');
        const channelsPanel = document.getElementById('serverChannelsPanel');
        const rolesPanel = document.getElementById('serverRolesPanel');
        const membersPanel = document.getElementById('serverMembersPanel');
        const discoverPanel = document.getElementById('serverDiscoverPanel');
        const title = document.getElementById('serverModalTitle');
        const hint = document.getElementById('serverModalHint');
        const kicker = document.getElementById('serverModalKicker');
        const modeNote = document.getElementById('serverModalModeNote');
        const saveBtn = document.getElementById('serverSaveBtn');
        const deleteBtn = document.getElementById('serverDeleteBtn');
        const serverModalCancel = document.getElementById('serverModalCancel');
        const nameInput = document.getElementById('serverNameInput');
        const descInput = document.getElementById('serverDescriptionInput');
        const iconInput = document.getElementById('serverIconInput');
        const colorInput = document.getElementById('serverColorInput');
        const publicInput = document.getElementById('serverPublicInput');
        const serverMembersList = document.getElementById('serverMembersList');
        const serverRolesCard = document.getElementById('serverRolesCard');
        const serverJoinLinkInput = document.getElementById('serverJoinLinkInput');
        const serverJoinLinkGenerateBtn = document.getElementById('serverJoinLinkGenerateBtn');
        const serverJoinLinkCopyBtn = document.getElementById('serverJoinLinkCopyBtn');
        const serverChannelCreate = document.querySelector('[data-server-channel-create]');
        const serverChannelCreateBody = document.querySelector('[data-server-channel-create-body]');
        const serverChannelCreateToggleBtn = document.getElementById('serverChannelCreateBtn');
        const serverChannelCreateSubmitBtn = document.getElementById('serverChannelCreateSubmitBtn');
        const serverChannelNameInput = document.getElementById('serverChannelNameInput');
        const serverChannelTopicInput = document.getElementById('serverChannelTopicInput');
        const serverChannelKindInput = document.getElementById('serverChannelKindInput');
        const serverAvatarUploadBtn = document.getElementById('serverAvatarUploadBtn');
        const serverAvatarRemoveBtn = document.getElementById('serverAvatarRemoveBtn');
        const serverBannerUploadBtn = document.getElementById('serverBannerUploadBtn');
        const serverBannerRemoveBtn = document.getElementById('serverBannerRemoveBtn');
        const serverRoleNameInput = document.getElementById('serverRoleNameInput');
        const serverRoleColorInput = document.getElementById('serverRoleColorInput');
        const serverRolePermView = document.getElementById('serverRolePermView');
        const serverRolePermSend = document.getElementById('serverRolePermSend');
        const serverRolePermManage = document.getElementById('serverRolePermManage');
        const serverRoleCreate = document.querySelector('[data-server-role-create]');
        const serverRoleCreateBody = document.querySelector('[data-server-role-create-body]');
        const serverRoleCreateToggleBtn = document.getElementById('serverRoleCreateBtn');
        const serverRoleCreateSubmitBtn = document.getElementById('serverRoleCreateSubmitBtn');
        const discoverQuery = document.getElementById('serverDiscoverQuery');
        const errorBox = document.getElementById('serverModalError');
        const canManage = this.canManageServer(server);
        const current = isEdit && this.S.serverModal.serverId
            ? (this.S.servers || []).find(s => s.id === this.S.serverModal.serverId)
            : null;

        this.S.serverModal.activeSection = activeSection;

        if (grid) grid.classList.toggle('is-discover', isDiscover);
        if (basicsCard) basicsCard.hidden = activeSection !== 'overview';
        if (channelsCard) channelsCard.hidden = activeSection !== 'channels';
        if (membersCard) membersCard.hidden = activeSection !== 'members';
        if (serverRolesCard) serverRolesCard.hidden = activeSection !== 'roles';
        if (discoverCard) discoverCard.hidden = activeSection !== 'discover';
        if (overviewPanel) overviewPanel.hidden = activeSection !== 'overview';
        if (channelsPanel) channelsPanel.hidden = activeSection !== 'channels';
        if (rolesPanel) rolesPanel.hidden = activeSection !== 'roles';
        if (membersPanel) membersPanel.hidden = activeSection !== 'members';
        if (discoverPanel) discoverPanel.hidden = activeSection !== 'discover';
        if (nav) {
            nav.querySelectorAll('[data-server-modal-section]').forEach(btn => {
                const section = btn.getAttribute('data-server-modal-section');
                const visible = isDiscover ? section === 'discover' : section !== 'discover';
                btn.hidden = !visible;
                btn.classList.toggle('active', visible && section === activeSection);
            });
        }
        if (sidebarTitle) sidebarTitle.textContent = isEdit ? (current?.name || server?.name || 'Настройки сервера') : isDiscover ? 'Поиск серверов' : 'Создание сервера';
        if (sidebarHint) sidebarHint.textContent = isEdit
            ? (activeSection === 'overview'
                ? 'Основные параметры сервера и внешний вид.'
                : activeSection === 'channels'
                    ? 'Создавайте, редактируйте и удаляйте каналы.'
                    : activeSection === 'roles'
                        ? 'Настройка ролей и прав доступа.'
                        : 'Управление участниками и их ролями.')
            : isDiscover
                ? 'Подберите сервер и войдите в него из каталога.'
                : activeSection === 'roles'
                    ? 'Соберите роли до создания сервера.'
                    : 'Имя, оформление и базовая конфигурация.';
        if (title) title.textContent = isEdit ? 'Настройки сервера' : isDiscover ? 'Публичные серверы' : 'Создать сервер';
        if (hint) hint.textContent = isEdit
            ? (activeSection === 'overview'
                ? 'Переименуйте сервер, измените оформление и код входа.'
                : activeSection === 'channels'
                    ? 'Управляйте каналами сервера.'
                : activeSection === 'roles'
                    ? 'Управляйте ролями и правами доступа.'
                    : 'Добавляйте участников и назначайте им роли.')
            : isDiscover
                ? 'Выберите публичный сервер и войдите в него через меню без автодобавления в список.'
            : activeSection === 'roles'
                ? 'Настройте роли и доступ перед созданием.'
                : 'Настройте имя, оформление и доступ перед созданием.';
        if (kicker) kicker.textContent = isEdit ? 'Settings' : isDiscover ? 'Discover' : 'Creation';
        if (modeNote) modeNote.textContent = isEdit ? 'edit' : isDiscover ? 'browse' : 'create';
        if (saveBtn) {
            saveBtn.hidden = isDiscover;
            saveBtn.textContent = this.S.serverModal.saving ? 'Сохранение...' : (isEdit ? 'Сохранить' : 'Создать');
            saveBtn.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        }
        if (deleteBtn) deleteBtn.hidden = !isEdit || !canManage || this.normalizeMemberRole(current?.myRole || current?.my_role || '') !== 'owner';
        if (serverModalCancel) serverModalCancel.textContent = isDiscover ? 'Закрыть' : 'Отмена';
        if (nameInput) nameInput.value = isEdit ? (current?.name || '') : (createDraftView?.name || '');
        if (descInput) descInput.value = isEdit ? (current?.description || '') : (createDraftView?.description || '');
        if (iconInput) iconInput.value = isEdit ? (current?.icon || '') : (createDraftView?.icon || '');
        const normalizedColor = this.normalizeColorValue(isEdit ? (current?.color || '#cbff00') : (createDraftView?.color || '#cbff00'));
        if (colorInput) colorInput.value = normalizedColor;
        const colorHexInput = document.getElementById('serverColorHexInput');
        if (colorHexInput) colorHexInput.value = normalizedColor;
        const serverColorPickerPreview = document.querySelector('[data-color-picker-key="server-basics"] .color-picker-preview');
        if (serverColorPickerPreview) serverColorPickerPreview.style.background = normalizedColor;
        this.applyColorWheelValue({
            wheel: document.getElementById('serverColorWheel'),
            hidden: colorInput,
            hexInput: colorHexInput,
            value: normalizedColor,
        });
        if (publicInput) publicInput.checked = isEdit ? !!current?.is_public : !!(createDraftView?.isPublic ?? true);
        if (discoverQuery && !discoverQuery.value) {
            discoverQuery.value = '';
        }
        const linkLocked = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        // Медиа выбирается и при создании: файл ждёт в черновике и уезжает сразу
        // после POST (до него у сервера нет id). Раньше здесь кнопки были disabled
        // при создании, но выглядели активными — клик молча не делал ничего.
        const assetLocked = isDiscover || !!this.S.serverModal.saving;
        const pendingAssets = this._serverCreateAssets || {};
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.disabled = assetLocked;
        if (serverAvatarRemoveBtn) serverAvatarRemoveBtn.disabled = assetLocked || (!isEdit && !pendingAssets.avatar);
        if (serverBannerUploadBtn) serverBannerUploadBtn.disabled = assetLocked;
        if (serverBannerRemoveBtn) serverBannerRemoveBtn.disabled = assetLocked || (!isEdit && !pendingAssets.banner);
        if (serverJoinLinkInput) serverJoinLinkInput.disabled = linkLocked;
        if (serverJoinLinkGenerateBtn) serverJoinLinkGenerateBtn.disabled = linkLocked;
        if (serverJoinLinkCopyBtn) serverJoinLinkCopyBtn.disabled = linkLocked;
        if (serverRoleNameInput) serverRoleNameInput.disabled = false;
        if (serverRoleColorInput) serverRoleColorInput.disabled = false;
        const serverRoleColorHexInput = document.getElementById('serverRoleColorHexInput');
        if (serverRoleColorHexInput) serverRoleColorHexInput.disabled = false;
        if (serverRolePermView) serverRolePermView.disabled = false;
        if (serverRolePermSend) serverRolePermSend.disabled = false;
        if (serverRolePermManage) serverRolePermManage.disabled = false;
        const roleCreateOpen = !!this.S.serverModal.roleCreateOpen;
        if (serverRoleCreate) serverRoleCreate.classList.toggle('is-collapsed', !roleCreateOpen);
        if (serverRoleCreateBody) serverRoleCreateBody.hidden = !roleCreateOpen;
        if (serverRoleCreateToggleBtn) serverRoleCreateToggleBtn.textContent = roleCreateOpen ? 'Свернуть' : 'Новая роль';
        if (serverRoleCreateSubmitBtn) serverRoleCreateSubmitBtn.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading || !roleCreateOpen;
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.title = 'Загрузить аватар';
        if (serverAvatarRemoveBtn) serverAvatarRemoveBtn.title = 'Удалить аватар';
        if (serverBannerUploadBtn) serverBannerUploadBtn.title = 'Загрузить баннер';
        if (serverBannerRemoveBtn) serverBannerRemoveBtn.title = 'Удалить баннер';
        if (errorBox) errorBox.textContent = this.S.serverModal.error || '';
        if (serverMembersList) {
            serverMembersList.classList.toggle('is-loading', !!this.S.serverModal.loading);
        }
        const roleSelect = document.getElementById('serverMemberRole');
        if (roleSelect) {
            roleSelect.innerHTML = this.serverRoleOptionsHtml(roleSelect.value || 'member');
        }
        if (serverRoleColorInput) {
            const roleColor = this.normalizeColorValue(serverRoleColorInput.value || '#cbff00');
            serverRoleColorInput.value = roleColor;
            if (serverRoleColorHexInput) serverRoleColorHexInput.value = roleColor;
            const createPicker = document.querySelector('[data-color-picker-key="server-role-create"]');
            const createPickerOpen = this.serverModalColorPickerState('server-role-create');
            const createPickerPreview = createPicker?.querySelector('.color-picker-preview');
            if (createPickerPreview) createPickerPreview.style.background = roleColor;
            if (createPicker) createPicker.classList.toggle('is-collapsed', !createPickerOpen);
            const createPickerToggle = createPicker?.querySelector('[data-color-picker-toggle="server-role-create"]');
            if (createPickerToggle) createPickerToggle.textContent = createPickerOpen ? 'Свернуть' : 'Развернуть';
            const createPickerSub = createPicker?.querySelector('.color-picker-sub');
            if (createPickerSub) createPickerSub.textContent = createPickerOpen ? 'Колесо открыто' : 'Свернуто по умолчанию';
            if (activeSection === 'roles') {
                this.applyColorWheelValue({
                    wheel: document.getElementById('serverRoleColorWheel'),
                    hidden: serverRoleColorInput,
                    hexInput: serverRoleColorHexInput,
                    value: roleColor,
                });
            }
        }
        const channelCreateOpen = !!this.S.serverModal.channelCreateOpen;
        if (serverChannelCreate) serverChannelCreate.classList.toggle('is-collapsed', !channelCreateOpen);
        if (serverChannelCreateBody) serverChannelCreateBody.hidden = !channelCreateOpen;
        if (serverChannelCreateToggleBtn) serverChannelCreateToggleBtn.textContent = channelCreateOpen ? 'Свернуть' : 'Новый канал';
        if (serverChannelCreateSubmitBtn) serverChannelCreateSubmitBtn.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading || !channelCreateOpen;
        if (serverChannelNameInput) serverChannelNameInput.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        if (serverChannelTopicInput) serverChannelTopicInput.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        if (serverChannelKindInput) serverChannelKindInput.disabled = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        const serverColorPicker = document.querySelector('[data-color-picker-key="server-basics"]');
        if (serverColorPicker) {
            const open = this.serverModalColorPickerState('server-basics');
            serverColorPicker.classList.toggle('is-collapsed', !open);
            const toggle = serverColorPicker.querySelector('[data-color-picker-toggle="server-basics"]');
            if (toggle) toggle.textContent = open ? 'Свернуть' : 'Развернуть';
            // The markup is static in index.html, so the sub line has to be kept in
            // step here too — it read «Свернуто по умолчанию» with the wheel open.
            const sub = serverColorPicker.querySelector('.color-picker-sub');
            if (sub) sub.textContent = open ? 'Колесо открыто' : 'Свернуто по умолчанию';
        }
        if (activeSection === 'overview') {
            this.renderServerJoinLink();
        } else if (activeSection === 'channels') {
            this.renderServerChannels();
        } else if (activeSection === 'roles') {
            this.renderServerRoles();
        } else if (activeSection === 'members') {
            this.renderServerModalMembers();
        } else if (activeSection === 'discover') {
            this.renderPublicServersModal();
        }
        if (isEdit && (this.S.serverModal.serverId || server?.id)) {
            this.syncServerAssetPreview(this.S.serverModal.serverId || server?.id || '');
        } else {
            this.resetServerAssetPreview();
            if (!isDiscover) this.applyServerCreateAssetPreview();
        }
    }

    // Файлы, выбранные при создании сервера. Держатся вне S: File не
    // сериализуется, а blob:-ссылку превью надо отзывать при замене.
    setServerCreateAsset(kind, file) {
        const pending = this._serverCreateAssets || (this._serverCreateAssets = {});
        const prev = pending[kind];
        if (prev?.url) {
            try { URL.revokeObjectURL(prev.url); } catch (e) {}
        }
        pending[kind] = file ? { file, url: URL.createObjectURL(file) } : null;
    }

    clearServerCreateAssets() {
        this.setServerCreateAsset('avatar', null);
        this.setServerCreateAsset('banner', null);
    }

    applyServerCreateAssetPreview() {
        const pending = this._serverCreateAssets || {};
        const avatarBox = document.getElementById('serverAvatarPreview');
        const bannerBox = document.getElementById('serverBannerPreview');
        if (avatarBox && pending.avatar) {
            avatarBox.innerHTML = `<img class="avatar-img" src="${this.esc(pending.avatar.url)}" alt="server avatar">`;
        }
        if (bannerBox && pending.banner) {
            bannerBox.textContent = '';
            bannerBox.style.backgroundImage = `url('${this.esc(pending.banner.url)}')`;
            bannerBox.style.backgroundSize = 'cover';
            bannerBox.style.backgroundPosition = 'center';
        }
    }

    async loadServerMembers(serverId) {
        const sid = String(serverId || '').trim();
        if (!sid) return [];
        const res = await this.apiFetch(this.apiRoutes.servers.members(sid));
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось загрузить участников сервера');
        }
        const data = await res.json();
        const members = Array.isArray(data) ? data : (Array.isArray(data?.members) ? data.members : []);
        return members.map(member => ({
            ...member,
            role: this.normalizeMemberRole(member.role),
        }));
    }

    async loadServerRoles(serverId) {
        const sid = String(serverId || '').trim();
        if (!sid) return [];
        const res = await this.apiFetch(this.apiRoutes.servers.roles(sid));
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось загрузить роли сервера');
        }
        const data = await res.json();
        const roles = Array.isArray(data?.roles) ? data.roles : [];
        return roles.map(role => ({
            ...role,
            roleId: String(role.roleId || role.role_id || '').trim(),
            name: String(role.name || '').trim(),
            color: String(role.color || '#cbff00').trim(),
            canView: !!(role.canView ?? role.can_view),
            canSend: !!(role.canSend ?? role.can_send),
            canManage: !!(role.canManage ?? role.can_manage),
            canManageChannels: !!(role.canManageChannels ?? role.can_manage_channels),
            canManageRoles: !!(role.canManageRoles ?? role.can_manage_roles),
            canInvite: !!(role.canInvite ?? role.can_invite),
            canAttach: !!(role.canAttach ?? role.can_attach),
            canEmbed: !!(role.canEmbed ?? role.can_embed),
            canReact: !!(role.canReact ?? role.can_react),
            canPin: !!(role.canPin ?? role.can_pin),
            canMention: !!(role.canMention ?? role.can_mention),
            canVoice: !!(role.canVoice ?? role.can_voice),
            canKick: !!(role.canKick ?? role.can_kick),
            canBan: !!(role.canBan ?? role.can_ban),
            position: Number(role.position || 0) || 0,
        }));
    }

    async loadServerChannels(serverId) {
        const sid = String(serverId || '').trim();
        if (!sid) return [];
        const res = await this.apiFetch(this.apiRoutes.servers.channels(sid));
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось загрузить каналы сервера');
        }
        const data = await res.json();
        const channels = Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []);
        return this.normalizeServerChannels(channels);
    }

    normalizeServerChannels(channels) {
        return (Array.isArray(channels) ? channels : [])
            .filter(Boolean)
            .map((channel, index) => ({
                ...channel,
                id: String(channel.id || '').trim(),
                name: String(channel.name || '').trim(),
                topic: String(channel.topic || '').trim(),
                kind: this.normalizeChannelKind(channel.kind),
                position: Number.isFinite(Number(channel.position)) ? Number(channel.position) : index,
            }))
            .sort((a, b) => Number(a.position || 0) - Number(b.position || 0) || String(a.name || '').localeCompare(String(b.name || '')));
    }

    normalizeChannelKind(kind) {
        return String(kind || 'text').trim().toLowerCase() === 'voice' ? 'voice' : 'text';
    }

    channelKindLabel(kind) {
        return this.normalizeChannelKind(kind) === 'voice' ? 'Голосовой' : 'Текстовый';
    }

    renderServerJoinLink() {
        const input = document.getElementById('serverJoinLinkInput');
        if (!input) return;
        const link = this.S.serverModal.mode === 'create'
            ? (this.serverCreateDraft()?.joinLink || this.S.serverModal.joinLink || '')
            : (this.S.serverModal.joinLink || '');
        input.value = link;
    }

    serverCreateDraftDefaults() {
        return {
            name: '',
            description: '',
            icon: '',
            color: '#cbff00',
            joinLink: '',
            isPublic: true,
        };
    }

    serverCreateDraft() {
        return {
            ...this.serverCreateDraftDefaults(),
            ...(this.S.serverModal.createDraft || {}),
        };
    }

    syncServerCreateDraftFromDom() {
        if (this.S.serverModal.mode !== 'create') {
            return this.serverCreateDraft();
        }
        const current = this.serverCreateDraft();
        const nameInput = document.getElementById('serverNameInput');
        const descInput = document.getElementById('serverDescriptionInput');
        const iconInput = document.getElementById('serverIconInput');
        const colorInput = document.getElementById('serverColorInput');
        const joinLinkInput = document.getElementById('serverJoinLinkInput');
        const publicInput = document.getElementById('serverPublicInput');
        const next = {
            ...current,
            name: String(nameInput?.value ?? current.name ?? ''),
            description: String(descInput?.value ?? current.description ?? ''),
            icon: String(iconInput?.value ?? current.icon ?? ''),
            color: this.normalizeColorValue(colorInput?.value || current.color || '#cbff00'),
            joinLink: String(joinLinkInput?.value ?? current.joinLink ?? ''),
            isPublic: publicInput ? !!publicInput.checked : !!current.isPublic,
        };
        this.setServerModalState({
            createDraft: next,
            joinLink: next.joinLink,
        });
        return next;
    }

    renderServerRoles() {
        const list = document.getElementById('serverRolesList');
        const count = document.getElementById('serverRolesCount');
        const isEdit = this.S.serverModal.mode === 'edit';
        const roles = isEdit ? this.serverRoleList() : this.draftServerRoleList();
        if (count) count.textContent = String(roles.length || 0);
        if (!list) return;
        if (roles.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">${isEdit ? 'Ролей нет' : 'Черновики ролей'}</div>
                <div class="empty-sub">${isEdit ? 'Создайте первую роль' : 'Добавьте роли перед созданием сервера'}</div>
            </div>`;
            return;
        }
        const renderColorPicker = ({ pickerKey, wheelId, colorId, hexId, currentColor, isRoleCard = false }) => {
            const open = this.serverModalColorPickerState(pickerKey);
            return `<div class="color-picker color-picker--compact color-picker--collapsible ${open ? '' : 'is-collapsed'}" data-color-picker-key="${this.esc(pickerKey)}">
                <div class="color-picker-head">
                    <div class="color-picker-summary">
                        <span class="color-picker-preview" style="background:${this.safeCssColor(currentColor) || 'transparent'}"></span>
                        <div class="color-picker-copy">
                            <div class="color-picker-title">RGB</div>
                            <div class="color-picker-sub">${open ? 'Колесо открыто' : 'Свернуто по умолчанию'}</div>
                        </div>
                    </div>
                    <button class="btn-flat color-picker-toggle" type="button" data-color-picker-toggle="${this.esc(pickerKey)}">${open ? 'Свернуть' : 'Развернуть'}</button>
                </div>
                <div class="color-picker-body">
                    <div class="color-wheel ${isRoleCard ? 'color-wheel--tiny' : 'color-wheel--small'}" id="${this.esc(wheelId)}" tabindex="0" aria-label="Цвет роли">
                        <div class="color-wheel-thumb"></div>
                        <div class="color-wheel-center">${isRoleCard ? '' : 'RGB'}</div>
                    </div>
                    <div class="color-picker-side">
                        <input type="hidden" ${isRoleCard ? `data-role-color="${this.esc(pickerKey)}"` : `data-draft-role-color="${this.esc(pickerKey)}"`} id="${this.esc(colorId)}" value="${this.esc(currentColor)}">
                        <input class="settings-input color-hex-input" type="text" id="${this.esc(hexId)}" maxlength="7" value="${this.esc(currentColor)}" aria-label="HEX цвет роли">
                    </div>
                </div>
            </div>`;
        };
        list.innerHTML = roles.map(role => {
            if (!isEdit) {
                const draftId = String(role.draftId || '').trim();
                const safeDraftId = draftId.replace(/[^a-z0-9_-]/gi, '_');
                const wheelId = `draftRoleColorWheel-${safeDraftId}`;
                const colorId = `draftRoleColorInput-${safeDraftId}`;
                const hexId = `draftRoleColorHexInput-${safeDraftId}`;
                const currentColor = this.normalizeColorValue(role.color || '#cbff00');
                const collapsed = role.collapsed !== false;
                const draftPermCount = this.serverRolePermissionsCount(role);
                return `<div class="server-role-card draft-role ${collapsed ? 'collapsed' : ''}" data-draft-role-card="${this.esc(draftId)}" data-draft-role-collapsed="${collapsed ? '1' : '0'}">
                    <div class="server-role-head server-role-head--draft">
                        <span class="server-role-chip" style="background:${this.safeCssColor(currentColor) || 'transparent'}"></span>
                        <div>
                            <div class="server-role-name">${this.esc(role.name || 'Новая роль')}</div>
                            <div class="server-role-meta">черновик</div>
                        </div>
                        <button class="btn-flat server-role-toggle" type="button" data-draft-role-toggle="${this.esc(draftId)}">${collapsed ? 'Развернуть' : 'Свернуть'}</button>
                    </div>
                    <div class="server-role-body">
                        <div class="server-role-meta server-role-summary">Права: ${draftPermCount}/${this.serverRolePermissionDefs().length}</div>
                        <div class="server-role-controls">
                        <input class="settings-input" data-draft-role-name="${this.esc(draftId)}" value="${this.esc(role.name || '')}" placeholder="Название роли">
                        ${renderColorPicker({ pickerKey: draftId, wheelId, colorId, hexId, currentColor, isRoleCard: false })}
                        ${this.serverRolePermissionsHtml(role, draftId, 'data-draft-role-perm')}
                        <div class="server-role-actions">
                            <button class="btn-flat" type="button" data-draft-role-delete="${this.esc(draftId)}">Удалить</button>
                        </div>
                        </div>
                    </div>
                </div>`;
            }
            const locked = role.roleId === 'member' || role.roleId === 'admin';
            const safeRoleId = String(role.roleId || '').replace(/[^a-z0-9_-]/gi, '_');
            const wheelId = `roleColorWheel-${safeRoleId}`;
            const colorId = `roleColorInput-${safeRoleId}`;
            const hexId = `roleColorHexInput-${safeRoleId}`;
            const currentColor = this.normalizeColorValue(role.color || '#cbff00');
            const rolePermCount = this.serverRolePermissionsCount(role);
            const colorPickerKey = role.roleId || safeRoleId;
            const options = `
                <div class="server-role-controls">
                    <input class="settings-input" data-role-name="${this.esc(role.roleId)}" value="${this.esc(role.name || '')}">
                    ${renderColorPicker({ pickerKey: colorPickerKey, wheelId, colorId, hexId, currentColor, isRoleCard: true })}
                    <div class="server-role-actions">
                        <button class="btn-flat" type="button" data-role-save="${this.esc(role.roleId)}">Сохранить</button>
                        <button class="btn-flat" type="button" data-role-delete="${this.esc(role.roleId)}" ${locked ? 'disabled' : ''}>Удалить</button>
                    </div>
                </div>
            `;
            return `<div class="server-role-card ${locked ? 'owner-role' : ''}" data-role-card="${this.esc(role.roleId)}">
                <div class="server-role-head">
                    <span class="server-role-chip" style="background:${this.safeCssColor(role.color) || '#cbff00'}"></span>
                    <div>
                        <div class="server-role-name">${this.esc(role.name || role.roleId)}</div>
                        <div class="server-role-meta">${this.esc(role.roleId)}</div>
                    </div>
                    <span class="server-role-meta">${locked ? 'системная' : 'роль'}</span>
                </div>
                <div class="server-role-meta server-role-summary">Права: ${rolePermCount}/${this.serverRolePermissionDefs().length}</div>
                ${this.serverRolePermissionsHtml(role, role.roleId, 'data-role-perm')}
                ${options}
            </div>`;
        }).join('');
        requestAnimationFrame(() => {
            roles.forEach(role => {
                if (!isEdit) {
                    const draftId = String(role.draftId || '').trim();
                const safeDraftId = draftId.replace(/[^a-z0-9_-]/gi, '_');
                this.colorWheelBindings.delete(`draftRoleColorWheel-${safeDraftId}`);
                this.bindColorWheel({
                    wheelId: `draftRoleColorWheel-${safeDraftId}`,
                    hiddenId: `draftRoleColorInput-${safeDraftId}`,
                    hexId: `draftRoleColorHexInput-${safeDraftId}`,
                    initialValue: this.normalizeColorValue(role.color || '#cbff00'),
                });
                return;
            }
            const safeRoleId = String(role.roleId || '').replace(/[^a-z0-9_-]/gi, '_');
            const wheelId = `roleColorWheel-${safeRoleId}`;
            const colorId = `roleColorInput-${safeRoleId}`;
            const hexId = `roleColorHexInput-${safeRoleId}`;
            this.colorWheelBindings.delete(wheelId);
            this.bindColorWheel({
                wheelId,
                hiddenId: colorId,
                hexId,
                initialValue: this.normalizeColorValue(role.color || '#cbff00'),
            });
            });
        });
    }

    renderServerChannels({ force = false } = {}) {
        const list = document.getElementById('serverChannelsList');
        const count = document.getElementById('serverChannelsCount');
        const isEdit = this.S.serverModal.mode === 'edit';
        const channels = isEdit ? this.normalizeServerChannels(this.S.serverModal.channels || []) : [];
        if (count) count.textContent = String(channels.length || 0);
        if (!list) return;
        // A rename in progress or a row being dragged owns the list's DOM: any of
        // the many renderServerModal() calls (a loadServers landing, an avatar)
        // would otherwise replace the input under the caret or the row under the
        // pointer. Deferred, not dropped — the edit or drag re-renders on its end.
        if (!force && (this._serverChannelDrag || list.querySelector('.server-channel-row-input'))) {
            this._serverChannelsRenderDeferred = true;
            return;
        }
        this._serverChannelsRenderDeferred = false;
        if (this.S.serverModal.loading && channels.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Загрузка каналов</div>
                <div class="empty-sub">Подождите секунду</div>
            </div>`;
            return;
        }
        if (!isEdit) {
            list.innerHTML = '';
            return;
        }
        if (channels.length === 0) {
            list.innerHTML = `<div class="empty-state">
                <div class="empty-ttl">Каналов нет</div>
                <div class="empty-sub">Создайте первый канал</div>
            </div>`;
            return;
        }
        // One row per channel, saved as you go: the row itself drags to reorder,
        // the name and topic edit in place on click, the icon on the right flips
        // the channel between text and voice. See bindServerChannelsList().
        const grip = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
        list.innerHTML = channels.map(channel => {
            const kind = this.normalizeChannelKind(channel.kind);
            const kindLabel = this.channelKindLabel(kind);
            const nextLabel = kind === 'voice' ? 'текстовым' : 'голосовым';
            const name = String(channel.name || '');
            return `<div class="server-channel-row" data-channel-card="${this.esc(channel.id)}">
                <span class="server-channel-grip">${grip}</span>
                <div class="server-channel-row-copy">
                    <span class="server-channel-row-name" data-channel-rename="${this.esc(channel.id)}" title="Нажмите, чтобы переименовать">${this.esc(name)}</span>
                    <span class="server-channel-row-topic${channel.topic ? '' : ' empty'}" data-channel-retopic="${this.esc(channel.id)}" title="Нажмите, чтобы изменить тему">${this.esc(channel.topic || 'Добавить тему')}</span>
                </div>
                <button class="server-channel-kind-toggle ${kind}" type="button" data-channel-kind-toggle="${this.esc(channel.id)}" title="${this.esc(`${kindLabel} канал — нажмите, чтобы сделать ${nextLabel}`)}" aria-label="${this.esc(`${kindLabel} канал ${name}: сделать ${nextLabel}`)}">${this.channelKindIcon(kind, 'server-channel-kind-icon')}</button>
                <button class="server-channel-row-delete" type="button" data-channel-delete="${this.esc(channel.id)}" title="Удалить канал" aria-label="${this.esc(`Удалить канал ${name}`)}">${this.uiIcon('trash', 'server-channel-row-delete-icon')}</button>
            </div>`;
        }).join('');
    }

    async openServerModal(mode = 'create', serverId = null) {
        const nextMode = mode === 'edit' ? 'edit' : 'create';
        const sid = nextMode === 'edit' ? String(serverId || this.S.activeServer || '').trim() : null;
        const server = sid ? (this.S.servers || []).find(item => item.id === sid) : null;
        if (nextMode === 'edit' && (!server || !this.canManageServer(server))) {
            return;
        }
        const selectedChannelId = nextMode === 'edit'
            ? ((this.S.activeServer === sid ? this.S.activeChannel : null) || server?.channels?.[0]?.id || null)
            : null;

        this.setServerModalState({
            mode: nextMode,
            serverId: sid,
            activeSection: nextMode === 'edit' ? 'overview' : 'overview',
            colorPickers: {},
            roleCreateOpen: false,
            channelCreateOpen: false,
            members: nextMode === 'edit' ? (server?.members || []) : [],
            roles: [],
            channels: nextMode === 'edit' ? (server?.channels || []) : [],
            draftRoles: [],
            createDraft: nextMode === 'edit' ? null : this.serverCreateDraftDefaults(),
            joinLink: nextMode === 'edit' ? (server?.joinLink || server?.join_link || '') : '',
            selectedChannelId,
            channelPermissions: [],
            loading: nextMode === 'edit',
            saving: false,
            error: '',
        });
        this.clearServerCreateAssets();
        this.openServerOverlay();
        this.renderServerModal();
        if (nextMode === 'create') {
            this.applyServerRoleCreateDefaults();
        }

        if (nextMode === 'edit' && sid) {
            try {
                const [members, roles, channels] = await Promise.all([
                    this.loadServerMembers(sid),
                    this.loadServerRoles(sid),
                    this.loadServerChannels(sid),
                ]);
                this.setServerModalState({
                    members,
                    roles,
                    channels,
                    loading: false,
                });
                this.renderServerModal();
            } catch (e) {
                this.setServerModalState({ loading: false, error: e?.message || 'Не удалось загрузить участников' });
                this.renderServerModal();
            }
        }
    }

    async openPublicServersModal() {
        const discoverQuery = document.getElementById('serverDiscoverQuery');
        if (discoverQuery) discoverQuery.value = '';
        this.setServerModalState({
            mode: 'discover',
            serverId: null,
            activeSection: 'discover',
            colorPickers: {},
            members: [],
            roles: [],
            channels: [],
            draftRoles: [],
            createDraft: null,
            joinLink: '',
            selectedChannelId: null,
            channelPermissions: [],
            channelCreateOpen: false,
            loading: true,
            saving: false,
            error: '',
        });
        this.openServerOverlay();
        this.renderServerModal();
        await this.loadPublicServers({ silent: true });
    }

    publicServerFilterValue() {
        const input = document.getElementById('serverDiscoverQuery');
        return String(input?.value || '').trim().toLowerCase();
    }

    renderFilteredPublicServers() {
        const q = this.publicServerFilterValue();
        const servers = Array.isArray(this.S.publicServers) ? this.S.publicServers : [];
        if (!q) return servers;
        return servers.filter(server => {
            const haystack = `${server.name || ''} ${server.description || server.hint || ''} ${server.joinLink || server.join_link || ''}`.toLowerCase();
            return haystack.includes(q);
        });
    }

    async loadPublicServers({ silent = false } = {}) {
        try {
            this.setServerModalState({ loading: true, error: '' });
            this.renderServerModal();
            const res = await this.apiFetch(this.apiRoutes.discover.servers);
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось загрузить публичные серверы');
            }
            const data = await res.json();
            this.S.publicServers = this.normalizeServers(Array.isArray(data?.servers) ? data.servers : []);
            this.setServerModalState({ loading: false, error: '' });
            this.renderServerModal();
        } catch (e) {
            this.S.publicServers = [];
            this.setServerModalState({
                loading: false,
                error: e?.message || 'Не удалось загрузить публичные серверы',
            });
            this.renderServerModal();
            if (!silent) {
                this.addLogEntry({ type: 'ERROR', msg: e?.message || 'Не удалось загрузить публичные серверы', ts: new Date().toLocaleTimeString() });
            }
        }
    }

    async enterPublicServer(serverIdOrLink) {
        const raw = String(serverIdOrLink || '').trim();
        if (!raw) return;
        await this.joinServerByLink(raw);
        if (this.S.serverModal.mode === 'discover') {
            await this.loadPublicServers({ silent: true });
        }
    }

    async submitServerModal() {
        if (this.S.serverModal.saving) return;
        const mode = this.S.serverModal.mode;
        const serverId = this.S.serverModal.serverId;
        const createDraft = mode === 'edit' ? null : this.syncServerCreateDraftFromDom();
        const nameInput = document.getElementById('serverNameInput');
        const descInput = document.getElementById('serverDescriptionInput');
        const iconInput = document.getElementById('serverIconInput');
        const colorInput = document.getElementById('serverColorInput');
        const joinLinkInput = document.getElementById('serverJoinLinkInput');
        const publicInput = document.getElementById('serverPublicInput');
        const payloadSource = mode === 'edit'
            ? null
            : (createDraft || this.serverCreateDraft());
        const payload = {
            name: (payloadSource ? payloadSource.name : (nameInput?.value || '')).trim(),
            description: (payloadSource ? payloadSource.description : (descInput?.value || '')).trim(),
            icon: (payloadSource ? payloadSource.icon : (iconInput?.value || '')).trim(),
            color: this.normalizeColorValue(payloadSource ? payloadSource.color : (colorInput?.value || '#cbff00')),
            join_link: (payloadSource ? payloadSource.joinLink : (joinLinkInput?.value || '')).trim(),
            is_public: payloadSource ? !!payloadSource.isPublic : !!publicInput?.checked,
        };
        if (mode !== 'edit') {
            payload.roles = this.syncDraftServerRolesFromDom().map(role => {
                const rolePayload = {
                    name: role.name,
                    color: role.color,
                };
                this.serverRolePermissionDefs().forEach(def => {
                    rolePayload[def.key] = !!role[def.key];
                });
                return rolePayload;
            });
        }

        if (!payload.name) {
            this.setServerModalState({ error: 'Введите название сервера' });
            this.renderServerModal();
            return;
        }

        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();

        try {
            const endpoint = mode === 'edit' && serverId
                ? this.apiRoutes.servers.byId(serverId)
                : this.apiRoutes.servers.list;
            const res = await this.apiFetch(endpoint, {
                method: mode === 'edit' ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось сохранить сервер');
            }
            const data = await res.json();
            const pendingAssets = mode === 'edit'
                ? []
                : ['avatar', 'banner']
                    .map(kind => [kind, this._serverCreateAssets?.[kind]?.file])
                    .filter(([, file]) => file);
            this.closeServerOverlay();
            await this.loadServers({ silent: true });
            if (data?.id) {
                this.setActiveServer(data.id, { persist: true });
                if (pendingAssets.length) {
                    await this.uploadCreatedServerAssets(data.id, pendingAssets);
                }
            }
            if (mode !== 'edit') this.clearServerCreateAssets();
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось сохранить сервер' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    // 'pending' — файл отложен до создания сервера, 'uploaded' — ушёл на сервер.
    // Вызывающий пишет «обновлён» только на второе.
    async uploadServerAsset(kind, file) {
        if (!file) return 'skipped';
        const mode = this.S.serverModal.mode;
        if (mode === 'create') {
            this.setServerCreateAsset(kind, file);
            this.renderServerModal();
            return 'pending';
        }
        const serverId = this.S.serverModal.serverId || this.S.activeServer;
        if (!serverId || mode !== 'edit') {
            throw new Error('Медиа можно менять только у уже созданного сервера');
        }
        await this.putServerAsset(serverId, kind, file);
        await this.syncServerAssetPreview(serverId);
        return 'uploaded';
    }

    // Сервер уже создан и диалог закрыт: сбой медиа не должен выглядеть как
    // сбой создания, поэтому он уходит в журнал, а не в ошибку модалки.
    async uploadCreatedServerAssets(serverId, assets) {
        for (const [kind, file] of assets) {
            try {
                await this.putServerAsset(serverId, kind, file);
            } catch (e) {
                this.addLogEntry({
                    type: 'ERROR',
                    msg: `Сервер создан, но ${kind === 'avatar' ? 'аватар' : 'баннер'} не загрузился: ${e?.message || e}`,
                    ts: new Date().toLocaleTimeString(),
                });
            }
        }
        this.scheduleServerAssetRefresh();
    }

    async putServerAsset(serverId, kind, file) {
        const downscaled = await this.downscaleServerAssetFile(file, kind);
        const dataUrl = await this.readFileAsDataURL(downscaled);
        const res = await this.apiFetch(this.apiRoutes.servers.assets(serverId, kind), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            // Binary body (base64 data URL) — apiFetch only auto-detects FormData as a
            // bulk transfer, so a plain JSON body like this one silently got the 8s
            // default meant for ordinary calls instead of the 120s transfer budget
            // (see TRANSFER_REQUEST_TIMEOUT_MS in api.js) — exactly the slow-link
            // failure downscaleServerAssetFile's own comment warns about, just missed
            // here specifically. loadServerAsset (the GET side) already passes it.
            timeoutMs: TRANSFER_REQUEST_TIMEOUT_MS,
            body: JSON.stringify({ data_url: dataUrl }),
        });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || `Не удалось обновить ${kind}`);
        }
        this.clearServerAssetCache(serverId, kind);
    }

    async removeServerAsset(kind) {
        if (this.S.serverModal.mode === 'create') {
            this.setServerCreateAsset(kind, null);
            this.renderServerModal();
            return;
        }
        const serverId = this.S.serverModal.serverId || this.S.activeServer;
        if (!serverId || this.S.serverModal.mode !== 'edit') {
            throw new Error('Медиа можно менять только у уже созданного сервера');
        }
        const res = await this.apiFetch(this.apiRoutes.servers.assets(serverId, kind), {
            method: 'DELETE',
        });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || `Не удалось удалить ${kind}`);
        }
        this.clearServerAssetCache(serverId, kind);
        await this.syncServerAssetPreview(serverId);
    }

    async generateServerJoinLink() {
        if (this.S.serverModal.saving) return '';
        const mode = this.S.serverModal.mode;
        const server = mode === 'edit'
            ? this.currentServer()
            : null;
        const fallback = mode === 'edit' && server?.id
            ? `zali://server/${server.id}`
            : `zali://server/${(document.getElementById('serverNameInput')?.value || 'server').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
        if (mode === 'edit') {
            this.setServerModalState({ joinLink: fallback, error: '' });
        } else {
            const draft = this.syncServerCreateDraftFromDom();
            this.setServerModalState({
                joinLink: fallback,
                createDraft: {
                    ...draft,
                    joinLink: fallback,
                },
                error: '',
            });
        }
        this.renderServerModal();
        return fallback;
    }

    async joinServerByLink(link) {
        const raw = String(link || '').trim();
        if (!raw) return;
        const inviteMatch = raw.match(/(?:zali:\/\/invite\/|invite\/)?([a-z0-9]{4,64})/i);
        if (inviteMatch && /invite/i.test(raw)) {
            const inviteCode = inviteMatch[1].toLowerCase();
            try {
                const res = await this.apiFetch(this.apiRoutes.invites.join(inviteCode), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: inviteCode }),
                });
                if (!res.ok) {
                    throw new Error(await res.text() || 'Не удалось войти по ссылке');
                }
                const data = await res.json();
                await this.loadServers({ silent: true });
                this.closeServerOverlay();
                if (data?.serverId) {
                    this.setActiveServer(data.serverId, { persist: true });
                }
                this.addLogEntry({ type: 'SUCCESS', msg: `Вход по ссылке успешен: ${inviteCode}`, ts: new Date().toLocaleTimeString() });
            } catch (e) {
                this.addLogEntry({ type: 'ERROR', msg: e?.message || 'Не удалось войти по ссылке', ts: new Date().toLocaleTimeString() });
            }
            return;
        }

        try {
            const res = await this.apiFetch(this.apiRoutes.servers.join, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ link: raw }),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось войти по ссылке');
            }
            const data = await res.json();
            await this.loadServers({ silent: true });
            this.closeServerOverlay();
            if (data?.serverId) {
                this.setActiveServer(data.serverId, { persist: true });
            }
            this.addLogEntry({ type: 'SUCCESS', msg: `Вход по ссылке успешен`, ts: new Date().toLocaleTimeString() });
        } catch (e) {
            this.addLogEntry({ type: 'ERROR', msg: e?.message || 'Не удалось войти по ссылке', ts: new Date().toLocaleTimeString() });
        }
    }

    openJoinCodeModal() {
        const existing = document.getElementById('joinCodeModalOverlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'joinCodeModalOverlay';
        overlay.className = 'modal-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.55);';
        overlay.innerHTML = `
            <div class="join-code-modal" style="background:var(--panel-bg,#1c1c1e);color:var(--text-color,#fff);border-radius:12px;padding:20px;min-width:280px;max-width:90vw;box-shadow:0 12px 40px rgba(0,0,0,0.4);">
                <div style="font-weight:600;margin-bottom:10px;">Войти по коду</div>
                <input type="text" id="joinCodeModalInput" placeholder="Код или ссылка сервера" autocomplete="off" spellcheck="false"
                    style="width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:rgba(255,255,255,0.06);color:inherit;font-size:14px;margin-bottom:14px;">
                <div style="display:flex;justify-content:flex-end;gap:8px;">
                    <button type="button" id="joinCodeModalCancel" class="btn-flat">Отмена</button>
                    <button type="button" id="joinCodeModalSubmit" class="btn-flat">Войти</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        const input = document.getElementById('joinCodeModalInput');
        const close = () => overlay.remove();
        const submit = () => {
            const link = this.extractInviteCode(input.value);
            close();
            if (link) this.joinServerByLink(link);
        };

        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.getElementById('joinCodeModalCancel').addEventListener('click', close);
        document.getElementById('joinCodeModalSubmit').addEventListener('click', submit);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') close();
        });
        input.focus();
    }

    extractInviteCode(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const match = raw.match(/(?:zali:\/\/invite\/|invite\/|zali:\/\/server\/|server\/)?([a-z0-9._-]{2,128})/i);
        return (match && match[1]) ? match[1].toLowerCase() : raw.toLowerCase();
    }

    rolePayloadFromCreateForm() {
        const nameInput = document.getElementById('serverRoleNameInput');
        const colorInput = document.getElementById('serverRoleColorInput');
        const colorHexInput = document.getElementById('serverRoleColorHexInput');
        const permissions = {};
        this.serverRolePermissionDefs().forEach(def => {
            permissions[def.key] = !!document.querySelector(`[data-server-role-perm="${CSS.escape(def.key)}"]`)?.checked;
        });
        return {
            name: (nameInput?.value || '').trim(),
            color: this.normalizeColorValue(colorInput?.value || colorHexInput?.value || '#cbff00'),
            ...permissions,
        };
    }

    rolePayloadFromCard(roleId) {
        const card = document.querySelector(`[data-role-card="${CSS.escape(String(roleId || ''))}"]`);
        if (!card) return null;
        const name = String(card.querySelector(`[data-role-name="${CSS.escape(String(roleId || ''))}"]`)?.value || '').trim();
        const color = this.normalizeColorValue(card.querySelector(`[data-role-color="${CSS.escape(String(roleId || ''))}"]`)?.value || '#cbff00');
        const permissions = {};
        this.serverRolePermissionDefs().forEach(def => {
            permissions[def.key] = !!card.querySelector(`[data-role-perm="${CSS.escape(def.key)}"]`)?.checked;
        });
        return {
            name,
            color,
            ...permissions,
        };
    }

    async createServerRole() {
        const payload = this.rolePayloadFromCreateForm();
        if (!payload.name) {
            this.setServerModalState({ error: 'Введите название роли' });
            this.renderServerModal();
            return;
        }
        if (this.S.serverModal.mode === 'create') {
            const draftRoles = this.syncDraftServerRolesFromDom();
            const draftPermissions = {};
            this.serverRolePermissionDefs().forEach(def => {
                draftPermissions[def.key] = !!payload[def.key];
            });
            draftRoles.push({
                draftId: `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
                collapsed: true,
                name: payload.name,
                color: payload.color,
                ...draftPermissions,
            });
            this.setServerModalState({ draftRoles, error: '' });
            const nameInput = document.getElementById('serverRoleNameInput');
            if (nameInput) nameInput.value = '';
            this.applyServerRoleCreateDefaults();
            this.renderServerModal();
            return;
        }
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const res = await this.apiFetch(this.apiRoutes.servers.roles(serverId), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось создать роль');
        }
        const role = await res.json();
        const roles = [role, ...(this.S.serverModal.roles || [])].sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
        this.setServerModalState({ roles, error: '' });
        const nameInput = document.getElementById('serverRoleNameInput');
        if (nameInput) nameInput.value = '';
        this.renderServerModal();
        this.applyServerRoleCreateDefaults();
        await this.loadServers({ silent: true });
    }

    async saveServerRole(roleId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const payload = this.rolePayloadFromCard(roleId);
        if (!payload) return;
        const res = await this.apiFetch(this.apiRoutes.servers.role(serverId, roleId), {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        if (!res.ok) {
            throw new Error(await res.text() || 'Не удалось сохранить роль');
        }
        const updated = await res.json();
        const roles = (this.S.serverModal.roles || []).map(role => String(role.roleId || '') === roleId ? updated : role);
        this.setServerModalState({ roles, error: '' });
        this.renderServerModal();
        await this.loadServers({ silent: true });
    }

    async deleteServerRole(roleId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const res = await this.apiFetch(this.apiRoutes.servers.role(serverId, roleId), {
            method: 'DELETE',
        });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || 'Не удалось удалить роль');
        }
        const roles = (this.S.serverModal.roles || []).filter(role => String(role.roleId || '') !== roleId);
        this.setServerModalState({ roles, error: '' });
        this.renderServerModal();
        await this.loadServers({ silent: true });
    }

    async saveServerMembersFromModal() {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        try {
            const members = await this.loadServerMembers(serverId);
            this.setServerModalState({ members });
            this.renderServerModal();
            await this.loadServers({ silent: true });
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось обновить участников' });
            this.renderServerModal();
        }
    }

    channelPayloadFromCreateForm() {
        const nameInput = document.getElementById('serverChannelNameInput');
        const topicInput = document.getElementById('serverChannelTopicInput');
        const kindInput = document.getElementById('serverChannelKindInput');
        return {
            name: (nameInput?.value || '').trim(),
            topic: (topicInput?.value || '').trim(),
            kind: this.normalizeChannelKind(kindInput?.value || 'text'),
        };
    }

    // The sidebar list and the rail read S.servers, which only loadServers
    // refreshes — so every landed channel change ends here.
    async refreshServersAfterChannelChange(serverId) {
        try {
            await this.loadServers({ silent: true });
        } catch (_) {}
        if (this.S.activeServer === serverId) {
            this.renderServerInterface();
            this.renderContacts();
        }
    }

    // Optimistic: the row shows the new value at once and goes back to what it
    // was if the server refuses (a duplicate name, no rights, no network).
    async updateServerChannel(channelId, patch) {
        const serverId = this.S.serverModal.serverId;
        const cid = String(channelId || '').trim();
        if (!serverId || !cid || this.S.serverModal.mode !== 'edit') return false;
        const previous = this.S.serverModal.channels || [];
        this.setServerModalState({
            channels: previous.map(channel => (String(channel.id) === cid ? { ...channel, ...patch } : channel)),
            error: '',
        });
        this.renderServerChannels({ force: true });
        try {
            const res = await this.apiFetch(this.apiRoutes.servers.channel(serverId, cid), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(patch),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось сохранить канал');
            }
            const data = await res.json().catch(() => null);
            if (Array.isArray(data)) {
                this.setServerModalState({ channels: this.normalizeServerChannels(data) });
            }
            this.renderServerChannels();
            await this.refreshServersAfterChannelChange(serverId);
            return true;
        } catch (e) {
            this.setServerModalState({ channels: previous, error: e?.message || 'Не удалось сохранить канал' });
            this.renderServerModal();
            return false;
        }
    }

    toggleServerChannelKind(channelId) {
        const cid = String(channelId || '').trim();
        const channel = (this.S.serverModal.channels || []).find(item => String(item.id) === cid);
        if (!channel) return;
        const kind = this.normalizeChannelKind(channel.kind) === 'voice' ? 'text' : 'voice';
        void this.updateServerChannel(cid, { kind });
    }

    // The API has no bulk reorder, so every channel whose stored position differs
    // gets its own PATCH. Positions are rewritten as 0..n-1 on the way: older
    // servers carry duplicates and gaps, which is why the list showed «позиция 2»
    // above «позиция 1».
    async persistServerChannelOrder(orderedIds) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const previous = this.normalizeServerChannels(this.S.serverModal.channels || []);
        const byId = new Map(previous.map(channel => [String(channel.id), channel]));
        const next = orderedIds
            .map(id => byId.get(String(id)))
            .filter(Boolean)
            .map((channel, index) => ({ ...channel, position: index }));
        if (next.length !== previous.length) {
            this.renderServerChannels({ force: true });
            return;
        }
        const changed = next.filter(channel => Number(byId.get(String(channel.id))?.position) !== channel.position);
        this.setServerModalState({ channels: next, error: '' });
        this.renderServerChannels({ force: true });
        if (!changed.length) return;
        try {
            let latest = null;
            for (const channel of changed) {
                const res = await this.apiFetch(this.apiRoutes.servers.channel(serverId, channel.id), {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ position: channel.position }),
                });
                if (!res.ok) {
                    throw new Error(await res.text() || 'Не удалось изменить порядок каналов');
                }
                latest = await res.json().catch(() => null);
            }
            if (Array.isArray(latest)) {
                this.setServerModalState({ channels: this.normalizeServerChannels(latest) });
            }
            this.renderServerChannels();
            await this.refreshServersAfterChannelChange(serverId);
        } catch (e) {
            // Some of the PATCHes may have landed, so the order comes back from the
            // server rather than from the snapshot.
            this.setServerModalState({ error: e?.message || 'Не удалось изменить порядок каналов' });
            await this.loadServerChannels(serverId).catch(() => {});
            this.renderServerModal();
        }
    }

    // Swaps the name (or topic) text for an input. Enter or leaving the field
    // saves, Escape puts the old value back.
    beginServerChannelFieldEdit(span, field) {
        const row = span?.closest('[data-channel-card]');
        const cid = row?.getAttribute('data-channel-card');
        if (!cid) return;
        const channel = (this.S.serverModal.channels || []).find(item => String(item.id) === cid);
        const original = String((field === 'name' ? channel?.name : channel?.topic) || '');
        const input = document.createElement('input');
        input.type = 'text';
        input.className = `settings-input server-channel-row-input ${field}`;
        input.maxLength = field === 'name' ? 64 : 180;
        input.value = original;
        input.placeholder = field === 'name' ? 'Название канала' : 'Тема канала';
        input.autocomplete = 'off';
        input.spellcheck = false;
        span.replaceWith(input);
        input.focus();
        input.select();
        let finished = false;
        const finish = (commit) => {
            if (finished) return;
            finished = true;
            const value = input.value.trim();
            if (commit && value !== original && (field !== 'name' || value)) {
                void this.updateServerChannel(cid, { [field]: value });
            } else {
                this.renderServerChannels({ force: true });
            }
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                finish(true);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                finish(false);
            }
        });
        input.addEventListener('blur', () => finish(true));
    }

    bindServerChannelsList() {
        const list = document.getElementById('serverChannelsList');
        if (!list || list.__channelRowsBound) return;
        list.__channelRowsBound = true;

        const THRESHOLD = 5;
        const TOUCH_HOLD_MS = 280;
        const EDGE = 44;
        let press = null;
        let drag = null;
        let suppressClick = false;

        // The pointerup that ends a drag is followed by a click on whatever the
        // pointer was over — the kind icon, a name. That click is not a choice.
        list.addEventListener('click', (e) => {
            if (!suppressClick) return;
            e.preventDefault();
            e.stopPropagation();
        }, true);

        list.addEventListener('click', (e) => {
            const toggle = e.target.closest('[data-channel-kind-toggle]');
            if (toggle) {
                this.toggleServerChannelKind(toggle.getAttribute('data-channel-kind-toggle'));
                return;
            }
            const deleteBtn = e.target.closest('[data-channel-delete]');
            if (deleteBtn) {
                const channelId = deleteBtn.getAttribute('data-channel-delete');
                if (!channelId) return;
                this.deleteServerChannel(channelId).catch((err) => {
                    this.setServerModalState({ error: err?.message || 'Не удалось удалить канал' });
                    this.renderServerModal();
                });
                return;
            }
            const rename = e.target.closest('[data-channel-rename]');
            if (rename) {
                this.beginServerChannelFieldEdit(rename, 'name');
                return;
            }
            const retopic = e.target.closest('[data-channel-retopic]');
            if (retopic) this.beginServerChannelFieldEdit(retopic, 'topic');
        });

        const scrollerFor = () => [list, list.closest('.server-modal-content')]
            .find(el => el && el.scrollHeight > el.clientHeight + 1) || null;

        // Geometry is captured once, at the start, in "content" coordinates: the
        // scroller's movement since then is added back, so autoscrolling while
        // dragging never invalidates the measured row positions.
        const layout = () => {
            const scrolled = drag.scroller ? drag.scroller.scrollTop - drag.scroll0 : 0;
            const origin = drag.rects[drag.originIndex];
            const first = drag.rects[0];
            const last = drag.rects[drag.rects.length - 1];
            const offset = Math.max(
                first.top - origin.top - 8,
                Math.min(last.bottom - origin.bottom + 8, drag.clientY - drag.startY + scrolled),
            );
            drag.rows[drag.originIndex].style.transform = `translate3d(0, ${offset.toFixed(1)}px, 0)`;
            const center = origin.top + origin.height / 2 + offset;
            let index = 0;
            drag.rects.forEach((rect, i) => {
                if (i !== drag.originIndex && center > rect.top + rect.height / 2) index += 1;
            });
            if (index === drag.index) return;
            drag.index = index;
            drag.rows.forEach((row, i) => {
                if (i === drag.originIndex) return;
                let shift = 0;
                if (drag.originIndex < index && i > drag.originIndex && i <= index) shift = -drag.step;
                if (drag.originIndex > index && i >= index && i < drag.originIndex) shift = drag.step;
                row.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : '';
            });
        };

        const autoscroll = () => {
            if (!drag) return;
            const scroller = drag.scroller;
            if (scroller) {
                const box = scroller.getBoundingClientRect();
                let speed = 0;
                if (drag.clientY < box.top + EDGE) speed = -Math.ceil((box.top + EDGE - drag.clientY) / 4);
                else if (drag.clientY > box.bottom - EDGE) speed = Math.ceil((drag.clientY - box.bottom + EDGE) / 4);
                if (speed) {
                    scroller.scrollTop += speed;
                    layout();
                }
            }
            drag.raf = requestAnimationFrame(autoscroll);
        };

        const startDrag = () => {
            if (!press || drag) return;
            const rows = Array.from(list.querySelectorAll('.server-channel-row'));
            const originIndex = rows.indexOf(press.row);
            if (originIndex < 0 || rows.length < 2) {
                press = null;
                return;
            }
            const rects = rows.map(row => row.getBoundingClientRect());
            const scroller = scrollerFor();
            drag = {
                rows,
                rects,
                originIndex,
                index: originIndex,
                pointerId: press.pointerId,
                startY: press.startY,
                clientY: press.startY,
                scroller,
                scroll0: scroller ? scroller.scrollTop : 0,
                step: rects[originIndex].height + Math.max(0, rects[1].top - rects[0].bottom),
                raf: 0,
            };
            this._serverChannelDrag = true;
            list.classList.add('is-dragging');
            press.row.classList.add('dragging');
            try { list.setPointerCapture(drag.pointerId); } catch (_) {}
            autoscroll();
        };

        const endDrag = (commit) => {
            if (!drag) return;
            cancelAnimationFrame(drag.raf);
            const { rows, originIndex, index } = drag;
            drag = null;
            this._serverChannelDrag = false;
            list.classList.remove('is-dragging');
            rows.forEach((row) => {
                row.classList.remove('dragging');
                row.style.transform = '';
            });
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 0);
            if (commit && index !== originIndex) {
                const ids = rows.map(row => row.getAttribute('data-channel-card'));
                const [moved] = ids.splice(originIndex, 1);
                ids.splice(index, 0, moved);
                // Re-renders the list in the new order synchronously, in the same
                // task as the transforms are cleared above — no frame in between.
                void this.persistServerChannelOrder(ids);
            } else if (this._serverChannelsRenderDeferred) {
                this.renderServerChannels({ force: true });
            }
        };

        list.addEventListener('pointerdown', (e) => {
            if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
            const row = e.target.closest('.server-channel-row');
            if (!row || e.target.closest('input, textarea, select')) return;
            // An open rename commits on this very press (blur) and re-renders the
            // list, which would pull the row out from under the pointer.
            if (list.querySelector('.server-channel-row-input')) return;
            press = { row, pointerId: e.pointerId, pointerType: e.pointerType, startX: e.clientX, startY: e.clientY, holdTimer: 0 };
            if (e.pointerType === 'touch') {
                // On touch a plain drag is the list's own scroll; picking a row up
                // takes a short hold, like every native reorderable list.
                press.holdTimer = setTimeout(startDrag, TOUCH_HOLD_MS);
            }
        });

        list.addEventListener('pointermove', (e) => {
            if (drag) {
                if (e.pointerId !== drag.pointerId) return;
                drag.clientY = e.clientY;
                layout();
                return;
            }
            if (!press || e.pointerId !== press.pointerId) return;
            const moved = Math.hypot(e.clientX - press.startX, e.clientY - press.startY);
            if (press.pointerType === 'touch') {
                if (moved > 8) {
                    clearTimeout(press.holdTimer);
                    press = null;
                }
                return;
            }
            if (moved >= THRESHOLD) {
                startDrag();
                if (drag) {
                    drag.clientY = e.clientY;
                    layout();
                }
            }
        });

        const release = (e, commit) => {
            if (press && e.pointerId === press.pointerId) {
                clearTimeout(press.holdTimer);
                press = null;
            }
            if (drag && e.pointerId === drag.pointerId) endDrag(commit);
        };
        list.addEventListener('pointerup', (e) => release(e, true));
        list.addEventListener('pointercancel', (e) => release(e, false));
        // Once a row is picked up by touch, the finger must move the row, not the page.
        list.addEventListener('touchmove', (e) => {
            if (drag && e.cancelable) e.preventDefault();
        }, { passive: false });
    }

    async createServerChannel() {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const payload = this.channelPayloadFromCreateForm();
        if (!payload.name) {
            this.setServerModalState({ error: 'Введите название канала' });
            this.renderServerModal();
            return;
        }
        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();
        try {
            const res = await this.apiFetch(this.apiRoutes.servers.channels(serverId), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось создать канал');
            }
            const data = await res.json();
            const channels = this.normalizeServerChannels(Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []));
            const nameInput = document.getElementById('serverChannelNameInput');
            const topicInput = document.getElementById('serverChannelTopicInput');
            if (nameInput) nameInput.value = '';
            if (topicInput) topicInput.value = '';
            this.setServerModalState({ channels, error: '' });
            await this.loadServers({ silent: true });
            if (this.S.activeServer === serverId) {
                this.setActiveServer(serverId, { persist: true });
            }
            this.renderServerModal();
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось создать канал' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    async deleteServerChannel(channelId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const cid = String(channelId || '').trim();
        const channel = (this.S.serverModal.channels || []).find(item => String(item.id || '') === cid);
        const confirmDelete = confirm(`Удалить канал "${channel?.name || cid}"?`);
        if (!confirmDelete) return;
        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();
        try {
            const res = await this.apiFetch(this.apiRoutes.servers.channel(serverId, cid), {
                method: 'DELETE',
            });
            if (!res.ok && res.status !== 204) {
                throw new Error(await res.text() || 'Не удалось удалить канал');
            }
            let channels = [];
            if (res.status !== 204) {
                const data = await res.json();
                channels = this.normalizeServerChannels(Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []));
            }
            this.setServerModalState({ channels, error: '' });
            await this.loadServers({ silent: true });
            if (this.S.activeServer === serverId) {
                this.setActiveServer(serverId, { persist: true });
            }
            this.renderServerModal();
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось удалить канал' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    currentServer() {
        return (this.S.servers || []).find(server => server.id === this.S.activeServer) || null;
    }

    currentChannel() {
        const server = this.currentServer();
        if (!server) return null;
        return (server.channels || []).find(channel => channel.id === this.S.activeChannel) || null;
    }

    currentServerChatKey() {
        if (!this.S.activeServer || !this.S.activeChannel) return '';
        return `${this.S.activeServer}:${this.S.activeChannel}`;
    }

    currentConversationMode() {
        if (this.S.navMode === 'servers' && this.currentServerChatKey()) {
            return 'servers';
        }
        return 'dm';
    }

    clearActiveServerSelection({ persist = true } = {}) {
        this.S.activeServer = null;
        this.S.activeChannel = null;
        this.S.activeConversationType = 'dm';
        if (persist) {
            this.saveStoredActiveServer(null);
            this.saveStoredActiveChannel(null);
        }
    }
});
