// End-to-end negotiation checks: two real ZaliInterface instances, a simulated
// zali-server, and a strict RTCPeerConnection model.
//
// The assertion is deliberately not "connectionState === connected" — that is
// exactly the state every silent call in this project's history reported. It is
// "both sides applied a local AND a remote description that carry audio", i.e.
// there is a session in which each end can actually be heard.
import { SimServer } from './lib/sim_server.mjs';
import { VoicePeer } from './lib/peer.mjs';
import { VirtualClock, drainMicrotasks } from './lib/clock.mjs';

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
            // Deliberately not awaited before settling: accepting a call awaits the
            // microphone, and a microphone that is slow (an open permission dialog)
            // only resolves once virtual time moves — which is settle()'s job. Await
            // it before settling and the scenario deadlocks on the harness, not on
            // the client.
            const accepting = autoAccept ? b.api.acceptIncomingCall() : null;
            await server.settle();
            if (accepting) await accepting;
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
    // voice_call_accepted and voice_call_connected arrive back to back and are both
    // dispatched fire-and-forget, so two syncVoicePeers passes overlap on every
    // single call. If the attach guard is not latched synchronously they both add
    // the same track: a real browser throws InvalidAccessError there, aborting
    // whichever pass was mid-negotiation.
    const dupes = ctx.a.duplicateAddTrackAttempts() + ctx.b.duplicateAddTrackAttempts();
    record('overlapping sync passes never add the same track twice', dupes === 0,
        `duplicate addTrack attempts=${dupes}`);
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

console.log('\n== the microphone permission dialog ==');

{
    // The callee leaves the permission dialog open for 30 s. getUserMedia stays
    // pending that whole time, and answering used to wait on it — so the CALLER was
    // not heard either, although receiving audio needs no permission at all, and the
    // caller's answer watchdog gives up after 8 s and starts rolling offers back.
    const ctx = await runDmCall({ calleeOpts: { micDelayMs: 30000 } });
    record('a slow microphone does not hold up the answer',
        ctx.b.tracesOf('answering-before-mic-ready').length === 1,
        `answered-early=${ctx.b.tracesOf('answering-before-mic-ready').length}`);
    record('the call is two-way once the slow microphone finally lands',
        twoWay(ctx), describe(ctx));
    // A mic that lands late releases several waiters at once (the accept, the
    // negotiation retry, the room-state pass), so this is where an attach guard
    // that latches after an await really does add the same track several times.
    const dupes = ctx.a.duplicateAddTrackAttempts() + ctx.b.duplicateAddTrackAttempts();
    record('a late microphone is attached exactly once per peer', dupes === 0,
        `duplicate addTrack attempts=${dupes}`);
}

console.log('\n== remote playback blocked by autoplay policy ==');

{
    // Nothing in the WebRTC layer is wrong here: the session is negotiated, RTP
    // arrives, and the <audio> element is simply not allowed to start. Only a user
    // gesture lifts that, and a call is not guaranteed to have had one on this
    // device (answered from a notification, page restored mid-call).
    const ctx = await runDmCall({ calleeOpts: { autoplayBlocked: true } });
    const sink = ctx.b.remoteSinkFor('alice');
    record('the session itself is fine — the sink is what is blocked',
        twoWay(ctx) && !!sink && sink.paused === true,
        `sink=${sink ? (sink.paused ? 'paused' : 'playing') : 'none'} ${describe(ctx)}`);
    record('a call in progress listens for the gesture that could unblock it',
        ctx.b.doc.listenerCount('pointerdown') > 0,
        `pointerdown listeners=${ctx.b.doc.listenerCount('pointerdown')}`);
    // No virtual time passes here, so this proves the gesture did it — not some
    // timer that would have fixed it anyway.
    ctx.b.autoplayBlocked = false;
    ctx.b.gesture('pointerdown');
    await drainMicrotasks();
    record('the next user gesture starts it playing, with no reload and no re-dial',
        ctx.b.remoteSinkFor('alice')?.paused === false,
        `sink=${ctx.b.remoteSinkFor('alice')?.paused ? 'paused' : 'playing'}`);
    ctx.a.api.resetVoiceState();
    record('the listeners are dropped when the call ends',
        ctx.a.doc.listenerCount('pointerdown') === 0,
        `pointerdown listeners=${ctx.a.doc.listenerCount('pointerdown')}`);
}

