// Минимальный DOM для проверок точечного обновления списков.
//
// Настоящего парсера HTML здесь нет и не нужно: список сообщений и сайдбар
// собираются из строк, каждая из которых — один элемент верхнего уровня, и
// проверке важно другое — какие узлы пережили кадр, а какие были созданы
// заново, и сколько разметки пришлось разобрать. Разбор верхнего уровня идёт по
// глубине тегов (void-элементы и самозакрывающиеся SVG-теги учтены), этого
// достаточно для разметки, которую производит web/src/interface.
const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta',
    'param', 'source', 'track', 'wbr',
]);

/** Делит HTML на куски верхнего уровня: элементы и непустые текстовые узлы. */
export function splitTopLevel(html) {
    const parts = [];
    const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*?(\/?)>/g;
    let depth = 0;
    let start = 0;
    let textStart = 0;
    let match;
    while ((match = tagRe.exec(html))) {
        const [, closing, rawName, selfClosing] = match;
        const name = rawName.toLowerCase();
        if (depth === 0 && !closing) {
            const text = html.slice(textStart, match.index);
            if (text) parts.push({ text });
            start = match.index;
        }
        if (closing) depth -= 1;
        else if (!selfClosing && !VOID_TAGS.has(name)) depth += 1;
        if (depth === 0) {
            if (!closing && (selfClosing || VOID_TAGS.has(name))) {
                parts.push({ html: html.slice(start, tagRe.lastIndex) });
            } else if (closing) {
                parts.push({ html: html.slice(start, tagRe.lastIndex) });
            }
            textStart = tagRe.lastIndex;
        }
    }
    const tail = html.slice(textStart);
    if (tail) parts.push({ text: tail });
    return parts;
}

export class MiniNode {
    constructor(doc, part) {
        this.ownerDocument = doc;
        this.parentNode = null;
        this.outerHTML = part.html ?? part.text;
        this.nodeType = part.html != null ? 1 : 3;
        doc.stats.nodesCreated += 1;
    }
    get nextSibling() {
        const parent = this.parentNode;
        if (!parent) return null;
        const list = parent.childNodes;
        return list[list.indexOf(this) + 1] || null;
    }
    remove() {
        const parent = this.parentNode;
        if (!parent) return;
        parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
        this.parentNode = null;
    }
}

export class MiniElement {
    constructor(doc, tagName = 'div') {
        this.ownerDocument = doc;
        this.tagName = tagName.toUpperCase();
        this.childNodes = [];
        this.dataset = {};
        this.style = {};
        this.scrollTop = 0;
        this.clientHeight = 800;
        this.scrollHeightReads = 0;
        if (this.tagName === 'TEMPLATE') this.content = new MiniElement(doc, 'fragment');
    }
    _parse(html) {
        const doc = this.ownerDocument;
        const value = String(html == null ? '' : html);
        doc.stats.charsParsed += value.length;
        return splitTopLevel(value).map((part) => new MiniNode(doc, part));
    }
    _adopt(nodes) {
        for (const node of nodes) {
            node.parentNode = this;
        }
        return nodes;
    }
    set innerHTML(html) {
        const target = this.content || this;
        for (const node of target.childNodes) node.parentNode = null;
        target.childNodes = target._adopt(this._parse(html));
        if (!this.content) this.ownerDocument.stats.fullWrites += 1;
    }
    get innerHTML() {
        return (this.content || this).childNodes.map((node) => node.outerHTML).join('');
    }
    get childElementCount() { return this.childNodes.filter((node) => node.nodeType === 1).length; }
    get firstChild() { return this.childNodes[0] || null; }
    get firstElementChild() { return this.childNodes.find((node) => node.nodeType === 1) || null; }
    get scrollHeight() {
        this.scrollHeightReads += 1;
        return Math.max(this.clientHeight, this.innerHTML.length / 40);
    }
    insertBefore(node, ref) {
        const moving = node instanceof MiniElement ? node.childNodes.splice(0) : [node];
        if (!(node instanceof MiniElement)) node.remove();
        const index = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
        this.childNodes.splice(index < 0 ? this.childNodes.length : index, 0, ...this._adopt(moving));
        return node;
    }
    appendChild(node) { return this.insertBefore(node, null); }
    removeChild(node) { node.remove(); return node; }
    insertAdjacentHTML(position, html) {
        if (position !== 'beforeend') throw new Error(`mini-dom: insertAdjacentHTML(${position}) не поддержан`);
        this.childNodes.push(...this._adopt(this._parse(html)));
    }
    querySelectorAll() { return []; }
    querySelector() { return null; }
    getBoundingClientRect() { return { top: 0, bottom: this.clientHeight, left: 0, right: 400 }; }
    addEventListener() {}
    removeEventListener() {}
}

export class MiniDocument {
    constructor() {
        this.stats = { nodesCreated: 0, charsParsed: 0, fullWrites: 0 };
    }
    createElement(tagName) { return new MiniElement(this, tagName); }
    resetStats() {
        this.stats.nodesCreated = 0;
        this.stats.charsParsed = 0;
        this.stats.fullWrites = 0;
    }
}
