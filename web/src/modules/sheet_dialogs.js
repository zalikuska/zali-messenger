(function () {
    'use strict';

    /**
     * Нижние листы на телефоне: смахивание вниз закрывает окно.
     *
     * На телефоне (≤ 760 px) окна по центру — подтверждения, перевод, почта,
     * аддоны, правила, выбор экрана, обрезка аватара — рисуются листом, прижатым к
     * низу (слой «НИЖНИЕ ЛИСТЫ» в конце web/style.css). Лист держится за верхнюю
     * кромку: потянул за «ручку» или шапку вниз — он едет за пальцем и, если
     * отпустили далеко или резко, уходит и закрывается. Закрытие — тот же Escape,
     * что и у системного «назад» (handleMobileBack в mobile.js): у каждого окна он
     * уже обработан, поэтому отдельного метода закрытия у окна знать не нужно.
     * Не закрылось (окно не отпускает Escape) — лист возвращается на место.
     */
    if (typeof document === 'undefined' || typeof window === 'undefined') return;

    const BOX = '.coin-transfer-box, .rules-dialog-box, .voice-picker, .avatar-crop-modal';
    const ZONE = 68;          // высота «ручки» с шапкой, за которую листа можно тянуть, px
    const START = 8;          // сдвиг, с которого жест считается перетаскиванием, px
    const FLING = 0.55;       // скорость броска, px/мс
    const FAR = 0.28;         // доля высоты, после которой отпущенный лист закрывается
    const mq = window.matchMedia ? window.matchMedia('(max-width: 760px)') : null;

    let drag = null;
    let swallowClickUntil = 0;

    const shown = (el) => !!el && el.isConnected && !el.hidden && el.getClientRects().length > 0;

    function reduced() {
        try { return !!window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches; } catch (e) { return false; }
    }

    function onStart(e) {
        drag = null;
        if (!mq?.matches || e.touches.length !== 1) return;
        const box = e.target?.closest?.(BOX);
        if (!box) return;
        const t = e.touches[0];
        const rect = box.getBoundingClientRect();
        if (t.clientY - rect.top > ZONE) return;
        drag = { box, x: t.clientX, y: t.clientY, dy: 0, active: false, last: [{ y: t.clientY, t: e.timeStamp }], h: rect.height };
    }

    function onMove(e) {
        if (!drag) return;
        const t = e.touches[0];
        const dx = t.clientX - drag.x;
        const dy = t.clientY - drag.y;
        if (!drag.active) {
            if (Math.abs(dx) > START && Math.abs(dx) > Math.abs(dy)) { drag = null; return; }
            if (dy <= START) return;
            drag.active = true;
            drag.box.style.transition = 'none';
            drag.box.style.animation = 'none';
        }
        if (e.cancelable) e.preventDefault();
        drag.dy = Math.max(0, dy - START);
        drag.last.push({ y: t.clientY, t: e.timeStamp });
        if (drag.last.length > 4) drag.last.shift();
        drag.box.style.transform = `translateY(${drag.dy}px)`;
    }

    function reset(box, animate) {
        box.style.transition = animate ? 'transform .28s cubic-bezier(.22, 1, .36, 1)' : '';
        box.style.transform = '';
        const clean = () => { box.style.transition = ''; box.style.animation = ''; };
        if (animate) setTimeout(clean, 300); else clean();
    }

    function dismiss(box) {
        const escape = () => new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        box.dispatchEvent(escape());
        if (shown(box)) document.dispatchEvent(escape());
        // Закрылось — убрать следы перетаскивания, чтобы при следующем показе лист был как новый.
        if (!shown(box)) { reset(box, false); return; }
        reset(box, true);
    }

    function onEnd() {
        const d = drag;
        drag = null;
        if (!d?.active) return;
        swallowClickUntil = performance.now() + 350;
        const first = d.last[0];
        const lastPt = d.last[d.last.length - 1];
        const speed = lastPt.t > first.t ? (lastPt.y - first.y) / (lastPt.t - first.t) : 0;
        const away = d.dy > d.h * FAR || speed > FLING;
        if (!away) { reset(d.box, true); return; }
        if (reduced()) { dismiss(d.box); return; }
        d.box.style.transition = 'transform .2s cubic-bezier(.4, 0, 1, 1)';
        d.box.style.transform = `translateY(${d.h + 24}px)`;
        setTimeout(() => dismiss(d.box), 200);
    }

    document.addEventListener('touchstart', onStart, { capture: true, passive: true });
    document.addEventListener('touchmove', onMove, { capture: true, passive: false });
    document.addEventListener('touchend', onEnd, { capture: true, passive: true });
    document.addEventListener('touchcancel', () => {
        const d = drag;
        drag = null;
        if (d?.active) reset(d.box, true);
    }, { capture: true, passive: true });
    // После перетаскивания палец, отпущенный над кнопкой «закрыть», дал бы ещё и клик.
    document.addEventListener('click', (e) => {
        if (performance.now() < swallowClickUntil) { e.preventDefault(); e.stopPropagation(); }
    }, true);
})();
