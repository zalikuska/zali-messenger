// --- ZaliInterface: подсказки имён в полях, куда логин вводят руками. ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Любое `<input data-user-suggest>` получает выпадающий список: при фокусе — те,
// с кем у вас есть связь, при вводе — совпадения по имени. Порядок считает сервер
// (`GET /api/users/suggest`): сначала те, кем вы пользуетесь чаще всего (личка,
// переводы), затем друзья, затем люди с общими друзьями, контакты и общие серверы.
// Без сети список строится из локальных контактов.
//
// Необязательные атрибуты поля:
//   data-user-suggest-self   — предложить «Вы» первым (вывод из казны себе);
//   data-user-suggest-pool   — имя источника доп. кандидатов (`treasury`).
//
// Выбор пункта кладёт имя в поле и шлёт `input`+`change` — поле само решает,
// что дальше (отправить, добавить в список).

const ZALI_SUGGEST_LIMIT = 6;
const ZALI_SUGGEST_CACHE_MS = 15000;

ZaliMixin(ZaliInterface, class {

    bindUserSuggestEvents() {
        if (this._userSuggestBound) return;
        this._userSuggestBound = true;
        const fieldOf = (target) => (target && target.closest ? target.closest('input[data-user-suggest]') : null);

        document.addEventListener('focusin', (e) => {
            if (this._userSuggestPicking) return;
            const input = fieldOf(e.target);
            if (input) this.showUserSuggest(input);
            else if (!e.target.closest?.('.us-menu')) this.hideUserSuggest();
        });
        document.addEventListener('input', (e) => {
            if (this._userSuggestPicking) return;
            const input = fieldOf(e.target);
            if (input) this.showUserSuggest(input);
        });
        document.addEventListener('keydown', (e) => {
            const menu = this._userSuggest;
            if (!menu) return;
            const input = fieldOf(e.target);
            if (!input || input !== menu.input) return;
            const count = menu.items.length;
            if (e.key === 'Escape') {
                // Закрываем только список: окно под ним остаётся.
                e.preventDefault();
                e.stopPropagation();
                this.hideUserSuggest();
            } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count) {
                e.preventDefault();
                const step = e.key === 'ArrowDown' ? 1 : -1;
                menu.active = (menu.active + step + count) % count;
                this.paintUserSuggestActive();
            } else if (e.key === 'Enter' && menu.active >= 0 && menu.items[menu.active]) {
                // Выбран пункт — Enter берёт его, а не отправляет форму.
                e.preventDefault();
                e.stopPropagation();
                this.pickUserSuggest(menu.items[menu.active].username);
            } else if (e.key === 'Tab') {
                this.hideUserSuggest();
            }
        }, true);
        // mousedown, а не click: поле не должно потерять фокус до выбора.
        document.addEventListener('mousedown', (e) => {
            const option = e.target.closest?.('.us-opt');
            if (option) {
                e.preventDefault();
                this.pickUserSuggest(option.getAttribute('data-us-name') || '');
                return;
            }
            if (!fieldOf(e.target) && !e.target.closest?.('.us-menu')) this.hideUserSuggest();
        });
        window.addEventListener('resize', () => this.hideUserSuggest());
        window.addEventListener('blur', () => this.hideUserSuggest());
    }

    /** Локальный список — мгновенно и без сети: контакты, затем остальные известные имена. */
    localUserSuggestions(query, { includeSelf = false } = {}) {
        const q = String(query || '').trim().toLowerCase();
        const me = this.myName();
        const seen = new Set();
        const out = [];
        const add = (name, reason) => {
            const value = String(name || '').trim();
            const key = value.toLowerCase();
            if (!value || seen.has(key) || (key === String(me).toLowerCase() && !includeSelf)) return;
            if (q && !key.includes(q)) return;
            seen.add(key);
            out.push({ username: value, reason: reason || '' });
        };
        (this.S.contacts || []).forEach(name => add(name, 'в контактах'));
        const friends = this.S.profile?.friends;
        if (Array.isArray(friends)) friends.forEach(name => add(typeof name === 'string' ? name : name?.username, 'друг'));
        return out;
    }

    async fetchUserSuggestions(query) {
        const key = String(query || '').trim().toLowerCase();
        this._userSuggestCache = this._userSuggestCache || new Map();
        const hit = this._userSuggestCache.get(key);
        if (hit && Date.now() - hit.at < ZALI_SUGGEST_CACHE_MS) return hit.users;
        const res = await this.apiFetch(this.apiRoutes.users.suggest(key, ZALI_SUGGEST_LIMIT));
        if (!res.ok) throw new Error(`suggest ${res.status}`);
        const data = await res.json();
        const users = (Array.isArray(data?.users) ? data.users : [])
            .map(item => ({ username: String(item?.username || ''), reason: String(item?.reason || '') }))
            .filter(item => item.username);
        this._userSuggestCache.set(key, { at: Date.now(), users });
        return users;
    }

    userSuggestPool(input) {
        if (input.getAttribute('data-user-suggest-pool') === 'treasury') {
            const members = this._treasury?.data?.members;
            return Array.isArray(members) ? members : [];
        }
        return [];
    }

    async showUserSuggest(input) {
        if (!this.S.session?.token || input.readOnly || input.disabled) {
            this.hideUserSuggest();
            return;
        }
        const query = String(input.value || '').trim().replace(/^@/, '');
        const includeSelf = input.hasAttribute('data-user-suggest-self');
        const seq = (this._userSuggestSeq = (this._userSuggestSeq || 0) + 1);
        const compose = (ranked) => {
            const me = String(this.myName() || '');
            const lowerQuery = query.toLowerCase();
            const seen = new Set();
            const list = [];
            const push = (username, reason) => {
                const key = String(username || '').toLowerCase();
                if (!key || seen.has(key)) return;
                if (key === me.toLowerCase() && !includeSelf) return;
                seen.add(key);
                list.push({ username, reason });
            };
            if (includeSelf && me && (!lowerQuery || me.toLowerCase().includes(lowerQuery))) {
                push(me, 'вывести себе');
            }
            ranked.forEach(item => push(item.username, item.reason));
            this.userSuggestPool(input).forEach((name) => {
                if (!lowerQuery || String(name).toLowerCase().includes(lowerQuery)) push(name, 'участник сервера');
            });
            return list.slice(0, ZALI_SUGGEST_LIMIT + 2);
        };

        // Сначала то, что есть локально, затем — ответ сервера с учётом частоты.
        this.renderUserSuggest(input, compose(this.localUserSuggestions(query, { includeSelf })));
        try {
            const ranked = await this.fetchUserSuggestions(query);
            if (seq !== this._userSuggestSeq || document.activeElement !== input) return;
            this.renderUserSuggest(input, compose(ranked));
        } catch (e) {
            // Нет сети — остаётся локальный список.
        }
    }

    renderUserSuggest(input, items) {
        if (!items.length || !input.isConnected) {
            this.hideUserSuggest();
            return;
        }
        let menu = this._userSuggest;
        if (!menu || menu.input !== input) {
            this.hideUserSuggest();
            const el = document.createElement('div');
            el.className = 'us-menu';
            el.setAttribute('role', 'listbox');
            el.id = 'userSuggestMenu';
            document.body.appendChild(el);
            menu = this._userSuggest = { input, el, items: [], active: -1 };
            input.setAttribute('aria-controls', el.id);
            input.setAttribute('aria-expanded', 'true');
        }
        const previous = menu.active >= 0 ? menu.items[menu.active]?.username : '';
        menu.items = items;
        menu.active = previous ? items.findIndex(item => item.username === previous) : -1;
        menu.el.innerHTML = items.map((item, index) => `<div class="us-opt${index === menu.active ? ' is-active' : ''}" role="option" data-us-name="${this.esc(item.username)}">
            <span class="us-ava">${this.renderAvatarHTML(item.username, 'avatar-img', '')}</span>
            <span class="us-name">${this.esc(item.username)}</span>
            ${item.reason ? `<span class="us-reason">${this.esc(item.reason)}</span>` : ''}
        </div>`).join('');
        const rect = input.getBoundingClientRect();
        const width = Math.max(rect.width, 220);
        const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
        menu.el.style.width = `${Math.round(width)}px`;
        menu.el.style.left = `${Math.round(left)}px`;
        const below = window.innerHeight - rect.bottom;
        const height = Math.min(menu.el.scrollHeight, 320);
        if (below < height + 12 && rect.top > below) {
            menu.el.style.top = '';
            menu.el.style.bottom = `${Math.round(window.innerHeight - rect.top + 6)}px`;
        } else {
            menu.el.style.bottom = '';
            menu.el.style.top = `${Math.round(rect.bottom + 6)}px`;
        }
    }

    paintUserSuggestActive() {
        const menu = this._userSuggest;
        if (!menu) return;
        menu.el.querySelectorAll('.us-opt').forEach((el, index) => {
            const on = index === menu.active;
            el.classList.toggle('is-active', on);
            if (on) el.scrollIntoView({ block: 'nearest' });
        });
    }

    pickUserSuggest(username) {
        const menu = this._userSuggest;
        const name = String(username || '').trim();
        if (!menu || !name) return;
        const input = menu.input;
        this.hideUserSuggest();
        // Выбор — не ввод: свои же события не должны открывать список заново.
        this._userSuggestPicking = true;
        try {
            input.value = name;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
            input.focus({ preventScroll: true });
        } finally {
            this._userSuggestPicking = false;
        }
    }

    hideUserSuggest() {
        const menu = this._userSuggest;
        if (!menu) return;
        this._userSuggest = null;
        this._userSuggestSeq = (this._userSuggestSeq || 0) + 1;
        menu.input.removeAttribute('aria-controls');
        menu.input.setAttribute('aria-expanded', 'false');
        menu.el.remove();
    }
});
