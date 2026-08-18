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
        const editLocked = !isEdit;
        const linkLocked = !!this.S.serverModal.saving || !!this.S.serverModal.loading;
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.disabled = editLocked;
        if (serverAvatarRemoveBtn) serverAvatarRemoveBtn.disabled = editLocked;
        if (serverBannerUploadBtn) serverBannerUploadBtn.disabled = editLocked;
        if (serverBannerRemoveBtn) serverBannerRemoveBtn.disabled = editLocked;
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
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.title = isEdit ? 'Загрузить аватар' : 'Создать сервер сначала';
        if (serverAvatarRemoveBtn) serverAvatarRemoveBtn.title = isEdit ? 'Удалить аватар' : 'Создать сервер сначала';
        if (serverBannerUploadBtn) serverBannerUploadBtn.title = isEdit ? 'Загрузить баннер' : 'Создать сервер сначала';
        if (serverBannerRemoveBtn) serverBannerRemoveBtn.title = isEdit ? 'Удалить баннер' : 'Создать сервер сначала';
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

    renderServerChannels() {
        const list = document.getElementById('serverChannelsList');
        const count = document.getElementById('serverChannelsCount');
        const isEdit = this.S.serverModal.mode === 'edit';
        const channels = isEdit ? this.normalizeServerChannels(this.S.serverModal.channels || []) : [];
        if (count) count.textContent = String(channels.length || 0);
        if (!list) return;
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
        list.innerHTML = channels.map(channel => {
            const safeId = String(channel.id || '').replace(/[^a-z0-9_-]/gi, '_');
            const kind = this.normalizeChannelKind(channel.kind);
            return `<div class="server-channel-card" data-channel-card="${this.esc(channel.id)}">
                <div class="server-channel-head">
                    <span class="server-channel-chip ${kind}">${this.channelKindIcon(kind, 'server-channel-chip-icon')}</span>
                    <div class="server-channel-copy">
                        <input class="settings-input" data-channel-name="${this.esc(channel.id)}" value="${this.esc(channel.name || '')}" placeholder="Название канала">
                        <div class="server-channel-meta">ID: ${this.esc(channel.id || safeId)} · ${this.esc(this.channelKindLabel(kind))}</div>
                    </div>
                    <select class="settings-input server-channel-kind-select" data-channel-kind="${this.esc(channel.id)}">
                        <option value="text"${kind === 'text' ? ' selected' : ''}>Текстовый</option>
                        <option value="voice"${kind === 'voice' ? ' selected' : ''}>Голосовой</option>
                    </select>
                    <div class="server-channel-controls">
                        <button class="btn-flat" type="button" data-channel-save="${this.esc(channel.id)}">Сохранить</button>
                        <button class="btn-flat" type="button" data-channel-delete="${this.esc(channel.id)}">Удалить</button>
                    </div>
                </div>
                <div class="server-channel-body">
                    <input class="settings-input" data-channel-topic="${this.esc(channel.id)}" value="${this.esc(channel.topic || '')}" placeholder="Тема или описание">
                    <label class="server-channel-position">
                        <span class="server-channel-position-label">Позиция</span>
                        <input class="settings-input" data-channel-position="${this.esc(channel.id)}" type="number" min="0" step="1" value="${this.esc(String(Number.isFinite(Number(channel.position)) ? Number(channel.position) : 0))}" placeholder="0">
                    </label>
                </div>
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
            this.closeServerOverlay();
            await this.loadServers({ silent: true });
            if (data?.id) {
                this.setActiveServer(data.id, { persist: true });
            }
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось сохранить сервер' });
            this.renderServerModal();
        } finally {
            this.setServerModalState({ saving: false });
        }
    }

    async uploadServerAsset(kind, file) {
        const serverId = this.S.serverModal.serverId || this.S.activeServer;
        if (!serverId || !file || this.S.serverModal.mode !== 'edit') return;
        const downscaled = await this.downscaleServerAssetFile(file, kind);
        const dataUrl = await this.readFileAsDataURL(downscaled);
        const res = await this.apiFetch(this.apiRoutes.servers.assets(serverId, kind), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ data_url: dataUrl }),
        });
        if (!res.ok && res.status !== 204) {
            throw new Error(await res.text() || `Не удалось обновить ${kind}`);
        }
        this.clearServerAssetCache(serverId, kind);
        await this.syncServerAssetPreview(serverId);
    }

    async removeServerAsset(kind) {
        const serverId = this.S.serverModal.serverId || this.S.activeServer;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
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

    channelPayloadFromCard(channelId) {
        const card = document.querySelector(`[data-channel-card="${CSS.escape(String(channelId || ''))}"]`);
        if (!card) return null;
        const name = String(card.querySelector(`[data-channel-name="${CSS.escape(String(channelId || ''))}"]`)?.value || '').trim();
        const topic = String(card.querySelector(`[data-channel-topic="${CSS.escape(String(channelId || ''))}"]`)?.value || '').trim();
        const kind = this.normalizeChannelKind(card.querySelector(`[data-channel-kind="${CSS.escape(String(channelId || ''))}"]`)?.value || 'text');
        const positionValue = String(card.querySelector(`[data-channel-position="${CSS.escape(String(channelId || ''))}"]`)?.value || '').trim();
        const position = positionValue === '' ? undefined : Number(positionValue);
        return {
            name,
            topic,
            kind,
            position: Number.isFinite(position) ? position : undefined,
        };
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

    async saveServerChannel(channelId) {
        const serverId = this.S.serverModal.serverId;
        if (!serverId || this.S.serverModal.mode !== 'edit') return;
        const cid = String(channelId || '').trim();
        const payload = this.channelPayloadFromCard(cid);
        if (!payload || !payload.name) {
            this.setServerModalState({ error: 'Введите название канала' });
            this.renderServerModal();
            return;
        }
        this.setServerModalState({ saving: true, error: '' });
        this.renderServerModal();
        try {
            const res = await this.apiFetch(this.apiRoutes.servers.channel(serverId, cid), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
            if (!res.ok) {
                throw new Error(await res.text() || 'Не удалось сохранить канал');
            }
            const data = await res.json();
            const channels = this.normalizeServerChannels(Array.isArray(data) ? data : (Array.isArray(data?.channels) ? data.channels : []));
            this.setServerModalState({ channels, error: '' });
            await this.loadServers({ silent: true });
            if (this.S.activeServer === serverId) {
                this.setActiveServer(serverId, { persist: true });
            }
            this.renderServerModal();
        } catch (e) {
            this.setServerModalState({ error: e?.message || 'Не удалось сохранить канал' });
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
