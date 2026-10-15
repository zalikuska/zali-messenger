// --- ZaliInterface: магазин аддонов во вкладке «Аддоны» хаба. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Витрина — GET
// /api/addons/store; покупка — POST …/buy (деньги сразу автору), файл — GET
// …/download (JSON с base64) и дальше обычная установка installAddonFromFile со
// всеми проверками и диалогом разрешений. Публикация — в окне подписи
// (addons_signing.js), сервер — server/src/addon_store.rs.
ZaliMixin(ZaliInterface, class {

    addonStoreState() {
        if (!this._addonStore) {
            this._addonStore = {
                items: [], loaded: false, loading: false, error: '', filter: 'all', query: '', seq: 0,
                balance: null, busyId: '', assets: new Map(), assetUrls: new Map(), searchTimer: 0,
            };
        }
        return this._addonStore;
    }

    bindAddonStoreEvents() {
        const root = document.getElementById('hubStore');
        if (!root) return;
        root.addEventListener('click', (e) => {
            const filter = e.target.closest('[data-store-filter]');
            if (filter) {
                this.setStoreFilter(filter.getAttribute('data-store-filter'));
                return;
            }
            const btn = e.target.closest('[data-store-action]');
            if (!btn || btn.disabled) return;
            const id = btn.closest('[data-store-id]')?.getAttribute('data-store-id') || '';
            const action = btn.getAttribute('data-store-action');
            if (action === 'get') void this.storeAcquire(id);
            else if (action === 'retry') void this.loadStore({ force: true });
        });
        const search = document.getElementById('hubStoreSearch');
        search?.addEventListener('input', () => {
            const st = this.addonStoreState();
            clearTimeout(st.searchTimer);
            st.searchTimer = setTimeout(() => {
                st.query = String(search.value || '').trim();
                void this.loadStore({ force: true });
            }, 250);
        });
    }

    setStoreFilter(filter) {
        const st = this.addonStoreState();
        const next = ['all', 'free', 'paid', 'owned'].includes(filter) ? filter : 'all';
        if (st.filter === next) return;
        st.filter = next;
        void this.loadStore({ force: true });
    }

    async loadStore({ force = false } = {}) {
        const st = this.addonStoreState();
        if (!document.getElementById('hubStore')) return;
        if (!this.S.session?.token) {
            st.items = [];
            st.loaded = true;
            this.renderHubStore();
            return;
        }
        if (st.loading && !force) return;
        if (st.loaded && !force && Date.now() - (st.loadedAt || 0) < 15000) {
            this.renderHubStore();
            return;
        }
        // Ответы приходят не по порядку (фильтр щёлкнули дважды подряд): берём только последний запрос.
        const seq = st.seq = (st.seq || 0) + 1;
        st.loading = true;
        st.error = '';
        this.renderHubStore();
        try {
            const params = new URLSearchParams();
            if (st.query) params.set('q', st.query);
            if (st.filter !== 'all') params.set('filter', st.filter);
            const res = await this.apiFetch(`/api/addons/store${params.toString() ? `?${params}` : ''}`, { interactive: true });
            if (!res.ok) throw new Error(`Ошибка ${res.status}`);
            const data = await res.json();
            if (seq !== st.seq) return;
            st.items = Array.isArray(data?.items) ? data.items : [];
            if (Number.isFinite(Number(data?.balance))) {
                st.balance = Number(data.balance);
                this.S.zaliCoinBalance = st.balance;
            }
            st.loaded = true;
            st.loadedAt = Date.now();
        } catch (error) {
            if (seq === st.seq) st.error = error?.message || String(error);
        } finally {
            if (seq === st.seq) {
                st.loading = false;
                this.renderHubStore();
            }
        }
    }

    /** Иконка и фон карточки: отдельный запрос на аддон, результат — blob:-адреса. */
    async ensureStoreAssets(item) {
        const st = this.addonStoreState();
        const key = `${item.id}:${item.digest}`;
        if (st.assets.has(key) || (!item.hasIcon && !item.hasBackground)) return;
        st.assets.set(key, null);
        try {
            const res = await this.apiFetch(`/api/addons/store/${encodeURIComponent(item.id)}/assets`, { interactive: true });
            if (!res.ok) return;
            const data = await res.json();
            const toUrl = (dataUrl) => {
                const m = /^data:(image\/(?:png|jpeg|webp|svg\+xml));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''));
                if (!m) return '';
                const bin = atob(m[2]);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
                return URL.createObjectURL(new Blob([bytes], { type: m[1] }));
            };
            st.assets.set(key, { icon: toUrl(data.icon), background: toUrl(data.background) });
            this.applyStoreAssets();
        } catch (e) {
            st.assets.delete(key);
        }
    }

    applyStoreAssets() {
        const st = this.addonStoreState();
        for (const card of document.querySelectorAll('#hubStoreGrid [data-store-id]')) {
            const item = st.items.find(i => i.id === card.getAttribute('data-store-id'));
            const assets = item ? st.assets.get(`${item.id}:${item.digest}`) : null;
            if (!assets) continue;
            const img = card.querySelector('[data-store-icon]');
            if (img && assets.icon && img.getAttribute('src') !== assets.icon) {
                img.src = assets.icon;
                img.hidden = false;
                card.querySelector('[data-store-letter]')?.setAttribute('hidden', '');
            }
            if (assets.background) {
                card.classList.add('has-bg');
                card.style.setProperty('--store-bg', `url("${assets.background}")`);
            }
        }
    }

    /** Установлен ли аддон и какой версии: из списка хаба (`_addonsList`). */
    storeInstallState(item) {
        const installed = (this._addonsList || []).find(a => a.id === item.id);
        if (!installed) return { installed: false, outdated: false, version: '' };
        const version = String(installed.manifest?.version || '');
        return { installed: true, outdated: version !== item.version, version };
    }

    storeActionFor(item) {
        const state = this.storeInstallState(item);
        const canInstall = this.addonsAvailable();
        if (state.installed && !state.outdated) return { label: 'Установлено', disabled: true, kind: 'ghost' };
        if (!canInstall) return { label: 'Недоступно здесь', disabled: true, kind: 'ghost' };
        if (state.outdated) return { label: `Обновить до ${item.version}`, disabled: false, kind: 'primary' };
        if (!item.owned && item.price > 0) return { label: `Купить · ${this.formatCoinAmount(item.price)} ZC`, disabled: false, kind: 'primary' };
        return { label: 'Установить', disabled: false, kind: 'primary' };
    }

    storeFilterLabel(filter) {
        return { all: 'Все', free: 'Бесплатные', paid: 'Платные', owned: 'Мои' }[filter] || filter;
    }

    renderHubStore() {
        const grid = document.getElementById('hubStoreGrid');
        const filters = document.getElementById('hubStoreFilters');
        if (!grid) return;
        const st = this.addonStoreState();
        if (filters) {
            this.setHTMLIfChanged(filters, ['all', 'free', 'paid', 'owned'].map(f =>
                `<button type="button" role="tab" class="store-chip${st.filter === f ? ' is-selected' : ''}" aria-selected="${st.filter === f ? 'true' : 'false'}" data-store-filter="${this.esc(f)}">${this.esc(this.storeFilterLabel(f))}</button>`
            ).join(''));
        }
        const balanceEl = document.getElementById('hubStoreBalance');
        if (balanceEl) {
            const show = this.S.session?.token && st.balance !== null;
            balanceEl.hidden = !show;
            if (show) balanceEl.textContent = `${this.formatCoinAmount(st.balance)} ZC`;
        }
        if (!this.S.session?.token) {
            this.setHTMLIfChanged(grid, '<div class="store-empty"><strong>Войдите в аккаунт</strong><span>Магазин аддонов доступен после входа.</span></div>');
            return;
        }
        if (st.error) {
            this.setHTMLIfChanged(grid, `<div class="store-empty is-error" role="alert"><strong>Не удалось открыть магазин</strong><span>${this.esc(st.error)}</span>
                <button class="btn-flat" type="button" data-store-action="retry">Повторить</button></div>`);
            return;
        }
        if (!st.loaded || (st.loading && !st.items.length)) {
            this.setHTMLIfChanged(grid, Array.from({ length: 6 }, () => `<article class="store-card is-skeleton" aria-hidden="true">
                <div class="store-card-cover"></div>
                <div class="store-card-body"><span class="store-skel w60"></span><span class="store-skel w40"></span><span class="store-skel w90"></span></div>
            </article>`).join(''));
            return;
        }
        if (!st.items.length) {
            const searching = !!st.query || st.filter !== 'all';
            this.setHTMLIfChanged(grid, searching
                ? '<div class="store-empty"><strong>Ничего не нашлось</strong><span>Измените запрос или фильтр.</span></div>'
                : `<div class="store-empty"><strong>В магазине пока пусто</strong>
                    <span>Разработчикам: выложить аддон можно в разделе «Подпись аддонов» — нужна официальная подпись.</span>
                    <button class="btn-flat" type="button" data-hub-tab="signing">Подпись аддонов</button></div>`);
            return;
        }
        const F = window.ZaliAddonFormat;
        const html = st.items.map((item) => {
            const action = this.storeActionFor(item);
            const busy = st.busyId === item.id;
            const perms = (Array.isArray(item.permissions) ? item.permissions : []).slice(0, 3);
            const extra = Math.max(0, (item.permissions || []).length - perms.length);
            const letter = String(item.name || '?').trim().charAt(0).toUpperCase() || '?';
            const permChips = perms.map(p => {
                const info = F?.permissionInfo?.(p);
                const elevated = !!F?.isElevated?.(p);
                return `<li class="store-perm${elevated ? ' is-elevated' : ''}">${this.esc(info?.title || p)}</li>`;
            }).join('') + (extra ? `<li class="store-perm">+${extra}</li>` : '');
            const price = item.price > 0
                ? `<span class="store-price is-paid">${this.esc(this.formatCoinAmount(item.price))} <small>ZC</small></span>`
                : '<span class="store-price">Бесплатно</span>';
            return `<article class="store-card" data-store-id="${this.esc(item.id)}">
                <div class="store-card-cover"></div>
                <div class="store-card-icon" aria-hidden="true">
                    <span data-store-letter>${this.esc(letter)}</span>
                    <img data-store-icon alt="" hidden>
                </div>
                <div class="store-card-body">
                    <h4 class="store-card-name">${this.esc(item.name)}</h4>
                    <p class="store-card-meta"><span class="store-official" title="Официальная подпись ZaliMessenger">Официальный</span> @${this.esc(item.owner)} · ${this.esc(item.version)} · ${this.esc(this.addonSizeLabel(item.size))}</p>
                    <p class="store-card-desc">${this.esc(item.summary || 'Без описания')}</p>
                    ${permChips ? `<ul class="store-perms" aria-label="Разрешения">${permChips}</ul>` : '<p class="store-perms-none">Без доступа к файлам и сети</p>'}
                </div>
                <div class="store-card-foot">
                    ${price}
                    <button class="${this.esc(action.kind === 'primary' ? 'auth-btn primary' : 'btn-flat')} store-get" type="button" data-store-action="get"${action.disabled || busy ? ' disabled' : ''}${busy ? ' aria-busy="true"' : ''}>${busy ? 'Загрузка…' : this.esc(action.label)}</button>
                </div>
            </article>`;
        }).join('');
        this.setHTMLIfChanged(grid, html);
        this.applyStoreAssets();
        for (const item of st.items) void this.ensureStoreAssets(item);
    }

    setStoreStatus(text, tone = '') {
        const el = document.getElementById('hubStoreStatus');
        if (!el) return;
        el.textContent = text || '';
        el.hidden = !text;
        el.classList.toggle('is-error', tone === 'error');
        el.classList.toggle('is-success', tone === 'success');
    }

    /** Купить (если платный и не куплен) → скачать → обычная установка. */
    async storeAcquire(id) {
        const st = this.addonStoreState();
        const item = st.items.find(i => i.id === id);
        if (!item || st.busyId) return;
        this.setStoreStatus('');
        if (!item.owned && item.price > 0) {
            const balance = Number.isFinite(Number(st.balance)) ? Number(st.balance) : Number(this.S.zaliCoinBalance) || 0;
            if (balance < item.price) {
                this.setStoreStatus(`Не хватает ZaliCoin: нужно ${this.formatCoinAmount(item.price)} ZC, на балансе ${this.formatCoinAmount(balance)} ZC.`, 'error');
                return;
            }
            const ok = await this.confirmAction({
                title: `Купить «${item.name}»?`,
                message: `${this.formatCoinAmount(item.price)} ZC уйдут автору @${item.owner}. На вашем балансе ${this.formatCoinAmount(balance)} ZC. Покупка привязана к аккаунту: переустановить аддон можно в любой момент без доплаты.`,
                confirmLabel: `Купить за ${this.formatCoinAmount(item.price)} ZC`,
                danger: false,
            });
            if (!ok) return;
        }
        st.busyId = id;
        this.renderHubStore();
        try {
            if (!item.owned) {
                const res = await this.apiFetch(`/api/addons/store/${encodeURIComponent(id)}/buy`, { method: 'POST', body: '{}', interactive: true });
                let body = null;
                try { body = await res.json(); } catch (e) { /* пустой ответ */ }
                if (!res.ok) throw new Error(String(body?.message || `Сервер отказал (${res.status})`));
                item.owned = true;
                if (Number.isFinite(Number(body?.balance))) {
                    st.balance = Number(body.balance);
                    this.S.zaliCoinBalance = st.balance;
                }
            }
            const res = await this.apiFetch(`/api/addons/store/${encodeURIComponent(id)}/download`, { interactive: true });
            let body = null;
            try { body = await res.json(); } catch (e) { /* пустой ответ */ }
            if (!res.ok) throw new Error(String(body?.message || `Сервер отказал (${res.status})`));
            const bin = atob(String(body.dataBase64 || ''));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            const file = new File([bytes], String(body.fileName || `${id}.zali`), { type: 'application/octet-stream' });
            st.busyId = '';
            this.renderHubStore();
            await this.installAddonFromFile(file);
            this.renderHubStore();
        } catch (error) {
            this.setStoreStatus(String(error?.message || error), 'error');
        } finally {
            if (st.busyId) {
                st.busyId = '';
                this.renderHubStore();
            }
        }
    }
});
