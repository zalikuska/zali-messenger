// --- ZaliInterface: приветствие нового аккаунта — тема, схема, разделы, стиль. ---
// Часть класса ZaliInterface (см. web/src/interface.js, порядок — web/src/manifest.json).
//
// Показывается один раз, сразу после регистрации (queueWelcomeTour из auth.js;
// флаг zali_welcome_pending_v1 = имя аккаунта переживает перезагрузку посреди
// приветствия). Каждый выбор применяется сразу и теми же путями, что в настройках
// (zali_styler:set_appearance / set_theme, saveDesignMode, saveUiV2Segments), —
// поэтому «Пропустить» на любом шаге оставляет уже выбранное, а синхронизация
// настроек между устройствами (settings_sync.js) подхватывает его как обычно.
//
// Анимации: появление логотипа пузырями, смена шагов, круговая смена темы через
// View Transitions (где их нет — мгновенно). Всё гасится prefers-reduced-motion.
ZaliMixin(ZaliInterface, class {

    welcomeTourPendingKey() {
        return 'zali_welcome_pending_v1';
    }

    welcomeTourSteps() {
        return ['hello', 'appearance', 'scheme', 'segments', 'style', 'done'];
    }

    /** Аккаунт только что создан: показать приветствие, как только уйдёт экран входа. */
    queueWelcomeTour(username) {
        const name = String(username || this.myName?.() || '').trim().toLowerCase();
        if (!name) return;
        try { localStorage.setItem(this.welcomeTourPendingKey(), name); } catch (e) { /* без хранилища — покажем только сейчас */ }
        this._welcomeQueuedFor = name;
        // Экран входа гаснет 320 мс (updateAuthView) — приветствие встаёт следом.
        setTimeout(() => this.maybeShowWelcomeTour(), 380);
    }

    /** Снять ожидающее приветствие, не показывая (вход ссылкой разработчика). */
    cancelWelcomeTour() {
        this._welcomeQueuedFor = '';
        try { localStorage.removeItem(this.welcomeTourPendingKey()); } catch (e) {}
        if (this._welcome?.open) this.finishWelcomeTour();
    }

    maybeShowWelcomeTour() {
        if (this._welcome?.open) return;
        const session = this.S?.session;
        if (!session?.token || session.guest) return;
        let pending = this._welcomeQueuedFor || '';
        try { pending = localStorage.getItem(this.welcomeTourPendingKey()) || pending; } catch (e) {}
        const me = String(this.myName?.() || session.username || '').trim().toLowerCase();
        if (!pending || pending !== me) return;
        this.openWelcomeTour();
    }

    welcomeReducedMotion() {
        try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch (e) { return false; }
    }

    openWelcomeTour() {
        if (this._welcome?.open) return;
        document.getElementById('welcomeTour')?.remove();
        const root = document.createElement('div');
        root.id = 'welcomeTour';
        root.className = 'wt';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-labelledby', 'wtTitle');
        root.innerHTML = `
            <div class="wt-shell">
                <header class="wt-top">
                    <div class="wt-progress" aria-hidden="true"><span class="wt-progress-fill"></span></div>
                    <button type="button" class="wt-skip" data-wt-skip>Пропустить</button>
                </header>
                <div class="wt-stage"></div>
                <footer class="wt-nav">
                    <button type="button" class="wt-btn wt-btn--ghost" data-wt-back>Назад</button>
                    <button type="button" class="wt-btn wt-btn--primary" data-wt-next>Далее</button>
                </footer>
            </div>`;
        document.body.appendChild(root);
        this._welcome = { open: true, root, index: 0, busy: false };
        root.addEventListener('click', (e) => this.onWelcomeClick(e));
        this._welcomeKey = (e) => {
            if (!this._welcome?.open) return;
            if (e.key === 'Escape') { e.preventDefault(); this.finishWelcomeTour(); }
        };
        document.addEventListener('keydown', this._welcomeKey, true);
        this.renderWelcomeStep(0, 0);
        // Кадр на раскладку, потом класс — иначе появление не анимируется.
        requestAnimationFrame(() => root.classList.add('is-open'));
    }

    /** Системное «назад» на телефоне (mobile.js: handleMobileBack). */
    welcomeTourBack() {
        if (!this._welcome?.open) return false;
        if (this._welcome.index > 0) this.goWelcomeStep(this._welcome.index - 1);
        else this.finishWelcomeTour();
        return true;
    }

    finishWelcomeTour() {
        const st = this._welcome;
        if (!st?.open) return;
        st.open = false;
        try { localStorage.removeItem(this.welcomeTourPendingKey()); } catch (e) {}
        this._welcomeQueuedFor = '';
        document.removeEventListener('keydown', this._welcomeKey, true);
        const root = st.root;
        root.classList.remove('is-open');
        root.classList.add('is-closing');
        setTimeout(() => root.remove(), this.welcomeReducedMotion() ? 0 : 320);
    }

    goWelcomeStep(next) {
        const st = this._welcome;
        if (!st?.open || st.busy) return;
        const steps = this.welcomeTourSteps();
        const target = Math.max(0, Math.min(steps.length - 1, next));
        if (target === st.index) return;
        const dir = target > st.index ? 1 : -1;
        st.index = target;
        this.renderWelcomeStep(target, dir);
    }

    renderWelcomeStep(index, dir) {
        const st = this._welcome;
        const root = st.root;
        const steps = this.welcomeTourSteps();
        const id = steps[index];
        const stage = root.querySelector('.wt-stage');
        const old = stage.querySelector('.wt-step.is-current');
        const step = document.createElement('section');
        step.className = 'wt-step is-current';
        step.dataset.step = id;
        step.innerHTML = this.welcomeStepHTML(id);
        const reduced = this.welcomeReducedMotion();
        if (old) {
            old.classList.remove('is-current', 'is-entering', 'is-enter-back');
            old.classList.add(dir < 0 ? 'is-leave-back' : 'is-leaving');
            old.setAttribute('aria-hidden', 'true');
            old.inert = true;
            st.busy = !reduced;
            setTimeout(() => { old.remove(); st.busy = false; }, reduced ? 0 : 240);
        }
        step.classList.add('is-entering');
        if (dir < 0) step.classList.add('is-enter-back');
        stage.appendChild(step);
        this.syncWelcomeChrome();
        // Фокус — на главную кнопку шага, без прокрутки.
        root.querySelector('[data-wt-next]')?.focus({ preventScroll: true });
    }

    syncWelcomeChrome() {
        const st = this._welcome;
        const root = st.root;
        const steps = this.welcomeTourSteps();
        const id = steps[st.index];
        // Шкала — только по шагам выбора: приветствие и финал её не двигают.
        const choice = steps.length - 2;
        const done = Math.max(0, Math.min(choice, st.index - 1 + (id === 'done' ? 1 : 0)));
        const fill = root.querySelector('.wt-progress-fill');
        if (fill) fill.style.transform = `scaleX(${id === 'hello' ? 0 : (done + (id === 'done' ? 0 : 1)) / choice})`;
        root.dataset.step = id;
        const back = root.querySelector('[data-wt-back]');
        const next = root.querySelector('[data-wt-next]');
        const skip = root.querySelector('[data-wt-skip]');
        if (back) back.hidden = id === 'hello' || id === 'done';
        if (skip) skip.hidden = id === 'done';
        if (next) next.textContent = id === 'hello' ? 'Начнём' : id === 'done' ? 'Начать общение' : 'Далее';
    }

    onWelcomeClick(e) {
        const t = e.target.closest('button');
        if (!t || !this._welcome?.open) return;
        if (t.hasAttribute('data-wt-next')) {
            const steps = this.welcomeTourSteps();
            if (steps[this._welcome.index] === 'done') this.finishWelcomeTour();
            else this.goWelcomeStep(this._welcome.index + 1);
            return;
        }
        if (t.hasAttribute('data-wt-back')) { this.goWelcomeStep(this._welcome.index - 1); return; }
        if (t.hasAttribute('data-wt-skip')) { this.finishWelcomeTour(); return; }
        const appearance = t.getAttribute('data-wt-appearance');
        if (appearance) {
            this.welcomeApplyLook(e, () => this.bus?.send?.('zali_styler:set_appearance', appearance));
            return;
        }
        const theme = t.getAttribute('data-wt-theme');
        if (theme) {
            this.welcomeApplyLook(e, () => this.bus?.send?.('zali_styler:set_theme', theme));
            return;
        }
        const mode = t.getAttribute('data-wt-style');
        if (mode) {
            this.welcomeApplyLook(e, () => this.saveDesignMode(mode));
            return;
        }
        const seg = t.getAttribute('data-wt-segment');
        if (seg) this.toggleWelcomeSegment(seg, t);
        const component = t.getAttribute('data-wt-component');
        if (component) this.toggleWelcomeComponent(component, t);
    }

    /** Смена облика с волной (motion.js); отметки выбора — в том же колбэке:
     *  колбэк View Transition асинхронный, обновлённые до него отметки читали
     *  старое состояние. */
    welcomeApplyLook(event, change) {
        this.applyLookWave(event, () => { change(); this.refreshWelcomeStep(); });
    }

    /** Отметки выбора на текущем шаге — без пересборки шага (иначе он заново въедет). */
    refreshWelcomeStep() {
        const st = this._welcome;
        const step = st?.root.querySelector('.wt-step.is-current');
        if (!step) return;
        const look = this.welcomeLookState();
        const mark = (sel, attr, value) => step.querySelectorAll(sel).forEach(el => {
            const on = el.getAttribute(attr) === value;
            el.classList.toggle('is-active', on);
            el.setAttribute('aria-checked', String(on));
        });
        mark('[data-wt-appearance]', 'data-wt-appearance', look.appearance);
        mark('[data-wt-theme]', 'data-wt-theme', look.theme);
        mark('[data-wt-style]', 'data-wt-style', look.style);
        const name = step.querySelector('[data-wt-scheme-name]');
        if (name) name.textContent = this.welcomeSchemeLabel(look.theme);
    }

    welcomeLookState() {
        let appearance = 'system';
        let theme = 'lime';
        try {
            const a = this.bus?.send?.('zali_styler:get_appearance');
            if (a?.mode) appearance = a.mode;
        } catch (e) {}
        try { theme = localStorage.getItem('zali_theme_name_v1') || theme; } catch (e) {}
        const activeTheme = document.querySelector('.btn-theme[data-theme].active, .btn-theme[data-theme].is-active');
        if (activeTheme) theme = activeTheme.getAttribute('data-theme') || theme;
        return { appearance, theme, style: this.normalizeDesignMode(this.designMode) };
    }

    welcomeSchemes() {
        return [
            ['lime', 'Lime'], ['cyber', 'Cyberpunk'], ['matrix', 'Matrix'], ['ocean', 'Ocean'], ['mono', 'Mono'],
            ['ember', 'Ember'], ['aurora', 'Aurora'], ['graphite', 'Graphite'], ['rose', 'Rose'], ['violet', 'Violet'],
        ];
    }

    welcomeSchemeLabel(id) {
        return (this.welcomeSchemes().find(([k]) => k === id) || [id, id])[1];
    }

    /** Логотип пузырями: те же пропорции, что у brand/logo (ступени 33/54/75 %). */
    welcomeLogoHTML(extra = '') {
        const rows = [['in', 100], ['out start', 33], ['out mid', 54], ['out end', 75], ['in', 100]];
        return `<div class="wt-logo${this.esc(extra)}" aria-hidden="true">${rows.map(([kind, w], i) =>
            `<span class="wt-b ${this.esc(kind.split(' ').map(k => 'wt-b--' + k).join(' '))}" style="--i:${this.esc(String(i))};--w:${this.esc(String(w))}%"></span>`).join('')}</div>`;
    }

    welcomeStepHTML(id) {
        const look = this.welcomeLookState();
        const on = (cond) => cond ? ' is-active' : '';
        const aria = (cond) => `aria-checked="${cond}"`;
        const head = (title, lead, k = 0) => `
            <h2 class="wt-title" id="wtTitle" style="--k:${this.esc(String(k))}">${title}</h2>
            <p class="wt-lead" style="--k:${this.esc(String(k + 1))}">${lead}</p>`;
        if (id === 'hello') {
            const name = this.esc(this.myName?.() || this.S?.session?.username || '');
            return `
                <div class="wt-hero">
                    ${this.welcomeLogoHTML()}
                    <h1 class="wt-title wt-title--hero" id="wtTitle" style="--k:5">Добро пожаловать${name ? `, <span class="wt-name">${name}</span>` : ''}</h1>
                    <p class="wt-lead" style="--k:6">Настроим Zali под вас — это полминуты. Любой выбор потом меняется в настройках.</p>
                </div>`;
        }
        if (id === 'appearance') {
            const opts = [
                ['system', 'Как в системе', 'Следует за темой устройства'],
                ['dark', 'Тёмная', 'Спокойная, для вечера и ночи'],
                ['light', 'Светлая', 'Тёплая бумага вместо белого'],
            ];
            return `
                ${head('Тема', 'Светлая, тёмная или та же, что у устройства. Переключается сразу — смотрите вживую.')}
                <div class="wt-options wt-options--3" role="radiogroup" aria-label="Тема">
                    ${opts.map(([v, label, sub], i) => `
                        <button type="button" class="wt-opt${this.esc(on(look.appearance === v))}" data-wt-appearance="${this.esc(v)}" role="radio" ${aria(look.appearance === v)} style="--k:${this.esc(String(i + 2))}">
                            <span class="wt-mini wt-mini--${this.esc(v)}" aria-hidden="true">
                                <i class="wt-mini-in"></i><i class="wt-mini-out"></i><i class="wt-mini-in wt-mini-in--short"></i>
                            </span>
                            <span class="wt-opt-copy"><strong>${label}</strong><small>${sub}</small></span>
                            <span class="wt-mark" aria-hidden="true"></span>
                        </button>`).join('')}
                </div>`;
        }
        if (id === 'scheme') {
            return `
                ${head('Цветовая схема', 'Цвет ваших сообщений, кнопок и всего, что «моё».')}
                <div class="wt-chat" aria-hidden="true" style="--k:2">
                    <div class="wt-msg wt-msg--in">Привет! Ну как, выбрал цвет?</div>
                    <div class="wt-msg wt-msg--out">Почти. Сейчас — <span data-wt-scheme-name>${this.esc(this.welcomeSchemeLabel(look.theme))}</span></div>
                    <div class="wt-msg wt-msg--in">Бери тот, от которого хочется писать</div>
                </div>
                <div class="wt-swatches" role="radiogroup" aria-label="Цветовая схема" style="--k:3">
                    ${this.welcomeSchemes().map(([v, label]) => `
                        <button type="button" class="wt-swatch${this.esc(on(look.theme === v))}" data-wt-theme="${this.esc(v)}" role="radio" ${aria(look.theme === v)} title="${this.esc(label)}">
                            <span class="wt-swatch-dot theme-${this.esc(v)}" aria-hidden="true"></span>
                            <span class="wt-swatch-name">${label}</span>
                        </button>`).join('')}
                </div>`;
        }
        if (id === 'segments') {
            const selected = new Set(this.normalizeUiV2Segments(this.uiV2Segments));
            const signs = { dm: 'person', servers: 'people', zalicoin: 'coin' };
            return `
                ${head('Разделы и компоненты', 'Что будет на панели разделов — Хаб есть всегда, остальное по вкусу, хотя бы одно. Ниже — что включить сверх обычного.')}
                <div class="wt-tiles" style="--k:2">
                    ${this.hubSegmentCatalog().map((item, i) => `
                        <button type="button" class="wt-tile${this.esc(on(selected.has(item.id)))}" data-wt-segment="${this.esc(item.id)}" role="checkbox" aria-checked="${this.esc(String(selected.has(item.id)))}" style="--k:${this.esc(String(i + 2))}">
                            <span class="wt-tile-sign">${this.zaliSign?.(signs[item.id]) || ''}</span>
                            <span class="wt-tile-copy"><strong>${this.esc(item.label)}</strong><small>${this.esc(item.description)}</small></span>
                            <span class="wt-mark wt-mark--check" aria-hidden="true"></span>
                        </button>`).join('')}
                </div>
                <div class="wt-dock" aria-hidden="true" style="--k:5">${this.welcomeDockHTML()}</div>
                <p class="wt-hint" data-wt-seg-hint hidden>Хотя бы один раздел должен остаться</p>
                ${this.welcomeComponentsHTML()}`;
        }
        if (id === 'style') {
            return `
                ${head('Стиль оформления', 'Оба — «Фокус»: акцент только там, где он что-то значит. Второй добавляет мягкий свет.')}
                <div class="wt-options wt-options--2" role="radiogroup" aria-label="Стиль оформления">
                    ${this.designModeCatalog().map((m, i) => `
                        <button type="button" class="wt-opt wt-opt--style${this.esc(on(look.style === m.id))}" data-wt-style="${this.esc(m.id)}" role="radio" ${aria(look.style === m.id)} style="--k:${this.esc(String(i + 2))}">
                            <span class="wt-style-prev wt-style-prev--${this.esc(m.id)}" aria-hidden="true">
                                <i class="wt-mini-in"></i><i class="wt-mini-out"></i><i class="wt-mini-in wt-mini-in--short"></i>
                            </span>
                            <span class="wt-opt-copy"><strong>${this.esc(m.label)}</strong><small>${this.esc(m.hint)}</small></span>
                            <span class="wt-mark" aria-hidden="true"></span>
                        </button>`).join('')}
                </div>`;
        }
        // done
        const appearanceLabel = { system: 'как в системе', dark: 'тёмная', light: 'светлая' }[look.appearance] || look.appearance;
        const styleLabel = (this.designModeCatalog().find(m => m.id === look.style) || {}).label || '';
        return `
            <div class="wt-hero wt-hero--done">
                ${this.welcomeLogoHTML(' wt-logo--done')}
                <h2 class="wt-title wt-title--hero" id="wtTitle" style="--k:5">Всё готово</h2>
                <p class="wt-lead" style="--k:6">Найдите собеседника через поиск или зайдите на сервер по ссылке-приглашению.</p>
                <div class="wt-summary" style="--k:7">
                    <span>Тема: ${this.esc(appearanceLabel)}</span>
                    <span>Схема: ${this.esc(this.welcomeSchemeLabel(look.theme))}</span>
                    <span>${this.esc(styleLabel)}</span>
                    ${this.remoteControlComponentEnabled?.() ? '<span>Удалённое управление</span>' : ''}
                </div>
            </div>`;
    }

    /** Компоненты — то, что в «Настройках → Компоненты» (sidebar_settings.js) и
     *  по умолчанию выключено. Сейчас один: удалённое управление (remote_control.js,
     *  хранится только на этом устройстве). Новый компонент — запись здесь. */
    welcomeComponents() {
        const host = !!this.nativeSupports?.('nativeRemoteControl');
        return [{
            id: 'remote-control',
            label: 'Удалённое управление',
            sign: 'display',
            description: host
                ? 'Отдать собеседнику управление своим экраном во время демонстрации — или управлять чужим'
                : 'Управлять чужим экраном, когда вам его отдали. Отдавать своё умеют приложения для macOS и Windows',
            enabled: () => !!this.remoteControlComponentEnabled?.(),
            set: (on) => this.setRemoteControlComponentEnabled?.(on),
        }];
    }

    welcomeComponentsHTML() {
        const items = this.welcomeComponents();
        if (!items.length) return '';
        return `
            <h3 class="wt-subtitle" style="--k:6">Компоненты</h3>
            <div class="wt-tiles" style="--k:7">
                ${items.map(item => {
                    const on = item.enabled();
                    return `
                    <button type="button" class="wt-tile${on ? ' is-active' : ''}" data-wt-component="${this.esc(item.id)}" role="checkbox" aria-checked="${this.esc(String(on))}">
                        <span class="wt-tile-sign">${this.zaliSign?.(item.sign) || ''}</span>
                        <span class="wt-tile-copy"><strong>${this.esc(item.label)}</strong><small>${this.esc(item.description)}</small></span>
                        <span class="wt-mark wt-mark--check" aria-hidden="true"></span>
                    </button>`;
                }).join('')}
            </div>`;
    }

    toggleWelcomeComponent(id, tile) {
        const item = this.welcomeComponents().find(c => c.id === id);
        if (!item) return;
        const next = !item.enabled();
        item.set(next);
        const on = item.enabled();
        tile.classList.toggle('is-active', on);
        tile.setAttribute('aria-checked', String(on));
    }

    welcomeDockHTML() {
        const byId = Object.fromEntries(this.hubSegmentCatalog().map(item => [item.id, item.label]));
        const ids = this.normalizeUiV2Segments(this.uiV2Segments);
        return [...ids.map(id => byId[id]), 'Хаб']
            .map((label, i) => `<span class="wt-dock-item${i === 0 ? ' is-active' : ''}">${this.esc(label)}</span>`).join('');
    }

    toggleWelcomeSegment(id, tile) {
        const current = this.normalizeUiV2Segments(this.uiV2Segments);
        const has = current.includes(id);
        const step = tile.closest('.wt-step');
        const hint = step?.querySelector('[data-wt-seg-hint]');
        if (has && current.length <= 1) {
            if (hint) hint.hidden = false;
            tile.classList.remove('is-denied');
            void tile.offsetWidth;
            tile.classList.add('is-denied');
            return;
        }
        if (hint) hint.hidden = true;
        // Порядок — как в каталоге, независимо от порядка щелчков.
        const order = this.hubSegmentCatalog().map(item => item.id);
        const next = has ? current.filter(x => x !== id) : order.filter(x => x === id || current.includes(x));
        this.saveUiV2Segments(next);
        tile.classList.toggle('is-active', !has);
        tile.setAttribute('aria-checked', String(!has));
        const dock = step?.querySelector('.wt-dock');
        if (dock) this.setHTMLIfChanged?.(dock, this.welcomeDockHTML());
    }
});
