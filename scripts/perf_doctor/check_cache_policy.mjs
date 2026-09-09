// Политика постоянного кеша ассетов (web/src/interface/cache.js).
//
// Проверяется то, что в этой подсистеме легче всего сломать незаметно:
//
//   - настройки по умолчанию (их видит каждый, кто ничего не трогал);
//   - что режим действительно решает, ЧТО кладётся на диск, а не только
//     как это называется в интерфейсе;
//   - что счётчик обращений реально управляет вытеснением — это прямое
//     требование к фиче, а не деталь реализации;
//   - что горячий путь (обращение к файлу) не трогает диск.
//
// Всё это чистая логика: IndexedDB здесь нет и не нужна — методы,
// принимающие решения, работают с индексом сводок в памяти.
import { loadZaliInterface } from '../voice_doctor/lib/load_interface.mjs';

let failures = 0;
let checks = 0;
const pass = (n, d = '') => { checks += 1; console.log(`  [PASS] ${n}${d ? ` — ${d}` : ''}`); };
const fail = (n, d = '') => { checks += 1; failures += 1; console.log(`  [FAIL] ${n}${d ? ` — ${d}` : ''}`); };
const check = (n, ok, failDetail = '', passDetail = '') => (ok ? pass(n, passDetail) : fail(n, failDetail));

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;
const DAY = 86400000;

const { ZaliInterface } = loadZaliInterface({ Blob });

/** Экземпляр без DOM и без базы: всё, что здесь проверяется, живёт в памяти. */
function makeClient() {
    const api = Object.create(ZaliInterface.prototype);
    api.S = { session: { username: 'alice', token: 't' } };
    api.trace = () => {};
    api._cacheStats = new Map();
    api._cacheDirtyStats = new Set();
    api._cacheBytes = 0;
    api._cacheDb = null;
    api._cacheReady = null;
    api._cachePrefs = null;
    // renderCacheSettings() уходит в DOM, которого здесь нет; сохранение
    // настроек само по себе проверяется через loadCachePrefs().
    api.renderCacheSettings = () => {};
    api.clearAssetCache = async () => {};
    api.enforceCachePolicy = async () => {};
    return api;
}

/** Кладёт сводку напрямую — как будто файл уже на диске. */
function seed(api, { kind, id, size, hits, ageDays = 0 }) {
    const key = api.cacheEntryKey(kind, id);
    const stat = {
        k: key,
        s: size,
        h: hits,
        u: Date.now() - ageDays * DAY,
        c: Date.now() - ageDays * DAY,
        g: api.cacheClassOf(kind, size),
        n: kind,
        t: 'application/octet-stream',
    };
    api._cacheStats.set(key, stat);
    api._cacheBytes += size;
    return stat;
}

