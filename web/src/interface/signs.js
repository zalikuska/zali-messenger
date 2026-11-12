// --- ZaliInterface: знаки — маленькие векторные иллюстрации в элементах интерфейса. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Знак — не иконка и не сцена. Иконка (uiIcon) — один штрих 1.8, говорит «что
// нажать». Сцена (scripts/build_decor.py) — крупный рисунок в пустом месте экрана.
// Знак стоит на плитке рядом с содержимым и говорит «что это за сущность»:
// монета, кошелёк, казна, карточка. Образец — монета кошелька ZaliCoin.
//
// Один рецепт на все (docs/UI_GUIDELINES.md, §4 «Знаки»):
//   • сетка 24×24, обводка currentColor, круглые концы и стыки;
//   • основной контур — 1.4–1.6;
//   • вторая ступень — деталь .9 с opacity .4 (или целый второй предмет с .45):
//     так рисунок двухтоновый одним цветом и работает в любой схеме;
//   • тело предмета — заливка тем же цветом на 12–18 % (кошелёк, коробка, сектор
//     диаграммы); мелкие точки и песок — сплошные с opacity;
//   • цвет задаёт плитка: нейтральный --text2, акцентный — когда сущность «моя»
//     или «новая/входящая». Своих цветов внутри знака нет.
ZaliMixin(ZaliInterface, class {

    static get ZALI_SIGNS() {
        const d = 'stroke-width=".9" opacity=".4"';
        // Тело предмета — заливка тем же цветом на 12–16 %: второй тон, как у сцен build_decor.py.
        const t = 'fill="currentColor" fill-opacity=".14"';
        return {
            coin: `<circle cx="12" cy="12" r="9" stroke-width="1.4"/><circle cx="12" cy="12" r="6.7" ${d}/><path d="M9.7 9.3h4.6l-4.6 5.4h4.6" stroke-width="1.6"/><path d="M10.6 12h2.8" stroke-width="1.15"/>`,
            wallet: `<path d="M4 9.2h14.6a1.9 1.9 0 0 1 1.9 1.9v6.9a1.9 1.9 0 0 1-1.9 1.9H5.9A1.9 1.9 0 0 1 4 18z" ${t}/><path d="M4 9.2l9.9-3.4a1.5 1.5 0 0 1 2 1.4v2"/><path d="M20.5 12.3h-3.2a1.75 1.75 0 0 0 0 3.5h3.2"/><circle cx="17.4" cy="14.05" r=".9" fill="currentColor" stroke="none"/><path d="M6.6 12h5.4" ${d}/>`,
            gift: `<rect x="4.8" y="11" width="14.4" height="8.8" rx="1.6" ${t}/><rect x="3.8" y="7.6" width="16.4" height="3.4" rx="1.1"/><path d="M12 7.6v12.2"/><path d="M12 7.6c-.9-2.5-4.4-3.8-4.8-1.7-.2 1.3 1.6 1.7 4.8 1.7zM12 7.6c.9-2.5 4.4-3.8 4.8-1.7.2 1.3-1.6 1.7-4.8 1.7z"/><path d="M7.3 13.6v3.4" ${d}/>`,
            chest: `<path d="M4 11.2h16v6.9a1.9 1.9 0 0 1-1.9 1.9H5.9A1.9 1.9 0 0 1 4 18.1z" ${t}/><path d="M4 11.2V9.6a4.4 4.4 0 0 1 4.4-4.4h7.2A4.4 4.4 0 0 1 20 9.6v1.6"/><path d="M8.4 5.4v5.8M15.6 5.4v5.8" ${d}/><rect x="10.4" y="9.6" width="3.2" height="4" rx=".9"/>`,
            pie: `<path d="M12 12V3.4a8.6 8.6 0 0 1 7.45 12.9z" fill="currentColor" fill-opacity=".18" stroke="none"/><circle cx="12" cy="12" r="8.6"/><path d="M12 3.4V12l7.45 4.3"/><path d="M12 12l-5.8 6.3" ${d}/><path d="M12 12 3.6 10.2" ${d}/>`,
            stack: `<ellipse cx="12" cy="6.8" rx="6.6" ry="2.6" ${t}/><path d="M5.4 6.8v3.6c0 1.45 2.95 2.6 6.6 2.6s6.6-1.15 6.6-2.6V6.8"/><path d="M5.4 10.4V14c0 1.45 2.95 2.6 6.6 2.6s6.6-1.15 6.6-2.6v-3.6"/><path d="M5.4 14v3.4c0 1.45 2.95 2.6 6.6 2.6s6.6-1.15 6.6-2.6V14"/><path d="M10.2 6.8h3.6" ${d}/>`,
            transfer: `<path d="M5 8.6h13.2M15 5.4l3.2 3.2-3.2 3.2"/><path d="M19 15.4H5.8M9 12.2l-3.2 3.2L9 18.6" opacity=".45"/>`,
            person: `<circle cx="12" cy="8.6" r="3.6" ${t}/><path d="M5.2 19.4c.6-3.4 3.4-5.6 6.8-5.6s6.2 2.2 6.8 5.6"/>`,
            people: `<circle cx="9.6" cy="9" r="3.2" ${t}/><path d="M3.8 19c.5-3 2.9-5 5.8-5s5.3 2 5.8 5"/><circle cx="16" cy="8.2" r="2.7" opacity=".45"/><path d="M16.8 13.3c2.2.3 3.8 2 4.2 4.4" opacity=".45"/>`,
            hourglass: `<path d="M7 3.8h10M7 20.2h10"/><path d="M8.2 3.8v2.6c0 2.1 3.8 3.4 3.8 5.6s-3.8 3.5-3.8 5.6v2.6M15.8 3.8v2.6c0 2.1-3.8 3.4-3.8 5.6s3.8 3.5 3.8 5.6v2.6"/><path d="M9.6 18.6c.5-1.4 1.4-2.2 2.4-2.2s1.9.8 2.4 2.2z" fill="currentColor" stroke="none" opacity=".4"/>`,
            box: `<path d="M4.4 7.4 12 3.6l7.6 3.8L12 11.2z" ${t} stroke="none"/><path d="M12 3.6l7.6 3.8v9.2L12 20.4l-7.6-3.8V7.4z"/><path d="M4.4 7.4 12 11.2l7.6-3.8M12 11.2v9.2"/><path d="M8.2 5.5l7.6 3.8" ${d}/>`,
            unassigned: `<circle cx="12" cy="12" r="8.6" stroke-dasharray="2.2 2.8"/><circle cx="12" cy="12" r="1.3" fill="currentColor" stroke="none" opacity=".4"/>`,
            display: `<rect x="3.4" y="4.6" width="17.2" height="11.6" rx="1.8" ${t}/><path d="M9 19.6h6M12 16.2v3.4"/><path d="M6.4 7.8h4.4" ${d}/>`,
            window: `<rect x="3.6" y="4.8" width="16.8" height="14.4" rx="2" ${t}/><path d="M3.6 8.6h16.8"/><circle cx="6.2" cy="6.7" r=".6" fill="currentColor" stroke="none"/><circle cx="8.2" cy="6.7" r=".6" fill="currentColor" stroke="none"/><path d="M6.8 12h6.4M6.8 15h4" ${d}/>`,
        };
    }

    /** SVG знака по имени; неизвестное имя — пустая строка (плитка остаётся пустой). */
    // Размер и цвет задаёт плитка-родитель (CSS), поэтому лишних классов знаку не нужно.
    zaliSign(name) {
        const body = ZaliInterface.ZALI_SIGNS[name];
        if (!body) return '';
        return `<svg class="zali-sign" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
    }

    /** Статическая разметка (index.html) ставит пустой `<span data-zali-sign="имя">` —
     *  знак рисуется отсюда, чтобы у каждого был ровно один источник. Заполняет
     *  только пустые плейсхолдеры: повторный вызов ничего не переписывает. */
    hydrateZaliSigns(root = document) {
        if (!root || !root.querySelectorAll) return;
        root.querySelectorAll('[data-zali-sign]').forEach(el => {
            if (el.firstElementChild) return;
            const svg = this.zaliSign(el.getAttribute('data-zali-sign'));
            if (svg) el.innerHTML = svg;
        });
    }
});
