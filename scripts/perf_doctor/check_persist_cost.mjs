// Цена сохранения кэша сообщений.
//
// Инвариант:
//
//   > приём или отправка ОДНОГО сообщения стоит работы, пропорциональной
//   > этому сообщению, а не всему архиву переписок на устройстве
//
// Проверяется три разных счёта: синхронная запись в localStorage, стоимость
// «холостого» сохранения (детектор изменений), и поведение на платформе, где
// localStorage — единственное место, где вложения вообще хранятся, когда он
// переполняется. Плюс синхронность горячего пути отправки.
import fs from 'node:fs';
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

const newMessage = (id, text = 'привет') => ({
    id, clientId: id, sender: 'bob', receiver: 'alice',
    text, timestamp: new Date().toISOString(),
    attachments: [], reactions: [], myReactions: [],
});

// macOS-подобная платформа: нативный кэш-файл есть, поэтому в localStorage
// незачем держать байты вложений.
function costOfOneMessage() {
    console.log('\n──────── кэш сообщений: цена одного сохранения\n');

    const client = new RenderClient();
    client.seedConversation({ count: 60, attachmentBytes: 512 * 1024, withAttachmentEvery: 5 });
    const attachmentBytes = client.attachmentBytesInState();

    client.api.saveStoredMessageCache();
    client.resetCounters();

    client.api.S.chats[client.peer].push(newMessage('msg-new'));
    client.api.saveStoredMessageCache();

    console.log(`  на устройстве: ${fmt(attachmentBytes)} вложений в 60 сообщениях`);
    console.log(`  одно новое сообщение (6 символов) стоило ${fmt(client.persistedBytes)} записи в localStorage\n`);

    check(
        'сохранение после одного сообщения не переписывает весь архив',
        client.persistedBytes < 256 * 1024,
        `${fmt(client.persistedBytes)} записано в localStorage`,
    );

    // Холостое сохранение: строка совпадёт с прошлой, писать нечего. Вопрос в
    // том, во сколько обошлось это выяснить.
    client.resetCounters();
    const t0 = process.hrtime.bigint();
    client.api.saveStoredMessageCache();
    const idleMs = Number(process.hrtime.bigint() - t0) / 1e6;
    check(
        'сохранение без изменений не сериализует вложения',
        idleMs < 5 && client.persistedBytes === 0,
        `${idleMs.toFixed(1)} ms на детектор изменений`,
    );
}

// Всплеск сообщений должен сходиться в одно сохранение: копия архива через
// нативный мост неизбежна (иначе вложения некуда положить), но она обязана
// быть одна на пачку, а не одна на сообщение.
async function burstCoalescesIntoOneSave() {
    console.log('\n──────── всплеск сообщений\n');
    const client = new RenderClient();
    client.seedConversation({ count: 60, attachmentBytes: 512 * 1024, withAttachmentEvery: 5 });
    client.api.saveStoredMessageCache();
    client.resetCounters();

    for (let i = 0; i < 10; i += 1) {
        client.api.S.chats[client.peer].push(newMessage(`burst-${i}`, 'ок'));
        client.api.scheduleSaveStoredMessageCache();
    }
    await new Promise(resolve => setTimeout(resolve, 700));

    const perMessage = client.nativeBridgeBytes / 10;
    console.log(`  10 сообщений подряд: ${fmt(client.nativeBridgeBytes)} через мост\n`);
    check(
        'всплеск из 10 сообщений стоит одной копии архива, а не десяти',
        client.nativeBridgeBytes < 12 * MB,
        `${fmt(client.nativeBridgeBytes)} всего, ~${fmt(perMessage)} на сообщение`,
    );
}

// Windows / iOS / Android: нативного кэш-файла нет, вложения живут только в
// localStorage. Когда они перестают туда влезать, клиент обязан перейти на
// хранение без payload-ов и больше не пытаться — а не пересобирать весь архив
// на каждое сообщение до конца сессии.
function quotaOverflowIsNotForever() {
    console.log('\n──────── переполнение квоты там, где нативного кэша нет\n');

    const client = new RenderClient();
    // Ни saveMessageCache, ни какой-либо другой возможности — но мост есть.
    client.api.nativeSupports = () => false;
    client.seedConversation({ count: 60, attachmentBytes: 512 * 1024, withAttachmentEvery: 5 });
    client.api.warnStorageFallback = () => {};

    let attempts = 0;
    let quotaFailures = 0;
    client.sandbox.localStorage.setItem = (key, value) => {
        if (!String(key).startsWith('zali_message_cache')) return;
        attempts += 1;
        if (String(value).length > 1 * MB) {
            quotaFailures += 1;
            const error = new Error('quota exceeded');
            error.name = 'QuotaExceededError';
            throw error;
        }
    };

    client.api.saveStoredMessageCache();
    for (let i = 0; i < 10; i += 1) {
        client.api.S.chats[client.peer].push(newMessage(`burst-${i}`, 'ок'));
        client.api.saveStoredMessageCache();
    }

    console.log(`  11 сохранений: ${attempts} попыток записи, из них отказов по квоте ${quotaFailures}\n`);
    check(
        'переполнение квоты происходит один раз, а не на каждое сообщение',
        quotaFailures <= 1,
        `${quotaFailures} отказов по квоте за 11 сохранений`,
    );
}

// Между Enter и появлением пузырька не должно быть ни одного await, когда ключ
// разговора уже есть на устройстве — а это подавляющее большинство отправок.
function sendPathIsNotBlocking() {
    console.log('\n──────── путь отправки\n');
    const src = fs.readFileSync(new URL('../../web/src/interface/message_send.js', import.meta.url), 'utf8');
    const start = src.indexOf('async sendInputMessage(');
    const end = src.indexOf('async submitMessageEdit(');
    const body = end > start ? src.slice(start, end) : src.slice(start);

    check(
        'sendInputMessage() не сериализует архив синхронно',
        !/\n\s*this\.saveStoredMessageCache\(\);/.test(body),
        'вызывает saveStoredMessageCache() напрямую вместо scheduleSaveStoredMessageCache()',
        'сохранение отложено через scheduleSaveStoredMessageCache()',
    );

    const storedIndex = body.indexOf('getStoredConversationKey(');
    const awaitIndex = body.indexOf('await this.resolveConversationCryptoKey(');
    check(
        'известный ключ разговора не заставляет ждать сеть',
        storedIndex >= 0 && storedIndex < awaitIndex && /storedConversationKey\s*\|\|\s*await this\.resolveConversationCryptoKey/.test(body),
        'резолв ключа ожидается безусловно — композер очищается только после сетевого запроса',
        'ключ из локального хранилища берётся синхронно, await только при его отсутствии',
    );
}

async function main() {
    costOfOneMessage();
    await burstCoalescesIntoOneSave();
    quotaOverflowIsNotForever();
    sendPathIsNotBlocking();
    console.log(`\n  итог: ${checks} проверок, ${failures} нарушено`);
    process.exit(failures > 0 ? 1 : 0);
}

void main();
