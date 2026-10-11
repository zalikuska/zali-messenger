// --- ZaliInterface: категории настроек — в левой панели, на месте списка чатов. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Пока открыты настройки (приложения или сервера), список диалогов слева
// заменяется списком категорий, а справа показывается только выбранная. Так
// «куда я попал» и «куда ещё можно» всегда на виду, а длинная простыня карточек
// не прокручивается целиком.
//
// Панель — один общий механизм: syncSidebarPanel() решает по состоянию, что
// показывать (настройки сервера важнее настроек приложения), и перерисовывает
// только при изменении. Вызывается из open*View(), открытия/закрытия окна
// сервера и перерисовки окна сервера.

const ZALI_SETTINGS_CAT_KEY = 'zali_settings_category_v1';

ZaliMixin(ZaliInterface, class {

    /** Категории настроек приложения → карточки (data-settings-section). */
    settingsCategories() {
        const ico = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
        return [
            { id: 'profile', label: 'Профиль', sections: ['profile', 'game-activity', 'game-focus'],
              icon: ico('<circle cx="12" cy="8" r="3.6"/><path d="M4.5 20c.6-3.8 3.6-6 7.5-6s6.9 2.2 7.5 6"/>') },
            { id: 'appearance', label: 'Оформление', sections: ['theme', 'design', 'navigation'],
              icon: ico('<path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.9 1.5-1.9-.3-1 .4-2.1 1.5-2.1H17a4 4 0 0 0 4-4c0-5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>') },
            { id: 'sound', label: 'Звук и звонки', sections: ['audio', 'notify-sound'],
              icon: ico('<path d="M4 10v4h4l5 4V6l-5 4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"/>') },
            { id: 'account', label: 'Аккаунт', sections: ['session', 'crypto'],
              icon: ico('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>') },
            { id: 'app', label: 'Приложение', sections: ['updates', 'autostart', 'cache'],
              icon: ico('<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M9 12h6M12 9v6"/>') },
            { id: 'dev', label: 'Для разработчиков', sections: ['voice-trace', 'logs'],
              icon: ico('<path d="m8 8-4 4 4 4M16 8l4 4-4 4M14 5l-4 14"/>') },
        ];
    }

    settingsActiveCategory() {
        const cats = this.settingsCategories();
        let id = '';
        try { id = localStorage.getItem(ZALI_SETTINGS_CAT_KEY) || ''; } catch (e) { /* без хранилища */ }
        return cats.some(c => c.id === id) ? id : cats[0].id;
    }

    setSettingsCategory(id) {
        const cats = this.settingsCategories();
        const next = cats.some(c => c.id === id) ? id : cats[0].id;
        try { localStorage.setItem(ZALI_SETTINGS_CAT_KEY, next); } catch (e) { /* не критично */ }
        this.applySettingsCategory();
        this.syncSidebarPanel({ force: true });
    }

    /** Показывает карточки выбранной категории; остальные скрыты. */
    applySettingsCategory() {
        const view = document.getElementById('viewSettings');
        if (!view) return;
        const active = this.settingsActiveCategory();
        const cats = this.settingsCategories();
        const bySection = new Map();
        cats.forEach(cat => cat.sections.forEach(section => bySection.set(section, cat.id)));
        view.setAttribute('data-settings-cat', active);
        view.querySelectorAll('[data-settings-section]').forEach((card) => {
            const section = card.getAttribute('data-settings-section');
            // Карточка, которой нет в карте, не должна пропасть: она в «Приложении».
            card.setAttribute('data-settings-cat', bySection.get(section) || 'app');
        });
        // «Для разработчиков» раньше раскрывалось заголовком; теперь выбор
        // категории и есть намерение — карточки показываются сами.
        view.querySelector('.settings-shell')?.classList.toggle('dev-open', active === 'dev');
        const scroller = view.querySelector('.settings-scroll');
        if (scroller) scroller.scrollTop = 0;
        this.renderSettingsCategoryBar();
    }

    /** Полоса категорий в самом экране настроек — для телефона, где нет левой панели. */
    renderSettingsCategoryBar() {
        const bar = document.getElementById('settingsCats');
        if (!bar) return;
        const active = this.settingsActiveCategory();
        bar.innerHTML = this.settingsCategories().map(cat => `<button type="button" class="settings-cat${cat.id === active ? ' is-active' : ''}" data-settings-cat-btn="${this.esc(cat.id)}">${this.esc(cat.label)}</button>`).join('');
    }

    /** Что должна показывать левая панель сейчас: { kind, title, items, active, footer } | null. */
    sidebarPanelConfig() {
        const overlay = document.getElementById('serverOverlay');
        const modal = this.S.serverModal || {};
        const serverOpen = !!overlay && !overlay.hidden && overlay.classList.contains('visible') && modal.mode === 'edit';
        if (serverOpen) {
            const server = (this.S.servers || []).find(s => s.id === modal.serverId) || this.currentServer();
            const ico = (path) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${path}</svg>`;
            const labels = {
                overview: ['Обзор', ico('<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>')],
                channels: ['Каналы', ico('<path d="M5 9h14M5 15h14M10 4 8 20M16 4l-2 16"/>')],
                roles: ['Роли', ico('<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6z"/><path d="m9 12 2 2 4-4"/>')],
                members: ['Участники', ico('<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M18 14.4c1.8.8 3 2.7 3 5.6"/>')],
            };
            return {
                kind: 'server',
                title: String(server?.name || 'Настройки сервера'),
                caption: 'Настройки сервера',
                items: this.serverModalSectionsForMode('edit').map(id => ({ id, label: labels[id][0], icon: labels[id][1] })),
                active: this.serverModalActiveSection('edit'),
                footer: { id: 'close-server', label: 'Закрыть настройки' },
            };
        }
        if (document.getElementById('viewSettings')?.classList.contains('active')) {
            return {
                kind: 'settings',
                title: 'Настройки',
                caption: '',
                items: this.settingsCategories().map(({ id, label, icon }) => ({ id, label, icon })),
                active: this.settingsActiveCategory(),
                footer: null,
            };
        }
        return null;
    }

    syncSidebarPanel({ force = false } = {}) {
        const box = document.getElementById('sidebarSettings');
        if (!box) return;
        const cfg = this.sidebarPanelConfig();
        const signature = cfg ? JSON.stringify([cfg.kind, cfg.title, cfg.items.map(i => i.id), cfg.active]) : '';
        if (!force && this._sidebarPanelSig === signature) return;
        this._sidebarPanelSig = signature;
        if (!cfg) {
            box.hidden = true;
            box.innerHTML = '';
            document.body.removeAttribute('data-sidebar-panel');
            return;
        }
        box.hidden = false;
        document.body.setAttribute('data-sidebar-panel', cfg.kind);
        box.setAttribute('data-panel-kind', cfg.kind);
        box.innerHTML = `
            <div class="sidebar-settings-head">
                ${cfg.caption ? `<span class="sidebar-settings-caption">${this.esc(cfg.caption)}</span>` : ''}
                <strong class="sidebar-settings-title">${this.esc(cfg.title)}</strong>
            </div>
            <nav class="sidebar-settings-nav" aria-label="${this.esc(cfg.caption || cfg.title)}">
                ${cfg.items.map(item => `<button type="button" class="sidebar-settings-item${item.id === cfg.active ? ' is-active' : ''}" data-sidebar-item="${this.esc(item.id)}"${item.id === cfg.active ? ' aria-current="page"' : ''}>
                    <span class="sidebar-settings-ico">${item.icon || ''}</span>
                    <span class="sidebar-settings-label">${this.esc(item.label)}</span>
                </button>`).join('')}
            </nav>
            ${cfg.footer ? `<button type="button" class="sidebar-settings-foot" data-sidebar-footer="${this.esc(cfg.footer.id)}">${this.esc(cfg.footer.label)}</button>` : ''}`;
    }

    bindSidebarSettingsEvents() {
        const box = document.getElementById('sidebarSettings');
        if (box && !box.__bound) {
            box.__bound = true;
            box.addEventListener('click', (e) => {
                const item = e.target.closest('[data-sidebar-item]');
                if (item) {
                    const id = item.getAttribute('data-sidebar-item');
                    if (box.getAttribute('data-panel-kind') === 'server') this.setServerModalSection(id);
                    else this.setSettingsCategory(id);
                    return;
                }
                if (e.target.closest('[data-sidebar-footer="close-server"]')) this.closeServerOverlay();
            });
        }
        const bar = document.getElementById('settingsCats');
        if (bar && !bar.__bound) {
            bar.__bound = true;
            bar.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-settings-cat-btn]');
                if (btn) this.setSettingsCategory(btn.getAttribute('data-settings-cat-btn'));
            });
        }
        this.applySettingsCategory();
    }
});
