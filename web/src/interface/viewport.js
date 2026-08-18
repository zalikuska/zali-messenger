// --- ZaliInterface: Окно прокрутки списка сообщений, класс производительности, якоря скролла. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    requestMessagesScroll(position = 'bottom') {
        this.pendingMessagesScroll = position === 'top' ? 'top' : 'bottom';
    }

    resetMessageWindow() {
        this.messageWindow = {
            conversationKey: '',
            start: 0,
            end: 0,
            count: 0,
            useWindow: false,
            avgHeight: this.messageWindow?.avgHeight || 92,
        };
    }

    scheduleMessagesRender() {
        this.scheduleRenderMessages();
    }

    // Any scrollTop we assign ourselves fires a scroll event a frame later. Without
    // this marker that event was indistinguishable from the user scrolling, so it
    // cancelled the queued "open at the bottom" of a chat we had just switched to —
    // leaving the new conversation parked at an arbitrary offset.
    markProgrammaticScroll() {
        this._programmaticScrollUntil = (typeof performance !== 'undefined' ? performance.now() : Date.now()) + 200;
    }

    isProgrammaticScroll() {
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        return now <= Number(this._programmaticScrollUntil || 0);
    }

    onMessagesScroll() {
        const box = document.getElementById('msgs');
        if (!box) return;
        if (!this.isProgrammaticScroll()) {
            this.pendingMessagesScroll = null;
            this._bottomIntent = false;
        }
        if (this.messageScrollRaf) return;
        this.messageScrollRaf = requestAnimationFrame(() => {
            this.messageScrollRaf = 0;
            const msgs = this.getCurrentMessages();
            const conversationKey = this.S.navMode === 'servers'
                ? this.currentServerChatKey()
                : String(this.S.current || '').trim();
            const nextWindow = this.computeMessageWindow(msgs, box, {
                conversationChanged: conversationKey !== (this.messageWindow?.conversationKey || ''),
                stickToBottom: this.isMessagesNearBottom(box),
            });
            const current = this.messageWindow || {};
            if (
                current.conversationKey === conversationKey &&
                current.start === nextWindow.start &&
                current.end === nextWindow.end &&
                current.count === msgs.length &&
                (!!current.useWindow) === (!!nextWindow.useWindow)
            ) {
                return;
            }
            this.scheduleRenderMessages();
        });
    }

    computeMessageWindow(msgs, box, { conversationChanged = false, stickToBottom = false } = {}) {
        const total = Array.isArray(msgs) ? msgs.length : 0;
        const baseAvg = Math.max(56, Math.min(160, Number(this.messageWindow?.avgHeight || 92)));
        // Windowing threshold by tier. Every mounted bubble costs layout, paint and
        // a share of the blurred panel it sits inside, so a budget phone starts
        // virtualising sooner than a desktop does. Purely a cost knob: the spacers
        // below reproduce the exact scroll geometry of the unmounted rows, so the
        // list looks and scrolls identically no matter where the threshold sits.
        const tier = this.perfTier();
        const windowThreshold = tier === 'weak' ? 100 : tier === 'mid' ? 140 : 180;
        if (total <= windowThreshold || !box) {
            return {
                useWindow: false,
                start: 0,
                end: total,
                topSpacer: 0,
                bottomSpacer: 0,
                avgHeight: baseAvg,
            };
        }

        const viewportCount = Math.max(18, Math.ceil(Math.max(1, box.clientHeight) / baseAvg) + 8);
        // Overscan is deliberately NOT cut hard on weak devices. It is what keeps a
        // fast fling from outrunning the render and exposing bare spacer — trimming
        // it to save paint would trade a frame-rate win for visible blank gaps on
        // exactly the devices least able to refill them. 0.55/24 is a modest trim,
        // still well over a screenful either side of the viewport.
        const overscanFactor = tier === 'weak' ? 0.55 : 0.7;
        const overscanFloor = tier === 'weak' ? 24 : 30;
        const overscan = Math.max(overscanFloor, Math.floor(viewportCount * overscanFactor));
        const windowSize = Math.min(total, viewportCount + overscan * 2);
        const nearTop = box.scrollTop <= baseAvg * 4;
        const nearBottom = this.isMessagesNearBottom(box, baseAvg * 2);

        let start = Math.max(0, Math.floor(box.scrollTop / baseAvg) - overscan);
        let end = Math.min(total, start + windowSize);

        if (conversationChanged || stickToBottom || nearBottom) {
            start = Math.max(0, total - windowSize);
            end = total;
        } else if (nearTop) {
            start = 0;
            end = Math.min(total, windowSize);
        }

        if (end - start < windowSize) {
            if (start === 0) {
                end = Math.min(total, windowSize);
            } else if (end === total) {
                start = Math.max(0, total - windowSize);
            }
        }

        return {
            useWindow: true,
            start,
            end,
            topSpacer: start * baseAvg,
            bottomSpacer: Math.max(0, (total - end) * baseAvg),
            avgHeight: baseAvg,
        };
    }

    // Frame-rate tiering.
    //
    // What the display can do and what the device can afford per frame are two
    // different facts, and both matter: a 120 Hz panel on a budget phone still
    // misses frames if we ask it to lay out a thousand off-screen nodes, while a
    // fast desktop pinned to a 60 Hz panel gains nothing from extra headroom.
    //
    // Hard rule for everything keyed off this: the tier may only scale work the
    // user cannot see — how many *off-screen* message rows stay mounted. It must
    // never change a colour, a size, a blur, a shadow or a duration, so the
    // rendered result is byte-identical across tiers and only the cost differs.
    perfTier() {
        if (this._perfTier) return this._perfTier;
        const nav = typeof navigator !== 'undefined' ? navigator : {};
        const cores = Number(nav.hardwareConcurrency || 0);
        const memory = Number(nav.deviceMemory || 0);
        // A coarse primary pointer is the most reliable "this is a phone/tablet"
        // signal available to us; UA sniffing is not.
        const coarsePointer = typeof window.matchMedia === 'function'
            && window.matchMedia('(pointer: coarse)').matches;
        let tier;
        if (!coarsePointer && (cores === 0 || cores >= 8)) {
            tier = 'high';
        } else if ((memory && memory <= 3) || (cores && cores <= 4)) {
            tier = 'weak';
        } else {
            tier = coarsePointer ? 'mid' : 'high';
        }
        this._perfTier = tier;
        try {
            document.documentElement.dataset.perfTier = tier;
        } catch (e) {}
        this.trace(`perf tier=${tier} cores=${cores || '?'} memory=${memory || '?'} coarse=${coarsePointer}`);
        return tier;
    }

    // Measured refresh ceiling, from real rAF cadence rather than assumption —
    // a 120 Hz phone whose panel is currently running at 60 (battery saver, an
    // OEM policy that ignored our request) must be treated as 60. Diagnostics
    // only today: nothing renders differently because of it, it exists so the
    // frame ceiling is observable in the log instead of guessed at.
    probeDisplayRefreshRate() {
        if (this._displayHzProbeStarted) return;
        this._displayHzProbeStarted = true;
        if (typeof requestAnimationFrame !== 'function') return;
        const samples = [];
        let last = 0;
        const tick = (now) => {
            if (last) samples.push(now - last);
            last = now;
            if (samples.length < 20) {
                requestAnimationFrame(tick);
                return;
            }
            const sorted = samples.slice().sort((a, b) => a - b);
            const median = sorted[Math.floor(sorted.length / 2)] || 16.7;
            this._displayHz = Math.round(1000 / median);
            this.trace(`perf displayHz≈${this._displayHz} tier=${this.perfTier()}`);
        };
        requestAnimationFrame(tick);
    }

    mobileLayoutQuery() {
        if (!this._mobileLayoutQuery && typeof window.matchMedia === 'function') {
            this._mobileLayoutQuery = window.matchMedia('(max-width: 760px)');
        }
        return this._mobileLayoutQuery || null;
    }

    isMobileLayout() {
        if (typeof window.matchMedia === 'function') {
            return window.matchMedia('(max-width: 760px)').matches;
        }
        return !!this.mobileLayoutQuery()?.matches;
    }

    applyPendingMessagesScroll(box) {
        if (!box || !this.pendingMessagesScroll) return;
        const target = this.pendingMessagesScroll;
        this.pendingMessagesScroll = null;
        this.markProgrammaticScroll();
        if (target === 'bottom') {
            box.scrollTop = box.scrollHeight;
            this.pinToBottomAfterLayout(box);
        } else {
            // Jumping to the top is an explicit "don't follow the bottom" intent —
            // otherwise the next viewport change would re-pin and undo it.
            this._bottomIntent = false;
            box.scrollTop = 0;
        }
    }

    // Height is not final at the moment we scroll: the virtual window's spacers are
    // sized from an average message height that this very render recalibrates, and
    // avatars/images/fonts settle a frame later. Scrolling once therefore left the
    // newly opened chat a screen or two above the last message. Re-pin on the next
    // frame — once, and only while nothing else has claimed the scroll position.
    pinToBottomAfterLayout(box) {
        if (!box) return;
        // A real user scroll clears this intent (see onMessagesScroll), so the
        // correction can never fight someone who has started reading history.
        this._bottomIntent = true;
        if (this._pinBottomRaf) return;
        this._pinBottomRaf = requestAnimationFrame(() => {
            this._pinBottomRaf = 0;
            if (!this._bottomIntent || this.pendingMessagesScroll) return;
            if (box.scrollHeight - (box.scrollTop + box.clientHeight) <= 1) return;
            this.markProgrammaticScroll();
            box.scrollTop = box.scrollHeight;
        });
    }

    captureMessageScrollAnchor(box) {
        if (!box) return null;
        const boxRect = box.getBoundingClientRect?.();
        if (!boxRect) return null;
        const nodes = box.querySelectorAll('.msg[data-message-id]');
        if (!nodes.length) return null;
        // Binary search on offsetTop for the first node at or below the viewport top,
        // instead of walking the list front-to-back measuring every node. Nodes are in
        // document order, so offsetTop is monotonic.
        const viewportTop = box.scrollTop;
        let lo = 0;
        let hi = nodes.length - 1;
        let candidate = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const node = nodes[mid];
            if (node.offsetTop + node.offsetHeight >= viewportTop) {
                candidate = mid;
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }
        for (let i = candidate; i < nodes.length; i += 1) {
            const node = nodes[i];
            const messageId = String(node.dataset?.messageId || '').trim();
            if (!messageId) continue;
            const rect = node.getBoundingClientRect?.();
            if (!rect || rect.bottom < boxRect.top) continue;
            if (rect.top > boxRect.bottom) break;
            return {
                messageId,
                topOffset: rect.top - boxRect.top,
            };
        }
        return null;
    }

    restoreMessageScrollAnchor(box, anchor) {
        if (!box || !anchor?.messageId) return false;
        // Selector lookup instead of materialising every .msg node and comparing
        // datasets in JS — this runs inside the render path on every scroll-preserving
        // update.
        let node = null;
        try {
            const escaped = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function')
                ? CSS.escape(anchor.messageId)
                : null;
            if (escaped) node = box.querySelector(`.msg[data-message-id="${escaped}"]`);
        } catch (e) {
            node = null;
        }
        if (!node) {
            const nodes = Array.from(box.querySelectorAll('.msg[data-message-id]'));
            node = nodes.find(item => String(item.dataset?.messageId || '').trim() === anchor.messageId) || null;
        }
        if (!node) return false;
        const boxRect = box.getBoundingClientRect?.();
        const rect = node.getBoundingClientRect?.();
        if (!boxRect || !rect) return false;
        box.scrollTop += (rect.top - boxRect.top) - Number(anchor.topOffset || 0);
        return true;
    }

    // Called when the viewport itself changes size (rotation, window resize, the
    // mobile keyboard). A resize does not move scrollTop, so a list that was pinned
    // to its newest message silently ends up scrolled away from it.
    repinMessagesAfterViewportChange() {
        if (!this._bottomIntent) return;
        const box = document.getElementById('msgs');
        if (!box) return;
        this.pinToBottomAfterLayout(box);
    }

    isMessagesNearBottom(box, threshold = 56) {
        if (!box) return true;
        return (box.scrollHeight - (box.scrollTop + box.clientHeight)) <= threshold;
    }
});
