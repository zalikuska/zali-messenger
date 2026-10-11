// --- ZaliInterface: вкладка «Подпись аддонов» в хабе — подписать, мои аддоны, казна. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Серверная половина и
// инварианты — server/src/addons.rs; формат — web/src/modules/addon_format.js;
// описание для авторов — docs/ADDONS.md §10.
//
// «Свободная» подпись — закрытый инструмент на стороне сервера, открытый любому
// вошедшему: сюда приходит только отпечаток файла, сервер подписывает его от
// имени аккаунта и закрепляет за ним id аддона. Ключа у пользователя нет и
// терять нечего. Подписанный файл строится здесь же, из того же файла плюс запись
// `zali-signature.json`, и перед сохранением проверяется тем же кодом, что при
// установке.
//
// Официальная подпись — по заявке на конкретную сборку: оператор сервера
// рассматривает её вручную, и только после одобрения сервер выдаёт подпись
// именно этому файлу. Новая версия — новая заявка.
//
// Подписавший становится владельцем: видит установки и запуски (счётчиками, без
// имён) и управляет казной аддона — выводит то, что внесено больше недели назад.
// Это ограничение разработчика; человек, пользующийся аддоном, забирает свои
// монеты обратно сразу (zali.coins.withdraw, addons_coins.js).

