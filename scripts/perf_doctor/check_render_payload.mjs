// Стоимость одного кадра отрисовки списка сообщений.
//
// Инвариант не «рендер быстрый», а:
//
//   > стоимость перерисовки диалога пропорциональна его ТЕКСТУ,
//   > а не байтам вложений и аватаров в нём
//
// Нарушается он ровно там, где двоичные данные попадают в строку HTML:
// на macOS/Windows вложения и аватары приходят в вебвью как data:-URL
// (WebView.swift makeDataURL / native.rs), и каждый кадр несёт их base64
// целиком — через esc(), через innerHTML, и ещё раз в _lastMessagesHTML.
//
// Всё ниже исполняет боевой web/src/interface.js.
import { RenderClient } from './lib/render_client.mjs';

let failures = 0;
let checks = 0;
const pass = (n, d = '') => { checks += 1; console.log(`  [PASS] ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { checks += 1; failures += 1; console.log(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
// Отдельная формулировка для успеха: у проверок по исходнику деталь
// описывает нарушение, и печатать её рядом с [PASS] значит врать.
const check = (n, ok, failDetail = '', passDetail = '') => (ok ? pass(n, passDetail) : fail(n, failDetail));

const MB = 1024 * 1024;
const fmt = (bytes) => (bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`);

function main() {
    console.log('\n──────── список сообщений: цена одного кадра\n');

    // 60 сообщений, каждое пятое — фото на 512 КБ. Скромный диалог с картинками:
    // 12 вложений, ~6 МБ. Ниже порога виртуализации (100 на слабом устройстве),
    // то есть рисуется целиком — как и в проде для диалога такой длины.
    const client = new RenderClient();
    client.seedConversation({ count: 60, attachmentBytes: 512 * 1024, withAttachmentEvery: 5, avatarBytes: 64 * 1024 });
    const attachmentBytes = client.attachmentBytesInState();
    const textBytes = Object.values(client.api.S.chats)[0]
        .reduce((sum, m) => sum + String(m.text || '').length, 0);

    client.resetCounters();
    client.render();

    const first = {
        html: client.box.writtenChars,
        esc: client.escChars,
        escCalls: client.escCalls,
    };
    console.log(`  диалог: 60 сообщений, ${fmt(attachmentBytes)} вложений, ${textBytes} символов текста`);
    console.log(`  кадр 1: HTML ${fmt(first.html)}, через esc() прошло ${fmt(first.esc)} за ${first.escCalls} вызовов\n`);

    // 1. Двоичные данные не должны попадать в строку HTML вообще. Запас x8 к
    //    тексту — это разметка бабблов, а не полезная нагрузка.
    check(
        'HTML кадра пропорционален тексту, а не вложениям',
        first.html < textBytes * 8 + 64 * 1024,
        `${fmt(first.html)} HTML при ${textBytes} символах текста и ${fmt(attachmentBytes)} вложений`,
    );

    // 2. esc() — пять последовательных regex-проходов по каждой строке. base64
    //    не содержит ни одного экранируемого символа, так что каждый его байт
    //    сканируется пять раз впустую.
    check(
        'esc() не сканирует байты вложений',
        first.esc < textBytes * 8 + 64 * 1024,
        `${fmt(first.esc)} символов в esc() ⇒ ~${fmt(first.esc * 5)} сканирования на кадр`,
    );

    // 3. Второй кадр без изменений: innerHTML не переписывается (это уже
    //    защищено сравнением _lastMessagesHTML), но строка всё равно
    //    собирается заново — и вместе с ней заново прогоняется весь base64.
    client.resetCounters();
    client.render();
    const second = { html: client.box.writtenChars, esc: client.escChars };
    check(
        'повторный кадр без изменений не переписывает DOM',
        second.html === 0,
        `${fmt(second.html)} записано в innerHTML`,
    );
    check(
        'повторный кадр без изменений не пересобирает полезную нагрузку',
        second.esc < textBytes * 8 + 64 * 1024,
        `${fmt(second.esc)} символов снова прошло через esc()`,
    );

    // 4. Одно новое текстовое сообщение. Цена должна быть ценой сообщения,
    //    а не всего диалога.
    client.api.S.chats[client.peer].push({
        id: 'msg-new', clientId: 'client-new',
        sender: client.peer, receiver: client.me,
        text: 'привет', timestamp: new Date(1_700_000_000_000 + 61 * 60_000).toISOString(),
        attachments: [], reactions: [], myReactions: [],
    });
    client.resetCounters();
    client.render();
    const incremental = { html: client.box.writtenChars, esc: client.escChars };
    console.log('');
    check(
        'одно новое сообщение не перерисовывает байты всех вложений',
        incremental.html < 64 * 1024,
        `${fmt(incremental.html)} HTML переписано ради одного текстового сообщения`,
    );

    console.log(`\n  итог: ${checks} проверок, ${failures} нарушено`);
    return failures;
}

process.exit(main() > 0 ? 1 : 0);
