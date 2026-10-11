// Стилизованные выпадающие списки (web/src/modules/ui_select.js): чистая логика
// без DOM — размещение меню и набор буквы — плюс охранные проверки исходника.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(path.join(root, 'web/src/modules/ui_select.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web/style.css'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'web/src/manifest.json'), 'utf8'));

let failures = 0;
const check = (name, ok, detail = '') => {
    if (ok) console.log(`  [PASS] ${name}`);
    else { failures += 1; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
};

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox);
const api = sandbox.window.ZaliSelect;

console.log('\n──────── размещение меню');
const rect = (top, bottom) => ({ top, bottom, left: 10, width: 200 });
const below = api.computePlacement(rect(100, 140), 800, 200);
check('есть место снизу — открывается вниз', below.placeAbove === false && below.top === 146, JSON.stringify(below));
const flip = api.computePlacement(rect(700, 740), 800, 240);
check('внизу тесно, вверху просторно — вверх', flip.placeAbove === true && flip.top + flip.height <= 700, JSON.stringify(flip));
const cap = api.computePlacement(rect(50, 90), 1200, 5000);
check('высота ограничена 300 px', cap.height === 300, JSON.stringify(cap));
const tiny = api.computePlacement(rect(10, 40), 120, 400);
check('в крошечном окне высота не меньше 80 px', tiny.height >= 80, JSON.stringify(tiny));

console.log('\n──────── набор буквы');
const labels = ['Apple', 'Avocado', 'Banana', 'Blueberry', 'Cherry'];
const none = [false, false, false, false, false];
check('первая буква — следующий пункт на неё', api.typeaheadIndex(labels, none, 'a', 0) === 1);
check('обход по кругу', api.typeaheadIndex(labels, none, 'a', 1) === 0);
check('несколько букв ищут префикс', api.typeaheadIndex(labels, none, 'bl', 2) === 3);
check('регистр не важен', api.typeaheadIndex(labels, none, 'CH', 0) === 4);
check('отключённые пункты пропускаются', api.typeaheadIndex(labels, [false, true, false, false, false], 'av', 0) === -1);
check('ничего не нашлось — -1', api.typeaheadIndex(labels, none, 'z', 0) === -1);

console.log('\n──────── охранные проверки');
check('меню строится через DOM API, без innerHTML', !/\.innerHTML\s*=/.test(source));
check('скрытый select не показывается (display:none !important)', /\.zs-native\s*\{\s*display:\s*none\s*!important/.test(css));
check('меню поверх модалок (z-index ≥ 10000)', /\.zs-menu\s*\{[^}]*z-index:\s*10000/.test(css));
check('модуль в манифесте до интерфейса', manifest.modules.includes('modules/ui_select.js'));
check('ползунок в «Фокусе» заметен (≥ .3 альфы)', /--sb-thumb:\s*rgba\(255,255,255,\.34\)/.test(css));
check('scrollbar-color задан вместе с ::-webkit-scrollbar', /scrollbar-color:\s*var\(--sb-thumb\)/.test(css));

console.log('');
console.log(failures === 0 ? '  итог: все проверки пройдены' : `  итог: нарушено ${failures}`);
process.exit(failures === 0 ? 0 : 1);
