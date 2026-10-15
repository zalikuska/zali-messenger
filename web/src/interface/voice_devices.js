// --- ZaliInterface: выбор камеры и источника демонстрации экрана. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Всё живёт в веб-слое:
// нативные шеллы (macOS WKWebView, Windows WebView2) отдают getUserMedia /
// getDisplayMedia самим движком, поэтому дублировать это в Swift/Rust/Kotlin
// не нужно. Исключение — Android, где демонстрация идёт через MediaProjection
// (системный диалог), и выбирать там нечего: туда пикер не показывается.
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
        try { return track?.getSettings?.().deviceId || ''; } catch (e) { return ''; }
    }

    async listVoiceVideoInputs() {
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
            const next = await navigator.mediaDevices.getUserMedia({
                video: { deviceId: { exact: id }, width: { ideal: 1280 }, height: { ideal: 720 } },
            });
            const track = next.getVideoTracks()[0];
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

        const startPreview = async () => {
            stopPreview();
            hint.hidden = false;
            hint.textContent = 'Запрашиваю доступ к камере…';
            try {
                const constraints = selected
                    ? { video: { deviceId: { exact: selected } } }
                    : { video: true };
                const stream = await navigator.mediaDevices.getUserMedia(constraints);
                if (!alive) { for (const t of stream.getTracks()) t.stop(); return; }
                previewStream = stream;
                video.srcObject = stream;
                video.play?.().catch(() => {});
                hint.hidden = true;
                if (!selected) selected = stream.getVideoTracks()[0]?.getSettings?.().deviceId || '';
                await refresh();
            } catch (error) {
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
            selected = row.dataset.device || '';
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

    // Что показывать и в каком качестве. Список конкретных экранов/окон рисует
    // система — веб-слой не может их перечислить, поэтому здесь выбирается
    // КАТЕГОРИЯ (подсказка системному диалогу) и качество.
    openVoiceScreenPicker() {
        if (document.getElementById('voicePickerOverlay')) return;
        const pref = this.loadVoiceDevicePref(ZaliInterface.VOICE_SCREEN_PREF_KEY);
        const categories = [
            { id: 'monitor', icon: 'screen', title: 'Весь экран', note: 'Всё, что видно на мониторе' },
            { id: 'window', icon: 'window', title: 'Окно', note: 'Одно приложение' },
        ];
        let surface = categories.some(c => c.id === pref.surface) ? pref.surface : 'monitor';
        let height = [0, 720, 1080].includes(Number(pref.height)) ? Number(pref.height) : 1080;
        let fps = [15, 30, 60].includes(Number(pref.fps)) ? Number(pref.fps) : 30;
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
                    for (const el of group.querySelectorAll('[data-v]')) {
                        const on = el === btn;
                        el.classList.toggle('is-selected', on);
                        el.setAttribute('aria-checked', String(on));
                    }
                });
            },
            onConfirm: () => {
                const choice = { surface, height, fps };
                this.saveVoiceDevicePref(ZaliInterface.VOICE_SCREEN_PREF_KEY, choice);
                void this.startScreenShare(choice);
                return true;
            },
        });
    }
});
