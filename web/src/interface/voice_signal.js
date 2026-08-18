// --- ZaliInterface: Обработка входящих voice_* сигналов и событий. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // handleVoiceEvent is dispatched fire-and-forget from both sockets, so signal
    // application used to interleave freely across its awaits (ensureVoiceLocalStream,
    // setRemoteDescription, createAnswer). With one peer that is mostly survivable;
    // in a group call every extra participant multiplies the traffic and two signals
    // for the SAME peer routinely overlapped — an ICE candidate reading
    // `pc.remoteDescription` as null mid-way through the offer handler got queued
    // into pendingIceCandidates *after* flushPendingVoiceIceCandidates had already
    // drained it, so those candidates sat there forever and that one pair never
    // completed ICE. Chain per peer: different peers still negotiate in parallel
    // (a blocked mic prompt for one must not stall the rest), signals for the same
    // peer apply strictly in order.
    async handleVoiceSignal(signal = {}) {
        const peer = String(signal.from || signal.sender || '').trim();
        if (!peer) return;
        const chains = this.voice.signalChains || (this.voice.signalChains = new Map());
        const previous = chains.get(peer) || Promise.resolve();
        const result = previous.then(() => this.applyVoiceSignal(signal));
        // The stored tail swallows rejections so one failed signal can't poison
        // every later signal from that peer; the caller still sees the real result.
        const tail = result.catch(() => {});
        chains.set(peer, tail);
        try {
            return await result;
        } finally {
            // Drop the entry once this was the last queued signal, so a long-lived
            // room doesn't retain a promise per peer that ever spoke to us.
            if (chains.get(peer) === tail) chains.delete(peer);
        }
    }

    async applyVoiceSignal(signal = {}) {
        const roomId = String(signal.roomId || '').trim();
        const from = String(signal.from || signal.sender || '').trim();
        const signalPayload = signal.signal || signal.payload || signal;
        if (!roomId || !from || !signalPayload) return;
        // Signals were applied no matter which room they belonged to, and the offer
        // branch below writes roomId/roomType/targetUser/inviter straight from the
        // signal — so one late offer/ICE packet from a room we already left (a
        // cancelled invite, a call the peer restarted) re-pointed the live session at
        // a dead room and killed the call in progress. Only the room we are actually
        // in may drive negotiation.
        const currentRoomId = String(this.voice.roomId || '').trim();
        if (currentRoomId && roomId !== currentRoomId) {
            this.voiceTrace('signal-foreign-room', {
                roomId,
                currentRoomId,
                from,
                signalType: signalPayload.type || '',
            }, 'WARN');
            return;
        }
        this.voiceTrace('signal-recv', {
            roomId,
            from,
            to: signal.to || '',
            signalType: signalPayload.type || '',
            roomType: signal.roomType || this.voice.roomType || '',
        });

        if (signalPayload.type === 'offer') {
            // A peer that was evicted and re-joined (or simply gave up on this link)
            // builds a brand-new RTCPeerConnection, so its offer carries new ICE
            // credentials and a new DTLS fingerprint. Feeding that to a pc whose
            // transport already died never recovers — the returning participant
            // stayed silently outside the call while everyone else reconnected fine.
            // Rebuild instead of trying to revive a terminal connection.
            const stale = this.voice.peerConnections.get(from);
            if (stale && (stale.pc.connectionState === 'failed' || stale.pc.signalingState === 'closed')) {
                this.voiceTrace('offer-on-dead-peer-rebuild', {
                    roomId,
                    from,
                    state: stale.pc.connectionState,
                    signaling: stale.pc.signalingState,
                }, 'WARN');
                this.closeVoicePeer(from);
            }
            let entry = this.getVoicePeerEntry(from);
            // Mid-call renegotiation (camera/screen-share toggles) means either
            // side can now send an offer at any time, not just once at call
            // setup — so two peers toggling near-simultaneously can each have a
            // local offer outstanding when the other's offer arrives ("glare").
            // A bare setRemoteDescription(offer) in that state throws. Resolve it
            // with a minimal polite/impolite split (mirrors shouldInitiateVoiceOffer's
            // tie-break): the polite side rolls back its own offer and accepts the
            // incoming one; the impolite side ignores the incoming offer and waits
            // for its own outgoing offer to be answered instead.
            const offerCollision = entry.pc.signalingState !== 'stable';
            if (offerCollision && !this.isPoliteVoicePeer(from)) {
                // We own the offer for this pair, so we keep it and let the peer
                // answer. Re-drive negotiation anyway: dropping an offer is only
                // safe while ours is genuinely still in flight, and if the answer
                // never arrives nothing else would ever notice.
                this.voiceTrace('offer-collision-ignored', { roomId, from, state: entry.pc.signalingState }, 'WARN');
                this.scheduleVoiceNegotiationRetry('offer-collision-ignored');
                return;
            }
            // We are going to accept this offer, so the connection has to be in a
            // state that can actually take one. 'stable' can; 'have-local-offer' can
            // once we roll our own offer back. Every other non-stable state
            // ('have-remote-offer', the pranswer pair) cannot — setRemoteDescription
            // throws InvalidStateError from there, and the old code walked straight
            // into it via an `else if (offerCollision)` branch that logged
            // "offer-collision-no-rollback" and carried on regardless.
            //
            // That is the failure in the production log, on three separate calls:
            //   ERROR [VOICE] offer-apply-error ... error=The object is in an invalid state.
            // The throw aborted the block before createAnswer(), so no answer was ever
            // built or sent, and the caller sat in have-local-offer until its watchdog
            // gave up — the matching "answer-never-arrived attempt=1/2" on the other side.
            //
            // A connection wedged in a state that cannot take an offer holds nothing
            // worth preserving, so rebuild it and let the offer land on a fresh
            // 'stable' one. Same reasoning as the dead-transport rebuild above.
            if (offerCollision && entry.pc.signalingState !== 'have-local-offer') {
                this.voiceTrace('offer-unapplicable-rebuild', {
                    roomId,
                    from,
                    state: entry.pc.signalingState,
                }, 'WARN');
                this.closeVoicePeer(from);
                entry = this.getVoicePeerEntry(from);
            }
            this.voice.roomId = roomId;
            this.voice.roomType = signal.roomType || this.voice.roomType || 'dm';
            this.voice.serverId = signal.serverId || this.voice.serverId || '';
            this.voice.channelId = signal.channelId || this.voice.channelId || '';
            this.voice.targetUser = signal.target || this.voice.targetUser || '';
            this.voice.inviter = signal.from || this.voice.inviter || '';
            // Only downgrade to 'connecting' for the initial call setup offer.
            // Camera/screen-share toggles send a fresh offer to an already-
            // connected peer too (mid-call renegotiation) — RTCPeerConnection's
            // connectionState doesn't change for that (no ICE restart), so
            // onconnectionstatechange never fires again to bring status back to
            // 'connected'. Downgrading here unconditionally used to leave the
            // call stuck showing "connecting" after the very first toggle.
            if (this.voice.status !== 'connected') {
                this.voice.status = 'connecting';
            }
            // Answering is a negotiation too, and it holds the same latch offers use.
            // Per-peer signal chaining orders incoming signals, but syncVoicePeers is
            // driven independently by voice_room_state — which in a group call fires
            // on every join/leave. Without this, a sync landing in the window between
            // ensureVoiceLocalStream() and setRemoteDescription() still saw 'stable'
            // and sent its own offer, and the setRemoteDescription that followed threw
            // InvalidStateError, leaving that one link unnegotiated.
            entry.negotiating = true;
            try {
                // 'have-local-offer' is the only state a rollback is legal from.
                // Attempting it from any other non-stable state throws, and that
                // exception used to abort the whole block — so the answer this peer
                // was waiting for was never created or sent.
                // The only non-stable state that can still reach here: anything else
                // was rebuilt above, so there is no longer a path that tries to apply
                // an offer to a connection that cannot take one.
                if (entry.pc.signalingState === 'have-local-offer') {
                    this.voiceTrace('offer-collision-rollback', { roomId, from, state: entry.pc.signalingState }, 'WARN');
                    await entry.pc.setLocalDescription({ type: 'rollback' });
                }
                try {
                    // Bounded on purpose. getUserMedia() stays pending for as long as
                    // the permission dialog is open, and this await sits in front of
                    // the ANSWER — so while the callee reads that dialog the caller is
                    // not heard either, although receiving audio needs no permission
                    // whatsoever. Answering recvonly first turns "both sides silent
                    // until the dialog is dismissed" into "audible one way at once,
                    // both ways as soon as the mic lands". Well under the peer's 8 s
                    // answer watchdog, so the answer still arrives before it gives up.
                    if (!await this.awaitVoiceLocalStream(4000)) {
                        this.voiceDiag('answering-before-mic-ready', { roomId, from }, 'WARN');
                        this.scheduleVoiceNegotiationRetry('offer-before-mic-ready');
                    }
                } catch (error) {
                    this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
                    // Answering without local tracks produces a recvonly answer; retry
                    // so the mic can still join the call once it becomes available.
                    this.scheduleVoiceNegotiationRetry('offer-without-mic');
                }
                await this.attachLocalVoiceTracks(from);
                this.voiceTrace('signal-offer-apply', { roomId, from, localStream: !!this.voice.localStream, peer: from });
                try {
                    await entry.pc.setRemoteDescription(signalPayload.sdp);
                } catch (error) {
                    if (!this.isVoiceSessionShapeError(error)) throw error;
                    // The offer is fine; this connection's established media layout
                    // is what refuses it, and only a connection without one can
                    // accept it. Seen in production on 2026-08-03 in a channel call:
                    // the same offer failed twice in three seconds and the link went
                    // to 'disconnected' — the generic recovery below just re-armed a
                    // negotiation that replayed the identical mismatch.
                    this.voiceDiag('offer-sdp-shape-rebuild', {
                        roomId,
                        from,
                        error: error?.message || String(error),
                    }, 'WARN');
                    this.closeVoicePeer(from);
                    entry = this.getVoicePeerEntry(from);
                    // The fresh entry needs the latch the old one was holding, or a
                    // syncVoicePeers pass landing in the awaits below sees 'stable'
                    // and starts offering into the middle of this answer.
                    entry.negotiating = true;
                    await this.attachLocalVoiceTracks(from);
                    await entry.pc.setRemoteDescription(signalPayload.sdp);
                }
                await this.flushPendingVoiceIceCandidates(entry, from);
                const answer = await entry.pc.createAnswer();
                await entry.pc.setLocalDescription(answer);
                this.voiceTrace('signal-answer-send', {
                    roomId,
                    from,
                    peer: from,
                    localDesc: entry.pc.localDescription?.type || 'answer',
                    sdpLength: entry.pc.localDescription?.sdp?.length || 0,
                });
                this.sendVoiceEvent({
                    type: 'voice_signal',
                    roomId,
                    roomType: this.voice.roomType,
                    serverId: this.voice.serverId,
                    channelId: this.voice.channelId,
                    to: from,
                    signal: {
                        type: 'answer',
                        sdp: {
                            type: entry.pc.localDescription?.type || 'answer',
                            sdp: entry.pc.localDescription?.sdp || '',
                        },
                    },
                });
                this.voice.participants = Array.from(new Set([this.myName(), from].concat(this.voice.participants || [])));
                if (offerCollision) {
                    // Rolling back discarded whatever WE were offering (a freshly
                    // added camera/screen track, an ICE restart) — the answer we just
                    // sent describes the peer's offer, not our pending change, so
                    // without re-offering, that change never reaches this peer.
                    this.voiceTrace('offer-collision-requeue', { roomId, from }, 'WARN');
                    entry.renegotiationPending = true;
                }
            } catch (error) {
                this.voiceDiag('offer-apply-error', { roomId, from, error: error?.message || String(error) }, 'ERROR');
                this.addLogEntry({ type: 'WARN', msg: error?.message || `Не удалось применить предложение звонка от ${from}`, ts: new Date().toLocaleTimeString() });
                // Recover, don't just report. Failing here means no answer was sent,
                // so this link is silent — and nothing else was watching it: the
                // answer watchdog only supervises offers WE sent, and the peer's own
                // retries land back in whatever state broke this attempt. The answer
                // branch below has had this recovery all along; the offer branch
                // ending in a bare log is why a single bad apply killed a call for
                // good instead of costing it one negotiation round.
                entry.offerSent = false;
                this.scheduleVoiceNegotiationRetry('offer-apply-failed');
            } finally {
                entry.negotiating = false;
                // onsignalingstatechange already fired for the answer while the latch
                // was still held, so it skipped the drain — do it here instead, or a
                // requeued renegotiation would sit until some unrelated state change.
                if (entry.renegotiationPending && entry.pc.signalingState === 'stable') {
                    entry.renegotiationPending = false;
                    this.renegotiateVoicePeer(from).catch(() => {});
                }
            }
            this.renderVoicePanel();
            return;
        }

        const entry = this.getVoicePeerEntry(from);
        if (signalPayload.type === 'answer') {
            // An answer is only applicable to an offer we still have outstanding.
            // Applying one in any other signaling state throws InvalidStateError —
            // and this used to be an unguarded await inside an async handler, so the
            // rejection aborted the rest of handleVoiceEvent and surfaced as an
            // unhandled rejection instead of a recoverable call. It happens for real:
            // a rolled-back offer (glare) or a peer that restarted its connection
            // leaves us 'stable' while its answer is still in flight.
            if (entry.pc.signalingState !== 'have-local-offer') {
                this.voiceDiag('signal-answer-ignored', {
                    roomId,
                    from,
                    state: entry.pc.signalingState,
                }, 'WARN');
                return;
            }
            this.voiceTrace('signal-answer-apply', {
                roomId,
                from,
                peer: from,
                remoteDesc: !!signalPayload.sdp,
                sdpType: signalPayload.sdp?.type || '',
                sdpLength: signalPayload.sdp?.sdp?.length || 0,
            });
            try {
                await entry.pc.setRemoteDescription(signalPayload.sdp);
                this.clearVoiceAnswerWatchdog(entry);
                // The budget is per stuck negotiation, not per call: a link that
                // answers again has proved it is alive, so a later loss gets the
                // full set of retries rather than the remainder of an old one.
                entry.answerRetries = 0;
                await this.flushPendingVoiceIceCandidates(entry, from);
                this.voice.status = 'connected';
            } catch (error) {
                this.voiceDiag('answer-apply-error', { roomId, from, error: error?.message || String(error) }, 'ERROR');
                if (this.isVoiceSessionShapeError(error)) {
                    // Same immutable-layout dead end as the offer branch, reached
                    // from the other side: our next offer would be built from the
                    // very layout the peer just refused to match, so the retry
                    // needs a connection that carries no layout at all.
                    this.voiceDiag('answer-sdp-shape-rebuild', { roomId, from }, 'WARN');
                    this.closeVoicePeer(from);
                } else {
                    // The offer is dead — clear the latch so the negotiation retry below
                    // can produce a fresh one instead of leaving a mute call standing.
                    entry.offerSent = false;
                }
                this.scheduleVoiceNegotiationRetry('answer-apply-failed');
            }
            this.renderVoicePanel();
            return;
        }

        if (signalPayload.type === 'screen-meta') {
            if (signalPayload.action === 'start' && signalPayload.streamId) {
                entry.remoteScreenStreamId = String(signalPayload.streamId);
                // This id-announcement and the SDP offer carrying the actual
                // track are two independent signals — if ontrack already fired
                // before this arrived, the stream was filed as camera video
                // (attachRemoteVoiceStream) for lack of an id to match. Re-route
                // it now instead of leaving it stuck in the camera bubble.
                const misfiledVideo = this.voice.remoteVideos.get(from);
                if (misfiledVideo?.srcObject && misfiledVideo.srcObject.id === entry.remoteScreenStreamId) {
                    const misroutedStream = misfiledVideo.srcObject;
                    this.voice.remoteVideos.delete(from);
                    try { misfiledVideo.pause?.(); misfiledVideo.srcObject = null; misfiledVideo.remove?.(); } catch (e) {}
                    this.attachRemoteScreenStream(from, misroutedStream);
                }
                this.voiceTrace('screen-meta-start', { roomId, from, streamId: entry.remoteScreenStreamId });
            } else if (signalPayload.action === 'stop') {
                entry.remoteScreenStreamId = null;
                this.detachRemoteScreenStream(from);
                this.voiceTrace('screen-meta-stop', { roomId, from });
            }
            this.renderVoicePanel();
            return;
        }

        if (signalPayload.type === 'ice' && signalPayload.candidate) {
            try {
                entry.receivedIceCandidates = (entry.receivedIceCandidates || 0) + 1;
                const candidateInfo = this.describeIceCandidate(signalPayload.candidate.candidate || '');
                this.voiceTrace('signal-ice-recv', {
                    roomId,
                    from,
                    peer: from,
                    count: entry.receivedIceCandidates,
                    candidateType: candidateInfo.type,
                    protocol: candidateInfo.protocol,
                    address: candidateInfo.address,
                });
                if (entry.pc.remoteDescription) {
                    this.voiceTrace('signal-ice-apply', { roomId, from, peer: from, queued: false });
                    await entry.pc.addIceCandidate(signalPayload.candidate);
                } else {
                    entry.pendingIceCandidates = entry.pendingIceCandidates || [];
                    entry.pendingIceCandidates.push(signalPayload.candidate);
                    this.voiceTrace('signal-ice-queue', { roomId, from, peer: from, queued: true, queueSize: entry.pendingIceCandidates.length });
                }
            } catch (e) {
                console.warn('Failed to add ICE candidate', e);
                this.voiceTrace('signal-ice-error', { roomId, from, peer: from, error: e?.message || String(e) }, 'WARN');
            }
        }
    }

    // De-duplicates voice_* events that may now legitimately arrive twice — once
    // over the dedicated voice WebSocket, once over the more reliable main
    // message socket's fallback forwarding (see voiceEventPayload). Keeps a
    // small bounded window of recently-seen vids rather than growing forever.
    isDuplicateVoiceEvent(vid) {
        const id = String(vid || '').trim();
        if (!id) return false;
        const seen = this.voice.recentEventIds || (this.voice.recentEventIds = new Map());
        const now = Date.now();
        for (const [key, ts] of seen) {
            if (now - ts > 60000) seen.delete(key);
        }
        if (seen.has(id)) return true;
        seen.set(id, now);
        return false;
    }

    async handleVoiceEvent(payload = {}) {
        const eventType = String(payload?.type || '').trim();
        if (!eventType) return;
        if (this.isDuplicateVoiceEvent(payload.vid)) {
            this.voiceTrace('event-dedup', { eventType, vid: payload.vid || '' }, 'INFO');
            return;
        }
        this.voiceTrace('event-recv', {
            eventType,
            roomId: payload.roomId || '',
            roomType: payload.roomType || '',
            from: payload.from || '',
            target: payload.target || '',
        });

        if (eventType === 'voice_call_invite') {
            const from = String(payload.from || '').trim();
            const roomId = String(payload.roomId || '').trim();
            // Busy guard: an invite used to overwrite voice state unconditionally —
            // an incoming call from a third user mid-call clobbered callTrack /
            // incomingInvite and flipped the UI to "входящий звонок", killing the
            // active call's state (the RTCPeerConnections kept running headless).
            // Auto-reject instead; the server allows the target of a ringing room
            // to reject it, so the caller gets a normal voice_call_rejected.
            const activeRoomId = String(this.voice.roomId || '').trim();
            // Mutual invite is GLARE, not "busy". isInActiveCall() counts 'calling'
            // and 'incoming', so a merely ringing invite made us auto-reject anything
            // arriving — including the invite from the very person we were calling.
            // Both sides do it at once, both rooms die, and nobody ever answers: the
            // production log for 2026-08-02 shows 15 invites, 124 rejects and zero
            // answers for exactly this. It needs only both people to tap «Позвонить»
            // in the same few seconds, which is precisely what they do when a call
            // did not connect the first time.
            //
            // Resolve it the same way SDP glare is resolved — one deterministic owner
            // (compareVoicePeerNames is engine-independent, unlike localeCompare) —
            // and never reject: rejecting tears down the peer's room too, so the pair
            // ends up with no call at all instead of one.
            const activePeer = String(this.voice.targetUser || this.voice.inviter || '').trim();
            const samePeer = !!from && !!activePeer && from.toLowerCase() === activePeer.toLowerCase();
            const ringing = this.voice.status === 'calling' || this.voice.status === 'incoming';
            if (activeRoomId && activeRoomId !== roomId && samePeer && ringing) {
                const iOwnTheCall = this.compareVoicePeerNames(this.myName(), from) < 0;
                if (iOwnTheCall && this.voice.status === 'calling') {
                    // Keep our own invite; the peer drops theirs and answers ours.
                    this.voiceDiag('invite-glare-keep-ours', {
                        roomId, from, activeRoomId, status: this.voice.status,
                    }, 'WARN');
                    return;
                }
                // We do not own it: withdraw our invite and let theirs be the call.
                this.voiceDiag('invite-glare-adopt-theirs', {
                    roomId, from, activeRoomId, status: this.voice.status,
                }, 'WARN');
                const ourInvite = String(this.voice.outgoingInvite?.roomId || activeRoomId || '').trim();
                if (ourInvite && ourInvite !== roomId) {
                    this.sendVoiceEvent({
                        type: 'voice_call_cancel',
                        roomId: ourInvite,
                        target: from,
                    });
                    // Our own voice_call_outgoing / room_state for the withdrawn room
                    // are usually still in flight and would drag us back to 'calling',
                    // undoing the adoption a moment after it happened.
                    this.abandonVoiceRoom(ourInvite);
                }
                this.voice.outgoingInvite = null;
                // Fall through: the incoming invite below becomes the live call.
            } else if (activeRoomId && activeRoomId !== roomId && this.isInActiveCall()) {
                this.voiceTrace('incoming-invite-busy', { roomId, from, activeRoomId, status: this.voice.status }, 'WARN');
                this.sendVoiceEvent({
                    type: 'voice_call_reject',
                    roomId,
                    inviter: from,
                });
                this.addLogEntry({ type: 'INFO', msg: `Входящий звонок от ${from} отклонён: уже идёт другой звонок`, ts: new Date().toLocaleTimeString() });
                return;
            }
            this.voice.incomingInvite = {
                roomId,
                from,
                roomType: 'dm',
            };
            this.voice.inviter = from;
            this.voice.callTrack = {
                roomId,
                peer: from,
                roomType: 'dm',
                direction: 'incoming',
                startedAt: Date.now(),
                connectedAt: 0,
                endedAt: 0,
                outcome: 'incoming',
                recorded: false,
            };
            this.voice.outgoingInvite = null;
            this.voice.status = 'incoming';
            this.voiceTrace('incoming-invite', { roomId, from });
            this.renderVoicePanel();
            return;
        }

        if (eventType === 'voice_call_outgoing') {
            if (this.isAbandonedVoiceRoom(payload.roomId)) {
                this.voiceDiag('outgoing-ring-ignored-abandoned', { roomId: payload.roomId || '' }, 'WARN');
                return;
            }
            this.voice.outgoingInvite = {
                roomId: String(payload.roomId || '').trim(),
                target: String(payload.target || '').trim(),
            };
            this.voice.targetUser = String(payload.target || '').trim();
            this.voice.status = 'calling';
            this.voiceTrace('outgoing-ring', { roomId: this.voice.outgoingInvite.roomId, target: this.voice.targetUser });
            this.renderVoicePanel();
            return;
        }

        if (eventType === 'voice_signal') {
            this.voiceTrace('signal-event', {
                roomId: payload.roomId || '',
                from: payload.from || payload.sender || '',
                to: payload.to || '',
                signalType: payload.signal?.type || payload.payload?.type || '',
            });
            await this.handleVoiceSignal(payload);
            return;
        }

        if (eventType === 'voice_call_rejected') {
            if (this.voice.outgoingInvite?.roomId === String(payload.roomId || '').trim()) {
                this.voiceTrace('outgoing-rejected', { roomId: payload.roomId || '', from: payload.from || '' }, 'WARN');
                this.recordVoiceCallHistory({ outcome: 'rejected', endedAt: Date.now() });
                this.resetVoiceState({ preserveInvite: false });
            }
            return;
        }

        if (eventType === 'voice_call_cancelled') {
            if (this.voice.incomingInvite?.roomId === String(payload.roomId || '').trim()) {
                this.voiceTrace('incoming-cancelled', { roomId: payload.roomId || '', from: payload.from || '' }, 'WARN');
                this.recordVoiceCallHistory({ outcome: 'cancelled', endedAt: Date.now() });
                this.resetVoiceState({ preserveInvite: false });
            }
            return;
        }

        if (eventType === 'voice_call_missed') {
            const roomId = String(payload.roomId || '').trim();
            if (this.voice.incomingInvite?.roomId === roomId || this.voice.outgoingInvite?.roomId === roomId) {
                this.voiceTrace('call-missed', { roomId, from: payload.from || '', target: payload.target || '' }, 'WARN');
                this.recordVoiceCallHistory({ outcome: 'missed', endedAt: Date.now() });
                this.resetVoiceState({ preserveInvite: false });
            }
            return;
        }

        if (eventType === 'voice_call_accepted') {
            const roomId = String(payload.roomId || '').trim();
            const me = String(this.myName() || '').trim();
            const from = String(payload.from || '').trim();
            const target = String(payload.target || '').trim();
            const remotePeer = from && from !== me ? from : target;
            const callOwner = target || this.voice.inviter || '';
            const participants = Array.isArray(payload.participants)
                ? payload.participants.map(name => String(name || '').trim()).filter(Boolean)
                : [payload.from, payload.target].map(name => String(name || '').trim()).filter(Boolean);
            this.voice.roomId = roomId || this.voice.roomId;
            this.voice.roomType = 'dm';
            this.voice.targetUser = remotePeer || this.voice.targetUser || '';
            this.voice.inviter = callOwner || this.voice.inviter || '';
            this.voice.participants = participants.length ? participants : this.voice.participants;
            this.voice.status = 'connected';
            if (roomId && String(this.voice.outgoingInvite?.roomId || '').trim() === roomId) {
                this.voice.outgoingInvite = null;
            }
            if (roomId && String(this.voice.incomingInvite?.roomId || '').trim() === roomId) {
                this.voice.incomingInvite = null;
            }
            this.voiceTrace('call-accepted', { roomId, from, target, participants });
            if (this.voice.callTrack) {
                this.voice.callTrack.connectedAt = this.voice.callTrack.connectedAt || Date.now();
                this.voice.callTrack.outcome = 'connected';
            }
            this.renderVoicePanel();
            try {
                await this.ensureVoiceLocalStream();
            } catch (error) {
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
            }
            await this.syncVoicePeers();
            return;
        }

        if (eventType === 'voice_call_connected') {
            const roomId = String(payload.roomId || '').trim();
            const me = String(this.myName() || '').trim();
            const from = String(payload.from || '').trim();
            const target = String(payload.target || '').trim();
            const remotePeer = from && from !== me ? from : target;
            const callOwner = target || this.voice.inviter || '';
            const participants = Array.isArray(payload.participants)
                ? payload.participants.map(name => String(name || '').trim()).filter(Boolean)
                : [payload.from, payload.target].map(name => String(name || '').trim()).filter(Boolean);
            this.voice.roomId = roomId || this.voice.roomId;
            this.voice.roomType = 'dm';
            this.voice.targetUser = remotePeer || this.voice.targetUser || '';
            this.voice.inviter = callOwner || this.voice.inviter || '';
            this.voice.participants = participants.length ? participants : this.voice.participants;
            this.voice.status = 'connected';
            if (roomId && String(this.voice.outgoingInvite?.roomId || '').trim() === roomId) {
                this.voice.outgoingInvite = null;
            }
            if (roomId && String(this.voice.incomingInvite?.roomId || '').trim() === roomId) {
                this.voice.incomingInvite = null;
            }
            this.voiceTrace('call-connected', { roomId, from, target, participants }, 'SUCCESS');
            if (this.voice.callTrack) {
                this.voice.callTrack.connectedAt = this.voice.callTrack.connectedAt || Date.now();
                this.voice.callTrack.outcome = 'connected';
            }
            this.renderVoicePanel();
            try {
                await this.ensureVoiceLocalStream();
            } catch (error) {
                this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
            }
            await this.syncVoicePeers();
            return;
        }

        if (eventType === 'voice_error') {
            this.addLogEntry({
                type: 'ERROR',
                msg: String(payload.message || 'Ошибка voice'),
                ts: new Date().toLocaleTimeString(),
            });
            return;
        }

        if (eventType === 'voice_room_state') {
            const roomId = String(payload.roomId || '').trim();
            if (this.isAbandonedVoiceRoom(roomId)) {
                this.voiceDiag('room-state-ignored-abandoned', { roomId }, 'WARN');
                return;
            }
            const roomStatus = String(payload.status || '').trim().toLowerCase();
            const roomInitiator = String(payload.initiator || '').trim();
            const roomTarget = String(payload.target || '').trim();
            const participants = Array.isArray(payload.participants) ? payload.participants.map(name => String(name || '').trim()).filter(Boolean) : [];
            const currentRoomId = String(this.voice.roomId || '').trim();
            // Foreign-room guard for ANY active call, not just dm→dm: a user sitting in
            // a channel voice room is made a participant of a new ringing DM room the
            // moment someone invites them, so the broadcastVoiceRoomState for that new
            // room arrives here and used to overwrite roomId/participants/status of the
            // channel session. Only room states for the room we are actually in may
            // mutate live call state while a call is in progress.
            const inActiveCall = this.isInActiveCall();
            if (currentRoomId && roomId && roomId !== currentRoomId && (this.voice.roomType === 'dm' || inActiveCall)) {
                this.voiceTrace('room-state-stale', { roomId, currentRoomId }, 'INFO');
                return;
            }
            this.voice.roomId = roomId;
            this.voice.roomType = String(payload.roomType || this.voice.roomType || '').trim();
            this.voice.serverId = String(payload.serverId || this.voice.serverId || '').trim();
            this.voice.channelId = String(payload.channelId || this.voice.channelId || '').trim();
            this.voice.participants = participants;
            const me = String(this.myName() || '').trim();
            const amParticipant = participants.includes(me);
            if (roomStatus === 'ringing' || roomStatus === 'pending') {
                if (me && roomTarget && me === roomTarget) {
                    this.voice.incomingInvite = {
                        roomId,
                        from: roomInitiator || this.voice.inviter || '',
                        roomType: 'dm',
                    };
                    this.voice.inviter = roomInitiator || this.voice.inviter || '';
                    this.voice.targetUser = roomTarget || this.voice.targetUser || '';
                    this.voice.callTrack = this.voice.callTrack || {
                        roomId,
                        peer: roomInitiator || roomTarget || '',
                        roomType: 'dm',
                        direction: 'incoming',
                        startedAt: Date.now(),
                        connectedAt: 0,
                        endedAt: 0,
                        outcome: 'incoming',
                        recorded: false,
                    };
                    this.voice.status = 'incoming';
                } else if (me && roomInitiator && me === roomInitiator) {
                    this.voice.outgoingInvite = {
                        roomId,
                        target: roomTarget || this.voice.targetUser || '',
                    };
                    this.voice.targetUser = roomTarget || this.voice.targetUser || '';
                    this.voice.inviter = roomInitiator || this.voice.inviter || '';
                    this.voice.callTrack = this.voice.callTrack || {
                        roomId,
                        peer: roomTarget || roomInitiator || '',
                        roomType: 'dm',
                        direction: 'outgoing',
                        startedAt: Date.now(),
                        connectedAt: 0,
                        endedAt: 0,
                        outcome: 'calling',
                        recorded: false,
                    };
                    this.voice.status = 'calling';
                } else {
                    this.voice.status = amParticipant ? 'connecting' : 'idle';
                }
            } else {
                this.voice.status = amParticipant ? 'connected' : 'idle';
            }
            this.voiceTrace('room-state', { roomId, roomType: this.voice.roomType || '', participants });
            if (amParticipant && this.voice.callTrack && !this.voice.callTrack.connectedAt && roomStatus !== 'ringing' && roomStatus !== 'pending') {
                this.voice.callTrack.connectedAt = Date.now();
                this.voice.callTrack.outcome = 'connected';
            }
            if (roomStatus === 'missed') {
                if (this.voice.callTrack && !this.voice.callTrack.connectedAt) {
                    this.voice.callTrack.connectedAt = Date.now();
                    this.voice.callTrack.outcome = 'missed';
                }
                if (this.voice.incomingInvite?.roomId === roomId || this.voice.outgoingInvite?.roomId === roomId) {
                    this.recordVoiceCallHistory({ outcome: 'missed', endedAt: Date.now() });
                    this.resetVoiceState({ preserveInvite: false });
                }
                return;
            }
            if (roomStatus !== 'ringing' && roomStatus !== 'pending') {
                if (String(this.voice.outgoingInvite?.roomId || '').trim() === roomId) {
                    this.voice.outgoingInvite = null;
                }
                if (String(this.voice.incomingInvite?.roomId || '').trim() === roomId) {
                    this.voice.incomingInvite = null;
                }
            }
            if (amParticipant && roomStatus !== 'ringing' && roomStatus !== 'pending') {
                // Covers every way into a live room, not just joinVoiceChannel:
                // accepting a DM call, and a room restored from the server's
                // reconnect snapshot.
                this.ensureVoicePresenceKeepalive();
                try {
                    await this.ensureVoiceLocalStream();
                } catch (error) {
                    this.addLogEntry({ type: 'WARN', msg: error?.message || 'Не удалось получить доступ к микрофону', ts: new Date().toLocaleTimeString() });
                }
                await this.syncVoicePeers();
            } else if (roomStatus === 'ringing' || roomStatus === 'pending') {
                this.renderVoicePanel();
            } else if (this.voice.roomType === 'dm' && this.voice.roomId === roomId && this.voice.callTrack) {
                this.voice.status = this.voice.status === 'idle' ? 'connecting' : this.voice.status;
            } else {
                this.voiceTrace('room-state-reset', { roomId, participants }, 'WARN');
                this.resetVoiceState({ preserveInvite: true });
            }
            this.renderVoicePanel();
            return;
        }

        if (eventType === 'voice_call_ended') {
            const roomId = String(payload.roomId || '').trim();
            const currentRoomId = String(this.voice.roomId || '').trim();
            if (roomId && currentRoomId && roomId !== currentRoomId) {
                this.voiceTrace('call-ended-stale', { roomId, currentRoomId }, 'INFO');
                return;
            }
            this.voiceTrace('call-ended', { roomId, from: payload.from || '', currentRoomId });
            this.leaveVoiceRoom({ announce: false, outcome: 'completed' });
            return;
        }
    }
});
