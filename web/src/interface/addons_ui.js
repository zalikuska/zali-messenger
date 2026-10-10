// --- ZaliInterface: аддоны в хабе — список, установка, сведения, удаление. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Дизайн — docs/ADDONS.md.
// Запуск и песочница — addons_runtime.js, хранилище — addons_store.js.

const ZALI_ADDON_ICON_MAX_BYTES = 256 * 1024;

ZaliMixin(ZaliInterface, class {

    addonsAvailable() {
        return this.addonsSandboxAvailable() && this.addonStoreKind() !== 'none';
    }

    /** Вызывается из bindEvents(): слот в верхней полосе, клики хаба, первый список. */
    bindAddonEvents() {
        this.placeAddonTitlebarSlot();
        this.renderAddonTitlebar();
        document.getElementById('hubAddons')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-addon-action]');
            if (!btn || btn.disabled) return;
            const id = btn.closest('[data-addon-id]')?.getAttribute('data-addon-id') || '';
            this.handleAddonAction(btn.getAttribute('data-addon-action'), id);
        });
        const input = document.getElementById('addonFileInput');
        input?.addEventListener('change', () => {
            const file = input.files?.[0];
            input.value = '';
            if (file) this.installAddonFromFile(file);
        });
        const onTitlebarClick = (e) => {
            const btn = e.target.closest('[data-addon-tb]');
            if (!btn) return;
            if (btn.getAttribute('data-addon-tb') === 'collapse') this.collapseAddon();
            else this.expandAddon(btn.getAttribute('data-addon-id') || '');
        };
        document.getElementById('tbAddon')?.addEventListener('click', onTitlebarClick);
        document.getElementById('addonStageBar')?.addEventListener('click', onTitlebarClick);
        this.refreshAddonsList();
    }

    handleAddonAction(action, id) {
        if (action === 'install') {
            document.getElementById('addonFileInput')?.click();
        } else if (action === 'retry') {
            this.refreshAddonsList();
        } else if (action === 'open') {
            this.setAddonsStatus('');
            this.launchAddon(id).catch((error) => {
                this.setAddonsStatus(`Не удалось открыть аддон: ${error?.message || error}`, 'error');
            });
        } else if (action === 'stop') {
            this.stopAddon(id);
        } else if (action === 'details') {
            const meta = (this._addonsList || []).find(item => item.id === id);
            if (meta) this.showAddonDetailsDialog(meta);
        }
    }

    async refreshAddonsList() {
        if (!this.addonsAvailable()) {
            this._addonsList = [];
            this.renderHubAddons();
            return;
        }
        this._addonsLoading = true;
        this.renderHubAddons();
        try {
            const list = await this.addonStoreList();
            this._addonsList = list
                .filter(item => item && item.id && item.manifest)
                .sort((a, b) => String(a.manifest.name).localeCompare(String(b.manifest.name), 'ru'));
            this._addonsError = '';
        } catch (error) {
            this._addonsError = error?.message || String(error);
        } finally {
            this._addonsLoading = false;
            this.renderHubAddons();
        }
    }

    setAddonsStatus(text, tone = '') {
        const el = document.getElementById('hubAddonsStatus');
        if (!el) return;
        el.textContent = text || '';
        el.hidden = !text;
        el.classList.toggle('is-error', tone === 'error');
        el.classList.toggle('is-success', tone === 'success');
    }

    addonIconHtml(meta) {
        const src = String(meta?.iconDataUrl || '');
        if (/^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(src)) {
            return `<span class="hub-addon-icon"><img src="${this.esc(src)}" alt=""></span>`;
        }
        const letter = String(meta?.manifest?.name || '?').trim().charAt(0).toUpperCase() || '?';
        return `<span class="hub-addon-icon" aria-hidden="true">${this.esc(letter)}</span>`;
    }

    renderHubAddons() {
        const list = document.getElementById('hubAddonsList');
        const installBtn = document.getElementById('hubAddonsInstallBtn');
        if (!list) return;
        const available = this.addonsAvailable();
        if (installBtn) {
            installBtn.hidden = !available;
            installBtn.disabled = !!this._addonInstallBusy;
        }
        if (!available) {
            list.innerHTML = '<p class="hub-addons-note">Аддоны недоступны в этой версии приложения.</p>';
            return;
        }
        if (this._addonsError) {
            list.innerHTML = `<div class="hub-addons-note is-error">
                <span>Не удалось открыть хранилище аддонов: ${this.esc(this._addonsError)}</span>
                <button class="btn-flat" type="button" data-addon-action="retry">Повторить</button>
            </div>`;
            return;
        }
        const items = this._addonsList || [];
        if (!items.length) {
            list.innerHTML = this._addonsLoading
                ? '<p class="hub-addons-note"><span class="addon-frame-spinner" aria-hidden="true"></span>Загрузка аддонов…</p>'
                : `<div class="hub-addons-empty">
                    <strong>Аддонов пока нет</strong>
                    <span>Установите мини-приложение из файла .zali: игру, запись голоса, лаунчер.</span>
                </div>`;
            return;
        }
        const F = window.ZaliAddonFormat;
        list.innerHTML = items.map((meta) => {
            const m = meta.manifest;
            const instance = this.addonInstances().get(meta.id);
            const running = !!instance;
            const elevated = m.permissions.some(p => F.isElevated(p));
            return `<article class="hub-addon-item${running ? ' is-running' : ''}" data-addon-id="${this.esc(meta.id)}">
                ${this.addonIconHtml(meta)}
                <div class="hub-addon-main">
                    <div class="hub-component-top">
                        <strong>${this.esc(m.name)}</strong>
                        <span class="hub-component-version">${this.esc(m.version)}</span>
                        ${elevated ? '<span class="hub-addon-flag is-elevated">Повышенные права</span>' : ''}
                        ${running ? '<span class="hub-addon-flag is-running">Работает</span>' : ''}
                    </div>
                    <p>${this.esc(m.description || 'Без описания')}</p>
                </div>
                <div class="hub-addon-actions">
                    <button class="auth-btn primary" type="button" data-addon-action="open">${running ? 'Развернуть' : 'Открыть'}</button>
                    ${running ? '<button class="btn-flat" type="button" data-addon-action="stop">Остановить</button>' : ''}
                    <button class="hub-addon-more" type="button" data-addon-action="details" title="Об аддоне" aria-label="Об аддоне «${this.esc(m.name)}»">
                        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="4.5" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="15.5" cy="10" r="1.6"/></svg>
                    </button>
                </div>
            </article>`;
        }).join('');
    }

    // ---- Установка ----

    async installAddonFromFile(file) {
        const F = window.ZaliAddonFormat;
        if (this._addonInstallBusy) return;
        this.setAddonsStatus('');
        if (!this.addonsAvailable()) return;
        if (Number(file?.size || 0) > F.LIMITS.fileBytes) {
            this.setAddonsStatus('Файл не подошёл: аддон больше 32 МБ.', 'error');
            return;
        }
        let info;
        try {
            info = await F.inspect(new Uint8Array(await file.arrayBuffer()));
        } catch (error) {
            this.setAddonsStatus(`Файл не подошёл: ${error?.message || error}`, 'error');
            return;
        }
        const m = info.manifest;
        const existing = (this._addonsList || []).find(item => item.id === m.id) || null;
        const unsupported = m.permissions.filter(p => !this.addonPermissionSupported(p, m));
        const confirmed = await this.showAddonInstallDialog(info, existing, unsupported);
        if (!confirmed) return;

        this._addonInstallBusy = true;
        this.renderHubAddons();
        this.setAddonsStatus(existing ? `Обновляем «${m.name}»…` : `Устанавливаем «${m.name}»…`);
        try {
            if (this.addonInstances().has(m.id)) this.stopAddon(m.id);
            const now = Date.now();
            const meta = {
                id: m.id,
                manifest: m,
                sha256: info.sha256,
                size: info.size,
                iconDataUrl: this.addonIconDataUrl(info),
                installedAt: existing?.installedAt || now,
                updatedAt: now,
            };
            await this.addonStorePut(meta, info.bytes);
            await this.refreshAddonsList();
            this.setAddonsStatus(existing ? `«${m.name}» обновлён до ${m.version}.` : `«${m.name}» установлен — откройте его кнопкой «Открыть».`, 'success');
        } catch (error) {
            this.setAddonsStatus(`Не удалось установить «${m.name}»: ${error?.message || error}`, 'error');
        } finally {
            this._addonInstallBusy = false;
            this.renderHubAddons();
        }
    }

    addonIconDataUrl(info) {
        const path = info.manifest.icon;
        const bytes = path ? info.files.get(path) : null;
        if (!bytes || bytes.length > ZALI_ADDON_ICON_MAX_BYTES) return '';
        const mime = window.ZaliAddonFormat.mimeForPath(path);
        return `data:${mime};base64,${this.addonBytesToBase64(bytes)}`;
    }

    addonSizeLabel(bytes) {
        const n = Number(bytes || 0);
        if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1).replace('.', ',')} МБ`;
        if (n >= 1024) return `${Math.max(1, Math.round(n / 1024))} КБ`;
        return `${n} Б`;
    }

    addonFingerprintLabel(sha256) {
        const hex = String(sha256 || '');
        return hex ? hex.slice(0, 32).match(/.{1,4}/g).join(' ') : '—';
    }

    /** Список разрешений по уровням. newSet — подсветить новые при обновлении. */
    addonPermissionsHtml(manifest, { newSet = null, unsupported = [] } = {}) {
        const F = window.ZaliAddonFormat;
        const row = (permission) => {
            const info = F.permissionInfo(permission);
            const hosts = permission === 'network' && manifest.network.length
                ? `<span class="addon-perm-hosts">Сайты: ${this.esc(manifest.network.join(', '))}</span>`
                : '';
            const isNew = newSet && newSet.has(permission);
            return `<li class="addon-perm${unsupported.includes(permission) ? ' is-unsupported' : ''}">
                <strong>${this.esc(info?.title || permission)}${isNew ? ' <em class="addon-perm-new">новое</em>' : ''}</strong>
                <span>${this.esc(info?.description || '')}</span>
                ${hosts}
            </li>`;
        };
        const normal = manifest.permissions.filter(p => !F.isElevated(p));
        const elevated = manifest.permissions.filter(p => F.isElevated(p));
        let html = '';
        if (!normal.length && !elevated.length) {
            html += '<p class="addon-perm-none">Только свой интерфейс и свои настройки — без файлов, сети и микрофона.</p>';
        }
        if (normal.length) html += `<ul class="addon-perm-list">${normal.map(row).join('')}</ul>`;
        if (elevated.length) {
            html += `<div class="addon-perm-elevated">
                <h3>Повышенные права</h3>
                <ul class="addon-perm-list">${elevated.map(row).join('')}</ul>
                <p>Система попросит подтвердить их при установке и при каждом запуске. Давайте их только аддонам, автору которых доверяете.</p>
            </div>`;
        }
        return html;
    }

    showAddonInstallDialog(info, existing, unsupported) {
        const F = window.ZaliAddonFormat;
        const m = info.manifest;
        const oldPermissions = new Set(existing?.manifest?.permissions || []);
        const newSet = existing ? new Set(m.permissions.filter(p => !oldPermissions.has(p))) : null;
        const sub = [
            existing ? `Обновление ${existing.manifest.version} → ${m.version}` : `Версия ${m.version}`,
            m.author,
            this.addonSizeLabel(info.size),
        ].filter(Boolean).join(' · ');
        const blocked = unsupported.length
            ? `<p class="addon-dialog-error" role="alert">Здесь нельзя выдать: ${this.esc(unsupported.map(p => F.permissionInfo(p)?.title || p).join(', '))}. ${unsupported.some(p => F.isElevated(p)) ? 'Такие аддоны работают в приложении для macOS и Windows.' : ''}</p>`
            : '';
        const html = `
            <div class="addon-dialog-head">
                ${this.addonIconHtml({ manifest: m, iconDataUrl: this.addonIconDataUrl(info) })}
                <div>
                    <h2 id="addonDialogTitle">${existing ? 'Обновить' : 'Установить'} «${this.esc(m.name)}»?</h2>
                    <p class="addon-dialog-sub">${this.esc(sub)}</p>
                </div>
            </div>
            ${m.description ? `<p class="addon-dialog-desc">${this.esc(m.description)}</p>` : ''}
            <section class="addon-dialog-perms" aria-label="Что сможет аддон">
                <h3>Что сможет аддон</h3>
                ${this.addonPermissionsHtml(m, { newSet, unsupported })}
            </section>
            ${blocked}
            <p class="addon-dialog-fp">Отпечаток SHA-256: <code>${this.esc(this.addonFingerprintLabel(info.sha256))}</code></p>
            <div class="coin-transfer-actions">
                <button class="btn-flat" type="button" data-dialog-action="cancel">Отмена</button>
                <button class="auth-btn primary" type="button" data-dialog-action="ok"${unsupported.length ? ' disabled' : ''}>${existing ? 'Обновить' : 'Установить'}</button>
            </div>`;
        return this.openAddonDialog(html).then(action => action === 'ok');
    }

    async showAddonDetailsDialog(meta) {
        const m = meta.manifest;
        const sub = [`Версия ${m.version}`, m.author, this.addonSizeLabel(meta.size)].filter(Boolean).join(' · ');
        const installed = meta.updatedAt ? new Date(meta.updatedAt).toLocaleDateString('ru-RU') : '';
        const html = `
            <div class="addon-dialog-head">
                ${this.addonIconHtml(meta)}
                <div>
                    <h2 id="addonDialogTitle">${this.esc(m.name)}</h2>
                    <p class="addon-dialog-sub">${this.esc(sub)}</p>
                </div>
            </div>
            ${m.description ? `<p class="addon-dialog-desc">${this.esc(m.description)}</p>` : ''}
            <section class="addon-dialog-perms" aria-label="Разрешения">
                <h3>Разрешения</h3>
                ${this.addonPermissionsHtml(m)}
            </section>
            <p class="addon-dialog-fp">Отпечаток SHA-256: <code>${this.esc(this.addonFingerprintLabel(meta.sha256))}</code>${installed ? `<br>Установлен: ${this.esc(installed)}` : ''}</p>
            <div class="coin-transfer-actions addon-dialog-actions">
                <button class="btn-flat addon-dialog-danger" type="button" data-dialog-action="remove">Удалить аддон</button>
                <button class="auth-btn primary" type="button" data-dialog-action="cancel">Закрыть</button>
            </div>`;
        const action = await this.openAddonDialog(html);
        if (action !== 'remove') return;
        const confirmed = await this.confirmAction({
            title: `Удалить «${m.name}»?`,
            message: 'Аддон и всё, что он сохранил, будут удалены с этого устройства.',
            confirmLabel: 'Удалить аддон',
        });
        if (!confirmed) return;
        try {
            this.stopAddon(meta.id);
            await this.addonStoreRemove(meta.id);
            await this.refreshAddonsList();
            this.setAddonsStatus(`«${m.name}» удалён.`, 'success');
        } catch (error) {
            this.setAddonsStatus(`Не удалось удалить «${m.name}»: ${error?.message || error}`, 'error');
        }
    }

    /**
     * Модальное окно аддонов: тот же каркас, что у confirmAction (фокус внутри,
     * Esc и клик мимо — «Отмена»). Кнопки помечаются data-dialog-action.
     * @returns {Promise<string>} действие нажатой кнопки или 'cancel'
     */
    openAddonDialog(innerHtml) {
        const host = document.querySelector('.main') || document.body;
        if (this._addonDialogDismiss) this._addonDialogDismiss('cancel');
        return new Promise((resolve) => {
            const previousFocus = document.activeElement;
            const overlay = document.createElement('div');
            overlay.className = 'coin-transfer-modal addon-dialog';
            overlay.innerHTML = `<div class="coin-transfer-box addon-dialog-box" role="dialog" aria-modal="true" aria-labelledby="addonDialogTitle">${innerHtml}</div>`;
            const buttons = () => Array.from(overlay.querySelectorAll('button:not([disabled])'));
            const finish = (action) => {
                if (this._addonDialogDismiss !== finish) return;
                this._addonDialogDismiss = null;
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                try { previousFocus?.focus?.(); } catch (e) { /* элемента уже нет */ }
                resolve(action);
            };
            const onKey = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    finish('cancel');
                } else if (e.key === 'Tab') {
                    const order = buttons();
                    if (!order.length) return;
                    const idx = order.indexOf(document.activeElement);
                    e.preventDefault();
                    order[(idx + (e.shiftKey ? order.length - 1 : 1) + order.length) % order.length].focus();
                }
            };
            this._addonDialogDismiss = finish;
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    finish('cancel');
                    return;
                }
                const btn = e.target.closest('[data-dialog-action]');
                if (btn && !btn.disabled) finish(btn.getAttribute('data-dialog-action'));
            });
            document.addEventListener('keydown', onKey, true);
            host.appendChild(overlay);
            // По умолчанию в фокусе «Отмена»/«Закрыть»: случайный Enter ничего не ставит и не удаляет.
            (overlay.querySelector('[data-dialog-action="cancel"]') || buttons()[0])?.focus();
        });
    }
});
