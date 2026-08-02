// Conversation-key synchronisation, end to end, on the real client code.
//
// The invariant is not "a key exists" — every broken state in this project's
// history had keys, several of them. It is:
//
//   every message ever sent in a scope must remain decryptable by every device
//   of every participant
//
// which is what "перебрано ключей 16 (ни один не подошёл)" violates. A message is
// modelled as the key its sender's device was actively using at that moment; a
// device can read it if that key is in its candidate pool (active + alt:).
import { SimBackend } from './lib/sim_backend.mjs';
import { Device } from './lib/device.mjs';

let failures = 0;
const results = [];
function record(name, ok, detail = '') {
    results.push({ name, ok });
    if (!ok) failures += 1;
    process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function mulberry32(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// Background publishing is fire-and-forget by design (a chat must open without
// waiting for the network), so the harness has to let those tasks land.
const settle = async (backend, rounds = 6) => {
    for (let i = 0; i < rounds; i++) {
        await new Promise(r => setTimeout(r, 20));
        // Where the WebSocket would fire: republish nudges reach the devices that
        // actually hold the key. Skipping this would test a crippled system.
        if (backend) await backend.flushPushes();
    }
};

/** Everyone re-resolves and re-syncs until nothing changes — the convergence step. */
async function converge(backend, devices, scopeArgs, rounds = 4) {
    for (let i = 0; i < rounds; i++) {
        for (const d of devices) {
            await d.resolve({ ...scopeArgs(d), reason: `converge${i}` });
            await d.syncEnvelopes(`converge${i}`);
        }
        await settle(backend, 3);
    }
}

/**
 * Why a device cannot read a message: was an envelope carrying that key ever
 * sealed to it, and did the publish that should have created one fail? Without
 * this a failure only says "unreadable", which is the symptom every one of these
 * bugs shares and tells you nothing about which mechanism broke.
 */
function diagnose(backend, device, key, scope) {
    const scoped = backend.canonicalScope(scope);
    const sealed = backend.envelopes.filter(e =>
        e.recipientDeviceId === device.deviceId && e.scope === scoped).length;
    const failedPublishes = device.traces.filter(t => /publishConversationKeyEnvelopes failed/.test(t)).length;
    return `envelopesForDevice=${sealed} failedPublishesByThisDevice=${failedPublishes} candidates=${device.candidatesFor(scope).length}`;
}

/**
 * What the real client does when a message will not decrypt: ask the holders to
 * republish, then pick up the answer. Modelled explicitly so the checks measure
 * "can the user ever read this", not just "was it readable on the first try".
 */
async function recoverUnreadable(backend, devices, messages, scope, rounds = 3) {
    for (let i = 0; i < rounds; i++) {
        let asked = false;
        for (const d of devices) {
            const missing = messages.some(m => !d.canDecrypt(scope, m.key));
            if (!missing) continue;
            asked = true;
            d.api._republishAskedAt = null; // the cooldown is not what is under test
            await d.api.requestKeyRepublishForDecryptFailure(scope);
        }
        if (!asked) return;
        await settle(backend, 3);
        for (const d of devices) await d.syncEnvelopes('after-republish');
    }
}

/**
 * A device must never lose the ability to read what IT sent. This needs no
 * network, no peer and no recovery — the key was in its own store — so it is the
 * one property that must hold unconditionally, and the one that catches an
 * adoption path silently dropping the key it is replacing.
 */
function cannotReadOwnHistory(messages, devices, scope) {
    const bad = [];
    for (const msg of messages) {
        if (!msg.sender) continue;
        if (!msg.sender.canDecrypt(scope, msg.key)) {
            bad.push(`${msg.sender.user}/${msg.sender.opts.label || msg.sender.deviceId} cannot read its own msg#${msg.n}`);
        }
    }
    return bad;
}

/** Reports which (device, message) pairs cannot be read. */
function unreadable(messages, devices, scope) {
    const bad = [];
    for (const msg of messages) {
        for (const d of devices) {
            if (!d.canDecrypt(scope, msg.key)) {
                bad.push(`${d.user}/${d.deviceId} cannot read msg#${msg.n} from ${msg.from}`);
            }
        }
    }
    return bad;
}

console.log('\n== key store: switching the active key ==');
{
    // Direct, deterministic check on the store operation itself. The end-to-end
    // scenarios cannot see this reliably: once the republish path offers every
    // candidate, a peer hands the dropped key straight back and the loss is
    // repaired before any assertion runs. The guarantee is that it is never lost
    // in the first place — a device must not need the network to read its own
    // history.
    const backend = new SimBackend();
    const d = new Device('alice', backend);
    await d.register();
    const scope = 'dm:alice:bob';
    const first = 'FirstKey-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const second = 'SecondKey-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    const third = 'ThirdKey-cccccccccccccccccccccccccccccccc';

    const store = {};
    d.api.setActiveConversationKey(store, scope, first);
    d.api.setActiveConversationKey(store, scope, second);
    let candidates = d.api.conversationKeyCandidates(store, scope);
    record('switching the active key keeps the previous one as a candidate',
        store[scope] === second && candidates.includes(first) && candidates.includes(second),
        `active=${String(store[scope]).slice(0, 9)} candidates=${candidates.length}`);

    d.api.setActiveConversationKey(store, scope, third);
    candidates = d.api.conversationKeyCandidates(store, scope);
    record('every key ever active for a scope stays decryptable',
        [first, second, third].every(k => candidates.includes(k)),
        `candidates=${candidates.length} of 3`);

    const before = JSON.stringify(store);
    d.api.setActiveConversationKey(store, scope, third);
    record('re-selecting the current key changes nothing', JSON.stringify(store) === before);
}

console.log('\n== DM: two users, one device each ==');
{
    const backend = new SimBackend();
    const a = new Device('alice', backend);
    const b = new Device('bob', backend);
    await a.register(); await b.register();

    const ka = await a.resolve({ peer: 'bob', reason: 't' });
    await settle(backend);
    const kb = await b.resolve({ peer: 'alice', reason: 't' });
    await settle(backend);

    record('both sides end up with the same conversation key', !!ka && ka === kb,
        `alice=${ka.slice(0, 8)} bob=${kb.slice(0, 8)}`);
    record('exactly one canonical key is registered', backend.registry.size === 1,
        `registry=${backend.registry.size}`);
    record('the server never sees plaintext key material',
        backend.plaintextLeaks([ka, kb]).length === 0,
        backend.plaintextLeaks([ka, kb]).join(', '));
}

console.log('\n== DM: scope canonicalisation ==');
{
    const backend = new SimBackend();
    // Different casing on each side — the two ends must still address one row.
    const a = new Device('Alice', backend);
    const b = new Device('BOB', backend);
    await a.register(); await b.register();
    const ka = await a.resolve({ peer: 'BOB', reason: 't' });
    await settle(backend);
    const kb = await b.resolve({ peer: 'Alice', reason: 't' });
    await settle(backend);
    record('mixed-case usernames fold to one scope and one key', ka === kb && backend.registry.size === 1,
        `scopes=${[...backend.registry.keys()].join(',')}`);
}

console.log('\n== multi-device: a second device joins later ==');
{
    const backend = new SimBackend();
    const a1 = new Device('alice', backend, { label: 'mac' });
    const b = new Device('bob', backend);
    await a1.register(); await b.register();

    const established = await a1.resolve({ peer: 'bob', reason: 't' });
    await settle(backend);
    await b.resolve({ peer: 'alice', reason: 't' });
    await settle(backend);

    const messages = [{ n: 1, from: 'alice/mac', key: established }];

    // Now the user adds a phone. It must adopt, not fork.
    const a2 = new Device('alice', backend, { label: 'phone' });
    await a2.register();
    const k2 = await a2.resolve({ peer: 'bob', reason: 't' });
    await settle(backend);

    record('a newly added own device adopts the existing key instead of forking',
        k2 === established, `existing=${established.slice(0, 8)} new=${String(k2).slice(0, 8)}`);
    record('registry still holds exactly one canonical key', backend.registry.size === 1);

    const msg2 = { n: 2, from: 'alice/phone', key: a2.activeKeyFor('dm:alice:bob') };
    messages.push(msg2);
    await converge(backend, [a1, a2, b], (d) => (d.user === 'bob' ? { peer: 'alice' } : { peer: 'bob' }));
    await recoverUnreadable(backend, [a1, a2, b], messages, 'dm:alice:bob');
    const bad = unreadable(messages, [a1, a2, b], 'dm:alice:bob');
    record('every device reads every message after convergence', bad.length === 0, bad.join('; '));
}

console.log('\n== DM: both sides open the chat simultaneously (claim race) ==');
{
    const backend = new SimBackend();
    const a = new Device('alice', backend);
    const b = new Device('bob', backend);
    await a.register(); await b.register();

    const [ka, kb] = await Promise.all([
        a.resolve({ peer: 'bob', reason: 'race' }),
        b.resolve({ peer: 'alice', reason: 'race' }),
    ]);
    await settle(backend);

    // Both may legitimately have invented a key here; what must NOT happen is that
    // the messages already encrypted under either one become unreadable.
    const messages = [
        { n: 1, from: 'alice', key: ka, sender: a },
        { n: 2, from: 'bob', key: kb, sender: b },
    ];
    record('the race produces exactly one canonical key', backend.registry.size === 1,
        `registry=${backend.registry.size}`);

    await converge(backend, [a, b], (d) => (d.user === 'alice' ? { peer: 'bob' } : { peer: 'alice' }));
    // Checked BEFORE any recovery: republish can hide a key that adoption dropped,
    // and "it healed eventually" is not the same guarantee as "it never broke".
    const ownHistory = cannotReadOwnHistory(messages, [a, b], 'dm:alice:bob');
    record('no device loses the key it used for its own messages',
        ownHistory.length === 0, ownHistory.join('; '));
    await recoverUnreadable(backend, [a, b], messages, 'dm:alice:bob');
    record('both sides converge on the canonical key',
        a.activeKeyFor('dm:alice:bob') === b.activeKeyFor('dm:alice:bob'),
        `alice=${a.activeKeyFor('dm:alice:bob').slice(0, 8)} bob=${b.activeKeyFor('dm:alice:bob').slice(0, 8)}`);
    const bad = unreadable(messages, [a, b], 'dm:alice:bob');
    record('messages sent during the race stay readable by both sides',
        bad.length === 0, bad.join('; '));
}

console.log('\n== channel: three members ==');
{
    const backend = new SimBackend();
    backend.setServerMembers('srv1', ['alice', 'bob', 'carol']);
    const a = new Device('alice', backend);
    const b = new Device('bob', backend);
    const c = new Device('carol', backend);
    await a.register(); await b.register(); await c.register();
    const args = { serverId: 'srv1', channelId: 'chan1' };
    const scope = 'server:srv1:chan1';

    const messages = [];
    let n = 0;
    for (const d of [a, b, c]) {
        const key = await d.resolve({ ...args, reason: 't' });
        await settle(backend);
        messages.push({ n: ++n, from: d.user, key });
    }

    record('channel scope gets exactly one canonical key', backend.registry.size === 1,
        `registry=${[...backend.registry.keys()].join(',')}`);

    await converge(backend, [a, b, c], () => args, 5);
    await recoverUnreadable(backend, [a, b, c], messages, scope);
    const keys = [a, b, c].map(d => d.activeKeyFor(scope));
    record('all three members converge on one active channel key',
        new Set(keys).size === 1, keys.map(k => k.slice(0, 8)).join(' '));
    const bad = unreadable(messages, [a, b, c], scope);
    record('every member reads every channel message sent before convergence',
        bad.length === 0, bad.join('; '));
}

console.log('\n== revoked device ==');
{
    const backend = new SimBackend();
    const a = new Device('alice', backend);
    const b1 = new Device('bob', backend, { label: 'old' });
    const b2 = new Device('bob', backend, { label: 'new' });
    await a.register(); await b1.register(); await b2.register();
    // Bob revokes the old device before any key is published.
    backend.user('bob').devices.get(b1.deviceId).revoked = true;

    const key = await a.resolve({ peer: 'bob', reason: 't' });
    await settle(backend);
    const sealedFor = backend.envelopes.filter(e => e.recipient === 'bob').map(e => e.recipientDeviceId);
    record('no envelope is sealed to a revoked device',
        !sealedFor.includes(b1.deviceId) && sealedFor.includes(b2.deviceId),
        `sealedFor=[${sealedFor.join(',')}] revoked=${b1.deviceId}`);
    const k2 = await b2.resolve({ peer: 'alice', reason: 't' });
    record('the live device still receives the key', k2 === key);
}

console.log('\n== flaky backend ==');
{
    for (const [label, failRate, seed] of [['10% of requests fail', 0.1, 3], ['30% of requests fail', 0.3, 9]]) {
        const backend = new SimBackend({ failRate, rng: mulberry32(seed) });
        const a = new Device('alice', backend);
        const b = new Device('bob', backend);
        await a.register(); await b.register();

        const ka = await a.resolve({ peer: 'bob', reason: 'flaky' });
        await settle(backend);
        const kb = await b.resolve({ peer: 'alice', reason: 'flaky' });
        await settle(backend);
        const messages = [{ n: 1, from: 'alice', key: ka, sender: a }, { n: 2, from: 'bob', key: kb, sender: b }];

        // Network recovers; convergence must then complete.
        backend.opts.failRate = 0;
        await converge(backend, [a, b], (d) => (d.user === 'alice' ? { peer: 'bob' } : { peer: 'alice' }), 5);
        await recoverUnreadable(backend, [a, b], messages, 'dm:alice:bob');

        const same = a.activeKeyFor('dm:alice:bob') === b.activeKeyFor('dm:alice:bob');
        const bad = unreadable(messages, [a, b], 'dm:alice:bob');
        record(`converges after ${label}`, same && bad.length === 0,
            `${same ? '' : 'active keys differ; '}${bad.join('; ')}`);
    }
}

console.log('\n== forced key reset ==');
{
    const backend = new SimBackend();
    const a = new Device('alice', backend);
    const b = new Device('bob', backend);
    await a.register(); await b.register();
    const original = await a.resolve({ peer: 'bob', reason: 't' });
    await settle(backend);
    await b.resolve({ peer: 'alice', reason: 't' });
    await settle(backend);

    // Explicit "сбросить ключи шифрования": the new claim must take the row over.
    const scope = 'dm:alice:bob';
    const fresh = 'ForcedResetKeyForcedResetKeyForcedReset';
    a.api._forceClaimScopes = new Set([scope]);
    const after = await a.api.reconcileConversationKey(scope, fresh, { reason: 'reset' });
    record('a forced claim replaces the canonical key',
        after === fresh && backend.registry.get(scope).keyId === await a.api.conversationKeyId(fresh),
        `after=${String(after).slice(0, 10)}`);
    record('the previous key is not the canonical one any more',
        backend.registry.get(scope).keyId !== await a.api.conversationKeyId(original));
}

console.log('\n== request budget ==');
{
    // Correctness is not enough: every request here is serialized through the
    // client's API slot pool, so a sweep that is merely "thorough" starves history
    // loading and envelope fetches behind it. That is what shipped on 2026-08-02 —
    // publishing every historical candidate for every scope turned login into a
    // minutes-long POST storm and the chat came up empty. Cost is now a test.
    const backend = new SimBackend();
    const me = new Device('alice', backend, { label: 'main' });
    const other = new Device('alice', backend, { label: 'phone' });
    const peer = new Device('bob', backend);
    await me.register(); await other.register(); await peer.register();

    // A realistic account: many scopes, each carrying several historical keys.
    const SCOPES = 18, ALTS = 3;
    const store = {};
    for (let i = 0; i < SCOPES; i++) {
        const scope = `dm:alice:peer${String(i).padStart(2, '0')}`;
        store[scope] = `active-key-${i}-aaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
        for (let a = 0; a < ALTS; a++) {
            me.api.addAltConversationKey(store, scope, `old-key-${i}-${a}-bbbbbbbbbbbbbbbbbbbbbbbb`);
        }
    }
    me.api.saveStoredConversationKeys(store);

    const before = backend.calls.length;
    await me.api.retryPublishConversationKeys({ reason: 'budget-test' });
    const spent = backend.calls.length - before;
    const perScope = spent / SCOPES;
    record(`a full republish sweep stays proportional to scopes, not to key history`,
        perScope <= 4,
        `${spent} requests for ${SCOPES} scopes x ${1 + ALTS} keys = ${perScope.toFixed(1)}/scope (budget 4)`);
}

console.log('\n== randomized multi-device scenarios ==');
{
    let bad = 0; const examples = [];
    let ownHistoryBroken = 0; const ownExamples = [];
    const total = 24;
    for (let seed = 1; seed <= total; seed++) {
        const rng = mulberry32(seed * 2654435761);
        const backend = new SimBackend({ rng, failRate: rng() < 0.4 ? rng() * 0.25 : 0 });
        const aliceDevices = 1 + Math.floor(rng() * 3);
        const bobDevices = 1 + Math.floor(rng() * 3);
        const devices = [];
        for (let i = 0; i < aliceDevices; i++) devices.push(new Device('alice', backend, { label: `a${i}` }));
        for (let i = 0; i < bobDevices; i++) devices.push(new Device('bob', backend, { label: `b${i}` }));
        for (const d of devices) await d.register();

        // Devices open the chat in a random order, some of them concurrently.
        const order = devices.slice().sort(() => (rng() < 0.5 ? -1 : 1));
        const messages = [];
        let n = 0;
        for (const d of order) {
            const args = d.user === 'alice' ? { peer: 'bob' } : { peer: 'alice' };
            const key = await d.resolve({ ...args, reason: 'fuzz' });
            if (rng() < 0.7) messages.push({ n: ++n, from: `${d.user}/${d.opts.label}`, key, sender: d });
            if (rng() < 0.4) await settle(backend, 1);
        }
        await settle(backend);
        backend.opts.failRate = 0;
        await converge(backend, devices, (d) => (d.user === 'alice' ? { peer: 'bob' } : { peer: 'alice' }), 5);
        const ownLoss = cannotReadOwnHistory(messages, devices, 'dm:alice:bob');
        if (ownLoss.length) { ownHistoryBroken += 1; if (ownExamples.length < 3) ownExamples.push(`seed=${seed} ${ownLoss[0]}`); }
        await recoverUnreadable(backend, devices, messages, 'dm:alice:bob');

        const problems = unreadable(messages, devices, 'dm:alice:bob');
        const actives = new Set(devices.map(d => d.activeKeyFor('dm:alice:bob')));
        if (problems.length || actives.size !== 1) {
            bad += 1;
            if (examples.length < 3) {
                const firstBad = messages.find(m => devices.some(d => !d.canDecrypt('dm:alice:bob', m.key)));
                const victim = firstBad && devices.find(d => !d.canDecrypt('dm:alice:bob', firstBad.key));
                const why = victim ? diagnose(backend, victim, firstBad.key, 'dm:alice:bob') : '';
                examples.push(`seed=${seed} devices=${aliceDevices}+${bobDevices} activeKeys=${actives.size} `
                    + `backendFailures=${backend.failures} ${problems.slice(0, 2).join('; ')} [${why}]`);
            }
        }
    }
    record(`${total} randomized scenarios: no device loses its own history`,
        ownHistoryBroken === 0,
        ownHistoryBroken ? `${ownHistoryBroken} broken, e.g. ${ownExamples.join(' | ')}` : '');
    record(`${total} randomized multi-device scenarios converge and stay readable`,
        bad === 0, bad ? `${bad} broken, e.g. ${examples.join(' | ')}` : '');
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILURES: ' + failures} (${results.length} checks)\n`);
process.exit(failures === 0 ? 0 : 1);
