// Source-level guards for the failure shapes that the runtime checks cannot see
// once they are fixed — every one of these has already shipped as a silent call.
//
// These are intentionally blunt string/regex rules over web/src/interface.js. A
// rule firing is not automatically a bug, but it means someone reintroduced a
// pattern that cost this project a broken call before, and the comment says which.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './lib/load_interface.mjs';

const raw = fs.readFileSync(path.join(REPO_ROOT, 'web/src/interface.js'), 'utf8');
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

// A latch released only in `finally` is a permanent outage if anything above it hangs.
record('call-setup latch has a staleness escape',
    src.includes('isVoiceCallSetupBusy'),
    'guards must go through isVoiceCallSetupBusy, not read callSetupInFlight directly');

// Remote audio must have a route even when the WebAudio graph is not running.
// Remote audio must not depend on a WebAudio graph: that path had no fallback
// when it was running yet silent, and no detection either.
record('the <audio> element is the playback sink, never created muted',
    /audio\.muted = false/.test(src) && !/audio\.muted = true/.test(src),
    'attachRemoteVoiceStream must create the element unmuted');
record('no WebAudio graph is wired to the speakers for remote audio',
    !/remotePlaybackNodes|ensureVoiceMasterGain/.test(src),
    'playback must not go through gain -> destination');
record('a connected call reports whether RTP arrives and whether the sink plays',
    /reportVoiceAudioHealth/.test(src),
    'audio-health diagnostics must run on connected peers');

console.log(`\n${failures === 0 ? 'OK' : 'FAILURES: ' + failures}\n`);
process.exit(failures === 0 ? 0 : 1);
