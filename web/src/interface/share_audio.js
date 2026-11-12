// --- ZaliInterface: звук самого приложения в демонстрации экрана. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Оболочка снимает звук системы БЕЗ всего ZaliMessenger (macOS — tap без процессов
// приложения и его WebKit, Windows — process loopback без дерева процессов): иначе
// голоса собеседников из наших динамиков ушли бы в демонстрацию и они слышали бы себя.
// Но тогда пропадало бы и остальное, что играет приложение. Это остальное страница
// собирает сама и подмешивает в звук демонстрации:
//   • голоса звонка и звук чужих демонстраций — НЕ попадают (свои <audio>/<video>
//     собеседников сюда не заводятся);
//   • звуки входа/выхода из звонка — тоже нет: зрители сами в звонке и слышат их;
//   • уведомления и рингтоны — приглушённо (SHARE_DUCK_GAIN);
//   • видео и аудио из переписки (вложения) — как есть.
// Аддоны (sandbox iframe с непрозрачным origin) отсюда недостижимы — их звука в
// демонстрации нет.
//
// Всё сводится в общем контексте звуков (this.sound.ctx): уведомления и так играют
// там, а медиа вложений заводится туда через createMediaElementSource (один раз на
// элемент — после этого его звук навсегда идёт через контекст, слышно его так же).
ZaliMixin(ZaliInterface, class {

    // ≈ −10 дБ: уведомление в стриме слышно, но не перекрывает показываемое.
    static get SHARE_DUCK_GAIN() { return 0.3; }

    shareAudioState() {
        if (!this._shareAudio) {
            this._shareAudio = {
                active: false,
                ctx: null,
                soundTee: null,   // уведомления/рингтоны (вход приглушения)
                mediaBus: null,   // звук вложений
                duck: null,
                dest: null,
                nativeSource: null,
                routed: new WeakSet(),
                onPlay: null,
                routedCount: 0,
            };
        }
        return this._shareAudio;
    }

    // Постоянные узлы на контекст: отводы с выхода звуков создаются вместе с шиной
    // звуков (soundBus/soundDirectBus) всегда — неподключённый к выходу узел ничего не
    // считает, а подключать их в момент старта демонстрации не к чему было бы.
    shareAudioNodes(ctx) {
        const st = this.shareAudioState();
        if (st.ctx !== ctx) {
            st.ctx = ctx;
            st.soundTee = ctx.createGain();
            st.mediaBus = ctx.createGain();
            st.duck = ctx.createGain();
            st.duck.gain.value = ZaliInterface.SHARE_DUCK_GAIN;
            st.soundTee.connect(st.duck);
            st.dest = null;
            st.routed = new WeakSet();
        }
        return st;
    }

    /** Отвод выхода звуков (зовут soundBus/soundDirectBus при создании шины). */
    teeShareSound(ctx, node, gain = 1) {
        try {
            const st = this.shareAudioNodes(ctx);
            if (gain === 1) {
                node.connect(st.soundTee);
            } else {
                const g = ctx.createGain();
                g.gain.value = gain;
                node.connect(g);
                g.connect(st.soundTee);
            }
        } catch (e) {}
    }

    /**
     * Звук демонстрации = звук системы от оболочки (nativeTrack, может не быть) +
     * звук приложения без звонка. Возвращает дорожку для отправки или null (нет Web
     * Audio — тогда шлётся nativeTrack как есть).
     */
    startShareAppAudio(nativeTrack = null) {
        const ctx = this.ensureSoundContext?.();
        if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') return null;
        this.stopShareAppAudio('restart');
        // Шины звуков создаются заранее: иначе первое уведомление за время показа
        // создало бы их уже после подключения, и отвод всё равно подключился бы
        // (shareAudioNodes общий), но так порядок проще читать в журнале.
        this.soundBus?.(ctx);
        this.soundDirectBus?.(ctx);
        const st = this.shareAudioNodes(ctx);
        try {
            st.dest = ctx.createMediaStreamDestination();
            st.duck.connect(st.dest);
            st.mediaBus.connect(st.dest);
            if (nativeTrack) {
                st.nativeSource = ctx.createMediaStreamSource(new MediaStream([nativeTrack]));
                st.nativeSource.connect(st.dest);
            }
        } catch (error) {
            this.voiceDiag?.('share-app-audio-failed', { error: error?.message || String(error) }, 'WARN');
            this.stopShareAppAudio('failed');
            return null;
        }
        st.active = true;
        // Уже играющие вложения и всё, что запустят во время показа. 'play' не
        // всплывает — ловим на погружении.
        for (const el of document.querySelectorAll('video, audio')) {
            if (!el.paused) this.routeShareMedia(el);
        }
        st.onPlay = (event) => this.routeShareMedia(event.target);
        document.addEventListener('play', st.onPlay, true);
        if (ctx.state === 'suspended') ctx.resume?.().catch(() => {});
        this.voiceDiag?.('share-app-audio-start', {
            native: !!nativeTrack,
            ctx: ctx.state,
            rate: ctx.sampleRate,
            duck: ZaliInterface.SHARE_DUCK_GAIN,
        });
        return st.dest.stream.getAudioTracks()[0] || null;
    }

    stopShareAppAudio(reason = 'stop') {
        const st = this.shareAudioState();
        if (st.onPlay) {
            document.removeEventListener('play', st.onPlay, true);
            st.onPlay = null;
        }
        if (st.dest) {
            try { st.duck?.disconnect(st.dest); } catch (e) {}
            try { st.mediaBus?.disconnect(st.dest); } catch (e) {}
            for (const t of st.dest.stream.getTracks()) { try { t.stop(); } catch (e) {} }
            st.dest = null;
        }
        if (st.nativeSource) {
            try { st.nativeSource.disconnect(); } catch (e) {}
            st.nativeSource = null;
        }
        if (st.active) this.voiceDiag?.('share-app-audio-stop', { reason, media: st.routedCount });
        st.active = false;
    }

    /**
     * Заведённое в контекст вложение слышно, только пока контекст идёт — и после
     * демонстрации тоже. Контекст звуков сам будится только звуком уведомления, а
     * WebKit/Chromium приостанавливают его (смена устройства, прерывание, сон): видео
     * играло бы молча. Будим при каждом play заведённого элемента и при любой
     * остановке контекста, пока такой элемент играет. Один раз на контекст.
     */
    keepShareMediaAudible(ctx) {
        const st = this.shareAudioState();
        if (st.keepAliveCtx === ctx) return;
        st.keepAliveCtx = ctx;
        const wake = (why) => {
            if (st.ctx !== ctx || ctx.state === 'running' || ctx.state === 'closed') return;
            this.voiceDiag?.('share-app-audio-resume', { why, state: ctx.state });
            ctx.resume?.().catch(() => {});
        };
        document.addEventListener('play', (event) => {
            if (st.routed.has(event.target)) wake('play');
        }, true);
        ctx.addEventListener?.('statechange', () => {
            const playing = Array.from(document.querySelectorAll('video, audio'))
                .some(el => st.routed.has(el) && !el.paused);
            if (playing) wake('statechange');
        });
    }

    /** Вложение из переписки → в звук демонстрации (и, как раньше, в динамики). */
    routeShareMedia(el) {
        const st = this.shareAudioState();
        if (!st.active || !st.ctx || !el || st.routed.has(el)) return;
        // Только медиа переписки. Голоса и экраны собеседников — свои <audio>/<video>
        // без этих классов: их в демонстрацию не пускаем.
        if (!el.matches?.('.media-video, .media-audio-player')) return;
        if (el.muted && el.matches('.media-gif-like')) return;
        const src = el.currentSrc || el.src || '';
        // Чужой origin без CORS createMediaElementSource превращает в тишину — и в
        // динамиках тоже. Вложения приезжают blob:/data:, их можно.
        let sameOrigin = /^(blob|data):/i.test(src);
        if (!sameOrigin) {
            try { sameOrigin = new URL(src, location.href).origin === location.origin; } catch (e) {}
        }
        if (!sameOrigin) {
            this.voiceDiag?.('share-app-audio-skip', { reason: 'cross-origin' });
            return;
        }
        try {
            const node = st.ctx.createMediaElementSource(el);
            node.connect(st.ctx.destination);
            node.connect(st.mediaBus);
            st.routed.add(el);
            st.routedCount += 1;
            this.keepShareMediaAudible(st.ctx);
            this.voiceDiag?.('share-app-audio-media', { tag: el.tagName.toLowerCase(), count: st.routedCount });
        } catch (error) {
            // Элемент уже заведён в другой контекст и т. п. — играет как раньше, без стрима.
            st.routed.add(el);
            this.voiceDiag?.('share-app-audio-skip', { reason: error?.message || String(error) }, 'WARN');
        }
    }
});
