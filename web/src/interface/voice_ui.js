// --- ZaliInterface: Отрисовка голосовой панели, плиток и развёрнутого звонка. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    voiceIcon(kind) {
        const phone = '<path d="M6.15 4.4c-.92.16-1.62.9-1.72 1.83-.67 6.32 6.98 13.97 13.3 13.3.93-.1 1.67-.8 1.83-1.72l.36-2.08a1.18 1.18 0 0 0-.76-1.32l-3.18-1.16a1.22 1.22 0 0 0-1.27.3l-1.1 1.06a10.4 10.4 0 0 1-4.22-4.22l1.06-1.1c.34-.35.45-.86.3-1.27L9.59 4.84a1.18 1.18 0 0 0-1.32-.76l-2.12.32Z" stroke="currentColor" stroke-width="2.1" stroke-linejoin="round"/>';
        const mic = '<rect x="9" y="3" width="6" height="10" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M5 11a7 7 0 0 0 14 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 18v3M9 21h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>';
        const cam = '<rect x="3.5" y="6.5" width="12" height="11" rx="2.2" stroke="currentColor" stroke-width="1.8"/><path d="M15.5 10.4 20 7.6a.6.6 0 0 1 .92.51v7.78a.6.6 0 0 1-.92.51l-4.5-2.8" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>';
        const screen = '<rect x="3" y="4.5" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 20h7M12 16.5v3.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M12 6.5v6M9.5 10 12 7.5 14.5 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
        const headphones = '<path d="M4.5 13.5v-1.7a7.5 7.5 0 0 1 15 0v1.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><rect x="3" y="13" width="4" height="6.2" rx="1.7" stroke="currentColor" stroke-width="1.8"/><rect x="17" y="13" width="4" height="6.2" rx="1.7" stroke="currentColor" stroke-width="1.8"/>';
        const chevronDown = '<path d="M6 9l6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
        const slash = '<path d="M19.5 4.5l-15 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
        const icons = {
            phone,
            'phone-off': phone + slash,
            mic,
            'mic-off': mic + slash,
            cam,
            'cam-off': cam + slash,
            screen,
            'screen-off': screen + slash,
            video: cam,
            headphones,
            'headphones-off': headphones + slash,
            'chevron-down': chevronDown,
        };
        return `<svg class="call-ctrl-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true" focusable="false">${icons[kind] || ''}</svg>`;
    }

    callCtrlBtn({ id, kind, label, active = false, danger = false }) {
        const cls = ['call-ctrl-btn', active ? 'active' : '', danger ? 'danger' : ''].filter(Boolean).join(' ');
        return `<button class="${cls}" type="button" id="${id}" title="${this.esc(label)}" aria-label="${this.esc(label)}">${this.voiceIcon(kind)}</button>`;
    }

    // Discord-style call stage: one rectangular tile per participant, avatar in
    // the middle, name badge at the bottom — the tile *is* the participant list,
    // and it's also where that participant's camera feed mounts (see
    // mountVoiceVideoElements, which fills `.voice-tile-media` by data-peer).
    // Keyed on the lowercased name because every other voice code path
    // (participants, remoteVideos, remoteAudios) normalises that way.
    renderVoiceTiles() {
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
        push(this.myName());
        for (const name of (Array.isArray(this.voice.participants) ? this.voice.participants : [])) push(name);
        // Someone whose media arrived before the room-state snapshot listing them
        // would otherwise have a video element with no tile to mount into.
        for (const name of this.voice.remoteVideos.keys()) push(name);
        for (const name of this.voice.remoteAudios.keys()) push(name);

        if (!participants.length) {
            return '<div class="voice-empty">Пока никого нет</div>';
        }
        const myName = String(this.myName() || '').trim().toLowerCase();
        return `<div class="voice-tiles" id="voiceTiles">` + participants.map(name => {
            const key = name.toLowerCase();
            const mine = key === myName;
            // Mute state is only known for ourselves — the protocol carries no
            // per-peer mic state, so no badge is drawn for remote participants
            // rather than a badge that would be a guess.
            const muted = mine && !!this.voice.muted;
            return `
                <div class="voice-tile ${mine ? 'mine' : ''}" data-peer="${this.esc(key)}">
                    <div class="voice-tile-media"></div>
                    <div class="voice-tile-avatar">${this.renderAvatarHTML(name, 'voice-tile-ava', name)}</div>
                    <div class="voice-tile-footer">
                        ${muted ? `<span class="voice-tile-mic muted" title="Микрофон выключен">${this.voiceIcon('mic-off')}</span>` : ''}
                        <span class="voice-tile-name">${this.esc(name)}</span>
                    </div>
                </div>
            `;
        }).join('') + `</div>`;
    }

    // Collapsed call UI: mute + deafen on the left, peer/channel name centered,
    // running timer on the right. Tapping anywhere on the bar except those two
    // buttons expands to renderVoiceCallExpanded (wired in the #voicePanel
    // click delegate).
    renderVoiceCallBar({ title }) {
        const muteLabel = this.voice.muted ? 'Включить микрофон' : 'Выключить микрофон';
        const deafenLabel = this.voice.deafened ? 'Включить звук' : 'Выключить звук';
        return `
            <div class="voice-callbar" id="voiceCallBar" role="button" tabindex="0" aria-label="Развернуть звонок">
                <div class="voice-callbar-controls">
                    <button class="voice-callbar-btn" type="button" id="voiceMuteBtn" title="${this.esc(muteLabel)}" aria-label="${this.esc(muteLabel)}">${this.voiceIcon(this.voice.muted ? 'mic-off' : 'mic')}</button>
                    <button class="voice-callbar-btn ${this.voice.deafened ? 'danger' : ''}" type="button" id="voiceDeafenBtn" title="${this.esc(deafenLabel)}" aria-label="${this.esc(deafenLabel)}">${this.voiceIcon(this.voice.deafened ? 'headphones-off' : 'headphones')}</button>
                </div>
                <div class="voice-callbar-title">${this.esc(title)}</div>
                <div class="voice-callbar-timer" id="voiceCallTimer">0:00</div>
            </div>
        `;
    }

    // Fullscreen (within the chat window) call view: dynamic grid of 16:9 tiles,
    // one per participant, reusing renderVoiceTiles()/mountVoiceVideoElements()
    // as-is so a participant's camera feed replaces their tile exactly like it
    // already does in the collapsed layout — nothing about tile mounting changes,
    // only where the tiles are shown.
    renderVoiceCallExpanded({ title, actionButtons }) {
        return `
            <div class="voice-call-expanded" id="voiceCallExpanded">
                <div class="voice-call-expanded-header" id="voiceCollapseBar" role="button" tabindex="0" aria-label="Свернуть звонок">
                    <button class="voice-call-collapse-btn" type="button" id="voiceCollapseBtn" title="Свернуть" aria-label="Свернуть">${this.voiceIcon('chevron-down')}</button>
                    <div class="voice-call-expanded-title">${this.esc(title)}</div>
                    <div class="voice-call-expanded-timer" id="voiceCallExpandedTimer">0:00</div>
                </div>
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
        const activeRoom = isVoice ? !!this.voice.roomId && participantMatch : connectedDmRoom;
        const outgoingTarget = this.voice.outgoingInvite?.target || this.voice.targetUser || '';
        const incomingFrom = this.voice.incomingInvite?.from || this.voice.inviter || '';
        const voiceHealth = this.voiceTraceEnabled ? this.getVoiceHealthSnapshot() : [];
        const title = isVoice
            ? `Голосовой канал: ${this.currentChannel()?.name || 'room'}`
            : activeRoom
                ? `Активный звонок${outgoingTarget || incomingFrom ? ` с ${outgoingTarget || incomingFrom}` : ''}`
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
                actionButtons.push(this.callCtrlBtn({ id: 'voiceLeaveBtn', kind: 'phone-off', label: 'Покинуть', danger: true }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceMuteBtn', kind: this.voice.muted ? 'mic-off' : 'mic', label: this.voice.muted ? 'Включить микрофон' : 'Выключить микрофон', active: !this.voice.muted }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceDeafenBtn', kind: this.voice.deafened ? 'headphones-off' : 'headphones', label: this.voice.deafened ? 'Включить звук' : 'Выключить звук', active: !this.voice.deafened, danger: this.voice.deafened }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceCameraBtn', kind: this.voice.cameraOn ? 'cam' : 'cam-off', label: this.voice.cameraOn ? 'Выключить камеру' : 'Включить камеру', active: this.voice.cameraOn }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceScreenShareBtn', kind: this.voice.screenSharing ? 'screen' : 'screen-off', label: this.voice.screenSharing ? 'Остановить показ экрана' : 'Показать экран', active: this.voice.screenSharing }));
            } else {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceJoinBtn">${this.voiceIcon('phone')}<span>Присоединиться</span></button>`);
            }
        } else if (this.S.navMode === 'dm' && this.S.current) {
            if (activeRoom) {
                actionButtons.push(this.callCtrlBtn({ id: 'voiceLeaveBtn', kind: 'phone-off', label: 'Завершить', danger: true }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceMuteBtn', kind: this.voice.muted ? 'mic-off' : 'mic', label: this.voice.muted ? 'Включить микрофон' : 'Выключить микрофон', active: !this.voice.muted }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceDeafenBtn', kind: this.voice.deafened ? 'headphones-off' : 'headphones', label: this.voice.deafened ? 'Включить звук' : 'Выключить звук', active: !this.voice.deafened, danger: this.voice.deafened }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceCameraBtn', kind: this.voice.cameraOn ? 'cam' : 'cam-off', label: this.voice.cameraOn ? 'Выключить камеру' : 'Включить камеру', active: this.voice.cameraOn }));
                actionButtons.push(this.callCtrlBtn({ id: 'voiceScreenShareBtn', kind: this.voice.screenSharing ? 'screen' : 'screen-off', label: this.voice.screenSharing ? 'Остановить показ экрана' : 'Показать экран', active: this.voice.screenSharing }));
            } else if (this.voice.status === 'incoming' && this.voice.incomingInvite?.from) {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceAcceptBtn">${this.voiceIcon('phone')}<span>Принять</span></button>`);
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceRejectBtn">${this.voiceIcon('phone-off')}<span>Отклонить</span></button>`);
            } else if (this.voice.status === 'calling') {
                actionButtons.push(`<button class="voice-btn danger" type="button" id="voiceCancelBtn">${this.voiceIcon('phone-off')}<span>Отменить</span></button>`);
            } else {
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceCallBtn">${this.voiceIcon('phone')}<span>Позвонить</span></button>`);
                actionButtons.push(`<button class="voice-btn" type="button" id="voiceVideoCallBtn">${this.voiceIcon('video')}<span>Видеозвонок</span></button>`);
            }
        }
        const actionsBarClass = activeRoom ? 'voice-room-actions call-ctrl-bar' : 'voice-room-actions';

        // A live call (as opposed to ringing/dialing/idle-selected) collapses to a
        // slim top bar by default and only shows the full participant grid when
        // the user taps it — the old always-expanded card ate half the chat
        // window for the entire duration of every call.
        if (activeRoom) {
            if (!this.voice.activeSince) {
                this.voice.activeSince = Number(this.voice.callTrack?.connectedAt) || Date.now();
            }
            this.startVoiceCallBarTimer();
            return this.voice.expanded
                ? this.renderVoiceCallExpanded({ title, actionButtons })
                : this.renderVoiceCallBar({ title });
        }
        this.voice.activeSince = 0;
        this.stopVoiceCallBarTimer();

        return `
            <div class="voice-room-card ${activeRoom ? 'active' : ''} ${isVoice ? 'voice-channel' : ''}">
                <div class="voice-room-top">
                    <div>
                        <div class="voice-room-title">${this.esc(title)}</div>
                        <div class="voice-room-sub">${this.esc(this.voice.status === 'connected' ? 'Собеседник поднял трубку' : this.voice.status === 'incoming' ? 'Входящий звонок' : this.voice.status === 'calling' ? 'Ожидание ответа' : this.voice.status === 'connecting' ? 'Соединяемся' : 'Голос готов')}</div>
                    </div>
                    <div class="voice-room-state">${this.esc(activeRoom ? 'В эфире' : isVoice ? 'Выбрано' : 'Ожидание')}</div>
                </div>
                ${this.voice.micError ? `<div class="voice-room-alert">${this.esc(this.voice.micError)}</div>` : ''}
                <div class="voice-stage" id="voiceStage"></div>
                ${this.renderVoiceTiles()}
                <div class="${actionsBarClass}">${actionButtons.join('')}</div>
                <div class="voice-meter-grid">
                    <div class="voice-meter" id="voiceMicMeter">
                        <div class="voice-meter-head">
                            <span class="voice-meter-name">Микрофон</span>
                            <span class="voice-meter-value" id="voiceMicLevelText">0%</span>
                        </div>
                        <div class="voice-meter-track">
                            <div class="voice-meter-fill" id="voiceMicLevelFill"></div>
                        </div>
                    </div>
                    <div class="voice-meter" id="voiceServerMeter">
                        <div class="voice-meter-head">
                            <span class="voice-meter-name">С сервера</span>
                            <span class="voice-meter-value" id="voiceServerLevelText">0%</span>
                        </div>
                        <div class="voice-meter-track">
                            <div class="voice-meter-fill remote" id="voiceServerLevelFill"></div>
                        </div>
                    </div>
                </div>
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
        if (this.voice.status === 'incoming' && this.voice.incomingInvite) {
            this.startRingtone();
        } else {
            this.stopRingtone();
        }
        const panel = document.getElementById('voicePanel');
        if (!panel) return;
        const isServers = this.S.navMode === 'servers';
        const isVoiceChannel = isServers && this.isVoiceChannel(this.currentChannel());
        const hasDmCall = this.voice.roomType === 'dm' || this.voice.status === 'incoming' || this.voice.status === 'calling';
        const hasIncoming = this.voice.status === 'incoming';
        const showPanel = isVoiceChannel || hasDmCall || hasIncoming;
        panel.hidden = !showPanel;
        if (!showPanel) {
            panel.innerHTML = '';
            return;
        }
        // An active screen share needs more than the normal half-screen cap
        // (see .voice-panel.has-stage in style.css) — the stage tiles alone can
        // run well past that at their 16:9 aspect ratio.
        const hasStage = !!(this.voice.screenSharing || this.voice.remoteScreens?.size);
        panel.classList.toggle('has-stage', hasStage);
        if (isVoiceChannel || hasDmCall || hasIncoming || this.voice.roomType === 'dm') {
            panel.innerHTML = this.renderVoiceRoomView();
            // Bar/expanded modes need layout rules (fixed slim bar vs. a fullscreen
            // overlay) that don't fit the normal embedded-card sizing in
            // .voice-panel, hence dedicated classes rather than relying on
            // .has-stage/max-height alone.
            panel.classList.toggle('call-bar-mode', !!panel.querySelector('#voiceCallBar'));
            panel.classList.toggle('call-expanded-mode', !!panel.querySelector('#voiceCallExpanded'));
            this.mountVoiceVideoElements();
            return;
        }
        panel.classList.remove('call-bar-mode', 'call-expanded-mode');
        panel.innerHTML = '';
    }

    mountVoiceVideoElements() {
        const stage = document.getElementById('voiceStage');
        if (stage) {
            stage.replaceChildren();
            if (this.voice.localScreenVideoEl && this.voice.screenSharing) {
                const wrap = document.createElement('div');
                wrap.className = 'voice-stage-tile';
                wrap.appendChild(this.voice.localScreenVideoEl);
                const label = document.createElement('span');
                label.className = 'voice-video-label';
                label.textContent = 'Ваш экран';
                wrap.appendChild(label);
                stage.appendChild(wrap);
            }
            for (const [peer, video] of this.voice.remoteScreens.entries()) {
                const wrap = document.createElement('div');
                wrap.className = 'voice-stage-tile';
                wrap.appendChild(video);
                const label = document.createElement('span');
                label.className = 'voice-video-label';
                label.textContent = `Экран: ${peer}`;
                wrap.appendChild(label);
                stage.appendChild(wrap);
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
        for (const tile of tiles.querySelectorAll('.voice-tile')) {
            tile.classList.remove('has-video');
            const media = tile.querySelector('.voice-tile-media');
            if (media) media.replaceChildren();
            byPeer.set(tile.dataset.peer || '', tile);
        }
        this._voiceTileNodes = byPeer;
        const mountVideo = (peer, video) => {
            const key = String(peer || '').trim().toLowerCase();
            if (!key || !video) return;
            const tile = byPeer.get(key);
            const media = tile?.querySelector('.voice-tile-media');
            if (!media) return;
            media.appendChild(video);
            tile.classList.add('has-video');
        };
        if (this.voice.cameraOn) mountVideo(this.myName(), this.voice.localVideoEl);
        for (const [peer, video] of this.voice.remoteVideos.entries()) {
            mountVideo(peer, video);
        }
        this.applyVoiceSpeakingState();
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
        for (const [peer, tile] of byPeer) {
            const speaking = Number(this._voiceTileLevels[peer] || 0) >= SPEAKING_THRESHOLD;
            // classList.toggle with an explicit force flag still writes the
            // attribute every call, which dirties style on tiles that did not
            // change. Only touch the ones whose state actually flipped.
            if (tile.classList.contains('speaking') !== speaking) {
                tile.classList.toggle('speaking', speaking);
            }
        }
    }
});
