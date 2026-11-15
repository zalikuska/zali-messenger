// --- ZaliInterface: счётчик FPS поверх интерфейса (Настройки → «Для разработчиков»). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Показывает то, что видит пользователь: частоту кадров за последние полсекунды,
// самый долгий кадр в этом окне и — чтобы фриз не терялся, пока на него смотрят, —
// счётчик подвисаний с момента включения (кадр дольше FREEZE_MS) с самым долгим из них.
// Долгие задачи главного потока (PerformanceObserver 'longtask', есть в Chromium/
// WebView2/Android WebView, нет в WebKit) добавляются отдельной строкой: они
// объясняют, ЧЕМ был занят поток, когда кадр пропал.
//
// Сам счётчик ничего не должен ронять: цикл rAF только пишет время кадра в
// массив, текст меняется дважды в секунду, плашка — `contain: strict` на своём
// слое, её перерисовка не трогает остальную страницу; касания она пропускает
// насквозь (лежит над кнопками шапки). Счётчики подвисаний обнуляет выключение и
// включение тумблера. Выключен — ни цикла, ни
// наблюдателя, ни элемента в документе. Настройка этого устройства: в синхронизацию
// настроек не входит (у телефона и компьютера разные причины включать её).
ZaliMixin(ZaliInterface, class {
    fpsMeterStorageKey() {
        return 'zali_fps_meter_v1';
    }

    loadFpsMeter() {
        try { return localStorage.getItem(this.fpsMeterStorageKey()) === '1'; } catch (e) { return false; }
    }

    saveFpsMeter(enabled) {
        this.fpsMeterOn = !!enabled;
        try { localStorage.setItem(this.fpsMeterStorageKey(), this.fpsMeterOn ? '1' : '0'); } catch (e) { /* без хранилища */ }
        this.applyFpsMeter();
    }

    applyFpsMeter() {
        if (typeof this.fpsMeterOn !== 'boolean') this.fpsMeterOn = this.loadFpsMeter();
        const toggle = document.getElementById('inputFpsMeter');
        if (toggle) toggle.checked = this.fpsMeterOn;
        if (this.fpsMeterOn) this.startFpsMeter();
        else this.stopFpsMeter();
    }

    startFpsMeter() {
        if (this._fpsMeter || !document.body) return;
        const FREEZE_MS = 100;
        const WINDOW_MS = 500;
        const el = document.createElement('div');
        el.className = 'fps-meter';
        el.setAttribute('aria-hidden', 'true');
        el.innerHTML = '<span class="fps-meter-head"><b class="fps-meter-value">—</b><span class="fps-meter-frame"></span></span>'
            + '<span class="fps-meter-line fps-meter-freeze"></span><span class="fps-meter-line fps-meter-tasks"></span>';
        document.body.appendChild(el);
        const valueEl = el.querySelector('.fps-meter-value');
        const frameEl = el.querySelector('.fps-meter-frame');
        const freezeEl = el.querySelector('.fps-meter-freeze');
        const tasksEl = el.querySelector('.fps-meter-tasks');
        const meter = {
            el, raf: 0, observer: null, onVisibility: null, last: 0, windowStart: 0, frames: 0, worst: 0,
            freezes: 0, worstFreeze: 0, longTasks: 0, worstTask: 0, lastFreeze: null, lastTasks: null,
        };
        const render = (now) => {
            const span = now - meter.windowStart;
            const fps = span > 0 ? Math.round(meter.frames * 1000 / span) : 0;
            valueEl.textContent = `${fps} fps`;
            frameEl.textContent = `${Math.round(meter.worst)} мс`;
            const freezeText = `фризы ${meter.freezes}${meter.freezes ? ` · макс ${Math.round(meter.worstFreeze)} мс` : ''}`;
            if (freezeText !== meter.lastFreeze) { meter.lastFreeze = freezeText; freezeEl.textContent = freezeText; }
            const tasksText = meter.observer
                ? `долгих задач ${meter.longTasks}${meter.longTasks ? ` · ${Math.round(meter.worstTask)} мс` : ''}`
                : '';
            if (tasksText !== meter.lastTasks) { meter.lastTasks = tasksText; tasksEl.textContent = tasksText; }
            el.dataset.level = fps >= 55 ? 'ok' : (fps >= 40 ? 'warn' : 'bad');
            meter.windowStart = now;
            meter.frames = 0;
            meter.worst = 0;
        };
        const tick = (now) => {
            meter.raf = requestAnimationFrame(tick);
            if (meter.last) {
                const dt = now - meter.last;
                if (dt > meter.worst) meter.worst = dt;
                if (dt > FREEZE_MS) {
                    meter.freezes += 1;
                    if (dt > meter.worstFreeze) meter.worstFreeze = dt;
                }
            } else {
                meter.windowStart = now;
            }
            meter.last = now;
            meter.frames += 1;
            if (now - meter.windowStart >= WINDOW_MS) render(now);
        };
        meter.raf = requestAnimationFrame(tick);
        // Скрытое приложение не рисует кадров вовсе — разрыв после возврата не фриз.
        meter.onVisibility = () => { meter.last = 0; meter.frames = 0; };
        document.addEventListener('visibilitychange', meter.onVisibility);
        try {
            if (typeof PerformanceObserver === 'function'
                && (PerformanceObserver.supportedEntryTypes || []).includes('longtask')) {
                meter.observer = new PerformanceObserver((list) => {
                    for (const entry of list.getEntries()) {
                        meter.longTasks += 1;
                        if (entry.duration > meter.worstTask) meter.worstTask = entry.duration;
                    }
                });
                meter.observer.observe({ type: 'longtask' });
            }
        } catch (e) { meter.observer = null; }
        this._fpsMeter = meter;
    }

    stopFpsMeter() {
        const meter = this._fpsMeter;
        if (!meter) return;
        this._fpsMeter = null;
        if (meter.raf) cancelAnimationFrame(meter.raf);
        try { meter.observer?.disconnect(); } catch (e) { /* уже отключён */ }
        document.removeEventListener('visibilitychange', meter.onVisibility);
        meter.el.remove();
    }
});
