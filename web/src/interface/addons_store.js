// --- ZaliInterface: хранилище аддонов хаба — файлы аддонов и их данные. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Дизайн — docs/ADDONS.md.
//
// Две реализации за одним набором методов addonStore*/addonData*:
//  - нативная (capability `addonStore`, сообщение ADDON_REQUEST): папка
//    <данные приложения>/addons/<id>/ у оболочки. Обязательна на Android — там
//    документ живёт на file:// и IndexedDB не открывается (см. шапку cache.js);
//    на macOS/Windows нужна ещё и потому, что бэкенд-процесс и права оболочка
//    берёт из СВОЕЙ копии файла;
//  - IndexedDB `zali_addons_v1` — браузер/PWA.
// Данные аддона — плоское «путь → байты»: storage живёт одним файлом kv.json,
// кеш — под cache/. Пути проверяет ZaliAddonFormat.pathError и здесь, и в нативе.

const ZALI_ADDONS_DB_NAME = 'zali_addons_v1';
const ZALI_ADDONS_DB_VERSION = 1;
const ZALI_ADDONS_OPEN_TIMEOUT_MS = 4000;
// Мост гоняет байты base64-строкой: 32 МБ файла — ~43 МБ строки, отдельный потолок.
const ZALI_ADDON_NATIVE_TIMEOUT_MS = 60000;

