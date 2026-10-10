// Лаунчер — пример повышенных прав.
// fs.read: zali.fs.paths/list/stat — обзор диска, чтобы выбрать программу.
// launch: zali.system.open (как двойной клик) и zali.system.exec (с аргументами).
// Ярлыки хранятся в zali.storage. Работает на macOS и Windows; в браузере и
// на Android приложение такой аддон не запустит — там нет повышенных прав.
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const statusEl = $('status');
    const listEl = $('shortcuts');
    const emptyEl = $('empty');
    const picker = $('picker');
    const pathInput = $('pathInput');
    const argsInput = $('argsInput');
    const entriesEl = $('entries');

    let shortcuts = [];
    let paths = null;
    let cwd = '';

    function setStatus(text, isError) {
        statusEl.textContent = text || '';
        statusEl.classList.toggle('error', !!isError);
    }

    const sep = () => (paths && paths.separator) || '/';
    const baseName = (path) => String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || path;
    function join(dir, name) {
        return dir.endsWith('/') || dir.endsWith('\\') ? dir + name : dir + sep() + name;
    }
    function parent(dir) {
        const trimmed = dir.replace(/[\\/]+$/, '');
        const i = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
        if (i < 0) return dir;
        const up = trimmed.slice(0, i);
        // «C:» → «C:\», «» → «/».
        if (!up) return '/';
        return /^[A-Za-z]:$/.test(up) ? up + '\\' : up;
    }
    // Аргументы: пробелы разделяют, кавычки группируют.
    function splitArgs(text) {
        const out = [];
        const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
        let m;
        while ((m = re.exec(text))) out.push(m[1] ?? m[2] ?? m[3]);
        return out;
    }

    async function saveShortcuts() {
        await zali.storage.set('shortcuts', shortcuts);
    }

    function button(text, cls, onClick, label) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = text;
        if (label) b.setAttribute('aria-label', label);
        b.addEventListener('click', onClick);
        return b;
    }

    function render() {
        listEl.textContent = '';
        emptyEl.hidden = shortcuts.length > 0;
        for (const item of shortcuts) {
            const li = document.createElement('li');
            li.className = 'card';
            const name = document.createElement('div');
            name.className = 'card-name';
            name.textContent = item.name;
            const path = document.createElement('div');
            path.className = 'card-path';
            path.textContent = item.args.length ? `${item.path} ${item.args.join(' ')}` : item.path;
            const actions = document.createElement('div');
            actions.className = 'card-actions';
            const run = button('Запустить', 'btn primary', () => launch(item), `Запустить «${item.name}»`);
            const del = button('Убрать', 'btn danger', () => removeShortcut(item, del), `Убрать ярлык «${item.name}»`);
            actions.append(run, del);
            li.append(name, path, actions);
            listEl.appendChild(li);
        }
    }

    async function launch(item) {
        try {
            const stat = await zali.fs.stat(item.path);
            if (!stat.exists) throw new Error(`«${item.path}» больше нет на диске.`);
            if (item.args.length) {
                const res = await zali.system.exec(item.path, item.args, { cwd: parent(item.path) });
                setStatus(`«${item.name}» запущен (процесс ${res.pid}).`);
            } else {
                await zali.system.open(item.path);
                setStatus(`«${item.name}» открыт.`);
            }
        } catch (error) {
            setStatus((error && error.message) || 'Не удалось запустить.', true);
        }
    }

    // Убрать ярлык — второй клик в течение 4 с. Сама программа не трогается.
    async function removeShortcut(item, btn) {
        if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.textContent = 'Точно убрать?';
            setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Убрать'; }, 4000);
            return;
        }
        shortcuts = shortcuts.filter((s) => s !== item);
        await saveShortcuts();
        render();
        setStatus(`Ярлык «${item.name}» убран.`);
    }

    async function addShortcut(path) {
        const args = splitArgs(argsInput.value.trim());
        if (shortcuts.some((s) => s.path === path && s.args.join(' ') === args.join(' '))) {
            setStatus('Такой ярлык уже есть.', true);
            return;
        }
        const name = baseName(path).replace(/\.(app|exe|lnk|bat|cmd)$/i, '');
        shortcuts.push({ name, path, args });
        await saveShortcuts();
        closePicker();
        render();
        setStatus(`Ярлык «${name}» добавлен.`);
    }

    // ---- Обзор диска ----

    async function openDir(dir) {
        setStatus('');
        entriesEl.textContent = '';
        let items;
        try {
            items = await zali.fs.list(dir);
        } catch (error) {
            setStatus((error && error.message) || 'Не удалось открыть папку.', true);
            return;
        }
        cwd = dir;
        pathInput.value = dir;
        items = items
            .filter((e) => !e.name.startsWith('.'))
            .sort((a, b) => (a.type === 'dir') === (b.type === 'dir') ? a.name.localeCompare(b.name, 'ru') : a.type === 'dir' ? -1 : 1);
        if (!items.length) {
            const li = document.createElement('li');
            li.className = 'entry muted';
            li.textContent = 'Папка пуста.';
            entriesEl.appendChild(li);
        }
        for (const entry of items.slice(0, 500)) {
            const full = join(dir, entry.name);
            // .app на macOS — папка, но запускается как программа.
            const isApp = entry.type === 'dir' && /\.app$/i.test(entry.name);
            const li = document.createElement('li');
            li.className = 'entry';
            li.tabIndex = 0;
            const kind = document.createElement('span');
            kind.className = 'entry-kind';
            kind.textContent = entry.type === 'dir' && !isApp ? '▸' : '•';
            const name = document.createElement('span');
            name.className = 'entry-name';
            name.textContent = entry.name;
            li.append(kind, name, button('Добавить', 'btn', (e) => { e.stopPropagation(); addShortcut(full); }, `Добавить «${entry.name}»`));
            const open = () => { if (entry.type === 'dir' && !isApp) openDir(full); };
            li.addEventListener('click', open);
            li.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
            entriesEl.appendChild(li);
        }
    }

    async function openPicker() {
        if (!paths) {
            try {
                paths = await zali.fs.paths();
            } catch (error) {
                setStatus((error && error.message) || 'Нет доступа к диску.', true);
                return;
            }
            const places = $('places');
            const isWin = String(paths.platform || '').startsWith('windows');
            const list = [
                ['Домашняя папка', paths.home],
                ['Рабочий стол', paths.desktop],
                ['Загрузки', paths.downloads],
                ['Программы', isWin ? 'C:\\Program Files' : '/Applications'],
            ];
            for (const [label, path] of list) {
                if (path) places.appendChild(button(label, 'btn', () => openDir(path)));
            }
        }
        picker.hidden = false;
        emptyEl.hidden = true;
        $('addBtn').disabled = true;
        await openDir(cwd || paths.home || sep());
    }

    function closePicker() {
        picker.hidden = true;
        argsInput.value = '';
        emptyEl.hidden = shortcuts.length > 0;
        $('addBtn').disabled = false;
    }

    $('addBtn').addEventListener('click', openPicker);
    $('closePicker').addEventListener('click', closePicker);
    $('upBtn').addEventListener('click', () => openDir(parent(cwd)));
    $('goBtn').addEventListener('click', () => openDir(pathInput.value.trim()));
    pathInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') openDir(pathInput.value.trim()); });

    zali.ready.then(async () => {
        const saved = await zali.storage.get('shortcuts').catch(() => null);
        shortcuts = Array.isArray(saved) ? saved : [];
        render();
    });
})();
