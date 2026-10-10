// Змейка — пример аддона без разрешений. Из SDK нужны только zali.storage
// (рекорд) и событие visibility (пауза, когда аддон свернули).
(function () {
    'use strict';
    const CELLS = 20;
    const TICK_MS = 120;
    const canvas = document.getElementById('board');
    const ctx = canvas.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const color = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    const ACCENT = color('--zali-accent', '#cbff00');
    const DANGER = color('--zali-danger', '#ff4d6d');
    const GRID = color('--zali-border', 'rgba(255,255,255,.07)');

    const $ = (id) => document.getElementById(id);
    const overlay = $('overlay');
    const overlayText = $('overlayText');
    const startBtn = $('start');
    const pauseBtn = $('pause');

    const DIRS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };
    let snake, dir, nextDir, food, score, best = 0, timer = 0, state = 'idle';

    zali.storage.get('best').then((value) => {
        best = Number(value) || 0;
        $('best').textContent = best;
    }).catch(() => {});

    function reset() {
        snake = [[9, 10], [8, 10], [7, 10]];
        dir = nextDir = 'right';
        score = 0;
        $('score').textContent = '0';
        placeFood();
    }

    function placeFood() {
        const taken = new Set(snake.map(([x, y]) => x + ',' + y));
        const free = [];
        for (let x = 0; x < CELLS; x += 1) for (let y = 0; y < CELLS; y += 1) if (!taken.has(x + ',' + y)) free.push([x, y]);
        food = free[Math.floor(Math.random() * free.length)];
    }

    function setState(next, text) {
        state = next;
        clearInterval(timer);
        timer = 0;
        if (next === 'running') timer = setInterval(step, TICK_MS);
        overlay.hidden = next === 'running';
        pauseBtn.textContent = next === 'paused' ? 'Продолжить' : 'Пауза';
        pauseBtn.disabled = next === 'idle' || next === 'over';
        if (text) overlayText.textContent = text;
        startBtn.textContent = next === 'paused' ? 'Продолжить' : next === 'over' ? 'Сыграть ещё' : 'Начать игру';
        if (next !== 'running') startBtn.focus();
    }

    function start() {
        if (state !== 'paused') reset();
        setState('running');
        draw();
    }

    function step() {
        const [dx, dy] = DIRS[nextDir];
        dir = nextDir;
        const [hx, hy] = snake[0];
        const head = [hx + dx, hy + dy];
        const hitWall = head[0] < 0 || head[1] < 0 || head[0] >= CELLS || head[1] >= CELLS;
        // Хвост в этот ход уйдёт — в его клетку можно.
        const body = snake.slice(0, -1);
        if (hitWall || body.some(([x, y]) => x === head[0] && y === head[1])) return gameOver();
        snake.unshift(head);
        if (head[0] === food[0] && head[1] === food[1]) {
            score += 1;
            $('score').textContent = score;
            if (snake.length === CELLS * CELLS) return gameOver();
            placeFood();
        } else {
            snake.pop();
        }
        draw();
    }

    function gameOver() {
        const record = score > best;
        if (record) {
            best = score;
            $('best').textContent = best;
            zali.storage.set('best', best).catch(() => {});
        }
        draw();
        setState('over', record ? `Новый рекорд: ${score}!` : `Игра окончена. Счёт: ${score}.`);
    }

    function draw() {
        const size = canvas.width / CELLS;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = GRID;
        ctx.lineWidth = 1;
        for (let i = 1; i < CELLS; i += 1) {
            ctx.beginPath(); ctx.moveTo(i * size, 0); ctx.lineTo(i * size, canvas.height); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, i * size); ctx.lineTo(canvas.width, i * size); ctx.stroke();
        }
        if (food) {
            ctx.fillStyle = DANGER;
            ctx.beginPath();
            ctx.arc((food[0] + 0.5) * size, (food[1] + 0.5) * size, size * 0.35, 0, Math.PI * 2);
            ctx.fill();
        }
        snake.forEach(([x, y], i) => {
            ctx.globalAlpha = i === 0 ? 1 : 0.75;
            ctx.fillStyle = ACCENT;
            ctx.fillRect(x * size + 2, y * size + 2, size - 4, size - 4);
        });
        ctx.globalAlpha = 1;
    }

    function turn(name) {
        if (!DIRS[name]) return;
        const [dx, dy] = DIRS[name];
        const [cx, cy] = DIRS[dir];
        if (dx === -cx && dy === -cy) return;
        nextDir = name;
    }

    const KEYS = {
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right',
    };
    document.addEventListener('keydown', (e) => {
        if (KEYS[e.code]) {
            e.preventDefault();
            if (state === 'running') turn(KEYS[e.code]);
        } else if (e.code === 'Space') {
            e.preventDefault();
            if (state === 'running') setState('paused', 'Пауза.');
            else start();
        } else if (e.code === 'Escape') {
            zali.ui.collapse();
        }
    });

    let touch = null;
    canvas.addEventListener('touchstart', (e) => { touch = e.touches[0]; }, { passive: true });
    canvas.addEventListener('touchend', (e) => {
        if (!touch) return;
        const t = e.changedTouches[0];
        const dx = t.clientX - touch.clientX;
        const dy = t.clientY - touch.clientY;
        touch = null;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
        turn(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
    });
    document.querySelectorAll('[data-dir]').forEach((btn) => {
        btn.addEventListener('click', () => turn(btn.dataset.dir));
    });

    startBtn.addEventListener('click', start);
    pauseBtn.addEventListener('click', () => {
        if (state === 'running') setState('paused', 'Пауза.');
        else if (state === 'paused') start();
    });
    // Свёрнутый аддон работает дальше — играть вслепую нечестно, ставим паузу.
    zali.on('visibility', ({ visible }) => {
        if (!visible && state === 'running') setState('paused', 'Пауза.');
    });

    reset();
    draw();
    setState('idle');
})();
