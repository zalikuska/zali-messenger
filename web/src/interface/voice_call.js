// --- ZaliInterface: Управление звонком и записи о звонках. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    async startDirectCall(peer, { video = false } = {}) {
        const target = String(peer || '').trim();
        if (!target) return;
        // Re-entrancy guard. startDirectCall awaits (playback unlock, getUserMedia),
        // so a double-click ran it twice before the first pass had any state to test
        // against — and makeDmCallRoomId stamps a *fresh* roomId each time, so the
        // server ended up with two ringing rooms for one pair. The callee auto-rejects
        // the second as busy, the caller's outgoingInvite by then points at that second
        // room, so the rejection wiped the caller's whole call state; the accept for the
        // first room then arrived with no callTrack, leaving a call that reports
        // "connected" while neither side ever sends an offer — a silent call.
        if (this.isVoiceCallSetupBusy('start-dm-call')) {
            this.voiceTrace('start-dm-call-ignored-busy-setup', { target }, 'WARN');
            return;
        }
        const activeRoomId = String(this.voice.roomId || '').trim();
        if (activeRoomId && this.isInActiveCall()) {
            const activePeer = String(this.voice.targetUser || this.voice.inviter || '').trim();
            if (activePeer === target) {
                this.voiceTrace('start-dm-call-ignored-same-peer', {
                    target,
                    roomId: activeRoomId,
                    status: this.voice.status || '',
                }, 'WARN');
                this.renderVoicePanel();
                return;
            }
        }
        // Latched before the teardown below, not after it: ending the previous call
        // awaits, and a second click landing in that window would otherwise sail past
        // the guard and start a parallel setup.
        this.voice.callSetupInFlight = true;
        this.voice.callSetupStartedAt = Date.now();
        try {
            if (activeRoomId && this.isInActiveCall()) {
                this.addLogEntry({
                    type: 'INFO',
                    msg: `Завершаем текущий звонок перед звонком ${target}`,
                    ts: new Date().toLocaleTimeString(),
                });
                await this.endCurrentVoiceSession({ reason: 'start-other-call' });
            }
            const me = String(this.myName() || '').trim();
            const roomId = this.makeDmCallRoomId(target);
            if (!roomId) return;
            this.voiceTrace('start-dm-call', { target, me, roomId, video });
            this.voice.videoEnabled = !!video;
            // Not awaited on purpose — see refreshVoiceTurnCredentials: a rotating
            // TURN credential is an optimisation over the static one, never a
            // precondition, so it must not be able to delay or fail a call.
            void this.refreshVoiceTurnCredentials();
            // Deliberately not awaited: the synchronous part (creating the context and
            // calling resume()) is what has to happen inside the user gesture, and the
            // rest is best-effort. Awaiting it put a promise WebKit may never settle in
            // front of the invite — see unlockVoicePlayback.
            void this.unlockVoicePlayback();
            this.voice.callTrack = {
                roomId,
                peer: target,
                roomType: 'dm',
                direction: 'outgoing',
                startedAt: Date.now(),
                connectedAt: 0,
                endedAt: 0,
                outcome: 'calling',
                recorded: false,
            };
            this.voice.outgoingInvite = {
                roomId,
                target,
            };
            this.voice.roomId = roomId;
            this.voice.roomType = 'dm';
            this.voice.targetUser = target;
            this.voice.inviter = me;
            this.voice.participants = [me, target].filter(Boolean);
            this.voice.status = 'calling';
            this.voice.negotiationRetries = 0;
            this.sendVoiceEvent({
                type: 'voice_call_invite',
                roomId,
                roomType: 'dm',
                target,
            });
            this.renderVoicePanel();
            try {
                await this.ensureVoiceLocalStream();
                await this.syncVoicePeers();
            } catch (error) {
                this.addLogEntry({
                    type: 'WARN',
                    msg: error?.message || 'Не удалось подготовить микрофон для звонка',
                    ts: new Date().toLocaleTimeString(),
                });
            }
        } finally {
            this.voice.callSetupInFlight = false;
            this.voice.callSetupStartedAt = 0;
        }
    }

    // The re-entrancy latch that guards call setup is released in a `finally`, so any
    // await inside setup that never settles disables calling entirely — «Позвонить»
    // and «Принять» just stop responding, with only a trace line to show for it, until
    // the app is restarted. A latch older than any plausible setup is treated as
    // abandoned rather than trusted: the worst case of being wrong is one redundant
    // setup, the worst case of trusting it is a client that can no longer call at all.
    isVoiceCallSetupBusy(reason = '') {
        if (!this.voice.callSetupInFlight) return false;
        const startedAt = Number(this.voice.callSetupStartedAt || 0);
        if (startedAt && Date.now() - startedAt > 30000) {
            this.voiceDiag('call-setup-latch-stale', {
                reason,
                ageMs: Date.now() - startedAt,
            }, 'WARN');
            this.voice.callSetupInFlight = false;
            this.voice.callSetupStartedAt = 0;
            return false;
        }
        return true;
    }

    async acceptIncomingCall() {
        const invite = this.voice.incomingInvite;
        if (!invite?.roomId || !invite?.from) return;
        // Same re-entrancy hazard as startDirectCall: this awaits before it clears
        // incomingInvite, so a double-tap on «Принять» sent two voice_call_accept
        // events and restarted the local setup mid-flight.
        if (this.isVoiceCallSetupBusy('accept-incoming')) {
            this.voiceTrace('accept-incoming-ignored-busy-setup', { roomId: invite.roomId }, 'WARN');
            return;
        }
        this.voice.callSetupInFlight = true;
        this.voice.callSetupStartedAt = Date.now();
        try {
            await this.performAcceptIncomingCall(invite);
        } finally {
            this.voice.callSetupInFlight = false;
            this.voice.callSetupStartedAt = 0;
        }
    }

    async performAcceptIncomingCall(invite) {
        const me = String(this.myName() || '').trim();
        this.voiceDiag('accept-incoming', { roomId: invite.roomId, from: invite.from, me });
        void this.refreshVoiceTurnCredentials();
        // Not awaited — see unlockVoicePlayback. Awaited here, a refused resume() left
        // the callee holding callSetupInFlight forever: the accept was never sent, and
        // «Принять» silently did nothing on every later call too.
        void this.unlockVoicePlayback();
        this.voice.roomId = String(invite.roomId || '').trim();
        this.voice.roomType = 'dm';
        this.voice.targetUser = String(invite.from || '').trim();
        this.voice.inviter = String(invite.from || '').trim();
        this.voice.participants = [me, String(invite.from || '').trim()].filter(Boolean);
        this.voice.status = 'connecting';
        this.voice.negotiationRetries = 0;
        this.voice.callTrack = {
            roomId: invite.roomId,
            peer: invite.from,
            roomType: 'dm',
            direction: 'incoming',
            startedAt: Date.now(),
            connectedAt: 0,
            endedAt: 0,
            outcome: 'connecting',
            recorded: false,
        };
        this.addLogEntry({
            type: 'INFO',
            msg: `Принимаем звонок ${this.voice.roomId} от ${invite.from}`,
            ts: new Date().toLocaleTimeString(),
        });
        this.renderVoicePanel();
        this.sendVoiceEvent({
            type: 'voice_call_accept',
            roomId: invite.roomId,
            inviter: invite.from,
        });
        this.renderVoicePanel();
        try {
            await this.ensureVoiceLocalStream();
            await this.syncVoicePeers();
        } catch (error) {
            this.addLogEntry({
                type: 'WARN',
                msg: error?.message || 'Не удалось подготовить микрофон для ответа на звонок',
                ts: new Date().toLocaleTimeString(),
            });
        }
    }

    async rejectIncomingCall() {
        const invite = this.voice.incomingInvite;
        if (!invite?.roomId || !invite?.from) return;
        this.voiceTrace('reject-incoming', { roomId: invite.roomId, from: invite.from });
        this.sendVoiceEvent({
            type: 'voice_call_reject',
            roomId: invite.roomId,
            inviter: invite.from,
        });
        this.recordVoiceCallHistory({ outcome: 'rejected', endedAt: Date.now() });
        this.resetVoiceState({ preserveInvite: false });
    }

    toggleVoiceMute() {
        const stream = this.voice.localStream;
        if (!stream) return;
        const nextMuted = !this.voice.muted;
        for (const track of stream.getAudioTracks()) {
            track.enabled = !nextMuted;
        }
        this.voice.muted = nextMuted;
        this.renderVoicePanel();
    }

    // "Deafen": silences everything coming FROM the call (remote mic + remote
    // camera audio track), independent of our own mic mute. Applied to every
    // live element immediately, and to each newly attached remote audio/video
    // element going forward (see attachRemoteAudioElement / mountVoiceVideoElements).
    toggleVoiceDeafen() {
        this.voice.deafened = !this.voice.deafened;
        this.applyVoiceDeafenState();
        this.renderVoicePanel();
    }

    // Remote <video> elements are always muted (see attachRemoteVoiceVideo) —
    // playback audio comes solely from the per-peer <audio> element created in
    // attachRemoteVoiceStream, so that's the only sink deafen needs to touch.
    applyVoiceDeafenState() {
        const deafened = !!this.voice.deafened;
        for (const audio of this.voice.remoteAudios.values()) {
            try { audio.muted = deafened; } catch (e) {}
        }
    }

    // Collapsed top bar <-> fullscreen grid. Purely a local UI toggle — it does
    // not touch tracks or connections, so it's safe to flip mid-call.
    toggleVoiceCallExpanded() {
        this.voice.expanded = !this.voice.expanded;
        this.renderVoicePanel();
    }

    // Called from every "the user navigated somewhere else" entry point
    // (switchChat, setActiveChannel, setActiveServer, and the Hub/ZaliCoin/
    // Settings tab openers) so the fullscreen call grid never keeps covering
    // the screen for a chat/channel/tab the user just left. The call itself
    // (and the collapsed bar) is untouched — only the expanded/collapsed flag.
    collapseActiveCallView() {
        if (!this.voice.expanded) return;
        this.voice.expanded = false;
        this.renderVoicePanel();
    }

    // Way back to the call from the strip. A channel call lives in its voice
    // channel, whose view IS the call interface. A DM call has no room view of
    // its own, so it opens the conversation with the fullscreen grid on top.
    openActiveVoiceCall() {
        const roomType = String(this.voice.roomType || '').trim();
        if (roomType === 'channel') {
            const sid = String(this.voice.serverId || '').trim();
            const cid = String(this.voice.channelId || '').trim();
            if (!sid || !cid) return;
            if (this.S.navMode !== 'servers' || this.S.activeServer !== sid) {
                this.setActiveServer(sid);
            }
            this.setActiveChannel(cid);
            this.ensureChatViewOpen();
            this.renderVoicePanel();
            return;
        }
        if (roomType === 'dm') {
            const peer = this.voiceDmCallPeer();
            if (peer) this.switchChat(peer);
            else this.ensureChatViewOpen();
            // After switchChat: it collapses the grid on the way in.
            this.voice.expanded = true;
            this.renderVoicePanel();
        }
    }

    formatCallClock(ms) {
        const total = Math.max(0, Math.round(Number(ms) || 0) / 1000) | 0;
        const mm = Math.floor(total / 60);
        const ss = String(total % 60).padStart(2, '0');
        return `${mm}:${ss}`;
    }

    // Ticks the bar/expanded-header timer text once a second without going
    // through renderVoicePanel — a full innerHTML rebuild every second would
    // tear down and remount the <video> elements mid-call for no reason.
    startVoiceCallBarTimer() {
        if (this.voice.barTimerInterval) return;
        const tick = () => {
            const since = Number(this.voice.activeSince || 0);
            if (!since) return;
            const label = this.formatCallClock(Date.now() - since);
            const bar = document.getElementById('voiceCallTimer');
            if (bar) bar.textContent = label;
            const expanded = document.getElementById('voiceCallExpandedTimer');
            if (expanded) expanded.textContent = label;
        };
        tick();
        this.voice.barTimerInterval = setInterval(tick, 1000);
    }

    stopVoiceCallBarTimer() {
        if (this.voice.barTimerInterval) {
            clearInterval(this.voice.barTimerInterval);
            this.voice.barTimerInterval = 0;
        }
    }

    callRecordMessageId(roomId) {
        return `call-${String(roomId || '').trim()}`;
    }

    // Human-readable summary that also goes into `text`. Older clients (and any
    // client that does not understand the structured payload) show this instead of
    // an empty bubble, so the record degrades to a readable line rather than to
    // nothing.
    formatCallSummary(callInfo, direction) {
        const outcome = String(callInfo?.outcome || '').trim();
        const ms = Number(callInfo?.durationMs || 0);
        if (outcome === 'missed') return direction === 'outgoing' ? 'Вызов без ответа' : 'Пропущенный звонок';
        if (outcome === 'rejected') return direction === 'outgoing' ? 'Вызов отклонён' : 'Отклонённый звонок';
        // Written when the client gives up on a call it can no longer recover (every
        // link exhausted, or the room gone from the server). Without its own label it
        // rendered as an ordinary completed call whose duration counted the whole
        // dead stretch — "Исходящий звонок · 8:30" for eight minutes of silence.
        if (outcome === 'failed') {
            if (!ms) return 'Звонок прерван';
            const totalFailed = Math.round(ms / 1000);
            return `Звонок прерван · ${Math.floor(totalFailed / 60)}:${String(totalFailed % 60).padStart(2, '0')}`;
        }
        if (!ms) return direction === 'outgoing' ? 'Исходящий звонок' : 'Входящий звонок';
        const total = Math.round(ms / 1000);
        const mm = Math.floor(total / 60);
        const ss = String(total % 60).padStart(2, '0');
        const label = direction === 'outgoing' ? 'Исходящий звонок' : 'Входящий звонок';
        return `${label} · ${mm}:${ss}`;
    }

    sendCallRecordMessage(message) {
        const peer = String(message?.call?.peer || '').trim();
        if (!peer || !message?.call) return;
        let payload = '';
        try {
            payload = JSON.stringify(message.call);
        } catch (e) {
            return;
        }
        this.enqueuePendingOutbox({
            clientId: message.id,
            sender: this.myName(),
            receiver: peer,
            text: this.formatCallSummary(message.call, message.call.direction),
            call: payload,
            attachments: [],
            timestamp: message.timestamp,
        });
        this.flushPendingOutbox();
    }

    // Incoming counterpart. Direction is derived locally from who sent it rather
    // than trusted from the payload: the sender wrote 'outgoing' from its own point
    // of view, and for the receiver the very same call is incoming.
    parseCallRecordPayload(payload) {
        const raw = String(payload?.call || '').trim();
        if (!raw) return null;
        let parsed = null;
        try {
            parsed = JSON.parse(raw);
        } catch (e) {
            this.trace('parseCallRecordPayload invalid json');
            return null;
        }
        if (!parsed || typeof parsed !== 'object' || !String(parsed.roomId || '').trim()) return null;
        return parsed;
    }

    applyCallRecordMessage(callInfo, payload) {
        const me = String(this.myName() || '').trim();
        const sender = String(payload?.sender || '').trim();
        const receiver = String(payload?.receiver || '').trim();
        const peer = sender === me ? receiver : sender;
        if (!peer) return;
        const direction = sender === me ? 'outgoing' : 'incoming';
        const id = this.callRecordMessageId(callInfo.roomId);
        const message = {
            id,
            clientId: id,
            kind: 'call',
            sender,
            receiver,
            text: '',
            attachments: [],
            timestamp: String(payload?.timestamp || callInfo.endedAt || new Date().toISOString()),
            call: { ...callInfo, peer, direction },
        };
        this.initChat(peer);
        const arr = this.S.chats[peer];
        const index = arr.findIndex(m => String(m.id || '').trim() === id
            || String(m.clientId || '').trim() === id);
        if (index >= 0) arr[index] = { ...arr[index], ...message };
        else arr.push(message);
        arr.sort((a, b) => this.compareMessagesByTime(a, b));
        this.saveStoredMessageCache();
        this.trace(`applyCallRecordMessage peer=${peer} direction=${direction} roomId=${callInfo.roomId}`);
        this.renderContacts();
        if (this.S.navMode === 'dm' && this.S.current === peer) this.scheduleRenderMessages();
    }

    recordVoiceCallHistory({ outcome = 'completed', endedAt = Date.now() } = {}) {
        const call = this.voice.callTrack;
        if (!call || call.recorded || call.roomType === 'channel') return;
        const peer = String(call.peer || this.voice.targetUser || this.voice.inviter || '').trim();
        if (!peer) return;
        const direction = String(call.direction || '').trim() || 'outgoing';
        const startMs = Number(call.connectedAt || call.startedAt || endedAt) || endedAt;
        const endMs = Number(endedAt || Date.now()) || Date.now();
        const durationMs = Math.max(0, endMs - startMs);
        const message = {
            // Stable across both participants and all their devices: the room id
            // identifies one call, so the local row and the one that arrives over the
            // wire collapse into a single entry instead of duplicating.
            id: this.callRecordMessageId(call.roomId || `${peer}-${endMs}`),
            kind: 'call',
            sender: direction === 'outgoing' ? this.myName() : peer,
            receiver: direction === 'outgoing' ? peer : this.myName(),
            text: '',
            attachments: [],
            timestamp: new Date(endMs).toISOString(),
            call: {
                roomId: call.roomId || '',
                peer,
                direction,
                outcome,
                startedAt: new Date(startMs).toISOString(),
                connectedAt: call.connectedAt ? new Date(call.connectedAt).toISOString() : '',
                endedAt: new Date(endMs).toISOString(),
                durationMs,
            },
        };
        const convo = peer;
        this.initChat(convo);
        const arr = this.S.chats[convo];
        // Dedupe on the room-derived id, not on a rendered-content key: the same call
        // can be written here locally AND arrive over the wire from the other side,
        // and those two differ in text and sender casing while being the same call.
        const existingIndex = arr.findIndex(m => String(m.id || '').trim() === message.id
            || String(m.clientId || '').trim() === message.id);
        if (existingIndex >= 0) {
            arr[existingIndex] = { ...arr[existingIndex], ...message };
        } else {
            arr.push(message);
            arr.sort((a, b) => this.compareMessagesByTime(a, b));
        }
        call.recorded = true;
        this.voice.callTrack = null;
        this.saveStoredMessageCache();
        // The caller owns the record and is the one that sends it, so exactly one
        // copy travels. The callee keeps its local row for instant feedback and lets
        // the incoming copy upsert onto the same id. Until this existed the record
        // was never sent anywhere at all: it lived only in this device's cache, so
        // neither the peer nor the account's own other devices ever saw it.
        if (direction === 'outgoing') {
            this.sendCallRecordMessage(message);
        }
        this.renderContacts();
        if (this.S.navMode === 'dm' && this.S.current === convo) {
            this.scheduleRenderMessages();
        }
    }
});
