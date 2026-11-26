// --- ZaliInterface: медиа на весь экран и поворот экрана на телефоне. ---
//
// Интерфейс телефона живёт только в портрете: оболочка Android держит портретную
// ориентацию (MainActivity.applyOrientation). Альбомный разрешён лишь пока на экране
// медиа на весь экран:
//   - видео звонка — камера или показ экрана (#voiceFocus, voice_ui.js openVoiceFocus);
//   - фото из ленты (#mediaViewer, ниже: зум, листание, поворот);
//   - видео из ленты, развёрнутое кнопкой своей панели (document.fullscreenElement).
// Веб сообщает оболочке SCREEN_ROTATION { free }, она переключает ориентацию на
// пользовательскую (с учётом системной блокировки поворота) и обратно на портрет.
//
// В альбомном ширина телефона больше 760 px, и раскладка за оверлеем становится
// «настольной». Сбрасывать навигацию телефона из-за этого нельзя (syncMobileChrome
// снял бы открытый чат и вложенные экраны), поэтому обработчики смены раскладки в
// events.js пропускают ход, пока mobileRotationHeld() — и пока экран возвращается в
// портрет после закрытия медиа.
ZaliMixin(ZaliInterface, class {

    setupMediaViewer() {
        if (this._mediaViewerReady) return;
        this._mediaViewerReady = true;
        document.addEventListener('click', (event) => {
            // Не только телефон: на десктопе фото из ленты тоже разворачивается
            // (раньше клик по нему не делал ничего — репорты a9227ff3, 1a749380).
            const img = event.target?.closest?.('#msgs img.media-img');
            if (!img || img.classList.contains('compact') || !(img.currentSrc || img.src)) return;
            // В режиме жалобы тап по сообщению выбирает его.
            if (img.closest('.is-reporting')) return;
            event.preventDefault();
            event.stopPropagation();
            this.openMediaViewer(img.currentSrc || img.src, img.getAttribute('alt') || '');
        }, true);
        const onFullscreen = () => this.syncScreenRotation();
        document.addEventListener('fullscreenchange', onFullscreen);
        document.addEventListener('webkitfullscreenchange', onFullscreen);
    }

    // Фото из ленты на весь экран. Один оверлей #mediaViewer (по нему его находят
    // `mediaRotationWanted` и системное «назад» в mobile.js), всё состояние — в замыкании:
    // закрытие обязано снять все слушатели, и проще всего это делает один `destroy`.
    //   зум: колесо / щипок трекпада (ctrl+wheel) / щипок пальцами / двойной клик и тап /
    //        кнопки и клавиши + − 0 1; панорама — перетаскиванием;
    //   листание: стрелки на экране и на клавиатуре, свайп влево-вправо на телефоне —
    //        по фото, которые сейчас в ленте (лента виртуализована: берутся отрисованные);
    //   закрытие: Esc, ×, клик/тап по пустому месту, свайп вниз на телефоне.
    // Геометрия: картинка стоит в центре «рамки» (.mv-fitbox — экран за вычетом панелей),
    // `z` — пикселей экрана на пиксель картинки, `fit` — масштаб «вписать» (не больше 1).
    openMediaViewer(src, label = '') {
        if (!src) return;
        this.closeMediaViewer({ keepRotation: true });
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();

        const ICON = {
            close: '<path d="M6 6l12 12M18 6 6 18"/>',
            download: '<path d="M12 4v11m0 0 4-4m-4 4-4-4M5 19.5h14"/>',
            zoomIn: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2M11 8.3v5.4M8.3 11h5.4"/>',
            zoomOut: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2M8.3 11h5.4"/>',
            rotate: '<path d="M19.5 12a7.5 7.5 0 1 1-2.4-5.5"/><path d="M19.8 4.2v4.4h-4.4"/>',
            prev: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
            next: '<path d="M9.5 5.5 16 12l-6.5 6.5"/>',
        };
        const icon = name => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[name]}</svg>`;

        const root = document.createElement('div');
        root.id = 'mediaViewer';
        root.className = 'media-viewer mv';
        root.tabIndex = -1;
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.setAttribute('aria-label', 'Просмотр фото');
        root.innerHTML = `<div class="mv-backdrop"></div>
            <div class="mv-surface">
                <div class="mv-fitbox"></div>
                <img class="mv-img" alt="" draggable="false">
            </div>
            <div class="mv-top">
                <div class="mv-title"><span class="mv-name"></span><span class="mv-meta"></span></div>
                <div class="mv-actions">
                    <button type="button" class="mv-btn" data-mv="download" aria-label="Скачать" title="Скачать">${icon('download')}</button>
                    <button type="button" class="mv-btn" data-mv="close" aria-label="Закрыть" title="Закрыть (Esc)">${icon('close')}</button>
                </div>
            </div>
            <button type="button" class="mv-nav mv-prev" data-mv="prev" aria-label="Предыдущее фото" title="Предыдущее (←)">${icon('prev')}</button>
            <button type="button" class="mv-nav mv-next" data-mv="next" aria-label="Следующее фото" title="Следующее (→)">${icon('next')}</button>
            <div class="mv-dock" role="toolbar" aria-label="Масштаб">
                <button type="button" class="mv-btn" data-mv="zoom-out" aria-label="Отдалить" title="Отдалить (−)">${icon('zoomOut')}</button>
                <button type="button" class="mv-zoom" data-mv="zoom-toggle" aria-label="Масштаб" title="Вписать / 100 %">100%</button>
                <button type="button" class="mv-btn" data-mv="zoom-in" aria-label="Приблизить" title="Приблизить (+)">${icon('zoomIn')}</button>
                <span class="mv-sep" aria-hidden="true"></span>
                <button type="button" class="mv-btn" data-mv="rotate" aria-label="Повернуть" title="Повернуть (R)">${icon('rotate')}</button>
            </div>`;

        const surface = root.querySelector('.mv-surface');
        const fitbox = root.querySelector('.mv-fitbox');
        const img = root.querySelector('.mv-img');
        const nameEl = root.querySelector('.mv-name');
        const metaEl = root.querySelector('.mv-meta');
        const zoomEl = root.querySelector('.mv-zoom');
        const prevBtn = root.querySelector('.mv-prev');
        const nextBtn = root.querySelector('.mv-next');
        const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

        // Фото, которые сейчас в ленте, в порядке экрана. Ушедшее из окна виртуализации
        // не попадёт — листать можно по тому, что отрисовано.
        let items = Array.from(document.querySelectorAll('#msgs img.media-img:not(.compact)'))
            .filter(el => !el.closest('.is-reporting') && (el.currentSrc || el.src))
            .map(el => ({ src: el.currentSrc || el.src, name: el.getAttribute('alt') || '' }));
        let index = items.findIndex(item => item.src === src);
        if (index < 0) { items = [{ src, name: label }]; index = 0; }

        let nw = 0, nh = 0;          // естественный размер текущего фото
        let rot = 0;                 // 0 / 90 / 180 / 270
        let z = 1, tx = 0, ty = 0;   // масштаб и смещение от центра рамки
        let fit = 1;
        let bx = 0, by = 0, fw = 0, fh = 0; // центр рамки относительно центра экрана, её размер
        let anim = 0;
        let idleTimer = 0;
        let lastTap = null;
        const pts = new Map();
        let gesture = null;

        const maxZ = () => Math.max(8, fit * 8);
        const sideways = () => rot % 180 !== 0;
        const spanW = () => (sideways() ? nh : nw);
        const spanH = () => (sideways() ? nw : nh);
        const isZoomed = () => z > fit * 1.02;

        const measure = () => {
            const fb = fitbox.getBoundingClientRect();
            const sf = surface.getBoundingClientRect();
            fw = fb.width; fh = fb.height;
            bx = fb.left + fb.width / 2 - (sf.left + sf.width / 2);
            by = fb.top + fb.height / 2 - (sf.top + sf.height / 2);
        };
        const computeFit = () => (nw && fw ? Math.min(1, fw / spanW(), fh / spanH()) : 1);
        // Пока картинка меньше рамки — по центру; больше — край до края рамки, не дальше.
        const clampPan = (zz, x, y) => {
            const mx = Math.max(0, (spanW() * zz - fw) / 2);
            const my = Math.max(0, (spanH() * zz - fh) / 2);
            return [clamp(x, -mx, mx), clamp(y, -my, my)];
        };
        const paint = () => {
            img.style.transform = `translate3d(${bx + tx}px, ${by + ty}px, 0) rotate(${rot}deg) scale(${z})`;
            zoomEl.textContent = `${Math.round(z * 100)}%`;
            root.classList.toggle('is-zoomed', isZoomed());
        };
        const setView = (nz, nx, ny, { slack = false } = {}) => {
            z = nz;
            if (slack && nz < fit) { tx = nx; ty = ny; } else [tx, ty] = clampPan(nz, nx, ny);
            paint();
        };
        const cancelAnim = () => { if (anim) { cancelAnimationFrame(anim); anim = 0; } };
        const animateTo = (nz, nx, ny, ms = 200) => {
            cancelAnim();
            [nx, ny] = clampPan(nz, nx, ny);
            if (reduce || ms <= 0) { setView(nz, nx, ny); return; }
            const z0 = z, x0 = tx, y0 = ty, t0 = performance.now();
            const step = (t) => {
                const k = Math.min(1, (t - t0) / ms);
                const e = 1 - Math.pow(1 - k, 3);
                z = z0 + (nz - z0) * e; tx = x0 + (nx - x0) * e; ty = y0 + (ny - y0) * e;
                paint();
                anim = k < 1 ? requestAnimationFrame(step) : 0;
            };
            anim = requestAnimationFrame(step);
        };
        // Точка экрана → от центра рамки: так считается смещение зума.
        const local = (clientX, clientY) => {
            const sf = surface.getBoundingClientRect();
            return [clientX - (sf.left + sf.width / 2) - bx, clientY - (sf.top + sf.height / 2) - by];
        };
        const zoomAbout = (nz, px, py, { animate = false } = {}) => {
            nz = clamp(nz, fit, maxZ());
            const ratio = nz / z;
            const nx = px - (px - tx) * ratio;
            const ny = py - (py - ty) * ratio;
            if (animate) animateTo(nz, nx, ny, 180); else setView(nz, nx, ny);
        };
        const toggleZoomAt = (px, py) => {
            if (isZoomed()) { animateTo(fit, 0, 0, 220); return; }
            let target = fit < 1 ? Math.min(1, fit * 2.5) : 2.5;
            if (target < fit * 1.2) target = fit * 2.5;
            zoomAbout(target, px, py, { animate: true });
        };
        const relayout = ({ reset = false } = {}) => {
            measure();
            const wasFit = reset || !isZoomed();
            fit = computeFit();
            if (wasFit) setView(fit, 0, 0); else setView(clamp(z, fit, maxZ()), tx, ty);
        };

        const setChrome = (visible) => root.classList.toggle('is-bare', !visible);
        const wake = () => {
            root.classList.remove('is-idle');
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                // Панели прячутся только у мыши и пока над ними не держат курсор.
                if (root.matches(':hover') && !root.querySelector('.mv-top:hover, .mv-dock:hover, .mv-nav:hover')) root.classList.add('is-idle');
            }, 2800);
        };

        const preload = (i) => {
            const item = items[i];
            if (!item || /^(blob|data):/i.test(item.src)) return;
            const probe = new Image();
            probe.decoding = 'async';
            probe.src = item.src;
        };
        const updateMeta = () => {
            const parts = [];
            if (items.length > 1) parts.push(`${index + 1} из ${items.length}`);
            if (nw && nh) parts.push(`${nw}×${nh}`);
            metaEl.textContent = parts.join(' · ');
        };
        const show = (i) => {
            index = clamp(i, 0, items.length - 1);
            const item = items[index];
            cancelAnim();
            rot = 0; nw = 0; nh = 0;
            img.style.visibility = 'hidden';
            img.alt = item.name;
            nameEl.textContent = item.name;
            nameEl.hidden = !item.name;
            const many = items.length > 1;
            prevBtn.hidden = !many; nextBtn.hidden = !many;
            prevBtn.disabled = index === 0; nextBtn.disabled = index === items.length - 1;
            updateMeta();
            const ready = () => {
                if (items[index] !== item) return;
                nw = img.naturalWidth || 1024; nh = img.naturalHeight || 1024;
                img.style.width = `${nw}px`; img.style.height = `${nh}px`;
                img.style.margin = `${-nh / 2}px 0 0 ${-nw / 2}px`;
                img.style.visibility = '';
                updateMeta();
                relayout({ reset: true });
            };
            img.onload = ready;
            img.onerror = () => { img.style.visibility = 'hidden'; };
            img.src = item.src;
            if (img.complete && img.naturalWidth) ready();
            preload(index + 1); preload(index - 1);
        };
        const go = (delta) => {
            const next = index + delta;
            if (next < 0 || next >= items.length) return false;
            show(next);
            return true;
        };
        const rotate = () => {
            if (!nw) return;
            cancelAnim();
            rot = (rot + 90) % 360;
            fit = computeFit();
            setView(fit, 0, 0);
        };
        const download = (anchor) => {
            const item = items[index];
            if (!item) return;
            const base = String(item.name || 'photo').trim() || 'photo';
            void this.downloadAttachmentFromHref?.(item.src, base, { anchor });
        };
        const close = () => this.closeMediaViewer();
        const zoomCenter = (factor) => zoomAbout(z * factor, 0, 0, { animate: true });

        const actions = {
            close,
            download: (btn) => download(btn),
            prev: () => go(-1),
            next: () => go(1),
            rotate,
            'zoom-in': () => zoomCenter(1.5),
            'zoom-out': () => zoomCenter(1 / 1.5),
            'zoom-toggle': () => {
                if (isZoomed() && Math.abs(z - 1) > 0.01) animateTo(1, tx * (1 / z), ty * (1 / z), 200);
                else toggleZoomAt(0, 0);
            },
        };
        root.addEventListener('click', (event) => {
            const btn = event.target.closest('[data-mv]');
            if (!btn || !root.contains(btn)) return;
            event.stopPropagation();
            actions[btn.getAttribute('data-mv')]?.(btn);
            wake();
        });

        // --- мышь / касания ---------------------------------------------------------
        surface.addEventListener('wheel', (event) => {
            event.preventDefault();
            cancelAnim();
            const dy = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
            // Щипок трекпада приходит как ctrl+wheel и мельче колеса мыши.
            const k = event.ctrlKey ? 0.012 : 0.003;
            const [px, py] = local(event.clientX, event.clientY);
            zoomAbout(z * Math.exp(-clamp(dy, -120, 120) * k), px, py);
            wake();
        }, { passive: false });

        const overImage = (x, y) => {
            const r = img.getBoundingClientRect();
            return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
        };
        const midpoint = () => {
            const [a, b] = [...pts.values()];
            return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
        };
        const startOne = (x, y, touch) => {
            gesture = { mode: 'one', sx: x, sy: y, tx0: tx, ty0: ty, moved: false, axis: '', touch, t0: performance.now() };
        };
        surface.addEventListener('pointerdown', (event) => {
            if (event.button > 0) return;
            try { surface.setPointerCapture(event.pointerId); } catch (e) {}
            cancelAnim();
            pts.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (pts.size === 1) {
                startOne(event.clientX, event.clientY, event.pointerType !== 'mouse');
            } else if (pts.size === 2) {
                const m = midpoint();
                const [mx, my] = local(m.x, m.y);
                gesture = { mode: 'pinch', d0: m.d, z0: z, mx, my, tx0: tx, ty0: ty };
            }
            wake();
        });
        surface.addEventListener('pointermove', (event) => {
            if (event.pointerType === 'mouse') wake();
            if (!pts.has(event.pointerId)) return;
            pts.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (!gesture) return;
            if (gesture.mode === 'pinch' && pts.size >= 2) {
                const m = midpoint();
                const nz = clamp(gesture.z0 * m.d / gesture.d0, fit * 0.6, maxZ());
                const ratio = nz / gesture.z0;
                const [cx, cy] = local(m.x, m.y);
                setView(nz, cx - (gesture.mx - gesture.tx0) * ratio, cy - (gesture.my - gesture.ty0) * ratio, { slack: true });
                return;
            }
            if (gesture.mode !== 'one') return;
            const dx = event.clientX - gesture.sx;
            const dy = event.clientY - gesture.sy;
            if (!gesture.moved && Math.hypot(dx, dy) > 6) {
                gesture.moved = true;
                gesture.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : 'y';
                if (isZoomed()) root.classList.add('is-panning');
            }
            if (!gesture.moved) return;
            if (isZoomed()) {
                setView(z, gesture.tx0 + dx, gesture.ty0 + dy);
            } else if (gesture.touch) {
                // Не увеличено: фото идёт за пальцем — вбок листается, вниз закрывается.
                if (gesture.axis === 'x') {
                    const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === items.length - 1);
                    tx = dx * (atEdge ? 0.25 : 0.9);
                    ty = 0;
                } else {
                    tx = 0;
                    ty = dy;
                    root.style.setProperty('--mv-dim', String(Math.max(0.15, 1 - Math.abs(dy) / 420)));
                }
                paint();
            }
        });
        const endPointer = (event) => {
            if (!pts.has(event.pointerId)) return;
            pts.delete(event.pointerId);
            try { surface.releasePointerCapture(event.pointerId); } catch (e) {}
            const g = gesture;
            if (!g) return;
            if (g.mode === 'pinch') {
                if (pts.size >= 1) {
                    // Один палец остался: продолжаем панорамой с него, без скачка.
                    const rest = [...pts.values()][0];
                    startOne(rest.x, rest.y, true);
                    gesture.moved = true;
                    gesture.axis = 'p';
                } else gesture = null;
                if (z < fit) animateTo(fit, 0, 0, 200);
                return;
            }
            gesture = null;
            root.classList.remove('is-panning');
            if (event.type === 'pointercancel') { if (!isZoomed()) animateTo(fit, 0, 0, 160); root.style.removeProperty('--mv-dim'); return; }
            if (g.moved) {
                if (!isZoomed() && g.touch && g.axis !== 'p') {
                    const dx = event.clientX - g.sx;
                    const dy = event.clientY - g.sy;
                    const fast = (performance.now() - g.t0) < 260;
                    if (g.axis === 'y' && (Math.abs(dy) > 120 || (fast && Math.abs(dy) > 50))) { close(); return; }
                    if (g.axis === 'x' && (Math.abs(dx) > 70 || (fast && Math.abs(dx) > 35)) && go(dx < 0 ? 1 : -1)) {
                        root.style.removeProperty('--mv-dim');
                        return;
                    }
                    root.style.removeProperty('--mv-dim');
                    animateTo(fit, 0, 0, 180);
                }
                return;
            }
            // Нажатие без движения.
            const now = performance.now();
            const x = event.clientX, y = event.clientY;
            if (lastTap && now - lastTap.t < 300 && Math.hypot(x - lastTap.x, y - lastTap.y) < 28) {
                // Второй тап двойного: первый уже скрыл/показал панели — возвращаем их.
                if (lastTap.toggled) setChrome(root.classList.contains('is-bare'));
                lastTap = null;
                if (overImage(x, y)) { const [px, py] = local(x, y); toggleZoomAt(px, py); }
                return;
            }
            lastTap = { t: now, x, y, toggled: false };
            if (!overImage(x, y)) { close(); return; }
            if (g.touch) { setChrome(root.classList.contains('is-bare')); lastTap.toggled = true; }
        };
        surface.addEventListener('pointerup', endPointer);
        surface.addEventListener('pointercancel', endPointer);
        // Браузер не должен тащить картинку как файл или открывать меню на долгом тапе.
        surface.addEventListener('dragstart', e => e.preventDefault());
        surface.addEventListener('contextmenu', (e) => { if (e.pointerType === 'touch') e.preventDefault(); });

        // --- клавиатура -------------------------------------------------------------
        const onKey = (event) => {
            if (event.ctrlKey || event.metaKey || event.altKey) return;
            const key = event.key;
            let handled = true;
            if (key === 'Escape') close();
            else if (key === 'ArrowLeft') { if (isZoomed()) setView(z, tx + 80, ty); else go(-1); }
            else if (key === 'ArrowRight') { if (isZoomed()) setView(z, tx - 80, ty); else go(1); }
            else if (key === 'ArrowUp' && isZoomed()) setView(z, tx, ty + 80);
            else if (key === 'ArrowDown' && isZoomed()) setView(z, tx, ty - 80);
            else if (key === '+' || key === '=') zoomCenter(1.5);
            else if (key === '-' || key === '_') zoomCenter(1 / 1.5);
            else if (key === '0') animateTo(fit, 0, 0, 200);
            else if (key === '1') animateTo(1, 0, 0, 200);
            else if (key === 'r' || key === 'R' || key === 'к' || key === 'К') rotate();
            else handled = false;
            if (!handled) return;
            event.preventDefault();
            event.stopPropagation();
            wake();
        };
        document.addEventListener('keydown', onKey, true);

        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(() => relayout()) : null;
        observer?.observe(surface);
        const onResize = () => relayout();
        window.addEventListener('resize', onResize);

        this._mediaViewer = {
            root,
            destroy: () => {
                cancelAnim();
                clearTimeout(idleTimer);
                observer?.disconnect();
                window.removeEventListener('resize', onResize);
                document.removeEventListener('keydown', onKey, true);
                img.onload = null; img.onerror = null;
            },
        };
        document.body.appendChild(root);
        measure();
        show(index);
        wake();
        try { root.focus({ preventScroll: true }); } catch (e) {}
        this.syncScreenRotation();
    }

    closeMediaViewer({ keepRotation = false } = {}) {
        const viewer = this._mediaViewer;
        this._mediaViewer = null;
        viewer?.destroy();
        const root = viewer?.root || document.getElementById('mediaViewer');
        if (!root) return;
        root.remove();
        if (!keepRotation) this.syncScreenRotation();
    }

    mediaRotationWanted() {
        return !!(document.getElementById('voiceFocus')
            || document.getElementById('mediaViewer')
            || document.fullscreenElement
            || document.webkitFullscreenElement);
    }

    syncScreenRotation() {
        const free = this.mediaRotationWanted();
        if (free === !!this._rotationFree) return;
        this._rotationFree = free;
        clearTimeout(this._rotationSettleTimer);
        if (free) {
            this._rotationSettleUntil = 0;
        } else {
            // Экран ещё секунду-другую в альбомном, пока оболочка возвращает портрет.
            this._rotationSettleUntil = Date.now() + 2000;
            // Не вернулся (планшет, поворот не сработал) — догоняем раскладку сами.
            this._rotationSettleTimer = setTimeout(() => {
                if (this._rotationFree) return;
                this._rotationSettleUntil = 0;
                if (!this.isMobileLayout()) this.closeMobileSidebar?.();
                this.syncMobileChrome?.();
                this.repinMessagesAfterViewportChange?.();
            }, 2100);
        }
        if (this.nativeSupports?.('screenRotation')) {
            this.postNativeMessage({ type: NativeMessageTypes.SCREEN_ROTATION, free });
        }
    }

    // true — смену раскладки сейчас вызвал поворот ради медиа, навигацию не трогать.
    mobileRotationHeld() {
        if (this._rotationFree) return true;
        if (!this._rotationSettleUntil) return false;
        if (this.isMobileLayout() || Date.now() > this._rotationSettleUntil) {
            this._rotationSettleUntil = 0;
            return false;
        }
        return true;
    }
});
