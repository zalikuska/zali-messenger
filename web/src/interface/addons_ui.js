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
        this.bindAddonDropZone(document.getElementById('hubAddons'));
        // Быстрый запуск на главной хаба: управление аддонами живёт во вкладке «Аддоны».
        document.getElementById('hubQuick')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-addon-open]');
            if (!btn || btn.disabled) return;
            void this.openAddonFromHub(btn.getAttribute('data-addon-open') || '');
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

    /** Файл .zali, брошенный на раздел «Аддоны», идёт тем же путём, что выбор через «Установить». */
    bindAddonDropZone(zone) {
        if (!zone) return;
        const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
        let depth = 0;
        const clear = () => { depth = 0; zone.classList.remove('is-dropping'); };
        zone.addEventListener('dragenter', (e) => {
            if (!hasFiles(e) || !this.addonsAvailable()) return;
            e.preventDefault();
            depth += 1;
            zone.classList.add('is-dropping');
        });
        zone.addEventListener('dragover', (e) => {
            if (!hasFiles(e) || !this.addonsAvailable()) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        zone.addEventListener('dragleave', () => {
            depth = Math.max(0, depth - 1);
            if (!depth) zone.classList.remove('is-dropping');
        });
        zone.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            clear();
            if (!this.addonsAvailable()) return;
            const files = Array.from(e.dataTransfer.files || []);
            const file = files.find(f => /\.zali$/i.test(f.name)) || files[0];
            if (!file) return;
            if (files.length > 1) this.setAddonsStatus('Брошено несколько файлов — ставлю первый .zali; остальные ставьте по одному.');
            this.installAddonFromFile(file);
        });
    }

    handleAddonAction(action, id) {
        if (action === 'install') {
            document.getElementById('addonFileInput')?.click();
        } else if (action === 'retry') {
            this.refreshAddonsList();
        } else if (action === 'open') {
            this.openAddonFromHub(id);
        } else if (action === 'stop') {
            this.stopAddon(id);
        } else if (action === 'details') {
            const meta = (this._addonsList || []).find(item => item.id === id);
            if (meta) this.showAddonDetailsDialog(meta);
        }
    }

    /** «Открыть»: пока идёт запуск (чтение файла, системное подтверждение), кнопка занята — двойной клик не стартует дважды. */
    async openAddonFromHub(id) {
        if (!this._addonLaunching) this._addonLaunching = new Set();
        if (this._addonLaunching.has(id)) return;
        this._addonLaunching.add(id);
        if (this._addonJustInstalled === id) this._addonJustInstalled = null;
        this.setAddonsStatus('');
        this.renderHubAddons();
        try {
            await this.launchAddon(id);
        } catch (error) {
            this.setAddonsStatus(`Не удалось открыть аддон: ${error?.message || error}`, 'error');
            // Строка состояния живёт во вкладке «Аддоны»: с главной ошибку не видно.
            if (this._hubTab !== 'addons') this.setHubTab('addons');
        } finally {
            this._addonLaunching.delete(id);
            this.renderHubAddons();
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

    /** Фон плашки аддона (manifest.background) как data-URL для хранилища; пусто, если фона нет. */
    async addonBackgroundDataUrl(info) {
        const path = info.manifest.background;
        const bytes = path ? info.files.get(path) : null;
        if (!bytes || bytes.length > window.ZaliAddonFormat.LIMITS.backgroundBytes) return '';
        const mime = window.ZaliAddonFormat.mimeForPath(path);
        const raw = `data:${mime};base64,${this.addonBytesToBase64(bytes)}`;
        // Метаданные аддона ходят через мост оболочек при каждом чтении списка, а
        // плашка — полоса высотой ~90 px: большую растровую картинку сжимаем (до
        // 1200 px по ширине, webp), векторную и так лёгкую оставляем как есть.
        if (mime === 'image/svg+xml' || bytes.length <= 160 * 1024) return raw;
        try {
            const bitmap = await createImageBitmap(new Blob([bytes], { type: mime }));
            const scale = Math.min(1, 1200 / bitmap.width);
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.width * scale));
            canvas.height = Math.max(1, Math.round(bitmap.height * scale));
            canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            bitmap.close?.();
            const blob = await new Promise(res => canvas.toBlob(res, 'image/webp', 0.82));
            if (!blob || blob.size >= bytes.length) return raw;
            const out = new Uint8Array(await blob.arrayBuffer());
            return `data:${blob.type || 'image/webp'};base64,${this.addonBytesToBase64(out)}`;
        } catch (e) {
            return raw;
        }
    }

    /**
     * blob:-адрес фона плашки. Data-URL в разметку не кладём (полезная нагрузка
     * по тексту — см. skill performance): адрес собирается один раз на аддон и
     * версию, прежний освобождается.
     */
    addonBackgroundUrl(meta) {
        const src = String(meta?.backgroundDataUrl || '');
        const m = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(src);
        if (!m) return '';
        const cache = this._addonBgUrls || (this._addonBgUrls = new Map());
        const key = `${meta.id}:${meta.sha256 || src.length}`;
        const hit = cache.get(meta.id);
        if (hit && hit.key === key) return hit.url;
        try {
            const bin = atob(m[2]);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            const url = URL.createObjectURL(new Blob([bytes], { type: m[1] }));
            if (hit) URL.revokeObjectURL(hit.url);
            cache.set(meta.id, { key, url });
            return url;
        } catch (e) {
            return '';
        }
    }

    /** Главная хаба: по плашке на каждый установленный аддон — только быстрый запуск. */
    renderHubQuick() {
        const box = document.getElementById('hubQuick');
        if (!box) return;
        const items = this.addonsAvailable() && !this._addonsError ? (this._addonsList || []) : [];
        box.hidden = !items.length;
        if (!items.length) {
            if (box.childElementCount) box.innerHTML = '';
            return;
        }
        const chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" focusable="false"><path d="M9 5l7 7-7 7"/></svg>';
        this.setHTMLIfChanged(box, items.map((meta) => {
            const m = meta.manifest;
            const running = this.addonInstances().has(meta.id);
            const launching = !!this._addonLaunching?.has(meta.id);
            return `
            <button class="hub-action hub-action--addon${meta.backgroundDataUrl ? ' has-bg' : ''}" type="button" data-addon-open="${this.esc(meta.id)}"${launching ? ' disabled aria-busy="true"' : ''}>
                ${this.addonIconHtml(meta)}
                <span class="hub-action-text">
                    <strong>${this.esc(m.name)}${running ? ' <span class="hub-addon-flag is-running">Работает</span>' : ''}</strong>
                    <span>${this.esc(m.description || 'Мини-приложение')}</span>
                </span>
                <span class="hub-action-go" aria-hidden="true">${chevron}</span>
            </button>`;
        }).join(''));
        for (const btn of box.querySelectorAll('[data-addon-open]')) {
            const meta = items.find(item => item.id === btn.getAttribute('data-addon-open'));
            const url = meta ? this.addonBackgroundUrl(meta) : '';
            if (url) btn.style.setProperty('--addon-bg', `url("${url}")`);
            else btn.style.removeProperty('--addon-bg');
        }
    }

    renderHubAddons() {
        this.renderHubQuick();
        this.renderHubStore?.();
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
            const launching = !!this._addonLaunching?.has(meta.id);
            const fresh = this._addonJustInstalled === meta.id;
            return `<article class="hub-addon-item${running ? ' is-running' : ''}${fresh ? ' is-new' : ''}" data-addon-id="${this.esc(meta.id)}">
                ${this.addonIconHtml(meta)}
                <div class="hub-addon-main">
                    <div class="hub-component-top">
                        <strong>${this.esc(m.name)}</strong>
                        <span class="hub-component-version">${this.esc(m.version)}</span>
                        ${fresh ? '<span class="hub-addon-flag is-new">Новый</span>' : ''}
                        ${elevated ? '<span class="hub-addon-flag is-elevated">Повышенные права</span>' : ''}
                        ${meta.signature?.state === 'official' ? '<span class="hub-addon-flag is-official">Официальный</span>' : meta.signature?.state === 'self' ? `<span class="hub-addon-flag is-self" title="Самоподпись: автор @${this.esc(meta.signature.owner || '')}">Автор @${this.esc(meta.signature.owner || '')}</span>` : ''}
                        ${running ? (instance.recorder ? '<span class="hub-addon-flag is-recording">Идёт запись</span>' : '<span class="hub-addon-flag is-running">Работает</span>') : ''}
                    </div>
                    <p>${this.esc(m.description || 'Без описания')}</p>
                </div>
                <div class="hub-addon-actions">
                    <button class="auth-btn primary" type="button" data-addon-action="open"${launching ? ' disabled aria-busy="true"' : ''}>${launching ? 'Запуск…' : running ? 'Развернуть' : 'Открыть'}</button>
                    ${running ? '<button class="btn-flat" type="button" data-addon-action="stop">Остановить</button>' : ''}
                    <button class="hub-addon-more" type="button" data-addon-action="details" title="Об аддоне" aria-label="Об аддоне «${this.esc(m.name)}»">
                        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="4.5" cy="10" r="1.6"/><circle cx="10" cy="10" r="1.6"/><circle cx="15.5" cy="10" r="1.6"/></svg>
                    </button>
                </div>
            </article>`;
        }).join('');
        const fresh = list.querySelector('.hub-addon-item.is-new');
        if (fresh && this._addonScrollToNew) {
            this._addonScrollToNew = false;
            try { fresh.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch (e) { /* без прокрутки */ }
        }
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
            info = await this.addonInspect(new Uint8Array(await file.arrayBuffer()));
        } catch (error) {
            this.setAddonsStatus(`Файл не подошёл: ${error?.message || error}`, 'error');
            return;
        }
        const m = info.manifest;
        const existing = (this._addonsList || []).find(item => item.id === m.id) || null;
        const unsupported = m.permissions.filter(p => !this.addonPermissionSupported(p, m));
        // Кто на самом деле владелец этого id — по реестру сервера. Нет сети — это
        // тоже сведение: диалог скажет, что автора проверить не удалось.
        const signed = info.signature.state === 'self' || info.signature.state === 'official';
        const registry = this.S.session?.token ? await this.addonRegistryLookup(m.id, { force: true }) : null;
        // id закреплён за автором: чужой файл с таким id не ставится. Исключения —
        // файл с подписью самого владельца и сборка самого владельца без подписи
        // (его собственная отладочная версия до подписания).
        if (registry?.registered && registry.owner !== this.myName()) {
            const byOwner = signed && info.signature.owner === registry.owner && info.signature.kind === registry.kind;
            if (!byOwner) {
                const text = `id «${m.id}» закреплён за @${registry.owner}, а этот файл не подписан им. Выберите другой id в manifest.json — или попросите владельца подписать файл.`;
                this.setAddonsStatus(text, 'error');
                await this.confirmAction({
                    title: 'Этот id занят',
                    message: text,
                    confirmLabel: 'Понятно',
                    cancelLabel: 'Закрыть',
                    danger: false,
                });
                return;
            }
        }
        const confirmed = await this.showAddonInstallDialog(info, existing, unsupported, registry);
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
                backgroundDataUrl: await this.addonBackgroundDataUrl(info),
                // Для списка и сведений: сам файл при запуске проверяется заново.
                signature: {
                    state: info.signature.state,
                    kind: info.signature.kind || '',
                    owner: info.signature.owner || '',
                    fingerprint: info.signature.fingerprint || '',
                },
                installedAt: existing?.installedAt || now,
                updatedAt: now,
            };
            await this.addonStorePut(meta, info.bytes);
            this.addonReportEvent?.(m.id, existing ? 'update' : 'install', m.version, info.signature.state);
            if (info.signature.state === 'official') void this.addonRegisterOfficial?.(m.id);
            this._addonJustInstalled = existing ? null : m.id;
            this._addonScrollToNew = !existing;
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

    addonFilesWord(n) {
        const last = n % 10;
        const tens = n % 100;
        if (tens >= 11 && tens <= 14) return 'файлов';
        if (last === 1) return 'файл';
        return last >= 2 && last <= 4 ? 'файла' : 'файлов';
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

    /** Короткая плашка «кем подписан» для диалогов и списка. */
    addonSignatureHtml(signature, registry = null, { signing = false } = {}) {
        const s = signature || { state: 'none' };
        const owner = s.owner ? `@${this.esc(s.owner)}` : '';
        const row = (tone, title, text) => `<div class="addon-sign is-${this.esc(tone)}" role="note">
            <strong>${this.esc(title)}</strong>${text ? `<span>${text}</span>` : ''}</div>`;
        if (s.state === 'official') {
            return row('official', 'Официальный аддон ZaliMessenger', `Подписан сертификатом разработчиков. Автор ${owner}.`);
        }
        if (s.state === 'self') {
            let note = 'Приложение за него не ручается: с ZaliCoin он работает с предупреждением.';
            if (registry && registry.registered && (registry.owner !== s.owner || registry.kind !== 'self')) {
                note = `<b>В реестре сервера автор другой — @${this.esc(registry.owner)}. Не доверяйте этому файлу.</b>`;
            } else if (registry && !registry.registered) {
                note = 'Автора нет в реестре этого сервера — переводы недоступны.';
            }
            return row('self', `Самоподпись · автор ${owner}`, note);
        }
        if (s.state === 'unverified') {
            return row('warn', 'Подпись не проверена', `${this.esc(s.reason || 'Нет ключа проверки')}. Аддон не сможет принимать ZaliCoin.`);
        }
        if (s.state === 'invalid') {
            return row('bad', 'Подпись недействительна', `${this.esc(s.reason || 'Файл повреждён')}. Не ставьте файл, если не знаете, откуда он.`);
        }
        return row('none', 'Без подписи', signing
            ? 'После подписи аддон закрепится за вашим аккаунтом и сможет принимать ZaliCoin и пользоваться облаком.'
            : 'Не может принимать ZaliCoin и пользоваться облаком ZaliMessenger.');
    }

    showAddonInstallDialog(info, existing, unsupported, registry = null) {
        const F = window.ZaliAddonFormat;
        const m = info.manifest;
        const oldPermissions = new Set(existing?.manifest?.permissions || []);
        const newSet = existing ? new Set(m.permissions.filter(p => !oldPermissions.has(p))) : null;
        const sub = [
            existing ? `Обновление ${existing.manifest.version} → ${m.version}` : `Версия ${m.version}`,
            m.author,
            this.addonSizeLabel(info.size),
        ].filter(Boolean).join(' · ');
        // Облако и ZaliCoin открыты только подписанным аддонам: не мешаем
        // поставить, но говорим заранее, что именно не заработает.
        const signedState = info.signature?.state;
        const cloudNeedsSignature = m.permissions.includes('cloud') && signedState !== 'self' && signedState !== 'official';
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
            ${cloudNeedsSignature ? '<p class="addon-dialog-error" role="alert">Аддон просит облако ZaliMessenger, но не подписан: облако ему откроется только после подписи автора.</p>' : ''}
            ${this.addonSignatureHtml(info.signature, registry)}
            <p class="addon-dialog-fp">Отпечаток SHA-256: <code>${this.esc(this.addonFingerprintLabel(info.sha256))}</code></p>
            <div class="coin-transfer-actions">
                <button class="btn-flat" type="button" data-dialog-action="cancel">Отмена</button>
                <button class="auth-btn primary" type="button" data-dialog-action="ok"${unsupported.length ? ' disabled' : ''}>${existing ? 'Обновить' : 'Установить'}</button>
            </div>`;
        return this.openAddonDialog(html).then(action => action === 'ok');
    }

    /** Сколько места занимают данные аддона (настройки и кеш) на этом устройстве; null — не удалось узнать. */
    async addonDataUsage(id) {
        try {
            const entries = await this.addonDataList(id, '');
            return { files: entries.length, bytes: entries.reduce((sum, e) => sum + Number(e.size || 0), 0), entries };
        } catch (error) {
            return null;
        }
    }

    async showAddonDetailsDialog(meta) {
        const m = meta.manifest;
        const usage = await this.addonDataUsage(meta.id);
        // Облако ZaliMessenger (разрешение `cloud`): сколько аддон хранит на сервере.
        let cloud = null;
        let audit = null;
        if (m.permissions.includes('cloud') && this.S.session?.token) {
            try {
                const base = `/api/addons/${encodeURIComponent(meta.id)}/cloud`;
                const res = await this.apiFetch(base, { interactive: false });
                if (res.ok) {
                    cloud = await res.json();
                    const log = await this.apiFetch(`${base}/audit`, { interactive: false });
                    if (log.ok) audit = await log.json();
                }
            } catch (error) { /* нет связи — строка просто не показывается */ }
        }
        const cloudLine = cloud
            ? `Облако ZaliMessenger: занято ${this.addonSizeLabel(Number(cloud.bytes) || 0)} из ${this.addonSizeLabel(Number(cloud.quota) || 0)} у всех пользователей аддона; ваши данные — ${this.addonSizeLabel(Number(cloud.mine) || 0)}`
            : '';
        // Журнал чтения: автор не может собирать данные незаметно.
        const reads = Number(audit?.reads) || 0;
        const listings = Number(audit?.listings) || 0;
        const auditLine = audit && (reads || listings)
            ? `Автор аддона читал ваши данные: ${reads} раз(а), просматривал список данных: ${listings} раз(а)${audit.lastAt ? `; последний раз ${new Date(Number(audit.lastAt) * 1000).toLocaleString('ru-RU')}` : ''}`
            : (audit ? 'Автор аддона ваши данные пока не читал' : '');
        const dataLine = usage
            ? (usage.files ? `Данные аддона: ${this.addonSizeLabel(usage.bytes)} (${usage.files} ${this.addonFilesWord(usage.files)})` : 'Данных аддон пока не сохранил')
            : '';
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
            ${meta.signature ? this.addonSignatureHtml(meta.signature, null) : ''}
            <p class="addon-dialog-fp">Отпечаток SHA-256: <code>${this.esc(this.addonFingerprintLabel(meta.sha256))}</code>${installed ? `<br>Установлен: ${this.esc(installed)}` : ''}${dataLine ? `<br>${this.esc(dataLine)}` : ''}${cloudLine ? `<br>${this.esc(cloudLine)}` : ''}${auditLine ? `<br>${this.esc(auditLine)}` : ''}</p>
            <div class="coin-transfer-actions addon-dialog-actions">
                <span class="addon-dialog-danger-group">
                    <button class="btn-flat addon-dialog-danger" type="button" data-dialog-action="remove">Удалить аддон</button>
                    ${usage?.files ? '<button class="btn-flat" type="button" data-dialog-action="clear">Очистить данные</button>' : ''}
                    ${cloud?.keys ? '<button class="btn-flat" type="button" data-dialog-action="clear-cloud">Удалить мои данные из облака</button>' : ''}
                </span>
                <button class="auth-btn primary" type="button" data-dialog-action="cancel">Закрыть</button>
            </div>`;
        const action = await this.openAddonDialog(html);
        if (action === 'clear-cloud') {
            const sure = await this.confirmAction({
                title: `Удалить ваши данные «${m.name}» из облака?`,
                message: 'Всё, что аддон сохранил о вас на серверах ZaliMessenger, будет стёрто — на всех устройствах и у автора аддона. Данные других пользователей и общая область не затрагиваются. Сам аддон останется установленным.',
                confirmLabel: 'Удалить мои данные',
            });
            if (!sure) return;
            try {
                const res = await this.apiFetch(`/api/addons/${encodeURIComponent(meta.id)}/cloud`, { method: 'DELETE', interactive: true });
                if (!res.ok) throw new Error(`сервер ответил ${res.status}`);
                this.setAddonsStatus(`Ваши данные «${m.name}» удалены из облака.`, 'success');
            } catch (error) {
                this.setAddonsStatus(`Не удалось удалить данные «${m.name}» из облака: ${error?.message || error}`, 'error');
            }
            return;
        }
        if (action === 'clear') {
            const sure = await this.confirmAction({
                title: `Очистить данные «${m.name}»?`,
                message: 'Настройки и кеш аддона будут стёрты с этого устройства. Сам аддон останется установленным.',
                confirmLabel: 'Очистить',
            });
            if (!sure) return;
            try {
                // Запущенный аддон держит настройки в памяти и записал бы их обратно.
                const wasRunning = this.addonInstances().has(meta.id);
                if (wasRunning) this.stopAddon(meta.id);
                for (const entry of usage.entries) await this.addonDataDelete(meta.id, entry.path);
                this.setAddonsStatus(`Данные «${m.name}» очищены${wasRunning ? '; аддон остановлен — откройте его заново' : ''}.`, 'success');
            } catch (error) {
                this.setAddonsStatus(`Не удалось очистить данные «${m.name}»: ${error?.message || error}`, 'error');
            }
            return;
        }
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
            this.addonReportEvent?.(meta.id, 'remove', m.version, meta.signature?.state);
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
        // Пока аддон развёрнут, его сцена лежит поверх .main (z-index 650): окно,
        // которое аддон сам вызвал (перевод ZaliCoin), должно быть над ней,
        // иначе человек не увидит, что ему предлагают подтвердить.
        const stage = document.getElementById('addonStage');
        const overStage = !!(stage && !stage.hidden && stage.parentElement);
        const host = overStage ? stage.parentElement : (document.querySelector('.main') || document.body);
        if (this._addonDialogDismiss) this._addonDialogDismiss('cancel');
        return new Promise((resolve) => {
            const previousFocus = document.activeElement;
            const overlay = document.createElement('div');
            overlay.className = `coin-transfer-modal addon-dialog${overStage ? ' is-over-stage' : ''}`;
            overlay.innerHTML = `<div class="coin-transfer-box addon-dialog-box" role="dialog" aria-modal="true" aria-labelledby="addonDialogTitle">${innerHtml}</div>`;
            const buttons = () => Array.from(overlay.querySelectorAll('button:not([disabled]), input:not([disabled])'));
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
