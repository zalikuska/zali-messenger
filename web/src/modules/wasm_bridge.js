// @ts-check
// Lazily loads the WASM build of core/ (see scripts/build_web_wasm.sh) and exposes
// pack/unpack helpers for the .zali archive format to the rest of interface.js.
// Only relevant when running as a plain browser tab with no native shell — the
// macOS/Windows clients pack/unpack archives natively and never touch this module.
// Dynamic import() here resolves relative to the document URL, so web/wasm-pkg/
// must be served alongside web/index.html.
(function() {
    'use strict';

    let readyPromise = null;

    function load() {
        if (!readyPromise) {
            readyPromise = import('./wasm-pkg/zali_core.js')
                .then(async (mod) => {
                    await mod.default();
                    return mod;
                })
                .catch((error) => {
                    readyPromise = null;
                    throw error;
                });
        }
        return readyPromise;
    }

    // ---- Распаковка в воркере ------------------------------------------------
    // unpack_message_wasm — это PBKDF2 на 210k итераций плюс AES-GCM, синхронно.
    // В главном потоке каждое сообщение (и каждый неподошедший ключ-кандидат)
    // замораживал вкладку: история из десятков сообщений или одно сообщение,
    // перебирающее десяток старых ключей, — секунды без отрисовки и ввода.
    // Воркер собирается из Blob и сам импортирует тот же wasm-pkg по абсолютному
    // адресу, поэтому отдельного файла на сервере для него не нужно. Не поднялся
    // (старый движок, запрет blob:) — распаковываем по-старому в главном потоке.
    const WORKER_SOURCE = `
        let ready = null;
        function load(url) {
            if (!ready) {
                ready = import(url).then(async (mod) => { await mod.default(); return mod; })
                    .catch((error) => { ready = null; throw error; });
            }
            return ready;
        }
        self.onmessage = async (event) => {
            const { id, url, archive, key } = event.data || {};
            let mod;
            try {
                mod = await load(url);
            } catch (error) {
                self.postMessage({ id, ok: false, loadFailed: true, error: String(error) });
                return;
            }
            try {
                const value = mod.unpack_message_wasm(archive, key);
                const transfer = [];
                for (const att of (value && value.attachments) || []) {
                    if (att && att.bytes && att.bytes.buffer) transfer.push(att.bytes.buffer);
                }
                self.postMessage({ id, ok: true, value }, transfer);
            } catch (error) {
                const message = (error && error.message) || String(error);
                self.postMessage({ id, ok: false, error: message });
            }
        };
    `;
    const workerPool = [];
    let workerBroken = false;
    let workerSeq = 0;
    let workerCursor = 0;
    const workerPending = new Map();

    function spawnWorker() {
        const blobUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: 'text/javascript' }));
        const worker = new Worker(blobUrl, { type: 'module' });
        URL.revokeObjectURL(blobUrl);
        worker.onmessage = (event) => {
            const { id, ok, value, error, loadFailed } = event.data || {};
            const pending = workerPending.get(id);
            if (!pending) return;
            workerPending.delete(id);
            if (loadFailed) {
                // Не «неверный ключ», а воркер не смог загрузить WASM: такая ошибка
                // пометила бы сообщение нерасшифруемым. Уходим в главный поток.
                workerBroken = true;
                pending.fallback();
                return;
            }
            if (ok) pending.resolve(value);
            else pending.reject(new Error(error || 'unpack failed'));
        };
        worker.onerror = () => {
            // Воркер не загрузился целиком (например, движок без module workers):
            // всё, что ждало его, повторяем в главном потоке и больше его не зовём.
            workerBroken = true;
            for (const [id, pending] of workerPending) {
                if (pending.worker === worker) {
                    workerPending.delete(id);
                    pending.fallback();
                }
            }
        };
        return worker;
    }

    function pickWorker() {
        if (workerBroken || typeof Worker === 'undefined') return null;
        try {
            if (!workerPool.length) {
                const cores = Number(navigator.hardwareConcurrency) || 2;
                const size = Math.max(1, Math.min(2, cores - 1));
                for (let i = 0; i < size; i += 1) workerPool.push(spawnWorker());
            }
        } catch (e) {
            workerBroken = true;
            return null;
        }
        workerCursor = (workerCursor + 1) % workerPool.length;
        return workerPool[workerCursor];
    }

    async function unpackOnMainThread(bytes, key) {
        const mod = await load();
        return mod.unpack_message_wasm(bytes, key);
    }

    function unpackInWorker(bytes, key) {
        const worker = pickWorker();
        if (!worker) return unpackOnMainThread(bytes, key);
        const url = new URL('./wasm-pkg/zali_core.js', document.baseURI).href;
        return new Promise((resolve, reject) => {
            const id = ++workerSeq;
            workerPending.set(id, {
                worker,
                resolve,
                reject,
                fallback: () => unpackOnMainThread(bytes, key).then(resolve, reject),
            });
            // Копия, а не передача буфера: при откате в главный поток байты нужны здесь.
            worker.postMessage({ id, url, archive: bytes.slice(), key });
        });
    }

    window.ZaliWasm = {
        async isAvailable() {
            try {
                await load();
                return true;
            } catch (e) {
                return false;
            }
        },

        /**
         * @param {string} sender
         * @param {string} text
         * @param {string} key
         * @param {number} keyVersion
         * @param {Array<{name:string, archivePath:string, mimeType:string, kind:string, bytes:Uint8Array}>} [attachments]
         * @returns {Promise<Uint8Array>}
         */
        async packMessage(sender, text, key, keyVersion, attachments, call, reply) {
            const mod = await load();
            const jsAttachments = (attachments || []).map(a => ({
                name: a.name,
                archivePath: a.archivePath,
                mimeType: a.mimeType,
                kind: a.kind,
                bytes: a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array(a.bytes),
            }));
            // `call`/`reply` are opaque JSON strings; the core encrypts them with
            // the conversation key exactly like the body. undefined = absent, which
            // keeps the archive byte-identical to what a pre-reply client wrote.
            return mod.pack_message_wasm(
                sender,
                text,
                key,
                keyVersion || 0,
                jsAttachments,
                call || undefined,
                reply || undefined,
            );
        },

        /**
         * @param {Uint8Array} archiveBytes
         * @param {string} key
         * @returns {Promise<{sender:string, text:string, timestamp:number, keyVersion:number, attachments:Array<{name:string,archivePath:string,mimeType:string,kind:string,bytes:Uint8Array}>}>}
         */
        async unpackMessage(archiveBytes, key) {
            const bytes = archiveBytes instanceof Uint8Array ? archiveBytes : new Uint8Array(archiveBytes);
            return unpackInWorker(bytes, key);
        },
    };
})();
