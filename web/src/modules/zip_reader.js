// --- window.ZaliZip: чтение ZIP-архива в браузере/WebView без зависимостей. ---
//
// Нужен упаковщику аддонов (interface/addons_pack.js): автор отдаёт ZIP с
// исходниками, приложение собирает из него `.zali`. Читает центральный каталог,
// поддерживает методы «stored» и «deflate» (через DecompressionStream). ZIP64,
// шифрование и многотомные архивы отклоняются с понятным сообщением.
//
// Пределы защищают от «бомбы»: объявленный размер проверяется до распаковки, а
// сама распаковка прерывается, как только данных больше объявленного.
(function () {
    'use strict';

    const LIMITS = Object.freeze({
        entries: 4000,
        fileBytes: 32 * 1024 * 1024,
        totalBytes: 64 * 1024 * 1024,
    });

    class ZipError extends Error {
        constructor(message) {
            super(message);
            this.name = 'ZipError';
        }
    }

    const fail = (message) => { throw new ZipError(message); };
    const decoder = new TextDecoder('utf-8');

    async function inflateRaw(bytes, expected) {
        if (typeof DecompressionStream !== 'function') {
            fail('Этот движок не умеет распаковывать ZIP. Обновите приложение или упакуйте архив без сжатия.');
        }
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
        const reader = stream.getReader();
        const chunks = [];
        let total = 0;
        for (;;) {
            let step;
            try {
                step = await reader.read();
            } catch (e) {
                fail('Архив повреждён: не удалось распаковать файл.');
            }
            if (step.done) break;
            total += step.value.length;
            if (total > expected) {
                try { await reader.cancel(); } catch (e) { /* уже закрыт */ }
                fail('Архив повреждён: размер файла больше заявленного.');
            }
            chunks.push(step.value);
        }
        if (total !== expected) fail('Архив повреждён: размер файла не совпал с каталогом.');
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
        return out;
    }

    /**
     * @param {ArrayBuffer|Uint8Array} input
     * @returns {Promise<Array<{name: string, data: Uint8Array}>>} файлы в порядке каталога
     */
    async function read(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (bytes.length < 22) fail('Это не ZIP-архив.');

        let eocd = -1;
        const lowest = Math.max(0, bytes.length - 22 - 0xffff);
        for (let i = bytes.length - 22; i >= lowest; i -= 1) {
            if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
        }
        if (eocd < 0) fail('Это не ZIP-архив: не найден каталог.');

        const count = view.getUint16(eocd + 10, true);
        const cdOffset = view.getUint32(eocd + 16, true);
        if (count === 0xffff || cdOffset === 0xffffffff || view.getUint32(eocd + 12, true) === 0xffffffff) {
            fail('ZIP64 не поддерживается: архив слишком большой для аддона.');
        }
        if (count > LIMITS.entries) fail(`В архиве больше ${LIMITS.entries} записей.`);

        const files = [];
        let totalBytes = 0;
        let cursor = cdOffset;
        for (let n = 0; n < count; n += 1) {
            if (cursor + 46 > bytes.length || view.getUint32(cursor, true) !== 0x02014b50) {
                fail('Архив повреждён: каталог записей не читается.');
            }
            const flags = view.getUint16(cursor + 8, true);
            const method = view.getUint16(cursor + 10, true);
            const compressed = view.getUint32(cursor + 20, true);
            const size = view.getUint32(cursor + 24, true);
            const nameLen = view.getUint16(cursor + 28, true);
            const extraLen = view.getUint16(cursor + 30, true);
            const commentLen = view.getUint16(cursor + 32, true);
            const localOffset = view.getUint32(cursor + 42, true);
            const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLen);
            cursor += 46 + nameLen + extraLen + commentLen;

            const name = decoder.decode(rawName).replace(/\\/g, '/');
            if (name.endsWith('/')) continue;
            if (flags & 1) fail('Архив защищён паролем — снимите пароль и упакуйте заново.');
            if (method !== 0 && method !== 8) fail(`Метод сжатия ${method} не поддерживается (файл «${name}»).`);
            if (size > LIMITS.fileBytes) fail(`Файл «${name}» больше 32 МБ.`);
            totalBytes += size;
            if (totalBytes > LIMITS.totalBytes) fail('Распакованный архив больше 64 МБ.');

            if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== 0x04034b50) {
                fail('Архив повреждён: локальный заголовок не найден.');
            }
            const start = localOffset + 30 + view.getUint16(localOffset + 26, true) + view.getUint16(localOffset + 28, true);
            if (start + compressed > bytes.length) fail('Архив повреждён: данные обрезаны.');
            const raw = bytes.subarray(start, start + compressed);
            let data;
            if (method === 0) {
                if (raw.length !== size) fail(`Архив повреждён: размер файла «${name}» не совпал.`);
                data = raw.slice();
            } else {
                data = await inflateRaw(raw, size);
            }
            files.push({ name, data });
        }
        return files;
    }

    window.ZaliZip = Object.freeze({ LIMITS, ZipError, read });
})();
