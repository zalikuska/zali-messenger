// Цена одного события в уже открытом интерфейсе: пришло сообщение, сменился
// статус, в журнал упала строка.
//
// До 2026-09-22 каждое такое событие переписывало список сообщений и сайдбар
// целиком через innerHTML — все пузыри окна (с их <img>/<video>) и все строки
// контактов создавались заново и заново раскладывались. Замер в браузере:
// приём одного сообщения на аккаунте со 150 чатами — ~13 мс JS (из них 9 мс
// принудительная раскладка в addLogEntry) плюс ~7 мс раскладки сайдбара;
// кадр списка из 78 пузырей — 6,5 мс, из них 5 мс на даты (toLocale*String
// строит ICU-форматтер на каждый вызов).
//
// Меряется размерность: сколько узлов создано и сколько символов разметки
// разобрано на событие, сколько раз журнал синхронно читал раскладку, сколько
// форматтеров дат построено за кадр.
import vm from 'node:vm';
import { RenderClient } from './lib/render_client.mjs';
import { MiniDocument } from './lib/mini_dom.mjs';

let failures = 0;
let checks = 0;
const pass = (n, d = '') => { checks += 1; console.log(`  [PASS] ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { checks += 1; failures += 1; console.log(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
const check = (n, ok, failDetail = '', passDetail = '') => (ok ? pass(n, passDetail) : fail(n, failDetail));

/** RenderClient, у которого #msgs, #contacts и #logBody — узлы мини-DOM. */
function clientWithDom() {
    const client = new RenderClient();
    const doc = new MiniDocument();
    const nodes = {
        msgs: doc.createElement('div'),
        contacts: doc.createElement('div'),
        logBody: doc.createElement('div'),
    };
    client.box = nodes.msgs;
    client.sandbox.document.getElementById = (id) => nodes[id] || null;
    client.sandbox.document.createElement = (tag) => doc.createElement(tag);
    return { client, doc, nodes };
}

function message(client, i, extra = {}) {
    return {
        id: `msg-${i}`,
        clientId: `client-${i}`,
        sender: i % 2 === 0 ? client.me : client.peer,
        receiver: i % 2 === 0 ? client.peer : client.me,
        text: `сообщение номер ${i}`,
        timestamp: new Date(1_700_000_000_000 + i * 60_000).toISOString(),
        attachments: [],
        reactions: [],
        myReactions: [],
        ...extra,
    };
}

function messageListIsPatched() {
    console.log('\n──────── список сообщений: новое сообщение и смена статуса\n');
    const { client, doc, nodes } = clientWithDom();
    const box = nodes.msgs;
    client.seedConversation({ count: 60 });
    client.render();
    const fullChars = doc.stats.charsParsed;
    const before = box.childNodes.slice();
    console.log(`  первый кадр: ${before.length} узлов, ${fullChars} символов разметки`);

    // Новое сообщение внизу.
    doc.resetStats();
    const msgs = client.api.S.chats[client.peer];
    msgs.push(message(client, 60));
    client.render();
    const survived = before.filter((node) => box.childNodes.includes(node)).length;
    console.log(`  +1 сообщение: создано ${doc.stats.nodesCreated} узлов, разобрано ${doc.stats.charsParsed} символов, полных записей ${doc.stats.fullWrites}`);
    check('новое сообщение не пересоздаёт остальные пузыри',
        doc.stats.fullWrites === 0 && doc.stats.nodesCreated <= 3,
        `создано ${doc.stats.nodesCreated} узлов, полных записей ${doc.stats.fullWrites}`,
        `создано ${doc.stats.nodesCreated} узлов, ${survived} из ${before.length} прежних на месте`);
    check('разбирается только новая разметка, а не весь список',
        doc.stats.charsParsed * 5 < fullChars,
        `${doc.stats.charsParsed} символов при ${fullChars} у полного кадра`);

    // Смена статуса последнего (своего) сообщения: «отправляется» → отправлено.
    msgs.push(message(client, 62, { status: 'sending' }));
    client.render();
    const beforeStatus = box.childNodes.slice();
    doc.resetStats();
    msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], status: 'sent' };
    client.render();
    const replaced = beforeStatus.filter((node) => !box.childNodes.includes(node)).length;
    check('смена статуса заменяет ровно одну строку',
        replaced === 1 && doc.stats.nodesCreated === 1,
        `заменено ${replaced}, создано ${doc.stats.nodesCreated}`,
        '1 узел из ' + beforeStatus.length);

    // Результат патча обязан совпадать с полной отрисовкой того же состояния.
    const patchedHTML = box.innerHTML;
    client.api._messageRowState = null;
    client.api._lastMessagesHTML = null;
    box.innerHTML = '';
    client.render();
    check('после патчей список побайтно равен полной отрисовке', box.innerHTML === patchedHTML,
        'разметка разошлась с полной отрисовкой того же состояния');

    // Кто-то переписал #msgs мимо рендера (пустое состояние, голосовой канал):
    // соответствие строк узлам потеряно, следующий кадр обязан писать целиком.
    box.innerHTML = '<div class="empty-state"></div>';
    doc.resetStats();
    msgs.push(message(client, 63));
    client.render();
    check('чужая запись в #msgs не оставляет список склеенным из обрывков',
        doc.stats.fullWrites === 1 && !box.innerHTML.includes('empty-state'),
        'после внешней записи патч применился к чужим узлам');
}

function sidebarIsPatched() {
    console.log('\n──────── сайдбар: сообщение в одном из 50 чатов\n');
    const { client, doc, nodes } = clientWithDom();
    const api = client.api;
    const peers = [];
    for (let c = 0; c < 50; c += 1) {
        const peer = `peer${c}`;
        peers.push(peer);
        api.S.chats[peer] = [message(client, c, { sender: peer, receiver: client.me, id: `${peer}-0` })];
    }
    api.S.contacts = peers;
    api.S.current = 'peer0';
    api.renderContacts();
    const before = nodes.contacts.childNodes.slice();
    doc.resetStats();
    // Новое сообщение в чате, который и так последний по времени: его строка
    // меняет превью, порядок остальных не меняется.
    api.S.chats.peer49.push(message(client, 1000, { sender: 'peer49', receiver: client.me, id: 'peer49-1' }));
    api.renderContacts();
    const replaced = before.filter((node) => !nodes.contacts.childNodes.includes(node)).length;
    console.log(`  строк ${before.length}: заменено ${replaced}, создано узлов ${doc.stats.nodesCreated}`);
    check('новое сообщение пересоздаёт одну строку сайдбара, а не все',
        doc.stats.fullWrites === 0 && replaced === 1,
        `заменено ${replaced} строк, полных записей ${doc.stats.fullWrites}`);

    // Пустое состояние поиска и обратно: слот тот же, commitListHTML пишет
    // напрямую — кэш построчной записи не должен выдать это за «без изменений».
    api.S.searchQ = 'nobody-matches';
    api.renderContacts();
    api.S.searchQ = '';
    api.renderContacts();
    check('после пустого состояния сайдбар снова показывает контакты',
        nodes.contacts.childNodes.length === peers.length,
        `в сайдбаре ${nodes.contacts.childNodes.length} узлов вместо ${peers.length}`);
}

async function journalDoesNotForceLayout() {
    console.log('\n──────── журнал: строка на каждое входящее сообщение\n');
    const { client, nodes } = clientWithDom();
    const addLogEntry = Object.getPrototypeOf(client.api).addLogEntry;
    const realLog = console.log;
    console.log = () => {};
    try {
        for (let i = 0; i < 40; i += 1) {
            addLogEntry.call(client.api, { type: 'SUCCESS', msg: `Получено: ${i}`, ts: '12:00:00' });
        }
    } finally {
        console.log = realLog;
    }
    const syncReads = nodes.logBody.scrollHeightReads;
    const syncNodes = nodes.logBody.childNodes.length;
    await new Promise((resolve) => setTimeout(resolve, 5));
    check('запись в журнал не читает раскладку синхронно',
        syncReads === 0 && syncNodes === 0,
        `${syncReads} синхронных чтений scrollHeight, ${syncNodes} узлов вставлено сразу`);
    check('строки журнала вставляются пачкой за кадр',
        nodes.logBody.childNodes.length === 40 && nodes.logBody.scrollHeightReads === 1,
        `${nodes.logBody.childNodes.length} строк, ${nodes.logBody.scrollHeightReads} чтений раскладки`,
        '40 строк, одно чтение раскладки');
}

function dateFormattersAreReused() {
    console.log('\n──────── даты в кадре списка\n');
    const { client } = clientWithDom();
    let constructed = 0;
    const RealDTF = vm.runInContext('Intl.DateTimeFormat', client.sandbox);
    vm.runInContext('Intl', client.sandbox).DateTimeFormat = new Proxy(RealDTF, {
        construct(target, args) { constructed += 1; return new target(...args); },
    });
    const api = client.api;
    const stamps = [];
    for (let i = 0; i < 300; i += 1) stamps.push(new Date(1_700_000_000_000 + i * 3_600_000 * 7).toISOString());
    stamps.push(new Date().toISOString(), new Date(Date.now() - 86_400_000).toISOString());
    let mismatches = 0;
    for (const iso of stamps) {
        const d = new Date(iso);
        const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        const today = new Date();
        const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
        const date = d.toDateString() === today.toDateString() ? 'Сегодня'
            : d.toDateString() === yesterday.toDateString() ? 'Вчера'
                : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
        if (api.fmtTime(iso) !== time || api.fmtDate(iso) !== date) mismatches += 1;
        if (api.fmtTime(d.getTime()) !== time) mismatches += 1;
    }
    check('fmtTime/fmtDate дают те же строки, что toLocale*String', mismatches === 0,
        `${mismatches} расхождений на ${stamps.length} метках`);
    const afterFirst = constructed;
    for (let r = 0; r < 20; r += 1) for (const iso of stamps) { api.fmtTime(iso); api.fmtDate(iso); }
    check('форматтеры дат создаются один раз, а не на каждый вызов',
        afterFirst <= 3 && constructed === afterFirst,
        `${constructed} форматтеров на ${stamps.length * 21 * 2} вызовов`,
        `${constructed} форматтера на ${stamps.length * 21 * 2} вызовов`);
    check('невалидная дата выглядит как прежде', api.fmtTime('garbage') === 'Invalid Date' && api.fmtDate('garbage') === 'Invalid Date',
        `fmtTime → ${api.fmtTime('garbage')}, fmtDate → ${api.fmtDate('garbage')}`);
}

async function keySweepAsksDeviceDirectoryOncePerUser() {
    console.log('\n──────── свип переотправки ключей: справочник устройств\n');
    const { client } = clientWithDom();
    const api = client.api;
    const scopes = {};
    for (let c = 0; c < 40; c += 1) scopes[`dm:${client.me}:peer${c}`] = `key-${c}`;
    api.loadStoredConversationKeys = () => ({ ...scopes });
    api.S.session = { token: 't', username: client.me };
    api.ensureDeviceCryptoIdentity = async () => ({ deviceId: 'dev-self' });
    api.currentDeviceId = () => 'dev-self';
    api.devicePublicJwk = () => ({ kty: 'EC' });
    api.conversationKeyId = async (secret) => `id-${secret}`;
    api.encryptConversationKeyEnvelope = async () => 'sealed';
    api.channelFromConversationScope = () => null;
    api.peerFromConversationScope = (scope) => scope.split(':')[2];
    const lookups = new Map();
    let envelopePosts = 0;
    api.apiFetch = async (url, opts = {}) => {
        const match = /\/users\/([^/]+)\/devices/.exec(String(url));
        if (match) {
            lookups.set(match[1], (lookups.get(match[1]) || 0) + 1);
            return { ok: true, json: async () => [{ deviceId: `${match[1]}-1` }, { deviceId: `${match[1]}-2` }] };
        }
        if (opts.method === 'POST') envelopePosts += 1;
        return { ok: true, json: async () => ({}), text: async () => '' };
    };
    await api._retryPublishConversationKeysImpl({ reason: 'check' });
    const own = lookups.get(client.me) || 0;
    const peerMax = Math.max(0, ...[...lookups.entries()].filter(([u]) => u !== client.me).map(([, n]) => n));
    console.log(`  40 переписок: своих устройств спрошено ${own} раз, собеседника — не больше ${peerMax}, конвертов ${envelopePosts}`);
    check('свип спрашивает свои устройства один раз, а не по разу на переписку', own === 1,
        `${own} одинаковых запросов своего справочника за один свип`);
    check('конверты по-прежнему уходят каждому устройству каждого scope', envelopePosts === 40 * 2 + 40 * 2,
        `${envelopePosts} конвертов вместо ${40 * 2 + 40 * 2}`);

    // Вне свипа (ответ на запрос ключа от только что появившегося устройства)
    // справочник обязан спрашиваться заново каждый раз.
    lookups.clear();
    await api.publishConversationKeyToOwnDevices({ scope: `dm:${client.me}:peer1`, key: 'k' });
    await api.publishConversationKeyToOwnDevices({ scope: `dm:${client.me}:peer2`, key: 'k' });
    check('вне свипа справочник устройств не кэшируется', (lookups.get(client.me) || 0) === 2,
        `${lookups.get(client.me) || 0} запросов на 2 публикации`);
}

messageListIsPatched();
sidebarIsPatched();
await journalDoesNotForceLayout();
dateFormattersAreReused();
await keySweepAsksDeviceDirectoryOncePerUser();
console.log(`\n  итог: ${checks} проверок, ${failures} нарушено`);
process.exit(failures > 0 ? 1 : 0);
