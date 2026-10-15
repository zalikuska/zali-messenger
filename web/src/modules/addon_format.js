// @ts-check
// --- window.ZaliAddonFormat: файл аддона хаба (.zali с магиком ZALIEXTN). ---
//
// Контейнер тот же, что у архивов сообщений (sdk/Rust ZaliSession, sdk/Swift
// ZaliArc), другой только магик, и шифрование запрещено: аддон должен читаться
// ДО установки, чтобы показать пользователю, что он просит. Здесь — разбор и
// проверка файла и манифеста, каталог разрешений и сборка (для тестов и
// упаковщика). Без DOM и без состояния: модуль грузят и харнессы в Node.
// Дизайн: /docs/ADDONS.md. Упаковщик: scripts/addon_pack.py.
//
// Раскладка (little-endian):
//   "ZALIEXTN" | u8 version=1 | u8 len + id | u8 len + dom | u8 flags=0 | u32 count
//   count × ( u16 nameLen | name | u64 size | u64 stored(=size) | данные )
(function () {
    'use strict';

    const MAGIC = 'ZALIEXTN';
    const FORMAT_VERSION = 1;
    const MANIFEST_PATH = 'manifest.json';
    const LIMITS = Object.freeze({
        fileBytes: 32 * 1024 * 1024,
        entries: 2000,
        manifestBytes: 64 * 1024,
        // Фон плашки аддона на главной хаба (manifest.background).
        backgroundBytes: 512 * 1024,
        signatureBytes: 16 * 1024,
        pathBytes: 255,
        storageBytes: 1024 * 1024,
        cacheBytes: 256 * 1024 * 1024,
        // Облако ZaliMessenger (server/src/addon_cloud.rs): пул аддона у всех
        // пользователей вместе и доля одного человека в нём.
        cloudBytes: 10 * 1024 * 1024,
        cloudUserBytes: 1024 * 1024,
        networkHosts: 16,
        backendArgs: 32,
    });

    const ID_RE = /^[a-z0-9][a-z0-9._-]{2,63}$/;
    const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
    const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
    const HOST_RE = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$/;
    const CONTROL_RE = /[\u0000-\u001f\u007f]/;

    // Файл подписи внутри контейнера и ключ официальной подписи. Приватная часть
    // ключа лежит вне репозитория (ops/keys/) и есть только у закрытого инструмента
    // разработчиков; тот же публичный ключ зашит в server/src/addons.rs.
    const SIGNATURE_PATH = 'zali-signature.json';
    const OFFICIAL_PUBLIC_KEY = 'BDUcWsKrt/KoOeUnExrEScgAqUD3JEPCDLS5OqWmER0pm+FXwhzClXxkEh0KG4WdLkm9czOJXgXSuMuYlOcrMWw=';
    const SIGNATURE_VERSION = 1;
    // Сколько суток взнос лежит в казне аддона, прежде чем автор сможет его вывести.
    const COIN_HOLD_DAYS = 7;

    // Ключи платформ в manifest.backend.commands. Оболочка выбирает свой.
    const BACKEND_PLATFORMS = Object.freeze(['macos-arm64', 'macos-x64', 'windows-x64', 'windows-arm64']);

    /**
     * Каталог разрешений. Порядок — порядок показа в диалоге установки.
     * `normal` перечисляются при установке; `elevated` подтверждает ещё и
     * система — при установке и при каждом запуске (только macOS и Windows).
     */
    const PERMISSIONS = Object.freeze({
        cache: { level: 'normal', title: 'Кеш приложения', description: 'Хранить свои файлы в кеше приложения, до 256 МБ.' },
        notifications: { level: 'normal', title: 'Уведомления', description: 'Показывать уведомления от своего имени.' },
        clipboard: { level: 'normal', title: 'Буфер обмена', description: 'Копировать текст в буфер обмена.' },
        files: { level: 'normal', title: 'Сохранение файлов', description: 'Сохранять файлы на компьютер через загрузки.' },
        microphone: { level: 'normal', title: 'Микрофон', description: 'Записывать звук с микрофона, пока аддон открыт.' },
        network: { level: 'normal', title: 'Интернет', description: 'Обмениваться данными с сайтами из списка.' },
        cloud: { level: 'normal', title: 'Облако ZaliMessenger', description: 'Хранить данные аддона на серверах ZaliMessenger (до 10 МБ на весь аддон) для синхронизации между устройствами и людьми. Автор аддона может прочитать то, что аддон сохранит о вас. Только для подписанных аддонов.' },
        coins: { level: 'normal', title: 'ZaliCoin', description: 'Видеть ваш баланс, предлагать перевести монеты на баланс аддона (каждый перевод — только после вашего подтверждения) и возвращать вам ваши монеты.' },
        'network.any': { level: 'elevated', title: 'Любые серверы в интернете', description: 'Обращаться к любым серверам, в том числе к тем, адрес которых вы укажете сами, и передавать им данные аддона.' },
        'fs.read': { level: 'elevated', title: 'Чтение файлов на всём диске', description: 'Читать любые файлы и папки компьютера.' },
        'fs.write': { level: 'elevated', title: 'Запись файлов на всём диске', description: 'Создавать, менять и удалять любые файлы компьютера.' },
        launch: { level: 'elevated', title: 'Запуск программ', description: 'Открывать файлы и запускать программы компьютера.' },
        process: { level: 'elevated', title: 'Собственная программа', description: 'Запускать свою программу с вашими правами.' },
    });

    const MIME_BY_EXT = Object.freeze({
        html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript',
        css: 'text/css', json: 'application/json', txt: 'text/plain', md: 'text/markdown',
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
        webp: 'image/webp', svg: 'image/svg+xml', ico: 'image/x-icon', avif: 'image/avif',
        mp3: 'audio/mpeg', ogg: 'audio/ogg', oga: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
        weba: 'audio/webm', mp4: 'video/mp4', webm: 'video/webm',
        woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
        wasm: 'application/wasm',
    });
    const ICON_EXTS = Object.freeze(['png', 'svg', 'webp', 'jpg', 'jpeg']);

    class AddonFormatError extends Error {
        /** @param {string} message */
        constructor(message) {
            super(message);
            this.name = 'AddonFormatError';
        }
    }

    const fail = (message) => { throw new AddonFormatError(message); };

    /** @param {any} input @returns {Uint8Array} */
    function toBytes(input) {
        if (input instanceof Uint8Array) return input;
        if (input instanceof ArrayBuffer) return new Uint8Array(input);
        if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        return fail('Нужны байты файла.');
    }

    const utf8Strict = new TextDecoder('utf-8', { fatal: true });
    const utf8Encoder = new TextEncoder();

    /** @param {Uint8Array} bytes */
    function decodeUtf8(bytes, what) {
        try {
            return utf8Strict.decode(bytes);
        } catch (e) {
            return fail(`${what}: не UTF-8.`);
        }
    }

    function extOf(path) {
        const name = String(path || '').split('/').pop() || '';
        const dot = name.lastIndexOf('.');
        return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
    }

    function mimeForPath(path) {
        return MIME_BY_EXT[extOf(path)] || 'application/octet-stream';
    }

    /**
     * Путь внутри архива: сегменты [A-Za-z0-9._-] через «/». Те же правила
     * проверяют нативные оболочки, когда распаковывают bin/ на диск, — путь
     * не должен суметь выйти из папки аддона ни на одной файловой системе.
     * @returns {string} текст ошибки или '' если путь годится
     */
    function pathError(path) {
        const value = String(path ?? '');
        if (!value) return 'пустой путь';
        if (utf8Encoder.encode(value).length > LIMITS.pathBytes) return 'путь длиннее 255 байт';
        if (value.startsWith('/') || value.endsWith('/')) return 'путь начинается или кончается «/»';
        for (const segment of value.split('/')) {
            if (!segment) return 'пустой сегмент пути';
            if (segment === '.' || segment === '..') return 'сегмент «.» или «..»';
            if (!SEGMENT_RE.test(segment)) return 'недопустимые символы в пути';
        }
        return '';
    }

    function readU32(view, offset) { return view.getUint32(offset, true); }

    // u64 без BigInt (WKWebView старых macOS): старшая половина у файлов до 32 МБ
    // обязана быть нулём.
    function readU64(view, offset) {
        const lo = view.getUint32(offset, true);
        const hi = view.getUint32(offset + 4, true);
        return hi === 0 ? lo : Number.POSITIVE_INFINITY;
    }

    /**
     * Разбирает контейнер. Данные записей — подмассивы исходного буфера, без копий.
     * @param {ArrayBuffer|Uint8Array} input
     * @returns {{headerId: string, files: Map<string, Uint8Array>}}
     */
    function parseContainer(input) {
        const bytes = toBytes(input);
        if (bytes.length > LIMITS.fileBytes) fail('Файл больше 32 МБ.');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 0;
        const need = (count) => {
            if (offset + count > bytes.length) fail('Файл обрезан.');
        };

        need(8);
        let magic = '';
        for (let i = 0; i < 8; i += 1) magic += String.fromCharCode(bytes[i]);
        if (magic !== MAGIC) {
            fail(magic.startsWith('ZALI') ? `Это не аддон, а файл ${magic}.` : 'Это не файл аддона ZaliMessenger.');
        }
        offset = 8;
        need(1);
        const version = bytes[offset];
        offset += 1;
        if (version !== FORMAT_VERSION) fail(`Версия формата ${version} не поддерживается — обновите приложение.`);

        const readShortString = (what) => {
            need(1);
            const len = bytes[offset];
            offset += 1;
            need(len);
            const value = decodeUtf8(bytes.subarray(offset, offset + len), what);
            offset += len;
            return value;
        };
        const headerId = readShortString('Заголовок');
        readShortString('Заголовок');

        need(1);
        const flags = bytes[offset];
        offset += 1;
        if (flags !== 0) fail('Файл аддона зашифрован — так нельзя: его нужно проверить до установки.');

        need(4);
        const count = readU32(view, offset);
        offset += 4;
        if (count > LIMITS.entries) fail(`В файле больше ${LIMITS.entries} записей.`);

        /** @type {Map<string, Uint8Array>} */
        const files = new Map();
        const seen = new Set();
        for (let i = 0; i < count; i += 1) {
            need(2);
            const nameLen = view.getUint16(offset, true);
            offset += 2;
            need(nameLen);
            const name = decodeUtf8(bytes.subarray(offset, offset + nameLen), 'Имя файла');
            offset += nameLen;
            const problem = pathError(name);
            if (problem) fail(`Файл «${name.slice(0, 80)}»: ${problem}.`);
            const folded = name.toLowerCase();
            if (seen.has(folded)) fail(`Файл «${name}» встречается дважды.`);
            seen.add(folded);

            need(16);
            const size = readU64(view, offset);
            const stored = readU64(view, offset + 8);
            offset += 16;
            if (stored !== size) fail(`Файл «${name}»: размеры не сходятся.`);
            need(size);
            files.set(name, bytes.subarray(offset, offset + size));
            offset += size;
        }
        if (offset !== bytes.length) fail('После последнего файла лишние данные.');
        return { headerId, files };
    }

    function optionalText(value, field, max) {
        if (value === undefined || value === null) return '';
        if (typeof value !== 'string') fail(`Манифест: «${field}» должно быть строкой.`);
        const text = value.trim();
        if (text.length > max) fail(`Манифест: «${field}» длиннее ${max} символов.`);
        if (CONTROL_RE.test(text.replace(/\n/g, ''))) fail(`Манифест: «${field}» содержит управляющие символы.`);
        return text;
    }

    function requiredText(value, field, max) {
        const text = optionalText(value, field, max);
        if (!text) fail(`Манифест: нет «${field}».`);
        return text;
    }

    function fileRef(value, field, files) {
        if (typeof value !== 'string') fail(`Манифест: «${field}» должно быть путём к файлу.`);
        const problem = pathError(value);
        if (problem) fail(`Манифест: «${field}»: ${problem}.`);
        if (!files.has(value)) fail(`Манифест: «${field}» ссылается на «${value}», а его нет в файле.`);
        return value;
    }

    /**
     * Проверяет и нормализует manifest.json. Неизвестные поля пропускаются
     * (на будущее), неизвестные разрешения — нет: старое приложение не должно
     * молча выдать аддону меньше, чем он рассчитывал, или не то.
     * @param {Map<string, Uint8Array>} files
     */
    function parseManifest(files) {
        const raw = files.get(MANIFEST_PATH);
        if (!raw) fail('В файле нет manifest.json.');
        if (raw.length > LIMITS.manifestBytes) fail('manifest.json больше 64 КБ.');
        let data;
        try {
            data = JSON.parse(decodeUtf8(raw, 'manifest.json'));
        } catch (e) {
            if (e instanceof AddonFormatError) throw e;
            fail('manifest.json — не JSON.');
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail('manifest.json должен быть объектом.');
        if (data.zaliAddon !== 1) fail('Манифест: нужно "zaliAddon": 1.');

        const id = requiredText(data.id, 'id', 64);
        if (!ID_RE.test(id) || id.includes('..')) {
            fail('Манифест: id — от 3 до 64 символов a-z, 0-9, «.», «_», «-», начинается с буквы или цифры.');
        }
        const name = requiredText(data.name, 'name', 64);
        const version = requiredText(data.version, 'version', 32);
        if (!VERSION_RE.test(version)) fail('Манифест: version — например 1.0.0.');
        const description = optionalText(data.description, 'description', 300);
        const author = optionalText(data.author, 'author', 80);

        const entry = fileRef(data.entry ?? 'index.html', 'entry', files);
        if (!['html', 'htm'].includes(extOf(entry))) fail('Манифест: entry должен быть .html.');

        let icon = '';
        if (data.icon !== undefined && data.icon !== null && data.icon !== '') {
            icon = fileRef(data.icon, 'icon', files);
            if (!ICON_EXTS.includes(extOf(icon))) fail('Манифест: icon — png, svg, webp или jpeg.');
        }

        // Фон плашки аддона на главной хаба: картинка во всю ширину плашки.
        let background = '';
        if (data.background !== undefined && data.background !== null && data.background !== '') {
            background = fileRef(data.background, 'background', files);
            if (!ICON_EXTS.includes(extOf(background))) fail('Манифест: background — png, svg, webp или jpeg.');
            if (files.get(background).length > LIMITS.backgroundBytes) fail('Манифест: background больше 512 КБ.');
        }

        const permissionsRaw = data.permissions ?? [];
        if (!Array.isArray(permissionsRaw)) fail('Манифест: permissions должен быть списком.');
        const permissions = [];
        for (const item of permissionsRaw) {
            const key = String(item);
            if (!Object.prototype.hasOwnProperty.call(PERMISSIONS, key)) {
                fail(`Манифест: неизвестное разрешение «${key.slice(0, 40)}». Возможно, нужно обновить приложение.`);
            }
            if (!permissions.includes(key)) permissions.push(key);
        }
        // Порядок каталога — порядок показа.
        permissions.sort((a, b) => Object.keys(PERMISSIONS).indexOf(a) - Object.keys(PERMISSIONS).indexOf(b));

        const network = [];
        if (data.network !== undefined && data.network !== null) {
            if (!Array.isArray(data.network)) fail('Манифест: network должен быть списком хостов.');
            for (const item of data.network) {
                const host = String(item || '').trim().toLowerCase();
                if (!HOST_RE.test(host)) fail(`Манифест: «${host.slice(0, 80)}» — не имя хоста (без схемы и пути).`);
                if (!network.includes(host)) network.push(host);
            }
            if (network.length > LIMITS.networkHosts) fail(`Манифест: в network больше ${LIMITS.networkHosts} хостов.`);
        }
        if (network.length && !permissions.includes('network')) fail('Манифест: network указан без разрешения «network».');
        if (permissions.includes('network') && !network.length) fail('Манифест: разрешение «network» без списка хостов в network.');
        // «network.any» снимает потребность в списке: аддон ходит на любые серверы.
        // Лишний список рядом с ним не ошибка, но смысла не имеет.

        let backend = null;
        if (data.backend !== undefined && data.backend !== null) {
            const b = data.backend;
            if (typeof b !== 'object' || Array.isArray(b)) fail('Манифест: backend должен быть объектом.');
            if (b.type !== 'process') fail('Манифест: backend.type — только "process".');
            if (!permissions.includes('process')) fail('Манифест: backend без разрешения «process».');
            const commandsRaw = b.commands;
            if (!commandsRaw || typeof commandsRaw !== 'object' || Array.isArray(commandsRaw)) {
                fail('Манифест: backend.commands — объект «платформа → путь».');
            }
            /** @type {Record<string, string>} */
            const commands = {};
            for (const [platform, path] of Object.entries(commandsRaw)) {
                if (!BACKEND_PLATFORMS.includes(platform)) {
                    fail(`Манифест: платформа «${platform.slice(0, 40)}» в backend.commands не поддерживается.`);
                }
                commands[platform] = fileRef(path, `backend.commands.${platform}`, files);
            }
            if (!Object.keys(commands).length) fail('Манифест: backend.commands пуст.');
            const argsRaw = b.args ?? [];
            if (!Array.isArray(argsRaw) || argsRaw.length > LIMITS.backendArgs) {
                fail(`Манифест: backend.args — список до ${LIMITS.backendArgs} строк.`);
            }
            const args = argsRaw.map((arg, i) => {
                if (typeof arg !== 'string' || arg.length > 256 || arg.includes('\u0000')) {
                    fail(`Манифест: backend.args[${i}] — строка до 256 символов.`);
                }
                return arg;
            });
            backend = { type: 'process', commands, args };
        }
        if (permissions.includes('process') && !backend) fail('Манифест: разрешение «process» без backend.');

        return { zaliAddon: 1, id, name, version, description, author, entry, icon, background, permissions, network, backend };
    }

    async function sha256Hex(bytes) {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) return '';
        const digest = await subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Полная проверка файла перед установкой.
     * @param {ArrayBuffer|Uint8Array} input
     */
    async function inspect(input, keys = {}) {
        const bytes = toBytes(input);
        const { files } = parseContainer(bytes);
        const manifest = parseManifest(files);
        const sha256 = await sha256Hex(bytes);
        const signature = await verifySignature(files, manifest, keys);
        return { bytes, files, manifest, sha256, size: bytes.length, signature };
    }

    /**
     * Собирает файл аддона. Зовут упаковщик хаба (interface/addons_pack.js: ZIP →
     * .zali), подпись (withSignature) и тесты.
     * @param {Array<[string, Uint8Array|string]>} entries
     * @param {{id?: string}} [options]
     */
    function build(entries, options = {}) {
        const encoded = entries.map(([name, data]) => {
            const problem = pathError(name);
            if (problem) fail(`«${name}»: ${problem}.`);
            return [utf8Encoder.encode(name), typeof data === 'string' ? utf8Encoder.encode(data) : toBytes(data)];
        });
        const id = utf8Encoder.encode(String(options.id || '')).subarray(0, 255);
        const dom = utf8Encoder.encode('addon');
        let total = 8 + 1 + 1 + id.length + 1 + dom.length + 1 + 4;
        for (const [name, data] of encoded) total += 2 + name.length + 16 + data.length;
        const out = new Uint8Array(total);
        const view = new DataView(out.buffer);
        let offset = 0;
        for (let i = 0; i < 8; i += 1) out[offset++] = MAGIC.charCodeAt(i);
        out[offset++] = FORMAT_VERSION;
        out[offset++] = id.length; out.set(id, offset); offset += id.length;
        out[offset++] = dom.length; out.set(dom, offset); offset += dom.length;
        out[offset++] = 0;
        view.setUint32(offset, encoded.length, true); offset += 4;
        for (const [name, data] of encoded) {
            view.setUint16(offset, name.length, true); offset += 2;
            out.set(name, offset); offset += name.length;
            view.setUint32(offset, data.length, true); view.setUint32(offset + 4, 0, true); offset += 8;
            view.setUint32(offset, data.length, true); view.setUint32(offset + 4, 0, true); offset += 8;
            out.set(data, offset); offset += data.length;
        }
        return out;
    }

    // ---- Подпись ----
    //
    // Файл подписи — обычная запись контейнера `zali-signature.json`:
    //   {zaliSignature:1, kind:'self'|'official', alg:'ES256', publicKey, id,
    //    version, owner, digest, signedAt, signature}
    // `digest` — отпечаток содержимого (все записи, кроме самой подписи), так что
    // подписанный файл меняется только добавлением подписи. Подписывается
    // сообщение `signatureMessage(...)` — его же собирают сервер (addons.rs) и
    // инструмент подписи (scripts/addon_sign.py). ES256 — «сырая» подпись r‖s.

    const hexOf = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

    function bytesFromBase64(value) {
        const binary = atob(String(value || ''));
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
        return out;
    }

    function signatureMessage(kind, id, version, owner, digest, signedAt) {
        return `zali-addon-sig:v1\n${kind}\n${id}\n${version}\n${owner}\n${digest}\n${signedAt}`;
    }

    /**
     * Отпечаток содержимого: SHA-256 от `zali-addon-content:v1\n` и записей,
     * отсортированных по пути, — по каждой u32be(len path) · path · u64be(len
     * data) · data. Файл подписи в него не входит.
     * @param {Map<string, Uint8Array>} files
     */
    async function contentDigest(files) {
        const names = Array.from(files.keys()).filter((name) => name !== SIGNATURE_PATH).sort();
        const header = utf8Encoder.encode('zali-addon-content:v1\n');
        const parts = [header];
        let total = header.length;
        for (const name of names) {
            const nameBytes = utf8Encoder.encode(name);
            const data = files.get(name);
            const head = new Uint8Array(4 + nameBytes.length + 8);
            const view = new DataView(head.buffer);
            view.setUint32(0, nameBytes.length, false);
            head.set(nameBytes, 4);
            view.setUint32(4 + nameBytes.length, 0, false);
            view.setUint32(8 + nameBytes.length, data.length, false);
            parts.push(head, data);
            total += head.length + data.length;
        }
        const all = new Uint8Array(total);
        let offset = 0;
        for (const part of parts) { all.set(part, offset); offset += part.length; }
        return await sha256Hex(all);
    }

    async function fingerprintOfKey(publicKeyBase64) {
        try {
            return await sha256Hex(bytesFromBase64(publicKeyBase64));
        } catch (e) {
            return '';
        }
    }

    /** Разбор файла подписи без проверки подлинности. null — подписи нет. */
    function readSignature(files) {
        const raw = files.get(SIGNATURE_PATH);
        if (!raw) return null;
        if (raw.length > LIMITS.signatureBytes) fail('zali-signature.json больше 16 КБ.');
        let data;
        try {
            data = JSON.parse(decodeUtf8(raw, SIGNATURE_PATH));
        } catch (e) {
            if (e instanceof AddonFormatError) throw e;
            fail('zali-signature.json — не JSON.');
        }
        if (!data || typeof data !== 'object' || Array.isArray(data)) fail('zali-signature.json должен быть объектом.');
        return data;
    }

    /**
     * Проверяет подпись файла.
     *
     * Состояния:
     *  - `none`       — подписи нет;
     *  - `official`   — подписано ключом разработчиков ZaliMessenger;
     *  - `self`       — подписано серверным ключом «свободной» подписи: автор
     *                   известен, но это не поручительство за аддон;
     *  - `unverified` — похоже на самоподпись, но ключа сервера у нас нет или он
     *                   чужой (файл подписан другим сервером);
     *  - `invalid`    — подпись есть, но не сходится: файл изменили после
     *                   подписания, или подпись повреждена.
     *
     * @param {Map<string, Uint8Array>} files
     * @param {{id: string, version: string}} manifest
     * @param {{selfPublicKey?: string}} [keys]
     */
    async function verifySignature(files, manifest, keys = {}) {
        let sig;
        try {
            sig = readSignature(files);
        } catch (error) {
            return { state: 'invalid', reason: error.message };
        }
        if (!sig) return { state: 'none' };
        const invalid = (reason) => ({ state: 'invalid', reason, kind: String(sig.kind || ''), owner: String(sig.owner || '') });
        if (sig.zaliSignature !== SIGNATURE_VERSION) return invalid('неизвестная версия подписи');
        if (sig.alg !== 'ES256') return invalid('неизвестный алгоритм подписи');
        const kind = String(sig.kind || '');
        if (kind !== 'self' && kind !== 'official') return invalid('неизвестный вид подписи');
        if (sig.id !== manifest.id) return invalid('подпись выдана другому аддону');
        if (sig.version !== manifest.version) return invalid('подпись выдана для другой версии');
        const owner = String(sig.owner || '');
        if (!owner || owner.length > 64) return invalid('в подписи нет автора');
        const digest = await contentDigest(files);
        if (sig.digest !== digest) return invalid('файл изменён после подписания');

        let publicKeyBytes;
        let signatureBytes;
        try {
            publicKeyBytes = bytesFromBase64(sig.publicKey);
            signatureBytes = bytesFromBase64(sig.signature);
        } catch (e) {
            return invalid('подпись повреждена');
        }
        const fingerprint = await sha256Hex(publicKeyBytes);

        if (kind === 'official') {
            if (sig.publicKey !== OFFICIAL_PUBLIC_KEY) return invalid('подпись сделана не официальным ключом');
        } else if (!keys.selfPublicKey || sig.publicKey !== keys.selfPublicKey) {
            return { state: 'unverified', kind, owner, fingerprint, signedAt: Number(sig.signedAt) || 0, reason: keys.selfPublicKey ? 'файл подписан ключом другого сервера' : 'ключ проверки подписей недоступен' };
        }
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) return { state: 'unverified', kind, owner, fingerprint, reason: 'проверка подписей недоступна в этом окружении' };
        let ok = false;
        try {
            const key = await subtle.importKey('raw', publicKeyBytes, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            const message = utf8Encoder.encode(signatureMessage(kind, sig.id, sig.version, owner, digest, sig.signedAt));
            ok = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, message);
        } catch (e) {
            ok = false;
        }
        if (!ok) return invalid('подпись не сходится');
        return { state: kind, kind, owner, fingerprint, signedAt: Number(sig.signedAt) || 0, digest };
    }

    /**
     * Подпись произвольного сообщения официальным ключом разработчиков (ES256,
     * r‖s в base64). Так проверяется подпись релиза приложения (updates.js):
     * ключ тот же, что у официальных аддонов, а сообщения не пересекаются — у
     * каждого свой префикс (`zali-addon-sig:v1` / `zali-release-sig:v1`).
     * `publicKey` нужен только тестам.
     * @param {string} message
     * @param {string} signatureBase64
     * @param {string} [publicKey]
     * @returns {Promise<boolean>}
     */
    async function verifyOfficialMessage(message, signatureBase64, publicKey = OFFICIAL_PUBLIC_KEY) {
        const subtle = globalThis.crypto?.subtle;
        if (!subtle) return false;
        try {
            const signatureBytes = bytesFromBase64(signatureBase64);
            if (signatureBytes.length !== 64) return false;
            const key = await subtle.importKey('raw', bytesFromBase64(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            return !!(await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signatureBytes, utf8Encoder.encode(String(message))));
        } catch (e) {
            return false;
        }
    }

    /**
     * Возвращает файл аддона с (новой) подписью. Остальные записи — как были, так
     * что отпечаток содержимого не меняется.
     * @param {ArrayBuffer|Uint8Array} input
     * @param {object} signature
     */
    function withSignature(input, signature) {
        const { headerId, files } = parseContainer(input);
        const entries = [];
        for (const [name, data] of files) {
            if (name !== SIGNATURE_PATH) entries.push([name, data]);
        }
        entries.push([SIGNATURE_PATH, JSON.stringify(signature)]);
        return build(entries, { id: headerId });
    }

    const permissionInfo = (id) => PERMISSIONS[id] || null;
    const isElevated = (id) => PERMISSIONS[id]?.level === 'elevated';

    window.ZaliAddonFormat = Object.freeze({
        MAGIC,
        FORMAT_VERSION,
        MANIFEST_PATH,
        LIMITS,
        SIGNATURE_PATH,
        OFFICIAL_PUBLIC_KEY,
        COIN_HOLD_DAYS,
        PERMISSIONS,
        BACKEND_PLATFORMS,
        AddonFormatError,
        pathError,
        mimeForPath,
        extOf,
        parseContainer,
        parseManifest,
        inspect,
        build,
        sha256Hex,
        contentDigest,
        fingerprintOfKey,
        signatureMessage,
        readSignature,
        verifySignature,
        verifyOfficialMessage,
        withSignature,
        permissionInfo,
        isElevated,
    });
})();
