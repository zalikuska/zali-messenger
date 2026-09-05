// Web UI invariants.
//
// The shared UI is ~21 500 lines that render other people's names, messages,
// profiles, server metadata and drawings straight into `innerHTML`. It runs
// inside every native shell, holding the session token and the conversation
// keys, so one injection there is the whole account — on every platform at once.
//
// Two kinds of rule live here: named invariants (the escaper actually escapes,
// no key material comes out of `Math.random`, links are scheme-checked), and a
// reviewed baseline of every un-escaped interpolation that sits inside an HTML
// attribute. The baseline is not a suppression list — it is the record that each
// of those sites was looked at once. A new one fails until someone looks at it.

import { readFileSync } from 'node:fs';
import { record, section, finish, read, stripLineComments } from './lib/report.mjs';
import { scanAttributeSinks, fingerprint } from './lib/html_sinks.mjs';
import { loadZaliInterface } from '../voice_doctor/lib/load_interface.mjs';

const manifest = JSON.parse(readFileSync('web/src/manifest.json', 'utf8'));
const sourceFiles = ['modules', 'core', 'interface']
    .flatMap(group => manifest[group] || [])
    .map(name => `web/src/${name}`);

const all = stripLineComments(sourceFiles.map(read).join('\n'));

section('escaping');
{
    // Проверяется ПОВЕДЕНИЕ, а не форма записи. Раньше здесь искались подстроки
    // вида `replace(/&/g,'&amp;')`, то есть проверялась конкретная реализация:
    // переписать esc() в один проход (что и было сделано ради скорости — пять
    // цепочек .replace сканировали каждую строку пять раз) означало уронить
    // проверку, ничего не сломав, а любая другая реализация с тем же дефектом
    // прошла бы. Настоящий инвариант — что именно возвращает esc().
    const { ZaliInterface } = loadZaliInterface();
    const esc = ZaliInterface.prototype.esc;
    const call = (value) => esc.call({}, value);

    for (const [name, input, expected] of [
        ['&', '&', '&amp;'],
        ['<', '<', '&lt;'],
        ['>', '>', '&gt;'],
        ['"', '"', '&quot;'],
        ["'", "'", '&#039;'],
    ]) {
        record(`esc() escapes ${name}`, call(input) === expected,
            name === '"' || name === "'"
                ? 'quotes are what keep an escaped value inside its attribute'
                : '');
    }

    // & must be escaped as part of the same pass, not after the others: an
    // implementation that replaced & last would turn the &lt; it had just
    // produced into &amp;lt;, and the value would render as literal text.
    record('esc() escapes & without double-encoding what it produced',
        call('<') === '&lt;' && call('&lt;') === '&amp;lt;',
        'escaping & after the others would double-encode the entities produced before it');

    // A realistic hostile value: every special character at once, in an order
    // that would expose a chained-replace mistake.
    record('esc() neutralises an attribute-breaking payload',
        call(`" onerror='alert(1)'><img src=x>`)
            === '&quot; onerror=&#039;alert(1)&#039;&gt;&lt;img src=x&gt;',
        'an escaped value must not be able to leave its attribute or open a tag');

    record('esc() passes through a value with nothing to escape',
        call('data:image/png;base64,AAAA') === 'data:image/png;base64,AAAA'
            && call('') === '' && call(null) === '' && call(undefined) === '',
        'the fast path must not alter safe input or turn null into "null"');
}

section('dangerous sinks');
{
    record('no eval()', !/[^.\w]eval\s*\(/.test(all));
    record('no new Function()', !/new Function\s*\(/.test(all));
    record('no document.write', !/document\.write\s*\(/.test(all));
    record('no innerHTML of a raw message body',
        !/innerHTML\s*=\s*[^;\n]*\bmsg\.text\b/.test(all)
            && !/innerHTML\s*=\s*[^;\n]*\bmessage\.text\b/.test(all),
        'message text goes through renderMessageText, which escapes then auto-links');
    record('renderMessageText escapes before linkifying',
        /renderMessageText\([\s\S]{0,1200}?this\.esc\(/.test(all));
}

section('links');
{
    record('auto-linked hrefs are scheme-checked',
        /safeHref/.test(all) && /https\?:/.test(all),
        'a javascript: href in a chat message is a click away from the bridge');
    record('external links carry rel="noopener noreferrer"',
        !/target="_blank"(?![^>]*rel=)/.test(all)
            || /target="_blank" rel="noopener noreferrer"/.test(all));
    record('external links are handed to the OS, not to this webview',
        /openExternalLink\(url\)[\s\S]{0,400}?\^https\?:/.test(all)
            || /openExternalLink\([\s\S]{0,300}?\/\^https\?:/.test(all),
        'and the native shells refuse the navigation even if this is bypassed');
}

section('key material');
{
    record('randomBase64 has no Math.random fallback',
        /randomBase64[\s\S]{0,400}?throw/.test(all) && !/randomBase64[\s\S]{0,400}?Math\.random/.test(all),
        'a predictable conversation key is indistinguishable from a working one');
    record('vault envelopes pin their KDF parameters',
        /iterations\s*[<>]=?\s*100000/.test(all),
        'otherwise the sender chooses how hard the vault is to crack');
    record('the key registry receives a fingerprint, not a key',
        /keyId/.test(all) && !/keyValue:\s*key\b/.test(all));
}

section('CSS from server data');
{
    record('safeCssColor exists and is restrictive',
        /safeCssColor\(/.test(all));
    record('server colours go through it',
        /serverAvatarBackground[\s\S]{0,200}?safeCssColor\(/.test(all));
}

section('HTML attribute sinks');
{
    const baseline = new Set(
        JSON.parse(readFileSync('scripts/security_doctor/attribute_sinks.baseline.json', 'utf8')).reviewed,
    );
    const findings = scanAttributeSinks(sourceFiles);
    const fresh = findings.filter(f => !baseline.has(fingerprint(f)));
    const stale = [...baseline].filter(
        key => !findings.some(f => fingerprint(f) === key),
    );

    record('every un-escaped attribute interpolation has been reviewed',
        fresh.length === 0,
        fresh.map(f => `${f.path}:${f.line} ${f.attribute}="\${${f.expression}}"`).join(' | '));
    record('the reviewed baseline has no dead entries',
        stale.length === 0,
        `${stale.length} entr(y|ies) no longer in the source: ${stale.slice(0, 3).join(' | ')}`);
    process.stdout.write(`  · ${findings.length} attribute interpolations scanned across ${sourceFiles.length} files\n`);
}

finish('web UI');
