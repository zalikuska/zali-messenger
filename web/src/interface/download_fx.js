// --- ZaliInterface: анимация скачивания файла. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Кольца сходятся к центру, в центре вспыхивает диск со значком скачивания (стрелка
// «падает» в лоток), и всё расходится волной с искрами. Играется там, где нажали
// на файл (центр плашки вложения), а без якоря — по центру окна. Только WAAPI и
// слой поверх интерфейса, который сам себя убирает: на сообщения, прокрутку и фокус
// не влияет. При `prefers-reduced-motion` — короткое появление диска без движения.
ZaliMixin(ZaliInterface, class {

    /** Центр окна и якорь → точка анимации в пикселях вида. */
    downloadFxOrigin(anchor) {
        const vw = window.innerWidth || 800;
        const vh = typeof zaliUsableViewportHeight === 'function' ? zaliUsableViewportHeight() : (window.innerHeight || 600);
        let x = vw / 2;
        let y = vh / 2;
        try {
            const rect = anchor?.getBoundingClientRect?.();
            if (rect && rect.width > 0 && rect.height > 0) {
                x = rect.left + rect.width / 2;
                y = rect.top + rect.height / 2;
            }
        } catch (e) { /* якоря уже нет — центр окна */ }
        // Целиком в окне: диск ~68 px и волна до ~±110 px.
        const pad = 110;
        return {
            x: Math.max(pad, Math.min(vw - pad, x)),
            y: Math.max(pad, Math.min(vh - pad, y)),
        };
    }

    playDownloadFx(anchor = null) {
        if (typeof document === 'undefined' || typeof Element === 'undefined' || !Element.prototype.animate) return;
        try {
            document.querySelectorAll('.dl-fx').forEach(node => node.remove());
            const reduce = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            const { x, y } = this.downloadFxOrigin(anchor);
            const root = document.createElement('div');
            root.className = 'dl-fx';
            root.setAttribute('aria-hidden', 'true');
            root.style.left = `${x}px`;
            root.style.top = `${y}px`;
            const mk = (cls) => {
                const el = document.createElement('span');
                el.className = cls;
                root.appendChild(el);
                return el;
            };
            const rings = [mk('dl-ring'), mk('dl-ring'), mk('dl-ring')];
            const glow = mk('dl-glow');
            const wave = [mk('dl-wave'), mk('dl-wave')];
            const dots = [];
            const DOTS = 12;
            for (let i = 0; i < DOTS; i++) dots.push(mk('dl-dot'));
            const disc = mk('dl-disc');
            disc.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'
                + '<path class="dl-arrow" d="M12 4v10.5" pathLength="1"/>'
                + '<path class="dl-head" d="m7.6 10.4 4.4 4.4 4.4-4.4" pathLength="1"/>'
                + '<path class="dl-tray" d="M5.2 19.2h13.6" pathLength="1"/></svg>';
            document.body.appendChild(root);

            const anims = [];
            const run = (el, frames, options) => {
                const a = el.animate(frames, { fill: 'both', ...options });
                anims.push(a);
                return a;
            };

            if (reduce) {
                run(disc, [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }], { duration: 900, easing: 'linear' });
                for (const el of [...rings, glow, ...wave, ...dots]) el.style.display = 'none';
            } else {
                // 1. Кольца сходятся к центру (с запаздыванием друг за другом).
                rings.forEach((ring, i) => {
                    run(ring, [
                        { transform: 'scale(3.6)', opacity: 0 },
                        { transform: 'scale(2.5)', opacity: 0.85, offset: 0.38 },
                        { transform: 'scale(0.82)', opacity: 0 },
                    ], { duration: 640, delay: i * 95, easing: 'cubic-bezier(.55,.05,.35,1)' });
                });
                // 2. В точке схождения — вспышка и диск с пружиной.
                run(glow, [
                    { transform: 'scale(.35)', opacity: 0 },
                    { transform: 'scale(1.05)', opacity: 0.6, offset: 0.4 },
                    { transform: 'scale(1.9)', opacity: 0 },
                ], { duration: 820, delay: 470, easing: 'cubic-bezier(.2,.7,.2,1)' });
                run(disc, [
                    { transform: 'scale(.15)', opacity: 0 },
                    { transform: 'scale(1.14)', opacity: 1, offset: 0.55 },
                    { transform: 'scale(1)', opacity: 1, offset: 0.7 },
                    { transform: 'scale(1)', opacity: 1, offset: 0.78 },
                    { transform: 'scale(.82)', opacity: 0 },
                ], { duration: 1260, delay: 470, easing: 'cubic-bezier(.34,1.4,.5,1)' });
                // 3. Стрелка «падает» в лоток: линия дорисовывается, голова и лоток — следом.
                const arrow = disc.querySelector('.dl-arrow');
                const head = disc.querySelector('.dl-head');
                const tray = disc.querySelector('.dl-tray');
                run(arrow, [{ strokeDashoffset: 1, transform: 'translateY(-5px)' }, { strokeDashoffset: 0, transform: 'translateY(0)' }], { duration: 320, delay: 650, easing: 'cubic-bezier(.3,.9,.3,1)' });
                run(head, [{ opacity: 0, transform: 'translateY(-5px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 300, delay: 720, easing: 'cubic-bezier(.3,.9,.3,1)' });
                run(tray, [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], { duration: 300, delay: 840, easing: 'cubic-bezier(.3,.9,.3,1)' });
                // 4. Расхождение: две волны от края диска и искры по кругу.
                wave.forEach((el, i) => {
                    run(el, [
                        { transform: 'scale(1)', opacity: 0.8, borderWidth: '3px' },
                        { transform: 'scale(3.4)', opacity: 0, borderWidth: '0.5px' },
                    ], { duration: 780, delay: 960 + i * 110, easing: 'cubic-bezier(.16,1,.3,1)' });
                });
                dots.forEach((dot, i) => {
                    const angle = (i / DOTS) * Math.PI * 2 + (i % 2 ? 0.12 : -0.08);
                    const reach = 64 + (i % 3) * 14;
                    const dx = Math.cos(angle) * reach;
                    const dy = Math.sin(angle) * reach;
                    run(dot, [
                        { transform: 'translate(0px,0px) scale(1)', opacity: 0 },
                        { transform: `translate(${dx * 0.35}px,${dy * 0.35}px) scale(1.15)`, opacity: 1, offset: 0.18 },
                        { transform: `translate(${dx}px,${dy}px) scale(.2)`, opacity: 0 },
                    ], { duration: 720, delay: 950 + (i % 4) * 28, easing: 'cubic-bezier(.2,.8,.25,1)' });
                });
            }
            const done = () => root.remove();
            Promise.allSettled(anims.map(a => a.finished)).then(done);
            setTimeout(done, 3200);
        } catch (e) {
            this.trace?.(`playDownloadFx failed error=${e?.message || e}`);
        }
    }
});
