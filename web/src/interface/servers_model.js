// --- ZaliInterface: Модель серверов и ролей, работа с цветом. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    getDefaultServers() {
        return [];
    }

    defaultServerChannels(serverId) {
        const sid = String(serverId || '').trim();
        return [
            { id: `${sid}-general`, name: 'general', topic: 'Общий чат', kind: 'text', position: 0 },
            { id: `${sid}-voice`, name: 'voice', topic: 'Голосовой канал', kind: 'voice', position: 1 },
        ];
    }

    ensureServerChannels(server = {}) {
        const next = { ...server };
        const channels = Array.isArray(next.channels) ? next.channels.filter(Boolean).map(channel => ({ ...channel })) : [];
        if (!channels.length && next.id) {
            next.channels = this.defaultServerChannels(next.id);
            return next;
        }
        next.channels = channels.map((channel, index) => ({
            ...channel,
            kind: String(channel.kind || 'text').trim().toLowerCase() || 'text',
            position: Number.isFinite(Number(channel.position)) ? Number(channel.position) : index,
        })).sort((a, b) => Number(a.position || 0) - Number(b.position || 0));
        return next;
    }

    ensureServersState() {
        this.S.servers = Array.isArray(this.S.servers)
            ? this.S.servers.map(server => this.ensureServerChannels(server))
            : [];
        const stored = this.loadStoredActiveServer();
        if (stored && this.S.servers.some(s => s.id === stored)) {
            this.S.activeServer = stored;
        } else if (!this.S.servers.some(s => s.id === this.S.activeServer)) {
            this.S.activeServer = null;
            this.S.activeChannel = null;
        }
    }

    updateSidebarModeLabel() {
        const label = document.querySelector('.nav-label');
        if (label) {
            label.textContent = this.S.navMode === 'servers' ? 'Сервера' : 'Диалоги';
        }
    }

    updateNavModeButtons() {
        const dmBtn = document.getElementById('modeDmBtn');
        const serversBtn = document.getElementById('modeServersBtn');
        const isServers = this.S.navMode === 'servers';
        if (dmBtn) {
            dmBtn.classList.toggle('active', !isServers);
            dmBtn.setAttribute('aria-pressed', String(!isServers));
        }
        if (serversBtn) {
            serversBtn.classList.toggle('active', isServers);
            serversBtn.setAttribute('aria-pressed', String(isServers));
        }
        document.body?.setAttribute('data-nav-mode', this.S.navMode);
        const viewChat = document.getElementById('viewChat');
        if (viewChat) viewChat.classList.toggle('server-mode', isServers);
        this.updateSidebarModeLabel();
        this.renderHubSegmentNav();
    }

    normalizeServers(servers) {
        return Array.isArray(servers) ? servers.map(server => ({
            ...server,
            channels: Array.isArray(server.channels) && server.channels.length ? server.channels.map(channel => ({ ...channel })) : [],
            myRole: server.myRole || server.my_role || null,
            memberCount: Number(server.memberCount || server.member_count || 0) || 0,
            joinLink: server.joinLink || server.join_link || '',
        })).map(server => this.ensureServerChannels(server)).filter(Boolean) : [];
    }

    normalizeMemberRole(role) {
        const value = String(role || '').trim().toLowerCase();
        if (value === 'owner') return 'owner';
        if (value === 'admin') return 'admin';
        return 'member';
    }

    roleLabel(role) {
        switch (this.normalizeMemberRole(role)) {
            case 'owner': return 'Владелец';
            case 'admin': return 'Админ';
            default: return 'Участник';
        }
    }

    serverRoleLabel(roleId) {
        const role = String(roleId || '').trim();
        if (!role) return 'Участник';
        if (role === 'owner') return 'Владелец';
        if (role === 'admin') return 'Админ';
        if (role === 'member') return 'Участник';
        const found = (this.S.serverModal.roles || []).find(item => String(item.roleId || '') === role);
        return found?.name || role;
    }

    serverRoleList() {
        return Array.isArray(this.S.serverModal.roles) ? this.S.serverModal.roles : [];
    }

    draftServerRoleList() {
        return Array.isArray(this.S.serverModal.draftRoles) ? this.S.serverModal.draftRoles : [];
    }

    serverRolePermissionDefs() {
        return [
            { key: 'can_view', label: 'Чтение каналов', hint: 'Видеть список и историю сообщений', group: 'Доступ', defaultCreate: true },
            { key: 'can_send', label: 'Отправка сообщений', hint: 'Писать в текстовые каналы', group: 'Доступ', defaultCreate: true },
            { key: 'can_react', label: 'Реакции', hint: 'Ставить реакции на сообщения', group: 'Доступ', defaultCreate: true },
            { key: 'can_attach', label: 'Файлы', hint: 'Прикреплять изображения и файлы', group: 'Доступ', defaultCreate: true },
            { key: 'can_embed', label: 'Ссылки и медиа', hint: 'Встраивать превью ссылок', group: 'Доступ', defaultCreate: true },
            { key: 'can_voice', label: 'Голосовые каналы', hint: 'Входить и говорить в voice', group: 'Доступ', defaultCreate: true },
            { key: 'can_manage', label: 'Управление сервером', hint: 'Общие админские действия', group: 'Управление', defaultCreate: false },
            { key: 'can_manage_channels', label: 'Каналы', hint: 'Создавать и менять каналы', group: 'Управление', defaultCreate: false },
            { key: 'can_manage_roles', label: 'Роли', hint: 'Создавать и менять роли', group: 'Управление', defaultCreate: false },
            { key: 'can_invite', label: 'Приглашения', hint: 'Генерировать инвайты', group: 'Управление', defaultCreate: true },
            { key: 'can_pin', label: 'Закреплять', hint: 'Закреплять важные сообщения', group: 'Управление', defaultCreate: false },
            { key: 'can_mention', label: '@everyone', hint: 'Упоминать всех участников', group: 'Управление', defaultCreate: false },
            { key: 'can_kick', label: 'Исключать', hint: 'Кикать участников из сервера', group: 'Управление', defaultCreate: false },
            { key: 'can_ban', label: 'Бан', hint: 'Блокировать участников', group: 'Управление', defaultCreate: false },
        ];
    }

    serverRolePermissionValue(role, key) {
        if (!role) return false;
        if (Object.prototype.hasOwnProperty.call(role, key)) return !!role[key];
        const camel = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
        if (Object.prototype.hasOwnProperty.call(role, camel)) return !!role[camel];
        return false;
    }

    serverModalColorPickerState(key) {
        return !!this.S.serverModal?.colorPickers?.[key];
    }

    setServerModalColorPickerState(key, open) {
        const next = {
            ...(this.S.serverModal.colorPickers || {}),
            [key]: !!open,
        };
        this.setServerModalState({ colorPickers: next });
    }

    toggleServerModalColorPicker(key) {
        const next = !this.serverModalColorPickerState(key);
        this.setServerModalColorPickerState(key, next);
        this.renderServerModal();
    }

    serverRolePermissionsHtml(role, keyPrefix = '', attrName = 'data-role-perm') {
        const defs = this.serverRolePermissionDefs();
        const sections = defs.reduce((acc, def) => {
            if (!acc[def.group]) acc[def.group] = [];
            acc[def.group].push(def);
            return acc;
        }, {});
        return Object.entries(sections).map(([groupName, items]) => {
            const rows = items.map(def => {
                const key = def.key;
                const checked = this.serverRolePermissionValue(role, key) ? 'checked' : '';
                return `<label class="server-perm-row server-perm-row--stacked">
                    <span>
                        <strong>${this.esc(def.label)}</strong>
                        <small>${this.esc(def.hint)}</small>
                    </span>
                    <input type="checkbox" ${attrName}="${this.esc(key)}" ${checked}>
                </label>`;
            }).join('');
            return `<div class="server-perm-group">
                <div class="server-perm-group-title">${this.esc(groupName)}</div>
                <div class="server-perm-grid server-perm-grid--dense">${rows}</div>
            </div>`;
        }).join('');
    }

    serverRolePermissionsCount(role) {
        return this.serverRolePermissionDefs().reduce((total, def) => total + Number(!!this.serverRolePermissionValue(role, def.key)), 0);
    }

    serverRoleCreateDefaults() {
        const defaults = {};
        this.serverRolePermissionDefs().forEach(def => {
            defaults[def.key] = !!def.defaultCreate;
        });
        return defaults;
    }

    applyServerRoleCreateDefaults() {
        const defaults = this.serverRoleCreateDefaults();
        this.serverRolePermissionDefs().forEach(def => {
            const el = document.querySelector(`[data-server-role-perm="${CSS.escape(def.key)}"]`);
            if (el) el.checked = !!defaults[def.key];
        });
    }

    syncDraftServerRolesFromDom() {
        if (this.S.serverModal.mode !== 'create') return this.draftServerRoleList();
        const cards = Array.from(document.querySelectorAll('[data-draft-role-card]'));
        const roles = cards.map(card => {
            const draftId = String(card.getAttribute('data-draft-role-card') || '').trim();
            const permissions = {};
            this.serverRolePermissionDefs().forEach(def => {
                permissions[def.key] = !!card.querySelector(`[data-draft-role-perm="${CSS.escape(def.key)}"]`)?.checked;
            });
            return {
                draftId,
                collapsed: String(card.getAttribute('data-draft-role-collapsed') || '1') !== '0',
                name: String(card.querySelector('[data-draft-role-name]')?.value || '').trim(),
                color: this.normalizeColorValue(card.querySelector('[data-draft-role-color]')?.value || '#cbff00'),
                ...permissions,
            };
        }).filter(role => role.draftId);
        this.setServerModalState({ draftRoles: roles });
        return roles;
    }

    serverRoleOptionsHtml(selected = 'member') {
        const roles = [...this.serverRoleList(), ...this.draftServerRoleList()];
        const options = [
            { roleId: 'member', name: 'Участник' },
            { roleId: 'admin', name: 'Админ' },
            ...roles.filter(role => role.roleId && role.roleId !== 'member' && role.roleId !== 'admin' && role.roleId !== 'owner'),
        ];
        return options.map(role => {
            const roleId = String(role.roleId || '').trim();
            const label = this.esc(role.name || this.serverRoleLabel(roleId));
            const isSelected = roleId === String(selected || '').trim() ? 'selected' : '';
            return `<option value="${this.esc(roleId)}" ${isSelected}>${label}</option>`;
        }).join('');
    }

    normalizeColorValue(value) {
        const raw = String(value || '').trim();
        if (/^#[0-9a-fA-F]{6}$/.test(raw)) return raw.toLowerCase();
        return '#cbff00';
    }

    hexToRgb(hex) {
        const value = this.normalizeColorValue(hex).slice(1);
        const num = Number.parseInt(value, 16);
        return {
            r: (num >> 16) & 255,
            g: (num >> 8) & 255,
            b: num & 255,
        };
    }

    rgbToHex(r, g, b) {
        const toHex = (n) => Number(n || 0).toString(16).padStart(2, '0');
        return `#${toHex(Math.max(0, Math.min(255, Math.round(r))))}${toHex(Math.max(0, Math.min(255, Math.round(g))))}${toHex(Math.max(0, Math.min(255, Math.round(b))))}`;
    }

    rgbToHsl(r, g, b) {
        const rn = (r || 0) / 255;
        const gn = (g || 0) / 255;
        const bn = (b || 0) / 255;
        const max = Math.max(rn, gn, bn);
        const min = Math.min(rn, gn, bn);
        const delta = max - min;
        let h = 0;
        let s = 0;
        const l = (max + min) / 2;
        if (delta !== 0) {
            s = delta / (1 - Math.abs(2 * l - 1));
            switch (max) {
                case rn:
                    h = 60 * (((gn - bn) / delta) % 6);
                    break;
                case gn:
                    h = 60 * (((bn - rn) / delta) + 2);
                    break;
                default:
                    h = 60 * (((rn - gn) / delta) + 4);
                    break;
            }
        }
        return {
            h: (h + 360) % 360,
            s: s * 100,
            l: l * 100,
        };
    }

    hslToRgb(h, s, l) {
        const hue = ((h % 360) + 360) % 360;
        const sat = Math.max(0, Math.min(100, Number(s) || 0)) / 100;
        const lig = Math.max(0, Math.min(100, Number(l) || 0)) / 100;
        const c = (1 - Math.abs(2 * lig - 1)) * sat;
        const hp = hue / 60;
        const x = c * (1 - Math.abs((hp % 2) - 1));
        let r1 = 0, g1 = 0, b1 = 0;
        if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
        else if (hp < 2) [r1, g1, b1] = [x, c, 0];
        else if (hp < 3) [r1, g1, b1] = [0, c, x];
        else if (hp < 4) [r1, g1, b1] = [0, x, c];
        else if (hp < 5) [r1, g1, b1] = [x, 0, c];
        else [r1, g1, b1] = [c, 0, x];
        const m = lig - c / 2;
        return {
            r: Math.round((r1 + m) * 255),
            g: Math.round((g1 + m) * 255),
            b: Math.round((b1 + m) * 255),
        };
    }

    hueToHex(hue) {
        const rgb = this.hslToRgb(hue, 100, 50);
        return this.rgbToHex(rgb.r, rgb.g, rgb.b);
    }

    bindColorWheel({ wheelId, hiddenId, hexId, initialValue = '#cbff00' }) {
        const wheel = document.getElementById(wheelId);
        const hidden = document.getElementById(hiddenId);
        const hexInput = document.getElementById(hexId);
        if (!wheel || this.colorWheelBindings.has(wheelId)) return;
        this.colorWheelBindings.add(wheelId);
        const updatePreview = (value) => {
            const normalized = this.normalizeColorValue(value);
            const picker = wheel.closest('.color-picker');
            const preview = picker?.querySelector('.color-picker-preview');
            if (preview) preview.style.background = normalized;
        };

        const setFromPoint = (clientX, clientY) => {
            const rect = wheel.getBoundingClientRect();
            if (!rect.width || !rect.height) return;
            const dx = clientX - rect.left - rect.width / 2;
            const dy = clientY - rect.top - rect.height / 2;
            const angle = Math.atan2(dy, dx) * 180 / Math.PI + 90;
            const nextValue = this.hueToHex(angle);
            this.applyColorWheelValue({ wheel, hidden, hexInput, value: nextValue });
            updatePreview(nextValue);
        };

        const onPointerDown = (e) => {
            e.preventDefault();
            try { wheel.setPointerCapture(e.pointerId); } catch (_) {}
            setFromPoint(e.clientX, e.clientY);
        };
        const onPointerMove = (e) => {
            if ((e.buttons || 0) === 0) return;
            setFromPoint(e.clientX, e.clientY);
        };
        const onClick = (e) => {
            if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return;
            setFromPoint(e.clientX, e.clientY);
        };
        const onHexInput = () => {
            const nextValue = hexInput?.value || hidden?.value || initialValue;
            this.applyColorWheelValue({ wheel, hidden, hexInput, value: nextValue });
            updatePreview(nextValue);
        };

        wheel.addEventListener('pointerdown', onPointerDown);
        wheel.addEventListener('pointermove', onPointerMove);
        wheel.addEventListener('mousedown', onPointerDown);
        wheel.addEventListener('click', onClick);
        hexInput?.addEventListener('input', onHexInput);
        hidden?.addEventListener('input', () => {
            this.applyColorWheelValue({ wheel, hidden, hexInput, value: hidden.value });
            updatePreview(hidden.value);
        });
    }

    applyColorWheelValue({ wheel, hidden, hexInput, value }) {
        if (!wheel) return;
        const normalized = this.normalizeColorValue(value);
        const { h } = this.rgbToHsl(...Object.values(this.hexToRgb(normalized)));
        const rect = wheel.getBoundingClientRect();
        const radius = Math.max(20, Math.min(rect.width, rect.height) * 0.36);
        const angle = ((h - 90) * Math.PI) / 180;
        const x = (rect.width / 2) + Math.cos(angle) * radius;
        const y = (rect.height / 2) + Math.sin(angle) * radius;
        wheel.style.setProperty('--thumb-x', `${x}px`);
        wheel.style.setProperty('--thumb-y', `${y}px`);
        wheel.style.setProperty('--wheel-color', normalized);
        if (hidden && hidden.value !== normalized) hidden.value = normalized;
        if (hexInput && hexInput.value.toLowerCase() !== normalized) hexInput.value = normalized;
    }
});
