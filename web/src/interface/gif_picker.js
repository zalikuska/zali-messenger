// --- ZaliInterface: выбор GIF (KLIPY) — третья кнопка поля ввода. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Ключ приложения KLIPY отдаёт наш сервер (GET /api/gifs/config, server/src/gifs.rs).
// Кнопка видна всегда; без ключа окно объясняет, чего не хватает. Дальше сервер не
// участвует: условия KLIPY требуют, чтобы запросы к API и загрузка картинок шли прямо
// из клиента, без прокси и кеша партнёра, а выдача показывалась в их порядке и отдельно
// от чужого контента. CORS у api.klipy.com открыт (`*`), поэтому прямой fetch работает
// и в браузере, и в WebView всех оболочек (Android — с Origin: null).
//
// Отправляется ссылка на файл из ответа KLIPY как есть (URL менять нельзя) — обычным
// текстовым сообщением. Получатель рисует её через renderUrlPreview (isKlipyUrl), а
// старые клиенты — как любую прямую ссылку на картинку (isDirectMediaUrl).
//
// Избранное — вкладка рядом с выдачей KLIPY и звёздочка на плитке и на GIF в чате.
// Хранится на устройстве, отдельно на каждый аккаунт (zali_gif_favorites_v1:<имя>):
// только ссылки и размеры, сами файлы не копируются (условия KLIPY). В облако настроек
// не кладётся — там 4 КБ на значение.
//
// Тестовый ключ KLIPY — 100 запросов в час, поэтому: поиск с паузой после ввода,
// тренды кешируются на 10 минут, «поделиться» шлётся одним запросом без повторов,
// избранное и фильтр по нему запросов не делают.
ZaliMixin(ZaliInterface, class {

    static get GIF_API_BASE() { return 'https://api.klipy.com/api/v1'; }
    static get GIF_FAVORITES_MAX() { return 200; }
    static get GIF_STAR_SVG() {
        return '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>';
    }

    // ── Ключ KLIPY с нашего сервера ─────────────────────────────────────

    gifConfigScope() {
        let base = '';
        try { base = this.getApiBaseUrl(); } catch (e) {}
        return `${base}|${this.myName() || ''}`;
    }

    /** GET /api/gifs/config — кеш на сервер и аккаунт, после сбоя пауза 60 с. */
    loadGifConfig() {
        const scope = this.gifConfigScope();
        if (!this.myName()) return Promise.resolve(null);
        if (this._gifConfigScope === scope && this._gifConfig) return Promise.resolve(this._gifConfig);
        if (this._gifConfigScope === scope && this._gifConfigPromise) return this._gifConfigPromise;
        if (this._gifConfigScope === scope && this._gifConfigFailedAt && Date.now() - this._gifConfigFailedAt < 60000) {
            return Promise.resolve(null);
        }
        this._gifConfigScope = scope;
        this._gifConfig = null;
        const run = (async () => {
            try {
                const res = await this.apiFetch(this.apiRoutes.gifs.config, { timeoutMs: 8000 });
                if (res.ok) {
                    const data = await res.json();
                    const appKey = String(data?.appKey || '').trim();
                    const config = { enabled: !!data?.enabled && !!appKey, appKey };
                    if (this._gifConfigScope === scope) this._gifConfig = config;
                    // DNS и TLS к KLIPY — заранее, пока человек ещё не нажал кнопку.
                    if (config.enabled) this.gifWarmConnections();
                    return config;
                }
                if (res.status === 404) {
                    // Сервер старше выбора GIF.
                    const config = { enabled: false, appKey: '' };
                    if (this._gifConfigScope === scope) this._gifConfig = config;
                    return config;
                }
            } catch (e) {
                this.trace(`loadGifConfig failed error=${e?.message || e}`);
            }
            if (this._gifConfigScope === scope) this._gifConfigFailedAt = Date.now();
            return null;
        })();
        this._gifConfigPromise = run;
        run.finally(() => {
            if (this._gifConfigPromise === run) this._gifConfigPromise = null;
            this.syncGifButton();
        });
        return run;
    }

    gifEnabled() {
        return !!(this._gifConfig?.enabled && this._gifConfigScope === this.gifConfigScope());
    }

    /** Доступность кнопки; зовётся из updateSendButtonState. Кнопка видна всегда:
     *  без ключа на сервере окно само говорит, чего не хватает (скрытую кнопку
     *  не найти и не понять, почему её нет). */
    syncGifButton() {
        const btn = document.getElementById('gifBtn');
        if (!btn) return;
        if (!this.gifEnabled()) void this.loadGifConfig();
        if (btn.hidden) btn.hidden = false;
        const noTarget = !!document.getElementById('attachBtn')?.disabled;
        btn.disabled = noTarget;
        if (noTarget && this.gifPickerOpen()) this.closeGifPicker();
        if (this.gifPickerOpen()) this.gifSyncAvailability();
    }

    /** Без ключа — объяснение вместо сетки; ключ появился — обычная выдача. */
    gifSyncAvailability() {
        const el = document.getElementById('gifPicker');
        if (!el) return false;
        const enabled = this.gifEnabled();
        const search = el.querySelector('.gif-picker-search');
        if (search) search.disabled = !enabled;
        el.classList.toggle('is-unavailable', !enabled);
        if (!enabled) {
            this.gifClearGrid();
            this.gifSetNote(this._gifConfigPromise
                ? ''
                : (this._gifConfig
                    ? 'GIF пока не подключены: на сервере не задан ключ KLIPY (KLIPY_APP_KEY).'
                    : 'Не удалось связаться с сервером. Попробуйте ещё раз чуть позже.'));
        } else if (this._gifUnavailableShown) {
            this.gifSetNote('');
        }
        this._gifUnavailableShown = !enabled;
        return enabled;
    }

    /** Постоянный анонимный id устройства для KLIPY (не имя аккаунта). */
    gifCustomerId() {
        const key = 'zali_klipy_customer_v1';
        try {
            let id = localStorage.getItem(key);
            if (!id) {
                id = window.crypto?.randomUUID ? window.crypto.randomUUID() : this.randomBase64(16).replace(/[^a-z0-9]/gi, '');
                localStorage.setItem(key, id);
            }
            return id;
        } catch (e) {
            if (!this._gifCustomerFallback) this._gifCustomerFallback = window.crypto?.randomUUID?.() || String(Date.now());
            return this._gifCustomerFallback;
        }
    }

    gifLocale() {
        const lang = String(navigator.language || 'en').toLowerCase().split(/[-_]/)[0];
        return /^[a-z]{2}$/.test(lang) ? lang : 'en';
    }

    // ── Избранное ───────────────────────────────────────────────────────

    gifFavoritesKey() {
        return `zali_gif_favorites_v1:${String(this.myName() || '').toLowerCase()}`;
    }

    /** Список избранного, новые первыми: { url, preview, w, h, title, slug, at }. */
    gifFavorites() {
        const key = this.gifFavoritesKey();
        if (this._gifFavKey === key && Array.isArray(this._gifFavs)) return this._gifFavs;
        let list = [];
        try {
            const raw = JSON.parse(localStorage.getItem(key) || '[]');
            if (Array.isArray(raw)) {
                list = raw.filter(f => f && typeof f.url === 'string' && /^https:\/\//i.test(f.url) && this.isKlipyUrl(f.url))
                    .map(f => ({
                        url: f.url,
                        preview: typeof f.preview === 'string' && /^https:\/\//i.test(f.preview) && this.isKlipyUrl(f.preview) ? f.preview : f.url,
                        poster: typeof f.poster === 'string' && /^https:\/\//i.test(f.poster) && this.isKlipyUrl(f.poster) ? f.poster : '',
                        w: Number(f.w) || 1,
                        h: Number(f.h) || 1,
                        title: String(f.title || '').slice(0, 200),
                        slug: String(f.slug || '').slice(0, 200),
                        at: Number(f.at) || 0,
                    }));
            }
        } catch (e) {}
        this._gifFavKey = key;
        this._gifFavs = list;
        return list;
    }

    gifSaveFavorites(list) {
        this._gifFavKey = this.gifFavoritesKey();
        this._gifFavs = list.slice(0, this.constructor.GIF_FAVORITES_MAX);
        try { localStorage.setItem(this._gifFavKey, JSON.stringify(this._gifFavs)); } catch (e) {}
    }

    gifIsFavorite(url) {
        return !!url && this.gifFavorites().some(f => f.url === url);
    }

    /** Добавить/убрать. entry — запись выдачи (gifEntryFromItem) или { url } из чата. */
    gifToggleFavorite(entry) {
        const url = String(entry?.url || '');
        if (!url || !this.isKlipyUrl(url)) return false;
        const list = this.gifFavorites();
        const on = !list.some(f => f.url === url);
        const next = on
            ? [{
                url,
                preview: entry.preview || url,
                poster: String(entry.poster || ''),
                w: Number(entry.w) || 1,
                h: Number(entry.h) || 1,
                title: String(entry.title || ''),
                slug: String(entry.slug || ''),
                at: Date.now(),
            }, ...list]
            : list.filter(f => f.url !== url);
        this.gifSaveFavorites(next);
        this.syncGifFavStars(document);
        this.gifUpdateFavCount();
        return on;
    }

    // ── Синхронизация избранного (settings_sync.js, ключ gif_favorites) ──
    // Сжатый вид: строка «v1», дальше по строке на GIF: «файл|превью|ШxВ». Файл —
    // хвост после https://static.klipy.com/ii/ (≈50 байт) или полный адрес другого
    // хоста KLIPY; превью из той же папки — только имя файла. Около 75 байт на GIF:
    // 200 штук — ~15 КБ при пределе ключа на сервере 16 КБ. Названия и slug не едут
    // (поиск по названию — по тем, что отмечены на этом устройстве).

    static get GIF_SYNC_PREFIX() { return 'https://static.klipy.com/ii/'; }

    /** Предел значения: 16 КБ — только сервер, что знает /api/gifs/config (и поднятый
     *  предел), иначе 4 КБ: длинное значение старый сервер отверг бы вместе со всеми
     *  остальными настройками в том же запросе. */
    gifSyncLimitBytes() {
        return this._gifConfig ? 15 * 1024 : 4000;
    }

    gifSyncEncode() {
        let stored = null;
        try { stored = localStorage.getItem(this.gifFavoritesKey()); } catch (e) {}
        if (stored === null) return null; // избранного здесь никогда не было — нечего слать
        const prefix = this.constructor.GIF_SYNC_PREFIX;
        const pack = (url) => (url.startsWith(prefix) ? url.slice(prefix.length) : url);
        const lines = ['v1'];
        let size = 2;
        const limit = this.gifSyncLimitBytes();
        for (const f of this.gifFavorites()) {
            const dir = f.url.slice(0, f.url.lastIndexOf('/') + 1);
            const preview = f.preview && f.preview !== f.url
                ? (f.preview.startsWith(dir) && !f.preview.slice(dir.length).includes('/') ? f.preview.slice(dir.length) : pack(f.preview))
                : '';
            const line = `${pack(f.url)}|${preview}|${Math.round(f.w) || 1}x${Math.round(f.h) || 1}`;
            if (/[\n]/.test(line)) continue;
            if (size + line.length + 1 > limit) break;
            lines.push(line);
            size += line.length + 1;
        }
        return lines.join('\n');
    }

    gifSyncApply(raw) {
        const lines = String(raw || '').split('\n');
        if (lines[0] !== 'v1') return;
        const prefix = this.constructor.GIF_SYNC_PREFIX;
        const unpack = (s) => (/^https:\/\//i.test(s) ? s : prefix + s);
        const local = new Map(this.gifFavorites().map(f => [f.url, f]));
        const now = Date.now();
        const list = [];
        lines.slice(1).forEach((line, i) => {
            const [file, prev, size] = line.split('|');
            if (!file) return;
            const url = unpack(file);
            if (!/^https:\/\//i.test(url) || !this.isKlipyUrl(url)) return;
            const dir = url.slice(0, url.lastIndexOf('/') + 1);
            const preview = !prev ? url : (prev.includes('/') || /^https:\/\//i.test(prev) ? unpack(prev) : dir + prev);
            const [w, h] = String(size || '').split('x').map(Number);
            const known = local.get(url);
            list.push({
                url,
                preview: this.isKlipyUrl(preview) ? preview : url,
                w: w > 0 ? w : 1,
                h: h > 0 ? h : 1,
                title: known?.title || '',
                slug: known?.slug || '',
                poster: known?.poster || '',
                at: known?.at || now - i,
            });
        });
        this.gifSaveFavorites(list);
        this.syncGifFavStars(document);
        this.gifUpdateFavCount();
        if (this.gifPickerOpen() && this._gifTab === 'fav') this.gifRenderFavorites();
    }

    /** Звёздочки на плитках и на GIF в ленте — по текущему избранному. */
    syncGifFavStars(root = document) {
        const set = new Set(this.gifFavorites().map(f => f.url));
        root.querySelectorAll?.('[data-gif-fav]').forEach(btn => {
            const on = set.has(btn.getAttribute('data-gif-fav') || '');
            if (btn.classList.contains('is-on') !== on) btn.classList.toggle('is-on', on);
            const pressed = on ? 'true' : 'false';
            if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
            const label = on ? 'Убрать из избранного' : 'В избранное';
            if (btn.getAttribute('aria-label') !== label) {
                btn.setAttribute('aria-label', label);
                btn.title = label;
            }
        });
    }

    /** Звёздочка поверх GIF из KLIPY в ленте (renderUrlPreview). */
    gifFavStarHTML(url) {
        const on = this.gifIsFavorite(url);
        const label = on ? 'Убрать из избранного' : 'В избранное';
        return `<button type="button" class="gif-fav-star${on ? ' is-on' : ''}" data-gif-fav="${this.esc(url)}" aria-pressed="${this.esc(String(on))}" aria-label="${this.esc(label)}" title="${this.esc(label)}">${this.constructor.GIF_STAR_SVG}</button>`;
    }

    /** Делегат кликов документа (events.js): звёздочка на GIF в ленте. */
    onGifFavClick(e) {
        const btn = e.target?.closest?.('.gif-fav-star[data-gif-fav]');
        if (!btn || btn.closest('#gifPicker')) return false;
        e.preventDefault();
        e.stopPropagation();
        const url = btn.getAttribute('data-gif-fav') || '';
        const media = btn.parentElement?.querySelector('img.media-img, video.media-video');
        this.gifToggleFavorite({
            url,
            preview: url,
            w: media?.naturalWidth || media?.videoWidth || 1,
            h: media?.naturalHeight || media?.videoHeight || 1,
        });
        return true;
    }

    gifUpdateFavCount() {
        const count = document.querySelector('#gifPicker .gif-picker-tab-count');
        if (!count) return;
        const n = this.gifFavorites().length;
        const text = n ? String(n) : '';
        if (count.textContent !== text) count.textContent = text;
        count.hidden = !n;
    }

    // ── Окно ────────────────────────────────────────────────────────────

    gifPickerOpen() {
        const el = document.getElementById('gifPicker');
        return !!el && !el.hidden;
    }

    toggleGifPicker() {
        if (this.gifPickerOpen()) this.closeGifPicker();
        else this.openGifPicker();
    }

    ensureGifPicker() {
        let el = document.getElementById('gifPicker');
        if (el) return el;
        const area = document.querySelector('#viewChat .input-area');
        if (!area) return null;
        el = document.createElement('div');
        el.id = 'gifPicker';
        el.className = 'gif-picker';
        el.hidden = true;
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Выбор GIF');
        el.setAttribute('data-no-swipe', '');

        const head = document.createElement('div');
        head.className = 'gif-picker-head';
        const search = document.createElement('input');
        search.type = 'search';
        search.className = 'gif-picker-search';
        // «Search KLIPY» в поле поиска — обязательная часть подписи по условиям KLIPY.
        search.placeholder = 'Поиск в KLIPY';
        search.setAttribute('aria-label', 'Поиск GIF в KLIPY');
        search.autocomplete = 'off';
        search.spellcheck = false;
        search.enterKeyHint = 'search';

        const tabs = document.createElement('div');
        tabs.className = 'gif-picker-tabs';
        tabs.setAttribute('role', 'tablist');
        for (const [id, label] of [['klipy', 'KLIPY'], ['fav', 'Избранное']]) {
            const tab = document.createElement('button');
            tab.type = 'button';
            tab.className = 'gif-picker-tab';
            tab.dataset.gifTab = id;
            tab.setAttribute('role', 'tab');
            tab.setAttribute('aria-selected', id === 'klipy' ? 'true' : 'false');
            tab.append(label);
            if (id === 'fav') {
                const count = document.createElement('span');
                count.className = 'gif-picker-tab-count';
                count.hidden = true;
                tab.append(count);
            }
            tabs.appendChild(tab);
        }
        head.append(search, tabs);

        const body = document.createElement('div');
        body.className = 'gif-picker-body';
        const grid = document.createElement('div');
        grid.className = 'gif-picker-grid';
        for (let i = 0; i < 2; i++) {
            const col = document.createElement('div');
            col.className = 'gif-picker-col';
            grid.appendChild(col);
        }
        const note = document.createElement('div');
        note.className = 'gif-picker-note';
        note.hidden = true;
        body.append(grid, note);

        const foot = document.createElement('div');
        foot.className = 'gif-picker-foot';
        foot.textContent = 'Powered by KLIPY';

        el.append(head, body, foot);
        area.appendChild(el);

        this._gifTab = 'klipy';
        search.addEventListener('input', () => {
            clearTimeout(this._gifSearchTimer);
            // В избранном поиск — фильтр по названию на месте, без запросов к KLIPY.
            if (this._gifTab === 'fav') {
                this.gifRenderFavorites();
                return;
            }
            // Запрос из памяти — сразу; новый — после паузы 250 мс (устаревший обрывается в gifLoad).
            if (this.gifCacheGet(search.value)) {
                this.gifLoad({ reset: true });
                return;
            }
            this._gifSearchTimer = setTimeout(() => this.gifLoad({ reset: true }), 250);
        });
        search.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                clearTimeout(this._gifSearchTimer);
                if (this._gifTab === 'fav') this.gifRenderFavorites();
                else this.gifLoad({ reset: true });
            }
        });
        tabs.addEventListener('click', (e) => {
            const tab = e.target.closest?.('[data-gif-tab]');
            if (tab) this.gifSetTab(tab.dataset.gifTab);
        });
        body.addEventListener('scroll', () => {
            if (this._gifTab !== 'klipy') return;
            if (body.scrollTop + body.clientHeight >= body.scrollHeight - 240) this.gifLoad({ reset: false });
        }, { passive: true });
        grid.addEventListener('click', (e) => {
            const tile = e.target.closest?.('.gif-picker-tile');
            if (!tile || !grid.contains(tile)) return;
            const entry = this._gifItems?.get(tile.dataset.gifKey || '');
            if (!entry) return;
            if (e.target.closest('.gif-fav-star')) this.gifToggleFavorite(entry);
            else this.sendGif(entry);
        });
        el.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this.closeGifPicker({ restoreFocus: true });
            }
        });
        return el;
    }

    gifSetTab(tab) {
        const el = document.getElementById('gifPicker');
        if (!el || !this.gifEnabled()) return;
        const next = tab === 'fav' ? 'fav' : 'klipy';
        el.querySelectorAll('[data-gif-tab]').forEach(btn => {
            btn.setAttribute('aria-selected', btn.dataset.gifTab === next ? 'true' : 'false');
        });
        const search = el.querySelector('.gif-picker-search');
        search.placeholder = next === 'fav' ? 'Поиск в избранном' : 'Поиск в KLIPY';
        if (this._gifTab === next) return;
        this._gifTab = next;
        search.value = '';
        clearTimeout(this._gifSearchTimer);
        this._gifSeq = (this._gifSeq || 0) + 1; // ответ KLIPY, что ещё в пути, больше не нужен
        this._gifAbort?.abort();
        this._gifLoading = false;
        if (next === 'fav') this.gifRenderFavorites();
        else this.gifLoad({ reset: true });
    }

    openGifPicker() {
        const el = this.ensureGifPicker();
        if (!el) return;
        el.hidden = false;
        document.getElementById('gifBtn')?.setAttribute('aria-expanded', 'true');
        this.gifUpdateFavCount();
        if (!this.gifEnabled()) {
            // Переспрашиваем сервер на каждом открытии без ключа: ключ могли вписать и
            // перезапустить сервер, а ответ «выключено» лежит в памяти. Запрос свой, дешёвый.
            if (!this._gifConfigPromise) {
                this._gifConfig = null;
                this._gifConfigFailedAt = 0;
            }
            const pending = this.loadGifConfig();
            this.gifSyncAvailability();
            pending.then(() => {
                if (this.gifPickerOpen() && this.gifSyncAvailability()) this.gifFillPicker({ force: true });
            });
        } else {
            this.gifSyncAvailability();
            this.gifFillPicker();
        }
        if (!this._gifOutsideHandler) {
            this._gifOutsideHandler = (e) => {
                const picker = document.getElementById('gifPicker');
                if (!picker || picker.hidden) return;
                if (picker.contains(e.target) || document.getElementById('gifBtn')?.contains(e.target)) return;
                this.closeGifPicker();
            };
            document.addEventListener('pointerdown', this._gifOutsideHandler, true);
        }
    }

    gifFillPicker({ force = false } = {}) {
        const el = document.getElementById('gifPicker');
        const search = el?.querySelector('.gif-picker-search');
        if (!search) return;
        if (this._gifTab === 'fav') {
            this.gifRenderFavorites();
        } else if (this.gifCacheGet(search.value)) {
            // Выдача в памяти свежая — показываем её без запроса (лимит тестового ключа).
            const query = search.value.trim();
            if (force || this._gifQuery !== query || !this._gifItems?.size) this.gifRenderFromCache(query);
        } else if (force || !this._gifItems?.size || this._gifQuery !== search.value.trim()) {
            this.gifLoad({ reset: true });
        }
        // На телефоне фокус в поиск не ставим: клавиатура закроет сетку (§6 гайдлайнов).
        if (!this.isMobileLayout()) {
            try { search.focus({ preventScroll: true }); } catch (e) { search.focus(); }
        }
    }

    closeGifPicker({ restoreFocus = false } = {}) {
        const el = document.getElementById('gifPicker');
        if (el) el.hidden = true;
        clearTimeout(this._gifSearchTimer);
        const btn = document.getElementById('gifBtn');
        btn?.setAttribute('aria-expanded', 'false');
        if (this._gifOutsideHandler) {
            document.removeEventListener('pointerdown', this._gifOutsideHandler, true);
            this._gifOutsideHandler = null;
        }
        if (restoreFocus) {
            const input = document.getElementById('msgInput');
            if (input && !input.disabled && !this.isMobileLayout()) input.focus();
        }
    }

    gifClearGrid() {
        const el = document.getElementById('gifPicker');
        this._gifIO?.disconnect();
        el?.querySelectorAll('.gif-picker-col').forEach(col => col.replaceChildren());
        this._gifItems = new Map();
        this._gifColHeights = [0, 0];
        const body = el?.querySelector('.gif-picker-body');
        if (body) body.scrollTop = 0;
        this.gifSetNote('');
    }

    gifSetNote(text) {
        const note = document.querySelector('#gifPicker .gif-picker-note');
        if (!note) return;
        note.textContent = text;
        note.hidden = !text;
    }

    gifRenderFavorites() {
        const el = document.getElementById('gifPicker');
        if (!el) return;
        this._gifQuery = null; // выдача KLIPY в сетке больше не лежит
        this.gifClearGrid();
        const query = el.querySelector('.gif-picker-search')?.value.trim().toLowerCase() || '';
        const all = this.gifFavorites();
        const list = query ? all.filter(f => f.title.toLowerCase().includes(query)) : all;
        this.gifAppendEntries(list.map(f => ({ ...f, key: f.url })));
        if (!all.length) this.gifSetNote('Здесь будут GIF со звёздочкой. Отметьте любой — в окне или прямо в чате.');
        else if (!list.length) this.gifSetNote('В избранном такого нет.');
    }

    // ── Память выдачи: тренды ('') и последние запросы поиска ────────────
    // По 10 минут, не больше 30 запросов: стёрли букву и вернули — ответ без запроса.
    // Хранятся только ответы API (ссылки), не файлы.

    static get GIF_CACHE_TTL() { return 600000; }
    static get GIF_CACHE_MAX() { return 30; }

    gifCacheGet(query) {
        const key = String(query || '').trim().toLowerCase();
        const entry = this._gifCache?.get(key);
        if (!entry) return null;
        if (Date.now() - entry.at > this.constructor.GIF_CACHE_TTL) {
            this._gifCache.delete(key);
            return null;
        }
        return entry;
    }

    gifCacheStore(query, page, items, hasNext) {
        if (!this._gifCache) this._gifCache = new Map();
        const key = String(query || '').trim().toLowerCase();
        const prev = page > 1 ? this.gifCacheGet(key) : null;
        if (page > 1 && !prev) return; // первая страница уже устарела — хвост без головы не храним
        const entry = { at: prev ? prev.at : Date.now(), items: (prev ? prev.items : []).concat(items), page, hasNext };
        this._gifCache.delete(key);
        this._gifCache.set(key, entry);
        while (this._gifCache.size > this.constructor.GIF_CACHE_MAX) {
            this._gifCache.delete(this._gifCache.keys().next().value);
        }
    }

    gifRenderFromCache(query = '') {
        const cache = this.gifCacheGet(query);
        if (!cache) return;
        this._gifSeq = (this._gifSeq || 0) + 1;
        this._gifAbort?.abort();
        this._gifQuery = String(query || '').trim();
        this.gifClearGrid();
        this._gifPage = cache.page;
        this._gifHasNext = cache.hasNext;
        this.gifAppendItems(cache.items);
    }

    /** Страница трендов или поиска. reset — с первой страницы и с очисткой сетки. */
    async gifLoad({ reset = false } = {}) {
        const appKey = this._gifConfig?.appKey;
        const el = document.getElementById('gifPicker');
        if (!appKey || !el || this._gifTab === 'fav') return;
        const query = el.querySelector('.gif-picker-search')?.value.trim() || '';
        if (!reset) {
            if (this._gifLoading || !this._gifHasNext || query !== this._gifQuery) return;
        }
        // Тренды уже грузятся заранее (наведение на кнопку) — дождаться их, а не слать второй запрос.
        if (reset && !query && this._gifPrefetch) {
            const waitSeq = (this._gifSeq = (this._gifSeq || 0) + 1);
            this._gifQuery = '';
            this.gifClearGrid();
            this._gifLoading = true;
            await this._gifPrefetch;
            if (waitSeq !== this._gifSeq) return;
            this._gifLoading = false;
        }
        if (reset && this.gifCacheGet(query)) {
            this.gifRenderFromCache(query);
            return;
        }
        const seq = (this._gifSeq = (this._gifSeq || 0) + 1);
        const page = reset ? 1 : (this._gifPage || 1) + 1;
        if (reset) {
            this._gifQuery = query;
            this.gifClearGrid();
        }
        // Новый поиск обрывает прежний запрос: его ответ всё равно выбросили бы.
        this._gifAbort?.abort();
        const ctrl = new AbortController();
        this._gifAbort = ctrl;
        this._gifLoading = true;
        const { data, failure } = await this.gifFetchPage(appKey, query, page, ctrl);
        if (seq !== this._gifSeq) return; // пришёл ответ на устаревший запрос
        this._gifLoading = false;
        if (!data?.result || !data?.data) {
            if (page === 1 || failure) this.gifSetNote(failure || 'Не удалось загрузить GIF.');
            this._gifHasNext = false;
            return;
        }
        const items = Array.isArray(data.data.data) ? data.data.data : [];
        this._gifPage = Number(data.data.current_page) || page;
        this._gifHasNext = !!data.data.has_next && items.length > 0;
        this.gifCacheStore(query, this._gifPage, items, this._gifHasNext);
        this.gifAppendItems(items);
        if (page === 1 && !items.length) this.gifSetNote(query ? 'Ничего не нашлось.' : 'Пока пусто.');
    }

    /** Один запрос трендов или поиска к KLIPY: { data, failure }. */
    async gifFetchPage(appKey, query, page, ctrl = new AbortController()) {
        const params = new URLSearchParams({
            page: String(page),
            per_page: '24',
            customer_id: this.gifCustomerId(),
            locale: this.gifLocale(),
            content_filter: 'medium',
        });
        if (query) params.set('q', query);
        const url = `${this.constructor.GIF_API_BASE}/${encodeURIComponent(appKey)}/gifs/${query ? 'search' : 'trending'}?${params}`;
        let data = null;
        let failure = '';
        try {
            const timer = setTimeout(() => ctrl.abort(), 12000);
            const res = await fetch(url, { signal: ctrl.signal, credentials: 'omit', referrerPolicy: 'no-referrer' });
            clearTimeout(timer);
            if (res.status === 429) failure = 'KLIPY временно ограничил запросы. Попробуйте чуть позже.';
            else if (!res.ok) failure = 'Не удалось загрузить GIF.';
            else data = await res.json();
        } catch (e) {
            failure = 'Нет связи с KLIPY.';
        }
        return { data, failure };
    }

    // ── Скорость первого открытия ────────────────────────────────────────
    // Замер 2026-11-19 (Mac через VPN): холодный DNS static.klipy.com — 1,4 с, TLS к
    // api/static — 0,2–0,5 с, а сами файлы у KLIPY уже в кеше Cloudflare (HIT). Свой
    // кеш на сервере не помог бы (VPS дальше их CDN) и запрещён условиями KLIPY, поэтому:
    // соединения прогреваются заранее, тренды и первые превью грузятся при наведении на
    // кнопку, а в чат уходит mp4 (в 5 раз легче webp того же размера).

    /** preconnect к API и CDN KLIPY. fetch идёт без кук (анонимный пул соединений),
     *  картинки — обычным <img>, поэтому у них разные подсказки. */
    gifWarmConnections() {
        if (this._gifWarmAt && Date.now() - this._gifWarmAt < 15000) return;
        this._gifWarmAt = Date.now();
        const hints = [
            ['preconnect', 'https://api.klipy.com', 'anonymous'],
            ['preconnect', 'https://static.klipy.com', null],
            ['dns-prefetch', 'https://static1.klipy.com', null],
            ['dns-prefetch', 'https://static2.klipy.com', null],
        ];
        for (const [rel, href, cors] of hints) {
            // Пересоздание подсказки заново открывает соединение, если старое закрылось по простою.
            document.head.querySelector(`link[data-gif-warm="${rel}:${href}"]`)?.remove();
            const link = document.createElement('link');
            link.rel = rel;
            link.href = href;
            if (cors) link.crossOrigin = cors;
            link.dataset.gifWarm = `${rel}:${href}`;
            document.head.appendChild(link);
        }
    }

    /** Наведение/нажатие на кнопку GIF: тренды и первые превью — до открытия окна. */
    gifPrefetchTrending() {
        const appKey = this._gifConfig?.appKey;
        if (!appKey || !this.gifEnabled()) return;
        this.gifWarmConnections();
        if (this._gifPrefetch || this.gifPickerOpen()) return;
        if (this.gifCacheGet('')) return;
        const run = (async () => {
            const { data } = await this.gifFetchPage(appKey, '', 1);
            if (!data?.result || !data?.data) return;
            const items = Array.isArray(data.data.data) ? data.data.data : [];
            this.gifCacheStore('', Number(data.data.current_page) || 1, items, !!data.data.has_next && items.length > 0);
            // Первые кадры — в кеш браузера тем же способом, что грузит плитка (<img>/poster
            // без CORS): постер-jpg у видео-превью (~8 КБ), иначе само webp-превью.
            for (const item of items.slice(0, 8)) {
                const entry = this.gifEntryFromItem(item);
                if (!entry) continue;
                const img = new Image();
                img.referrerPolicy = 'no-referrer';
                img.decoding = 'async';
                img.src = entry.poster || entry.preview;
            }
        })();
        this._gifPrefetch = run;
        run.finally(() => {
            if (this._gifPrefetch === run) this._gifPrefetch = null;
        });
    }

    /** Лучший вариант файла по порядку размеров и форматов. По умолчанию webp
     *  (лёгкий, анимированный, рисуется <img>), затем gif. */
    gifPickFile(item, sizes, formats = ['webp', 'gif']) {
        const file = item?.file || {};
        for (const size of sizes) {
            const set = file[size];
            if (!set) continue;
            for (const fmt of formats) {
                const f = set[fmt];
                if (f?.url && /^https:\/\//i.test(f.url)) return f;
            }
        }
        return null;
    }

    /** Запись выдачи KLIPY в общем виде плитки (тот же вид хранит избранное). */
    gifEntryFromItem(item) {
        // Реклама в выдаче приходит только при включённой в панели KLIPY рекламе —
        // у нас она выключена, других типов в ответе GIF нет.
        if (item?.type && item.type !== 'gif') return null;
        const slug = String(item?.slug || '');
        // Превью плитки — sm.mp4 (~50 КБ, 320 px) с постером sm.jpg (~8 КБ): легче и чётче
        // анимированного sm.webp (~80 КБ, 220 px). Нет mp4 — webp/gif как раньше.
        const preview = this.gifPickFile(item, ['sm', 'xs'], ['mp4']) || this.gifPickFile(item, ['sm', 'xs', 'md']);
        const poster = /\.mp4(\?|$)/i.test(preview?.url || '') ? this.gifPickFile(item, ['sm', 'xs'], ['jpg']) : null;
        // В чат — mp4: md.mp4 ~120 КБ против ~640 КБ у md.webp и 3,7 МБ у gif. Получатель
        // рисует его как GIF (video autoplay loop muted, renderUrlPreview → isKlipyUrl).
        const send = this.gifPickFile(item, ['md', 'hd', 'sm'], ['mp4', 'webp', 'gif']);
        if (!slug || !preview || !send) return null;
        // Размытая заглушка KLIPY — готовый data:-адрес крошечного JPEG (~0,8 КБ), фон плитки,
        // пока грузится превью. Принимаем только этот вид: строка уходит в style.
        const blur = typeof item.blur_preview === 'string' && item.blur_preview.length < 12000
            && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/.test(item.blur_preview) ? item.blur_preview : '';
        return {
            key: slug,
            slug,
            title: String(item.title || ''),
            url: send.url,
            preview: preview.url,
            poster: poster?.url || '',
            w: Number(preview.width) || 1,
            h: Number(preview.height) || 1,
            blur,
        };
    }

    gifAppendItems(items) {
        this.gifAppendEntries(items.map(item => this.gifEntryFromItem(item)).filter(Boolean));
    }

    gifAppendEntries(entries) {
        const cols = [...document.querySelectorAll('#gifPicker .gif-picker-col')];
        if (cols.length < 2) return;
        if (!this._gifItems) this._gifItems = new Map();
        if (!this._gifColHeights) this._gifColHeights = [0, 0];
        const favs = new Set(this.gifFavorites().map(f => f.url));
        for (const entry of entries) {
            if (!entry?.key || this._gifItems.has(entry.key)) continue;
            this._gifItems.set(entry.key, entry);
            const ratio = Math.min(2.2, Math.max(0.45, entry.h / entry.w));
            const tile = document.createElement('div');
            tile.className = 'gif-picker-tile';
            tile.dataset.gifKey = entry.key;
            tile.style.aspectRatio = `${entry.w} / ${entry.h}`;
            if (entry.blur) tile.style.backgroundImage = `url("${entry.blur}")`;
            const pick = document.createElement('button');
            pick.type = 'button';
            pick.className = 'gif-picker-pick';
            pick.title = entry.title || 'GIF';
            pick.setAttribute('aria-label', `Отправить GIF${entry.title ? `: ${entry.title}` : ''}`);
            // Видео-превью (sm.mp4 выдачи или mp4 из чата в избранном): файл грузится и
            // играет, только пока плитка видна (gifObserveTile), за кадром — пауза.
            if (/\.(mp4|webm)(\?|$)/i.test(entry.preview)) {
                const video = document.createElement('video');
                video.muted = true;
                video.loop = true;
                video.playsInline = true;
                video.preload = 'none';
                video.setAttribute('muted', '');
                video.setAttribute('playsinline', '');
                video.dataset.src = entry.preview;
                if (entry.poster) video.poster = entry.poster;
                pick.appendChild(video);
                this.gifObserveTile(video);
            } else {
                const img = document.createElement('img');
                img.alt = '';
                img.loading = 'lazy';
                img.decoding = 'async';
                img.referrerPolicy = 'no-referrer';
                img.src = entry.preview;
                pick.appendChild(img);
            }
            const star = document.createElement('button');
            star.type = 'button';
            star.className = 'gif-fav-star';
            star.setAttribute('data-gif-fav', entry.url);
            const on = favs.has(entry.url);
            if (on) star.classList.add('is-on');
            star.setAttribute('aria-pressed', on ? 'true' : 'false');
            star.setAttribute('aria-label', on ? 'Убрать из избранного' : 'В избранное');
            star.title = on ? 'Убрать из избранного' : 'В избранное';
            star.innerHTML = this.constructor.GIF_STAR_SVG;
            tile.append(pick, star);
            // Порядок сохраняется: каждая следующая плитка — в более короткую колонку.
            const target = this._gifColHeights[0] <= this._gifColHeights[1] ? 0 : 1;
            cols[target].appendChild(tile);
            this._gifColHeights[target] += ratio;
        }
    }

    /** Видео плитки играет только в видимой части окна (+200 px запаса). */
    gifObserveTile(video) {
        if (typeof IntersectionObserver !== 'function') {
            video.src = video.dataset.src || '';
            video.autoplay = true;
            return;
        }
        if (!this._gifIO) {
            const root = document.querySelector('#gifPicker .gif-picker-body');
            this._gifIO = new IntersectionObserver((records) => {
                for (const rec of records) {
                    const v = rec.target;
                    if (rec.isIntersecting) {
                        if (!v.getAttribute('src') && v.dataset.src) v.src = v.dataset.src;
                        v.play?.()?.catch?.(() => {});
                    } else if (!v.paused) {
                        v.pause();
                    }
                }
            }, { root, rootMargin: '200px 0px' });
        }
        this._gifIO.observe(video);
    }

    sendGif(entry) {
        const url = String(entry?.url || '');
        if (!url) return;
        const query = this._gifTab === 'klipy' ? (this._gifQuery || '') : '';
        this.closeGifPicker({ restoreFocus: true });
        void this.sendInputMessage({ systemText: url });
        // Учёт «поделились» у KLIPY — улучшает их выдачу; ошибка ни на что не влияет.
        const appKey = this._gifConfig?.appKey;
        const slug = String(entry?.slug || '');
        if (appKey && slug) {
            const body = JSON.stringify(query ? { customer_id: this.gifCustomerId(), q: query } : { customer_id: this.gifCustomerId() });
            fetch(`${this.constructor.GIF_API_BASE}/${encodeURIComponent(appKey)}/gifs/share/${encodeURIComponent(slug)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body,
                credentials: 'omit',
                referrerPolicy: 'no-referrer',
                keepalive: true,
            }).catch(() => {});
        }
    }

    isKlipyUrl(url) {
        try {
            const parsed = new URL(url);
            // Только https: http-ссылку от собеседника подменил бы любой на пути.
            if (parsed.protocol !== 'https:') return false;
            const host = parsed.hostname.toLowerCase();
            return host === 'klipy.com' || host.endsWith('.klipy.com');
        } catch (e) {
            return false;
        }
    }
});
