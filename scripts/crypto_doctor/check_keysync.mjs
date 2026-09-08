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
    a.api.queueForceClaimScopes([scope]);
    const after = await a.api.reconcileConversationKey(scope, fresh, { reason: 'reset' });
    record('a forced claim replaces the canonical key',
        after === fresh && backend.registry.get(scope).keyId === await a.api.conversationKeyId(fresh),
        `after=${String(after).slice(0, 10)}`);
    record('the previous key is not the canonical one any more',
        backend.registry.get(scope).keyId !== await a.api.conversationKeyId(original));
}

// Opening a chat in a conversation that genuinely has no key yet must not sit
// through the "wait for a key that might be in flight" retries. Those exist for a
// real hazard — inventing a key here is irreversible and orphans the real one —
// but the registry answers whether such a key can exist, and when the answer is a
// definite "no claim" the wait is pure latency on the path that opens a chat.
//
// The distinction is the whole check: an absent cache entry means BOTH "no claim"
// and "the lookup never answered", so a version of this that reads the cache
// directly waits every time while appearing to be fixed.
console.log('\n== opening a chat does not wait for a key that cannot exist ==');
{
    const backend = new SimBackend();
    backend.user('alice'); backend.user('bob');
    const a = new Device('alice', backend, { deviceId: 'dev_wait_a' });
    await a.register();

    const started = Date.now();
    const key = await a.resolve({ peer: 'bob', reason: 'first-open' });
    const elapsed = Date.now() - started;
    record('a first chat with an unclaimed scope resolves without the retry sleeps',
        !!key && elapsed < 1000, `${elapsed} ms`);

    // ...and the reverse: when the lookup could not be made, the client must still
    // wait rather than treat "no answer" as "no key".
    const flaky = new SimBackend();
    flaky.user('alice'); flaky.user('bob');
    const b = new Device('alice', flaky, { deviceId: 'dev_wait_b' });
    await b.register();
    record('a scope whose lookup never answered is not treated as unclaimed',
        b.api.canonicalLookupSucceeded('dm:alice:bob') === false,
        'an unasked scope must read as "unknown", not "no claim"');
    await b.api.fetchCanonicalKeyIds(['dm:alice:bob']);
    record('...and reads as answered once the lookup lands',
        b.api.canonicalLookupSucceeded('dm:alice:bob') === true);
}

