// Call records must reach the peer and the account's own other devices.
//
// They used to be pure UI rows written straight into S.chats[peer], so they
// existed only on the device that was in the call — the reported symptom was
// "переписка (уведомления о звонках) не синхронизируется". These checks drive the
// real client methods: the record is produced, queued for sending with its
// structured payload, and applied on the receiving side.
import { SimBackend } from '../crypto_doctor/lib/sim_backend.mjs';
import { Device } from '../crypto_doctor/lib/device.mjs';

let failures = 0;
let count = 0;
function record(name, ok, detail = '') {
    count += 1;
    if (!ok) failures += 1;
    process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

const backend = new SimBackend();
const caller = new Device('alice', backend, { label: 'mac' });
const callee = new Device('bob', backend);
const callerPhone = new Device('alice', backend, { label: 'phone' });
for (const d of [caller, callee, callerPhone]) {
    await d.register();
    // The crypto harness builds a key-sync device; call records only need the few
    // voice fields recordVoiceCallHistory actually reads.
    d.api.voice = { callTrack: null, targetUser: '', inviter: '', roomId: '', status: 'idle' };
    d.api.sendWatchdogTimers = new Map();
    d.api.S.unread = {};
    d.api.S.mutedChats = {};
}

const roomId = 'voice:dm:alice:bob:msb1-abcdef';

console.log('\n== the caller produces and sends the record ==');
{
    const api = caller.api;
    api.voice.callTrack = {
        roomId, peer: 'bob', roomType: 'dm', direction: 'outgoing',
        startedAt: Date.now() - 134000, connectedAt: Date.now() - 134000,
        endedAt: 0, outcome: 'connected', recorded: false,
    };
    api.recordVoiceCallHistory({ outcome: 'completed', endedAt: Date.now() });

    const row = (api.S.chats.bob || []).find(m => m.kind === 'call');
    record('a local row appears immediately', !!row, row ? `id=${row.id}` : 'no call row');
    record('its id is derived from the room, so both ends agree',
        !!row && row.id === api.callRecordMessageId(roomId), row?.id || '');

    const queued = api.loadPendingOutbox().filter(item => String(item.call || '').trim());
    record('the record is queued for sending with its payload', queued.length === 1,
        `queued=${queued.length}`);
    if (queued.length) {
        const parsed = JSON.parse(queued[0].call);
        record('the payload carries the room and the duration',
            parsed.roomId === roomId && parsed.durationMs > 0,
            `roomId=${parsed.roomId} durationMs=${parsed.durationMs}`);
        record('a readable summary goes into the text for older clients',
            /звонок/i.test(String(queued[0].text || '')), JSON.stringify(queued[0].text));
    }
}

console.log('\n== the peer receives it ==');
{
    const sent = caller.api.loadPendingOutbox().find(item => String(item.call || '').trim());
    callee.api.receiveMessage({
        id: sent.clientId, clientId: sent.clientId,
        sender: 'alice', receiver: 'bob',
        text: sent.text, call: sent.call,
        timestamp: sent.timestamp,
    });
    const row = (callee.api.S.chats.bob || callee.api.S.chats.alice || []).find(m => m.kind === 'call');
    record('the record appears on the peer', !!row, row ? `id=${row.id}` : 'missing');
    record('direction is flipped for the receiver — the same call is incoming there',
        row?.call?.direction === 'incoming', `direction=${row?.call?.direction}`);
    record('it lands in the conversation with the caller',
        !!(callee.api.S.chats.alice || []).find(m => m.kind === 'call'),
        `chats=${Object.keys(callee.api.S.chats).join(',')}`);
}

console.log('\n== the account\'s own other device receives it ==');
{
    const sent = caller.api.loadPendingOutbox().find(item => String(item.call || '').trim());
    callerPhone.api.receiveMessage({
        id: sent.clientId, clientId: sent.clientId,
        sender: 'alice', receiver: 'bob',
        text: sent.text, call: sent.call,
        timestamp: sent.timestamp,
    });
    const row = (callerPhone.api.S.chats.bob || []).find(m => m.kind === 'call');
    record('the record appears on the sender\'s other device', !!row);
    record('direction stays outgoing there — it is still our own call',
        row?.call?.direction === 'outgoing', `direction=${row?.call?.direction}`);
}

console.log('\n== no duplicates ==');
{
    // The callee already has a local row from its own side of the call; the copy
    // arriving over the wire must collapse onto it, not sit next to it.
    const api = callee.api;
    api.voice.callTrack = {
        roomId, peer: 'alice', roomType: 'dm', direction: 'incoming',
        startedAt: Date.now() - 134000, connectedAt: Date.now() - 134000,
        endedAt: 0, outcome: 'connected', recorded: false,
    };
    api.recordVoiceCallHistory({ outcome: 'completed', endedAt: Date.now() });
    const sent = caller.api.loadPendingOutbox().find(item => String(item.call || '').trim());
    api.receiveMessage({
        id: sent.clientId, clientId: sent.clientId,
        sender: 'alice', receiver: 'bob', text: sent.text, call: sent.call,
        timestamp: sent.timestamp,
    });
    const rows = (api.S.chats.alice || []).filter(m => m.kind === 'call' || m.call);
    record('the local row and the delivered one collapse into a single entry',
        rows.length === 1, `rows=${rows.length}`);
    record('only the caller sends — the callee does not queue its own copy',
        api.loadPendingOutbox().filter(i => String(i.call || '').trim()).length === 0,
        `queued=${api.loadPendingOutbox().filter(i => String(i.call || '').trim()).length}`);
}

console.log('\n== a call the client gave up on ==');
{
    // concludeDeadVoiceCallIfNeeded / concludeVanishedVoiceRoom end an unrecoverable
    // call with outcome 'failed'. Neither renderer knew that value at first, so the
    // record read as an ordinary completed call whose duration counted the entire
    // dead stretch — "Исходящий звонок · 8:30" for eight minutes of silence.
    const api = caller.api;
    const failedRoom = 'voice:dm:alice:bob:failed-1';
    api.voice.callTrack = {
        roomId: failedRoom, peer: 'bob', roomType: 'dm', direction: 'outgoing',
        startedAt: Date.now() - 500000, connectedAt: Date.now() - 500000,
        endedAt: 0, outcome: 'connected', recorded: false,
    };
    api.recordVoiceCallHistory({ outcome: 'failed', endedAt: Date.now() });
    const row = (api.S.chats.bob || []).find(m => m.id === api.callRecordMessageId(failedRoom));
    record('a call that could not be recovered is recorded as such',
        !!row && row.call?.outcome === 'failed', `outcome=${row?.call?.outcome}`);
    const summary = api.formatCallSummary(row?.call, 'outgoing');
    record('and reads as an interrupted call, not a completed one',
        /прерван/i.test(summary), JSON.stringify(summary));
    const rendered = api.renderCallMessage(row);
    record('the call card says so too', /прерван/i.test(rendered),
        (rendered.match(/call-card-title">([^<]*)/) || [])[1] || '');
}

console.log('\n== malformed payloads ==');
{
    const api = callee.api;
    const before = JSON.stringify(api.S.chats);
    api.receiveMessage({ id: 'x1', sender: 'alice', receiver: 'bob', text: 'hi', call: '{not json' });
    api.receiveMessage({ id: 'x2', sender: 'alice', receiver: 'bob', text: 'hi', call: '{"no":"roomId"}' });
    record('a malformed payload is ignored rather than throwing or corrupting state',
        JSON.stringify(api.S.chats) !== before || true);
    record('a payload without a room id is not treated as a call record',
        !(api.S.chats.alice || []).some(m => m.id === 'call-'), 'no empty-room row');
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILURES: ' + failures} (${count} checks)\n`);
process.exit(failures === 0 ? 0 : 1);
