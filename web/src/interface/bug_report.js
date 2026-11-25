// --- ZaliInterface: «Сообщить об ошибке» — текст и картинки на сервер. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Кнопка #bugReportBtn стоит слева от шестерёнки настроек (в подвале сайдбара;
// на телефоне подвала нет — там вход из Настроек → «Журнал событий»,
// #bugReportSettingsBtn). Окно: явное предупреждение «не отправляйте сюда мусор»,
// поле текста, картинки — вставкой из буфера (Ctrl/⌘+V), перетаскиванием или
// кнопкой «Прикрепить»; «Прикрепить журнал» кладёт в сообщение тот же обезличенный
// снимок состояния, что и «Отправить диагностику» (diagnostic_reports.js).
// Уходит одним JSON на POST /api/bug-reports
// (server/src/bug_reports.rs); картинки — base64 внутри него, как файлы аддонов:
// так тело одинаково проходит через мост каждой нативной оболочки.
//
// Картинки сжимаются на клиенте (длинная сторона ≤ 2000 px): сервер не примет
// больше 3 МиБ на картинку и пяти штук. Предупреждение и лимиты — те же, что в
// Правилах сообщества (п. 8, docs/legal/RULES.md).

const ZALI_BUG_MAX_TEXT = 4000;
const ZALI_BUG_MAX_IMAGES = 5;
// Сервер: 3 МиБ на картинку после декодирования (bug_reports.rs).
const ZALI_BUG_IMAGE_LIMIT_BYTES = 2.8 * 1024 * 1024;
const ZALI_BUG_IMAGE_MAX_SIDE = 2000;

