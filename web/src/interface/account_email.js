// --- ZaliInterface: почта аккаунта. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Сервер —
// server/src/account_email.rs, письма — server/src/mail_templates.rs.
//
// Три пути, один набор шагов внутри #authOverlay (.auth-flow, класс is-flow):
//   • после регистрации — код из письма; не ввёл или почты нет — экран «Оставить
//     аккаунт без почты?», где отказ включается только через 5 секунд;
//   • «Забыли пароль?» на экране входа — логин/почта → код → новый пароль;
//   • Настройки → «Почта» — смена почты в диалоге (.coin-transfer-modal).
//
// Пароль на шаге привязки нужен серверу (почту меняют только с ним) и живёт
// только в S.auth.flow, в памяти, до конца шага — никуда не сохраняется.
// Сервер без почты (MAIL_TRANSPORT=off) или старый, без /api/auth/email/config,
// — поля почты и «Забыли пароль?» просто не показываются.
ZaliMixin(ZaliInterface, class {

    // ── Включена ли почта на сервере ─────────────────────────────────────

    emailEnabled() {
        return !!this.S.emailConfig?.enabled;
    }

    emailCodeTtlMinutes() {
        return Math.max(1, Math.round((Number(this.S.emailConfig?.codeTtlSecs) || 900) / 60));
    }

    /** Загружает /api/auth/email/config. Кешируется на адрес сервера. */
    loadEmailConfig({ force = false } = {}) {
        let base = '';
        try { base = this.getApiBaseUrl(); } catch (e) {}
        const fresh = this.S.emailConfig && this._emailConfigBase === base;
        // Пауза после неудачи — только для того же сервера: сменили адрес на экране
        // входа — спрашиваем новый сразу.
        const recentlyFailed = this._emailConfigBase === base
            && this._emailConfigFailedAt && (Date.now() - this._emailConfigFailedAt) < 30000;
        if (!force && (fresh || recentlyFailed) && !this._emailConfigPromise) return Promise.resolve(this.S.emailConfig || null);
        if (!force && this._emailConfigPromise && this._emailConfigBase === base) return this._emailConfigPromise;
        this._emailConfigBase = base;
        const run = (async () => {
            let config = null;
            try {
                const res = await this.apiFetch(this.apiRoutes.auth.emailConfig, { timeoutMs: 8000 });
                if (res.ok) {
                    const data = await res.json();
                    config = {
                        enabled: !!data?.enabled,
                        codeTtlSecs: Number(data?.codeTtlSecs) || 900,
                        resendCooldownSecs: Number(data?.resendCooldownSecs) || 60,
                    };
                    this._emailConfigFailedAt = 0;
                } else if (res.status === 404) {
                    // Сервер старше этой функции — почты у него нет.
                    config = { enabled: false, codeTtlSecs: 900, resendCooldownSecs: 60 };
                    this._emailConfigFailedAt = 0;
                }
            } catch (e) {
                this.trace(`loadEmailConfig failed error=${e?.message || e}`);
            }
            if (!config) {
                this._emailConfigFailedAt = Date.now();
                config = { enabled: false, codeTtlSecs: 900, resendCooldownSecs: 60, unknown: true };
            }
            if (this._emailConfigBase === base) this.S.emailConfig = config;
            return config;
        })();
        this._emailConfigPromise = run;
        run.finally(() => {
            if (this._emailConfigPromise === run) this._emailConfigPromise = null;
            this.updateAuthView();
            this.renderEmailSettings();
            // Сервер не ответил (запуск без сети, сервер ещё поднимается) — сам
            // спросить ещё раз, пока открыт экран входа: иначе «Забыли пароль?» и поле
            // почты не появились бы до первой случайной перерисовки.
            clearTimeout(this._emailConfigRetryTimer);
            if (this.S.emailConfig?.unknown && !this.S.session?.token) {
                this._emailConfigRetryTimer = setTimeout(() => {
                    if (this.S.emailConfig?.unknown && !this.S.session?.token) void this.loadEmailConfig({ force: true });
                }, 30000);
            }
        });
        return run;
    }

    /** `alexander@example.org` → `al•••@example.org` — для журнала: он уходит в диагностические отчёты. */
    maskEmail(value) {
        const text = String(value || '');
        const at = text.lastIndexOf('@');
        if (at < 1) return '•••';
        const local = text.slice(0, at);
        return `${local.slice(0, local.length > 4 ? 2 : 1)}•••${text.slice(at)}`;
    }

    /** Похоже ли на адрес почты. Окончательно решает сервер (normalize_email). */
    looksLikeEmail(value) {
        const text = String(value || '').trim();
        return text.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text);
    }

    async readApiError(res, fallback) {
        const text = await res.text().catch(() => '');
        const clean = String(text || '').trim();
        if (clean && clean.length < 400 && !clean.startsWith('<')) return clean;
        if (res.status === 429) return 'Слишком много попыток. Подождите немного.';
        if (res.status === 503) return 'Сервер пока не отправляет письма.';
        return fallback;
    }

    networkErrorText(e, fallback) {
        const msg = String(e?.message || e || '');
        return NETWORK_FAILURE_TEXT_RE.test(msg) || /network/i.test(msg)
            ? 'Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.'
            : (msg || fallback);
    }

    // ── Поле кода: шесть ячеек поверх одного настоящего поля ─────────────
    // Одно <input autocomplete="one-time-code">, а не шесть: вставка «123 456»,
    // автоподстановка кода из письма на iOS, удаление и выделение работают сами,
    // ячейки только рисуют цифры.

    otpHTML(label = 'Код из письма, 6 цифр') {
        const cells = Array.from({ length: 6 }, () => '<span class="otp-cell"></span>').join('');
        return `
            <div class="otp" data-otp>
                <input class="otp-input" data-otp-input type="text" inputmode="numeric" pattern="[0-9]*"
                       autocomplete="one-time-code" maxlength="6" spellcheck="false" autocapitalize="none"
                       aria-label="${this.esc(label)}">
                <div class="otp-cells" aria-hidden="true">${cells}</div>
            </div>`;
    }

    bindOtp(root, { onChange = null, onComplete = null } = {}) {
        const box = root?.querySelector?.('[data-otp]');
        const input = box?.querySelector('[data-otp-input]');
        if (!box || !input) return null;
        const cells = Array.from(box.querySelectorAll('.otp-cell'));
        const toEnd = () => {
            const end = input.value.length;
            try { input.setSelectionRange(end, end); } catch (e) {}
        };
        const paint = () => {
            const value = input.value;
            const active = Math.min(value.length, cells.length - 1);
            cells.forEach((cell, i) => {
                const digit = value[i] || '';
                if (cell.textContent !== digit) cell.textContent = digit;
                cell.classList.toggle('is-filled', !!digit);
                cell.classList.toggle('is-active', i === active);
            });
        };
        input.addEventListener('input', () => {
            const digits = input.value.replace(/\D+/g, '').slice(0, 6);
            if (digits !== input.value) input.value = digits;
            box.classList.remove('is-error', 'is-success');
            paint();
            onChange?.(digits);
            if (digits.length === 6) onComplete?.(digits);
        });
        input.addEventListener('focus', () => { box.classList.add('is-focused'); toEnd(); });
        input.addEventListener('blur', () => box.classList.remove('is-focused'));
        input.addEventListener('click', toEnd);
        input.addEventListener('keydown', (e) => {
            // Каретка всегда в конце: ячейки — не текстовое поле, ходить по ним незачем.
            if (['ArrowLeft', 'ArrowRight', 'Home', 'End', 'ArrowUp', 'ArrowDown'].includes(e.key)) e.preventDefault();
        });
        paint();
        return {
            input,
            value: () => input.value,
            clear: () => { input.value = ''; paint(); },
            focus: () => input.focus({ preventScroll: true }),
            error: () => {
                box.classList.remove('is-success');
                // Перезапуск анимации встряски: класс снимается и ставится через кадр.
                box.classList.remove('is-error');
                void box.offsetWidth;
                box.classList.add('is-error');
                input.value = '';
                paint();
            },
            success: () => { box.classList.remove('is-error'); box.classList.add('is-success'); },
            setDisabled: (disabled) => { input.disabled = !!disabled; box.classList.toggle('is-disabled', !!disabled); },
        };
    }

    formatCountdown(ms) {
        const total = Math.max(0, Math.ceil(ms / 1000));
        const m = Math.floor(total / 60);
        const s = total % 60;
        return `${m}:${String(s).padStart(2, '0')}`;
    }

    // Фокус в поле — только на компьютере: на телефоне клавиатура закрыла бы
    // то, ради чего открыли шаг (docs/UI_GUIDELINES.md §6).
    focusIfDesktop(el) {
        if (!el || this.isMobileLayout?.()) return;
        requestAnimationFrame(() => el.focus({ preventScroll: true }));
    }

    // ── Регистрация → привязка почты ─────────────────────────────────────

    emailOnboardingStorageKey() {
        return 'zali_email_onboarding_v1';
    }

    /** Чей шаг с почтой не закончен (строчными) — '' если ничей. */
    emailOnboardingPendingFor() {
        try { return String(localStorage.getItem(this.emailOnboardingStorageKey()) || '').trim().toLowerCase(); } catch (e) { return ''; }
    }

    clearEmailOnboardingFlag() {
        try { localStorage.removeItem(this.emailOnboardingStorageKey()); } catch (e) {}
        // Приветствие нового аккаунта ждало этого шага.
        this.maybeShowWelcomeTour?.();
    }

    /** executeAuth/executeNativeAuth после успешной регистрации. */
    beginRegistrationEmailStep(password) {
        const pending = this._registrationEmail;
        this._registrationEmail = null;
        if (!pending) return;
        this.beginEmailOnboarding({ email: pending.email, password, username: this.myName() });
    }

    /** Шаг с почтой после регистрации через форму. */
    beginEmailOnboarding({ email = '', password = '', username = '' } = {}) {
        if (!this.emailEnabled()) return;
        const address = String(email || '').trim();
        try { localStorage.setItem(this.emailOnboardingStorageKey(), String(username || this.myName() || '').toLowerCase()); } catch (e) {}
        this.S.auth.flow = {
            kind: 'email',
            step: address ? 'code' : 'skip',
            prevStep: address ? 'code' : 'enter',
            email: address,
            password: String(password || ''),
            username: String(username || this.myName() || ''),
            error: '',
            busy: !!address,
            resendAt: 0,
            sent: false,
        };
        this.addLogEntry({ type: 'INFO', msg: address ? 'Отправляем код подтверждения почты' : 'Почта при регистрации не указана', ts: new Date().toLocaleTimeString() });
        this.updateAuthView();
        if (address) void this.flowSendEmailCode();
    }

    /**
     * Регистрация прервалась перезагрузкой до конца шага с почтой — вернуться к нему,
     * если почта так и не привязана. Пароля в памяти уже нет: шаг «почта» спросит его.
     */
    async maybeResumeEmailOnboarding() {
        const pendingFor = this.emailOnboardingPendingFor();
        const me = this.myName();
        if (!pendingFor || !me || this.S.auth.flow) return;
        if (pendingFor !== me.toLowerCase()) {
            this.clearEmailOnboardingFlag();
            return;
        }
        await this.loadEmailConfig();
        if (this.myName() !== me || this.S.auth.flow) return;
        if (!this.emailEnabled()) {
            // Сервер перестал слать письма (или связи нет) — шаг не вернуть, не держим и приветствие.
            if (!this.S.emailConfig?.unknown) this.clearEmailOnboardingFlag();
            return;
        }
        const status = await this.loadAccountEmailStatus();
        if (!status || this.S.auth.flow || this.myName() !== me) return;
        if (status.email) {
            this.clearEmailOnboardingFlag();
            return;
        }
        const pending = status.pending;
        this.S.auth.flow = {
            kind: 'email',
            step: pending ? 'code' : 'skip',
            prevStep: pending ? 'code' : 'enter',
            email: pending?.email || '',
            password: '',
            username: me,
            error: '',
            busy: false,
            resendAt: pending ? Date.now() + (Number(pending.resendIn) || 0) * 1000 : 0,
            sent: !!pending,
        };
        this.updateAuthView();
    }

    async flowSendEmailCode() {
        const flow = this.S.auth.flow;
        if (!flow || flow.kind !== 'email') return;
        const email = String(flow.email || '').trim();
        if (!this.looksLikeEmail(email)) {
            flow.step = 'enter';
            flow.error = 'Проверьте адрес почты';
            flow.busy = false;
            this.updateAuthView();
            return;
        }
        if (!flow.password) {
            flow.step = 'enter';
            flow.error = 'Введите пароль аккаунта';
            flow.busy = false;
            this.updateAuthView();
            return;
        }
        flow.busy = true;
        flow.error = '';
        this.syncAuthFlow();
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.email, {
                method: 'POST',
                body: JSON.stringify({ email, password: flow.password }),
                interactive: true,
            });
            if (this.S.auth.flow !== flow) return;
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                flow.email = String(data?.pending?.email || email);
                flow.resendAt = Date.now() + (Number(data?.pending?.resendIn ?? this.S.emailConfig?.resendCooldownSecs) || 60) * 1000;
                flow.sent = true;
                flow.step = 'code';
                this.addLogEntry({ type: 'SUCCESS', msg: `Код отправлен на ${this.maskEmail(flow.email)}`, ts: new Date().toLocaleTimeString() });
            } else {
                const message = await this.readApiError(res, 'Не удалось отправить код');
                if (res.status === 403) flow.password = '';
                // Уже отправленный код (повтор раньше минуты) — остаёмся на вводе кода.
                if (res.status === 429 && flow.sent) {
                    flow.step = 'code';
                } else {
                    flow.step = 'enter';
                }
                flow.error = message;
            }
        } catch (e) {
            if (this.S.auth.flow !== flow) return;
            flow.step = 'enter';
            flow.error = this.networkErrorText(e, 'Не удалось отправить код');
        } finally {
            if (this.S.auth.flow === flow) {
                flow.busy = false;
                this.updateAuthView();
            }
        }
    }

    async flowResendEmailCode() {
        const flow = this.S.auth.flow;
        if (!flow || flow.kind !== 'email' || flow.busy || Date.now() < flow.resendAt) return;
        flow.busy = true;
        flow.error = '';
        this.syncAuthFlow();
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.emailResend, { method: 'POST', body: '{}', interactive: true });
            if (this.S.auth.flow !== flow) return;
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                flow.resendAt = Date.now() + (Number(data?.pending?.resendIn ?? 60) || 60) * 1000;
                flow.notice = 'Новый код отправлен. Прежний больше не действует.';
                this._authFlowOtp?.clear();
                this._authFlowOtp?.focus();
            } else if (res.status === 404 && flow.password) {
                // Заявка истекла (сутки) — начать заново тем же паролем.
                flow.busy = false;
                await this.flowSendEmailCode();
                return;
            } else {
                flow.error = await this.readApiError(res, 'Не удалось отправить код');
                if (res.status === 404) flow.step = 'enter';
            }
        } catch (e) {
            if (this.S.auth.flow === flow) flow.error = this.networkErrorText(e, 'Не удалось отправить код');
        } finally {
            if (this.S.auth.flow === flow) {
                flow.busy = false;
                this.updateAuthView();
            }
        }
    }

    async flowConfirmEmailCode(code) {
        const flow = this.S.auth.flow;
        if (!flow || flow.kind !== 'email' || flow.busy) return;
        const digits = String(code || this._authFlowOtp?.value() || '').replace(/\D+/g, '');
        if (digits.length !== 6) {
            flow.error = 'Введите все 6 цифр кода';
            this.syncAuthFlow();
            return;
        }
        flow.busy = true;
        flow.error = '';
        flow.notice = '';
        this.syncAuthFlow();
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.emailConfirm, {
                method: 'POST',
                body: JSON.stringify({ code: digits }),
                interactive: true,
            });
            if (this.S.auth.flow !== flow) return;
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                flow.email = String(data?.email || flow.email);
                this.S.accountEmail = { email: flow.email, verifiedAt: data?.verifiedAt || null, pending: null, enabled: true };
                this._authFlowOtp?.success();
                flow.password = '';
                this.addLogEntry({ type: 'SUCCESS', msg: `Почта ${this.maskEmail(flow.email)} привязана к аккаунту`, ts: new Date().toLocaleTimeString() });
                // Короткая пауза — ячейки успевают стать лаймовыми, это и есть «принято».
                await new Promise(resolve => setTimeout(resolve, 420));
                if (this.S.auth.flow !== flow) return;
                flow.step = 'done';
            } else {
                flow.error = await this.readApiError(res, 'Неверный код');
                this._authFlowOtp?.error();
            }
        } catch (e) {
            if (this.S.auth.flow === flow) flow.error = this.networkErrorText(e, 'Не удалось проверить код');
        } finally {
            if (this.S.auth.flow === flow) {
                flow.busy = false;
                this.updateAuthView();
                if (flow.step === 'code') this._authFlowOtp?.focus();
            }
        }
    }

    flowGoSkip() {
        const flow = this.S.auth.flow;
        if (!flow || flow.kind !== 'email') return;
        if (flow.step !== 'skip') flow.prevStep = flow.step === 'done' ? 'enter' : flow.step;
        flow.step = 'skip';
        flow.error = '';
        this.updateAuthView();
    }

    flowBackFromSkip() {
        const flow = this.S.auth.flow;
        if (!flow || flow.kind !== 'email') return;
        flow.step = flow.sent && flow.email ? (flow.prevStep === 'enter' ? 'enter' : 'code') : 'enter';
        flow.error = '';
        this.updateAuthView();
    }

    finishEmailOnboarding({ skipped = false } = {}) {
        const flow = this.S.auth.flow;
        if (!flow || flow.kind !== 'email') return;
        if (skipped) {
            if (Date.now() < (flow.skipUnlockAt || 0)) return;
            // Код, если он ушёл, гасим: аккаунт остаётся без почты осознанно.
            if (flow.sent) {
                void this.apiFetch(this.apiRoutes.auth.emailPending, { method: 'DELETE' }).catch(() => {});
            }
            this.addLogEntry({ type: 'WARN', msg: 'Аккаунт оставлен без почты — восстановить пароль будет нельзя', ts: new Date().toLocaleTimeString() });
            this.S.accountEmail = { ...(this.S.accountEmail || {}), email: this.S.accountEmail?.email || null, pending: null };
        }
        flow.password = '';
        this.S.auth.flow = null;
        try { localStorage.removeItem(this.emailOnboardingStorageKey()); } catch (e) {}
        this.updateAuthView();
        this.renderEmailSettings();
    }

    // ── «Забыли пароль?» ─────────────────────────────────────────────────

    openPasswordReset() {
        if (!this.emailEnabled()) return;
        const typed = String(document.getElementById('authUsername')?.value || '').trim();
        this.S.auth.failure = null;
        this.S.auth.flow = {
            kind: 'reset',
            step: 'request',
            login: typed,
            username: '',
            resetToken: '',
            error: '',
            busy: false,
            resendAt: 0,
        };
        this.updateAuthView();
    }

    closePasswordReset({ username = '' } = {}) {
        const flow = this.S.auth.flow;
        if (!flow || flow.kind !== 'reset') return;
        const prefill = username || flow.username || (flow.login && !flow.login.includes('@') ? flow.login : '');
        flow.resetToken = '';
        this.S.auth.flow = null;
        this.updateAuthView();
        const input = document.getElementById('authUsername');
        if (input && prefill && !this.S.session?.token) input.value = prefill;
        if (!this.S.session?.token) {
            const target = prefill ? document.getElementById('authPassword') : input;
            this.focusIfDesktop(target);
        }
    }

    async flowRequestReset() {
        const flow = this.S.auth.flow;
        if (!flow || flow.kind !== 'reset' || flow.busy) return;
        const field = document.getElementById('authFlowLogin');
        if (field) flow.login = String(field.value || '').trim();
        if (!flow.login) {
            flow.error = 'Укажите логин или почту';
            this.syncAuthFlow();
            this.focusIfDesktop(field);
            return;
        }
        flow.busy = true;
        flow.error = '';
        this.syncAuthFlow();
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.passwordReset, {
                method: 'POST',
                body: JSON.stringify({ login: flow.login }),
                interactive: true,
            });
            if (this.S.auth.flow !== flow) return;
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                flow.resendAt = Date.now() + (Number(data?.resendCooldownSecs) || 60) * 1000;
                if (flow.step === 'code') {
                    flow.notice = 'Если почта привязана, новый код уже в пути. Прежний больше не действует.';
                    this._authFlowOtp?.clear();
                }
                flow.step = 'code';
            } else {
                flow.error = await this.readApiError(res, 'Не удалось запросить код');
            }
        } catch (e) {
            if (this.S.auth.flow === flow) flow.error = this.networkErrorText(e, 'Не удалось запросить код');
        } finally {
            if (this.S.auth.flow === flow) {
                flow.busy = false;
                this.updateAuthView();
            }
        }
    }

    async flowVerifyResetCode(code) {
        const flow = this.S.auth.flow;
        if (!flow || flow.kind !== 'reset' || flow.busy) return;
        const digits = String(code || this._authFlowOtp?.value() || '').replace(/\D+/g, '');
        if (digits.length !== 6) {
            flow.error = 'Введите все 6 цифр кода';
            this.syncAuthFlow();
            return;
        }
        flow.busy = true;
        flow.error = '';
        flow.notice = '';
        this.syncAuthFlow();
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.passwordResetVerify, {
                method: 'POST',
                body: JSON.stringify({ login: flow.login, code: digits }),
                interactive: true,
            });
            if (this.S.auth.flow !== flow) return;
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                flow.resetToken = String(data?.resetToken || '');
                flow.username = String(data?.username || '');
                if (!flow.resetToken) throw new Error('Сервер не выдал токен сброса');
                this._authFlowOtp?.success();
                await new Promise(resolve => setTimeout(resolve, 380));
                if (this.S.auth.flow !== flow) return;
                flow.step = 'password';
            } else {
                flow.error = await this.readApiError(res, 'Неверный или устаревший код');
                this._authFlowOtp?.error();
            }
        } catch (e) {
            if (this.S.auth.flow === flow) flow.error = this.networkErrorText(e, 'Не удалось проверить код');
        } finally {
            if (this.S.auth.flow === flow) {
                flow.busy = false;
                this.updateAuthView();
                if (flow.step === 'code') this._authFlowOtp?.focus();
            }
        }
    }

    async flowCompleteReset() {
        const flow = this.S.auth.flow;
        if (!flow || flow.kind !== 'reset' || flow.busy) return;
        const next = String(document.getElementById('authFlowNewPassword')?.value || '');
        const repeat = String(document.getElementById('authFlowNewPasswordRepeat')?.value || '');
        if (next.length < 8) {
            flow.error = 'Пароль должен быть не короче 8 символов';
            this.syncAuthFlow();
            return;
        }
        if (next !== repeat) {
            flow.error = 'Пароли не совпадают';
            this.syncAuthFlow();
            this.focusIfDesktop(document.getElementById('authFlowNewPasswordRepeat'));
            return;
        }
        flow.busy = true;
        flow.error = '';
        this.syncAuthFlow();
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.passwordResetComplete, {
                method: 'POST',
                body: JSON.stringify({ resetToken: flow.resetToken, newPassword: next }),
                interactive: true,
            });
            if (this.S.auth.flow !== flow) return;
            if (!res.ok) {
                flow.error = await this.readApiError(res, 'Не удалось сменить пароль');
                // Токен сгорел (10 минут) — вернуться к запросу кода.
                if (/устарел/i.test(flow.error)) {
                    flow.resetToken = '';
                    flow.step = 'request';
                }
                return;
            }
            const data = await res.json();
            const username = String(data?.username || flow.username);
            flow.resetToken = '';
            this.S.auth.flow = null;
            this.S.auth.dismissed = false;
            // Тот же путь, что у входа по паролю (executeAuth): новый пароль — это и
            // новая парольная фраза облачного vault. Старый vault сервер уже удалил:
            // он зашифрован забытым паролем.
            this.applySession({ username, token: data.token, guest: false });
            if (typeof data.cloudVaultSyncEnabled !== 'undefined') {
                this.applyVaultCloudSyncEnabled(!!data.cloudVaultSyncEnabled, { persistLocal: true });
            }
            this.S.auth.vaultPassphrase = next;
            this.setAuthMode('login', { clearInputs: true, focus: false });
            this.startPostAuthSetup({
                passphrase: next,
                reason: 'password-reset',
                saveUnlockSecret: true,
                resetVault: true,
            });
            this.addLogEntry({ type: 'SUCCESS', msg: `Пароль сброшен по почте, вход выполнен как ${username}`, ts: new Date().toLocaleTimeString() });
            this.showToast({
                title: 'Пароль изменён',
                text: 'Остальные устройства вышли из аккаунта. Если какая-то переписка не читается — правой кнопкой по собеседнику → «Восстановить переписку».',
                tone: 'success',
                timeoutMs: 9000,
            });
        } catch (e) {
            if (this.S.auth.flow === flow) flow.error = this.networkErrorText(e, 'Не удалось сменить пароль');
        } finally {
            if (this.S.auth.flow === flow) flow.busy = false;
            this.updateAuthView();
        }
    }

    // ── Отрисовка шагов в #authFlow ───────────────────────────────────────

    authFlowTemplate(flow) {
        const esc = (v) => this.esc(String(v ?? ''));
        const ttl = this.emailCodeTtlMinutes();
        const icon = (name) => this.flowIcon(name);
        const links = (items) => `<div class="auth-flow-links">${items}</div>`;
        const errorBox = '<div class="auth-flow-error" data-flow-error role="alert"></div>';
        const noticeBox = '<div class="auth-flow-notice" data-flow-notice role="status"></div>';
        if (flow.kind === 'email') {
            if (flow.step === 'enter') {
                const needPassword = !flow.password;
                return `
                    <div class="auth-flow-step">
                        <span class="auth-flow-kicker">Шаг 2 из 2 · почта</span>
                        <h1>Привяжите почту</h1>
                        <p>Пришлём на неё код из 6 цифр. По почте можно будет сбросить пароль, если вы его забудете.</p>
                    </div>
                    <form class="auth-flow-form" data-flow-form="email-send" novalidate>
                        <input id="authFlowEmail" class="auth-input" type="email" inputmode="email" autocomplete="email"
                               placeholder="Почта" aria-label="Почта" autocapitalize="none" spellcheck="false" maxlength="254" value="${esc(flow.email)}">
                        ${needPassword ? `<input id="authFlowPassword" class="auth-input" type="password" autocomplete="current-password"
                               placeholder="Пароль аккаунта" aria-label="Пароль аккаунта" maxlength="72">` : ''}
                        ${errorBox}
                        <div class="auth-actions"><button class="auth-btn primary" type="submit" data-flow-primary>Отправить код</button></div>
                    </form>
                    ${links('<button class="auth-flow-link" type="button" data-flow-action="email-skip">Пропустить</button>')}`;
            }
            if (flow.step === 'code') {
                return `
                    <div class="auth-flow-step">
                        <span class="auth-flow-kicker">Шаг 2 из 2 · почта</span>
                        <h1>Введите код</h1>
                        <p>Отправили код из 6 цифр на <strong class="auth-flow-target" data-flow-email>${esc(flow.email)}</strong>. Он действует ${ttl} минут.</p>
                    </div>
                    <form class="auth-flow-form" data-flow-form="email-code" novalidate>
                        ${this.otpHTML()}
                        ${errorBox}${noticeBox}
                        <div class="auth-actions"><button class="auth-btn primary" type="submit" data-flow-primary disabled>Подтвердить</button></div>
                    </form>
                    <div class="auth-flow-row">
                        <button class="auth-link" type="button" data-flow-action="email-resend" data-flow-resend>Отправить ещё раз</button>
                        <button class="auth-link" type="button" data-flow-action="email-change">Другая почта</button>
                    </div>
                    <p class="auth-flow-hint">Письма нет пару минут? Загляните в «Спам» и отметьте письмо как «Не спам».</p>
                    ${links('<button class="auth-flow-link" type="button" data-flow-action="email-skip">Пропустить</button>')}`;
            }
            if (flow.step === 'skip') {
                return `
                    <div class="auth-flow-step">
                        <h1>Оставить аккаунт без почты?</h1>
                        <p>Без почты забытый пароль не восстановить: доступ к аккаунту, контактам и переписке пропадёт навсегда — вернуть его не сможем даже мы.</p>
                    </div>
                    <div class="auth-flow-facts">
                        <div class="auth-flow-fact is-warn">
                            <span class="auth-flow-fact-icon">${icon('lock-off')}</span>
                            <div><strong>Сброс пароля недоступен</strong><span>Код для сброса приходит только на подтверждённую почту.</span></div>
                        </div>
                        <div class="auth-flow-fact">
                            <span class="auth-flow-fact-icon">${icon('gear')}</span>
                            <div><strong>Можно привязать позже</strong><span>Настройки → Аккаунт и безопасность → Почта.</span></div>
                        </div>
                    </div>
                    <div class="auth-actions auth-flow-actions">
                        <button class="auth-btn primary" type="button" data-flow-action="email-back">Привязать почту</button>
                        <button class="auth-btn auth-btn--countdown is-counting" type="button" data-flow-action="email-skip-confirm" disabled aria-disabled="true">
                            <span class="auth-countdown-fill" aria-hidden="true"></span>
                            <span class="auth-countdown-label">Продолжить без почты</span>
                            <span class="auth-countdown-num" data-flow-countdown aria-hidden="true">5</span>
                        </button>
                    </div>`;
            }
            if (flow.step === 'done') {
                return `
                    <div class="auth-flow-success" aria-hidden="true">${icon('check')}</div>
                    <div class="auth-flow-step">
                        <h1>Почта привязана</h1>
                        <p>Если забудете пароль, сбросите его кодом из письма на <strong class="auth-flow-target" data-flow-email>${esc(flow.email)}</strong>. Сменить почту можно в настройках.</p>
                    </div>
                    <div class="auth-actions"><button class="auth-btn primary" type="button" data-flow-action="email-done">Продолжить</button></div>`;
            }
        }
        if (flow.kind === 'reset') {
            if (flow.step === 'request') {
                return `
                    <div class="auth-flow-step">
                        <h1>Сброс пароля</h1>
                        <p>Укажите логин или почту аккаунта — пришлём код на привязанную почту.</p>
                    </div>
                    <form class="auth-flow-form" data-flow-form="reset-request" novalidate>
                        <input id="authFlowLogin" class="auth-input" type="text" autocomplete="username" placeholder="Логин или почта"
                               aria-label="Логин или почта" autocapitalize="none" spellcheck="false" maxlength="254" value="${esc(flow.login)}">
                        ${errorBox}
                        <div class="auth-actions"><button class="auth-btn primary" type="submit" data-flow-primary>Получить код</button></div>
                    </form>
                    ${links('<button class="auth-flow-link" type="button" data-flow-action="reset-cancel">Вернуться ко входу</button>')}`;
            }
            if (flow.step === 'code') {
                return `
                    <div class="auth-flow-step">
                        <h1>Код из письма</h1>
                        <p>Если к аккаунту <strong class="auth-flow-target" data-flow-login>${esc(flow.login)}</strong> привязана почта, код уже в пути. Он действует ${ttl} минут.</p>
                    </div>
                    <form class="auth-flow-form" data-flow-form="reset-code" novalidate>
                        ${this.otpHTML()}
                        ${errorBox}${noticeBox}
                        <div class="auth-actions"><button class="auth-btn primary" type="submit" data-flow-primary disabled>Продолжить</button></div>
                    </form>
                    <div class="auth-flow-row">
                        <button class="auth-link" type="button" data-flow-action="reset-resend" data-flow-resend>Отправить ещё раз</button>
                        <button class="auth-link" type="button" data-flow-action="reset-change">Другой аккаунт</button>
                    </div>
                    <p class="auth-flow-hint">Не приходит — проверьте «Спам». Если к аккаунту не привязана почта, сбросить пароль, к сожалению, нельзя.</p>
                    ${links('<button class="auth-flow-link" type="button" data-flow-action="reset-cancel">Вернуться ко входу</button>')}`;
            }
            if (flow.step === 'password') {
                return `
                    <div class="auth-flow-step">
                        <h1>Новый пароль</h1>
                        <p>Для аккаунта <strong class="auth-flow-target" data-flow-username>${esc(flow.username)}</strong>, не короче 8 символов.</p>
                    </div>
                    <form class="auth-flow-form" data-flow-form="reset-password" novalidate>
                        <input type="text" autocomplete="username" value="${esc(flow.username)}" tabindex="-1" aria-hidden="true" hidden>
                        <input id="authFlowNewPassword" class="auth-input" type="password" autocomplete="new-password" placeholder="Новый пароль" aria-label="Новый пароль" maxlength="72">
                        <input id="authFlowNewPasswordRepeat" class="auth-input" type="password" autocomplete="new-password" placeholder="Повторите пароль" aria-label="Повторите пароль" maxlength="72">
                        <div class="auth-flow-fact is-note">
                            <span class="auth-flow-fact-icon">${icon('devices')}</span>
                            <div><strong>Все устройства выйдут из аккаунта</strong><span>Ключи переписок, сохранённые в облаке под старым паролем, удалятся. Переписки вернут ваши другие устройства или собеседники: правой кнопкой по собеседнику → «Восстановить переписку».</span></div>
                        </div>
                        ${errorBox}
                        <div class="auth-actions"><button class="auth-btn primary" type="submit" data-flow-primary>Сохранить и войти</button></div>
                    </form>
                    ${links('<button class="auth-flow-link" type="button" data-flow-action="reset-cancel">Отмена</button>')}`;
            }
        }
        return '';
    }

    flowIcon(name) {
        const attrs = 'viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
        const icons = {
            check: `<svg ${attrs} stroke-width="2.4"><path d="m5.5 12.5 4.2 4.2 8.8-9.4"/></svg>`,
            'lock-off': `<svg ${attrs}><rect x="5" y="10.5" width="14" height="9.5" rx="2.4"/><path d="M8.2 10.5V8a3.8 3.8 0 0 1 7.3-1.5"/><path d="m4 4 16 16"/></svg>`,
            gear: `<svg ${attrs}><path d="M10.4 3.25h3.2l.55 2.32c.54.2 1.05.5 1.5.87l2.27-.72 1.6 2.76-1.72 1.62c.05.3.08.6.08.9s-.03.6-.08.9l1.72 1.62-1.6 2.76-2.27-.72c-.45.37-.96.67-1.5.87l-.55 2.32h-3.2l-.55-2.32a5.78 5.78 0 0 1-1.5-.87l-2.27.72-1.6-2.76L6.2 11.9a5.6 5.6 0 0 1 0-1.8L4.48 8.48l1.6-2.76 2.27.72c.45-.37.96-.67 1.5-.87l.55-2.32Z"/><circle cx="12" cy="11" r="2.65"/></svg>`,
            devices: `<svg ${attrs}><rect x="3.5" y="5" width="12.5" height="9" rx="1.8"/><path d="M2.5 17.5h15"/><rect x="17" y="8.5" width="4.5" height="10" rx="1.4"/></svg>`,
            mail: `<svg ${attrs}><rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="m4.5 7.5 7.5 5.3 7.5-5.3"/></svg>`,
            'mail-warn': `<svg ${attrs}><rect x="3.5" y="5.5" width="17" height="13" rx="2.6"/><path d="m4.5 7.5 7.5 5.3 7.5-5.3"/><path d="M18.8 2.6v2.6"/></svg>`,
            server: `<svg ${attrs}><rect x="4" y="4.5" width="16" height="6" rx="1.8"/><rect x="4" y="13.5" width="16" height="6" rx="1.8"/><path d="M8 7.5h.01M8 16.5h.01"/></svg>`,
        };
        return icons[name] || '';
    }

    renderAuthFlow() {
        const el = document.getElementById('authFlow');
        const overlay = document.getElementById('authOverlay');
        const flow = this.S.auth.flow;
        if (overlay) {
            overlay.classList.toggle('is-flow', !!flow);
            if (flow) {
                overlay.dataset.flowKind = flow.kind;
                overlay.dataset.flowStep = flow.step;
            } else {
                delete overlay.dataset.flowKind;
                delete overlay.dataset.flowStep;
            }
        }
        if (!el) return;
        if (!flow) {
            if (!el.hidden) el.hidden = true;
            if (this._authFlowRendered) {
                el.innerHTML = '';
                this._authFlowRendered = '';
                this._authFlowOtp = null;
            }
            this.stopAuthFlowTicker();
            return;
        }
        el.hidden = false;
        const signature = `${flow.kind}:${flow.step}`;
        if (signature !== this._authFlowRendered) {
            el.innerHTML = this.authFlowTemplate(flow);
            this._authFlowRendered = signature;
            this._authFlowOtp = null;
            if (flow.step === 'skip') flow.skipUnlockAt = Date.now() + 5000;
            const otpOwner = el.querySelector('[data-otp]');
            if (otpOwner) {
                this._authFlowOtp = this.bindOtp(el, {
                    onChange: () => {
                        const f = this.S.auth.flow;
                        if (f && f.error) { f.error = ''; }
                        if (f) f.notice = '';
                        this.syncAuthFlow();
                    },
                    onComplete: (code) => {
                        const f = this.S.auth.flow;
                        if (!f || f.busy) return;
                        if (f.kind === 'email') void this.flowConfirmEmailCode(code);
                        else void this.flowVerifyResetCode(code);
                    },
                });
            }
            const first = this._authFlowOtp?.input
                || el.querySelector('#authFlowEmail:not([value]), #authFlowEmail[value=""]')
                || el.querySelector('#authFlowPassword')
                || el.querySelector('#authFlowEmail')
                || el.querySelector('#authFlowLogin')
                || el.querySelector('#authFlowNewPassword');
            this.focusIfDesktop(first);
        }
        this.syncAuthFlow();
        this.startAuthFlowTicker();
    }

    /** Подвижные части шага: занятость, ошибка, обратные отсчёты. Без перерисовки. */
    syncAuthFlow() {
        const el = document.getElementById('authFlow');
        const flow = this.S.auth.flow;
        if (!el || !flow) return;
        const set = (node, text) => { if (node && node.textContent !== text) node.textContent = text; };
        const errorEl = el.querySelector('[data-flow-error]');
        set(errorEl, flow.error || '');
        errorEl?.classList.toggle('is-shown', !!flow.error);
        const noticeEl = el.querySelector('[data-flow-notice]');
        set(noticeEl, flow.error ? '' : (flow.notice || ''));
        noticeEl?.classList.toggle('is-shown', !flow.error && !!flow.notice);

        const primary = el.querySelector('[data-flow-primary]');
        if (primary) {
            if (!primary.dataset.label) primary.dataset.label = primary.textContent;
            const otpIncomplete = !!this._authFlowOtp && this._authFlowOtp.value().length < 6;
            primary.disabled = !!flow.busy || otpIncomplete;
            primary.classList.toggle('is-busy', !!flow.busy);
            const busyLabel = {
                'email-send': 'Отправляем…', 'email-code': 'Проверяем…', 'reset-request': 'Отправляем…',
                'reset-code': 'Проверяем…', 'reset-password': 'Сохраняем…',
            }[primary.closest('[data-flow-form]')?.dataset.flowForm || ''] || primary.dataset.label;
            set(primary, flow.busy ? busyLabel : primary.dataset.label);
        }
        // Пока код уходит сразу после регистрации, ячейки ждут.
        if (this._authFlowOtp) this._authFlowOtp.setDisabled(!!flow.busy);
        el.querySelectorAll('[data-flow-email]').forEach(node => set(node, flow.email || ''));
        this.syncAuthFlowTimers();
    }

    syncAuthFlowTimers() {
        const el = document.getElementById('authFlow');
        const flow = this.S.auth.flow;
        if (!el || !flow) return;
        const now = Date.now();
        const resend = el.querySelector('[data-flow-resend]');
        if (resend) {
            const left = (flow.resendAt || 0) - now;
            const waiting = left > 0;
            const label = waiting ? `Ещё раз через ${this.formatCountdown(left)}` : 'Отправить ещё раз';
            if (resend.textContent !== label) resend.textContent = label;
            resend.disabled = waiting || !!flow.busy || (flow.kind === 'email' && !flow.sent);
        }
        const countdownBtn = el.querySelector('[data-flow-action="email-skip-confirm"]');
        if (countdownBtn) {
            const left = (flow.skipUnlockAt || 0) - now;
            const locked = left > 0;
            const num = countdownBtn.querySelector('[data-flow-countdown]');
            const seconds = String(Math.max(1, Math.ceil(left / 1000)));
            if (num && locked && num.textContent !== seconds) num.textContent = seconds;
            if (num) num.hidden = !locked;
            countdownBtn.disabled = locked;
            countdownBtn.setAttribute('aria-disabled', locked ? 'true' : 'false');
            countdownBtn.classList.toggle('is-counting', locked);
            countdownBtn.setAttribute('aria-label', locked ? `Продолжить без почты — станет доступно через ${seconds} с` : 'Продолжить без почты');
        }
    }

    startAuthFlowTicker() {
        if (this._authFlowTicker) return;
        this._authFlowTicker = setInterval(() => {
            if (!this.S.auth.flow) { this.stopAuthFlowTicker(); return; }
            this.syncAuthFlowTimers();
        }, 250);
    }

    stopAuthFlowTicker() {
        if (this._authFlowTicker) clearInterval(this._authFlowTicker);
        this._authFlowTicker = null;
    }

    /** Один раз, из bindAuthEvents(): все действия шагов — делегатом на #authFlow. */
    bindAccountEmailEvents() {
        document.getElementById('authForgotBtn')?.addEventListener('click', () => this.openPasswordReset());
        const host = document.getElementById('authFlow');
        if (!host) return;
        host.addEventListener('submit', (e) => {
            const form = e.target.closest('[data-flow-form]');
            if (!form) return;
            e.preventDefault();
            const flow = this.S.auth.flow;
            if (!flow || flow.busy) return;
            switch (form.dataset.flowForm) {
                case 'email-send': {
                    flow.email = String(document.getElementById('authFlowEmail')?.value || '').trim();
                    const pw = document.getElementById('authFlowPassword');
                    if (pw) flow.password = String(pw.value || '');
                    void this.flowSendEmailCode();
                    break;
                }
                case 'email-code': void this.flowConfirmEmailCode(); break;
                case 'reset-request': void this.flowRequestReset(); break;
                case 'reset-code': void this.flowVerifyResetCode(); break;
                case 'reset-password': void this.flowCompleteReset(); break;
                default: break;
            }
        });
        host.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-flow-action]');
            if (!btn || btn.disabled) return;
            const flow = this.S.auth.flow;
            if (!flow) return;
            switch (btn.dataset.flowAction) {
                case 'email-skip': this.flowGoSkip(); break;
                case 'email-back': this.flowBackFromSkip(); break;
                case 'email-skip-confirm': this.finishEmailOnboarding({ skipped: true }); break;
                case 'email-done': this.finishEmailOnboarding(); break;
                case 'email-resend': void this.flowResendEmailCode(); break;
                case 'email-change':
                    flow.step = 'enter';
                    flow.error = '';
                    flow.notice = '';
                    this.updateAuthView();
                    break;
                case 'reset-cancel': this.closePasswordReset(); break;
                case 'reset-resend':
                    if (Date.now() >= (flow.resendAt || 0)) void this.flowRequestReset();
                    break;
                case 'reset-change':
                    flow.step = 'request';
                    flow.error = '';
                    flow.notice = '';
                    this.updateAuthView();
                    break;
                default: break;
            }
        });
        host.addEventListener('input', (e) => {
            if (!e.target.matches('.auth-input')) return;
            const flow = this.S.auth.flow;
            if (flow?.error) {
                flow.error = '';
                this.syncAuthFlow();
            }
        });
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            const flow = this.S.auth.flow;
            if (!flow || document.querySelector('.coin-transfer-modal')) return;
            if (flow.kind === 'reset') {
                e.preventDefault();
                this.closePasswordReset();
            } else if (flow.kind === 'email' && (flow.step === 'enter' || flow.step === 'code')) {
                e.preventDefault();
                this.flowGoSkip();
            }
        });
    }

    // ── Настройки → «Почта» ──────────────────────────────────────────────

    async loadAccountEmailStatus() {
        if (!this.S.session?.token || this.S.session?.guest) return null;
        const user = this.myName();
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.email, { timeoutMs: 10000 });
            if (!res.ok) return null;
            const data = await res.json();
            if (this.myName() !== user) return null;
            this.S.accountEmail = {
                enabled: !!data?.enabled,
                email: data?.email || null,
                verifiedAt: data?.verifiedAt || null,
                pending: data?.pending || null,
            };
            this.renderEmailSettings();
            return this.S.accountEmail;
        } catch (e) {
            this.trace(`loadAccountEmailStatus failed error=${e?.message || e}`);
            return null;
        }
    }

    /** Зовётся при открытии настроек: свежий статус почты и сразу отрисовка. */
    refreshEmailSettings() {
        this.renderEmailSettings();
        void this.loadEmailConfig().then(() => {
            if (this.emailEnabled()) void this.loadAccountEmailStatus();
        });
    }

    renderEmailSettings() {
        const card = document.getElementById('emailSettingsCard');
        const host = document.getElementById('emailSettings');
        if (!card || !host) return;
        const signedIn = !!this.S.session?.token && !this.S.session?.guest;
        card.hidden = !signedIn;
        if (!signedIn) {
            this.setHTMLIfChanged(host, '');
            return;
        }
        const cfg = this.S.emailConfig;
        const status = this.S.accountEmail;
        const esc = (v) => this.esc(String(v ?? ''));
        // Пока ответа нет — тишина, а не «Загрузка…» (§2 п. 3 гайдлайнов).
        if (!cfg) { this.setHTMLIfChanged(host, ''); return; }
        if (!cfg.enabled) {
            this.setHTMLIfChanged(host, `
                <div class="email-row">
                    <span class="email-row-icon">${this.flowIcon('server')}</span>
                    <div class="email-row-text">
                        <strong>${cfg.unknown ? 'Сервер не ответил' : 'Сервер не отправляет письма'}</strong>
                        <span>${cfg.unknown ? 'Статус почты появится, когда будет связь.' : 'Привязать почту и сбросить по ней пароль на этом сервере нельзя.'}</span>
                    </div>
                </div>`);
            return;
        }
        if (!status) { this.setHTMLIfChanged(host, ''); return; }
        const pending = status.pending?.email ? `
            <div class="email-pending">
                <span>Ждёт подтверждения: <strong>${esc(status.pending.email)}</strong></span>
                <button class="btn-flat email-btn" type="button" data-email-action="code">Ввести код</button>
            </div>` : '';
        if (status.email) {
            this.setHTMLIfChanged(host, `
                <div class="email-row is-linked">
                    <span class="email-row-icon is-mine">${this.flowIcon('mail')}</span>
                    <div class="email-row-text">
                        <strong class="email-address">${esc(status.email)}</strong>
                        <span>Подтверждена · по ней можно сбросить пароль</span>
                    </div>
                    <button class="btn-flat email-btn" type="button" data-email-action="change">Сменить</button>
                </div>
                ${pending}`);
            return;
        }
        this.setHTMLIfChanged(host, `
            <div class="email-row is-missing">
                <span class="email-row-icon is-warn">${this.flowIcon('mail-warn')}</span>
                <div class="email-row-text">
                    <strong>Почта не привязана</strong>
                    <span>Если забудете пароль, восстановить аккаунт не получится.</span>
                </div>
            </div>
            ${pending}
            <button class="auth-btn primary email-link-btn" type="button" data-email-action="link">Привязать почту</button>`);
    }

    bindEmailSettingsEvents() {
        const host = document.getElementById('emailSettings');
        if (!host || host.dataset.bound) return;
        host.dataset.bound = '1';
        host.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-email-action]');
            if (!btn) return;
            const action = btn.dataset.emailAction;
            if (action === 'code') this.openEmailDialog({ step: 'code', email: this.S.accountEmail?.pending?.email || '' });
            else this.openEmailDialog({ step: 'form', change: action === 'change' });
        });
    }

    // ── Диалог смены почты (каркас .coin-transfer-modal) ─────────────────

    openEmailDialog({ step = 'form', change = false, email = '' } = {}) {
        this.closeEmailDialog();
        const host = document.querySelector('.main') || document.body;
        const overlay = document.createElement('div');
        overlay.className = 'coin-transfer-modal email-dialog';
        overlay.innerHTML = `
            <div class="coin-transfer-box email-dialog-box" role="dialog" aria-modal="true" aria-labelledby="emailDialogTitle">
                <div class="coin-transfer-head">
                    <h2 id="emailDialogTitle"></h2>
                    <button class="avatar-crop-close" type="button" aria-label="Закрыть" data-email-dialog="close">×</button>
                </div>
                <div class="email-dialog-body" data-email-dialog-body></div>
            </div>`;
        const state = {
            step,
            change: change || !!this.S.accountEmail?.email,
            email: email || '',
            password: '',
            error: '',
            notice: '',
            busy: false,
            resendAt: step === 'code' ? Date.now() + (Number(this.S.accountEmail?.pending?.resendIn) || 0) * 1000 : 0,
            canResend: step === 'code',
            otp: null,
            overlay,
            previousFocus: document.activeElement,
        };
        this._emailDialog = state;
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) { this.closeEmailDialog(); return; }
            const btn = e.target.closest('[data-email-dialog]');
            if (!btn || btn.disabled) return;
            const action = btn.dataset.emailDialog;
            if (action === 'close' || action === 'cancel') this.closeEmailDialog();
            else if (action === 'resend') void this.emailDialogResend();
            else if (action === 'other') { state.step = 'form'; state.error = ''; state.notice = ''; this.renderEmailDialog(); }
        });
        overlay.addEventListener('submit', (e) => {
            e.preventDefault();
            if (state.busy) return;
            if (state.step === 'form') void this.emailDialogSend();
            else if (state.step === 'code') void this.emailDialogConfirm();
            else this.closeEmailDialog();
        });
        overlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeEmailDialog(); }
        });
        host.appendChild(overlay);
        this.renderEmailDialog();
        state.ticker = setInterval(() => this.syncEmailDialogTimers(), 250);
    }

    closeEmailDialog() {
        const state = this._emailDialog;
        if (!state) return;
        this._emailDialog = null;
        clearInterval(state.ticker);
        state.password = '';
        state.overlay.remove();
        try { state.previousFocus?.focus?.({ preventScroll: true }); } catch (e) {}
        this.renderEmailSettings();
    }

    renderEmailDialog() {
        const state = this._emailDialog;
        if (!state) return;
        const box = state.overlay;
        const title = box.querySelector('#emailDialogTitle');
        const body = box.querySelector('[data-email-dialog-body]');
        const esc = (v) => this.esc(String(v ?? ''));
        const ttl = this.emailCodeTtlMinutes();
        const titles = {
            form: state.change ? 'Сменить почту' : 'Привязать почту',
            code: 'Код из письма',
            done: 'Почта привязана',
        };
        title.textContent = titles[state.step] || '';
        const current = this.S.accountEmail?.email;
        state.otp = null;
        if (state.step === 'form') {
            body.innerHTML = `
                <form class="email-dialog-form" novalidate>
                    <p class="email-dialog-text">${state.change && current
                        ? `Сейчас: <strong>${esc(current)}</strong>. Пришлём код на новый адрес, а на прежний — уведомление о смене.`
                        : 'Пришлём на неё код из 6 цифр. По почте можно сбросить пароль, если вы его забудете.'}</p>
                    <label class="email-dialog-label" for="emailDialogAddress">${state.change ? 'Новая почта' : 'Почта'}</label>
                    <input id="emailDialogAddress" class="settings-input email-dialog-input" type="email" inputmode="email" autocomplete="email"
                           placeholder="name@example.com" autocapitalize="none" spellcheck="false" maxlength="254" value="${esc(state.email)}">
                    <label class="email-dialog-label" for="emailDialogPassword">Текущий пароль</label>
                    <input id="emailDialogPassword" class="settings-input email-dialog-input" type="password" autocomplete="current-password" maxlength="72">
                    <div class="email-dialog-error" data-email-error role="alert"></div>
                    <div class="coin-transfer-actions">
                        <button class="btn-flat" type="button" data-email-dialog="cancel">Отмена</button>
                        <button class="auth-btn primary" type="submit" data-email-primary>Отправить код</button>
                    </div>
                </form>`;
            this.focusIfDesktop(body.querySelector(state.email ? '#emailDialogPassword' : '#emailDialogAddress'));
        } else if (state.step === 'code') {
            body.innerHTML = `
                <form class="email-dialog-form" novalidate>
                    <p class="email-dialog-text">Отправили код на <strong>${esc(state.email)}</strong>. Он действует ${ttl} минут.</p>
                    ${this.otpHTML()}
                    <div class="email-dialog-error" data-email-error role="alert"></div>
                    <div class="email-dialog-notice" data-email-notice role="status"></div>
                    <div class="email-dialog-row">
                        <button class="email-dialog-link" type="button" data-email-dialog="resend" data-email-resend>Отправить ещё раз</button>
                        <button class="email-dialog-link" type="button" data-email-dialog="other">Другая почта</button>
                    </div>
                    <div class="coin-transfer-actions">
                        <button class="btn-flat" type="button" data-email-dialog="cancel">Отмена</button>
                        <button class="auth-btn primary" type="submit" data-email-primary disabled>Подтвердить</button>
                    </div>
                </form>`;
            state.otp = this.bindOtp(body, {
                onChange: () => { state.error = ''; state.notice = ''; this.syncEmailDialog(); },
                onComplete: (code) => { if (!state.busy) void this.emailDialogConfirm(code); },
            });
            this.focusIfDesktop(state.otp?.input);
        } else {
            body.innerHTML = `
                <form class="email-dialog-form" novalidate>
                    <div class="email-dialog-done">
                        <span class="email-dialog-done-mark" aria-hidden="true">${this.flowIcon('check')}</span>
                        <p class="email-dialog-text">Теперь пароль можно сбросить кодом из письма на <strong>${esc(state.email)}</strong>.</p>
                    </div>
                    <div class="coin-transfer-actions">
                        <button class="auth-btn primary" type="submit" data-email-primary>Готово</button>
                    </div>
                </form>`;
            this.focusIfDesktop(body.querySelector('[data-email-primary]'));
        }
        this.syncEmailDialog();
    }

    syncEmailDialog() {
        const state = this._emailDialog;
        if (!state) return;
        const box = state.overlay;
        const err = box.querySelector('[data-email-error]');
        if (err && err.textContent !== state.error) err.textContent = state.error || '';
        err?.classList.toggle('is-shown', !!state.error);
        const notice = box.querySelector('[data-email-notice]');
        const noticeText = state.error ? '' : (state.notice || '');
        if (notice && notice.textContent !== noticeText) notice.textContent = noticeText;
        notice?.classList.toggle('is-shown', !!noticeText);
        const primary = box.querySelector('[data-email-primary]');
        if (primary) {
            if (!primary.dataset.label) primary.dataset.label = primary.textContent;
            const otpIncomplete = !!state.otp && state.otp.value().length < 6;
            primary.disabled = state.busy || otpIncomplete;
            const busyText = state.step === 'form' ? 'Отправляем…' : 'Проверяем…';
            const text = state.busy ? busyText : primary.dataset.label;
            if (primary.textContent !== text) primary.textContent = text;
        }
        state.otp?.setDisabled(state.busy);
        this.syncEmailDialogTimers();
    }

    syncEmailDialogTimers() {
        const state = this._emailDialog;
        if (!state) return;
        const resend = state.overlay.querySelector('[data-email-resend]');
        if (!resend) return;
        const left = (state.resendAt || 0) - Date.now();
        const label = left > 0 ? `Ещё раз через ${this.formatCountdown(left)}` : 'Отправить ещё раз';
        if (resend.textContent !== label) resend.textContent = label;
        resend.disabled = left > 0 || state.busy || !state.canResend;
    }

    async emailDialogSend() {
        const state = this._emailDialog;
        if (!state || state.busy) return;
        const box = state.overlay;
        state.email = String(box.querySelector('#emailDialogAddress')?.value || '').trim();
        state.password = String(box.querySelector('#emailDialogPassword')?.value || '');
        if (!this.looksLikeEmail(state.email)) {
            state.error = 'Проверьте адрес почты';
            this.syncEmailDialog();
            return;
        }
        if (!state.password) {
            state.error = 'Введите текущий пароль';
            this.syncEmailDialog();
            this.focusIfDesktop(box.querySelector('#emailDialogPassword'));
            return;
        }
        state.busy = true;
        state.error = '';
        this.syncEmailDialog();
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.email, {
                method: 'POST',
                body: JSON.stringify({ email: state.email, password: state.password }),
                interactive: true,
            });
            if (this._emailDialog !== state) return;
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                state.email = String(data?.pending?.email || state.email);
                state.resendAt = Date.now() + (Number(data?.pending?.resendIn ?? 60) || 60) * 1000;
                state.canResend = true;
                state.step = 'code';
                state.password = '';
                state.busy = false;
                this.S.accountEmail = { ...(this.S.accountEmail || {}), pending: data?.pending || { email: state.email } };
                this.renderEmailDialog();
                return;
            }
            state.error = await this.readApiError(res, 'Не удалось отправить код');
        } catch (e) {
            if (this._emailDialog === state) state.error = this.networkErrorText(e, 'Не удалось отправить код');
        }
        if (this._emailDialog === state) {
            state.busy = false;
            this.syncEmailDialog();
        }
    }

    async emailDialogResend() {
        const state = this._emailDialog;
        if (!state || state.busy || Date.now() < state.resendAt) return;
        state.busy = true;
        state.error = '';
        this.syncEmailDialog();
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.emailResend, { method: 'POST', body: '{}', interactive: true });
            if (this._emailDialog !== state) return;
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                state.resendAt = Date.now() + (Number(data?.pending?.resendIn ?? 60) || 60) * 1000;
                state.notice = 'Новый код отправлен. Прежний больше не действует.';
                state.otp?.clear();
            } else {
                state.error = await this.readApiError(res, 'Не удалось отправить код');
                if (res.status === 404) { state.step = 'form'; state.busy = false; this.renderEmailDialog(); return; }
            }
        } catch (e) {
            if (this._emailDialog === state) state.error = this.networkErrorText(e, 'Не удалось отправить код');
        }
        if (this._emailDialog === state) {
            state.busy = false;
            this.syncEmailDialog();
            state.otp?.focus();
        }
    }

    async emailDialogConfirm(code) {
        const state = this._emailDialog;
        if (!state || state.busy) return;
        const digits = String(code || state.otp?.value() || '').replace(/\D+/g, '');
        if (digits.length !== 6) return;
        state.busy = true;
        state.error = '';
        state.notice = '';
        this.syncEmailDialog();
        try {
            const res = await this.apiFetch(this.apiRoutes.auth.emailConfirm, {
                method: 'POST',
                body: JSON.stringify({ code: digits }),
                interactive: true,
            });
            if (this._emailDialog !== state) return;
            if (res.ok) {
                const data = await res.json().catch(() => ({}));
                state.email = String(data?.email || state.email);
                this.S.accountEmail = { enabled: true, email: state.email, verifiedAt: data?.verifiedAt || null, pending: null };
                state.otp?.success();
                this.addLogEntry({ type: 'SUCCESS', msg: `Почта ${this.maskEmail(state.email)} привязана к аккаунту`, ts: new Date().toLocaleTimeString() });
                try { localStorage.removeItem(this.emailOnboardingStorageKey()); } catch (e) {}
                await new Promise(resolve => setTimeout(resolve, 420));
                if (this._emailDialog !== state) return;
                state.busy = false;
                state.step = 'done';
                this.renderEmailDialog();
                this.renderEmailSettings();
                return;
            }
            state.error = await this.readApiError(res, 'Неверный код');
            state.otp?.error();
        } catch (e) {
            if (this._emailDialog === state) state.error = this.networkErrorText(e, 'Не удалось проверить код');
        }
        if (this._emailDialog === state) {
            state.busy = false;
            this.syncEmailDialog();
            state.otp?.focus();
        }
    }

    // ── Всплывающее уведомление ──────────────────────────────────────────
    // Плавающий слой (§4 «Плавающие слои»): подложка и тень — только через --menu-*.

    showToast({ title = '', text = '', tone = '', timeoutMs = 6000 } = {}) {
        let stack = document.getElementById('zaliToasts');
        if (!stack) {
            stack = document.createElement('div');
            stack.id = 'zaliToasts';
            stack.className = 'zali-toasts';
            stack.setAttribute('role', 'status');
            stack.setAttribute('aria-live', 'polite');
            document.body.appendChild(stack);
        }
        const toast = document.createElement('div');
        toast.className = `zali-toast${tone ? ` is-${tone}` : ''}`;
        const mark = document.createElement('span');
        mark.className = 'zali-toast-mark';
        mark.setAttribute('aria-hidden', 'true');
        const body = document.createElement('div');
        body.className = 'zali-toast-body';
        if (title) {
            const strong = document.createElement('strong');
            strong.textContent = title;
            body.appendChild(strong);
        }
        if (text) {
            const span = document.createElement('span');
            span.textContent = text;
            body.appendChild(span);
        }
        const close = document.createElement('button');
        close.type = 'button';
        close.className = 'zali-toast-close';
        close.setAttribute('aria-label', 'Закрыть');
        close.innerHTML = this.uiIcon('close');
        toast.append(mark, body, close);
        const dismiss = () => {
            if (!toast.isConnected) return;
            toast.classList.add('is-leaving');
            setTimeout(() => toast.remove(), 200);
        };
        close.addEventListener('click', dismiss);
        stack.appendChild(toast);
        while (stack.children.length > 3) stack.firstElementChild?.remove();
        if (timeoutMs > 0) setTimeout(dismiss, timeoutMs);
        return dismiss;
    }
});
