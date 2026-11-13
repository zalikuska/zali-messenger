// --- ZaliInterface: Мобильная раскладка, жесты навигации, переключение экранов. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // Drives .sidebar's parked/unparked position as a plain inline style —
    // mirroring setMobileNavProgress()'s #viewChat/.mobile-dock handling —
    // always writing an explicit value, never clearing the inline style to
    // fall back on the CSS rule's own translateY(115%). That fallback was
    // tried first and measured unreliable: after clearing the inline
    // override, getComputedStyle kept reporting the identity matrix
    // indefinitely instead of transitioning to the cascade's parked value —
    // even a full second later, nothing had moved. Writing both states
    // explicitly (like #viewChat already does) sidesteps that fallback path
    // entirely; only the transition duration is still gated by class
    // (transition: none while becoming visible, so the reveal is instant;
    // the class removed, so the .12s park plays once the caller sets the
    // parked value).
    setMobileListParked(parked) {
        const sidebar = document.querySelector('.sidebar');
        if (sidebar) sidebar.style.transform = parked ? 'translateY(115%)' : 'translateY(0)';
    }

    setMobileSidebarOpen(open, { animate = true } = {}) {
        const isOpen = !!open;
        document.body?.classList.toggle('mobile-sidebar-open', isOpen);
        // isOpen === list/picker screen visible (--mnav 0); closed === chat screen visible (--mnav 1)
        if (isOpen) {
            document.body?.classList.add('mobile-list-visible');
            this.setMobileListParked(false);
            // Уходим со страницы чата — клавиатура его поля ввода больше не нужна.
            // Без этого она оставалась над списком диалогов: фокус держало поле,
            // уехавшее за край экрана.
            const focused = document.activeElement;
            if (focused && focused.id === 'msgInput' && this.isMobileLayout()) focused.blur();
        }
        this.setMobileNavProgress(isOpen ? 0 : 1, { animate });
        if (!isOpen) {
            this.scheduleMobileListPark();
        }
        const btn = document.getElementById('mobileMenuBtn');
        if (btn) btn.setAttribute('aria-expanded', String(isOpen));
        const backdrop = document.getElementById('mobileBackdrop');
        if (backdrop) backdrop.hidden = !isOpen;
        return isOpen;
    }

    // Parks the list back down (translateY, out of the way of the input
    // area) only once the chat has actually finished covering it — never
    // while any part of the list might still be visible on screen.
    scheduleMobileListPark() {
        const chatEl = document.getElementById('viewChat');
        if (!chatEl) return;
        let done = false;
        const attemptPark = () => {
            // A back-swipe may have started (and re-shown the list) after this
            // park was scheduled but before its 340ms fallback fired — at drag
            // activation progress is still ~1, so the progress check alone
            // would yank the list out from under the user's finger.
            if (document.body?.classList.contains('mobile-nav-dragging')) return;
            // The window may have grown to the desktop layout between scheduling
            // and firing; parking there would translate the always-visible
            // desktop sidebar off the bottom of the screen.
            if (!this.isMobileLayout()) return;
            if (this.currentMobileNavProgress() >= 0.98 && !document.body?.classList.contains('mobile-sidebar-open')) {
                document.body?.classList.remove('mobile-list-visible');
                // Class removal switches .sidebar back to its normal .12s
                // transition; writing the parked value now (not clearing to
                // fall back on it) animates the park — harmless either way
                // visually since the chat is already fully covering it.
                this.setMobileListParked(true);
            }
        };
        const finish = () => {
            if (done) return;
            done = true;
            chatEl.removeEventListener('transitionend', onEnd);
            attemptPark();
        };
        const onEnd = (e) => {
            if (e.target === chatEl && e.propertyName === 'transform') finish();
        };
        chatEl.addEventListener('transitionend', onEnd);
        // Fallback in case the transform didn't actually change (transitionend
        // never fires) or something else interrupts the transition.
        setTimeout(finish, 340);
    }

    // Drives the mobile list<->chat push navigation. p=0 shows the fullscreen
    // chat/server picker, p=1 shows the chat. animate=false is used while a
    // touch drag is in progress so the transform tracks the finger with zero
    // transition lag.
    //
    // #viewChat/.mobile-dock's transform is written here directly as an
    // inline style (plain px/percent), NOT via a CSS custom property + calc()
    // — a `calc(var(--mnav))`-driven transform was observed to permanently
    // stick at its pre-change value after any transition:none phase ended,
    // regardless of how the re-enable was sequenced (classList timing,
    // forced reflow, rAF, setTimeout). A literal, non-var()-dependent inline
    // transform value does not have this problem.
    setMobileNavProgress(p, { animate = true } = {}) {
        const body = document.body;
        if (!body) return;
        const clamped = Math.max(0, Math.min(1, Number(p) || 0));
        const moved = clamped !== this._mobileNavProgress;
        this._mobileNavProgress = clamped;
        body.classList.toggle('mobile-nav-instant', !animate);
        // Доводка перехода (тап по диалогу, «назад», отпущенный свайп) двигает
        // #viewChat с обеими матовыми поверхностями внутри ровно так же, как
        // перетаскивание пальцем, но стекло снималось только на время
        // перетаскивания: все 240 мс анимации каждый кадр заново размывал полосу
        // во всю ширину. На время доводки — тот же режим, что и при жесте.
        if (animate && moved && this.isMobileLayout()) {
            body.classList.add('mobile-nav-animating');
            clearTimeout(this._mobileNavAnimTimer);
            this._mobileNavAnimTimer = setTimeout(() => {
                body.classList.remove('mobile-nav-animating');
            }, 300);
        }
        const vc = document.getElementById('viewChat');
        if (vc) vc.style.transform = `translateX(${((1 - clamped) * 100).toFixed(4)}%)`;
        this.applyMobileDockTransform(clamped);
        this.notifyNativeMobileNav(clamped, animate);
    }

    // Док уезжает вниз только на экране чата (там под ним поле ввода). Хаб,
    // ZaliCoin и Настройки — полные экраны, между которыми переходят этим же
    // доком; нативная панель Android с самого начала оставляет себя видимой на
    // них (см. notifyNativeMobileNav), а веб-док прятался вместе с чатом и
    // оставлял Хаб без пути назад.
    applyMobileDockTransform(progress) {
        const dock = document.querySelector('.mobile-dock');
        if (!dock) return;
        const chatScreen = !!document.getElementById('viewChat')?.classList.contains('active');
        const value = chatScreen ? Math.max(0, Math.min(1, Number(progress) || 0)) : 0;
        dock.style.transform = `translate(-50%, ${(value * 140).toFixed(4)}%)`;
    }

    // The Android shell hides the web .mobile-dock and draws its own native bar
    // over the WebView, so that bar can't see the transform above — it has to be
    // told, or it keeps sitting on top of the chat's message input. `animate`
    // separates a finger-tracked drag (native must follow instantly, frame by
    // frame) from a committed transition (native runs its own ~240ms slide).
    // Re-reports the current position from the DOM. Needed wherever the position
    // itself didn't change but what it *means* for the native bar did:
    // setMobileNavProgress() only fires on an actual move, so a session that
    // lands straight on a screen (guest login opening the chat placeholder, a
    // restored conversation, the login overlay closing) would never report
    // anything and the bar would stay wherever it was — parked over the message
    // input, or floating over a chat. Derived from the DOM, not from
    // _mobileNavProgress, which is undefined until the first navigation.
    syncNativeMobileNav() {
        if (!this.nativeSupports('mobileNav')) return;
        // Never yank the bar out from under a finger mid-swipe.
        if (document.body?.classList.contains('mobile-nav-dragging')) return;
        const listVisible = !!document.body?.classList.contains('mobile-sidebar-open');
        this.notifyNativeMobileNav(listVisible ? 0 : this.currentMobileNavProgress(), true);
    }

    notifyNativeMobileNav(progress, animate) {
        if (!this.nativeSupports('mobileNav')) return;
        // Only the chat screen wants the bar gone. Settings/Хаб/ZaliCoin close
        // the mobile sidebar too — which drives progress to 1 — but they are
        // full screens the user navigates *between* with that very bar, so
        // report 0 for them regardless of the nav transform.
        // The login overlay covers whichever view is active underneath (normally
        // the chat one) — leave the bar alone there, as it was before.
        const authUp = !!document.getElementById('authOverlay')?.classList.contains('visible');
        const chatScreen = !authUp
            && !!document.getElementById('viewChat')?.classList.contains('active');
        const value = chatScreen ? (Number(progress) || 0) : 0;
        const flag = !!animate;
        // Какая секция активна сейчас. Нативная панель (Android) рисуется поверх
        // вебвью и прячет веб-док, поэтому подсветку своей активной вкладки она
        // взять неоткуда не может: её собственный `selected` — это локальное
        // состояние, меняющееся только от тапа по ней самой. А в Хаб и Настройки
        // можно уйти и другим путём (сегмент-контрол внутри настроек), после чего
        // подсветка начинала врать. Считается ровно теми же условиями, что и
        // класс .active на кнопках веб-дока в syncMobileChrome().
        const section = this.activeMobileNavSection();
        // Drag frames arrive at display rate; only the visible steps are worth
        // a bridge hop.
        if (this._lastNativeNavProgress != null
            && Math.abs(value - this._lastNativeNavProgress) < 0.01
            && flag === this._lastNativeNavAnimate
            && section === this._lastNativeNavSection) return;
        this._lastNativeNavProgress = value;
        this._lastNativeNavAnimate = flag;
        this._lastNativeNavSection = section;
        this.postNativeMessage({
            type: NativeMessageTypes.MOBILE_NAV_PROGRESS,
            progress: value,
            animate: flag,
            section,
        });
    }

    /** 'chats' | 'servers' | 'zalicoin' | 'hub' — источник истины для подсветки и веб-дока,
     * и нативной панели. Настройки в доке нет: они открываются из Хаба, поэтому подсвечивают Хаб. */
    activeMobileNavSection() {
        if (document.getElementById('viewSettings')?.classList.contains('active')) return 'hub';
        if (document.getElementById('viewZaliCoin')?.classList.contains('active')) return 'zalicoin';
        if (document.getElementById('viewHub')?.classList.contains('active')) return 'hub';
        return this.S.navMode === 'servers' ? 'servers' : 'chats';
    }

    /** Ставит капсулу под активную кнопку дока. Во время перетаскивания не трогает —
     *  там её ведёт setupMobileDockDrag. */
    syncMobileDockThumb() {
        // Нативная панель (Android/iOS) рисует свою и прячет веб-док. Чтение
        // offsetWidth/offsetLeft у скрытого дока принудительно пересчитывало
        // раскладку всей страницы синхронно в обработчике клика: ~40 мс на каждое
        // переключение вкладки на телефоне (замер CPU-профилем, 2026-10-11).
        if (this.nativeSupports('mobileNav')) return;
        // На десктопной раскладке док скрыт: чтение его геометрии — та же
        // принудительная раскладка страницы на каждом переключении экрана
        // (до 7 мс в WKWebView macOS), а результат никому не виден. Переход
        // в мобильную раскладку пересинхронизирует капсулу обработчиком resize.
        if (!this.isMobileLayout()) return;
        const dock = document.getElementById('mobileDock');
        const thumb = dock?.querySelector('.mobile-dock-thumb');
        const active = dock?.querySelector('.mobile-dock-btn.active');
        if (!thumb || !active || dock.classList.contains('is-dragging')) return;
        thumb.style.width = `${active.offsetWidth}px`;
        thumb.style.setProperty('--tx', `${active.offsetLeft}px`);
        dock.__syncDockInk?.();
    }

    /**
     * Перетаскивание по доку: палец или мышь двигают капсулу плавно, она немного
     * растёт, а при отпускании встаёт под ближайший пункт и переключает раздел.
     * Короткий тап (без движения дальше порога) остаётся обычным кликом кнопки.
     */
    setupMobileDockDrag() {
        // Веб-док скрыт нативной панелью — перетаскивать нечего, а слушатели resize
        // и чтение геометрии были бы чистой нагрузкой.
        if (this.nativeSupports('mobileNav')) return;
        const dock = document.getElementById('mobileDock');
        if (!dock || dock.__dockDragBound) return;
        dock.__dockDragBound = true;
        const thumb = dock.querySelector('.mobile-dock-thumb');
        const buttons = [...dock.querySelectorAll('.mobile-dock-btn')];
        if (!thumb || buttons.length < 2) return;
        const DRAG_SLOP = 6;
        const GROW = 1.08;
        let drag = null;

        // Тёмная копия подписей внутри капсулы: капсула лежит над кнопками и обрезает
        // копию, поэтому под ней текст и иконка тёмные, а вне капсулы остаются светлыми —
        // как фильтр. Копия обязана совпадать с рядом кнопок до пикселя, иначе подпись
        // удваивается: ряд встаёт в те же x/y/ширину (offsetLeft/offsetTop первой кнопки
        // уже включают padding и рамку дока), сдвиг — переменная --tx капсулы.
        const ink = document.createElement('div');
        ink.className = 'mobile-dock-ink';
        ink.setAttribute('aria-hidden', 'true');
        ink.innerHTML = buttons.map((b) => `<span class="mobile-dock-btn mobile-dock-ink-item">${b.innerHTML}</span>`).join('');
        thumb.appendChild(ink);
        const inkItems = [...ink.children];
        const syncInk = () => {
            const shown = buttons.filter((b) => b.offsetWidth > 0);
            if (!shown.length) return;
            const first = shown[0];
            const last = shown[shown.length - 1];
            buttons.forEach((b, i) => { inkItems[i].style.display = b.offsetWidth > 0 ? '' : 'none'; });
            ink.style.setProperty('--ink-x', `${first.offsetLeft}px`);
            ink.style.setProperty('--ink-y', `${first.offsetTop - thumb.offsetTop}px`);
            ink.style.setProperty('--ink-w', `${last.offsetLeft + last.offsetWidth - first.offsetLeft}px`);
            ink.style.setProperty('--ink-h', `${first.offsetHeight}px`);
            ink.style.gap = getComputedStyle(dock).columnGap;
        };
        dock.__syncDockInk = syncInk;
        syncInk();

        const clampX = (x) => Math.min(Math.max(x, buttons[0].offsetLeft), buttons[buttons.length - 1].offsetLeft);
        const nearestButton = (x) => {
            const center = x + thumb.offsetWidth / 2;
            let best = buttons[0];
            let bestDist = Infinity;
            for (const b of buttons) {
                const dist = Math.abs(b.offsetLeft + b.offsetWidth / 2 - center);
                if (dist < bestDist) { best = b; bestDist = dist; }
            }
            return best;
        };

        dock.addEventListener('pointerdown', (e) => {
            if (e.pointerType === 'mouse' && e.button !== 0) return;
            if (!e.target.closest('.mobile-dock-btn')) return;
            const active = dock.querySelector('.mobile-dock-btn.active') || buttons[0];
            drag = { id: e.pointerId, startX: e.clientX, startTx: active.offsetLeft, moved: false };
        });

        dock.addEventListener('pointermove', (e) => {
            if (!drag || e.pointerId !== drag.id) return;
            const dx = e.clientX - drag.startX;
            if (!drag.moved) {
                if (Math.abs(dx) < DRAG_SLOP) return;
                drag.moved = true;
                try { dock.setPointerCapture(e.pointerId); } catch (err) { /* не критично */ }
                dock.classList.add('is-dragging');
                thumb.style.setProperty('--ts', String(GROW));
            }
            const x = clampX(drag.startTx + dx);
            thumb.style.setProperty('--tx', `${x}px`);
            const target = nearestButton(x);
            buttons.forEach((b) => b.classList.toggle('is-target', b === target));
        });

        const finishDrag = (e, cancelled) => {
            if (!drag || e.pointerId !== drag.id) return;
            const moved = drag.moved;
            drag = null;
            if (!moved) return;
            dock.classList.remove('is-dragging');
            thumb.style.setProperty('--ts', '1');
            buttons.forEach((b) => b.classList.remove('is-target'));
            const x = parseFloat(thumb.style.getPropertyValue('--tx')) || 0;
            const current = dock.querySelector('.mobile-dock-btn.active');
            const target = cancelled ? current : nearestButton(x);
            if (target && target !== current) {
                // Кнопка сама вызовет переход и обновит подсветку через syncMobileDock().
                target.click();
            } else {
                this.syncMobileDockThumb();
            }
            // Браузер может отправить свой click после отпускания — он уже не нужен.
            dock.__suppressDockClick = true;
            setTimeout(() => { dock.__suppressDockClick = false; }, 350);
        };
        dock.addEventListener('pointerup', (e) => finishDrag(e, false));
        dock.addEventListener('pointercancel', (e) => finishDrag(e, true));

        dock.addEventListener('click', (e) => {
            if (!dock.__suppressDockClick) return;
            dock.__suppressDockClick = false;
            e.stopPropagation();
            e.preventDefault();
        }, true);

        window.addEventListener('resize', () => { syncInk(); this.syncMobileDockThumb(); });
        this.syncMobileDockThumb();
    }

    currentMobileNavProgress() {
        return typeof this._mobileNavProgress === 'number' ? this._mobileNavProgress : 1;
    }

    // Горизонтальные жесты на экране чата. Вертикаль принадлежит прокрутке ленты,
    // горизонталь — нам, и у неё два значения:
    //
    //  • вправо, откуда угодно — назад к списку: чат едет за пальцем и открывает
    //    список под собой (зеркало перехода в setMobileSidebarOpen). Раньше жест
    //    начинался только в полосе 28px у левого края — а именно её Android в
    //    жестовой навигации забирает под системное «назад», так что в оболочке
    //    он почти не срабатывал;
    //  • влево по сообщению — ответить на него: строка уезжает, справа
    //    проявляется значок, отпускание за порогом открывает плашку ответа.
    //
    // Слушатели пассивные. Прежний `touchmove` с `passive: false` на #viewChat
    // делал блокирующей каждую прокрутку ленты: браузер обязан дождаться
    // обработчика, прежде чем сдвинуть контент, и любой занятый кадр главного
    // потока (приём сообщения, перерисовка) превращался в рывок под пальцем.
    // Теперь вертикаль отдана компоновщику целиком (`touch-action: pan-y` на
    // ленте в style.css): жест, начатый горизонтально, браузер прокруткой не
    // считает вовсе, поэтому отменять его через preventDefault не нужно.
    setupMobileNavGestures() {
        const chatEl = document.getElementById('viewChat');
        if (!chatEl || chatEl.__mobileSwipeNavBound) return;
        chatEl.__mobileSwipeNavBound = true;

        const LOCK_SLOP = 10;       // сколько пальцу пройти до выбора направления
        const REPLY_TRIGGER = 54;   // после этого отпускание = «ответить»
        const REPLY_MAX = 78;       // дальше строка не едет
        // Всё, что само владеет горизонтальным движением или выделением текста.
        const OWN_GESTURE = 'input, textarea, select, [contenteditable="true"], pre, video[controls], '
            + '.voice-panel, .draft-attachments, .server-rail, [data-no-swipe]';
        let mode = null;            // null | 'pending' | 'back' | 'reply'
        let startX = 0;
        let startY = 0;
        let viewportWidth = 1;
        let velocity = 0;
        let lastT = 0;
        let lastDx = 0;
        let row = null;
        let armed = false;
        let hint = null;

        const replyHint = () => {
            if (hint) return hint;
            hint = document.createElement('div');
            hint.className = 'swipe-reply-hint';
            hint.setAttribute('aria-hidden', 'true');
            hint.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" '
                + 'stroke-linecap="round" stroke-linejoin="round"><path d="M10 8 5 13l5 5"/>'
                + '<path d="M5 13h9a5 5 0 0 1 5 5v1"/></svg>';
            chatEl.appendChild(hint);
            return hint;
        };

        const releaseRow = () => {
            if (row) {
                row.classList.remove('swipe-reply-drag');
                row.classList.add('swipe-reply-settle');
                row.style.transform = '';
                const settled = row;
                setTimeout(() => settled.classList.remove('swipe-reply-settle'), 220);
            }
            if (hint) {
                hint.classList.remove('visible', 'armed');
                hint.style.transform = '';
            }
            row = null;
            armed = false;
        };

        const reset = () => {
            mode = null;
            velocity = 0;
            lastT = 0;
            lastDx = 0;
        };

        chatEl.addEventListener('touchstart', (e) => {
            if (mode) { releaseRow(); reset(); }
            if (!this.isMobileLayout() || e.touches.length !== 1) return;
            if (this.currentMobileNavProgress() < 0.98) return;
            const touch = e.touches[0];
            const target = e.target;
            if (!touch || target?.closest?.(OWN_GESTURE)) return;
            mode = 'pending';
            startX = touch.clientX;
            startY = touch.clientY;
            viewportWidth = window.innerWidth || 1;
            const candidate = target?.closest?.('#msgs .msg[data-message-id]');
            row = candidate && !candidate.classList.contains('notice') ? candidate : null;
        }, { passive: true });

        chatEl.addEventListener('touchmove', (e) => {
            if (!mode) return;
            if (e.touches.length !== 1) { releaseRow(); reset(); return; }
            const touch = e.touches[0];
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;

            if (mode === 'pending') {
                // Вертикальное намерение — это прокрутка, жест не наш.
                if (Math.abs(dy) >= LOCK_SLOP && Math.abs(dy) >= Math.abs(dx)) { row = null; reset(); return; }
                if (Math.abs(dx) < LOCK_SLOP || Math.abs(dx) < Math.abs(dy) * 1.3) return;
                if (dx > 0) {
                    mode = 'back';
                    row = null;
                    document.body?.classList.add('mobile-nav-dragging');
                    // Список должен стоять на месте (Y=0) к началу движения: чат
                    // съезжает с него вправо, а не список поднимается снизу.
                    document.body?.classList.add('mobile-list-visible');
                    this.setMobileListParked(false);
                } else if (row) {
                    mode = 'reply';
                    row.classList.remove('swipe-reply-settle');
                    row.classList.add('swipe-reply-drag');
                    const rect = row.getBoundingClientRect();
                    const host = chatEl.getBoundingClientRect();
                    const el = replyHint();
                    el.style.top = `${Math.round(rect.top - host.top + rect.height / 2)}px`;
                    el.classList.add('visible');
                } else {
                    reset();
                    return;
                }
                // Отсчёт пути — от точки выбора направления, без скачка на LOCK_SLOP.
                startX = touch.clientX;
                return;
            }

            if (mode === 'back') {
                const now = (e.timeStamp || Date.now());
                if (lastT && now > lastT) velocity = (dx - lastDx) / (now - lastT); // px/ms
                lastT = now;
                lastDx = dx;
                const progress = Math.max(0, Math.min(1, 1 - dx / viewportWidth));
                this.setMobileNavProgress(progress, { animate: false });
                return;
            }

            // reply: строка идёт за пальцем с нарастающим сопротивлением.
            const pull = Math.max(0, -dx);
            const offset = pull <= REPLY_TRIGGER
                ? pull
                : Math.min(REPLY_MAX, REPLY_TRIGGER + (pull - REPLY_TRIGGER) * 0.35);
            row.style.transform = `translate3d(${-offset.toFixed(1)}px, 0, 0)`;
            const nowArmed = pull >= REPLY_TRIGGER;
            if (hint) {
                const k = Math.min(1, pull / REPLY_TRIGGER);
                hint.style.transform = `translate3d(0, -50%, 0) scale(${(0.5 + k * 0.5).toFixed(3)})`;
                hint.style.opacity = k.toFixed(3);
                hint.classList.toggle('armed', nowArmed);
            }
            if (nowArmed && !armed && navigator.vibrate) {
                try { navigator.vibrate(8); } catch (err) { /* нет вибро */ }
            }
            armed = nowArmed;
        }, { passive: true });

        const finish = (cancelled) => {
            if (!mode) return;
            if (mode === 'back') {
                document.body?.classList.remove('mobile-nav-dragging');
                // Быстрый смах подтверждает переход и на коротком пути — как
                // системный «назад»; иначе решает положение (40% пути).
                const flicked = !cancelled && velocity > 0.45;
                const openList = !cancelled && (flicked || this.currentMobileNavProgress() < 0.6);
                this.setMobileSidebarOpen(openList, { animate: true });
            } else if (mode === 'reply') {
                const messageId = row?.getAttribute('data-message-id');
                const go = !cancelled && armed && messageId;
                if (hint) hint.style.opacity = '';
                releaseRow();
                if (go) this.startReplyToMessage(messageId);
            }
            row = null;
            reset();
        };

        chatEl.addEventListener('touchend', () => finish(false), { passive: true });
        chatEl.addEventListener('touchcancel', () => finish(true), { passive: true });
    }

    // Телефон без выбранного разговора открывается на списке диалогов. Раньше
    // вход (и запуск с пустой сессией) оставлял на экране чата заглушку
    // «Выберите собеседника» со стрелкой «назад» и выключенным полем ввода —
    // экран, на котором нечего делать, а список был в одном лишнем шаге.
    landMobileOnListIfEmpty() {
        if (!this.isMobileLayout()) return;
        const body = document.body;
        if (!body || body.classList.contains('mobile-sidebar-open')
            || body.classList.contains('mobile-nav-dragging')) return;
        if (!document.getElementById('viewChat')?.classList.contains('active')) return;
        const selected = this.S?.navMode === 'servers'
            ? !!this.currentServerChatKey()
            : !!String(this.S?.current || '').trim();
        if (selected) return;
        this.setMobileSidebarOpen(true, { animate: false });
        this.syncMobileChrome();
    }

    // True when sliding the chat screen back in would actually show something:
    // the chat view is the active one AND it has a conversation loaded. Without
    // this the forward-swipe would drag in an empty "Выберите чат" placeholder.
    hasOpenMobileConversation() {
        if (!document.getElementById('viewChat')?.classList.contains('active')) return false;
        if (this.S?.navMode === 'servers') return !!this.currentServerChatKey();
        return !!String(this.S?.current || '').trim();
    }

    // Interactive forward-swipe: dragging left anywhere on the list screen pulls
    // the last open chat back in from the right — the mirror of the back-swipe
    // above, and the reason dialog rows no longer own a horizontal gesture of
    // their own (swipe-to-delete was removed; the row's × button deletes).
    //
    // Bound on .sidebar rather than #viewChat because while the list is showing
    // it is the sidebar that's under the finger — #viewChat is parked off-screen
    // to the right at that point.
    setupMobileForwardNavGesture() {
        const sidebarEl = document.querySelector('.sidebar');
        if (!sidebarEl || sidebarEl.__mobileForwardSwipeBound) return;
        sidebarEl.__mobileForwardSwipeBound = true;

        const DRAG_ACTIVATE = 8;
        let tracking = false;
        let dragging = false;
        let startX = 0;
        let startY = 0;
        let viewportWidth = 1;
        let velocity = 0;
        let lastT = 0;
        let lastDx = 0;

        const reset = () => {
            tracking = false;
            dragging = false;
            velocity = 0;
            lastT = 0;
            lastDx = 0;
        };

        sidebarEl.addEventListener('touchstart', (e) => {
            if (!this.isMobileLayout()) return;
            // Only from the settled list screen, and only when there is a chat
            // to come back to.
            if (this.currentMobileNavProgress() > 0.02) return;
            if (!this.hasOpenMobileConversation()) return;
            const touch = e.touches[0];
            if (!touch) return;
            // Anything that owns horizontal dragging itself (text fields, the
            // horizontally scrolling server rail) keeps its gesture.
            if (e.target?.closest?.('input, textarea, [contenteditable="true"], .server-rail, .mode-switch')) return;
            tracking = true;
            dragging = false;
            startX = touch.clientX;
            startY = touch.clientY;
            viewportWidth = window.innerWidth || 1;
        }, { passive: true });

        sidebarEl.addEventListener('touchmove', (e) => {
            if (!tracking) return;
            const touch = e.touches[0];
            if (!touch) return;
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            if (!dragging) {
                // Vertical intent wins — never fight the dialog list's scroll.
                if (Math.abs(dy) > Math.abs(dx) + 4) { reset(); return; }
                if (dx > -DRAG_ACTIVATE || Math.abs(dx) < Math.abs(dy) * 1.3) return;
                dragging = true;
                document.body?.classList.add('mobile-nav-dragging');
                // The list must stay put at Y=0 for the whole drag — the chat
                // slides in over it, the list never moves.
                document.body?.classList.add('mobile-list-visible');
                this.setMobileListParked(false);
            }
            if (dragging) {
                const now = (e.timeStamp || Date.now());
                if (lastT && now > lastT) velocity = (dx - lastDx) / (now - lastT); // px/ms
                lastT = now;
                lastDx = dx;
                const progress = Math.max(0, Math.min(1, -dx / viewportWidth));
                this.setMobileNavProgress(progress, { animate: false });
            }
        // Пассивный, как и жест чата: вертикаль списка диалогов — у компоновщика
        // (`touch-action: pan-y` на .contacts), и прокрутка списка больше не ждёт
        // этот обработчик на каждом движении пальца.
        }, { passive: true });

        const finish = () => {
            if (!tracking) return;
            document.body?.classList.remove('mobile-nav-dragging');
            if (dragging) {
                // Mirror of the back-swipe: a fast flick commits regardless of
                // distance, otherwise the 40%-travelled position decides.
                const flicked = velocity < -0.45;
                const openChat = flicked || this.currentMobileNavProgress() > 0.4;
                this.setMobileSidebarOpen(!openChat, { animate: true });
                // A drag that ended over a dialog row must not also count as a
                // tap on it (which would open that chat instead of the last one).
                this._suppressNextSidebarClick = true;
                setTimeout(() => { this._suppressNextSidebarClick = false; }, 400);
            }
            reset();
        };

        sidebarEl.addEventListener('touchend', finish, { passive: true });
        sidebarEl.addEventListener('touchcancel', finish, { passive: true });
        sidebarEl.addEventListener('click', (e) => {
            if (!this._suppressNextSidebarClick) return;
            this._suppressNextSidebarClick = false;
            e.preventDefault();
            e.stopPropagation();
        }, true);
    }

    // Экранная клавиатура: одна модель на все оболочки.
    //
    // Клавиатура приходит двумя разными способами, и раньше учитывался только
    // один, причём в двух правилах CSS (отступы ленты):
    //  • Android-оболочка и Chrome с `interactive-widget=resizes-content` сжимают
    //    сам вьюпорт раскладки — `innerHeight` уменьшается, приложение (100vh)
    //    садится над клавиатурой само, `--kbd-inset` остаётся 0;
    //  • iOS (Safari, WKWebView, PWA) вьюпорт раскладки не трогает: клавиатура
    //    ложится ПОВЕРХ страницы, уменьшается только `visualViewport`. Всё, что
    //    прижато к низу (поле ввода, нижние листы, список), оказывалось под ней,
    //    а Safari «спасал» поле, сдвигая страницу вверх вместе с шапкой.
    //
    // Поэтому наружу отдаются три вещи, и остальное делает CSS:
    //  • `--app-h` на <html> — высота видимой области. Пишется ТОЛЬКО когда
    //    клавиатура перекрывает раскладку (второй случай): `.app` сжимается до
    //    видимой части, и каждый экран, а не только чат, заканчивается над
    //    клавиатурой. В первом случае свойство не пишется вовсе: смена
    //    наследуемого свойства на <html> — пересчёт стилей всего документа, а
    //    Android во время анимации клавиатуры меняет высоту на каждом кадре;
    //  • `--kbd-inset` — сколько раскладки закрыто клавиатурой (для
    //    `position: fixed`, которые от `.app` не зависят);
    //  • `body.kbd-open` — клавиатура на экране. По нему прячется док, снимается
    //    нижний безопасный отступ (под клавиатурой он — пустая полоса) и
    //    ужимаются поля.
    setupMobileKeyboardAvoidance() {
        if (this._mobileKeyboardBound) return;
        this._mobileKeyboardBound = true;
        const vv = window.visualViewport || null;
        const root = document.documentElement;
        // Клавиатура ниже этого не бывает; панель адреса браузера и полоса
        // подсказок — бывают, и они не должны переключать раскладку.
        const KEYBOARD_MIN = 120;
        let baselineWidth = 0;
        let baselineHeight = 0;
        let raf = 0;
        let lastInset = '';
        let lastAppH = '';

        const isTextEntry = (el) => {
            if (!el || el === document.body) return false;
            if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
            if (el.tagName !== 'INPUT') return false;
            return !/^(button|checkbox|radio|range|file|color|submit|reset|image|hidden)$/i.test(el.type || 'text');
        };

        const apply = () => {
            raf = 0;
            const body = document.body;
            if (!body) return;
            // Щипок масштабирует visualViewport — это не клавиатура.
            if (vv && Math.abs((vv.scale || 1) - 1) > 0.01) return;

            const layoutH = window.innerHeight || root.clientHeight || 0;
            const visibleH = vv ? vv.height : layoutH;
            const mobile = this.isMobileLayout();
            const inset = mobile && vv
                ? Math.max(0, Math.round(layoutH - vv.height - vv.offsetTop))
                : 0;

            // Полная высота для этой ширины — наибольшая из виденных. Поворот
            // экрана меняет ширину и начинает отсчёт заново.
            const width = window.innerWidth || 0;
            if (width !== baselineWidth) {
                baselineWidth = width;
                baselineHeight = 0;
            }
            if (visibleH > baselineHeight) baselineHeight = visibleH;
            const covered = baselineHeight - visibleH;
            const open = mobile && covered > KEYBOARD_MIN && isTextEntry(document.activeElement);

            const insetValue = `${inset}px`;
            if (insetValue !== lastInset) {
                lastInset = insetValue;
                body.style.setProperty('--kbd-inset', insetValue);
            }
            const appH = inset > 0 ? `${Math.round(visibleH)}px` : '';
            if (appH !== lastAppH) {
                lastAppH = appH;
                if (appH) root.style.setProperty('--app-h', appH);
                else root.style.removeProperty('--app-h');
            }
            // iOS успевает сдвинуть страницу к полю до того, как приложение
            // сжалось: возвращаем её на место, иначе шапка остаётся за краем.
            if (inset > 0 && vv && vv.offsetTop > 0) {
                try { window.scrollTo(0, 0); } catch (e) { /* не критично */ }
            }

            if (open !== !!this._kbdOpen) {
                this._kbdOpen = open;
                body.classList.toggle('kbd-open', open);
                if (open) this.revealFocusedField();
            }
        };
        const schedule = () => {
            if (raf) return;
            raf = requestAnimationFrame(apply);
        };

        if (vv) {
            vv.addEventListener('resize', schedule);
            vv.addEventListener('scroll', schedule);
        }
        window.addEventListener('resize', schedule, { passive: true });
        // Фокус — половина условия: клавиатуру могли убрать жестом «назад», не
        // снимая фокус, а переход между полями на мгновение оставляет документ
        // без активного элемента — поэтому пересчёт в следующем кадре, а не сразу.
        document.addEventListener('focusin', schedule);
        document.addEventListener('focusout', schedule);
        apply();
    }

    // Системное «назад» (кнопка или жест Android). Оболочка спрашивает веб, есть
    // ли что закрыть, и сворачивает приложение, только если ответ — нет. До этого
    // «назад» из открытого чата, меню сообщения или окна перевода сразу
    // выбрасывало из приложения: у оболочки не было ни одного обработчика.
    //
    // Порядок — от самого верхнего слоя вниз: окно или меню → вложенный экран →
    // чат → список. Возвращает true, если шаг был сделан.
    handleMobileBack() {
        const shown = (el) => !!el && !el.hidden && el.getClientRects().length > 0;

        // 1. Окна и меню. Сначала их собственные закрывающие методы, затем — для
        //    всего, что открыто как dialog/menu и здесь не перечислено, — Escape,
        //    который каждое такое окно уже обрабатывает.
        const closers = [
            // Видео звонка на весь экран (voice_ui.js openVoiceFocus) — поверх всего.
            ['#voiceFocus', () => this.closeVoiceFocus?.()],
            ['#reactionMenu, .reaction-menu', () => this.hideReactionMenu?.()],
            ['.contact-context-menu, #contactContextMenu', () => this.closeContactContextMenu?.()],
            ['.server-rail-menu, #serverRailContextMenu', () => this.closeServerRailContextMenu?.()],
            ['#coinTransferModal', () => this.closeCoinTransferModal?.()],
            ['#treasuryModal', () => this.closeTreasuryModal?.()],
            ['#updateAvailableModal', () => this.closeUpdateModal?.()],
            ['#profileOverlay', () => this.closeProfile?.()],
            ['#serverOverlay', () => this.closeServerOverlay?.()],
        ];
        for (const [selector, close] of closers) {
            const el = document.querySelector(selector);
            if (!shown(el)) continue;
            try { close(); } catch (e) { /* закрываем как получится */ }
            if (!shown(el)) return true;
        }
        const layers = [...document.querySelectorAll('[role="dialog"], [role="menu"], [aria-modal="true"]')]
            .filter((el) => shown(el) && !el.closest('#authOverlay'));
        if (layers.length) {
            const top = layers[layers.length - 1];
            const escape = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
            (top.contains(document.activeElement) ? document.activeElement : top).dispatchEvent(escape());
            if (shown(top)) document.dispatchEvent(escape());
            if (!shown(top)) return true;
        }

        if (!this.isMobileLayout()) return false;
        // Экран входа — выходить некуда, пусть оболочка сворачивает приложение.
        if (document.getElementById('authOverlay')?.classList.contains('visible')) return false;

        // 2. Плашка ответа или правки занимает поле ввода — «назад» её снимает.
        if ((this.S?.replyDraft || this.S?.editDraft) && this.currentMobileNavProgress() >= 0.5
            && document.getElementById('viewChat')?.classList.contains('active')) {
            this.cancelComposerContext?.();
            return true;
        }

        // 3. Вложенные экраны: настройки открываются из Хаба, вкладки Хаба — из обзора.
        if (document.getElementById('viewSettings')?.classList.contains('active')) {
            this.openHubView();
            return true;
        }
        const hub = document.getElementById('viewHub');
        if (hub?.classList.contains('active')) {
            const tab = hub.getAttribute('data-hub-current') || 'overview';
            if (tab !== 'overview' && typeof this.setHubTab === 'function') {
                // «Для разработчиков» вложена в «Аддоны» — назад на шаг, а не сразу в хаб.
                this.setHubTab(tab === 'signing' ? 'addons' : 'overview');
            } else {
                this.openChatView({ showList: true });
            }
            return true;
        }
        if (document.getElementById('viewZaliCoin')?.classList.contains('active')) {
            this.openChatView({ showList: true });
            return true;
        }

        // 3½. Открытая лента выбора серверов на экране каналов — свернуть в шапку.
        if (document.body?.classList.contains('mobile-sidebar-open')
            && this.S.navMode === 'servers'
            && this.closeMobileServerPicker?.()) {
            return true;
        }

        // 4. Открытый чат → список диалогов.
        if (!document.body?.classList.contains('mobile-sidebar-open')
            && this.currentMobileNavProgress() >= 0.5) {
            this.openChatView({ showList: true });
            return true;
        }
        return false;
    }

    isKeyboardOpen() {
        return !!this._kbdOpen;
    }

    // Поле, в которое печатают, должно быть на экране. Android-оболочка
    // подкручивает его сама, когда сжимает вебвью; iOS — нет: раскладку мы
    // сжали собственным `--app-h`, и поле внутри длинной прокрутки (настройки,
    // сервер, перевод) оставалось ниже видимой части. Поле ввода сообщения
    // закреплено над клавиатурой раскладкой, ему это не нужно.
    revealFocusedField() {
        const el = document.activeElement;
        if (!el || el.id === 'msgInput' || typeof el.getBoundingClientRect !== 'function') return;
        requestAnimationFrame(() => {
            if (document.activeElement !== el) return;
            // Не `scrollIntoView`: он прокручивает и предков с `overflow: hidden`
            // (сам `.app`, body), а вернуть их обратно пользователю нечем — экран
            // остаётся сдвинутым. Двигаем только ближайшую настоящую прокрутку.
            let scroller = el.parentElement;
            while (scroller && scroller !== document.body) {
                const overflowY = getComputedStyle(scroller).overflowY;
                if ((overflowY === 'auto' || overflowY === 'scroll')
                    && scroller.scrollHeight > scroller.clientHeight + 1) break;
                scroller = scroller.parentElement;
            }
            if (!scroller || scroller === document.body) return;
            const rect = el.getBoundingClientRect();
            const box = scroller.getBoundingClientRect();
            const visibleBottom = Math.min(box.bottom,
                window.visualViewport ? window.visualViewport.height : window.innerHeight);
            const margin = 16;
            if (rect.bottom > visibleBottom - margin) {
                scroller.scrollTop += rect.bottom - (visibleBottom - margin);
            } else if (rect.top < box.top + margin) {
                scroller.scrollTop -= (box.top + margin) - rect.top;
            }
        });
    }

    // Mobile touch gestures, delegated on the persistent containers (#msgs /
    // #contacts, which holds channels too in servers mode) so they survive the innerHTML re-renders
    // those lists do.
    //
    //  • Long-press a message  → opens the existing reaction menu.
    //  • Long-press a contact  → opens the contact context menu (профиль,
    //    подписка, заявка в друзья, глушилка, громкость собеседника).
    //  • Long-press a channel  → глушилка канала.
    //
    // Всё это на десктопе висит на `contextmenu`, которого на тач-устройствах
    // просто нет: браузеры его либо не шлют, либо шлют непредсказуемо, а iOS
    // вместо него показывает собственное системное меню. Долгое нажатие для
    // сообщений было сделано ещё тогда, а для контактов и каналов — нет, и
    // комментарий выше про «#contacts» описывал намерение, а не код. То есть
    // всё меню контакта было с телефона недостижимо в принципе.
    //
    // Dialog rows deliberately have NO horizontal gesture of their own: a
    // left-swipe on the list screen belongs to the forward navigation gesture
    // (setupMobileForwardNavGesture → return to the last open chat). Deleting a
    // dialog is the row's own × button (.contact-remove), which the mobile
    // stylesheet used to hide in favour of swipe-to-reveal-Delete.
    setupMobileTouchGestures() {
        const msgsEl = document.getElementById('msgs');
        if (msgsEl) {
            this.bindMobileLongPress(msgsEl, '.msg[data-message-id]', (msgEl, x, y) => {
                const id = msgEl.getAttribute('data-message-id');
                if (id) this.showReactionMenu(msgEl, id, x, y);
            });
        }

        // One binding for both kinds of sidebar row: bindMobileLongPress binds a
        // container only once, and #contacts holds dialogs in ЛС and channels in
        // servers mode.
        const contactsEl = document.getElementById('contacts');
        if (contactsEl) {
            this.bindMobileLongPress(contactsEl, '.contact, .sidebar-channel[data-channel-id]', (row, x, y) => {
                if (row.classList.contains('sidebar-channel')) {
                    if (row.getAttribute('data-channel-kind') === 'voice') return;
                    const sid = row.getAttribute('data-server-id');
                    const cid = row.getAttribute('data-channel-id');
                    if (sid && cid) this.toggleMuteChannel(sid, cid);
                    return;
                }
                if (!row.dataset.name) return;
                this.openContactContextMenu(row.dataset.name, x, y);
            });
        }

        // Казна, настройки и участники сервера живут только в меню по аватарке
        // сервера (openServerRailContextMenu), а с 0.2b36 оно висело на одном
        // contextmenu. На тач-экране его нет — WKWebView и мобильный Safari по
        // долгому нажатию его не шлют, — и все три пункта были с телефона
        // недостижимы: шестерёнку из шапки убрали, другого входа не осталось.
        for (const rail of this.serverRailElements()) {
            this.bindMobileLongPress(rail, '.server-rail-item[data-server-id]', (item, x, y) => {
                this.hideServerRailTip();
                const serverId = item.getAttribute('data-server-id');
                if (serverId) this.openServerRailContextMenu(serverId, x, y);
            });
        }
    }

    /**
     * Долгое нажатие с делегированием на постоянном контейнере.
     *
     * @param {HTMLElement} container контейнер, переживающий перерисовки списка
     * @param {string} selector       что считать «строкой» внутри него
     * @param {(el: HTMLElement, x: number, y: number) => void} onLongPress
     */
    bindMobileLongPress(container, selector, onLongPress) {
        if (!container || container.__mobileLongPressBound) return;
        container.__mobileLongPressBound = true;

        const LONG_PRESS_MS = 420;
        const MOVE_CANCEL = 10;
        let timer = null;
        let startX = 0;
        let startY = 0;
        let held = null;
        let fired = false;

        const cancelPress = () => {
            if (timer) { clearTimeout(timer); timer = null; }
            if (held) { held.classList.remove('press-hold'); held = null; }
        };

        container.addEventListener('touchstart', (e) => {
            if (!this.isMobileLayout()) return;
            const touch = e.touches[0];
            const target = e.target?.closest?.(selector);
            if (!touch || !target) return;
            fired = false;
            startX = touch.clientX;
            startY = touch.clientY;
            held = target;
            target.classList.add('press-hold');
            timer = setTimeout(() => {
                fired = true;
                onLongPress(target, startX, startY);
                if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* no haptics */ } }
                cancelPress();
            }, LONG_PRESS_MS);
        }, { passive: true });

        container.addEventListener('touchmove', (e) => {
            const touch = e.touches[0];
            if (!touch || !timer) return;
            if (Math.abs(touch.clientX - startX) > MOVE_CANCEL || Math.abs(touch.clientY - startY) > MOVE_CANCEL) cancelPress();
        }, { passive: true });

        container.addEventListener('touchend', cancelPress);
        container.addEventListener('touchcancel', cancelPress);

        // Долгое нажатие по строке диалога иначе доигрывалось обычным кликом: меню
        // открывалось и тут же уезжало вместе с переключением чата. Перехват в фазе
        // погружения, до делегированного обработчика в events.js.
        container.addEventListener('click', (e) => {
            if (!fired) return;
            fired = false;
            e.preventDefault();
            e.stopPropagation();
        }, true);
    }

    syncMobileChrome() {
        const isMobile = this.isMobileLayout();
        document.body?.classList.toggle('is-mobile-layout', isMobile);

        // The mobile push-nav drives .sidebar / #viewChat with inline transforms
        // (see setMobileListParked / setMobileNavProgress). Those are meaningless
        // on desktop and actively harmful — a parked translateY(115%) pushes the
        // always-visible desktop sidebar off-screen — so clear them on the way out.
        if (!isMobile) {
            const sidebar = document.querySelector('.sidebar');
            if (sidebar) sidebar.style.transform = '';
            const viewChat = document.getElementById('viewChat');
            if (viewChat) viewChat.style.transform = '';
            document.body?.classList.remove('mobile-list-visible', 'mobile-nav-instant', 'mobile-nav-dragging');
        }

        const dock = document.getElementById('mobileDock');
        if (dock) {
            dock.classList.toggle('visible', isMobile);
        }

        if (isMobile) {
            this.syncNativeMobileNav();
            // Экран мог смениться без движения самой навигации (чат -> Хаб).
            if (!document.body?.classList.contains('mobile-nav-dragging')) {
                this.applyMobileDockTransform(this.currentMobileNavProgress());
            }
        }

        // Одна функция на обе панели — веб-док и нативную: разъехаться им теперь
        // негде, потому что подсветка считается в одном месте.
        const section = this.activeMobileNavSection();
        const chatsBtn = document.getElementById('mobileChatsBtn');
        const serversBtn = document.getElementById('mobileServersBtn');
        const zaliCoinBtn = document.getElementById('mobileZaliCoinBtn');
        const hubBtn = document.getElementById('mobileHubBtn');

        if (chatsBtn) chatsBtn.classList.toggle('active', section === 'chats');
        if (serversBtn) serversBtn.classList.toggle('active', section === 'servers');
        if (zaliCoinBtn) zaliCoinBtn.classList.toggle('active', section === 'zalicoin');
        if (hubBtn) hubBtn.classList.toggle('active', section === 'hub');
        this.syncMobileDockThumb();

        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        if (mobileMenuBtn) {
            mobileMenuBtn.classList.toggle('active', !!document.body?.classList.contains('mobile-sidebar-open'));
        }

        const backdrop = document.getElementById('mobileBackdrop');
        if (backdrop) backdrop.hidden = !(isMobile && document.body?.classList.contains('mobile-sidebar-open'));
    }

    closeMobileSidebar() {
        this.setMobileSidebarOpen(false);
    }

    openMobileSidebar() {
        this.setMobileSidebarOpen(true);
    }

    toggleMobileSidebar(force = null) {
        const next = force == null ? !document.body?.classList.contains('mobile-sidebar-open') : !!force;
        return this.setMobileSidebarOpen(next);
    }

    // The sidebar (contact list, mode-switch, server/channel list) stays visible
    // and clickable across every top-level view — Hub, ZaliCoin, Settings — not
    // just the chat screen. Before this, picking a conversation from there while
    // one of those was open silently updated S.current/activeServer/activeChannel
    // and re-rendered #msgs behind the scenes, but #viewChat itself stayed
    // display:none: the click looked like it did nothing at all. Called by
    // switchChat/setActiveServer/setActiveChannel; guarded so re-selecting the
    // already-open conversation from the chat view itself doesn't replay
    // #viewChat's .24s enter animation on every call.
    ensureChatViewOpen() {
        if (document.getElementById('viewChat')?.classList.contains('active')) return;
        this.openChatView();
    }

    // showList=true lands on the mobile list/picker screen instead of the
    // chat screen — pass it when the caller is about to show the list right
    // after, so we settle on the final state in one step instead of closing
    // then reopening the sidebar (which used to flash the chat screen before
    // sliding back, because renderHubSegmentNav()'s layout reads in between
    // forced the browser to commit the intermediate transform).
    openChatView({ showList = false } = {}) {
        this.collapseAddonForNavigation?.();
        this.closeCoinOverlaysForNavigation?.();
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        const zv = document.getElementById('viewZaliCoin');
        if (sv) sv.classList.remove('active');
        if (hv) hv.classList.remove('active');
        if (zv) zv.classList.remove('active');
        if (cv) cv.classList.add('active');
        // Звонящий звонок — в шапке открытого чата или строкой сверху: зависит от экрана.
        this.syncRingingCallPlacement?.();
        this.setMobileSidebarOpen(showList);
        this.renderServerToolbar();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
        // Whether the call strip shows depends on which tab is on screen.
        this.renderVoiceCallStrip();
        this.syncSidebarPanel?.();
    }

    openSettingsView() {
        this.collapseAddonForNavigation?.();
        this.closeCoinOverlaysForNavigation?.();
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        const zv = document.getElementById('viewZaliCoin');
        this.collapseActiveCallView();
        if (cv) cv.classList.remove('active');
        if (hv) hv.classList.remove('active');
        if (zv) zv.classList.remove('active');
        if (sv) sv.classList.add('active');
        // Звонящий звонок — в шапке открытого чата или строкой сверху: зависит от экрана.
        this.syncRingingCallPlacement?.();
        const tbChat = document.getElementById('tbChat');
        if (tbChat) tbChat.textContent = 'Настройки';
        this.applyNetworkConfigToInputs();
        this.renderUiV2Settings();
        this.renderAudioDeviceSettings();
        this.renderNotificationVolumeSettings();
        this.renderUpdateSettings();
        void this.renderAutostartSettings();
        void this.renderControlSettings();
        this.renderGameActivitySettings();
        this.renderGameFocusSettings();
        this.renderRecentAccounts();
        this.renderVaultCloudSyncControls();
        // Индекс сводок кеша поднимается лениво, первым обращением. Открытие
        // настроек — как раз такое обращение: без него карточка на свежем
        // запуске показала бы пустой кеш при полном диске. Рисуем сразу (чтобы
        // не мигало) и ещё раз, когда база ответит.
        this.renderCacheSettings();
        void this.ensureCacheReady().then(() => this.renderCacheSettings());
        this.closeMobileSidebar();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
        // Whether the call strip shows depends on which tab is on screen.
        this.renderVoiceCallStrip();
        this.syncSidebarPanel?.();
    }

    openHubView() {
        this.collapseAddonForNavigation?.();
        this.closeCoinOverlaysForNavigation?.();
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        const zv = document.getElementById('viewZaliCoin');
        this.collapseActiveCallView();
        if (cv) cv.classList.remove('active');
        if (sv) sv.classList.remove('active');
        if (zv) zv.classList.remove('active');
        if (hv) hv.classList.add('active');
        // Звонящий звонок — в шапке открытого чата или строкой сверху: зависит от экрана.
        this.syncRingingCallPlacement?.();
        const tbChat = document.getElementById('tbChat');
        if (tbChat) tbChat.textContent = 'Хаб';
        this.closeMobileSidebar();
        this.renderHub();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
        // Whether the call strip shows depends on which tab is on screen.
        this.renderVoiceCallStrip();
        this.syncSidebarPanel?.();
    }

    openZaliCoinView() {
        this.collapseAddonForNavigation?.();
        this.closeCoinOverlaysForNavigation?.();
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        const zv = document.getElementById('viewZaliCoin');
        this.collapseActiveCallView();
        if (cv) cv.classList.remove('active');
        if (hv) hv.classList.remove('active');
        if (sv) sv.classList.remove('active');
        if (zv) zv.classList.add('active');
        // Звонящий звонок — в шапке открытого чата или строкой сверху: зависит от экрана.
        this.syncRingingCallPlacement?.();
        const tbChat = document.getElementById('tbChat');
        if (tbChat) tbChat.textContent = 'ZaliCoin';
        this.closeMobileSidebar();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
        // Whether the call strip shows depends on which tab is on screen.
        this.renderVoiceCallStrip();
        this.refreshZaliCoinView();
        this.syncSidebarPanel?.();
    }
});
