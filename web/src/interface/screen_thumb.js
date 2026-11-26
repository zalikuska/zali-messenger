// --- ZaliInterface: размытое превью чужой демонстрации без видеопотока. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// В SFU чужой экран идёт зрителю только после «Смотреть» (voice_sfu_watch, sfu.rs).
// До этого плитка — размытая заглушка, а чтобы она не была пустой, показывающий
// раз в несколько секунд шлёт каждому участнику крошечный снимок экрана (JPEG
// ~96 px, 1–3 КБ) обычным сигналом `screen-thumb`. Это единицы килобайт в минуту
// против мегабит видео; пропавший снимок ничего не ломает — остаётся тёмный фон.
const ZALI_THUMB_WIDTH = 96;
const ZALI_THUMB_FIRST_MS = 1200;
const ZALI_THUMB_EVERY_MS = 8000;
const ZALI_THUMB_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/=]{40,12000}$/;

ZaliMixin(ZaliInterface, class {

    // ---- Зритель ----

    /** Узел-заглушка для плитки чужой демонстрации; один на человека, пока он показывает. */
    screenPlaceholderNode(peer) {
        const name = String(peer || '').trim();
        const key = name.toLowerCase();
        const cache = this._screenPlaceholders || (this._screenPlaceholders = new Map());
        let node = cache.get(key);
        if (!node) {
            node = document.createElement('div');
            node.className = 'voice-screen-ph';
            node.dataset.peer = key;
            cache.set(key, node);
            // Раньше звук «начался стрим» играл при появлении <video>; теперь видео
            // появляется только после «Смотреть», и о показе говорит заглушка.
            this.playVoiceEventSound?.('stream');
        }
        const thumb = this.voice.screenThumbs?.get(key) || '';
        if (node.dataset.thumb !== thumb) {
            node.dataset.thumb = thumb;
            node.style.backgroundImage = thumb ? `url("${thumb}")` : '';
        }
        // Заглушки тех, кто перестал показывать, не копим.
        const live = new Set(Array.from(this.remoteScreenPeers?.().keys() || [], n => String(n).trim().toLowerCase()));
        for (const k of Array.from(cache.keys())) {
            if (!live.has(k)) cache.delete(k);
        }
        return node;
    }

    onScreenThumb(from, data) {
        const key = String(from || '').trim().toLowerCase();
        if (!key || typeof data !== 'string' || !ZALI_THUMB_RE.test(data)) return;
        const map = this.voice.screenThumbs || (this.voice.screenThumbs = new Map());
        map.set(key, data);
        const node = this._screenPlaceholders?.get(key);
        if (node && node.dataset.thumb !== data) {
            node.dataset.thumb = data;
            node.style.backgroundImage = `url("${data}")`;
        }
    }

    // ---- Показывающий ----

    ensureScreenThumbLoop() {
        if (this._screenThumbTimer) return;
        let startedAt = 0;
        let sentAt = 0;
        this._screenThumbTimer = setInterval(() => {
            const sharing = !!this.voice?.screenSharing && !!this.voice?.roomId;
            if (!sharing) {
                startedAt = 0;
                sentAt = 0;
                return;
            }
            if (document.visibilityState === 'hidden') return;
            const now = Date.now();
            if (!startedAt) startedAt = now;
            // Первый снимок — почти сразу после начала показа, дальше — раз в несколько секунд.
            const due = sentAt ? now - sentAt >= ZALI_THUMB_EVERY_MS : now - startedAt >= ZALI_THUMB_FIRST_MS;
            if (due && this.sendScreenThumb()) sentAt = now;
        }, 600);
    }

    /** Снимок своего экрана → всем остальным в комнате. true — отправлено. */
    sendScreenThumb() {
        const video = this.voice.localScreenVideoEl;
        if (!video || !video.videoWidth || !video.videoHeight || video.readyState < 2) return false;
        const me = String(this.myName() || '').trim().toLowerCase();
        const peers = (this.voice.participants || []).filter(n => String(n).trim().toLowerCase() !== me);
        if (!peers.length) return false;
        let data = '';
        try {
            const w = ZALI_THUMB_WIDTH;
            const h = Math.max(1, Math.round(w * video.videoHeight / video.videoWidth));
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            canvas.getContext('2d').drawImage(video, 0, 0, w, h);
            data = canvas.toDataURL('image/jpeg', 0.45);
        } catch (e) {
            return false;
        }
        if (!ZALI_THUMB_RE.test(data)) return false;
        for (const peer of peers) this.sendVoicePeerSignal(peer, { type: 'screen-thumb', d: data });
        return true;
    }
});
