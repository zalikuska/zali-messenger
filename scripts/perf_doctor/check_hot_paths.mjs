// Горячие пути, на которых работа растёт быстрее, чем повод её делать.
//
// Часть проверок измеряет боевой рендер, часть читает исходник: некоторые
// вещи (autoplay у каждого видео, дебаунс у поиска) не имеют численного
// выражения в песочнице без layout, но однозначно видны в коде.
import fs from 'node:fs';
import { RenderClient, dataUrlOfBytes } from './lib/render_client.mjs';

let failures = 0;
let checks = 0;
const pass = (n, d = '') => { checks += 1; console.log(`  [PASS] ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { checks += 1; failures += 1; console.log(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
// Отдельная формулировка для успеха: у проверок по исходнику деталь
// описывает нарушение, и печатать её рядом с [PASS] значит врать.
const check = (n, ok, failDetail = '', passDetail = '') => (ok ? pass(n, passDetail) : fail(n, failDetail));

const MB = 1024 * 1024;
const fmt = (bytes) => (bytes >= MB ? `${(bytes / MB).toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`);
const src = (rel) => fs.readFileSync(new URL(`../../web/src/${rel}`, import.meta.url), 'utf8');

// Аватар собеседника — один файл, но в разметке он появляется у каждого
// входящего сообщения, начинающего или завершающего группу. На нативных
// шеллах это data:-URL, то есть весь его base64 копируется в строку HTML
// столько раз, сколько таких сообщений на экране.
function avatarDuplication() {
    console.log('\n──────── аватары в списке сообщений\n');

    const withAvatar = new RenderClient();
    withAvatar.seedConversation({ count: 60, avatarBytes: 64 * 1024 });
    withAvatar.resetCounters();
    withAvatar.render();

    const withoutAvatar = new RenderClient();
    withoutAvatar.seedConversation({ count: 60, avatarBytes: 0 });
    withoutAvatar.resetCounters();
    withoutAvatar.render();

    const avatarCost = withAvatar.box.writtenChars - withoutAvatar.box.writtenChars;
    const oneAvatar = Math.ceil((64 * 1024) / 3) * 4;
    const copies = avatarCost / oneAvatar;

    console.log(`  один аватар 64 KB → ${fmt(oneAvatar)} base64`);
    console.log(`  в кадре из 60 сообщений он занимает ${fmt(avatarCost)} — ${copies.toFixed(0)} копий\n`);
    check(
        'аватар не копируется в разметку по разу на сообщение',
        copies <= 1.5,
        `${copies.toFixed(0)} копий одного и того же файла в одной строке HTML`,
    );
}

// Вложения приходят от нативного шелла как data:-URL. В состоянии они такими и
// остаются — их ещё надо уметь переслать и сохранить, — но в разметку обязана
// уходить короткая blob:-ссылка, иначе base64 идёт через esc(), через склейку
// строки, через innerHTML и оседает второй копией в _lastMessagesHTML.
function nativeAttachmentsRenderAsBlob() {
    console.log('\n──────── форма вложения, пришедшего от нативного шелла\n');
    const client = new RenderClient();
    const payload = dataUrlOfBytes(256 * 1024);
    const source = { name: 'photo.png', mimeType: 'image/png', kind: 'image', size: 256 * 1024, dataUrl: payload };

    const normalized = client.api.normalizeAttachment(source);
    check(
        'payload сохраняется для отправки и персиста',
        normalized.dataUrl === payload,
        'dataUrl потерян — сообщение нечем переслать и нечего сохранить',
        'dataUrl не тронут',
    );
    // Нормализация не должна создавать object URL: её зовёт ещё и
    // saveStoredMessageCache(), который обходит вложения ВСЕХ переписок.
    check(
        'нормализация не декодирует вложение',
        !client.api._attachmentBlobUrls || client.api._attachmentBlobUrls.size === 0,
        'blob создаётся при нормализации — значит и при каждом сохранении кэша, для всех переписок',
        'blob создаётся только при отрисовке',
    );

    const displayUrl = client.api.attachmentDisplayUrl(payload);
    check(
        'для показа отдаётся blob:-ссылка',
        displayUrl.startsWith('blob:'),
        `получено ${displayUrl.slice(0, 24)}…`,
        `${displayUrl} вместо ${fmt(payload.length)} base64`,
    );

    const html = client.api.renderAttachmentPreview(source);
    check(
        'в разметку вложения не попадает base64',
        !html.includes('base64,') && html.length < 1024,
        `${fmt(html.length)} разметки на одно вложение`,
        `${html.length} байт разметки на вложение в ${fmt(payload.length)}`,
    );

    // Ссылка в разметке больше не является полезной нагрузкой, а нативному
    // мосту сохранения нужна именно она — обратный поиск обязан работать,
    // иначе на macOS/Windows «Скачать» молча свалится в браузерный путь
    // `<a download>`, которого те вебвью не исполняют.
    const savedByNative = [];
    client.api.nativeSupports = (cap) => cap === 'downloadAttachment';
    client.api.postNativeMessage = (payload) => { savedByNative.push(payload); return true; };
    void client.api.downloadAttachmentFromHref(displayUrl, 'photo.png');
    check(
        'нативное сохранение получает исходный payload, а не blob:-ссылку',
        savedByNative.length === 1 && savedByNative[0].dataUrl === payload,
        savedByNative.length ? `в мост ушло ${String(savedByNative[0].dataUrl).slice(0, 12)}…` : 'мост не вызван вовсе',
        'обратный поиск blob: → data: работает',
    );

    // Повторная отрисовка не должна плодить новые object URL на то же вложение.
    client.api.renderAttachmentPreview(source);
    check(
        'повторная отрисовка переиспользует ту же ссылку',
        client.api._attachmentBlobUrls.size === 1,
        `${client.api._attachmentBlobUrls.size} object URL на одно вложение — утечка`,
        'ссылка создаётся один раз на вложение',
    );
}

// Видео в сообщении помечалось autoplay+loop независимо от того, гифка это или
// настоящий видеофайл, а IntersectionObserver умел только возобновлять
// воспроизведение — паузы при уходе за экран не было.
function videoPlaybackIsBounded() {
    console.log('\n──────── воспроизведение видео в ленте\n');
    const client = new RenderClient();
    const video = { name: 'clip.mp4', mimeType: 'video/mp4', kind: 'video', size: 1024, dataUrl: 'https://example.test/clip.mp4' };

    const plain = client.api.renderAttachmentPreview(video);
    check(
        'обычное видео не запускается само',
        !/autoplay/.test(plain),
        'autoplay/loop проставлены безусловно — каждое видео в окне играет одновременно',
        'autoplay только у гифкоподобных вложений',
    );

    const gif = client.api.renderAttachmentPreview(video, false, { gifLike: true });
    check(
        'гифкоподобное видео по-прежнему играет само',
        /autoplay/.test(gif) && /loop/.test(gif) && /muted/.test(gif),
        'гифка перестала автовоспроизводиться',
        'autoplay loop muted на месте',
    );

    const render = src('interface/message_render.js');
    const observerBody = render.slice(
        render.indexOf('new IntersectionObserver'),
        render.indexOf('observer.observe(video)'),
    );
    check(
        'видео вне экрана ставится на паузу',
        /video\.pause/.test(observerBody),
        'observer только возобновляет (ensurePlaying), паузы нет',
        'симметричная пауза по выходу из вьюпорта',
    );
}

// Поиск пользователей: запрос на каждое нажатие клавиши, без дебаунса и без
// отмены предыдущего — ответы могут прийти не в том порядке, в котором ушли.
function searchIsDebounced() {
    console.log('\n──────── поиск\n');
    const events = src('interface/events.js');
    const handler = events.slice(
        events.indexOf("searchInput.addEventListener('input'"),
        events.indexOf("searchInput.addEventListener('focus'"),
    );
    check(
        'ввод в поиске не шлёт запрос на каждый символ',
        !/loadUsers\(/.test(handler),
        'loadUsers() вызывается прямо из обработчика input',
        'ввод уходит в scheduleUserSearch() с дебаунсом и защитой от гонки ответов',
    );
}

// Сортировка истории по времени создаёт по два объекта Date на сравнение.
// На слиянии истории это десятки тысяч аллокаций на ровном месте.
function sortsDoNotAllocateDates() {
    console.log('\n──────── слияние истории\n');
    const files = ['interface/state_sync.js', 'interface/storage.js', 'interface/voice_call.js', 'interface/server_messages.js'];
    const hits = [];
    for (const rel of files) {
        const text = src(rel);
        text.split('\n').forEach((line, i) => {
            if (/sort\(\(a, b\) => new Date\(/.test(line)) hits.push(`${rel}:${i + 1}`);
        });
    }
    check(
        'сортировка сообщений не аллоцирует Date на каждое сравнение',
        hits.length === 0,
        `${hits.length} мест: ${hits.join(', ')}`,
        'сравнение по числовому значению времени',
    );
}

// normalizeAttachments() вызывается по нескольку раз на сообщение за кадр:
// из messageHasMedia, messageIsGifOnly, messageIsImageCaption и самого
// renderMessageBody — каждый раз заново создавая объекты и прогоняя regex
// распознавания стикера.
function attachmentsNormalizedOncePerRender() {
    console.log('\n──────── нормализация вложений\n');
    const client = new RenderClient();
    client.seedConversation({ count: 40, attachmentBytes: 4 * 1024, withAttachmentEvery: 1 });
    // Считается работа, а не вызовы: normalizeAttachments() зовут три раза на
    // сообщение (messageHasMedia, messageIsGifOnly/messageIsImageCaption и сам
    // renderMessageBody), и это нормально — не нормально было каждый раз заново
    // строить объекты и прогонять regex распознавания стикера.
    let built = 0;
    const proto = Object.getPrototypeOf(client.api);
    const real = proto.normalizeAttachment;
    // Считается только настоящая сборка: вызов, вернувший тот же объект, —
    // это ранний выход по маркеру, он бесплатный.
    client.api.normalizeAttachment = function (att) {
        const out = real.call(this, att);
        if (out !== att) built += 1;
        return out;
    };
    client.render();
    const perMessage = built / 40;
    console.log(`  40 сообщений с вложением: ${built} нормализаций за кадр (${perMessage.toFixed(1)} на сообщение)\n`);
    check(
        'вложения сообщения нормализуются один раз за кадр',
        perMessage <= 1.5,
        `${perMessage.toFixed(1)} раз на сообщение за один кадр`,
        `${perMessage.toFixed(1)} раз на сообщение`,
    );
}

avatarDuplication();
nativeAttachmentsRenderAsBlob();
videoPlaybackIsBounded();
searchIsDebounced();
sortsDoNotAllocateDates();
attachmentsNormalizedOncePerRender();
console.log(`\n  итог: ${checks} проверок, ${failures} нарушено`);
process.exit(failures > 0 ? 1 : 0);
