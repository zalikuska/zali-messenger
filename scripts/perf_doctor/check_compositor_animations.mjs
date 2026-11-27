// Бесконечные анимации, которые идут, пока человек в звонке или звонок звонит, обязаны
// жить в композиторе: только opacity и transform, и transform — без scale() на крошечных
// элементах (точка в 7 px с scale() гнала по полному кругу стиль → Paint ×2 → Layerize на
// КАЖДОМ кадре: Chromium ×6, трассировка за 12 с — 519 мс против 33 мс без анимации).
// Волна звонка раньше была box-shadow со spread — 766 мс против 124 мс за 8 с.
//
// Проверка читает style.css как текст: цена видна только в трассировке, но свойства
// ключевых кадров — это то, что её определяет, и это ловится без браузера.
import fs from 'node:fs';
import { loadZaliInterface } from '../voice_doctor/lib/load_interface.mjs';

let failures = 0;
let checks = 0;
const pass = (n, d = '') => { checks += 1; console.log(`  [PASS] ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { checks += 1; failures += 1; console.log(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
const check = (n, ok, failDetail = '', passDetail = '') => (ok ? pass(n, passDetail) : fail(n, failDetail));

const css = fs.readFileSync(new URL('../../web/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function keyframeProps(name) {
    const re = new RegExp(`@keyframes\\s+${name}\\s*\\{`);
    const m = re.exec(css);
    if (!m) return null;
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < css.length && depth > 0) {
        if (css[i] === '{') depth += 1;
        else if (css[i] === '}') depth -= 1;
        i += 1;
    }
    const body = css.slice(start, i - 1);
    const props = new Set();
    for (const frame of body.matchAll(/\{([^{}]*)\}/g)) {
        for (const decl of frame[1].split(';')) {
            const prop = decl.split(':')[0]?.trim();
            if (prop) props.add(prop);
        }
    }
    return { props, body };
}

console.log('\n— звонок: бесконечные анимации только в композиторе —');
for (const name of ['voice-live-dot', 'focus-live-dot', 'voice-ring-wave', 'voiceIncomingPulse']) {
    const k = keyframeProps(name);
    if (!k) { fail(`@keyframes ${name} есть`, 'не найдены'); continue; }
    const bad = [...k.props].filter(p => p !== 'opacity' && p !== 'transform');
    check(`${name}: только opacity/transform`, bad.length === 0, `анимирует ${bad.join(', ')}`, [...k.props].join(', '));
    if (name.endsWith('live-dot')) {
        check(`${name}: без scale()`, !/scale\(/.test(k.body), 'scale() на точке в 7 px перерисовывает кадр целиком');
    }
}

// Хозяева волны — псевдоэлементы, а не сам аватар (анимация на нём тянет за собой его кадр).
const ringHosts = [...css.matchAll(/([^{}]+)\{[^{}]*animation:\s*voice-ring-wave[^;}]*[;}]/g)].map(m => m[1].trim());
check('у волны звонка нет хозяев кроме псевдоэлементов', ringHosts.length > 0 && ringHosts.every(sel => sel.split(',').every(s => /::(before|after)\s*$/.test(s.trim()))),
    `хозяева: ${ringHosts.join(' | ')}`, `${ringHosts.length} хозяина`);

// Индикатор сегментов берёт геометрию из кеша ResizeObserver (чтение offsetLeft в обработчике
// перехода — принудительная раскладка документа, который только что поменяли).
const { ZaliInterface } = loadZaliInterface();
const src = String(ZaliInterface.prototype.syncHubSegmentIndicator);
check('индикатор сегментов читает кеш геометрии', /_hubSegGeom/.test(src), 'syncHubSegmentIndicator снова читает offsetLeft напрямую');
check('кеш геометрии заводит ResizeObserver', typeof ZaliInterface.prototype.observeHubSegmentGeometry === 'function',
    'нет observeHubSegmentGeometry');


// Открытие чата: верхние строки окна достраиваются по кадрам (deferOffscreenMessageRows), а высоты
// строк записываются только когда все они настоящие — у отложенных offsetTop это оценка.
console.log('\n— открытие чата: раскладка окна по кадрам —');
check('правило .msg-defer: content-visibility + оценка высоты',
    /#msgs\s*>\s*\.msg\.msg-defer\s*\{[^}]*content-visibility:\s*hidden[^}]*contain-intrinsic-block-size:\s*var\(--msg-defer-h/.test(css),
    'нет правила, отложенные строки раскладываются сразу');
check('deferOffscreenMessageRows есть', typeof ZaliInterface.prototype.deferOffscreenMessageRows === 'function', 'метод пропал');
check('кусок достройки небольшой', ZaliInterface.DEFER_CHUNK > 0 && ZaliInterface.DEFER_CHUNK <= 32, `DEFER_CHUNK=${ZaliInterface.DEFER_CHUNK}`, `${ZaliInterface.DEFER_CHUNK} строк за кадр`);
const listSrc = fs.readFileSync(new URL('../../web/src/interface/message_list.js', import.meta.url), 'utf8');
check('высоты записываются после достройки, а не поверх оценок',
    /if \(deferState\) deferState\.onDone = recordHeights;\s*else recordHeights\(\);/.test(listSrc),
    'recordMessageRowHeights зовётся до достройки — в хранилище попадут оценки отложенных строк');
check('откладывается только открытие внизу (без запомненного места и очереди «вверх»)',
    /conversationChanged && !restore && this\.pendingMessagesScroll !== 'top'/.test(listSrc), 'условие отложения изменилось');

console.log(`\n  итог: ${checks} проверок, ${failures} нарушено`);
process.exit(failures ? 1 : 0);
