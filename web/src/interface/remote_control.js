// --- ZaliInterface: удалённое управление своим компьютером — отдаёт сам показывающий. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Работает поверх демонстрации экрана в звонке, как AnyDesk/TeamViewer, но управление
// не просят — его отдаёт сам тот, кто показывает экран, кнопкой на своей демонстрации:
//
//   показывающий                           сервер (voice_signal)          зритель
//   «Отдать управление» на «Ваш экран» →
//   выбор участника → MEDIA_REQUEST rc_grant →
//   НАТИВНЫЙ диалог оболочки («Отдать») ──rc-grant─────────────────────▶ «X отдал вам
//                                                                         управление»
//   MEDIA_REQUEST rc_input → CGEvent /   ◀──RTCDataChannel 'zali-rc'──── мышь/клавиатура над
//   SendInput                              (пока канал не открыт —         развёрнутым экраном X
//                                           rc-input через сервер, мышь)
//   «Забрать управление», плашка         ──rc-revoke────────────────────▶
//   «Остановить», конец демонстрации/звонка
//                                        ◀──rc-release──────────────────  «Вернуть управление»,
//                                                                          компонент выключен
//
// Инварианты:
//   • Разрешение действует, пока идёт ЭТА демонстрация всего экрана: оболочка привязывает
//     его к живому потоку захвата и снимает, когда поток кончился, страница
//     перезагрузилась или страница отозвала. Конец звонка гасит демонстрацию — и его.
//   • Подтверждает ОБОЛОЧКА своим диалогом, даже после клика на странице: скомпрометированный
//     JS не может выдать управление сам, а случайный клик не отдаёт компьютер.
//   • Управление — одному участнику за раз; выдача другому сначала забирает у прежнего.
//   • Показывающий принимает ввод только от того, кому отдал: `from` у сигнала проставляет
//     сервер, канал данных — от RTCPeerConnection этого же пира.
//   • Клавиши — только по RTCDataChannel (DTLS между участниками). Через сервер (rc-input
//     в voice_signal) ходит лишь мышь, пока канал не открылся: иначе всё, что зритель
//     печатает у собеседника (включая пароли), видел бы оператор сервера — а сервер может
//     быть чужим («Свой сервер»). Показывающий клавиши через сервер не принимает.
//   • Компонент выключен по умолчанию: «Настройки → Компоненты → Удалённое управление»
//     (zali_component_remote_control_v1, только на этом устройстве — в облако настроек
//     не уходит). Выключен у показывающего — нет кнопки «Отдать управление»; у зрителя —
//     выданное право сразу возвращается (rc-release, reason 'disabled'). Выключение посреди
//     сеанса обрывает его в обе стороны.
//   • Отдать управление умеют оболочки с `nativeRemoteControl` (macOS, Windows) при
//     нативной демонстрации всего экрана; управлять — любой клиент, это чистый веб.
//   • Координаты — доли кадра [0..1]; оболочка переводит их в точки своего монитора.
//     Клавиши — KeyboardEvent.code (физическая клавиша), раскладка — у показывающего.
ZaliMixin(ZaliInterface, class {

    // Нативный диалог сам закрывается через 100 с; страница ждёт чуть дольше.
    static get RC_GRANT_TIMEOUT_MS() { return 110000; }
    static get RC_RELAY_MOVE_INTERVAL_MS() { return 100; }
    static get RC_COMPONENT_KEY() { return 'zali_component_remote_control_v1'; }

    // ------------------------------------------------------------- компонент

    remoteControlComponentEnabled() {
        try { return localStorage.getItem(ZaliInterface.RC_COMPONENT_KEY) === '1'; } catch (e) { return false; }
    }

    setRemoteControlComponentEnabled(enabled) {
        const on = !!enabled;
        try {
            if (on) localStorage.setItem(ZaliInterface.RC_COMPONENT_KEY, '1');
            else localStorage.removeItem(ZaliInterface.RC_COMPONENT_KEY);
        } catch (e) {}
        if (!on) {
            const rc = this.rcState();
            if (rc.host) this.revokeRemoteControlHost('component-off');
            if (rc.view) this.endRemoteControlView('component-off', { notifyPeer: true, reason: 'disabled' });
        }
        this.voiceTrace?.('rc-component', { enabled: on });
        this.syncRemoteControlSettings();
        this.syncRemoteControlUi();
    }

    bindRemoteControlSettings() {
        const input = document.getElementById('inputRemoteControlComponent');
        if (!input || input.dataset.rcBound) return;
        input.dataset.rcBound = '1';
        input.addEventListener('change', () => this.setRemoteControlComponentEnabled(input.checked));
        this.syncRemoteControlSettings();
    }

    syncRemoteControlSettings() {
        const input = document.getElementById('inputRemoteControlComponent');
        if (input) input.checked = this.remoteControlComponentEnabled();
        const note = document.getElementById('remoteControlComponentNote');
        if (note) {
            const host = this.nativeSupports('nativeRemoteControl');
            const text = host
                ? 'Кнопка «Отдать управление» появляется на вашей демонстрации всего экрана.'
                    + (window.__ZALI_NATIVE_PLATFORM === 'macos' ? ' macOS попросит разрешить ZaliMessenger в «Универсальном доступе».' : '')
                : 'На этом устройстве можно только управлять чужим экраном, когда вам его отдали, — отдавать своё управление умеют приложения для macOS и Windows.';
            if (note.textContent !== text) note.textContent = text;
        }
    }

    rcState() {
        if (!this._rc) {
            this._rc = {
                view: null,            // мы управляем: { peer, since, pressedKeys, pressedButtons, channel… }
                host: null,            // нами управляют: { peer, stream, since }
                pending: '',           // кому отдаём — ждём нативного подтверждения
                channels: new Map(),   // peer → входящий RTCDataChannel 'zali-rc'
                keyHook: null,
            };
        }
        return this._rc;
    }

    // ---------------------------------------------------------------- общее

    rcNotice(type, msg) {
        this.addLogEntry?.({ type, msg, ts: new Date().toLocaleTimeString() });
    }

    /** Точка входа из handleVoiceSignal: все сигналы `rc-*`. */
    handleRemoteControlSignal(from, signal = {}) {
        const peer = String(from || '').trim();
        if (!peer) return;
        switch (signal.type) {
            case 'rc-grant': this.onRemoteControlGranted(peer); break;
            case 'rc-revoke': this.onRemoteControlRevoked(peer); break;
            case 'rc-release': this.onRemoteControlReleased(peer, String(signal.reason || '')); break;
            case 'rc-input': this.applyRemoteControlInput(peer, signal.e, 'relay'); break;
            default: break;
        }
    }

    /** closeVoicePeer: соединение с пиром закрыто (ушёл или пересоздаётся). */
    onRemoteControlPeerClosed(peer) {
        const rc = this.rcState();
        const name = String(peer || '').trim();
        try { rc.channels.get(name)?.close(); } catch (e) {}
        rc.channels.delete(name);
        this.onSharedBrowserPeerClosed?.(name);
        if (rc.host?.peer === name) this.revokeRemoteControlHost('peer-closed', { notifyPeer: false });
        if (rc.view?.peer === name) {
            // Канал жил на закрытом RTCPeerConnection; новый создастся на новом при
            // следующем вводе. Само право остаётся, пока показывающий его не забрал.
            rc.view.channel = null;
            rc.view.channelPc = null;
            rc.view.channelFailed = false;
        }
    }

    /** Конец звонка (resetVoiceState): всё сбросить без сигналов — комнаты уже нет. */
    resetRemoteControl(reason = 'call-end') {
        const rc = this.rcState();
        if (rc.host) this.revokeRemoteControlHost(reason, { notifyPeer: false });
        if (rc.view) this.endRemoteControlView(reason, { notifyPeer: false });
        for (const ch of rc.channels.values()) { try { ch.close(); } catch (e) {} }
        rc.channels.clear();
        rc.pending = '';
        this.closeRemoteControlPicker();
        this.syncRemoteControlUi();
    }

    /** pc.ondatachannel любого пира звонка. */
    onVoiceDataChannel(peer, channel) {
        // 'zali-sb' — ввод и курсоры «Общего браузера» (shared_browser.js).
        if (channel?.label === 'zali-sb') return this.onSharedBrowserDataChannel?.(peer, channel);
        if (!channel || channel.label !== 'zali-rc') return;
        const rc = this.rcState();
        const name = String(peer || '').trim();
        try { rc.channels.get(name)?.close(); } catch (e) {}
        rc.channels.set(name, channel);
        channel.onmessage = (event) => {
            if (typeof event.data !== 'string' || event.data.length > 512) return;
            let input = null;
            try { input = JSON.parse(event.data); } catch (e) { return; }
            this.applyRemoteControlInput(name, input, 'channel');
        };
        channel.onclose = () => {
            if (rc.channels.get(name) === channel) rc.channels.delete(name);
        };
        this.voiceTrace('rc-channel-incoming', { peer: name });
    }

    // ------------------------------------------------- показывающий (отдаём управление)

    /** Можно ли сейчас отдать управление: компонент, оболочка, нативный показ всего экрана. */
    remoteControlHostAvailable() {
        return !!(this.remoteControlComponentEnabled()
            && this.voice?.screenSharing
            && this.voice.screenNativeStream
            && this.voice.screenIsDisplay
            && this.nativeSupports('nativeRemoteControl'));
    }

    /** Кому можно отдать: участники звонка, с кем есть соединение. */
    remoteControlCandidates() {
        return Array.from(this.voice?.peerConnections?.keys?.() || []).filter(Boolean);
    }

    async grantRemoteControl(peer) {
        const rc = this.rcState();
        const name = String(peer || '').trim();
        if (!name || rc.pending || rc.host?.peer === name) return;
        if (!this.remoteControlHostAvailable() || !this.voice.peerConnections?.has(name)) return;
        const stream = this.voice.screenNativeStream;
        // Оболочка держит одно разрешение: прежнему управляющему — забрать до диалога.
        if (rc.host) this.revokeRemoteControlHost('switched');
        rc.pending = name;
        this.voiceTrace('rc-grant-ask', { peer: name, stream });
        this.syncRemoteControlUi();
        try {
            // Ответ приходит после решения пользователя в нативном диалоге.
            await this.nativeMediaRequest('rc_grant', { stream, options: { peer: name } }, ZaliInterface.RC_GRANT_TIMEOUT_MS);
        } catch (error) {
            const code = error?.code || '';
            this.voiceTrace('rc-grant-failed', { peer: name, code, error: error?.message || String(error) }, code === 'denied' ? 'INFO' : 'WARN');
            if (code === 'permission') this.rcNotice('WARN', error?.message || 'Нет системного разрешения на управление компьютером');
            else if (code !== 'denied') this.rcNotice('WARN', `Не удалось отдать управление: ${error?.message || code || 'ошибка'}`);
            return;
        } finally {
            rc.pending = '';
            this.syncRemoteControlUi();
        }
        // Пока висел диалог, демонстрация могла кончиться или человек — уйти.
        if (!this.remoteControlHostAvailable() || this.voice.screenNativeStream !== stream || !this.voice.peerConnections?.has(name)) {
            this.postNativeMessage({ type: NativeMessageTypes.MEDIA_REQUEST, op: 'rc_revoke', stream });
            return;
        }
        rc.host = { peer: name, stream, since: Date.now() };
        this.sendVoicePeerSignal(name, { type: 'rc-grant' });
        this.voiceTrace('rc-granted', { peer: name, stream });
        this.rcNotice('INFO', `Вы отдали управление компьютером: ${name}`);
        this.syncRemoteControlUi();
    }

    /** Управляющий вернул право сам (или у него выключен компонент). */
    onRemoteControlReleased(peer, reason) {
        if (this.rcState().host?.peer !== peer) return;
        this.revokeRemoteControlHost('released', { notifyPeer: false });
        this.rcNotice('INFO', reason === 'disabled'
            ? `У ${peer} выключен компонент «Удалённое управление» — управление не передано`
            : `${peer} вернул управление`);
    }

    applyRemoteControlInput(peer, raw, via) {
        const host = this.rcState().host;
        if (!host || host.peer !== peer || !raw || typeof raw !== 'object') return;
        if (!this.remoteControlComponentEnabled()) return;
        const input = this.sanitizeRemoteControlInput(raw);
        if (!input) return;
        // Клавиши — только из канала данных (см. шапку файла).
        if (via === 'relay' && input.t === 'key') return;
        host.events = (host.events || 0) + 1;
        if (via === 'relay') host.relayed = (host.relayed || 0) + 1;
        this.postNativeMessage({ type: NativeMessageTypes.MEDIA_REQUEST, op: 'rc_input', stream: host.stream, options: input });
    }

    /** Только известные поля и допустимые значения — дальше это уходит в инъекцию ввода. */
    sanitizeRemoteControlInput(raw) {
        const unit = (v) => {
            const n = Number(v);
            return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : null;
        };
        switch (raw.t) {
            case 'move': {
                const x = unit(raw.x), y = unit(raw.y);
                return x === null || y === null ? null : { t: 'move', x, y };
            }
            case 'down':
            case 'up': {
                const x = unit(raw.x), y = unit(raw.y);
                const b = Number(raw.b);
                if (x === null || y === null || ![0, 1, 2].includes(b)) return null;
                return { t: raw.t, x, y, b };
            }
            case 'wheel': {
                const clamp = (v) => {
                    const n = Number(v);
                    return Number.isFinite(n) ? Math.max(-2000, Math.min(2000, Math.round(n))) : 0;
                };
                const dx = clamp(raw.dx), dy = clamp(raw.dy);
                return dx || dy ? { t: 'wheel', dx, dy } : null;
            }
            case 'key': {
                const code = String(raw.code || '');
                if (!/^[A-Za-z0-9]{1,24}$/.test(code)) return null;
                return { t: 'key', code, d: raw.d ? 1 : 0 };
            }
            case 'release':
                return { t: 'release' };
            default:
                return null;
        }
    }

    revokeRemoteControlHost(reason = 'stopped', { notifyPeer = true } = {}) {
        const rc = this.rcState();
        const host = rc.host;
        if (!host) return;
        rc.host = null;
        this.postNativeMessage({ type: NativeMessageTypes.MEDIA_REQUEST, op: 'rc_revoke', stream: host.stream });
        if (notifyPeer) this.sendVoicePeerSignal(host.peer, { type: 'rc-revoke', reason });
        try { rc.channels.get(host.peer)?.close(); } catch (e) {}
        rc.channels.delete(host.peer);
        this.voiceTrace('rc-revoked', {
            peer: host.peer,
            reason,
            seconds: Math.round((Date.now() - host.since) / 1000),
            events: host.events || 0,
            relayed: host.relayed || 0,
        });
        if (reason !== 'released') this.rcNotice('INFO', `Управление компьютером забрано у ${host.peer}`);
        this.syncRemoteControlUi();
    }

    /** media_event 'rc_revoked' — оболочка сама сняла разрешение (поток кончился). */
    onNativeRemoteControlRevoked(payload = {}) {
        const host = this.rcState().host;
        if (!host || Number(payload.stream) !== Number(host.stream)) return;
        this.revokeRemoteControlHost(String(payload.reason || 'native'), { notifyPeer: true });
    }

    // ---------------------------------------------------------- зритель (управляем мы)

    remoteControlViewFor(peer) {
        const view = this.rcState().view;
        return view && view.peer === peer ? view : null;
    }

    onRemoteControlGranted(peer) {
        const rc = this.rcState();
        if (!this.remoteControlComponentEnabled()) {
            // Компонент выключен: право не принимаем и сообщаем почему.
            this.sendVoicePeerSignal(peer, { type: 'rc-release', reason: 'disabled' });
            return;
        }
        if (rc.view?.peer === peer) return;
        // Управление отдаёт только тот, чей экран мы сейчас видим. Сервер ретранслирует
        // любой `rc-*` от любого участника звонка, и без этой проверки участник без
        // демонстрации «отдавал управление», а клавиши зрителя уходили ему (аудит
        // 2026-11-18).
        if (!this.voice?.remoteScreens?.has?.(peer)) {
            this.voiceTrace('rc-grant-ignored', { peer, reason: 'no-screen' }, 'WARN');
            this.sendVoicePeerSignal(peer, { type: 'rc-release', reason: 'no-screen' });
            return;
        }
        if (rc.view) this.endRemoteControlView('switched', { notifyPeer: true });
        rc.view = { peer, since: Date.now(), pressedKeys: new Set(), pressedButtons: new Set() };
        this.ensureRemoteControlChannel();
        this.voiceTrace('rc-active', { peer });
        this.rcNotice('INFO', `${peer} отдал вам управление своим компьютером — разверните его экран, чтобы управлять`);
        this.playVoiceEventSound?.('stream');
        this.syncRemoteControlUi();
    }

    onRemoteControlRevoked(peer) {
        if (!this.remoteControlViewFor(peer)) return;
        this.endRemoteControlView('revoked', { notifyPeer: false });
        this.rcNotice('INFO', `${peer} забрал управление`);
    }

    endRemoteControlView(why, { notifyPeer = true, reason = 'returned' } = {}) {
        const rc = this.rcState();
        const view = rc.view;
        if (!view) return;
        this.releaseRemoteControlInputs(view);
        if (notifyPeer) this.sendVoicePeerSignal(view.peer, { type: 'rc-release', reason });
        try { view.channel?.close(); } catch (e) {}
        if (view.frame) cancelAnimationFrame(view.frame);
        rc.view = null;
        this.voiceTrace('rc-view-end', { peer: view.peer, why });
        this.syncRemoteControlUi();
    }

    /** «Вернуть управление». */
    stopRemoteControlView() {
        this.endRemoteControlView('user', { notifyPeer: true });
    }

    /** Канал данных к показывающему на текущем RTCPeerConnection (создаётся один раз). */
    ensureRemoteControlChannel() {
        const view = this.rcState().view;
        if (!view) return null;
        const entry = this.voice.peerConnections?.get(view.peer);
        if (!entry?.pc) return null;
        if (view.channelPc === entry.pc) return view.channelFailed ? null : view.channel;
        view.channelPc = entry.pc;
        view.channelFailed = false;
        let channel;
        try {
            channel = entry.pc.createDataChannel('zali-rc', { ordered: true });
        } catch (error) {
            view.channelFailed = true;
            this.voiceTrace('rc-channel-failed', { peer: view.peer, error: error?.message || String(error) }, 'WARN');
            return null;
        }
        view.channel = channel;
        channel.onopen = () => this.voiceTrace('rc-channel-open', { peer: view.peer, ms: Date.now() - (view.since || Date.now()) });
        channel.onclose = () => { if (view.channel === channel) view.channel = null; };
        // Первый канал данных на соединении требует нового offer (m=application).
        this.renegotiateVoicePeer(view.peer).catch(() => {});
        return channel;
    }

    sendRemoteControlInput(input) {
        const view = this.rcState().view;
        if (!view) return;
        const channel = this.ensureRemoteControlChannel();
        if (channel && channel.readyState === 'open') {
            // Затор канала: движения можно пропустить, нажатия — нет.
            if (input.t === 'move' && channel.bufferedAmount > 64 * 1024) return;
            try { channel.send(JSON.stringify(input)); return; } catch (e) {}
        }
        // Пока канал не открыт — через сервер, но только мышь: клавиши сервер видеть не должен.
        if (input.t === 'key') {
            if (!view.keysHeldNoticeShown) {
                view.keysHeldNoticeShown = true;
                this.rcNotice('INFO', 'Клавиатура заработает, когда установится прямое соединение с собеседником');
            }
            return;
        }
        // Движения реже (каждое — строка в журнале сервера).
        if (input.t === 'move') {
            const now = Date.now();
            if (now - (view.lastRelayMoveAt || 0) < ZaliInterface.RC_RELAY_MOVE_INTERVAL_MS) return;
            view.lastRelayMoveAt = now;
        }
        this.sendVoicePeerSignal(view.peer, { type: 'rc-input', e: input });
    }

    releaseRemoteControlInputs(view) {
        if (!view) return;
        const hadAny = view.pressedKeys?.size || view.pressedButtons?.size;
        view.pressedKeys?.clear();
        view.pressedButtons?.clear();
        // Оболочка сама отпускает всё, что считала нажатым.
        if (hadAny) this.sendRemoteControlInput({ t: 'release' });
    }

    /** Управляем ли мы экраном, который сейчас открыт на весь экран. */
    remoteControlFocusActive() {
        const view = this.rcState().view;
        const focus = this._voiceFocus;
        return !!(view && focus?.kind === 'screen' && focus.peer === view.peer);
    }

    /** Клиентские координаты → доли кадра с учётом полей object-fit: contain. */
    remoteControlPoint(video, clientX, clientY) {
        if (!video) return null;
        const rect = video.getBoundingClientRect();
        const vw = video.videoWidth, vh = video.videoHeight;
        if (!vw || !vh || !rect.width || !rect.height) return null;
        const scale = Math.min(rect.width / vw, rect.height / vh);
        const w = vw * scale, h = vh * scale;
        const x = (clientX - (rect.left + (rect.width - w) / 2)) / w;
        const y = (clientY - (rect.top + (rect.height - h) / 2)) / h;
        return { x, y, inside: x >= 0 && x <= 1 && y >= 0 && y <= 1, cx: Math.min(1, Math.max(0, x)), cy: Math.min(1, Math.max(0, y)) };
    }

    bindRemoteControlCapture(media) {
        if (!media || media.dataset.rcBound) return;
        media.dataset.rcBound = '1';
        const video = () => media.querySelector('video');
        const guard = (event) => {
            if (!this.remoteControlFocusActive()) return false;
            event.preventDefault();
            event.stopPropagation();
            return true;
        };
        media.addEventListener('pointermove', (event) => {
            if (!this.remoteControlFocusActive()) return;
            const view = this.rcState().view;
            const p = this.remoteControlPoint(video(), event.clientX, event.clientY);
            if (!p || (!p.inside && !view.pressedButtons.size)) return;
            view.pendingMove = { t: 'move', x: p.cx, y: p.cy };
            if (!view.frame) {
                view.frame = requestAnimationFrame(() => {
                    view.frame = 0;
                    const move = view.pendingMove;
                    view.pendingMove = null;
                    if (move) this.sendRemoteControlInput(move);
                });
            }
        });
        media.addEventListener('pointerdown', (event) => {
            if (!guard(event)) return;
            const view = this.rcState().view;
            const p = this.remoteControlPoint(video(), event.clientX, event.clientY);
            const b = event.button;
            if (!p || !p.inside || ![0, 1, 2].includes(b)) return;
            try { media.setPointerCapture(event.pointerId); } catch (e) {}
            view.pressedButtons.add(b);
            this.sendRemoteControlInput({ t: 'down', x: p.cx, y: p.cy, b });
        });
        media.addEventListener('pointerup', (event) => {
            if (!guard(event)) return;
            const view = this.rcState().view;
            const b = event.button;
            if (!view.pressedButtons.has(b)) return;
            view.pressedButtons.delete(b);
            const p = this.remoteControlPoint(video(), event.clientX, event.clientY);
            this.sendRemoteControlInput({ t: 'up', x: p ? p.cx : 0, y: p ? p.cy : 0, b });
        });
        media.addEventListener('pointercancel', () => {
            if (this.remoteControlFocusActive()) this.releaseRemoteControlInputs(this.rcState().view);
        });
        // Клик по кадру в режиме управления — нажатие у собеседника, а не «свернуть».
        media.addEventListener('click', (event) => { guard(event); });
        media.addEventListener('dblclick', (event) => { guard(event); });
        media.addEventListener('contextmenu', (event) => { guard(event); });
        media.addEventListener('wheel', (event) => {
            if (!guard(event)) return;
            const k = event.deltaMode === 1 ? 16 : (event.deltaMode === 2 ? 400 : 1);
            this.sendRemoteControlInput({ t: 'wheel', dx: Math.round(event.deltaX * k), dy: Math.round(event.deltaY * k) });
        }, { passive: false });
    }

    /** Клавиатура — на window в фазе захвата, раньше хоткеев приложения и Esc оверлея. */
    ensureRemoteControlKeyHook() {
        const rc = this.rcState();
        if (rc.keyHook) return;
        rc.keyHook = (event) => {
            if (!this.remoteControlFocusActive()) return;
            if (!event.code || event.isComposing) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            const view = rc.view;
            const down = event.type === 'keydown';
            if (down) view.pressedKeys.add(event.code);
            else if (!view.pressedKeys.delete(event.code)) return;
            this.sendRemoteControlInput({ t: 'key', code: event.code, d: down ? 1 : 0 });
        };
        rc.blurHook = () => {
            if (rc.view) this.releaseRemoteControlInputs(rc.view);
        };
        window.addEventListener('keydown', rc.keyHook, true);
        window.addEventListener('keyup', rc.keyHook, true);
        window.addEventListener('blur', rc.blurHook);
    }

    // ------------------------------------------------------------------- интерфейс

    /** Кнопка на своей демонстрации, режим захвата ввода у зрителя, плашка «вами управляют». */
    syncRemoteControlUi() {
        this.syncRemoteControlHostBanner();
        const stage = document.getElementById('voiceStage');
        if (stage) this.syncRemoteControlStage(stage);
        const root = document.getElementById('voiceFocus');
        if (root) this.syncRemoteControlFocus(root);
    }

    /** Зритель: в развёрнутом экране того, кто отдал управление, — захват ввода и «Вернуть». */
    syncRemoteControlFocus(root) {
        const focus = this._voiceFocus;
        const bar = root.querySelector('.voice-focus-bar');
        const media = root.querySelector('.voice-focus-media');
        const peer = focus?.kind === 'screen' ? focus.peer : '';
        const controlling = !!(peer && this.remoteControlViewFor(peer));
        root.classList.toggle('is-rc', controlling);
        if (controlling) {
            this.bindRemoteControlCapture(media);
            this.ensureRemoteControlKeyHook();
        }
        let btn = bar?.querySelector('.voice-focus-rc');
        if (!bar || !controlling) {
            btn?.remove();
            return;
        }
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'voice-focus-rc is-active';
            btn.textContent = 'Вернуть управление';
            btn.title = 'Мышь и клавиатура над кадром уходят собеседнику. Нажмите, чтобы вернуть ему управление';
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                this.stopRemoteControlView();
            });
            bar.insertBefore(btn, bar.querySelector('.voice-focus-close'));
        }
    }

    /** Показывающий: кнопка «Отдать управление» / «Забрать управление» на плитке «Ваш экран». */
    syncRemoteControlStage(stage) {
        const rc = this.rcState();
        const tile = Array.from(stage.children).find(t => t.dataset?.kind === 'screen' && t.dataset.peer === '');
        let btn = tile?.querySelector('.rc-stage-btn');
        const available = this.remoteControlHostAvailable() && (rc.host || this.remoteControlCandidates().length);
        if (!tile || !available) {
            btn?.remove();
            if (!available) this.closeRemoteControlPicker();
            return;
        }
        if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'rc-stage-btn';
            // Плитка по клику разворачивается на весь экран — кнопка свой клик не отдаёт.
            btn.addEventListener('click', (event) => {
                event.stopPropagation();
                const state = this.rcState();
                if (state.pending) return;
                if (state.host) {
                    this.revokeRemoteControlHost('stopped');
                    return;
                }
                const people = this.remoteControlCandidates();
                if (people.length === 1) void this.grantRemoteControl(people[0]);
                else {
                    const r = btn.getBoundingClientRect();
                    this.openRemoteControlPicker(r.left, r.bottom + 6);
                }
            });
            tile.appendChild(btn);
        }
        const label = rc.host
            ? `Забрать управление у ${rc.host.peer}`
            : (rc.pending ? 'Ждём подтверждения…' : 'Отдать управление');
        if (btn.textContent !== label) btn.textContent = label;
        btn.classList.toggle('is-active', !!rc.host);
        btn.disabled = !!rc.pending;
        btn.title = rc.host
            ? `${rc.host.peer} управляет вашим компьютером. Нажмите, чтобы забрать управление`
            : 'Отдать участнику звонка управление мышью и клавиатурой, пока идёт эта демонстрация';
    }

    /** Выбор участника — меню того же вида, что у контекстного меню контакта. */
    openRemoteControlPicker(x, y) {
        this.closeContactContextMenu?.();
        const people = this.remoteControlCandidates();
        if (!people.length) return;
        const menu = document.createElement('div');
        menu.id = 'contactContextMenu';
        menu.className = 'peer-context-menu';
        menu.setAttribute('role', 'menu');
        menu.tabIndex = -1;
        menu.innerHTML = `<div class="peer-context-menu-volume-head" style="padding:8px 12px 0"><span>Кому отдать управление</span></div>`
            + people.map(name => `<button type="button" class="peer-context-menu-item" role="menuitem" data-rc-peer="${this.esc(name)}">${this.voiceIcon('screen')}<span>${this.esc(name)}</span></button>`).join('');
        document.body.appendChild(menu);
        const pad = 8;
        const width = menu.offsetWidth, height = menu.offsetHeight;
        menu.style.left = `${Math.max(pad, Math.min(x, window.innerWidth - width - pad))}px`;
        menu.style.top = `${Math.max(pad, Math.min(y, window.innerHeight - height - pad))}px`;
        menu.querySelectorAll('[data-rc-peer]').forEach(item => item.addEventListener('click', () => {
            const name = item.getAttribute('data-rc-peer');
            this.closeContactContextMenu?.();
            void this.grantRemoteControl(name);
        }));
        const keyHandler = (evt) => {
            if (menu.isConnected && evt.key === 'Escape') { evt.preventDefault(); this.closeContactContextMenu?.(); }
        };
        this._contactContextMenuKeyHandler = keyHandler;
        document.addEventListener('keydown', keyHandler, true);
        menu.focus({ preventScroll: true });
        const outsideHandler = (evt) => { if (!menu.contains(evt.target)) this.closeContactContextMenu?.(); };
        this._contactContextMenuOutsideHandler = outsideHandler;
        setTimeout(() => {
            document.addEventListener('click', outsideHandler);
            document.addEventListener('contextmenu', outsideHandler);
        }, 0);
        this._rcPickerOpen = true;
    }

    closeRemoteControlPicker() {
        if (!this._rcPickerOpen) return;
        this._rcPickerOpen = false;
        if (document.querySelector('#contactContextMenu [data-rc-peer]')) this.closeContactContextMenu?.();
    }

    syncRemoteControlHostBanner() {
        const host = this.rcState().host;
        let banner = document.getElementById('rcHostBanner');
        if (!host) {
            banner?.remove();
            return;
        }
        if (!banner) {
            banner = document.createElement('div');
            banner.id = 'rcHostBanner';
            banner.className = 'rc-host-banner';
            banner.setAttribute('role', 'alert');
            banner.innerHTML = `<span class="rc-host-banner-dot" aria-hidden="true"></span>
                <span class="rc-host-banner-text"></span>
                <button type="button" class="rc-host-banner-stop">Остановить</button>`;
            banner.querySelector('.rc-host-banner-stop')?.addEventListener('click', () => this.revokeRemoteControlHost('stopped'));
            document.body.appendChild(banner);
        }
        const text = `${host.peer} управляет вашим компьютером`;
        const textEl = banner.querySelector('.rc-host-banner-text');
        if (textEl && textEl.textContent !== text) textEl.textContent = text;
    }
});
