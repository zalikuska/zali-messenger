// --- ZaliInterface: Постоянный кеш бинарных ассетов: аватарки, ассеты серверов, профили, вложения. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Зачем это вообще появилось
// --------------------------
// До этого файла кеш ассетов был `new Map()` в конструкторе — то есть жил ровно
// до перезагрузки страницы. Каждый запуск клиента заново скачивал аватарку
// КАЖДОГО контакта, иконку и баннер каждого сервера, а профиль перезапрашивался
// на каждом открытии (см. шапку profiles.js — там это было записано как
// осознанное решение). Отсюда «многие аватарки и раздел профиля требуют
// подгрузки»: не медленная сеть, а отсутствие диска под кешем.
//
// Здесь появляется диск — IndexedDB — и политика, которая решает, что на него
// класть и что с него выкидывать.
//
// Три вещи, вокруг которых построен файл
// --------------------------------------
//  1. СВОДКА ДЕШЕВЛЕ САМОГО ФАЙЛА. На каждый файл хранится один компактный
//     stat-объект (~60 байт, однобуквенные поля) в ОТДЕЛЬНОМ object store.
//     Весь индекс сводок целиком поднимается в память ОДНИМ getAll() при
//     открытии базы, дальше попадание в кеш меняет только Map в памяти, а на
//     диск дирти-записи уходят пачкой раз в ZALI_CACHE_STAT_FLUSH_MS. Иначе
//     каждое обращение к аватарке стоило бы отдельной транзакции записи —
//     дороже, чем сама аватарка.
//  2. РЕШЕНИЕ О ВЫТЕСНЕНИИ ПРИНИМАЕТСЯ БЕЗ ЕДИНОГО ЧТЕНИЯ С ДИСКА. Индекс уже
//     в памяти, поэтому выбор жертвы — это сортировка массива, а не обход базы.
//  3. ЦЕНА ПРОПОРЦИОНАЛЬНА ДЕЙСТВИЮ (общий принцип раздела «Производительность»
//     в CLAUDE.md). Запись одного файла трогает один blob и один stat, а не
//     пересобирает индекс; вытеснение трогает ровно столько записей, сколько
//     нужно освободить.
//
// Чего здесь СОЗНАТЕЛЬНО нет
// --------------------------
// Нативного слоя. Всё живёт в вебвью и работает одинаково во всех четырёх
// оболочках — как и голосовые звонки (см. исключение в CLAUDE.md), правку
// дублировать в macOS/Windows/Android не нужно, достаточно bundle_web.py.
// Плата: там, где IndexedDB недоступна (документ с opaque-origin — это про
// Android с его file:///android_asset/), кеш деградирует до сегодняшнего
// поведения «только память», а не ломается. Проверять доступность обязательно
// через реальное открытие базы: наличие window.indexedDB ещё ничего не значит,
// на file:// оно есть и бросает SecurityError на open().

const ZALI_CACHE_DB_NAME = 'zali_asset_cache_v1';
const ZALI_CACHE_DB_VERSION = 1;
const ZALI_CACHE_BLOB_STORE = 'blobs';
const ZALI_CACHE_STAT_STORE = 'stats';

// Дирти-сводки сбрасываются пачкой. Число подобрано так, чтобы всплеск
// обращений (первая отрисовка списка контактов трогает все аватарки разом)
// уложился в одну транзакцию.
const ZALI_CACHE_STAT_FLUSH_MS = 4000;

// Потолок «лёгкого» режима: картинка/стикер крупнее этого считается тяжёлой и
// в режиме «Кешировать легковесное» на диск не попадает.
const ZALI_CACHE_LIGHT_MAX_BYTES = 2 * 1024 * 1024;

// Сколько blob:-ссылок разрешено создать при прогреве. Прогрев существует ради
// первого кадра, а не ради полноты: остальное подтянется обычным путём по мере
// обращения. Без потолка аккаунт с тысячей контактов создавал бы тысячу
// object URL'ов до того, как нарисован первый экран.
const ZALI_CACHE_PRIME_LIMIT = 400;

// Через сколько кешированный ассет перепроверяется в фоне. Аватарки штатно
// инвалидируются событием avatar_updated (handleAvatarUpdated), поэтому срок
// длинный — это страховка на случай пропущенного события, а не основной путь.
const ZALI_CACHE_REVALIDATE_MS = 24 * 60 * 60 * 1000;

// Окно дедупликации показов: см. cacheNoteAssetUse(). Аватарка, весь день
// висящая в списке контактов, набирает столько обращений, сколько минут
// приложение было открыто, — а не сколько раз перерисовался список.
const ZALI_CACHE_USE_WINDOW_MS = 60_000;

// Потолок ожидания открытия базы — см. openCacheDb(). Это не «медленный диск»,
// а «открытие может не завершиться никогда»; секунды хватает с запасом на любое
// честное открытие, а всё, что дольше, для отрисовки уже неотличимо от отказа.
const ZALI_CACHE_OPEN_TIMEOUT_MS = 4000;

// Вес класса в формуле полезности. Аватарка в 8 КБ, к которой обращаются на
// каждой отрисовке, обязана переживать видео в 40 МБ, открытое однажды, —
// и без веса это уже вытекало бы из деления на размер, но вес делает
// приоритет явным и настраиваемым.
const ZALI_CACHE_CLASS_WEIGHT = { essential: 8, light: 2, bulk: 1 };

// Сколько сверх необходимого освобождать за один проход вытеснения. Освобождать
// ровно столько, сколько нужно под текущий файл, — значит запускать вытеснение
// на каждой следующей записи; 12% дают запас на серию.
const ZALI_CACHE_EVICT_HEADROOM = 0.12;

