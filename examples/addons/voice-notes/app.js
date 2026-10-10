// Голосовые заметки — пример обычных разрешений.
// microphone: zali.mic.start/stop — пишет приложение, аддону приходят байты.
// cache: сами записи (до 256 МБ); список заметок — в zali.storage.
// files: «Сохранить» отдаёт запись в загрузки.
(function () {
    'use strict';
    const $ = (id) => document.getElementById(id);
    const recordBtn = $('record');
    const cancelBtn = $('cancel');
    const timerEl = $('timer');
    const statusEl = $('status');
    const listEl = $('list');
    const emptyEl = $('empty');

    let notes = [];
    let recording = false;
    let busy = false;
    let startedAt = 0;
    let tick = 0;
    const urls = new Map();

    const EXT = { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/wav': 'wav' };
    const extFor = (mime) => EXT[String(mime || '').split(';')[0]] || 'webm';
    const fmtTime = (ms) => {
        const s = Math.round(ms / 1000);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    };
    const fmtSize = (bytes) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} КБ` : `${(bytes / 1024 / 1024).toFixed(1)} МБ`;

    function setStatus(text, isError) {
        statusEl.textContent = text || '';
        statusEl.classList.toggle('error', !!isError);
    }

    function errorText(error) {
        if (error && error.code === 'denied') return 'Нет доступа к микрофону. Разрешите его приложению в настройках системы.';
        if (error && error.code === 'not_visible') return 'Запись можно начать, только пока аддон открыт.';
        if (error && error.code === 'quota') return 'Кеш заполнен. Удалите старые заметки.';
        return (error && error.message) || 'Что-то пошло не так.';
    }

    async function saveIndex() {
        await zali.storage.set('notes', notes);
    }

    async function refreshUsage() {
        try {
            const u = await zali.cache.usage();
            $('usage').textContent = `Занято ${fmtSize(u.bytes)} из ${fmtSize(u.quota)}`;
        } catch (e) { /* не критично */ }
    }

    function render() {
        listEl.textContent = '';
        emptyEl.hidden = notes.length > 0;
        for (const note of notes.slice().reverse()) {
            const li = document.createElement('li');
            li.className = 'note';
            const head = document.createElement('div');
            head.className = 'note-head';
            const title = document.createElement('span');
            title.className = 'note-title';
            title.textContent = note.title;
            const meta = document.createElement('span');
            meta.className = 'note-meta';
            meta.textContent = `${fmtTime(note.durationMs)} · ${fmtSize(note.size)}`;
            head.append(title, meta);

            const audio = document.createElement('audio');
            audio.controls = true;
            audio.preload = 'none';
            loadUrl(note).then((url) => { if (url) audio.src = url; });

            const actions = document.createElement('div');
            actions.className = 'note-actions';
            const save = button('Сохранить файл', 'btn', () => saveNote(note));
            const del = button('Удалить', 'btn danger', () => removeNote(note, del));
            actions.append(save, del);
            li.append(head, audio, actions);
            listEl.appendChild(li);
        }
    }

    function button(text, cls, onClick) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = cls;
        b.textContent = text;
        b.addEventListener('click', onClick);
        return b;
    }

    async function loadUrl(note) {
        if (urls.has(note.id)) return urls.get(note.id);
        const bytes = await zali.cache.read(note.file).catch(() => null);
        if (!bytes) return '';
        const url = URL.createObjectURL(new Blob([bytes], { type: note.mimeType }));
        urls.set(note.id, url);
        return url;
    }

    async function toggleRecord() {
        if (busy) return;
        busy = true;
        recordBtn.disabled = true;
        try {
            if (!recording) {
                await zali.mic.start();
                recording = true;
                startedAt = Date.now();
                tick = setInterval(() => { timerEl.textContent = fmtTime(Date.now() - startedAt); }, 250);
                setStatus('Идёт запись…');
            } else {
                const result = await zali.mic.stop();
                stopUi();
                await storeNote(result);
            }
        } catch (error) {
            if (recording && error && error.code !== 'busy') stopUi();
            setStatus(errorText(error), true);
        } finally {
            busy = false;
            recordBtn.disabled = false;
            syncButtons();
        }
    }

    function stopUi() {
        recording = false;
        clearInterval(tick);
        timerEl.textContent = '0:00';
    }

    function syncButtons() {
        recordBtn.textContent = recording ? 'Остановить запись' : 'Начать запись';
        recordBtn.classList.toggle('recording', recording);
        recordBtn.classList.toggle('primary', !recording);
        cancelBtn.hidden = !recording;
        timerEl.hidden = !recording;
    }

    async function storeNote(result) {
        if (!result.data || !result.data.length) {
            setStatus('Запись пустая — ничего не сохранено.', true);
            return;
        }
        const id = Date.now().toString(36);
        const mimeType = result.mimeType || 'audio/webm';
        const note = {
            id,
            title: `Заметка от ${new Date().toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })}`,
            file: `notes/${id}.${extFor(mimeType)}`,
            mimeType,
            durationMs: result.durationMs || 0,
            size: result.data.length,
        };
        setStatus('Сохраняю…');
        await zali.cache.write(note.file, result.data);
        notes.push(note);
        await saveIndex();
        setStatus('Заметка сохранена.');
        render();
        refreshUsage();
    }

    async function cancelRecord() {
        try { await zali.mic.cancel(); } catch (e) { /* уже остановлена */ }
        stopUi();
        syncButtons();
        setStatus('Запись отменена.');
    }

    async function saveNote(note) {
        try {
            const bytes = await zali.cache.read(note.file);
            if (!bytes) throw new Error('Файл заметки пропал из кеша.');
            await zali.files.save({ name: `${note.title}.${extFor(note.mimeType)}`, data: bytes, mimeType: note.mimeType });
            setStatus('Файл сохранён в загрузки.');
        } catch (error) {
            setStatus(errorText(error), true);
        }
    }

    // Удаление — с подтверждением прямо на кнопке: второй клик в течение 4 с.
    async function removeNote(note, btn) {
        if (btn.dataset.armed !== '1') {
            btn.dataset.armed = '1';
            btn.textContent = 'Точно удалить?';
            setTimeout(() => { btn.dataset.armed = ''; btn.textContent = 'Удалить'; }, 4000);
            return;
        }
        try {
            await zali.cache.remove(note.file);
            notes = notes.filter((n) => n.id !== note.id);
            await saveIndex();
            const url = urls.get(note.id);
            if (url) URL.revokeObjectURL(url);
            urls.delete(note.id);
            setStatus('Заметка удалена.');
            render();
            refreshUsage();
        } catch (error) {
            setStatus(errorText(error), true);
        }
    }

    recordBtn.addEventListener('click', toggleRecord);
    cancelBtn.addEventListener('click', cancelRecord);

    zali.ready.then(async () => {
        const saved = await zali.storage.get('notes').catch(() => null);
        notes = Array.isArray(saved) ? saved : [];
        render();
        refreshUsage();
    }).catch((error) => setStatus(errorText(error), true));
})();
