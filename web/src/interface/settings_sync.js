// --- ZaliInterface: Облако настроек — тема, расстановка сообщений, громкости на всех устройствах. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Сервер — server/src/settings_sync.rs
// (`/api/settings-sync`, слияние по ключам, последняя запись побеждает, событие `settings_sync`).
//
// Принципы:
//  - Синхронизируется только то, что перечислено в settingsSyncEntries(). Ничего
//    привязанного к машине (id микрофона и динамиков, подавление эха, кэш, ключи) —
//    там разное железо, а ключи в облако не кладём вообще.
//  - Каждая запись — { v: строка, t: мс }. «Новее» решает t, а не порядок прихода.
//  - Изменение ловится на записи в localStorage (патч Storage.setItem), поэтому
//    существующие save*()-методы править не нужно; применение чужого значения идёт
//    через те же save*() под флагом _settingsSyncApplying, чтобы не отправить эхо.
//  - Выключатель — локальный (zali_settings_sync_enabled_v1), по умолчанию включено.
ZaliMixin(ZaliInterface, class {

    settingsSyncEnabledKey() {
        return 'zali_settings_sync_enabled_v1';
    }

    settingsSyncMetaKey() {
        return `zali_settings_sync_meta_v1${this._userSuffix()}`;
    }

    settingsSyncEnabled() {
        try {
            return localStorage.getItem(this.settingsSyncEnabledKey()) !== '0';
        } catch (e) {
            return true;
        }
    }

    // name — ключ на сервере ([a-z0-9_]); read() — текущая строка или null (не задано).
    settingsSyncEntries() {
        const lsGet = (key) => {
            try { return localStorage.getItem(key); } catch (e) { return null; }
        };
        return [
            {
                name: 'design_mode',
                storageKey: 'zali_design_mode_v1',
                read: () => lsGet('zali_design_mode_v1'),
                apply: (raw) => this.saveDesignMode(raw),
            },
            {
                name: 'decor_art',
                storageKey: 'zali_decor_art_v1',
                read: () => lsGet('zali_decor_art_v1'),
                apply: (raw) => this.saveDecorArt(raw === '1'),
            },
            {
                name: 'msg_one_side',
                storageKey: 'zali_msg_one_side_v1',
                read: () => lsGet('zali_msg_one_side_v1'),
                apply: (raw) => this.saveMsgOneSide(raw === '1'),
            },
            {
                name: 'ui_v2',
                storageKey: 'zali_ui_v2_enabled_v1',
                read: () => lsGet('zali_ui_v2_enabled_v1'),
                apply: (raw) => this.saveUiV2Enabled(raw === '1'),
            },
            {
                name: 'ui_v2_segments',
                storageKey: 'zali_ui_v2_segments_v1',
                read: () => lsGet('zali_ui_v2_segments_v1'),
                apply: (raw) => this.saveUiV2Segments(JSON.parse(raw)),
            },
            {
                // Громкости и выбранные звуки; устройства и подавление эха остаются у машины.
                name: 'audio_volumes',
                storageKey: this.audioPrefsStorageKey(),
                read: () => {
                    const raw = lsGet(this.audioPrefsStorageKey());
                    if (!raw) return null;
                    try {
                        const p = JSON.parse(raw);
                        return JSON.stringify({
                            m: p.masterVolumePercent ?? 100,
                            n: p.notificationVolumePercent ?? 100,
                            p: p.peerVolumePercents || {},
                            s: p.screenVolumePercents || {},
                            // Звук сообщения и рингтон; '' — по умолчанию.
                            ms: typeof p.messageSound === 'string' ? p.messageSound : '',
                            rt: typeof p.ringtone === 'string' ? p.ringtone : '',
                            vs: p.voiceSounds !== false,
                        });
                    } catch (e) { return null; }
                },
                apply: (raw) => {
                    const v = JSON.parse(raw);
                    this.audioPrefs = this.audioPrefs || this.loadAudioPrefs();
                    this.setMasterVolumePercent(v.m);
                    this.setNotificationVolumePercent(v.n);
                    this.audioPrefs.peerVolumePercents = (v.p && typeof v.p === 'object') ? v.p : {};
                    this.audioPrefs.screenVolumePercents = (v.s && typeof v.s === 'object') ? v.s : {};
                    // Запись от клиента без этих полей (старая сборка) выбор не трогает.
                    if (typeof v.ms === 'string') this.audioPrefs.messageSound = v.ms;
                    if (typeof v.rt === 'string') this.audioPrefs.ringtone = v.rt;
                    if (typeof v.vs === 'boolean') this.audioPrefs.voiceSounds = v.vs;
                    this.saveAudioPrefs();
                    this.renderSoundSettings?.();
                    const slider = document.getElementById('inputMasterVolume');
                    if (slider) slider.value = String(this.audioPrefs.masterVolumePercent);
                    const nslider = document.getElementById('inputNotificationVolume');
                    if (nslider) nslider.value = String(this.audioPrefs.notificationVolumePercent);
                },
            },
        ];
    }

    settingsSyncLoadMeta() {
        try {
            const parsed = JSON.parse(localStorage.getItem(this.settingsSyncMetaKey()) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    settingsSyncSaveMeta(meta) {
        try {
            localStorage.setItem(this.settingsSyncMetaKey(), JSON.stringify(meta));
        } catch (e) {}
    }

    // Ловим запись в синхронизируемые ключи, не трогая сами save*()-методы.
    installSettingsSyncHook() {
        if (this._settingsSyncHooked) return;
        this._settingsSyncHooked = true;
        const self = this;
        try {
            const original = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
                const result = original.apply(this, arguments);
                try {
                    if (this === window.localStorage && !self._settingsSyncApplying
                        && self.settingsSyncEntries().some(e => e.storageKey === key)) {
                        self.scheduleSettingsSyncPush();
                    }
                } catch (e) { /* хук не должен ломать запись */ }
                return result;
            };
        } catch (e) { /* без хранилища синхронизировать нечего */ }
    }

    scheduleSettingsSyncPush() {
        if (!this.settingsSyncEnabled()) return;
        clearTimeout(this._settingsSyncTimer);
        this._settingsSyncTimer = setTimeout(() => void this.pushSettingsSync(), 700);
    }

    setSettingsSyncStatus(text) {
        this._settingsSyncStatus = text;
        const el = document.getElementById('settingsSyncStatus');
        if (el) el.textContent = text;
    }

    applySettingsSyncUi() {
        const toggle = document.getElementById('inputSettingsSync');
        if (toggle) toggle.checked = this.settingsSyncEnabled();
        const el = document.getElementById('settingsSyncStatus');
        if (el) el.textContent = this._settingsSyncStatus || (this.settingsSyncEnabled() ? 'Включено' : 'Выключено');
    }

    setSettingsSyncEnabled(enabled) {
        try {
            localStorage.setItem(this.settingsSyncEnabledKey(), enabled ? '1' : '0');
        } catch (e) {}
        this._settingsSyncStatus = '';
        this.applySettingsSyncUi();
        if (enabled) void this.pullSettingsSync();
    }

    // Подтянуть документ с сервера, применить более новое чужое, отправить более новое своё.
    async pullSettingsSync() {
        if (!this.settingsSyncEnabled() || !this.S?.session?.token) return;
        if (this._settingsSyncBusy) { this._settingsSyncAgain = true; return; }
        this._settingsSyncBusy = true;
        try {
            const res = await this.apiFetch('/api/settings-sync');
            if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
            const remote = (await res.json())?.entries || {};
            const outgoing = this.settingsSyncMerge(remote);
            if (Object.keys(outgoing).length) await this.putSettingsSync(outgoing);
            this.setSettingsSyncStatus(`Синхронизировано в ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
        } catch (e) {
            this.trace?.(`settingsSync pull failed: ${e?.message || e}`);
            this.setSettingsSyncStatus('Не удалось синхронизировать — повторим позже');
        } finally {
            this._settingsSyncBusy = false;
            if (this._settingsSyncAgain) {
                this._settingsSyncAgain = false;
                void this.pullSettingsSync();
            }
        }
    }

    // Применяет новее-локального из remote, возвращает то, что новее серверного.
    settingsSyncMerge(remote) {
        const meta = this.settingsSyncLoadMeta();
        const outgoing = {};
        this._settingsSyncApplying = true;
        try {
            for (const entry of this.settingsSyncEntries()) {
                const r = remote?.[entry.name];
                const current = entry.read();
                let m = meta[entry.name];
                // Первый запуск: считаем локальное «давним» (t=0) — серверное его перебьёт.
                if (!m && current !== null) m = meta[entry.name] = { v: current, t: 0 };
                if (m && current !== null && current !== m.v) m = meta[entry.name] = { v: current, t: Date.now() };
                const remoteNewer = r && typeof r.v === 'string' && (!m || r.t > m.t);
                if (remoteNewer) {
                    if (r.v !== current) {
                        try { entry.apply(r.v); } catch (e) { this.trace?.(`settingsSync apply ${entry.name}: ${e?.message || e}`); continue; }
                    }
                    meta[entry.name] = { v: r.v, t: r.t };
                } else if (m && current !== null && (!r || m.t > r.t)) {
                    const t = m.t || Date.now();
                    meta[entry.name] = { v: current, t };
                    outgoing[entry.name] = { v: current, t };
                }
            }
        } finally {
            this._settingsSyncApplying = false;
        }
        this.settingsSyncSaveMeta(meta);
        return outgoing;
    }

    async putSettingsSync(entries) {
        const res = await this.apiFetch('/api/settings-sync', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ entries }),
        });
        if (!res?.ok) throw new Error(`HTTP ${res?.status}`);
        // Сервер вернул слитый документ: если там что-то новее — применим.
        const merged = (await res.json())?.entries || {};
        this.settingsSyncMerge(merged);
    }

    async pushSettingsSync() {
        if (!this.settingsSyncEnabled() || !this.S?.session?.token) return;
        try {
            // pull сам отправит всё, что у нас новее, и принесёт чужое.
            await this.pullSettingsSync();
        } catch (e) { /* статус уже выставлен */ }
    }

    // Из onGameActivityConnected: вход и каждый реконнект.
    settingsSyncOnConnected() {
        this.installSettingsSyncHook();
        void this.pullSettingsSync();
    }

    handleSettingsSyncRealtime() {
        void this.pullSettingsSync();
    }
});
