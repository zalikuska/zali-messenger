// --- ZaliInterface: Экранирование, иконки, форматирование времени и дат. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
const ZALI_ESCAPE_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' };
const ZALI_ESCAPE_PATTERN = /[&<>"']/g;
const ZALI_ESCAPE_PROBE = /[&<>"']/;

// Форматтеры дат создаются один раз. toLocaleTimeString()/toLocaleDateString()
// с локалью и опциями строят новый ICU-форматтер на КАЖДЫЙ вызов, а отрисовка
// списка сообщений зовёт их по три-пять раз на пузырь: замер на 78 пузырях —
// 5 из 5,8 мс кадра уходило на даты. Intl.DateTimeFormat с теми же локалью и
// опциями даёт ту же строку (toLocale*String по спецификации делегирует ему).
// Результаты дополнительно запоминаются по исходному значению метки времени:
// перерисовка того же списка просит те же самые строки.
// Форматтер запоминает часовой пояс на момент создания, поэтому раз в минуту
// пояс сверяется заново: сменили пояс системы — форматтеры и память
// пересоздаются, как это неявно делал toLocale*String().
const ZALI_FORMAT_MEMO_LIMIT = 4096;
const ZALI_TZ_RECHECK_MS = 60 * 1000;
let zaliTimeFormat = null;
let zaliDayMonthFormat = null;
let zaliFormatTimeZone = '';
let zaliFormatCheckedAt = 0;
const zaliTimeMemo = new Map();
const zaliDayMonthMemo = new Map();

function zaliEnsureFormatters() {
    const nowMs = Date.now();
    if (zaliTimeFormat && nowMs - zaliFormatCheckedAt < ZALI_TZ_RECHECK_MS) return;
    zaliFormatCheckedAt = nowMs;
    let zone = '';
    try { zone = new Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) { zone = ''; }
    if (zaliTimeFormat && zone === zaliFormatTimeZone) return;
    zaliFormatTimeZone = zone;
    zaliTimeFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
    zaliDayMonthFormat = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
    zaliTimeMemo.clear();
    zaliDayMonthMemo.clear();
}

function zaliMemoFormat(memo, key, compute) {
    let value = memo.get(key);
    if (value === undefined) {
        if (memo.size >= ZALI_FORMAT_MEMO_LIMIT) memo.clear();
        value = compute();
        memo.set(key, value);
    }
    return value;
}

// Сравнение имён в сайдбаре. localeCompare() с локалью и опциями строит
// коллатор на каждое сравнение — а сортировка контактов делает их n·log n на
// каждую перерисовку сайдбара. Тот же коллатор, созданный один раз, сравнивает
// так же.
const ZALI_NAME_COLLATOR = new Intl.Collator('ru', { sensitivity: 'base' });

// Номер локального календарного дня — то же сравнение, что toDateString(),
// без построения строк.
function zaliLocalDayIndex(date) {
    return date.getFullYear() * 400 + date.getMonth() * 32 + date.getDate();
}

ZaliMixin(ZaliInterface, class {

    // --- HTML Helper Utilities ---
    // One pass, not five. esc() is called several hundred times per render of the
    // message list and once per rendered character of every attachment URL that
    // still reaches it; five chained .replace() calls meant five full regex scans
    // of every string, and for anything without a special character all five
    // found nothing. Same output, same escapes, one traversal.
    esc(s) {
        if (s == null) return '';
        const value = String(s);
        // Fast path: the overwhelming majority of strings (names, timestamps,
        // ids, URLs) contain nothing to escape, and this test bails on the first
        // character that could matter instead of building a new string.
        // Two regexes on purpose: a /g/ one carries lastIndex across .test()
        // calls, which would make every second call lie.
        if (!ZALI_ESCAPE_PROBE.test(value)) return value;
        return value.replace(ZALI_ESCAPE_PATTERN, (ch) => ZALI_ESCAPE_MAP[ch]);
    }

    ruPlural(n, one, few, many) {
        const abs = Math.abs(Math.trunc(Number(n) || 0));
        const d10 = abs % 10;
        const d100 = abs % 100;
        if (d10 === 1 && d100 !== 11) return one;
        if (d10 >= 2 && d10 <= 4 && (d100 < 12 || d100 > 14)) return few;
        return many;
    }

    safeCssColor(value) {
        if (!value) return '';
        const trimmed = String(value).trim();
        if (/^(#[0-9a-fA-F]{3,8}|rgb\([^)]+\)|rgba\([^)]+\)|hsl\([^)]+\)|hsla\([^)]+\)|linear-gradient\([^<>"'`\n]+\)|[a-zA-Z]{2,30})$/.test(trimmed)) return trimmed;
        return '';
    }

    uiIcon(name, extraClass = '') {
        const cls = `ui-icon ui-icon-${this.esc(name)}${extraClass ? ` ${this.esc(extraClass)}` : ''}`;
        const attrs = `class="${cls}" viewBox="0 0 24 24" aria-hidden="true" focusable="false"`;
        const icons = {
            phone: `<svg ${attrs} fill="none"><path d="M7.3 4.75 9.2 8.9c.28.6.13 1.31-.36 1.75l-1.23 1.1c1.09 2.08 2.78 3.75 4.9 4.83l1.04-1.2a1.52 1.52 0 0 1 1.75-.39l4.05 1.74c.65.28 1.03.96.91 1.66l-.37 2.16c-.13.76-.8 1.3-1.57 1.25C9.4 21.25 2.77 14.68 2.22 5.75a1.5 1.5 0 0 1 1.26-1.58l2.18-.41c.69-.13 1.35.26 1.64.99Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>`,
            paperclip: `<svg ${attrs} fill="none"><path d="m8.15 12.55 5.42-5.42a3.26 3.26 0 0 1 4.62 4.61l-6.53 6.53a5.2 5.2 0 0 1-7.35-7.35l6.45-6.45a7.05 7.05 0 0 1 9.98 9.97l-6.52 6.53" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
            gear: `<svg ${attrs} fill="none"><path d="M10.4 3.25h3.2l.55 2.32c.54.2 1.05.5 1.5.87l2.27-.72 1.6 2.76-1.72 1.62c.05.3.08.6.08.9s-.03.6-.08.9l1.72 1.62-1.6 2.76-2.27-.72c-.45.37-.96.67-1.5.87l-.55 2.32h-3.2l-.55-2.32a5.78 5.78 0 0 1-1.5-.87l-2.27.72-1.6-2.76L6.2 11.9a5.6 5.6 0 0 1 0-1.8L4.48 8.48l1.6-2.76 2.27.72c.45-.37.96-.67 1.5-.87l.55-2.32Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="11" r="2.65" stroke="currentColor" stroke-width="1.8"/></svg>`,
            speaker: `<svg ${attrs} fill="none"><path d="M4 9.4v5.2h3.1l4.4 3.35V6.05L7.1 9.4H4Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M15.2 8.25a5 5 0 0 1 0 7.5M17.85 5.6a8.75 8.75 0 0 1 0 12.8" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
            hash: `<svg ${attrs} fill="none"><path d="M9.3 4.5 7.8 19.5M16.2 4.5l-1.5 15M4.75 9h14.5M4.25 15h14.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`,
            close: `<svg ${attrs} fill="none"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>`,
            bell: `<svg ${attrs} fill="none"><path d="M12 3.5a4.2 4.2 0 0 0-4.2 4.2v2.3c0 .78-.28 1.53-.79 2.12l-1.2 1.4c-.7.82-.12 2.08.96 2.08h10.46c1.08 0 1.66-1.26.96-2.08l-1.2-1.4a3.2 3.2 0 0 1-.79-2.12V7.7A4.2 4.2 0 0 0 12 3.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.9 18.5a2.1 2.1 0 0 0 4.2 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
            'bell-off': `<svg ${attrs} fill="none"><path d="M12 3.5a4.2 4.2 0 0 0-4.2 4.2v2.3c0 .78-.28 1.53-.79 2.12l-1.2 1.4c-.7.82-.12 2.08.96 2.08h10.46c1.08 0 1.66-1.26.96-2.08l-1.2-1.4a3.2 3.2 0 0 1-.79-2.12V7.7A4.2 4.2 0 0 0 12 3.5Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M9.9 18.5a2.1 2.1 0 0 0 4.2 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4.5 4.5l15 15" stroke="currentColor" stroke-width="2.1" stroke-linecap="round"/></svg>`,
            // Пункты контекстных меню и действия над сообщением. Один
            // стиль со всеми иконками выше: 24×24, обводка 1.8, круглые
            // концы — иначе строка меню с иконкой выглядит склеенной из
            // двух разных наборов.
            user: `<svg ${attrs} fill="none"><circle cx="12" cy="8.4" r="3.6" stroke="currentColor" stroke-width="1.8"/><path d="M5 19.6c.55-3.4 3.45-5.7 7-5.7s6.45 2.3 7 5.7" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
            'user-plus': `<svg ${attrs} fill="none"><circle cx="10.2" cy="8.4" r="3.6" stroke="currentColor" stroke-width="1.8"/><path d="M3.4 19.6c.5-3.3 3.3-5.7 6.8-5.7 1.05 0 2.05.18 2.95.52" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M17.6 14.1v5.9M14.65 17.05h5.9" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
            eye: `<svg ${attrs} fill="none"><path d="M2.9 12S6.7 5.9 12 5.9 21.1 12 21.1 12 17.3 18.1 12 18.1 2.9 12 2.9 12Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.85" stroke="currentColor" stroke-width="1.8"/></svg>`,
            'eye-off': `<svg ${attrs} fill="none"><path d="M6.4 6.9C4.2 8.4 2.9 12 2.9 12s3.8 6.1 9.1 6.1c1.7 0 3.2-.63 4.45-1.5M9.6 5.35A8.9 8.9 0 0 1 12 5.9c5.3 0 9.1 6.1 9.1 6.1s-.86 1.4-2.35 2.85" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M9.98 9.98a2.85 2.85 0 0 0 4.04 4.04" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4.6 4.6l14.8 14.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
            reply: `<svg ${attrs} fill="none"><path d="M9.4 6.6 4.2 11.8l5.2 5.2" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/><path d="M4.8 11.8h8.9a5.9 5.9 0 0 1 5.9 5.9v.9" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>`,
            pencil: `<svg ${attrs} fill="none"><path d="M15.05 5.5 18.5 8.95" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="m16.05 4.5 1.5 1.5a1.6 1.6 0 0 1 0 2.26L9.4 16.4l-3.4 1.1 1.1-3.4 8.14-8.15a1.6 1.6 0 0 1 2.26 0Z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M4.9 20.3h14.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>`,
            // Монета ZaliCoin — тот же «Ƶ», что в coinGiftIcon и на кнопке композера.
            coin: `<svg ${attrs} fill="none"><circle cx="12" cy="12" r="8.6" stroke="currentColor" stroke-width="1.8"/><path d="M9.5 9h5l-5 6h5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M10.5 12h3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>`,
            trash: `<svg ${attrs} fill="none"><path d="M4.9 6.9h14.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M9.7 6.9V5.5a1.4 1.4 0 0 1 1.4-1.4h1.8a1.4 1.4 0 0 1 1.4 1.4v1.4" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="m6.8 6.9.75 11.5a1.6 1.6 0 0 0 1.6 1.5h5.7a1.6 1.6 0 0 0 1.6-1.5l.75-11.5" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>`,
        };
        return icons[name] || '';
    }

    channelKindIcon(kind, extraClass = '') {
        return this.normalizeChannelKind(kind) === 'voice'
            ? this.uiIcon('speaker', extraClass)
            : this.uiIcon('hash', extraClass);
    }

    fmtTime(iso) {
        if (!iso) return '';
        zaliEnsureFormatters();
        return zaliMemoFormat(zaliTimeMemo, iso, () => {
            const date = new Date(iso);
            // Невалидная дата: форматтер бросает RangeError там, где
            // toLocaleTimeString() вернул бы строку «Invalid Date».
            if (Number.isNaN(date.getTime())) return 'Invalid Date';
            try { return zaliTimeFormat.format(date); }
            catch(e) { return ''; }
        });
    }

    // Numbers are handled explicitly, not as an afterthought: the browser
    // receive path stores `unpacked.timestamp * 1000`, i.e. a number of
    // milliseconds, while history rows carry an ISO string. Date.parse() of a
    // number is NaN, so a value-based comparator that only parsed strings would
    // silently sort every browser-delivered message to the epoch.
    messageTimestampValue(value) {
        if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
        const ts = Date.parse(value || '');
        return Number.isFinite(ts) ? ts : 0;
    }

    // Comparator for chronological message order. Exists so the sort sites stop
    // writing `new Date(a.timestamp) - new Date(b.timestamp)`, which allocated
    // two Date objects per comparison — tens of thousands of them per history
    // merge, all thrown away immediately.
    compareMessagesByTime(a, b) {
        return this.messageTimestampValue(a?.timestamp) - this.messageTimestampValue(b?.timestamp);
    }

    messageHoverTimeLabel(msg) {
        const iso = msg?.timestamp || '';
        const time = this.fmtTime(iso);
        if (!time) return '';
        const date = this.fmtDate(iso);
        return date ? `${date}, ${time}` : time;
    }

    messageInlineTimeLabel(msg) {
        return this.fmtTime(msg?.timestamp || '');
    }

    // Sidebar sorting calls this once per contact on every renderContacts(), so a
    // full scan of every conversation was O(contacts × messages) per sidebar paint
    // — tens of thousands of Date parses per incoming message on a busy account.
    // Messages are appended chronologically, so the newest timestamp lives at the
    // tail; scan backwards over a small bounded tail to stay tolerant of the slight
    // out-of-order that reconciliation can leave behind, and stop there.
    //
    // The answer is memoised per conversation against the identity of those tail
    // message objects. Messages are never mutated in place (every edit/reconcile
    // replaces the object), so identical references mean identical timestamps —
    // and one incoming message then costs one conversation's re-scan, not
    // Date.parse × 24 × every contact on each sidebar paint.
    conversationLastMessageAt(peer) {
        const msgs = Array.isArray(this.S.chats?.[peer]) ? this.S.chats[peer] : [];
        const TAIL_SCAN = 24;
        const memoMap = this._lastMessageAtMemo || (this._lastMessageAtMemo = new WeakMap());
        const tailStart = Math.max(0, msgs.length - TAIL_SCAN);
        const memo = memoMap.get(msgs);
        if (memo && memo.length === msgs.length) {
            let same = true;
            for (let i = tailStart, j = 0; i < msgs.length; i += 1, j += 1) {
                if (memo.tail[j] !== msgs[i]) { same = false; break; }
            }
            if (same) return memo.value;
        }
        let lastTs = 0;
        for (let i = msgs.length - 1; i >= tailStart; i -= 1) {
            const ts = this.messageTimestampValue(msgs[i]?.timestamp);
            if (ts > lastTs) lastTs = ts;
        }
        memoMap.set(msgs, { length: msgs.length, tail: msgs.slice(tailStart), value: lastTs });
        return lastTs;
    }

    compareContactNames(a, b) {
        return ZALI_NAME_COLLATOR.compare(a, b);
    }

    fmtDate(iso) {
        if (!iso) return '';
        try {
            const messageDate = new Date(iso);
            if (Number.isNaN(messageDate.getTime())) return 'Invalid Date';
            zaliEnsureFormatters();
            const now = new Date();
            const yesterday = new Date(now); yesterday.setDate(yesterday.getDate()-1);
            const day = zaliLocalDayIndex(messageDate);
            if (day === zaliLocalDayIndex(now))       return 'Сегодня';
            if (day === zaliLocalDayIndex(yesterday)) return 'Вчера';
            return zaliMemoFormat(zaliDayMonthMemo, day, () => zaliDayMonthFormat.format(messageDate));
        } catch(e) { return ''; }
    }
});
