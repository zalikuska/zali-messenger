// --- ZaliInterface: попап состояния соединения (клик по точке #wsPill в титлбаре). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Точка в титлбаре больше не «раскрывается» по наведению — подробности открываются
// по клику попапом вниз: статус соединения, пинг до сервера и скорость.
//  - СТАТУС: `S.wsOn` (setConnectionStatus) и, в звонке, число живых WebRTC-линков.
//  - ПИНГ: время ответа дешёвого GET через apiFetch — то есть тем же путём, каким
//    ходит всё приложение (в нативных шеллах — через мост, а не голым fetch), поэтому
//    цифра честная для любой платформы. Сервер отдельного ping-эндпоинта не имеет.
//  - СКОРОСТЬ: прирост байтов nominated-пары ICE по всем пирам звонка (getStats).
//    Вне звонка передачи, которую можно измерить, нет — показываем прочерк, а не
//    выдуманную цифру.
// Поля попапа обновляются на месте (textContent), разметка не пересобирается —
// иначе значения мигали бы каждую секунду.
ZaliMixin(ZaliInterface, class {
    bindConnectionInfoEvents() {
        const pill = document.getElementById('wsPill');
        if (!pill) return;
        pill.setAttribute('role', 'button');
        pill.setAttribute('aria-haspopup', 'true');
        pill.tabIndex = 0;
        pill.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleConnectionInfo();
        });
        pill.addEventListener('keydown', (e) => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            this.toggleConnectionInfo();
        });
    }

    toggleConnectionInfo() {
        if (document.getElementById('connInfoMenu')) this.closeConnectionInfo();
        else this.openConnectionInfo();
    }

    openConnectionInfo() {
        const pill = document.getElementById('wsPill');
        if (!pill) return;
        this.closeConnectionInfo();
        const menu = document.createElement('div');
        menu.id = 'connInfoMenu';
        menu.className = 'peer-context-menu conn-info-menu';
        menu.setAttribute('role', 'dialog');
        menu.setAttribute('aria-label', 'Состояние соединения');
        menu.innerHTML = `
            <div class="conn-info-title">Соединение</div>
            <div class="conn-info-row"><span>Статус</span><strong id="connInfoStatus"></strong></div>
            <div class="conn-info-row" id="connInfoCallRow" hidden><span>Звонок</span><strong id="connInfoCall"></strong></div>
            <div class="conn-info-row"><span>Пинг</span><strong id="connInfoPing"></strong></div>
            <div class="conn-info-row"><span>Скорость</span><strong id="connInfoSpeed"></strong></div>
        `;
        document.body.appendChild(menu);
        // Под точкой, прижато к её краю, ближнему к краю окна (на Windows точка
        // переезжает налево, на macOS живёт справа).
        const rect = pill.getBoundingClientRect();
        const pad = 8;
        const width = menu.offsetWidth;
        const alignRight = rect.left + rect.width / 2 > window.innerWidth / 2;
        const left = alignRight ? rect.right - width : rect.left;
        menu.style.left = `${Math.max(pad, Math.min(left, window.innerWidth - width - pad))}px`;
        menu.style.top = `${Math.round(rect.bottom + 6)}px`;
        menu.style.setProperty('--menu-origin', `top ${alignRight ? 'right' : 'left'}`);

        this._connInfoOutside = (e) => {
            if (e.target.closest?.('#connInfoMenu') || e.target.closest?.('#wsPill')) return;
            this.closeConnectionInfo();
        };
        this._connInfoKey = (e) => {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            this.closeConnectionInfo();
        };
        document.addEventListener('mousedown', this._connInfoOutside, true);
        document.addEventListener('keydown', this._connInfoKey, true);
        window.addEventListener('blur', this._connInfoOutside);

        this._connPingMs = this._connPingMs ?? null;
        this._connSpeed = null;
        this._connSpeedPrev = null;
        this.refreshConnectionInfo();
        void this.probeConnectionPing();
        void this.sampleConnectionSpeed();
        this._connInfoSpeedTimer = setInterval(() => { void this.sampleConnectionSpeed(); }, 1000);
        this._connInfoPingTimer = setInterval(() => { void this.probeConnectionPing(); }, 5000);
        pill.setAttribute('aria-expanded', 'true');
    }

    closeConnectionInfo() {
        document.getElementById('connInfoMenu')?.remove();
        document.getElementById('wsPill')?.removeAttribute('aria-expanded');
        if (this._connInfoOutside) {
            document.removeEventListener('mousedown', this._connInfoOutside, true);
            window.removeEventListener('blur', this._connInfoOutside);
            this._connInfoOutside = null;
        }
        if (this._connInfoKey) {
            document.removeEventListener('keydown', this._connInfoKey, true);
            this._connInfoKey = null;
        }
        if (this._connInfoSpeedTimer) { clearInterval(this._connInfoSpeedTimer); this._connInfoSpeedTimer = null; }
        if (this._connInfoPingTimer) { clearInterval(this._connInfoPingTimer); this._connInfoPingTimer = null; }
    }

    // Пока попап не открыт — ничего не делает; зовётся и из setConnectionStatus.
    refreshConnectionInfo() {
        if (!document.getElementById('connInfoMenu')) return;
        const set = (id, text, tone = '') => {
            const el = document.getElementById(id);
            if (!el) return;
            if (el.textContent !== text) el.textContent = text;
            if ((el.dataset.tone || '') !== tone) {
                if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
            }
        };
        const on = !!this.S.wsOn;
        set('connInfoStatus', on ? 'Подключено' : 'Переподключение…', on ? 'good' : 'bad');

        const pcs = this.voice?.peerConnections;
        const callRow = document.getElementById('connInfoCallRow');
        if (callRow) callRow.hidden = !(pcs && pcs.size);
        if (pcs && pcs.size) {
            let up = 0;
            for (const entry of pcs.values()) if (entry?.pc?.connectionState === 'connected') up++;
            set('connInfoCall', `${up} из ${pcs.size}`, up === pcs.size ? 'good' : up ? 'warn' : 'bad');
        }

        const ping = this._connPingMs;
        if (typeof ping === 'number') {
            set('connInfoPing', `${ping} мс`, ping < 120 ? 'good' : ping < 300 ? 'warn' : 'bad');
        } else {
            // «…» только пока первый замер в пути; провалившийся — «нет ответа».
            set('connInfoPing', this._connPingFailed ? 'нет ответа' : on ? '…' : 'нет связи', this._connPingFailed || !on ? 'bad' : '');
        }

        const speed = this._connSpeed;
        if (speed) {
            set('connInfoSpeed', `↓ ${this.formatConnRate(speed.down)} · ↑ ${this.formatConnRate(speed.up)}`);
        } else {
            set('connInfoSpeed', pcs && pcs.size ? '…' : 'виден в звонке');
        }
    }

    formatConnRate(bytesPerSec) {
        const bits = Math.max(0, Number(bytesPerSec) || 0) * 8;
        if (bits >= 1e6) return `${(bits / 1e6).toFixed(1).replace('.', ',')} Мбит/с`;
        return `${Math.round(bits / 1e3)} кбит/с`;
    }

    async probeConnectionPing() {
        if (this._connPingBusy || !document.getElementById('connInfoMenu')) return;
        this._connPingBusy = true;
        const startedAt = performance.now();
        try {
            const res = await this.apiFetch('/api/version?platform=macos&channels=r,b,a', { timeoutMs: 6000 });
            // Любой ответ сервера — это замер; 5xx значит, что отвечал не он.
            this._connPingMs = res && res.status < 500 ? Math.round(performance.now() - startedAt) : null;
            this._connPingFailed = this._connPingMs === null;
            try { await res.arrayBuffer?.(); } catch (e) {}
        } catch (e) {
            this._connPingMs = null;
            this._connPingFailed = true;
        } finally {
            this._connPingBusy = false;
        }
        this.refreshConnectionInfo();
    }

    async sampleConnectionSpeed() {
        const pcs = this.voice?.peerConnections;
        if (!pcs || !pcs.size) {
            this._connSpeed = null;
            this._connSpeedPrev = null;
            this.refreshConnectionInfo();
            return;
        }
        let sent = 0;
        let received = 0;
        let seen = false;
        for (const entry of pcs.values()) {
            if (!entry?.pc) continue;
            try {
                const stats = await entry.pc.getStats();
                stats.forEach((report) => {
                    if (report.type === 'candidate-pair' && report.state === 'succeeded' && report.nominated) {
                        sent += Number(report.bytesSent) || 0;
                        received += Number(report.bytesReceived) || 0;
                        seen = true;
                    }
                });
            } catch (e) {}
        }
        const now = performance.now();
        const prev = this._connSpeedPrev;
        this._connSpeedPrev = { sent, received, now };
        if (!seen || !prev || now <= prev.now) {
            this._connSpeed = null;
        } else {
            const seconds = (now - prev.now) / 1000;
            this._connSpeed = {
                up: Math.max(0, sent - prev.sent) / seconds,
                down: Math.max(0, received - prev.received) / seconds,
            };
        }
        this.refreshConnectionInfo();
    }
});
