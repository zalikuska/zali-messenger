// --- ZaliInterface: Жизненный цикл пира: offer/answer, рестарты, супервизор связи. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // Not every rejected offer is a state problem. Once a connection has
    // negotiated a session it owns an immutable media layout, and an offer whose
    // m-sections are laid out differently is refused on those grounds alone —
    // the signaling state is perfectly legal. It happens whenever the peer
    // rebuilds its own RTCPeerConnection (our own dead-transport and
    // unapplicable-offer rebuilds both do exactly that) and the fresh one orders
    // its transceivers differently from the session we already hold:
    //   Failed to set remote offer sdp: The order of m-lines in subsequent offer
    //   doesn't match order from previous offer/answer.
    // Nothing about that is retryable — the layout on this side cannot be
    // reordered, so every redelivery of the same offer fails identically.
    isVoiceSessionShapeError(error) {
        const message = String(error?.message || error || '').toLowerCase();
        return message.includes('m-line') || message.includes('m-lines') || message.includes('media section');
    }

    closeVoicePeer(peer) {
        const name = String(peer || '').trim();
        if (!name) return;
        const entry = this.voice.peerConnections.get(name);
        if (entry) {
            this.voiceDiag('peer-close', { peer: name, roomId: this.voice.roomId || '', ...this.voicePeerSnapshot(name) });
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
            entry.audioSender = null;
            entry.videoSender = null;
            entry.screenSender = null;
            entry.remoteScreenStreamId = null;
            try { entry.pc.close(); } catch (e) {}
            this.voice.peerConnections.delete(name);
        }
        // The signal chain is deliberately NOT dropped here: closeVoicePeer can be
        // called from inside that peer's own chain (rebuilding a dead connection),
        // and deleting the entry there would let the next signal from this peer
        // start a second, concurrent chain. handleVoiceSignal already removes the
        // entry once it is the last queued signal, and resetVoiceState clears all.
        const audio = this.voice.remoteAudios.get(name);
        if (audio) {
            try {
                audio.pause?.();
                audio.srcObject = null;
                audio.remove?.();
            } catch (e) {}
            this.voice.remoteAudios.delete(name);
        }
        const video = this.voice.remoteVideos.get(name);
        if (video) {
            try {
                video.pause?.();
                video.srcObject = null;
                video.remove?.();
            } catch (e) {}
            this.voice.remoteVideos.delete(name);
        }
        this.detachRemoteScreenStream(name);
        if (this.voice.meterRemote.has(name)) {
            const meter = this.voice.meterRemote.get(name);
            try {
                meter?.source?.disconnect?.();
                meter?.analyser?.disconnect?.();
            } catch (e) {}
            this.voice.meterRemote.delete(name);
        }
        this.voice.meterLevels.remote = 0;
    }

    async sendVoiceOffer(peer) {
        const entry = this.getVoicePeerEntry(peer);
        if (!entry || !this.voice.localStream) return;
        if (entry.offerSent) return;
        // `negotiating` is checked and set synchronously, before any await. Every
        // room-state broadcast re-runs syncVoicePeers, and a group call produces one
        // per join/leave — two overlapping runs both saw offerSent=false and
        // signalingState='stable' (neither flips until setLocalDescription resolves)
        // and both offered the same peer. The peer answers both; the second answer
        // arrives in 'stable' and is discarded, so whichever offer it belonged to
        // stays half-negotiated and that link carries no audio.
        if (entry.negotiating || entry.pc.signalingState !== 'stable') {
            this.voiceTrace('send-offer-skipped', { peer, state: entry.pc.signalingState, negotiating: !!entry.negotiating }, 'WARN');
            return;
        }
        entry.negotiating = true;
        try {
            await this.sendVoiceOfferInner(entry, peer);
        } finally {
            entry.negotiating = false;
        }
    }

    async sendVoiceOfferInner(entry, peer) {
        this.voiceDiag('send-offer', { peer, roomId: this.voice.roomId || '', roomType: this.voice.roomType || '', iceRestart: !!entry.needsIceRestart });
        await this.attachLocalVoiceTracks(peer);
        const offer = await this.createVoiceOfferFor(entry);
        await entry.pc.setLocalDescription(offer);
        entry.offerSent = true;
        this.voiceDiag('offer-created', {
            peer,
            roomId: this.voice.roomId || '',
            sdpType: entry.pc.localDescription?.type || 'offer',
            sdpLength: entry.pc.localDescription?.sdp?.length || 0,
        });
        const delivered = this.sendVoiceEvent({
            type: 'voice_signal',
            roomId: this.voice.roomId,
            roomType: this.voice.roomType,
            serverId: this.voice.serverId,
            channelId: this.voice.channelId,
            to: peer,
            signal: {
                type: 'offer',
                sdp: {
                    type: entry.pc.localDescription?.type || 'offer',
                    sdp: entry.pc.localDescription?.sdp || '',
                },
            },
        });
        // offerSent used to latch true even when the signal never left the client
        // (socket reconnecting, native bridge refused) — nothing ever retried, so the
        // call sat there reporting "connected" with no media in either direction.
        if (!delivered) {
            entry.offerSent = false;
            this.voiceDiag('offer-send-failed', { peer, roomId: this.voice.roomId || '' }, 'WARN');
            this.scheduleVoiceNegotiationRetry('offer-send-failed');
            return;
        }
        this.armVoiceAnswerWatchdog(entry, peer);
    }

    // An offer that leaves the client but whose ANSWER never comes back leaves this
    // side in 'have-local-offer' with offerSent latched — syncVoicePeers then skips
    // the peer forever, and no other watchdog covers it: the reconnect/ICE-restart
    // path is driven by onconnectionstatechange, and a connection that never got a
    // remote description never starts ICE, so it never reaches 'disconnected' or
    // 'failed' to trigger anything. The peer that did answer sees a healthy call.
    // A single dropped answer frame is enough — the voice socket reconnects mid-call
    // routinely — and the result is a call that looks connected to both sides and is
    // silent for both. Found by scripts/voice_doctor with a 20 % signal drop rate.
    //
    // EVERY path that sets a local offer must arm this, not just the initial one.
    // An ICE restart and a mid-call renegotiation reach the same dead end, and are
    // worse: 'have-local-offer' also blocks every later renegotiation for that peer
    // (they queue on renegotiationPending, which only drains on a return to
    // 'stable' that can never come), so one lost frame freezes that link for the
    // rest of the call.
    armVoiceAnswerWatchdog(entry, peer) {
        if (!entry) return;
        this.clearVoiceAnswerWatchdog(entry);
        entry.answerWatchdog = setTimeout(() => {
            entry.answerWatchdog = null;
            if (!this.voice.roomId) return;
            if (!this.voice.peerConnections.has(peer)) return;
            if (entry.pc.signalingState !== 'have-local-offer') return;
            const attempt = Number(entry.answerRetries || 0) + 1;
            entry.answerRetries = attempt;
            this.voiceDiag('answer-never-arrived', {
                peer,
                roomId: this.voice.roomId || '',
                state: entry.pc.signalingState,
                attempt,
            }, 'WARN');
            // Roll back to 'stable' so the retry can build a fresh offer; without the
            // rollback sendVoiceOffer would refuse (it requires 'stable') and the peer
            // would stay stuck exactly as before.
            Promise.resolve()
                .then(() => entry.pc.setLocalDescription({ type: 'rollback' }))
                .catch(error => this.voiceTrace('answer-watchdog-rollback-failed', {
                    peer, error: error?.message || String(error),
                }, 'WARN'))
                .then(() => {
                    entry.offerSent = false;
                    entry.negotiating = false;
                    if (attempt > 4) {
                        // Bounded: a peer that answers nothing is gone, and re-offering
                        // it forever would keep one dead link renegotiating for the
                        // whole call. The connection-state paths still cover a link
                        // that later fails outright.
                        this.voiceDiag('answer-watchdog-exhausted', { peer, attempt }, 'WARN');
                        return;
                    }
                    // An offer sent on an ALREADY negotiated connection (ICE restart,
                    // track change) cannot be recovered through syncVoicePeers: that
                    // only offers on behalf of the offer owner, and either side may
                    // renegotiate. Re-offer this peer directly instead; the initial
                    // offer (no remote description yet) still goes through the shared
                    // retry so a missing mic is re-acquired on the way.
                    if (entry.pc.remoteDescription) {
                        this.renegotiateVoicePeer(peer).catch(() => {});
                    } else {
                        this.scheduleVoiceNegotiationRetry('answer-never-arrived');
                    }
                });
        }, 8000);
    }

    clearVoiceAnswerWatchdog(entry) {
        if (entry?.answerWatchdog) {
            clearTimeout(entry.answerWatchdog);
            entry.answerWatchdog = null;
        }
    }

    // Bounded re-run of the "get a mic, offer to whoever we owe an offer to" path.
    // Every step of call setup that can fail silently (mic denied while the peer is
    // already connected, a signal dropped by a reconnecting socket, an answer that
    // couldn't be applied) ends up here instead of leaving a live-looking call that
    // never carries audio.
    scheduleVoiceNegotiationRetry(reason = 'retry') {
        if (this.voice.negotiationRetryTimer) return;
        const attempt = Number(this.voice.negotiationRetries || 0) + 1;
        if (attempt > 8) {
            this.voiceDiag('negotiation-retry-exhausted', { reason, attempt, roomId: this.voice.roomId || '' }, 'WARN');
            return;
        }
        this.voice.negotiationRetries = attempt;
        this.voiceDiag('negotiation-retry-scheduled', { reason, attempt, roomId: this.voice.roomId || '' });
        this.voice.negotiationRetryTimer = setTimeout(async () => {
            this.voice.negotiationRetryTimer = null;
            if (!String(this.voice.roomId || '').trim()) return;
            if (!this.isInActiveCall()) return;
            try {
                await this.ensureVoiceLocalStream();
            } catch (error) {
                this.voiceTrace('negotiation-retry-mic-failed', { error: error?.message || String(error) }, 'WARN');
            }
            try {
                await this.syncVoicePeers();
            } catch (error) {
                this.voiceTrace('negotiation-retry-failed', { error: error?.message || String(error) }, 'WARN');
            }
        }, Math.min(1500 * attempt, 6000));
    }

    async restartVoicePeer(peer) {
        const name = String(peer || '').trim();
        if (!name || !this.voice.roomId) return;
        const entry = this.getVoicePeerEntry(name);
        if (!entry || !this.voice.localStream) return;
        // Marked before the queueing check, not after it: the queued request drains
        // through renegotiateVoicePeer, which used to build a plain offer and so
        // silently turned every deferred restart into a no-op on a dead transport.
        entry.needsIceRestart = true;
        // createOffer({iceRestart}) + setLocalDescription throws outside 'stable'.
        // Both ends of a pair arm their own reconnect/health timers, so in a group
        // call restarts land on top of an in-flight (re)negotiation routinely —
        // queue instead of throwing and leaving the pair broken.
        if (entry.negotiating || entry.pc.signalingState !== 'stable') {
            entry.renegotiationPending = true;
            this.voiceTrace('restart-queued', { peer: name, state: entry.pc.signalingState, negotiating: !!entry.negotiating }, 'WARN');
            return;
        }
        if (entry.healthTimer) {
            clearTimeout(entry.healthTimer);
            entry.healthTimer = null;
        }
        this.voiceDiag('restart-offer', { peer: name, roomId: this.voice.roomId || '', ...this.voicePeerSnapshot(name) });
        await this.attachLocalVoiceTracks(name);
        const offer = await this.createVoiceOfferFor(entry);
        await entry.pc.setLocalDescription(offer);
        entry.offerSent = true;
        this.voiceTrace('offer-restart-created', {
            peer: name,
            roomId: this.voice.roomId || '',
            sdpType: entry.pc.localDescription?.type || 'offer',
            sdpLength: entry.pc.localDescription?.sdp?.length || 0,
        });
        const delivered = this.sendVoiceEvent({
            type: 'voice_signal',
            roomId: this.voice.roomId,
            roomType: this.voice.roomType,
            serverId: this.voice.serverId,
            channelId: this.voice.channelId,
            to: name,
            signal: {
                type: 'offer',
                sdp: {
                    type: entry.pc.localDescription?.type || 'offer',
                    sdp: entry.pc.localDescription?.sdp || '',
                },
            },
        });
        if (!delivered) {
            // Same latch bug sendVoiceOfferInner already guards against: an offer that
            // never left the client must not count as sent. This path is worse — it
            // only runs on a link that is ALREADY broken, and the reconnect timer that
            // brought us here was cleared by the state change that armed it, so
            // nothing else would ever try again.
            entry.offerSent = false;
            this.voiceDiag('offer-restart-send-failed', { peer: name, roomId: this.voice.roomId || '' }, 'WARN');
        }
        // An ICE restart whose answer is lost is the worst case of all: the transport
        // is dead, the connection state does not change (it is already failed), so no
        // further reconnect timer is ever armed. Without this the peer is gone for the
        // rest of the call.
        this.armVoiceAnswerWatchdog(entry, name);
    }

    // Level-triggered supervision of the peer links, as opposed to everything else
    // in this file, which is edge-triggered off onconnectionstatechange.
    //
    // That distinction is the whole point. 'failed' is a terminal state: the event
    // fires once on the way in and never again, because there is nothing left to
    // transition to. Every recovery hung off that single edge therefore gets
    // exactly one attempt, and if that attempt is dropped — the offer never leaves
    // the socket, its answer is lost, the network is still down 8 s later — the
    // link is dead for the rest of the call while the panel keeps saying «В эфире».
    // Reachability, meanwhile, is not an edge at all: it comes back on its own
    // schedule, minutes later, with no event to announce it. Only something that
    // re-reads the actual state can act on that.
    //
    // Costs nothing on a healthy call: the timer is armed by the failure and stops
    // itself as soon as no link needs watching.
    ensureVoiceLinkSupervisor() {
        if (this.voice.linkSupervisorTimer) return;
        this.voice.linkSupervisorTimer = setInterval(() => {
            try {
                this.superviseVoiceLinks();
            } catch (error) {
                this.voiceTrace('link-supervisor-error', { error: error?.message || String(error) }, 'WARN');
            }
        }, 5000);
    }

    stopVoiceLinkSupervisor() {
        if (this.voice.linkSupervisorTimer) {
            clearInterval(this.voice.linkSupervisorTimer);
            this.voice.linkSupervisorTimer = null;
        }
    }

    superviseVoiceLinks() {
        if (!String(this.voice.roomId || '').trim()) {
            this.stopVoiceLinkSupervisor();
            return;
        }
        let watching = false;
        for (const [name, entry] of this.voice.peerConnections) {
            const state = String(entry?.pc?.connectionState || '');
            if (state === 'connected' || state === 'completed') {
                entry.needsIceRestart = false;
                entry.linkRecoveryAttempts = 0;
                entry.linkRecoverySkipTicks = 0;
                // Cleared here too, not only from onconnectionstatechange: the dead-call
                // detector below treats this flag as "this link is finished", so a link
                // that came back must not still be carrying it.
                entry.linkRecoveryExhausted = false;
                continue;
            }
            if (state !== 'failed' && state !== 'disconnected') continue;
            watching = true;
            entry.needsIceRestart = true;
            // Something is already trying: the reconnect timer armed by the state
            // change, a negotiation in flight, or an offer whose answer is still
            // within the watchdog's window. Doubling up here would only produce
            // glare on a link that is already struggling.
            if (entry.reconnectTimer || entry.negotiating || entry.answerWatchdog) continue;
            if (entry.pc.signalingState !== 'stable') continue;
            if (entry.linkRecoverySkipTicks > 0) {
                entry.linkRecoverySkipTicks -= 1;
                continue;
            }
            const attempt = Number(entry.linkRecoveryAttempts || 0) + 1;
            // Bounded, but generously: at a ceiling of one attempt per 25 s this is
            // roughly eight minutes of trying. Long enough to outlast a tunnel, a
            // lift or a Wi-Fi→LTE handover, and still not a link renegotiating for
            // the rest of a two-hour call.
            if (attempt > 20) {
                if (!entry.linkRecoveryExhausted) {
                    entry.linkRecoveryExhausted = true;
                    this.voiceDiag('link-recovery-exhausted', {
                        peer: name,
                        roomId: this.voice.roomId || '',
                        attempts: attempt - 1,
                        ...this.voicePeerSnapshot(name),
                    }, 'ERROR');
                }
                continue;
            }
            entry.linkRecoveryAttempts = attempt;
            // 5 s, 10 s, 15 s, 20 s, then 25 s from there on.
            entry.linkRecoverySkipTicks = Math.min(attempt, 4);
            this.voiceDiag('link-recovery', {
                peer: name,
                roomId: this.voice.roomId || '',
                state,
                ice: entry.pc.iceConnectionState || '',
                attempt,
            }, 'WARN');
            // Not awaited: the supervisor tick must not be held up by one peer, and
            // restartVoicePeer re-entrancy is already guarded by entry.negotiating.
            Promise.resolve(this.restartVoicePeer(name)).catch(error => {
                this.voiceTrace('link-recovery-failed', { peer: name, error: error?.message || String(error) }, 'WARN');
            });
        }
        if (!watching) this.stopVoiceLinkSupervisor();
        this.concludeDeadVoiceCallIfNeeded();
    }

    // A call whose every link has given up is over, and nothing said so. The
    // supervisor stopped after ~8 minutes of trying, the panel kept showing «В
    // эфире» with a participant list frozen at whoever was there when the network
    // went, and the only way out was for the user to guess that and press the red
    // button. Worse, no call record was written, so the conversation kept no trace
    // of a call that really happened.
    //
    // Deliberately conservative: it fires only when there IS at least one peer and
    // EVERY one of them has exhausted its recovery budget. A call still holding one
    // working link is not dead, and a room we have not managed to negotiate with yet
    // (no peer entries at all) is handled by the negotiation retry, not here.
    concludeDeadVoiceCallIfNeeded() {
        if (!String(this.voice.roomId || '').trim()) return;
        const entries = Array.from(this.voice.peerConnections.values());
        if (!entries.length) return;
        if (!entries.every(entry => entry.linkRecoveryExhausted)) return;
        this.voiceDiag('call-dead-all-links-exhausted', {
            roomId: this.voice.roomId || '',
            roomType: this.voice.roomType || '',
            peers: entries.length,
        }, 'ERROR');
        this.addLogEntry({
            type: 'ERROR',
            msg: 'Связь со всеми участниками потеряна — звонок завершён',
            ts: new Date().toLocaleTimeString(),
        });
        void this.leaveVoiceRoom({ announce: true, outcome: 'failed' });
    }

    // Same conclusion reached from the other direction: the server told us the room
    // we think we are in does not exist. Nothing can be signalled into a room that is
    // gone — no ICE restart, no re-offer — so the call is over whatever the panel
    // says. Before this, voice_error was written to the journal and otherwise
    // ignored, and the client sat in a room the server had forgotten, re-asserting
    // presence into the void every 8 s.
    concludeVanishedVoiceRoom(roomId, message = '') {
        const current = String(this.voice.roomId || '').trim();
        const reported = String(roomId || '').trim();
        if (!current || (reported && reported !== current)) return false;
        this.voiceDiag('call-dead-room-vanished', {
            roomId: current,
            roomType: this.voice.roomType || '',
            status: this.voice.status || '',
            message,
        }, 'ERROR');
        this.addLogEntry({
            type: 'ERROR',
            msg: 'Голосовая комната больше не существует на сервере — звонок завершён',
            ts: new Date().toLocaleTimeString(),
        });
        // announce:false — there is nothing to announce to, and voice_leave for a
        // missing room only earns another voice_error.
        void this.leaveVoiceRoom({ announce: false, outcome: 'failed' });
        return true;
    }

    // Re-asserts room membership. The server evicts a user from their voice room
    // 150 s after their WebSocket closes (the delayed cleanup in realtime.rs — the
    // window has been 12 s and 45 s in the past, and both were shorter than a real
    // reconnect; check realtime.rs before trusting a number written here), and
    // nothing ever re-joined afterwards: the browser voice socket's onopen doesn't
    // re-join, and on native shells the voice transport reconnects entirely inside
    // Swift/Rust (NetworkService.connectVoiceWebSocket / run_voice_transport) — JS
    // never even learns it happened. So any blip past 12 s (Wi-Fi roam, VPN re-key,
    // sleep) turned that one participant into a ghost: their UI still showed a live
    // call, but the server no longer routed signals to them (route_voice_signal
    // rejects a non-participant sender) and everyone else got a roster without them
    // and tore down the peer. voice_join is idempotent, so re-sending it is enough.
    sendVoiceRoomPresence() {
        const roomId = String(this.voice.roomId || '').trim();
        if (!roomId) return false;
        const status = String(this.voice.status || '');
        // Not while a DM invite is still ringing — the room is 'ringing' then and
        // joining it would make us a participant before the call is even accepted.
        if (status !== 'connecting' && status !== 'connected') return false;
        const roomType = String(this.voice.roomType || '').trim();
        if (roomType !== 'channel' && roomType !== 'dm') return false;
        return this.sendVoiceEvent({
            type: 'voice_join',
            roomId,
            roomType,
            serverId: this.voice.serverId,
            channelId: this.voice.channelId,
            // Marks this as a membership re-assert rather than a real join, so the
            // server treats it as non-destructive: it may put us back into a room we
            // were evicted from, but must never move us out of one we are still in.
            // Rooms are tracked per ACCOUNT, not per device — without this flag two
            // devices on the same account in two different rooms would evict each
            // other every keepalive tick and flap both calls forever.
            keepalive: true,
        });
    }

    ensureVoicePresenceKeepalive() {
        if (this.voice.presenceTimer) return;
        // Far shorter than the server's eviction window, so a reconnect that lands
        // inside it never costs the call; if it lands after, this is what brings the
        // participant back instead of leaving them silently dropped. Also the first
        // thing that runs after a transport reconnect (voice_transport_state), so in
        // practice membership is re-asserted immediately rather than up to 8 s later.
        this.voice.presenceTimer = setInterval(() => {
            if (!String(this.voice.roomId || '').trim()) {
                this.stopVoicePresenceKeepalive();
                return;
            }
            this.sendVoiceRoomPresence();
        }, 8000);
    }

    stopVoicePresenceKeepalive() {
        if (this.voice.presenceTimer) {
            clearInterval(this.voice.presenceTimer);
            this.voice.presenceTimer = null;
        }
    }

    async syncVoicePeers() {
        const participants = Array.isArray(this.voice.participants) ? this.voice.participants : [];
        const peers = participants
            .map(name => String(name || '').trim())
            .filter(Boolean)
            .filter(name => name !== this.myName());
        const nextPeers = new Set(peers);
        // The retry budget is a single global counter, so in a group call one peer
        // that keeps failing used to burn all 8 attempts and then nothing — for any
        // peer — could ever retry again. A changed roster is a genuinely new
        // situation (someone joined or left), so give it a fresh budget.
        const rosterKey = peers.slice().sort().join(' ');
        const rosterChanged = this.voice.peerRosterKey !== rosterKey;
        if (rosterChanged) {
            const previous = this.voice.peerRosterKey;
            this.voice.peerRosterKey = rosterKey;
            this.voice.negotiationRetries = 0;
            // Always-on: who is in the room, and when it changed, is the frame every
            // other voice line has to be read against — a peer that "never got an
            // offer" usually turns out to have joined after the pass that would have
            // sent it.
            this.voiceDiag('roster-changed', {
                roomId: this.voice.roomId || '',
                roomType: this.voice.roomType || '',
                status: this.voice.status || '',
                peers,
                count: peers.length,
                was: previous || '(none)',
            });
            if (peers.length > ZaliInterface.MAX_MESH_AUDIO_PEERS) {
                this.voiceDiag('mesh-size-over-comfort', {
                    roomId: this.voice.roomId || '',
                    peers: peers.length,
                    limit: ZaliInterface.MAX_MESH_AUDIO_PEERS,
                }, 'WARN');
            }
        }
        this.voiceTrace('sync-peers', {
            roomId: this.voice.roomId || '',
            roomType: this.voice.roomType || '',
            status: this.voice.status || '',
            me: this.myName(),
            peers,
            localStream: !!this.voice.localStream,
        });

        for (const peer of this.voice.peerConnections.keys()) {
            if (!nextPeers.has(peer)) {
                this.closeVoicePeer(peer);
            }
        }

        let offerPending = false;
        for (const peer of peers) {
            const entry = this.getVoicePeerEntry(peer);
            let attachedNow = false;
            try {
                attachedNow = await this.attachLocalVoiceTracks(peer);
            } catch (error) {
                // One connection refusing tracks must not abandon the pass for
                // everyone else: this loop is the only thing that offers to the
                // remaining peers, so an escaping exception here silences the whole
                // room to fix nothing. Retry covers the peer that failed.
                this.voiceDiag('sync-peer-attach-failed', {
                    peer,
                    roomId: this.voice.roomId || '',
                    error: error?.message || String(error),
                }, 'ERROR');
                this.scheduleVoiceNegotiationRetry('attach-failed');
                continue;
            }
            // A peer whose offer we answered before the microphone was ready got a
            // recvonly answer, and nothing renegotiated once the mic did arrive — so
            // that side of the call stayed permanently silent. Adding tracks to an
            // already-negotiated connection has no effect without a fresh offer.
            if (attachedNow && entry.pc.remoteDescription) {
                this.voiceTrace('late-local-tracks-renegotiate', { peer, roomId: this.voice.roomId || '' }, 'WARN');
                await this.renegotiateVoicePeer(peer);
            }
            this.attachLocalScreenTrackToPeer(peer);
            if (!this.shouldInitiateVoiceOffer(peer)) continue;
            if (!this.voice.localStream) {
                // We owe this peer an offer but have no mic yet (permission prompt
                // still open, device busy). Nothing else re-drove this before, so the
                // call just stayed silent forever.
                offerPending = true;
                continue;
            }
            if (entry.offerSent) continue;
            try {
                await this.sendVoiceOffer(peer);
            } catch (e) {
                this.addLogEntry({ type: 'ERROR', msg: `Не удалось начать голосовой обмен с ${peer}`, ts: new Date().toLocaleTimeString() });
            }
            if (!entry.offerSent) offerPending = true;
        }
        if (offerPending) {
            this.scheduleVoiceNegotiationRetry('offer-pending');
        } else if (peers.length) {
            this.voice.negotiationRetries = 0;
        }
        // The video budget is divided by the roster, and the roster just moved, so
        // limits computed for a smaller call are now several times too generous.
        // Done HERE rather than next to the roster-change detection at the top: the
        // peer connections the budget is divided by are created and closed by the
        // loop above, so up there the count is still the previous roster's and the
        // recomputed limit would be one roster behind.
        if (rosterChanged) void this.refreshVoiceSenderLimits();
        this.renderVoicePanel();
    }

    async joinVoiceChannel({ serverId = null, channelId = null } = {}) {
        const server = this.currentServer();
        const channel = server && channelId ? (server.channels || []).find(ch => ch.id === channelId) : this.currentChannel();
        const sid = String(serverId || server?.id || '').trim();
        const cid = String(channelId || channel?.id || '').trim();
        if (!sid || !cid) return;
        if (!this.isVoiceChannel(channel)) {
            return;
        }
        const roomId = this.voiceRoomKeyForChannel(sid, cid);
        if (!roomId) return;
        // Joining a voice channel used to overwrite live call state exactly the way
        // startDirectCall did: an in-progress DM call (or another voice channel) was
        // never left, so the server kept us in the old room while the UI showed the
        // new one. Same room = idempotent no-op instead of a redundant re-join.
        const activeRoomId = String(this.voice.roomId || '').trim();
        if (activeRoomId === roomId && this.isInActiveCall()) {
            this.renderVoicePanel();
            return;
        }
        if (activeRoomId && this.isInActiveCall()) {
            await this.endCurrentVoiceSession({ reason: 'join-voice-channel' });
        }
        void this.refreshVoiceTurnCredentials();
        // Channel joins never unlocked playback, so the AudioContext could stay
        // suspended for the whole session — this is a click handler, i.e. the one
        // moment the browser lets us resume it. Not awaited: see unlockVoicePlayback.
        void this.unlockVoicePlayback();
        // Capture the mic HERE, in the click handler, not only from the voice_room_state
        // that comes back over the WS. Both DM paths (startDirectCall /
        // performAcceptIncomingCall) already do this; the channel path was the one that
        // asked for the microphone from an async WS event instead — and Safari (desktop
        // and every iOS browser, including the installed PWA) rejects a getUserMedia
        // permission prompt that isn't tied to a user gesture. The result was a call
        // that joined the room, rendered as «В эфире», and never sent a single offer,
        // because syncVoicePeers has no tracks to offer with. Failure is non-fatal: the
        // room is still joined (the peer may be audible one way), micError explains why.
        try {
            await this.ensureVoiceLocalStream();
        } catch (error) {
            this.addLogEntry({
                type: 'WARN',
                msg: this.voice.micError || error?.message || 'Не удалось получить доступ к микрофону',
                ts: new Date().toLocaleTimeString(),
            });
        }
        this.voice.negotiationRetries = 0;
        this.voice.roomId = roomId;
        this.voice.roomType = 'channel';
        this.voice.serverId = sid;
        this.voice.channelId = cid;
        this.voice.status = 'connecting';
        this.voice.participants = [];
        this.sendVoiceEvent({
            type: 'voice_join',
            roomId,
            roomType: 'channel',
            serverId: sid,
            channelId: cid,
        });
        this.ensureVoicePresenceKeepalive();
        this.renderVoicePanel();
    }

    async leaveVoiceRoom({ announce = true, outcome = 'completed' } = {}) {
        const roomId = String(this.voice.roomId || '').trim();
        this.voiceDiag('leave-room', {
            roomId,
            roomType: this.voice.roomType || '',
            announce,
            outcome,
            participants: Array.isArray(this.voice.participants) ? this.voice.participants : [],
        });
        if (this.voice.roomType === 'dm' && roomId && this.voice.callTrack && !this.voice.callTrack.recorded) {
            this.recordVoiceCallHistory({ outcome, endedAt: Date.now() });
        }
        if (announce && roomId) {
            this.sendVoiceEvent({
                type: 'voice_leave',
                roomId,
                roomType: this.voice.roomType,
                serverId: this.voice.serverId,
                channelId: this.voice.channelId,
            });
        }
        this.resetVoiceState();
    }

    // Tears down whatever voice session is live right now, picking the signal its
    // state actually requires: a ringing *outgoing* invite must be cancelled, a
    // ringing *incoming* one rejected, an established room left. Starting a new
    // call used to just overwrite roomId/callTrack/participants in place, which
    // left the previous room alive on the server (nobody ever sent voice_leave)
    // and its RTCPeerConnections running headless — the "звонок поверх звонка"
    // the user hit by pressing a call button mid-call.
    async endCurrentVoiceSession({ reason = 'switch' } = {}) {
        const roomId = String(this.voice.roomId || '').trim();
        const status = String(this.voice.status || '');
        const outgoing = this.voice.outgoingInvite;
        const incoming = this.voice.incomingInvite;
        this.voiceTrace('end-current-session', { reason, roomId, status });
        if (status === 'incoming' && incoming?.roomId && incoming?.from) {
            await this.rejectIncomingCall();
            return;
        }
        if (status === 'calling' && outgoing?.roomId && outgoing?.target) {
            this.sendVoiceEvent({
                type: 'voice_call_cancel',
                roomId: outgoing.roomId,
                target: outgoing.target,
            });
            this.recordVoiceCallHistory({ outcome: 'cancelled', endedAt: Date.now() });
            this.resetVoiceState({ preserveInvite: false });
            return;
        }
        if (roomId) {
            await this.leaveVoiceRoom({ announce: true, outcome: 'completed' });
            return;
        }
        this.resetVoiceState({ preserveInvite: false });
    }
});
