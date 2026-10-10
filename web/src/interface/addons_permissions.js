// --- ZaliInterface: обычные разрешения аддонов хаба — кеш, уведомления, ---
// --- буфер обмена, сохранение файлов, микрофон. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Дизайн — docs/ADDONS.md.
//
// Методы подключаются к таблице RPC через addonRpcExtraMethods()
// (addons_runtime.js): у каждого своё разрешение, без которого dispatchAddonRpc
// вызов не пропустит. Всё, что видит пользователь (уведомление, загрузка,
// запись с микрофона), делает приложение, а не фрейм: песочнице не выданы ни
// allow-downloads, ни allow-modals, ни микрофон (allow="").

const ZALI_ADDON_CACHE_PREFIX = 'cache/';
const ZALI_ADDON_WRITE_MAX_BYTES = 32 * 1024 * 1024;
const ZALI_ADDON_NOTIFY_INTERVAL_MS = 5000;
const ZALI_ADDON_SAVE_INTERVAL_MS = 2000;
const ZALI_ADDON_MIC_MAX_MS = 60 * 60 * 1000;
const ZALI_ADDON_MIC_MAX_BYTES = 64 * 1024 * 1024;

ZaliMixin(ZaliInterface, class {

    addonRpcExtraMethods() {
        return {
            'cache.write': { permission: 'cache', run: (i, p) => this.addonCacheWrite(i, p) },
            'cache.read': { permission: 'cache', run: (i, p) => this.addonCacheRead(i, p) },
            'cache.list': { permission: 'cache', run: (i, p) => this.addonCacheList(i, p) },
            'cache.remove': { permission: 'cache', run: (i, p) => this.addonCacheRemove(i, p) },
            'cache.usage': { permission: 'cache', run: (i) => this.addonCacheUsage(i) },
            notify: { permission: 'notifications', run: (i, p) => this.addonNotify(i, p) },
            'clipboard.writeText': { permission: 'clipboard', run: (i, p) => this.addonClipboardWrite(i, p) },
            'files.save': { permission: 'files', run: (i, p) => this.addonSaveFile(i, p) },
            'mic.start': { permission: 'microphone', run: (i) => this.addonMicStart(i) },
            'mic.stop': { permission: 'microphone', run: (i) => this.addonMicStop(i) },
            'mic.cancel': { permission: 'microphone', run: (i) => { this.addonStopRecorder(i); return true; } },
        };
    }

    addonBytesParam(params) {
        const data = params?.data;
        if (!(data instanceof ArrayBuffer)) throw this.addonError('bad_params', 'Нужны байты');
        if (data.byteLength > ZALI_ADDON_WRITE_MAX_BYTES) throw this.addonError('too_large', 'За один раз — не больше 32 МБ');
        return new Uint8Array(data);
    }

    addonRequireVisible(instance, what) {
        if (!instance.expanded) throw this.addonError('not_visible', `${what} — только пока аддон открыт`);
    }

    // ---- zali.cache: файлы аддона под cache/, до 256 МБ на аддон ----

    addonCachePath(params) {
        const path = String(params?.path ?? '').replace(/^\/+/, '');
        const problem = window.ZaliAddonFormat.pathError(path);
        if (problem) throw this.addonError('bad_path', `Путь «${path.slice(0, 80)}»: ${problem}`);
        return ZALI_ADDON_CACHE_PREFIX + path;
    }

    async addonCacheWrite(instance, params) {
        const path = this.addonCachePath(params);
        const bytes = this.addonBytesParam(params);
        // Квота считается по тому, что уже лежит, с заменой старой версии файла.
        // Записи одного аддона идут по очереди, иначе две параллельные прошли бы
        // проверку квоты обе.
        const run = async () => {
            const entries = await this.addonDataList(instance.id, ZALI_ADDON_CACHE_PREFIX);
            const used = entries.reduce((sum, e) => sum + (e.path === path ? 0 : Number(e.size || 0)), 0);
            if (used + bytes.length > window.ZaliAddonFormat.LIMITS.cacheBytes) {
                throw this.addonError('quota', 'Кеш аддона заполнен (256 МБ) — удалите ненужное через zali.cache.remove');
            }
            await this.addonDataWrite(instance.id, path, bytes);
            return true;
        };
        const next = (instance.cacheWrite || Promise.resolve()).catch(() => {}).then(run);
        instance.cacheWrite = next;
        return await next;
    }

    async addonCacheRead(instance, params) {
        const bytes = await this.addonDataRead(instance.id, this.addonCachePath(params));
        if (!bytes) return null;
        const data = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
        return { result: data, transfer: [data] };
    }

    async addonCacheList(instance, params) {
        const prefix = String(params?.prefix ?? '').replace(/^\/+/, '');
        if (prefix.length > 255 || /[\u0000-\u001f\\]/.test(prefix)) throw this.addonError('bad_path', 'Недопустимый префикс');
        const entries = await this.addonDataList(instance.id, ZALI_ADDON_CACHE_PREFIX + prefix);
        return entries
            .filter(e => String(e.path || '').startsWith(ZALI_ADDON_CACHE_PREFIX))
            .map(e => ({ path: e.path.slice(ZALI_ADDON_CACHE_PREFIX.length), size: Number(e.size || 0) }));
    }

    async addonCacheRemove(instance, params) {
        await this.addonDataDelete(instance.id, this.addonCachePath(params));
        return true;
    }

    async addonCacheUsage(instance) {
        const entries = await this.addonDataList(instance.id, ZALI_ADDON_CACHE_PREFIX);
        const bytes = entries.reduce((sum, e) => sum + Number(e.size || 0), 0);
        return { bytes, quota: window.ZaliAddonFormat.LIMITS.cacheBytes, files: entries.length };
    }

    // ---- zali.notify ----

    async addonNotify(instance, params) {
        const now = Date.now();
        if (now - Number(instance.lastNotifyAt || 0) < ZALI_ADDON_NOTIFY_INTERVAL_MS) {
            throw this.addonError('rate_limited', 'Не чаще одного уведомления в 5 секунд');
        }
        const clean = (value, max) => Array.from(String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, max).join('');
        const title = clean(params?.title, 64);
        const body = clean(params?.body, 180);
        if (!title && !body) throw this.addonError('bad_params', 'Нужен заголовок или текст');
        instance.lastNotifyAt = now;
        // Имя аддона всегда в заголовке: уведомление не должно выдать себя за
        // сообщение от собеседника. Пробелы и кавычки не дают оболочке принять
        // его за имя пользователя, если она попробует открыть по нему чат.
        const sender = `Аддон «${instance.manifest.name}»`;
        const text = [title, body].filter(Boolean).join(' — ');
        if (this.hasNativeBridge()) {
            this.postNativeMessage({
                type: NativeMessageTypes.SHOW_NOTIFICATION,
                sender,
                text,
                attachmentCount: 0,
                serverId: null,
                channelId: null,
                messageId: `addon:${instance.id}:${now}`,
            });
            return { shown: true };
        }
        if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return { shown: false };
        try {
            const registration = navigator.serviceWorker ? await navigator.serviceWorker.ready : null;
            const options = { body: text, icon: './icon-192.png', badge: './icon-192.png', tag: `zali:addon:${instance.id}`, renotify: true, data: { addonId: instance.id } };
            if (registration?.showNotification) await registration.showNotification(sender, options);
            else new Notification(sender, options);
            return { shown: true };
        } catch (error) {
            return { shown: false };
        }
    }

    // ---- zali.clipboard ----

    async addonClipboardWrite(instance, params) {
        const text = String(params?.text ?? '');
        if (text.length > 1024 * 1024) throw this.addonError('too_large', 'Текст больше 1 МБ');
        this.addonRequireVisible(instance, 'Копировать');
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (error) {
            // Фокус сейчас во фрейме аддона, и Clipboard API документа приложения
            // может отказать «документ не в фокусе» — старый путь через выделение.
            const area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
            document.body.appendChild(area);
            area.select();
            let ok = false;
            try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
            area.remove();
            try { instance.iframe?.focus(); } catch (e) { /* фрейма уже нет */ }
            if (!ok) throw this.addonError('failed', 'Система не дала скопировать текст');
            return true;
        }
    }

    // ---- zali.files.save ----

    async addonSaveFile(instance, params) {
        this.addonRequireVisible(instance, 'Сохранять файлы');
        const now = Date.now();
        if (now - Number(instance.lastSaveAt || 0) < ZALI_ADDON_SAVE_INTERVAL_MS) {
            throw this.addonError('rate_limited', 'Не чаще одного файла в 2 секунды');
        }
        const bytes = this.addonBytesParam(params);
        let name = String(params?.name ?? '').replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, '_').replace(/^[.\s]+/, '').trim().slice(0, 128);
        if (!name) name = 'file';
        const mimeRaw = String(params?.mimeType ?? '').trim().toLowerCase();
        const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeRaw) ? mimeRaw : window.ZaliAddonFormat.mimeForPath(name);
        instance.lastSaveAt = now;
        const dataUrl = `data:${mime};base64,${this.addonBytesToBase64(bytes)}`;
        const ok = await this.downloadAttachmentFromHref(dataUrl, name);
        if (ok === false) throw this.addonError('failed', 'Не удалось сохранить файл');
        return true;
    }

    // ---- zali.mic: запись идёт в приложении, аддону отдаются готовые байты ----

    async addonMicStart(instance) {
        if (instance.recorder) throw this.addonError('busy', 'Запись уже идёт');
        this.addonRequireVisible(instance, 'Начать запись');
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
            throw this.addonError('unsupported', 'Запись звука здесь недоступна');
        }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        } catch (error) {
            throw this.addonError('denied', 'Нет доступа к микрофону — разрешите его приложению');
        }
        // Пока ждали разрешения, аддон могли остановить.
        if (!this.addonInstances().has(instance.id) || instance.recorder) {
            stream.getTracks().forEach(t => t.stop());
            throw this.addonError('cancelled', 'Запись отменена');
        }
        const candidates = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];
        const mimeType = candidates.find(type => window.MediaRecorder.isTypeSupported?.(type)) || '';
        let recorder;
        try {
            recorder = new window.MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        } catch (error) {
            stream.getTracks().forEach(t => t.stop());
            throw this.addonError('unsupported', 'Запись звука здесь недоступна');
        }
        const rec = { recorder, stream, chunks: [], bytes: 0, startedAt: Date.now(), stoppedAt: 0, mimeType: recorder.mimeType || mimeType, limit: '', done: null, timer: 0 };
        rec.done = new Promise((resolve) => { recorder.addEventListener('stop', resolve, { once: true }); });
        const autoStop = (reason) => {
            if (rec.limit || recorder.state === 'inactive') return;
            rec.limit = reason;
            try { recorder.stop(); } catch (e) { /* уже остановлен */ }
            this.emitAddonEvent(instance, 'mic', { state: 'stopped', reason });
        };
        recorder.addEventListener('dataavailable', (e) => {
            if (!e.data?.size) return;
            rec.chunks.push(e.data);
            rec.bytes += e.data.size;
            if (rec.bytes >= ZALI_ADDON_MIC_MAX_BYTES) autoStop('limit');
        });
        recorder.addEventListener('stop', () => {
            rec.stoppedAt = Date.now();
            clearTimeout(rec.timer);
            rec.stream.getTracks().forEach(t => t.stop());
        });
        rec.timer = setTimeout(() => autoStop('limit'), ZALI_ADDON_MIC_MAX_MS);
        recorder.start(1000);
        instance.recorder = rec;
        this.renderAddonTitlebar();
        this.renderHubAddons?.();
        return { mimeType: rec.mimeType };
    }

    async addonMicStop(instance) {
        const rec = instance.recorder;
        if (!rec) throw this.addonError('not_recording', 'Запись не идёт');
        if (rec.recorder.state !== 'inactive') {
            try { rec.recorder.stop(); } catch (e) { /* уже остановлен */ }
        }
        await rec.done;
        if (instance.recorder !== rec) throw this.addonError('cancelled', 'Запись отменена');
        instance.recorder = null;
        this.renderAddonTitlebar();
        this.renderHubAddons?.();
        const blob = new Blob(rec.chunks, { type: rec.mimeType || 'audio/webm' });
        const data = await blob.arrayBuffer();
        const durationMs = Math.max(0, (rec.stoppedAt || Date.now()) - rec.startedAt);
        return { result: { data, mimeType: blob.type, durationMs }, transfer: [data] };
    }

    /** Отмена записи без результата: mic.cancel, остановка аддона, ошибка фрейма. */
    addonStopRecorder(instance) {
        const rec = instance?.recorder;
        if (!rec) return;
        instance.recorder = null;
        clearTimeout(rec.timer);
        try { if (rec.recorder.state !== 'inactive') rec.recorder.stop(); } catch (e) { /* уже остановлен */ }
        rec.stream.getTracks().forEach(t => t.stop());
        rec.chunks = [];
        this.renderAddonTitlebar();
        this.renderHubAddons?.();
    }
});
