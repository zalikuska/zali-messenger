// --- ZaliInterface: Экранирование, иконки, форматирование времени и дат. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // --- HTML Helper Utilities ---
    esc(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g,'&amp;').replace(/</g,'&lt;')
            .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;');
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
        try { return new Date(iso).toLocaleTimeString('ru-RU',{hour:'2-digit',minute:'2-digit'}); }
        catch(e) { return ''; }
    }

    messageTimestampValue(iso) {
        const ts = Date.parse(iso || '');
        return Number.isFinite(ts) ? ts : 0;
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
    conversationLastMessageAt(peer) {
        const msgs = Array.isArray(this.S.chats?.[peer]) ? this.S.chats[peer] : [];
        const TAIL_SCAN = 24;
        let lastTs = 0;
        let scanned = 0;
        for (let i = msgs.length - 1; i >= 0 && scanned < TAIL_SCAN; i -= 1, scanned += 1) {
            const ts = this.messageTimestampValue(msgs[i]?.timestamp);
            if (ts > lastTs) lastTs = ts;
        }
        return lastTs;
    }

    fmtDate(iso) {
        if (!iso) return '';
        try {
            const messageDate = new Date(iso), now = new Date();
            const yesterday = new Date(); yesterday.setDate(yesterday.getDate()-1);
            if (messageDate.toDateString() === now.toDateString())       return 'Сегодня';
            if (messageDate.toDateString() === yesterday.toDateString()) return 'Вчера';
            return messageDate.toLocaleDateString('ru-RU',{day:'numeric',month:'long'});
        } catch(e) { return ''; }
    }
});