function defaults() {
    console.log('\n──────── настройки по умолчанию\n');
    const api = makeClient();
    const prefs = api.loadCachePrefs();
    check('режим по умолчанию — «кешировать легковесное»',
        prefs.mode === 'light', `получено ${prefs.mode}`, prefs.mode);
    check('потолок по умолчанию — 2 ГБ',
        api.cacheLimitBytes() === 2 * GB, `получено ${api.cacheLimitBytes()}`, api.cacheLimitLabel());

    const stops = ZaliInterface.cacheLimitStops.map(s => s.bytes);
    const expected = [512 * MB, 1 * GB, 2 * GB, 4 * GB, 8 * GB, 16 * GB, Infinity];
    check('остановки слайдера — 512 МБ / 1 / 2 / 4 / 8 / 16 ГБ / без ограничения',
        stops.length === expected.length && stops.every((v, i) => v === expected[i]),
        `получено ${stops.join(', ')}`, `${stops.length} остановок`);

    const modes = ZaliInterface.cacheModeCatalog.map(m => m.id);
    check('режимов четыре, включая «не кешировать»',
        modes.length === 4 && ['all', 'light', 'essential', 'off'].every(id => modes.includes(id)),
        `получено ${modes.join(', ')}`, modes.join(', '));

    // Отсутствующее значение — это «по умолчанию», а не «минимум». Number(null)
    // равен нулю, то есть самому маленькому потолку: без отдельной ветки
    // сохранённые настройки без limitIndex молча давали бы 512 МБ.
    const missing = makeClient();
    const blanks = [null, undefined, ''].map(v => missing.normalizeCacheLimitIndex(v));
    check('отсутствующий потолок — это 2 ГБ, а не 512 МБ',
        blanks.every(v => v === ZaliInterface.defaultCacheLimitIndex),
        `получено ${blanks.join(', ')}`, 'null / undefined / "" → индекс по умолчанию');

    // Мусор в настройках не должен ронять клиент в режим «без кеша» или
    // «без ограничения» — обе крайности человек не выбирал.
    const broken = makeClient();
    broken._cachePrefs = null;
    broken.saveCachePrefs({ mode: 'нечто', limitIndex: 999 });
    const fixed = broken.loadCachePrefs();
    check('непонятные значения сводятся к безопасным',
        fixed.mode === 'light' && fixed.limitIndex === ZaliInterface.cacheLimitStops.length - 1,
        `mode=${fixed.mode} limitIndex=${fixed.limitIndex}`,
        'режим падает в default, индекс зажимается в диапазон');
}

function policy() {
    console.log('\n──────── что режим пускает на диск\n');
    const api = makeClient();
    const cases = [
        // [режим, вид, размер, ожидание]
        ['off', 'avatar', 8 * KB, false],
        ['off', 'attachment', 100 * KB, false],
        ['essential', 'avatar', 8 * KB, true],
        ['essential', 'profile', 4 * KB, true],
        ['essential', 'server_asset', 40 * KB, true],
        ['essential', 'sticker', 60 * KB, false],
        ['essential', 'attachment', 100 * KB, false],
        ['light', 'avatar', 8 * KB, true],
        ['light', 'sticker', 60 * KB, true],
        ['light', 'attachment', 1 * MB, true],
        ['light', 'attachment', 8 * MB, false],
        ['all', 'attachment', 40 * MB, true],
        ['all', 'sticker', 60 * KB, true],
    ];
    let wrong = [];
    for (const [mode, kind, size, expected] of cases) {
        api._cachePrefs = { mode, limitIndex: 2 };
        if (api.cachePolicyAllows(kind, size) !== expected) {
            wrong.push(`${mode}/${kind}/${Math.round(size / KB)}KB`);
        }
    }
    check('каждый режим пускает ровно свой класс ассетов',
        wrong.length === 0, `расходится: ${wrong.join(', ')}`, `${cases.length} сочетаний`);

    api._cachePrefs = { mode: 'light', limitIndex: 2 };
    check('граница «лёгкого» — по размеру, а не по типу',
        api.cachePolicyAllows('attachment', 2 * MB) && !api.cachePolicyAllows('attachment', 2 * MB + 1),
        'потолок лёгкого режима не совпадает с 2 МБ',
        'ровно 2 МБ ещё лёгкое, 2 МБ + 1 байт — уже нет');
}

