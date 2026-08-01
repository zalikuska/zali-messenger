// Simulated zali-server voice plane, mirroring server/src/voice.rs:
//   voice_call_invite  -> invite to target + outgoing to sender + room 'ringing'
//   voice_call_accept  -> room 'active', room_state, accepted+connected to BOTH
//   voice_signal       -> routed to `to`, stamped with `from` (sender-authoritative)
//   voice_join/leave   -> membership + voice_room_state broadcast
//
// The transport is deliberately hostile on demand: drop, delay, reorder and
// duplicate are all real failure modes of a WS that reconnects mid-call.
import { drainMicrotasks } from './clock.mjs';

export class SimServer {
    constructor(opts = {}) {
        this.clock = opts.clock || null;
        this.peers = new Map();
        this.rooms = new Map();
        this.queue = [];
        this.opts = opts;
        this.rng = opts.rng || Math.random;
        this.delivered = 0;
        this.dropped = 0;
        this.log = [];
    }

    register(peer) { this.peers.set(peer.name, peer); }

    _room(roomId) {
        if (!this.rooms.has(roomId)) {
            this.rooms.set(roomId, { participants: new Set(), callState: 'pending', initiator: null, target: null, roomType: 'dm', serverId: null, channelId: null });
        }
        return this.rooms.get(roomId);
    }

    _enqueue(to, event) {
        const drop = this.opts.dropRate ? this.rng() < this.opts.dropRate : false;
        if (drop) { this.dropped += 1; this.log.push({ to, type: event.type, dropped: true }); return; }
        const at = this.opts.jitter ? this.rng() * this.opts.jitter : 0;
        this.queue.push({ to, event, at, seq: this.queue.length });
        if (this.opts.duplicateRate && this.rng() < this.opts.duplicateRate) {
            this.queue.push({ to, event, at: at + 0.5, seq: this.queue.length });
        }
    }

    /** Client -> server. Returns whether the client considers it delivered. */
    fromClient(sender, payload) {
        const type = payload.type;
        this.log.push({ from: sender, type, to: payload.to || '', signalType: payload.signal?.type || '' });
        if (this.opts.refuseSend) return false;

        if (type === 'voice_call_invite') {
            const target = String(payload.target || '').trim();
            const roomId = String(payload.roomId || '').trim();
            const room = this._room(roomId);
            room.roomType = 'dm';
            room.callState = 'ringing';
            room.initiator = sender;
            room.target = target;
            room.participants.add(sender);
            room.participants.add(target);
            this._enqueue(target, { type: 'voice_call_invite', roomId, roomType: 'dm', from: sender, target });
            this._enqueue(sender, { type: 'voice_call_outgoing', roomId, roomType: 'dm', target });
            this._broadcastRoom(roomId);
            return true;
        }

        if (type === 'voice_call_accept') {
            const roomId = String(payload.roomId || '').trim();
            const inviter = String(payload.inviter || '').trim();
            const room = this.rooms.get(roomId);
            // Mirrors the server's authorization check exactly.
            if (!room || room.roomType !== 'dm' || room.callState !== 'ringing'
                || room.initiator !== inviter || room.target !== sender) {
                this.log.push({ rejected: 'accept', sender, roomId });
                return true;
            }
            room.callState = 'active';
            room.participants = new Set([sender, inviter]);
            this._broadcastRoom(roomId);
            const participants = [sender, inviter];
            for (const who of [inviter, sender]) {
                this._enqueue(who, { type: 'voice_call_accepted', roomId, from: sender, target: inviter, participants });
            }
            for (const who of [inviter, sender]) {
                this._enqueue(who, { type: 'voice_call_connected', roomId, from: sender, target: inviter, participants });
            }
            return true;
        }

        if (type === 'voice_signal') {
            const roomId = String(payload.roomId || '').trim();
            const room = this.rooms.get(roomId);
            if (!room) { this.log.push({ rejected: 'signal-missing-room', sender, roomId }); return true; }
            const allowed = room.participants.has(sender) || room.initiator === sender || room.target === sender;
            if (!allowed) { this.log.push({ rejected: 'signal-unauthorized', sender, roomId }); return true; }
            const signal = { ...payload, from: sender };
            const to = String(payload.to || '').trim();
            if (to) this._enqueue(to, signal);
            else for (const p of room.participants) if (p !== sender) this._enqueue(p, signal);
            return true;
        }

        if (type === 'voice_join') {
            const roomId = String(payload.roomId || '').trim();
            const room = this._room(roomId);
            room.roomType = payload.roomType || room.roomType;
            room.serverId = payload.serverId ?? room.serverId;
            room.channelId = payload.channelId ?? room.channelId;
            const changed = !room.participants.has(sender);
            room.participants.add(sender);
            if (room.roomType === 'channel' && room.callState === 'pending') room.callState = 'active';
            if (changed) this._broadcastRoom(roomId);
            else this._enqueue(sender, this._roomPayload(roomId));
            return true;
        }

        if (type === 'voice_leave') {
            const roomId = String(payload.roomId || '').trim();
            const room = this.rooms.get(roomId);
            if (room) { room.participants.delete(sender); this._broadcastRoom(roomId); }
            return true;
        }

        if (type === 'voice_call_cancel' || type === 'voice_call_reject') {
            const roomId = String(payload.roomId || '').trim();
            const room = this.rooms.get(roomId);
            if (room) {
                for (const p of room.participants) {
                    if (p !== sender) this._enqueue(p, { type: type === 'voice_call_reject' ? 'voice_call_rejected' : 'voice_call_cancelled', roomId, from: sender });
                }
                this.rooms.delete(roomId);
            }
            return true;
        }

        return true;
    }

    _roomPayload(roomId) {
        const room = this._room(roomId);
        return {
            type: 'voice_room_state',
            roomId,
            roomType: room.roomType,
            status: room.callState,
            initiator: room.initiator,
            target: room.target,
            serverId: room.serverId,
            channelId: room.channelId,
            participants: [...room.participants].sort(),
        };
    }

    _broadcastRoom(roomId) {
        const payload = this._roomPayload(roomId);
        for (const p of this._room(roomId).participants) this._enqueue(p, payload);
    }

    /**
     * Runs the network AND virtual time until everything is quiet, so timer-driven
     * recovery (answer watchdog, negotiation retries, ICE restarts) really happens.
     */
    async settle(maxVirtualMs = 180000) {
        const clock = this.clock;
        const deadline = (clock ? clock.now : 0) + maxVirtualMs;
        for (let guard = 0; guard < 200000; guard++) {
            await drainMicrotasks();
            if (this.queue.length) {
                if (this.opts.reorder) {
                    this.queue.sort((a, b) => (a.at - b.at) || (this.rng() < 0.5 ? -1 : 1));
                } else {
                    this.queue.sort((a, b) => (a.at - b.at) || (a.seq - b.seq));
                }
                const item = this.queue.shift();
                const peer = this.peers.get(item.to);
                if (peer) {
                    this.delivered += 1;
                    await peer.deliver(item.event);
                }
                continue;
            }
            if (!clock) return true;
            if (!clock.hasTimers()) return true;
            if (clock.nextAt() > deadline) return true;
            clock.fireNext();
        }
        return false;
    }

    signalCounts() {
        const counts = {};
        for (const row of this.log) {
            if (row.type !== 'voice_signal') continue;
            const k = row.signalType || '?';
            counts[k] = (counts[k] || 0) + 1;
        }
        return counts;
    }
}
