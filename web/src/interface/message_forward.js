// --- ZaliInterface: «Копировать» и «Переслать» в меню сообщения. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Пересылка не шлёт
// сообщение сама: она открывает выбранный диалог и кладёт текст и вложения в
// поле ввода — человек видит, что уйдёт, и сам нажимает «Отправить». Так
// пересылка проходит тем же путём (ключи, outbox, вложения), что и обычная отправка.
ZaliMixin(ZaliInterface, class {

    // Текст, который имеет смысл копировать/пересылать: карточки ZaliCoin
    // и записи о звонках — служебные, их текст ничего человеку не говорит.
    messageCopyableText(msg) {
        if (!msg || msg.kind === 'call') return '';
        if (this.parseCoinCard?.(msg.text)) return '';
        return String(msg.text || '').trim();
    }

    canForwardMessage(msg) {
        if (!msg || msg.kind === 'call') return false;
        if (this.parseCoinCard?.(msg.text)) return false;
        return !!this.messageCopyableText(msg) || this.normalizeAttachments(msg.attachments).length > 0;
    }

    async copyMessageText(messageId) {
        const found = this.findMessageById(messageId);
        const text = this.messageCopyableText(found?.msg);
        if (!text) return false;
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch (e) {
            // WebView без доступа к буферу обмена: запасной путь через выделение.
            try {
                const area = document.createElement('textarea');
                area.value = text;
                area.setAttribute('readonly', '');
                area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
                document.body.appendChild(area);
                area.select();
                ok = document.execCommand('copy');
                area.remove();
            } catch (e2) { ok = false; }
        }
        this.addLogEntry({
            type: ok ? 'SUCCESS' : 'WARN',
            msg: ok ? 'Сообщение скопировано' : 'Не удалось скопировать сообщение',
            ts: new Date().toLocaleTimeString(),
        });
        return ok;
    }

    openForwardDialog(messageId) {
        const found = this.findMessageById(messageId);
        if (!found || !this.canForwardMessage(found.msg)) return;
        const text = this.messageCopyableText(found.msg);
        const attachments = this.normalizeAttachments(found.msg.attachments).map(att => ({ ...att }));
        const me = this.myName();
        const peers = Array.from(new Set([...(this.S.contacts || []), this.S.current].filter(Boolean)))
            .filter(name => name && name !== me);
        if (!peers.length) {
            this.addLogEntry({ type: 'WARN', msg: 'Некому переслать: список контактов пуст', ts: new Date().toLocaleTimeString() });
            return;
        }
        document.getElementById('forwardDialog')?.remove();
        const previousFocus = document.activeElement;
        const overlay = document.createElement('div');
        overlay.id = 'forwardDialog';
        overlay.className = 'coin-transfer-modal confirm-dialog';
        overlay.innerHTML = `
            <div class="coin-transfer-box confirm-dialog-box forward-dialog-box" role="dialog" aria-modal="true" aria-labelledby="forwardDialogTitle">
                <div class="coin-transfer-head"><h2 id="forwardDialogTitle">Переслать сообщение</h2></div>
                <div class="forward-dialog-list" role="listbox"></div>
                <div class="coin-transfer-actions">
                    <button class="btn-flat" type="button" data-forward-cancel>Отмена</button>
                </div>
            </div>`;
        const list = overlay.querySelector('.forward-dialog-list');
        for (const name of peers) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'btn-flat forward-dialog-item';
            btn.setAttribute('role', 'option');
            btn.dataset.peer = name;
            btn.textContent = name;
            list.appendChild(btn);
        }
        const onKey = (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        };
        const close = () => {
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            try { previousFocus?.focus?.(); } catch (e) { /* элемента уже нет */ }
        };
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay || e.target.closest('[data-forward-cancel]')) { close(); return; }
            const item = e.target.closest('[data-peer]');
            if (!item) return;
            const peer = item.dataset.peer;
            close();
            // switchChat сбрасывает черновик и цитату — кладём пересылаемое уже после него.
            this.switchChat(peer);
            this.S.editDraft = null;
            this.S.replyDraft = null;
            this.renderComposerContext?.();
            this.S.draftAttachments = attachments;
            this.renderDraftAttachments();
            const input = document.getElementById('msgInput');
            if (input) {
                input.value = text;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.focus();
            }
            this.updateSendButtonState?.();
        });
        document.addEventListener('keydown', onKey, true);
        (document.querySelector('.main') || document.body).appendChild(overlay);
        list.querySelector('button')?.focus();
    }
});
