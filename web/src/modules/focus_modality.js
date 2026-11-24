(function () {
    'use strict';

    /**
     * Кольца фокуса — только для работы с клавиатуры.
     *
     * Своя эвристика браузера (`:focus-visible`) здесь не годится: программный
     * focus() (открыли окно, меню, вернули фокус после закрытия) WebKit — а это
     * Mac-оболочка — считает «клавиатурным», если перед этим печатали в поле
     * сообщения. Поэтому кольца вылезали после обычного клика мышью.
     *
     * Признак держим сами: атрибут `data-kbd-focus` на <html> ставится клавишей
     * Tab или навигационной клавишей вне поля ввода и снимается любым нажатием
     * мыши, пальца или пера. Все правила `:focus-visible` в style.css дописаны
     * `:where([data-kbd-focus] *)` (нулевая специфичность) — без признака колец нет.
     * Поля ввода свой вид в фокусе сохраняют: он на `:focus`, а не на кольце.
     */
    const root = document.documentElement;
    const NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

    function isTextEditing(el) {
        if (!el || el.nodeType !== 1) return false;
        if (el.isContentEditable) return true;
        if (el.tagName === 'TEXTAREA') return true;
        if (el.tagName !== 'INPUT') return false;
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        return !['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file', 'image'].includes(type);
    }

    function setKeyboard(on) {
        if (on === root.hasAttribute('data-kbd-focus')) return;
        if (on) root.setAttribute('data-kbd-focus', '');
        else root.removeAttribute('data-kbd-focus');
    }

    // Стрелки на пустом месте (фокус на <body>: листают ленту) кольца не заслуживают —
    // кольцо рисовать не на чем, а признак потом оставался бы включённым до клика.
    const isIdleTarget = (el) => !el || el === document.body || el === root;

    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Tab' || (NAV_KEYS.has(e.key) && !isTextEditing(e.target) && !isIdleTarget(e.target))) setKeyboard(true);
    }, true);
    // Любое нажатие снимает признак — и на window, и на document: часть оболочек
    // и вложенных слоёв глушит событие до document. mousedown/touchstart — запасные
    // пути для движков без полноценных pointer-событий.
    const clearKeyboard = () => setKeyboard(false);
    window.addEventListener('pointerdown', clearKeyboard, true);
    document.addEventListener('pointerdown', clearKeyboard, true);
    document.addEventListener('mousedown', clearKeyboard, true);
    document.addEventListener('touchstart', clearKeyboard, { capture: true, passive: true });
    // Ушли из окна (Alt+Tab, клик в другое приложение) и вернулись: Tab от переключения
    // окон мог просочиться и включить признак — возвращаемся к окну без колец.
    window.addEventListener('blur', clearKeyboard);

    window.ZaliFocusModality = {
        isKeyboard: () => root.hasAttribute('data-kbd-focus'),
    };
})();
