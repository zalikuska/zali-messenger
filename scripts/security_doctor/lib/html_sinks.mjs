// Finds `${...}` interpolations that land inside an HTML **attribute value** in
// a template literal, and reports the ones that are not visibly escaped.
//
// Why attributes specifically: `esc()` escapes `<`, `>`, `&`, `"` and `'`, so an
// escaped value can neither open a tag nor close the attribute it sits in. An
// *un*escaped one inside `href="..."`, `style="..."` or `onclick="..."` needs no
// tag at all — a quote is enough to add an event handler to the element that is
// already being built. Text-position interpolations are far more numerous and
// far less sharp; this check deliberately covers the sharp edge rather than
// drowning it in 200 log-string matches.
import { readFileSync, existsSync } from 'node:fs';

const ATTR = /(?:\s([a-zA-Z-]+)\s*=\s*")([^"]*\$\{[^"]*)"/g;
const INTERP = /\$\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;

/** Expressions that cannot carry markup no matter what the data is. */
const INHERENTLY_SAFE = [
    // Goes through an escaper or a validator by name.
    /^\s*(this\.)?(esc|escapeHtml|safeCssColor)\s*\(/,
    // URL-encoded: `"` and `<` cannot survive.
    /^\s*encodeURIComponent\s*\(/,
    // Coerced to a number — the result is digits, `NaN` or `Infinity`.
    /^\s*(Number|parseInt|parseFloat)\s*\(/,
    // A ternary that can only ever produce one of two string literals written
    // right here, e.g. `x ? 'active' : ''`.
    /^[^'"`]*\?\s*'[^'"`<>]*'\s*:\s*'[^'"`<>]*'$/,
];

export function scanAttributeSinks(files) {
    const findings = [];
    for (const path of files) {
        if (!existsSync(path)) continue;
        const lines = readFileSync(path, 'utf8').split('\n');
        lines.forEach((line, index) => {
            if (line.trim().startsWith('//')) return;
            for (const match of line.matchAll(ATTR)) {
                const [, attribute, value] = match;
                for (const interp of value.matchAll(INTERP)) {
                    const expression = interp[1].trim();
                    if (INHERENTLY_SAFE.some(re => re.test(expression))) continue;
                    findings.push({ path, line: index + 1, attribute, expression });
                }
            }
        });
    }
    return findings;
}

/** Stable identity for the baseline: line numbers move on every edit, code does not. */
export function fingerprint({ path, attribute, expression }) {
    return `${path}|${attribute}|${expression}`;
}