function eviction() {
    console.log('\n──────── обращения решают, кого удалить\n');
    const api = makeClient();
    api._cachePrefs = { mode: 'all', limitIndex: 0 };

    const avatar = seed(api, { kind: 'avatar', id: 'bob', size: 8 * KB, hits: 40 });
    const video = seed(api, { kind: 'attachment', id: 'm1#0#clip.mp4', size: 40 * MB, hits: 1 });
    const photoHot = seed(api, { kind: 'attachment', id: 'm2#0#a.jpg', size: 1 * MB, hits: 30 });
    const photoCold = seed(api, { kind: 'attachment', id: 'm3#0#b.jpg', size: 1 * MB, hits: 1 });

    const order = api.cacheEvictionOrder().map(e => e.stat.k);
    check('первым уходит большое и почти не использованное',
        order[0] === video.k, `первым идёт ${api.cacheEntryLabel({ k: order[0] })}`, 'clip.mp4');
    check('аватарка переживает всё остальное',
        order[order.length - 1] === avatar.k,
        `последним идёт ${api.cacheEntryLabel({ k: order[order.length - 1] })}`, 'bob');
    check('при равном размере решает число обращений',
        order.indexOf(photoCold.k) < order.indexOf(photoHot.k),
        'файл с одним обращением не опережает файл с тридцатью',
        'b.jpg (1 обр.) уходит раньше a.jpg (30 обр.)');

    // Старение: иначе запись, набравшая обращений в прошлом году, держалась
    // бы вечно и состав кеша застыл бы.
    const aged = makeClient();
    aged._cachePrefs = { mode: 'all', limitIndex: 0 };
    const fresh = seed(aged, { kind: 'attachment', id: 'fresh', size: 1 * MB, hits: 5, ageDays: 0 });
    const stale = seed(aged, { kind: 'attachment', id: 'stale', size: 1 * MB, hits: 20, ageDays: 400 });
    const agedOrder = aged.cacheEvictionOrder().map(e => e.stat.k);
    check('давние обращения весят меньше свежих',
        agedOrder.indexOf(stale.k) < agedOrder.indexOf(fresh.k),
        'запись годичной давности не уступает свежей',
        '20 обращений год назад уступают 5 обращениям сегодня');

    // Сколько именно освобождается: без запаса вытеснение запускалось бы на
    // каждой следующей записи.
    const tight = makeClient();
    tight._cachePrefs = { mode: 'all', limitIndex: 0 };
    const deleted = [];
    tight.ensureCacheReady = async () => ({});
    tight.cacheDeleteKeys = async (keys) => {
        keys.forEach(k => { deleted.push(k); tight.cacheForgetStat(k); });
    };
    for (let i = 0; i < 600; i += 1) {
        seed(tight, { kind: 'attachment', id: `f${i}`, size: 1 * MB, hits: (i % 5) + 1 });
    }
    const before = tight.cacheUsedBytes();
    const limit = tight.cacheLimitBytes();
    return tight.cacheEvictFor(64 * MB).then(() => {
        const after = tight.cacheUsedBytes();
        check('вытеснение доводит кеш ниже потолка с запасом на серию',
            after + 64 * MB <= limit && deleted.length > 0,
            `после вытеснения ${Math.round(after / MB)} МБ при потолке ${Math.round(limit / MB)} МБ`,
            `${deleted.length} записей, ${Math.round((before - after) / MB)} МБ освобождено`);
        check('вытеснение трогает только то, что нужно освободить',
            deleted.length < 600,
            'вычищен весь кеш вместо нужной доли',
            `удалено ${deleted.length} из 600`);
        check('«без ограничения» не вытесняет по потолку',
            (() => {
                const unlimited = makeClient();
                unlimited._cachePrefs = { mode: 'all', limitIndex: ZaliInterface.cacheLimitStops.length - 1 };
                seed(unlimited, { kind: 'attachment', id: 'x', size: 40 * MB, hits: 1 });
                let touched = false;
                unlimited.cacheDeleteKeys = async () => { touched = true; };
                unlimited.cacheEvictFor(1 * GB);
                return !touched;
            })(),
            'вытеснение сработало при снятом потолке',
            'потолок Infinity — вытеснение только по квоте браузера');
    });
}