ZaliMixin(ZaliInterface, class {

    addonSigningState() {
        if (!this._addonSigning) {
            this._addonSigning = {
                info: null, digest: '', fileName: '', busy: false, error: '', result: null,
                mine: null, mineError: '', mineLoading: false,
            };
        }
        return this._addonSigning;
    }

    bindAddonSigningEvents() {
        document.getElementById('hubTabs')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-hub-tab]');
            if (btn) this.setHubTab(btn.getAttribute('data-hub-tab'));
        });
        const pane = document.getElementById('hubSigning');
        if (!pane) return;
        pane.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-sign-action]');
            if (!btn || btn.disabled) return;
            const action = btn.getAttribute('data-sign-action');
            const id = btn.closest('[data-sign-addon]')?.getAttribute('data-sign-addon') || '';
            if (action === 'pick') document.getElementById('addonSignFileInput')?.click();
            else if (action === 'sign') void this.signPickedAddon('self');
            else if (action === 'sign-official') void this.signPickedAddon('official');
            else if (action === 'request-official') void this.requestOfficialForPicked();
            else if (action === 'download') this.downloadSignedAddon();
            else if (action === 'install') void this.installSignedAddon();
            else if (action === 'reset') this.resetAddonSigning();
            else if (action === 'manage') void this.openAddonManageDialog(id);
            else if (action === 'refresh') void this.loadMyAddons();
        });
        // Поле выбора файла создаётся при каждой перерисовке вкладки, поэтому
        // слушатель — на панели (событие всплывает), а не на самом поле: к
        // моменту привязки поля ещё нет, а после перерисовки оно новое.
        pane.addEventListener('change', (e) => {
            const input = e.target;
            if (!input || input.id !== 'addonSignFileInput') return;
            const file = input.files?.[0];
            input.value = '';
            if (file) void this.pickAddonToSign(file);
        });
        this.bindSigningDropZone(pane);
    }

    /** Файл .zali, брошенный на вкладку, выбирается для подписи (не устанавливается). */
    bindSigningDropZone(zone) {
        const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
        let depth = 0;
        zone.addEventListener('dragenter', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth += 1;
            zone.classList.add('is-dropping');
        });
        zone.addEventListener('dragover', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });
        zone.addEventListener('dragleave', () => {
            depth = Math.max(0, depth - 1);
            if (!depth) zone.classList.remove('is-dropping');
        });
        zone.addEventListener('drop', (e) => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            depth = 0;
            zone.classList.remove('is-dropping');
            const files = Array.from(e.dataTransfer.files || []);
            const file = files.find(f => /\.zali$/i.test(f.name)) || files[0];
            if (file) void this.pickAddonToSign(file);
        });
    }

    setHubTab(name) {
        const tab = name === 'signing' ? 'signing' : 'overview';
        this._hubTab = tab;
        document.querySelectorAll('#hubTabs [data-hub-tab]').forEach((btn) => {
            const on = btn.getAttribute('data-hub-tab') === tab;
            btn.classList.toggle('is-active', on);
            btn.setAttribute('aria-selected', on ? 'true' : 'false');
        });
        document.querySelectorAll('[data-hub-pane]').forEach((pane) => {
            pane.hidden = pane.getAttribute('data-hub-pane') !== tab;
        });
        if (tab === 'signing') {
            this.renderHubSigning();
            void this.loadMyAddons();
        }
    }

    // ---- Подпись ----

    async pickAddonToSign(file) {
        const F = window.ZaliAddonFormat;
        const st = this.addonSigningState();
        st.error = '';
        st.result = null;
        if (Number(file?.size || 0) > F.LIMITS.fileBytes) {
            st.error = 'Файл не подошёл: аддон больше 32 МБ.';
            this.renderHubSigning();
            return;
        }
        if (!this.S.session?.token) {
            st.error = 'Войдите в аккаунт: подпись закрепляет аддон за вами.';
            this.renderHubSigning();
            return;
        }
        try {
            st.info = await this.addonInspect(new Uint8Array(await file.arrayBuffer()));
            st.digest = await F.contentDigest(st.info.files);
            st.fileName = file.name || '';
        } catch (error) {
            st.info = null;
            st.digest = '';
            st.error = `Файл не подошёл: ${error?.message || error}`;
        }
        this.renderHubSigning();
    }

    resetAddonSigning() {
        const st = this.addonSigningState();
        st.info = null;
        st.digest = '';
        st.result = null;
        st.error = '';
        st.fileName = '';
        this.renderHubSigning();
    }

    async signPickedAddon(kind = 'self') {
        const F = window.ZaliAddonFormat;
        const st = this.addonSigningState();
        const info = st.info;
        if (!info || st.busy) return;
        st.busy = true;
        st.error = '';
        this.renderHubSigning();
        try {
            const m = info.manifest;
            const res = await this.apiFetch('/api/addons/sign', {
                method: 'POST',
                body: JSON.stringify({ id: m.id, version: m.version, digest: st.digest, name: m.name, kind }),
                interactive: true,
            });
            let body = null;
            try { body = await res.json(); } catch (e) { /* пустой ответ */ }
            if (!res.ok) throw new Error(String(body?.message || `Сервер отказал (${res.status})`));
            const signedBytes = F.withSignature(info.bytes, body.signature);
            // Тем же кодом, что при установке: файл, который мы отдадим, обязан
            // пройти проверку у того, кто его поставит.
            const check = await this.addonInspect(signedBytes);
            if (check.signature.state !== kind) {
                throw new Error(`Подписанный файл не прошёл проверку: ${check.signature.reason || check.signature.state}`);
            }
            st.result = {
                bytes: signedBytes,
                fileName: `${m.id}-${m.version}.signed.zali`,
                manifest: m,
                signature: check.signature,
                kind,
            };
            this.addonRegistryForget(m.id);
            this.downloadSignedAddon();
            await this.loadMyAddons();
        } catch (error) {
            st.error = `Не удалось подписать: ${error?.message || error}`;
        } finally {
            st.busy = false;
            this.renderHubSigning();
        }
    }

    /** Заявка на официальную подпись этой сборки; решает оператор сервера вручную. */
    async requestOfficialForPicked() {
        const st = this.addonSigningState();
        const info = st.info;
        if (!info || st.busy) return;
        const m = info.manifest;
        const html = `
            <div class="addon-dialog-head">
                <div>
                    <h2 id="addonDialogTitle">Официальная подпись</h2>
                    <p class="addon-dialog-sub">«${this.esc(m.name)}» ${this.esc(m.version)}</p>
                </div>
            </div>
            <p class="addon-dialog-desc">Заявку рассматривает оператор сервера вручную. Одобряется именно эта версия файла: для новой версии заявка подаётся заново.</p>
            <textarea class="settings-input addon-request-note" rows="3" maxlength="500" placeholder="Что делает аддон и зачем ему официальная подпись (необязательно)"></textarea>
            <div class="coin-transfer-actions">
                <button class="btn-flat" type="button" data-dialog-action="cancel">Отмена</button>
                <button class="auth-btn primary" type="button" data-dialog-action="ok">Отправить заявку</button>
            </div>`;
        const closed = this.openAddonDialog(html);
        const note = Array.from(document.querySelectorAll('.addon-dialog')).pop()?.querySelector('textarea');
        if (await closed !== 'ok') return;
        st.busy = true;
        st.error = '';
        this.renderHubSigning();
        try {
            const res = await this.apiFetch(`/api/addons/${encodeURIComponent(m.id)}/official-request`, {
                method: 'POST',
                body: JSON.stringify({ version: m.version, digest: st.digest, note: String(note?.value || '') }),
                interactive: true,
            });
            let body = null;
            try { body = await res.json(); } catch (e) { /* пустой ответ */ }
            if (!res.ok) throw new Error(String(body?.message || `Сервер отказал (${res.status})`));
            await this.loadMyAddons();
        } catch (error) {
            st.error = `Не удалось отправить заявку: ${error?.message || error}`;
        } finally {
            st.busy = false;
            this.renderHubSigning();
        }
    }

    downloadSignedAddon() {
        const result = this.addonSigningState().result;
        if (!result) return;
        const dataUrl = `data:application/octet-stream;base64,${this.addonBytesToBase64(result.bytes)}`;
        void this.downloadAttachmentFromHref?.(dataUrl, result.fileName);
    }

    async installSignedAddon() {
        const result = this.addonSigningState().result;
        if (!result) return;
        const file = new File([result.bytes], result.fileName, { type: 'application/octet-stream' });
        this.setHubTab('overview');
        await this.installAddonFromFile(file);
    }

    // ---- Мои аддоны ----

    async loadMyAddons() {
        const st = this.addonSigningState();
        if (!this.S.session?.token) {
            st.mine = [];
            this.renderHubSigning();
            return;
        }
        st.mineLoading = true;
        this.renderHubSigning();
        try {
            const res = await this.apiFetch('/api/addons/mine', { interactive: true });
            if (!res.ok) throw new Error(`Ошибка ${res.status}`);
            const data = await res.json();
            st.mine = Array.isArray(data?.addons) ? data.addons : [];
            st.mineError = '';
        } catch (error) {
            st.mineError = error?.message || String(error);
        } finally {
            st.mineLoading = false;
            this.renderHubSigning();
        }
    }

    addonCoinsShort(amount) {
        return Number(amount || 0).toLocaleString('ru-RU');
    }

    addonDateLabel(ms) {
        return new Date(Number(ms) || 0).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    }

    /** Состояние заявки на официальную подпись для строки списка или выбранного файла. */
    addonRequestLine(request, { digest = '' } = {}) {
        if (!request || (digest && request.digest !== digest)) return '';
        const v = this.esc(request.version);
        if (request.status === 'pending') return `Заявка на официальную подпись ${v} ждёт решения`;
        if (request.status === 'approved') return `Заявка ${v} одобрена — можно получить официальную подпись`;
        if (request.status === 'rejected') {
            return request.decisionNote ? `Заявка ${v} отклонена: ${this.esc(request.decisionNote)}` : `Заявка ${v} отклонена`;
        }
        return '';
    }

    addonSignChipHtml(signature) {
        const s = signature || { state: 'none' };
        if (s.state === 'official') return '<span class="addon-chip is-official">Официальная</span>';
        if (s.state === 'self') return `<span class="addon-chip is-self">Самоподпись · @${this.esc(s.owner || '')}</span>`;
        if (s.state === 'unverified') return '<span class="addon-chip is-warn">Подпись не проверена</span>';
        if (s.state === 'invalid') return '<span class="addon-chip is-bad">Подпись недействительна</span>';
        return '<span class="addon-chip">Не подписан</span>';
    }

    renderHubSigning() {
        const box = document.getElementById('hubSigningBody');
        if (!box) return;
        const st = this.addonSigningState();
        const mine = Array.isArray(st.mine) ? st.mine : null;

        let picked = '';
        if (st.result) {
            const m = st.result.manifest;
            picked = `<div class="addon-sign-card is-done" role="status">
                <div class="addon-sign-card-text">
                    <strong>«${this.esc(m.name)}» ${this.esc(m.version)} подписан${st.result.kind === 'official' ? ' официально' : ''}</strong>
                    <span>Файл <code>${this.esc(st.result.fileName)}</code> сохранён и закреплён за @${this.esc(this.myName())}. Раздавайте именно его.</span>
                </div>
                <div class="addon-sign-actions">
                    <button class="btn-flat" type="button" data-sign-action="install">Установить</button>
                    <button class="btn-flat" type="button" data-sign-action="download">Сохранить ещё раз</button>
                    <button class="btn-flat" type="button" data-sign-action="reset">Другой файл</button>
                </div>
            </div>`;
        } else if (st.info) {
            const m = st.info.manifest;
            const item = mine ? mine.find(a => a.id === m.id) : null;
            const request = item?.officialRequest || null;
            const approved = !!request && request.digest === st.digest && request.status === 'approved';
            const pending = !!request && request.digest === st.digest && request.status === 'pending';
            const isOfficial = item?.kind === 'official';
            const line = this.addonRequestLine(request, { digest: st.digest });
            const hint = !item ? 'Подпись закрепит этот id за вашим аккаунтом.' : '';
            const busy = st.busy ? ' disabled aria-busy="true"' : '';
            let actions;
            if (approved) {
                actions = `<button class="auth-btn primary" type="button" data-sign-action="sign-official"${busy}>${st.busy ? 'Подписываем…' : 'Получить официальную подпись'}</button>
                    <button class="btn-flat" type="button" data-sign-action="sign"${busy}>Самоподпись</button>`;
            } else {
                actions = `<button class="auth-btn primary" type="button" data-sign-action="sign"${busy}>${st.busy ? 'Подписываем…' : 'Подписать'}</button>`;
                if (item && !isOfficial && !pending) {
                    actions += `<button class="btn-flat" type="button" data-sign-action="request-official"${busy}>Запросить официальную</button>`;
                }
            }
            picked = `<div class="addon-sign-card" data-sign-addon="${this.esc(m.id)}">
                <div class="addon-sign-card-head">
                    ${this.addonIconHtml({ manifest: m, iconDataUrl: this.addonIconDataUrl(st.info) })}
                    <div class="addon-sign-card-text">
                        <strong>${this.esc(m.name)}</strong>
                        <span>${this.esc(m.id)} · ${this.esc(m.version)} · ${this.esc(this.addonSizeLabel(st.info.size))}</span>
                    </div>
                    ${this.addonSignChipHtml(st.info.signature)}
                </div>
                ${line || hint ? `<p class="addon-sign-hint">${line || this.esc(hint)}</p>` : ''}
                <div class="addon-sign-actions">
                    ${actions}
                    <button class="btn-flat" type="button" data-sign-action="reset"${busy}>Другой файл</button>
                </div>
            </div>`;
        } else {
            picked = `<div class="addon-sign-drop">
                <span>Перетащите файл <b>.zali</b> сюда или выберите его</span>
                <button class="auth-btn primary" type="button" data-sign-action="pick">Выбрать файл</button>
            </div>`;
        }

        let mineHtml;
        if (st.mineError) {
            mineHtml = `<div class="hub-addons-note is-error"><span>Не удалось загрузить: ${this.esc(st.mineError)}</span>
                <button class="btn-flat" type="button" data-sign-action="refresh">Повторить</button></div>`;
        } else if (mine === null || (st.mineLoading && !mine.length)) {
            mineHtml = '<p class="hub-addons-note"><span class="addon-frame-spinner" aria-hidden="true"></span>Загрузка…</p>';
        } else if (!mine.length) {
            mineHtml = `<div class="hub-addons-empty"><strong>За вами пока нет аддонов</strong>
                <span>Подпишите файл выше — аддон закрепится за аккаунтом, и здесь появятся его установки и казна.</span></div>`;
        } else {
            mineHtml = mine.map((a) => {
                const t = a.treasury || {};
                const official = a.kind === 'official';
                const requestLine = official ? '' : this.addonRequestLine(a.officialRequest);
                return `<article class="addon-mine" data-sign-addon="${this.esc(a.id)}">
                    <span class="hub-addon-icon" aria-hidden="true">${this.esc(String(a.name || a.id).trim().charAt(0).toUpperCase() || '?')}</span>
                    <div class="addon-mine-main">
                        <div class="addon-mine-title">
                            <strong>${this.esc(a.name || a.id)}</strong>
                            <span class="addon-chip ${official ? 'is-official' : 'is-self'}">${official ? 'Официальный' : 'Самоподпись'}</span>
                        </div>
                        <p class="addon-mine-stats">Установок ${this.addonCoinsShort(a.installs)} · запусков за 7 дней ${this.addonCoinsShort(a.launches7d)} · в казне ${this.addonCoinsShort(t.balance)} ZC</p>
                        ${requestLine ? `<p class="addon-mine-request">${requestLine}</p>` : ''}
                    </div>
                    <button class="btn-flat" type="button" data-sign-action="manage">Управление</button>
                </article>`;
            }).join('');
        }

        box.innerHTML = `
            <section class="hub-components addon-sign-section" aria-labelledby="hubSignTitle">
                <div class="hub-components-head">
                    <div>
                        <span class="settings-kicker">Подпись</span>
                        <h3 id="hubSignTitle">Подписать аддон</h3>
                    </div>
                </div>
                <p class="addon-sign-intro">Подпись закрепляет аддон за вашим аккаунтом: вы видите установки и управляете его ZaliCoin.
                    Самоподпись — не сертификат приложения, предупреждение для пользователей остаётся.</p>
                ${st.error ? `<p class="hub-addons-status is-error" role="alert">${this.esc(st.error)}</p>` : ''}
                ${picked}
                <input type="file" id="addonSignFileInput" accept=".zali" hidden>
            </section>
            <section class="hub-components addon-sign-section" aria-labelledby="hubMineTitle">
                <div class="hub-components-head">
                    <div>
                        <span class="settings-kicker">Автор</span>
                        <h3 id="hubMineTitle">Мои аддоны</h3>
                    </div>
                    <button class="btn-flat" type="button" data-sign-action="refresh"${st.mineLoading ? ' disabled' : ''}>Обновить</button>
                </div>
                <div class="addon-mine-list">${mineHtml}</div>
            </section>`;
    }

    // ---- Управление аддоном: статистика и казна ----

    addonDayLabel(day) {
        const parts = String(day || '').split('-');
        return parts.length === 3 ? `${parts[2]}.${parts[1]}` : String(day || '');
    }

    addonManageHtml(data) {
        const a = data.addon || {};
        const t = data.treasury || {};
        const s = data.stats || {};
        const official = a.kind === 'official';
        // Сервер отдаёт только дни, в которые были запуски; ряд за 14 суток (UTC,
        // как в strftime на сервере) дополняется нулями, чтобы график не растягивался.
        const byDay = new Map((Array.isArray(s.daily) ? s.daily : []).map(d => [String(d.day), Number(d.launches) || 0]));
        const today = new Date();
        const series = [];
        for (let i = 13; i >= 0; i -= 1) {
            const key = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - i)).toISOString().slice(0, 10);
            series.push([key, byDay.get(key) || 0]);
        }
        const peak = Math.max(1, ...series.map(([, n]) => n));
        const launchesWord = (n) => {
            const last = n % 10;
            const tens = n % 100;
            if (tens >= 11 && tens <= 14) return 'запусков';
            if (last === 1) return 'запуск';
            return last >= 2 && last <= 4 ? 'запуска' : 'запусков';
        };
        // Подсказка при наведении — как у зарядов карточек ZaliCoin (data-zc-tip).
        const bars = series.map(([key, n]) => {
            const label = this.addonDayLabel(key);
            const tip = `${label} · ${n ? `${n} ${launchesWord(n)}` : 'без запусков'}`;
            const h = n ? Math.max(10, Math.round((n / peak) * 100)) : 4;
            return `<span class="addon-bar${n ? '' : ' is-empty'}" tabindex="0" data-tip="${this.esc(tip)}"><i style="height:${Number(h)}%"></i></span>`;
        }).join('');

        const withdrawable = Number(t.withdrawable) || 0;
        const locked = Number(t.locked) || 0;
        let treasuryLine;
        if (withdrawable > 0) {
            treasuryLine = `Можно вывести <button class="addon-link" type="button" data-manage-action="all">${this.addonCoinsShort(withdrawable)} ZC</button>`;
            if (t.nextUnlock) treasuryLine += ` · ещё ${this.addonCoinsShort(t.nextUnlock.amount)} ZC — ${this.esc(this.addonDateLabel(t.nextUnlock.at))}`;
        } else if (t.nextUnlock) {
            treasuryLine = `Пока выводить нечего: ${this.addonCoinsShort(t.nextUnlock.amount)} ZC откроются ${this.esc(this.addonDateLabel(t.nextUnlock.at))}`;
        } else if (locked > 0) {
            treasuryLine = 'Пока выводить нечего';
        } else {
            treasuryLine = 'Казна пуста';
        }
        const paidOut = Number(data.paidOut) || 0;

        const rows = [
            ...(data.deposits || []).map(d => ({ at: Number(d.at) || 0, who: `@${this.esc(d.username)}`, sum: `+${this.addonCoinsShort(d.amount)} ZC`, note: d.note ? this.esc(d.note) : '' })),
            ...(data.withdrawals || []).map(w => ({ at: Number(w.at) || 0, who: 'Вывод', sum: `−${this.addonCoinsShort(w.amount)} ZC`, note: '' })),
        ].sort((x, y) => y.at - x.at).slice(0, 8);
        const ledger = rows.length ? `<details class="addon-ledger">
                <summary>Операции · ${rows.length}</summary>
                <ul>${rows.map(r => `<li><span class="addon-ledger-who">${r.who}</span><b>${r.sum}</b><time>${this.esc(this.addonDateLabel(r.at))}</time>${r.note ? `<em>${r.note}</em>` : ''}</li>`).join('')}</ul>
            </details>` : '';

        return `
            <div class="addon-dialog-head">
                <span class="hub-addon-icon" aria-hidden="true">${this.esc(String(a.name || a.id || '?').trim().charAt(0).toUpperCase() || '?')}</span>
                <div>
                    <h2 id="addonDialogTitle">${this.esc(a.name || a.id)}</h2>
                    <p class="addon-dialog-sub">${this.esc(a.id)} · ${official ? 'официальная подпись' : 'самоподпись'}</p>
                </div>
            </div>
            <div class="addon-stats">
                <div><b>${this.addonCoinsShort(s.installs)}</b><span>установок</span></div>
                <div><b>${this.addonCoinsShort(s.users7d)}</b><span>активных за 7 дней</span></div>
                <div><b>${this.addonCoinsShort(s.launches7d)}</b><span>запусков за 7 дней</span></div>
            </div>
            ${series.some(([, n]) => n > 0) ? `<div class="addon-bars" role="img" aria-label="Запуски по дням за 14 дней">${bars}</div>
            <p class="addon-bars-caption">Запуски по дням, 14 дней</p>` : ''}
            <section class="addon-treasury" aria-label="Казна">
                <div class="addon-treasury-head"><b>${this.addonCoinsShort(t.balance)} ZC</b><span>в казне</span></div>
                <p class="addon-treasury-line">${treasuryLine}</p>
                <form class="addon-withdraw-row" data-manage-form="withdraw">
                    <input class="settings-input" type="text" inputmode="numeric" pattern="[0-9]*" autocomplete="off" name="amount" placeholder="Сумма" aria-label="Сколько вывести"${withdrawable > 0 ? '' : ' disabled'}>
                    <button class="auth-btn primary" type="submit"${withdrawable > 0 ? '' : ' disabled'}>Вывести</button>
                </form>
                <p class="addon-treasury-note">Вывод разработчика — только со взносов старше ${Number(t.holdDays) || 7} дней.${paidOut > 0 ? ` Возвращено пользователям: ${this.addonCoinsShort(paidOut)} ZC.` : ''}</p>
                <p class="addon-manage-status" data-manage-status role="status" aria-live="polite" hidden></p>
            </section>
            ${ledger}
            ${official ? '' : `<section class="addon-pin" aria-label="Закрепление id">
                <p class="addon-treasury-note"><b>${this.esc(a.id)}</b> закреплён за вашим аккаунтом: пока так, никто другой не может подписать аддон с этим id. Отвязав его, вы отпускаете имя — его сможет занять любой.</p>
                <button class="btn-flat addon-dialog-danger" type="button" data-manage-action="unbind">Отвязать id</button>
            </section>`}
            <div class="coin-transfer-actions">
                <button class="btn-flat" type="button" data-dialog-action="cancel">Закрыть</button>
            </div>`;
    }

    async openAddonManageDialog(id) {
        if (!id) return;
        let data;
        try {
            const res = await this.apiFetch(`/api/addons/${encodeURIComponent(id)}/manage`, { interactive: true });
            if (!res.ok) throw new Error(res.status === 404 ? 'Аддон не найден или он не ваш' : `Ошибка ${res.status}`);
            data = await res.json();
        } catch (error) {
            this.addonSigningState().error = `Не удалось открыть управление: ${error?.message || error}`;
            this.renderHubSigning();
            return;
        }
        const closed = this.openAddonDialog(this.addonManageHtml(data));
        const overlay = Array.from(document.querySelectorAll('.addon-dialog')).pop();
        const boxEl = overlay?.querySelector('.addon-dialog-box');
        if (!overlay || !boxEl) return;
        const setStatus = (text, tone = '') => {
            const el = boxEl.querySelector('[data-manage-status]');
            if (!el) return;
            el.textContent = text || '';
            el.hidden = !text;
            el.classList.toggle('is-error', tone === 'error');
            el.classList.toggle('is-success', tone === 'success');
        };
        const refresh = async () => {
            const res = await this.apiFetch(`/api/addons/${encodeURIComponent(id)}/manage`, { interactive: true });
            if (!res.ok) return;
            data = await res.json();
            boxEl.innerHTML = this.addonManageHtml(data);
        };
        const withdraw = async (amount) => {
            if (!Number.isSafeInteger(amount) || amount <= 0) {
                setStatus('Введите целое число ZaliCoin больше нуля', 'error');
                return;
            }
            const available = Number(data?.treasury?.withdrawable) || 0;
            if (amount > available) {
                setStatus(`Сейчас можно вывести не больше ${this.addonCoinsShort(available)} ZC`, 'error');
                return;
            }
            setStatus('Выводим…');
            try {
                await this.addonWithdrawRequest(id, amount);
                await refresh();
                setStatus(`Выведено ${this.addonCoinsShort(amount)} ZC на ваш баланс`, 'success');
                void this.loadMyAddons();
            } catch (error) {
                setStatus(String(error?.message || error), 'error');
            }
        };
        overlay.addEventListener('submit', (e) => {
            const form = e.target.closest('[data-manage-form="withdraw"]');
            if (!form) return;
            e.preventDefault();
            void withdraw(Number(new FormData(form).get('amount')));
        });
        const unbind = async () => {
            const name = data?.addon?.name || id;
            const balance = Number(data?.treasury?.balance) || 0;
            if (balance > 0) {
                setStatus(`В казне ${this.addonCoinsShort(balance)} ZC: сначала верните их людям и выведите, потом отвязывайте id`, 'error');
                return;
            }
            const sure = await this.confirmAction({
                title: `Отвязать id «${id}»?`,
                message: `Аддон «${name}» перестанет быть вашим: пропадёт его статистика, а облако ZaliMessenger с данными пользователей будет стёрто. Имя id освободится — любой сможет закрепить его за собой. Подписанные вами файлы с этим id останутся, но проверка автора по реестру перестанет с ними сходиться.`,
                confirmLabel: 'Отвязать id',
            });
            if (!sure) return;
            setStatus('Отвязываем…');
            try {
                const res = await this.apiFetch(`/api/addons/${encodeURIComponent(id)}/unbind`, { method: 'POST', body: '{}', interactive: true });
                let body = null;
                try { body = await res.json(); } catch (e) { /* пустой ответ */ }
                if (!res.ok) throw new Error(String(body?.message || `Ошибка ${res.status}`));
                this.addonRegistryForget?.(id);
                this.setAddonsStatus?.(`id «${id}» отвязан от вашего аккаунта.`, 'success');
                void this.loadMyAddons();
                overlay.querySelector('[data-dialog-action="cancel"]')?.click();
            } catch (error) {
                setStatus(String(error?.message || error), 'error');
            }
        };
        overlay.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-manage-action="all"]');
            if (btn && !btn.disabled) void withdraw(Number(data?.treasury?.withdrawable) || 0);
            if (e.target.closest('[data-manage-action="unbind"]')) void unbind();
        });
        await closed;
    }

    // ---- События сервера ----

    /** Кто-то перевёл ZaliCoin аддону, закреплённому за вами. */
    handleAddonCoinsRealtime(payload) {
        const amount = Number(payload?.amount) || 0;
        const from = String(payload?.from || '');
        if (amount > 0) {
            this.setAddonsStatus?.(`Аддон ${payload.addonId}: +${this.addonCoinsShort(amount)} ZC от @${from}`, 'success');
        }
        if (this._hubTab === 'signing') void this.loadMyAddons();
        void this.refreshZaliCoinView?.();
    }

    /** Оператор принял решение по заявке на официальную подпись. */
    handleAddonOfficialRealtime(payload) {
        const status = String(payload?.status || '');
        const text = status === 'approved'
            ? `Заявка на официальную подпись ${payload.addonId} одобрена — получите подпись во вкладке «Подпись аддонов»`
            : `Заявка на официальную подпись ${payload.addonId} отклонена${payload.note ? `: ${payload.note}` : ''}`;
        this.setAddonsStatus?.(text, status === 'approved' ? 'success' : 'error');
        void this.loadMyAddons();
    }
});
