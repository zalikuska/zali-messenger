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

    loadExperimentalDesign() {
        try {
            return localStorage.getItem(this.experimentalDesignStorageKey()) === '1';
        } catch (e) {
            return false;
        }
    }

    saveExperimentalDesign(enabled) {
        this.experimentalDesign = !!enabled;
        try {
            localStorage.setItem(this.experimentalDesignStorageKey(), this.experimentalDesign ? '1' : '0');
        } catch (e) {}
        this.applyExperimentalDesign();
    }

    applyExperimentalDesign() {
        document.body?.setAttribute('data-experimental-design', this.experimentalDesign ? 'on' : 'off');
        const toggle = document.getElementById('inputExperimentalDesign');
        if (toggle) toggle.checked = !!this.experimentalDesign;
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
        const fallback = { micDeviceId: '', speakerDeviceId: '', masterVolumePercent: 100, peerVolumePercents: {} };
        try {
            const raw = localStorage.getItem(this.audioPrefsStorageKey());
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            return {
                micDeviceId: String(parsed?.micDeviceId || ''),
                speakerDeviceId: String(parsed?.speakerDeviceId || ''),
                masterVolumePercent: Number.isFinite(parsed?.masterVolumePercent) ? Math.max(0, Math.min(200, parsed.masterVolumePercent)) : 100,
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
            zalicoin: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.25"/><path d="M12 7.4v9.2M14.6 9.4c0-1.05-1.16-1.9-2.6-1.9-1.44 0-2.6.85-2.6 1.9 0 1.05 1.16 1.55 2.6 1.9 1.44.35 2.6.85 2.6 1.9 0 1.05-1.16 1.9-2.6 1.9-1.44 0-2.6-.85-2.6-1.9"/></svg>',
        };
        return icons[key] || icons.hub;
    }

    renderHubSegmentNav() {
        const nav = document.getElementById('hubSegmentNav');
        if (!nav) return;
        const catalog = new Map(this.hubSegmentCatalog().map(item => [item.id, item]));
        const active = this.activeHubSegmentId();
        const items = this.normalizeUiV2Segments(this.uiV2Segments)
            .map(id => catalog.get(id))
            .filter(Boolean);
        items.push({ id: 'hub', label: 'Хаб', eyebrow: 'Home', description: 'Новости и подприложения' });
        const signature = items.map(item => item.id).join('|');
        const hasStableButtons = nav.dataset.segmentSignature === signature
            && nav.querySelector('.hub-segment-indicator')
            && nav.querySelectorAll('.hub-segment-btn').length === items.length;
        if (hasStableButtons) {
            this.updateHubSegmentNavActive(active);
            return;
        }
        nav.innerHTML = '<span class="hub-segment-indicator" aria-hidden="true"></span>' + items.map(item => `
            <button class="hub-segment-btn ${active === item.id ? 'active' : ''}" type="button" data-hub-segment="${this.esc(item.id)}" title="${this.esc(item.label)} · ${this.esc(item.description)}" aria-label="${this.esc(item.label)}" aria-pressed="${active === item.id ? 'true' : 'false'}">
                ${this.hubSegmentIcon(item.id)}
            </button>
        `).join('');
        nav.dataset.segmentSignature = signature;
        this.syncHubSegmentIndicator(null);
    }

    updateHubSegmentNavActive(active) {
        const nav = document.getElementById('hubSegmentNav');
        if (!nav) return;
        const previousActive = nav.querySelector('.hub-segment-btn.active');
        const previousPosition = previousActive
            ? {
                x: previousActive.offsetLeft,
                width: previousActive.offsetWidth,
            }
            : null;
        nav.querySelectorAll('.hub-segment-btn').forEach(btn => {
            const isActive = String(btn.getAttribute('data-hub-segment') || '') === active;
            btn.classList.toggle('active', isActive);
            btn.setAttribute('aria-pressed', String(isActive));
        });
        this.syncHubSegmentIndicator(previousPosition);
    }

    syncHubSegmentIndicator(previousPosition = null) {
        const nav = document.getElementById('hubSegmentNav');
        const indicator = nav?.querySelector('.hub-segment-indicator');
        const activeBtn = nav?.querySelector('.hub-segment-btn.active');
        if (!nav || !indicator || !activeBtn) return;
        const applyTarget = (withTransition = true) => {
            if (withTransition) indicator.style.transition = '';
            indicator.style.width = `${activeBtn.offsetWidth}px`;
            indicator.style.transform = `translate3d(${activeBtn.offsetLeft}px, 0, 0)`;
        };
        const samePosition = previousPosition
            && Math.abs(Number(previousPosition.x || 0) - activeBtn.offsetLeft) < 0.5
            && Math.abs(Number(previousPosition.width || 0) - activeBtn.offsetWidth) < 0.5;
        if (samePosition) {
            return;
        }
        if (previousPosition) {
            indicator.getBoundingClientRect();
            requestAnimationFrame(() => applyTarget(true));
        } else {
            indicator.style.transition = 'none';
            applyTarget(false);
            requestAnimationFrame(() => {
                indicator.style.transition = '';
            });
        }
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
