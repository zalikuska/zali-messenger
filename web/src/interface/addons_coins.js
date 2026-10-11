// --- ZaliInterface: ZaliCoin для аддонов — баланс, перевод на баланс аддона, вывод. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Серверная половина,
// формат подписи и инварианты — server/src/addons.rs, web/src/modules/addon_format.js;
// описание для авторов — docs/ADDONS.md §10.
//
// Кто что решает:
//  - АДДОН (песочница) может только попросить: `zali.coins.deposit({amount})`.
//    Сумма, получатель и подтверждение — не у него: окно рисует приложение, а
//    не фрейм, и закрыть его «нажатием» изнутри аддон не может.
//  - ПРИЛОЖЕНИЕ показывает диалог с предупреждением, которое зависит от подписи:
//    у официального аддона — спокойное («вы перечисляете монеты на баланс
//    приложения»), у остального — строгое (вас могут обмануть) и с галочкой.
//    Неподписанному аддону перевод недоступен вообще.
//  - СЕРВЕР держит деньги: взнос и вывод проводятся одной транзакцией, а вывод
//    автору разрешён только с того, что пролежало неделю.
//
// Доверие к аддону складывается из двух независимых вещей, и обе обязаны сойтись:
// подпись в самом файле (его не подделать, не имея ключа) и запись в реестре
// сервера (кому аддон принадлежит). Файл, подписанный чужим ключом или не за того
// автора, на перевод не пускается — даже если подпись в нём сама по себе верна.

const ZALI_ADDON_COIN_INTERVAL_MS = 3000;
const ZALI_ADDON_KEYS_TTL_MS = 10 * 60 * 1000;
const ZALI_ADDON_REGISTRY_TTL_MS = 30 * 1000;
const ZALI_ADDON_KEYS_STORAGE = 'zali_addon_signing_keys_v1';