ZaliMixin(ZaliInterface, class {

    addonStoreKind() {
        if (this.hasNativeBridge()) return this.nativeSupports('addonStore') ? 'native' : 'none';
        return window.indexedDB ? 'idb' : 'none';
    }

    async addonNativeRequest(op, fields = {}, timeoutMs = ZALI_ADDON_NATIVE_TIMEOUT_MS) {
        const res = await this.requestNativeAction({ type: NativeMessageTypes.ADDON_REQUEST, op, ...fields }, timeoutMs);
        return res?.data ?? null;
    }

    addonBytesToBase64(bytes) {
        const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let binary = '';
        const CHUNK = 0x8000;
        for (let i = 0; i < view.length; i += CHUNK) {
            binary += String.fromCharCode.apply(null, view.subarray(i, i + CHUNK));
        }
        return btoa(binary);
    }

    addonBase64ToBytes(value) {
        const binary = atob(String(value || ''));
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
        return out;
    }

    // ---- IndexedDB ----

    openAddonsDb() {
        if (this._addonsDbPromise) return this._addonsDbPromise;
        this._addonsDbPromise = new Promise((resolve, reject) => {
            let settled = false;
            const done = (fn, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn(value);
            };
            const timer = setTimeout(() => done(reject, new Error('Хранилище аддонов не открылось')), ZALI_ADDONS_OPEN_TIMEOUT_MS);
            let request;
            try {
                request = window.indexedDB.open(ZALI_ADDONS_DB_NAME, ZALI_ADDONS_DB_VERSION);
            } catch (error) {
                done(reject, error);
                return;
            }
            request.onupgradeneeded = () => {
                const db = request.result;
                if (!db.objectStoreNames.contains('addons')) db.createObjectStore('addons', { keyPath: 'id' });
                if (!db.objectStoreNames.contains('archives')) db.createObjectStore('archives');
                if (!db.objectStoreNames.contains('data')) db.createObjectStore('data');
            };
            request.onsuccess = () => done(resolve, request.result);
            request.onerror = () => done(reject, request.error || new Error('Хранилище аддонов не открылось'));
            request.onblocked = () => done(reject, new Error('Хранилище аддонов занято другой вкладкой'));
        }).catch((error) => {
            // Следующая попытка — заново, а не навсегда закешированный отказ.
            this._addonsDbPromise = null;
            throw error;
        });
        return this._addonsDbPromise;
    }

    async addonsIdb(storeNames, mode, work) {
        const db = await this.openAddonsDb();
        return await new Promise((resolve, reject) => {
            const tx = db.transaction(storeNames, mode);
            let result;
            Promise.resolve(work(tx)).then((value) => { result = value; }, (error) => {
                try { tx.abort(); } catch (e) { /* уже завершена */ }
                reject(error);
            });
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error || new Error('Ошибка хранилища аддонов'));
            tx.onabort = () => reject(tx.error || new Error('Запись в хранилище аддонов отменена'));
        });
    }

    addonsIdbRequest(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error || new Error('Ошибка хранилища аддонов'));
        });
    }

    addonDataKeyRange(id, prefix = '') {
        // Ключ данных — [id, путь]; '￿' больше любого символа пути.
        return IDBKeyRange.bound([id, prefix], [id, `${prefix}￿`]);
    }

    // ---- Общий интерфейс ----

    /** @returns {Promise<Array<{id: string, manifest: any, sha256: string, size: number, installedAt: number, updatedAt: number}>>} */
    async addonStoreList() {
        const kind = this.addonStoreKind();
        if (kind === 'native') {
            const data = await this.addonNativeRequest('store.list', {}, 15000);
            return Array.isArray(data?.addons) ? data.addons.map(item => ({ ...(item.meta || {}), id: item.addonId })) : [];
        }
        if (kind === 'idb') {
            return await this.addonsIdb(['addons'], 'readonly', (tx) => this.addonsIdbRequest(tx.objectStore('addons').getAll()));
        }
        throw new Error('Хранилище аддонов недоступно в этой версии приложения');
    }

    async addonStoreGetArchive(id) {
        const kind = this.addonStoreKind();
        if (kind === 'native') {
            const data = await this.addonNativeRequest('store.get', { addonId: id });
            if (!data?.dataBase64) throw new Error('Файл аддона не найден');
            return this.addonBase64ToBytes(data.dataBase64);
        }
        const buffer = await this.addonsIdb(['archives'], 'readonly', (tx) => this.addonsIdbRequest(tx.objectStore('archives').get(id)));
        if (!buffer) throw new Error('Файл аддона не найден');
        return new Uint8Array(buffer);
    }

    /**
     * Сохраняет файл аддона. Нативная оболочка показывает здесь системное
     * подтверждение повышенных прав и может отказать — тогда исключение.
     * @returns {Promise<{granted?: string[]}>}
     */
    async addonStorePut(meta, bytes) {
        const kind = this.addonStoreKind();
        if (kind === 'native') {
            const data = await this.addonNativeRequest('store.put', {
                addonId: meta.id,
                meta,
                dataBase64: this.addonBytesToBase64(bytes),
            }, 10 * 60 * 1000);
            return data || {};
        }
        const copy = bytes.slice().buffer;
        await this.addonsIdb(['addons', 'archives'], 'readwrite', (tx) => {
            tx.objectStore('addons').put(meta);
            tx.objectStore('archives').put(copy, meta.id);
        });
        return {};
    }

    async addonStoreRemove(id) {
        const kind = this.addonStoreKind();
        if (kind === 'native') {
            await this.addonNativeRequest('store.remove', { addonId: id }, 15000);
            return;
        }
        await this.addonsIdb(['addons', 'archives', 'data'], 'readwrite', (tx) => {
            tx.objectStore('addons').delete(id);
            tx.objectStore('archives').delete(id);
            tx.objectStore('data').delete(this.addonDataKeyRange(id));
        });
    }

    addonDataPathOrThrow(path) {
        const problem = window.ZaliAddonFormat?.pathError(path);
        if (problem) throw Object.assign(new Error(`Путь «${String(path).slice(0, 80)}»: ${problem}`), { code: 'bad_path' });
        return path;
    }

    /** @returns {Promise<Uint8Array|null>} */
    async addonDataRead(id, path) {
        this.addonDataPathOrThrow(path);
        if (this.addonStoreKind() === 'native') {
            const data = await this.addonNativeRequest('data.read', { addonId: id, path });
            return data?.exists ? this.addonBase64ToBytes(data.dataBase64) : null;
        }
        const value = await this.addonsIdb(['data'], 'readonly', (tx) => this.addonsIdbRequest(tx.objectStore('data').get([id, path])));
        return value ? new Uint8Array(value.bytes) : null;
    }

    async addonDataWrite(id, path, bytes) {
        this.addonDataPathOrThrow(path);
        if (this.addonStoreKind() === 'native') {
            await this.addonNativeRequest('data.write', { addonId: id, path, dataBase64: this.addonBytesToBase64(bytes) });
            return;
        }
        const copy = bytes.slice().buffer;
        await this.addonsIdb(['data'], 'readwrite', (tx) => {
            tx.objectStore('data').put({ size: copy.byteLength, bytes: copy }, [id, path]);
        });
    }

    async addonDataDelete(id, path) {
        this.addonDataPathOrThrow(path);
        if (this.addonStoreKind() === 'native') {
            await this.addonNativeRequest('data.delete', { addonId: id, path });
            return;
        }
        await this.addonsIdb(['data'], 'readwrite', (tx) => { tx.objectStore('data').delete([id, path]); });
    }

    /** @returns {Promise<Array<{path: string, size: number}>>} */
    async addonDataList(id, prefix = '') {
        if (this.addonStoreKind() === 'native') {
            const data = await this.addonNativeRequest('data.list', { addonId: id, path: prefix });
            return Array.isArray(data?.entries) ? data.entries : [];
        }
        return await this.addonsIdb(['data'], 'readonly', (tx) => new Promise((resolve, reject) => {
            const out = [];
            const request = tx.objectStore('data').openCursor(this.addonDataKeyRange(id, prefix));
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) { resolve(out); return; }
                out.push({ path: cursor.key[1], size: Number(cursor.value?.size || 0) });
                cursor.continue();
            };
            request.onerror = () => reject(request.error);
        }));
    }
});
