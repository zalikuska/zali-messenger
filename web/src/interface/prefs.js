// --- ZaliInterface: Пользовательские настройки: тема, звук, устройства ввода/вывода, сегменты хаба. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    navModeStorageKey() {
        return 'zali_nav_mode_v1';
    }

    uiV2EnabledStorageKey() {
        return 'zali_ui_v2_enabled_v1';
    }

    uiV2SegmentsStorageKey() {
        return 'zali_ui_v2_segments_v1';
    }

    experimentalDesignStorageKey() {
        return 'zali_experimental_design_v1';
    }

    // ============================================================
    // DESIGN MODE — оформление интерфейса целиком: classic | flat | focus.
    //
    // Раньше это был одиночный чекбокс «плоский режим»
    // (`zali_experimental_design_v1`, атрибут `data-experimental-design`).
    // Режимов стало три, и они взаимоисключающие, поэтому источник правды —
    // `zali_design_mode_v1`, а старый ключ остаётся ЗЕРКАЛОМ: его продолжают
    // читать CSS-правила плоской темы (`body[data-experimental-design="on"]`,
    // ~66 селекторов) и старые сборки нативных шеллов, у которых в
    // localStorage уже лежит выбор пользователя. Поэтому saveDesignMode()
    // пишет оба ключа, а loadDesignMode() умеет поднять старый выбор.
    // ============================================================

    designModeStorageKey() {
        return 'zali_design_mode_v1';
    }

    designModeCatalog() {
        // Порядок = порядок в настройках: сначала «Фокус» (он же по умолчанию) и его
        // вариант со свечением, затем прежние оформления.
        return [
            // «Фокус» — не очередная перекраска, а другая иерархия: акцент
            // остаётся только у «моего» (исходящие, мой аватар), «нового»
            // (непрочитанное) и главного действия (отправить), служебное
            // прячется до наведения или до проблемы. Слой CSS — в конце
            // web/style.css, раздел «DESIGN MODE: FOCUS».
            { id: 'focus', label: 'Фокус', note: 'По умолчанию', hint: 'Спокойные поверхности и ясная иерархия: акцент только там, где он что-то значит.' },
            // Тот же «Фокус» (вся иерархия и поверхности общие) плюс мягкое свечение:
            // ореол вокруг сплошных акцентов и рассеянный свет на фоне. Технически —
            // data-design-mode="focus" с добавкой data-design-glow="on", поэтому
            // каждое правило «Фокуса» работает и здесь без копий; слой свечения — в
            // конце web/style.css, раздел «DESIGN MODE: FOCUS GLOW».
            { id: 'focus-glow', label: 'Фокус со свечением', note: '', hint: 'Тот же «Фокус», но акценты светятся мягким ореолом, а фон — рассеянным светом.' },
            { id: 'classic', label: 'Классический', note: '', hint: 'Исходное оформление: градиенты, свечения, стеклянные панели.' },
            { id: 'flat', label: 'Плоский', note: '', hint: 'Тот же интерфейс без градиентов и свечений — матовые поверхности.' },
        ];
    }

    // Оформление по умолчанию — «Фокус». Меняется только здесь: им пользуется всё,
    // что не нашло выбора пользователя (нет ключа, мусор в ключе, нет localStorage).
    // Тот, кто выбирал сам, остаётся на своём: выбор лежит в `zali_design_mode_v1`.
    defaultDesignMode() {
        return 'focus';
    }

    normalizeDesignMode(value) {
        const id = String(value || '').trim().toLowerCase();
        return this.designModeCatalog().some(m => m.id === id) ? id : this.defaultDesignMode();
    }

    loadDesignMode() {
        try {
            const stored = localStorage.getItem(this.designModeStorageKey());
            if (stored) return this.normalizeDesignMode(stored);
            // Миграция с одиночного чекбокса «плоский режим»: он хранил явный выбор
            // — '1' это 'flat', '0' — возврат на классический. Нет ключа вовсе —
            // выбора не было, действует оформление по умолчанию.
            const legacy = localStorage.getItem(this.experimentalDesignStorageKey());
            if (legacy === '1') return 'flat';
            if (legacy === '0') return 'classic';
            return this.defaultDesignMode();
        } catch (e) {
            return this.defaultDesignMode();
        }
    }

    saveDesignMode(mode) {
        this.designMode = this.normalizeDesignMode(mode);
        this.experimentalDesign = this.designMode === 'flat';
        try {
            localStorage.setItem(this.designModeStorageKey(), this.designMode);
            localStorage.setItem(this.experimentalDesignStorageKey(), this.experimentalDesign ? '1' : '0');
        } catch (e) {}
        this.applyDesignMode();
    }

    applyDesignMode() {
        this.designMode = this.normalizeDesignMode(this.designMode || this.loadDesignMode());
        this.experimentalDesign = this.designMode === 'flat';
        const body = document.body;
        if (body) {
            // «Фокус со свечением» — это «Фокус» + флаг свечения, а не отдельная
            // ветка CSS: так не копируются сотни правил.
            const glow = this.designMode === 'focus-glow';
            body.setAttribute('data-design-mode', glow ? 'focus' : this.designMode);
            body.setAttribute('data-design-glow', glow ? 'on' : 'off');
            body.setAttribute('data-experimental-design', this.experimentalDesign ? 'on' : 'off');
        }
        // Легаси-чекбокс мог остаться в чужой сборке HTML — держим его в курсе.
        const legacyToggle = document.getElementById('inputExperimentalDesign');
        if (legacyToggle) legacyToggle.checked = !!this.experimentalDesign;
        // Высоту поля ввода resizeComposer() пишет инлайном по scrollHeight,
        // а отступы поля у режимов разные: при старте он отрабатывает раньше
        // applyDesignMode(), и без пересчёта поле оставалось на 3px ниже
        // своего содержимого — с полосой прокрутки внутри.
        this.resizeComposer?.();
        this.renderDesignModeSettings();
    }

    renderDesignModeSettings() {
        const host = document.getElementById('designModeOptions');
        if (!host) return;
        const active = this.normalizeDesignMode(this.designMode);
        const html = this.designModeCatalog().map(mode => `
            <button type="button" class="design-mode-option${mode.id === active ? ' active' : ''}" data-design-mode="${this.esc(mode.id)}" aria-pressed="${mode.id === active}">
                <span class="design-mode-preview design-mode-preview--${this.esc(mode.id)}" aria-hidden="true">
                    <span class="design-mode-preview-bar"></span>
                    <span class="design-mode-preview-row"></span>
                    <span class="design-mode-preview-row design-mode-preview-row--accent"></span>
                </span>
                <span class="design-mode-copy">
                    <strong>${this.esc(mode.label)}</strong>
                    <small>${this.esc(mode.hint)}</small>
                </span>
                <span class="design-mode-note">${this.esc(mode.note)}</span>
            </button>
        `).join('');
        if (host.innerHTML !== html) host.innerHTML = html;
    }

    // Обратная совместимость: старый API продолжает работать, но теперь это
    // просто «переключить между classic и flat» поверх designMode.
    loadExperimentalDesign() {
        return this.loadDesignMode() === 'flat';
    }

    saveExperimentalDesign(enabled) {
        this.saveDesignMode(enabled ? 'flat' : 'classic');
    }

    applyExperimentalDesign() {
        this.applyDesignMode();
    }

    voiceTraceStorageKey() {
        return 'zali_voice_trace_enabled_v1';
    }

    loadVoiceTraceEnabled() {
        try {
            return localStorage.getItem(this.voiceTraceStorageKey()) === '1';
        } catch (e) {
            return false;
        }
    }

    saveVoiceTraceEnabled(enabled) {
        this.voiceTraceEnabled = !!enabled;
        try {
            localStorage.setItem(this.voiceTraceStorageKey(), this.voiceTraceEnabled ? '1' : '0');
        } catch (e) {}
        this.applyVoiceTraceEnabled();
    }

    applyVoiceTraceEnabled() {
        const toggle = document.getElementById('inputVoiceTrace');
        if (toggle) toggle.checked = !!this.voiceTraceEnabled;
        if (!this.voiceTraceEnabled && this.voice) {
            this.voice.traceLines = [];
        }
        if (typeof this.renderVoicePanel === 'function') {
            this.renderVoicePanel();
        }
    }

    // ============================================================
    // AUDIO DEVICE + VOLUME PREFERENCES — mic/speaker selection and playback
    // volume (master + per-contact). Device/volume choices persist across
    // sessions in localStorage; the actual WebAudio gain nodes they drive
    // live on this.voice and only exist while a call is active.
    // ============================================================

    audioPrefsStorageKey() {
        return 'zali_audio_prefs_v1';
    }

    loadAudioPrefs() {
        const fallback = { micDeviceId: '', speakerDeviceId: '', masterVolumePercent: 100, notificationVolumePercent: 100, peerVolumePercents: {} };
        try {
            const raw = localStorage.getItem(this.audioPrefsStorageKey());
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return {
                micDeviceId: String(parsed?.micDeviceId || ''),
                speakerDeviceId: String(parsed?.speakerDeviceId || ''),
                masterVolumePercent: Number.isFinite(parsed?.masterVolumePercent) ? Math.max(0, Math.min(200, parsed.masterVolumePercent)) : 100,
                // Отдельная от masterVolumePercent громкость: та живёт на графе
                // звонка (remote <audio>.volume), эта — на synth-графе звука
                // уведомлений (soundBus). Один и тот же процент на оба означал
                // бы, что звонок и звук нового сообщения нельзя развести.
                notificationVolumePercent: Number.isFinite(parsed?.notificationVolumePercent) ? Math.max(0, Math.min(200, parsed.notificationVolumePercent)) : 100,
                peerVolumePercents: (parsed?.peerVolumePercents && typeof parsed.peerVolumePercents === 'object') ? parsed.peerVolumePercents : {},
            };
        } catch (e) {
            return fallback;
        }
    }

    saveAudioPrefs() {
        try {
            localStorage.setItem(this.audioPrefsStorageKey(), JSON.stringify(this.audioPrefs));
        } catch (e) {}
    }

    getPeerVolumePercent(peer) {
        const name = String(peer || '').trim();
        if (!name) return 100;
        const value = this.audioPrefs?.peerVolumePercents?.[name];
        return Number.isFinite(value) ? Math.max(0, Math.min(200, value)) : 100;
    }

    setPeerVolumePercent(peer, percent) {
        const name = String(peer || '').trim();
        if (!name) return;
        const clamped = Math.max(0, Math.min(200, Math.round(Number(percent) || 0)));
        this.audioPrefs.peerVolumePercents[name] = clamped;
        this.saveAudioPrefs();
        this.applyPeerVolume(name);
    }

    setMasterVolumePercent(percent) {
        const clamped = Math.max(0, Math.min(200, Math.round(Number(percent) || 0)));
        this.audioPrefs.masterVolumePercent = clamped;
        this.saveAudioPrefs();
        this.applyMasterVolume();
        const label = document.getElementById('masterVolumeValue');
        if (label) label.textContent = `${clamped}%`;
    }

    notificationVolumeFactor() {
        const percent = Number.isFinite(this.audioPrefs?.notificationVolumePercent) ? this.audioPrefs.notificationVolumePercent : 100;
        return Math.max(0, Math.min(2, percent / 100));
    }

    setNotificationVolumePercent(percent) {
        const clamped = Math.max(0, Math.min(200, Math.round(Number(percent) || 0)));
        this.audioPrefs.notificationVolumePercent = clamped;
        this.saveAudioPrefs();
        this.applyNotificationVolume();
        const label = document.getElementById('notificationVolumeValue');
        if (label) label.textContent = `${clamped}%`;
    }

    // soundBus() кеширует узел master на этом графе, поэтому смена настройки
    // между двумя звуками не пересоздаёт граф — она обязана дотянуться до
    // уже существующего gain-узла и переставить его прямо во время игры.
    applyNotificationVolume() {
        const bus = this.sound?.bus;
        // Прямое присваивание, а не setValueAtTime(..., ctx.currentTime): это
        // не звуковая автоматизация внутри ноты (там нужна точность до сэмпла
        // при currentTime), а мгновенная реакция на слайдер настроек — и на
        // движке, где currentTime не продвигается, пока рендер-граф не
        // "тикнул", запланированное на "сейчас" значение молча не подхватится.
        if (bus?.master) bus.master.gain.value = 0.9 * this.notificationVolumeFactor();
    }

    // Both sliders end up as one element volume. HTMLMediaElement.volume saturates
    // at 1.0, so the >100 % half can no longer boost — only the WebAudio graph could
    // do that, and that graph was the single unfallback-able playback path. Being
    // audible beats a boost that depended on it.
    effectiveRemoteVolume(peer) {
        const peerPercent = this.getPeerVolumePercent(peer);
        const masterPercent = this.audioPrefs.masterVolumePercent || 100;
        return Math.max(0, Math.min(1, (peerPercent / 100) * (masterPercent / 100)));
    }

    applyMasterVolume() {
        for (const peer of this.voice.remoteAudios.keys()) this.applyPeerVolume(peer);
    }

    applyPeerVolume(peer) {
        const name = String(peer || '').trim();
        const audio = this.voice.remoteAudios.get(name);
        if (audio) audio.volume = this.effectiveRemoteVolume(name);
    }

    async refreshAudioDeviceOptions() {
        const micSelect = document.getElementById('inputAudioMic');
        const speakerSelect = document.getElementById('inputAudioSpeaker');
        if (!micSelect && !speakerSelect) return;
        if (!navigator.mediaDevices?.enumerateDevices) return;
        try {
            // Device labels are only populated after a getUserMedia grant; until
            // then they just show as "Микрофон N" / "Динамики N" placeholders.
            const devices = await navigator.mediaDevices.enumerateDevices();
            const mics = devices.filter(d => d.kind === 'audioinput');
            const speakers = devices.filter(d => d.kind === 'audiooutput');
            if (micSelect) {
                const current = this.audioPrefs.micDeviceId;
                micSelect.innerHTML = ['<option value="">Системный микрофон по умолчанию</option>']
                    .concat(mics.map((d, i) => `<option value="${this.esc(d.deviceId)}">${this.esc(d.label || `Микрофон ${i + 1}`)}</option>`))
                    .join('');
                micSelect.value = mics.some(d => d.deviceId === current) ? current : '';
            }
            if (speakerSelect) {
                const current = this.audioPrefs.speakerDeviceId;
                const supported = typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
                speakerSelect.disabled = !supported;
                speakerSelect.innerHTML = ['<option value="">Системные динамики по умолчанию</option>']
                    .concat(speakers.map((d, i) => `<option value="${this.esc(d.deviceId)}">${this.esc(d.label || `Динамики ${i + 1}`)}</option>`))
                    .join('');
                speakerSelect.value = speakers.some(d => d.deviceId === current) ? current : '';
            }
        } catch (error) {
            this.voiceTrace?.('device-enumerate-failed', { error: error?.message || String(error) }, 'WARN');
        }
    }

    renderAudioDeviceSettings() {
        const volumeInput = document.getElementById('inputMasterVolume');
        if (volumeInput) volumeInput.value = String(this.audioPrefs.masterVolumePercent);
        const volumeLabel = document.getElementById('masterVolumeValue');
        if (volumeLabel) volumeLabel.textContent = `${this.audioPrefs.masterVolumePercent}%`;
        this.refreshAudioDeviceOptions();
    }

    renderNotificationVolumeSettings() {
        const volumeInput = document.getElementById('inputNotificationVolume');
        if (volumeInput) volumeInput.value = String(this.audioPrefs.notificationVolumePercent);
        const volumeLabel = document.getElementById('notificationVolumeValue');
        if (volumeLabel) volumeLabel.textContent = `${this.audioPrefs.notificationVolumePercent}%`;
    }

    // ============================================================
    // Карточка «Автозапуск» (только Windows, capability `autostart`): запуск
    // свёрнутым в трей при входе в систему. Истина лежит в реестре, а не здесь:
    // автозапуск переключают ещё Диспетчер задач и установщик, поэтому при
    // каждом открытии настроек состояние спрашивается у оболочки
    // (apps/windows/src/native/autostart.rs).
    // ============================================================

    autostartSupported() {
        return this.hasNativeBridge() && this.nativeSupports('autostart');
    }

    async renderAutostartSettings() {
        const card = document.getElementById('autostartSettingsCard');
        if (!card) return;
        const supported = this.autostartSupported();
        card.hidden = !supported;
        if (!supported) return;
        this.applyAutostartStatus();
        if (this._autostartBusy) return;
        try {
            const res = await this.requestNativeAction({ type: NativeMessageTypes.AUTOSTART_REQUEST }, 5000);
            this._autostartStatus = res?.data || null;
            this._autostartError = '';
        } catch (error) {
            this._autostartError = error?.message || String(error);
        }
        this.applyAutostartStatus();
    }

    applyAutostartStatus() {
        const input = document.getElementById('inputAutostart');
        const text = document.getElementById('autostartStatusText');
        const status = this._autostartStatus;
        if (input) {
            input.checked = !!status?.enabled;
            input.disabled = !!this._autostartBusy || !status;
        }
        if (!text) return;
        if (this._autostartError) {
            text.textContent = `Автозапуск недоступен: ${this._autostartError}`;
        } else if (!status) {
            text.textContent = 'Проверяем…';
        } else if (status.blockedBySystem) {
            text.textContent = 'Автозапуск выключен в Диспетчере задач (вкладка «Автозагрузка»). Включите переключатель, чтобы вернуть его.';
        } else if (status.enabled) {
            text.textContent = 'После входа в Windows приложение запустится само и останется в трее. Закрыть его совсем можно через значок в трее → «Выход».';
        } else {
            text.textContent = 'Приложение не запускается само: пока вы его не откроете, сообщения и звонки не приходят.';
        }
    }

    // При сбое переключатель возвращается в прежнее положение: applyAutostartStatus
    // рисует последнее состояние, которое подтвердила оболочка, а не клик.
    async setAutostartFromSettings(enabled) {
        if (!this.autostartSupported() || this._autostartBusy) return;
        this._autostartBusy = true;
        this.applyAutostartStatus();
        try {
            const res = await this.requestNativeAction({ type: NativeMessageTypes.AUTOSTART_REQUEST, enabled: !!enabled }, 5000);
            this._autostartStatus = res?.data || this._autostartStatus;
            this._autostartError = '';
        } catch (error) {
            this._autostartError = error?.message || String(error);
        } finally {
            this._autostartBusy = false;
            this.applyAutostartStatus();
        }
    }

    // ============================================================
    // Карточка «Обновления» в настройках: текущая версия + ручная проверка.
    // Автопроверка (checkForAppUpdate, updates.js) идёт при каждом входе и
    // сама решает, показывать ли модалку; этой кнопке при этом ЕЩЁ нужно
    // самой сообщить результат — «версия последняя» — иначе тишина в ответ
    // на явный клик читалась бы как «не сработало».
    // ============================================================

    currentAppVersionLabel() {
        const version = String(window.__ZALI_NATIVE_APP_VERSION || '').trim();
        return version ? `v${version}` : 'веб-версия';
    }

    renderUpdateSettings() {
        const note = document.getElementById('appVersionNote');
        if (note) note.textContent = this.currentAppVersionLabel();
        const statusText = document.getElementById('appUpdateStatusText');
        const btn = document.getElementById('checkForUpdatesBtn');
        const supported = this.hasNativeBridge() && this.nativeSupports('appUpdate');
        if (btn) btn.disabled = !supported || !!this._checkingForUpdates;
        if (!statusText) return;
        if (this._checkingForUpdates) {
            statusText.textContent = 'Проверяем…';
            return;
        }
        if (!supported) {
            statusText.textContent = 'Проверка версии доступна в приложении для macOS и Windows.';
            return;
        }
        const status = this.S.updateStatus || {};
        if (status.available) {
            statusText.textContent = `Доступно обновление v${status.version}. Открыть карточку в Хабе, чтобы установить.`;
        } else if (this._lastUpdateCheckFailed) {
            statusText.textContent = 'Не удалось проверить обновления — нет связи с сервером. Попробуйте ещё раз.';
        } else if (this._lastUpdateCheckAt) {
            statusText.textContent = 'У вас установлена последняя версия.';
        } else {
            statusText.textContent = 'Нажмите «Проверить обновления», чтобы узнать, есть ли новая версия.';
        }
    }

    // Обёртка над checkForAppUpdate() специально для явного клика: сама
    // функция молчит, если обновления нет (она рассчитана на тихую проверку
    // при каждом входе) — здесь же нужен видимый ответ на «не пришло
    // ничего», иначе кнопка выглядела бы сломанной.
    async checkForAppUpdateFromSettings() {
        if (this._checkingForUpdates) return;
        this._checkingForUpdates = true;
        this.renderUpdateSettings();
        // checkForAppUpdate() глотает сбои сети и сервера, поэтому «версия
        // последняя» можно показывать только после определённого ответа.
        let checked = false;
        try {
            checked = (await this.checkForAppUpdate()) === true;
        } finally {
            this._checkingForUpdates = false;
            this._lastUpdateCheckFailed = !checked;
            if (checked) this._lastUpdateCheckAt = Date.now();
            this.renderUpdateSettings();
        }
    }

    async setAudioInputDevice(deviceId) {
        this.audioPrefs.micDeviceId = String(deviceId || '');
        this.saveAudioPrefs();
        if (!this.voice.localStream) return;
        try {
            const constraints = this.audioPrefs.micDeviceId
                ? { audio: { deviceId: { exact: this.audioPrefs.micDeviceId } }, video: false }
                : { audio: true, video: false };
            const newStream = await navigator.mediaDevices.getUserMedia(constraints);
            const newTrack = newStream.getAudioTracks()[0];
            if (!newTrack) return;
            const oldTrack = this.voice.localStream.getAudioTracks()[0];
            for (const entry of this.voice.peerConnections.values()) {
                if (entry.audioSender) {
                    await entry.audioSender.replaceTrack(newTrack);
                }
            }
            if (oldTrack) {
                this.voice.localStream.removeTrack(oldTrack);
                try { oldTrack.stop(); } catch (e) {}
            }
            this.voice.localStream.addTrack(newTrack);
            this.ensureMeterEntry('local', this.voice.localStream);
            this.voiceTrace('mic-switched', { deviceId: this.audioPrefs.micDeviceId || 'default' }, 'SUCCESS');
        } catch (error) {
            this.addLogEntry({ type: 'ERROR', msg: error?.message || 'Не удалось переключить микрофон', ts: new Date().toLocaleTimeString() });
            this.voiceTrace('mic-switch-failed', { error: error?.message || String(error) }, 'ERROR');
        }
    }

    async setAudioOutputDevice(deviceId) {
        this.audioPrefs.speakerDeviceId = String(deviceId || '');
        this.saveAudioPrefs();
        await this.applyAudioOutputDevice();
    }

    async applyAudioOutputDevice() {
        const id = this.audioPrefs.speakerDeviceId || '';
        for (const audio of this.voice.remoteAudios.values()) {
            if (typeof audio.setSinkId === 'function') {
                try { await audio.setSinkId(id); } catch (error) {
                    this.voiceTrace?.('speaker-sink-failed', { error: error?.message || String(error) }, 'WARN');
                }
            }
        }
        // AudioContext.setSinkId is a newer API (not universally supported) — the
        // per-<audio>-element setSinkId above already covers the fallback
        // 'element' playback route from syncRemoteAudioPlaybackMode.
        const ctx = this.voice.audioContext;
        if (ctx && typeof ctx.setSinkId === 'function') {
            try { await ctx.setSinkId(id || 'default'); } catch (error) {
                this.voiceTrace?.('speaker-sink-context-failed', { error: error?.message || String(error) }, 'WARN');
            }
        }
    }

    hubSegmentCatalog() {
        return [
            { id: 'dm', label: 'ЛС', eyebrow: 'Direct', description: 'Личные диалоги и контакты' },
            { id: 'servers', label: 'Сервера', eyebrow: 'Guilds', description: 'Каналы, роли и сообщества' },
            { id: 'zalicoin', label: 'ZaliCoin', eyebrow: 'Economy', description: 'Баланс и переводы ZaliCoin' },
        ];
    }

    loadUiV2Enabled() {
        try {
            const raw = localStorage.getItem(this.uiV2EnabledStorageKey());
            // ZaliCoin ships as the 3rd segment of this nav (see hubSegmentCatalog),
            // so this is now the default chrome — `null` (never explicitly toggled)
            // means "on"; an explicit '0' from before this change stays respected.
            return raw === null ? true : raw === '1';
        } catch (e) {
            return true;
        }
    }

    saveUiV2Enabled(enabled) {
        this.uiV2Enabled = !!enabled;
        try {
            localStorage.setItem(this.uiV2EnabledStorageKey(), this.uiV2Enabled ? '1' : '0');
        } catch (e) {}
        this.applyUiV2Chrome();
    }

    normalizeUiV2Segments(value) {
        const allowed = new Set(this.hubSegmentCatalog().map(item => item.id));
        const source = Array.isArray(value) ? value : [];
        const next = [];
        for (const item of source) {
            const id = String(item || '').trim();
            if (!allowed.has(id) || next.includes(id)) continue;
            next.push(id);
            if (next.length >= 3) break;
        }
        return next.length ? next : ['dm', 'servers', 'zalicoin'];
    }

    loadUiV2Segments() {
        try {
            const raw = localStorage.getItem(this.uiV2SegmentsStorageKey());
            return this.normalizeUiV2Segments(raw ? JSON.parse(raw) : ['dm', 'servers', 'zalicoin']);
        } catch (e) {
            return ['dm', 'servers', 'zalicoin'];
        }
    }

    saveUiV2Segments(segments) {
        this.uiV2Segments = this.normalizeUiV2Segments(segments);
        try {
            localStorage.setItem(this.uiV2SegmentsStorageKey(), JSON.stringify(this.uiV2Segments));
        } catch (e) {}
        this.applyUiV2Chrome();
    }

    activeHubSegmentId() {
        if (document.getElementById('viewHub')?.classList.contains('active')) return 'hub';
        if (document.getElementById('viewSettings')?.classList.contains('active')) return 'settings';
        if (document.getElementById('viewZaliCoin')?.classList.contains('active')) return 'zalicoin';
        return this.S.navMode === 'servers' ? 'servers' : 'dm';
    }

    handleHubSegment(segmentId) {
        const id = String(segmentId || '').trim();
        if (id === 'hub') {
            this.openHubView();
            return;
        }
        if (id === 'settings') {
            this.openSettingsView();
            return;
        }
        if (id === 'zalicoin') {
            this.openZaliCoinView();
            return;
        }
        if (id === 'servers') {
            this.setNavMode('servers', { refresh: true });
            this.openChatView();
            return;
        }
        this.setNavMode('dm', { refresh: true });
        this.openChatView();
    }

    hubSegmentIcon(id) {
        const key = String(id || '').trim();
        const icons = {
            dm: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5.25 5.75h13.5a2 2 0 0 1 2 2v7.1a2 2 0 0 1-2 2H11.4l-4.75 3.4v-3.4h-1.4a2 2 0 0 1-2-2v-7.1a2 2 0 0 1 2-2Z"/><path d="M7.4 9.3h9.2M7.4 12.6h6.4"/></svg>',
            servers: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.2 4.6h11.6a2 2 0 0 1 2 2v2.8a2 2 0 0 1-2 2H6.2a2 2 0 0 1-2-2V6.6a2 2 0 0 1 2-2Z"/><path d="M6.2 12.6h11.6a2 2 0 0 1 2 2v2.8a2 2 0 0 1-2 2H6.2a2 2 0 0 1-2-2v-2.8a2 2 0 0 1 2-2Z"/><path d="M7.6 8h.05M7.6 16h.05M10.4 8h6M10.4 16h6"/></svg>',
            settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h8.2"/><path d="M16.8 7H19"/><path d="M15 5.1a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z"/><path d="M5 17h2.2"/><path d="M10.8 17H19"/><path d="M9 15.1a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z"/><path d="M5 12h4.2"/><path d="M12.8 12H19"/><path d="M11 10.1a1.9 1.9 0 1 1 0 3.8 1.9 1.9 0 0 1 0-3.8Z"/></svg>',
            hub: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.75 20.25 9v9.25a2 2 0 0 1-2 2h-4.1v-5.35h-4.3v5.35h-4.1a2 2 0 0 1-2-2V9L12 3.75Z"/></svg>',
            zalicoin: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="M9.5 9h5l-5 6h5M10.4 12h3.2"/></svg>',
        };
        return icons[key] || icons.hub;
    }

    renderHubSegmentNav() {
        const nav = document.getElementById('hubSegmentNav');
        if (!nav) return;
        const catalog = new Map(this.hubSegmentCatalog().map(item => [item.id, item]));
        const wanted = this.activeHubSegmentId();
        const items = this.normalizeUiV2Segments(this.uiV2Segments)
            .map(id => catalog.get(id))
            .filter(Boolean);
        items.push({ id: 'hub', label: 'Хаб', eyebrow: 'Home', description: 'Новости и подприложения' });
        const signature = items.map(item => item.id).join('|');
        const hasStableButtons = nav.dataset.segmentSignature === signature
            && nav.querySelector('.hub-segment-indicator')
            && nav.querySelectorAll('.hub-segment-btn').length === items.length;
        if (hasStableButtons) {
            // Нет кнопки у открытого экрана (Настройки) — выделенным остаётся прежний
            // раздел, см. resolveHubSegmentActive.
            this.updateHubSegmentNavActive(wanted);
            this.syncHubSegmentBadges();
            return;
        }
        // Первая отрисовка: прежнего раздела нет, берём по режиму навигации.
        let active = wanted;
        if (!items.some(item => item.id === active)) {
            const fallback = this.S.navMode === 'servers' ? 'servers' : 'dm';
            active = items.some(item => item.id === fallback) ? fallback : (items[0]?.id || active);
        }
        nav.innerHTML = '<span class="hub-segment-indicator" aria-hidden="true"></span>' + items.map(item => `
            <button class="hub-segment-btn ${active === item.id ? 'active' : ''}" type="button" data-hub-segment="${this.esc(item.id)}" title="${this.esc(item.label)} · ${this.esc(item.description)}" aria-label="${this.esc(item.label)}" aria-pressed="${active === item.id ? 'true' : 'false'}">
                ${this.hubSegmentIcon(item.id)}
                <span class="hub-segment-badge" hidden></span>
            </button>
        `).join('');
        nav.dataset.segmentSignature = signature;
        this.syncHubSegmentIndicator();
        this.syncHubSegmentBadges();
    }

    // "Разделы" (ЛС/Сервера) accrue unread the same way the DM list and the
    // server list already do — this just surfaces the existing totals (see
    // computeTotalUnreadCount/renderServers' per-server sum) on the segment
    // buttons themselves, which previously showed no indicator at all. Other
    // segments (ZaliCoin, Хаб) have no unread concept and stay at 0.
    hubSegmentUnreadCount(id) {
        if (id === 'dm') {
            return Object.values(this.S.unread || {}).reduce((sum, value) => sum + Number(value || 0), 0);
        }
        if (id === 'servers') {
            return Object.values(this.S.channelUnread || {}).reduce((sum, value) => sum + Number(value || 0), 0);
        }
        return 0;
    }

    // Called on every unread increment/reset (via syncTaskbarBadge, the
    // existing single choke point for both) as well as after a full nav
    // rebuild — cheap enough to run unconditionally since it only ever
    // touches up to 4 buttons and never rebuilds the nav itself.
    syncHubSegmentBadges() {
        const nav = document.getElementById('hubSegmentNav');
        if (!nav) return;
        nav.querySelectorAll('.hub-segment-btn[data-hub-segment]').forEach(btn => {
            const id = btn.getAttribute('data-hub-segment');
            const count = this.hubSegmentUnreadCount(id);
            let badge = btn.querySelector('.hub-segment-badge');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'hub-segment-badge';
                btn.appendChild(badge);
            }
            if (count > 0) {
                badge.textContent = count > 99 ? '99+' : String(count);
                badge.hidden = false;
            } else {
                badge.hidden = true;
            }
        });
    }

    // Раздел, который выделяет панель, когда открыт экран без своей кнопки в ней
    // (Настройки — в панели только чаты, сервера, ZaliCoin и Хаб). Раньше `active`
    // оставался 'settings', ни одна кнопка не получала `.active`, а лаймовый
    // индикатор стоял под прежней: все иконки белые, и на плашке в том числе.
    // Теперь выделенным остаётся последний раздел, на котором стоит плашка, —
    // иконка под ней чёрная. Нет прежнего — раздел по режиму навигации.
    resolveHubSegmentActive(nav, active) {
        const ids = Array.from(nav.querySelectorAll('.hub-segment-btn[data-hub-segment]'))
            .map(btn => String(btn.getAttribute('data-hub-segment') || ''));
        if (ids.includes(active)) return active;
        const current = nav.querySelector('.hub-segment-btn.active');
        if (current) return String(current.getAttribute('data-hub-segment') || '');
        const fallback = this.S.navMode === 'servers' ? 'servers' : 'dm';
        return ids.includes(fallback) ? fallback : (ids[0] || active);
    }

    updateHubSegmentNavActive(active) {
        const nav = document.getElementById('hubSegmentNav');
        if (!nav) return;
        active = this.resolveHubSegmentActive(nav, active);
        const previousActive = nav.querySelector('.hub-segment-btn.active');
        // Активный сегмент не сменился (переход между личками, входящее
        // сообщение): кнопки трогать незачем. Сверка индикатора с положением
        // кнопки (сменилась ширина окна) откладывается в кадр: чтение
        // offsetLeft — принудительная раскладка документа, который вызывающий
        // только что поменял (switchChat → setNavMode).
        if (previousActive && String(previousActive.getAttribute('data-hub-segment') || '') === active) {
            this.scheduleHubSegmentIndicator(false);
            return;
        }
        nav.querySelectorAll('.hub-segment-btn').forEach(btn => {
            const isActive = String(btn.getAttribute('data-hub-segment') || '') === active;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });
        this.scheduleHubSegmentIndicator(true);
    }

    // Одна отложенная в кадр сверка индикатора на все вызовы. Раньше «просто
    // сверить» (без анимации) и «переехать» (с анимацией) были двумя разными
    // rAF-колбэками: при переходе из Хаба/ZaliCoin/Настроек в ЛС или Сервера
    // первым в кадре срабатывал «просто сверить» и ставил индикатор на место
    // мгновенно, а «переехать» затем ехал уже из точки назначения — анимации не
    // было. Теперь запросы сливаются, и если хоть один просил анимацию, она будет.
    scheduleHubSegmentIndicator(animate) {
        this._hubIndicatorAnimate = !!(this._hubIndicatorAnimate || animate);
        if (this._hubIndicatorRaf) return;
        this._hubIndicatorRaf = requestAnimationFrame(() => {
            this._hubIndicatorRaf = 0;
            const animateNow = this._hubIndicatorAnimate;
            this._hubIndicatorAnimate = false;
            this.syncHubSegmentIndicator({ animate: animateNow });
        });
    }

    // Ставит индикатор под активную кнопку; ничего не делает, если он уже там
    // (или едет туда: мгновенная пересинхронизация оборвала бы идущий переезд).
    syncHubSegmentIndicator({ animate = false } = {}) {
        const nav = document.getElementById('hubSegmentNav');
        const indicator = nav?.querySelector('.hub-segment-indicator');
        const activeBtn = nav?.querySelector('.hub-segment-btn.active');
        if (!nav || !indicator || !activeBtn) return;
        const target = `${activeBtn.offsetLeft}:${activeBtn.offsetWidth}`;
        if (indicator.dataset.target === target) return;
        const animated = animate && !!indicator.dataset.target;
        indicator.style.transition = animated ? '' : 'none';
        indicator.style.width = `${activeBtn.offsetWidth}px`;
        indicator.style.transform = `translate3d(${activeBtn.offsetLeft}px, 0, 0)`;
        indicator.dataset.target = target;
        if (!animated) {
            requestAnimationFrame(() => {
                if (indicator.dataset.target === target) indicator.style.transition = '';
            });
        }
    }

    // Клик по сегменту: индикатор трогается сразу, в этом же кадре, а тяжёлая
    // перерисовка экрана (списки, настройки, кеш) откладывается на кадр позже.
    // Раньше она шла синхронно в обработчике клика и держала главный поток, пока
    // индикатор ещё не тронулся: отсюда «подлагивание» переключения. Переезд —
    // transform-переход, после старта он идёт в композиторе и не зависит от
    // главного потока.
    selectHubSegment(segmentId) {
        const id = String(segmentId || '').trim();
        if (!id) return;
        clearTimeout(this._hubSegmentDeferTimer);
        cancelAnimationFrame(this._hubSegmentDeferRaf);
        this.updateHubSegmentNavActive(id);
        // rAF → setTimeout: обработчик стартует после кадра, в котором индикатор уже поехал.
        this._hubSegmentDeferRaf = requestAnimationFrame(() => {
            this._hubSegmentDeferTimer = setTimeout(() => this.handleHubSegment(id), 0);
        });
    }

    renderUiV2Settings() {
        const toggle = document.getElementById('inputUiV2Enabled');
        if (toggle) toggle.checked = !!this.uiV2Enabled;
        const box = document.getElementById('hubSegmentSettings');
        const count = document.getElementById('hubSegmentsCount');
        if (!box) return;
        const selected = new Set(this.normalizeUiV2Segments(this.uiV2Segments));
        const total = selected.size + 1;
        if (count) count.textContent = `${total} / 4`;
        box.innerHTML = this.hubSegmentCatalog().map(item => `
            <label class="hub-segment-option">
                <input type="checkbox" value="${this.esc(item.id)}" ${selected.has(item.id) ? 'checked' : ''}>
                <span>
                    <strong>${this.esc(item.label)}</strong>
                    <small>${this.esc(item.description)}</small>
                </span>
            </label>
        `).join('');
    }

    applyUiV2Chrome() {
        document.body?.setAttribute('data-ui-v2', this.uiV2Enabled ? 'on' : 'off');
        if (!this.uiV2Enabled && document.getElementById('viewHub')?.classList.contains('active')) {
            this.openChatView();
        }
        this.renderHubSegmentNav();
        this.renderUiV2Settings();
        this.syncMobileChrome();
    }
});