console.log('\n== a lost answer to a mid-call offer ==');

// The initial offer is covered by armVoiceAnswerWatchdog. The other two ways this
// client sends an offer — an ICE restart after a failed link, and a renegotiation
// after a track change — go through their own code paths, and an offer left
// unanswered there is just as fatal: the connection sits in 'have-local-offer'
// forever, every later renegotiation queues behind it, and no connection-state
// event ever fires again to notice (the state it would report has not changed).
// One dropped frame on a socket that reconnects mid-call is enough.
// `window` is virtual milliseconds spent with the loss still in place, so a
// multi-answer loss really spans several 8 s watchdog cycles instead of being
// undone before the first retry is even sent.
async function afterConnectWithLostAnswers(action, { lose = 1, window = 4000 } = {}) {
    return runDmCall({
        afterConnect: async ({ a, b, server }) => {
            let budget = lose;
            server.opts.dropFilter = (to, event) => {
                if (budget > 0 && event.type === 'voice_signal' && event.signal?.type === 'answer') {
                    budget -= 1;
                    return true;
                }
                return false;
            };
            await action({ a, b, server });
            await server.settle(window);
            server.opts.dropFilter = null;
            server.lostAnswers = lose - budget;
            await server.settle();
        },
    });
}

{
    const ctx = await afterConnectWithLostAnswers(({ a, b }) => a.api.restartVoicePeer(b.name));
    record('a lost answer to an ICE-restart offer still recovers', twoWay(ctx), describe(ctx));
}

{
    // Driven from the side that does NOT own the offer, which is the harder case:
    // the negotiation retry runs syncVoicePeers, and syncVoicePeers only offers on
    // behalf of the offer owner — so recovery here cannot lean on it.
    const ctx = await afterConnectWithLostAnswers(({ a, b }) => b.api.renegotiateVoicePeer(a.name));
    record('a lost answer to a renegotiation from the answering side still recovers',
        twoWay(ctx), describe(ctx));
}

{
    const ctx = await afterConnectWithLostAnswers(
        ({ a, b }) => a.api.renegotiateVoicePeer(b.name),
        { lose: 3, window: 30000 },
    );
    record('three consecutive lost answers still converge',
        twoWay(ctx) && ctx.server.lostAnswers === 3,
        `${describe(ctx)} lost=${ctx.server.lostAnswers}`);
}

{
    // A peer that answers nothing at all must not be re-offered for the rest of the
    // call: one dead link would otherwise renegotiate every 8 s forever.
    const ctx = await afterConnectWithLostAnswers(
        ({ a, b }) => a.api.renegotiateVoicePeer(b.name),
        { lose: 50, window: 120000 },
    );
    const offersAfter = ctx.server.lostAnswers;
    record('an unanswerable link gives up instead of re-offering forever',
        offersAfter <= 6 && ctx.a.tracesOf('answer-watchdog-exhausted').length === 1,
        `offers spent=${offersAfter} exhausted=${ctx.a.tracesOf('answer-watchdog-exhausted').length}`);
}

{
    // The offer never leaves the client at all (socket reconnecting, native bridge
    // refusing). sendVoiceOfferInner already treats that as a retryable failure;
    // the restart path must not latch offerSent on a frame that was never sent.
    const ctx = await runDmCall({
        afterConnect: async ({ a, b, server }) => {
            server.opts.refuseSend = true;
            await a.api.restartVoicePeer(b.name);
            await server.settle(1000);
            server.opts.refuseSend = false;
            await server.settle();
        },
    });
    record('an ICE-restart offer that never leaves the client is retried',
        twoWay(ctx), describe(ctx));
}

console.log('\n== the link dies mid-call ==');