// A key event must re-read history when — and only when — something is currently
// unreadable. Getting the "only when" wrong wastes a full paged walk of the
// conversation on every envelope push; getting the "when" wrong leaves a message
// stuck as a placeholder forever. The default has to be "re-read".
console.log('\n== a key event re-reads history exactly when it can help ==');
{
    const backend = new SimBackend();
    backend.user('alice'); backend.user('bob');
    const d = new Device('alice', backend, { deviceId: 'dev_reload' });
    await d.register();
    const api = d.api;

    record('a conversation that was never loaded is always re-read',
        api.keyChangeCanRevealMore({ peer: 'bob' }) === true,
        'an empty store is not evidence that everything is fine');

    api.S.chats.bob = [
        { id: 'm1', sender: 'bob', receiver: 'alice', text: 'обычное сообщение', timestamp: '1' },
    ];
    record('a fully readable conversation is not re-read',
        api.keyChangeCanRevealMore({ peer: 'bob' }) === false);

    // Native shells: the unreadable message is present as a placeholder.
    for (const placeholder of [
        '🔒 Сообщение зашифровано другим ключом',
        '🔑 Получение ключа…',
        'Не удалось расшифровать сообщение: нет E2E-ключа для этой переписки',
    ]) {
        api.S.chats.bob = [
            { id: 'm1', sender: 'bob', receiver: 'alice', text: 'обычное сообщение', timestamp: '1' },
            { id: 'm2', sender: 'bob', receiver: 'alice', text: placeholder, timestamp: '2' },
        ];
        record(`a placeholder forces a re-read — ${placeholder.slice(0, 24)}`,
            api.keyChangeCanRevealMore({ peer: 'bob' }) === true);
    }

    // Browser: the unreadable message is ABSENT, so placeholders cannot speak for it.
    api.S.chats.bob = [
        { id: 'm1', sender: 'bob', receiver: 'alice', text: 'обычное сообщение', timestamp: '1' },
    ];
    api.markBrowserDecryptGap({ peer: 'bob' });
    record('a message the browser dropped forces a re-read',
        api.keyChangeCanRevealMore({ peer: 'bob' }) === true,
        'it never reached the store, so nothing else can report it');
    api.clearBrowserDecryptGap({ peer: 'bob' });
    record('...and stops forcing one once the load repaired it',
        api.keyChangeCanRevealMore({ peer: 'bob' }) === false);

    // Channels use a different store; the same rules must hold there.
    const args = { serverId: 'srv1', channelId: 'chan1' };
    record('an unloaded channel is always re-read',
        api.keyChangeCanRevealMore(args) === true);
    api.S.serverChats['srv1:chan1'] = [
        { id: 'c1', sender: 'bob', receiver: 'chan1', text: '🔑 Получение ключа…', timestamp: '1' },
    ];
    record('a channel placeholder forces a re-read',
        api.keyChangeCanRevealMore(args) === true);
    api.S.serverChats['srv1:chan1'] = [
        { id: 'c1', sender: 'bob', receiver: 'chan1', text: 'обычное сообщение', timestamp: '1' },
    ];
    record('a readable channel is not re-read',
        api.keyChangeCanRevealMore(args) === false);
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

// The answer to a republish request carries several keys by construction, so its
// cost has to scale with RECIPIENTS, not with recipients times keys. Each
// publish call re-fetches the recipient's device list, so doing one call per key
// turned a six-candidate answer into six directory lookups per member — before a
// single envelope was written.
{
    const backend = new SimBackend();
    backend.user('alice'); backend.user('bob');
    const scope = 'dm:alice:bob';
    const a = new Device('alice', backend, { deviceId: 'dev_budget_a' });
    const b = new Device('bob', backend, { deviceId: 'dev_budget_b' });
    await a.register(); await b.register();

    const store = { [scope]: 'BudgetActiveKeyBudgetActiveKeyAA' };
    for (let i = 0; i < 4; i += 1) {
        a.api.addAltConversationKey(store, scope, `BudgetHistoricalKeyNumber${i}xxxxx`);
    }
    a.api.saveStoredConversationKeys(store);

    const before = backend.calls.filter(c => c.path.endsWith('/devices')).length;
    await a.api.handleKeyRepublishRequest({ scope, requester: 'bob' });
    const lookups = backend.calls.filter(c => c.path.endsWith('/devices')).length - before;
    record('a republish answer costs one device lookup per recipient, not one per key',
        lookups <= 2, `${lookups} device lookups for 5 candidates`);

    await settle(backend);
    await b.syncEnvelopes('budget');
    record('...and still delivers every candidate',
        b.candidatesFor(scope).length >= 5, `bob holds ${b.candidatesFor(scope).length}`);
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

console.log('\n== republish answers with every candidate, and they all survive storage ==');
{
    // The point of answering a republish request with every candidate is that the
    // requester is missing a HISTORICAL key — the active one is the very key it
    // already has. That only works if the envelope store can hold more than one key
    // per (scope, sender device, recipient device): the server's UNIQUE constraint
    // did not include the key, so publishing N candidates was N upserts over one row
    // and only the last survived. Nothing anywhere could see it, because the harness
    // modelled the table as append-only.
    const backend = new SimBackend();
    backend.user('alice'); backend.user('bob');
    const scope = 'dm:alice:bob';

    const a = new Device('alice', backend, { deviceId: 'dev_cand_a' });
    const b = new Device('bob', backend, { deviceId: 'dev_cand_b' });
    await a.register(); await b.register();

    // Alice holds three keys for the scope: one active, two demoted historical ones.
    const active = 'CandidateActiveCandidateActiveAA';
    const old1 = 'CandidateHistoricalOneHistoricalB';
    const old2 = 'CandidateHistoricalTwoHistoricalC';
    const stored = a.api.loadStoredConversationKeys();
    stored[scope] = active;
    a.api.addAltConversationKey(stored, scope, old1);
    a.api.addAltConversationKey(stored, scope, old2);
    a.api.saveStoredConversationKeys(stored);

    await a.api.handleKeyRepublishRequest({ scope, requester: 'bob' });
    await settle(backend);
    await b.syncEnvelopes('candidates');

    const got = b.candidatesFor(scope);
    record('a republish answer delivers every candidate, not just the last one written',
        [active, old1, old2].every(k => got.includes(k)),
        `bob holds ${got.length}: ${[active, old1, old2].map(k => got.includes(k) ? 'y' : 'n').join('')}`);
    record('each distinct key occupies its own envelope row',
        new Set(backend.envelopes.filter(e => e.scope === scope && e.recipient === 'bob')
            .map(e => e.keyId)).size === 3,
        `rows=${backend.envelopes.filter(e => e.scope === scope && e.recipient === 'bob').length}`);
}

console.log('\n== cloud vault: an account\'s own devices ==');
{
    // The vault is the only channel that carries an account's FULL key set — the
    // republish sweep deliberately sends the active key per scope and nothing else —
    // so a second device recovering an incomplete vault has no other way back to the
    // keys it is missing.
    const backend = new SimBackend();
    backend.user('alice'); backend.user('bob'); backend.user('carol');
    const PASS = 'vault-passphrase';

    const a1 = new Device('alice', backend, { vaultPassphrase: PASS, deviceId: 'dev_vault_a1' });
    await a1.register();

    a1.api.saveStoredConversationKeys({ 'dm:alice:bob': 'VaultKeyOneVaultKeyOneVaultKeyOne' });
    await a1.api.syncCloudVaultPackage({ passphrase: PASS, reason: 'first' });

    // A key created AFTER the first publish. This is the case that silently never
    // reached the cloud: the skip was decided by "is the newest event mine?", which
    // is true forever once we have published once, instead of by "does the newest
    // event already contain what I hold?".
    const stored = a1.api.loadStoredConversationKeys();
    stored['dm:alice:carol'] = 'VaultKeyTwoVaultKeyTwoVaultKeyTwo';
    a1.api.saveStoredConversationKeys(stored);
    await a1.api.syncCloudVaultPackage({ passphrase: PASS, reason: 'second' });

    const a2 = new Device('alice', backend, { vaultPassphrase: PASS, deviceId: 'dev_vault_a2' });
    await a2.register();
    await a2.api.syncCloudVaultPackage({ passphrase: PASS, reason: 'recover' });
    const recovered = a2.api.loadStoredConversationKeys();

    record('a key created after the first vault publish still reaches the cloud',
        recovered['dm:alice:carol'] === 'VaultKeyTwoVaultKeyTwoVaultKeyTwo',
        `recoveredScopes=${Object.keys(recovered).join(',') || 'none'}`);
    record('the original key set survives the later publish',
        recovered['dm:alice:bob'] === 'VaultKeyOneVaultKeyOneVaultKeyOne');

    // Idempotence: with nothing new to say, a sync must not append another event.
    const before = backend.vault.length;
    await a1.api.syncCloudVaultPackage({ passphrase: PASS, reason: 'noop' });
    record('a sync with nothing new to publish does not append an event',
        backend.vault.length === before, `events ${before} -> ${backend.vault.length}`);
}

console.log('\n== stale canonical claim: the registry names a key nobody has ==');
{
    // Reinstall on both sides of a DM and the registry row outlives every copy of
    // the key it fingerprints. Before the takeover existed this never resolved:
    // each side kept its own active key forever, re-running claim → promote(fail) →
    // republish → sync → promote(fail) on every single chat open.
    const backend = new SimBackend();
    backend.user('alice'); backend.user('bob');
    const scope = 'dm:alice:bob';

    const a1 = new Device('alice', backend, { deviceId: 'dev_stale_a1' });
    const b1 = new Device('bob', backend, { deviceId: 'dev_stale_b1' });
    await a1.register(); await b1.register();
    await a1.resolve({ peer: 'bob', reason: 'seed' }); await settle(backend);
    await b1.resolve({ peer: 'alice', reason: 'seed' }); await settle(backend);
    const deadKeyId = backend.registry.get(scope).keyId;

    // Both devices are gone for good — reinstalled, so their key stores went with
    // them — and nothing that ever held the key is online to answer a republish.
    backend.devices = [];
    for (const user of ['alice', 'bob']) {
        for (const [, rec] of backend.user(user).devices) rec.revoked = true;
    }
    const a2 = new Device('alice', backend, { deviceId: 'dev_stale_a2' });
    const b2 = new Device('bob', backend, { deviceId: 'dev_stale_b2' });
    await a2.register(); await b2.register();

    // Both open the chat at the same moment, which is what produced three live keys
    // in a channel and two in a DM.
    await Promise.all([
        a2.resolve({ peer: 'bob', reason: 'race' }),
        b2.resolve({ peer: 'alice', reason: 'race' }),
    ]);
    await settle(backend);

    // The attempt count is the other half of the gate, and it is the half that
    // protects a working conversation: a device that opens a chat once, fails, and
    // comes back an hour later would otherwise present a mark that looks old enough
    // and hijack a scope nobody had any trouble with.
    {
        const probe = new Device('alice', backend, { deviceId: 'dev_gate_probe' });
        const scopeKey = probe.api.staleCanonicalStorageKey();
        const old = Date.now() - 60 * 60 * 1000;
        probe.sandbox.localStorage.setItem(scopeKey, JSON.stringify({ [scope]: { first: old, attempts: 0 } }));
        const firstVerdict = probe.api.markStaleCanonical(scope);
        record('an old mark with too few attempts does not authorise a takeover',
            firstVerdict === false, 'one failure after a long gap must not count as "stuck"');
        let verdict = firstVerdict;
        for (let i = 0; i < 5 && !verdict; i += 1) verdict = probe.api.markStaleCanonical(scope);
        record('repeated failures over the window do authorise it', verdict === true);
    }

    record('a claim that is merely young is not taken over',
        backend.registry.get(scope).keyId === deadKeyId,
        'the takeover must never fire on a first failure');

    // Age both the client-side marks and the backend row past the window. This is
    // the fast-forward the real system reaches by simply staying broken for 15 min.
    const age = 20 * 60 * 1000;
    backend.advance(age);
    for (const d of [a2, b2]) {
        const key = d.api.staleCanonicalStorageKey();
        const map = JSON.parse(d.sandbox.localStorage.getItem(key) || '{}');
        // Only the clock is fast-forwarded — the attempt count is left exactly as the
        // client earned it, so the "keeps failing across separate attempts" half of
        // the gate is still being exercised rather than skipped.
        for (const s of Object.keys(map)) {
            if (map[s] && typeof map[s] === 'object') map[s].first -= age;
            else map[s] -= age;
        }
        d.sandbox.localStorage.setItem(key, JSON.stringify(map));
    }

    await converge(backend, [a2, b2], (d) => ({ peer: d.user === 'alice' ? 'bob' : 'alice' }));
    await settle(backend);

    const winner = backend.registry.get(scope).keyId;
    record('an unreachable claim is taken over by a key that actually exists',
        winner !== deadKeyId, `keyId ${deadKeyId.slice(0, 8)} -> ${winner.slice(0, 8)}`);
    record('exactly one key wins the takeover, not one per participant',
        a2.activeKeyFor(scope) === b2.activeKeyFor(scope),
        `alice=${a2.activeKeyFor(scope).slice(0, 8)} bob=${b2.activeKeyFor(scope).slice(0, 8)}`);
    record('the winning key is the one the registry now names',
        await a2.api.conversationKeyId(a2.activeKeyFor(scope)) === winner);
    record('neither side loses what it already wrote',
        a2.canDecrypt(scope, a2.activeKeyFor(scope)) && b2.canDecrypt(scope, b2.activeKeyFor(scope)));
}

console.log('\n== forced reset survives a relaunch ==');
{
    // The reset queues every scope and each is only force-claimed when that chat is
    // next resolved. Held in memory, the queue expired at the next launch and the
    // reset silently skipped every conversation the user had not opened since.
    const backend = new SimBackend();
    backend.user('alice'); backend.user('bob');
    const scope = 'dm:alice:bob';
    const a = new Device('alice', backend, { deviceId: 'dev_reset_a' });
    const b = new Device('bob', backend, { deviceId: 'dev_reset_b' });
    await a.register(); await b.register();
    await a.resolve({ peer: 'bob', reason: 'seed' }); await settle(backend);
    await b.resolve({ peer: 'alice', reason: 'seed' }); await settle(backend);

    a.api.queueForceClaimScopes([scope]);
    // "Relaunch": a brand-new interface instance over the same storage, so anything
    // the queue kept on the instance is gone while localStorage survives.
    const relaunched = new Device('alice', backend, {
        deviceId: 'dev_reset_a', sandbox: a.sandbox,
    });
    const carried = relaunched.api.consumeForceClaimScope(scope);
    record('a queued forced claim survives into the next session', carried);
    record('it is consumed exactly once, so it cannot keep overwriting the registry',
        !relaunched.api.consumeForceClaimScope(scope));
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILURES: ' + failures} (${results.length} checks)\n`);
process.exit(failures === 0 ? 0 : 1);
