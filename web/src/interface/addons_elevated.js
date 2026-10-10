// --- ZaliInterface: повышенные права аддонов хаба — файлы на всём диске, ---
// --- запуск программ, собственный процесс-бэкенд. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Дизайн — docs/ADDONS.md.
//
// Всё здесь делает нативная оболочка (Windows: native/addon_elevated.rs, macOS:
// Services/AddonElevated.swift) через ADDON_REQUEST, и только в рамках сессии:
// session.start показывает системный диалог при каждом запуске и выдаёт
// sessionId, без которого оболочка не выполнит ни одной операции. Права сессии
// оболочка берёт из манифеста внутри файла аддона и сверяет отпечаток с тем,
// что подтвердили при установке, — проверка разрешения здесь (dispatchAddonRpc)
// лишь первая из двух.

const ZALI_ADDON_SESSION_TIMEOUT_MS = 10 * 60 * 1000;

ZaliMixin(ZaliInterface, class {

    /** Вызывается из launchAddon до создания фрейма; отказ в диалоге — исключение. */
    async addonSessionStart(instance) {
        const F = window.ZaliAddonFormat;
        const elevated = instance.manifest.permissions.filter(p => F.isElevated(p));
        if (!elevated.length) return;
        // Системный диалог ждёт ответа пользователя — таймаут с запасом.
        const res = await this.addonNativeRequest('session.start', { addonId: instance.id }, ZALI_ADDON_SESSION_TIMEOUT_MS);
        if (!res?.sessionId) throw this.addonError('denied', 'Запуск отменён');
        instance.sessionId = String(res.sessionId);
    }

    addonSessionEnd(instance) {
        const sessionId = instance?.sessionId;
        if (!sessionId) return;
        instance.sessionId = '';
        this.addonNativeRequest('session.end', { sessionId }, 15000).catch(() => {});
    }

    /** Методы SDK с повышенными правами — подмешиваются в addonRpcExtraMethods(). */
    addonElevatedRpcMethods() {
        const call = (op, fields = {}) => (instance) => {
            if (!instance.sessionId) throw this.addonError('denied', 'Аддон запущен без повышенных прав');
            return this.addonNativeRequest(op, { sessionId: instance.sessionId, ...fields });
        };
        const pathOf = (params) => String(params?.path ?? '');
        return {
            'fs.paths': {
                run: (instance) => {
                    const p = instance.manifest.permissions;
                    if (!p.includes('fs.read') && !p.includes('fs.write')) {
                        throw this.addonError('permission_denied', 'Аддон не просил доступ к файлам');
                    }
                    return call('fs.paths')(instance);
                },
            },
            'fs.read': {
                permission: 'fs.read',
                run: async (instance, params) => {
                    const data = await call('fs.read', { path: pathOf(params) })(instance);
                    const buffer = this.addonBase64ToBytes(data?.dataBase64 || '').buffer;
                    return { result: buffer, transfer: [buffer] };
                },
            },
            'fs.stat': { permission: 'fs.read', run: (i, p) => call('fs.stat', { path: pathOf(p) })(i) },
            'fs.list': { permission: 'fs.read', run: (i, p) => call('fs.list', { path: pathOf(p) })(i) },
            'fs.write': {
                permission: 'fs.write',
                run: (instance, params) => {
                    const bytes = this.addonBytesParam(params);
                    return call('fs.write', { path: pathOf(params), append: !!params?.append, dataBase64: this.addonBytesToBase64(bytes) })(instance);
                },
            },
            'fs.mkdir': { permission: 'fs.write', run: (i, p) => call('fs.mkdir', { path: pathOf(p) })(i) },
            'fs.remove': { permission: 'fs.write', run: (i, p) => call('fs.remove', { path: pathOf(p), recursive: !!p?.recursive })(i) },
            'system.open': { permission: 'launch', run: (i, p) => call('system.open', { path: pathOf(p) })(i) },
            'system.exec': {
                permission: 'launch',
                run: (i, p) => call('system.exec', {
                    path: pathOf(p),
                    args: Array.isArray(p?.args) ? p.args.slice(0, 64).map(String) : [],
                    cwd: String(p?.cwd ?? ''),
                })(i),
            },
            'backend.send': { permission: 'process', run: (i, p) => call('backend.send', { message: p?.message ?? null })(i) },
            'backend.restart': { permission: 'process', run: (i) => call('backend.restart')(i) },
        };
    }

    /** Событие от оболочки (bus `addon_event`): строка бэкенда, его выход. */
    onNativeAddonEvent(payload) {
        const sessionId = String(payload?.sessionId || '');
        if (!sessionId) return;
        for (const instance of this.addonInstances().values()) {
            if (instance.sessionId !== sessionId) continue;
            const event = String(payload.event || '');
            if (event === 'backend' || event === 'backend-exit' || event === 'backend-error') {
                this.emitAddonEvent(instance, event, payload.data ?? null);
            }
            return;
        }
    }
});
