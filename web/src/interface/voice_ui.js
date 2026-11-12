// --- ZaliInterface: Отрисовка голосовой панели, плиток и развёрнутого звонка. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // Набор иконок голосового UI. Рисуются на сетке 24×24 из целых координат,
    // обводка наследуется от <svg> (CSS подбирает толщину под размер так, чтобы на
    // экране выходило ровно 1,5 px: см. «Иконки голосового UI» в style.css).
    // «Выключено» — не «иконка + перечёркивание», а отдельная геометрия, где линии
    // фигуры обрываются у диагонали: раньше косая черта шла поверх контура, и на
    // полупрозрачном цвете места наложения выходили ярче, а тонкие линии слипались.
    voiceIcon(kind) {
        const phone = '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.91.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92Z"/>';
        const mic = '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><path d="M12 19v3"/>';
        const micOff = '<path d="M3 3l18 18"/><path d="M15 9.3V5a3 3 0 0 0-5.7-1.3"/><path d="M9 9v3a3 3 0 0 0 5.1 2.1"/><path d="M19 10v2a7 7 0 0 1-.9 3.4"/><path d="M5 10v2a7 7 0 0 0 11.5 5.4"/><path d="M12 19v3"/>';
        const cam = '<path d="M16 10.5 21 7.4a.5.5 0 0 1 .8.4v8.4a.5.5 0 0 1-.8.4L16 13.5"/><rect x="2" y="6" width="14" height="12" rx="2.5"/>';
        const camOff = '<path d="M3 3l18 18"/><path d="M7 6h7a2 2 0 0 1 2 2v2.5l5-3.1a.5.5 0 0 1 .8.4v8.4"/><path d="M16 14v2a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 1-1.7"/>';
        const screen = '<rect x="2" y="3" width="20" height="14" rx="2.5"/><path d="M8 21h8"/><path d="M12 17v4"/>';
        const screenOff = '<path d="M3 3l18 18"/><path d="M20 6.5V6a3 3 0 0 0-3-3H7"/><path d="M2 8v6a3 3 0 0 0 3 3h12"/><path d="M8 21h8"/><path d="M12 17v4"/>';
        const headphones = '<path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a9 9 0 0 1 18 0v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3"/>';
        const headphonesOff = '<path d="M3 3l18 18"/><path d="M3 12a9 9 0 0 1 1.45-4.9"/><path d="M7.1 4.45A9 9 0 0 1 21 12v7a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-1"/><path d="M21 14h-3a2 2 0 0 0-2 2"/><path d="M3 14h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7"/>';
        const gamepad = '<path d="M6 11h4"/><path d="M8 9v4"/><path d="M15 12h.01"/><path d="M18 10h.01"/><path d="M17.3 5H6.7a4 4 0 0 0-4 3.6C2.6 9.4 2 14.5 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.4-1.4a2 2 0 0 1 1.4-.6h4.4a2 2 0 0 1 1.4.6L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.5-.6-6.6-.7-7.3A4 4 0 0 0 17.3 5Z"/>';
        const chevronDown = '<path d="m6 9 6 6 6-6"/>';
        const chevronUp = '<path d="m6 15 6-6 6 6"/>';
        const windowIcon = '<rect x="2" y="4" width="20" height="16" rx="2.5"/><path d="M2 9h20"/>';
        // Положенная трубка — знак «сбросить»: горизонтальная трубка, симметричная
        // относительно x = 12 и по высоте занимающая 7,8…16,2, то есть с центром ровно
        // в центре сетки; с обводкой — x 1,4…22,6, внутри сетки. Раньше это была обычная трубка, повёрнутая на 135°: её контур
        // в сетке не центрирован, после поворота он съезжал вверх-влево и стоял с
        // наклоном — в кнопке «Завершить» выглядел кривым и мельче соседних иконок.
        const phoneDown = '<path d="M2.5 12.8c0-1.2.7-2.3 1.8-3C6.6 8.5 9.2 7.8 12 7.8s5.4.7 7.7 2c1.1.7 1.8 1.8 1.8 3v1.6a1.8 1.8 0 0 1-2 1.8l-2.7-.4a1.8 1.8 0 0 1-1.6-1.8v-1.6c-1-.4-2.1-.6-3.2-.6s-2.2.2-3.2.6v1.6a1.8 1.8 0 0 1-1.6 1.8l-2.7.4A1.8 1.8 0 0 1 2.5 14.4Z"/>';
        const icons = {
            phone,
            'phone-off': phone + '<path d="M3 3l18 18"/>',
            'phone-down': phoneDown,
            mic,
            'mic-off': micOff,
            cam,
            'cam-off': camOff,
            screen,
            'screen-off': screenOff,
            video: cam,
            headphones,
            'headphones-off': headphonesOff,
            gamepad,
            'chevron-down': chevronDown,
            'chevron-up': chevronUp,
            window: windowIcon,
        };
        return `<svg class="call-ctrl-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${icons[kind] || ''}</svg>`;
    }

    // short — короткая подпись под кнопкой («Микрофон», «Камера»): label
    // меняется вместе с состоянием («Выключить микрофон») и годится только
    // для подсказки, а подпись должна называть кнопку, а не действие.
    callCtrlBtn({ id, kind, label, short = '', active = false, danger = false }) {
        const cls = ['call-ctrl-btn', active ? 'active' : '', danger ? 'danger' : ''].filter(Boolean).join(' ');
        const shortAttr = short ? ` data-short="${this.esc(short)}"` : '';
        return `<button class="${cls}" type="button" id="${id}" title="${this.esc(label)}" aria-label="${this.esc(label)}"${shortAttr}>${this.voiceIcon(kind)}</button>`;
    }

    // Кнопка камеры + «хвостик» выбора устройства (#voiceCameraPickBtn).
    cameraCtrlSplit(opts) {
        const main = this.callCtrlBtn(opts);
        const label = 'Выбрать камеру';
        return `<span class="call-ctrl-split">${main}<button class="call-ctrl-caret" type="button" id="voiceCameraPickBtn" title="${this.esc(label)}" aria-label="${this.esc(label)}">${this.voiceIcon('chevron-up')}</button></span>`;
    }

    // ── «Кто сидит в канале» в списке каналов ────────────────────────────
    // Состав комнат приходит только участникам, поэтому для каналов, в которых мы
    // не сидим, раз в несколько секунд спрашиваем сервер разом про весь сервер
    // (GET /api/servers/:id/voice); для канала, в котором мы сами, берём живые
    // данные звонка. Секундомер канала считается от входа самого раннего участника.
    // Порядок в списке: сначала те, кто в эфире (показывает экран), затем с камерой,
    // дальше — по времени входа (у всех клиентов один порядок), затем по имени.
    rankVoiceOccupants({ names, joinedAt = {}, states = {} }) {
        const key = n => String(n).toLowerCase();
        const rank = n => (states[key(n)]?.screen ? 0 : (states[key(n)]?.camera ? 1 : 2));
        return names.slice().sort((a, b) => (rank(a) - rank(b))
            || ((joinedAt[key(a)] || 0) - (joinedAt[key(b)] || 0))
            || key(a).localeCompare(key(b)));
    }

    voiceChannelOccupants(server, channel) {
        const raw = this.voiceChannelOccupantsRaw(server, channel);
        return { ...raw, names: this.rankVoiceOccupants(raw) };
    }

    voiceChannelOccupantsRaw(server, channel) {
        const roomId = this.voiceRoomKeyForChannel(server.id, channel.id);
        const inThisCall = this.voiceLiveCallType?.() === 'channel' && String(this.voice.roomId || '') === roomId;
        if (inThisCall) {
            const names = Array.isArray(this.voice.participants) ? this.voice.participants.filter(Boolean) : [];
            return { names, joinedAt: this.voice.joinedAt || {}, states: this.voice.memberStates || {} };
        }
        const live = this._serverVoicePresence?.[server.id]?.[channel.id];
        if (!live) return { names: [], joinedAt: {}, states: {} };
        return live;
    }

    async refreshServerVoicePresence() {
        const server = this.currentServer?.();
        if (!server?.id) return;
        try {
            const res = await this.apiFetch(`/api/servers/${encodeURIComponent(server.id)}/voice`);
            if (!res.ok) return;
            const data = await res.json();
            const channels = {};
            for (const [cid, raw] of Object.entries(data.channels || {})) {
                const joinedAt = this.parseVoiceJoinedAt(raw.joinedAt);
                const names = (Array.isArray(raw.participants) ? raw.participants : [])
                    .map(name => String(name || '').trim()).filter(Boolean)
                    .sort((a, b) => ((joinedAt[a.toLowerCase()] || 0) - (joinedAt[b.toLowerCase()] || 0)) || a.localeCompare(b));
                if (names.length) channels[cid] = { names, joinedAt, states: this.parseVoiceMemberStates(raw.states) };
            }
            const before = JSON.stringify(this._serverVoicePresence?.[server.id] || {});
            if (!this._serverVoicePresence) this._serverVoicePresence = {};
            this._serverVoicePresence[server.id] = channels;
            if (JSON.stringify(channels) !== before && this.S.navMode === 'servers') this.renderServers();
        } catch (e) { /* список — удобство, не критично */ }
    }

    ensureServerVoicePoll() {
        if (this._serverVoiceTimer) return;
        let tick = 0;
        void this.refreshServerVoicePresence();
        this._serverVoiceTimer = setInterval(() => {
            if (this.S.navMode !== 'servers' || !this.currentServer?.()) {
                this.stopServerVoicePoll();
                return;
            }
            this.fillVoiceChannelTimers();
            tick += 1;
            if (tick % 5 === 0 && document.visibilityState !== 'hidden') void this.refreshServerVoicePresence();
        }, 1000);
    }

    stopServerVoicePoll() {
        if (!this._serverVoiceTimer) return;
        clearInterval(this._serverVoiceTimer);
        this._serverVoiceTimer = null;
    }

    voiceElapsedLabel(sinceMs) {
        const total = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
        const h = Math.floor(total / 3600);
        const m = Math.floor((total % 3600) / 60);
        const sec = total % 60;
        const mm = h ? String(m).padStart(2, '0') : String(m);
        return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
    }

    // Текст секундомера не входит в разметку (она сравнивается с прошлой, и
    // тикающие секунды пересобирали бы список под курсором) — вписывается сюда.
    fillVoiceChannelTimers() {
        for (const el of document.querySelectorAll('[data-voice-since]')) {
            const since = Number(el.getAttribute('data-voice-since')) || 0;
            if (!since) continue;
            const label = this.voiceElapsedLabel(since);
            if (el.textContent !== label) el.textContent = label;
        }
    }

    // Строки участников под голосовым каналом: аватар, имя, игра («Играет в …»),
    // справа — «В ЭФИРЕ» (показывает экран), камера, выключенный микрофон/звук.
    voiceChannelMembersHTML(server, channel, occupants) {
        if (!occupants.names.length) return '';
        const rows = occupants.names.map(name => {
            const key = name.toLowerCase();
            const st = occupants.states?.[key] || {};
            const game = this.gameActivityFor?.(name);
            // Игра — только значок, слева от аватара; название в подсказке. Слот
            // занят всегда (пустой у тех, кто не играет), чтобы аватары стояли ровно.
            const activity = `<span class="svm-game"${game ? ` title="${this.esc(this.gameActivityLabel(game))}"` : ' aria-hidden="true"'}>${game ? this.gameActivityIconHTML() : ''}</span>`;
            const flags = [
                st.screen ? '<span class="svm-live">В эфире</span>' : '',
                st.camera ? `<span class="svm-flag" title="Камера включена">${this.voiceIcon('cam')}</span>` : '',
                st.deafened
                    ? `<span class="svm-flag is-off" title="Звук выключен">${this.voiceIcon('headphones-off')}</span>`
                    : (st.muted ? `<span class="svm-flag is-off" title="Микрофон выключен">${this.voiceIcon('mic-off')}</span>` : ''),
            ].join('');
            return `<div class="sidebar-voice-member" data-peer="${this.esc(key)}" data-name="${this.esc(name)}">
                ${activity}
                <span class="svm-ava">${this.renderAvatarHTML(name, 'avatar-img', name)}</span>
                <span class="svm-name">${this.esc(name)}</span>
                <span class="svm-flags">${flags}</span>
            </div>`;
        }).join('');
        return `<div class="sidebar-voice-members" data-server-id="${this.esc(server.id)}" data-channel-id="${this.esc(channel.id)}" data-channel-kind="voice">${rows}</div>`;
    }

    // ── Превью голосового канала ─────────────────────────────────────────
    // Комнатные voice_room_state приходят только тем, кто в комнате, поэтому
    // снаружи канал выглядел пустым. Пока открыт экран «Зайти в канал»,
    // спрашиваем сервер (GET …/channels/:id/voice) раз в несколько секунд.
    voicePresenceKey() {
        const server = this.currentServer?.();
        const channel = this.currentChannel?.();
        return server?.id && channel?.id ? `${server.id}:${channel.id}` : '';
    }

    voicePresenceNames() {
        const data = this._voicePresence;
        if (!data || data.key !== this.voicePresenceKey()) return [];
        return this.rankVoiceOccupants({ names: data.names, joinedAt: data.joinedAt, states: data.states });
    }

    voicePresenceStates() {
        const data = this._voicePresence;
        return (data && data.key === this.voicePresenceKey()) ? (data.states || {}) : {};
    }

    async refreshVoicePresence() {
        const key = this.voicePresenceKey();
        if (!key) return;
        const [serverId, channelId] = [this.currentServer().id, this.currentChannel().id];
        try {
            const res = await this.apiFetch(`/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}/voice`);
            if (!res.ok) return;
            const data = await res.json();
            const joinedAt = this.parseVoiceJoinedAt(data.joinedAt);
            const names = (Array.isArray(data.participants) ? data.participants : [])
                .map(name => String(name || '').trim()).filter(Boolean)
                .sort((a, b) => ((joinedAt[a.toLowerCase()] || 0) - (joinedAt[b.toLowerCase()] || 0)) || a.localeCompare(b));
            const prev = this._voicePresence;
            const states = this.parseVoiceMemberStates(data.states);
            const changed = !prev || prev.key !== key || prev.names.join('\n') !== names.join('\n')
                || JSON.stringify(prev.states) !== JSON.stringify(states);
            this._voicePresence = { key, names, joinedAt, states };
            if (changed && key === this.voicePresenceKey()) this.scheduleRenderVoicePanel(0);
        } catch (e) { /* превью — удобство, не критично */ }
    }

    ensureVoicePresencePoll() {
        if (this._voicePresenceTimer) return;
        void this.refreshVoicePresence();
        this._voicePresenceTimer = setInterval(() => {
            if (document.visibilityState === 'hidden' || !document.getElementById('viewChat')?.classList.contains('active')) return;
            void this.refreshVoicePresence();
        }, 4000);
    }

    stopVoicePresencePoll() {
        if (!this._voicePresenceTimer) return;
        clearInterval(this._voicePresenceTimer);
        this._voicePresenceTimer = null;
    }

    // Discord-style call stage: one rectangular tile per participant, avatar in
    // the middle, name badge at the bottom — the tile *is* the participant list,
    // and it's also where that participant's camera feed mounts (see
    // mountVoiceVideoElements, which fills `.voice-tile-media` by data-peer).
    // Keyed on the lowercased name because every other voice code path
    // (participants, remoteVideos, remoteAudios) normalises that way.
    // Красной карточки «Х показывает экран · В эфире» над плитками превью больше нет —
    // пользователь попросил её убрать (2026-11-11). Кто показывает экран, видно по
    // метке «В эфире» у его строки в списке канала (voiceChannelMembersHTML).
    // previewNames — превью голосового канала, в котором мы не состоим: показываем
    // только тех, кого назвал сервер (voicePresenceNames), без нас самих и без
    // медиа-карт текущего звонка.
    renderVoiceTiles(previewNames = null, previewStates = null) {
        const seen = new Set();
        const participants = [];
        const push = name => {
            const raw = String(name || '').trim();
            if (!raw) return;
            const key = raw.toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            participants.push(raw);
        };
        if (Array.isArray(previewNames)) {
            for (const name of previewNames) push(name);
        } else {
            push(this.myName());
            for (const name of (Array.isArray(this.voice.participants) ? this.voice.participants : [])) push(name);
            // Someone whose media arrived before the room-state snapshot listing them
            // would otherwise have a video element with no tile to mount into.
            for (const name of this.voice.remoteVideos.keys()) push(name);
            for (const name of this.voice.remoteAudios.keys()) push(name);
        }

        if (!participants.length) {
            return `<div class="voice-empty">${Array.isArray(previewNames) ? 'В канале пока никого — зайдите первым' : 'Пока никого нет'}</div>`;
        }
        const myName = String(this.myName() || '').trim().toLowerCase();
        // Превью уже упорядочено (эфир → камера → время входа) тем же правилом, что и
        // список слева; пересортировка по живым картам звонка (их у нас нет) сбила бы его.
        const { shown, overflow } = Array.isArray(previewNames)
            ? { shown: participants.slice(0, this.voiceTileLimit()), overflow: participants.slice(this.voiceTileLimit()) }
            : this.splitVoiceParticipants(participants);
        const tiles = `<div class="voice-tiles" id="voiceTiles">` + shown.map(name => {
            const key = name.toLowerCase();
            const mine = key === myName;
            // Чужой микрофон — по самоописанию участника (voice_state); клиент
            // старой версии его не шлёт, и тогда значка нет, а не догадка.
            const states = Array.isArray(previewNames) ? previewStates : this.voice.memberStates;
            const muted = mine ? !!this.voice.muted : !!states?.[key]?.muted;
            // В превью видео нет, но у человека с включённой камерой вместо аватара —
            // плейсхолдер веб-камеры: так сразу видно, кто покажется в кадре.
            const camHint = Array.isArray(previewNames) && !!states?.[key]?.camera;
            return `
                <div class="voice-tile ${mine ? 'mine' : ''}${camHint ? ' cam-hint' : ''}" data-peer="${this.esc(key)}" data-name="${this.esc(name)}">
                    <div class="voice-tile-media"></div>
                    <div class="voice-tile-person">
                        <span class="voice-level-ring" aria-hidden="true"></span>
                        <div class="voice-tile-avatar">${camHint ? this.voiceIcon('cam') : this.renderAvatarHTML(name, 'voice-tile-ava', name)}</div>
                    </div>
                    <div class="voice-tile-footer">
                        ${muted ? `<span class="voice-tile-mic muted" title="Микрофон выключен">${this.voiceIcon('mic-off')}</span>` : ''}
                        <span class="voice-tile-name">${this.esc(name)}</span>
                    </div>
                </div>
            `;
        }).join('') + `</div>`;
        if (!overflow.length) return `<div class="voice-tiles-wrap" id="voiceTilesWrap">${tiles}</div>`;
        const dots = overflow.map(name => {
            const key = name.toLowerCase();
            return `<div class="voice-dot" data-peer="${this.esc(key)}" data-name="${this.esc(name)}" title="${this.esc(name)}">${this.renderAvatarHTML(name, 'avatar-img', name)}</div>`;
        }).join('');
        return `<div class="voice-tiles-wrap" id="voiceTilesWrap">${tiles}`
            + `<div class="voice-overflow" id="voiceOverflow" role="group" aria-label="${this.esc('Ещё ' + overflow.length)}">`
            + `<span class="voice-overflow-label">Ещё ${overflow.length}</span>${dots}</div></div>`;
    }

    // Самоописание участников комнаты (voice_state): имя в нижнем регистре →
    // {muted, deafened, camera, screen}. Протокол раньше не нёс состояния собеседников,
    // поэтому чужой микрофон и камера нигде не показывались.
    parseVoiceMemberStates(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        for (const [name, st] of Object.entries(raw)) {
            const key = String(name || '').trim().toLowerCase();
            if (!key || !st || typeof st !== 'object') continue;
            out[key] = { muted: !!st.muted, deafened: !!st.deafened, camera: !!st.camera, screen: !!st.screen };
        }
        return out;
    }

    // Сообщает серверу, что у нас с микрофоном/звуком/камерой/экраном. Вызывается из
    // renderVoicePanel (его зовёт каждый переход состояния звонка) и с keepalive;
    // повтор того же состояния не шлётся, пока не сменилась сессия в комнате.
    syncVoiceMemberState({ force = false } = {}) {
        const roomId = String(this.voice.roomId || '').trim();
        const status = String(this.voice.status || '');
        const roomType = String(this.voice.roomType || '').trim();
        if (!roomId || (status !== 'connecting' && status !== 'connected') || (roomType !== 'channel' && roomType !== 'dm')) return;
        const me = String(this.myName() || '').trim().toLowerCase();
        const state = {
            muted: !!this.voice.muted,
            deafened: !!this.voice.deafened,
            camera: !!this.voice.cameraOn,
            screen: !!this.voice.screenSharing,
        };
        // Время входа в сигнатуре: после выхода и повторного входа сервер забыл
        // состояние, и оно должно уйти заново.
        const signature = `${roomId}|${this.voice.joinedAt?.[me] || 0}|${JSON.stringify(state)}`;
        if (!force && signature === this._voiceStateSig) return;
        this._voiceStateSig = signature;
        this.sendVoiceEvent({ type: 'voice_state', roomId, roomType, ...state });
    }

    // Keys are lowercased so lookups match every other voice map.
    parseVoiceJoinedAt(raw) {
        const out = {};
        if (!raw || typeof raw !== 'object') return out;
        for (const [name, ms] of Object.entries(raw)) {
            const key = String(name || '').trim().toLowerCase();
            const value = Number(ms);
            if (key && Number.isFinite(value) && value > 0) out[key] = value;
        }
        return out;
    }

    // Who gets a tile, in what order. Screen shares come first, then cameras, then
    // everyone else by time spent in the room (server-stamped entry time, so every
    // client ranks the same way). Speaking is deliberately NOT a key: the grid would
    // reshuffle on every pause in a conversation, and speakers already have a ring.
    rankVoiceParticipants(participants) {
        const me = String(this.myName() || '').trim().toLowerCase();
        const sharers = new Set(Array.from(this.voice.remoteScreens.keys(), name => String(name).trim().toLowerCase()));
        if (this.voice.screenSharing) sharers.add(me);
        const cameras = new Set(Array.from(this.voice.remoteVideos.keys(), name => String(name).trim().toLowerCase()));
        if (this.voice.cameraOn) cameras.add(me);
        // Самоописание участников (voice_state) знает про экран и камеру ещё до того,
        // как дошло видео: эфир и камера поднимают человека наверх сразу.
        for (const [key, st] of Object.entries(this.voice.memberStates || {})) {
            if (st.screen) sharers.add(key);
            if (st.camera) cameras.add(key);
        }
        const joinedAt = this.voice.joinedAt || {};
        const firstSeen = this.voice.firstSeen instanceof Map ? this.voice.firstSeen : (this.voice.firstSeen = new Map());
        const now = Date.now();
        const tenure = key => {
            if (joinedAt[key]) return joinedAt[key];
            // Server did not stamp this person (older server): the first moment this
            // client saw them is the next best thing.
            if (!firstSeen.has(key)) firstSeen.set(key, now);
            return firstSeen.get(key);
        };
        const rows = participants.map(name => {
            const key = name.toLowerCase();
            return { name, key, rank: sharers.has(key) ? 0 : (cameras.has(key) ? 1 : 2), since: tenure(key) };
        });
        rows.sort((a, b) => (a.rank - b.rank) || (a.since - b.since) || a.key.localeCompare(b.key));
        return rows.map(row => row.name);
    }

    voiceTileLimit() {
        const staged = !!(this.voice.screenSharing || this.voice.remoteScreens?.size);
        return staged ? ZaliInterface.MAX_VOICE_TILES_WITH_STAGE : ZaliInterface.MAX_VOICE_TILES;
    }

    // Top N of the ranking get tiles, the rest become circles. Our own tile is
    // always among them: a late joiner to a full room must still see themselves.
    splitVoiceParticipants(participants) {
        const limit = this.voiceTileLimit();
        const ranked = this.rankVoiceParticipants(participants);
        if (ranked.length <= limit) return { shown: ranked, overflow: [] };
        const me = String(this.myName() || '').trim().toLowerCase();
        let shown = ranked.slice(0, limit);
        let overflow = ranked.slice(limit);
        if (me && !shown.some(name => name.toLowerCase() === me)) {
            const mine = overflow.find(name => name.toLowerCase() === me);
            if (mine) {
                overflow = overflow.filter(name => name !== mine);
                overflow.unshift(shown[shown.length - 1]);
                shown = shown.slice(0, -1).concat(mine);
            }
        }
        return { shown, overflow };
    }

    // The expanded grid shows 16:9 tiles that keep their shape and leave the rest of
    // the area empty, so the grid cannot be left to CSS auto-fit: pick the column
    // count whose tile comes out largest in the box we actually have.
    fitVoiceTiles() {
        const tiles = document.getElementById('voiceTiles');
        const host = tiles?.closest('.voice-call-expanded-grid');
        if (!tiles || !host) return;
        const panel = host.closest('.voice-panel');
        if (panel?.classList.contains('has-stage')) return;
        const count = tiles.children.length;
        const width = tiles.clientWidth;
        const height = tiles.clientHeight;
        if (!count || width <= 0 || height <= 0) return;
        const gap = 10;
        let best = { w: 0, c: 1 };
        for (let c = 1; c <= count; c++) {
            const r = Math.ceil(count / c);
            const byWidth = (width - (c - 1) * gap) / c;
            const byHeight = ((height - (r - 1) * gap) / r) * 16 / 9;
            const w = Math.min(byWidth, byHeight);
            if (w > best.w) best = { w, c };
        }
        const w = Math.max(96, Math.floor(best.w));
        tiles.style.setProperty('--vt-cols', String(best.c));
        tiles.style.setProperty('--vt-w', `${w}px`);
        tiles.style.setProperty('--vt-av', `${Math.max(32, Math.min(96, Math.round(w * 0.28)))}px`);
        if (typeof ResizeObserver === 'function') {
            if (this._voiceTilesObserved !== tiles) {
                this._voiceTilesObserver?.disconnect();
                this._voiceTilesObserver = new ResizeObserver(() => this.fitVoiceTiles());
                this._voiceTilesObserver.observe(tiles);
                this._voiceTilesObserved = tiles;
            }
        }
    }

    // Компактный идущий звонок: таймер, затем микрофон и звук, затем «сбросить».
    // Один и тот же фрагмент рисуется в двух местах — в титлбаре (#tbCall, на
    // стороне, противоположной кнопкам окна) и в полосе над вкладками
    // (#voiceCallStrip, видна только на телефоне, где титлбара нет), — поэтому
    // кнопки адресуются data-voice-action, а не id. Таймер — кнопка: открывает
    // полный интерфейс звонка (openActiveVoiceCall).
    // Время в разметку не входит: HTML сравнивается с прошлым, и тикающие
    // секунды пересобирали бы кнопки прямо под курсором (клик терялся).
    // Его вписывает fillVoiceCallTimers() — сразу после вставки и по таймеру.
    fillVoiceCallTimers() {
        const label = this.voiceCallClockLabel();
        for (const el of document.querySelectorAll('[data-voice-timer]')) {
            if (el.textContent !== label) el.textContent = label;
        }
    }

    renderVoiceCompactCall({ title }) {
        const muteLabel = this.voice.muted ? 'Включить микрофон' : 'Выключить микрофон';
        const deafenLabel = this.voice.deafened ? 'Включить звук' : 'Выключить звук';
        const openLabel = `${title} — открыть звонок`;
        return `
            <div class="voice-compact" role="group" aria-label="${this.esc(title)}">
                <button class="voice-compact-timer" type="button" data-voice-action="open" title="${this.esc(openLabel)}" aria-label="${this.esc(openLabel)}">
                    <span class="voice-compact-dot" aria-hidden="true"></span>
                    <span class="voice-compact-time" data-voice-timer></span>
                </button>
                <button class="voice-compact-btn${this.voice.muted ? ' is-off' : ''}" type="button" data-voice-action="mute" title="${this.esc(muteLabel)}" aria-label="${this.esc(muteLabel)}" aria-pressed="${this.voice.muted ? 'true' : 'false'}">${this.voiceIcon(this.voice.muted ? 'mic-off' : 'mic')}</button>
                <button class="voice-compact-btn${this.voice.deafened ? ' is-off' : ''}" type="button" data-voice-action="deafen" title="${this.esc(deafenLabel)}" aria-label="${this.esc(deafenLabel)}" aria-pressed="${this.voice.deafened ? 'true' : 'false'}">${this.voiceIcon(this.voice.deafened ? 'headphones-off' : 'headphones')}</button>
                <button class="voice-compact-btn is-hangup" type="button" data-voice-action="leave" title="Завершить звонок" aria-label="Завершить звонок">${this.voiceIcon('phone-down')}</button>
            </div>
        `;
    }

    // Входящий звонок — одна строка: кто звонит, «Отклонить», «Принять». Живёт
    // в полосе над вкладками и видна с любого экрана — и для обычного входящего,
    // и для звонящего поверх голосового канала. Кнопки со своими id: панель
    // чата может одновременно держать свои (#voiceAcceptBtn и т. п.).
    // «Принять» стоит последней — справа, под большим пальцем и там, где её
    // ищут по привычке; «Отклонить» — красная положенная трубка слева от неё.
    renderVoiceIncomingStrip(invite) {
        const from = String(invite?.from || '').trim();
        const overChannel = !!invite?.overChannel;
        const label = from ? `Входящий звонок от ${from}` : 'Входящий звонок';
        const acceptTitle = overChannel ? 'Выйти из канала и принять звонок' : 'Принять звонок';
        const rejectTitle = overChannel ? 'Отклонить и остаться в канале' : 'Отклонить звонок';
        return `
            <div class="voice-incoming" role="group" aria-label="${this.esc(label)}">
                <div class="voice-incoming-who">
                    <span class="voice-incoming-ava" aria-hidden="true">${from ? this.renderAvatarHTML(from, 'avatar-img', from) : ''}</span>
                    <span class="voice-incoming-name">${this.esc(from || 'Входящий звонок')}</span>
                    <span class="voice-incoming-note">${overChannel ? 'звонит · вы в канале' : 'звонит'}</span>
                </div>
                <div class="voice-incoming-actions">
                    <button class="voice-incoming-btn is-decline" type="button" id="voiceStripRejectBtn" title="${this.esc(rejectTitle)}" aria-label="${this.esc(rejectTitle)}">${this.voiceIcon('phone-down')}<span>Отклонить</span></button>
                    <button class="voice-incoming-btn is-accept" type="button" id="voiceStripAcceptBtn" title="${this.esc(acceptTitle)}" aria-label="${this.esc(acceptTitle)}">${this.voiceIcon('phone')}<span>Принять</span></button>
                </div>
            </div>
        `;
    }

    // Fullscreen (within the chat window) call view: dynamic grid of 16:9 tiles,
    // one per participant, reusing renderVoiceTiles()/mountVoiceVideoElements()
    // as-is so a participant's camera feed replaces their tile exactly like it
    // already does in the collapsed layout — nothing about tile mounting changes,
    // only where the tiles are shown.
    // `embedded` is the voice channel's own view: the call is the whole screen
    // there already, so there is nothing to collapse back to.
    renderVoiceCallExpanded({ title, actionButtons, embedded = false, preview = null }) {
        if (preview) {
            const count = preview.names.length;
            const countLabel = count ? `${count} в канале` : 'Никого в канале';
            return `
                <div class="voice-call-expanded embedded is-preview" id="voiceCallExpanded">
                    <div class="voice-call-expanded-header">
                        <div class="voice-call-expanded-title">${this.esc(title)}</div>
                        <div class="voice-preview-count${count ? ' has-people' : ''}">${this.esc(countLabel)}</div>
                    </div>
                    <div class="voice-stage" id="voiceStage"></div>
                    <div class="voice-call-expanded-grid">${this.renderVoiceTiles(preview.names, preview.states)}</div>
                    <div class="voice-join-bar">${actionButtons.join('')}</div>
                </div>
            `;
        }
        const header = embedded
            ? `<div class="voice-call-expanded-header">
                    <div class="voice-call-expanded-title">${this.esc(title)}</div>
                    <div class="voice-call-expanded-timer" id="voiceCallExpandedTimer" data-voice-timer></div>
                </div>`
            : `<div class="voice-call-expanded-header" id="voiceCollapseBar" role="button" tabindex="0" aria-label="Свернуть звонок">
                    <button class="voice-call-collapse-btn" type="button" id="voiceCollapseBtn" title="Свернуть" aria-label="Свернуть">${this.voiceIcon('chevron-down')}</button>
                    <div class="voice-call-expanded-title">${this.esc(title)}</div>
                    <div class="voice-call-expanded-timer" id="voiceCallExpandedTimer" data-voice-timer></div>
                </div>`;
        return `
            <div class="voice-call-expanded ${embedded ? 'embedded' : ''}" id="voiceCallExpanded">
                ${header}
                ${this.voice.micError ? `<div class="voice-room-alert">${this.esc(this.voice.micError)}</div>` : ''}
                <div class="voice-stage" id="voiceStage"></div>
                <div class="voice-call-expanded-grid">${this.renderVoiceTiles()}</div>
                <div class="call-ctrl-bar voice-call-expanded-actions">${actionButtons.join('')}</div>
            </div>
        `;
    }

    renderVoiceRoomView() {
        const isVoice = this.isVoiceChannel(this.currentChannel());
        const me = String(this.myName() || '').trim().toLowerCase();
        const participants = Array.isArray(this.voice.participants)
            ? this.voice.participants.map(name => String(name || '').trim().toLowerCase()).filter(Boolean)
            : [];
        const participantMatch = me && participants.includes(me);
        // The server lists both sides as room "participants" the moment an invite is
        // created (voice.rs voice_call_invite handler), well before anyone accepts —
        // it models "who belongs to this ringing room", not "who is actually on the
        // call". Treating participantMatch alone as "active call" made the callee's
        // panel render as an already-connected call (only Завершить/mute, no
        // Принять/Отклонить) the instant the invite arrived, so the call could never
        // actually be accepted and the server's 60s ringing timeout later marked it
        // missed. Ringing/calling states must render as pending, not active.
        const pendingDmCall = this.voice.status === 'incoming' || this.voice.status === 'calling';
        const connectedDmRoom = this.voice.roomType === 'dm' && !!String(this.voice.roomId || '').trim() && !pendingDmCall && (this.voice.status === 'connected' || participantMatch);
        // For a voice channel, "active" means active in THIS channel's room. Being
        // in a call elsewhere used to render this channel as the live call — with
        // the other room's participants on its tiles.
        const isThisVoiceRoom = isVoice && this.isViewingVoiceCallRoom({ requireChatView: false });
        // 'connecting' counts: between the join click and the server's room state
        // the channel should already show the call, not the «Присоединиться» card.
        const activeRoom = isVoice ? isThisVoiceRoom && this.voiceLiveCallType() === 'channel' : connectedDmRoom;
        const outgoingTarget = this.voice.outgoingInvite?.target || this.voice.targetUser || '';
        const incomingFrom = this.voice.incomingInvite?.from || this.voice.inviter || '';
        const voiceHealth = this.voiceTraceEnabled ? this.getVoiceHealthSnapshot() : [];
        // Собеседник активного звонка — через voiceDmCallPeer(): после перезагрузки
        // посреди звонка outgoingInvite пуст, а inviter — это мы сами, если звонили
        // мы, и заголовок говорил «Активный звонок с <моё имя>».
        const activePeer = this.voiceDmCallPeer() || outgoingTarget || incomingFrom;
        const title = isVoice
            ? `Голосовой канал: ${this.currentChannel()?.name || 'room'}`
            : activeRoom
                ? `Активный звонок${activePeer ? ` с ${activePeer}` : ''}`
                : this.voice.status === 'incoming'
                    ? `Входящий звонок от ${incomingFrom}`
                    : this.voice.status === 'calling'
                        ? `Звонок ${outgoingTarget ? `к ${outgoingTarget}` : ''}`
                        : this.voice.status === 'connecting'
                            ? `Соединяемся${outgoingTarget || incomingFrom ? ` с ${outgoingTarget || incomingFrom}` : ''}`
                            : 'Голосовые вызовы';

        const actionButtons = [];
        if (isVoice) {
            if (activeRoom) {
                actionButtons.push(this.callCtrlBtn({ id: 'voiceLeaveBtn', kind: 'phone-down', label: 'Покинуть', short: 'Покинуть', danger: true }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceMuteBtn', kind: this.voice.muted ? 'mic-off' : 'mic', label: this.voice.muted ? 'Включить микрофон' : 'Выключить микрофон', short: 'Микрофон', active: !this.voice.muted }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceDeafenBtn', kind: this.voice.deafened ? 'headphones-off' : 'headphones', label: this.voice.deafened ? 'Включить звук' : 'Выключить звук', short: 'Звук', active: !this.voice.deafened, danger: this.voice.deafened }));
                actionButtons.push(this.cameraCtrlSplit({ id: 'voiceCameraBtn', kind: this.voice.cameraOn ? 'cam' : 'cam-off', label: this.voice.cameraOn ? 'Выключить камеру' : 'Включить камеру', short: 'Камера', active: this.voice.cameraOn }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceScreenShareBtn', kind: this.voice.screenSharing ? 'screen' : 'screen-off', label: this.voice.screenSharing ? 'Остановить показ экрана' : 'Показать экран', short: 'Экран', active: this.voice.screenSharing }));
            } else {
                actionButtons.push(`<button class="voice-btn voice-join-big" type="button" id="voiceJoinBtn">${this.voiceIcon('phone')}<span>Зайти в канал</span></button>`);
            }
        } else if (this.S.navMode === 'dm' && this.S.current) {
            if (activeRoom) {
                actionButtons.push(this.callCtrlBtn({ id: 'voiceLeaveBtn', kind: 'phone-down', label: 'Завершить', short: 'Завершить', danger: true }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceMuteBtn', kind: this.voice.muted ? 'mic-off' : 'mic', label: this.voice.muted ? 'Включить микрофон' : 'Выключить микрофон', short: 'Микрофон', active: !this.voice.muted }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceDeafenBtn', kind: this.voice.deafened ? 'headphones-off' : 'headphones', label: this.voice.deafened ? 'Включить звук' : 'Выключить звук', short: 'Звук', active: !this.voice.deafened, danger: this.voice.deafened }));
                actionButtons.push(this.cameraCtrlSplit({ id: 'voiceCameraBtn', kind: this.voice.cameraOn ? 'cam' : 'cam-off', label: this.voice.cameraOn ? 'Выключить камеру' : 'Включить камеру', short: 'Камера', active: this.voice.cameraOn }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceScreenShareBtn', kind: this.voice.screenSharing ? 'screen' : 'screen-off', label: this.voice.screenSharing ? 'Остановить показ экрана' : 'Показать экран', short: 'Экран', active: this.voice.screenSharing }));
            } else if (this.voice.status === 'incoming' && this.voice.incomingInvite?.from) {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceAcceptBtn">${this.voiceIcon('phone')}<span>Принять</span></button>`);
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceRejectBtn">${this.voiceIcon('phone-down')}<span>Отклонить</span></button>`);
            } else if (this.voice.status === 'calling') {
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceCancelBtn">${this.voiceIcon('phone-down')}<span>Отменить</span></button>`);
            } else {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceCallBtn">${this.voiceIcon('phone')}<span>Позвонить</span></button>`);
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceVideoCallBtn">${this.voiceIcon('video')}<span>Видеозвонок</span></button>`);
            }
        }
        const actionsBarClass = activeRoom ? 'voice-room-actions call-ctrl-bar' : 'voice-room-actions';

        // A live call never renders a bar here any more: the slim bar lives in
        // #voiceCallStrip above every tab (renderVoiceCallStrip). Inside its own
        // voice channel the call is the whole view; a DM call only takes over the
        // chat when the user opened the fullscreen grid.
        // The call timer is owned by renderVoiceCallStrip, which runs on every
        // renderVoicePanel — not here, where a non-call view used to stop it.
        if (activeRoom) {
            this.stopVoicePresencePoll();
            if (isVoice) return this.renderVoiceCallExpanded({ title, actionButtons, embedded: true });
            return this.voice.expanded ? this.renderVoiceCallExpanded({ title, actionButtons }) : '';
        }

        // Голосовой канал, в котором мы не состоим: превью (кто сейчас внутри) и
        // большая кнопка входа внизу — на месте панели управления звонком.
        if (isVoice) {
            this.ensureVoicePresencePoll();
            return this.renderVoiceCallExpanded({ title, actionButtons, embedded: true, preview: { names: this.voicePresenceNames(), states: this.voicePresenceStates() } });
        }
        this.stopVoicePresencePoll();

        const sub = isVoice
            ? 'Нажмите «Присоединиться», чтобы войти в канал'
            : this.voice.status === 'connected' ? 'Собеседник поднял трубку' : this.voice.status === 'incoming' ? 'Входящий звонок' : this.voice.status === 'calling' ? 'Ожидание ответа' : this.voice.status === 'connecting' ? 'Соединяемся' : 'Голос готов';
        return `
            <div class="voice-room-card ${activeRoom ? 'active' : ''} ${isVoice ? 'voice-channel' : ''}" data-voice-status="${this.esc(String(this.voice.status || 'idle'))}">
                <div class="voice-room-top">
                    <div>
                        <div class="voice-room-title">${this.esc(title)}</div>
                        <div class="voice-room-sub">${this.esc(sub)}</div>
                    </div>
                    <div class="voice-room-state">${this.esc(activeRoom ? 'В эфире' : isVoice ? 'Выбрано' : 'Ожидание')}</div>
                </div>
                ${this.voice.micError ? `<div class="voice-room-alert">${this.esc(this.voice.micError)}</div>` : ''}
                <div class="voice-stage" id="voiceStage"></div>
                ${isVoice ? '' : this.renderVoiceTiles()}
                <div class="${actionsBarClass}">${actionButtons.join('')}</div>
                ${voiceHealth.length ? `
                    <div class="voice-health">
                        <div class="voice-room-label">Voice health</div>
                        <div class="voice-health-grid">
                            ${voiceHealth.map(item => `
                                <div class="voice-health-card" data-tone="${this.esc(item.tone)}">
                                    <span class="voice-health-name">${this.esc(item.label)}</span>
                                    <strong class="voice-health-value">${this.esc(item.value)}</strong>
                                    <span class="voice-health-sub">${this.esc(item.sub || '')}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
                ${Array.isArray(this.voice.traceLines) && this.voice.traceLines.length ? `
                    <div class="voice-trace">
                        <div class="voice-room-label">Трассировка</div>
                        <div class="voice-trace-list">
                            ${this.voice.traceLines.slice(-8).map(line => `
                                <div class="voice-trace-line voice-trace-${this.esc(line.level.toLowerCase())}">
                                    <span class="voice-trace-ts">[${this.esc(line.ts)}]</span>
                                    <span class="voice-trace-stage">${this.esc(line.stage)}</span>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>
        `;
    }

    // Coalesces bursts of voice-panel refreshes (ICE candidate storms, rapid state
    // flips) into one render per window instead of one innerHTML rebuild per event.
    scheduleRenderVoicePanel(delayMs = 100) {
        if (this._voicePanelRenderTimer) return;
        this._voicePanelRenderTimer = setTimeout(() => {
            this._voicePanelRenderTimer = null;
            this.renderVoicePanel();
        }, Math.max(0, Number(delayMs) || 0));
    }

    renderVoicePanel() {
        // Every voice-state transition (ringing → answered/declined/missed/ended)
        // calls renderVoicePanel(), so syncing the ringtone here — rather than at
        // each individual transition site — guarantees it always stops, including
        // paths that don't go through resetVoiceState (e.g. the caller cancelling).
        if (this.hasRingingIncomingInvite()) {
            this.startRingtone();
        } else {
            this.stopRingtone();
        }
        this.renderVoicePanelBody();
        this.syncVoiceMemberState();
        // Список каналов слева показывает, кто сидит в голосовых каналах: любое
        // изменение звонка (вход, выход, состав, значки) отражается и там.
        if (this.S.navMode === 'servers') this.renderServers?.();
        // After the panel: whether the strip shows depends on what the panel
        // just decided to cover (a voice channel's own view, a DM's fullscreen grid).
        this.renderVoiceCallStrip();
        this.renderChatHeaderCallState();
    }

    renderVoicePanelBody() {
        const panel = document.getElementById('voicePanel');
        if (!panel) return;
        const isServers = this.S.navMode === 'servers';
        const isVoiceChannel = isServers && this.isVoiceChannel(this.currentChannel());
        // A voice channel has no text chat: its view is the call (or the join
        // card), with the message list and composer hidden by this class.
        document.getElementById('viewChat')?.classList.toggle('voice-channel-view', isVoiceChannel);
        // Звонящий входящий в панели чата не рисуется: он — одна строка в полосе
        // над вкладками (renderVoiceCallStrip), видимая с любого экрана.
        // И исходящий, пока не ответили, — тоже не карточка: шапка чата или
        // строка сверху (renderChatHeaderCallState / renderVoiceCallStrip).
        const ringingDm = this.voice.status === 'incoming' || this.voice.status === 'calling';
        const hasDmCall = !ringingDm && this.voice.roomType === 'dm';
        const html = (isVoiceChannel || hasDmCall) ? this.renderVoiceRoomView() : '';
        if (!html) {
            panel.hidden = true;
            panel.innerHTML = '';
            panel.classList.remove('has-stage', 'call-bar-mode', 'call-expanded-mode', 'call-room-mode');
            this._voiceTileNodes = null;
            this._voicePanelHtml = '';
            this.stopVoicePresencePoll();
            return;
        }
        panel.hidden = false;
        // An active screen share needs more than the normal half-screen cap
        // (see .voice-panel.has-stage in style.css) — the stage tiles alone can
        // run well past that at their 16:9 aspect ratio.
        const hasStage = !!(this.voice.screenSharing || this.voice.remoteScreens?.size);
        panel.classList.toggle('has-stage', hasStage);
        // Разметка не изменилась (переключение вкладки, повторный вызов из
        // вспомогательных обновлений): DOM уже верный, а пересборка innerHTML
        // выбрасывает каждый <video> из документа и вставляет заново — на кадр-два
        // превью камеры и демонстрации экрана гаснут, это и было «мигание».
        // Оставляем узлы как есть и лишь донастраиваем видео.
        if (this._voicePanelHtml === html && panel.firstElementChild) {
            this.mountVoiceVideoElements();
            return;
        }
        // Часы в разметку не входят (data-voice-timer, fillVoiceCallTimers): с ними HTML
        // менялся каждую секунду, и любая перерисовка шла сюда — каждый <video> камеры
        // вынимался из документа и вставлялся заново, плитка мигала чёрным.
        const videos = panel.querySelectorAll('video').length;
        if (videos) this.voiceDiag?.('voice-panel-rebuild', { videos });
        this._voicePanelHtml = html;
        panel.innerHTML = html;
        this.fillVoiceCallTimers();
        // The fullscreen DM grid is an overlay over the whole chat; a voice
        // channel's embedded call just fills the panel's own grid row.
        panel.classList.remove('call-bar-mode');
        panel.classList.toggle('call-expanded-mode', !!panel.querySelector('#voiceCallExpanded:not(.embedded)'));
        panel.classList.toggle('call-room-mode', !!panel.querySelector('#voiceCallExpanded.embedded'));
        this.mountVoiceVideoElements();
    }

    voiceCallClockLabel() {
        const since = Number(this.voice.activeSince || 0);
        return since ? this.formatCallClock(Date.now() - since) : '0:00';
    }

    // The call the strip stands for: 'channel' for a voice channel room we are
    // in (or joining), 'dm' for a DM call past ringing, '' for none.
    voiceLiveCallType() {
        const roomId = String(this.voice.roomId || '').trim();
        if (!roomId) return '';
        const status = String(this.voice.status || '');
        const me = String(this.myName() || '').trim().toLowerCase();
        const joined = !!me && (Array.isArray(this.voice.participants) ? this.voice.participants : [])
            .some(name => String(name || '').trim().toLowerCase() === me);
        if (this.voice.roomType === 'channel') {
            return (joined || status === 'connecting' || status === 'connected') ? 'channel' : '';
        }
        if (this.voice.roomType === 'dm') {
            if (status === 'incoming' || status === 'calling') return '';
            return (joined || status === 'connected') ? 'dm' : '';
        }
        return '';
    }

    // Whether the selected channel is the voice channel whose room we are in.
    // With requireChatView, also that the chat view (not Hub/Settings) is on screen.
    isViewingVoiceCallRoom({ requireChatView = true } = {}) {
        const roomId = String(this.voice.roomId || '').trim();
        if (!roomId || this.voice.roomType !== 'channel' || this.S.navMode !== 'servers') return false;
        const server = this.currentServer();
        const channel = this.currentChannel();
        if (!server || !channel || !this.isVoiceChannel(channel)) return false;
        if (this.voiceRoomKeyForChannel(server.id, channel.id) !== roomId) return false;
        return !requireChatView || !!document.getElementById('viewChat')?.classList.contains('active');
    }

    voiceDmCallPeer() {
        const me = String(this.myName() || '').trim().toLowerCase();
        const candidates = [
            this.voice.callTrack?.peer,
            ...(Array.isArray(this.voice.participants) ? this.voice.participants : []),
            this.voice.outgoingInvite?.target,
            this.voice.targetUser,
            this.voice.inviter,
        ];
        for (const candidate of candidates) {
            const name = String(candidate || '').trim();
            if (name && name.toLowerCase() !== me) return name;
        }
        return '';
    }

    // Named after the call's own room, not the selected channel — the strip is
    // shown precisely while the user is somewhere else.
    voiceLiveCallTitle(type) {
        if (type === 'channel') {
            const server = (this.S.servers || []).find(item => item.id === this.voice.serverId);
            const channel = (server?.channels || []).find(item => item.id === this.voice.channelId);
            return `Голосовой канал: ${channel?.name || 'room'}`;
        }
        const peer = this.voiceDmCallPeer();
        return peer ? `Звонок с ${peer}` : 'Звонок';
    }

    // The slim bar above every tab while a call is live. Hidden only where the
    // call itself is already on screen: its voice channel, or a DM's open grid.
    renderVoiceCallStrip() {
        const type = this.voiceLiveCallType();
        // The sidebar marks the voice channel we are in. This runs on every
        // voice-panel render, so the list is refreshed only when that changes.
        const sidebarCallKey = type === 'channel' ? String(this.voice.roomId || '') : '';
        if (sidebarCallKey !== this._sidebarCallKey) {
            this._sidebarCallKey = sidebarCallKey;
            if (this.S.navMode === 'servers') this.renderContacts();
        }
        // The call clock lives here because this runs on every renderVoicePanel
        // whatever tab is open; the room views are not always rendered.
        if (type) {
            if (!this.voice.activeSince) {
                this.voice.activeSince = Number(this.voice.callTrack?.connectedAt) || Date.now();
            }
            this.startVoiceCallBarTimer();
        } else {
            this.voice.activeSince = 0;
            this.stopVoiceCallBarTimer();
        }
        // Компактный идущий звонок в титлбаре — всегда, пока звонок идёт: это его
        // постоянное место (таймер открывает полный интерфейс).
        const titleCall = document.getElementById('tbCall');
        if (titleCall) {
            const html = type ? this.renderVoiceCompactCall({ title: this.voiceLiveCallTitle(type) }) : '';
            if (html !== this._voiceTitleCallHtml) {
                titleCall.innerHTML = html;
                this._voiceTitleCallHtml = html;
            }
            titleCall.hidden = !type;
        }
        if (type) this.fillVoiceCallTimers();
        const strip = document.getElementById('voiceCallStrip');
        if (!strip) return;
        const main = strip.parentElement;
        const setStrip = (kind, html) => {
            main?.classList.toggle('has-call-strip', !!kind);
            main?.classList.toggle('has-incoming-strip', kind === 'incoming');
            main?.classList.toggle('has-live-strip', kind === 'live');
            if (kind) strip.dataset.kind = kind;
            else delete strip.dataset.kind;
            if (html !== this._voiceStripHtml) {
                strip.innerHTML = html;
                this._voiceStripHtml = html;
            }
            strip.hidden = !kind;
            if (kind === 'live') this.fillVoiceCallTimers();
        };
        // Звонящий входящий занимает полосу везде — в том числе поверх
        // голосового канала, где пользователь скорее всего и находится.
        // …но если открыт чат именно с этим человеком, звонок уже в его шапке.
        const ringing = this.voiceRingingState();
        if (ringing) {
            // Развёрнутый аддон хаба закрывает приложение целиком — входящий его сворачивает.
            if (ringing.kind === 'incoming') this.collapseAddonForIncomingCall?.(this.voice.incomingInvite);
            if (this.isRingingInChatHeader(ringing)) setStrip('', '');
            else if (ringing.kind === 'incoming') setStrip('incoming', this.renderVoiceIncomingStrip(this.voice.incomingInvite));
            else setStrip('incoming', this.renderVoiceOutgoingStrip(ringing.peer));
            return;
        }
        // Полоса идущего звонка — для телефона: там нет титлбара. На десктопе её
        // прячет CSS (#voiceCallStrip[data-kind="live"]), звонок живёт в титлбаре.
        const chatOpen = !!document.getElementById('viewChat')?.classList.contains('active');
        const coveredByCall = type === 'channel'
            ? this.isViewingVoiceCallRoom()
            : type === 'dm' && chatOpen && !!this.voice.expanded;
        if (!type || coveredByCall) {
            setStrip('', '');
            return;
        }
        setStrip('live', this.renderVoiceCompactCall({ title: this.voiceLiveCallTitle(type) }));
    }

    // Звонок, который сейчас звонит (ещё не начался): входящий или исходящий
    // личный; null — ничего не звонит.
    voiceRingingState() {
        if (this.hasRingingIncomingInvite()) {
            return { kind: 'incoming', peer: String(this.voice.incomingInvite?.from || '').trim() };
        }
        if (this.voice.status === 'calling') {
            const peer = String(this.voice.outgoingInvite?.target || this.voice.targetUser || '').trim();
            if (peer) return { kind: 'outgoing', peer };
        }
        return null;
    }

    // Открыт ли сейчас чат именно с тем, кто звонит / кому звоним, — тогда
    // звонок рисуется прямо в его шапке.
    isRingingInChatHeader(ringing = this.voiceRingingState()) {
        if (!ringing?.peer || this.S.navMode !== 'dm') return false;
        if (!document.getElementById('viewChat')?.classList.contains('active')) return false;
        return String(this.S.current || '').trim().toLowerCase() === ringing.peer.toLowerCase();
    }

    // Пока звонок звонит, шапка чата с этим человеком сама становится звонком:
    // той же высоты, аватар пульсирует, под именем — статус, на месте трубки и
    // камеры — «Отклонить / Принять» или «Отменить».
    renderChatHeaderCallState() {
        const hdr = document.getElementById('chatHdr');
        const note = document.getElementById('chatHdrCallNote');
        const ctl = document.getElementById('chatHdrCallCtl');
        if (!hdr || !note || !ctl) return;
        const ringing = this.voiceRingingState();
        const show = !!ringing && this.isRingingInChatHeader(ringing);
        const kind = show ? ringing.kind : '';
        hdr.classList.toggle('is-ringing', show);
        hdr.dataset.ringKind = kind;
        note.hidden = !show;
        ctl.hidden = !show;
        const noteText = kind === 'incoming' ? 'Входящий звонок…' : kind === 'outgoing' ? 'Вызов…' : '';
        if (note.textContent !== noteText) note.textContent = noteText;
        const html = kind === 'incoming'
            ? this.ringingButton('reject', 'Отклонить', 'phone-down') + this.ringingButton('accept', 'Принять', 'phone')
            : kind === 'outgoing'
                ? this.ringingButton('cancel', 'Отменить', 'phone-down')
                : '';
        if (ctl.innerHTML !== html) ctl.innerHTML = html;
    }

    ringingButton(action, label, icon) {
        const cls = action === 'accept' ? 'is-accept' : 'is-decline';
        return `<button class="voice-incoming-btn ${cls}" type="button" data-ring-action="${this.esc(action)}" title="${this.esc(label)}" aria-label="${this.esc(label)}">${this.voiceIcon(icon)}<span>${this.esc(label)}</span></button>`;
    }

    // Строка сверху, когда звоним мы, а открыт другой экран.
    renderVoiceOutgoingStrip(peer) {
        const label = `Вызов ${peer}`;
        return `
            <div class="voice-incoming is-outgoing" role="group" aria-label="${this.esc(label)}">
                <div class="voice-incoming-who">
                    <span class="voice-incoming-ava" aria-hidden="true">${this.renderAvatarHTML(peer, 'avatar-img', peer)}</span>
                    <span class="voice-incoming-name">${this.esc(peer)}</span>
                    <span class="voice-incoming-note">вызов…</span>
                </div>
                <div class="voice-incoming-actions">${this.ringingButton('cancel', 'Отменить', 'phone-down')}</div>
            </div>
        `;
    }

    // Смена экрана посреди звонящего звонка: шапка или строка сверху.
    syncRingingCallPlacement() {
        if (!this.voiceRingingState() && !document.getElementById('chatHdr')?.classList.contains('is-ringing')) return;
        this.renderVoiceCallStrip();
        this.renderChatHeaderCallState();
    }

    mountVoiceVideoElements() {
        const stage = document.getElementById('voiceStage');
        if (stage) {
            // Состав сцены: [видео, подпись, закрыто ли превью]. Если он совпадает с
            // тем, что уже смонтировано, ничего не трогаем — иначе <video> вынимается
            // из документа и вставляется заново, и кадр мигает.
            // Чужой экран изначально закрыт: размытый кадр и «Смотреть». Первые
            // секунды демонстрации идут в низком разрешении (кодек ещё набирает
            // качество), и размытие прячет это; клик открывает поток. Решение
            // хранится на самом <video> (dataset.watching): новая демонстрация —
            // новый элемент — снова закрыта, а перерисовки панели его не сбрасывают.
            const wanted = [];
            if (this.voice.localScreenVideoEl && this.voice.screenSharing) {
                wanted.push([this.voice.localScreenVideoEl, 'Ваш экран', false, '']);
            }
            for (const [peer, video] of this.voice.remoteScreens.entries()) {
                wanted.push([video, `Экран: ${peer}`, !video.dataset.watching, peer]);
            }
            const tilesNow = Array.from(stage.children);
            const same = tilesNow.length === wanted.length && wanted.every(([video, text, gated], i) => {
                const tile = tilesNow[i];
                return tile.firstElementChild === video
                    && tile.querySelector('.voice-video-label')?.textContent === text
                    && tile.classList.contains('is-gated') === gated;
            });
            if (!same) {
                stage.replaceChildren();
                for (const [video, text, gated, peer] of wanted) {
                    const wrap = document.createElement('div');
                    wrap.className = `voice-stage-tile${gated ? ' is-gated' : ''}`;
                    wrap.appendChild(video);
                    const label = document.createElement('span');
                    label.className = 'voice-video-label';
                    label.textContent = text;
                    wrap.appendChild(label);
                    if (gated) {
                        const watch = document.createElement('button');
                        watch.type = 'button';
                        watch.className = 'voice-screen-watch';
                        watch.setAttribute('aria-label', `Смотреть: ${text}`);
                        watch.innerHTML = `<span class="voice-screen-watch-pill">${this.voiceIcon('screen')}<span>Смотреть</span></span>`;
                        watch.addEventListener('click', () => {
                            video.dataset.watching = '1';
                            wrap.classList.remove('is-gated');
                            watch.remove();
                            // Звук включается вместе с картинкой, не раньше; клик — это
                            // и жест пользователя, без которого браузер не даст играть.
                            this.applyScreenVolume(peer);
                            video.play?.().catch(() => {});
                        });
                        wrap.appendChild(watch);
                    }
                    // ПКМ по чужой демонстрации — громкость её звука.
                    if (peer) {
                        wrap.addEventListener('contextmenu', (event) => {
                            event.preventDefault();
                            this.openScreenContextMenu(peer, event.clientX, event.clientY);
                        });
                    }
                    stage.appendChild(wrap);
                }
            }
        }
        const tiles = document.getElementById('voiceTiles');
        if (!tiles) {
            this._voiceTileNodes = null;
            return;
        }
        // Index the tiles once per panel render. The meter loop toggles the
        // speaking ring 8×/s and used to re-run querySelectorAll on every tick;
        // the tile set only ever changes when this function rebuilds it.
        const byPeer = new Map();
        const root = document.getElementById('voiceTilesWrap') || tiles;
        for (const tile of root.querySelectorAll('.voice-tile, .voice-dot')) {
            byPeer.set(tile.dataset.peer || '', tile);
        }
        this._voiceTileNodes = byPeer;
        // Сначала — какое видео должно стоять в какой плитке, потом — минимальная
        // правка: уже стоящее на месте видео не трогаем (вынуть и вставить
        // <video> = мигающий кадр), лишнее убираем.
        const wantedVideo = new Map();
        const wantVideo = (peer, video) => {
            const key = String(peer || '').trim().toLowerCase();
            if (!key || !video || !byPeer.get(key)?.querySelector('.voice-tile-media')) return;
            wantedVideo.set(key, video);
        };
        if (this.voice.cameraOn) wantVideo(this.myName(), this.voice.localVideoEl);
        for (const [peer, video] of this.voice.remoteVideos.entries()) {
            wantVideo(peer, video);
        }
        for (const [key, tile] of byPeer) {
            const media = tile.querySelector('.voice-tile-media');
            if (!media) continue;
            const video = wantedVideo.get(key);
            if (!video) {
                if (media.childNodes.length) media.replaceChildren();
                tile.classList.remove('has-video');
                continue;
            }
            if (media.childNodes.length !== 1 || media.firstChild !== video) media.replaceChildren(video);
            // Аватар прячется только когда у видео есть первый кадр: раньше класс
            // ставился сразу, и до прихода кадра плитка была просто чёрной.
            const ready = video.readyState >= 2;
            tile.classList.toggle('has-video', ready);
            if (!ready && !video._readyHook) {
                video._readyHook = true;
                const onReady = () => {
                    video._readyHook = false;
                    video.closest('.voice-tile, .voice-dot')?.classList.add('has-video');
                };
                video.addEventListener('loadeddata', onReady, { once: true });
                video.addEventListener('playing', onReady, { once: true });
            }
        }
        this.applyVoiceSpeakingState();
        this.fitVoiceTiles();
    }

    // Discord's "green ring while talking". Driven straight from the meter loop
    // (updateVoiceMeters) by toggling a class on existing tiles — never by
    // re-rendering the panel, which would tear down and remount every <video>
    // element several times a second.
    applyVoiceSpeakingState(levels = this._voiceTileLevels) {
        this._voiceTileLevels = levels || {};
        const byPeer = this._voiceTileNodes;
        if (!byPeer || !byPeer.size) return;
        const SPEAKING_THRESHOLD = 12; // percent, same scale as the meters
        // Кольцо уровня вокруг аватара (или рамка видео-плитки) заполняется от
        // нижней точки в обе стороны: --voice-level 0…1, полное кольцо — на
        // ~60 % шкалы, где уже громкая речь. Пишется только при заметном
        // изменении, чтобы 8 обновлений в секунду не трогали стиль впустую.
        const LEVEL_FULL = 60;
        const SPEAKING_HOLD_MS = 350;
        const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        for (const [peer, tile] of byPeer) {
            const percent = Number(this._voiceTileLevels[peer] || 0);
            // Мгновенный уровень анализатора рваный (слоги, паузы, шум): кольцо
            // прыгало на каждом замере. Сглаживаем: рост быстрый (чтобы начало речи
            // не запаздывало), спад медленный (чтобы кольцо не дёргалось в паузах).
            const target = Math.min(1, percent / LEVEL_FULL);
            const prev = tile._voiceSmooth || 0;
            let smooth = prev + (target - prev) * (target > prev ? 0.5 : 0.16);
            if (smooth < 0.015) smooth = 0;
            tile._voiceSmooth = smooth;
            const level = Math.round(smooth * 50) / 50;
            if (tile._voiceLevel !== level) {
                tile._voiceLevel = level;
                tile.style.setProperty('--voice-level', String(level));
            }
            // «Говорит» держится ещё долю секунды после последнего громкого замера —
            // иначе обводка мигала на каждой паузе между словами.
            if (percent >= SPEAKING_THRESHOLD) tile._speakUntil = now + SPEAKING_HOLD_MS;
            const speaking = now < (tile._speakUntil || 0);
            // classList.toggle with an explicit force flag still writes the
            // attribute every call, which dirties style on tiles that did not
            // change. Only touch the ones whose state actually flipped.
            if (tile.classList.contains('speaking') !== speaking) {
                tile.classList.toggle('speaking', speaking);
            }
        }
    }
});
