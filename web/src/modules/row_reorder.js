// Перетаскивание строк списка — то же поведение, что у списка каналов в
// настройках сервера (server_modal.js, bindServerChannelsList): строка сама
// ручка, порог 5 px для мыши, удержание 280 мс для касания, соседи
// расступаются, у края окна список автопрокручивается.
//
// Модуль не знает, что за строки: он двигает их и сообщает новый порядок.
//
//   ZaliRowReorder.bind(listEl, {
//       rowSelector: '.row',          // что тянется
//       idAttr: 'data-row-id',        // чем строка опознаётся
//       ignore: 'input, textarea',    // нажатие здесь не начинает перетаскивание
//       onReorder(ids, from, to) {},  // новый порядок id и откуда/куда ушла строка
//   });
//
// Привязка одноразовая: повторный bind на тот же список только меняет
// колбэки, так что список можно перерисовывать, не перевешивая обработчики.
(function () {
    const THRESHOLD = 5;
    const TOUCH_HOLD_MS = 280;
    const EDGE = 44;

    function bind(list, options) {
        if (!list) return null;
        const opts = list.__rowReorderOptions = Object.assign(list.__rowReorderOptions || {}, options);
        if (list.__rowReorderBound) return opts;
        list.__rowReorderBound = true;

        let press = null;
        let drag = null;
        let suppressClick = false;

        const rowSel = () => opts.rowSelector;
        const scrollerFor = () => {
            const candidates = [list];
            let parent = list.parentElement;
            while (parent) {
                candidates.push(parent);
                parent = parent.parentElement;
            }
            return candidates.find(el => el && el.scrollHeight > el.clientHeight + 1
                && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) || null;
        };

        // Клик, которым заканчивается перетаскивание, — не выбор.
        list.addEventListener('click', (e) => {
            if (!suppressClick) return;
            e.preventDefault();
            e.stopPropagation();
        }, true);

        // Геометрия снимается один раз в «контентных» координатах: прокрутка
        // с момента старта добавляется обратно, поэтому автопрокрутка не
        // сбивает измеренные позиции.
        const layout = () => {
            const scrolled = drag.scroller ? drag.scroller.scrollTop - drag.scroll0 : 0;
            const origin = drag.rects[drag.originIndex];
            const first = drag.rects[0];
            const last = drag.rects[drag.rects.length - 1];
            const offset = Math.max(
                first.top - origin.top - 8,
                Math.min(last.bottom - origin.bottom + 8, drag.clientY - drag.startY + scrolled),
            );
            drag.rows[drag.originIndex].style.transform = `translate3d(0, ${offset.toFixed(1)}px, 0)`;
            const center = origin.top + origin.height / 2 + offset;
            let index = 0;
            drag.rects.forEach((rect, i) => {
                if (i !== drag.originIndex && center > rect.top + rect.height / 2) index += 1;
            });
            if (index === drag.index) return;
            drag.index = index;
            drag.rows.forEach((row, i) => {
                if (i === drag.originIndex) return;
                let shift = 0;
                if (drag.originIndex < index && i > drag.originIndex && i <= index) shift = -drag.step;
                if (drag.originIndex > index && i >= index && i < drag.originIndex) shift = drag.step;
                row.style.transform = shift ? `translate3d(0, ${shift}px, 0)` : '';
            });
            if (typeof opts.onPreview === 'function') {
                const ids = drag.rows.map(row => row.getAttribute(opts.idAttr));
                const [moved] = ids.splice(drag.originIndex, 1);
                ids.splice(index, 0, moved);
                opts.onPreview(ids, drag.originIndex, index);
            }
        };

        const autoscroll = () => {
            if (!drag) return;
            const scroller = drag.scroller;
            if (scroller) {
                const box = scroller.getBoundingClientRect();
                let speed = 0;
                if (drag.clientY < box.top + EDGE) speed = -Math.ceil((box.top + EDGE - drag.clientY) / 4);
                else if (drag.clientY > box.bottom - EDGE) speed = Math.ceil((drag.clientY - box.bottom + EDGE) / 4);
                if (speed) {
                    scroller.scrollTop += speed;
                    layout();
                }
            }
            drag.raf = requestAnimationFrame(autoscroll);
        };

        const startDrag = () => {
            if (!press || drag) return;
            const rows = Array.from(list.querySelectorAll(rowSel()));
            const originIndex = rows.indexOf(press.row);
            if (originIndex < 0 || rows.length < 2) {
                press = null;
                return;
            }
            const rects = rows.map(row => row.getBoundingClientRect());
            const scroller = scrollerFor();
            drag = {
                rows,
                rects,
                originIndex,
                index: originIndex,
                pointerId: press.pointerId,
                startY: press.startY,
                clientY: press.startY,
                scroller,
                scroll0: scroller ? scroller.scrollTop : 0,
                step: rects[originIndex].height + Math.max(0, rects[1].top - rects[0].bottom),
                raf: 0,
            };
            list.classList.add('is-dragging');
            press.row.classList.add('dragging');
            try { list.setPointerCapture(drag.pointerId); } catch (_) { /* не критично */ }
            autoscroll();
        };

        const endDrag = (commit) => {
            if (!drag) return;
            cancelAnimationFrame(drag.raf);
            const { rows, originIndex, index } = drag;
            drag = null;
            list.classList.remove('is-dragging');
            rows.forEach((row) => {
                row.classList.remove('dragging');
                row.style.transform = '';
            });
            suppressClick = true;
            setTimeout(() => { suppressClick = false; }, 0);
            if (commit && index !== originIndex) {
                const ids = rows.map(row => row.getAttribute(opts.idAttr));
                const [moved] = ids.splice(originIndex, 1);
                ids.splice(index, 0, moved);
                if (typeof opts.onReorder === 'function') opts.onReorder(ids, originIndex, index);
            }
        };

        list.addEventListener('pointerdown', (e) => {
            if (drag || (e.pointerType === 'mouse' && e.button !== 0)) return;
            const row = e.target.closest(rowSel());
            if (!row || !list.contains(row)) return;
            if (opts.ignore && e.target.closest(opts.ignore)) return;
            press = { row, pointerId: e.pointerId, pointerType: e.pointerType, startX: e.clientX, startY: e.clientY, holdTimer: 0 };
            if (e.pointerType === 'touch') {
                // На касании обычный сдвиг — прокрутка списка; взять строку можно
                // только удержанием, как в любом нативном списке.
                press.holdTimer = setTimeout(startDrag, TOUCH_HOLD_MS);
            }
        });

        list.addEventListener('pointermove', (e) => {
            if (drag) {
                if (e.pointerId !== drag.pointerId) return;
                drag.clientY = e.clientY;
                layout();
                return;
            }
            if (!press || e.pointerId !== press.pointerId) return;
            const moved = Math.hypot(e.clientX - press.startX, e.clientY - press.startY);
            if (press.pointerType === 'touch') {
                if (moved > 8) {
                    clearTimeout(press.holdTimer);
                    press = null;
                }
                return;
            }
            if (moved >= THRESHOLD) {
                startDrag();
                if (drag) {
                    drag.clientY = e.clientY;
                    layout();
                }
            }
        });

        const release = (e, commit) => {
            if (press && e.pointerId === press.pointerId) {
                clearTimeout(press.holdTimer);
                press = null;
            }
            if (drag && e.pointerId === drag.pointerId) endDrag(commit);
        };
        list.addEventListener('pointerup', (e) => release(e, true));
        list.addEventListener('pointercancel', (e) => release(e, false));
        list.addEventListener('touchmove', (e) => {
            if (drag && e.cancelable) e.preventDefault();
        }, { passive: false });

        return opts;
    }

    window.ZaliRowReorder = Object.freeze({ bind });
})();