// Кеш выключают и включают обратно в одном сеансе — и это тот самый случай,
// когда мемоизация обманывает: memo стоит на открытии базы, а не на режиме.
function toggling() {
    console.log('\n──────── выключение и обратное включение\n');
    const api = makeClient();
    let opened = 0;
    api.ensureCacheStorage = () => { opened += 1; return Promise.resolve({ fake: true }); };

    api._cachePrefs = { mode: 'off', limitIndex: 2 };
    return api.ensureCacheReady().then(async (offDb) => {
        check('при выключенном кеше база не открывается',
            offDb === null && opened === 0,
            `db=${!!offDb} открытий=${opened}`, 'ensureCacheReady() → null, ноль открытий');

        api._cachePrefs = { mode: 'light', limitIndex: 2 };
        const onDb = await api.ensureCacheReady();
        check('обратное включение работает без перезагрузки',
            !!onDb && opened === 1,
            `db=${!!onDb} открытий=${opened}`, 'база открывается сразу после включения');

        // Инвалидация обязана доходить до диска и при выключенном кеше.
        api._cachePrefs = { mode: 'off', limitIndex: 2 };
        let deleted = null;
        api.cacheDeleteKeys = async (keys) => { deleted = keys; };
        await api.cacheDelete('avatar', 'bob');
        check('удаление записи работает и при выключенном кеше',
            Array.isArray(deleted) && deleted.length === 1,
            'cacheDelete() промолчал при выключенном кеше',
            'снятая аватарка убирается с диска в любом режиме');
    });
}

// Вложения кладутся из saveStoredMessageCache(), который обходит ВЕСЬ архив
// на каждом сохранении. Если бы запись в кеш не спрашивала индекс сводок,
// каждое новое текстовое сообщение переписывало бы на диск все фотографии
// переписки — ровно та «квадратичная работа на горячем пути», от которой
// защищает весь этот раздел.
function attachmentPersistCost() {
    console.log('\n──────── цена сохранения кеша сообщений\n');
    const api = makeClient();
    api._cachePrefs = { mode: 'light', limitIndex: 2 };
    let puts = 0;
    api.cachePut = (kind, id) => {
        puts += 1;
        // Успешная запись оставляет сводку — именно её и спрашивает guard.
        seed(api, { kind, id, size: 90 * KB, hits: 1 });
        return Promise.resolve(true);
    };

    const withPhoto = {
        id: 'msg-1',
        attachments: [{ name: 'photo.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,AAAA' }],
    };
    api.cacheStoreMessageAttachments(withPhoto);
    const first = puts;
    for (let i = 0; i < 40; i += 1) api.cacheStoreMessageAttachments(withPhoto);
    const repeats = puts - first;

    check('первое сохранение кладёт вложение',
        first === 1, `записей=${first}`, '1 запись');
    check('повторные сохранения того же архива не пишут ничего',
        repeats === 0, `${repeats} лишних записей за 40 сохранений`,
        '40 сохранений → 0 записей');

    api.cacheStoreMessageAttachments({
        id: 'msg-2',
        attachments: [{ name: 'b.jpg', mimeType: 'image/jpeg', dataUrl: 'data:image/jpeg;base64,BBBB' }],
    });
    check('новое вложение пишется ровно один раз',
        puts - first - repeats === 1, `записей=${puts - first - repeats}`, '1 запись');

    // Сообщение без id адресовать нечем: индекс ключуется id + позиция + имя.
    let orphan = 0;
    api.cachePut = () => { orphan += 1; return Promise.resolve(true); };
    api.cacheStoreMessageAttachments({ attachments: [{ name: 'x.jpg', dataUrl: 'data:image/jpeg;base64,CCCC' }] });
    check('вложение без идентификатора сообщения не пишется',
        orphan === 0, 'записано вложение, которое нечем найти обратно',
        'нет id — нет записи');
}