ZaliMixin(ZaliInterface, class {

    addonCoinsRpcMethods() {
        return {
            'coins.balance': { permission: 'coins', run: (i) => this.addonCoinsBalance(i) },
            'coins.treasury': { permission: 'coins', run: (i) => this.addonCoinsTreasury(i) },
            'coins.deposit': { permission: 'coins', run: (i, p) => this.addonCoinsDeposit(i, p) },
            'coins.withdraw': { permission: 'coins', run: (i, p) => this.addonCoinsWithdraw(i, p) },
        };
    }

    // ---- Ключи проверки подписей ----

    /**
     * Публичные ключи сервера: «свободной» подписи и официальной. Кешируются —
     * проверка подписи нужна на каждый запуск, а ключ меняется только если
     * сервер пересоздали. Недоступен (нет сети, не вошли) — берётся последний
     * известный; нет и его — `null`, и самоподпись считается непроверенной.
     */
    async addonSigningKeys({ force = false } = {}) {
        const now = Date.now();
        if (!force && this._addonKeys && now - this._addonKeysAt < ZALI_ADDON_KEYS_TTL_MS) return this._addonKeys;
        const apiBase = String(this.apiUrl?.('/') || '');
        try {
            const res = await this.apiFetch('/api/addons/signing-key', { interactive: false });
            if (res.ok) {
                const data = await res.json();
                if (data?.self?.publicKey) {
                    this._addonKeys = data;
                    this._addonKeysAt = now;
                    try {
                        localStorage.setItem(ZALI_ADDON_KEYS_STORAGE, JSON.stringify({ apiBase, data }));
                    } catch (e) { /* без кеша — проверим при следующем запуске */ }
                    return data;
                }
            }
        } catch (e) { /* ниже — последнее известное */ }
        if (this._addonKeys) return this._addonKeys;
        try {
            const stored = JSON.parse(localStorage.getItem(ZALI_ADDON_KEYS_STORAGE) || 'null');
            // Ключ принадлежит серверу, у которого его брали: другой сервер — другая подпись.
            if (stored?.data?.self?.publicKey && stored.apiBase === apiBase) {
                this._addonKeys = stored.data;
                this._addonKeysAt = now;
                return stored.data;
            }
        } catch (e) { /* нет сохранённого */ }
        return null;
    }

    async addonInspect(bytes) {
        const keys = await this.addonSigningKeys();
        return await window.ZaliAddonFormat.inspect(bytes, { selfPublicKey: keys?.self?.publicKey || '' });
    }

    // ---- Реестр авторов ----

    async addonRegistryLookup(id, { force = false } = {}) {
        if (!this._addonRegistryCache) this._addonRegistryCache = new Map();
        const cached = this._addonRegistryCache.get(id);
        if (!force && cached && Date.now() - cached.at < ZALI_ADDON_REGISTRY_TTL_MS) return cached.value;
        if (!this.S.session?.token) return null;
        try {
            const res = await this.apiFetch(`/api/addons/${encodeURIComponent(id)}`, { interactive: false });
            if (!res.ok) return null;
            const value = await res.json();
            this._addonRegistryCache.set(id, { at: Date.now(), value });
            return value;
        } catch (e) {
            return null;
        }
    }

    addonRegistryForget(id) {
        this._addonRegistryCache?.delete(id);
    }

    /** Официально подписанный файл вносится в реестр при установке и при первом запуске. */
    async addonRegisterOfficial(id) {
        try {
            const bytes = await this.addonStoreGetArchive(id);
            const { files } = window.ZaliAddonFormat.parseContainer(bytes);
            const signature = window.ZaliAddonFormat.readSignature(files);
            if (!signature || signature.kind !== 'official') return false;
            const res = await this.apiFetch('/api/addons/register-official', {
                method: 'POST',
                body: JSON.stringify({ signature: { ...signature, name: '' } }),
                interactive: false,
            });
            this.addonRegistryForget(id);
            return res.ok;
        } catch (e) {
            return false;
        }
    }

    /** Установки, обновления, запуски и удаления — для статистики автора. Тихо и без ожидания. */
    addonReportEvent(id, kind, version, signatureState) {
        if (signatureState !== 'self' && signatureState !== 'official') return;
        if (!this.S.session?.token) return;
        this.apiFetch(`/api/addons/${encodeURIComponent(id)}/events`, {
            method: 'POST',
            body: JSON.stringify({ kind, version: String(version || '') }),
            interactive: false,
        }).catch(() => {});
    }

    /** Можно ли этому запущенному аддону принимать монеты (подписан, автор совпал с реестром). */
    addonCoinsTrust(instance) {
        return this.addonSignedTrust(instance, { what: 'принимать ZaliCoin', thing: 'перевод' });
    }

    /**
     * Подписан ли запущенный аддон так, что автору из реестра можно верить: и
     * монеты, и облако ZaliMessenger открыты только таким. Возвращает
     * `{ ok, kind, owner, fingerprint, official, reason, code }`.
     * @param {{what?: string, thing?: string}} wording что именно закрыто без подписи
     */
    async addonSignedTrust(instance, { what = 'принимать ZaliCoin', thing = 'перевод' } = {}) {
        const signature = instance.signature || { state: 'none' };
        const none = (code, reason) => ({ ok: false, kind: signature.state, owner: signature.owner || '', reason, code });
        if (signature.state === 'none') return none('not_signed', `Аддон не подписан — он не может ${what}.`);
        if (signature.state === 'invalid') return none('not_signed', 'Подпись аддона повреждена или файл изменён после подписания.');
        if (signature.state === 'unverified') return none('not_signed', 'Подпись аддона не удалось проверить.');
        let registry = await this.addonRegistryLookup(instance.id);
        if (signature.state === 'official' && (!registry || !registry.registered || registry.kind !== 'official')) {
            if (await this.addonRegisterOfficial(instance.id)) registry = await this.addonRegistryLookup(instance.id, { force: true });
        }
        if (!registry) return none('offline', `Не удалось связаться с сервером — ${thing} сейчас недоступен.`);
        if (!registry.registered) return none('not_signed', `Этого аддона нет в реестре автора — ${thing} недоступен.`);
        if (Array.isArray(registry.revoked) && signature.digest && registry.revoked.includes(signature.digest)) {
            return none('revoked', 'Эта версия аддона отозвана оператором сервера — обновите или удалите аддон.');
        }
        if (registry.kind !== signature.kind || registry.owner !== signature.owner) {
            return none('not_signed', 'Подпись в файле не совпадает с записью об авторе на сервере — файл мог быть подделан.');
        }
        const sameKey = !registry.keyFingerprint || registry.keyFingerprint === signature.fingerprint;
        if (!sameKey) return none('not_signed', 'Ключ подписи не совпадает с ключом автора на сервере.');
        return {
            ok: true,
            kind: signature.state,
            owner: signature.owner,
            fingerprint: signature.fingerprint,
            official: signature.state === 'official',
        };
    }

    /**
     * Отпечаток сборки, которую запустил человек, — заголовком к запросам, где
     * сервер умеет отказывать отозванным сборкам (облако, вклады). Заголовок
     * присылает приложение; обойти его может только изменённый клиент, поэтому
     * это страховка честных клиентов, а не замена проверки подписи.
     */
    addonDigestOptions(instance, options = {}) {
        const digest = instance?.signature?.digest;
        if (!digest) return options;
        return { ...options, headers: { ...(options.headers || {}), 'X-Zali-Addon-Digest': String(digest) } };
    }

    addonCoinsAmount(params) {
        const amount = Number(params?.amount);
        if (!Number.isSafeInteger(amount) || amount <= 0) {
            throw this.addonError('bad_params', 'Сумма — целое число ZaliCoin больше нуля');
        }
        return amount;
    }

    addonCoinsRateLimit(instance, what) {
        const now = Date.now();
        if (now - Number(instance.lastCoinOpAt || 0) < ZALI_ADDON_COIN_INTERVAL_MS) {
            throw this.addonError('rate_limited', `${what} — не чаще раза в 3 секунды`);
        }
        instance.lastCoinOpAt = now;
    }

    async addonCoinsApi(path, options = {}, instance = null) {
        let res;
        try {
            res = await this.apiFetch(path, { interactive: true, ...this.addonDigestOptions(instance, options) });
        } catch (error) {
            throw this.addonError('offline', 'Не удалось связаться с сервером');
        }
        let body = null;
        try { body = await res.json(); } catch (e) { /* пустой ответ */ }
        if (!res.ok) {
            const code = String(body?.code || (res.status === 404 ? 'not_found' : res.status === 403 ? 'forbidden' : 'failed'));
            throw Object.assign(this.addonError(code, String(body?.message || `Ошибка ${res.status}`)), { treasury: body?.treasury });
        }
        return body;
    }

    // ---- zali.coins.balance / treasury ----

    async addonCoinsBalance() {
        const data = await this.addonCoinsApi(this.apiRoutes.coins.balance, { interactive: false });
        return { balance: Number(data?.balance) || 0, held: Number(data?.held) || 0 };
    }

    async addonCoinsTreasury(instance) {
        const trust = await this.addonCoinsTrust(instance);
        const out = {
            signed: instance.signature?.state || 'none',
            trusted: trust.ok,
            official: !!trust.official,
            owner: trust.owner || '',
            isOwner: false,
            holdDays: window.ZaliAddonFormat.COIN_HOLD_DAYS,
        };
        if (!trust.ok) return { ...out, reason: trust.reason };
        // Сколько этот человек вправе забрать из аддона (zali.coins.withdraw).
        const registry = await this.addonRegistryLookup(instance.id, { force: true });
        out.deposited = Number(registry?.you?.deposited) || 0;
        out.available = Number(registry?.you?.available) || 0;
        out.isOwner = trust.owner === this.myName();
        if (out.isOwner) {
            const manage = await this.addonCoinsApi(`/api/addons/${encodeURIComponent(instance.id)}/manage`, { interactive: false });
            out.balance = Number(manage?.treasury?.balance) || 0;
            out.withdrawable = Number(manage?.treasury?.withdrawable) || 0;
            out.locked = Number(manage?.treasury?.locked) || 0;
            out.nextUnlock = manage?.treasury?.nextUnlock || null;
        }
        return out;
    }

    // ---- zali.coins.deposit ----

    async addonCoinsDeposit(instance, params) {
        const amount = this.addonCoinsAmount(params);
        this.addonRequireVisible(instance, 'Перевод ZaliCoin');
        const trust = await this.addonCoinsTrust(instance);
        if (!trust.ok) throw this.addonError(trust.code || 'not_signed', trust.reason);
        this.addonCoinsRateLimit(instance, 'Перевод');
        const note = Array.from(String(params?.note ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim()).slice(0, 140).join('');
        const balance = (await this.addonCoinsBalance()).balance;
        if (amount > balance) {
            throw this.addonError('insufficient_funds', `На вашем балансе ${balance.toLocaleString('ru-RU')} ZaliCoin — этого не хватает`);
        }
        const confirmed = await this.showAddonDepositDialog({ instance, trust, amount, note, balance });
        if (!confirmed) throw this.addonError('cancelled', 'Перевод отменён');
        const result = await this.addonCoinsApi(`/api/addons/${encodeURIComponent(instance.id)}/deposit`, {
            method: 'POST',
            body: JSON.stringify({ amount, note, idempotencyKey: this.zaliCoinNewIdempotencyKey() }),
        }, instance);
        this.scheduleZaliCoinRefresh?.();
        void this.refreshZaliCoinView?.();
        return { ok: true, deposited: amount, balance: Number(result?.balance) || 0 };
    }

    addonCoinsFormat(amount) {
        return `${Number(amount || 0).toLocaleString('ru-RU')} ZaliCoin`;
    }

    /** Картинка диалога: монета с «Z» уходит стрелкой в значок аддона. */
    addonCoinsArtHtml(meta) {
        return `<div class="addon-coin-art" aria-hidden="true">
            <span class="addon-coin-coin">
                <svg viewBox="0 0 64 64" focusable="false">
                    <defs>
                        <linearGradient id="addonCoinGrad" x1="0" y1="0" x2="1" y2="1">
                            <stop offset="0" stop-color="rgb(var(--accent-rgb))"/>
                            <stop offset="1" stop-color="rgb(var(--accent-rgb))" stop-opacity=".6"/>
                        </linearGradient>
                    </defs>
                    <circle cx="32" cy="32" r="30" fill="url(#addonCoinGrad)"/>
                    <circle cx="32" cy="32" r="23.5" fill="none" stroke="rgba(0,0,0,.3)" stroke-width="2"/>
                    <path d="M23 24h18L23 40h18" fill="none" stroke="rgba(0,0,0,.78)" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
            </span>
            <svg class="addon-coin-flow" viewBox="0 0 64 14" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M2 7h50" stroke-dasharray="2 7"/>
                <path d="M52 2l8 5-8 5"/>
            </svg>
            <span class="addon-coin-target">${this.addonIconHtml(meta)}</span>
        </div>`;
    }

    showAddonDepositDialog({ instance, trust, amount, note, balance }) {
        const m = instance.manifest;
        const meta = { manifest: m, iconDataUrl: instance.iconDataUrl || '' };
        const owner = trust.owner ? `@${this.esc(trust.owner)}` : 'автор неизвестен';
        const warning = trust.official
            ? `<p class="addon-coin-note is-official" role="note">Вы перечисляете свои ZaliCoin на баланс приложения «${this.esc(m.name)}» — официального аддона ZaliMessenger.</p>`
            : `<div class="addon-coin-note is-warning" role="alert">
                    <p><strong>Аддон не подписан сертификатом ZaliMessenger.</strong> Отправляя деньги, вы не можете быть уверены, что вас не обманут: приложение за аддон не отвечает. Автор — ${owner}.</p>
                    <label class="addon-coin-ack"><input type="checkbox" data-coin-ack> Понимаю риск</label>
               </div>`;
        const html = `
            ${this.addonCoinsArtHtml(meta)}
            <h2 id="addonDialogTitle" class="addon-coin-title">Перевести ${this.esc(this.addonCoinsFormat(amount))}</h2>
            <p class="addon-coin-sub">аддону «${this.esc(m.name)}» · на балансе станет ${this.esc(this.addonCoinsFormat(balance - amount))}</p>
            ${note ? `<p class="addon-coin-note-text">«${this.esc(note)}»</p>` : ''}
            ${warning}
            <div class="coin-transfer-actions">
                <button class="btn-flat" type="button" data-dialog-action="cancel">Отмена</button>
                <button class="auth-btn primary" type="button" data-dialog-action="ok"${trust.official ? '' : ' disabled data-needs-ack'}>Перевести</button>
            </div>`;
        const promise = this.openAddonDialog(html).then(action => action === 'ok');
        // Строгое предупреждение: кнопка «Перевести» оживает только после галочки.
        const box = Array.from(document.querySelectorAll('.addon-dialog')).pop();
        const ack = box?.querySelector('[data-coin-ack]');
        const ok = box?.querySelector('[data-needs-ack]');
        if (ack && ok) ack.addEventListener('change', () => { ok.disabled = !ack.checked; });
        return promise;
    }

    // ---- zali.coins.withdraw ----

    /**
     * Человек забирает из аддона на свой баланс: свои же переведённые монеты, а у
     * официального аддона — ещё и то, что он решил выплатить. Недельное
     * удержание тут ни при чём: оно только у вывода разработчика (окно
     * управления в хабе, addonWithdrawRequest). Подтверждения нет: деньги идут
     * человеку, а не от него.
     */
    async addonCoinsWithdraw(instance, params) {
        const amount = this.addonCoinsAmount(params);
        this.addonRequireVisible(instance, 'Вывод ZaliCoin');
        const trust = await this.addonCoinsTrust(instance);
        if (!trust.ok) throw this.addonError(trust.code || 'not_signed', trust.reason);
        this.addonCoinsRateLimit(instance, 'Вывод');
        const result = await this.addonCoinsApi(`/api/addons/${encodeURIComponent(instance.id)}/payout`, {
            method: 'POST',
            body: JSON.stringify({ amount, idempotencyKey: this.zaliCoinNewIdempotencyKey() }),
        });
        this.addonRegistryForget(instance.id);
        this.scheduleZaliCoinRefresh?.();
        void this.refreshZaliCoinView?.();
        return {
            ok: true,
            withdrawn: amount,
            balance: Number(result?.balance) || 0,
            available: Number(result?.available) || 0,
        };
    }

    /** Вывод разработчика из казны своего аддона — только окно управления в хабе. */
    async addonWithdrawRequest(id, amount) {
        const result = await this.addonCoinsApi(`/api/addons/${encodeURIComponent(id)}/withdraw`, {
            method: 'POST',
            body: JSON.stringify({ amount, idempotencyKey: this.zaliCoinNewIdempotencyKey() }),
        });
        void this.refreshZaliCoinView?.();
        return {
            ok: true,
            withdrawn: amount,
            balance: Number(result?.balance) || 0,
            treasury: result?.treasury || null,
        };
    }
});
