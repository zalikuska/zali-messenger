// --- ZaliInterface: разделы едут за капсулой нижней панели (телефон). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Пока палец тащит капсулу веб-дока (setupMobileDockDrag в mobile.js), поверх интерфейса
// стоит лента снимков разделов «Чаты · Сервера · ZaliCoin · Хаб», и она едет за
// капсулой. На отпускании лента доезжает до выбранного раздела, настоящий экран под
// ней к этому моменту уже переключён (обычным кликом кнопки), и лента гаснет.
//
// Почему снимки, а не живые экраны: «Чаты» и «Сервера» — один и тот же .sidebar,
// перерисованный по режиму, а Хаб и ZaliCoin живут в .main под списком; держать
// четыре живых экрана рядом значило бы переписать раскладку телефона. Снимок —
// клон .app: текущий раздел снимается в начале жеста (свежий), остальные — когда
// пользователь в последний раз на них был (в простое после перехода). Раздел, на
// котором ещё не были, показывается пустой страницей с названием.
//
// Лента не линейна: позиция страниц = магнит(положение капсулы). У своего места
// лента «прилипает» (идёт вдвое медленнее пальца), в середине пути догоняет —
// разделы чуть-чуть стараются встать на место, не дёргаясь при этом скачком.
// Доводка ленты: чуть длиннее и мягче прежних 320 мс cubic-bezier(.2,.8,.2,1) —
// у той 90% пути проходилось за первую треть, и смена раздела читалась рывком.
const PAGER_SETTLE_MS = 340;
const PAGER_EASING = 'cubic-bezier(.22,.72,.24,1)';

