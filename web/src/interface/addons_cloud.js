// --- ZaliInterface: облако аддонов — 10 МБ данных на аддон на серверах ZaliMessenger. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Дизайн — docs/ADDONS.md §11.
//
// Хранилище приложения для синхронизации и сбора данных от пользователей
// (server/src/addon_cloud.rs): один пул 10 МБ на аддон у всех пользователей
// вместе, у человека своя личная область (до 1 МБ, её читает автор аддона) и
// общая — читают все, пишет автор. Открыто только подписанным аддонам.
//
// Разрешение `cloud` проверяет dispatchAddonRpc; здесь — подпись (как для
// монет), разбор параметров, ограничение частоты и перевод ответов сервера в
// коды ошибок SDK. Токен аккаунта остаётся в приложении: фрейм его не видит.

const ZALI_ADDON_CLOUD_WINDOW_MS = 10000;
const ZALI_ADDON_CLOUD_MAX_CALLS = 40;
const ZALI_ADDON_CLOUD_KEY_BYTES = 256;
const ZALI_ADDON_CLOUD_TRUST_TTL_MS = 60000;

ZaliMixin(ZaliInterface, class {

    addonCloudRpcMethods() {
        return {
            'cloud.get': { permission: 'cloud', run: (i, p) => this.addonCloudGet(i, p) },
            'cloud.set': { permission: 'cloud', run: (i, p) => this.addonCloudSet(i, p) },
            'cloud.getBytes': { permission: 'cloud', run: (i, p) => this.addonCloudGetBytes(i, p) },
            'cloud.setBytes': { permission: 'cloud', run: (i, p) => this.addonCloudSetBytes(i, p) },
            'cloud.remove': { permission: 'cloud', run: (i, p) => this.addonCloudRemove(i, p) },
            'cloud.keys': { permission: 'cloud', run: (i, p) => this.addonCloudKeys(i, p) },
            'cloud.clear': { permission: 'cloud', run: (i, p) => this.addonCloudClear(i, p) },
            'cloud.usage': { permission: 'cloud', run: (i) => this.addonCloudUsage(i) },
            'cloud.collect.list': { permission: 'cloud', run: (i, p) => this.addonCloudCollectList(i, p) },
            'cloud.collect.get': { permission: 'cloud', run: (i, p) => this.addonCloudCollectGet(i, p, 'json') },
            'cloud.collect.getBytes': { permission: 'cloud', run: (i, p) => this.addonCloudCollectGet(i, p, 'bytes') },
        };
    }

    addonCloudKey(params, field = 'key') {
        const key = String(params?.[field] ?? '');
        if (!key || new TextEncoder().encode(key).length > ZALI_ADDON_CLOUD_KEY_BYTES || /[\u0000-\u001f\u007f]/.test(key)) {
            throw this.addonError('bad_params', 'Ключ — от 1 до 256 байт без управляющих символов');
        }
        return key;
    }

    addonCloudScope(params) {
        const scope = String(params?.scope ?? 'user');
        if (scope !== 'user' && scope !== 'shared') throw this.addonError('bad_params', 'scope — user или shared');
        return scope;
    }

    /** Облако — только подписанному аддону; решение держится минуту, потом проверка заново. */
    async addonCloudRequireSigned(instance) {
        const cached = instance.cloudTrust;
        if (cached && Date.now() - cached.at < ZALI_ADDON_CLOUD_TRUST_TTL_MS) return cached.trust;
        const trust = await this.addonSignedTrust(instance, { what: 'пользоваться облаком ZaliMessenger', thing: 'облако' });
        if (!trust.ok) throw this.addonError(trust.code || 'not_signed', trust.reason || 'Облако — только подписанным аддонам');
        instance.cloudTrust = { at: Date.now(), trust };
        return trust;
    }

    /** Не больше 40 обращений за 10 секунд на запущенный аддон. */
    addonCloudRateLimit(instance) {
        const now = Date.now();
        const log = (instance.cloudCalls || []).filter(at => now - at < ZALI_ADDON_CLOUD_WINDOW_MS);
        if (log.length >= ZALI_ADDON_CLOUD_MAX_CALLS) {
            instance.cloudCalls = log;
            throw this.addonError('rate_limited', 'Облако: не больше 40 обращений за 10 секунд');
        }
        log.push(now);
        instance.cloudCalls = log;
    }

    async addonCloudApi(instance, path, options = {}) {
        if (!this.S.session?.token) {
            throw this.addonError('unsupported', 'Облако доступно только после входа в аккаунт');
        }
        await this.addonCloudRequireSigned(instance);
        this.addonCloudRateLimit(instance);
        let res;
        try {
            res = await this.apiFetch(path, { interactive: true, ...this.addonDigestOptions(instance, options) });
        } catch (error) {
            throw this.addonError('offline', 'Не удалось связаться с сервером');
        }
        let body = null;
        try { body = await res.json(); } catch (e) { /* пустой ответ */ }
        if (!res.ok) {
            const code = String(body?.code || (res.status === 404 ? 'not_found' : res.status === 413 ? 'quota' : res.status === 403 ? 'forbidden' : res.status === 429 ? 'rate_limited' : 'failed'));
            throw this.addonError(code, String(body?.message || 'Облако ответило отказом'));
        }
        return body;
    }

    addonCloudBase(instance) {
        return `/api/addons/${encodeURIComponent(instance.id)}/cloud`;
    }

    addonCloudItemPath(instance, key, scope) {
        return `${this.addonCloudBase(instance)}/item?key=${encodeURIComponent(key)}&scope=${scope}`;
    }

    async addonCloudRead(instance, path, kind) {
        try {
            const body = await this.addonCloudApi(instance, path);
            if (body?.kind !== kind) {
                throw this.addonError('bad_params', kind === 'json'
                    ? 'Под этим ключом лежат байты — читайте getBytes'
                    : 'Под этим ключом лежит JSON — читайте get');
            }
            return body.value;
        } catch (error) {
            // Отсутствие ключа — не ошибка, как и в zali.storage.get.
            if (error?.code === 'not_found') return null;
            throw error;
        }
    }

    async addonCloudGet(instance, params) {
        const key = this.addonCloudKey(params);
        const value = await this.addonCloudRead(instance, this.addonCloudItemPath(instance, key, this.addonCloudScope(params)), 'json');
        return value === undefined ? null : value;
    }

    async addonCloudGetBytes(instance, params) {
        const key = this.addonCloudKey(params);
        const base64 = await this.addonCloudRead(instance, this.addonCloudItemPath(instance, key, this.addonCloudScope(params)), 'bytes');
        if (base64 === null) return null;
        const buffer = this.addonBase64ToBytes(String(base64)).buffer;
        return { result: buffer, transfer: [buffer] };
    }

    /** Размер проверяется до отправки: 10 МБ JSON не стоит гнать по сети зря. */
    addonCloudSizeLimit(scope) {
        const L = window.ZaliAddonFormat.LIMITS;
        return scope === 'shared' ? L.cloudBytes : L.cloudUserBytes;
    }

    async addonCloudSet(instance, params) {
        const key = this.addonCloudKey(params);
        const scope = this.addonCloudScope(params);
        const value = params?.value === undefined ? null : params.value;
        let size = 0;
        try { size = new TextEncoder().encode(JSON.stringify(value)).length; } catch (e) {
            throw this.addonError('bad_params', 'Значение не сериализуется в JSON');
        }
        if (size > this.addonCloudSizeLimit(scope)) {
            throw this.addonError('quota', scope === 'shared' ? 'Значение больше 10 МБ' : 'Значение больше доли человека — 1 МБ');
        }
        return this.addonCloudApi(instance, this.addonCloudItemPath(instance, key, scope), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'json', value }),
        });
    }

    async addonCloudSetBytes(instance, params) {
        const key = this.addonCloudKey(params);
        const scope = this.addonCloudScope(params);
        const data = params?.data;
        if (!(data instanceof ArrayBuffer)) throw this.addonError('bad_params', 'Нужны байты');
        if (data.byteLength > this.addonCloudSizeLimit(scope)) {
            throw this.addonError('quota', scope === 'shared' ? 'Значение больше 10 МБ' : 'Значение больше доли человека — 1 МБ');
        }
        return this.addonCloudApi(instance, this.addonCloudItemPath(instance, key, scope), {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: 'bytes', value: this.addonBytesToBase64(new Uint8Array(data)) }),
        });
    }

    async addonCloudRemove(instance, params) {
        const key = this.addonCloudKey(params);
        const body = await this.addonCloudApi(instance, this.addonCloudItemPath(instance, key, this.addonCloudScope(params)), { method: 'DELETE' });
        return !!body?.removed;
    }

    async addonCloudKeys(instance, params) {
        const scope = this.addonCloudScope(params);
        const body = await this.addonCloudApi(instance, `${this.addonCloudBase(instance)}?scope=${scope}`);
        return (Array.isArray(body?.items) ? body.items : []).map(item => item.key);
    }

    async addonCloudClear(instance, params) {
        const scope = this.addonCloudScope(params);
        const body = await this.addonCloudApi(instance, `${this.addonCloudBase(instance)}?scope=${scope}`, { method: 'DELETE' });
        return Number(body?.removed) || 0;
    }

    /** `{bytes, quota}` — пул аддона; `{mine, mineQuota}` — доля человека; `isOwner` — автор ли он. */
    async addonCloudUsage(instance) {
        const body = await this.addonCloudApi(instance, this.addonCloudBase(instance));
        const L = window.ZaliAddonFormat.LIMITS;
        return {
            bytes: Number(body?.bytes) || 0,
            quota: Number(body?.quota) || L.cloudBytes,
            mine: Number(body?.mine) || 0,
            mineQuota: Number(body?.mineQuota) || L.cloudUserBytes,
            keys: Number(body?.keys) || 0,
            isOwner: !!body?.isOwner,
        };
    }

    // ---- Сбор данных автором: только он, остальным сервер ответит forbidden ----

    async addonCloudCollectList(instance, params) {
        const offset = Math.max(0, Math.trunc(Number(params?.offset) || 0));
        const limit = Math.min(200, Math.max(1, Math.trunc(Number(params?.limit) || 100)));
        const body = await this.addonCloudApi(instance, `${this.addonCloudBase(instance)}/collect?offset=${offset}&limit=${limit}`);
        return {
            total: Number(body?.total) || 0,
            users: Number(body?.users) || 0,
            bytes: Number(body?.bytes) || 0,
            offset,
            items: (Array.isArray(body?.items) ? body.items : []).map(item => ({
                user: String(item.user), key: String(item.key), kind: String(item.kind),
                size: Number(item.size) || 0, updatedAt: Number(item.updatedAt) || 0,
            })),
        };
    }

    async addonCloudCollectGet(instance, params, kind) {
        const user = String(params?.user ?? '').trim();
        if (!user || user.length > 64) throw this.addonError('bad_params', 'Нужно имя пользователя');
        const key = this.addonCloudKey(params);
        const path = `${this.addonCloudBase(instance)}/collect/item?user=${encodeURIComponent(user)}&key=${encodeURIComponent(key)}`;
        const value = await this.addonCloudRead(instance, path, kind);
        if (value === null || kind === 'json') return value;
        const buffer = this.addonBase64ToBytes(String(value)).buffer;
        return { result: buffer, transfer: [buffer] };
    }
});
