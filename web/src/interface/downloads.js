// --- ZaliInterface: скачивание вложений — режим и папка из настроек. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Два режима (настройки → «Приложение» → «Скачивание файлов»):
//   ask     — системное окно «Сохранить как…» на каждый файл (по умолчанию);
//   instant — сразу, без вопросов: в выбранную папку (Windows/macOS) или в
//             «Загрузки/ZaliMessenger» (Android). Папка хранится здесь, на устройстве, и
//             уходит оболочке с каждым скачиванием; оболочка проверяет, что это
//             существующий каталог, а имя файла чистит сама — выйти из папки нельзя.
// Оболочка отвечает NATIVE_RESPONSE по requestId: успех (путь, имя) → анимация и
// тост «Файл сохранён»; error "cancelled" — окно закрыли, тишина; error
// "folder_unavailable" — папку удалили или отключили, спрашиваем как в `ask`.
const ZALI_DOWNLOAD_PREFS_KEY = 'zali_download_prefs_v1';
const ZALI_DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000; // человек может долго выбирать папку

ZaliMixin(ZaliInterface, class {

    downloadPrefs() {
        let raw = null;
        try { raw = JSON.parse(localStorage.getItem(ZALI_DOWNLOAD_PREFS_KEY) || 'null'); } catch (e) { raw = null; }
        const src = raw && typeof raw === 'object' ? raw : {};
        return {
            mode: src.mode === 'instant' ? 'instant' : 'ask',
            folder: typeof src.folder === 'string' ? src.folder.trim().slice(0, 1024) : '',
        };
    }

    saveDownloadPrefs(prefs) {
        try { localStorage.setItem(ZALI_DOWNLOAD_PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* только до перезагрузки */ }
        this.renderDownloadSettings();
    }

    /** Оболочка сообщает результат сохранения (иначе — старая, «выстрелил и забыл»). */
    downloadReportsResult() {
        return this.nativeSupports('downloadFolder') || this.nativeSupports('downloadResult');
    }

    // ---- Настройки ----

    renderDownloadSettings() {
        const card = document.getElementById('downloadSettingsCard');
        if (!card) return;
        const supported = this.hasNativeBridge() && this.nativeSupports('downloadAttachment') && this.downloadReportsResult();
        card.hidden = !supported;
        if (!supported) return;
        const prefs = this.downloadPrefs();
        card.querySelectorAll('[data-download-mode]').forEach((btn) => {
            const active = btn.getAttribute('data-download-mode') === prefs.mode;
            btn.classList.toggle('is-active', active);
            btn.setAttribute('aria-checked', active ? 'true' : 'false');
        });
        const canPick = this.nativeSupports('downloadFolder');
        const row = document.getElementById('downloadFolderRow');
        if (row) row.hidden = !(canPick && prefs.mode === 'instant');
        const pathEl = document.getElementById('downloadFolderPath');
        if (pathEl) {
            pathEl.textContent = '';
            const text = document.createElement('bdi');
            text.textContent = prefs.folder || 'Папка «Загрузки» по умолчанию';
            pathEl.appendChild(text);
            pathEl.title = prefs.folder || '';
        }
        const reset = document.getElementById('downloadFolderResetBtn');
        if (reset) reset.hidden = !prefs.folder;
        const help = document.getElementById('downloadSettingsHelp');
        if (help) {
            if (prefs.mode === 'ask') {
                help.textContent = 'Перед каждым скачиванием открывается окно: вы сами выбираете, куда сохранить файл.';
            } else if (canPick) {
                help.textContent = prefs.folder
                    ? 'Файлы сохраняются сразу, без вопросов, в выбранную папку. Если файл с таким именем уже есть, к имени добавится номер.'
                    : 'Файлы сохраняются сразу, без вопросов, в папку «Загрузки». Выберите свою папку кнопкой справа.';
            } else {
                help.textContent = 'Файлы сохраняются сразу, без вопросов, в «Загрузки/ZaliMessenger».';
            }
        }
    }

    bindDownloadSettings() {
        const card = document.getElementById('downloadSettingsCard');
        if (!card || card.dataset.bound) return;
        card.dataset.bound = '1';
        card.addEventListener('click', (event) => {
            const modeBtn = event.target.closest('[data-download-mode]');
            if (modeBtn) {
                const mode = modeBtn.getAttribute('data-download-mode') === 'instant' ? 'instant' : 'ask';
                this.saveDownloadPrefs({ ...this.downloadPrefs(), mode });
                return;
            }
            if (event.target.closest('#downloadFolderPickBtn')) {
                void this.pickDownloadFolder();
                return;
            }
            if (event.target.closest('#downloadFolderResetBtn')) {
                this.saveDownloadPrefs({ ...this.downloadPrefs(), folder: '' });
            }
        });
    }

    async pickDownloadFolder() {
        const prefs = this.downloadPrefs();
        const btn = document.getElementById('downloadFolderPickBtn');
        if (btn) btn.disabled = true;
        try {
            const res = await this.requestNativeAction(
                { type: NativeMessageTypes.PICK_DOWNLOAD_FOLDER_REQUEST, current: prefs.folder },
                ZALI_DOWNLOAD_TIMEOUT_MS,
            );
            const path = String(res?.data?.path || '').trim();
            if (path) this.saveDownloadPrefs({ ...prefs, folder: path });
        } catch (error) {
            this.addLogEntry?.({ type: 'WARN', msg: `Не удалось выбрать папку: ${error?.message || error}`, ts: new Date().toLocaleTimeString() });
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    // ---- Скачивание через оболочку ----

    /** true — файл сохранён (или передан в «Поделиться» на Android), false — нет. */
    async nativeDownloadAttachment(dataUrl, filename, anchor = null) {
        // Старая оболочка (без ответов): отправили — и считаем, что скачалось.
        if (!this.downloadReportsResult()) {
            this.postNativeMessage({ type: NativeMessageTypes.DOWNLOAD_ATTACHMENT, dataUrl, filename });
            this.playDownloadFx?.(anchor);
            return true;
        }
        return this.runNativeDownload((mode, prefs) => ({
            type: NativeMessageTypes.DOWNLOAD_ATTACHMENT,
            dataUrl,
            filename,
            mode,
            folder: prefs.folder,
        }), filename, anchor);
    }

    /** Режим и папка из настроек → запрос оболочке → тост/анимация. Общее для data:-URL и докачки. */
    async runNativeDownload(buildMessage, filename, anchor = null) {
        const prefs = this.downloadPrefs();
        const send = (mode) => this.requestNativeAction(buildMessage(mode, prefs), ZALI_DOWNLOAD_TIMEOUT_MS);
        // «Сразу»: анимация стартует вместе со скачиванием — запись занимает мгновения,
        // а ждать ответа, чтобы показать, что клик сработал, незачем.
        if (prefs.mode === 'instant') this.playDownloadFx?.(anchor);
        try {
            let res;
            try {
                res = await send(prefs.mode);
            } catch (error) {
                if (error?.message !== 'folder_unavailable') throw error;
                this.showToast?.({ title: 'Папка недоступна', text: 'Выберите, куда сохранить этот файл. Папку можно сменить в настройках.', tone: 'warn' });
                res = await send('ask');
                if (!res?.data?.shared) this.playDownloadFx?.(anchor);
            }
            const data = res?.data || {};
            if (data.shared) return true; // Android: открыт лист «Поделиться»
            if (prefs.mode === 'ask') this.playDownloadFx?.(anchor);
            const where = data.folder ? ` — ${data.folder}` : '';
            this.showToast?.({ title: 'Файл сохранён', text: `${data.name || filename}${where}` });
            return true;
        } catch (error) {
            if (error?.message === 'cancelled') return false;
            this.addLogEntry?.({ type: 'ERROR', msg: `Не удалось сохранить вложение: ${error?.message || error}`, ts: new Date().toLocaleTimeString() });
            this.showToast?.({ title: 'Не удалось сохранить файл', text: String(error?.message || ''), tone: 'error' });
            return false;
        }
    }

    /**
     * Вложение, байтов которого в странице нет (Android: крупнее порога нативного слоя): оболочка
     * сама скачивает архив сообщения, расшифровывает и сохраняет файл — строка через мост не идёт.
     * `card` — карточка `[data-attachment-unavailable]`; сообщение берём из её родителя.
     */
    async downloadMessageAttachment(card) {
        if (!card || card.classList.contains('is-loading')) return false;
        const name = card.getAttribute('data-attachment-unavailable') || 'attachment';
        const found = this.findMessageById(card.closest('[data-message-id]')?.getAttribute('data-message-id'));
        if (!this.nativeSupports('downloadMessageAttachment') || !found?.msg?.id) {
            this.showToast?.({ title: 'Файл пока не скачать', text: `${name}: подождите, пока подгрузится история, и попробуйте снова.`, tone: 'warn' });
            return false;
        }
        const msg = found.msg;
        const me = String(this.myName?.() || '').trim();
        let sender = String(msg.sender || '').trim();
        let receiver = String(msg.receiver || '').trim();
        let serverId = String(msg.serverId || '').trim();
        let channelId = String(msg.channelId || '').trim();
        if (found.serverKey && (!serverId || !channelId)) {
            const [sid, cid] = String(found.serverKey).split(':');
            serverId = serverId || sid || '';
            channelId = channelId || cid || '';
        }
        if (!found.serverKey) {
            if (!sender) sender = found.peer;
            if (!receiver) receiver = sender.toLowerCase() === me.toLowerCase() ? found.peer : me;
        }
        const label = card.querySelector('.file-message-size');
        const previousLabel = label ? label.textContent : '';
        card.classList.add('is-loading');
        if (label) label.textContent = 'Скачивание…';
        try {
            return await this.runNativeDownload((mode, prefs) => ({
                type: NativeMessageTypes.DOWNLOAD_MESSAGE_ATTACHMENT,
                messageId: String(msg.id),
                sender,
                receiver,
                serverId,
                channelId,
                archivePath: card.getAttribute('data-attachment-path') || '',
                name,
                size: Number(card.getAttribute('data-attachment-size') || 0),
                mode,
                folder: prefs.folder,
            }), name, card);
        } finally {
            card.classList.remove('is-loading');
            if (label) label.textContent = previousLabel;
        }
    }
});
