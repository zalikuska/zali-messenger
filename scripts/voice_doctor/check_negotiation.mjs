// End-to-end negotiation checks: two real ZaliInterface instances, a simulated
// zali-server, and a strict RTCPeerConnection model.
//
// The assertion is deliberately not "connectionState === connected" — that is
// exactly the state every silent call in this project's history reported. It is
// "both sides applied a local AND a remote description that carry audio", i.e.
// there is a session in which each end can actually be heard.
import { SimServer } from './lib/sim_server.mjs';
import { VoicePeer } from './lib/peer.mjs';
import { VirtualClock } from './lib/clock.mjs';

const results = [];
let failures = 0;

function record(name, ok, detail = '') {
    results.push({ name, ok, detail });
    if (!ok) failures += 1;
    const mark = ok ? 'PASS' : 'FAIL';
    process.stdout.write(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function mulberry32(seed) {
    return function () {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

// A scenario that never finishes is the single most important failure mode here —
// the AudioContext deadlock manifested exactly as "acceptIncomingCall() never
// returns". Without a real-time deadline the suite would just hang and report
// nothing, which is indistinguishable from a machine that is merely slow.
const SCENARIO_DEADLINE_MS = 20000;
class Deadlocked extends Error {}
function withDeadline(promise, label) {
    let timer;
    return Promise.race([
        promise.finally(() => clearTimeout(timer)),
        new Promise((_, reject) => {
            // Deliberately NOT unref'd. A deadlocked scenario leaves no real timers
            // (the clock is virtual), so an unref'd deadline lets Node decide the
            // event loop is empty and exit silently — reporting nothing at all,
            // which is exactly the outcome this deadline exists to prevent.
            timer = setTimeout(() => reject(new Deadlocked(`${label} did not finish in ${SCENARIO_DEADLINE_MS} ms`)), SCENARIO_DEADLINE_MS);
        }),
    ]);
}

/** One DM call from `a` to `b`, driven through the real entry points. */
async function runDmCall({
    caller = 'alice', callee = 'bob', serverOpts = {}, callerOpts = {}, calleeOpts = {},
    beforeAccept = null, afterConnect = null, autoAccept = true,
} = {}) {
    const clock = new VirtualClock();
    const server = new SimServer({ ...serverOpts, clock });
    const a = new VoicePeer(caller, server, { ...callerOpts, clock });
    const b = new VoicePeer(callee, server, { ...calleeOpts, clock });
    server.register(a); server.register(b);

    const ctx = { a, b, server, deadlocked: '' };
    try {
        await withDeadline((async () => {
            await a.api.startDirectCall(callee);
            await server.settle(2000);
            if (beforeAccept) await beforeAccept({ a, b, server });
            if (autoAccept) await b.api.acceptIncomingCall();
            await server.settle();
            if (afterConnect) { await afterConnect({ a, b, server }); await server.settle(); }
        })(), `${caller}->${callee}`);
    } catch (error) {
        if (!(error instanceof Deadlocked)) throw error;
        ctx.deadlocked = error.message;
    }
    return ctx;
}

function twoWay({ a, b, deadlocked }) {
    if (deadlocked) return false;
    return a.hasTwoWayAudio(b.name) && b.hasTwoWayAudio(a.name);
}

function describe({ a, b, server, deadlocked }) {
    if (deadlocked) return `DEADLOCKED: ${deadlocked}`;
    const ea = a.entryFor(b.name); const eb = b.entryFor(a.name);
    return `signalling=${JSON.stringify(server.signalCounts())} `
        + `${a.name}[state=${ea?.pc.signalingState || 'none'} in=${ea?.pc.negotiatedIncomingKinds() || []} out=${ea?.pc.negotiatedOutgoingKinds() || []}] `
        + `${b.name}[state=${eb?.pc.signalingState || 'none'} in=${eb?.pc.negotiatedIncomingKinds() || []} out=${eb?.pc.negotiatedOutgoingKinds() || []}]`;
}

// ---------------------------------------------------------------------------
console.log('\n== DM calls ==');

{
    const ctx = await runDmCall();
    record('plain DM call carries audio both ways', twoWay(ctx), describe(ctx));
    const counts = ctx.server.signalCounts();
    record('exactly one offer and one answer on a clean call',
        counts.offer === 1 && counts.answer === 1, JSON.stringify(counts));
}

{
    // The historical killer: both ends decide the other one owns the offer.
    const ctx = await runDmCall();
    const offerers = [];
    if (ctx.a.api.shouldInitiateVoiceOffer(ctx.b.name)) offerers.push(ctx.a.name);
    if (ctx.b.api.shouldInitiateVoiceOffer(ctx.a.name)) offerers.push(ctx.b.name);
    record('exactly one side owns the offer', offerers.length === 1, `offerers=[${offerers}]`);
    const politeA = ctx.a.api.isPoliteVoicePeer(ctx.b.name);
    const politeB = ctx.b.api.isPoliteVoicePeer(ctx.a.name);
    record('politeness is the strict inverse of offer ownership',
        politeA !== ctx.a.api.shouldInitiateVoiceOffer(ctx.b.name)
        && politeB !== ctx.b.api.shouldInitiateVoiceOffer(ctx.a.name)
        && politeA !== politeB,
        `politeA=${politeA} politeB=${politeB}`);
}

{
    // WebKit's refused AudioContext.resume() — a promise that never settles.
    const audio = { resumeNeverSettles: true };
    const ctx = await runDmCall({ callerOpts: { audio }, calleeOpts: { audio } });
    record('call still completes when AudioContext.resume() never settles',
        twoWay(ctx), describe(ctx));
    record('callee is not left holding the call-setup latch',
        ctx.b.api.voice.callSetupInFlight === false,
        `callSetupInFlight=${ctx.b.api.voice.callSetupInFlight}`);
}

{
    // Microphone denied on the callee: the call must not pretend to be fine.
    const ctx = await runDmCall({ calleeOpts: { micFails: true } });
    const calleeSilent = !ctx.b.api.voice.localStream;
    record('denied mic is reported instead of silently swallowed',
        calleeSilent && !!ctx.b.api.voice.micError,
        `micError=${JSON.stringify(ctx.b.api.voice.micError)}`);
    record('caller still hears the callee-less call as one-way, not as connected audio',
        !twoWay(ctx), describe(ctx));
}

{
    // Mic arrives late — the answer was recvonly and must be renegotiated.
    let unblock;
    const gate = new Promise(r => { unblock = r; });
    const ctx = await runDmCall({
        calleeOpts: {},
        afterConnect: async ({ b }) => { unblock(); await gate; },
    });
    record('late microphone does not leave a permanently one-way call', twoWay(ctx), describe(ctx));
}

console.log('\n== simultaneous invites (call glare) ==');

{
    // Both people tap «Позвонить» within the ringing window — which is exactly what
    // they do after a call failed to connect once. Each side then has a ringing
    // outgoing invite, and isInActiveCall() counts 'calling', so the busy guard used
    // to auto-reject the other's invite. Both rooms died and nobody ever answered.
    // Production log 2026-08-02: 15 invites, 124 rejects, 0 answers.
    const clock = new VirtualClock();
    const server = new SimServer({ clock });
    const a = new VoicePeer('alice', server, { clock });
    const b = new VoicePeer('bob', server, { clock });
    server.register(a); server.register(b);

    await Promise.all([
        a.api.startDirectCall('bob'),
        b.api.startDirectCall('alice'),
    ]);
    await server.settle();

    const rejects = server.log.filter(r => r.type === 'voice_call_reject').length;
    record('neither side auto-rejects the person it is calling', rejects === 0,
        `voice_call_reject sent=${rejects}`);

    // Before an accept the callee deliberately has no voice.roomId (it is set when
    // answering), so convergence is checked on the invites themselves.
    const callee = a.api.voice.status === 'incoming' ? a : (b.api.voice.status === 'incoming' ? b : null);
    const caller = callee === a ? b : a;
    record('exactly one side ends up as the callee, one as the caller',
        !!callee && caller.api.voice.status === 'calling',
        `alice=${a.api.voice.status} bob=${b.api.voice.status}`);
    if (callee) {
        record('both sides point at the same surviving room',
            callee.api.voice.incomingInvite?.roomId === caller.api.voice.outgoingInvite?.roomId
            && !!caller.api.voice.outgoingInvite?.roomId,
            `callee=${callee.api.voice.incomingInvite?.roomId || 'none'} caller=${caller.api.voice.outgoingInvite?.roomId || 'none'}`);
        await callee.api.acceptIncomingCall();
        await server.settle();
        record('the surviving call carries audio both ways', twoWay({ a, b }), describe({ a, b, server }));
    }
}

console.log('\n== hostile transport ==');

for (const [label, opts] of [
    ['dropped signals (20%)', { dropRate: 0.2, rng: mulberry32(7) }],
    ['reordered delivery', { reorder: true, jitter: 3, rng: mulberry32(11) }],
    ['duplicated delivery', { duplicateRate: 0.5, rng: mulberry32(13) }],
    ['jittered delivery', { jitter: 5, rng: mulberry32(17) }],
]) {
    const ctx = await runDmCall({ serverOpts: opts });
    record(`call converges with ${label}`, twoWay(ctx), describe(ctx));
}

console.log('\n== ICE / candidate faults ==');

{
    const ctx = await runDmCall({ callerOpts: { faults: { noRelay: true } } });
    record('no relay candidate is flagged as a warning',
        ctx.a.traces.some(t => t.stage === 'ice-candidate-end' && t.level === 'WARN'),
        'expected WARN on ice-candidate-end without relay');
    record('session still negotiates without a relay candidate', twoWay(ctx), describe(ctx));
}

{
    const ctx = await runDmCall({ callerOpts: { faults: { gatherNothing: true } } });
    record('a peer that gathers no candidates still completes SDP negotiation',
        twoWay(ctx), describe(ctx));
}

console.log('\n== glare (simultaneous offers) ==');

{
    // Force both ends to renegotiate at the same instant.
    const ctx = await runDmCall({
        afterConnect: async ({ a, b, server }) => {
            await Promise.all([
                a.api.renegotiateVoicePeer(b.name).catch(() => {}),
                b.api.renegotiateVoicePeer(a.name).catch(() => {}),
            ]);
            await server.settle();
        },
    });
    record('simultaneous renegotiation resolves to a live session', twoWay(ctx), describe(ctx));
    const rolledBackBoth = ctx.a.tracesOf('offer-collision-rollback').length > 0
        && ctx.b.tracesOf('offer-collision-rollback').length > 0;
    record('glare never has both sides roll back', !rolledBackBoth,
        rolledBackBoth ? 'both sides rolled back — nobody answers' : '');
}

console.log('\n== name tie-break determinism ==');

{
    // In a voice channel there is no inviter, so the offerer is decided purely by
    // comparing the two usernames — and the two ends run different engines. The
    // comparison must therefore be engine-independent. localeCompare is not:
    // with full ICU 'apple' < 'Zebra'; without it, code units put 'Zebra' first.
    // If the two sides disagree, both offer AND both are impolite: each drops the
    // other's offer, no answer is ever sent, the call is "connected" and silent.
    const pairs = [
        ['Zebra', 'apple'], ['GRIBOED', 'apple'], ['alice', 'Bob'],
        ['ёж', 'Ёж'], ['user_1', 'User-1'], ['a', 'A'],
        ['GRIBOED', 'zalikus'], ['igorek', 'pro_cofiev'],
    ];
    const clock = new VirtualClock();
    const server = new SimServer({ clock });
    const probe = new VoicePeer('probe', server, { clock });

    const localeDivergent = [];
    const comparatorDivergent = [];
    const badRoles = [];
    for (const [x, y] of pairs) {
        const icu = Math.sign(x.localeCompare(y));
        const codeUnit = x < y ? -1 : x > y ? 1 : 0;
        if (icu !== codeUnit) localeDivergent.push(`${x}/${y}`);
        // The shipping comparator must match code-unit order, which every engine
        // computes identically, and must be antisymmetric.
        const got = Math.sign(probe.api.compareVoicePeerNames(x, y));
        const back = Math.sign(probe.api.compareVoicePeerNames(y, x));
        if (got !== codeUnit || back !== -codeUnit) {
            comparatorDivergent.push(`${x}/${y}: got=${got} reverse=${back} expected=${codeUnit}`);
        }
    }
    record('shipping tie-break matches engine-independent code-unit order',
        comparatorDivergent.length === 0, comparatorDivergent.join('; '));
    record('the hazard it guards against is real (localeCompare does diverge)',
        localeDivergent.length > 0,
        `diverging pairs: ${localeDivergent.join(', ')}`);

    // Full role check per pair, with a fresh peer per identity.
    const roleFailures = [];
    for (const [x, y] of pairs) {
        const c2 = new VirtualClock();
        const srv = new SimServer({ clock: c2 });
        const px = new VoicePeer(x, srv, { clock: c2 });
        const py = new VoicePeer(y, srv, { clock: c2 });
        for (const p of [px, py]) { p.api.voice.roomType = 'channel'; p.api.voice.status = 'connected'; }
        const offerers = [x, y].filter((n, i) => (i === 0 ? px : py).api.shouldInitiateVoiceOffer(i === 0 ? y : x));
        const polite = [px.api.isPoliteVoicePeer(y), py.api.isPoliteVoicePeer(x)];
        if (offerers.length !== 1 || polite[0] === polite[1] || polite[0] === px.api.shouldInitiateVoiceOffer(y)) {
            roleFailures.push(`${x}/${y}: offerers=[${offerers}] polite=[${polite}]`);
        }
    }
    record('every name pair yields exactly one offerer and one polite side',
        roleFailures.length === 0, roleFailures.join('; '));
}

// ---------------------------------------------------------------------------
console.log('\n== randomized scenarios ==');
{
    let bad = 0; let ran = 0; const examples = [];
    for (let seed = 1; seed <= 40; seed++) {
        const rng = mulberry32(seed * 2654435761);
        const serverOpts = {
            rng,
            dropRate: rng() < 0.5 ? rng() * 0.25 : 0,
            jitter: rng() < 0.5 ? rng() * 4 : 0,
            reorder: rng() < 0.3,
            duplicateRate: rng() < 0.3 ? rng() * 0.4 : 0,
        };
        const names = [['alice', 'bob'], ['Zebra', 'apple'], ['GRIBOED', 'zalikus'], ['igorek', 'pro_cofiev']][seed % 4];
        const audio = rng() < 0.5 ? { resumeNeverSettles: true } : {};
        const ctx = await runDmCall({
            caller: names[0], callee: names[1],
            serverOpts,
            callerOpts: { audio },
            calleeOpts: { audio },
        });
        ran += 1;
        if (!twoWay(ctx)) {
            bad += 1;
            if (examples.length < 3) examples.push(`seed=${seed} ${JSON.stringify(serverOpts)} :: ${describe(ctx)}`);
        }
    }
    record(`${ran} randomized calls all end with two-way audio`, bad === 0,
        bad ? `${bad} silent calls, e.g. ${examples.join(' | ')}` : '');
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILURES: ' + failures} (${results.length} checks)\n`);
process.exit(failures === 0 ? 0 : 1);
