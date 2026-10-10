// --- ZaliInterface: Игровой статус («Играет в …»). ---
// Часть класса ZaliInterface (см. web/src/interface.js).
//
// Как это устроено, чтобы не разъехалось между оболочками:
//  - ЧТО запущено, знает только нативная оболочка (macOS Swift
//    Services/GameDetector.swift, Windows native/game_detector.rs). Она читает
//    список процессов и присылает сюда готовое «название + источник» как
//    realtime-событие `native_game_activity` — тот же проброс, что у кадров
//    сервера, поэтому новых каналов в мосте нет.
//  - КАК это применить — решает только этот файл: переключатель приватности,
//    ручной статус, список «это не игра», время начала, отправка на сервер.
//    Оболочка ничего не знает о настройках и ничего не шлёт на сервер сама.
//  - Каталог известных игр лежит здесь, в одном месте, и уходит оболочке в
//    GAME_DETECTOR_CONFIG при включении. Поэтому правка каталога — это правка
//    одного файла, а не трёх.
//  - Сервер (server/src/activity.rs) хранит статус только в памяти, привязанным
//    к сокету, и рассылает друзьям и соседям по серверам.
//
// Браузер/PWA процессов не видит: там работает только ручной статус.
ZaliMixin(ZaliInterface, class {

    // ------------------------------------------------------------
    // Каталог: имя процесса (нижний регистр, без .exe/.app) → название.
    // Намеренно нет «java»/«javaw»: под ними живёт всё что угодно.
    // ------------------------------------------------------------

    gameCatalog() {
        return [
            ['Counter-Strike 2', ['cs2']],
            ['Dota 2', ['dota2']],
            ['VALORANT', ['valorant-win64-shipping', 'valorant']],
            ['League of Legends', ['league of legends', 'leagueoflegends']],
            ['Fortnite', ['fortniteclient-win64-shipping']],
            ['Apex Legends', ['r5apex', 'r5apex_dx12']],
            ['PUBG: BATTLEGROUNDS', ['tslgame']],
            ['Overwatch 2', ['overwatch']],
            ['Rocket League', ['rocketleague']],
            ['Grand Theft Auto V', ['gta5', 'gta5_enhanced']],
            ['Red Dead Redemption 2', ['rdr2']],
            ['Cyberpunk 2077', ['cyberpunk2077']],
            ['The Witcher 3', ['witcher3']],
            ['ELDEN RING', ['eldenring']],
            ['DARK SOULS III', ['darksoulsiii']],
            ['Sekiro', ['sekiro']],
            ["Baldur's Gate 3", ['bg3', 'bg3_dx11']],
            ['Hades', ['hades']],
            ['Hades II', ['hades2']],
            ['Terraria', ['terraria']],
            ['Stardew Valley', ['stardew valley', 'stardewvalley']],
            ['Minecraft', ['minecraft', 'minecraft.windows']],
            ['Roblox', ['robloxplayerbeta', 'robloxplayer']],
            ['World of Warcraft', ['wow', 'wowclassic', 'wow-64', 'world of warcraft']],
            ['Diablo IV', ['diablo iv']],
            ['Hearthstone', ['hearthstone']],
            ['StarCraft II', ['sc2', 'sc2_x64']],
            ['Warcraft III', ['warcraft iii', 'war3']],
            ['Warframe', ['warframe.x64', 'warframe']],
            ['Destiny 2', ['destiny2']],
            ["Tom Clancy's Rainbow Six Siege", ['rainbowsix', 'rainbowsix_vulkan']],
            ['Call of Duty', ['cod', 'modernwarfare', 'blackops4']],
            ['Battlefield 2042', ['bf2042']],
            ['Battlefield V', ['bfv']],
            ['Escape from Tarkov', ['escapefromtarkov']],
            ['Rust', ['rustclient', 'rust']],
            ['ARK: Survival Evolved', ['shootergame']],
            ['Valheim', ['valheim']],
            ['Satisfactory', ['factorygame']],
            ['Factorio', ['factorio']],
            ['RimWorld', ['rimworldwin64', 'rimworld']],
            ['Sid Meier’s Civilization VI', ['civilizationvi']],
            ['Cities: Skylines', ['cities']],
            ['Among Us', ['among us']],
            ['Fall Guys', ['fallguys_client']],
            ['Genshin Impact', ['genshinimpact', 'yuanshen']],
            ['Honkai: Star Rail', ['starrail']],
            ['Zenless Zone Zero', ['zenlesszonezero']],
            ['Path of Exile', ['pathofexile', 'pathofexile_x64', 'pathofexilesteam']],
            ['Lost Ark', ['lostark']],
            ['Team Fortress 2', ['tf_win64', 'tf2']],
            ['Left 4 Dead 2', ['left4dead2']],
            ['Portal 2', ['portal2']],
            ["Garry's Mod", ['gmod']],
            // Stable и lazer на Windows — один и тот же osu!.exe: различаются только
            // папкой установки (\osu!\ против \osulazer\), поэтому у них `path`.
            ['osu!', ['osu!'], { path: '\\osu!\\' }],
            ['osu!lazer', ['osu!'], { path: 'osulazer' }],
            ['osu!lazer', ['sh.ppy.osu.lazer', 'osulazer']],
            // project8 — прежнее кодовое имя процесса, оставлено для старых установок.
            ['Deadlock', ['deadlock', 'project8']],
            ['Celeste', ['celeste']],
            ['Hollow Knight', ['hollow_knight']],
            ['Dead Cells', ['deadcells']],
            ['Subnautica', ['subnautica']],
            ["No Man's Sky", ['nms']],
            ['Starfield', ['starfield']],
            ['The Elder Scrolls V: Skyrim', ['skyrimse', 'tesv', 'skyrim']],
            ['Fallout 4', ['fallout4']],
            ['Fallout 76', ['fallout76']],
            ['Hogwarts Legacy', ['hogwartslegacy']],
            ['Palworld', ['palworld-win64-shipping']],
            ['Lethal Company', ['lethal company']],
            ['Phasmophobia', ['phasmophobia']],
            ['Helldivers 2', ['helldivers2']],
            ['Monster Hunter: World', ['monsterhunterworld']],
            ['Monster Hunter Rise', ['monsterhunterrise']],
            ['Monster Hunter Wilds', ['monsterhunterwilds']],
            ['Street Fighter 6', ['streetfighter6']],
            ['EA SPORTS FC', ['fc24', 'fc25', 'fifa23', 'fifa22']],
            ['Forza Horizon 5', ['forzahorizon5']],
            ['Euro Truck Simulator 2', ['eurotrucks2']],
            ['Assetto Corsa', ['acs', 'assettocorsa']],
            ['World of Tanks', ['worldoftanks']],
            ['World of Warships', ['worldofwarships']],
            ['War Thunder', ['aces']],
            ['Age of Empires II', ['aoe2de_s']],
            ['Stellaris', ['stellaris']],
            ['Hearts of Iron IV', ['hoi4']],
            ['Europa Universalis IV', ['eu4']],
            ['Crusader Kings III', ['ck3']],
            ['Disco Elysium', ['discoelysium']],
            ['Undertale', ['undertale']],
            ['Cuphead', ['cuphead']],
            ["Don't Starve Together", ['dontstarve_steam']],
            ['The Binding of Isaac', ['isaac-ng']],
            ['Sea of Thieves', ['sotgame']],
            ['Deep Rock Galactic', ['fsd-win64-shipping']],
            ['Risk of Rain 2', ['risk of rain 2']],
            ['Content Warning', ['content warning']],
            ['Dead by Daylight', ['deadbydaylight-win64-shipping']],
            ['Teamfight Tactics', ['teamfighttactics']],
        ];
    }

    // Плоский вид для оболочки: {process, name[, path]}. Оболочка сравнивает имя
    // процесса без расширения, в нижнем регистре. Необязательный `path` — подстрока
    // пути к exe (без учёта регистра, `/` приравнен к `\`): запись подходит, только если
    // она в пути есть. Нужен там, где у разных игр один и тот же процесс.
    gameCatalogForNative() {
        const flat = [];
        for (const [name, processes, options] of this.gameCatalog()) {
            const path = String(options?.path || '').trim();
            for (const process of processes) {
                flat.push(path ? { process, name, path } : { process, name });
            }
        }
        return flat;
    }

    // ------------------------------------------------------------
    // Настройки (на устройстве, не на сервере: что показывать, решает машина)
    // ------------------------------------------------------------

    gameActivityStorageKey() {
        return 'zali_game_activity_v1';
    }

    gameActivityPrefs() {
        if (this._gameActivityPrefs) return this._gameActivityPrefs;
        let stored = {};
        try {
            stored = JSON.parse(localStorage.getItem(this.gameActivityStorageKey()) || '{}') || {};
        } catch (e) {}
        this._gameActivityPrefs = {
            // По умолчанию выключено: по статусу видно, чем человек занят прямо
            // сейчас, и включать это должен он сам.
            enabled: stored.enabled === true,
            manual: String(stored.manual || '').trim().slice(0, 64),
            ignored: Array.isArray(stored.ignored)
                ? stored.ignored.map(item => String(item || '').trim()).filter(Boolean).slice(0, 100)
                : [],
        };
        return this._gameActivityPrefs;
    }

    saveGameActivityPrefs(patch = {}) {
        const next = { ...this.gameActivityPrefs(), ...patch };
        next.manual = String(next.manual || '').trim().slice(0, 64);
        this._gameActivityPrefs = next;
        try {
            localStorage.setItem(this.gameActivityStorageKey(), JSON.stringify(next));
        } catch (e) {}
        this.syncGameDetector();
        this.publishGameActivity();
        this.renderGameActivitySettings();
        this.scheduleGameActivityRender();
    }

    gameActivityDetectionSupported() {
        return this.hasNativeBridge() && this.nativeSupports('gameActivity');
    }

    isGameIgnored(name) {
        const needle = String(name || '').trim().toLowerCase();
        if (!needle) return false;
        return this.gameActivityPrefs().ignored.some(item => item.toLowerCase() === needle);
    }

    // Что мы сейчас сообщаем о себе: null или {name, id, source, since}.
    //
    // Игру нужно знать в двух случаях: показ статуса другим включён, либо включён
    // режим «в игре» (game_focus.js — серверу надо понимать, что мы играем, чтобы
    // придержать уведомления). Поле `share` говорит серверу, можно ли показывать
    // название кому-то ещё: без показа статус живёт только для этого режима.
    effectiveGameActivity() {
        const prefs = this.gameActivityPrefs();
        const share = prefs.enabled;
        const focus = !!this.gameFocusEnabled?.();
        if ((!share && !focus) || !this.S.session?.token) return null;
        if (prefs.manual) {
            if (!this._manualGameSince || this._manualGameName !== prefs.manual) {
                this._manualGameName = prefs.manual;
                this._manualGameSince = Date.now();
            }
            return { name: prefs.manual, id: '', source: 'manual', since: this._manualGameSince, share };
        }
        const detected = this._detectedGame;
        if (!detected || this.isGameIgnored(detected.name)) return null;
        return { ...detected, share };
    }

    // ------------------------------------------------------------
    // Оболочка → JS: что запущено
    // ------------------------------------------------------------

    handleNativeGameActivity(payload) {
        const raw = payload?.activity;
        const name = String(raw?.name || '').trim();
        if (!name) {
            this._detectedGame = null;
        } else {
            const previous = this._detectedGame;
            const same = previous && previous.name === name && previous.id === String(raw.id || '');
            this._detectedGame = {
                name: name.slice(0, 64),
                id: String(raw.id || '').slice(0, 64),
                source: String(raw.source || 'process'),
                // Оболочка присылает событие при каждой смене, а не по таймеру, но
                // повтор того же — не повод сдвигать «играет с …».
                since: same ? previous.since : Date.now(),
            };
        }
        this.publishGameActivity();
        this.renderGameActivitySettings();
        // Игра кончилась, а очередь отложенных не пуста: сервер сбросит её сам, это резерв.
        if (!this.effectiveGameActivity()) this.armLocalFocusFlush?.();
    }

    // Включить/выключить опрос процессов в оболочке. Каталог уходит только вместе
    // с `enabled: true` — выключенной оболочке он ни к чему.
    syncGameDetector() {
        if (!this.gameActivityDetectionSupported()) return;
        const enabled = (this.gameActivityPrefs().enabled || !!this.gameFocusEnabled?.())
            && !!this.S.session?.token;
        if (!enabled) this._detectedGame = null;
        const key = enabled ? 'on' : 'off';
        if (this._gameDetectorSyncedAs === key) return;
        this._gameDetectorSyncedAs = key;
        this.postNativeMessage({
            type: NativeMessageTypes.GAME_DETECTOR_CONFIG,
            enabled,
            games: enabled ? this.gameCatalogForNative() : [],
        });
    }

    // ------------------------------------------------------------
    // JS → сервер
    // ------------------------------------------------------------

    publishGameActivity({ force = false } = {}) {
        const me = this.myName?.() || '';
        if (this._gameActivityUser !== me) {
            // Другой аккаунт на этом же окне: его серверу мы ещё ничего не говорили,
            // а чужие статусы прежнего аккаунта показывать нельзя.
            this._gameActivityUser = me;
            this._lastPublishedGameKey = '';
            this._gameDetectorSyncedAs = '';
            this.S.gameActivities = {};
            this.scheduleGameActivityRender();
        }
        if (!me || !this.S.session?.token) return false;
        const activity = this.effectiveGameActivity();
        const key = activity
            ? `${activity.name}|${activity.id}|${activity.source}|${activity.since}|${activity.share ? 1 : 0}`
            : '';
        if (!force && key === this._lastPublishedGameKey) return false;
        // До первой отправки «ничего не играет» молчим: сервер и так ничего не знает.
        if (!key && !this._lastPublishedGameKey && !force) return false;
        const frame = {
            type: 'client_activity',
            activity: activity
                ? {
                    kind: 'game',
                    name: activity.name,
                    id: activity.id,
                    source: activity.source,
                    since: activity.since,
                    share: !!activity.share,
                }
                : null,
        };
        if (!this.sendClientActivityFrame(frame)) return false;
        this._lastPublishedGameKey = key;
        return true;
    }

    sendClientActivityFrame(frame) {
        if (this.nativeSupports('voice')) {
            // Тот же путь, что у голосовых событий: оболочка кладёт любой payload в
            // свой сокет и сама держит очередь на время реконнекта.
            return this.postNativeMessage({ type: NativeMessageTypes.VOICE_EVENT, payload: frame });
        }
        const socket = this.voice?.socket;
        if (!socket || typeof WebSocket === 'undefined' || socket.readyState !== WebSocket.OPEN) return false;
        try {
            socket.send(JSON.stringify(frame));
            return true;
        } catch (e) {
            return false;
        }
    }

    // Вызывается из setConnectionStatus(true): после реконнекта у сервера новое
    // соединение без статуса, и «повтор» ему нужен независимо от того, менялось ли что-то.
    onGameActivityConnected() {
        // Настройки режима «в игре» живут на сервере: подтянуть их на каждом входе —
        // от них зависит, нужно ли вообще определять игру (game_focus.js).
        const me = this.myName?.() || '';
        if (me && this._gameFocusLoadedFor !== me) void this.loadGameFocusSettings?.();
        this.syncGameDetector();
        this.publishGameActivity({ force: !!this.effectiveGameActivity() });
        if (this._gameActivityTimer) return;
        // Страховка от потерянного кадра и от рестарта сервера. Сервер сравнивает с
        // текущим значением и при повторе не рассылает ничего.
        this._gameActivityTimer = setInterval(() => {
            // Пока связи нет, оболочка складывает кадры в очередь, а у очереди есть
            // потолок — копить в ней повторы одного и того же незачем.
            if (this.S.wsOn && this.effectiveGameActivity()) this.publishGameActivity({ force: true });
        }, 25000);
    }

    // ------------------------------------------------------------
    // Сервер → JS: чужие статусы
    // ------------------------------------------------------------

    gameActivityMap() {
        if (!this.S.gameActivities || typeof this.S.gameActivities !== 'object') this.S.gameActivities = {};
        return this.S.gameActivities;
    }

    normalizeRemoteGameActivity(raw) {
        const name = String(raw?.name || '').trim();
        if (!name) return null;
        return {
            name: name.slice(0, 64),
            id: String(raw.id || '').slice(0, 64),
            source: String(raw.source || 'process'),
            since: Number(raw.since) || 0,
        };
    }

    handleGameActivityRealtime(payload) {
        const type = String(payload?.type || '');
        if (type === 'native_game_activity') {
            this.handleNativeGameActivity(payload);
            return;
        }
        const me = this.myName?.() || '';
        const map = this.gameActivityMap();
        if (type === 'activity_snapshot') {
            const next = {};
            const entries = payload.activities && typeof payload.activities === 'object' ? payload.activities : {};
            for (const [username, raw] of Object.entries(entries)) {
                const activity = this.normalizeRemoteGameActivity(raw);
                if (activity && username && username !== me) next[username] = activity;
            }
            this.S.gameActivities = next;
        } else if (type === 'user_activity') {
            const username = String(payload.username || '').trim();
            if (!username || username === me) return;
            const activity = this.normalizeRemoteGameActivity(payload.activity);
            if (activity) map[username] = activity;
            else delete map[username];
        }
        this.scheduleGameActivityRender();
    }

    // Для самого себя — то, что мы сообщаем, для остальных — то, что прислал сервер.
    gameActivityFor(username) {
        const name = String(username || '');
        if (!name) return null;
        // Свой статус на экране — только если мы его показываем: «в игре» для
        // режима уведомлений не повод рисовать значок у себя в профиле.
        if (name === (this.myName?.() || '')) {
            const own = this.effectiveGameActivity();
            return own?.share ? own : null;
        }
        return this.gameActivityMap()[name] || null;
    }

    // ------------------------------------------------------------
    // Отрисовка
    // ------------------------------------------------------------

    gameActivityIconHTML() {
        return '<svg class="game-activity-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 11h4M8 9v4"/><circle cx="15.5" cy="10.5" r=".6"/><circle cx="17.5" cy="12.5" r=".6"/><path d="M17.3 5H6.7a4 4 0 0 0-3.9 3.2l-1.3 6.4A2.5 2.5 0 0 0 5.9 17l1.6-2.2a2 2 0 0 1 1.6-.8h5.8a2 2 0 0 1 1.6.8l1.6 2.2a2.5 2.5 0 0 0 4.4-2.4l-1.3-6.4A4 4 0 0 0 17.3 5Z"/></svg>';
    }

    gameActivityLabel(activity) {
        return activity?.name ? `Играет в ${activity.name}` : '';
    }

    gameActivityDuration(activity) {
        const since = Number(activity?.since) || 0;
        if (!since) return '';
        const minutes = Math.floor((Date.now() - since) / 60000);
        if (minutes < 1) return 'только что';
        if (minutes < 60) return `${minutes} мин`;
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
    }

    // Строка «🎮 Играет в X · 2 ч» для шапки чата и профиля.
    gameActivityLineHTML(username, { withDuration = true } = {}) {
        const activity = this.gameActivityFor(username);
        if (!activity) return '';
        const duration = withDuration ? this.gameActivityDuration(activity) : '';
        return `<span class="game-activity-line">${this.gameActivityIconHTML()}<span class="game-activity-text">${this.esc(this.gameActivityLabel(activity))}</span>${duration ? `<span class="game-activity-since">${this.esc(duration)}</span>` : ''}</span>`;
    }

    // Статусы приходят пачками (снимок при подключении — десятки записей), а
    // перерисовка списков не бесплатна: сводим всё к одному кадру.
    scheduleGameActivityRender() {
        if (this._gameActivityRenderQueued) return;
        this._gameActivityRenderQueued = true;
        const run = () => {
            this._gameActivityRenderQueued = false;
            this.renderGameActivityUi();
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
        else setTimeout(run, 0);
    }

    renderGameActivityUi() {
        try {
            this.renderContacts();
            if (this.S.navMode !== 'servers' && this.S.current) {
                this.updateChatHeaderCryptoKey({ peer: this.S.current });
            }
            if (this.ensureProfileState?.().open) this.renderProfileOverlay();
            const serverOverlay = document.getElementById('serverOverlay');
            if (serverOverlay && !serverOverlay.hidden && this.S.serverModal?.mode === 'edit') {
                this.renderServerModalMembers();
            }
        } catch (e) {
            this.trace?.(`renderGameActivityUi failed: ${e?.message || e}`);
        }
    }

    // ------------------------------------------------------------
    // Карточка в настройках
    // ------------------------------------------------------------

    renderGameActivitySettings() {
        const card = document.getElementById('gameActivitySettingsCard');
        if (!card) return;
        const prefs = this.gameActivityPrefs();
        const toggle = document.getElementById('inputGameActivity');
        if (toggle) toggle.checked = prefs.enabled;
        const manual = document.getElementById('inputGameActivityManual');
        if (manual && document.activeElement !== manual) manual.value = prefs.manual;
        const status = document.getElementById('gameActivityStatusText');
        const ignoredBox = document.getElementById('gameActivityIgnored');
        if (status) {
            const supported = this.gameActivityDetectionSupported();
            const detected = this._detectedGame;
            let text;
            if (!prefs.enabled) {
                text = 'Выключено: никто не видит, во что вы играете.';
            } else if (prefs.manual) {
                text = `Показываем вручную заданную игру: ${prefs.manual}.`;
            } else if (!supported) {
                text = 'В браузере процессы не видны — укажите игру вручную ниже. Автоопределение работает в приложении для macOS и Windows.';
            } else if (detected && this.isGameIgnored(detected.name)) {
                text = `Найдено «${detected.name}», но оно в списке «это не игра» — не показываем.`;
            } else if (detected) {
                text = `Сейчас определено: ${detected.name}.`;
            } else {
                text = 'Игра не найдена. Как только вы запустите известную игру, она появится у друзей и участников ваших серверов.';
            }
            status.textContent = text;
        }
        const hideBtn = document.getElementById('gameActivityNotGameBtn');
        if (hideBtn) {
            const detected = this._detectedGame;
            hideBtn.hidden = !(prefs.enabled && !prefs.manual && detected && !this.isGameIgnored(detected.name));
        }
        if (ignoredBox) {
            ignoredBox.innerHTML = prefs.ignored.length
                ? prefs.ignored.map(item => `<button type="button" class="btn-flat" data-game-activity-unignore="${this.esc(item)}" title="Снова показывать">${this.esc(item)} ×</button>`).join(' ')
                : '';
            ignoredBox.hidden = prefs.ignored.length === 0;
        }
    }

    bindGameActivitySettings() {
        const toggle = document.getElementById('inputGameActivity');
        if (toggle) {
            toggle.addEventListener('change', () => this.saveGameActivityPrefs({ enabled: !!toggle.checked }));
        }
        const manual = document.getElementById('inputGameActivityManual');
        if (manual) {
            manual.addEventListener('change', () => this.saveGameActivityPrefs({ manual: manual.value }));
        }
        const hideBtn = document.getElementById('gameActivityNotGameBtn');
        if (hideBtn) {
            hideBtn.addEventListener('click', () => {
                const name = this._detectedGame?.name;
                if (!name || this.isGameIgnored(name)) return;
                this.saveGameActivityPrefs({ ignored: [...this.gameActivityPrefs().ignored, name] });
            });
        }
        const ignoredBox = document.getElementById('gameActivityIgnored');
        if (ignoredBox) {
            ignoredBox.addEventListener('click', (event) => {
                const button = event.target.closest?.('[data-game-activity-unignore]');
                if (!button) return;
                const name = button.getAttribute('data-game-activity-unignore');
                this.saveGameActivityPrefs({
                    ignored: this.gameActivityPrefs().ignored.filter(item => item !== name),
                });
            });
        }
    }
});
