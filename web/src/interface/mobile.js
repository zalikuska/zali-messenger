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
        this._mobileNavProgress = clamped;
        body.classList.toggle('mobile-nav-instant', !animate);
        const vc = document.getElementById('viewChat');
        if (vc) vc.style.transform = `translateX(${((1 - clamped) * 100).toFixed(4)}%)`;
        const dock = document.querySelector('.mobile-dock');
        if (dock) dock.style.transform = `translate(-50%, ${(clamped * 140).toFixed(4)}%)`;
        this.notifyNativeMobileNav(clamped, animate);
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
        // Drag frames arrive at display rate; only the visible steps are worth
        // a bridge hop.
        if (this._lastNativeNavProgress != null
            && Math.abs(value - this._lastNativeNavProgress) < 0.01
            && flag === this._lastNativeNavAnimate) return;
        this._lastNativeNavProgress = value;
        this._lastNativeNavAnimate = flag;
        this.postNativeMessage({
            type: NativeMessageTypes.MOBILE_NAV_PROGRESS,
            progress: value,
            animate: flag,
        });
    }

    currentMobileNavProgress() {
        return typeof this._mobileNavProgress === 'number' ? this._mobileNavProgress : 1;
    }

    // Interactive back-swipe: dragging from the left edge of the open chat
    // drags it to the right, revealing the fullscreen picker underneath
    // (mirror of the forward transition driven by setMobileSidebarOpen).
    setupMobileNavGestures() {
        const chatEl = document.getElementById('viewChat');
        if (!chatEl || chatEl.__mobileSwipeNavBound) return;
        chatEl.__mobileSwipeNavBound = true;

        const EDGE_ZONE = 28;
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

        chatEl.addEventListener('touchstart', (e) => {
            if (!this.isMobileLayout() || this.currentMobileNavProgress() < 0.98) return;
            const touch = e.touches[0];
            if (!touch || touch.clientX > EDGE_ZONE) return;
            tracking = true;
            dragging = false;
            startX = touch.clientX;
            startY = touch.clientY;
            viewportWidth = window.innerWidth || 1;
        }, { passive: true });

        chatEl.addEventListener('touchmove', (e) => {
            if (!tracking) return;
            const touch = e.touches[0];
            if (!touch) return;
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;
            if (!dragging) {
                if (Math.abs(dy) > Math.abs(dx) + 4) { reset(); return; }
                if (dx < DRAG_ACTIVATE) return;
                dragging = true;
                document.body?.classList.add('mobile-nav-dragging');
                // Unpark the list — see setMobileListParked() — so it's
                // sitting at Y=0 as the chat starts moving: the reveal must
                // look like the chat sliding off the list on the left, not
                // the list rising from below.
                document.body?.classList.add('mobile-list-visible');
                this.setMobileListParked(false);
            }
            if (dragging) {
                if (e.cancelable) e.preventDefault();
                const now = (e.timeStamp || Date.now());
                if (lastT && now > lastT) velocity = (dx - lastDx) / (now - lastT); // px/ms
                lastT = now;
                lastDx = dx;
                const progress = Math.max(0, Math.min(1, 1 - dx / viewportWidth));
                this.setMobileNavProgress(progress, { animate: false });
            }
        }, { passive: false });

        const finish = () => {
            if (!tracking) return;
            document.body?.classList.remove('mobile-nav-dragging');
            if (dragging) {
                // Commit on a fast flick even when the drag is short — matching
                // native back-swipes — otherwise fall back to the 40% position.
                const flicked = velocity > 0.45;
                const openList = flicked || this.currentMobileNavProgress() < 0.6;
                this.setMobileSidebarOpen(openList, { animate: true });
            }
            reset();
        };

        chatEl.addEventListener('touchend', finish);
        chatEl.addEventListener('touchcancel', finish);
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
                if (dx > -DRAG_ACTIVATE) return;
                dragging = true;
                document.body?.classList.add('mobile-nav-dragging');
                // The list must stay put at Y=0 for the whole drag — the chat
                // slides in over it, the list never moves.
                document.body?.classList.add('mobile-list-visible');
                this.setMobileListParked(false);
            }
            if (dragging) {
                if (e.cancelable) e.preventDefault();
                const now = (e.timeStamp || Date.now());
                if (lastT && now > lastT) velocity = (dx - lastDx) / (now - lastT); // px/ms
                lastT = now;
                lastDx = dx;
                const progress = Math.max(0, Math.min(1, -dx / viewportWidth));
                this.setMobileNavProgress(progress, { animate: false });
            }
        }, { passive: false });

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

        sidebarEl.addEventListener('touchend', finish);
        sidebarEl.addEventListener('touchcancel', finish);
        sidebarEl.addEventListener('click', (e) => {
            if (!this._suppressNextSidebarClick) return;
            this._suppressNextSidebarClick = false;
            e.preventDefault();
            e.stopPropagation();
        }, true);
    }

    // Raises the message input above the on-screen keyboard on mobile by
    // exposing the keyboard inset as a CSS var; style.css shifts
    // #viewChat .input-area/.msgs by it.
    setupMobileKeyboardAvoidance() {
        const vv = window.visualViewport;
        if (!vv || this._mobileKeyboardBound) return;
        this._mobileKeyboardBound = true;
        const apply = () => {
            if (!this.isMobileLayout()) {
                document.body?.style.setProperty('--kbd-inset', '0px');
                return;
            }
            const inset = Math.max(0, (window.innerHeight - vv.height - vv.offsetTop));
            document.body?.style.setProperty('--kbd-inset', `${Math.round(inset)}px`);
            // The keyboard opening/closing resizes the message list under a fixed
            // scrollTop, which pushed the newest message off-screen exactly when the
            // user was about to reply to it. Re-pin, but only if we were the ones
            // holding the view at the bottom.
            this.repinMessagesAfterViewportChange();
        };
        vv.addEventListener('resize', apply);
        vv.addEventListener('scroll', apply);
        apply();
    }

    // Mobile touch gestures, delegated on the persistent containers (#msgs /
    // #contacts) so they survive the innerHTML re-renders those lists do.
    //
    //  • Long-press a message  → opens the existing reaction menu. The desktop
    //    path is `contextmenu`, which touch browsers fire inconsistently (and
    //    iOS shows its own callout instead).
    //
    // Dialog rows deliberately have NO horizontal gesture of their own: a
    // left-swipe on the list screen belongs to the forward navigation gesture
    // (setupMobileForwardNavGesture → return to the last open chat). Deleting a
    // dialog is the row's own × button (.contact-remove), which the mobile
    // stylesheet used to hide in favour of swipe-to-reveal-Delete.
    setupMobileTouchGestures() {
        const LONG_PRESS_MS = 420;
        const MOVE_CANCEL = 10;

        const msgsEl = document.getElementById('msgs');
        if (msgsEl && !msgsEl.__mobileLongPressBound) {
            msgsEl.__mobileLongPressBound = true;
            let timer = null;
            let startX = 0;
            let startY = 0;
            let held = null;
            const cancelPress = () => {
                if (timer) { clearTimeout(timer); timer = null; }
                if (held) { held.classList.remove('press-hold'); held = null; }
            };
            msgsEl.addEventListener('touchstart', (e) => {
                if (!this.isMobileLayout()) return;
                const touch = e.touches[0];
                const msgEl = e.target?.closest?.('.msg[data-message-id]');
                if (!touch || !msgEl) return;
                startX = touch.clientX;
                startY = touch.clientY;
                held = msgEl;
                msgEl.classList.add('press-hold');
                timer = setTimeout(() => {
                    const id = msgEl.getAttribute('data-message-id');
                    if (id) {
                        this.showReactionMenu(msgEl, id, startX, startY);
                        if (navigator.vibrate) { try { navigator.vibrate(12); } catch (err) { /* no haptics */ } }
                    }
                    cancelPress();
                }, LONG_PRESS_MS);
            }, { passive: true });
            msgsEl.addEventListener('touchmove', (e) => {
                const touch = e.touches[0];
                if (!touch || !timer) return;
                if (Math.abs(touch.clientX - startX) > MOVE_CANCEL || Math.abs(touch.clientY - startY) > MOVE_CANCEL) cancelPress();
            }, { passive: true });
            msgsEl.addEventListener('touchend', cancelPress);
            msgsEl.addEventListener('touchcancel', cancelPress);
        }

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

        if (isMobile) this.syncNativeMobileNav();

        const settingsActive = !!document.getElementById('viewSettings')?.classList.contains('active');
        const hubActive = !!document.getElementById('viewHub')?.classList.contains('active');
        const chatsBtn = document.getElementById('mobileChatsBtn');
        const serversBtn = document.getElementById('mobileServersBtn');
        const hubBtn = document.getElementById('mobileHubBtn');
        const settingsBtn = document.getElementById('mobileSettingsBtn');

        if (chatsBtn) chatsBtn.classList.toggle('active', !settingsActive && !hubActive && this.S.navMode !== 'servers');
        if (serversBtn) serversBtn.classList.toggle('active', !settingsActive && !hubActive && this.S.navMode === 'servers');
        if (hubBtn) hubBtn.classList.toggle('active', hubActive);
        if (settingsBtn) settingsBtn.classList.toggle('active', settingsActive);

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

    // showList=true lands on the mobile list/picker screen instead of the
    // chat screen — pass it when the caller is about to show the list right
    // after, so we settle on the final state in one step instead of closing
    // then reopening the sidebar (which used to flash the chat screen before
    // sliding back, because renderHubSegmentNav()'s layout reads in between
    // forced the browser to commit the intermediate transform).
    openChatView({ showList = false } = {}) {
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        const zv = document.getElementById('viewZaliCoin');
        if (sv) sv.classList.remove('active');
        if (hv) hv.classList.remove('active');
        if (zv) zv.classList.remove('active');
        if (cv) cv.classList.add('active');
        this.setMobileSidebarOpen(showList);
        this.renderServerToolbar();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
    }

    openSettingsView() {
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        const zv = document.getElementById('viewZaliCoin');
        this.collapseActiveCallView();
        if (cv) cv.classList.remove('active');
        if (hv) hv.classList.remove('active');
        if (zv) zv.classList.remove('active');
        if (sv) sv.classList.add('active');
        const tbChat = document.getElementById('tbChat');
        if (tbChat) tbChat.textContent = 'Настройки';
        this.applyNetworkConfigToInputs();
        this.renderUiV2Settings();
        this.renderAudioDeviceSettings();
        this.renderRecentAccounts();
        this.renderVaultCloudSyncControls();
        this.closeMobileSidebar();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
    }

    openHubView() {
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        const zv = document.getElementById('viewZaliCoin');
        this.collapseActiveCallView();
        if (cv) cv.classList.remove('active');
        if (sv) sv.classList.remove('active');
        if (zv) zv.classList.remove('active');
        if (hv) hv.classList.add('active');
        const tbChat = document.getElementById('tbChat');
        if (tbChat) tbChat.textContent = 'Хаб';
        this.closeMobileSidebar();
        this.renderHub();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
    }

    openZaliCoinView() {
        const cv = document.getElementById('viewChat');
        const hv = document.getElementById('viewHub');
        const sv = document.getElementById('viewSettings');
        const zv = document.getElementById('viewZaliCoin');
        this.collapseActiveCallView();
        if (cv) cv.classList.remove('active');
        if (hv) hv.classList.remove('active');
        if (sv) sv.classList.remove('active');
        if (zv) zv.classList.add('active');
        const tbChat = document.getElementById('tbChat');
        if (tbChat) tbChat.textContent = 'ZaliCoin';
        this.closeMobileSidebar();
        this.renderHubSegmentNav();
        this.syncMobileChrome();
        this.refreshZaliCoinView();
    }
});
