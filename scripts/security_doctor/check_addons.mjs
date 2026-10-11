// Addon sandbox invariants (hub addons, .zali files with the ZALIEXTN magic).
//
// An addon is someone else's code running inside the messenger. What keeps it
// away from the session token, the conversation keys and the native bridge is:
//   1. the file is parsed strictly before anything is shown or stored — paths
//      cannot escape the addon's folder, permissions are a closed list;
//   2. it runs in an opaque-origin <iframe sandbox> without allow-same-origin,
//      with its own CSP, and talks to the app only through checked postMessage;
//   3. the shells keep the native bridge away from child frames (pinned in
//      check_native_shells.mjs, "Frame isolation").
// (1) is exercised here against the real module; (2) is pinned statically.

import { readFileSync, readdirSync, mkdtempSync, rmSync, cpSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { record, section, finish, read, stripLineComments } from './lib/report.mjs';

const FORMAT_PATH = 'web/src/modules/addon_format.js';
const RUNTIME_PATH = 'web/src/interface/addons_runtime.js';

function loadSdkSource() {
    const sandbox = { window: {} };
    vm.createContext(sandbox);
    vm.runInContext(readFileSync('web/src/modules/addon_sdk.js', 'utf8'), sandbox, { filename: 'web/src/modules/addon_sdk.js' });
    return sandbox.window.ZaliAddonSdk.source();
}

function loadFormat() {
    const sandbox = { window: {}, TextEncoder, TextDecoder, crypto: webcrypto, atob, btoa };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(readFileSync(FORMAT_PATH, 'utf8'), sandbox, { filename: FORMAT_PATH });
    return sandbox.window.ZaliAddonFormat;
}

const F = loadFormat();
const enc = new TextEncoder();

const manifest = (extra = {}) => JSON.stringify({
    zaliAddon: 1,
    id: 'org.example.test',
    name: 'Тест',
    version: '1.0.0',
    entry: 'index.html',
    ...extra,
});

const baseEntries = (extra = {}) => [
    ['manifest.json', manifest(extra)],
    ['index.html', '<!doctype html><p>hi</p>'],
];

async function rejects(fn) {
    try {
        await fn();
        return '';
    } catch (error) {
        return error?.name === 'AddonFormatError' ? 'ok' : `wrong error: ${error?.message || error}`;
    }
}

async function expectReject(name, fn) {
    const result = await rejects(fn);
    record(name, result === 'ok', result === '' ? 'was accepted' : result === 'ok' ? '' : result);
}

section('format: round trip');
{
    const bytes = F.build(baseEntries({ permissions: ['cache', 'notifications'] }), { id: 'org.example.test' });
    const info = await F.inspect(bytes);
    record('a built file inspects back', info.manifest.id === 'org.example.test' && info.files.size === 2);
    record('magic is ZALIEXTN', new TextDecoder().decode(bytes.subarray(0, 8)) === 'ZALIEXTN');
    record('sha-256 fingerprint is computed', /^[0-9a-f]{64}$/.test(info.sha256));
    record('permissions keep catalog order', info.manifest.permissions.join(',') === 'cache,notifications');
}

section('format: hostile containers are refused');
{
    const good = F.build(baseEntries());
    await expectReject('wrong magic', () => {
        const copy = good.slice();
        copy.set(enc.encode('ZALIARCH'), 0);
        return F.inspect(copy);
    });
    await expectReject('encrypted flag', () => {
        const copy = good.slice();
        // magic 8, version 1, id len 1 (+0), dom len 1 + "addon"
        copy[8 + 1 + 1 + 1 + 5] = 1;
        return F.inspect(copy);
    });
    await expectReject('truncated file', () => F.inspect(good.subarray(0, good.length - 3)));
    await expectReject('trailing garbage', () => {
        const copy = new Uint8Array(good.length + 1);
        copy.set(good);
        return F.inspect(copy);
    });
    await expectReject('entry size with a non-zero high half (u64 > 4 GiB)', () => {
        const copy = good.slice();
        const view = new DataView(copy.buffer);
        // first entry: header(8+1+1+0+1+5+1+4) + nameLen(2) + "manifest.json"(13) + size lo(4) → hi
        view.setUint32(8 + 1 + 1 + 0 + 1 + 5 + 1 + 4 + 2 + 13 + 4, 1, true);
        return F.inspect(copy);
    });
    await expectReject('more entries declared than present', () => {
        const copy = good.slice();
        new DataView(copy.buffer).setUint32(8 + 1 + 1 + 0 + 1 + 5 + 1, 3, true);
        return F.inspect(copy);
    });
    for (const bad of ['../evil.js', 'a/../../evil', '/etc/passwd', 'a//b', 'a\\b', 'C:x', 'dir/', '.', 'name with space']) {
        record(`path «${bad}» is refused`, F.pathError(bad) !== '');
    }
    record('a nested path is fine', F.pathError('assets/img/logo.png') === '');
    await expectReject('a path that escapes the folder cannot be smuggled in (raw container)', () => {
        // build() refuses it, so write the entry by hand.
        const name = enc.encode('../x');
        const head = F.build(baseEntries());
        const count = new DataView(head.buffer).getUint32(17, true);
        const extra = new Uint8Array(2 + name.length + 16 + 1);
        const v = new DataView(extra.buffer);
        v.setUint16(0, name.length, true);
        extra.set(name, 2);
        v.setUint32(2 + name.length, 1, true);
        v.setUint32(2 + name.length + 8, 1, true);
        const out = new Uint8Array(head.length + extra.length);
        out.set(head);
        out.set(extra, head.length);
        new DataView(out.buffer).setUint32(17, count + 1, true);
        return F.inspect(out);
    });
    await expectReject('duplicate names differing only in case', () => F.inspect(F.build([
        ...baseEntries(), ['Index.html', 'x'],
    ])));
}

section('format: manifest is a closed contract');
{
    await expectReject('missing manifest', () => F.inspect(F.build([['index.html', 'x']])));
    await expectReject('unknown permission', () => F.inspect(F.build(baseEntries({ permissions: ['everything'] }))));
    await expectReject('network hosts without the network permission', () => F.inspect(F.build(baseEntries({ network: ['example.com'] }))));
    await expectReject('network permission without hosts', () => F.inspect(F.build(baseEntries({ permissions: ['network'] }))));
    await expectReject('a network "host" carrying a scheme or path', () => F.inspect(F.build(baseEntries({ permissions: ['network'], network: ['https://example.com/x'] }))));
    await expectReject('process permission without a backend', () => F.inspect(F.build(baseEntries({ permissions: ['process'] }))));
    await expectReject('backend without the process permission', () => F.inspect(F.build([
        ...baseEntries({ backend: { type: 'process', commands: { 'windows-x64': 'bin/a.exe' } } }),
        ['bin/a.exe', 'MZ'],
    ])));
    await expectReject('backend command that is not in the file', () => F.inspect(F.build(baseEntries({
        permissions: ['process'], backend: { type: 'process', commands: { 'windows-x64': 'bin/missing.exe' } },
    }))));
    await expectReject('entry that is not html', () => F.inspect(F.build([
        ['manifest.json', manifest({ entry: 'main.js' })], ['main.js', 'x'],
    ])));
    await expectReject('id with path characters', () => F.inspect(F.build(baseEntries({ id: '../x' }))));
    const elevated = Object.keys(F.PERMISSIONS).filter(key => F.isElevated(key)).sort().join(',');
    record('elevated permissions are exactly fs.read, fs.write, launch, network.any, process', elevated === 'fs.read,fs.write,launch,network.any,process', elevated);
    // network.any needs no host list; plain «network» still must name its hosts.
    record('network.any needs no host list',
        !(await rejects(() => F.inspect(F.build(baseEntries({ permissions: ['network.any'] }))))));
    record('network without hosts is still refused',
        !!(await rejects(() => F.inspect(F.build(baseEntries({ permissions: ['network'] }))))));
}

section('sandbox (web/src/interface/addons_runtime.js)');
{
    const src = stripLineComments(read(RUNTIME_PATH));
    const sandboxAttr = /setAttribute\('sandbox', '([^']*)'\)/.exec(src)?.[1] ?? null;
    record('the frame is sandboxed', sandboxAttr !== null);
    record('sandbox grants only scripts and pointer lock',
        sandboxAttr === 'allow-scripts allow-pointer-lock',
        `got "${sandboxAttr}" — allow-same-origin would hand the frame the app's origin, storage and bridge`);
    record('no feature is delegated to the frame', /setAttribute\('allow', ''\)/.test(src));
    record('the document comes from srcdoc, not a URL', /iframe\.srcdoc = this\.buildAddonDocument\(/.test(src) && !/iframe\.src =/.test(src));
    record('CSP starts from default-src \'none\'', /"default-src 'none'"/.test(src));
    record('CSP is the first thing in the document',
        /setAttribute\('http-equiv', 'Content-Security-Policy'\)/.test(src)
        && /doc\.head\.prepend\(csp,/.test(src)
        && /querySelectorAll\('base, meta\[http-equiv\]'\)[\s\S]{0,40}?\.remove\(\)/.test(src),
        'the addon\'s own <base>/<meta http-equiv> are dropped so it cannot loosen or redirect');
    record('RPC is accepted only from the addon\'s own frame',
        /addonInstanceBySource\(event\.source\)/.test(src)
        && /addonInstanceBySource\(source\) \{[\s\S]{0,300}?instance\.iframe\.contentWindow === source/.test(src));
    record('a frame that navigates away is torn down', /loadCount > 1[\s\S]{0,200}?failAddon/.test(src));
    record('launch is gated on bridge isolation', /launchAddon[\s\S]{0,600}?addonsSandboxAvailable\(\)/.test(src)
        && /addonsSandboxAvailable\(\) \{\s*return !this\.hasNativeBridge\(\) \|\| this\.nativeSupports\('addonFrames'\)/.test(src));
    record('every RPC method is checked against the addon\'s permissions', /dispatchAddonRpc[\s\S]{0,1200}?permissions\.includes/.test(src));
    record('ui.collapse touches only the caller, and only while expanded',
        /'ui\.collapse': \{ run: \(instance\) => \{ if \(instance\.expanded\) this\.collapseAddon\(\)/.test(src),
        'collapseAddon() collapses whichever addon is on screen — a background addon must not hide another');
    {
        // WebRTC is outside CSP; the SDK prefix must remove it before addon code runs.
        const sdk = loadSdkSource();
        const win = { RTCPeerConnection: function () {}, webkitRTCPeerConnection: function () {}, RTCDataChannel: function () {},
            addEventListener() {}, parent: { postMessage() {} } };
        const box = { window: win, TextEncoder, TextDecoder, Blob, URL, Object, Map, Set, Promise, Uint8Array, ArrayBuffer, setTimeout };
        win.window = win;
        vm.createContext(box);
        let ok = true;
        try { vm.runInContext(sdk, vm.createContext(Object.assign(win, box, { window: win })), { filename: 'addon_sdk' }); } catch (e) { ok = false; }
        record('WebRTC is removed from the sandbox before addon code runs',
            ok && win.RTCPeerConnection === undefined && win.webkitRTCPeerConnection === undefined && win.RTCDataChannel === undefined,
            'connect-src does not cover RTCPeerConnection; ICE/TURN credentials would exfiltrate data around the network permission');
    }
    record('the stored file is re-verified on every launch', /launchAddon[\s\S]{0,1500}?meta\.sha256 !== info\.sha256/.test(src));
}

section('permissions (web/src/interface/addons_permissions.js)');
{
    const src = stripLineComments(read('web/src/interface/addons_permissions.js'));
    const block = /addonRpcExtraMethods\(\) \{\s*return \{([\s\S]*?)\n        \};/.exec(src)?.[1] || '';
    const rows = block.split('\n').filter(line => /^\s*('[^']+'|[a-z]+):\s*\{/.test(line));
    const open = rows.filter(line => !/permission: '[a-z.]+'/.test(line));
    record('every extra RPC method names its permission', rows.length > 0 && open.length === 0,
        open.length ? `without one: ${open.map(l => l.trim().split(':')[0]).join(', ')}` : `${rows.length} methods`);
    record('user-visible actions need the addon on screen',
        /addonSaveFile[\s\S]{0,120}?addonRequireVisible/.test(src)
        && /addonMicStart[\s\S]{0,200}?addonRequireVisible/.test(src)
        && /addonClipboardWrite[\s\S]{0,300}?addonRequireVisible/.test(src));
    record('notifications carry the addon\'s name, not a chat sender', /const sender = `Аддон «\$\{instance\.manifest\.name\}»`/.test(src));
    record('the microphone is released when the addon stops',
        /addonStopRecorder\(instance\) \{[\s\S]{0,400}?getTracks\(\)\.forEach\(t => t\.stop\(\)\)/.test(src)
        && /stopAddon[\s\S]{0,300}?addonStopRecorder/.test(read(RUNTIME_PATH))
        && /failAddon[\s\S]{0,500}?addonStopRecorder/.test(read(RUNTIME_PATH)));
}

section('elevated permissions (native shells)');
{
    const rust = stripLineComments(read('apps/windows/src/native/addon_elevated.rs'));
    const swift = stripLineComments(read('apps/macos/Sources/ZaliMessenger/Services/AddonElevated.swift'));
    const rustStore = stripLineComments(read('apps/windows/src/native/addons.rs'));
    const swiftStore = stripLineComments(read('apps/macos/Sources/ZaliMessenger/Services/AddonStore.swift'));
    record('Windows: install of elevated permissions asks the user before writing',
        /fn store_put[\s\S]{0,1500}?confirm_install\([\s\S]{0,200}?write_atomic\(&dir\.join\("addon\.zali"\)/.test(rustStore));
    record('macOS: install of elevated permissions asks the user before writing',
        /confirmInstall\(archive[\s\S]{0,200}?writeAtomic\(data, to: dir\.appendingPathComponent\("addon\.zali"\)\)/.test(swiftStore));
    record('Windows: every launch re-checks the fingerprint and asks again',
        /fn session_start[\s\S]{0,2000}?sha256[\s\S]{0,400}?переустановите[\s\S]{0,600}?host\.confirm\(/.test(rust));
    record('macOS: every launch re-checks the fingerprint and asks again',
        /func sessionStart[\s\S]{0,1500}?== sha256[\s\S]{0,400}?переустановите[\s\S]{0,600}?confirm\(title:/.test(swift));
    const rustOps = (rust.match(/fn fs_op[\s\S]*?\n}\n/) || [''])[0];
    const unguarded = (rustOps.match(/"fs\.[a-z]+" => (?!with_session)/g) || []);
    record('Windows: every fs.* operation runs inside a session', rustOps.length > 0 && unguarded.length === 0, unguarded.join(', '));
    record('Windows: system.* and backend.* need their session permission',
        /fn system_op[\s\S]{0,120}?with_session\(payload, "launch"/.test(rust) && /fn backend_send[\s\S]{0,200}?with_session\(payload, "process"/.test(rust));
    const swiftCases = swift.split(/\n        case "/).slice(1).filter(c => /^(fs|system|backend)\./.test(c));
    const swiftOpen = swiftCases.filter(c => !/^\S+":\s*\n\s*(_ = )?(let s = )?try session\(dict, /.test(c)).map(c => c.split('"')[0]);
    record('macOS: every fs/system/backend operation runs inside a session', swiftCases.length >= 10 && swiftOpen.length === 0, swiftOpen.join(', '));
    record('the default button of the system dialog is the safe one',
        /MB_DEFBUTTON2/.test(read('apps/windows/src/native.rs')) && /addButton\(withTitle: "Отмена"\)\s*\n\s*alert\.addButton\(withTitle: action\)/.test(swift));
}

section('packer and example addons');
{
    // scripts/addon_pack.py повторяет проверки addon_format.js на Python:
    // всё, что он собрал, приложение должно принять, и с теми же разрешениями.
    const dir = mkdtempSync(join(tmpdir(), 'zali-addons-'));
    try {
        const examples = readdirSync('examples/addons', { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
        record('examples/addons has the three reference addons',
            ['snake', 'voice-notes', 'launcher'].every(name => examples.includes(name)), examples.join(', '));
        for (const name of examples) {
            const out = join(dir, `${name}.zali`);
            let packed = '';
            try {
                execFileSync('python3', ['scripts/addon_pack.py', `examples/addons/${name}`, out], { stdio: 'pipe' });
                packed = readFileSync(out);
            } catch (e) {
                record(`example ${name}: packs`, false, String(e.stderr || e.message).trim().slice(0, 200));
                continue;
            }
            let info = null;
            try {
                const { files } = F.parseContainer(packed);
                info = { files, manifest: F.parseManifest(files) };
            } catch (e) {
                record(`example ${name}: the app accepts the packed file`, false, e.message);
                continue;
            }
            const source = JSON.parse(readFileSync(`examples/addons/${name}/manifest.json`, 'utf8'));
            record(`example ${name}: packed by addon_pack.py, accepted by the app with the same permissions`,
                JSON.stringify(info.manifest.permissions) === JSON.stringify([...(source.permissions || [])].sort(
                    (a, b) => Object.keys(F.PERMISSIONS).indexOf(a) - Object.keys(F.PERMISSIONS).indexOf(b))));
        }
        // Обратное направление: упаковщик отвергает то, что отвергнет приложение.
        const bad = join(dir, 'bad');
        cpSync('examples/addons/snake', bad, { recursive: true });
        const m = JSON.parse(readFileSync(join(bad, 'manifest.json'), 'utf8'));
        m.permissions = ['fs.read', 'teleport'];
        writeFileSync(join(bad, 'manifest.json'), JSON.stringify(m));
        let refused = false;
        try { execFileSync('python3', ['scripts/addon_pack.py', bad, join(dir, 'bad.zali')], { stdio: 'pipe' }); } catch (e) { refused = e.status === 1; }
        record('addon_pack.py refuses an unknown permission', refused);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---- подписи и ZaliCoin аддонов ----------------------------------------------
//
// Аддон — чужой код, а ZaliCoin — деньги. Что стоит между ними:
//   1. подпись проверяется настоящим модулем на настоящей криптографии: любая
//      правка файла после подписания, чужой ключ или переставленная метка
//      («самоподпись» → «официальная») ломают её;
//   2. «официальной» считается только подпись ключом, зашитым в приложение и
//      в сервер, и тот же ключ в обоих местах и в инструменте на Python;
//   3. деньги доходят до аддона только если файл подписан И запись об авторе в
//      реестре сервера с подписью сходится — подпись в файле одна не пускает.

const subtle = webcrypto.subtle;
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

async function signedFile(bytes, { kind = 'self', owner = 'author', key, id, version, publicKey = null } = {}) {
    const { files, manifest: m } = (() => {
        const parsed = F.parseContainer(bytes);
        return { files: parsed.files, manifest: F.parseManifest(parsed.files) };
    })();
    const digest = await F.contentDigest(files);
    const signedAt = 1_700_000_000_000;
    const message = F.signatureMessage(kind, id ?? m.id, version ?? m.version, owner, digest, signedAt);
    const signature = new Uint8Array(await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, enc.encode(message)));
    const pub = publicKey ?? b64(new Uint8Array(await subtle.exportKey('raw', key.publicKey)));
    return {
        publicKey: pub,
        bytes: F.withSignature(bytes, {
            zaliSignature: 1, kind, alg: 'ES256', publicKey: pub,
            id: id ?? m.id, version: version ?? m.version, owner, digest, signedAt, signature: b64(signature),
        }),
    };
}

section('signatures: verified by the real module on real ECDSA');
{
    const serverKey = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const otherKey = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const plain = F.build(baseEntries({ permissions: ['coins'] }), { id: 'org.example.test' });
    const good = await signedFile(plain, { key: serverKey });
    const keys = { selfPublicKey: good.publicKey };

    const state = async (bytes, k = keys) => (await F.inspect(bytes, k)).signature.state;
    const reason = async (bytes, k = keys) => (await F.inspect(bytes, k)).signature.reason || '';

    record('an unsigned file is "none"', await state(plain) === 'none');
    const info = await F.inspect(good.bytes, keys);
    record('a file signed with the server key verifies as "self", with its author',
        info.signature.state === 'self' && info.signature.owner === 'author' && /^[0-9a-f]{64}$/.test(info.signature.fingerprint));
    record('without the server key a self-signature is only "unverified"', await state(good.bytes, {}) === 'unverified');
    record('a self-signature by another server\'s key is "unverified", never "self"',
        await state(good.bytes, { selfPublicKey: b64(new Uint8Array(await subtle.exportKey('raw', otherKey.publicKey))) }) === 'unverified');

    // Правка после подписания.
    const tamperedEntries = [...F.parseContainer(good.bytes).files].map(([name, data]) => [name, name === 'index.html' ? '<!doctype html><p>changed</p>' : data]);
    const tampered = F.build(tamperedEntries, { id: 'org.example.test' });
    record('editing a file after signing makes the signature "invalid"', await state(tampered) === 'invalid', await reason(tampered));
    const extraEntries = [...F.parseContainer(good.bytes).files, ['extra.js', enc.encode('x')]].map(([n, d]) => [n, d]);
    record('adding a file after signing makes it "invalid"', await state(F.build(extraEntries, { id: 'org.example.test' })) === 'invalid');

    // Подпись, перенесённая на другой аддон или версию.
    const moved = await signedFile(plain, { key: serverKey, id: 'org.example.other' });
    record('a signature issued for another addon id is "invalid"', await state(moved.bytes) === 'invalid', await reason(moved.bytes));
    const versioned = await signedFile(plain, { key: serverKey, version: '9.9.9' });
    record('a signature issued for another version is "invalid"', await state(versioned.bytes) === 'invalid', await reason(versioned.bytes));

    // Подмена вида подписи.
    const sigFile = JSON.parse(new TextDecoder().decode(F.parseContainer(good.bytes).files.get('zali-signature.json')));
    const flipped = F.withSignature(plain, { ...sigFile, kind: 'official' });
    record('relabelling a self-signature as official is "invalid"', await state(flipped) === 'invalid', await reason(flipped));
    const fakeOfficial = await signedFile(plain, { key: serverKey, kind: 'official' });
    record('an "official" signature made with any other key is "invalid"',
        await state(fakeOfficial.bytes) === 'invalid', await reason(fakeOfficial.bytes));
    record('a signature that claims the official public key but is signed by another is "invalid"',
        await state((await signedFile(plain, { key: serverKey, kind: 'official', publicKey: F.OFFICIAL_PUBLIC_KEY })).bytes) === 'invalid');

    // Мусор в файле подписи не роняет разбор.
    const junk = F.build([...F.parseContainer(plain).files, ['zali-signature.json', enc.encode('{nope')]].map(([n, d]) => [n, d]), { id: 'org.example.test' });
    record('a corrupt signature file is "invalid", not an exception', await state(junk) === 'invalid');
    const bare = F.build([...F.parseContainer(plain).files, ['zali-signature.json', enc.encode('{"zaliSignature":1}')]].map(([n, d]) => [n, d]), { id: 'org.example.test' });
    record('a signature missing its fields is "invalid"', await state(bare) === 'invalid');

    // Отпечаток не зависит от самой подписи — иначе её нельзя было бы проверить.
    const a = await F.contentDigest(F.parseContainer(plain).files);
    const b = await F.contentDigest(F.parseContainer(good.bytes).files);
    record('the content digest ignores the signature file', a === b);
    const resigned = F.withSignature(good.bytes, sigFile);
    record('re-signing replaces the old signature instead of stacking another',
        [...F.parseContainer(resigned).files.keys()].filter(n => n === 'zali-signature.json').length === 1);
}

section('signatures: same bytes in the app, the server tool and the Python tool');
{
    const dir = mkdtempSync(join(tmpdir(), 'zali-sign-'));
    try {
        const plain = F.build(baseEntries({ permissions: ['coins'] }), { id: 'org.example.test' });
        const file = join(dir, 'a.zali');
        writeFileSync(file, plain);
        const jsDigest = await F.contentDigest(F.parseContainer(plain).files);
        let pyDigest = '';
        try {
            pyDigest = execFileSync('python3', ['-I', 'scripts/addon_sign.py', 'digest', file], { stdio: 'pipe' }).toString().trim();
        } catch (e) {
            record('addon_sign.py digest runs', false, String(e.stderr || e.message).trim().slice(0, 200));
        }
        record('addon_sign.py computes the same content digest as the app', pyDigest === jsDigest, `${pyDigest.slice(0, 16)} vs ${jsDigest.slice(0, 16)}`);

        const serverKey = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
        const signed = await signedFile(plain, { key: serverKey });
        const signedPath = join(dir, 'signed.zali');
        writeFileSync(signedPath, signed.bytes);
        let pyState = '';
        try {
            pyState = execFileSync('python3', ['-I', 'scripts/addon_sign.py', 'verify', signedPath, '--self-key', signed.publicKey], { stdio: 'pipe' }).toString();
        } catch (e) {
            pyState = String(e.stdout || '') + String(e.stderr || '');
        }
        record('addon_sign.py verifies a signature the app made', /подпись — self/.test(pyState), pyState.trim().split('\n')[0]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }

    const serverSrc = read('server/src/addons.rs');
    const pySrc = read('scripts/addon_sign.py');
    const pyKey = (pySrc.match(/OFFICIAL_PUBLIC_KEY = "([^"]+)"/) || [])[1];
    const rsKey = (serverSrc.match(/OFFICIAL_PUBLIC_KEY_B64: &str =\s*"([^"]+)"/) || [])[1];
    record('the official public key is the same in the app, the server and the Python tool',
        !!rsKey && F.OFFICIAL_PUBLIC_KEY === rsKey && F.OFFICIAL_PUBLIC_KEY === pyKey, `${F.OFFICIAL_PUBLIC_KEY.slice(0, 12)}… / ${String(rsKey).slice(0, 12)}… / ${String(pyKey).slice(0, 12)}…`);
    record('addon_sign.py can only make official signatures (self ones are server-side)', !/choices=\[[^\]]*"self"/.test(pySrc));
}

section('ZaliCoin for addons (web/src/interface/addons_coins.js)');
{
    const coins = read('web/src/interface/addons_coins.js');
    const perms = read('web/src/interface/addons_permissions.js');
    const code = stripLineComments(coins);
    const rpcRows = [...code.matchAll(/'coins\.([a-z]+)': \{ permission: '([a-z.]+)'/g)];
    record('all four coins.* methods exist and each needs the "coins" permission',
        rpcRows.length === 4 && rpcRows.every(r => r[2] === 'coins'), rpcRows.map(r => `${r[1]}:${r[2]}`).join(', '));
    record('the coins RPC table is merged into the dispatcher', /addonCoinsRpcMethods\?\.\(\)/.test(perms));
    record('"coins" is a normal permission with a user-facing title',
        F.PERMISSIONS.coins && !F.isElevated('coins') && F.PERMISSIONS.coins.title === 'ZaliCoin');

    const deposit = (code.match(/async addonCoinsDeposit[\s\S]*?\n    \}\n/) || [''])[0];
    record('a deposit needs the addon on screen', /addonRequireVisible\(/.test(deposit));
    record('a deposit is refused for an untrusted addon before the dialog', /addonCoinsTrust\([\s\S]{0,200}?!trust\.ok[\s\S]{0,600}?showAddonDepositDialog/.test(deposit));
    record('a deposit is rate-limited', /addonCoinsRateLimit\(/.test(deposit));
    record('the amount is clamped by the person\'s own balance before the dialog', /amount > balance[\s\S]{0,300}?showAddonDepositDialog/.test(deposit));
    record('money moves only after the person confirms in the dialog',
        /showAddonDepositDialog[\s\S]{0,300}?if \(!confirmed\) throw[\s\S]{0,300}?\/deposit/.test(deposit));
    record('every deposit carries an idempotency key', /idempotencyKey: this\.zaliCoinNewIdempotencyKey\(\)/.test(deposit));

    const trust = (code.match(/async addonSignedTrust[\s\S]*?\n    \}\n/) || [''])[0];
    record('trust needs the registry to agree with the file on author and kind',
        /registry\.kind !== signature\.kind \|\| registry\.owner !== signature\.owner/.test(trust));
    record('trust needs the registry key to match the file\'s key', /registry\.keyFingerprint[\s\S]{0,120}?signature\.fingerprint/.test(trust));
    record('"none", "invalid" and "unverified" signatures never get as far as the registry',
        /state === 'none'[\s\S]{0,700}?state === 'invalid'[\s\S]{0,300}?state === 'unverified'[\s\S]{0,400}?addonRegistryLookup/.test(trust));

    const dialog = (code.match(/\n    showAddonDepositDialog\(\{[\s\S]*?\n    \}\n/) || [''])[0];
    record('an unsigned-by-ZaliMessenger addon gets the strong warning and an explicit acknowledgement',
        /is-warning[\s\S]{0,900}?data-coin-ack/.test(dialog) && /disabled data-needs-ack/.test(dialog));
    record('the official addon gets only the notice, without the acknowledgement',
        /trust\.official\s*\?[\s\S]{0,400}?is-official/.test(dialog) && /trust\.official \? '' : ' disabled data-needs-ack'/.test(dialog));
    record('the dialog escapes the addon\'s name, owner and note',
        /this\.esc\(m\.name\)/.test(dialog) && /this\.esc\(trust\.owner\)/.test(dialog) && /this\.esc\(note\)/.test(dialog));

    const withdraw = (code.match(/async addonCoinsWithdraw[\s\S]*?\n    \}\n/) || [''])[0];
    record('a person\'s withdrawal needs the addon on screen and a trusted signature',
        /addonRequireVisible\(/.test(withdraw) && /addonCoinsTrust\(/.test(withdraw) && /addonCoinsRateLimit\(/.test(withdraw));
    record('a person\'s withdrawal goes through /payout, never the developer\'s /withdraw',
        /\/payout`/.test(withdraw) && !/\/withdraw`/.test(withdraw));
    const dev = (code.match(/async addonWithdrawRequest[\s\S]*?\n    \}\n/) || [''])[0];
    record('the developer\'s withdrawal (week hold) is a separate path used by the management window only',
        /\/withdraw`/.test(dev) && !/addonWithdrawRequest\(/.test(withdraw));
}

section('cloud storage and external servers (addons_cloud.js, addonCsp)');
{
    const cloud = stripLineComments(read('web/src/interface/addons_cloud.js'));
    const perms = read('web/src/interface/addons_permissions.js');
    const rows = [...cloud.matchAll(/'cloud\.([A-Za-z.]+)': \{ permission: '([a-z.]+)'/g)];
    record('all eleven cloud.* methods exist and each needs the "cloud" permission',
        rows.length === 11 && rows.every(r => r[2] === 'cloud'), rows.map(r => `${r[1]}:${r[2]}`).join(', '));
    record('the cloud RPC table is merged into the dispatcher', /addonCloudRpcMethods\?\.\(\)/.test(perms));
    record('"cloud" is a normal permission, "network.any" an elevated one',
        F.PERMISSIONS.cloud && !F.isElevated('cloud') && F.isElevated('network.any'));
    const server = stripLineComments(read('server/src/addon_cloud.rs'));
    record('the pool is 10 MB per addon and a person\'s share 1 MB, on the client and the server',
        F.LIMITS.cloudBytes === 10 * 1024 * 1024 && F.LIMITS.cloudUserBytes === 1024 * 1024
        && /ADDON_CLOUD_QUOTA_BYTES: i64 = 10 \* 1024 \* 1024/.test(server)
        && /ADDON_CLOUD_USER_BYTES: i64 = 1024 \* 1024/.test(server));
    record('the cloud path is always the addon\'s own id, never a parameter',
        /\/api\/addons\/\$\{encodeURIComponent\(instance\.id\)\}\/cloud/.test(cloud) && !/params\??\.(id|addonId)/.test(cloud));
    record('every cloud call needs a verified signature before the network',
        /await this\.addonCloudRequireSigned\(instance\)[\s\S]{0,120}?addonCloudRateLimit/.test(cloud)
        && /addonSignedTrust\(instance, \{ what:/.test(cloud));
    record('cloud calls are rate-limited and refuse a signed-out account',
        /addonCloudRateLimit\(instance\)/.test(cloud) && /!this\.S\.session\?\.token/.test(cloud));
    record('the server refuses an addon that is not in the author registry',
        /async fn registered_owner[\s\S]{0,400}?FROM addon_registry[\s\S]{0,500}?"not_signed"/.test(server));
    record('only the registry owner writes to the shared area and reads other people\'s data',
        /scope == Scope::Shared \{\s*if let Err\(resp\) = require_owner/.test(server)
        && (server.match(/require_owner\(&owner, &username/g) || []).length >= 5);
    record('a person\'s personal area is keyed by their own name, never a parameter',
        /scope_column\(scope, &username\)/.test(server) && !/query\.user[\s\S]{0,80}?scope_column\(Scope::User, &username/.test(server));
    record('the quota is enforced inside an immediate transaction on the server',
        /run_immediate_tx[\s\S]{0,2500}?ADDON_CLOUD_QUOTA_BYTES[\s\S]{0,300}?ADDON_CLOUD_USER_BYTES/.test(server));

    const coinsSrc = stripLineComments(read('web/src/interface/addons_coins.js'));
    const serverAddons = stripLineComments(read('server/src/addons.rs'));
    record('the running build\'s digest rides on cloud and deposit requests',
        /addonDigestOptions\(instance, options\)/.test(cloud)
        && /addonCoinsApi\([\s\S]{0,300}?addonDigestOptions\(instance, options\)/.test(coinsSrc)
        && /\}, instance\);\s*this\.scheduleZaliCoinRefresh/.test(coinsSrc));
    record('a revoked build is refused by the trust check',
        /registry\.revoked\.includes\(signature\.digest\)[\s\S]{0,200}?'revoked'/.test(coinsSrc));
    record('a revoked build is not launched',
        /registry\.revoked\.includes\(info\.signature\.digest\)[\s\S]{0,200}?'revoked'/.test(stripLineComments(read(RUNTIME_PATH))));
    record('revoking a build needs the operator token and is not open to people',
        /async fn admin_revoke_build[\s\S]{0,400}?operator_authorized\(&state, &headers\)/.test(serverAddons));
    record('a deposit into a revoked build is refused but a person can always take their coins back',
        /async fn deposit[\s\S]{0,900}?digest_revoked/.test(serverAddons)
        && !/async fn payout[\s\S]{0,900}?digest_revoked/.test(serverAddons)
        && !/async fn withdraw[\s\S]{0,900}?digest_revoked/.test(serverAddons));
    record('the author\'s reads of people\'s data are written to the audit log',
        /audit\(&state, &addon_id, &username, None, "\*", "list"\)/.test(server)
        && /audit\(&state, &addon_id, &username, Some\(&user\), &key, "read"\)/.test(server));
    record('collecting is rate-limited per author',
        (server.match(/within_rate\(format!\("c:/g) || []).length === 2 && /within_rate\(format!\("w:/.test(server));
    record('a change of the registry owner wipes the cloud',
        /previous_owner[\s\S]{0,1500}?wipe_addon\(&mut \*conn, &tx_id\)/.test(serverAddons));

    record('unbinding an id is owner-only, refuses a non-empty treasury and official ids',
        /async fn unbind_addon[\s\S]{0,1800}?row\.owner != tx_user[\s\S]{0,200}?NotOwner[\s\S]{0,200}?row\.kind == "official"[\s\S]{0,200}?Official[\s\S]{0,600}?balance > 0[\s\S]{0,100}?Funds/.test(serverAddons));
    record('an unbound id starts clean: ledger and stats are archived and the cloud is wiped',
        /#unbound-/.test(serverAddons) && /"addon_coin_ops", "addon_events", "addon_official_requests"/.test(serverAddons)
        && /DELETE FROM addon_registry[\s\S]{0,300}?wipe_addon\(&mut \*conn, &tx_addon\)[\s\S]{0,100}?Ok\(UnbindOutcome::Done\)/.test(serverAddons));
    const uiSrc = stripLineComments(read('web/src/interface/addons_ui.js'));
    record('a file whose id is pinned to another author is not installed',
        /registry\?\.registered && registry\.owner !== this\.myName\(\)[\s\S]{0,500}?!byOwner[\s\S]{0,700}?return;/.test(uiSrc));

    const runtime = stripLineComments(read(RUNTIME_PATH));
    const csp = (runtime.match(/addonCsp\(manifest\) \{[\s\S]*?\n    \}\n/) || [''])[0];
    record('the open connect-src is reachable only through "network.any"',
        /permissions\.includes\('network\.any'\)/.test(csp) && /const remote = any \?/.test(csp));
    record('without it the policy still lists only the declared hosts',
        /\(manifest\.permissions\.includes\('network'\) \? manifest\.network : \[\]\)/.test(csp));
    record('"network.any" is unavailable where there is no elevated session (browser, Android)',
        /case 'network\.any':[\s\S]{0,200}?nativeSupports\('addonLaunch'\)/.test(runtime));
    record('every elevated permission is known to both native shells',
        read('apps/windows/src/native/addon_elevated.rs').includes('"network.any"')
        && read('apps/macos/Sources/ZaliMessenger/Services/AddonElevated.swift').includes('"network.any"'));
}

finish('addons');