// «Звонок отваливается спустя некоторое время». The drop itself is a network
// event — a Wi-Fi roam, a NAT rebind, a VPN re-key — and it is not a bug. What
// makes it a bug is that it is PERMANENT: connectionState reports 'failed' once
// and then, having nothing left to transition to, never fires again. Every
// recovery in this client is armed off that one edge, so whatever it hands off
// to has exactly one chance, and the fallbacks it hands off to (a restart queued
// behind an in-flight negotiation, an answer watchdog rolling the offer back,
// syncVoicePeers) all build a PLAIN offer — which re-agrees the media over the
// same dead transport and changes nothing. The call keeps showing «В эфире».
//
// The model is faithful about that on purpose: only an offer carrying iceRestart
// revives a broken transport, so hasTwoWayAudio stays true across a dead link and
// hasLiveTwoWayAudio is what actually distinguishes sound from silence.
{
    const ctx = await runDmCall({
        afterConnect: async ({ a, b, server }) => {
            a.breakLinkWith(b.name);
            b.breakLinkWith(a.name);
            await server.settle(120000);
        },
    });
    record('a link that dies mid-call comes back',
        ctx.a.hasLiveTwoWayAudio(ctx.b.name) && ctx.b.hasLiveTwoWayAudio(ctx.a.name),
        `${ctx.a.name}=${ctx.a.linkStateWith(ctx.b.name)} ${ctx.b.name}=${ctx.b.linkStateWith(ctx.a.name)} ${describe(ctx)}`);
    record('recovery is an ICE restart, not a plain renegotiation',
        ctx.a.iceRestartsWith(ctx.b.name) > 0,
        `iceRestarts=${ctx.a.iceRestartsWith(ctx.b.name)}`);
}

{
    // The same failure, but arriving while that peer is already renegotiating —
    // the ordinary case in a real call, where a camera toggle or a late mic is in
    // flight. restartVoicePeer refuses to build an offer outside 'stable' and
    // parks the request on renegotiationPending, which drains as a renegotiation.
    const ctx = await runDmCall({
        afterConnect: async ({ a, b, server }) => {
            const inFlight = a.api.renegotiateVoicePeer(b.name).catch(() => {});
            a.breakLinkWith(b.name);
            b.breakLinkWith(a.name);
            await inFlight;
            await server.settle(120000);
        },
    });
    record('a failure landing during a renegotiation still recovers',
        ctx.a.hasLiveTwoWayAudio(ctx.b.name) && ctx.b.hasLiveTwoWayAudio(ctx.a.name),
        `${ctx.a.name}=${ctx.a.linkStateWith(ctx.b.name)} ${ctx.b.name}=${ctx.b.linkStateWith(ctx.a.name)}`);
}

{
    // The recovery offer itself is lost. Nothing re-arms off connectionState — it
    // is already 'failed' and stays there — so this is the case where a single
    // dropped frame used to cost the whole call.
    const ctx = await runDmCall({
        afterConnect: async ({ a, b, server }) => {
            let budget = 2;
            server.opts.dropFilter = (to, event) => {
                if (budget > 0 && event.type === 'voice_signal' && event.signal?.type === 'answer') {
                    budget -= 1;
                    return true;
                }
                return false;
            };
            a.breakLinkWith(b.name);
            b.breakLinkWith(a.name);
            await server.settle(60000);
            server.opts.dropFilter = null;
            await server.settle(120000);
        },
    });
    record('a lost answer to the recovery offer does not cost the call',
        ctx.a.hasLiveTwoWayAudio(ctx.b.name) && ctx.b.hasLiveTwoWayAudio(ctx.a.name),
        `${ctx.a.name}=${ctx.a.linkStateWith(ctx.b.name)} ${ctx.b.name}=${ctx.b.linkStateWith(ctx.a.name)}`);
}

{
    // A network that is down for minutes, not seconds: every recovery attempt in
    // the first two minutes is thrown away. Recovery must still be running when
    // the network returns — giving up quietly is the same outcome as never trying.
    const ctx = await runDmCall({
        afterConnect: async ({ a, b, server }) => {
            server.opts.dropFilter = () => true;
            a.breakLinkWith(b.name);
            b.breakLinkWith(a.name);
            await server.settle(150000);
            server.opts.dropFilter = null;
            await server.settle(150000);
        },
    });
    record('a two-minute outage is survived, not given up on',
        ctx.a.hasLiveTwoWayAudio(ctx.b.name) && ctx.b.hasLiveTwoWayAudio(ctx.a.name),
        `${ctx.a.name}=${ctx.a.linkStateWith(ctx.b.name)} ${ctx.b.name}=${ctx.b.linkStateWith(ctx.a.name)}`);
}

