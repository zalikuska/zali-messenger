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

function loadFormat() {
    const sandbox = { window: {}, TextEncoder, TextDecoder, crypto: webcrypto };
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
    record('elevated permissions are exactly fs.read, fs.write, launch, process', elevated === 'fs.read,fs.write,launch,process', elevated);
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

finish('addons');
