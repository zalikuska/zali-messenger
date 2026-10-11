(function () {
    'use strict';

    /**
     * Стилизованные выпадающие списки вместо системных `<select>`.
     *
     * Зачем так, а не переписывать каждое место: селектов в приложении десятки,
     * часть из них рисуется строкой HTML заново при каждом обновлении (роли
     * участников, устройства звука). Поэтому компонент надстраивается над
     * настоящим `<select>` — он остаётся в DOM скрытым и остаётся источником
     * правды: `value`, события `change`/`input`, `disabled`, `options` работают для
     * остального кода как прежде, а вместо него рисуется кнопка и собственное меню.
     *
     * Как это держится:
     *  - MutationObserver на документе подхватывает новые `<select>` и убирает
     *    записи для удалённых;
     *  - на каждый select — свой наблюдатель за `<option>` и `disabled`;
     *  - программное `select.value = …` (так код выставляет значения при
     *    отрисовке настроек) перехватывается акцессором на экземпляре — иначе
     *    кнопка показывала бы старую подпись;
     *  - меню выносится в `<body>` (position: fixed): внутри модалок и
     *    прокручиваемых карточек его не обрежет overflow.
     *
     * Не трогает: `multiple`, `size > 1`, любой select с `data-native`.
     */

    const MENU_GAP = 6;
    const MENU_MAX_HEIGHT = 300;
    const VIEWPORT_PAD = 8;

    const states = new WeakMap();
    let open = null; // { select, state, menu, active }
    let typeBuffer = '';
    let typeTimer = null;

    const proto = typeof HTMLSelectElement !== 'undefined' ? HTMLSelectElement.prototype : null;
    const valueDescriptor = proto && Object.getOwnPropertyDescriptor(proto, 'value');
    const indexDescriptor = proto && Object.getOwnPropertyDescriptor(proto, 'selectedIndex');

    /**
     * Где и какой высоты открыть меню. Чистая функция — проверяется тестами без
     * DOM: вниз, пока там помещается хотя бы разумный минимум; иначе вверх, если
     * там просторнее; высота ограничена и экраном, и MENU_MAX_HEIGHT.
     */
    function computePlacement(rect, viewportHeight, contentHeight) {
        const below = viewportHeight - rect.bottom - MENU_GAP - VIEWPORT_PAD;
        const above = rect.top - MENU_GAP - VIEWPORT_PAD;
        const wanted = Math.min(contentHeight, MENU_MAX_HEIGHT);
        const placeAbove = below < Math.min(wanted, 160) && above > below;
        const room = placeAbove ? above : below;
        const height = Math.max(80, Math.min(wanted, room));
        const top = placeAbove ? rect.top - MENU_GAP - height : rect.bottom + MENU_GAP;
        return { placeAbove, height, top };
    }

    /** Индекс следующего пункта, подпись которого начинается с набранного. */
    function typeaheadIndex(labels, disabled, buffer, from) {
        const needle = String(buffer || '').toLowerCase();
        if (!needle) return -1;
        const count = labels.length;
        // Одна и та же буква подряд — перебор пунктов на неё, а не поиск «аа».
        const start = needle.length === 1 ? from + 1 : from;
        for (let step = 0; step < count; step += 1) {
            const index = (start + step + count) % count;
            if (!disabled[index] && String(labels[index]).toLowerCase().startsWith(needle)) return index;
        }
        return -1;
    }

    function shouldEnhance(select) {
        return !!select
            && select.tagName === 'SELECT'
            && !select.multiple
            && !(select.size > 1)
            && !select.hasAttribute('data-native')
            && !states.has(select);
    }

    function optionLabel(option) {
        return String(option.label || option.textContent || '').trim();
    }

    function selectedLabel(select) {
        const option = select.options[select.selectedIndex];
        return option ? optionLabel(option) : '';
    }

    /** Приглушённая подпись пункта: `<option data-hint="8 из 15 прав">`. */
    function optionHint(option) {
        return option ? String(option.getAttribute('data-hint') || '').trim() : '';
    }

    function labelFor(select) {
        const own = select.getAttribute('aria-label');
        if (own) return own;
        const label = select.labels && select.labels[0];
        return label ? String(label.textContent || '').trim() : '';
    }

    function refresh(select) {
        const state = states.get(select);
        if (!state) return;
        const text = selectedLabel(select);
        state.text.textContent = text || ' ';
        const hint = optionHint(select.options[select.selectedIndex]);
        if (hint) {
            const note = document.createElement('span');
            note.className = 'zs-hint';
            note.textContent = hint;
            state.text.append(note);
        }
        state.button.classList.toggle('is-placeholder', !text);
        state.button.disabled = !!select.disabled;
        state.button.title = select.title || '';
        const name = labelFor(select);
        if (name) state.button.setAttribute('aria-label', `${name}: ${text}${hint ? `, ${hint}` : ''}`);
        if (open && open.select === select) renderOptions();
    }

    function scheduleRefresh(select) {
        const state = states.get(select);
        if (!state || state.pending) return;
        state.pending = true;
        Promise.resolve().then(() => {
            state.pending = false;
            refresh(select);
        });
    }

    function closeMenu({ focusButton = false } = {}) {
        if (!open) return;
        const { menu, state } = open;
        open = null;
        menu.remove();
        state.button.setAttribute('aria-expanded', 'false');
        document.removeEventListener('pointerdown', onOutsidePointer, true);
        window.removeEventListener('resize', onViewportChange);
        window.removeEventListener('scroll', onScrollAnywhere, true);
        if (focusButton) state.button.focus({ preventScroll: true });
    }

    function onOutsidePointer(event) {
        if (!open) return;
        if (open.menu.contains(event.target) || open.state.button.contains(event.target)) return;
        closeMenu();
    }

    function onViewportChange() {
        closeMenu();
    }

    function onScrollAnywhere(event) {
        // Прокрутка самого меню — не повод закрывать его.
        if (open && event.target instanceof Node && open.menu.contains(event.target)) return;
        closeMenu();
    }

    function commit(select, index) {
        const option = select.options[index];
        if (!option || option.disabled) return;
        const changed = select.selectedIndex !== index;
        select.selectedIndex = index;
        refresh(select);
        if (changed) {
            select.dispatchEvent(new Event('input', { bubbles: true }));
            select.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }

    function setActive(index, { scroll = true } = {}) {
        if (!open) return;
        const items = open.menu.querySelectorAll('.zs-opt');
        open.active = index;
        items.forEach((item) => {
            const on = Number(item.dataset.index) === index;
            item.classList.toggle('is-active', on);
            if (on) {
                open.state.button.setAttribute('aria-activedescendant', item.id);
                if (scroll) item.scrollIntoView({ block: 'nearest' });
            }
        });
    }

    function renderOptions() {
        if (!open) return;
        const { select, menu } = open;
        menu.textContent = '';
        let group = null;
        Array.from(select.options).forEach((option, index) => {
            const parent = option.parentElement;
            if (parent && parent.tagName === 'OPTGROUP' && parent !== group) {
                group = parent;
                const head = document.createElement('div');
                head.className = 'zs-group';
                head.textContent = parent.label || '';
                menu.appendChild(head);
            } else if (!parent || parent.tagName !== 'OPTGROUP') {
                group = null;
            }
            const item = document.createElement('div');
            item.className = 'zs-opt';
            item.id = `${open.state.id}-o${index}`;
            item.dataset.index = String(index);
            item.setAttribute('role', 'option');
            const selected = index === select.selectedIndex;
            item.setAttribute('aria-selected', selected ? 'true' : 'false');
            if (selected) item.classList.add('is-selected');
            if (option.disabled) {
                item.classList.add('is-disabled');
                item.setAttribute('aria-disabled', 'true');
            }
            const text = document.createElement('span');
            text.className = 'zs-opt-text';
            text.textContent = optionLabel(option);
            const mark = document.createElement('span');
            mark.className = 'zs-opt-mark';
            mark.setAttribute('aria-hidden', 'true');
            mark.textContent = selected ? '✓' : '';
            const hint = optionHint(option);
            if (hint) {
                const note = document.createElement('span');
                note.className = 'zs-hint';
                note.textContent = hint;
                text.append(note);
            }
            item.append(text, mark);
            menu.appendChild(item);
        });
        setActive(Math.max(0, select.selectedIndex), { scroll: false });
    }

    function position() {
        if (!open) return;
        const { menu, state } = open;
        const rect = state.button.getBoundingClientRect();
        menu.style.minWidth = `${Math.round(rect.width)}px`;
        menu.style.maxHeight = 'none';
        // scrollHeight не включает рамку (border-box): без неё список в точности по
        // высоте содержимого получал полосу прокрутки из-за двух пикселей.
        const chrome = menu.offsetHeight - menu.clientHeight;
        const placement = computePlacement(rect, window.innerHeight, menu.scrollHeight + chrome);
        menu.style.maxHeight = `${Math.floor(placement.height)}px`;
        menu.style.top = `${Math.round(placement.top)}px`;
        const width = menu.offsetWidth;
        const left = Math.min(Math.max(VIEWPORT_PAD, rect.left), Math.max(VIEWPORT_PAD, window.innerWidth - width - VIEWPORT_PAD));
        menu.style.left = `${Math.round(left)}px`;
        menu.classList.toggle('is-above', placement.placeAbove);
    }

    function openMenu(select) {
        const state = states.get(select);
        if (!state || select.disabled) return;
        if (open && open.select === select) return;
        closeMenu();
        const menu = document.createElement('div');
        menu.className = 'zs-menu';
        menu.setAttribute('role', 'listbox');
        menu.setAttribute('aria-label', labelFor(select));
        menu.tabIndex = -1;
        open = { select, state, menu, active: 0 };
        renderOptions();
        document.body.appendChild(menu);
        state.button.setAttribute('aria-expanded', 'true');
        position();
        const active = menu.querySelector('.zs-opt.is-selected');
        if (active) active.scrollIntoView({ block: 'nearest' });
        menu.addEventListener('pointerdown', (event) => {
            // Не отдавать фокус меню: клавиатура остаётся на кнопке.
            event.preventDefault();
        });
        menu.addEventListener('click', (event) => {
            const item = event.target.closest && event.target.closest('.zs-opt');
            if (!item || item.classList.contains('is-disabled')) return;
            commit(select, Number(item.dataset.index));
            closeMenu({ focusButton: true });
        });
        menu.addEventListener('pointermove', (event) => {
            const item = event.target.closest && event.target.closest('.zs-opt');
            if (item && !item.classList.contains('is-disabled')) {
                setActive(Number(item.dataset.index), { scroll: false });
            }
        });
        document.addEventListener('pointerdown', onOutsidePointer, true);
        window.addEventListener('resize', onViewportChange);
        window.addEventListener('scroll', onScrollAnywhere, true);
    }

    function move(delta) {
        if (!open) return;
        const options = Array.from(open.select.options);
        let index = open.active;
        for (let step = 0; step < options.length; step += 1) {
            index = (index + delta + options.length) % options.length;
            if (!options[index].disabled) {
                setActive(index);
                return;
            }
        }
    }

    function onKeyDown(event, select) {
        const key = event.key;
        if (!open || open.select !== select) {
            if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ') {
                event.preventDefault();
                openMenu(select);
            } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                // Набор буквы на закрытом списке выбирает сразу, как у системного.
                const options = Array.from(select.options);
                typeBuffer += key;
                clearTimeout(typeTimer);
                typeTimer = setTimeout(() => { typeBuffer = ''; }, 700);
                const found = typeaheadIndex(options.map(optionLabel), options.map(o => o.disabled), typeBuffer, select.selectedIndex);
                if (found >= 0) commit(select, found);
            }
            return;
        }
        switch (key) {
            case 'ArrowDown': event.preventDefault(); move(1); break;
            case 'ArrowUp': event.preventDefault(); move(-1); break;
            case 'Home': event.preventDefault(); open.active = -1; move(1); break;
            case 'End': event.preventDefault(); open.active = 0; move(-1); break;
            case 'Enter':
            case ' ':
                event.preventDefault();
                commit(select, open.active);
                closeMenu({ focusButton: true });
                break;
            case 'Escape':
                event.preventDefault();
                event.stopPropagation();
                closeMenu({ focusButton: true });
                break;
            case 'Tab':
                closeMenu();
                break;
            default:
                if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                    const options = Array.from(select.options);
                    typeBuffer += key;
                    clearTimeout(typeTimer);
                    typeTimer = setTimeout(() => { typeBuffer = ''; }, 700);
                    const found = typeaheadIndex(options.map(optionLabel), options.map(o => o.disabled), typeBuffer, open.active);
                    if (found >= 0) setActive(found);
                }
        }
    }

    let counter = 0;

    function enhance(select) {
        if (!shouldEnhance(select)) return;
        const button = document.createElement('button');
        button.type = 'button';
        // Классы select переносятся на кнопку: размеры, рамка и отступы остаются
        // теми, что у поля (`settings-input`, `server-member-role` и т. п.).
        button.className = `zs-btn ${select.className}`.trim().replace(/\bzs-native\b/g, '');
        button.setAttribute('aria-haspopup', 'listbox');
        button.setAttribute('aria-expanded', 'false');
        const text = document.createElement('span');
        text.className = 'zs-text';
        const chevron = document.createElement('span');
        chevron.className = 'zs-chevron';
        chevron.setAttribute('aria-hidden', 'true');
        button.append(text, chevron);

        counter += 1;
        const state = { button, text, id: `zs${counter}`, pending: false, observer: null };
        states.set(select, state);

        select.classList.add('zs-native');
        select.tabIndex = -1;
        select.setAttribute('aria-hidden', 'true');
        select.insertAdjacentElement('afterend', button);

        button.addEventListener('click', () => {
            if (open && open.select === select) closeMenu();
            else openMenu(select);
        });
        button.addEventListener('keydown', (event) => onKeyDown(event, select));

        if (valueDescriptor && indexDescriptor) {
            Object.defineProperty(select, 'value', {
                configurable: true,
                get() { return valueDescriptor.get.call(this); },
                set(next) { valueDescriptor.set.call(this, next); scheduleRefresh(this); },
            });
            Object.defineProperty(select, 'selectedIndex', {
                configurable: true,
                get() { return indexDescriptor.get.call(this); },
                set(next) { indexDescriptor.set.call(this, next); scheduleRefresh(this); },
            });
        }
        state.observer = new MutationObserver(() => scheduleRefresh(select));
        state.observer.observe(select, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['disabled', 'label', 'selected', 'title'],
        });
        // Сброс формы возвращает значения по умолчанию без событий.
        const form = select.form;
        if (form) form.addEventListener('reset', () => setTimeout(() => refresh(select), 0));
        refresh(select);
    }

    function release(select) {
        const state = states.get(select);
        if (!state) return;
        if (open && open.select === select) closeMenu();
        if (state.observer) state.observer.disconnect();
        state.button.remove();
        states.delete(select);
    }

    function scan(root) {
        if (!root || root.nodeType !== 1) return;
        if (root.tagName === 'SELECT') {
            enhance(root);
            return;
        }
        root.querySelectorAll && root.querySelectorAll('select').forEach(enhance);
    }

    function sweepRemoved(root) {
        if (!root || root.nodeType !== 1) return;
        const list = root.tagName === 'SELECT' ? [root] : Array.from(root.querySelectorAll ? root.querySelectorAll('select') : []);
        list.forEach((select) => {
            if (!select.isConnected) release(select);
        });
    }

    function start() {
        if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
        scan(document.body);
        new MutationObserver((records) => {
            for (const record of records) {
                record.removedNodes.forEach(sweepRemoved);
                record.addedNodes.forEach(scan);
            }
        }).observe(document.body, { childList: true, subtree: true });
    }

    window.ZaliSelect = Object.freeze({
        enhance,
        refresh,
        close: closeMenu,
        // Для тестов (scripts/*_doctor): чистые функции без DOM.
        computePlacement,
        typeaheadIndex,
    });

    if (typeof document !== 'undefined') {
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
        else start();
    }
})();