ZaliMixin(ZaliInterface, class {

    // ============================================================
    // Настройки: режим и потолок
    // ============================================================

    // Настройка устройства, а не аккаунта: потолок кеша — про свободное место
    // на этой машине, и переживать переключение аккаунта он обязан.
    cachePrefsStorageKey() {
        return 'zali_cache_prefs_v1';
    }

    static get cacheModeCatalog() {
        return [
            {
                id: 'all',
                label: 'Кешировать всё',
                note: 'all',
                hint: 'Аватарки, ассеты серверов, профили, стикеры и любые вложения — включая видео и файлы.',
            },
            {
                id: 'light',
                label: 'Кешировать легковесное',
                note: 'default',
                hint: 'Всё необходимое плюс стикеры и медиа до 2 МБ. Тяжёлые вложения качаются заново.',
            },
            {
                id: 'essential',
                label: 'Кешировать необходимое',
                note: 'min',
                hint: 'Только аватарки, иконки и баннеры серверов и карточки профилей.',
            },
            {
                id: 'off',
                label: 'Не кешировать',
                note: 'off',
                hint: 'Ничего не хранится между запусками. Всё подгружается заново при каждом открытии.',
            },
        ];
    }

    // Остановки слайдера. Последняя — Infinity: «безлимитно» здесь означает
    // «клиент сам не вытесняет», а не «место бесконечно» — реальный потолок
    // тогда ставит браузерная квота, и запись, не влезшая в неё, всё равно
    // запускает вытеснение (см. cachePut).
    static get cacheLimitStops() {
        return [
            { bytes: 512 * 1024 * 1024, label: '512 МБ' },
            { bytes: 1024 * 1024 * 1024, label: '1 ГБ' },
            { bytes: 2 * 1024 * 1024 * 1024, label: '2 ГБ' },
            { bytes: 4 * 1024 * 1024 * 1024, label: '4 ГБ' },
            { bytes: 8 * 1024 * 1024 * 1024, label: '8 ГБ' },
            { bytes: 16 * 1024 * 1024 * 1024, label: '16 ГБ' },
            { bytes: Infinity, label: 'Без ограничения' },
        ];
    }

    static get defaultCacheMode() { return 'light'; }

    /** 2 ГБ — третья остановка. Индекс, а не значение: слайдер работает по индексу. */
    static get defaultCacheLimitIndex() { return 2; }

    normalizeCacheMode(value) {
        const id = String(value || '').trim().toLowerCase();
        return ZaliInterface.cacheModeCatalog.some(mode => mode.id === id)
            ? id
            : ZaliInterface.defaultCacheMode;
    }

    normalizeCacheLimitIndex(value) {
        // `null` отдельно от прочего мусора: Number(null) — это 0, то есть
        // самый маленький потолок. Отсутствующее значение в сохранённых
        // настройках должно давать значение ПО УМОЛЧАНИЮ, а не 512 МБ.
        if (value === null || value === undefined || value === '') {
            return ZaliInterface.defaultCacheLimitIndex;
        }
        const index = Number(value);
        if (!Number.isFinite(index)) return ZaliInterface.defaultCacheLimitIndex;
        const max = ZaliInterface.cacheLimitStops.length - 1;
        return Math.min(max, Math.max(0, Math.round(index)));
    }

    loadCachePrefs() {
        if (this._cachePrefs) return this._cachePrefs;
        let parsed = null;
        try {
            const raw = localStorage.getItem(this.cachePrefsStorageKey());
            parsed = raw ? JSON.parse(raw) : null;
        } catch (e) {
            parsed = null;
        }
        this._cachePrefs = {
            mode: this.normalizeCacheMode(parsed?.mode),
            limitIndex: this.normalizeCacheLimitIndex(
                parsed?.limitIndex === undefined ? ZaliInterface.defaultCacheLimitIndex : parsed.limitIndex,
            ),
        };
        return this._cachePrefs;
    }

    saveCachePrefs(partial = {}) {
        const current = this.loadCachePrefs();
        const next = {
            mode: partial.mode === undefined ? current.mode : this.normalizeCacheMode(partial.mode),
            limitIndex: partial.limitIndex === undefined
                ? current.limitIndex
                : this.normalizeCacheLimitIndex(partial.limitIndex),
        };
        const modeChanged = next.mode !== current.mode;
        const limitLowered = next.limitIndex < current.limitIndex;
        this._cachePrefs = next;
        try {
            localStorage.setItem(this.cachePrefsStorageKey(), JSON.stringify(next));
        } catch (e) {}
        this.trace(`saveCachePrefs mode=${next.mode} limit=${this.cacheLimitBytes()}`);
        // Ужесточение настройки применяется сразу, а не «когда-нибудь при
        // следующей записи»: человек, выкрутивший потолок с 16 ГБ до 512 МБ,
        // ждёт, что место освободится сейчас.
        if (next.mode === 'off') {
            void this.clearAssetCache();
        } else if (modeChanged || limitLowered) {
            void this.enforceCachePolicy();
        }
        this.renderCacheSettings();
        return next;
    }

    cacheMode() {
        return this.loadCachePrefs().mode;
    }

    cacheLimitBytes() {
        return ZaliInterface.cacheLimitStops[this.loadCachePrefs().limitIndex].bytes;
    }

    cacheLimitLabel() {
        return ZaliInterface.cacheLimitStops[this.loadCachePrefs().limitIndex].label;
    }

    // ============================================================
    // Политика: что вообще кладём на диск
    // ============================================================

    /**
     * Класс ассета. Определяет и вес при вытеснении, и режим, начиная с
     * которого ассет вообще попадает на диск.
     *   essential — маленькое и переиспользуемое на каждой отрисовке.
     *   light     — заметное, но всё ещё дешёвое.
     *   bulk      — тяжёлое, ради чего и существует потолок кеша.
     */
    cacheClassOf(kind, size = 0) {
        switch (kind) {
            case 'avatar':
            case 'server_asset':
            case 'profile':
                return 'essential';
            case 'sticker':
                return 'light';
            case 'attachment':
                return Number(size || 0) <= ZALI_CACHE_LIGHT_MAX_BYTES ? 'light' : 'bulk';
            default:
                return 'bulk';
        }
    }

    /** Пускает ли текущий режим ассет этого класса на диск. */
    cachePolicyAllows(kind, size = 0) {
        const mode = this.cacheMode();
        if (mode === 'off') return false;
        const cls = this.cacheClassOf(kind, size);
        if (mode === 'all') return true;
        if (mode === 'light') return cls !== 'bulk';
        return cls === 'essential';
    }

    // ============================================================
    // Хранилище
    // ============================================================

    /**
     * Ключ записи. Аккаунт входит в ключ, и это не перестраховка: список
     * контактов, состав серверов и карточки профилей — это то, с кем аккаунт
     * общается. Оставлять их видимыми следующему аккаунту на той же машине
     * незачем, а очистка по префиксу выходит бесплатной.
     */
    cacheEntryKey(kind, id) {
        const account = String(this.S?.session?.username || 'anon').trim().toLowerCase() || 'anon';
        return `${account}|${kind}|${String(id || '')}`;
    }

    cacheAccountPrefix() {
        const account = String(this.S?.session?.username || 'anon').trim().toLowerCase() || 'anon';
        return `${account}|`;
    }

    /**
     * Открывает базу ровно один раз за сессию и запоминает РЕЗУЛЬТАТ, включая
     * отказ: там, где IndexedDB закрыта origin'ом документа, open() бросает на
     * каждой попытке, и без запоминания клиент дёргал бы её на каждой аватарке.
     */
    ensureCacheStorage() {
        if (this._cacheReady) return this._cacheReady;
        this._cacheReady = (async () => {
            let db = null;
            try {
                db = await this.openCacheDb();
            } catch (e) {
                this.trace(`assetCache unavailable reason=${e?.name || e?.message || e}`);
                db = null;
            }
            if (!db) {
                this._cacheDisabledReason = 'IndexedDB недоступна в этой оболочке';
                this._cacheStats = new Map();
                this._cacheBytes = 0;
                return null;
            }
            this._cacheDb = db;
            await this.loadCacheStatIndex(db);
            return db;
        })();
        return this._cacheReady;
    }

    /**
     * То же самое, но с оглядкой на режим. Разделено намеренно: memo стоит на
     * ОТКРЫТИИ базы, а не на режиме, иначе выключение кеша в настройках
     * запоминало бы «базы нет» на весь сеанс, и обратное включение не
     * заработало бы до перезагрузки. Очистка и удаление базы, наоборот,
     * обязаны работать и при выключенном кеше — им нужно добраться до того,
     * что записали, пока он был включён.
     */
    ensureCacheReady() {
        if (this.cacheMode() === 'off') return Promise.resolve(null);
        return this.ensureCacheStorage();
    }

    /**
     * Открытие базы ОБЯЗАНО завершаться. Это не перестраховка — без таймаута
     * подсистема кеша умеет подвесить отрисовку.
     *
     * `indexedDB.open()` не даёт никаких гарантий по времени и не обязан
     * завершиться вообще: пока по этой базе висит незавершённый
     * `deleteDatabase()` (а он висит, пока хоть одна другая вкладка держит
     * соединение открытым), запрос на открытие просто ждёт — не `success`, не
     * `error`, и `blocked` тоже нет, потому что это событие только про смену
     * версии. Две вкладки веб-клиента — совершенно обычное дело, а
     * `destroyAssetCacheDatabase()` вызывается из конструктора при смене
     * localResetEpoch, то есть ровно в тот момент, когда вкладок может быть
     * несколько.
     *
     * Цена такого зависания непропорциональна: `ensureAvatarLoaded()` ждёт
     * `cacheGet()`, тот ждёт открытия базы — и промис аватарки не резолвится
     * НИКОГДА, оставаясь в `avatarRequests`. То есть аватарки перестают
     * грузиться совсем, включая сетевой путь, к которому кеш отношения не
     * имеет. Проверено вживую: `deleteDatabase` из второй вкладки → аватарка
     * висит в PENDING бесконечно.
     *
     * Поэтому: истёк таймаут — считаем, что диска нет, и работаем как на
     * платформе без IndexedDB. Соединение, если оно всё-таки откроется позже,
     * закрывается, чтобы не мешать чужому `deleteDatabase`.
     */
    openCacheDb() {
        return new Promise((resolve, reject) => {
            let request;
            try {
                if (!window.indexedDB) { resolve(null); return; }
                request = window.indexedDB.open(ZALI_CACHE_DB_NAME, ZALI_CACHE_DB_VERSION);
            } catch (e) {
                reject(e);
                return;
            }
            let done = false;
            const settle = (value) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve(value);
            };
            const timer = setTimeout(() => {
                if (done) return;
                done = true;
                this.trace('assetCache open timed out — работаем без диска');
                // Опоздавшее соединение закрываем: держать его открытым значит
                // блокировать deleteDatabase той вкладки, которая нас и ждёт.
                request.onsuccess = () => { try { request.result.close(); } catch (e) {} };
                resolve(null);
            }, ZALI_CACHE_OPEN_TIMEOUT_MS);

            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains(ZALI_CACHE_BLOB_STORE)) {
                    db.createObjectStore(ZALI_CACHE_BLOB_STORE);
                }
                if (!db.objectStoreNames.contains(ZALI_CACHE_STAT_STORE)) {
                    db.createObjectStore(ZALI_CACHE_STAT_STORE);
                }
            };
            request.onsuccess = () => settle(request.result);
            request.onerror = () => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                reject(request.error || new Error('indexedDB open failed'));
            };
            // Другая вкладка держит старую версию базы. Ждать нечего — работаем
            // без диска, но не висим на промисе вечно.
            request.onblocked = () => settle(null);
        });
    }

    /**
     * Весь индекс сводок — одним чтением. Это и есть «максимально ресурсно
     * оптимизированная сводка»: дальше ни одно обращение к кешу не читает с
     * диска ничего, кроме самого файла.
     */
    async loadCacheStatIndex(db) {
        const stats = new Map();
        let bytes = 0;
        try {
            const rows = await this.cacheIdbRequest(
                db.transaction(ZALI_CACHE_STAT_STORE, 'readonly').objectStore(ZALI_CACHE_STAT_STORE).getAll(),
            );
            for (const row of rows || []) {
                if (!row || !row.k) continue;
                stats.set(row.k, row);
                bytes += Number(row.s || 0);
            }
        } catch (e) {
            this.trace(`assetCache stat index read failed reason=${e?.name || e?.message || e}`);
        }
        this._cacheStats = stats;
        this._cacheBytes = bytes;
        this.trace(`assetCache ready entries=${stats.size} bytes=${bytes}`);
        return stats;
    }

    /** Промис вокруг IDBRequest — весь остальной файл говорит на async/await. */
    cacheIdbRequest(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('indexedDB request failed'));
        });
    }

    cacheStats() {
        if (!this._cacheStats) this._cacheStats = new Map();
        return this._cacheStats;
    }

    cacheUsedBytes() {
        return Number(this._cacheBytes || 0);
    }

    // ============================================================
    // Чтение / запись
    // ============================================================

    /**
     * Достаёт файл и засчитывает обращение. Возвращает Blob или null.
     *
     * Обращение засчитывается ТОЛЬКО при попадании: промах — это не
     * использование файла, и накручивать им счётчик значило бы поднимать
     * ценность записи, которой в кеше нет.
     */
    async cacheGet(kind, id) {
        const db = await this.ensureCacheReady();
        if (!db) return null;
        const key = this.cacheEntryKey(kind, id);
        const stat = this.cacheStats().get(key);
        if (!stat) return null;
        try {
            const row = await this.cacheIdbRequest(
                db.transaction(ZALI_CACHE_BLOB_STORE, 'readonly').objectStore(ZALI_CACHE_BLOB_STORE).get(key),
            );
            if (!row || !row.b) {
                // Сводка есть, файла нет — рассинхрон после прерванной
                // транзакции. Чинится удалением сводки, иначе она вечно
                // занимает место в учёте и мешает вытеснению.
                this.cacheForgetStat(key, { purgeDisk: true });
                return null;
            }
            this.cacheNoteHit(key);
            return new Blob([row.b], { type: row.t || stat.t || 'application/octet-stream' });
        } catch (e) {
            this.trace(`cacheGet failed key=${key} reason=${e?.name || e?.message || e}`);
            return null;
        }
    }

    /**
     * Пакетное чтение — одна транзакция на весь набор.
     *
     * Прогрев поднимает до ZALI_CACHE_PRIME_LIMIT записей; отдельная
     * транзакция на каждую — это столько же обращений к движку хранилища, а в
     * WKWebView/WebView2 ещё и столько же переходов через границу процесса,
     * на самом старте приложения.
     *
     * Обращения здесь НЕ засчитываются, и это принципиально. Прогрев берёт
     * самые используемые записи — если бы он их же и повышал, счётчик
     * подтверждал бы сам себя: однажды популярная аватарка вечно попадала бы
     * в прогрев, вечно обновляла время обращения и никогда бы не устаревала,
     * даже если человек уже год с ней не разговаривает. Использование
     * засчитывает тот, кто действительно показывает картинку, —
     * cacheNoteAssetUse() из loadStoredAvatar()/loadServerAsset().
     */
    async cacheReadBatch(keys) {
        const out = new Map();
        const db = this._cacheDb;
        if (!db || !keys.length) return out;
        try {
            const tx = db.transaction(ZALI_CACHE_BLOB_STORE, 'readonly');
            const store = tx.objectStore(ZALI_CACHE_BLOB_STORE);
            const reads = keys.map(key => this.cacheIdbRequest(store.get(key)).then(row => [key, row]));
            const rows = await Promise.all(reads);
            for (const [key, row] of rows) {
                if (row && row.b) out.set(key, new Blob([row.b], { type: row.t || 'application/octet-stream' }));
                else this.cacheForgetStat(key, { purgeDisk: true });
            }
        } catch (e) {
            this.trace(`cacheReadBatch failed count=${keys.length} reason=${e?.name || e?.message || e}`);
        }
        return out;
    }

    /**
     * Засчитывает показ ассета — но не чаще раза в ZALI_CACHE_USE_WINDOW_MS
     * на ключ.
     *
     * Вызывается из loadStoredAvatar(), то есть из отрисовки каждой строки
     * контакта и каждой группы сообщений: считать там КАЖДЫЙ вызов значило бы
     * мерить не «как часто нужен файл», а «сколько раз перерисовался список»,
     * и одна прокрутка ленты дала бы аватарке больше обращений, чем все
     * вложения переписки вместе. Окно превращает это в понятную величину:
     * сколько минут работы приложения файл реально был на экране.
     *
     * Цена — одна проверка Set на пути, где уже есть проверка Map.
     */
    cacheNoteAssetUse(kind, id) {
        if (!this._cacheStats || !this._cacheStats.size) return;
        const now = Date.now();
        if (!this._cacheUseWindow || now - this._cacheUseWindowAt > ZALI_CACHE_USE_WINDOW_MS) {
            this._cacheUseWindow = new Set();
            this._cacheUseWindowAt = now;
        }
        const key = this.cacheEntryKey(kind, id);
        if (this._cacheUseWindow.has(key)) return;
        this._cacheUseWindow.add(key);
        this.cacheNoteHit(key);
    }

    /** Свежесть записи — для фоновой перепроверки. */
    cacheIsStale(kind, id, maxAgeMs = ZALI_CACHE_REVALIDATE_MS) {
        const stat = this.cacheStats().get(this.cacheEntryKey(kind, id));
        if (!stat) return true;
        return (Date.now() - Number(stat.c || 0)) > maxAgeMs;
    }

    /**
     * Кладёт файл. Молча ничего не делает, если политика его не пускает —
     * вызывающему не нужно знать про режимы.
     */
    async cachePut(kind, id, source, { contentType = '' } = {}) {
        const blob = await this.toCacheBlob(source, contentType);
        if (!blob || !blob.size) return false;
        if (!this.cachePolicyAllows(kind, blob.size)) return false;
        const db = await this.ensureCacheReady();
        if (!db) return false;

        const key = this.cacheEntryKey(kind, id);
        // Удаление того же ключа, начатое раньше, должно ЗАВЕРШИТЬСЯ раньше —
        // см. cacheDelete(). Обе операции фоновые, и без этого порядок решает
        // то, кому первым досталось открытое соединение.
        const pendingDelete = this._cachePendingDeletes?.get(key);
        if (pendingDelete) {
            try { await pendingDelete; } catch (e) {}
        }
        const previous = this.cacheStats().get(key);
        const delta = blob.size - Number(previous?.s || 0);
        // Освобождаем место ДО записи: запись, не влезающая в потолок, иначе
        // сначала превысила бы его, а потом сама себя и вытеснила.
        if (delta > 0) await this.cacheEvictFor(delta);

        let buffer;
        try {
            buffer = await this.blobToArrayBuffer(blob);
        } catch (e) {
            return false;
        }
        // ArrayBuffer, а не Blob: Blob в IndexedDB исторически ломался в
        // WKWebView, а буфер лежит везде одинаково. Тип хранится рядом.
        const row = { b: buffer, t: blob.type || contentType || 'application/octet-stream' };
        const now = Date.now();
        const stat = {
            k: key,
            s: blob.size,
            // Свежая запись стартует с одним обращением: файл, который только
            // что понадобился, уже один раз использован.
            h: Number(previous?.h || 0) + 1,
            u: now,
            c: now,
            g: this.cacheClassOf(kind, blob.size),
            n: kind,
            t: row.t,
        };

        const write = async () => {
            const tx = db.transaction([ZALI_CACHE_BLOB_STORE, ZALI_CACHE_STAT_STORE], 'readwrite');
            tx.objectStore(ZALI_CACHE_BLOB_STORE).put(row, key);
            tx.objectStore(ZALI_CACHE_STAT_STORE).put(stat, key);
            await this.cacheTransactionDone(tx);
        };

        try {
            await write();
        } catch (e) {
            // Квота браузера может оказаться меньше выбранного потолка (и
            // всегда меньше «без ограничения»). Один раз освобождаем заметную
            // долю и пробуем снова; второй отказ — просто не кешируем.
            const quota = e?.name === 'QuotaExceededError' || /quota/i.test(String(e?.message || ''));
            if (!quota) {
                this.trace(`cachePut failed key=${key} reason=${e?.name || e?.message || e}`);
                return false;
            }
            // ignoreLimit: место кончилось по квоте браузера, а не по нашему
            // потолку — при «Без ограничения» обычное вытеснение не сработало бы.
            await this.cacheEvictFor(
                Math.max(delta, Math.ceil(this.cacheUsedBytes() * 0.25)),
                { ignoreLimit: true },
            );
            try {
                await write();
            } catch (inner) {
                this.trace(`cachePut quota-bound key=${key} reason=${inner?.name || inner?.message || inner}`);
                return false;
            }
        }

        // Учёт сводится по ТЕКУЩЕМУ состоянию индекса, а не по delta, посчитанной
        // до await'ов. Между ними стоит cacheEvictFor(), и вытеснение вправе
        // выбрать жертвой ровно ту запись, которую мы сейчас перезаписываем, —
        // тогда cacheForgetStat() уже вычел её размер, и прибавление старой
        // delta теряет previous.s безвозвратно. Замер: 81920 против реальных
        // 92160 после одной такой перезаписи, и дрейф копится, пока индекс не
        // будет перечитан с диска, — то есть выбранный потолок молча превышается.
        const current = this.cacheStats().get(key);
        this._cacheBytes = Math.max(0, this.cacheUsedBytes() - Number(current?.s || 0)) + blob.size;
        this.cacheStats().set(key, stat);
        this.scheduleCacheSummaryRefresh();
        return true;
    }

    // Через ensureCacheStorage(), а не ensureCacheReady(): инвалидация обязана
    // доходить до диска и при выключенном кеше — иначе снятая аватарка
    // осталась бы лежать там до включения кеша обратно.
    //
    // Удаление регистрируется в _cachePendingDeletes, и cachePut() по тому же
    // ключу его дожидается. Иначе инвалидация и перезакачка — две несвязанные
    // фоновые операции: handleAvatarUpdated() вызывает clearStoredAvatar()
    // (delete) и тут же ensureAvatarLoaded(force) (put), а delete успевает
    // раньше открыть базу, то есть приходит ВТОРЫМ и стирает только что
    // сохранённую новую аватарку.
    async cacheDelete(kind, id) {
        const key = this.cacheEntryKey(kind, id);
        if (!this._cachePendingDeletes) this._cachePendingDeletes = new Map();
        const pending = (async () => {
            const db = await this.ensureCacheStorage();
            if (!db) return;
            await this.cacheDeleteKeys([key]);
        })();
        this._cachePendingDeletes.set(key, pending);
        try {
            await pending;
        } finally {
            if (this._cachePendingDeletes.get(key) === pending) {
                this._cachePendingDeletes.delete(key);
            }
        }
    }

    async cacheDeleteKeys(keys) {
        const db = this._cacheDb;
        if (!db || !keys.length) return;
        try {
            const tx = db.transaction([ZALI_CACHE_BLOB_STORE, ZALI_CACHE_STAT_STORE], 'readwrite');
            const blobs = tx.objectStore(ZALI_CACHE_BLOB_STORE);
            const stats = tx.objectStore(ZALI_CACHE_STAT_STORE);
            keys.forEach(key => { blobs.delete(key); stats.delete(key); });
            await this.cacheTransactionDone(tx);
        } catch (e) {
            this.trace(`cacheDeleteKeys failed count=${keys.length} reason=${e?.name || e?.message || e}`);
            return;
        }
        keys.forEach(key => this.cacheForgetStat(key));
        this.scheduleCacheSummaryRefresh();
    }

    /**
     * Забывает запись в памяти. `purgeDisk` — когда сводка осиротела (файла под
     * ней нет): без него строка остаётся в object store и на КАЖДОМ следующем
     * запуске снова попадает в индекс, продолжая занимать место в учёте и
     * вытеснять настоящие записи. Из cacheDeleteKeys() приходит false —
     * там строка уже удалена той же транзакцией.
     */
    cacheForgetStat(key, { purgeDisk = false } = {}) {
        const stat = this.cacheStats().get(key);
        if (!stat) return;
        this._cacheBytes = Math.max(0, this.cacheUsedBytes() - Number(stat.s || 0));
        this.cacheStats().delete(key);
        this._cacheDirtyStats?.delete(key);
        if (!purgeDisk || !this._cacheDb) return;
        try {
            const tx = this._cacheDb.transaction(ZALI_CACHE_STAT_STORE, 'readwrite');
            tx.objectStore(ZALI_CACHE_STAT_STORE).delete(key);
        } catch (e) {
            this.trace(`cacheForgetStat purge failed key=${key} reason=${e?.name || e?.message || e}`);
        }
    }

    cacheTransactionDone(tx) {
        return new Promise((resolve, reject) => {
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error || new Error('indexedDB transaction failed'));
            tx.onabort = () => reject(tx.error || new Error('indexedDB transaction aborted'));
        });
    }

    // ============================================================
    // Сводка обращений
    // ============================================================

    /**
     * Обращение к файлу. Самый горячий путь во всём кеше — поэтому здесь
     * НЕТ ни одной операции с диском: правится объект в памяти, ключ
     * попадает в дирти-набор, а запись уходит пачкой по таймеру.
     */
    cacheNoteHit(key) {
        const stat = this.cacheStats().get(key);
        if (!stat) return;
        stat.h = Number(stat.h || 0) + 1;
        stat.u = Date.now();
        if (!this._cacheDirtyStats) this._cacheDirtyStats = new Set();
        this._cacheDirtyStats.add(key);
        this.scheduleCacheStatFlush();
    }

    scheduleCacheStatFlush() {
        if (this._cacheStatFlushTimer) return;
        this._cacheStatFlushTimer = setTimeout(() => {
            this._cacheStatFlushTimer = null;
            void this.flushCacheStats();
        }, ZALI_CACHE_STAT_FLUSH_MS);
    }

    /** Пишет только изменившиеся сводки, одной транзакцией. */
    async flushCacheStats() {
        const dirty = this._cacheDirtyStats;
        if (!dirty || !dirty.size) return;
        const db = this._cacheDb;
        if (!db) { dirty.clear(); return; }
        // Снимаем ровно те ключи, что уносим (а не весь набор): обращения,
        // случившиеся во время самой записи, обязаны остаться дирти.
        const keys = Array.from(dirty);
        keys.forEach(key => dirty.delete(key));
        try {
            const tx = db.transaction(ZALI_CACHE_STAT_STORE, 'readwrite');
            const store = tx.objectStore(ZALI_CACHE_STAT_STORE);
            keys.forEach(key => {
                const stat = this.cacheStats().get(key);
                if (stat) store.put(stat, key);
            });
            await this.cacheTransactionDone(tx);
        } catch (e) {
            // Неудачная запись — не повод забыть, чем пользовались: счётчики
            // решают, кого вытеснять, и потерянная пачка занижает ценность
            // ровно тех файлов, которые человек и открывал. Возвращаем в
            // дирти-набор и пробуем следующим тиком.
            keys.forEach(key => { if (this.cacheStats().has(key)) dirty.add(key); });
            this.scheduleCacheStatFlush();
            this.trace(`flushCacheStats failed count=${keys.length} reason=${e?.name || e?.message || e}`);
        }
    }

    /**
     * Полезность записи — она же ответ на вопрос «кого выкинуть первым».
     *
     *   полезность = обращения × вес класса / размер в КБ
     *   счёт       = полезность / (1 + возраст обращения в днях)
     *
     * Три свойства, ради которых формула именно такая:
     *   - обращения в числителе: то, чем пользуются, остаётся (прямое
     *     требование — счётчики обращений решают, кого удалить);
     *   - деление на размер: аватарка в 8 КБ с двумя обращениями ценнее
     *     видео в 40 МБ с двумя обращениями, потому что за то же место
     *     помещаются пять тысяч аватарок;
     *   - старение: иначе запись, набравшая обращений полгода назад,
     *     держалась бы вечно и кеш застыл бы на прошлогоднем составе.
     */
    cacheEntryScore(stat, now = Date.now()) {
        const sizeKb = Math.max(1, Number(stat?.s || 0) / 1024);
        const weight = ZALI_CACHE_CLASS_WEIGHT[stat?.g] || 1;
        const hits = Math.max(1, Number(stat?.h || 1));
        const ageDays = Math.max(0, (now - Number(stat?.u || 0)) / 86400000);
        return (hits * weight) / sizeKb / (1 + ageDays);
    }

    /** Записи, отсортированные от наименее полезной к наиболее. */
    cacheEvictionOrder(now = Date.now()) {
        return Array.from(this.cacheStats().values())
            .map(stat => ({ stat, score: this.cacheEntryScore(stat, now) }))
            .sort((a, b) => a.score - b.score);
    }

    /**
     * Освобождает место под `needBytes`, выкидывая наименее полезное.
     *
     * `ignoreLimit` — для случая, когда место кончилось НЕ по нашему потолку, а
     * по квоте браузера. Без него ветка восстановления в cachePut() при
     * выбранном «Без ограничения» не освобождала ничего (потолок Infinity —
     * выходим первой же строкой) и повторяла байт-в-байт ту же запись, которая
     * только что упала: после первого QuotaExceededError кеш переставал
     * принимать что-либо до конца сеанса.
     */
    async cacheEvictFor(needBytes, { ignoreLimit = false } = {}) {
        const limit = this.cacheLimitBytes();
        const used = this.cacheUsedBytes();
        let over;
        if (ignoreLimit || !Number.isFinite(limit)) {
            // Освобождаем ровно столько, сколько попросили: ориентира в виде
            // потолка здесь нет.
            if (!ignoreLimit) return 0;
            over = Number(needBytes || 0);
            if (over <= 0) return 0;
        } else {
            over = (used + Number(needBytes || 0)) - limit;
            if (over <= 0) return 0;
            over += Math.ceil(limit * ZALI_CACHE_EVICT_HEADROOM);
        }

        const doomed = [];
        let freed = 0;
        for (const { stat } of this.cacheEvictionOrder()) {
            if (freed >= over) break;
            doomed.push(stat.k);
            freed += Number(stat.s || 0);
        }
        if (!doomed.length) return 0;
        this.trace(`cacheEvict entries=${doomed.length} freed=${freed} limit=${limit}`);
        await this.cacheDeleteKeys(doomed);
        return freed;
    }

    /**
     * Приводит кеш в соответствие с текущими настройками. Вызывается, когда
     * настройки ужесточили: сначала выкидывается всё, что новый режим больше
     * не пускает (класс записи уже посчитан и лежит в сводке — обходить
     * файлы не нужно), потом добивается потолок.
     */
    async enforceCachePolicy() {
        const db = await this.ensureCacheStorage();
        if (!db) return;
        const mode = this.cacheMode();
        if (mode === 'off') { await this.clearAssetCache(); return; }
        const forbidden = [];
        for (const stat of this.cacheStats().values()) {
            const allowed = mode === 'all'
                || (mode === 'light' && stat.g !== 'bulk')
                || (mode === 'essential' && stat.g === 'essential');
            if (!allowed) forbidden.push(stat.k);
        }
        if (forbidden.length) await this.cacheDeleteKeys(forbidden);
        await this.cacheEvictFor(0);
        this.renderCacheSettings();
    }

    /**
     * Сводка для настроек. Считается по индексу в памяти — ни одного чтения
     * с диска, поэтому её не страшно пересчитывать на каждой отрисовке.
     */
    cacheSummary({ topLimit = 12 } = {}) {
        const now = Date.now();
        const evictionOrder = this.cacheEvictionOrder(now);
        // Всё, что несёт ИМЯ, показывается только по текущему аккаунту. Метка
        // записи — это ключ без префикса, то есть логин собеседника: без
        // фильтра карточка настроек перечисляла бы контакты предыдущего
        // аккаунта на той же машине. Ровно от этого префикс в ключе и заведён
        // (см. cacheEntryKey). Суммарные же цифры остаются общими: место на
        // диске и потолок — device-wide, вытеснение ходит по всем записям, и
        // показать здесь только «свою» долю значило бы соврать о занятом месте.
        const prefix = this.cacheAccountPrefix();
        const isMine = (stat) => String(stat?.k || '').startsWith(prefix);
        const kinds = new Map();
        let hits = 0;
        let bytes = 0;
        const entries = [];
        for (const stat of this.cacheStats().values()) {
            const size = Number(stat.s || 0);
            const hit = Number(stat.h || 0);
            bytes += size;
            hits += hit;
            const bucket = kinds.get(stat.n) || { kind: stat.n, count: 0, bytes: 0, hits: 0 };
            bucket.count += 1;
            bucket.bytes += size;
            bucket.hits += hit;
            kinds.set(stat.n, bucket);
            entries.push(stat);
        }
        const top = entries
            .filter(isMine)
            .sort((a, b) => (Number(b.h || 0) - Number(a.h || 0)) || (Number(b.s || 0) - Number(a.s || 0)))
            .slice(0, Math.max(0, topLimit))
            .map(stat => ({
                key: stat.k,
                kind: stat.n,
                label: this.cacheEntryLabel(stat),
                hits: Number(stat.h || 0),
                size: Number(stat.s || 0),
                lastUsed: Number(stat.u || 0),
                score: this.cacheEntryScore(stat, now),
            }));
        return {
            available: !!this._cacheDb,
            // База открывается лениво, поэтому «ещё не открывали» и «открыть
            // не удалось» — разные состояния. Без этого различия карточка
            // настроек на первом кадре сообщала бы, что кеш не работает,
            // на платформе, где он работает прекрасно.
            probed: !!this._cacheReady,
            reason: this._cacheDisabledReason || '',
            count: entries.length,
            bytes,
            hits,
            limit: this.cacheLimitBytes(),
            mode: this.cacheMode(),
            kinds: Array.from(kinds.values()).sort((a, b) => b.bytes - a.bytes),
            top,
            // Следующий кандидат на вылет — самое понятное объяснение того,
            // как счётчики обращений влияют на кеш.
            nextEvicted: (() => {
                const next = evictionOrder.find(entry => isMine(entry.stat));
                return next ? this.cacheEntryLabel(next.stat) : '';
            })(),
            // Сколько из общего объёма занимают другие аккаунты этого
            // устройства — числом, без имён.
            foreignCount: entries.length - entries.filter(isMine).length,
        };
    }

    /** Человекочитаемое имя записи: ключ без служебного префикса аккаунта. */
    cacheEntryLabel(stat) {
        const key = String(stat?.k || '');
        const parts = key.split('|');
        return parts.length > 2 ? parts.slice(2).join('|') : key;
    }

    /**
     * Короткая метка вида в списке «чаще всего используются». Без неё аватарка
     * bob и карточка профиля bob — две разные записи с одинаковой подписью, и
     * список выглядит так, будто в нём дубликаты.
     */
    cacheEntryKindTag(kind) {
        switch (kind) {
            case 'avatar': return 'ава';
            case 'server_asset': return 'сервер';
            case 'profile': return 'профиль';
            case 'sticker': return 'стикер';
            case 'attachment': return 'файл';
            default: return 'прочее';
        }
    }

    cacheKindLabel(kind) {
        switch (kind) {
            case 'avatar': return 'Аватарки';
            case 'server_asset': return 'Иконки серверов';
            case 'profile': return 'Профили';
            case 'sticker': return 'Стикеры';
            case 'attachment': return 'Вложения';
            default: return String(kind || 'Прочее');
        }
    }

    async clearAssetCache() {
        const db = this._cacheDb || await this.ensureCacheStorage();
        this._cacheDirtyStats?.clear();
        if (db) {
            try {
                const tx = db.transaction([ZALI_CACHE_BLOB_STORE, ZALI_CACHE_STAT_STORE], 'readwrite');
                tx.objectStore(ZALI_CACHE_BLOB_STORE).clear();
                tx.objectStore(ZALI_CACHE_STAT_STORE).clear();
                await this.cacheTransactionDone(tx);
            } catch (e) {
                this.trace(`clearAssetCache failed reason=${e?.name || e?.message || e}`);
            }
        }
        this._cacheStats = new Map();
        this._cacheBytes = 0;
        this.renderCacheSettings();
    }

    /**
     * Полное удаление базы — для сброса локальных данных (localResetEpoch).
     * Отдельно от clearAssetCache(): там база остаётся открытой и рабочей,
     * здесь исчезает вместе со схемой.
     */
    destroyAssetCacheDatabase() {
        try {
            this._cacheDb?.close?.();
        } catch (e) {}
        this._cacheDb = null;
        this._cacheReady = null;
        this._cacheStats = new Map();
        this._cacheBytes = 0;
        try {
            const request = window.indexedDB?.deleteDatabase?.(ZALI_CACHE_DB_NAME);
            // Удаление блокируется, пока другая вкладка держит соединение, и
            // остаётся висеть — а висящее удаление подвешивает ЧУЖИЕ открытия
            // этой базы (см. openCacheDb). Помешать этому отсюда нельзя, но
            // молча такое расследовать невозможно.
            if (request) {
                request.onblocked = () => this.trace('assetCache delete blocked — база открыта в другой вкладке');
            }
        } catch (e) {}
    }

    // ============================================================
    // Преобразования
    // ============================================================

    async toCacheBlob(source, contentType = '') {
        if (!source) return null;
        if (typeof Blob !== 'undefined' && source instanceof Blob) return source;
        if (source instanceof ArrayBuffer) {
            return new Blob([source], { type: contentType || 'application/octet-stream' });
        }
        if (typeof source === 'string') {
            if (source.startsWith('data:')) return this.dataUrlToBlob(source);
            return new Blob([source], { type: contentType || 'text/plain' });
        }
        return null;
    }

    // Blob.arrayBuffer() есть везде, куда мы целимся, но FileReader страхует
    // старые WKWebView — эта ветка дешевле, чем выяснять версию Safari в
    // каждой оболочке.
    blobToArrayBuffer(blob) {
        if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(reader.error || new Error('blob read failed'));
            reader.readAsArrayBuffer(blob);
        });
    }

    // ============================================================
    // Прогрев: ради него всё и затевалось
    // ============================================================

    /**
     * Поднимает аватарки и ассеты серверов с диска в память ДО первой
     * отрисовки. Это и есть ответ на «аватарки требуют подгрузки»: без
     * прогрева каждая из них ждала бы своего ensureAvatarLoaded(), то есть
     * сетевого ответа, и первый экран рисовался бы буквами-заглушками.
     *
     * Один проход, один набор транзакций, и только для текущего аккаунта.
     */
    async primeAssetCacheFromDisk() {
        const prefix = this.cacheAccountPrefix();
        // applySession() зовут на каждом применении сессии, включая повторные
        // с тем же аккаунтом. Прогрев — полный обход индекса, повторять его
        // на каждый вызов незачем: всё, что он поднял, уже в памяти.
        if (this._cachePrimedFor === prefix) return 0;
        const db = await this.ensureCacheReady();
        // Защёлка ставится ПОСЛЕ ответа базы. Раньше она стояла до await'а, и
        // один неудачный проход (открытие упёрлось в таймаут, потому что чужая
        // вкладка держит незавершённый deleteDatabase) навсегда отменял прогрев
        // для этого аккаунта — аватарки весь сеанс шли по сети, хотя база
        // открылась при следующем же cacheGet.
        if (!db) return 0;
        if (this._cachePrimedFor === prefix) return 0;
        this._cachePrimedFor = prefix;
        // Прогреваем самое используемое: если записей больше потолка, буквы
        // получат те, к кому обращаются реже всех.
        const candidates = Array.from(this.cacheStats().values())
            .filter(stat => String(stat.k || '').startsWith(prefix)
                && (stat.n === 'avatar' || stat.n === 'server_asset'))
            .sort((a, b) => Number(b.h || 0) - Number(a.h || 0))
            .slice(0, ZALI_CACHE_PRIME_LIMIT);
        if (!candidates.length) return 0;

        const wanted = candidates.filter(stat => {
            const id = String(stat.k).split('|').slice(2).join('|');
            if (!id) return false;
            return stat.n === 'avatar'
                ? !this.avatarCache.has(this.avatarCacheKey(id))
                : !this.serverAssetCache.has(id);
        });
        const blobs = await this.cacheReadBatch(wanted.map(stat => stat.k));

        let primed = 0;
        const stale = [];
        for (const stat of wanted) {
            const blob = blobs.get(stat.k);
            if (!blob) continue;
            const id = String(stat.k).split('|').slice(2).join('|');
            if (stat.n === 'avatar') {
                this.saveStoredAvatar(id, URL.createObjectURL(blob));
            } else {
                this.serverAssetCache.set(id, URL.createObjectURL(blob));
            }
            if (this.cacheIsStale(stat.n, id)) stale.push(stat);
            primed += 1;
        }
        if (primed) {
            this.trace(`primeAssetCacheFromDisk primed=${primed} stale=${stale.length}`);
            this.scheduleAvatarRefresh();
            this.scheduleServerAssetRefresh();
        }
        // Прогретую запись больше НИКТО не перепроверит, если не сделать этого
        // здесь: прогрев кладёт картинку прямо в avatarCache, после чего
        // loadStoredAvatar() возвращает значение, ensureAvatarLoaded() не
        // вызывается вовсе — а проверка свежести живёт только внутри неё.
        // То есть аватарка, поменянная, пока приложение было закрыто (события
        // avatar_updated не было и не будет), оставалась бы прошлогодней
        // навсегда. Фоновая перепроверка идёт после отрисовки: картинка уже
        // на экране, обновится под рукой.
        if (stale.length) this.revalidateStaleAssets(stale);
        return primed;
    }

    /** Фоновая перепроверка прогретых записей, у которых вышел срок. */
    revalidateStaleAssets(stats) {
        setTimeout(() => {
            for (const stat of stats) {
                const id = String(stat.k).split('|').slice(2).join('|');
                if (!id) continue;
                if (stat.n === 'avatar') {
                    void this.ensureAvatarLoaded(id, { force: true });
                    continue;
                }
                // Ключ ассета сервера — `${serverId}:${kind}`, а kind всегда
                // последний сегмент: id сервера сам может содержать ':'.
                const cut = id.lastIndexOf(':');
                if (cut <= 0) continue;
                void this.loadServerAsset(id.slice(0, cut), id.slice(cut + 1), { force: true });
            }
        }, 0);
    }

    /**
     * Досыпает вложения из кеша в уже загруженную историю. Работает после
     * восстановления истории, а не вместо него: loadStoredMessageCache()
     * синхронный, а диск — нет.
     *
     * Смысл в том, что localStorage перестаёт вмещать вложения задолго до
     * того, как переписка станет большой (см. writeMessageCacheToStorage —
     * там клиент переходит на копию без байтов). Раньше на Windows/iOS/Android
     * это означало «фотографии в истории превращаются в имена файлов
     * навсегда»; теперь байты лежат здесь.
     */
    async hydrateAttachmentPayloadsFromCache() {
        if (this.cacheMode() === 'off') return 0;
        // Обход всей истории — не то, что стоит делать дважды за сеанс на один
        // аккаунт: живая доставка приносит вложения уже с байтами.
        const prefix = this.cacheAccountPrefix();
        if (this._cacheHydratedFor === prefix) return 0;
        const db = await this.ensureCacheReady();
        // Защёлка — после ответа базы, по той же причине, что и в
        // primeAssetCacheFromDisk().
        if (!db) return 0;
        if (this._cacheHydratedFor === prefix) return 0;
        this._cacheHydratedFor = prefix;
        let restored = 0;
        for (const store of [this.S.chats, this.S.serverChats]) {
            for (const msgs of Object.values(store || {})) {
                for (const msg of msgs || []) {
                    const attachments = msg?.attachments || [];
                    if (!attachments.length) continue;
                    for (let index = 0; index < attachments.length; index += 1) {
                        const att = attachments[index];
                        if (!att || att.dataUrl || att.data_url) continue;
                        const id = this.attachmentCacheId(msg, att, index);
                        if (!id) continue;
                        const blob = await this.cacheGet(this.attachmentCacheKind(att), id);
                        if (!blob) continue;
                        att.dataUrl = await this.blobToDataUrl(blob);
                        restored += 1;
                    }
                }
            }
        }
        if (restored) {
            // Мемо normalizeAttachments() ключуется по строкам payload'ов и
            // само заметит подставленные байты — сбрасывать его не нужно.
            this.trace(`hydrateAttachmentPayloadsFromCache restored=${restored}`);
            this.scheduleRenderMessages();
        }
        return restored;
    }

    /**
     * Кладёт вложения в кеш. Идентичность записи — id сообщения + позиция +
     * имя: ровно тот же тройной ключ, по которому restoreAttachmentPayloads()
     * сверяет вложения, потому что отредактированное сообщение может нести
     * под тем же id другой набор файлов.
     */
    attachmentCacheId(msg, att, index) {
        const id = String(msg?.id || msg?.clientId || '').trim();
        if (!id) return '';
        return `${id}#${index}#${String(att?.name || '')}`;
    }

    /**
     * Вид записи для вложения — ОДНА функция на запись и на чтение.
     *
     * Вид входит в ключ (cacheEntryKey), поэтому расхождение здесь не роняет
     * ничего и не пишет в лог: стикер просто ложится под `sticker|…`, а
     * hydrateAttachmentPayloadsFromCache ищет его под `attachment|…` и не
     * находит — стикеры после перезагрузки остаются чипом с именем файла.
     * Вторая половина той же ошибки дороже: проверка «уже лежит» тоже
     * промахивается, поэтому каждый стикер архива переписывался на диск при
     * КАЖДОМ сохранении кеша сообщений — ровно та квадратичная работа на
     * горячем пути, которую эта проверка и должна была убрать.
     */
    attachmentCacheKind(att) {
        return att?.kind === 'sticker' ? 'sticker' : 'attachment';
    }

    /**
     * Сохраняет вложения сообщения. Ничего не читает с диска, чтобы понять,
     * лежит ли файл уже там: индекс сводок в памяти отвечает на это сразу,
     * а без такой проверки каждое сохранение кеша переписывало бы весь архив
     * заново (та самая «квадратичная работа на горячем пути»).
     */
    cacheStoreMessageAttachments(msg) {
        if (this.cacheMode() === 'off') return;
        const attachments = msg?.attachments || [];
        if (!attachments.length) return;
        attachments.forEach((att, index) => {
            const payload = att?.dataUrl || att?.data_url || '';
            if (!payload || !String(payload).startsWith('data:')) return;
            const id = this.attachmentCacheId(msg, att, index);
            if (!id) return;
            const kind = this.attachmentCacheKind(att);
            if (this.cacheStats().has(this.cacheEntryKey(kind, id))) return;
            void this.cachePut(kind, id, payload, { contentType: att.mimeType || '' });
        });
    }

    // Blob.text() — Safari 14+; FileReader страхует старые WKWebView так же,
    // как в blobToArrayBuffer().
    blobToText(blob) {
        if (typeof blob.text === 'function') return blob.text();
        return new Promise((resolve) => {
            try {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => resolve('');
                reader.readAsText(blob);
            } catch (e) {
                resolve('');
            }
        });
    }

    blobToDataUrl(blob) {
        return new Promise((resolve) => {
            try {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ''));
                reader.onerror = () => resolve('');
                reader.readAsDataURL(blob);
            } catch (e) {
                resolve('');
            }
        });
    }

    // ============================================================
    // Отрисовка сводки в настройках
    // ============================================================

    // Сводка меняется на каждой записи в кеш, а карточка настроек чаще всего
    // не открыта. Поэтому перерисовка коалесцируется и сама проверяет, есть
    // ли кому смотреть.
    scheduleCacheSummaryRefresh() {
        if (this._cacheSummaryRefreshTimer) return;
        this._cacheSummaryRefreshTimer = setTimeout(() => {
            this._cacheSummaryRefreshTimer = null;
            // Перерисовка заменяет контейнер целиком, вместе со слайдером. Если
            // его сейчас тащат, новый элемент теряет захват указателя, и
            // значение отскакивает к сохранённому — незавершённый жест просто
            // пропадает. А поводов для перерисовки в этот момент сколько
            // угодно: любая запись в кеш (аватарки ещё догружаются) меняет
            // цифры в сводке, так что защита равенством html не спасает.
            if (this.cacheLimitSliderBusy()) {
                this.scheduleCacheSummaryRefresh();
                return;
            }
            this.renderCacheSettings();
        }, 600);
    }

    /** Тащат ли прямо сейчас слайдер потолка. */
    cacheLimitSliderBusy() {
        if (this._cacheLimitDragging) return true;
        const slider = document.getElementById('inputCacheLimit');
        return !!slider && document.activeElement === slider;
    }

    renderCacheSettings() {
        const host = document.getElementById('cacheSettings');
        if (!host) return;
        const prefs = this.loadCachePrefs();
        const summary = this.cacheSummary();

        const modes = ZaliInterface.cacheModeCatalog.map(mode => `
            <button type="button" class="cache-mode-option${mode.id === prefs.mode ? ' active' : ''}" data-cache-mode="${this.esc(mode.id)}" aria-pressed="${mode.id === prefs.mode}">
                <span class="cache-mode-copy">
                    <strong>${this.esc(mode.label)}</strong>
                    <small>${this.esc(mode.hint)}</small>
                </span>
                <span class="cache-mode-note">${this.esc(mode.note)}</span>
            </button>
        `).join('');

        const stops = ZaliInterface.cacheLimitStops
            .map((stop, index) => `<option value="${index}" label="${this.esc(stop.label)}"></option>`)
            .join('');

        const limitLabel = this.cacheLimitLabel();
        const usedLabel = this.formatFileSize(summary.bytes);
        const fill = Number.isFinite(summary.limit) && summary.limit > 0
            ? Math.min(100, Math.round((summary.bytes / summary.limit) * 100))
            : 0;

        const kinds = summary.kinds.length
            ? summary.kinds.map(bucket => `
                <li class="cache-kind-row">
                    <span class="cache-kind-name">${this.esc(this.cacheKindLabel(bucket.kind))}</span>
                    <span class="cache-kind-meta">${bucket.count} шт · ${this.esc(this.formatFileSize(bucket.bytes))} · ${bucket.hits} обр.</span>
                </li>
            `).join('')
            : '<li class="cache-kind-row cache-kind-row--empty">Кеш пуст</li>';

        const top = summary.top.length
            ? summary.top.map(entry => `
                <li class="cache-top-row">
                    <span class="cache-top-name" title="${this.esc(`${this.cacheKindLabel(entry.kind)}: ${entry.label}`)}"><span class="cache-top-kind">${this.esc(this.cacheEntryKindTag(entry.kind))}</span>${this.esc(entry.label)}</span>
                    <span class="cache-top-hits">${entry.hits}×</span>
                    <span class="cache-top-size">${this.esc(this.formatFileSize(entry.size))}</span>
                </li>
            `).join('')
            : '<li class="cache-top-row cache-top-row--empty">Обращений пока не было</li>';

        let status;
        if (summary.reason && !summary.available) {
            status = `Постоянный кеш недоступен: ${this.esc(summary.reason)}. Ассеты живут только до перезагрузки.`;
        } else if (prefs.mode === 'off') {
            status = 'Кеширование выключено — ассеты подгружаются заново при каждом открытии.';
        } else if (!summary.probed) {
            status = 'Кеш ещё не открывался в этом сеансе — сводка появится после первого обращения.';
        } else {
            const foreign = summary.foreignCount
                ? ` · из них ${summary.foreignCount} от других аккаунтов на этом устройстве`
                : '';
            status = `Занято ${this.esc(usedLabel)} из ${this.esc(limitLabel)} · ${summary.count} файлов · ${summary.hits} обращений${this.esc(foreign)}`;
        }

        const nextOut = summary.nextEvicted && prefs.mode !== 'off'
            ? `<p class="settings-help">Следующим освободит место: <code>${this.esc(summary.nextEvicted)}</code> — реже всего используется относительно своего размера.</p>`
            : '';

        const html = `
            <div class="cache-mode-options">${modes}</div>
            <label class="settings-field cache-limit-field">
                <span>Потолок кеша: <strong id="cacheLimitValue">${this.esc(limitLabel)}</strong></span>
                <input type="range" min="0" max="${ZaliInterface.cacheLimitStops.length - 1}" step="1" value="${prefs.limitIndex}" id="inputCacheLimit" class="settings-range" list="cacheLimitStops">
                <datalist id="cacheLimitStops">${stops}</datalist>
            </label>
            <div class="cache-usage-bar" role="presentation"><span style="width:${fill}%"></span></div>
            <p class="settings-help cache-usage-status">${status}</p>
            ${nextOut}
            <div class="cache-summary-grid">
                <div class="cache-summary-block">
                    <span class="settings-kicker">По типам</span>
                    <ul class="cache-kind-list">${kinds}</ul>
                </div>
                <div class="cache-summary-block">
                    <span class="settings-kicker">Чаще всего используются</span>
                    <ul class="cache-top-list">${top}</ul>
                </div>
            </div>
            <button class="btn-flat" id="cacheClearBtn" type="button">Очистить кеш</button>
        `;
        if (host.innerHTML !== html) host.innerHTML = html;
    }
});
