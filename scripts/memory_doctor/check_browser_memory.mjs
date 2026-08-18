// Retention checks for the browser/PWA client.
//
// The invariant is not "memory is small" but:
//
//   > re-syncing a conversation must cost memory proportional to the conversation,
//   > not to the number of syncs
//
// Everything below runs the real interface.js. A failure here is a failure in
// production code.
import { BrowserTab, makeHistory } from './lib/browser_client.mjs';

let failures = 0;
let checks = 0;

function pass(name, detail = '') {
    checks += 1;
    console.log(`  [PASS] ${name}${detail ? ` — ${detail}` : ''}`);
}

function fail(name, detail = '') {
    checks += 1;
    failures += 1;
    console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`);
}

function check(name, condition, detail = '') {
    if (condition) pass(name, detail); else fail(name, detail);
}

const MB = 1024 * 1024;
const fmt = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

async function main() {
    console.log('\n──────── browser client: retention across repeated syncs\n');

    // 20 messages x 256 KB ≈ 5 MB of attachments — a modest photo conversation.
    const history = makeHistory({ me: 'alice', peer: 'bob', count: 20, attachmentBytes: 256 * 1024 });
    const tab = new BrowserTab({ me: 'alice', peer: 'bob', history });

    await tab.syncHistory();
    const afterFirst = {
        live: tab.tracker.liveCount,
        bytes: tab.tracker.liveBytes(),
        downloads: tab.downloads,
    };
    console.log(`  first sync: ${afterFirst.live} live object URLs, ${fmt(afterFirst.bytes)}, ${afterFirst.downloads} downloads`);

    // Ten more syncs. In production these come from refreshAfterKey (one per
    // key_envelope_available push), syncActiveConversation, and every reconnect —
    // a real session does far more than ten.
    const SYNCS = 10;
    for (let i = 0; i < SYNCS; i += 1) await tab.syncHistory();

    const afterMany = {
        live: tab.tracker.liveCount,
        bytes: tab.tracker.liveBytes(),
        downloads: tab.downloads,
    };
    console.log(`  after ${SYNCS} more syncs: ${afterMany.live} live object URLs, ${fmt(afterMany.bytes)}, ${afterMany.downloads} downloads\n`);

    check(
        'repeated syncs do not grow the live object-URL set',
        afterMany.live <= history.length,
        `${afterMany.live} live for ${history.length} messages (would be ${history.length * (SYNCS + 1)} if every sync leaked)`,
    );

    check(
        'retained attachment bytes stay proportional to the conversation',
        afterMany.bytes <= afterFirst.bytes,
        `${fmt(afterMany.bytes)} retained vs ${fmt(afterFirst.bytes)} of actual attachments`,
    );

    check(
        're-syncing does not re-download archives it already holds',
        afterMany.downloads <= history.length,
        `${afterMany.downloads} downloads for ${history.length} messages over ${SYNCS + 1} syncs`,
    );

    check(
        'every message still arrived',
        tab.received.length >= history.length,
        `${tab.received.length} delivered for ${history.length} rows`,
    );

    // The dedupe guard must not turn into "stops receiving". A live WS push of a
    // message id never seen before still has to be decoded and delivered, and a
    // later history sync that includes it must not deliver it a second time.
    const deliveredBefore = tab.received.length;
    const fresh = {
        id: 'msg-live-1',
        clientId: 'client-live-1',
        sender: 'bob',
        receiver: 'alice',
        timestamp: 1_700_001_000,
        attachmentBytes: 128 * 1024,
    };
    tab.history.push(fresh);
    await tab.api.handleIncomingBrowserMessage(fresh);

    check(
        'a new message arriving after many syncs is still delivered',
        tab.received.length === deliveredBefore + 1,
        `${tab.received.length - deliveredBefore} delivered`,
    );

    await tab.syncHistory();
    check(
        'the following history sync does not deliver it twice',
        tab.received.length === deliveredBefore + 1,
        `${tab.received.length - deliveredBefore} total deliveries for the new message`,
    );

    console.log('');
    if (failures) {
        console.log(`FAILED (${failures} of ${checks} checks)\n`);
        process.exit(1);
    }
    console.log(`OK (${checks} checks)\n`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
