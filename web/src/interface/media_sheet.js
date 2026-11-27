// --- ZaliInterface: галерея внутри приложения — лист плиток со своими фото (Android). ---
//
// «Скрепка» на Android открывает не системный выбор файла, а лист снизу: первая
// плитка — камера, дальше последние фото и видео телефона, выбор нескольких с
// порядковыми номерами, внизу «Прикрепить N». Плитки, превью и оригиналы даёт
// оболочка (apps/android/…/MediaGallery.kt): превью — обычные <img> по адресам
// https://zali-gallery.invalid/<token>/…, которые она перехватывает, оригинал —
// fetch() того же вида и File в handleFiles, как из <input type=file>.
//
// Без доступа к фото (не спрашивали, запретили) в листе камера и плашка с
// «Разрешить» / «Открыть настройки»; «Альбомы» в шапке — системный пикер
// (#attachmentInput → Photo Picker в MainActivity) при любом доступе. Плитка
// «Файл» — файловый менеджер (#anyFileInput): документы и .tgs не медиа.
ZaliMixin(ZaliInterface, class {

    openMediaSheet() {
        if (document.getElementById('mediaSheet')) return;
        // Клавиатура от поля ввода закрыла бы половину листа.
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        const requestId = `gallery-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        this._mediaSheet = {
            requestId,
            access: '',
            asked: false,
            items: [],
            loaded: false,
            selected: [],
            busy: false,
        };
        const layer = document.createElement('div');
        layer.className = 'media-sheet-layer';
        layer.id = 'mediaSheet';
        layer.innerHTML = `
            <div class="media-sheet-scrim" data-media-act="close"></div>
            <section class="media-sheet" role="dialog" aria-modal="true" aria-labelledby="mediaSheetTitle">
                <header class="media-sheet-head">
                    <h2 class="media-sheet-title" id="mediaSheetTitle">Фото и видео</h2>
                    <button class="media-sheet-link" type="button" data-media-act="system">Альбомы</button>
                    <button class="media-sheet-close" type="button" data-media-act="close" aria-label="Закрыть">${this.uiIcon('close')}</button>
                </header>
                <div class="media-sheet-body" id="mediaSheetBody"></div>
                <footer class="media-sheet-foot" id="mediaSheetFoot" hidden>
                    <button class="media-sheet-attach" type="button" data-media-act="attach"></button>
                </footer>
            </section>`;
        layer.addEventListener('click', (event) => this.onMediaSheetClick(event));
        layer.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') this.closeMediaSheet();
        });
        document.body.appendChild(layer);
        this.renderMediaSheet();
        this.postNativeMessage({ type: NativeMessageTypes.GALLERY_LIST, requestId, limit: ZaliInterface.MEDIA_SHEET_LIMIT });
    }

    closeMediaSheet() {
        const layer = document.getElementById('mediaSheet');
        this._mediaSheet = null;
        if (layer) layer.remove();
    }

    onMediaSheetClick(event) {
        const target = event.target.closest('[data-media-act]');
        if (!target) return;
        const st = this._mediaSheet;
        if (!st) return;
        const act = target.dataset.mediaAct;
        if (act === 'close') this.closeMediaSheet();
        else if (act === 'system') {
            this.closeMediaSheet();
            document.getElementById('attachmentInput')?.click();
        } else if (act === 'file') {
            this.closeMediaSheet();
            document.getElementById('anyFileInput')?.click();
        } else if (act === 'camera') {
            if (st.busy) return;
            this.postNativeMessage({ type: NativeMessageTypes.GALLERY_CAPTURE, requestId: st.requestId });
        } else if (act === 'access') {
            this.postNativeMessage({ type: NativeMessageTypes.GALLERY_REQUEST_ACCESS, requestId: st.requestId });
        } else if (act === 'settings') {
            this.postNativeMessage({ type: NativeMessageTypes.GALLERY_OPEN_SETTINGS });
        } else if (act === 'toggle') {
            this.toggleMediaSheetItem(target.dataset.mediaId);
        } else if (act === 'attach') {
            void this.attachMediaSheetSelection();
        }
    }

    onNativeGalleryEvent(payload) {
        const st = this._mediaSheet;
        if (!st || !payload || payload.requestId !== st.requestId) return;
        if (payload.event === 'list') {
            st.access = String(payload.access || 'none');
            st.asked = !!payload.asked;
            st.items = Array.isArray(payload.items) ? payload.items : [];
            st.loaded = true;
            // Выбранное, которого больше нет (доступ сузили до «только выбранных»), снимаем.
            const ids = new Set(st.items.map(item => item.id));
            st.selected = st.selected.filter(id => ids.has(id));
            this.renderMediaSheet();
        } else if (payload.event === 'captured' && payload.item) {
            void this.attachMediaSheetItems([payload.item]);
        }
        // capture_cancelled / capture_failed — лист остаётся как был.
    }

    // Возврат в приложение после системного окна (разрешение в настройках, «выбрать
    // ещё» на Android 14) — список мог измениться.
    refreshMediaSheet() {
        const st = this._mediaSheet;
        if (!st) return;
        this.postNativeMessage({ type: NativeMessageTypes.GALLERY_LIST, requestId: st.requestId, limit: ZaliInterface.MEDIA_SHEET_LIMIT });
    }

    renderMediaSheet() {
        const st = this._mediaSheet;
        const body = document.getElementById('mediaSheetBody');
        if (!st || !body) return;
        const tiles = [
            `<button class="media-tile media-tile-action" type="button" data-media-act="camera">
                ${this.uiIcon('camera')}<span>Камера</span>
            </button>`,
        ];
        // Пока список в пути — тишина: только камера (гайдлайны §2 п. 3).
        if (st.loaded && st.access === 'none') {
            const denied = st.asked;
            tiles.push(`<div class="media-sheet-ask">
                <p>${denied
                    ? 'Доступ к фото выключен в настройках Android. Включите его, чтобы выбирать фото здесь.'
                    : 'Разрешите доступ к фото, чтобы выбирать их прямо здесь.'}</p>
                <button class="media-sheet-ask-btn" type="button" data-media-act="${denied ? 'settings' : 'access'}">
                    ${denied ? 'Открыть настройки' : 'Разрешить'}
                </button>
            </div>`);
        } else if (st.loaded && st.access === 'partial') {
            tiles.push(`<button class="media-tile media-tile-action" type="button" data-media-act="access">
                ${this.uiIcon('plus')}<span>Выбрать ещё</span>
            </button>`);
        }
        // Не-медиа (документы, архивы, .tgs) Photo Picker не покажет, поэтому плитка
        // открывает файловый менеджер (#anyFileInput без accept).
        tiles.push(`<button class="media-tile media-tile-action" type="button" data-media-act="file">
            ${this.uiIcon('paperclip')}<span>Файл</span>
        </button>`);
        for (const item of st.items) tiles.push(this.mediaSheetTileHTML(item));
        let html = `<div class="media-sheet-grid">${tiles.join('')}</div>`;
        if (st.loaded && st.access !== 'none' && st.items.length === 0) {
            html += '<p class="media-sheet-empty">В галерее пока нет фото и видео.</p>';
        }
        this.setHTMLIfChanged(body, html);
        this.updateMediaSheetSelection();
    }

    mediaSheetTileHTML(item) {
        const video = item.kind === 'video';
        const duration = video && Number(item.durationMs) > 0
            ? `<span class="media-tile-dur">${this.esc(this.formatMediaDuration(item.durationMs))}</span>`
            : '';
        const label = video ? 'Видео' : 'Фото';
        return `<button class="media-tile" type="button" data-media-act="toggle" data-media-id="${this.esc(String(item.id || ''))}" aria-pressed="false" aria-label="${this.esc(label)}">
            <img src="${this.esc(String(item.thumb || ''))}" alt="" loading="lazy" decoding="async" draggable="false">
            ${duration}
            <span class="media-tile-check" aria-hidden="true"></span>
        </button>`;
    }

    formatMediaDuration(ms) {
        const total = Math.round(Number(ms) / 1000);
        const minutes = Math.floor(total / 60);
        const seconds = String(total % 60).padStart(2, '0');
        return `${minutes}:${seconds}`;
    }

    toggleMediaSheetItem(id) {
        const st = this._mediaSheet;
        if (!st || !id || st.busy) return;
        const index = st.selected.indexOf(id);
        if (index >= 0) st.selected.splice(index, 1);
        else if (st.selected.length < ZaliInterface.MEDIA_SHEET_MAX_SELECTED) st.selected.push(id);
        this.updateMediaSheetSelection();
    }

    // Выбор меняет только отметки и кнопку — сетку не перерисовываем, иначе <img>
    // создавались бы заново и превью мигали.
    updateMediaSheetSelection() {
        const st = this._mediaSheet;
        const layer = document.getElementById('mediaSheet');
        if (!st || !layer) return;
        for (const tile of layer.querySelectorAll('.media-tile[data-media-id]')) {
            const order = st.selected.indexOf(tile.dataset.mediaId);
            const on = order >= 0;
            tile.classList.toggle('is-selected', on);
            tile.setAttribute('aria-pressed', on ? 'true' : 'false');
            const check = tile.querySelector('.media-tile-check');
            const text = on ? String(order + 1) : '';
            if (check && check.textContent !== text) check.textContent = text;
        }
        const foot = document.getElementById('mediaSheetFoot');
        const button = foot?.querySelector('.media-sheet-attach');
        const count = st.selected.length;
        if (foot) foot.hidden = count === 0;
        if (button) {
            const text = st.busy ? 'Прикрепляем…' : `Прикрепить ${count}`;
            if (button.textContent !== text) button.textContent = text;
            button.disabled = st.busy;
        }
    }

    async attachMediaSheetSelection() {
        const st = this._mediaSheet;
        if (!st || st.busy || st.selected.length === 0) return;
        const byId = new Map(st.items.map(item => [item.id, item]));
        const items = st.selected.map(id => byId.get(id)).filter(Boolean);
        await this.attachMediaSheetItems(items);
    }

    // Оригиналы — тем же перехватом оболочки, что и превью; File уходит в общий
    // путь вложений (handleFiles), как из <input type=file>.
    async attachMediaSheetItems(items) {
        const st = this._mediaSheet;
        if (!st || st.busy || !items.length) return;
        st.busy = true;
        this.updateMediaSheetSelection();
        try {
            const files = [];
            for (const item of items) {
                const res = await fetch(String(item.full || ''));
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                const blob = await res.blob();
                const type = String(item.mime || blob.type || '');
                files.push(new File([blob], String(item.name || 'photo'), { type }));
            }
            this.closeMediaSheet();
            await this.handleFiles(files);
        } catch (e) {
            this.addLogEntry?.({ type: 'WARN', msg: `Галерея: не удалось прочитать файл (${e?.message || e})`, ts: new Date().toLocaleTimeString() });
            if (this._mediaSheet === st) {
                st.busy = false;
                this.updateMediaSheetSelection();
            }
        }
    }
});

// Сколько последних фото и видео показывать в листе — дальше «Альбомы» (системный пикер).
ZaliInterface.MEDIA_SHEET_LIMIT = 240;
ZaliInterface.MEDIA_SHEET_MAX_SELECTED = 10;
