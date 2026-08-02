// Source-level guards for the key-sync failure shapes. Each rule marks a pattern
// that has already produced unreadable messages in this project.
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from '../voice_doctor/lib/load_interface.mjs';

const raw = fs.readFileSync(path.join(REPO_ROOT, 'web/src/interface.js'), 'utf8');
// Only whole-line comments are dropped: the reasoning lives in comments and would
// otherwise trip every rule that names the pattern it forbids.
const src = raw.split('\n').map(l => (l.trim().startsWith('//') ? '' : l)).join('\n');
const lines = src.split('\n');

let failures = 0;
function record(name, ok, detail = '') {
    if (!ok) failures += 1;
    process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}
const hits = (re) => lines
    .map((line, i) => ({ line: line.trim(), n: i + 1 }))
    .filter(({ line }) => re.test(line));

console.log('\n== source invariants ==');

// Demoting the active key by hand drops it: addAltConversationKey refuses a key
// that is still stored[scope], which is exactly what it is at that moment.
{
    // setActiveConversationKey's own body is the sanctioned implementation of this
    // pattern — it is the one place allowed to do it, so exclude its range.
    const helperStart = src.indexOf('setActiveConversationKey(stored, scope, nextKey)');
    const helperEnd = helperStart > -1 ? src.indexOf('\n    }', helperStart) : -1;
    const helperLines = helperStart > -1
        ? [src.slice(0, helperStart).split('\n').length, src.slice(0, helperEnd).split('\n').length + 1]
        : [-1, -1];
    const bad = [];
    for (let i = 0; i < lines.length - 2; i++) {
        const lineNo = i + 1;
        if (lineNo >= helperLines[0] && lineNo <= helperLines[1]) continue;
        const window = lines.slice(i, i + 3).map(l => l.trim()).join(' ');
        if (/addAltConversationKey\(stored,\s*scope[d]?,\s*(current|active)\)/.test(window)
            && /stored\[scope[d]?\]\s*=/.test(window)) {
            bad.push(`${lineNo}: ${window.slice(0, 110)}`);
        }
    }
    record('key adoption goes through setActiveConversationKey, not a hand-rolled demote',
        bad.length === 0, bad.join(' | '));
}

record('setActiveConversationKey exists and preserves the outgoing key',
    /setActiveConversationKey\(stored, scope/.test(src) || /setActiveConversationKey\(/.test(src),
    'the single place that swaps the active key');

// The retry sweep and the republish answer must both offer the historical keys —
// the requester already has the active one; the messages it cannot read are the
// ones under a demoted key.
record('the republish answer offers every candidate, not just the active key',
    /handleKeyRepublishRequest[\s\S]{0,900}?conversationKeyCandidates/.test(src),
    'handleKeyRepublishRequest must use conversationKeyCandidates');
// The opposite of the rule that used to be here. Publishing every historical key
// from the periodic sweep is correct but unaffordable: it is one devices lookup
// plus an envelope POST per device for EVERY (scope, key), all serialized through
// the API slot pool. Shipped in 0.2b17/0.2b18, it turned login into a request storm
// and history never loaded. Historical keys belong to the targeted republish path.
{
    const start = src.indexOf('async retryPublishConversationKeys(');
    const end = start > -1 ? src.indexOf('\n    async ', start + 10) : -1;
    const body = start > -1 ? src.slice(start, end > -1 ? end : start + 3000) : '';
    record('the periodic sweep publishes the active key only',
        !!body && !/conversationKeyCandidates/.test(body),
        'retryPublishConversationKeys must not fan out over every candidate');
}

// A failed lookup must never be read as "no canonical key exists".
record('a failed canonical lookup returns the cache, never an empty answer',
    /fetchCanonicalKeyIds[\s\S]{0,1400}?catch[\s\S]{0,200}?return this\.canonicalKeyIdCache\(\)/.test(src));

// A decrypt failure has to trigger recovery, not just telemetry.
// Requiring the definition to exist is not enough — deleting just the call site
// leaves the helper in place and the recovery dead. Assert the call happens
// inside reportDecryptFailure.
{
    // The window must stop at the END of reportDecryptFailure. A fixed-size slice
    // ran past it into the definition of requestKeyRepublishForDecryptFailure
    // itself, so the rule matched the helper it was checking for a call to and
    // passed even with the call site deleted.
    const start = src.indexOf('async reportDecryptFailure(');
    const nextMethod = start > -1 ? src.indexOf('\n    async ', start + 10) : -1;
    const body = start > -1 ? src.slice(start, nextMethod > -1 ? nextMethod : start + 4000) : '';
    record('a decrypt failure asks the holders to republish',
        /requestKeyRepublishForDecryptFailure\s*\(/.test(body),
        'reportDecryptFailure must call requestKeyRepublishForDecryptFailure');
}

// Envelopes must stay device-bound and sender-checked.
record('envelope decryption verifies the recipient device',
    /decryptConversationKeyEnvelope[\s\S]{0,800}?recipientDeviceId[\s\S]{0,200}?identity\.deviceId/.test(src));

// No weak randomness anywhere near key material.
// Word-boundary matching on purpose: a substring rule flagged `native-` for
// containing "iv" and reported a request-id generator as a nonce.
{
    const cryptoish = /\b(key|keys|nonce|iv|salt|secret|passphrase|entropy)\b/i;
    const bad = hits(/Math\.random\(\)/).filter(({ line }) => cryptoish.test(line));
    record('no Math.random in key, nonce or salt generation', bad.length === 0,
        bad.map(h => `${h.n}: ${h.line}`).join(' | '));
}

// Concurrent read-modify-write over the key store must be serialized.
record('the key store is written under the write lock',
    /withConversationKeysWriteLock/.test(src)
    && /promoteCanonicalConversationKey[\s\S]{0,400}?withConversationKeysWriteLock/.test(src));

// The registry must only ever see a fingerprint.
{
    const claim = src.slice(src.indexOf('async claimConversationKey('), src.indexOf('async requestKeyRepublish('));
    record('the claim request sends a key id, never the key',
        /keyId/.test(claim) && !/body: JSON\.stringify\(\{[^}]*key:/.test(claim),
        'claimConversationKey body must contain keyId only');
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILURES: ' + failures}\n`);
process.exit(failures === 0 ? 0 : 1);