ZaliMixin(ZaliInterface, class {

    mobilePagerState() {
        return this._mPager || (this._mPager = { snaps: {}, active: null, captureTimer: null });
    }

    /** Магнит: i + t − K·sin(2πt)/2π. Наклон у места 1−K, в середине пути 1+K. */
    mobilePagerMagnet(p) {
        const K = 0.5;
        const i = Math.floor(p);
        const t = p - i;
        return i + t - (K * Math.sin(2 * Math.PI * t)) / (2 * Math.PI);
    }

    /** Экран чата (не список) — не раздел ленты: на нём панели нет. */
    mobilePagerOnChatScreen() {
        return !!document.getElementById('viewChat')?.classList.contains('active')
            && !document.body?.classList.contains('mobile-sidebar-open');
    }

    // Снимок текущего экрана: клон .app с «замороженной» видимостью. Часть правил
    // зависит от атрибутов body (режим ЛС/серверы, открыт ли список), а снимок
    // показывают уже в другом состоянии — поэтому display и положение верхних
    // контейнеров переносятся в клон инлайном с !important, как есть сейчас.
    mobilePagerCapture() {
        const app = document.querySelector('.app');
        if (!app) return null;
        const chatScreen = this.mobilePagerOnChatScreen();
        // Своя панель (#mobileDock), подложка и сцена аддонов лежат внутри .app, но в
        // снимке не нужны: панель настоящая и стоит поверх ленты, а её копии в каждом
        // снимке торчали бы лаймовыми капсулами по краям. Вместо них — пустые
        // оболочки (структура та же — по ней идёт заморозка ниже), скрытые.
        const DROP = new Set(['mobileDock', 'mobileBackdrop', 'addonStage']);
        const dropped = [];
        const cloneInto = (src) => {
            const copy = src.cloneNode(false);
            for (const child of src.children) {
                if (DROP.has(child.id)) {
                    const shell = child.cloneNode(false);
                    dropped.push(shell);
                    copy.appendChild(shell);
                } else if (child.classList.contains('main')) {
                    // Лента сообщений (сотни узлов) на экранах-списках уехала за край —
                    // её оболочка нужна для структуры, содержимое нет. Неактивные
                    // экраны скрыты — тоже только оболочки.
                    const main = child.cloneNode(false);
                    for (const view of child.children) {
                        const heavy = view.id === 'viewChat' && !chatScreen;
                        // Скрытые экраны И скрытые оверлеи/модалки (#serverOverlay, #treasuryModal…
                        // — не .view, но в .main и тоже display:none): раньше копировались
                        // целиком, ~370 лишних узлов из 495 на каждое касание (замер на V2036:
                        // снимок 38 мс → 27 мс при инвалидированных стилях, 495 → 121 узел).
                        const hidden = (view.classList.contains('view') && !view.classList.contains('active'))
                            || getComputedStyle(view).display === 'none';
                        main.appendChild(view.cloneNode(!(heavy || hidden)));
                    }
                    copy.appendChild(main);
                } else if (child.querySelector('.main, #mobileDock')) {
                    copy.appendChild(cloneInto(child));
                } else {
                    copy.appendChild(child.cloneNode(true));
                }
            }
            return copy;
        };
        const clone = cloneInto(app);
        const scrolls = [];
        const freeze = (orig, copy, depth) => {
            if (!orig || !copy || orig.nodeType !== 1 || copy.nodeType !== 1) return;
            const cs = getComputedStyle(orig);
            if (cs.display === 'none') {
                copy.style.setProperty('display', 'none', 'important');
                return;
            }
            copy.style.setProperty('display', cs.display, 'important');
            if (depth <= 2 && cs.transform && cs.transform !== 'none') copy.style.setProperty('transform', cs.transform, 'important');
            if (orig.scrollTop > 0 || orig.scrollLeft > 0) scrolls.push([copy, orig.scrollTop, orig.scrollLeft]);
            if (depth >= 6 || orig.children.length !== copy.children.length) return;
            for (let i = 0; i < orig.children.length; i++) freeze(orig.children[i], copy.children[i], depth + 1);
        };
        freeze(app, clone, 0);
        for (const shell of dropped) shell.style.setProperty('display', 'none', 'important');
        // Живое внутри снимка не нужно и вредно: фреймы аддонов перезагрузились бы,
        // видео и аудио заиграли бы заново.
        clone.querySelectorAll('iframe, video, audio, canvas, object, embed').forEach((el) => el.remove());
        clone.setAttribute('aria-hidden', 'true');
        clone.setAttribute('inert', '');
        return { node: clone, scrolls, at: Date.now() };
    }

    // Снимок Хаба/ZaliCoin, где ещё не были: их экраны живут в DOM всегда, просто
    // скрыты — клон текущего экрана, в котором вместо списка и прочих экранов показан
    // нужный. «Чаты»/«Сервера» так не собрать: это один список, перерисованный по
    // режиму, а настоящее переключение режима обнуляет счётчики непрочитанного.
    mobilePagerSynthetic(section) {
        const viewId = ({ hub: 'viewHub', zalicoin: 'viewZaliCoin' })[section];
        const orig = viewId && document.getElementById(viewId);
        if (!orig) return null;
        if (section === 'hub') { try { this.renderHub?.(); } catch (e) {} }
        // Знаки сущностей (монета, казна…) проставляются при первом открытии экрана;
        // без них в снимке ещё не открытого ZaliCoin пустые плитки.
        try { this.hydrateZaliSigns?.(orig); } catch (e) {}
        const base = this.mobilePagerCapture();
        if (base) base.synthetic = true;
        if (!base) return null;
        const root = base.node;
        const shell = root.querySelector(`#${viewId}`);
        if (!shell) return null;
        root.querySelector('.sidebar')?.style.setProperty('display', 'none', 'important');
        root.querySelectorAll('.main > .view').forEach((v) => {
            v.classList.remove('active');
            v.style.setProperty('display', 'none', 'important');
        });
        const full = orig.cloneNode(true);
        full.classList.add('active');
        full.style.removeProperty('display');
        full.querySelectorAll('iframe, video, audio, canvas, object, embed').forEach((el) => el.remove());
        shell.replaceWith(full);
        return { node: root, scrolls: [], at: Date.now(), synthetic: true };
    }

    // Снимок режима списка, в котором с запуска ещё не были («Сервера», стоя на
    // «Чатах», или наоборот). Это тот же #contacts, перерисованный по режиму, поэтому
    // список рисуется в нужном режиме прямо на месте, снимается и тут же
    // перерисовывается обратно — в одной задаче, до кадра: на экране этого не видно.
    // Через setNavMode нельзя: он обнуляет счётчики непрочитанного (активный чат или
    // канал «становятся видны»), сохраняет режим и запускает загрузку истории. Здесь
    // только отрисовка: renderContacts/renderServers состояние не меняют, а то, что
    // меняет выбор сервера (ensureServerSelection), сохраняется и возвращается.
    mobilePagerCaptureListMode(section) {
        const want = section === 'servers' ? 'servers' : (section === 'chats' ? 'dm' : '');
        if (!want || this.S?.navMode === want || typeof this.renderContacts !== 'function') return null;
        const list = document.getElementById('contacts');
        const body = document.body;
        const saved = {
            navMode: this.S.navMode,
            activeServer: this.S.activeServer,
            activeChannel: this.S.activeChannel,
            conv: this.S.activeConversationType,
            bar: this.S.mobileServerBar,
            attr: body?.getAttribute('data-nav-mode'),
            scrollTop: list?.scrollTop || 0,
        };
        let snap = null;
        try {
            this.S.navMode = want;
            if (want === 'servers') {
                this.ensureServerSelection?.();
                this.S.mobileServerBar = 'header';
            }
            body?.setAttribute('data-nav-mode', want);
            this.renderContacts();
            snap = this.mobilePagerCapture();
        } catch (e) {
            snap = null;
        } finally {
            this.S.navMode = saved.navMode;
            this.S.activeServer = saved.activeServer;
            this.S.activeChannel = saved.activeChannel;
            this.S.activeConversationType = saved.conv;
            this.S.mobileServerBar = saved.bar;
            if (saved.attr == null) body?.removeAttribute('data-nav-mode');
            else body?.setAttribute('data-nav-mode', saved.attr);
            try { this.renderContacts(); } catch (e) {}
            if (list) list.scrollTop = saved.scrollTop;
        }
        if (!snap) return null;
        // Стоя на Хабе/ZaliCoin, список убран вниз, а виден экран .main — в снимке
        // наоборот: список на месте, экраны .main скрыты.
        const root = snap.node;
        const sidebar = root.querySelector('.sidebar');
        if (sidebar) {
            sidebar.style.setProperty('display', 'flex', 'important');
            sidebar.style.setProperty('transform', 'none', 'important');
        }
        root.querySelectorAll('.main > .view').forEach((v) => v.style.setProperty('display', 'none', 'important'));
        snap.synthetic = true;
        // Прокрутку списка другого режима не знаем — снимок сверху.
        snap.scrolls = snap.scrolls.filter(([el]) => !el.closest?.('.sidebar'));
        return snap;
    }

    /** Снимок раздела, которого нет в кеше, — любым доступным способом. */
    mobilePagerBuild(section) {
        if (section === 'chats' || section === 'servers') return this.mobilePagerCaptureListMode(section);
        return this.mobilePagerSynthetic(section);
    }

    // Догоняет кеш в простое: по одному недостающему разделу за проход простоя, чтобы
    // уже первый жест показывал все разделы, а не названия.
    warmMobilePagerCache() {
        const state = this.mobilePagerState();
        if (state.warming) return;
        const step = (deadline) => {
            state.warming = false;
            if (state.active || !this.isMobileLayout?.() || this.mobilePagerOnChatScreen()) return;
            const missing = this.mobilePagerSections().filter((s) => !state.snaps[s]);
            if (!missing.length) return;
            if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 10) {
                state.warming = true;
                window.requestIdleCallback(step, { timeout: 4000 });
                return;
            }
            const snap = this.mobilePagerBuild(missing[0]);
            if (snap) state.snaps[missing[0]] = snap;
            else state.unbuildable = (state.unbuildable || 0) + 1;
            if (missing.length > 1 && (state.unbuildable || 0) < 4) {
                state.warming = true;
                if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(step, { timeout: 4000 });
                else setTimeout(() => step(null), 200);
            }
        };
        state.warming = true;
        if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(step, { timeout: 4000 });
        else setTimeout(() => step(null), 200);
    }

    mobilePagerBlank(section) {
        const page = document.createElement('div');
        page.className = 'm-pager-blank';
        const title = document.createElement('span');
        title.textContent = ({ chats: 'Чаты', servers: 'Сервера', zalicoin: 'ZaliCoin', hub: 'Хаб' })[section] || '';
        page.appendChild(title);
        return page;
    }

    // Снимок раздела, на который только что пришли, — в простое, чтобы следующий жест
    // показал его соседом. Вызывается из syncMobileChrome() (дебаунс).
    scheduleMobilePagerCapture() {
        if (!this.isMobileLayout?.()) return;
        const state = this.mobilePagerState();
        clearTimeout(state.captureTimer);
        state.captureTimer = setTimeout(() => {
            let tries = 0;
            const run = (deadline) => {
                if (state.active || !this.isMobileLayout?.() || this.mobilePagerOnChatScreen()) return;
                // Клон всего экрана — не дробится; ждём простоя, где на него хватит места.
                if (deadline && !deadline.didTimeout && deadline.timeRemaining() < 10 && tries++ < 6) {
                    window.requestIdleCallback(run, { timeout: 3000 });
                    return;
                }
                const section = this.activeMobileNavSection?.();
                if (!section) return;
                const snap = this.mobilePagerCapture();
                if (snap) state.snaps[section] = snap;
                this.warmMobilePagerCache();
            };
            if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 3000 });
            else run(null);
        }, 600);
    }

    /** Начало жеста: sections — разделы в порядке панели. */
    mobilePagerStart(sections) {
        if (!this.isMobileLayout?.() || !Array.isArray(sections) || sections.length < 2) return;
        // Жест по панели начался с нажатия на кнопку — снимок касания больше не нужен.
        this.mobilePagerDropPrepared();
        if (this.mobilePagerOnChatScreen()) return;
        const state = this.mobilePagerState();
        this.mobilePagerTeardown(true);
        const current = this.activeMobileNavSection?.();
        const index = Math.max(0, sections.indexOf(current));
        const fresh = this.mobilePagerCapture();
        if (fresh && current) state.snaps[current] = fresh;

        const pages = sections.map((section) => {
            let snap = section === current ? fresh : state.snaps[section];
            if (!snap) {
                snap = this.mobilePagerBuild(section);
                if (snap) state.snaps[section] = snap;
            }
            return snap?.node ? snap : { blank: section };
        });
        this.mobilePagerMount(pages, index, sections);
    }

    /** Ставит ленту: pages — снимки ({node, scrolls}) или {blank: section}. */
    mobilePagerMount(pages, index, sections = null) {
        const state = this.mobilePagerState();
        this.mobilePagerTeardown(true);
        const overlay = document.createElement('div');
        overlay.className = 'm-pager';
        overlay.setAttribute('aria-hidden', 'true');
        const track = document.createElement('div');
        track.className = 'm-pager-track';
        const mounted = [];
        pages.forEach((snap, i) => {
            const page = document.createElement('div');
            page.className = 'm-pager-page';
            page.style.left = `${i * 100}%`;
            if (snap?.node) {
                page.appendChild(snap.node);
                mounted.push(snap);
            } else {
                page.appendChild(this.mobilePagerBlank(snap?.blank));
            }
            track.appendChild(page);
        });
        overlay.appendChild(track);
        track.style.transform = `translate3d(${-index * 100}%, 0, 0)`;
        document.body.appendChild(overlay);
        for (const snap of mounted) {
            for (const [el, top, left] of snap.scrolls) { el.scrollTop = top; el.scrollLeft = left; }
        }
        state.active = { overlay, track, sections: sections || pages.map(() => ''), index, p: index, applied: index, raf: 0 };
    }

    mobilePagerMove(p) {
        const active = this.mobilePagerState().active;
        if (!active || active.settling) return;
        active.p = Math.max(0, Math.min(active.sections.length - 1, Number(p) || 0));
        if (active.raf) return;
        const apply = () => {
            active.raf = 0;
            if (active.settling) return;
            const x = this.mobilePagerMagnet(active.p);
            active.applied = x;
            active.track.style.transform = `translate3d(${(-x * 100).toFixed(3)}%, 0, 0)`;
        };
        try { active.raf = requestAnimationFrame(apply); } catch (e) { apply(); }
    }

    /** Отпускание: лента доезжает до раздела index и гаснет. */
    mobilePagerEnd(index) {
        const state = this.mobilePagerState();
        const active = state.active;
        if (!active || active.settling) return;
        active.settling = true;
        if (active.raf) { try { cancelAnimationFrame(active.raf); } catch (e) {} active.raf = 0; }
        const target = Math.max(0, Math.min(active.sections.length - 1, Number(index) || 0));
        // Доводка — Web Animations, а не CSS-переход. Переходу нужно начальное
        // положение в уже посчитанном стиле, и лента, поставленная в этой же задаче
        // (касание), получала его чтением getComputedStyle(track).transform — а
        // transform в процентах вычисляется только после раскладки, то есть это была
        // синхронная раскладка всей ленты снимков: 10–22 мс на касание при CPU ×12.
        // У анимации начало задано явно, и она идёт на компоновщике.
        const fromX = active.applied ?? this.mobilePagerMagnet(active.p);
        const from = `translate3d(${(-fromX * 100).toFixed(3)}%, 0, 0)`;
        const to = `translate3d(${-target * 100}%, 0, 0)`;
        active.track.style.transform = to;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            active.overlay.classList.add('is-leaving');
            setTimeout(() => this.mobilePagerTeardown(false, active), 140);
        };
        let reduce = false;
        try { reduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch (e) {}
        let anim = null;
        if (!reduce && fromX !== target && typeof active.track.animate === 'function') {
            try {
                anim = active.track.animate([{ transform: from }, { transform: to }],
                    { duration: PAGER_SETTLE_MS, easing: PAGER_EASING });
                // Размытие — только когда лента реально едет больше чем на треть экрана.
                if (Math.abs(target - fromX) > 0.33) this.motionBlurAnimate?.(active.track, { duration: PAGER_SETTLE_MS, peak: 1 });
            } catch (e) { anim = null; }
        }
        if (anim) {
            anim.onfinish = finish;
            anim.oncancel = finish;
            setTimeout(finish, 420);
        } else {
            finish();
        }
    }

    mobilePagerTeardown(immediate, which = null) {
        const state = this.mobilePagerState();
        const active = which || state.active;
        if (!active) return;
        if (active.raf) { try { cancelAnimationFrame(active.raf); } catch (e) {} }
        // Касание: анимация настоящего экрана не должна пережить ленту.
        for (const anim of active.anims || []) { try { anim.cancel(); } catch (e) {} }
        // Снимки вынимаются из ленты целыми — они остаются в кеше для следующего жеста.
        active.overlay.remove();
        active.track.querySelectorAll('.m-pager-page').forEach((page) => { while (page.firstChild) page.removeChild(page.firstChild); });
        if (state.active === active) state.active = null;
        if (!immediate) this.scheduleMobilePagerCapture();
    }

    /** Разделы в порядке панели: видимые кнопки веб-дока (у нативной панели iOS — все четыре). */
    mobilePagerSections() {
        if (this.nativeSupports?.('mobileNav')) return ['chats', 'servers', 'zalicoin', 'hub'];
        // Видимые кнопки — из кеша геометрии дока (ResizeObserver в setupMobileDockDrag):
        // offsetWidth здесь, в начале переключения, был лишней синхронной раскладкой.
        const dock = document.getElementById('mobileDock');
        const slots = dock?.__dockGeom?.slots;
        const buttons = slots ? slots.map((slot) => slot.el)
            : [...document.querySelectorAll('#mobileDock > .mobile-dock-btn')].filter((b) => b.offsetWidth > 0);
        return buttons.map((b) => this.mobileDockSectionOf(b)).filter(Boolean);
    }

    // Переключение раздела касанием (кнопка веб-дока): раздел въезжает, а не
    // появляется скачком. Старый экран уезжает снимком (снят до переключения, когда
    // раскладка уже посчитана, — дёшево), а въезжает НАСТОЯЩИЙ новый экран: та же
    // Web Animation на его контейнере. Раньше и новый экран снимался клоном сразу
    // после переключения — это заставляло браузер синхронно посчитать стили и
    // раскладку нового экрана в обработчике касания, а потом ещё и клона (~500 узлов):
    // 40–58 мс из 60–95 мс фриза на касание при CPU ×12 (замер 2026-11-15). Теперь
    // новый экран считается один раз, в обычном кадре, вместе с единственным снимком.
    // Если идёт жест по панели (лента уже стоит) — только переключение: доводку
    // делает mobilePagerEnd.
    mobileSwitchSection(target, doSwitch) {
        const state = this.mobilePagerState();
        // Второе касание, пока едет лента первого (~340 мс; соседние вкладки жмут именно
        // так), раньше шло мгновенно: state.active занят, и mobilePagerCanSlide говорил
        // «нельзя». Ленту касания прерываем — экран под ней уже в конечном положении,
        // новая лента стартует от него.
        if (state.active?.tap) this.mobilePagerTeardown(true);
        const sections = this.isMobileLayout?.() ? this.mobilePagerSections() : [];
        const from = this.activeMobileNavSection?.();
        const animate = this.mobilePagerCanSlide(from, target, sections);
        // Снимок, подготовленный ещё на нажатии (mobilePagerPrepareTap), — только для
        // этого же перехода; иначе убрать, чтобы он не закрывал экран.
        let prepared = state.prepared;
        if (prepared && (!animate || prepared.from !== from || prepared.target !== target)) {
            this.mobilePagerDropPrepared();
            prepared = null;
        }
        if (!animate) { doSwitch(); return; }
        state.prepared = null;
        const before = prepared ? prepared.before : this.mobilePagerCapture();
        doSwitch();
        const real = this.mobilePagerRealScreen(target);
        if (this.mobilePagerOnChatScreen() || this.activeMobileNavSection?.() !== target || !before
            || !real || typeof real.animate !== 'function') {
            if (prepared) prepared.overlay.remove();
            return;
        }
        state.snaps[from] = before;
        // Снимок нового раздела устарел (его только что перерисовали) — свежий снимет
        // простой после перехода (scheduleMobilePagerCapture в teardown).
        delete state.snaps[target];
        const forward = sections.indexOf(target) > sections.indexOf(from);
        this.mobilePagerSlideTap(before, real, forward, prepared);
    }

    /** Переход касанием анимируется: оба раздела в панели, не экран чата, лента не стоит. */
    mobilePagerCanSlide(from, target, sections) {
        let reduce = false;
        try { reduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch (e) {}
        return !reduce && !this.mobilePagerState().active && !!from && from !== target
            && sections.includes(from) && sections.includes(target)
            && !this.mobilePagerOnChatScreen();
    }

    // Нажатие на кнопку панели (pointerdown): снимок старого экрана снимается и ставится
    // поверх него сразу, пока палец ещё лежит (~80–100 мс до click). Снимок совпадает с
    // экраном, поэтому его появление не видно, а клон успевает посчитать стили, раскладку
    // и растр в обычных кадрах. Без этого всё это шло одной задачей в обработчике click
    // вместе с переключением раздела — 45–50 мс + 12–18 мс растра первого кадра
    // (замер на телефоне 2026-11-16), переключение отставало от касания на ~100 мс.
    // Если click не придёт (палец увели, начался жест по панели) — снимок убирается.
    mobilePagerPrepareTap(target) {
        const state = this.mobilePagerState();
        if (state.active?.tap) this.mobilePagerTeardown(true);
        this.mobilePagerDropPrepared();
        if (!this.isMobileLayout?.()) return;
        const from = this.activeMobileNavSection?.();
        if (!this.mobilePagerCanSlide(from, target, this.mobilePagerSections())) return;
        const before = this.mobilePagerCapture();
        if (!before) return;
        const { overlay, track } = this.mobilePagerTapOverlay(before);
        state.prepared = { from, target, before, overlay, track, timer: 0 };
    }

    /** Отпускание без click: подготовленный снимок живёт ещё немного — click идёт следом. */
    mobilePagerReleasePrepared() {
        const prepared = this.mobilePagerState().prepared;
        if (!prepared) return;
        clearTimeout(prepared.timer);
        prepared.timer = setTimeout(() => {
            if (this.mobilePagerState().prepared === prepared) this.mobilePagerDropPrepared();
        }, 400);
    }

    mobilePagerDropPrepared() {
        const state = this.mobilePagerState();
        const prepared = state.prepared;
        if (!prepared) return;
        state.prepared = null;
        clearTimeout(prepared.timer);
        prepared.overlay.remove();
    }

    /** Лента касания: одна страница со снимком старого экрана, поверх интерфейса. */
    mobilePagerTapOverlay(before) {
        const overlay = document.createElement('div');
        overlay.className = 'm-pager is-tap';
        overlay.setAttribute('aria-hidden', 'true');
        const track = document.createElement('div');
        track.className = 'm-pager-track';
        const page = document.createElement('div');
        page.className = 'm-pager-page';
        page.style.left = '0%';
        page.appendChild(before.node);
        track.appendChild(page);
        overlay.appendChild(track);
        document.body.appendChild(overlay);
        // Прокрутка снимка — в кадре, а не здесь: запись scrollTop сразу после вставки
        // посчитала бы раскладку синхронно. rAF идёт до отрисовки кадра, так что снимок
        // ни разу не покажется непрокрученным.
        try {
            requestAnimationFrame(() => {
                for (const [el, top, left] of before.scrolls) { el.scrollTop = top; el.scrollLeft = left; }
            });
        } catch (e) { /* без rAF — снимок сверху */ }
        return { overlay, track };
    }

    /** Контейнер настоящего экрана раздела, который въезжает при касании. */
    mobilePagerRealScreen(section) {
        if (section === 'chats' || section === 'servers') return document.querySelector('.sidebar');
        return document.getElementById(({ hub: 'viewHub', zalicoin: 'viewZaliCoin' })[section] || '');
    }

    // Касание: одна страница со снимком старого экрана уезжает, настоящий новый экран
    // въезжает следом вплотную — вместе это та же лента. Подложка ленты прозрачная
    // (.m-pager.is-tap): справа/слева от снимка виден настоящий экран под ней.
    mobilePagerSlideTap(before, real, forward, prepared = null) {
        const state = this.mobilePagerState();
        this.mobilePagerTeardown(true);
        const { overlay, track } = prepared || this.mobilePagerTapOverlay(before);
        const dir = forward ? -1 : 1;
        const timing = { duration: PAGER_SETTLE_MS, easing: PAGER_EASING };
        const active = { overlay, track, sections: [], index: 0, p: 0, applied: 0, raf: 0, settling: true, anims: [], tap: true };
        state.active = active;
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            for (const anim of active.anims) { try { anim.cancel(); } catch (e) {} }
            this.mobilePagerTeardown(false, active);
        };
        try {
            active.anims.push(track.animate([{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${dir * 100}%, 0, 0)` }], timing));
            active.anims.push(real.animate([{ transform: `translate3d(${-dir * 100}%, 0, 0)` }, { transform: 'translate3d(0, 0, 0)' }], timing));
        } catch (e) { finish(); return; }
        // Размытия в движении (motionBlurAnimate) здесь нет и не должно быть: filter на
        // живом экране перерисовывается каждый кадр, и на телефоне вся доводка шла
        // ~30 fps (запись экрана 2026-11-16: медиана 32 мс между кадрами, без него — 17).
        active.anims[0].onfinish = finish;
        active.anims[0].oncancel = finish;
        setTimeout(finish, 420);
    }
});

