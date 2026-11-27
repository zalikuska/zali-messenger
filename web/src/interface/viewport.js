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
        const nowMs = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!this.isProgrammaticScroll()) {
            // Скролл-событие не всегда от человека: когда строка растёт уже после закрепления
            // (стикер дорисовывается, высоты пересчитываются), браузер двигает scrollTop сам, а
            // событие приходит позже 200-мс метки «программного». Раньше любое такое событие снимало
            // намерение «держаться низа», и лента оставалась выше последнего сообщения. Человеком
            // скролл считается, только когда был его ввод (колесо, касание, клавиши, нажатая мышь)
            // или идёт инерция после касания; иначе намерение остаётся, а лента возвращается к низу.
            const touchInertia = nowMs - Number(this._msgTouchEndAt || 0) < 2500;
            const userInput = this._msgPointerActive || touchInertia || nowMs - Number(this._msgUserInputAt || 0) < 1200;
            if (userInput) {
                this.pendingMessagesScroll = null;
                this._bottomIntent = false;
                this._msgUserScrollAt = nowMs;
            } else if (this._bottomIntent && !this.pendingMessagesScroll
                && box.scrollHeight - box.scrollTop - box.clientHeight > 1) {
                this.pinToBottomAfterLayout(box);
            }
        }
        if (this.messageScrollRaf) return;
        this.messageScrollRaf = requestAnimationFrame(() => {
            this.messageScrollRaf = 0;
            this.syncJumpToBottom(box);
            const msgs = this.getCurrentMessages();
            const conversationKey = this.S.navMode === 'servers'
                ? this.currentServerChatKey()
                : String(this.S.current || '').trim();
            const nextWindow = this.computeMessageWindow(msgs, box, {
                conversationChanged: conversationKey !== (this.messageWindow?.conversationKey || ''),
                stickToBottom: this.isMessagesNearBottom(box) || !!this._bottomIntent,
                conversationKey,
                anchorIndex: this.restoreHoldIndex(msgs),
            });
            const current = this.messageWindow || {};
            const sameList = current.conversationKey === conversationKey
                && current.count === msgs.length
                && (!!current.useWindow) === (!!nextWindow.useWindow);
            if (sameList && current.start === nextWindow.start && current.end === nextWindow.end) {
                return;
            }
            // Гистерезис окна: пока видимая часть ленты лежит внутри уже
            // отрисованного окна с запасом не меньше трети overscan с каждой
            // стороны, окно не двигаем. Иначе оно сдвигалось на каждом шаге
            // прокрутки, и лента перестраивалась почти каждые два кадра (174 раза
            // за 6 с прокрутки в живом приложении) — на слабых устройствах это и
            // были рывки. Край списка (начало/конец переписки) — без запаса.
            if (sameList && nextWindow.useWindow && Number.isFinite(nextWindow.overscan)) {
                const margin = Math.max(4, Math.floor(nextWindow.overscan / 3));
                const firstVisible = nextWindow.firstVisible;
                const lastVisible = nextWindow.lastVisible;
                const topOk = current.start === 0 || current.start <= firstVisible - margin;
                const bottomOk = current.end >= msgs.length || current.end >= lastVisible + margin;
                const edgeShift = (nextWindow.start === 0) !== (current.start === 0)
                    || (nextWindow.end >= msgs.length) !== (current.end >= msgs.length);
                if (topOk && bottomOk && !edgeShift) return;
            }
            this.scheduleRenderMessages();
        });
    }

    // Нижняя граница средней высоты строки, по которой считаются заглушки окна
    // виртуализации. На телефоне время стоит в строке с текстом, и короткая
    // реплика занимает ~40px, а не 56: с прежней границей заглушки выходили на
    // треть выше настоящих строк, и при сдвиге окна лента смещалась.
    minMessageRowHeight() {
        return this.isMobileLayout() ? 36 : 56;
    }

    // ── Высоты строк окна виртуализации ───────────────────────────────────────
    // Раньше окно искало видимую строку как scrollTop / средняя высота, а заглушки
    // за окном считало как «число строк × средняя». Средняя пересчитывалась на
    // каждой отрисовке (70 → 62 → 54 → 60 px), настоящие строки не совпадали с ней,
    // и каждый сдвиг окна менял высоту ленты на сотни пикселей: поправка якоря
    // дёргала scrollTop, окно по новому scrollTop снова сдвигалось — около 90
    // перерисовок ленты за одну прокрутку (замер 2026-11-15, 211 сообщений), каждая
    // 10–19 мс при CPU ×12. Теперь у каждого уже отрисованного сообщения запомнена
    // его настоящая высота (от верха строки до верха следующей — с разделителем дня
    // и отступом группы), и заглушки, и поиск видимой строки идут по одним и тем же
    // накопленным высотам. Сдвиг окна заменяет заглушку строками той же высоты —
    // лента не меняет размер, якорь не дёргается, петли нет. Средняя — только для
    // ещё ни разу не отрисованных строк.
    messageHeightKey(msg) {
        return String(msg?.id || msg?.clientId || `${msg?.timestamp || ''}|${msg?.sender || ''}`);
    }

    // Запомненные высоты — по каждому из последних открытых чатов, а не один набор на всех.
    // Раньше хранилище пересоздавалось при каждой смене чата, и на повторном открытии первая
    // отрисовка строила заглушки окна по средней высоте: лента отрисовывалась на 18 000 px короче
    // настоящей, после замера вырастала, и «прилипание» к низу в этот момент слетало.
    messageHeightStore(conversationKey) {
        const key = String(conversationKey || '');
        const stores = this._msgHeightStores || (this._msgHeightStores = new Map());
        let store = stores.get(key);
        if (store) {
            // LRU: недавно использованный — в конец.
            stores.delete(key);
            stores.set(key, store);
            return store;
        }
        store = { key, map: new Map(), sum: 0, version: 0, tops: null, topsFor: null, topsLen: -1, topsVersion: -1, topsFallback: 0, fix: 0 };
        stores.set(key, store);
        while (stores.size > 8) stores.delete(stores.keys().next().value);
        return store;
    }

    /** Средняя измеренная высота строки (или запасная, пока ничего не измерено). */
    messageHeightAverage(store, fallback) {
        const avg = store && store.map.size ? store.sum / store.map.size : fallback;
        return Math.max(this.minMessageRowHeight(), Math.min(160, Number(avg) || 92));
    }

    /** tops[i] — верх i-й строки от начала ленты; tops[n] — высота всех строк. */
    messageRowOffsets(msgs, store, fallback) {
        const n = msgs.length;
        if (store.tops && store.topsFor === msgs && store.topsLen === n
            && store.topsVersion === store.version && store.topsFallback === fallback) {
            return store.tops;
        }
        const tops = new Float64Array(n + 1);
        for (let i = 0; i < n; i += 1) {
            const h = store.map.get(this.messageHeightKey(msgs[i]));
            tops[i + 1] = tops[i] + (h > 0 ? h : fallback);
        }
        store.tops = tops;
        store.topsFor = msgs;
        store.topsLen = n;
        store.topsVersion = store.version;
        store.topsFallback = fallback;
        return tops;
    }

    /** Индекс строки, которая лежит на высоте y (двоичный поиск по tops). */
    messageRowAt(tops, y) {
        const n = tops.length - 1;
        if (n <= 0) return 0;
        let lo = 0;
        let hi = n - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (tops[mid] <= y) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /**
     * Запоминает настоящие высоты только что отрисованных строк окна. nodes — элементы
     * .msg верхнего уровня #msgs в порядке rendered; endTop — верх того, что идёт
     * после последней строки (нижняя заглушка), или её низ.
     */
    recordMessageRowHeights(conversationKey, rendered, nodes, endTop) {
        if (!Array.isArray(rendered) || !nodes || nodes.length !== rendered.length || !nodes.length) return;
        const store = this.messageHeightStore(conversationKey);
        let nextTop = Number(endTop) || 0;
        let changed = false;
        for (let i = nodes.length - 1; i >= 0; i -= 1) {
            const top = nodes[i].offsetTop;
            const h = nextTop - top;
            nextTop = top;
            if (!(h > 0 && h < 4000)) continue;
            const key = this.messageHeightKey(rendered[i]);
            const old = store.map.get(key) || 0;
            if (Math.abs(old - h) < 1) continue;
            store.map.set(key, h);
            store.sum += h - old;
            changed = true;
        }
        if (changed) store.version += 1;
    }

    // anchorIndex >= 0 — открыть чат на запомненном месте (restoreScroll): окно строится вокруг этой
    // строки, а не прижимается к низу.
    computeMessageWindow(msgs, box, { conversationChanged = false, stickToBottom = false, conversationKey = null, anchorIndex = -1 } = {}) {
        const total = Array.isArray(msgs) ? msgs.length : 0;
        const baseAvg = Math.max(this.minMessageRowHeight(), Math.min(160, Number(this.messageWindow?.avgHeight || 92)));
        // Windowing threshold by tier. Every mounted bubble costs layout, paint and
        // a share of the blurred panel it sits inside, so a budget phone starts
        // virtualising sooner than a desktop does. Purely a cost knob: the spacers
        // below reproduce the exact scroll geometry of the unmounted rows, so the
        // list looks and scrolls identically no matter where the threshold sits.
        const tier = this.perfTier();
        // Компьютер ('high') держит смонтированными больше: каждый сдвиг окна — перерисовка
        // посреди прокрутки, а лишние строки вне экрана ему почти ничего не стоят.
        const windowThreshold = tier === 'weak' ? 100 : tier === 'mid' ? 140 : 320;
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

        const key = conversationKey != null ? conversationKey
            : (this.S.navMode === 'servers' ? this.currentServerChatKey() : String(this.S.current || '').trim());
        const store = this.messageHeightStore(key);
        // Поправка верхней заглушки относилась к прежнему показу чата; новый показ начинается с чистого листа.
        if (conversationChanged) store.fix = 0;
        const avg = this.messageHeightAverage(store, baseAvg);
        const tops = this.messageRowOffsets(msgs, store, avg);
        const viewportCount = Math.max(18, Math.ceil(Math.max(1, box.clientHeight) / avg) + 8);
        // Overscan is deliberately NOT cut hard on weak devices. It is what keeps a
        // fast fling from outrunning the render and exposing bare spacer — trimming
        // it to save paint would trade a frame-rate win for visible blank gaps on
        // exactly the devices least able to refill them. 0.55/24 is a modest trim,
        // still well over a screenful either side of the viewport.
        const overscanFactor = tier === 'weak' ? 0.55 : 0.7;
        const overscanFloor = tier === 'weak' ? 24 : tier === 'mid' ? 30 : 60;
        const overscan = Math.max(overscanFloor, Math.floor(viewportCount * overscanFactor));
        const windowSize = Math.min(total, viewportCount + overscan * 2);
        const nearTop = box.scrollTop <= avg * 4;
        const nearBottom = this.isMessagesNearBottom(box, avg * 2);
        // store.fix — поправка верхней заглушки, которой лента поглотила сдвиг якоря во
        // время прокрутки (absorbMessageAnchorShift): строки ниже заглушки стоят на fix
        // ниже своей расчётной высоты.
        const fix = Number(store.fix) || 0;
        const firstVisible = this.messageRowAt(tops, box.scrollTop - fix);
        const lastVisible = this.messageRowAt(tops, box.scrollTop - fix + box.clientHeight);

        let start = Math.max(0, firstVisible - overscan);
        let end = Math.min(total, start + windowSize);

        if (anchorIndex >= 0 && anchorIndex < total) {
            start = Math.max(0, Math.min(anchorIndex - overscan, total - windowSize));
            end = Math.min(total, start + windowSize);
        } else if (conversationChanged || stickToBottom || nearBottom) {
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

        // В начале переписки заглушки нет — поправке негде жить (её снимет якорь).
        if (start === 0) store.fix = 0;
        return {
            useWindow: true,
            start,
            end,
            topSpacer: Math.max(0, tops[start] + (start > 0 ? fix : 0)),
            bottomSpacer: Math.max(0, tops[total] - tops[end]),
            avgHeight: avg,
            overscan,
            viewportCount,
            firstVisible,
            lastVisible,
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

    // Открытие чата внизу: раскладка всего окна (до ~140 пузырей, ~1200 объектов раскладки) одним
    // кадром была самым длинным кадром смены чата. Верхние строки окна получают `.msg-defer`
    // (content-visibility: hidden, высота — оценка из --msg-defer-h) и достраиваются по
    // DEFER_CHUNK строк за кадр, от ближних к экрану к дальним. Каждый кусок сохраняет положение
    // нижней строки на экране (scrollTop += сдвиг): `overflow-anchor: none`, и без этого рост строк
    // над экраном сдвигал бы читаемое. Ввод человека (колесо, касание) на время достройки —
    // достроить всё сразу. Возвращает состояние (onDone вызывается, когда все строки настоящие) или
    // null, если откладывать нечего или движок content-visibility не знает.
    deferOffscreenMessageRows(box, nodes, windowInfo, conversationKey) {
        if (!box || !nodes || typeof requestAnimationFrame !== 'function') return null;
        const total = nodes.length;
        const keep = Math.max(28, (Number(windowInfo?.viewportCount) || 0) + 8);
        if (total <= keep + 24) return null;
        try {
            if (typeof CSS === 'undefined' || !CSS.supports?.('content-visibility', 'hidden')) return null;
        } catch (e) { return null; }
        const store = this.messageHeightStore(conversationKey);
        const avg = this.messageHeightAverage(store, Number(this.messageWindow?.avgHeight || 92));
        const deferred = Array.prototype.slice.call(nodes, 0, total - keep);
        const anchor = nodes[total - 1];
        box.style.setProperty('--msg-defer-h', `${Math.max(24, Math.round(avg) - 8)}px`);
        for (const node of deferred) node.classList.add('msg-defer');
        const state = { next: deferred.length, onDone: null, raf: 0, carry: 0 };
        box.__msgDefer = state;
        const finish = (completed) => {
            if (box.__msgDefer !== state) return;
            box.__msgDefer = null;
            box.style.removeProperty('--msg-defer-h');
            if (completed && state.onDone) state.onDone();
        };
        // Свёрнутому окну кадров не дают — страховочный таймер, иначе строки остались бы оценками.
        const schedule = () => {
            let ran = false;
            const run = () => { if (ran) return; ran = true; step(); };
            state.raf = requestAnimationFrame(run);
            setTimeout(run, 200);
        };
        const step = () => {
            state.raf = 0;
            if (box.__msgDefer !== state || !box.isConnected || !anchor.isConnected) { finish(false); return; }
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const userActive = now - Number(this._msgUserScrollAt || 0) < 300;
            const chunk = userActive ? state.next : ZaliInterface.DEFER_CHUNK;
            const before = anchor.getBoundingClientRect().top;
            for (let n = 0; n < chunk && state.next > 0; n += 1) {
                state.next -= 1;
                deferred[state.next].classList.remove('msg-defer');
            }
            // Целыми пикселями, остаток — в следующий кусок: иначе нижняя строка дрожала бы на 1–2 px.
            const want = anchor.getBoundingClientRect().top - before + state.carry;
            const apply = Math.round(want);
            state.carry = want - apply;
            if (apply !== 0) {
                this.markProgrammaticScroll();
                box.scrollTop += apply;
            }
            if (state.next > 0) schedule();
            else finish(true);
        };
        schedule();
        return state;
    }

    static get DEFER_CHUNK() { return 24; }

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

    /** Насколько якорная строка ушла от своего места после перерисовки (px) или null. */
    messageAnchorDelta(box, anchor) {
        if (!box || !anchor?.messageId) return null;
        let node = null;
        try {
            const escaped = (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') ? CSS.escape(anchor.messageId) : null;
            if (escaped) node = box.querySelector(`.msg[data-message-id="${escaped}"]`);
        } catch (e) { node = null; }
        if (!node) return null;
        const boxRect = box.getBoundingClientRect?.();
        const rect = node.getBoundingClientRect?.();
        if (!boxRect || !rect) return null;
        return (rect.top - boxRect.top) - Number(anchor.topOffset || 0);
    }

    // Пока пользователь листает, сдвиг якоря после перерисовки окна забирает верхняя
    // заглушка (меняется её высота), а не scrollTop: любая запись scrollTop обрывает
    // идущую инерцию трекпада и пальца — и WebKit, и Chromium. Сдвиг возникает при первом
    // проходе по истории: высоты ещё не отрисованных строк окно знает только по средней.
    // Когда прокрутка затихнет, rebaseMessageSpacer перенесёт поправку в scrollTop.
    absorbMessageAnchorShift(box, delta, windowInfo, conversationKey) {
        if (!windowInfo?.useWindow || !(windowInfo.start > 0)) return false;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!(now - Number(this._msgUserScrollAt || 0) < 400)) return false;
        const spacer = box.firstElementChild;
        if (!spacer || !spacer.classList?.contains('msg-window-spacer')) return false;
        const current = parseFloat(spacer.style.height) || 0;
        const next = current - delta;
        if (next < 0) return false;
        spacer.style.height = `${next}px`;
        const store = this.messageHeightStore(conversationKey);
        store.fix = (Number(store.fix) || 0) - delta;
        clearTimeout(this._msgRebaseTimer);
        this._msgRebaseTimer = setTimeout(() => this.rebaseMessageSpacer(conversationKey), 450);
        return true;
    }

    rebaseMessageSpacer(conversationKey) {
        const store = this._msgHeightStores?.get(String(conversationKey || ''));
        if (!store || !store.fix) return;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - Number(this._msgUserScrollAt || 0) < 400) {
            clearTimeout(this._msgRebaseTimer);
            this._msgRebaseTimer = setTimeout(() => this.rebaseMessageSpacer(conversationKey), 300);
            return;
        }
        const box = document.getElementById('msgs');
        const spacer = box?.firstElementChild;
        if (!box || !spacer || !spacer.classList?.contains('msg-window-spacer')) { store.fix = 0; return; }
        const current = parseFloat(spacer.style.height) || 0;
        const next = Math.max(0, current - store.fix);
        const applied = current - next;
        store.fix = 0;
        spacer.style.height = `${next}px`;
        if (Math.abs(applied) >= 1) {
            this.markProgrammaticScroll();
            box.scrollTop -= applied;
        }
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
        // Сдвиг меньше пикселя — не писать: любая запись scrollTop обрывает идущую
        // инерцию трекпада/пальца (WebKit и Chromium), а раньше здесь писался и ноль.
        const delta = (rect.top - boxRect.top) - Number(anchor.topOffset || 0);
        if (Math.abs(delta) >= 1) box.scrollTop += delta;
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

    // Лента меняет высоту не только при повороте: клавиатура, выросшее на три
    // строки поле ввода, плашка ответа, вложения. `scrollTop` при этом остаётся
    // прежним, то есть верх ленты стоит, а низ уезжает под поле ввода — ровно
    // тот край, на который человек смотрит. Держим низ: на сколько лента стала
    // ниже, на столько и прокручиваем (и обратно). Открытая на последнем
    // сообщении лента остаётся на нём, а прочитанное посередине истории не
    // прыгает — как в нативных мессенджерах. ResizeObserver срабатывает после
    // раскладки и до отрисовки, поэтому сдвиг не виден ни одним кадром.
    setupMessagesViewportAnchor() {
        const box = document.getElementById('msgs');
        if (!box || box.__viewportAnchorBound || typeof ResizeObserver !== 'function') return;
        box.__viewportAnchorBound = true;
        // height — высота на момент прошлого срабатывания; gap — расстояние до
        // низа, когда оно было измерено в согласованном состоянии.
        const state = { height: box.clientHeight, gap: 0 };
        const gapNow = () => Math.max(0, box.scrollHeight - box.scrollTop - box.clientHeight);
        // Событие scroll приходит в начале кадра, ДО раскладки и наблюдателя. Если
        // в этом же кадре меняется высота (анимация клавиатуры двигает её каждый
        // кадр, а наша же поправка scrollTop порождает scroll), чтение геометрии
        // здесь уже видит новую высоту — такой замер в память не идёт.
        box.addEventListener('scroll', () => {
            if (box.clientHeight === state.height) state.gap = gapNow();
        }, { passive: true });
        // Картинка, аватарка или видео, догрузившиеся уже после закрепления, растят ленту, а
        // scrollTop остаётся — низ уезжал вверх, и «к низу не прилипало». Следим, пока человек
        // не листал сам (_bottomIntent) или лента и так стояла у низа; один сдвиг на кадр.
        let mediaRaf = 0;
        const followLateMedia = () => {
            if (mediaRaf || this.pendingMessagesScroll) return;
            if (!this._bottomIntent && state.gap > 56) return;
            mediaRaf = requestAnimationFrame(() => {
                mediaRaf = 0;
                if (this.pendingMessagesScroll || (!this._bottomIntent && state.gap > 56)) return;
                if (gapNow() <= 1) return;
                this.markProgrammaticScroll();
                box.scrollTop = box.scrollHeight;
                state.gap = gapNow();
            });
        };
        box.addEventListener('load', followLateMedia, true);
        box.addEventListener('loadedmetadata', followLateMedia, true);
        this._msgFollowState = state;
        // Ввод человека: колесо, касание, клавиши, нажатие мыши (полоса прокрутки). По нему скролл-событие
        // отличается от дрожания, которое делает сам браузер (onMessagesScroll).
        const nowStamp = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const noteInput = () => { this._msgUserInputAt = nowStamp(); };
        for (const type of ['wheel', 'touchstart', 'touchmove']) {
            box.addEventListener(type, noteInput, { passive: true });
        }
        // После касания лента ещё катится по инерции — это тоже человек (onMessagesScroll).
        box.addEventListener('touchend', () => { this._msgTouchEndAt = nowStamp(); }, { passive: true });
        box.addEventListener('touchcancel', () => { this._msgTouchEndAt = nowStamp(); }, { passive: true });
        // Нажатая кнопка мыши (перетаскивание полосы прокрутки) — ввод, пока не отпущена.
        box.addEventListener('pointerdown', () => { this._msgPointerActive = true; noteInput(); }, { passive: true });
        window.addEventListener('pointerup', () => { this._msgPointerActive = false; noteInput(); }, true);
        window.addEventListener('pointercancel', () => { this._msgPointerActive = false; }, true);
        document.addEventListener('keydown', noteInput, true);
        // Свернули окно или ушли в фон — запомнить место чтения (saveCurrentScrollMemory).
        document.addEventListener('visibilitychange', () => { if (document.hidden) this.saveCurrentScrollMemory(); });
        window.addEventListener('pagehide', () => this.saveCurrentScrollMemory());
        new ResizeObserver(() => {
            const height = box.clientHeight;
            const previous = state.height;
            const delta = previous - height;
            state.height = height;
            // Скрытый экран (display: none) отдаёт 0 — это не изменение высоты.
            if (!delta || !height || !previous || this.pendingMessagesScroll) {
                if (height) state.gap = gapNow();
                return;
            }
            const scrollHeight = box.scrollHeight;
            const top = box.scrollTop;
            let gapBefore;
            if (delta > 0) {
                // Стала ниже: scrollTop браузер не трогал, «было» считается точно.
                gapBefore = scrollHeight - top - previous;
            } else {
                // Стала выше: у самого низа браузер уже прижал scrollTop к новому
                // максимуму, и точное «было» потеряно — известно лишь, что оно не
                // больше прироста. Тогда берём запомненное.
                const now = scrollHeight - top - height;
                gapBefore = now <= 1 ? Math.min(state.gap, -delta) : now - delta;
            }
            this.markProgrammaticScroll();
            if (gapBefore <= 2 || this._bottomIntent) {
                box.scrollTop = scrollHeight;
                if (this._bottomIntent) this.pinToBottomAfterLayout(box);
            } else {
                // Середина истории: низ видимой части остаётся на месте.
                box.scrollTop = scrollHeight - height - gapBefore;
            }
            state.gap = gapNow();
            this.syncJumpToBottom(box);
        }).observe(box);
    }

    // Строки, растущие уже после отрисовки (анимированный стикер, превью ссылки, видео без
    // события load), растят ленту, а scrollTop остаётся — низ уезжал вверх. ResizeObserver на каждой
    // отрисованной строке (их ≤ окна виртуализации): рост при «держим низ» — сразу к низу, ещё до
    // кадра. Набор наблюдаемых сверяется после каждой отрисовки списка, лишние узлы снимаются.
    watchMessageRows(box) {
        if (!box || typeof ResizeObserver !== 'function') return;
        if (!this._rowRO) {
            this._rowObserved = new Set();
            this._rowRO = new ResizeObserver(() => {
                const box2 = document.getElementById('msgs');
                if (!box2 || this.pendingMessagesScroll) return;
                const follow = this._bottomIntent || (this._msgFollowState && this._msgFollowState.gap <= 56);
                if (!follow) return;
                if (box2.scrollHeight - box2.scrollTop - box2.clientHeight <= 1) return;
                this.markProgrammaticScroll();
                box2.scrollTop = box2.scrollHeight;
                if (this._msgFollowState) this._msgFollowState.gap = 0;
            });
        }
        const observed = this._rowObserved;
        for (const node of observed) {
            if (!node.isConnected) { this._rowRO.unobserve(node); observed.delete(node); }
        }
        for (const node of box.querySelectorAll(':scope > .msg')) {
            if (observed.has(node)) continue;
            observed.add(node);
            this._rowRO.observe(node);
        }
    }

    // Кнопка «к последним сообщениям»: появляется, когда лента отмотана больше
    // чем на экран с небольшим. Единственный способ вернуться без неё — мотать
    // вручную всю историю.
    syncJumpToBottom(box) {
        const btn = this._jumpBtn || (this._jumpBtn = document.getElementById('msgsJumpBtn'));
        if (!btn || !box) return;
        const gap = box.scrollHeight - (box.scrollTop + box.clientHeight);
        const show = gap > Math.max(320, box.clientHeight * 0.6);
        if (show === this._jumpBtnShown) return;
        this._jumpBtnShown = show;
        btn.classList.toggle('visible', show);
        btn.tabIndex = show ? 0 : -1;
    }

    jumpToLatestMessages() {
        const box = document.getElementById('msgs');
        if (!box) return;
        const gap = box.scrollHeight - (box.scrollTop + box.clientHeight);
        this._jumpBtnShown = false;
        this._jumpBtn?.classList.remove('visible');
        // Близко — доезжаем плавно, чтобы было видно, куда делась лента. Далеко
        // (и тем более через заглушки окна виртуализации) — сразу: плавная
        // прокрутка на десятки экранов заставила бы перерисовать их все по пути.
        const near = gap <= box.clientHeight * 2.5 && typeof box.scrollTo === 'function';
        if (near) {
            box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
            return;
        }
        // Прыжок в самый низ переводит окно виртуализации в конец через обычный
        // обработчик прокрутки; закрепление доводит до последнего сообщения,
        // когда настоящие строки встанут на место заглушек.
        this.markProgrammaticScroll();
        box.scrollTop = box.scrollHeight;
        this.pinToBottomAfterLayout(box);
    }

    isMessagesNearBottom(box, threshold = 56) {
        if (!box) return true;
        return (box.scrollHeight - (box.scrollTop + box.clientHeight)) <= threshold;
    }

    // ── Запомненное место чтения ──────────────────────────────────────────────
    // Чат открывался всегда внизу, даже если человек ушёл из него (или свернул приложение)
    // на середине истории. Теперь при уходе из переписки, при сворачивании окна и при
    // закрытии страницы запоминается якорь: id сообщения у верха ленты и его отступ. Открытие
    // возвращает туда — если с тех пор не пришло нового (тогда читать надо новое, внизу) и
    // сообщение ещё есть. Хранится на устройстве, по аккаунту, не больше 40 переписок.
    scrollMemoryStorageKey() {
        return `zali_scroll_marks_v1:${String(this.myName?.() || '').trim().toLowerCase()}`;
    }

    loadScrollMemory() {
        const storageKey = this.scrollMemoryStorageKey();
        if (this._scrollMemory && this._scrollMemoryOwner === storageKey) return this._scrollMemory;
        let marks = {};
        try {
            const raw = JSON.parse(localStorage.getItem(storageKey) || 'null');
            if (raw && typeof raw === 'object') marks = raw;
        } catch (e) { marks = {}; }
        this._scrollMemory = marks;
        this._scrollMemoryOwner = storageKey;
        return marks;
    }

    persistScrollMemory({ now = false } = {}) {
        const write = () => {
            this._scrollMemorySaveTimer = null;
            const marks = this.loadScrollMemory();
            const keys = Object.keys(marks);
            if (keys.length > 40) {
                keys.sort((a, b) => Number(marks[a]?.at || 0) - Number(marks[b]?.at || 0));
                for (const old of keys.slice(0, keys.length - 40)) delete marks[old];
            }
            try { localStorage.setItem(this.scrollMemoryStorageKey(), JSON.stringify(marks)); } catch (e) { /* только до перезагрузки */ }
        };
        if (now) {
            clearTimeout(this._scrollMemorySaveTimer);
            write();
        } else if (!this._scrollMemorySaveTimer) {
            this._scrollMemorySaveTimer = setTimeout(write, 800);
        }
    }

    // box должен показывать именно эту переписку — иначе в память попало бы чужое место.
    saveScrollMemory(conversationKey, box, newestTs) {
        const key = String(conversationKey || '');
        if (!key || !box || !box.clientHeight) return false;
        if (!box.querySelector(':scope > .msg[data-message-id]')) return false;
        const marks = this.loadScrollMemory();
        const newest = Number(newestTs) || 0;
        if (this.isMessagesNearBottom(box) || this._bottomIntent) {
            marks[key] = { bottom: true, newest, at: Date.now() };
        } else {
            const anchor = this.captureMessageScrollAnchor(box);
            if (!anchor) return false;
            marks[key] = { id: anchor.messageId, off: Math.round(anchor.topOffset), bottom: false, newest, at: Date.now() };
        }
        this.persistScrollMemory();
        return true;
    }

    // Сворачивание окна / уход приложения в фон / закрытие страницы: текущая переписка — в память сразу.
    saveCurrentScrollMemory() {
        const box = document.getElementById('msgs');
        if (!box || this.isMobileChatOffscreen?.()) return;
        const key = this.S.navMode === 'servers' ? this.currentServerChatKey() : String(this.S.current || '').trim();
        if (!key || this.lastRenderedConversationKey !== key) return;
        if (this.saveScrollMemory(key, box, this._renderedNewestTs)) this.persistScrollMemory({ now: true });
    }

    // Куда вернуть чат при открытии: { index, id, off } или null (открывать внизу).
    pickScrollRestore(conversationKey, msgs) {
        const entry = this.loadScrollMemory()[String(conversationKey || '')];
        if (!entry || entry.bottom || !entry.id || !Array.isArray(msgs) || !msgs.length) return null;
        if (Date.now() - Number(entry.at || 0) > 3 * 24 * 3600 * 1000) return null;
        const newestNow = this.messageTimestampValue(msgs[msgs.length - 1]?.timestamp);
        // Пока человека не было, пришло новое — открываем внизу, как мессенджеры с непрочитанным.
        if (newestNow > Number(entry.newest || 0)) return null;
        const index = msgs.findIndex(msg => String(msg?.id || '') === entry.id || String(msg?.clientId || '') === entry.id);
        if (index < 0) return null;
        return { index, id: entry.id, off: Number(entry.off) || 0 };
    }

    applyScrollRestore(box, restore) {
        if (!box || !restore?.id) return false;
        let node = null;
        try { node = box.querySelector(`.msg[data-message-id="${CSS.escape(restore.id)}"]`); } catch (e) { node = null; }
        if (!node) return false;
        const boxRect = box.getBoundingClientRect();
        const rect = node.getBoundingClientRect();
        this.markProgrammaticScroll();
        const delta = (rect.top - boxRect.top) - restore.off;
        if (Math.abs(delta) >= 1) box.scrollTop += delta;
        // Читают историю, а не следуют за низом.
        this._bottomIntent = false;
        this.syncJumpToBottom?.(box);
        // Пока высоты строк вокруг якоря ещё не измерены (чат только что загружен), окно и заглушки
        // считаются по оценкам и после замера сдвигаются — якорь уплывал на сотни строк. Короткое время
        // окно держим вокруг якоря, а его отступ подтверждаем после каждой отрисовки; ручной скролл
        // снимает удержание.
        this._restoreHold = { id: restore.id, off: restore.off, since: typeof performance !== 'undefined' ? performance.now() : Date.now() };
        this._restoreHold.until = this._restoreHold.since + 2500;
        return true;
    }

    /** Индекс якоря, вокруг которого пока держим окно (applyScrollRestore), или -1. */
    restoreHoldIndex(msgs) {
        const hold = this._restoreHold;
        if (!hold) return -1;
        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now > hold.until || Number(this._msgUserScrollAt || 0) > hold.since) {
            this._restoreHold = null;
            return -1;
        }
        if (!Array.isArray(msgs)) return -1;
        return msgs.findIndex(msg => String(msg?.id || '') === hold.id || String(msg?.clientId || '') === hold.id);
    }
});
