// Server-side source invariants.
//
// The integration tests in `tests/security.rs` prove the behaviour end to end;
// these rules guard the *shape* of the code that produces it, catching a
// reintroduction at the moment it is typed rather than when someone notices the
// test that used to cover it was deleted along with it.

import { record, section, finish, read, stripLineComments } from './lib/report.mjs';

const auth = stripLineComments(read('server/src/auth.rs'));
const lib = stripLineComments(read('server/src/lib.rs'));
const messages = stripLineComments(read('server/src/messages.rs'));

/** Body of a single Rust fn, from its signature to the next top-level `fn`. */
function rustFn(src, name) {
    const start = src.indexOf(`async fn ${name}(`);
    if (start === -1) return '';
    const rest = src.slice(start + 1);
    const end = rest.search(/\n(pub\(crate\) )?(async )?fn /);
    return end === -1 ? rest : rest.slice(0, end);
}
const downloadUpload = rustFn(messages, 'download_upload_file');
const assets = stripLineComments(read('server/src/assets.rs'));
const updates = stripLineComments(read('server/src/updates.rs'));

section('credentials');
{
    record('no JWT is accepted from the query string',
        !/"token"\s*\|\s*"auth"\s*\|\s*"access_token"/.test(auth)
            && !/matches!\(key,\s*"token"/.test(auth),
        'a query string ends up in proxy logs, history and Referer — the WS ticket exists for this');
    record('the WS ticket is the only query credential',
        /if key == "ticket"/.test(auth));
    record('the WS ticket is consumed on use',
        /fn take_valid_ws_ticket[\s\S]{0,400}?ws_tickets\.remove\(/.test(auth),
        'single use is what makes it safe to put in a URL at all');
    record('the WS ticket expires',
        /fn take_valid_ws_ticket[\s\S]{0,600}?record\.expires_at/.test(auth));
    record('tokens are bound to a token_version',
        /token_version != claims\.token_version/.test(auth),
        'the only way logout can invalidate an already-issued JWT');
    record('issuer and audience are checked',
        /claims\.iss != JWT_ISSUER \|\| claims\.aud != JWT_AUDIENCE/.test(auth));
    record('guest mode stays opt-in',
        /ALLOW_GUEST_MODE[\s\S]{0,300}?unwrap_or\(false\)/.test(lib),
        'it hands every request a real account — it must never default on');
    record('a release build refuses a short/absent JWT_SECRET',
        /panic!\("JWT_SECRET/.test(lib));
    record('guest mode announces itself on every start',
        /if allow_guest_mode \{[\s\S]{0,900}?warn!\(/.test(lib),
        'it disables authentication outright — that must not be a quiet config line');
    record('the `null` CORS origin is dropped',
        /eq_ignore_ascii_case\("null"\)/.test(lib),
        'null is what a sandboxed iframe, a data: document and a file: page all send');
}

section('login rate limiting');
{
    record('per-(username, IP) budget exists',
        /fn login_rate_key\(/.test(auth));
    record('per-IP failed-login budget exists',
        /fn failed_login_ip_rate_key\(/.test(auth),
        'without it a password spray across usernames is never throttled');
    record('the per-IP budget counts failures, not requests',
        /let note_failure = \|\|/.test(auth)
            && /Ok\(None\) => \{[\s\S]{0,300}?note_failure\(\)/.test(auth),
        'counting successes too would lock a NAT full of legitimate users out');
    record('the unknown-username path still costs a bcrypt verify',
        /Ok\(None\) => \{[\s\S]{0,200}?verify_password\([\s\S]{0,80}?DUMMY_BCRYPT_HASH/.test(auth),
        'otherwise response timing enumerates accounts');
    record('registration is rate limited by IP too',
        /let reg_rate_key = format!\("reg:\{\}", client_ip\)/.test(auth));
    record('proxy headers are only trusted when configured',
        /TRUSTED_PROXY_MODE[\s\S]{0,600}?X-Forwarded-For/.test(auth),
        'trusting XFF unconditionally lets any client pick its own rate-limit bucket');
}

section('passwords');
{
    record('passwords are capped at 72 bytes',
        /payload\.password\.len\(\) > 72/.test(auth),
        'bcrypt truncates silently past that — two different passwords would both open the account');
    record('hashing and verification run off the async runtime',
        /spawn_blocking\(move \|\| bcrypt::hash/.test(auth)
            && /spawn_blocking\(move \|\| bcrypt::verify/.test(auth));
    record('no password length is written to the log',
        !/password_len/.test(auth)
            && !/пароль \(\{\} символов\)/.test(auth),
        'it narrows the search space for anyone reading the log');
    record('case-variant usernames cannot both register',
        /SELECT username FROM users WHERE lower\(username\) = \?/.test(auth),
        'two such accounts share one conversation scope, and therefore one key');
}

section('stored secrets');
{
    record('no table stores conversation key material',
        !/CREATE TABLE IF NOT EXISTS conversation_keys\b/.test(lib),
        'the registry stores a SHA-256 fingerprint; the key itself must never reach the server');
    record('the legacy plaintext key table is actively dropped',
        /DROP TABLE IF EXISTS conversation_keys/.test(lib),
        'an unused table is still a readable one');
    record('the key registry stores an id, not a key',
        /key_id TEXT NOT NULL/.test(lib) && !/key_value/.test(lib));
}

section('response headers');
{
    for (const [name, needle] of [
        ['nosniff', 'X_CONTENT_TYPE_OPTIONS'],
        ['frame-options DENY', 'X_FRAME_OPTIONS'],
        ['referrer policy', 'REFERRER_POLICY'],
        ['HSTS', 'STRICT_TRANSPORT_SECURITY'],
        ['CSP', 'CONTENT_SECURITY_POLICY'],
    ]) {
        record(`security_headers still sets ${name}`,
            new RegExp(`security_headers[\\s\\S]{0,1600}?${needle}`).test(lib));
    }
    record('CSP forbids framing and inline script',
        /frame-ancestors 'none'/.test(lib) && /script-src 'self'/.test(lib));
}

section('user content');
{
    record('attachments are served as opaque octet-stream',
        /application\/octet-stream/.test(downloadUpload),
        'anything renderable served from this origin is stored XSS');
    record('attachments are served as an attachment',
        /CONTENT_DISPOSITION[\s\S]{0,200}?attachment/.test(downloadUpload));
    record('attachment access is authorized per message',
        /can_access_message\(/.test(downloadUpload));
    record('avatars are identified by magic bytes, not by the declared type',
        /sniff_image_mime\(&file_data\)/.test(assets),
        'Content-Type in a multipart part is attacker-chosen');
    record('SVG avatars are refused',
        /image\/svg\+xml/.test(assets),
        'SVG is a script container');
    record('asset paths are derived by hashing, never by joining user input',
        /fn user_avatar_asset_dir[\s\S]{0,300}?hex_encode\(/.test(assets),
        'the username arrives from a URL path segment');
}

section('release publishing');
{
    record('the admin token is compared in constant time',
        /constant_time_eq\(/.test(updates));
    record('publishing is closed unless a token is configured',
        /release_admin_token \{[\s\S]{0,200}?None => return StatusCode::FORBIDDEN/.test(updates));
    record('release artifacts are served from their own directory',
        /releases_dir/.test(updates),
        'never from uploads/, which holds user attachments behind per-message auth');
    record('the served filename is allowlisted',
        /is_ascii_alphanumeric\(\)|[A-Za-z0-9._-]/.test(updates));
}

finish('server');
