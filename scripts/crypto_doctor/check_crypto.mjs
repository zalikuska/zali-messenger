// Primitive-level checks on the shipping crypto helpers, against Node's real
// WebCrypto. These are the properties the key-sync layer assumes and never
// re-verifies: an envelope only opens on its own device, tampering is detected,
// the registry fingerprint is not the key, and scope folding is stable.
import { SimBackend } from './lib/sim_backend.mjs';
import { Device } from './lib/device.mjs';

let failures = 0;
let count = 0;
function record(name, ok, detail = '') {
    count += 1;
    if (!ok) failures += 1;
    process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}
async function threw(fn) {
    try { await fn(); return null; } catch (e) { return e; }
}

const backend = new SimBackend();
const alice = new Device('alice', backend);
const bob1 = new Device('bob', backend, { label: 'b1' });
const bob2 = new Device('bob', backend, { label: 'b2' });
await alice.register(); await bob1.register(); await bob2.register();

const scope = 'dm:alice:bob';
const secret = 'S3cretConversationKey-000000000000000000000';

console.log('\n== conversation key envelopes ==');
{
    const bobDevice = [...backend.user('bob').devices.values()].find(d => d.deviceId === bob1.deviceId);
    const sealed = await alice.api.encryptConversationKeyEnvelope({
        scope, key: secret, recipientDevice: bobDevice, peer: 'bob',
    });

    const opened = await bob1.api.decryptConversationKeyEnvelope(sealed);
    record('an envelope round-trips to its recipient device',
        opened.key === secret && opened.scope === scope && opened.sender === 'alice',
        `sender=${opened.sender} scope=${opened.scope}`);

    record('the sealed envelope does not contain the key in the clear',
        !sealed.includes(secret));

    const wrongDevice = await threw(() => bob2.api.decryptConversationKeyEnvelope(sealed));
    record('another device of the same account cannot open it',
        !!wrongDevice, wrongDevice ? `rejected: ${wrongDevice.message}` : 'DECRYPTED — envelope is not device-bound');

    const alien = await threw(() => alice.api.decryptConversationKeyEnvelope(sealed));
    record('the sender cannot open its own envelope to someone else',
        !!alien, alien ? `rejected: ${alien.message}` : 'DECRYPTED');

    // Flip one base64 character of the ciphertext.
    const parsed = JSON.parse(sealed);
    const ct = parsed.ciphertext;
    const flipped = ct.slice(0, 4) + (ct[4] === 'A' ? 'B' : 'A') + ct.slice(5);
    const tampered = await threw(() => bob1.api.decryptConversationKeyEnvelope(
        JSON.stringify({ ...parsed, ciphertext: flipped })));
    record('tampered ciphertext is rejected (AEAD)', !!tampered,
        tampered ? `rejected: ${tampered.name}` : 'ACCEPTED — no integrity protection');

    const wrongVersion = await threw(() => bob1.api.decryptConversationKeyEnvelope(
        JSON.stringify({ ...parsed, version: 1 })));
    record('an envelope with an unexpected version is rejected', !!wrongVersion);

    const rebound = await threw(() => bob1.api.decryptConversationKeyEnvelope(
        JSON.stringify({ ...parsed, recipientDeviceId: bob2.deviceId })));
    record('rewriting recipientDeviceId does not make it open elsewhere', !!rebound);
}

console.log('\n== registry fingerprints ==');
{
    const id1 = await alice.api.conversationKeyId(secret);
    const id2 = await bob1.api.conversationKeyId(secret);
    const other = await alice.api.conversationKeyId(secret + 'x');
    record('the same key yields the same id on different devices', id1 === id2, id1.slice(0, 12));
    record('different keys yield different ids', id1 !== other);
    record('the id does not reveal the key', !id1.includes(secret) && id1.length >= 32,
        `len=${id1.length}`);
    record('the id is url-safe base64 (it travels in query strings)',
        /^[A-Za-z0-9_-]+$/.test(id1), id1);
}

