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
ZaliMixin(ZaliInterface, class {

    soundKindInfo(kind) {
        return kind === 'ring'
            ? { pref: 'ringtone', fallback: 'gruv', title: 'Рингтон звонка' }
            : { pref: 'messageSound', fallback: 'gruv', title: 'Звук сообщения' };
    }

    soundCatalog(kind) {
        const synth = window.ZaliSoundSynth;
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
    soundBuffer(kind, id, ctx) {
        const synth = window.ZaliSoundSynth;
        if (!synth || !ctx) return null;
        const cache = this.sound.buffers || (this.sound.buffers = new Map());
        const key = `${kind}:${id}:${ctx.sampleRate}`;
        const cached = cache.get(key);
        if (cached) return cached;
        try {
            const rendered = synth.render(kind, id, ctx.sampleRate);
            if (!rendered) return null;
            const buffer = ctx.createBuffer(2, rendered.left.length, rendered.sampleRate);
            buffer.getChannelData(0).set(rendered.left);
            buffer.getChannelData(1).set(rendered.right);
            if (kind === 'ring') {
                const keep = `ring:${this.selectedSound('ring')}:`;
                for (const other of [...cache.keys()]) {
                    if (other.startsWith('ring:') && !other.startsWith(keep)) cache.delete(other);
                }
            }
            cache.set(key, buffer);
            return buffer;
        } catch (error) {
            this.trace?.(`sound: render failed ${kind}/${id}: ${error?.message || error}`);
            return null;
        }
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
        }
        return bus.direct;
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
                // сэмплах уже лежит хвост предыдущего оборота. Короткий вход это прячет.
                gain.gain.setValueAtTime(0.0001, now);
                gain.gain.exponentialRampToValueAtTime(1, now + 0.03);
            }
            src.connect(gain);
            gain.connect(this.soundDirectBus(ctx));
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
        if (id !== 'classic' && this.playSoundBuffer('message', id)) return;
        this.playClassicMessageChime();
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

    // Выбранные звуки рендерятся заранее, в простое после первого жеста: рингтон —
    // до 0,1 с счёта на компьютере и в разы дольше на слабом телефоне, тратить их в
    // момент звонка незачем. По одному звуку за проход простоя, чтобы не подвешивать
    // интерфейс одним длинным куском сразу после первого касания.
    scheduleSoundPrewarm() {
        if (this.sound.prewarmScheduled) return;
        this.sound.prewarmScheduled = true;
        const idle = (fn, timeout) => {
            if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(fn, { timeout });
            else setTimeout(fn, Math.min(timeout, 1500));
        };
        const queue = ['message', 'ring'];
        const step = () => {
            const kind = queue.shift();
            const ctx = this.sound.ctx;
            if (!kind || !ctx || ctx.state === 'closed') {
                this.sound.prewarmScheduled = false;
                return;
            }
            const id = this.selectedSound(kind);
            if (id !== 'classic') this.soundBuffer(kind, id, ctx);
            idle(step, 8000);
        };
        idle(step, 5000);
    }

    // ── Настройки ─────────────────────────────────────────────────────────────

    // Прослушивание из настроек. Звук сообщения играет один раз; рингтон — цикл и
    // ещё пара секунд следующего оборота (слышно, как он замыкается), повторный клик
    // по играющему останавливает. Настоящий звонок прослушивание перебивает.
    previewSound(kind, id) {
        const current = this.sound.preview;
        const same = !!current && current.kind === kind && current.id === id;
        this.stopSoundPreview();
        if (this.sound.ringing) return;
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
        this.stopSoundHandle(preview.handle, 0.4);
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
            const selected = this.selectedSound(kind);
            const options = this.soundCatalog(kind).map((sound) => {
                const active = sound.id === selected;
                return `
                    <button type="button" class="sound-option${active ? ' active' : ''}" role="radio" aria-checked="${this.esc(String(active))}" data-sound-kind="${this.esc(kind)}" data-sound-id="${this.esc(sound.id)}">
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
            const title = this.soundKindInfo(kind).title;
            return `
                <div class="sound-group">
                    <span class="sound-group-title">${this.esc(title)}</span>
                    <div class="sound-options" role="radiogroup" aria-label="${this.esc(title)}">${options}</div>
                </div>`;
        };
        this.setHTMLIfChanged(host, group('message') + group('ring'));
        this.syncSoundPreviewState();
        if (!host.dataset.bound) {
            host.dataset.bound = '1';
            host.addEventListener('click', (event) => {
                const button = event.target?.closest?.('[data-sound-id]');
                if (!button) return;
                const kind = button.getAttribute('data-sound-kind') === 'ring' ? 'ring' : 'message';
                const id = button.getAttribute('data-sound-id');
                this.setSelectedSound(kind, id);
                this.previewSound(kind, id);
            });
        }
    }
});