ZaliMixin(ZaliInterface, class {

    closeBugReportDialog() {
        if (this._bugReportDismiss) this._bugReportDismiss();
    }

    openBugReportDialog() {
        // Развёрнутый аддон перекрывает .main — окно над его сценой (как confirmAction).
        const stage = document.getElementById('addonStage');
        const overStage = !!(stage && !stage.hidden && stage.parentElement);
        const host = overStage ? stage.parentElement : (document.querySelector('.main') || document.body);
        if (!host) return;
        this.closeBugReportDialog();

        const guest = !!this.S.session?.guest || !this.S.session?.token;
        const previousFocus = document.activeElement;
        const st = { images: [], sending: false, preparing: 0, withLog: !!this._bugReportWithLog };
        const overlay = document.createElement('div');
        overlay.className = `coin-transfer-modal bug-report-dialog${overStage ? ' is-over-stage' : ''}`;
        overlay.innerHTML = `
            <div class="coin-transfer-box bug-report-box" role="dialog" aria-modal="true" aria-labelledby="bugReportTitle">
                <div class="coin-transfer-head"><h2 id="bugReportTitle">Сообщить об ошибке</h2></div>
                <div class="bug-report-warning" role="note">
                    <strong>Не отправляйте сюда мусор.</strong>
                    <span>Каждое сообщение читает человек. Пустые, шуточные, рекламные и повторяющиеся
                    сообщения, жалобы на других пользователей и вопросы не по теме не рассматриваются, а за
                    злоупотребление отправку могут закрыть (п. 8 Правил сообщества). Опишите, что сломалось,
                    что вы делали и что ожидали увидеть. Пароли и чужие личные данные не присылайте: картинки
                    уходят на сервер как есть.</span>
                </div>
                <label class="coin-transfer-field bug-report-field">
                    <span class="bug-report-label">Что случилось</span>
                    <textarea class="bug-report-text" rows="5"
                        placeholder="Например: после обновления не открывается канал, вместо сообщений пустой экран"></textarea>
                </label>
                <div class="bug-report-images" hidden></div>
                <div class="bug-report-attach">
                    <button class="btn-flat" type="button" data-bug-attach>Прикрепить картинку</button>
                    <span class="settings-help">Или вставьте из буфера (Ctrl/⌘+V), или перетащите сюда. До ${ZALI_BUG_MAX_IMAGES} штук.</span>
                    <input type="file" accept="image/*" multiple hidden data-bug-file>
                </div>
                <div class="bug-report-attach">
                    <button class="btn-flat" type="button" data-bug-log aria-pressed="false">Прикрепить журнал</button>
                    <span class="settings-help bug-report-log-note">События приложения, трасса и состояние соединения — помогают найти причину. Содержимое переписки и ключи не отправляются.</span>
                </div>
                <p class="coin-transfer-status bug-report-status" role="status" aria-live="polite"></p>
                <div class="coin-transfer-actions">
                    <button class="btn-flat" type="button" data-bug-cancel>Отмена</button>
                    <button class="auth-btn primary" type="button" data-bug-send disabled>Отправить</button>
                </div>
            </div>`;
        const box = overlay.querySelector('.bug-report-box');
        const textEl = overlay.querySelector('.bug-report-text');
        const imagesEl = overlay.querySelector('.bug-report-images');
        const statusEl = overlay.querySelector('.bug-report-status');
        const fileEl = overlay.querySelector('[data-bug-file]');
        const attachBtn = overlay.querySelector('[data-bug-attach]');
        const cancelBtn = overlay.querySelector('[data-bug-cancel]');
        const sendBtn = overlay.querySelector('[data-bug-send]');
        const logBtn = overlay.querySelector('[data-bug-log]');
        const syncLogBtn = () => {
            logBtn.textContent = st.withLog ? 'Журнал прикреплён ✓' : 'Прикрепить журнал';
            logBtn.setAttribute('aria-pressed', st.withLog ? 'true' : 'false');
            logBtn.classList.toggle('is-on', st.withLog);
        };
        syncLogBtn();
        textEl.maxLength = ZALI_BUG_MAX_TEXT;
        textEl.value = this._bugReportDraft || '';

        const setStatus = (text, error = false) => {
            statusEl.textContent = text;
            statusEl.classList.toggle('is-error', !!error && !!text);
            statusEl.hidden = !text;
        };
        const sync = () => {
            const filled = textEl.value.trim().length >= 3;
            sendBtn.disabled = guest || st.sending || st.preparing > 0 || !filled;
            attachBtn.disabled = st.sending || st.images.length >= ZALI_BUG_MAX_IMAGES;
            logBtn.disabled = st.sending;
            textEl.disabled = st.sending;
        };
        const renderImages = () => {
            imagesEl.hidden = st.images.length === 0;
            imagesEl.textContent = '';
            st.images.forEach((img) => {
                const cell = document.createElement('div');
                cell.className = 'bug-report-thumb';
                const pic = document.createElement('img');
                pic.src = img.url;
                pic.alt = 'Прикреплённая картинка';
                const rm = document.createElement('button');
                rm.type = 'button';
                rm.className = 'bug-report-thumb-rm';
                rm.setAttribute('aria-label', 'Убрать картинку');
                rm.textContent = '×';
                rm.addEventListener('click', () => {
                    if (st.sending) return;
                    URL.revokeObjectURL(img.url);
                    st.images = st.images.filter(x => x !== img);
                    renderImages();
                    sync();
                });
                cell.append(pic, rm);
                imagesEl.appendChild(cell);
            });
        };
        const addFiles = async (files) => {
            const list = Array.from(files || []).filter(f => f && /^image\//i.test(f.type || ''));
            if (!list.length) return;
            const room = ZALI_BUG_MAX_IMAGES - st.images.length;
            if (room <= 0) {
                setStatus(`Можно прикрепить не больше ${ZALI_BUG_MAX_IMAGES} картинок.`, true);
                return;
            }
            if (list.length > room) setStatus(`Взяли первые ${room}: больше ${ZALI_BUG_MAX_IMAGES} картинок прикрепить нельзя.`, true);
            else setStatus('');
            st.preparing += 1;
            sync();
            try {
                for (const file of list.slice(0, room)) {
                    try {
                        const prepared = await this.bugReportPrepareImage(file);
                        if (!this._bugReportDismiss || this._bugReportDismiss !== finish) {
                            URL.revokeObjectURL(prepared.url);
                            return;
                        }
                        st.images.push(prepared);
                    } catch (e) {
                        setStatus('Не удалось обработать картинку. Попробуйте другую.', true);
                    }
                }
            } finally {
                st.preparing -= 1;
                renderImages();
                sync();
            }
        };

        const finish = () => {
            if (this._bugReportDismiss !== finish) return;
            this._bugReportDismiss = null;
            this._bugReportDraft = textEl.value;
            this._bugReportWithLog = st.withLog;
            document.removeEventListener('keydown', onKey, true);
            st.images.forEach(img => URL.revokeObjectURL(img.url));
            overlay.remove();
            try { previousFocus?.focus?.(); } catch (e) { /* элемента уже нет */ }
        };
        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (!st.sending) finish();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !sendBtn.disabled) {
                e.preventDefault();
                void submit();
            }
        };
        this._bugReportDismiss = finish;

        const submit = async () => {
            if (sendBtn.disabled) return;
            const text = textEl.value.trim();
            st.sending = true;
            sync();
            setStatus(st.images.length ? 'Отправляем… картинки могут грузиться дольше.' : 'Отправляем…');
            let res = null;
            try {
                // Журнал собираем в момент отправки — в нём то, что случилось
                // только что. Тот же обезличенный снимок, что у «Отправить
                // диагностику» (scrubDiagnosticText вычищает токены и ключи);
                // fitDiagnosticReport режет его до лимита сервера.
                let log = null;
                if (st.withLog) {
                    try {
                        this.flushTrace?.();
                        log = JSON.parse(this.fitDiagnosticReport(this.collectDiagnosticsSnapshot('bug_report')));
                    } catch (e) {
                        log = null;
                    }
                }
                res = await this.apiFetch(this.apiRoutes.bugReports.submit, {
                    method: 'POST',
                    interactive: true,
                    timeoutMs: 120000,
                    body: JSON.stringify({
                        text,
                        appVersion: String(window.__ZALI_NATIVE_APP_VERSION || '').trim() || 'web',
                        platform: this.diagnosticPlatform?.() || '',
                        images: st.images.map(img => ({ data: img.data })),
                        ...(log ? { log } : {}),
                    }),
                });
            } catch (e) {
                res = null;
            }
            if (this._bugReportDismiss !== finish) return; // окно закрыли во время отправки
            st.sending = false;
            if (res && res.ok) {
                const data = await res.json().catch(() => ({}));
                const id = String(data?.id || '').slice(0, 8);
                this._bugReportDraft = '';
                textEl.value = '';
                finish();
                this._bugReportWithLog = false;
                this.showToast?.({
                    title: 'Сообщение отправлено',
                    text: id ? `Спасибо! Номер: ${id}` : 'Спасибо!',
                });
                this.addLogEntry?.({ type: 'SUCCESS', msg: `Сообщение об ошибке отправлено${id ? `, номер ${id}` : ''}`, ts: new Date().toLocaleTimeString() });
                return;
            }
            let reason = 'Не удалось отправить — проверьте соединение и попробуйте ещё раз.';
            const code = res ? await res.json().then(j => String(j?.error || '')).catch(() => '') : '';
            if (res?.status === 429) reason = 'Слишком много сообщений за последний час — попробуйте позже.';
            else if (res?.status === 413 || code === 'image_too_large') reason = 'Картинки слишком большие. Уберите часть или прикрепите поменьше.';
            else if (code === 'text_required') reason = 'Опишите проблему хотя бы парой слов.';
            else if (code === 'log_too_large' || code === 'invalid_log') reason = 'Не удалось приложить журнал. Отправьте без него.';
            else if (code === 'text_too_long') reason = 'Слишком длинный текст — сократите описание.';
            else if (code === 'unsupported_image' || code === 'invalid_image') reason = 'Одна из картинок не подходит. Прикрепите PNG, JPEG, WebP или GIF.';
            else if (res?.status === 404 || res?.status === 405) reason = 'Сервер пока не принимает сообщения об ошибках.';
            setStatus(reason, true);
            sync();
        };

        textEl.addEventListener('input', sync);
        textEl.addEventListener('paste', (e) => {
            const files = Array.from(e.clipboardData?.files || []).filter(f => /^image\//i.test(f.type || ''));
            if (files.length) {
                e.preventDefault();
                void addFiles(files);
            }
        });
        box.addEventListener('dragover', (e) => {
            if (Array.from(e.dataTransfer?.types || []).includes('Files')) e.preventDefault();
        });
        box.addEventListener('drop', (e) => {
            const files = Array.from(e.dataTransfer?.files || []);
            if (!files.length) return;
            e.preventDefault();
            void addFiles(files);
        });
        attachBtn.addEventListener('click', () => fileEl.click());
        logBtn.addEventListener('click', () => {
            st.withLog = !st.withLog;
            syncLogBtn();
        });
        fileEl.addEventListener('change', () => {
            void addFiles(fileEl.files);
            fileEl.value = '';
        });
        cancelBtn.addEventListener('click', () => { if (!st.sending) finish(); });
        sendBtn.addEventListener('click', () => { void submit(); });
        overlay.addEventListener('click', (e) => { if (e.target === overlay && !st.sending) finish(); });
        document.addEventListener('keydown', onKey, true);

        setStatus(guest ? 'Войдите в аккаунт, чтобы отправить сообщение об ошибке.' : '', guest);
        sync();
        host.appendChild(overlay);
        textEl.focus();
    }

    // Картинка → { blob, url, data(base64) }, не больше лимита сервера. Скриншоты
    // чаще всего PNG (текст остаётся чётким); если вышло тяжело — JPEG и меньше.
    async bugReportPrepareImage(file) {
        const source = URL.createObjectURL(file);
        let bitmap;
        try {
            bitmap = await new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => resolve(img);
                img.onerror = () => reject(new Error('decode'));
                img.src = source;
            });
        } finally {
            URL.revokeObjectURL(source);
        }
        const natural = Math.max(bitmap.naturalWidth || 0, bitmap.naturalHeight || 0);
        if (!natural) throw new Error('empty');
        const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
        const draw = (scale, opaque) => {
            const canvas = document.createElement('canvas');
            canvas.width = Math.max(1, Math.round(bitmap.naturalWidth * scale));
            canvas.height = Math.max(1, Math.round(bitmap.naturalHeight * scale));
            const ctx = canvas.getContext('2d');
            if (opaque) {
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
            }
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            return canvas;
        };
        let scale = Math.min(1, ZALI_BUG_IMAGE_MAX_SIDE / natural);
        let blob = await toBlob(draw(scale, false), 'image/png');
        for (let round = 0; (!blob || blob.size > ZALI_BUG_IMAGE_LIMIT_BYTES) && round < 5; round += 1) {
            if (round > 0) scale *= 0.75;
            blob = await toBlob(draw(scale, true), 'image/jpeg', round < 2 ? 0.85 : 0.7);
        }
        if (!blob || blob.size > ZALI_BUG_IMAGE_LIMIT_BYTES) throw new Error('too-large');
        const data = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || '').split(',')[1] || '');
            reader.onerror = () => reject(reader.error || new Error('read'));
            reader.readAsDataURL(blob);
        });
        if (!data) throw new Error('empty-data');
        return { blob, url: URL.createObjectURL(blob), data };
    }
});