console.log('\n== scope canonicalisation ==');
{
    const fold = (s) => alice.api.canonicalConversationScope(s);
    record('participant order does not matter', fold('dm:bob:alice') === fold('dm:alice:bob'),
        `${fold('dm:bob:alice')} vs ${fold('dm:alice:bob')}`);
    record('casing does not matter', fold('dm:Alice:BOB') === fold('dm:alice:bob'));
    record('folding is idempotent', fold(fold('dm:BOB:alice')) === fold('dm:BOB:alice'));
    record('channel scopes are left intact',
        fold('server:S1:C1') === 'server:S1:C1', fold('server:S1:C1'));
    record('the client folds scopes exactly like the server',
        fold('dm:Alice:BOB') === backend.canonicalScope('dm:Alice:BOB'),
        `client=${fold('dm:Alice:BOB')} server=${backend.canonicalScope('dm:Alice:BOB')}`);
}

console.log('\n== generated key material ==');
{
    const keys = new Set();
    for (let i = 0; i < 200; i++) {
        keys.add(alice.api.randomBase64(32).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''));
    }
    record('200 generated keys are all distinct', keys.size === 200, `distinct=${keys.size}`);
    const sample = [...keys][0];
    record('a generated key carries 32 bytes of entropy', sample.length >= 42, `len=${sample.length}`);

    // No Math.random fallback: without a CSPRNG the client must refuse, not guess.
    const saved = alice.sandbox.window.crypto;
    alice.sandbox.window.crypto = { subtle: saved.subtle };
    const noRng = await threw(() => alice.api.randomBase64(32));
    alice.sandbox.window.crypto = saved;
    record('key generation refuses to run without a CSPRNG', !!noRng,
        noRng ? `threw: ${noRng.message}` : 'RETURNED A KEY — Math.random fallback?');
}

console.log('\n== vault packages ==');
{
    const payload = { kind: 'zali-account-vault-bootstrap', conversationKeys: { [scope]: secret } };
    const packed = await alice.api.encryptVaultPackage(payload, 'correct horse battery staple');
    record('a vault package does not contain the key in the clear', !packed.includes(secret));

    const opened = await alice.api.decryptVaultPackage(packed, 'correct horse battery staple');
    record('a vault package round-trips', opened?.conversationKeys?.[scope] === secret);

    const wrongPass = await threw(() => alice.api.decryptVaultPackage(packed, 'wrong passphrase'));
    record('a wrong passphrase cannot open the vault', !!wrongPass);

    // The KDF parameters must come from the code, never from the attacker-supplied
    // envelope — otherwise a forged package could ask for 1 PBKDF2 iteration.
    const encoded = packed.startsWith('zali-vault:') ? packed.slice('zali-vault:'.length) : packed;
    const inner = JSON.parse(new TextDecoder().decode(alice.api.bytesFromBase64(encoded)));
    record('the package declares the hardened KDF',
        inner.kdf === 'PBKDF2-SHA256' && inner.iterations >= 100000 && inner.aead === 'AES-256-GCM',
        `kdf=${inner.kdf} iterations=${inner.iterations} aead=${inner.aead}`);

    // The safe design is that the declared parameters are decoration: derivation
    // uses the constant in the code. So a package claiming iterations=1 must still
    // open normally — proving the attacker-supplied number never reached the KDF.
    // (If it were honoured, this would open only with a 1-iteration derivation and
    // the package would have become trivially crackable.)
    const downgraded = 'zali-vault:' + alice.api.base64FromBytes(
        new TextEncoder().encode(JSON.stringify({ ...inner, iterations: 1 })));
    const downgradeError = await threw(() => alice.api.decryptVaultPackage(downgraded, 'correct horse battery staple'));
    record('KDF parameters come from the code, not from the package',
        !downgradeError,
        downgradeError ? `declared iterations reached the KDF: ${downgradeError.message}` : '');
}

console.log(`\n${failures === 0 ? 'OK' : 'FAILURES: ' + failures} (${count} checks)\n`);
process.exit(failures === 0 ? 0 : 1);
