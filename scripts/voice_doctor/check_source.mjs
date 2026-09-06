// Source-level guards for the failure shapes that the runtime checks cannot see
// once they are fixed — every one of these has already shipped as a silent call.
//
// These are intentionally blunt string/regex rules over web/src/interface.js. A
// rule firing is not automatically a bug, but it means someone reintroduced a
// pattern that cost this project a broken call before, and the comment says which.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, readInterfaceSource } from './lib/load_interface.mjs';

// Читается вся группа `interface` из web/src/manifest.json: класс разложен по
// web/src/interface/*.js, и правило, смотрящее в один interface.js, с этого
// момента проверяло бы пустой класс-каркас и всегда «проходило».
const raw = readInterfaceSource();
// Comments discuss these patterns by name on purpose (that is where the reasoning
// lives), so the rules must look at code only.
// Conservative on purpose: only whole-line comments are removed. A cleverer
// stripper risks eating code that merely looks like a comment (regex literals,
// URLs in strings) and turning these rules into nonsense.
const src = raw
    .split('\n')
    .map(line => (line.trim().startsWith('//') ? '' : line))
    .join('\n');
const lines = src.split('\n');
let failures = 0;

function record(name, ok, detail = '') {
    if (!ok) failures += 1;
    process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

function hits(re) {
    const out = [];
    lines.forEach((line, i) => { if (re.test(line)) out.push(`${i + 1}: ${line.trim()}`); });
    return out;
}

console.log('\n== source invariants ==');

// WebKit never settles a refused resume(); awaiting it froze call setup entirely.
record('no bare `await ctx.resume()` anywhere',
    hits(/await\s+[\w.?]*\.resume\(\)/).length === 0,
    hits(/await\s+[\w.?]*\.resume\(\)/).join(' | '));

// The audio unlock must never gate the invite/accept path.
record('unlockVoicePlayback is never awaited by callers',
    hits(/await\s+this\.unlockVoicePlayback\(\)/).length === 0,
    hits(/await\s+this\.unlockVoicePlayback\(\)/).join(' | '));

// WKWebView also never settles HTMLMediaElement.play() — the element does start
// playing (paused:false), but the promise stays pending forever, so awaiting it
// stalls whatever asked. Measured by scripts/voice_doctor/engine (check 2).
record('no bare `await el.play()` anywhere',
    hits(/await\s+[\w.?\[\]]*\.play\(\)/).length === 0,
    hits(/await\s+[\w.?\[\]]*\.play\(\)/).join(' | '));

// Cross-engine tie-break: locale-sensitive comparison lets the two sides disagree.
{
    const bad = hits(/localeCompare/).filter(l => /shouldInitiate|isPolite|compareVoicePeerNames/.test(l));
    const inTieBreak = [];
    const fnStart = src.indexOf('shouldInitiateVoiceOffer(peer)');
    const fnEnd = src.indexOf('voiceEventPayload(payload');
    if (fnStart > -1 && fnEnd > fnStart && src.slice(fnStart, fnEnd).includes('localeCompare')) {
        inTieBreak.push('localeCompare inside the offer/polite tie-break');
    }
    record('voice peer tie-break does not use localeCompare',
        bad.length === 0 && inTieBreak.length === 0, [...bad, ...inTieBreak].join(' | '));
}

// An offer with no answer has no other watchdog: ICE never starts, so the
// connection-state recovery path never fires.
record('a sent offer arms an answer watchdog',
    src.includes('armVoiceAnswerWatchdog') && src.includes('clearVoiceAnswerWatchdog'),
    'armVoiceAnswerWatchdog/clearVoiceAnswerWatchdog must exist');

// Politeness must be derivable as the inverse; a shared helper is the only way
// the two ladders cannot drift apart silently.
{
    const politeStart = src.indexOf('isPoliteVoicePeer(peer)');
    const politeEnd = src.indexOf('voiceEventPayload(payload');
    const body = politeStart > -1 ? src.slice(politeStart, politeEnd) : '';
    record('isPoliteVoicePeer mirrors every rung of shouldInitiateVoiceOffer',
        body.includes('callTrack?.direction') && body.includes('voice.inviter') && body.includes('compareVoicePeerNames'),
        'polite ladder must consult direction, inviter and the shared comparator');
}

// …and EVERY local offer must arm it, not just the first one. An ICE restart and a
// mid-call renegotiation set a local offer too, and an unanswered one there is worse:
// it also blocks every later renegotiation for that peer (they queue on a return to
// 'stable' that can never come).
{
    const offers = hits(/setLocalDescription\(offer\)/);
    const arms = hits(/this\.armVoiceAnswerWatchdog\(/);
    record('every path that sets a local offer arms the answer watchdog',
        arms.length >= offers.length && offers.length >= 3,
        `setLocalDescription(offer)=${offers.length} armVoiceAnswerWatchdog=${arms.length}`);
}

// Guards that latch after an await do not guard anything: two passes both walk past
// them. This one adds the same track twice, which a real browser rejects with
// InvalidAccessError, aborting whatever was negotiating at the time.
{
    const start = src.indexOf('async attachLocalVoiceTracks(peer)');
    const end = src.indexOf('attachRemoteVoiceStream(peer, stream)');
    const body = start > -1 && end > start ? src.slice(start, end) : '';
    const latch = body.indexOf('localTracksAttached = true');
    const firstAwait = body.indexOf('await ');
    record('the local-track attach latch is taken before the first await',
        body !== '' && latch > -1 && (firstAwait === -1 || latch < firstAwait),
        `latch@${latch} firstAwait@${firstAwait}`);
}

// A failed ICE transport is revived by an ICE restart and by nothing else. If any
// offer path builds its own createOffer() the flag is lost exactly where it matters:
// the recovery offer re-agrees the media over the dead transport, negotiation
// completes, signalingState returns to 'stable', and the call carries nothing.
{
    // The helper is the one place allowed to touch createOffer directly.
    const helperStart = lines.findIndex(l => /createVoiceOfferFor\(entry\)\s*\{/.test(l));
    const helperEnd = helperStart > -1
        ? helperStart + lines.slice(helperStart).findIndex((l, i) => i > 0 && /^\s{4}\}/.test(l))
        : -1;
    const direct = [];
    lines.forEach((line, i) => {
        if (!/\.createOffer\(/.test(line)) return;
        if (helperStart > -1 && i >= helperStart && i <= helperEnd) return;
        direct.push(`${i + 1}: ${line.trim()}`);
    });
    record('offers are built through createVoiceOfferFor, which owns the iceRestart flag',
        helperStart > -1 && direct.length === 0,
        direct.length ? direct.join(' | ') : (helperStart > -1 ? '' : 'createVoiceOfferFor must exist'));
}

// 'failed' is terminal: onconnectionstatechange fires once on the way in and never
// again, so anything armed off that edge gets exactly one attempt — and the network
// coming back is not an edge at all. Recovery has to re-read the state on a timer.
record('a down link is supervised on a timer, not only on a state transition',
    /superviseVoiceLinks/.test(src) && /ensureVoiceLinkSupervisor/.test(src)
    && /stopVoiceLinkSupervisor/.test(src),
    'a failed peer must be re-examined periodically, not just when it fails');

// Autoplay policy refuses play() until a user gesture, and a call is not guaranteed
// to have had one on this device. Without a retry the sink stays paused for the whole
// call while RTP arrives and every WebRTC-level indicator says the call is healthy.
record('blocked remote playback is retried on a later user gesture',
    /ensureVoicePlaybackGestureHook/.test(src) && /releaseVoicePlaybackGestureHook/.test(src),
    'attachRemoteVoiceStream must install a gesture-driven playback retry');

// A latch released only in `finally` is a permanent outage if anything above it hangs.
record('call-setup latch has a staleness escape',
    src.includes('isVoiceCallSetupBusy'),
    'guards must go through isVoiceCallSetupBusy, not read callSetupInFlight directly');

// Remote audio must have a route even when the WebAudio graph is not running.
// Remote audio must not depend on a WebAudio graph: that path had no fallback
// when it was running yet silent, and no detection either.
// Accepts the deafen-derived form as well as a literal `false`. The original regex
// demanded `audio.muted = false` verbatim and started failing when the sink learned
// to honour deafen (`audio.muted = !!this.voice.deafened`) — which is what the check
// is actually protecting, only more correct: unmuted for every normal call, muted
// only when the user explicitly asked for silence. What must never come back is a
// sink created unconditionally muted, so that is what is asserted.
record('the <audio> element is the playback sink, never created muted',
    /audio\.muted = (?:false|!!this\.voice\.deafened)\b/.test(src) && !/audio\.muted = true/.test(src),
    'attachRemoteVoiceStream must create the element unmuted (or deafen-derived)');
record('no WebAudio graph is wired to the speakers for remote audio',
    !/remotePlaybackNodes|ensureVoiceMasterGain/.test(src),
    'playback must not go through gain -> destination');
record('a connected call reports whether RTP arrives and whether the sink plays',
    /reportVoiceAudioHealth/.test(src),
    'audio-health diagnostics must run on connected peers');

// ...and that it is REACHABLE, which the rule above cannot tell. The health sampler
// existed for a long time behind `if (!entry.statsTimer)` on the connected path,
// while the entry was created with a plain stats timer that the healthy path never
// cleared — so the guard was always false and the sampler only ever started on a
// link that had already failed once. One owner for that timer, no conditional arming.
record('the health sampler is armed through one owner, not behind a timer-exists guard',
    /ensureVoicePeerStatsTimer/.test(src) && !/if\s*\(!entry\.statsTimer\)/.test(src),
    'arm sampling via ensureVoicePeerStatsTimer(peer, entry, ms)');

// Mesh: every camera is encoded and uploaded once per peer. Unconstrained, four
// peers ask a consumer uplink for 4-10 Mbit/s and the audio sharing that uplink is
// what breaks first.
record('video and screen senders are bitrate-limited, not just audio',
    /applyVoiceVideoBitrateLimit/.test(src) && /voiceVideoBudget/.test(src),
    'video senders must get a maxBitrate divided by the roster');

// The offer branch opens the microphone and answers with a sendrecv session. Doing
// that before the user accepted means the caller hears them before they pick up.
record('no signal is negotiated while the invite is still ringing',
    /signal-before-accept-refused/.test(src),
    "applyVoiceSignal must refuse everything while voice.status === 'incoming'");

// Signals are addressed by username and the server delivers them to every
// connection of that account, so an account's other device receives offers meant
// for the device that answered — and used to answer them too.
record('a client with no room of its own does not negotiate someone else\'s call',
    /signal-outside-call-refused/.test(src),
    'applyVoiceSignal must refuse signals when voice.roomId is empty');

// A call whose links have all given up used to stay on screen as «В эфире» forever.
record('an unrecoverable call reaches a terminal state on its own',
    /concludeDeadVoiceCallIfNeeded/.test(src) && /concludeVanishedVoiceRoom/.test(src),
    'exhausted links and a vanished room must both end the call');

console.log(`\n${failures === 0 ? 'OK' : 'FAILURES: ' + failures}\n`);
process.exit(failures === 0 ? 0 : 1);
