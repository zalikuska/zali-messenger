// --- ZaliInterface: выбор камеры и источника демонстрации экрана. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Окна выбора — в веб-слое.
// Источник кадров: на macOS/Windows — оболочка (interface/native_media.js:
// камеры и экраны/окна с превью перечисляет она), иначе getUserMedia /
// getDisplayMedia движка. Android показывает системный диалог MediaProjection,
// выбирать там нечего — туда окно экрана не показывается.
ZaliMixin(ZaliInterface, class {

    static get VOICE_CAMERA_PREF_KEY() { return 'zali_voice_camera_v1'; }
    static get VOICE_SCREEN_PREF_KEY() { return 'zali_voice_screen_v1'; }

    loadVoiceDevicePref(key) {
        try {
            const raw = localStorage.getItem(key);
            const parsed = raw ? JSON.parse(raw) : null;
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    saveVoiceDevicePref(key, value) {
        try { localStorage.setItem(key, JSON.stringify(value || {})); } catch (e) {}
    }

    // Видео-ограничение для getUserMedia с учётом выбранной камеры. `ideal`, а не
    // `exact`: отключённую камеру молча заменит системная по умолчанию, а не
    // сорвёт включение звонка OverconstrainedError'ом.
    voiceCameraConstraint() {
        const pref = this.loadVoiceDevicePref(ZaliInterface.VOICE_CAMERA_PREF_KEY);
        const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
        if (pref.deviceId) video.deviceId = { ideal: pref.deviceId };
        return video;
    }

    currentVoiceCameraId() {
        const track = this.voice.localStream?.getVideoTracks?.()[0];
        if (track?.__zaliDeviceId) return track.__zaliDeviceId;
        try { return track?.getSettings?.().deviceId || ''; } catch (e) { return ''; }
    }

    async listVoiceVideoInputs() {
        if (this.nativeCaptureAvailable?.('camera')) {
            try {
                const { videoinput } = await this.listNativeMediaDevices();
                return videoinput.map((d, i) => ({ id: String(d.id || ''), label: d.label || `Камера ${i + 1}` }));
            } catch (error) {
                this.voiceDiag?.('native-device-list-failed', { error: error?.message || String(error) }, 'WARN');
            }
        }
        if (!navigator.mediaDevices?.enumerateDevices) return [];
        let all = [];
        try { all = await navigator.mediaDevices.enumerateDevices(); } catch (e) { return []; }
        let n = 0;
        return all.filter(d => d.kind === 'videoinput').map(d => {
            n += 1;
            return { id: d.deviceId || '', label: d.label || `Камера ${n}` };
        });
    }

    // Смена камеры на лету: новый трек берём ДО остановки старого, иначе
    // неудачная смена оставила бы звонок вообще без видео.
    async switchVoiceCamera(deviceId) {
        const id = String(deviceId || '');
        this.saveVoiceDevicePref(ZaliInterface.VOICE_CAMERA_PREF_KEY, { deviceId: id });
        if (!this.voice.cameraOn || !this.voice.localStream) return;
        if (id && id === this.currentVoiceCameraId()) return;
        try {
            const track = await this.captureVoiceCameraTrack(id);
            if (!track) return;
            const stream = this.voice.localStream;
            for (const old of stream.getVideoTracks()) {
                try { old.stop(); } catch (e) {}
                try { stream.removeTrack(old); } catch (e) {}
            }
            stream.addTrack(track);
            for (const entry of this.voice.peerConnections.values()) {
                if (entry.videoSender) {
                    try { await entry.videoSender.replaceTrack(track); } catch (e) {}
                }
            }
            this.attachLocalVideoPreview();
            this.voiceTrace('camera-switched', { deviceId: id, label: track.label || '' });
            this.renderVoicePanel();
        } catch (error) {
            this.voiceTrace('camera-switch-failed', { error: error?.message || String(error) }, 'WARN');
            this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось переключить камеру', ts: new Date().toLocaleTimeString() });
        }
    }

    // Кнопка «Камера»: с сохранённым выбором включает сразу, без — открывает пикер.
    async onVoiceCameraButton() {
        if (this.voice.cameraOn) {
            await this.setVoiceCameraEnabled(false);
            return;
        }
        const pref = this.loadVoiceDevicePref(ZaliInterface.VOICE_CAMERA_PREF_KEY);
        if (pref.deviceId) {
            await this.setVoiceCameraEnabled(true);
            return;
        }
        await this.openVoiceCameraPicker();
    }

    closeVoicePicker() {
        const overlay = document.getElementById('voicePickerOverlay');
        if (!overlay) return;
        try { overlay._cleanup?.(); } catch (e) {}
        overlay.remove();
    }

    mountVoicePicker({ title, bodyHtml, confirmLabel, onConfirm, onMount }) {
        this.closeVoicePicker();
        const overlay = document.createElement('div');
        overlay.id = 'voicePickerOverlay';
        overlay.className = 'voice-picker-overlay';
        overlay.innerHTML = `
            <div class="voice-picker" role="dialog" aria-modal="true" aria-label="${this.esc(title)}">
                <div class="voice-picker-head">
                    <div class="voice-picker-title">${this.esc(title)}</div>
                    <button type="button" class="voice-picker-close" id="voicePickerClose" aria-label="Закрыть">
                        <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
                    </button>
                </div>
                <div class="voice-picker-body">${bodyHtml}</div>
                <div class="voice-picker-actions">
                    <button type="button" class="voice-picker-btn" id="voicePickerCancel">Отмена</button>
                    <button type="button" class="voice-picker-btn is-primary" id="voicePickerConfirm">${this.esc(confirmLabel)}</button>
                </div>
            </div>`;
        document.body.appendChild(overlay);
        const close = () => this.closeVoicePicker();
        const onKey = (e) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        overlay._cleanup = () => document.removeEventListener('keydown', onKey);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        overlay.querySelector('#voicePickerCancel').addEventListener('click', close);
        overlay.querySelector('#voicePickerClose').addEventListener('click', close);
        const confirm = overlay.querySelector('#voicePickerConfirm');
        confirm.addEventListener('click', () => {
            const result = onConfirm?.(overlay);
            if (result !== false) close();
        });
        onMount?.(overlay, confirm);
        return overlay;
    }

    async openVoiceCameraPicker() {
        if (document.getElementById('voicePickerOverlay')) return;
        const cameraOn = !!this.voice.cameraOn;
        const pref = this.loadVoiceDevicePref(ZaliInterface.VOICE_CAMERA_PREF_KEY);
        let selected = (cameraOn && this.currentVoiceCameraId()) || pref.deviceId || '';
        let previewStream = null;
        let alive = true;
        const stopPreview = () => {
            if (previewStream) {
                for (const t of previewStream.getTracks()) { try { t.stop(); } catch (e) {} }
                previewStream = null;
            }
        };

        const overlay = this.mountVoicePicker({
            title: 'Камера',
            confirmLabel: cameraOn ? 'Переключить' : 'Включить камеру',
            bodyHtml: `
                <div class="voice-picker-preview"><video id="voicePickerVideo" autoplay playsinline muted></video><span class="voice-picker-hint" id="voicePickerHint">Запрашиваю доступ к камере…</span></div>
                <div class="voice-picker-list" id="voicePickerList" role="radiogroup" aria-label="Камеры"></div>`,
            onConfirm: () => {
                const id = selected;
                alive = false;
                stopPreview();
                if (cameraOn) {
                    void this.switchVoiceCamera(id);
                } else {
                    this.saveVoiceDevicePref(ZaliInterface.VOICE_CAMERA_PREF_KEY, { deviceId: id });
                    void this.setVoiceCameraEnabled(true);
                }
                return true;
            },
        });
        const hint = overlay.querySelector('#voicePickerHint');
        const video = overlay.querySelector('#voicePickerVideo');
        const list = overlay.querySelector('#voicePickerList');
        const confirm = overlay.querySelector('#voicePickerConfirm');
        const prevCleanup = overlay._cleanup;
        overlay._cleanup = () => { alive = false; stopPreview(); try { navigator.mediaDevices?.removeEventListener?.('devicechange', refresh); } catch (e) {} prevCleanup?.(); };

        // Каждый запуск получает номер: при быстром переключении камер ответ
        // getUserMedia приходит в произвольном порядке, и без этой проверки
        // «опоздавший» поток перезаписывал актуальный (превью показывало не ту
        // камеру), а перезаписанный так и оставался включённым — лампочка камеры
        // горела после закрытия окна.
        let previewSeq = 0;
        let listBuilt = false;
        const startPreview = async () => {
            const seq = ++previewSeq;
            // Прежний кадр остаётся на экране, пока не открыта новая камера: раньше
            // поток гасился заранее, и превью мигало чёрным с подсказкой «Запрашиваю…»
            // на каждое переключение. Подсказка нужна только когда показывать нечего.
            if (!previewStream) {
                hint.hidden = false;
                hint.textContent = 'Запрашиваю доступ к камере…';
            }
            try {
                let stream;
                if (this.nativeCaptureAvailable?.('camera')) {
                    // Превью из оболочки; тот же поток камеры она делит между превью и
                    // звонком, так что открыть его при включённой камере безопасно.
                    stream = await this.openNativeMediaStream({ kind: 'camera', deviceId: selected, defaultIfUnknown: true, options: { width: 640, height: 360, fps: 30 } });
                    // Неизвестный оболочке id заменён камерой по умолчанию — выбрана она.
                    if (stream.__zaliDeviceId) selected = stream.__zaliDeviceId;
                } else {
                    const constraints = selected
                        ? { video: { deviceId: { exact: selected } } }
                        : { video: true };
                    stream = await navigator.mediaDevices.getUserMedia(constraints);
                }
                if (!alive || seq !== previewSeq) { for (const t of stream.getTracks()) t.stop(); return; }
                const previous = previewStream;
                previewStream = stream;
                video.srcObject = stream;
                video.play?.().catch(() => {});
                hint.hidden = true;
                if (previous) for (const t of previous.getTracks()) { try { t.stop(); } catch (e) {} }
                if (!selected) selected = stream.getVideoTracks()[0]?.getSettings?.().deviceId || '';
                // Подписи камер становятся доступны только после разрешения; список
                // строится один раз, а не перерисовывается на каждое переключение
                // (иначе строки мигали и терялся hover/фокус).
                if (!listBuilt) { listBuilt = true; await refresh(); }
            } catch (error) {
                if (!alive || seq !== previewSeq) return;
                stopPreview();
                video.srcObject = null;
                hint.hidden = false;
                hint.textContent = error?.name === 'NotAllowedError'
                    ? 'Доступ к камере запрещён. Разрешите его в настройках системы или сайта.'
                    : 'Не удалось открыть камеру';
            }
        };

        const refresh = async () => {
            if (!alive) return;
            const devices = await this.listVoiceVideoInputs();
            if (!alive) return;
            if (!devices.length) {
                list.innerHTML = '<div class="voice-picker-empty">Камеры не найдены</div>';
                confirm.disabled = true;
                return;
            }
            confirm.disabled = false;
            if (!selected || !devices.some(d => d.id === selected)) selected = devices[0].id;
            list.innerHTML = devices.map(d => `
                <button type="button" class="voice-picker-row${d.id === selected ? ' is-selected' : ''}" role="radio" aria-checked="${this.esc(String(d.id === selected))}" data-device="${this.esc(d.id)}">
                    <span class="voice-picker-radio" aria-hidden="true"></span>
                    <span class="voice-picker-row-label">${this.esc(d.label)}</span>
                </button>`).join('');
        };

        list.addEventListener('click', (e) => {
            const row = e.target.closest('.voice-picker-row');
            if (!row) return;
            const picked = row.dataset.device || '';
            if (picked === selected && previewStream) return;
            selected = picked;
            for (const el of list.querySelectorAll('.voice-picker-row')) {
                const on = el === row;
                el.classList.toggle('is-selected', on);
                el.setAttribute('aria-checked', String(on));
            }
            void startPreview();
        });
        try { navigator.mediaDevices?.addEventListener?.('devicechange', refresh); } catch (e) {}
        await startPreview();
    }

    // Окно выбора для захвата в оболочке: экраны и окна перечисляет она
    // (ScreenCaptureKit / Windows.Graphics.Capture) вместе с превью, выбор — здесь, в
    // языке «Фокуса» (docs/UI_GUIDELINES.md): плитки на surface, выбор кольцом через
    // зазор, одна главная кнопка. Превью обновляются раз в 2 с, пока окно открыто;
    // плитки не перерисовываются целиком — меняется только картинка (без мигания).
    openNativeScreenPicker() {
        const pref = this.loadVoiceDevicePref(ZaliInterface.VOICE_SCREEN_PREF_KEY);
        let tab = pref.sourceKind === 'window' ? 'window' : 'display';
        let height = [0, 720, 1080].includes(Number(pref.height)) ? Number(pref.height) : 1080;
        let fps = [15, 30, 60].includes(Number(pref.fps)) ? Number(pref.fps) : 30;
        const audioSupported = this.nativeSupports('nativeScreenAudio');
        let audio = audioSupported && !(pref.audio === 0 || pref.audio === false);
        let selectedId = '';
        let sources = [];
        let loadError = null;
        let alive = true;
        let timer = null;
        const seg = (name, items, current) => `<div class="voice-picker-seg" data-seg="${this.esc(name)}" role="radiogroup">${items.map(it => `<button type="button" role="radio" class="voice-picker-seg-btn${it.v === current ? ' is-selected' : ''}" aria-checked="${this.esc(String(it.v === current))}" data-v="${this.esc(String(it.v))}">${this.esc(it.l)}</button>`).join('')}</div>`;
        const overlay = this.mountVoicePicker({
            title: 'Что показать',
            confirmLabel: 'Показать',
            bodyHtml: `
                ${seg('tab', [{ v: 'display', l: 'Экраны' }, { v: 'window', l: 'Окна' }], tab)}
                <div class="voice-src-grid" id="voiceSrcGrid" role="radiogroup" aria-label="Источник"></div>
                <div class="voice-picker-field"><span class="voice-picker-label">Разрешение</span>${seg('height', [{ v: 720, l: '720p' }, { v: 1080, l: '1080p' }, { v: 0, l: 'Оригинал' }], height)}</div>
                <div class="voice-picker-field"><span class="voice-picker-label">Частота кадров</span>${seg('fps', [{ v: 15, l: '15' }, { v: 30, l: '30' }, { v: 60, l: '60' }], fps)}</div>
                ${audioSupported ? `<div class="voice-picker-field"><span class="voice-picker-label">Звук</span>${seg('audio', [{ v: 1, l: 'Передавать' }, { v: 0, l: 'Без звука' }], audio ? 1 : 0)}</div>` : ''}`,
            onMount: (ov, confirm) => {
                ov.querySelector('.voice-picker')?.classList.add('voice-picker--wide');
                confirm.disabled = true;
                ov.addEventListener('click', (e) => {
                    const tile = e.target.closest('.voice-src-tile');
                    if (tile) {
                        selectedId = tile.dataset.id || '';
                        syncSelection();
                        return;
                    }
                    const btn = e.target.closest('[data-v]');
                    const group = btn?.closest('[data-seg]');
                    if (!btn || !group) return;
                    const name = group.dataset.seg;
                    const value = btn.dataset.v;
                    if (name === 'tab') { tab = value; selectedId = ''; render(); }
                    else if (name === 'height') height = Number(value);
                    else if (name === 'fps') fps = Number(value);
                    else if (name === 'audio') audio = Number(value) === 1;
                    for (const el of group.querySelectorAll('[data-v]')) {
                        const on = el === btn;
                        el.classList.toggle('is-selected', on);
                        el.setAttribute('aria-checked', String(on));
                    }
                });
                ov.addEventListener('dblclick', (e) => {
                    if (e.target.closest('.voice-src-tile') && selectedId) confirm.click();
                });
            },
            onConfirm: () => {
                if (!selectedId) return false;
                alive = false;
                clearTimeout(timer);
                this.saveVoiceDevicePref(ZaliInterface.VOICE_SCREEN_PREF_KEY, { sourceKind: tab, height, fps, audio: audio ? 1 : 0 });
                // own — окно самого мессенджера: звук для него собирает страница
                // (interface/share_audio.js), оболочка звук не снимает.
                const own = !!sources.find(s => s.id === selectedId)?.own;
                void this.startScreenShare({ sourceId: selectedId, sourceKind: tab, own, height, fps, audio: audio ? 1 : 0 });
                return true;
            },
        });
        const grid = overlay.querySelector('#voiceSrcGrid');
        const confirm = overlay.querySelector('#voicePickerConfirm');
        const prevCleanup = overlay._cleanup;
        overlay._cleanup = () => { alive = false; clearTimeout(timer); prevCleanup?.(); };

        const syncSelection = () => {
            for (const el of grid.querySelectorAll('.voice-src-tile')) {
                const on = el.dataset.id === selectedId;
                el.classList.toggle('is-selected', on);
                el.setAttribute('aria-checked', String(on));
            }
            confirm.disabled = !selectedId;
        };
        const emptyRow = (sign, text) => {
            const row = document.createElement('div');
            row.className = 'voice-src-empty';
            row.innerHTML = `<span class="voice-src-empty-sign">${this.zaliSign(sign)}</span>`;
            const label = document.createElement('span');
            label.textContent = text;
            row.appendChild(label);
            return row;
        };
        const render = () => {
            const list = sources.filter(src => (src.kind === 'window' ? 'window' : 'display') === tab);
            if (selectedId && !list.some(src => String(src.id) === selectedId)) selectedId = '';
            if (!selectedId && tab === 'display' && list.length) selectedId = String(list[0].id);
            if (loadError || !list.length) {
                grid.replaceChildren();
                if (loadError?.code === 'permission') {
                    grid.appendChild(emptyRow('display', 'Нет доступа к записи экрана. Разрешите его приложению в настройках системы и откройте окно ещё раз.'));
                } else if (loadError) {
                    grid.appendChild(emptyRow('display', 'Не удалось получить список экранов и окон'));
                } else if (sources.length) {
                    grid.appendChild(emptyRow(tab === 'window' ? 'window' : 'display', tab === 'window' ? 'Открытых окон нет' : 'Экраны не найдены'));
                }
                syncSelection();
                return;
            }
            // Плитки по id: существующие обновляются на месте, лишние уходят, новые
            // добавляются в порядке списка.
            const existing = new Map(Array.from(grid.querySelectorAll('.voice-src-tile')).map(el => [el.dataset.id, el]));
            for (const node of Array.from(grid.children)) if (!node.classList.contains('voice-src-tile')) node.remove();
            let prev = null;
            for (const src of list) {
                const id = String(src.id);
                let tile = existing.get(id);
                existing.delete(id);
                if (!tile) {
                    tile = document.createElement('button');
                    tile.type = 'button';
                    tile.className = 'voice-src-tile';
                    tile.setAttribute('role', 'radio');
                    tile.dataset.id = id;
                    tile.innerHTML = `<span class="voice-src-thumb"><img alt="" draggable="false"></span><span class="voice-src-title"></span><span class="voice-src-meta"></span>`;
                }
                const title = src.title || (src.kind === 'window' ? 'Окно' : 'Экран');
                const meta = [src.kind === 'window' ? (src.app || '') : '', src.width && src.height ? `${src.width}×${src.height}` : ''].filter(Boolean).join(' · ');
                const titleEl = tile.querySelector('.voice-src-title');
                const metaEl = tile.querySelector('.voice-src-meta');
                if (titleEl.textContent !== title) titleEl.textContent = title;
                if (metaEl.textContent !== meta) metaEl.textContent = meta;
                tile.setAttribute('aria-label', meta ? `${title}, ${meta}` : title);
                const img = tile.querySelector('img');
                const thumb = typeof src.thumb === 'string' && /^data:image\/(jpeg|png);base64,/.test(src.thumb) ? src.thumb : '';
                if (thumb && img.getAttribute('src') !== thumb) img.src = thumb;
                img.hidden = !thumb;
                const expected = prev ? prev.nextSibling : grid.firstChild;
                if (tile !== expected) grid.insertBefore(tile, expected);
                prev = tile;
            }
            for (const stale of existing.values()) stale.remove();
            syncSelection();
        };
        const load = async () => {
            try {
                sources = await this.listNativeScreenSources({ thumbWidth: 360 });
                loadError = null;
            } catch (error) {
                loadError = { code: error?.code || '', message: error?.message || String(error) };
                this.voiceDiag?.('native-screen-sources-failed', loadError, 'WARN');
            }
            if (!alive) return;
            render();
            // Живые превью, но не чаще раза в 5 с и не в скрытом окне: каждое
            // обновление — снимок КАЖДОГО экрана и окна в оболочке, JPEG и base64 через
            // мост; раз в 2 с при 30 окнах это заметно грузило процессор посреди звонка.
            if (loadError?.code !== 'permission') timer = setTimeout(load, document.hidden ? 15000 : 5000);
        };
        void load();
    }

    // Что показывать и в каком качестве. Список конкретных экранов/окон рисует
    // система — веб-слой не может их перечислить, поэтому здесь выбирается
    // КАТЕГОРИЯ (подсказка системному диалогу) и качество.
    openVoiceScreenPicker() {
        if (document.getElementById('voicePickerOverlay')) return;
        if (this.nativeCaptureAvailable?.('screen')) {
            this.openNativeScreenPicker();
            return;
        }
        const pref = this.loadVoiceDevicePref(ZaliInterface.VOICE_SCREEN_PREF_KEY);
        const categories = [
            { id: 'monitor', icon: 'screen', title: 'Весь экран', note: 'Всё, что видно на мониторе' },
            { id: 'window', icon: 'window', title: 'Окно', note: 'Одно приложение' },
        ];
        let surface = categories.some(c => c.id === pref.surface) ? pref.surface : 'monitor';
        let height = [0, 720, 1080].includes(Number(pref.height)) ? Number(pref.height) : 1080;
        let fps = [15, 30, 60].includes(Number(pref.fps)) ? Number(pref.fps) : 30;
        // Звук демонстрации: по умолчанию включён. В Windows отдаётся звук всей
        // системы (или вкладки); где платформа не умеет — картинка идёт без звука.
        let audio = !(pref.audio === 0 || pref.audio === false);
        const seg = (name, items, current) => `<div class="voice-picker-seg" data-seg="${this.esc(name)}" role="radiogroup">${items.map(it => `<button type="button" role="radio" class="voice-picker-seg-btn${it.v === current ? ' is-selected' : ''}" aria-checked="${this.esc(String(it.v === current))}" data-v="${this.esc(String(it.v))}">${this.esc(it.l)}</button>`).join('')}</div>`;
        this.mountVoicePicker({
            title: 'Что показать',
            confirmLabel: 'Выбрать источник',
            bodyHtml: `
                <div class="voice-picker-cats" data-seg="surface" role="radiogroup" aria-label="Категория">
                    ${categories.map(c => `
                        <button type="button" role="radio" class="voice-picker-cat${c.id === surface ? ' is-selected' : ''}" aria-checked="${this.esc(String(c.id === surface))}" data-v="${this.esc(c.id)}">
                            <span class="voice-picker-cat-icon">${this.voiceIcon(c.icon)}</span>
                            <span class="voice-picker-cat-title">${this.esc(c.title)}</span>
                            <span class="voice-picker-cat-note">${this.esc(c.note)}</span>
                        </button>`).join('')}
                </div>
                <div class="voice-picker-field"><span class="voice-picker-label">Разрешение</span>${seg('height', [{ v: 720, l: '720p' }, { v: 1080, l: '1080p' }, { v: 0, l: 'Оригинал' }], height)}</div>
                <div class="voice-picker-field"><span class="voice-picker-label">Частота кадров</span>${seg('fps', [{ v: 15, l: '15' }, { v: 30, l: '30' }, { v: 60, l: '60' }], fps)}</div>
                <div class="voice-picker-field"><span class="voice-picker-label">Звук</span>${seg('audio', [{ v: 1, l: 'Передавать' }, { v: 0, l: 'Без звука' }], audio ? 1 : 0)}</div>
                <div class="voice-picker-note">Конкретный экран или окно вы выберете в следующем системном окне.</div>`,
            onMount: (overlay) => {
                overlay.addEventListener('click', (e) => {
                    const btn = e.target.closest('[data-v]');
                    if (!btn) return;
                    const group = btn.closest('[data-seg]');
                    if (!group) return;
                    const name = group.dataset.seg;
                    const value = btn.dataset.v;
                    if (name === 'surface') surface = value;
                    else if (name === 'height') height = Number(value);
                    else if (name === 'fps') fps = Number(value);
                    else if (name === 'audio') audio = Number(value) === 1;
                    for (const el of group.querySelectorAll('[data-v]')) {
                        const on = el === btn;
                        el.classList.toggle('is-selected', on);
                        el.setAttribute('aria-checked', String(on));
                    }
                });
            },
            onConfirm: () => {
                const choice = { surface, height, fps, audio: audio ? 1 : 0 };
                this.saveVoiceDevicePref(ZaliInterface.VOICE_SCREEN_PREF_KEY, choice);
                void this.startScreenShare(choice);
                return true;
            },
        });
    }
});
