// --- ZaliInterface: Встроенный апдейтер клиента. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // --- App updates (macOS/Windows native shells only — see nativeSupports('appUpdate')) ---

    updateDeclinedStorageKey() {
        return 'zali_update_declined_version';
    }

    updateInstallAttemptsStorageKey() {
        return 'zali_update_install_attempts_v1';
    }

    // An install that silently doesn't take (Windows: the new .exe cannot be copied
    // over an installation in Program Files without elevation — the old binary is
    // restarted and the reason goes to updates/install.log) leaves the client on the
    // previous version, so the very next login finds the same "newer" release and
    // opens the same modal again. That is an unbreakable loop from the user's side:
    // accepting is what triggers it. Counting attempts per version turns the second
    // failure into a visible error instead of a third prompt.
    loadUpdateInstallAttempts() {
        try {
            const parsed = JSON.parse(localStorage.getItem(this.updateInstallAttemptsStorageKey()) || '{}');
            return {
                version: String(parsed?.version || ''),
                count: Number(parsed?.count) || 0,
            };
        } catch (e) {
            return { version: '', count: 0 };
        }
    }

    recordUpdateInstallAttempt(version) {
        const target = String(version || '').trim();
        if (!target) return;
        const previous = this.loadUpdateInstallAttempts();
        const next = {
            version: target,
            count: previous.version === target ? previous.count + 1 : 1,
        };
        try {
            localStorage.setItem(this.updateInstallAttemptsStorageKey(), JSON.stringify(next));
        } catch (e) {}
    }

    clearUpdateInstallAttempts() {
        try { localStorage.removeItem(this.updateInstallAttemptsStorageKey()); } catch (e) {}
    }

    // App version scheme: MAJOR.MINOR{a|b|r}BUILD, e.g. "0.2b9" (r=release >
    // b=beta > a=alpha at the same MAJOR.MINOR). Falls back to plain dotted
    // numeric versions (e.g. legacy "1.1.3") for compatibility with whatever the
    // server already has published in app_releases — those are treated as the
    // top ("release") channel so they compare purely by major.minor.patch.
    parseAppVersion(v) {
        const str = String(v || '').trim();
        const channeled = str.match(/^(\d+)\.(\d+)([abr])(\d+)$/i);
        if (channeled) {
            const channelRank = { a: 0, b: 1, r: 2 };
            return {
                major: parseInt(channeled[1], 10) || 0,
                minor: parseInt(channeled[2], 10) || 0,
                channel: channelRank[channeled[3].toLowerCase()],
                build: parseInt(channeled[4], 10) || 0,
            };
        }
        const parts = str.split('.').map(n => parseInt(n, 10) || 0);
        return {
            major: parts[0] || 0,
            minor: parts[1] || 0,
            channel: 2,
            build: parts[2] || 0,
        };
    }

    compareVersions(a, b) {
        const va = this.parseAppVersion(a);
        const vb = this.parseAppVersion(b);
        if (va.major !== vb.major) return va.major > vb.major ? 1 : -1;
        if (va.minor !== vb.minor) return va.minor > vb.minor ? 1 : -1;
        if (va.channel !== vb.channel) return va.channel > vb.channel ? 1 : -1;
        if (va.build !== vb.build) return va.build > vb.build ? 1 : -1;
        return 0;
    }

    isNewSchemeVersion(v) {
        return /^\d+\.\d+[abr]\d+$/i.test(String(v || '').trim());
    }

    // Unix-seconds cutoff for the one-time version-scheme migration: the
    // "1.1.4" release (first published 2026-07-27) exists only so pre-migration
    // clients (running the OLD compareVersions, which just splits on "." and
    // compares numbers) see a numeric bump and update — its actual bundled code
    // is build 0.2b9. Once a client is running that new code (and so already
    // understands MAJOR.MINOR{a|b|r}BUILD), a plain-numeric "latest" published
    // at or before this cutoff is that same legacy compatibility bump, not a
    // real newer release — comparing it via major-number alone (1 > 0) would
    // otherwise look newer than 0.2b9 forever and loop the update prompt.
    // Deliberately set days out (not pinned to that release's exact
    // publishedAt) — republishing "1.1.4" to fix e.g. its sha256 bumps
    // publishedAt each time, which would slip past an exact-timestamp cutoff.
    // Real post-migration releases (version matching the new scheme, or
    // published well after this date) are compared normally regardless.
    static VERSION_SCHEME_MIGRATION_CUTOFF_UNIX = 1785542400; // 2026-08-01T00:00:00Z

    async checkForAppUpdate() {
        if (!this.hasNativeBridge() || !this.nativeSupports('appUpdate')) return;
        const platform = String(window.__ZALI_NATIVE_PLATFORM || '').trim();
        const currentVersion = String(window.__ZALI_NATIVE_APP_VERSION || '').trim();
        if (!platform || !currentVersion) return;
        try {
            const res = await this.apiFetch(`/api/version?platform=${encodeURIComponent(platform)}`);
            if (!res.ok) return;
            const data = await res.json();
            const latestVersion = String(data?.version || '').trim();
            const publishedAt = Number(data?.publishedAt) || 0;
            const isLegacyMigrationBump = latestVersion
                && !this.isNewSchemeVersion(latestVersion)
                && publishedAt > 0
                && publishedAt <= ZaliInterface.VERSION_SCHEME_MIGRATION_CUTOFF_UNIX;
            if (isLegacyMigrationBump && this.isNewSchemeVersion(currentVersion)) {
                return;
            }
            if (!latestVersion || this.compareVersions(latestVersion, currentVersion) <= 0) {
                // We are running it — any earlier failed-install bookkeeping is stale.
                this.clearUpdateInstallAttempts();
                return;
            }
            // Reaching here after having already installed this exact version means the
            // install did not take. Keep the update reachable from the Hub, but stop
            // reopening the modal on every login.
            const attempts = this.loadUpdateInstallAttempts();
            const installKeepsFailing = attempts.version === latestVersion && attempts.count >= 2;
            this.S.updateStatus = {
                available: true,
                version: latestVersion,
                notes: String(data?.notes || ''),
                downloadUrl: String(data?.downloadUrl || ''),
                sha256: String(data?.sha256 || ''),
                mandatory: !!data?.mandatory,
                downloading: false,
                progress: 0,
                readyToInstall: false,
                error: installKeepsFailing
                    ? `Обновление ${latestVersion} уже устанавливалось, но версия не сменилась. Установите его вручную (на Windows — запустите приложение от имени администратора либо скачайте .exe по ссылке ниже).`
                    : '',
            };
            this.renderHub();
            const declined = (() => {
                try { return localStorage.getItem(this.updateDeclinedStorageKey()); } catch (e) { return null; }
            })();
            if (installKeepsFailing) {
                this.trace(`checkForAppUpdate install keeps failing version=${latestVersion} attempts=${attempts.count}`);
                return;
            }
            if (this.S.updateStatus.mandatory || declined !== latestVersion) {
                this.openUpdateModal();
            }
        } catch (e) {
            this.trace(`checkForAppUpdate failed err=${e?.message || e}`);
        }
    }

    openUpdateModal() {
        const modal = document.getElementById('updateAvailableModal');
        if (!modal || !this.S.updateStatus?.available) return;
        this.renderUpdateModal();
        modal.hidden = false;
    }

    closeUpdateModal() {
        const modal = document.getElementById('updateAvailableModal');
        if (modal) modal.hidden = true;
    }

    declineAppUpdate() {
        if (this.S.updateStatus?.mandatory) return;
        const version = String(this.S.updateStatus?.version || '').trim();
        if (version) {
            try { localStorage.setItem(this.updateDeclinedStorageKey(), version); } catch (e) {}
        }
        this.closeUpdateModal();
    }

    renderUpdateModal() {
        const modal = document.getElementById('updateAvailableModal');
        if (!modal) return;
        const status = this.S.updateStatus || {};
        const titleEl = modal.querySelector('#updateModalVersion');
        const notesEl = modal.querySelector('#updateModalNotes');
        const progressWrap = modal.querySelector('#updateModalProgressWrap');
        const progressBar = modal.querySelector('#updateModalProgressBar');
        const errorEl = modal.querySelector('#updateModalError');
        const acceptBtn = modal.querySelector('#updateModalAcceptBtn');
        const declineBtn = modal.querySelector('#updateModalDeclineBtn');
        if (titleEl) titleEl.textContent = `Доступно обновление v${status.version || ''}`;
        if (notesEl) notesEl.textContent = status.notes || 'Новая версия готова к загрузке.';
        if (errorEl) {
            errorEl.hidden = !status.error;
            errorEl.textContent = status.error || '';
        }
        if (declineBtn) declineBtn.hidden = !!status.downloading || !!status.readyToInstall || !!status.mandatory;
        if (progressWrap) progressWrap.hidden = !status.downloading;
        if (progressBar) progressBar.style.width = `${Math.round((status.progress || 0) * 100)}%`;
        if (acceptBtn) {
            if (status.readyToInstall) {
                acceptBtn.textContent = 'Перезапустить и установить';
                acceptBtn.disabled = false;
            } else if (status.downloading) {
                acceptBtn.textContent = `Загрузка… ${Math.round((status.progress || 0) * 100)}%`;
                acceptBtn.disabled = true;
            } else {
                acceptBtn.textContent = 'Обновить';
                acceptBtn.disabled = false;
            }
        }
    }

    async acceptAppUpdate() {
        const status = this.S.updateStatus || {};
        if (!status.available) return;
        if (status.readyToInstall) {
            this.recordUpdateInstallAttempt(status.version);
            this.requestNativeAction({ type: NativeMessageTypes.INSTALL_UPDATE_REQUEST }, 5000).catch(() => {});
            return;
        }
        if (status.downloading || !status.downloadUrl) return;
        this.S.updateStatus = { ...status, downloading: true, progress: 0, error: '' };
        this.renderUpdateModal();
        this.renderHub();
        try {
            await this.requestNativeAction({
                type: NativeMessageTypes.DOWNLOAD_UPDATE_REQUEST,
                url: status.downloadUrl,
                sha256: status.sha256,
            }, 10 * 60 * 1000);
            this.S.updateStatus = { ...this.S.updateStatus, downloading: false, progress: 1, readyToInstall: true };
        } catch (e) {
            this.S.updateStatus = { ...this.S.updateStatus, downloading: false, error: String(e?.message || e) };
        }
        this.renderUpdateModal();
        this.renderHub();
    }

    handleUpdateEvent(payload) {
        if (String(payload?.kind || '') !== 'progress') return;
        const status = this.S.updateStatus || {};
        if (!status.downloading) return;
        this.S.updateStatus = { ...status, progress: Number(payload?.progress || 0) };
        this.renderUpdateModal();
    }

    handleHubUpdateAction() {
        const status = this.S.updateStatus || {};
        if (!status.available) return;
        this.openUpdateModal();
    }
});
