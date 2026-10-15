// --- ZaliInterface: упаковщик аддонов в хабе (ZIP с исходниками → .zali). ---
// Часть класса ZaliInterface (см. web/src/interface.js). Вкладка «Упаковщик»
// (#hubPack): автор выбирает ZIP, приложение читает его (modules/zip_reader.js),
// отсеивает служебные файлы, проверяет пути и манифест теми же правилами, что при
// установке (modules/addon_format.js), и собирает файл `.zali`. Дальше — поставить в
// хаб, сохранить или отправить на подпись. Формат — docs/ADDONS.md; то же из
// командной строки делает scripts/addon_pack.py.
ZaliMixin(ZaliInterface, class {

    addonPackState() {
        if (!this._addonPack) {
            this._addonPack = { busy: false, error: '', result: null };
        }
        return this._addonPack;
    }

    bindAddonPackEvents() {
        const pane = document.getElementById('hubPack');
        if (!pane) return;
        pane.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-pack-action]');
            if (!btn || btn.disabled) return;
            const action = btn.getAttribute('data-pack-action');
            if (action === 'pick') document.getElementById('addonPackFileInput')?.click();
            else if (action === 'install') void this.installPackedAddon();
            else if (action === 'download') this.downloadPackedAddon();
            else if (action === 'sign') void this.signPackedAddon();
            else if (action === 'reset') this.resetAddonPack();
        });
        // Поле выбора файла создаётся при каждой перерисовке вкладки — слушатель на панели.
        pane.addEventListener('change', (e) => {
            const input = e.target;
            if (!input || input.id !== 'addonPackFileInput') return;
            const file = input.files && input.files[0];
            input.value = '';
            if (file) void this.packAddonFromZip(file);
        });
        let depth = 0;
        const dropZone = (e) => e.target.closest?.('.addon-sign-drop');
        pane.addEventListener('dragenter', (e) => {
            const zone = dropZone(e);
            if (!zone || !e.dataTransfer?.types?.includes('Files')) return;
            e.preventDefault();
            depth += 1;
            zone.classList.add('is-dropping');
        });
        pane.addEventListener('dragover', (e) => {
            if (dropZone(e)) e.preventDefault();
        });
        pane.addEventListener('dragleave', (e) => {
            const zone = dropZone(e);
            if (!zone) return;
            depth = Math.max(0, depth - 1);
            if (!depth) zone.classList.remove('is-dropping');
        });
        pane.addEventListener('drop', (e) => {
            const zone = dropZone(e);
            if (!zone) return;
            e.preventDefault();
            depth = 0;
            zone.classList.remove('is-dropping');
            const files = Array.from(e.dataTransfer?.files || []);
            const file = files.find(f => /\.zip$/i.test(f.name)) || files[0];
            if (file) void this.packAddonFromZip(file);
        });
    }

    resetAddonPack() {
        this._addonPack = { busy: false, error: '', result: null };
        this.renderHubPack();
    }

    /**
     * Служебные записи, которые не должны попасть в аддон: скрытые файлы и
     * папки (.git, .DS_Store), __MACOSX, Thumbs.db — то же, что пропускает
     * scripts/addon_pack.py.
     */
    isAddonPackJunk(path) {
        const segments = String(path || '').split('/');
        return segments.some(seg => seg === '__MACOSX' || seg === 'Thumbs.db' || seg.startsWith('.'));
    }

    async packAddonFromZip(file) {
        const st = this.addonPackState();
        if (st.busy) return;
        const F = window.ZaliAddonFormat;
        const Z = window.ZaliZip;
        st.error = '';
        st.result = null;
        if (!F || !Z) {
            st.error = 'Упаковщик недоступен в этой сборке.';
            this.renderHubPack();
            return;
        }
        if (Number(file?.size || 0) > Z.LIMITS.totalBytes) {
            st.error = 'Архив больше 64 МБ — аддон не может быть таким большим.';
            this.renderHubPack();
            return;
        }
        st.busy = true;
        this.renderHubPack();
        try {
            const raw = await Z.read(new Uint8Array(await file.arrayBuffer()));
            let skipped = 0;
            let kept = [];
            for (const entry of raw) {
                if (this.isAddonPackJunk(entry.name)) skipped += 1;
                else kept.push(entry);
            }

            // Архив папки целиком: всё лежит внутри одной корневой папки.
            let root = '';
            if (!kept.some(e => e.name === F.MANIFEST_PATH)) {
                const nested = kept.filter(e => /^[^/]+\/manifest\.json$/.test(e.name));
                if (nested.length === 1) {
                    root = nested[0].name.slice(0, nested[0].name.indexOf('/') + 1);
                    const inside = kept.filter(e => e.name.startsWith(root));
                    skipped += kept.length - inside.length;
                    kept = inside.map(e => ({ name: e.name.slice(root.length), data: e.data }));
                } else if (nested.length > 1) {
                    throw new Error('В архиве несколько manifest.json — оставьте один аддон на архив.');
                } else {
                    throw new Error('В архиве нет manifest.json. Он должен лежать в корне (или внутри единственной папки).');
                }
            }

            const seen = new Map();
            const problems = [];
            for (const entry of kept) {
                const problem = F.pathError(entry.name);
                if (problem) problems.push(`«${entry.name.slice(0, 60)}»: ${problem}`);
                const lower = entry.name.toLowerCase();
                if (seen.has(lower)) problems.push(`«${entry.name.slice(0, 60)}» дублирует «${seen.get(lower).slice(0, 60)}» с точностью до регистра`);
                else seen.set(lower, entry.name);
            }
            if (problems.length) {
                const more = problems.length > 3 ? ` (и ещё ${problems.length - 3})` : '';
                throw new Error(`Не подходят имена файлов: ${problems.slice(0, 3).join('; ')}${more}. Допустимы латиница, цифры, «.», «_» и «-».`);
            }

            const manifestEntry = kept.find(e => e.name === F.MANIFEST_PATH);
            let headerId = '';
            try {
                headerId = String(JSON.parse(new TextDecoder('utf-8').decode(manifestEntry.data))?.id || '');
            } catch (e) { /* манифест разберёт проверка ниже — с понятным сообщением */ }
            const ordered = [
                [F.MANIFEST_PATH, manifestEntry.data],
                ...kept.filter(e => e !== manifestEntry).map(e => [e.name, e.data]),
            ];
            const bytes = F.build(ordered, { id: headerId });
            // Файл, который мы отдаём, обязан пройти ту же проверку, что у того,
            // кто его поставит: размеры, число записей, разрешения, backend.
            const info = await this.addonInspect(bytes);
            const m = info.manifest;
            st.result = {
                bytes: info.bytes,
                fileName: `${m.id}-${m.version}.zali`,
                manifest: m,
                size: info.size,
                fileCount: ordered.length,
                skipped,
                root: root.replace(/\/$/, ''),
                sourceName: String(file.name || ''),
                iconDataUrl: this.addonIconDataUrl(info),
            };
        } catch (error) {
            st.error = `Не удалось собрать: ${error?.message || error}`;
        } finally {
            st.busy = false;
            this.renderHubPack();
        }
    }

    packedAddonFile() {
        const result = this.addonPackState().result;
        if (!result) return null;
        return new File([result.bytes], result.fileName, { type: 'application/octet-stream' });
    }

    downloadPackedAddon() {
        const result = this.addonPackState().result;
        if (!result) return;
        const dataUrl = `data:application/octet-stream;base64,${this.addonBytesToBase64(result.bytes)}`;
        void this.downloadAttachmentFromHref?.(dataUrl, result.fileName);
    }

    async installPackedAddon() {
        const file = this.packedAddonFile();
        if (!file) return;
        this.setHubTab('addons');
        await this.installAddonFromFile(file);
    }

    async signPackedAddon() {
        const file = this.packedAddonFile();
        if (!file) return;
        this.setHubTab('signing');
        await this.pickAddonToSign(file);
    }

    renderHubPack() {
        const box = document.getElementById('hubPackBody');
        if (!box) return;
        const st = this.addonPackState();
        const r = st.result;
        let body;
        if (st.busy) {
            body = `<div class="addon-sign-drop" aria-busy="true">
                <span><span class="addon-frame-spinner" aria-hidden="true"></span> Собираем .zali…</span>
            </div>`;
        } else if (r) {
            const m = r.manifest;
            const notes = [];
            if (r.root) notes.push(`корневая папка «${this.esc(r.root)}» убрана`);
            if (r.skipped) notes.push(`пропущено служебных файлов: ${r.skipped}`);
            body = `<div class="addon-sign-card is-done" role="status">
                <div class="addon-sign-card-head">
                    ${this.addonIconHtml({ manifest: m, iconDataUrl: r.iconDataUrl })}
                    <div class="addon-sign-card-text">
                        <strong>${this.esc(m.name)}</strong>
                        <span>${this.esc(m.id)} · ${this.esc(m.version)} · ${this.esc(this.addonSizeLabel(r.size))} · файлов ${r.fileCount}</span>
                    </div>
                </div>
                <p class="addon-sign-hint">Собран <code>${this.esc(r.fileName)}</code> из «${this.esc(r.sourceName)}»${notes.length ? ` — ${notes.join(', ')}` : ''}.</p>
                <div class="addon-sign-actions">
                    <button class="auth-btn primary" type="button" data-pack-action="install">Установить в хаб</button>
                    <button class="btn-flat" type="button" data-pack-action="download">Сохранить .zali</button>
                    <button class="btn-flat" type="button" data-pack-action="sign">Подписать</button>
                    <button class="btn-flat" type="button" data-pack-action="reset">Другой архив</button>
                </div>
            </div>`;
        } else {
            body = `<div class="addon-sign-drop">
                <span>Перетащите <b>ZIP</b> с исходниками сюда или выберите его</span>
                <button class="auth-btn primary" type="button" data-pack-action="pick">Выбрать ZIP</button>
            </div>`;
        }
        box.innerHTML = `
            <section class="hub-components addon-sign-section" aria-labelledby="hubPackTitle">
                <div class="hub-components-head">
                    <div>
                        <span class="settings-kicker">Разработчикам</span>
                        <h3 id="hubPackTitle">Упаковщик .zali</h3>
                    </div>
                </div>
                <p class="addon-sign-intro">Соберите аддон из архива с исходным кодом. В корне архива (или внутри
                    единственной папки) должен лежать <code>manifest.json</code>; скрытые и служебные файлы
                    пропускаются. Манифест и файлы проверяются теми же правилами, что при установке.</p>
                ${st.error ? `<p class="hub-addons-status is-error" role="alert">${this.esc(st.error)}</p>` : ''}
                ${body}
                <input type="file" id="addonPackFileInput" accept=".zip,application/zip,application/x-zip-compressed" hidden>
            </section>`;
    }
});
