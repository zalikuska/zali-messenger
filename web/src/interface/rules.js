// --- ZaliInterface: Правила сообщества на экране регистрации. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Текст — docs/legal/RULES.md, единственный источник: bundle_web.py кладёт его в
// window.ZALI_RULES_MD. Создать аккаунт можно только с отмеченным согласием
// (проверка в submitAuth). Проверка клиентская: сервер о правилах не знает.
// Вход в существующий аккаунт согласия не требует.
ZaliMixin(ZaliInterface, class {

    rulesMarkdown() {
        return typeof window.ZALI_RULES_MD === 'string' ? window.ZALI_RULES_MD : '';
    }

    rulesAccepted() {
        return !!document.getElementById('authRulesAccept')?.checked;
    }

    // Строка с галочкой видна только в режиме регистрации.
    renderAuthRulesControls() {
        const row = document.getElementById('authRules');
        if (!row) return;
        row.hidden = this.S.auth.mode !== 'register';
        const box = document.getElementById('authRulesAccept');
        if (box) box.disabled = !!this.S.auth.loading;
    }

    // Инлайн-разметка: только **жирный**. Всё остальное — текст (textContent),
    // HTML из файла не исполняется.
    appendRulesInline(el, text) {
        String(text).split(/(\*\*[^*]+\*\*)/).forEach((part) => {
            if (!part) return;
            if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
                const b = document.createElement('strong');
                b.textContent = part.slice(2, -2);
                el.appendChild(b);
            } else {
                el.appendChild(document.createTextNode(part));
            }
        });
    }

    // Минимальный Markdown → DOM для RULES.md: заголовки, абзацы, списки «- »,
    // **жирный**. Перенос строки внутри абзаца — пробел, как в Markdown.
    renderRulesMarkdown(md) {
        const frag = document.createDocumentFragment();
        let para = null;
        let list = null;
        let item = null;
        const close = () => { para = null; list = null; item = null; };
        String(md || '').split(/\r?\n/).forEach((raw) => {
            const line = raw.trimEnd();
            if (!line.trim() || /^-{3,}$/.test(line.trim())) { close(); return; }
            const heading = line.match(/^(#{1,3})\s+(.*)$/);
            if (heading) {
                close();
                const h = document.createElement(heading[1].length === 1 ? 'h2' : 'h3');
                this.appendRulesInline(h, heading[2]);
                frag.appendChild(h);
                return;
            }
            const bullet = line.match(/^\s*-\s+(.*)$/);
            if (bullet) {
                para = null;
                if (!list) {
                    list = document.createElement('ul');
                    frag.appendChild(list);
                }
                item = document.createElement('li');
                this.appendRulesInline(item, bullet[1]);
                list.appendChild(item);
                return;
            }
            // Продолжение пункта списка (строка с отступом).
            if (item && /^\s+/.test(raw)) {
                this.appendRulesInline(item, ' ' + line.trim());
                return;
            }
            list = null;
            item = null;
            if (!para) {
                para = document.createElement('p');
                frag.appendChild(para);
                this.appendRulesInline(para, line.trim());
            } else {
                this.appendRulesInline(para, ' ' + line.trim());
            }
        });
        return frag;
    }

    closeRulesDialog() {
        if (this._rulesDialogClose) this._rulesDialogClose();
    }

    openRulesDialog() {
        this.closeRulesDialog();
        const host = document.getElementById('authOverlay') || document.body;
        const previousFocus = document.activeElement;
        const overlay = document.createElement('div');
        overlay.className = 'rules-dialog';
        overlay.innerHTML = `
            <div class="rules-dialog-box" role="dialog" aria-modal="true" aria-label="Правила сообщества">
                <div class="rules-dialog-body" tabindex="0"></div>
                <div class="rules-dialog-actions">
                    <button class="auth-link rules-dialog-close" type="button">Закрыть</button>
                    <button class="auth-btn primary rules-dialog-accept" type="button">Принимаю</button>
                </div>
            </div>`;
        const body = overlay.querySelector('.rules-dialog-body');
        const md = this.rulesMarkdown();
        if (md) {
            body.appendChild(this.renderRulesMarkdown(md));
        } else {
            const p = document.createElement('p');
            p.textContent = 'Текст правил не встроен в эту сборку.';
            body.appendChild(p);
        }
        const closeBtn = overlay.querySelector('.rules-dialog-close');
        const acceptBtn = overlay.querySelector('.rules-dialog-accept');

        const onKey = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                close();
            }
        };
        const close = () => {
            if (this._rulesDialogClose !== close) return;
            this._rulesDialogClose = null;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            try { previousFocus?.focus?.(); } catch (e) { /* элемента уже нет */ }
        };
        this._rulesDialogClose = close;

        closeBtn.addEventListener('click', close);
        acceptBtn.addEventListener('click', () => {
            const box = document.getElementById('authRulesAccept');
            if (box) box.checked = true;
            if (this.S.auth.error === this.rulesRequiredMessage()) {
                this.S.auth.error = '';
                this.updateAuthView();
            }
            close();
        });
        overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
        document.addEventListener('keydown', onKey, true);
        host.appendChild(overlay);
        body.focus();
    }

    rulesRequiredMessage() {
        return 'Чтобы создать аккаунт, примите Правила сообщества';
    }

    bindAuthRulesEvents() {
        document.getElementById('authRulesLink')?.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.openRulesDialog();
        });
        document.getElementById('authRulesAccept')?.addEventListener('change', () => {
            if (this.rulesAccepted() && this.S.auth.error === this.rulesRequiredMessage()) {
                this.S.auth.error = '';
                this.updateAuthView();
            }
        });
    }
});