// Счётчик показов стоит на пути отрисовки — там, где аватарка попадает в
// разметку. Считать каждый вызов значило бы мерить число перерисовок списка,
// а не полезность файла: одна прокрутка ленты дала бы аватарке больше
// обращений, чем все вложения переписки вместе.
function useWindow() {
    console.log('\n──────── показ ассета на пути отрисовки\n');
    const api = makeClient();
    const stat = seed(api, { kind: 'avatar', id: 'bob', size: 8 * KB, hits: 1 });
    api.flushCacheStats = async () => {};

    for (let i = 0; i < 2000; i += 1) api.cacheNoteAssetUse('avatar', 'bob');
    check('перерисовка списка не накручивает счётчик',
        stat.h === 2, `после 2000 показов hits=${stat.h}`, '2000 показов подряд → +1 обращение');

    // Следующее окно — следующее обращение.
    api._cacheUseWindowAt = Date.now() - 61_000;
    api.cacheNoteAssetUse('avatar', 'bob');
    check('новое окно засчитывает показ заново',
        stat.h === 3, `hits=${stat.h}`, 'минута спустя → ещё +1');

    // Прогрев берёт самые используемые записи. Если бы он их же и повышал,
    // счётчик подтверждал бы сам себя, и однажды популярная аватарка никогда
    // бы не устарела.
    const primed = makeClient();
    const hot = seed(primed, { kind: 'avatar', id: 'bob', size: 8 * KB, hits: 50 });
    const beforeHits = hot.h;
    const beforeUsed = hot.u;
    primed.avatarCache = new Map();
    primed.serverAssetCache = new Map();
    primed.avatarCacheKey = (v) => String(v).toLowerCase();
    primed.saveStoredAvatar = (name, url) => primed.avatarCache.set(name, url);
    primed.scheduleAvatarRefresh = () => {};
    primed.scheduleServerAssetRefresh = () => {};
    primed.ensureCacheReady = async () => ({});
    primed.cacheReadBatch = async (keys) => new Map(keys.map(k => [k, { size: 8 * KB }]));
    globalThis.URL = globalThis.URL || {};
    const realCreate = globalThis.URL.createObjectURL;
    globalThis.URL.createObjectURL = () => 'blob:stub';
    return primed.primeAssetCacheFromDisk().then((count) => {
        globalThis.URL.createObjectURL = realCreate;
        check('прогрев поднимает записи в память',
            count === 1 && primed.avatarCache.size === 1,
            `поднято ${count}`, '1 запись');
        check('прогрев не накручивает собственный критерий отбора',
            hot.h === beforeHits && hot.u === beforeUsed,
            `hits ${beforeHits}→${hot.h}, lastUsed ${beforeUsed}→${hot.u}`,
            'обращения и время обращения не тронуты');
    });
}

function hotPath() {
    console.log('\n──────── цена одного обращения\n');
    const api = makeClient();
    const stat = seed(api, { kind: 'avatar', id: 'bob', size: 8 * KB, hits: 1 });
    let flushes = 0;
    api.flushCacheStats = async () => { flushes += 1; };

    for (let i = 0; i < 500; i += 1) api.cacheNoteHit(stat.k);

    check('обращение считается в памяти, а на диск уходит пачкой',
        stat.h === 501 && api._cacheDirtyStats.size === 1 && flushes === 0,
        `hits=${stat.h} dirty=${api._cacheDirtyStats.size} flushes=${flushes}`,
        '500 обращений → 1 дирти-запись, 0 транзакций');

    // Сводка считается по индексу в памяти — её не страшно перерисовывать.
    const summary = api.cacheSummary();
    check('сводка не читает диск и знает, кто уйдёт следующим',
        summary.count === 1 && summary.hits === 501 && summary.nextEvicted === 'bob',
        `count=${summary.count} hits=${summary.hits} next=${summary.nextEvicted}`,
        'count/hits/nextEvicted из памяти');

    // Промах не должен накручивать счётчик несуществующей записи.
    const before = api._cacheStats.size;
    api.cacheNoteHit(api.cacheEntryKey('avatar', 'nobody'));
    check('промах не создаёт сводку',
        api._cacheStats.size === before,
        'обращение к отсутствующему файлу завело запись в индексе',
        'индекс не растёт от промахов');
}

console.log('Постоянный кеш ассетов: политика, вытеснение, цена обращения');
defaults();
policy();
await eviction();
await toggling();
attachmentPersistCost();
await useWindow();
hotPath();

console.log(`\n  итог: ${checks} проверок, ${failures} нарушено`);
process.exit(failures ? 1 : 0);
