// --- ZaliInterface: Векторная стена автографов: рисование, публикация, модерация. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Всё здесь — вектор, и это не стилистическое предпочтение, а требование к
// формату: автограф хранится списком путей SVG (`d`, цвет, толщина) и
// положением на стене в ДОЛЯХ её ширины/высоты. Ни на одном шаге не возникает
// растра — ни при рисовании (никакого canvas.toDataURL), ни при хранении, ни
// при показе. Поэтому стена одинаково раскладывается на телефоне и на 5K,
// масштабируется без мыла и весит килобайты, а не мегабайты.
//
// Система координат
// -----------------
// Внутри стены всё меряется в её собственных единицах: WALL_W × WALL_H. Указатель
// переводится в них линейно (`preserveAspectRatio="none"` + фиксированный
// aspect-ratio у контейнера дают точное соответствие в обе стороны). При
// публикации рисунок обрезается по своей bbox: штрихи сдвигаются в начало
// координат, bbox становится собственным viewBox автографа, а место на стене
// уезжает в доли. Обратно это собирается вложенным <svg x y width height
// viewBox>, то есть один в один — без накопления ошибок масштабирования.
//
// Производительность
// ------------------
// Во время рисования НИЧЕГО не перерисовывается через innerHTML: на pointerdown
// создаётся один <path>, на pointermove ему меняется атрибут `d`. Полная
// перерисовка оверлея на каждое движение мыши подвесила бы вкладку и заодно
// сорвала бы захват указателя.
ZaliMixin(ZaliInterface, class {

    /** Единицы измерения стены. Отношение фиксировано и совпадает с CSS aspect-ratio. */
    static get WALL_W() { return 1000; }
    static get WALL_H() { return 600; }

    /** Палитра рисования. Совпадает по духу с брендовыми цветами интерфейса. */
    static get autographPalette() {
        return ['#cbff00', '#ffffff', '#ff5c8a', '#4fc3ff', '#ffb347', '#b48cff', '#4be08a', '#111111'];
    }

    static get AUTOGRAPH_MIN_POINT_DISTANCE() { return 1.6; }
    static get AUTOGRAPH_MAX_STROKES() { return 400; }
    static get AUTOGRAPH_MAX_POINTS_PER_STROKE() { return 1200; }

    // ------------------------------------------------------------
    // Загрузка
    // ------------------------------------------------------------

    async loadProfileAutographs() {
        const name = this.ensureProfileState().username;
        if (!name) return;
        this.setProfileState({ autographsLoading: true });
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.autographs(name, 'approved'));
            if (this.ensureProfileState().username !== name) return;
            if (!res.ok) {
                this.setProfileState({ autographsLoading: false, autographs: [] });
                return;
            }
            const body = await res.json();
            this.setProfileState({
                autographsLoading: false,
                autographs: Array.isArray(body?.autographs) ? body.autographs : [],
            });
        } catch (e) {
            this.setProfileState({ autographsLoading: false });
        }
    }

    /** Очередь модерации. Сервер отдаёт её только владельцу стены. */
    async loadPendingAutographs() {
        const state = this.ensureProfileState();
        const name = state.username;
        if (!name || !state.data?.isSelf) return;
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.autographs(name, 'pending'));
            if (this.ensureProfileState().username !== name) return;
            if (!res.ok) return;
            const body = await res.json();
            this.setProfileState({
                pendingAutographs: Array.isArray(body?.autographs) ? body.autographs : [],
            });
        } catch (e) {
            // Не критично: очередь перечитается при следующем заходе на вкладку.
        }
    }

    async moderateAutograph(autographId, action) {
        const id = String(autographId || '').trim();
        if (!id) return;
        const state = this.ensureProfileState();
        // Оптимистично убираем карточку из очереди — ответ «да/нет» должен
        // ощущаться мгновенным, а список всё равно перечитывается следом.
        this.setProfileState({
            pendingAutographs: (state.pendingAutographs || []).filter(item => item.id !== id),
        });
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.autographModeration(id), {
                method: 'POST',
                interactive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action }),
            });
            if (!res.ok) {
                await this.loadPendingAutographs();
                return;
            }
            if (action === 'approve') await this.loadProfileAutographs();
            await this.refreshProfile();
        } catch (e) {
            await this.loadPendingAutographs();
        }
    }

    /** Убрать чужой автограф со стены (владелец) или свой (автор). */
    async removeAutograph(autographId) {
        const id = String(autographId || '').trim();
        if (!id) return;
        const state = this.ensureProfileState();
        this.setProfileState({ autographs: (state.autographs || []).filter(item => item.id !== id) });
        try {
            await this.apiFetch(this.apiRoutes.profiles.autographModeration(id), {
                method: 'POST',
                interactive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete' }),
            });
        } catch (e) {
            await this.loadProfileAutographs();
        }
    }

    // ------------------------------------------------------------
    // Отрисовка
    // ------------------------------------------------------------

    /** Округление до 0.1 единицы: экономит байты и не влияет на вид. */
    autographRound(value) {
        return Math.round((Number(value) || 0) * 10) / 10;
    }

    /**
     * Гладкая кривая по точкам: середины отрезков как опорные точки, сами
     * точки — как контрольные. Ломаная из `L` на подписи выглядит рублеными
     * гранями, особенно на медленном движении мыши.
     * Алфавит — только `M`/`Q`/`L`, числа и разделители, то есть ровно то, что
     * пропускает валидатор на сервере.
     */
    autographPathData(points) {
        const list = Array.isArray(points) ? points : [];
        if (!list.length) return '';
        const r = (n) => this.autographRound(n);
        if (list.length === 1) {
            // Точка-клик: нулевой длины путь не рисуется вообще, поэтому даём
            // ему микроскопическую длину — с круглым linecap это ровная точка.
            const p = list[0];
            return `M ${r(p.x)} ${r(p.y)} L ${r(p.x + 0.1)} ${r(p.y)}`;
        }
        let d = `M ${r(list[0].x)} ${r(list[0].y)}`;
        for (let i = 1; i < list.length - 1; i++) {
            const mx = (list[i].x + list[i + 1].x) / 2;
            const my = (list[i].y + list[i + 1].y) / 2;
            d += ` Q ${r(list[i].x)} ${r(list[i].y)} ${r(mx)} ${r(my)}`;
        }
        const last = list[list.length - 1];
        d += ` L ${r(last.x)} ${r(last.y)}`;
        return d;
    }

    /** Один автограф как вложенный <svg>: своя система координат внутри бокса на стене. */
    renderAutographNode(autograph, { interactive = true } = {}) {
        const W = ZaliInterface.WALL_W;
        const H = ZaliInterface.WALL_H;
        const x = this.autographRound((Number(autograph?.x) || 0) * W);
        const y = this.autographRound((Number(autograph?.y) || 0) * H);
        const width = Math.max(1, this.autographRound((Number(autograph?.width) || 0) * W));
        const height = Math.max(1, this.autographRound((Number(autograph?.height) || 0) * H));
        const rotation = Number(autograph?.rotation) || 0;
        const viewBox = this.esc(String(autograph?.viewBox || '0 0 100 100'));
        const author = String(autograph?.author || '');
        const paths = (Array.isArray(autograph?.strokes) ? autograph.strokes : []).map(stroke => (
            `<path d="${this.esc(stroke?.d || '')}" fill="none" stroke="${this.esc(this.safeCssColor(stroke?.color) || '#cbff00')}" stroke-width="${Number(stroke?.width) || 2}" stroke-linecap="round" stroke-linejoin="round"></path>`
        )).join('');

        const inner = `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${viewBox}" preserveAspectRatio="none" overflow="visible">${paths}</svg>`;
        const rotated = rotation
            ? `<g transform="rotate(${this.autographRound(rotation)} ${this.autographRound(x + width / 2)} ${this.autographRound(y + height / 2)})">${inner}</g>`
            : inner;

        if (!interactive) return rotated;
        return `<g class="autograph-node" data-autograph-id="${this.esc(autograph?.id || '')}" data-autograph-author="${this.esc(author)}">
            <title>${this.esc(`Автограф: ${author}`)}</title>
            ${rotated}
        </g>`;
    }

    /** Сетка фона — тоже вектор, паттерном, а не картинкой. */
    renderAutographWallDefs() {
        return `<defs>
            <pattern id="autographGrid" width="50" height="50" patternUnits="userSpaceOnUse">
                <path d="M 50 0 L 0 0 0 50" fill="none" stroke="currentColor" stroke-width="1" opacity="0.10"></path>
            </pattern>
        </defs>`;
    }

    renderAutographWall() {
        const state = this.ensureProfileState();
        const W = ZaliInterface.WALL_W;
        const H = ZaliInterface.WALL_H;
        const drawing = state.drawing;
        const approved = Array.isArray(state.autographs) ? state.autographs : [];

        const nodes = approved.map(item => this.renderAutographNode(item)).join('');
        const empty = !approved.length && !drawing
            ? `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" dominant-baseline="middle" class="autograph-wall-empty-text">Стена пуста — оставьте первый автограф</text>`
            : '';

        return `<div class="autograph-wall${drawing ? ' drawing' : ''}" id="autographWall">
            <svg class="autograph-wall-svg" id="autographWallSvg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Стена автографов">
                ${this.renderAutographWallDefs()}
                <rect x="0" y="0" width="${W}" height="${H}" fill="url(#autographGrid)"></rect>
                <g class="autograph-wall-nodes">${nodes}</g>
                ${empty}
                <g class="autograph-draft-layer" id="autographDraftLayer"></g>
            </svg>
        </div>`;
    }

    /** Маленький превью-SVG для карточки в очереди модерации. */
    renderAutographPreview(autograph) {
        const viewBox = this.esc(String(autograph?.viewBox || '0 0 100 100'));
        const paths = (Array.isArray(autograph?.strokes) ? autograph.strokes : []).map(stroke => (
            `<path d="${this.esc(stroke?.d || '')}" fill="none" stroke="${this.esc(this.safeCssColor(stroke?.color) || '#cbff00')}" stroke-width="${Number(stroke?.width) || 2}" stroke-linecap="round" stroke-linejoin="round"></path>`
        )).join('');
        return `<svg class="autograph-preview-svg" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Автограф">${paths}</svg>`;
    }

    // ------------------------------------------------------------
    // Рисование
    // ------------------------------------------------------------

    startAutographDrawing() {
        const state = this.ensureProfileState();
        if (!state.data?.canAutograph) return;
        this.setProfileState({
            tab: 'wall',
            drawing: {
                strokes: [],
                color: ZaliInterface.autographPalette[0],
                width: 4,
                submitting: false,
                error: '',
            },
        });
    }

    cancelAutographDrawing({ silent = false } = {}) {
        const state = this.S.profile;
        if (!state?.drawing) return;
        this._autographActiveStroke = null;
        this._autographActivePath = null;
        if (silent) {
            // Закрытие оверлея: перерисовывать нечего и незачем.
            this.S.profile = { ...state, drawing: null };
            return;
        }
        this.setProfileState({ drawing: null });
    }

    setAutographColor(color) {
        const state = this.ensureProfileState();
        if (!state.drawing) return;
        const safe = this.safeCssColor(color) || ZaliInterface.autographPalette[0];
        this.setProfileState({ drawing: { ...state.drawing, color: safe } });
    }

    setAutographWidth(width) {
        const state = this.ensureProfileState();
        if (!state.drawing) return;
        const value = Math.min(40, Math.max(1, Number(width) || 4));
        this.setProfileState({ drawing: { ...state.drawing, width: value } });
    }

    undoAutographStroke() {
        const state = this.ensureProfileState();
        if (!state.drawing) return;
        const strokes = (state.drawing.strokes || []).slice(0, -1);
        this.setProfileState({ drawing: { ...state.drawing, strokes } });
    }

    clearAutographStrokes() {
        const state = this.ensureProfileState();
        if (!state.drawing) return;
        this.setProfileState({ drawing: { ...state.drawing, strokes: [] } });
    }

    /**
     * Клиентские координаты → единицы стены. Внешний svg объявлен с
     * `preserveAspectRatio="none"`, поэтому отображение линейно по обеим осям
     * и обратимо без поправок на «letterbox».
     */
    autographPointFromEvent(svg, event) {
        const rect = svg.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        const x = ((event.clientX - rect.left) / rect.width) * ZaliInterface.WALL_W;
        const y = ((event.clientY - rect.top) / rect.height) * ZaliInterface.WALL_H;
        return {
            x: Math.min(ZaliInterface.WALL_W, Math.max(0, x)),
            y: Math.min(ZaliInterface.WALL_H, Math.max(0, y)),
        };
    }

    /**
     * Навешивает обработчики указателя на свежеотрисованную стену. Вызывается
     * из рендера профиля: узлы заменяются целиком, поэтому слушатели каждый раз
     * ставятся заново — на новый элемент, а не на выброшенный старый.
     */
    bindAutographSurface() {
        const svg = document.getElementById('autographWallSvg');
        if (!svg || svg.dataset.autographBound === '1') return;
        svg.dataset.autographBound = '1';

        const draftLayer = () => document.getElementById('autographDraftLayer');

        const beginStroke = (event) => {
            const state = this.ensureProfileState();
            if (!state.drawing) return;
            if (event.button !== undefined && event.button !== 0) return;
            if ((state.drawing.strokes || []).length >= ZaliInterface.AUTOGRAPH_MAX_STROKES) return;
            const point = this.autographPointFromEvent(svg, event);
            if (!point) return;
            event.preventDefault();
            try { svg.setPointerCapture(event.pointerId); } catch (e) {}

            this._autographActiveStroke = {
                points: [point],
                color: state.drawing.color,
                width: state.drawing.width,
            };
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', this._autographActiveStroke.color);
            path.setAttribute('stroke-width', String(this._autographActiveStroke.width));
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('stroke-linejoin', 'round');
            path.setAttribute('d', this.autographPathData(this._autographActiveStroke.points));
            draftLayer()?.appendChild(path);
            this._autographActivePath = path;
        };

        const extendStroke = (event) => {
            const stroke = this._autographActiveStroke;
            if (!stroke || !this._autographActivePath) return;
            const point = this.autographPointFromEvent(svg, event);
            if (!point) return;
            const last = stroke.points[stroke.points.length - 1];
            const dx = point.x - last.x;
            const dy = point.y - last.y;
            // Прореживание по расстоянию: указатель сыплет событиями чаще, чем
            // это различимо глазом, а каждая лишняя точка — байты в базе и
            // работа при каждом показе стены.
            if (dx * dx + dy * dy < ZaliInterface.AUTOGRAPH_MIN_POINT_DISTANCE ** 2) return;
            if (stroke.points.length >= ZaliInterface.AUTOGRAPH_MAX_POINTS_PER_STROKE) return;
            stroke.points.push(point);
            this._autographActivePath.setAttribute('d', this.autographPathData(stroke.points));
        };

        const endStroke = (event) => {
            const stroke = this._autographActiveStroke;
            this._autographActiveStroke = null;
            this._autographActivePath = null;
            if (event?.pointerId !== undefined) {
                try { svg.releasePointerCapture(event.pointerId); } catch (e) {}
            }
            if (!stroke || !stroke.points.length) return;
            const state = this.ensureProfileState();
            if (!state.drawing) return;
            // Штрих переезжает в состояние, и перерисовка стены показывает его
            // уже из общего списка — черновой слой при этом очищается.
            this.setProfileState({
                drawing: { ...state.drawing, strokes: [...(state.drawing.strokes || []), stroke], error: '' },
            });
        };

        svg.addEventListener('pointerdown', beginStroke);
        svg.addEventListener('pointermove', extendStroke);
        svg.addEventListener('pointerup', endStroke);
        svg.addEventListener('pointercancel', endStroke);
        // Уход указателя за пределы окна без pointerup (частый случай при
        // быстром росчерке к краю) иначе оставил бы штрих незакрытым навсегда.
        svg.addEventListener('pointerleave', (event) => {
            if (this._autographActiveStroke) endStroke(event);
        });
    }

    /** Черновые штрихи рисуются из состояния — вызывается после каждой перерисовки стены. */
    renderAutographDraft() {
        const layer = document.getElementById('autographDraftLayer');
        if (!layer) return;
        const drawing = this.ensureProfileState().drawing;
        if (!drawing) {
            layer.innerHTML = '';
            return;
        }
        layer.innerHTML = (drawing.strokes || []).map(stroke => (
            `<path d="${this.esc(this.autographPathData(stroke.points))}" fill="none" stroke="${this.esc(this.safeCssColor(stroke.color) || '#cbff00')}" stroke-width="${Number(stroke.width) || 4}" stroke-linecap="round" stroke-linejoin="round"></path>`
        )).join('');
    }

    /**
     * Обрезает рисунок по его собственной bbox и отправляет.
     *
     * Сдвиг в начало координат — не косметика: без него viewBox автографа был бы
     * размером со всю стену, и рисунок в углу занимал бы прямоугольник во всю
     * стену, перекрывая соседей своей (пустой) областью.
     */
    async submitAutograph() {
        const state = this.ensureProfileState();
        const drawing = state.drawing;
        const owner = state.username;
        if (!drawing || !owner || drawing.submitting) return;
        const strokes = (drawing.strokes || []).filter(stroke => stroke.points?.length);
        if (!strokes.length) {
            this.setProfileState({ drawing: { ...drawing, error: 'Сначала нарисуйте что-нибудь' } });
            return;
        }

        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        strokes.forEach(stroke => {
            // Половина толщины с каждой стороны: иначе край штриха обрезался бы
            // границей viewBox, и вся линия выглядела бы «съеденной».
            const pad = (Number(stroke.width) || 4) / 2 + 1;
            stroke.points.forEach(point => {
                minX = Math.min(minX, point.x - pad);
                minY = Math.min(minY, point.y - pad);
                maxX = Math.max(maxX, point.x + pad);
                maxY = Math.max(maxY, point.y + pad);
            });
        });
        const boxWidth = Math.max(1, maxX - minX);
        const boxHeight = Math.max(1, maxY - minY);

        const payloadStrokes = strokes.map(stroke => ({
            d: this.autographPathData(stroke.points.map(point => ({ x: point.x - minX, y: point.y - minY }))),
            color: this.safeCssColor(stroke.color) || '#cbff00',
            width: Number(stroke.width) || 4,
        }));

        this.setProfileState({ drawing: { ...drawing, submitting: true, error: '' } });
        try {
            const res = await this.apiFetch(this.apiRoutes.profiles.autographs(owner), {
                method: 'POST',
                interactive: true,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    strokes: payloadStrokes,
                    viewBox: `0 0 ${this.autographRound(boxWidth)} ${this.autographRound(boxHeight)}`,
                    x: minX / ZaliInterface.WALL_W,
                    y: minY / ZaliInterface.WALL_H,
                    width: boxWidth / ZaliInterface.WALL_W,
                    height: boxHeight / ZaliInterface.WALL_H,
                    rotation: 0,
                }),
            });
            if (res.status === 403) {
                this.setProfileState({ drawing: { ...this.ensureProfileState().drawing, submitting: false, error: 'Владелец закрыл автографы для вас' } });
                return;
            }
            if (!res.ok) {
                const message = await res.text().catch(() => '');
                this.setProfileState({ drawing: { ...this.ensureProfileState().drawing, submitting: false, error: message || 'Не удалось отправить автограф' } });
                return;
            }
            const body = await res.json().catch(() => ({}));
            this.setProfileState({ drawing: null });
            this.addLogEntry({
                type: 'SUCCESS',
                msg: body?.status === 'approved'
                    ? 'Автограф добавлен на стену'
                    : 'Автограф отправлен на одобрение владельцу',
                ts: new Date().toLocaleTimeString(),
            });
            await this.loadProfileAutographs();
        } catch (e) {
            const current = this.ensureProfileState().drawing;
            if (current) {
                this.setProfileState({ drawing: { ...current, submitting: false, error: 'Не удалось отправить автограф' } });
            }
        }
    }

});
