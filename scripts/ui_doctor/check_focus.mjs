// Кольца фокуса — только с клавиатуры (web/src/modules/focus_modality.js).
//
// Каждое правило с :focus-visible в web/style.css обязано нести
// :where([data-kbd-focus] *) — иначе в Mac-оболочке (WebKit) кольцо снова
// вылезет после обычного клика: программный focus() после печати WebKit
// считает «клавиатурным». Новое правило без охраны — провал проверки.
import { readFileSync } from 'node:fs';

const GUARD = ':where([data-kbd-focus] *)';
const css = readFileSync('web/style.css', 'utf8').replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '));
const manifest = readFileSync('web/src/manifest.json', 'utf8');

let failed = 0;
const lines = css.split('\n');
lines.forEach((line, i) => {
    let at = line.indexOf(':focus-visible');
    while (at !== -1) {
        const rest = line.slice(at + ':focus-visible'.length);
        // Исключение одно: правило в конце файла, которое гасит рамку браузера
        // без признака клавиатуры, — `:where(:focus-visible)`.
        const isFallback = line.slice(0, at).endsWith(':where(') && line.includes('html:not([data-kbd-focus])');
        if (!rest.startsWith(GUARD) && !isFallback) {
            console.log(`  ✗ style.css:${i + 1}: :focus-visible без ${GUARD}`);
            console.log(`      ${line.trim().slice(0, 120)}`);
            failed++;
        }
        at = line.indexOf(':focus-visible', at + 1);
    }
});

if (!manifest.includes('"modules/focus_modality.js"')) {
    console.log('  ✗ modules/focus_modality.js нет в web/src/manifest.json — атрибут data-kbd-focus никто не ставит, колец не будет и с клавиатуры');
    failed++;
}

if (failed) {
    console.log(`  итог: ${failed} нарушений`);
    process.exit(1);
}
console.log('  ✓ все :focus-visible охранены признаком клавиатуры, модуль в манифесте');
