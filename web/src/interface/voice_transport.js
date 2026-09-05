// --- ZaliInterface: Голосовые комнаты и транспорт сигналинга. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    voiceRoomKeyForDm(peer) {
        const me = String(this.myName() || '').trim();
        const other = String(peer || '').trim();
        const pair = [me, other].filter(Boolean).sort();
        return pair.length === 2 ? `voice:dm:${pair.join(':')}` : '';
    }

    makeDmCallRoomId(peer) {
        const base = this.voiceRoomKeyForDm(peer);
        if (!base) return '';
        const stamp = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        return `${base}:${stamp}`;
    }

    voiceRoomKeyForChannel(serverId, channelId) {
        const sid = String(serverId || '').trim();
        const cid = String(channelId || '').trim();
        return sid && cid ? `voice:channel:${sid}:${cid}` : '';
    }

    isVoiceChannel(channel = null) {
        return String(channel?.kind || '').trim().toLowerCase() === 'voice';
    }

    currentVoicePeer() {
        if (this.S.navMode === 'dm') {
            return String(this.S.current || '').trim();
        }
        return '';
    }

    shouldInitiateVoiceOffer(peer) {
        const me = String(this.myName() || '').trim();
        const other = String(peer || '').trim();
        if (!me || !other) return false;
        if (this.voice.roomType === 'dm') {
            if (this.voice.status !== 'connected') return false;
            const direction = String(this.voice.callTrack?.direction || '').trim();
            if (direction) return direction === 'outgoing';
            // callTrack is not guaranteed to still be here: recordVoiceCallHistory
            // nulls it, and a reset racing the accept drops it too. Keying the offerer
            // purely off it meant both sides could conclude "not me" and sit in a
            // connected call that nobody ever negotiates. voice.inviter is echoed to
            // both peers by the server (voice_call_accepted / voice_room_state), so it
            // still yields exactly one offerer; the name tie-break is the last resort.
            const inviter = String(this.voice.inviter || '').trim();
            if (inviter) return inviter === me;
            return this.compareVoicePeerNames(me, other) < 0;
        }
        return this.compareVoicePeerNames(me, other) < 0;
    }

    // The tie-break has to produce the SAME winner on both machines, and the two
    // machines are usually different engines. localeCompare cannot do that: with full
    // ICU 'apple' < 'Zebra' (letters first, case as a tiebreak), while an engine
    // without it falls back to code units, where 'Zebra' < 'apple' ('Z'=90 < 'a'=97).
    // Two peers disagreeing means both offer and both are impolite — each drops the
    // other's offer, no answer is ever sent, and the call is connected and silent.
    // Code-unit order is identical on every engine, which is the only property that
    // matters here; it is never shown to the user.
    compareVoicePeerNames(a, b) {
        const x = String(a || '');
        const y = String(b || '');
        if (x === y) return 0;
        return x < y ? -1 : 1;
    }

    // Deterministic per-pair role for resolving offer/offer glare. Polite means
    // "does not own the offer for this pair": on a collision this side rolls its own
    // offer back and answers the incoming one, while the offer owner keeps its offer
    // and waits to be answered.
    //
    // This MUST be the inverse of shouldInitiateVoiceOffer. Both used to return the
    // same `me.localeCompare(other) < 0`, which made the offer owner *polite*. When
    // both sides offered at once the result was that neither ever answered: the
    // impolite side dropped the incoming offer on the floor by design, and the
    // polite side — the one holding the offer the peer was waiting on — rolled it
    // back. Confirmed against the server's signal log for a dead call: two offers
    // one way, one the other, 30 ICE candidates, and zero answers in either
    // direction. ICE flows in that state, so the call looks connected while no
    // session is ever agreed and nobody hears anybody.
    isPoliteVoicePeer(peer) {
        const me = String(this.myName() || '').trim();
        const other = String(peer || '').trim();
        if (!me || !other) return false;
        if (this.voice.roomType === 'dm') {
            // Mirrors shouldInitiateVoiceOffer's ladder, negated at every rung.
            // Deliberately does NOT consult voice.status: that gates *when* to
            // offer, and folding it in here would make both sides polite during
            // setup, so a rollback could be attempted from a state that has no
            // local offer to roll back.
            const direction = String(this.voice.callTrack?.direction || '').trim();
            if (direction) return direction !== 'outgoing';
            const inviter = String(this.voice.inviter || '').trim();
            if (inviter) return inviter !== me;
            return this.compareVoicePeerNames(me, other) > 0;
        }
        return this.compareVoicePeerNames(me, other) > 0;
    }

    voiceEventPayload(payload = {}) {
        // vid lets the receiver dedupe: voice signaling on native shells travels
        // over a dedicated voice-only WebSocket (separate from the main message
        // socket, with its own reconnect/heartbeat cycle) — the server delivers
        // every voice_* event to ALL of a user's active connections, so as a
        // reliability fallback the main socket now also forwards voice_* events
        // instead of silently dropping them (see handleVoiceEvent's dedupe check).
        // Without vid, that redundant delivery would double-apply offers/answers.
        this.voice.eventSeq = (this.voice.eventSeq || 0) + 1;
        return {
            ...payload,
            type: payload.type || 'voice_signal',
            vid: `${this.myName() || 'me'}:${Date.now().toString(36)}:${this.voice.eventSeq}`,
        };
    }

    sendVoiceEvent(payload = {}) {
        const event = this.voiceEventPayload(payload);
        this.voiceTrace('send-event', {
            type: event.type || '',
            roomId: event.roomId || '',
            roomType: event.roomType || '',
            to: event.to || '',
            signalType: event.signal?.type || '',
            participants: Array.isArray(this.voice.participants) ? this.voice.participants : [],
        });
        if (!this.nativeSupports('voice')) {
            if (this.voice.socket && this.voice.socket.readyState === WebSocket.OPEN) {
                try {
                    this.voice.socket.send(JSON.stringify(event));
                } catch (error) {
                    this.voiceTrace('send-event-failed', { type: event.type || '', error: error?.message || String(error) }, 'ERROR');
                    return false;
                }
                return true;
            }
            this.addLogEntry({
                type: 'WARN',
                msg: `Voice signal skipped in browser mode: ${event.type}`,
                ts: new Date().toLocaleTimeString(),
            });
            return false;
        }
        this.postNativeMessage({
            type: NativeMessageTypes.VOICE_EVENT,
            payload: event,
        });
        return true;
    }

    disconnectBrowserVoiceSocket() {
        this.voiceTrace('socket-disconnect', { generation: this.voiceSocketGeneration, hadSocket: !!this.voice.socket });
        this.voiceSocketGeneration += 1;
        this.voiceSocketReconnectDelayMs = 1000;
        if (this.voiceSocketPingTimer) {
            clearInterval(this.voiceSocketPingTimer);
            this.voiceSocketPingTimer = null;
        }
        if (this.voiceSocketReconnectTimer) {
            clearTimeout(this.voiceSocketReconnectTimer);
            this.voiceSocketReconnectTimer = null;
        }
        if (this.voice.socket) {
            try {
                this.voice.socket.onopen = null;
                this.voice.socket.onmessage = null;
                this.voice.socket.onclose = null;
                this.voice.socket.onerror = null;
                this.voice.socket.close();
            } catch (e) {}
        }
        this.voice.socket = null;
        this.voice.socketReady = false;
    }

    scheduleBrowserVoiceSocketReconnect(generation, reason = 'retry') {
        if (this.nativeSupports('voice')) return;
        const baseDelay = this.voiceSocketReconnectDelayMs || 1000;
        const jitter = Math.floor(Math.random() * 500);
        const delay = Math.min(baseDelay + jitter, 30000);
        this.voiceSocketReconnectDelayMs = Math.min(baseDelay * 2, 30000);
        this.voiceTrace('socket-reconnect-scheduled', { generation, reason, delay }, 'WARN');
        if (this.voiceSocketReconnectTimer) {
            clearTimeout(this.voiceSocketReconnectTimer);
            this.voiceSocketReconnectTimer = null;
        }
        this.voiceSocketReconnectTimer = setTimeout(() => {
            if (generation === this.voiceSocketGeneration) {
                this.connectBrowserVoiceSocket();
            }
        }, delay);
    }

    // Sends an immediate app-level ping so the half-open watchdog in the socket's
    // ping interval has fresh evidence to judge by. Safe to call at any time.
    probeVoiceSocketLiveness() {
        if (this.nativeSupports('voice')) return;
        const socket = this.voice.socket;
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        try {
            this.voiceSocketLastPingAt = Date.now();
            socket.send(JSON.stringify({ type: 'ping' }));
        } catch (e) {}
    }

    async fetchBrowserVoiceSocketTicket() {
        if (!this.S.session?.token) return '';
        const res = await this.apiFetch(this.apiRoutes.auth.wsTicket, { method: 'POST' });
        if (!res.ok) {
            throw new Error(await res.text().catch(() => 'Не удалось получить ws-ticket'));
        }
        const data = await res.json().catch(() => null);
        return String(data?.ticket || '').trim();
    }

    async connectBrowserVoiceSocket() {
        if (this.nativeSupports('voice')) return;
        if (typeof WebSocket === 'undefined') return;
        if (this.voice.socket && (this.voice.socket.readyState === WebSocket.OPEN || this.voice.socket.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this.disconnectBrowserVoiceSocket();
        const generation = ++this.voiceSocketGeneration;
        let url;
        try {
            url = new URL(this.getWsBaseUrl());
        } catch (error) {
            this.addLogEntry({ type: 'ERROR', msg: `Неверный WS URL: ${error?.message || error}`, ts: new Date().toLocaleTimeString() });
            return;
        }

        let ticket = '';
        try {
            ticket = await this.fetchBrowserVoiceSocketTicket();
        } catch (error) {
            this.addLogEntry({ type: 'ERROR', msg: `Не удалось получить ws-ticket: ${error?.message || error}`, ts: new Date().toLocaleTimeString() });
            this.scheduleBrowserVoiceSocketReconnect(generation, 'ticket-fetch-error');
            return;
        }
        if (!ticket) {
            this.addLogEntry({ type: 'ERROR', msg: 'Не удалось получить ws-ticket для voice socket', ts: new Date().toLocaleTimeString() });
            this.scheduleBrowserVoiceSocketReconnect(generation, 'ticket-missing');
            return;
        }
        if (generation !== this.voiceSocketGeneration) {
            return;
        }
        url.searchParams.set('ticket', ticket);

        try {
            this.voiceTrace('socket-connect', { url: url.toString(), generation, auth: 'ws-ticket' });
            const socket = new WebSocket(url.toString());
            this.voice.socket = socket;
            this.voice.socketReady = false;

            socket.onopen = () => {
                if (generation !== this.voiceSocketGeneration) return;
                this.voice.socketReady = true;
                this.voiceSocketReconnectDelayMs = 1000;
                if (this.voiceSocketPingTimer) {
                    clearInterval(this.voiceSocketPingTimer);
                    this.voiceSocketPingTimer = null;
                }
                this.voiceSocketLastInboundAt = Date.now();
                this.voiceSocketLastPingAt = 0;
                this.voiceSocketPingTimer = setInterval(() => {
                    if (generation !== this.voiceSocketGeneration) return;
                    if (!this.voice.socket || this.voice.socket.readyState !== WebSocket.OPEN) return;
                    // Half-open detection. A network path that dies without a FIN
                    // (Wi-Fi drop, VPN re-key, NAT eviction) leaves readyState stuck
                    // at OPEN until TCP finally gives up — minutes during which the
                    // client believes it is in the call, sendVoiceEvent reports
                    // success, and nothing reconnects. The server answers our ping
                    // with a pong, so an unanswered ping is proof the link is gone.
                    // Keyed off ping-vs-reply rather than plain idle time, because a
                    // quiet call legitimately has no traffic for minutes and a
                    // background tab's timers are throttled.
                    const lastPing = this.voiceSocketLastPingAt || 0;
                    if (lastPing > (this.voiceSocketLastInboundAt || 0) && Date.now() - lastPing > 15000) {
                        this.voiceTrace('socket-ping-unanswered', {
                            generation,
                            silentMs: Date.now() - lastPing,
                        }, 'WARN');
                        try { this.voice.socket.close(); } catch (e) {}
                        return; // onclose schedules the reconnect
                    }
                    try {
                        this.voiceSocketLastPingAt = Date.now();
                        this.voice.socket.send(JSON.stringify({ type: 'ping' }));
                    } catch (e) {}
                }, 25000);
                this.voiceTrace('socket-open', { generation, url: url.toString() }, 'SUCCESS');
                this.addLogEntry({ type: 'SUCCESS', msg: 'Browser voice socket connected', ts: new Date().toLocaleTimeString() });
                // This socket doubles as the pure-browser client's only realtime connection
                // (messages + voice signaling both ride it — see onmessage below), so its
                // lifecycle IS the connection-status badge in that mode, same as native
                // shells driving it via SET_CONNECTION_STATUS over their own transport.
                this.setConnectionStatus(true);
            };

            socket.onmessage = (event) => {
                if (generation !== this.voiceSocketGeneration) return;
                // Liveness evidence for the half-open watchdog above. Counts ANY
                // inbound frame, including the server's {"type":"pong"} — which had
                // no branch below and was silently dropped, so nothing ever noticed
                // whether the server was still answering.
                this.voiceSocketLastInboundAt = Date.now();
                let payload = null;
                try {
                    payload = JSON.parse(event.data);
                } catch (e) {
                    return;
                }
                if (payload && typeof payload === 'object' && String(payload.type || '').startsWith('voice_')) {
                    this.handleVoiceEvent(payload);
                } else if (payload && typeof payload === 'object' && payload.type === 'reaction_updated') {
                    // Native shells receive this over their own bridge (see the
                    // `zali_interface:reaction_updated` bus command); the browser has no
                    // such bridge, so this WS is the only path for it here.
                    this.onReactionUpdated(payload);
                } else if (payload && typeof payload === 'object' && payload.type === 'message_deleted') {
                    // Same story as reaction_updated above: native shells get this over
                    // their own bridge, the browser only has this WS.
                    this.onMessageDeleted(payload);
                } else if (payload && typeof payload === 'object' && payload.type === 'message_edited') {
                    this.onMessageEdited(payload);
                } else if (payload && typeof payload === 'object' && payload.type === 'key_envelope_available') {
                    // Native shells receive this over their own bridge (REFRESH_AFTER_KEY);
                    // the browser has no such bridge — without this branch a browser-tab
                    // user with a conversation open never picks up a freshly published key
                    // until they navigate away and back.
                    this.refreshAfterKey();
                } else if (payload && typeof payload === 'object' && payload.type === 'device_approved') {
                    // Pushed when one of our peers approves a new device — republish our
                    // side of any DM/channel keys we've already shared with them instead of
                    // waiting for our own next login. Also pushed when a peer (or one of
                    // our own accounts) simply *registers* a device — approval is a manual
                    // step almost nobody performs, and a keyless device is what makes
                    // messages end up encrypted with a key nobody else has.
                    void this.retryPublishConversationKeys({ reason: 'device_approved_push' });
                } else if (payload && typeof payload === 'object' && payload.type && this.dispatchRealtimeEvent(payload)) {
                    // Общий маршрутизатор (state_sync.js) — ТОТ ЖЕ, в который
                    // нативные оболочки отдают нераспознанные кадры. Ветка стоит
                    // до key_republish_request, но вреда нет: она возвращает false
                    // для всего, что разбирают ветки ниже, и цепочка идёт дальше.
                    // Так у браузера и у нативы одна и та же логика на новые типы.
                } else if (payload && typeof payload === 'object' && payload.type === 'key_republish_request') {
                    // A participant of a specific scope is telling us it holds the wrong
                    // key (or none). Republish just that scope straight away.
                    void this.handleKeyRepublishRequest(payload);
                } else if (payload && typeof payload === 'object' && !payload.type && payload.id && payload.sender && payload.receiver) {
                    // No `type` field = a raw `Message` row pushed by deliver_to_user/
                    // deliver_server_message (server/src/realtime.rs), not a voice/avatar
                    // event. Only reachable in pure-browser mode — native shells receive
                    // and decrypt these themselves over their own transport.
                    void this.handleIncomingBrowserMessage(payload);
                }
            };

            socket.onclose = () => {
                if (generation !== this.voiceSocketGeneration) return;
                this.voice.socketReady = false;
                this.voice.socket = null;
                if (this.voiceSocketPingTimer) {
                    clearInterval(this.voiceSocketPingTimer);
                    this.voiceSocketPingTimer = null;
                }
                this.voiceTrace('socket-close', { generation, url: url.toString() }, 'WARN');
                this.setConnectionStatus(false);
                if (!this.nativeSupports('voice')) {
                    const baseDelay = this.voiceSocketReconnectDelayMs || 1000;
                    const jitter = Math.floor(Math.random() * 500);
                    const delay = Math.min(baseDelay + jitter, 30000);
                    this.voiceSocketReconnectDelayMs = Math.min(baseDelay * 2, 30000);
                    this.voiceSocketReconnectTimer = setTimeout(() => {
                        if (generation === this.voiceSocketGeneration) {
                            this.connectBrowserVoiceSocket();
                        }
                    }, delay);
                }
            };

            socket.onerror = () => {
                if (generation !== this.voiceSocketGeneration) return;
                this.voice.socketReady = false;
                this.voiceTrace('socket-error', { generation, url: url.toString() }, 'WARN');
            };
        } catch (error) {
            this.addLogEntry({ type: 'ERROR', msg: `Не удалось подключить browser voice socket: ${error?.message || error}`, ts: new Date().toLocaleTimeString() });
        }
    }

    voiceRoomSummary() {
        const roomLabel = this.voice.roomType === 'channel'
            ? (this.currentChannel() ? `#${this.currentChannel().name}` : 'Голосовой канал')
            : this.voice.roomType === 'dm'
                ? `Звонок с ${this.voice.targetUser || this.voice.inviter || ''}`.trim()
                : 'Голос';
        return roomLabel;
    }

    resetVoiceState({ preserveInvite = false } = {}) {
        this.voiceTrace('reset-state', { preserveInvite, roomId: this.voice.roomId || '', roomType: this.voice.roomType || '', status: this.voice.status || '' });
        if (this.voice.negotiationRetryTimer) {
            clearTimeout(this.voice.negotiationRetryTimer);
            this.voice.negotiationRetryTimer = null;
        }
        this.voice.negotiationRetries = 0;
        this.voice.peerRosterKey = '';
        this.stopVoicePresenceKeepalive();
        this.stopVoiceLinkSupervisor();
        for (const entry of this.voice.peerConnections.values()) {
            if (entry.reconnectTimer) {
                clearTimeout(entry.reconnectTimer);
                entry.reconnectTimer = null;
            }
            if (entry.healthTimer) {
                clearTimeout(entry.healthTimer);
                entry.healthTimer = null;
            }
            if (entry.statsTimer) {
                clearInterval(entry.statsTimer);
                entry.statsTimer = null;
            }
            this.clearVoiceAnswerWatchdog(entry);
            try { entry.pc?.close(); } catch (e) {}
        }
        this.voice.peerConnections.clear();
        this.voice.signalChains?.clear();
        for (const audio of this.voice.remoteAudios.values()) {
            try {
                audio.pause?.();
                if (audio.srcObject) {
                    audio.srcObject = null;
                }
                audio.remove?.();
            } catch (e) {}
        }
        this.voice.remoteAudios.clear();
        this.releaseVoicePlaybackGestureHook();
        for (const video of this.voice.remoteVideos.values()) {
            try { video.pause?.(); video.srcObject = null; video.remove?.(); } catch (e) {}
        }
        this.voice.remoteVideos.clear();
        for (const video of this.voice.remoteScreens.values()) {
            try { video.pause?.(); video.srcObject = null; video.remove?.(); } catch (e) {}
        }
        this.voice.remoteScreens.clear();
        this.detachLocalVideoPreview();
        this.detachLocalScreenPreview();
        this.voice.videoEnabled = false;
        this.voice.cameraOn = false;
        this.voice.screenSharing = false;
        if (this.voice.localStream) {
            for (const track of this.voice.localStream.getTracks()) {
                try { track.stop(); } catch (e) {}
            }
        }
        this.voice.localStream = null;
        // A capture still in flight when the session is torn down must not be
        // handed to the *next* call as its local stream.
        this.voice.localStreamInFlight = null;
        this.voice.micError = '';
        if (this.voice.localScreenStream) {
            for (const track of this.voice.localScreenStream.getTracks()) {
                try { track.stop(); } catch (e) {}
            }
        }
        this.voice.localScreenStream = null;
        if (this.voice.audioContext) {
            try { this.voice.audioContext.close?.(); } catch (e) {}
        }
        this.voice.audioContext = null;
        this.voice.audioResumePending = false;
        this.voice.audioResumeNextAttemptAt = 0;
        this.voice.playbackUnlocked = false;
        this.voice.meterUiRenderedOnce = false;
        this.voice.meterLevels = { local: 0, remote: 0 };
        this.voice.meterLocal = null;
        this.voice.meterRemote.clear();
        this.stopVoiceMeterLoop();
        this.voice.traceLines = [];
        this.voice.roomId = '';
        this.voice.roomType = '';
        this.voice.serverId = '';
        this.voice.channelId = '';
        this.voice.targetUser = '';
        this.voice.inviter = '';
        this.voice.participants = [];
        this.voice.status = 'idle';
        this.voice.muted = false;
        this.voice.deafened = false;
        this.voice.expanded = false;
        this.voice.activeSince = 0;
        this.stopVoiceCallBarTimer();
        this.voice.callTrack = null;
        if (!preserveInvite) {
            this.voice.incomingInvite = null;
            this.voice.outgoingInvite = null;
        }
        this.renderVoicePanel();
        this.scheduleRenderMessages();
    }
});
