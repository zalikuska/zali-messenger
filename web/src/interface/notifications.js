// --- ZaliInterface: Мьюты, звуки, уведомления, бейдж непрочитанного. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    handleAvatarUpdated({ username, deleted = false } = {}) {
        const name = String(username || '').trim();
        if (!name) return;

        if (deleted) {
            this.saveStoredAvatar(name, null);
        } else {
            this.clearStoredAvatar(name);
            this.ensureAvatarLoaded(name, { force: true });
        }

        this.scheduleAvatarRefresh();
    }

    // Single source of truth for "is this conversation currently on screen". The
    // notification-suppression, render, and unread-clear paths must all agree on this;
    // spelling it out inline at each site is how they drifted apart before.
    isServerChatVisible(key) {
        return this.currentServerChatKey() === key && this.S.navMode === 'servers';
    }

    isDmChatVisible(peer) {
        if (!peer || peer !== this.S.current) return false;
        if (this.S.navMode === 'servers') return false;
        // The Hub and Settings screens are full-view overlays, not a navMode — so a DM
        // that is "selected" is still completely off-screen while either is open. Only
        // the servers view was excluded here, which meant an incoming message for the
        // selected peer produced no notification AND no unread increment for as long as
        // the user sat on the Hub. Same class of bug as the servers-view fix above it.
        if (document.getElementById('viewHub')?.classList.contains('active')) return false;
        if (document.getElementById('viewSettings')?.classList.contains('active')) return false;
        return true;
    }

    isPeerMuted(peer) {
        return !!(this.S.mutedChats || {})[String(peer || '').trim()];
    }

    isChannelMuted(serverId, channelId) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        if (!sid || !cid) return false;
        return !!(this.S.mutedChats || {})[`${sid}:${cid}`];
    }

    toggleMutePeer(peer) {
        const key = String(peer || '').trim();
        if (!key) return;
        this.S.mutedChats = this.S.mutedChats || {};
        if (this.S.mutedChats[key]) {
            delete this.S.mutedChats[key];
        } else {
            this.S.mutedChats[key] = true;
        }
        this.saveStoredMutedChats();
        this.renderContacts();
    }

    closeContactContextMenu() {
        const existing = document.getElementById('contactContextMenu');
        if (existing) existing.remove();
        if (this._contactContextMenuOutsideHandler) {
            document.removeEventListener('click', this._contactContextMenuOutsideHandler);
            document.removeEventListener('contextmenu', this._contactContextMenuOutsideHandler);
            this._contactContextMenuOutsideHandler = null;
        }
    }

    // Right-click on a contact — notification mute (existing behavior) plus
    // per-contact call volume, applied live to that peer's WebAudio gain node
    // (see ensureRemotePlaybackNode/applyPeerVolume) when they're in a call,
    // and persisted for future calls either way.
    openContactContextMenu(peer, x, y) {
        this.closeContactContextMenu();
        const name = String(peer || '').trim();
        if (!name) return;
        const muted = !!(this.S.mutedChats || {})[name];
        const percent = this.getPeerVolumePercent(name);
        const menu = document.createElement('div');
        menu.id = 'contactContextMenu';
        menu.className = 'peer-context-menu';
        menu.innerHTML = `
            <button type="button" class="peer-context-menu-item" data-action="mute">
                <span>${muted ? 'Включить уведомления' : 'Заглушить уведомления'}</span>
            </button>
            <div class="peer-context-menu-volume">
                <span>Громкость собеседника: <strong id="contactVolumeValue">${percent}%</strong></span>
                <input type="range" min="0" max="200" step="5" value="${percent}" id="contactVolumeRange" class="settings-range">
            </div>
        `;
        document.body.appendChild(menu);

        const rect = menu.getBoundingClientRect();
        const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
        const top = Math.max(8, Math.min(y, window.innerHeight - rect.height - 8));
        menu.style.left = `${left}px`;
        menu.style.top = `${top}px`;

        menu.querySelector('[data-action="mute"]')?.addEventListener('click', () => {
            this.toggleMutePeer(name);
            this.closeContactContextMenu();
        });
        const range = menu.querySelector('#contactVolumeRange');
        const label = menu.querySelector('#contactVolumeValue');
        range?.addEventListener('input', () => {
            const value = Number(range.value) || 100;
            if (label) label.textContent = `${value}%`;
            this.setPeerVolumePercent(name, value);
        });

        const outsideHandler = (evt) => {
            if (menu.contains(evt.target)) return;
            this.closeContactContextMenu();
        };
        this._contactContextMenuOutsideHandler = outsideHandler;
        // Deferred a tick so the contextmenu event that opened this menu
        // doesn't immediately bubble into the same listener and close it.
        setTimeout(() => {
            document.addEventListener('click', outsideHandler);
            document.addEventListener('contextmenu', outsideHandler);
        }, 0);
    }

    toggleMuteChannel(serverId, channelId) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        if (!sid || !cid) return;
        const key = `${sid}:${cid}`;
        this.S.mutedChats = this.S.mutedChats || {};
        if (this.S.mutedChats[key]) {
            delete this.S.mutedChats[key];
        } else {
            this.S.mutedChats[key] = true;
        }
        this.saveStoredMutedChats();
        this.renderServerInterface();
        this.renderContacts();
    }

    // Registers a one-time listener on the very first user gesture (click/key/touch)
    // to create+resume a persistent AudioContext. Browsers require AudioContext to be
    // resumed from within a user-gesture call stack at least once per page load —
    // it doesn't have to be the same gesture that later triggers a sound, so doing
    // this once up front means playMessageChime/startRingtone can fire later from an
    // async WS event (no gesture of their own) and still be audible.
    installSoundUnlock() {
        const unlock = () => {
            if (this.sound.unlocked) return;
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            try {
                this.sound.ctx = this.sound.ctx || new AudioCtx();
                this.sound.ctx.resume?.().catch(() => {});
                this.sound.unlocked = true;
            } catch (e) {}
            document.removeEventListener('click', unlock, true);
            document.removeEventListener('keydown', unlock, true);
            document.removeEventListener('touchstart', unlock, true);
        };
        document.addEventListener('click', unlock, true);
        document.addEventListener('keydown', unlock, true);
        document.addEventListener('touchstart', unlock, true);
    }

    ensureSoundContext() {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return null;
        if (!this.sound.ctx || this.sound.ctx.state === 'closed') {
            this.sound.ctx = new AudioCtx();
            this.sound.bus = null;
        }
        if (this.sound.ctx.state === 'suspended') {
            this.sound.ctx.resume?.().catch(() => {});
        }
        return this.sound.ctx;
    }

    // Shared output bus: master gain → compressor → destination. The compressor
    // is what makes these sounds actually loud — summed partials peak well past
    // 0 dBFS otherwise, and simply lowering per-voice gain to avoid that (what
    // the first version did) is exactly why they came out quiet and thin. Here
    // the peaks get tamed instead, so average level can sit much higher.
    soundBus(ctx) {
        if (this.sound.bus && this.sound.bus.ctx === ctx) return this.sound.bus.input;
        const master = ctx.createGain();
        master.gain.value = 0.9;
        const compressor = ctx.createDynamicsCompressor();
        compressor.threshold.setValueAtTime(-18, ctx.currentTime);
        compressor.knee.setValueAtTime(20, ctx.currentTime);
        compressor.ratio.setValueAtTime(6, ctx.currentTime);
        compressor.attack.setValueAtTime(0.003, ctx.currentTime);
        compressor.release.setValueAtTime(0.25, ctx.currentTime);
        master.connect(compressor);
        compressor.connect(ctx.destination);
        this.sound.bus = { ctx, input: master };
        return master;
    }

    // One struck-bell/marimba note built additively: a set of partials above the
    // fundamental, each with its own level and its own (shorter) decay, under a
    // lowpass that closes as the note rings out. That per-partial decay is what
    // reads as a real struck instrument — the highs die away first, leaving the
    // fundamental humming. Envelopes are exponential (not linear) because
    // amplitude decay is perceived logarithmically; a linear fade sounds like a
    // synthetic bleep cut short, which was the other half of the "плохие звуки".
    playBellVoice(ctx, { frequency, startTime, duration, gain = 0.3, partials, brightness = 7 }) {
        const bus = this.soundBus(ctx);
        const voice = ctx.createGain();
        voice.gain.value = gain;
        const filter = ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.Q.value = 0.7;
        filter.frequency.setValueAtTime(Math.min(frequency * brightness, 14000), startTime);
        filter.frequency.exponentialRampToValueAtTime(
            Math.max(frequency * 1.6, 300),
            startTime + duration
        );
        voice.connect(filter);
        filter.connect(bus);

        const voicePartials = partials || [
            { ratio: 1, gain: 1, decay: 1 },
            { ratio: 2, gain: 0.42, decay: 0.62 },
            { ratio: 3, gain: 0.2, decay: 0.42 },
            { ratio: 4.16, gain: 0.11, decay: 0.28 },
            { ratio: 5.43, gain: 0.05, decay: 0.19 },
        ];
        for (const partial of voicePartials) {
            const osc = ctx.createOscillator();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(frequency * partial.ratio, startTime);
            const env = ctx.createGain();
            const partialDuration = Math.max(duration * partial.decay, 0.05);
            // exponentialRampToValueAtTime can't touch zero, hence the epsilons.
            env.gain.setValueAtTime(0.0001, startTime);
            env.gain.exponentialRampToValueAtTime(partial.gain, startTime + 0.006);
            env.gain.exponentialRampToValueAtTime(0.0001, startTime + partialDuration);
            osc.connect(env);
            env.connect(voice);
            osc.start(startTime);
            osc.stop(startTime + partialDuration + 0.05);
        }
    }

    // Incoming message: a warm two-note rise (B5 → E6, a perfect fourth). Rising
    // intervals read as "new/arrived"; falling ones read as dismissal or error.
    // Synthesized (no audio asset) so it ships to every platform — macOS,
    // Windows, Android, browser — through bundle_web.py with nothing to bundle.
    playMessageChime() {
        const ctx = this.ensureSoundContext();
        if (!ctx) return;
        const now = ctx.currentTime + 0.02;
        this.playBellVoice(ctx, { frequency: 987.77, startTime: now, duration: 0.55, gain: 0.38 });
        this.playBellVoice(ctx, { frequency: 1318.51, startTime: now + 0.11, duration: 0.9, gain: 0.34 });
    }

    // Looping ringtone for an incoming call — started/stopped from the single
    // choke point renderVoicePanel() based on this.voice.status, so it tracks
    // every way a call stops ringing (answered, declined, missed, caller hung up)
    // without needing to be threaded into each of those call sites separately.
    //
    // Musical phrase (an E-major arpeggio played twice) rather than the usual
    // two-tone warble: it stays recognizable at low volume and doesn't turn
    // grating on the tenth repeat, while the silence between phrases is what
    // actually makes a ringtone read as urgent.
    startRingtone() {
        if (this.sound.ringing) return;
        const ctx = this.ensureSoundContext();
        if (!ctx) return;
        this.sound.ringing = true;
        const phrase = () => {
            if (!this.sound.ringing) return;
            const liveCtx = this.ensureSoundContext();
            if (!liveCtx) return;
            const now = liveCtx.currentTime + 0.02;
            const notes = [659.25, 987.77, 1318.51, 987.77]; // E5 B5 E6 B5
            for (const passOffset of [0, 0.78]) {
                notes.forEach((frequency, index) => {
                    this.playBellVoice(liveCtx, {
                        frequency,
                        startTime: now + passOffset + index * 0.15,
                        duration: 0.7,
                        gain: 0.4,
                        brightness: 8,
                    });
                });
            }
        };
        phrase();
        // Phrase runs ~1.8 s; a 3 s period leaves the ~1.2 s gap that makes it
        // sound like a phone ringing rather than a continuous alarm.
        this.sound.ringTimer = setInterval(phrase, 3000);
    }

    stopRingtone() {
        this.sound.ringing = false;
        if (this.sound.ringTimer) {
            clearInterval(this.sound.ringTimer);
            this.sound.ringTimer = null;
        }
    }

    // Single choke point for "a message arrived in a chat the user isn't currently
    // looking at". Both the live WS push path AND the reconnect / background
    // history-catch-up paths (loadHistory, mergeServerChatMessages) route through
    // here — those catch-up paths used to update S.chats/S.serverChats silently with
    // no notification and no unread badge, which was the root cause of notifications
    // being rare and arriving with a huge delay: most messages land via catch-up
    // after a WS drop, not via the live push that used to be the only notify trigger.
    notifyBackgroundMessage({ sender, text, attachmentCount = 0, serverId = null, channelId = null, peer = null }) {
        const from = String(sender || '').trim();
        if (!from || from === this.myName()) return;
        const isChannel = !!(serverId && channelId);
        const muteKey = isChannel ? `${serverId}:${channelId}` : String(peer || '').trim();
        if (!muteKey) return;
        if (isChannel) {
            this.S.channelUnread = this.S.channelUnread || {};
            this.S.channelUnread[muteKey] = (this.S.channelUnread[muteKey] || 0) + 1;
        } else {
            this.S.unread[muteKey] = (this.S.unread[muteKey] || 0) + 1;
        }
        this.syncTaskbarBadge();
        if ((this.S.mutedChats || {})[muteKey]) return;
        // Native OS notifications (UNUserNotificationCenter / toast / Android
        // channel) already carry their own default sound when granted — but that
        // depends on OS-level permission the user may never have granted, and the
        // browser/PWA client (no native bridge at all) gets no sound whatsoever
        // from postNativeMessage below. This chime is unconditional so a message
        // is always audible while its chat isn't the one on screen, independent
        // of native notification permission state, including when the window is
        // minimized or not frontmost (see playMessageChime).
        this.playMessageChime();
        this.postNativeMessage({
            type: NativeMessageTypes.SHOW_NOTIFICATION,
            sender: from,
            text,
            attachmentCount,
            serverId: serverId || null,
            channelId: channelId || null,
        });
        this.showBrowserNotification({
            sender: from,
            text,
            attachmentCount,
            serverId,
            channelId,
        });
    }

    // Mirror of the native shells' notification_body (apps/windows/src/native/transport.rs,
    // and the same precedence on macOS): message text wins, then an attachment count,
    // then a generic fallback.
    notificationBodyFor(text, attachmentCount = 0) {
        const trimmed = String(text || '').trim();
        if (trimmed) return Array.from(trimmed).slice(0, 180).join('');
        if (attachmentCount === 1) return 'Вложение';
        if (attachmentCount > 1) return `Вложения: ${attachmentCount}`;
        return 'Новое сообщение';
    }

    // Browser/PWA only — the one notification path nothing else covered.
    // postNativeMessage(SHOW_NOTIFICATION) above returns false immediately when there
    // is no native bridge, and the server only sends a Web Push when deliver_to_user
    // finds ZERO live WS connections. A tab that is merely *hidden* (backgrounded,
    // minimized, screen locked) has a live WS, so it fell straight through the gap
    // between the two and produced no notification at all — just the chime, which
    // browsers throttle in background tabs anyway.
    //
    // Only fires while the document is hidden: with the app actually on screen the
    // in-app unread badges already cover it. Notifications are tagged per conversation
    // with renotify, so a long-backgrounded tab alerts on each message without piling
    // up one entry per message in the OS notification centre.
    showBrowserNotification({ sender, text, attachmentCount = 0, serverId = null, channelId = null }) {
        if (this.hasNativeBridge()) return;
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        if (typeof document !== 'undefined' && document.visibilityState !== 'hidden') return;

        const from = String(sender || '').trim();
        if (!from) return;
        const isChannel = !!(serverId && channelId);
        const title = isChannel ? `${from} в канале` : from;
        const options = {
            body: this.notificationBodyFor(text, attachmentCount),
            icon: './icon-192.png',
            badge: './icon-192.png',
            tag: isChannel ? `zali:${serverId}:${channelId}` : `zali:dm:${from}`,
            renotify: true,
            data: { sender: from, serverId: serverId || null, channelId: channelId || null },
        };

        try {
            // registration.showNotification() rather than `new Notification()`: the
            // latter throws on Android Chrome, where only the service-worker form is
            // allowed, and it is also what the installed PWA needs.
            if (navigator.serviceWorker?.ready) {
                navigator.serviceWorker.ready
                    .then(registration => registration.showNotification(title, options))
                    .catch(e => this.trace(`showBrowserNotification failed: ${e?.message || e}`));
            } else {
                new Notification(title, options);
            }
        } catch (e) {
            this.trace(`showBrowserNotification failed: ${e?.message || e}`);
        }
    }

    // Total unread count across DMs and server channels — feeds the Windows
    // taskbar overlay badge (see syncTaskbarBadge). Mirrors the per-surface sums
    // already used by renderHub()/renderServers() for their own badges.
    computeTotalUnreadCount() {
        const dmTotal = Object.values(this.S.unread || {}).reduce((sum, value) => sum + Number(value || 0), 0);
        const channelTotal = Object.values(this.S.channelUnread || {}).reduce((sum, value) => sum + Number(value || 0), 0);
        return dmTotal + channelTotal;
    }

    syncTaskbarBadge() {
        if (!this.nativeSupports('taskbarBadge')) return;
        this.postNativeMessage({
            type: NativeMessageTypes.SET_UNREAD_BADGE,
            count: this.computeTotalUnreadCount(),
        });
    }

    // The set of statuses that mean "a call is live and must not be clobbered". Both the
    // incoming-invite busy-guard and the foreign-room-state guard key off this exact set;
    // inlining it twice risks one copy going stale and silently re-opening the
    // active-call-clobber bug.
    // Rooms this client deliberately walked away from (invite glare). Events for
    // them are already in flight when we leave, and applying those would restore
    // state for a call that no longer exists. Bounded: a handful per session.
    abandonVoiceRoom(roomId) {
        const id = String(roomId || '').trim();
        if (!id) return;
        if (!this._abandonedVoiceRooms) this._abandonedVoiceRooms = new Set();
        this._abandonedVoiceRooms.add(id);
        if (this._abandonedVoiceRooms.size > 32) {
            this._abandonedVoiceRooms.delete(this._abandonedVoiceRooms.values().next().value);
        }
    }

    isAbandonedVoiceRoom(roomId) {
        const id = String(roomId || '').trim();
        return !!id && !!this._abandonedVoiceRooms?.has(id);
    }

    isInActiveCall(status = this.voice?.status) {
        return ['connected', 'connecting', 'calling', 'incoming'].includes(String(status || ''));
    }
});