{
    // The supervision must not become a permanent timer on a healthy call: a
    // clean call has nothing to supervise, and an interval that keeps running is
    // both a battery cost and a source of surprise renegotiations.
    const ctx = await runDmCall();
    record('a healthy call leaves no supervision timer running',
        !ctx.a.api.voice.linkSupervisorTimer && !ctx.b.api.voice.linkSupervisorTimer,
        `alice=${!!ctx.a.api.voice.linkSupervisorTimer} bob=${!!ctx.b.api.voice.linkSupervisorTimer}`);
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

{
    // Straight from the production log (2026-08-03, three separate calls):
    //   ERROR [VOICE] offer-apply-error ... error=The object is in an invalid state.
    //   WARN  [VOICE] answer-never-arrived ... state=have-local-offer attempt=1
    // An offer arrived while the connection was in a signaling state that cannot
    // take one — legal to be in, illegal to apply an offer to, and impossible to
    // roll back out of. setRemoteDescription threw, the throw aborted the handler
    // before createAnswer(), no answer was ever sent, and the caller sat waiting
    // until its watchdog gave up. Nothing retried, so one bad apply killed the call.
    //
    // Only the polite side reaches the apply path at all (the impolite side keeps
    // its own offer and returns early), so park whichever peer that is.
    const ctx = await runDmCall({
        afterConnect: async ({ a, b, server }) => {
            const polite = a.api.isPoliteVoicePeer(b.name) ? a : b;
            const other = polite === a ? b : a;
            const entry = polite.api.getVoicePeerEntry(other.name);
            // have-remote-offer: reachable in production whenever an offer is applied
            // and the answer has not been produced yet.
            await entry.pc.setRemoteDescription({ type: 'offer', sdp: 'v=0\r\nparked\r\n' });
            await polite.deliver({
                type: 'voice_signal',
                roomId: polite.api.voice.roomId,
                from: other.name,
                to: polite.name,
                signal: { type: 'offer', sdp: { type: 'offer', sdp: 'v=0\r\nfresh\r\n' } },
            });
            await server.settle();
        },
    });
    const applyErrors = ctx.a.tracesOf('offer-apply-error').length
        + ctx.b.tracesOf('offer-apply-error').length;
    const rebuilds = ctx.a.tracesOf('offer-unapplicable-rebuild').length
        + ctx.b.tracesOf('offer-unapplicable-rebuild').length;
    const answers = ctx.a.tracesOf('signal-answer-send').length
        + ctx.b.tracesOf('signal-answer-send').length;
    record('an offer arriving in a state that cannot take one is rebuilt, not thrown away',
        rebuilds > 0 && applyErrors === 0,
        `rebuilds=${rebuilds} applyErrors=${applyErrors}`);
    record('that offer still produces an answer', answers > 0, `answers=${answers}`);
    record('the call survives an unapplicable offer', twoWay(ctx), describe(ctx));
}

{
    // Also straight from the production log (2026-08-03, a channel call), and a
    // different failure from the one above — the signaling state was legal:
    //   ERROR [VOICE] offer-apply-error ... error=Failed to set remote offer sdp:
    //     The order of m-lines in subsequent offer doesn't match order from
    //     previous offer/answer.
    //   → pc-state peer=Pivovarca from=connecting to=disconnected
    // A peer that rebuilds its RTCPeerConnection can lay its m-sections out in a
    // different order than the session this side already established, and this
    // side's layout is immutable — so the generic "clear the latch and retry"
    // recovery replays the identical mismatch forever. It failed twice in three
    // seconds in the log, then the link went down.
    const ctx = await runDmCall({
        afterConnect: async ({ a, b, server }) => {
            await b.deliver({
                type: 'voice_signal',
                roomId: b.api.voice.roomId,
                from: a.name,
                to: b.name,
                signal: {
                    type: 'offer',
                    sdp: {
                        type: 'offer',
                        // Same media as the live session, laid out the other way
                        // round — what a freshly built connection sends when its
                        // tracks were attached in a different order.
                        sdp: JSON.stringify({ type: 'offer', sends: ['video', 'audio'], streamIds: [''], ufrag: 'relaid' }),
                    },
                },
            });
            await server.settle();
        },
    });
    const answersBefore = 1;
    const rebuilds = ctx.b.tracesOf('offer-sdp-shape-rebuild').length;
    const applyErrors = ctx.b.tracesOf('offer-apply-error').length;
    const answers = ctx.b.tracesOf('signal-answer-send').length;
    record('an offer whose m-lines cannot match this session rebuilds instead of retrying',
        rebuilds > 0 && applyErrors === 0, `rebuilds=${rebuilds} applyErrors=${applyErrors}`);
    record('the relaid offer is answered rather than dropped',
        answers > answersBefore, `answers=${answers}`);
    record('the call survives an offer with an incompatible layout', twoWay(ctx), describe(ctx));
}

// ---------------------------------------------------------------------------
console.log('\n== always-on health telemetry ==');

{
    // The per-peer health sampler is the only thing that reports "RTP is flowing and
    // the sink can play it" on a live call, and it is what retries a sink the
    // autoplay policy paused. It used to be installed only on a link that had
    // ALREADY failed once — the entry was created with a plain 5 s stats timer that
    // nothing on the healthy path cleared, so the `if (!entry.statsTimer)` guard
    // that was supposed to install the health sampler on connect never fired. Which
    // means the telemetry written for calls that connect and stay silent did not run
    // on precisely those calls.
    const ctx = await runDmCall();
    await ctx.server.settle(60000);
    const aHealth = ctx.a.tracesOf('audio-health');
    const bHealth = ctx.b.tracesOf('audio-health');
    record('a call that never fails still reports per-peer audio health',
        aHealth.length > 0 && bHealth.length > 0,
        `alice=${aHealth.length} bob=${bHealth.length} lines`);
    const sample = aHealth[aHealth.length - 1]?.details || {};
    record('the health line carries both directions, not just what we receive',
        Object.prototype.hasOwnProperty.call(sample, 'rx')
        && Object.prototype.hasOwnProperty.call(sample, 'tx'),
        `keys=${Object.keys(sample).join(',')}`);
    record('the health line names the connection state it was sampled in',
        Object.prototype.hasOwnProperty.call(sample, 'pcState')
        && Object.prototype.hasOwnProperty.call(sample, 'ice'),
        `pcState=${sample.pcState || ''} ice=${sample.ice || ''}`);
    // A link that has not connected yet has no RTP by definition. Warning about it
    // on every call — several times per peer in a group — is how a diagnostic stops
    // being read; the failure of a link that never connects is reported by the
    // state and recovery lines instead.
    // Forced rather than waited for: on this model the link connects too quickly to
    // catch a sample mid-setup, and a check that passes because it observed nothing
    // is not a check.
    ctx.a.breakLinkWith('bob');
    const beforeForced = ctx.a.tracesOf('audio-health').length;
    await ctx.a.api.reportVoiceAudioHealth('bob');
    const forced = ctx.a.tracesOf('audio-health').slice(beforeForced);
    record('health lines from a link that is not up are not warnings',
        forced.length === 1 && forced[0].level === 'INFO',
        `level=${forced[0]?.level} pcState=${forced[0]?.details.pcState}`);
}

{
    // The end-of-call summary has to be written while the peer entries still exist:
    // resetVoiceState closes them, and everything worth reporting lives on them.
    const ctx = await runDmCall();
    await ctx.a.api.leaveVoiceRoom({ announce: true, outcome: 'completed' });
    await ctx.server.settle();
    const summary = ctx.a.tracesOf('call-summary');
    const perPeer = ctx.a.tracesOf('call-summary-peer');
    record('ending a call writes a summary', summary.length === 1, `lines=${summary.length}`);
    record('the summary reaches the peers before they are torn down',
        perPeer.length >= 1 && perPeer[0].details.peer === ctx.b.name,
        `peers=${perPeer.map(l => l.details.peer).join(',')}`);
}

console.log('\n== nothing negotiates before the call is answered ==');

{
    // The offer branch captures the microphone and answers with a sendrecv session.
    // It did so no matter whether the user had accepted, and the server lets an
    // invite's initiator signal into their own ringing room — so a caller running a
    // modified client could ring a contact and listen to them before they picked up.
    let refusedWhileRinging = null;
    const ctx = await runDmCall({
        beforeAccept: async ({ b, server }) => {
            const roomId = b.api.voice.incomingInvite?.roomId || '';
            await b.deliver({
                type: 'voice_signal',
                roomId,
                roomType: 'dm',
                from: 'alice',
                to: b.name,
                signal: { type: 'offer', sdp: { type: 'offer', sdp: JSON.stringify({ sends: ['audio'] }) } },
            });
            await server.settle(1000);
            refusedWhileRinging = {
                status: b.api.voice.status,
                mic: !!b.api.voice.localStream,
                peer: !!b.entryFor('alice'),
                refusals: b.tracesOf('signal-before-accept-refused').length,
            };
        },
    });
    record('an offer arriving before the call is answered does not open the microphone',
        refusedWhileRinging && refusedWhileRinging.mic === false,
        `mic=${refusedWhileRinging?.mic}`);
    record('and does not build a peer connection to answer through',
        refusedWhileRinging && refusedWhileRinging.peer === false,
        `peerConnection=${refusedWhileRinging?.peer}`);
    record('the invite is still ringing rather than half-connected',
        refusedWhileRinging && refusedWhileRinging.status === 'incoming',
        `status=${refusedWhileRinging?.status}`);
    record('the refusal is recorded, not silent',
        refusedWhileRinging && refusedWhileRinging.refusals === 1,
        `refusals=${refusedWhileRinging?.refusals}`);
    // The guard must cost the legitimate flow nothing: the real caller only offers
    // after voice_call_accepted, by which time this side is 'connecting'.
    record('accepting afterwards still produces a working call', twoWay(ctx), describe(ctx));
}

{
    // Signals are addressed by username and the server fans them out to every
    // connection of that account, so the second device of the account that answered
    // receives the same offers. With no room state of its own it used to answer
    // them: two answers for one offer, only the first applied, and which device won
    // the call decided by whichever replied first.
    const clock = new VirtualClock();
    const server = new SimServer({ clock });
    const a = new VoicePeer('alice', server, { clock });
    const b = new VoicePeer('bob', server, { clock });
    // A second, idle client — the same person's other device, as far as this
    // handler can tell.
    const bystander = new VoicePeer('bob', server, { clock });
    server.register(a); server.register(b);

    await a.api.startDirectCall('bob');
    await server.settle(2000);
    const accepting = b.api.acceptIncomingCall();
    await server.settle();
    await accepting;

    const offer = a.sent.find(e => e.type === 'voice_signal' && e.signal?.type === 'offer');
    await bystander.deliver({ ...offer, from: 'alice' });
    await server.settle(1000);

    record('a device that is not in the call does not answer offers meant for it',
        !bystander.api.voice.localStream && !bystander.entryFor('alice')
        && bystander.api.voice.roomId === '',
        `mic=${!!bystander.api.voice.localStream} peer=${!!bystander.entryFor('alice')} roomId=${JSON.stringify(bystander.api.voice.roomId)}`);
    record('and the refusal is recorded',
        bystander.tracesOf('signal-outside-call-refused').length === 1,
        `lines=${bystander.tracesOf('signal-outside-call-refused').length}`);
    record('the device that did answer is unaffected',
        twoWay({ a, b, deadlocked: '' }), describe({ a, b, server, deadlocked: '' }));
}

console.log('\n== a call that cannot be recovered ends ==');

{
    // The supervisor gives a broken link about eight minutes. When that ran out it
    // simply stopped, and the call stayed on screen as «В эфире» forever: no
    // participant could be reached, no ICE restart could land, and only the user
    // pressing the red button ended it — with no call record written either.
    const clock = new VirtualClock();
    // Signalling dies along with the media, which is what a real outage looks like:
    // a restart offer that cannot be delivered can never bring the link back.
    const server = new SimServer({
        clock,
        dropFilter: (to, event) => event.type === 'voice_signal' && server.mediaDead,
    });
    server.mediaDead = false;
    const a = new VoicePeer('alice', server, { clock });
    const b = new VoicePeer('bob', server, { clock });
    server.register(a); server.register(b);

    await a.api.startDirectCall('bob');
    await server.settle(2000);
    const accepting = b.api.acceptIncomingCall();
    await server.settle();
    await accepting;
    const connected = twoWay({ a, b, deadlocked: '' });
    // Captured now: describe() reads live peer state, and by the time this is
    // reported the call has been torn down and there is nothing left to describe.
    const connectedDetail = describe({ a, b, server, deadlocked: '' });

    server.mediaDead = true;
    a.breakLinkWith('bob');
    b.breakLinkWith('alice');
    // Long enough to outlast the whole recovery budget (20 attempts, spaced up to
    // 25 s) — the point is that it gives up rather than trying forever.
    await server.settle(900000);

    record('the call was live before the network died', connected, connectedDetail);
    record('an unrecoverable call gives up instead of showing «В эфире» forever',
        a.api.voice.roomId === '' && a.api.voice.status === 'idle',
        `roomId=${JSON.stringify(a.api.voice.roomId)} status=${a.api.voice.status}`);
    record('and says why in the log',
        a.tracesOf('call-dead-all-links-exhausted').length === 1,
        `lines=${a.tracesOf('call-dead-all-links-exhausted').length}`);
}

{
    // The same conclusion from the other direction: the server says the room we
    // believe we are in does not exist. Nothing can be signalled into it, so the
    // call is over whatever the panel says. Matched on the machine-readable code —
    // the human-readable message is Russian prose a rewording would detach this from.
    const ctx = await runDmCall();
    const roomId = ctx.a.api.voice.roomId;
    await ctx.a.deliver({
        type: 'voice_error',
        roomId,
        code: 'room_not_found',
        message: 'Голосовая комната не найдена',
    });
    await ctx.server.settle();
    record('a room the server has forgotten ends the call here too',
        ctx.a.api.voice.roomId === '' && ctx.a.api.voice.status === 'idle',
        `roomId=${JSON.stringify(ctx.a.api.voice.roomId)} status=${ctx.a.api.voice.status}`);
}

{
    // A voice_error for some OTHER room must not touch a live call — a stale error
    // from a cancelled invite arriving mid-call is ordinary traffic.
    const ctx = await runDmCall();
    const roomId = ctx.a.api.voice.roomId;
    await ctx.a.deliver({
        type: 'voice_error',
        roomId: 'voice:dm:alice:carol:stale',
        code: 'room_not_found',
        message: 'Голосовая комната не найдена',
    });
    await ctx.server.settle();
    record('an error about a different room leaves the live call alone',
        ctx.a.api.voice.roomId === roomId, `roomId=${JSON.stringify(ctx.a.api.voice.roomId)}`);
}

console.log('\n== the signalling transport coming back ==');

{
    // On native shells the voice socket lives in Swift/Rust and reconnects there;
    // JS never learned it had happened, so a participant evicted server-side waited
    // for the 8 s presence keepalive to notice. The shells now report the link, and
    // membership is re-asserted the moment it is back.
    const ctx = await runDmCall();
    const before = ctx.a.sent.filter(e => e.type === 'voice_join').length;
    await ctx.a.deliver({ type: 'voice_transport_state', state: 'up', reason: 'connected' });
    await ctx.server.settle(1000);
    const after = ctx.a.sent.filter(e => e.type === 'voice_join').length;
    record('a reconnected voice transport re-asserts room membership at once',
        after === before + 1, `voice_join sent before=${before} after=${after}`);
    const rejoins = ctx.a.sent.filter(e => e.type === 'voice_join');
    record('and the re-assert is marked keepalive, so it cannot evict another device',
        rejoins.length > 0 && rejoins.every(e => e.keepalive === true),
        `keepalive flags=[${rejoins.map(e => String(e.keepalive)).join(',')}]`);
}

{
    // A payload the shell could not deliver: over the native bridge sendVoiceEvent
    // is fire-and-forget and always reports success, so this event is the only way
    // a dropped offer ever becomes visible to the negotiation logic.
    const ctx = await runDmCall();
    const entry = ctx.a.entryFor('bob');
    entry.offerSent = true;
    await ctx.a.deliver({
        type: 'voice_send_failed',
        eventType: 'voice_signal',
        signalType: 'offer',
        to: 'bob',
        reason: 'queue-overflow',
    });
    await ctx.server.settle(1000);
    record('a dropped offer unlatches the peer instead of stranding it',
        ctx.a.entryFor('bob')?.offerSent === false,
        `offerSent=${ctx.a.entryFor('bob')?.offerSent}`);

    // A dropped ICE candidate is not a dropped offer: the offer is still valid and
    // still awaiting its answer, and unlatching there only forces a pointless
    // renegotiation on a link that is still converging.
    ctx.a.entryFor('bob').offerSent = true;
    await ctx.a.deliver({
        type: 'voice_send_failed',
        eventType: 'voice_signal',
        signalType: 'ice',
        to: 'bob',
        reason: 'queue-overflow',
    });
    await ctx.server.settle(1000);
    record('a dropped ICE candidate does not tear down a valid offer',
        ctx.a.entryFor('bob')?.offerSent === true,
        `offerSent=${ctx.a.entryFor('bob')?.offerSent}`);
}

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
