// Shared pass/fail reporting for the security-doctor checks.
//
// Deliberately tiny and dependency-free: these checks have to run on a machine
// with nothing installed but node, and in CI, and they are the last line of
// defence for invariants that have no runtime test (the native shells are not
// exercised by `cargo test` at all).

import { readFileSync, existsSync } from 'node:fs';

let failures = 0;
let checks = 0;

export function record(name, ok, detail = '') {
    checks += 1;
    if (!ok) failures += 1;
    process.stdout.write(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}\n`);
}

export function section(title) {
    process.stdout.write(`\n== ${title} ==\n`);
}

export function finish(label) {
    process.stdout.write(`\n${label}: ${checks - failures}/${checks} passed\n`);
    process.exit(failures === 0 ? 0 : 1);
}

/**
 * Reads a source file, or records a failure and returns '' if it is missing.
 * A moved file must fail loudly: silently checking an empty string would turn
 * every rule below it into a green tick.
 */
export function read(path) {
    if (!existsSync(path)) {
        record(`source present: ${path}`, false, 'file not found');
        return '';
    }
    return readFileSync(path, 'utf8');
}

/** Strips whole-line comments so a rule does not match the comment explaining it. */
export function stripLineComments(src, marker = '//') {
    return src
        .split('\n')
        .map(line => (line.trim().startsWith(marker) ? '' : line))
        .join('\n');
}
