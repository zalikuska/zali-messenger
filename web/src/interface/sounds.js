// --- ZaliInterface: звуки приложения — выбор, проигрывание готовых буферов, настройки. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Два события со звуком: новое сообщение (playMessageChime) и входящий звонок
// (startRingtone/stopRingtone). У каждого — свой выбор в настройках:
//   • новые звуки считает modules/sound_synth.js: один раз, офлайн, в готовый
//     стереобуфер; рингтон крутится AudioBufferSourceNode.loop без шва и без таймеров;
//   • «Классика» — прежний живой синтез из осцилляторов (notifications.js), оставлен
//     как вариант и как запасной путь: не удалось отрендерить буфер — звучит он.
//
// Выбор лежит в audioPrefs (messageSound / ringtone), пустая строка = звук по умолчанию,
// и ездит между устройствами вместе с громкостями (settings_sync.js, запись audio_volumes).
//
// Третья группа — звуки голосового канала (заход и выход участника, включение и
// выключение демонстрации):
// не выбираются, только включаются одним переключателем (audioPrefs.voiceSounds).
ZaliMixin(ZaliInterface, class {

    soundKindInfo(kind) {
        return kind === 'ring'
            ? { pref: 'ringtone', fallback: 'gruv', title: 'Рингтон звонка' }
            : { pref: 'messageSound', fallback: 'gruv', title: 'Звук сообщения' };
    }

    soundCatalog(kind) {
        const synth = window.ZaliSoundSynth;
        if (kind === 'voice') return synth ? synth.list('voice') : [];
        const classic = {
            id: 'classic',
            name: 'Классика',
            hint: kind === 'ring' ? 'Прежний рингтон' : 'Прежний сигнал',
        };
        return [...(synth ? synth.list(kind) : []), classic];
    }

    selectedSound(kind) {
        const info = this.soundKindInfo(kind);
        const ids = this.soundCatalog(kind).map(sound => sound.id);
        const stored = String(this.audioPrefs?.[info.pref] || '');
        if (ids.includes(stored)) return stored;
        return ids.includes(info.fallback) ? info.fallback : 'classic';
    }

    setSelectedSound(kind, id) {
        const info = this.soundKindInfo(kind);
        if (!this.soundCatalog(kind).some(sound => sound.id === id)) return;
        if (!this.audioPrefs) return;
        this.audioPrefs[info.pref] = id;
        this.saveAudioPrefs();
        this.renderSoundSettings();
    }

    // Готовый AudioBuffer звука под частоту дискретизации контекста (рендер ровно в
    // неё — без пересчёта на проигрывании). Кеш в памяти: звуки сообщений — все, что
    // запрашивали (сотни килобайт), рингтонов — выбранный и последний прослушанный
    // (каждый — пара мегабайт).
    soundBufferKey(kind, id, ctx) {
        return `${kind}:${id}:${ctx.sampleRate}`;
    }

    soundBufferCached(kind, id, ctx) {
        if (!ctx) return null;
        return this.sound.buffers?.get(this.soundBufferKey(kind, id, ctx)) || null;
    }

    // Готовые сэмплы → AudioBuffer в кеше. Копирование — доли миллисекунды; дорогой
    // сам рендер, и он идёт в воркере (soundBufferAsync), а здесь только при его
    // отсутствии.
    storeSoundBuffer(kind, id, ctx, rendered) {
        const cache = this.sound.buffers || (this.sound.buffers = new Map());
        const buffer = ctx.createBuffer(2, rendered.left.length, rendered.sampleRate);
        buffer.getChannelData(0).set(rendered.left);
        buffer.getChannelData(1).set(rendered.right);
        if (kind === 'ring') {
            const keep = `ring:${this.selectedSound('ring')}:`;
            for (const other of [...cache.keys()]) {
                if (other.startsWith('ring:') && !other.startsWith(keep)) cache.delete(other);
            }
        }
        cache.set(this.soundBufferKey(kind, id, ctx), buffer);
        return buffer;
    }

    // Синхронный рендер на главном потоке — только если воркер недоступен (нет
    // Worker/Blob). С воркером звук, которого нет в кеше, сразу не играет: рендер
    // рингтона — сотни миллисекунд на слабом телефоне, это фриз интерфейса в момент
    // звонка или прихода сообщения. Вызывающие получают null и идут в свой запасной
    // путь (classic), а буфер дозревает в фоне.
    soundBuffer(kind, id, ctx) {
        const synth = window.ZaliSoundSynth;
        if (!synth || !ctx) return null;
        const cached = this.soundBufferCached(kind, id, ctx);
        if (cached) return cached;
        if (this.soundWorker()) {
            this.soundBufferAsync(kind, id, ctx);
            return null;
        }
        try {
            const rendered = synth.render(kind, id, ctx.sampleRate);
            if (!rendered) return null;
            const buffer = this.storeSoundBuffer(kind, id, ctx, rendered);
            this.soundDbPut(kind, id, rendered);
            return buffer;
        } catch (error) {
            this.trace?.(`sound: render failed ${kind}/${id}: ${error?.message || error}`);
            return null;
        }
    }

    // Воркер рендера: тот же модуль ZaliSoundSynth, исходник берётся у него самого
    // (workerSource), отдельного файла нет — бандл один на все оболочки. null — если
    // воркеры недоступны или создать не вышло; тогда рендер синхронный, как раньше.
    soundWorker() {
        if (this.sound.worker !== undefined) return this.sound.worker;
        this.sound.worker = null;
        try {
            const synth = window.ZaliSoundSynth;
            if (!synth?.workerSource || typeof Worker !== 'function' || typeof Blob !== 'function' || !window.URL?.createObjectURL) return null;
            const source = synth.workerSource() + `
self.onmessage = (event) => {
    const { seq, kind, id, sampleRate } = event.data || {};
    try {
        const r = self.ZaliSoundSynth.render(kind, id, sampleRate);
        if (!r) { self.postMessage({ seq, ok: false }); return; }
        self.postMessage({ seq, ok: true, left: r.left, right: r.right, sampleRate: r.sampleRate }, [r.left.buffer, r.right.buffer]);
    } catch (error) {
        self.postMessage({ seq, ok: false, error: String(error && error.message || error) });
    }
};`;
            const url = window.URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
            const worker = new Worker(url);
            window.URL.revokeObjectURL(url);
            this.sound.workerSeq = 0;
            this.sound.workerWaiters = new Map();
            worker.onmessage = (event) => {
                const msg = event.data || {};
                const waiter = this.sound.workerWaiters.get(msg.seq);
                if (!waiter) return;
                this.sound.workerWaiters.delete(msg.seq);
                waiter(msg);
            };
            worker.onerror = (event) => {
                this.trace?.(`sound: worker failed: ${event?.message || 'error'}`);
                // Воркер не работает (например, оболочка не дала создать его из blob:):
                // ждущие досчитываются синхронно — тем же выбранным звуком, не «Классикой».
                const waiters = [...this.sound.workerWaiters.values()];
                this.sound.workerWaiters.clear();
                try { worker.terminate(); } catch (e) {}
                this.sound.worker = null;
                for (const waiter of waiters) waiter({ ok: false, workerFailed: true });
            };
            this.sound.worker = worker;
        } catch (error) {
            this.trace?.(`sound: worker unavailable: ${error?.message || error}`);
            this.sound.worker = null;
        }
        return this.sound.worker;
    }

    // ── Локальный кеш отрендеренных звуков (IndexedDB) ───────────────────────
    // После первого рендера звук лежит на устройстве: следующий запуск берёт готовые
    // сэмплы за миллисекунды и не считает их заново. Версия — хеш исходника
    // синтезатора: правка звуков в коде сама делает старые записи чужими (их чистит
    // soundDb() при открытии). На диск идут только используемые звуки — выбранные
    // «сообщение» и «рингтон» и звуки голосового канала; прослушанные в настройках
    // не копятся (рингтон — несколько МБ сэмплов).
    soundCacheVersion() {
        if (this.sound.cacheVersion) return this.sound.cacheVersion;
        const src = window.ZaliSoundSynth?.workerSource?.() || '';
        let h = 5381;
        for (let i = 0; i < src.length; i++) h = ((h << 5) + h + src.charCodeAt(i)) | 0;
        this.sound.cacheVersion = `${(h >>> 0).toString(36)}-${src.length.toString(36)}`;
        return this.sound.cacheVersion;
    }

    soundCacheKey(kind, id, sampleRate) {
        return `${this.soundCacheVersion()}|${kind}:${id}:${sampleRate}`;
    }

    soundDb() {
        if (this.sound.dbPromise) return this.sound.dbPromise;
        this.sound.dbPromise = new Promise((resolve) => {
            try {
                if (typeof indexedDB === 'undefined') { resolve(null); return; }
                const req = indexedDB.open('zali_sound_cache_v1', 1);
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains('renders')) req.result.createObjectStore('renders');
                };
                req.onerror = () => resolve(null);
                req.onblocked = () => resolve(null);
                req.onsuccess = () => {
                    const db = req.result;
                    // Записи прошлых версий синтезатора — мусор.
                    try {
                        const version = this.soundCacheVersion();
                        const tx = db.transaction('renders', 'readwrite');
                        const store = tx.objectStore('renders');
                        const keysReq = store.getAllKeys();
                        keysReq.onsuccess = () => {
                            for (const key of keysReq.result || []) {
                                if (!String(key).startsWith(`${version}|`)) store.delete(key);
                            }
                        };
                    } catch (e) {}
                    resolve(db);
                };
            } catch (e) {
                resolve(null);
            }
        });
        return this.sound.dbPromise;
    }

    soundDbGet(kind, id, sampleRate) {
        return this.soundDb().then((db) => new Promise((resolve) => {
            if (!db) { resolve(null); return; }
            try {
                const req = db.transaction('renders', 'readonly').objectStore('renders').get(this.soundCacheKey(kind, id, sampleRate));
                req.onsuccess = () => {
                    const v = req.result;
                    resolve(v && v.left instanceof Float32Array && v.right instanceof Float32Array && v.sampleRate ? v : null);
                };
                req.onerror = () => resolve(null);
            } catch (e) {
                resolve(null);
            }
        }));
    }

    soundDbPut(kind, id, rendered) {
        if (kind !== 'voice' && id !== this.selectedSound(kind)) return;
        this.soundDb().then((db) => {
            if (!db || !rendered?.left || !rendered?.right) return;
            try {
                const store = db.transaction('renders', 'readwrite').objectStore('renders');
                const sr = rendered.sampleRate;
                store.put({ left: rendered.left, right: rendered.right, sampleRate: sr }, this.soundCacheKey(kind, id, sr));
                // Прежний выбор того же вида больше не нужен.
                if (kind !== 'voice') {
                    const prefix = `${this.soundCacheVersion()}|${kind}:`;
                    const keep = this.soundCacheKey(kind, id, sr);
                    const keysReq = store.getAllKeys();
                    keysReq.onsuccess = () => {
                        for (const key of keysReq.result || []) {
                            const k = String(key);
                            if (k.startsWith(prefix) && k !== keep) store.delete(key);
                        }
                    };
                }
            } catch (e) {}
        });
    }

    // Проиграть выбранный звук всегда — «Классика» здесь не подменяет его. Готов —
    // сразу; нет в памяти — когда дозреет (локальный кеш, иначе воркер: доли секунды).
    // maxDelayMs — для звуков-событий, которые после долгого ожидания уже не к месту.
    playSoundWhenReady(kind, id, { loop = false, maxDelayMs = 0 } = {}) {
        const ready = this.playSoundBuffer(kind, id, { loop });
        if (ready) return Promise.resolve(ready);
        const ctx = this.sound.ctx || this.ensureSoundContext?.();
        if (!ctx) return Promise.resolve(null);
        const asked = Date.now();
        return this.soundBufferAsync(kind, id, ctx).then((buffer) => {
            if (!buffer) return null;
            if (maxDelayMs && Date.now() - asked > maxDelayMs) return null;
            return this.playSoundBuffer(kind, id, { loop });
        });
    }

    // → Promise<AudioBuffer|null>. Один рендер на звук: повторный запрос того же
    // звука ждёт уже идущий.
    soundBufferAsync(kind, id, ctx) {
        if (!ctx || !window.ZaliSoundSynth) return Promise.resolve(null);
        const cached = this.soundBufferCached(kind, id, ctx);
        if (cached) return Promise.resolve(cached);
        const key = this.soundBufferKey(kind, id, ctx);
        const pending = this.sound.pendingRenders || (this.sound.pendingRenders = new Map());
        if (pending.has(key)) return pending.get(key);
        const worker = this.soundWorker();
        let promise;
        if (!worker) {
            promise = this.soundDbGet(kind, id, ctx.sampleRate)
                .then(saved => saved ? this.storeSoundBuffer(kind, id, ctx, saved) : this.soundBuffer(kind, id, ctx));
        } else {
            promise = this.soundDbGet(kind, id, ctx.sampleRate).then(saved => saved
                ? this.storeSoundBuffer(kind, id, ctx, saved)
                : new Promise((resolve) => {
                const seq = ++this.sound.workerSeq;
                this.sound.workerWaiters.set(seq, (msg) => {
                    if (msg.workerFailed) {
                        resolve(this.soundBuffer(kind, id, ctx));
                        return;
                    }
                    if (!msg.ok) {
                        if (msg.error) this.trace?.(`sound: render failed ${kind}/${id}: ${msg.error}`);
                        resolve(null);
                        return;
                    }
                    try {
                        resolve(this.storeSoundBuffer(kind, id, ctx, msg));
                        this.soundDbPut(kind, id, msg);
                    } catch (error) {
                        this.trace?.(`sound: buffer failed ${kind}/${id}: ${error?.message || error}`);
                        resolve(null);
                    }
                });
                worker.postMessage({ seq, kind, id, sampleRate: ctx.sampleRate });
            }));
        }
        promise = promise.finally(() => pending.delete(key));
        pending.set(key, promise);
        return promise;
    }

    // Выход для готовых буферов. Они уже сведены по громкости, поэтому идут мимо
    // компрессора «Классики» (тот поджимал бы их атаки и качал хвосты реверберации):
    // громкость → мягкий ограничитель → выход. Ограничитель линеен до 0,8 и работает
    // только при громкости уведомлений выше 100% — вместо жёсткого клиппинга на выходе.
    // Кривая описывает вход ±2, поэтому перед ней сигнал ослаблен вдвое (0.5 в gain).
    soundDirectBus(ctx) {
        this.soundBus(ctx);
        const bus = this.sound.bus;
        if (!bus.direct) {
            const gain = ctx.createGain();
            gain.gain.value = 0.5 * this.notificationVolumeFactor();
            const shaper = ctx.createWaveShaper();
            const points = 4097;
            const curve = new Float32Array(points);
            for (let i = 0; i < points; i++) {
                const v = (i / (points - 1) * 2 - 1) * 2;
                const a = Math.abs(v);
                const y = a <= 0.8 ? a : 0.8 + 0.2 * Math.tanh((a - 0.8) / 0.2);
                curve[i] = v < 0 ? -y : y;
            }
            shaper.curve = curve;
            gain.connect(shaper);
            shaper.connect(ctx.destination);
            bus.direct = gain;
            // Вход для уведомлений и рингтонов: то же в динамики плюс отвод в звук
            // демонстрации экрана (interface/share_audio.js, там же приглушение). Звуки
            // звонка (вход/выход, демонстрация) идут прямо в bus.direct — зрители сами
            // в звонке и слышат их у себя.
            bus.directShared = ctx.createGain();
            bus.directShared.connect(gain);
            // Та же громкость, что у bus.direct (ползунок уведомлений, applyNotificationVolume).
            bus.directTee = ctx.createGain();
            bus.directTee.gain.value = 0.5 * this.notificationVolumeFactor();
            bus.directShared.connect(bus.directTee);
            this.teeShareSound?.(ctx, bus.directTee);
        }
        return bus.direct;
    }

    soundDirectSharedBus(ctx) {
        this.soundDirectBus(ctx);
        return this.sound.bus.directShared || this.sound.bus.direct;
    }

    // → { src, gain, ctx } или null (нет Web Audio / не удалось отрендерить).
    playSoundBuffer(kind, id, { loop = false } = {}) {
        const ctx = this.ensureSoundContext();
        if (!ctx) return null;
        const buffer = this.soundBuffer(kind, id, ctx);
        if (!buffer) return null;
        try {
            const src = ctx.createBufferSource();
            src.buffer = buffer;
            src.loop = !!loop;
            const gain = ctx.createGain();
            const now = ctx.currentTime + 0.02;
            if (loop) {
                // Цикл начинается «с середины» бесконечного повтора — в его первых
                // сэмплах уже лежит хвост предыдущего оборота. Короткий вход это прячет:
                // линейный, 20 мс. Экспонента от 0.0001 первые миллисекунды почти молчит,
                // а потом выстреливает — слышно как щелчок с задержкой.
                gain.gain.setValueAtTime(0, now);
                gain.gain.linearRampToValueAtTime(1, now + 0.02);
            }
            src.connect(gain);
            gain.connect(kind === 'voice' ? this.soundDirectBus(ctx) : this.soundDirectSharedBus(ctx));
            src.onended = () => {
                try { src.disconnect(); gain.disconnect(); } catch (e) {}
            };
            src.start(now);
            return { src, gain, ctx };
        } catch (error) {
            this.trace?.(`sound: play failed ${kind}/${id}: ${error?.message || error}`);
            return null;
        }
    }

    // Остановка — быстрое, но плавное затухание: постоянная времени fade/4, к моменту
    // stop() громкость уже ниже −60 дБ. Обрыв посреди ноты щёлкает, а затухание дольше
    // ~150 мс воспринимается как «тянет».
    stopSoundHandle(handle, fadeSeconds = 0.12) {
        if (!handle) return;
        try {
            // Контекст ещё не разблокирован жестом: его часы стоят, источник только
            // «поставлен на старт». Плавное затухание тут не сработает — при первой же
            // разблокировке прозвучал бы обрывок давно сброшенного звонка. Снять сразу.
            if (handle.ctx.state !== 'running') {
                handle.src.onended = null;
                handle.src.stop();
                handle.src.disconnect();
                handle.gain.disconnect();
                return;
            }
            const now = handle.ctx.currentTime;
            handle.gain.gain.cancelScheduledValues(now);
            handle.gain.gain.setTargetAtTime(0, now, fadeSeconds / 4);
            handle.src.stop(now + fadeSeconds + 0.05);
        } catch (e) {}
    }

    // Новое сообщение. Имя оставлено прежним: это точка, которую зовёт
    // presentMessageNotification и подменяют харнессы scripts/*_doctor.
    playMessageChime() {
        // До первого жеста AudioContext стоит на паузе, а всё поставленное в него звучит
        // в момент разблокировки. Десять сообщений, пришедших в фоновую вкладку, давали
        // бы при первом клике десять сигналов разом — пропускаем один, остальные нет.
        const ctx = this.ensureSoundContext();
        if (!ctx) return;
        if (ctx.state !== 'running') {
            if (this.sound.heldChime) return;
            this.sound.heldChime = true;
        } else {
            this.sound.heldChime = false;
        }
        const id = this.selectedSound('message');
        if (id === 'classic') { this.playClassicMessageChime(); return; }
        // Всегда выбранный звук: не готов — проиграется, когда дозреет. «Классика» —
        // только если синтезатор не смог его посчитать вовсе (иначе тишина).
        this.playSoundWhenReady('message', id).then((handle) => {
            if (!handle && !this.soundBufferCached('message', id, this.sound.ctx)) this.playClassicMessageChime();
        });
    }

    // Рингтон входящего звонка — включается и выключается из одной точки,
    // renderVoicePanel(), по this.voice.status: так он следует за любым способом,
    // которым звонок перестаёт звонить (ответили, отклонили, пропущен, сбросили),
    // и его не нужно протягивать в каждое из этих мест.
    startRingtone() {
        if (this.sound.ringing) return;
        this.stopSoundPreview();
        const id = this.selectedSound('ring');
        const loop = id !== 'classic' ? this.playSoundBuffer('ring', id, { loop: true }) : null;
        if (loop) {
            this.sound.ringLoop = loop;
        } else if (id !== 'classic' && this.sound.ctx) {
            // Рингтон ещё не в памяти: звоним выбранным, как только буфер готов
            // (локальный кеш или воркер) — без фриза на рендер в момент звонка.
            // «Классика» — только если посчитать его не удалось вовсе.
            this.sound.ringing = true;
            const ctx = this.sound.ctx;
            this.soundBufferAsync('ring', id, ctx).then((buffer) => {
                if (!this.sound.ringing || this.sound.ringLoop || this.sound.ringTimer) return;
                const late = buffer ? this.playSoundBuffer('ring', id, { loop: true }) : null;
                if (late) this.sound.ringLoop = late;
                else this.startClassicRingtone();
            });
            return;
        } else if (!this.startClassicRingtone()) {
            return;
        }
        this.sound.ringing = true;
    }

    stopRingtone() {
        this.sound.ringing = false;
        if (this.sound.ringTimer) {
            clearInterval(this.sound.ringTimer);
            this.sound.ringTimer = null;
        }
        if (this.sound.ringLoop) {
            this.stopSoundHandle(this.sound.ringLoop);
            this.sound.ringLoop = null;
        }
    }

    // Выбранные звуки готовятся заранее, после первого жеста: из локального кеша
    // (IndexedDB) или рендером в воркере, чтобы в момент звонка или сообщения не
    // ждать и не считать. Без воркера рендер синхронный — тогда по одному звуку за
    // проход простоя, чтобы не подвешивать интерфейс одним длинным куском.
    scheduleSoundPrewarm() {
        if (this.sound.prewarmScheduled) return;
        this.sound.prewarmScheduled = true;
        const idle = (fn, timeout) => {
            if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout });
            else setTimeout(fn, Math.min(timeout, 1500));
        };
        const queue = [['message', this.selectedSound('message')], ['ring', this.selectedSound('ring')]];
        if (this.voiceSoundsEnabled()) {
            for (const sound of this.soundCatalog('voice')) queue.push(['voice', sound.id]);
        }
        const step = () => {
            const next = queue.shift();
            const ctx = this.sound.ctx;
            if (!next || !ctx || ctx.state === 'closed') {
                this.sound.prewarmScheduled = false;
                return;
            }
            const [kind, id] = next;
            if (id === 'classic') { step(); return; }
            // Звук берётся из локального кеша (IndexedDB) или считается в воркере —
            // главный поток тратит только копирование готовых сэмплов, поэтому идём
            // цепочкой без пауз на простой: чем раньше всё готово, тем реже звук ждёт.
            // Раньше soundBuffer() считал здесь же синхронно — 50+ мс на компьютере и в
            // разы больше на телефоне, длинная задача после первого касания (замер
            // 2026-11-15: 56 мс). Без воркера — как прежде, по звуку на простой.
            const next2 = () => (this.sound.worker ? step() : idle(step, 8000));
            this.soundBufferAsync(kind, id, ctx).then(next2, next2);
        };
        idle(step, 5000);
    }

    // ── Голосовой канал ───────────────────────────────────────────────────────

    voiceSoundsEnabled() {
        return this.audioPrefs?.voiceSounds !== false;
    }

    setVoiceSoundsEnabled(enabled) {
        if (!this.audioPrefs) return;
        this.audioPrefs.voiceSounds = !!enabled;
        this.saveAudioPrefs();
        this.renderSoundSettings();
    }

    // id: 'join' | 'leave' | 'stream' | 'stream-stop'. Тихо пропускает, если звук ещё не разблокирован жестом:
    // заход и демонстрация — события «сейчас», копить их до первого клика незачем.
    // Один и тот же звук не чаще раза в 0,6 с — участник с плохой сетью, который
    // выпадает и возвращается, не устраивает очередь из сигналов.
    playVoiceEventSound(id) {
        if (!this.sound || !this.voiceSoundsEnabled()) return false;
        const ctx = this.ensureSoundContext();
        if (!ctx || ctx.state !== 'running') {
            this.voiceTrace?.('ui-sound-skipped', { id, ctx: ctx?.state || 'none' });
            return false;
        }
        const last = this.sound.voiceEventAt || (this.sound.voiceEventAt = {});
        const now = Date.now();
        if (now - (last[id] || 0) < 600) return false;
        last[id] = now;
        // Сколько стоил звук в момент события: рендер, если буфер не был готов заранее,
        // и задержка вывода контекста — чтобы жалоба «звук опаздывает» читалась по журналу.
        const clock = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
        const started = clock();
        const cached = !!this.sound.buffers?.has?.(`voice:${id}:${ctx.sampleRate}`);
        const ok = !!this.playSoundBuffer('voice', id);
        // Не в памяти — дозреет из локального кеша или воркера; позже 1,5 с звук
        // события уже не к месту.
        if (!ok) {
            this.playSoundWhenReady('voice', id, { maxDelayMs: 1500 }).then((late) => {
                this.voiceTrace?.('ui-sound-late', { id, ok: !!late, ms: Math.round(clock() - started) });
            });
        }
        this.voiceTrace?.('ui-sound', {
            id, ok, cached,
            ms: Math.round(clock() - started),
            outputLatencyMs: Math.round(((ctx.outputLatency || 0) + (ctx.baseLatency || 0)) * 1000),
        });
        return ok || !!this.sound.worker;
    }

    // Свой заход в канал: звук — в момент клика (joinVoiceChannel), а не когда сервер
    // пришлёт состав. Ответ сервера с этим же заходом затем не звучит второй раз.
    noteVoiceRoomJoining(roomId) {
        if (!this.sound) return;
        this.sound.selfJoinRoom = roomId;
        this.playVoiceEventSound('join');
    }

    // Вызывается из обработчика voice_room_state ДО того, как новый состав записан в
    // this.voice. Звук — один на обновление, сколько бы человек ни добавилось: при
    // собственном заходе в канал приходит сразу весь состав. Только комнаты каналов
    // и только когда я сам в комнате; периодические повторы состояния (каждые 8 с,
    // после переподключения сокета) ничего не меняют в составе и молчат.
    // Выход другого участника — только в той же комнате: при переходе в другой канал
    // «пропавшие» люди из прошлой комнаты никуда не выходили. Заход важнее выхода:
    // если в одном обновлении один ушёл, а другой пришёл, звучит заход.
    noteVoiceRoomMembers({ roomId, roomType, participants }) {
        if (roomType !== 'channel') return;
        const me = String(this.myName?.() || '').trim();
        if (!me || !participants.includes(me)) return;
        const sameRoom = !!roomId && String(this.voice?.roomId || '') === roomId;
        const previous = sameRoom && Array.isArray(this.voice.participants) ? this.voice.participants : [];
        const before = new Set(previous);
        const now = new Set(participants);
        // Первый состав после своего захода — уже прозвучал по клику. Сравнение идёт
        // со своим именем: состав, где новые только другие, — чей-то заход, а не мой.
        const selfJoin = this.sound?.selfJoinRoom === roomId && !before.has(me);
        if (selfJoin) {
            this.sound.selfJoinRoom = '';
            return;
        }
        if (participants.some(name => !before.has(name))) {
            this.playVoiceEventSound('join');
        } else if (previous.some(name => !now.has(name))) {
            this.playVoiceEventSound('leave');
        }
    }

    // Свой выход из канала (кнопка, переход в другой канал, комната пропала на
    // сервере) — из leaveVoiceRoom, пока состояние комнаты ещё не сброшено.
    noteVoiceRoomLeft() {
        if (this.voice?.roomType !== 'channel' || !String(this.voice.roomId || '').trim()) return;
        const me = String(this.myName?.() || '').trim();
        const participants = Array.isArray(this.voice.participants) ? this.voice.participants : [];
        if (me && participants.includes(me)) this.playVoiceEventSound('leave');
    }

    // ── Настройки ─────────────────────────────────────────────────────────────

    // Прослушивание из настроек. Звук сообщения играет один раз; рингтон — цикл и
    // ещё пара секунд следующего оборота (слышно, как он замыкается), повторный клик
    // по играющему останавливает. Настоящий звонок прослушивание перебивает.
    previewSound(kind, id) {
        // Звук ещё не отрендерен — дождаться воркера и проиграть, если пользователь
        // не успел выбрать другой (без фриза на рендер по клику).
        const ctx = this.sound.ctx || this.ensureSoundContext?.();
        if (id !== 'classic' && ctx && this.soundWorker() && !this.soundBufferCached(kind, id, ctx)) {
            const token = this.sound.previewToken = (this.sound.previewToken || 0) + 1;
            this.soundBufferAsync(kind, id, ctx).then((buffer) => {
                if (buffer && this.sound.previewToken === token) this.previewSound(kind, id);
            });
            return;
        }
        this.sound.previewToken = (this.sound.previewToken || 0) + 1;
        const current = this.sound.preview;
        const same = !!current && current.kind === kind && current.id === id;
        this.stopSoundPreview();
        if (this.sound.ringing) return;
        if (kind === 'voice') {
            this.playSoundWhenReady('voice', id);
            return;
        }
        if (kind !== 'ring') {
            if (id === 'classic' || !this.playSoundBuffer('message', id)) this.playClassicMessageChime();
            return;
        }
        if (same) return;
        let handle = null;
        let seconds = 2.4;
        if (id === 'classic') {
            if (!this.playClassicRingPhrase()) return;
        } else {
            handle = this.playSoundBuffer('ring', id, { loop: true });
            if (!handle) return;
            seconds = handle.src.buffer.duration + 2.5;
        }
        this.sound.preview = {
            kind, id, handle,
            timer: setTimeout(() => this.stopSoundPreview(), seconds * 1000),
        };
        this.syncSoundPreviewState();
    }

    stopSoundPreview() {
        const preview = this.sound.preview;
        if (!preview) return;
        this.sound.preview = null;
        clearTimeout(preview.timer);
        this.stopSoundHandle(preview.handle, 0.15);
        this.syncSoundPreviewState();
    }

    syncSoundPreviewState() {
        const host = document.getElementById('soundSettings');
        if (!host?.querySelectorAll) return;
        const preview = this.sound.preview;
        host.querySelectorAll('.sound-option').forEach((button) => {
            const playing = !!preview
                && button.getAttribute('data-sound-kind') === preview.kind
                && button.getAttribute('data-sound-id') === preview.id;
            button.classList.toggle('is-playing', playing);
        });
    }

    renderSoundSettings() {
        const host = document.getElementById('soundSettings');
        if (!host) return;
        const group = (kind) => {
            const selected = kind === 'voice' ? '' : this.selectedSound(kind);
            const options = this.soundCatalog(kind).map((sound) => {
                const active = sound.id === selected;
                return `
                    <button type="button" class="sound-option${active ? ' active' : ''}" ${kind === 'voice' ? 'aria-label="Прослушать"' : `role="radio" aria-checked="${this.esc(String(active))}"`} data-sound-kind="${this.esc(kind)}" data-sound-id="${this.esc(sound.id)}">
                        <span class="sound-option-icon" aria-hidden="true">
                            <svg class="sound-icon-play" viewBox="0 0 16 16" width="12" height="12"><path d="M5.2 3.1v9.8L13 8z" fill="currentColor"/></svg>
                            <span class="sound-icon-bars"><i></i><i></i><i></i></span>
                        </span>
                        <span class="sound-option-copy">
                            <strong>${this.esc(sound.name)}</strong>
                            <small>${this.esc(sound.hint)}</small>
                        </span>
                    </button>`;
            }).join('');
            if (kind === 'voice') {
                const on = this.voiceSoundsEnabled();
                return `
                <div class="sound-group${on ? '' : ' is-off'}">
                    <span class="sound-group-title">Голосовой канал</span>
                    <label class="server-toggle settings-toggle sound-voice-toggle">
                        <input type="checkbox" data-voice-sounds${on ? ' checked' : ''}>
                        <span>
                            <strong>Звуки захода, выхода и демонстрации</strong>
                            <small>Когда кто-то заходит в канал, где вы сидите, выходит из него, включает или выключает демонстрацию экрана</small>
                        </span>
                    </label>
                    <div class="sound-options">${options}</div>
                </div>`;
            }
            const title = this.soundKindInfo(kind).title;
            return `
                <div class="sound-group">
                    <span class="sound-group-title">${this.esc(title)}</span>
                    <div class="sound-options" role="radiogroup" aria-label="${this.esc(title)}">${options}</div>
                </div>`;
        };
        this.setHTMLIfChanged(host, group('message') + group('ring') + group('voice'));
        this.syncSoundPreviewState();
        if (!host.dataset.bound) {
            host.dataset.bound = '1';
            host.addEventListener('click', (event) => {
                const button = event.target?.closest?.('[data-sound-id]');
                if (!button) return;
                const rawKind = button.getAttribute('data-sound-kind');
                const kind = rawKind === 'ring' || rawKind === 'voice' ? rawKind : 'message';
                const id = button.getAttribute('data-sound-id');
                if (kind !== 'voice') this.setSelectedSound(kind, id);
                this.previewSound(kind, id);
            });
            host.addEventListener('change', (event) => {
                const toggle = event.target?.closest?.('[data-voice-sounds]');
                if (toggle) this.setVoiceSoundsEnabled(toggle.checked);
            });
        }
    }
});
