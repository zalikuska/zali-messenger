// Телефонная раскладка: клавиатура, поле ввода в потоке, жесты, размытие.
// Охранные проверки исходников — каждая стоит за дефектом, найденным при
// обходе мобильного интерфейса 2026-11-10 (см. скилл web-ui-architecture,
// «Телефон: клавиатура, поле ввода, шкала скруглений»).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const css = read('web/style.css');
const html = read('web/index.html');
const mobile = read('web/src/interface/mobile.js');
const viewport = read('web/src/interface/viewport.js');
const events = read('web/src/interface/events.js');
const kotlin = read('apps/android/app/src/main/java/org/zalikus/messenger/MainActivity.kt');
const pager = read('web/src/interface/mobile_pager.js');
const bridgeKt = read('apps/android/app/src/main/java/org/zalikus/messenger/NativeBridge.kt');

let failures = 0;
const check = (name, ok, detail = '') => {
    if (ok) console.log(`  [PASS] ${name}`);
    else { failures += 1; console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ''}`); }
};

// Последний мобильный слой: всё, что идёт после его заголовка.
const layerStart = css.indexOf('ТЕЛЕФОН, 2026-11');
const layer = layerStart >= 0 ? css.slice(layerStart) : '';
// Тело метода класса по имени (до следующего метода того же отступа).
const method = (src, name) => {
    const start = src.search(new RegExp(`\\n    ${name}\\(`));
    if (start < 0) return '';
    const rest = src.slice(start + 1);
    const end = rest.search(/\n    \}\n/);
    return end < 0 ? rest : rest.slice(0, end);
};

console.log('\n──────── клавиатура');
check('мобильный слой на месте', layerStart >= 0);
check('вьюпорт сжимается под клавиатуру в Chrome/Android',
    /name="viewport"[^>]*interactive-widget=resizes-content/.test(html));
check('.app берёт высоту видимой области', /\.app\s*\{[^}]*height:\s*var\(--app-h,\s*100vh\)/.test(layer));
check('каркасу не запрещено быть ниже экрана', /\.app \.main\s*\{[^}]*min-height:\s*0/.test(layer));
const kbd = method(mobile, 'setupMobileKeyboardAvoidance');
check('--app-h пишется только при перекрытии раскладки',
    /const appH = inset > 0 \?/.test(kbd) && /removeProperty\('--app-h'\)/.test(kbd),
    'иначе Android пересчитывает стили всего документа на каждом кадре клавиатуры');
check('переменные клавиатуры не переписываются без изменения',
    /insetValue !== lastInset/.test(kbd) && /appH !== lastAppH/.test(kbd));
check('поле в фокусе показывается без scrollIntoView',
    !/scrollIntoView\(/.test(method(mobile, 'revealFocusedField').replace(/\/\/.*$/gm, '')),
    'scrollIntoView двигает и предков с overflow: hidden');
check('док спрятан при клавиатуре', /body\.kbd-open \.mobile-dock\s*\{[^}]*transform:[^;]*!important/.test(layer));
check('окна заканчиваются над клавиатурой',
    /\.coin-transfer-modal,[\s\S]{0,220}\.auth-overlay\s*\{\s*bottom:\s*var\(--kbd-inset/.test(layer));

console.log('\n──────── поле ввода и лента');
check('поле ввода чата — в потоке колонки',
    /#viewChat \.input-area\s*\{[^}]*position:\s*relative[^}]*flex:\s*0 0 auto/.test(layer));
check('лента не резервирует место под поле жёстким отступом',
    !/#viewChat \.msgs\s*\{[^}]*padding:[^;}]*9\dpx/.test(layer));
check('низ ленты держит ResizeObserver, замер в scroll — только при согласованной высоте',
    /setupMessagesViewportAnchor\(\)/.test(viewport) && /new ResizeObserver/.test(method(viewport, 'setupMessagesViewportAnchor'))
    && /if \(box\.clientHeight === state\.height\) state\.gap = gapNow\(\)/.test(method(viewport, 'setupMessagesViewportAnchor')),
    'замер в scroll при несогласованной высоте сбивает якорь на анимации клавиатуры');
check('якорь ленты подключён', /this\.setupMessagesViewportAnchor\(\)/.test(events));
check('кнопки композера не забирают фокус у поля',
    /inputArea\.addEventListener\('mousedown'/.test(events) && /e\.target\.closest\('button'\)\) e\.preventDefault\(\)/.test(events),
    'иначе клавиатура закрывается после каждой отправки');
check('Enter на телефоне — перенос строки', /if \(this\.enterInsertsNewline\(\)\) return;/.test(events));
check('нижняя граница высоты строки учитывает телефон',
    /minMessageRowHeight\(\)/.test(viewport) && !/Math\.max\(56,/.test(viewport));

console.log('\n──────── жесты и прокрутка');
// Комментарии описывают прежний дефект теми же словами — смотрим только код.
const mobileCode = mobile.replace(/^\s*\/\/.*$/gm, '');
check('жесты слушают касания пассивно', !/passive:\s*false/.test(mobileCode),
    'passive: false на #viewChat/.sidebar делает блокирующей каждую прокрутку');
check('жесты не отменяют прокрутку через preventDefault',
    !/preventDefault/.test(method(mobile, 'setupMobileNavGestures'))
    && !/e\.cancelable/.test(method(mobile, 'setupMobileForwardNavGesture')));
check('вертикаль ленты и списка отдана компоновщику',
    /#viewChat \.msgs,\s*html body \.contacts\s*\{[^}]*touch-action:\s*pan-y/.test(layer));
check('свайп влево по сообщению — ответ', /this\.startReplyToMessage\(messageId\)/.test(method(mobile, 'setupMobileNavGestures')));

console.log('\n──────── размытие');
check('полосы без контента под собой не размываются', /:root\s*\{\s*--m-glass:\s*none;/.test(layer));
check('стекло дока и меню — отдельный токен, гаснет на жесте и доводке',
    /body\.mobile-nav-dragging,\s*body\.mobile-nav-animating\s*\{\s*--m-glass-float:\s*none/.test(layer)
    && /\.mobile-dock\s*\{[^}]*backdrop-filter:\s*var\(--m-glass-float\)/.test(layer));
check('доводка перехода помечается классом', /classList\.add\('mobile-nav-animating'\)/.test(mobile));
check('в мобильном слое нет размытия литералом',
    !/backdrop-filter:\s*blur\(/.test(layer), 'только var(--m-glass-float)');
check('подложки окон на телефоне — без размытия',
    /\.coin-transfer-modal,[\s\S]{0,160}\.profile-overlay\s*\{[^}]*backdrop-filter:\s*none/.test(layer));

console.log('\n──────── системное «назад»');
check('веб отдаёт обработчик оболочке', /window\.__zaliHandleBack\s*=/.test(events));
check('Android спрашивает веб и уходит в фон, а не завершается',
    /BackHandler\(/.test(kotlin) && /__zaliHandleBack/.test(kotlin) && /moveTaskToBack\(true\)/.test(kotlin));

console.log('\n──────── нижняя панель и переключение разделов (2026-11-15)');
// Переход на Хаб/ZaliCoin/Настройки ждал «парковки» списка до конца выезда чата,
// которого при таком переходе нет: через 340 мс список уезжал вниз с уже открытого экрана.
for (const view of ['openHubView', 'openZaliCoinView', 'openSettingsView']) {
    check(`${view}: список убирается сразу, а не уезжает вниз`, /closeMobileSidebar\(\{\s*parkNow:\s*true\s*\}\)/.test(method(mobile, view)));
}
// Капсула ехала transition'ом transform, тёмная копия подписей — прыжком по --tx:
// подписи двоились. Теперь анимируются сами зарегистрированные переменные.
check('--tx/--tw/--tg зарегистрированы (@property)',
    ['--tx', '--tw', '--tg'].every((v) => new RegExp(`@property ${v} \\{`).test(css)));
check('капсула анимирует переменные, а не transform/scale',
    /\.mobile-dock-thumb\s*\{[^}]*transition:\s*--tx[^;]*,\s*--tw[^;]*,\s*--tg/.test(css)
    && !/\.mobile-dock-thumb\s*\{[^}]*\n\s*scale:/.test(css));
check('копия подписей стоит по тем же --tx/--tg', /\.mobile-dock-ink\s*\{[^}]*left:\s*calc\(var\(--ink-x[^)]*\)\s*-\s*var\(--tx[^)]*\)\s*\+\s*var\(--tg/.test(css));
// Граница по скрытому пункту (offsetLeft = 0) выпускала капсулу за док.
check('граница капсулы — по видимым пунктам', /filter\(\(b\) => b\.offsetWidth > 0\)/.test(method(mobile, 'setupMobileDockDrag')));
check('разделы едут за капсулой (веб-док)', /mobilePagerStart\?\.\(/.test(mobile) && /mobilePagerMove\?\.\(/.test(mobile) && /mobilePagerEnd\?\.\(/.test(mobile));
check('лента не линейна (магнит к месту)', /Math\.sin\(2 \* Math\.PI \* t\)/.test(pager));
check('в снимке нет копии панели', /DROP = new Set\(\['mobileDock'/.test(pager));
check('касание по разделу тоже едет лентой: снимок старого экрана + настоящий новый',
    /switchSection\('chats'/.test(events) && /switchSection\('hub'/.test(events) && /mobileSwitchSection\(target, doSwitch\)/.test(pager)
    && /mobilePagerSlideTap\(before, real, forward[,)]/.test(pager) && /real\.animate\(/.test(pager));
// Второй снимок (нового экрана) сразу после переключения заставлял браузер синхронно
// считать стили и раскладку нового экрана в обработчике касания — 40–58 мс при CPU ×12.
check('касание не снимает новый экран клоном', !/const after = this\.mobilePagerCapture\(\)/.test(pager));
// transform в процентах вычисляется только после раскладки: чтение его ради старта
// CSS-перехода было синхронной раскладкой всей ленты снимков.
check('доводка ленты — Web Animations, без чтения стиля', !/getComputedStyle\(active\.track\)/.test(pager) && /active\.track\.animate\(/.test(pager));
// offsetLeft/offsetWidth в клике по вкладке — синхронная раскладка всей страницы
// (26–48 мс при CPU ×12): с удалением нативной панели Android веб-док снова на экране.
check('капсула дока берёт геометрию из кеша ResizeObserver',
    /new ResizeObserver\(measure\)/.test(mobile) && /__dockGeom\?\.byEl\.get\(active\)/.test(method(mobile, 'syncMobileDockThumb'))
    && !/offset(Left|Width)/.test(method(mobile, 'syncMobileDockThumb').replace(/\/\/.*$/gm, '')));
check('лента чата за краем телефона не перерисовывается (откладывается до показа)',
    /isMobileChatOffscreen\?\.\(\)/.test(read('web/src/interface/message_list.js'))
    && /this\._messagesRenderDeferred\) this\._renderMessagesNow/.test(mobile));
check('Хаб и ZaliCoin рисуются в ленте, даже если там ещё не были', /mobilePagerSynthetic\(section\)/.test(pager));
check('недостающий режим списка рисуется без setNavMode (счётчики непрочитанного не трогаются)',
    /mobilePagerCaptureListMode\(section\)/.test(pager) && !/setNavMode\(/.test(pager));
check('кеш ленты догоняется в простое, а не на первом жесте', /warmMobilePagerCache\(\)/.test(pager));
// Своя Compose-панель Android дублировала веб-док (жесты, тема, разделы) и расходилась
// с ним; с 2026-11-15 на Android работает сам веб-док.
check('Android не прячет веб-док и не рисует свою панель',
    !/mobileNav:\s*true/.test(bridgeKt) && !/mobile-dock\{display:none/.test(bridgeKt)
    && !/ZaliBottomBar/.test(kotlin) && !/__zaliDockPager/.test(pager));
check('веб-док на Android почти сплошной (размытия там нет)',
    /html\.is-android-shell body\[data-design-mode\] \.mobile-dock \{\s*background: color-mix\(in srgb, var\(--bg\) 96%/.test(css));

console.log('');
console.log(failures === 0 ? '  итог: все проверки пройдены' : `  итог: нарушено ${failures}`);
process.exit(failures === 0 ? 0 : 1);
