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

    document.addEventListener('keydown', (e) => {
        if (e.metaKey || e.ctrlKey || e.altKey) return;
        if (e.key === 'Tab' || (NAV_KEYS.has(e.key) && !isTextEditing(e.target))) setKeyboard(true);
    }, true);
    document.addEventListener('pointerdown', () => setKeyboard(false), true);

    window.ZaliFocusModality = {
        isKeyboard: () => root.hasAttribute('data-kbd-focus'),
    };
})();
