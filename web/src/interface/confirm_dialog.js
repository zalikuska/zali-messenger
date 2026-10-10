// --- ZaliInterface: подтверждение опасных действий внутри приложения. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Заменяет window.confirm(): WKWebView без runJavaScriptConfirmPanel отвечает
// на confirm() молча и сразу `false` (macOS/iOS-шеллы его не реализуют), а в
// WebView2 и Android WebView системный диалог выглядит у каждой платформы по-своему.
// Свой диалог одинаков везде, а кнопка называется действием, не «ОК».
ZaliMixin(ZaliInterface, class {

    /**
     * @param {{title: string, message?: string, confirmLabel?: string,
     *          cancelLabel?: string, danger?: boolean}} options
     * @returns {Promise<boolean>} true, если пользователь подтвердил.
     */
    confirmAction({ title, message = '', confirmLabel = 'Подтвердить', cancelLabel = 'Отмена', danger = true } = {}) {
        const host = document.querySelector('.main') || document.body;
        if (!host) return Promise.resolve(false);
        // Один диалог за раз: повторный вызов закрывает предыдущий как «Отмена».
        if (this._confirmDialogDismiss) this._confirmDialogDismiss(false);

        return new Promise((resolve) => {
            const previousFocus = document.activeElement;
            const overlay = document.createElement('div');
            overlay.className = 'coin-transfer-modal confirm-dialog';
            overlay.innerHTML = `
                <div class="coin-transfer-box confirm-dialog-box" role="alertdialog" aria-modal="true"
                     aria-labelledby="confirmDialogTitle" aria-describedby="confirmDialogText">
                    <div class="coin-transfer-head"><h2 id="confirmDialogTitle"></h2></div>
                    <p class="confirm-dialog-text" id="confirmDialogText"></p>
                    <div class="coin-transfer-actions">
                        <button class="btn-flat" type="button" data-confirm-cancel></button>
                        <button class="auth-btn primary${danger ? ' is-danger' : ''}" type="button" data-confirm-ok></button>
                    </div>
                </div>`;
            overlay.querySelector('#confirmDialogTitle').textContent = title || '';
            const textEl = overlay.querySelector('#confirmDialogText');
            textEl.textContent = message;
            textEl.hidden = !message;
            const cancelBtn = overlay.querySelector('[data-confirm-cancel]');
            const okBtn = overlay.querySelector('[data-confirm-ok]');
            cancelBtn.textContent = cancelLabel;
            okBtn.textContent = confirmLabel;

            const onKey = (e) => {
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    finish(false);
                    return;
                }
                if (e.key === 'Tab') {
                    // Фокус не уходит за диалог.
                    const order = [cancelBtn, okBtn];
                    const idx = order.indexOf(document.activeElement);
                    e.preventDefault();
                    order[(idx + (e.shiftKey ? order.length - 1 : 1)) % order.length].focus();
                }
            };
            const finish = (result) => {
                if (this._confirmDialogDismiss !== finish) return;
                this._confirmDialogDismiss = null;
                document.removeEventListener('keydown', onKey, true);
                overlay.remove();
                try { previousFocus?.focus?.(); } catch (e) { /* элемента уже нет */ }
                resolve(result);
            };
            this._confirmDialogDismiss = finish;

            cancelBtn.addEventListener('click', () => finish(false));
            okBtn.addEventListener('click', () => finish(true));
            overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); });
            document.addEventListener('keydown', onKey, true);
            host.appendChild(overlay);
            // По умолчанию в фокусе безопасная кнопка: случайный Enter ничего не удалит.
            cancelBtn.focus();
        });
    }
});
