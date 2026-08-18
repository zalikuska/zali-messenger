// --- ZaliInterface: Привязка DOM-событий и инерция прокрутки. ---
// Часть класса ZaliInterface (см. web/src/interface.js). Тела методов
// перенесены сюда дословно; ZaliMixin копирует дескрипторы на прототип,
// поэтому поведение и неперечисляемость методов те же, что у class-тела.
ZaliMixin(ZaliInterface, class {

    // --- UI Event Binding ---

    bindEvents() {
        // Метод был на 1512 строк. Разложен по назначению; порядок вызовов —
        // порядок исходных блоков, поэтому очерёдность регистрации слушателей
        // на одном и том же элементе не изменилась.
        this.bindContactListEvents();                     // списки контактов и каналов сервера
        this.bindVoicePanelEvents();                      // голосовая панель и плитки участников
        this.bindChatHeaderEvents();                      // шапка чата: звонок, видео, кнопка «назад»
        this.bindMessageListEvents();                     // список сообщений: реакции, ссылки, контекстное меню
        this.bindContactAddEvents();                      // добавление контакта и подсказки
        this.bindComposerEvents();                        // композер, вложения, перевод ZaliCoin, модалка обновления
        this.bindMessageInputEvents();                    // поле ввода: ввод, вставка, drag-and-drop
        this.bindSearchAndModeEvents();                   // поиск, переключение режима и сегментов хаба
        this.bindAuthEvents();                            // экран входа: форма, сеть, гость
        this.bindSettingsEvents();                        // настройки, сетевая конфигурация и модалка сервера
        this.bindStylerEvents();                          // выбор темы и селекторы стилизатора
        this.bindStyleSliderEvents();                     // слайдеры оформления
        this.bindCryptoKeyEvents();                       // ручной ввод ключа шифрования
        this.bindWindowChromeEvents();                    // перетаскивание окна, ресайз, горячие клавиши
    }

    /** Списки контактов и каналов сервера. Вызывается только из bindEvents(). */
    bindContactListEvents() {
        // 1. Click on contacts
        const contactsEl = document.getElementById('contacts');
        if (contactsEl) {
            contactsEl.addEventListener('click', (e) => {
                const serverBtn = e.target.closest('.server-item[data-server-id]');
                if (serverBtn) {
                    const serverId = serverBtn.getAttribute('data-server-id');
                    if (serverId) this.setActiveServer(serverId);
                    e.stopPropagation();
                    return;
                }
                const createBtn = e.target.closest('.server-create');
                if (createBtn) {
                    this.openServerModal('create');
                    e.stopPropagation();
                    return;
                }
                const joinBtn = e.target.closest('.server-join');
                if (joinBtn) {
                    this.openJoinCodeModal();
                    e.stopPropagation();
                    return;
                }
                const publicBtn = e.target.closest('.server-public');
                if (publicBtn) {
                    this.openPublicServersModal();
                    e.stopPropagation();
                    return;
                }
                const removeBtn = e.target.closest('.contact-remove');
                if (removeBtn) {
                    const username = removeBtn.getAttribute('data-remove-contact');
                    if (username) this.removeContact(username);
                    e.stopPropagation();
                    return;
                }
                const row = e.target.closest('.contact');
                if (row && row.dataset.name) this.switchChat(row.dataset.name);
            });
            contactsEl.addEventListener('contextmenu', (e) => {
                const row = e.target.closest('.contact');
                if (!row || !row.dataset.name) return;
                e.preventDefault();
                this.openContactContextMenu(row.dataset.name, e.clientX, e.clientY);
            });
        }

        const serverChannelList = document.getElementById('serverChannelList');
        if (serverChannelList) {
            serverChannelList.addEventListener('click', (e) => {
                const channelBtn = e.target.closest('.server-channel[data-channel-id]');
                if (!channelBtn) return;
                const channelId = channelBtn.getAttribute('data-channel-id');
                if (channelId) this.setActiveChannel(channelId);
            });
            serverChannelList.addEventListener('contextmenu', (e) => {
                const channelBtn = e.target.closest('.server-channel[data-channel-id]');
                if (!channelBtn) return;
                const sid = channelBtn.getAttribute('data-server-id');
                const cid = channelBtn.getAttribute('data-channel-id');
                if (channelBtn.getAttribute('data-channel-kind') === 'voice') return;
                e.preventDefault();
                if (sid && cid) this.toggleMuteChannel(sid, cid);
            });
        }

    }

    /** Голосовая панель и плитки участников. Вызывается только из bindEvents(). */
    bindVoicePanelEvents() {
        const voicePanel = document.getElementById('voicePanel');
        if (voicePanel) {
            voicePanel.addEventListener('click', async (e) => {
                const callBtn = e.target.closest('#voiceCallBtn');
                if (callBtn) {
                    await this.startDirectCall(this.S.current);
                    return;
                }
                const videoCallBtn = e.target.closest('#voiceVideoCallBtn');
                if (videoCallBtn) {
                    await this.startDirectCall(this.S.current, { video: true });
                    return;
                }
                const joinBtn = e.target.closest('#voiceJoinBtn');
                if (joinBtn) {
                    await this.joinVoiceChannel();
                    return;
                }
                const leaveBtn = e.target.closest('#voiceLeaveBtn');
                if (leaveBtn) {
                    await this.leaveVoiceRoom({ announce: true });
                    return;
                }
                const muteBtn = e.target.closest('#voiceMuteBtn');
                if (muteBtn) {
                    this.toggleVoiceMute();
                    return;
                }
                const deafenBtn = e.target.closest('#voiceDeafenBtn');
                if (deafenBtn) {
                    this.toggleVoiceDeafen();
                    return;
                }
                const collapseBtn = e.target.closest('#voiceCollapseBar');
                if (collapseBtn) {
                    this.toggleVoiceCallExpanded();
                    return;
                }
                // Bar click anywhere outside its own mute/deafen buttons expands to
                // the fullscreen grid — checked last so those two buttons (already
                // handled above) never also trigger an expand.
                const bar = e.target.closest('#voiceCallBar');
                if (bar) {
                    this.toggleVoiceCallExpanded();
                    return;
                }
                const cameraBtn = e.target.closest('#voiceCameraBtn');
                if (cameraBtn) {
                    await this.setVoiceCameraEnabled(!this.voice.cameraOn);
                    return;
                }
                const screenShareBtn = e.target.closest('#voiceScreenShareBtn');
                if (screenShareBtn) {
                    this.toggleScreenShare();
                    return;
                }
                const acceptBtn = e.target.closest('#voiceAcceptBtn');
                if (acceptBtn) {
                    await this.acceptIncomingCall();
                    return;
                }
                const rejectBtn = e.target.closest('#voiceRejectBtn');
                if (rejectBtn) {
                    await this.rejectIncomingCall();
                    return;
                }
                const cancelBtn = e.target.closest('#voiceCancelBtn');
                if (cancelBtn) {
                    const invite = this.voice.outgoingInvite;
                    if (invite?.roomId && invite?.target) {
                        this.sendVoiceEvent({
                            type: 'voice_call_cancel',
                            roomId: invite.roomId,
                            target: invite.target,
                        });
                    }
                    this.recordVoiceCallHistory({ outcome: 'cancelled', endedAt: Date.now() });
                    this.resetVoiceState({ preserveInvite: false });
                }
            });
            voicePanel.addEventListener('keydown', (e) => {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                if (e.target.closest('#voiceMuteBtn, #voiceDeafenBtn')) return;
                if (e.target.closest('#voiceCallBar, #voiceCollapseBar')) {
                    e.preventDefault();
                    this.toggleVoiceCallExpanded();
                }
            });
        }

    }

    /** Шапка чата: звонок, видео, кнопка «назад». Вызывается только из bindEvents(). */
    bindChatHeaderEvents() {
        const chatCallBtn = document.getElementById('chatCallBtn');
        if (chatCallBtn) {
            chatCallBtn.addEventListener('click', async () => {
                if (!this.S.current) return;
                await this.startDirectCall(this.S.current);
            });
        }

        const chatVideoCallBtn = document.getElementById('chatVideoCallBtn');
        if (chatVideoCallBtn) {
            chatVideoCallBtn.addEventListener('click', async () => {
                if (!this.S.current) return;
                await this.startDirectCall(this.S.current, { video: true });
            });
        }

        // Mobile chat app-bar back chevron: returns to the dialog list screen
        // via the same push-nav path a back-swipe uses.
        const chatBackBtn = document.getElementById('chatBackBtn');
        if (chatBackBtn) {
            chatBackBtn.addEventListener('click', () => this.openChatView({ showList: true }));
        }

    }

    /** Список сообщений: реакции, ссылки, контекстное меню. Вызывается только из bindEvents(). */
    bindMessageListEvents() {
        const msgsEl = document.getElementById('msgs');
        if (msgsEl) {
            msgsEl.addEventListener('scroll', () => this.onMessagesScroll(), { passive: true });
            msgsEl.addEventListener('click', (e) => {
                const fileLink = e.target.closest('a.file-chip, a.file-message');
                if (fileLink) {
                    e.preventDefault();
                    e.stopPropagation();
                    const href = fileLink.getAttribute('href') || '';
                    const filename = fileLink.getAttribute('download') || fileLink.textContent || 'attachment';
                    this.downloadAttachmentFromHref(href, filename);
                    return;
                }
                const quote = e.target.closest('.msg-quote[data-reply-target]');
                if (quote) {
                    e.stopPropagation();
                    this.scrollToMessage(quote.getAttribute('data-reply-target'));
                    return;
                }
                const reactionBtn = e.target.closest('[data-message-reaction]');
                if (reactionBtn) {
                    const messageId = reactionBtn.getAttribute('data-message-id');
                    const emoji = reactionBtn.getAttribute('data-message-reaction');
                    if (messageId && emoji) {
                        this.addReaction(messageId, emoji);
                    }
                    e.stopPropagation();
                    return;
                }
                this.hideReactionMenu();
            });
            msgsEl.addEventListener('contextmenu', (e) => {
                const msgEl = e.target.closest('.msg[data-message-id]');
                if (!msgEl) return;
                const messageId = msgEl.getAttribute('data-message-id');
                if (!messageId) return;
                e.preventDefault();
                this.showReactionMenu(msgEl, messageId, e.clientX, e.clientY);
                e.stopPropagation();
            });
        }

        document.addEventListener('click', (e) => {
            const menu = document.getElementById('reactionMenu');
            if (!menu || !menu.classList.contains('visible')) return;
            if (menu.contains(e.target)) return;
            if (e.target.closest('.msg[data-message-id]')) return;
            this.hideReactionMenu();
        });
        window.addEventListener('blur', () => this.hideReactionMenu());

        // Catches every auto-linked URL in message text (renderMessageText),
        // wherever it's rendered — not scoped to #msgs, so it also covers any
        // future spot that reuses the same target="_blank" markup. No-ops (and
        // lets the default navigation happen) outside a native shell.
        document.addEventListener('click', (e) => {
            const link = e.target.closest('a[target="_blank"]');
            if (!link) return;
            const href = link.getAttribute('href') || '';
            if (this.openExternalLink(href)) {
                e.preventDefault();
            }
        });

    }

    /** Добавление контакта и подсказки. Вызывается только из bindEvents(). */
    bindContactAddEvents() {
        const contactAddBtn = document.getElementById('contactAddBtn');
        if (contactAddBtn) {
            contactAddBtn.addEventListener('click', () => {
                if (!this.S.session?.token) return;
                if (!this.S.contactAddMode) {
                    this.enterContactAddMode();
                    return;
                }
                this.addContactFromInput();
            });
        }

        const contactSuggestions = document.getElementById('contactSuggestions');
        if (contactSuggestions) {
            contactSuggestions.addEventListener('pointerdown', (e) => {
                const item = e.target.closest('.contact-suggest-item');
                if (!item) return;
                e.preventDefault();
                const username = item.getAttribute('data-username');
                if (username) {
                    this.addContactFromInput(username);
                }
            });
        }

    }

    /** Композер, вложения, перевод ZaliCoin, модалка обновления. Вызывается только из bindEvents(). */
    bindComposerEvents() {
        // 2. Click send button & keyboard listener
        const sendBtn = document.getElementById('sendBtn');
        if (sendBtn) sendBtn.addEventListener('click', () => this.sendInputMessage());

        const composerContext = document.getElementById('composerContext');
        if (composerContext) {
            composerContext.addEventListener('click', (e) => {
                if (e.target.closest('[data-composer-context-cancel]')) {
                    this.cancelComposerContext();
                }
            });
        }

        const attachBtn = document.getElementById('attachBtn');
        const attachmentInput = document.getElementById('attachmentInput');
        if (attachBtn && attachmentInput) {
            attachBtn.addEventListener('click', () => attachmentInput.click());
            attachmentInput.addEventListener('change', (e) => {
                this.handleFiles(e.target.files || []);
                e.target.value = '';
            });
        }

        const coinTransferBtn = document.getElementById('coinTransferBtn');
        if (coinTransferBtn) {
            coinTransferBtn.addEventListener('click', () => {
                // In a DM the peer is the obvious recipient; in a server channel
                // (or with no active chat) there is no single peer — open the
                // wallet-style modal with a free recipient field instead of
                // silently doing nothing.
                const isDm = this.currentConversationMode() !== 'servers';
                this.openCoinTransferModal(isDm && this.S.current ? this.S.current : '');
            });
        }
        const zaliCoinSendBtn = document.getElementById('zaliCoinSendBtn');
        if (zaliCoinSendBtn) zaliCoinSendBtn.addEventListener('click', () => this.openCoinTransferModal());
        const coinTransferModal = document.getElementById('coinTransferModal');
        const coinTransferCloseBtn = document.getElementById('coinTransferCloseBtn');
        const coinTransferCancelBtn = document.getElementById('coinTransferCancelBtn');
        const coinTransferSubmitBtn = document.getElementById('coinTransferSubmitBtn');
        if (coinTransferCloseBtn) coinTransferCloseBtn.addEventListener('click', () => this.closeCoinTransferModal());
        if (coinTransferCancelBtn) coinTransferCancelBtn.addEventListener('click', () => this.closeCoinTransferModal());
        if (coinTransferSubmitBtn) coinTransferSubmitBtn.addEventListener('click', () => this.submitCoinTransfer());
        if (coinTransferModal) {
            coinTransferModal.addEventListener('click', (e) => {
                if (e.target === coinTransferModal) this.closeCoinTransferModal();
            });
        }
        const updateModalDeclineBtn = document.getElementById('updateModalDeclineBtn');
        const updateModalAcceptBtn = document.getElementById('updateModalAcceptBtn');
        if (updateModalDeclineBtn) updateModalDeclineBtn.addEventListener('click', () => this.declineAppUpdate());
        if (updateModalAcceptBtn) updateModalAcceptBtn.addEventListener('click', () => this.acceptAppUpdate());
        const coinTransferAmountInput = document.getElementById('coinTransferAmountInput');
        if (coinTransferAmountInput) {
            coinTransferAmountInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); this.submitCoinTransfer(); }
            });
        }
        const coinTransferRecipientInput = document.getElementById('coinTransferRecipientInput');
        if (coinTransferRecipientInput) {
            coinTransferRecipientInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); coinTransferAmountInput?.focus(); }
            });
        }

    }

    /** Поле ввода: ввод, вставка, drag-and-drop. Вызывается только из bindEvents(). */
    bindMessageInputEvents() {
        const msgInput = document.getElementById('msgInput');
        if (msgInput) {
            msgInput.addEventListener('input', () => {
                this.resizeComposer();
                this.updateSendButtonState();
            });
            msgInput.addEventListener('keydown', (e) => {
                // Escape backs out of a reply/edit without sending anything. Only
                // when one is active, so it keeps its usual meaning otherwise.
                if (e.key === 'Escape' && (this.S.replyDraft || this.S.editDraft)) {
                    e.preventDefault();
                    this.cancelComposerContext();
                    return;
                }
                if (e.key === 'Enter' && !e.shiftKey) { 
                    e.preventDefault(); 
                    this.sendInputMessage(); 
                }
            });
            msgInput.addEventListener('paste', (e) => {
                const files = Array.from(e.clipboardData?.files || []).filter(Boolean);
                if (files.length > 0) {
                    e.preventDefault();
                    this.handleFiles(files);
                }
            });
        }

        const inputBar = document.getElementById('inputBar');
        if (inputBar) {
            inputBar.addEventListener('dragover', (e) => {
                e.preventDefault();
                inputBar.classList.add('drop-active');
            });
            inputBar.addEventListener('dragleave', () => {
                inputBar.classList.remove('drop-active');
            });
            inputBar.addEventListener('drop', (e) => {
                e.preventDefault();
                inputBar.classList.remove('drop-active');
                const files = Array.from(e.dataTransfer?.files || []).filter(Boolean);
                if (files.length > 0) this.handleFiles(files);
            });
        }

        const draftAttachments = document.getElementById('draftAttachments');
        if (draftAttachments) {
            draftAttachments.addEventListener('click', (e) => {
                const btn = e.target.closest('.draft-att-remove');
                if (!btn) return;
                const id = btn.getAttribute('data-att-id');
                this.S.draftAttachments = this.S.draftAttachments.filter(att => att.id !== id);
                this.renderDraftAttachments();
                this.updateSendButtonState();
            });
        }

    }

    /** Поиск, переключение режима и сегментов хаба. Вызывается только из bindEvents(). */
    bindSearchAndModeEvents() {
        // 3. Search filter input (doubles as the contact-add input while contactAddMode is on)
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.addEventListener('input', (e) => {
                if (this.S.contactAddMode) {
                    const query = searchInput.value || '';
                    this.updateContactAddButtonState();
                    this.setContactStatus('');
                    this.renderContactSuggestions(true);
                    void this.loadUsers(query).then(() => this.renderContactSuggestions(true));
                    return;
                }
                this.S.searchQ = e.target.value;
                this.renderContacts();
            });
            searchInput.addEventListener('focus', () => {
                if (!this.S.contactAddMode) return;
                const query = searchInput.value || '';
                this.setContactStatus('');
                this.renderContactSuggestions(true);
                void this.loadUsers(query).then(() => this.renderContactSuggestions(true));
            });
            searchInput.addEventListener('blur', () => {
                if (!this.S.contactAddMode) return;
                setTimeout(() => {
                    if (!this.S.contactAddMode) return;
                    if (!String(searchInput.value || '').trim()) {
                        this.exitContactAddMode();
                    } else {
                        this.hideContactSuggestions();
                    }
                }, 120);
            });
            searchInput.addEventListener('keydown', (e) => {
                if (!this.S.contactAddMode) return;
                if (e.key === 'Escape') {
                    e.preventDefault();
                    this.exitContactAddMode();
                    searchInput.blur();
                    return;
                }
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.addContactFromInput();
                }
            });
        }

        const modeDmBtn = document.getElementById('modeDmBtn');
        const modeServersBtn = document.getElementById('modeServersBtn');
        if (modeDmBtn) modeDmBtn.addEventListener('click', () => this.setNavMode('dm'));
        if (modeServersBtn) modeServersBtn.addEventListener('click', () => this.setNavMode('servers'));
        const hubSegmentNav = document.getElementById('hubSegmentNav');
        if (hubSegmentNav) {
            hubSegmentNav.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-hub-segment]');
                if (!btn) return;
                this.handleHubSegment(btn.getAttribute('data-hub-segment'));
            });
        }

    }

    /** Экран входа: форма, сеть, гость. Вызывается только из bindEvents(). */
    bindAuthEvents() {
        const authForm = document.getElementById('authForm');
        const authLoginBtn = document.getElementById('authLoginBtn');
        if (authForm) {
            authForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitAuth(this.S.auth.mode);
            });
        }
        if (authLoginBtn) {
            authLoginBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.submitAuth(this.S.auth.mode);
            });
        }

        const authRegisterBtn = document.getElementById('authRegisterBtn');
        if (authRegisterBtn) authRegisterBtn.addEventListener('click', () => {
            this.setAuthMode(this.S.auth.mode === 'register' ? 'login' : 'register');
        });
        const inputVaultCloudSyncEnabled = document.getElementById('inputVaultCloudSyncEnabled');
        if (inputVaultCloudSyncEnabled) {
            inputVaultCloudSyncEnabled.addEventListener('change', () => {
                this.setVaultCloudSyncEnabled(!!inputVaultCloudSyncEnabled.checked);
            });
        }

        const authNetworkSaveBtn = document.getElementById('authNetworkSaveBtn');
        const authApiBaseUrl = document.getElementById('authApiBaseUrl');
        if (authApiBaseUrl) {
            authApiBaseUrl.addEventListener('input', () => {
                authApiBaseUrl.dataset.dirty = '1';
                const authNote = document.getElementById('authNetworkNote');
                const value = String(authApiBaseUrl.value || '').trim();
                if (authNote) {
                    authNote.textContent = value ? `Будет использован: ${value}` : 'Автоматически подставляется из настроек';
                }
            });
            authApiBaseUrl.addEventListener('blur', () => {
                this.syncAuthNetworkInput();
            });
        }
        if (authNetworkSaveBtn) {
            authNetworkSaveBtn.addEventListener('click', () => {
                const apiBaseUrl = String(authApiBaseUrl?.value || '').trim();
                if (!apiBaseUrl) {
                    this.addLogEntry({
                        type: 'ERROR',
                        msg: 'Укажите адрес API сервера',
                        ts: new Date().toLocaleTimeString(),
                    });
                    return;
                }
                const current = this.loadNetworkConfig();
                this.setNetworkConfig({
                    apiBaseUrl,
                    wsBaseUrl: this.deriveWsBaseUrl(apiBaseUrl),
                    iceServers: current.iceServers,
                });
                if (authApiBaseUrl) {
                    authApiBaseUrl.dataset.dirty = '0';
                }
                this.addLogEntry({
                    type: 'SUCCESS',
                    msg: `Адрес сервера обновлён: ${apiBaseUrl}`,
                    ts: new Date().toLocaleTimeString(),
                });
                this.updateAuthView();
            });
        }

        const authGuestBtn = document.getElementById('authGuestBtn');
        if (authGuestBtn) authGuestBtn.addEventListener('click', () => this.continueAsGuest());

        const authUsername = document.getElementById('authUsername');
        const authPassword = document.getElementById('authPassword');
        if (authUsername) {
            authUsername.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.submitAuth(this.S.auth.mode);
                }
            });
        }
        if (authPassword) {
            authPassword.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    this.submitAuth(this.S.auth.mode);
                }
            });
        }
        if (authApiBaseUrl) {
            authApiBaseUrl.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    authNetworkSaveBtn?.click();
                }
            });
        }

        this.initA2hsBanner();

        requestAnimationFrame(() => {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        });
        setTimeout(() => {
            this.clearAuthInputs();
            this.S.auth.fieldsCleared = true;
        }, 120);

    }

    /** Настройки, сетевая конфигурация и модалка сервера. Вызывается только из bindEvents(). */
    bindSettingsEvents() {
        const settingsBtn = document.getElementById('settingsBtn');
        const serverSettingsBtn = document.getElementById('serverSettingsBtn');
        const serverOverlay = document.getElementById('serverOverlay');
        const serverModalClose = document.getElementById('serverModalClose');
        const serverModalCancel = document.getElementById('serverModalCancel');
        const serverSaveBtn = document.getElementById('serverSaveBtn');
        const serverDeleteBtn = document.getElementById('serverDeleteBtn');
        const serverMemberAddBtn = document.getElementById('serverMemberAddBtn');
        const serverJoinLinkGenerateBtn = document.getElementById('serverJoinLinkGenerateBtn');
        const serverJoinLinkCopyBtn = document.getElementById('serverJoinLinkCopyBtn');
        const serverAvatarUploadBtn = document.getElementById('serverAvatarUploadBtn');
        const serverAvatarRemoveBtn = document.getElementById('serverAvatarRemoveBtn');
        const serverBannerUploadBtn = document.getElementById('serverBannerUploadBtn');
        const serverBannerRemoveBtn = document.getElementById('serverBannerRemoveBtn');
        const serverRoleCreateBtn = document.getElementById('serverRoleCreateBtn');
        const serverRoleNameInput = document.getElementById('serverRoleNameInput');
        const settingsLogoutBtn = document.getElementById('settingsLogoutBtn');
        const clearLogsBtn = document.getElementById('clearLogs');
        const closeSettings = document.getElementById('closeSettings');
        const resetEncryptionKeysBtn = document.getElementById('resetEncryptionKeysBtn');
        const networkConfigSaveBtn = document.getElementById('networkConfigSaveBtn');
        const networkConfigResetBtn = document.getElementById('networkConfigResetBtn');
        const networkTurnApplyBtn = document.getElementById('networkTurnApplyBtn');
        const networkTurnFillBtn = document.getElementById('networkTurnFillBtn');
        const inputApiBaseUrl = document.getElementById('inputApiBaseUrl');
        const inputWsBaseUrl = document.getElementById('inputWsBaseUrl');
        const inputIceServers = document.getElementById('inputIceServers');
        const deviceTrustRefreshBtn = document.getElementById('deviceTrustRefreshBtn');
        const deviceVaultExportBtn = document.getElementById('deviceVaultExportBtn');
        const deviceVaultImportBtn = document.getElementById('deviceVaultImportBtn');
        const deviceTrustList = document.getElementById('deviceTrustList');
        const avatarUploadBtn = document.getElementById('avatarUploadBtn');
        const avatarResetBtn = document.getElementById('avatarResetBtn');
        const meAva = document.getElementById('meAva');
        const inputUiV2Enabled = document.getElementById('inputUiV2Enabled');
        const inputExperimentalDesign = document.getElementById('inputExperimentalDesign');
        const inputVoiceTrace = document.getElementById('inputVoiceTrace');
        const hubSegmentSettings = document.getElementById('hubSegmentSettings');
        const recentAccounts = document.getElementById('recentAccounts');
        const inputAudioMic = document.getElementById('inputAudioMic');
        const inputAudioSpeaker = document.getElementById('inputAudioSpeaker');
        const inputMasterVolume = document.getElementById('inputMasterVolume');

        const openAvatarPicker = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            input.style.top = '0';
            input.style.width = '1px';
            input.style.height = '1px';
            input.style.opacity = '0';
            input.setAttribute('aria-hidden', 'true');
            document.body.appendChild(input);

            const cleanup = () => {
                input.removeEventListener('change', onChange);
                input.remove();
            };

            const onChange = async () => {
                const file = input.files && input.files[0];
                if (!file) {
                    cleanup();
                    return;
                }
                try {
                    const cropped = await this.openAvatarCropper(file);
                    if (!cropped) {
                        cleanup();
                        return;
                    }
                    await this.setProfileAvatar(cropped, this.myName());
                    this.addLogEntry({ type: 'SUCCESS', msg: `Аватар обновлён: ${this.myName()}`, ts: new Date().toLocaleTimeString() });
                } catch (err) {
                    this.addLogEntry({ type: 'ERROR', msg: err?.message || 'Не удалось обновить аватар', ts: new Date().toLocaleTimeString() });
                } finally {
                    cleanup();
                }
            };

            input.addEventListener('change', onChange, { once: true });
            input.click();
        };

        const showChatView = () => {
            this.openChatView();
        };

        const showSettingsView = () => {
            this.openSettingsView();
        };

        if (settingsBtn) settingsBtn.addEventListener('click', () => {
            this.applyNetworkConfigToInputs();
            this.renderUiV2Settings();
            this.renderAudioDeviceSettings();
            showSettingsView();
        });
        if (inputAudioMic) {
            inputAudioMic.addEventListener('change', () => {
                this.setAudioInputDevice(inputAudioMic.value);
            });
        }
        if (inputAudioSpeaker) {
            inputAudioSpeaker.addEventListener('change', () => {
                this.setAudioOutputDevice(inputAudioSpeaker.value);
            });
        }
        if (inputMasterVolume) {
            inputMasterVolume.addEventListener('input', () => {
                this.setMasterVolumePercent(inputMasterVolume.value);
            });
        }
        if (navigator.mediaDevices?.addEventListener) {
            navigator.mediaDevices.addEventListener('devicechange', () => this.refreshAudioDeviceOptions());
        }
        if (inputUiV2Enabled) {
            inputUiV2Enabled.addEventListener('change', () => {
                this.saveUiV2Enabled(!!inputUiV2Enabled.checked);
            });
        }
        if (inputExperimentalDesign) {
            inputExperimentalDesign.addEventListener('change', () => {
                this.saveExperimentalDesign(!!inputExperimentalDesign.checked);
            });
        }
        if (inputVoiceTrace) {
            inputVoiceTrace.addEventListener('change', () => {
                this.saveVoiceTraceEnabled(!!inputVoiceTrace.checked);
            });
        }
        if (hubSegmentSettings) {
            hubSegmentSettings.addEventListener('change', () => {
                const selected = Array.from(hubSegmentSettings.querySelectorAll('input[type="checkbox"]:checked'))
                    .map(input => String(input.value || '').trim())
                    .filter(Boolean);
                if (!selected.length) {
                    const first = hubSegmentSettings.querySelector('input[type="checkbox"]');
                    if (first) {
                        first.checked = true;
                        selected.push(String(first.value || 'dm'));
                    }
                }
                this.saveUiV2Segments(selected.slice(0, 3));
            });
        }
        if (deviceTrustRefreshBtn) {
            deviceTrustRefreshBtn.addEventListener('click', () => this.refreshDeviceTrust());
        }
        if (deviceVaultExportBtn) {
            deviceVaultExportBtn.addEventListener('click', () => this.exportCurrentVaultPackage());
        }
        if (deviceVaultImportBtn) {
            deviceVaultImportBtn.addEventListener('click', () => this.importVaultPackageFromInputs());
        }
        if (deviceTrustList) {
            deviceTrustList.addEventListener('click', (e) => {
                const approveBtn = e.target.closest('[data-device-approve]');
                if (approveBtn) {
                    this.approveDeviceAndExport(approveBtn.getAttribute('data-device-approve'));
                    return;
                }
                const revokeBtn = e.target.closest('[data-device-revoke]');
                if (revokeBtn) {
                    this.revokeTrustedDevice(revokeBtn.getAttribute('data-device-revoke'));
                }
            });
        }
        if (serverSettingsBtn) {
            serverSettingsBtn.addEventListener('click', () => {
                if (this.canManageServer()) {
                    this.openServerModal('edit', this.S.activeServer);
                }
            });
        }
        if (serverOverlay) {
            serverOverlay.addEventListener('click', (e) => {
                if (e.target === serverOverlay) {
                    this.closeServerOverlay();
                }
            });
        }
        const serverModalNav = document.getElementById('serverModalNav');
        if (serverModalNav) {
            serverModalNav.addEventListener('click', (e) => {
                const btn = e.target.closest('[data-server-modal-section]');
                if (!btn || btn.hidden) return;
                const section = btn.getAttribute('data-server-modal-section');
                this.setServerModalSection(section);
            });
        }
        const serverModal = document.getElementById('serverModal');
        if (serverModal) {
            serverModal.addEventListener('click', (e) => {
                const toggle = e.target.closest('[data-color-picker-toggle]');
                if (!toggle) return;
                const key = String(toggle.getAttribute('data-color-picker-toggle') || '').trim();
                if (!key) return;
                this.toggleServerModalColorPicker(key);
            });
        }
        const serverDiscoverQuery = document.getElementById('serverDiscoverQuery');
        if (serverDiscoverQuery) {
            serverDiscoverQuery.addEventListener('input', () => this.renderPublicServersModal());
        }
        const serverDiscoverRefreshBtn = document.getElementById('serverDiscoverRefreshBtn');
        if (serverDiscoverRefreshBtn) {
            serverDiscoverRefreshBtn.addEventListener('click', () => this.loadPublicServers({ silent: true }));
        }
        if (serverModalClose) serverModalClose.addEventListener('click', () => this.closeServerOverlay());
        if (serverModalCancel) serverModalCancel.addEventListener('click', () => this.closeServerOverlay());
        if (serverSaveBtn) serverSaveBtn.addEventListener('click', () => this.submitServerModal());
        if (serverDeleteBtn) {
            serverDeleteBtn.addEventListener('click', async () => {
                const serverId = this.S.serverModal.serverId || this.S.activeServer;
                const server = (this.S.servers || []).find(item => item.id === serverId);
                if (!server || this.normalizeMemberRole(server.myRole || server.my_role || '') !== 'owner') return;
                const confirmDelete = confirm(`Удалить сервер "${server.name}"?`);
                if (!confirmDelete) return;
                try {
                    const res = await this.apiFetch(this.apiRoutes.servers.byId(serverId), { method: 'DELETE' });
                    if (!res.ok && res.status !== 204) {
                        throw new Error(await res.text() || 'Не удалось удалить сервер');
                    }
                    this.closeServerOverlay();
                    await this.loadServers({ silent: true });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось удалить сервер' });
                    this.renderServerModal();
                }
            });
        }
        if (serverMemberAddBtn) {
            serverMemberAddBtn.addEventListener('click', async () => {
                const serverId = this.S.serverModal.serverId;
                const input = document.getElementById('serverMemberInput');
                const roleSelect = document.getElementById('serverMemberRole');
                const username = (input?.value || '').trim();
                const role = roleSelect?.value || 'member';
                if (!serverId || !username) return;
                try {
                    const res = await this.apiFetch(this.apiRoutes.servers.members(serverId), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, role }),
                    });
                    if (!res.ok) {
                        throw new Error(await res.text() || 'Не удалось добавить участника');
                    }
                    if (input) input.value = '';
                    const data = await res.json();
                    this.setServerModalState({
                        members: Array.isArray(data?.members) ? data.members : this.S.serverModal.members,
                        error: '',
                    });
                    this.renderServerModal();
                    await this.loadServers({ silent: true });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось добавить участника' });
                    this.renderServerModal();
                }
            });
        }
        const serverChannelsList = document.getElementById('serverChannelsList');
        if (serverChannelsList) {
            serverChannelsList.addEventListener('click', async (e) => {
                const saveBtn = e.target.closest('[data-channel-save]');
                if (saveBtn) {
                    const channelId = saveBtn.getAttribute('data-channel-save');
                    try {
                        await this.saveServerChannel(channelId);
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось сохранить канал' });
                        this.renderServerModal();
                    }
                    return;
                }
                const deleteBtn = e.target.closest('[data-channel-delete]');
                if (deleteBtn) {
                    const channelId = deleteBtn.getAttribute('data-channel-delete');
                    if (!channelId) return;
                    try {
                        await this.deleteServerChannel(channelId);
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось удалить канал' });
                        this.renderServerModal();
                    }
                }
            });
        }
        if (serverJoinLinkGenerateBtn) {
            serverJoinLinkGenerateBtn.addEventListener('click', async () => {
                try {
                    const link = await this.generateServerJoinLink();
                    if (link) {
                        this.addLogEntry({ type: 'SUCCESS', msg: `Код сервера обновлён`, ts: new Date().toLocaleTimeString() });
                    }
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось обновить код' });
                    this.renderServerModal();
                }
            });
        }
        if (serverJoinLinkCopyBtn) {
            serverJoinLinkCopyBtn.addEventListener('click', async () => {
                const text = this.S.serverModal.joinLink || '';
                if (!text) return;
                try {
                    await navigator.clipboard.writeText(text);
                    this.addLogEntry({ type: 'SUCCESS', msg: 'Код сервера скопирован', ts: new Date().toLocaleTimeString() });
                } catch (e) {
                    this.addLogEntry({ type: 'WARN', msg: 'Не удалось скопировать код сервера', ts: new Date().toLocaleTimeString() });
                }
            });
        }
        const serverDiscoverList = document.getElementById('serverDiscoverList');
        if (serverDiscoverList) {
            serverDiscoverList.addEventListener('click', async (e) => {
                const card = e.target.closest('[data-public-server-id]');
                if (card && card.classList.contains('server-discover-item')) {
                    const serverId = card.getAttribute('data-public-server-id');
                    if (!serverId) return;
                    const server = (this.S.publicServers || []).find(item => String(item.id || '') === serverId);
                    if (!server) return;
                    const role = this.normalizeMemberRole(server.myRole || server.my_role || '');
                    if (role === 'owner' || role === 'admin' || role === 'member') {
                        this.closeServerOverlay();
                        this.setActiveServer(serverId);
                    } else {
                        await this.enterPublicServer(server.joinLink || server.join_link || server.id);
                    }
                    return;
                }
                const openBtn = e.target.closest('[data-public-server-open]');
                if (openBtn) {
                    const serverId = openBtn.getAttribute('data-public-server-open');
                    if (!serverId) return;
                    const server = (this.S.publicServers || []).find(item => String(item.id || '') === serverId);
                    if (!server) return;
                    if (this.normalizeMemberRole(server.myRole || server.my_role || '') === 'owner'
                        || this.normalizeMemberRole(server.myRole || server.my_role || '') === 'admin'
                        || this.normalizeMemberRole(server.myRole || server.my_role || '') === 'member') {
                        this.closeServerOverlay();
                        this.setActiveServer(serverId);
                        return;
                    }
                    await this.enterPublicServer(server.joinLink || server.join_link || server.id);
                    return;
                }
                const joinBtn = e.target.closest('[data-public-server-join]');
                if (joinBtn) {
                    await this.enterPublicServer(joinBtn.getAttribute('data-public-server-join'));
                }
            });
        }
        if (serverRoleCreateBtn) {
            serverRoleCreateBtn.addEventListener('click', async () => {
                const roleCreateOpen = !this.S.serverModal.roleCreateOpen;
                this.setServerModalState({ roleCreateOpen });
                this.renderServerModal();
            });
        }
        const serverChannelCreateBtn = document.getElementById('serverChannelCreateBtn');
        if (serverChannelCreateBtn) {
            serverChannelCreateBtn.addEventListener('click', async () => {
                if (this.S.serverModal.mode !== 'edit') return;
                const channelCreateOpen = !this.S.serverModal.channelCreateOpen;
                this.setServerModalState({ channelCreateOpen, error: '' });
                this.renderServerModal();
            });
        }
        const serverChannelCreateSubmitBtn = document.getElementById('serverChannelCreateSubmitBtn');
        if (serverChannelCreateSubmitBtn) {
            serverChannelCreateSubmitBtn.addEventListener('click', async () => {
                try {
                    await this.createServerChannel();
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось создать канал' });
                    this.renderServerModal();
                }
            });
        }
        const serverRoleCreateSubmitBtn = document.getElementById('serverRoleCreateSubmitBtn');
        if (serverRoleCreateSubmitBtn) {
            serverRoleCreateSubmitBtn.addEventListener('click', async () => {
                try {
                    const mode = this.S.serverModal.mode;
                    await this.createServerRole();
                    this.addLogEntry({
                        type: 'SUCCESS',
                        msg: mode === 'create' ? 'Черновик роли добавлен' : 'Роль создана',
                        ts: new Date().toLocaleTimeString(),
                    });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось создать роль' });
                    this.renderServerModal();
                }
            });
        }
        const pickServerAsset = (kind) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            input.style.position = 'fixed';
            input.style.left = '-9999px';
            input.style.top = '0';
            document.body.appendChild(input);
            input.addEventListener('change', async () => {
                const file = input.files && input.files[0];
                if (!file) {
                    input.remove();
                    return;
                }
                try {
                    await this.uploadServerAsset(kind, file);
                    this.addLogEntry({ type: 'SUCCESS', msg: `${kind === 'avatar' ? 'Аватар' : 'Баннер'} сервера обновлён`, ts: new Date().toLocaleTimeString() });
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось обновить медиа сервера' });
                    this.renderServerModal();
                } finally {
                    input.remove();
                }
            }, { once: true });
            input.click();
        };
        if (serverAvatarUploadBtn) serverAvatarUploadBtn.addEventListener('click', () => pickServerAsset('avatar'));
        if (serverBannerUploadBtn) serverBannerUploadBtn.addEventListener('click', () => pickServerAsset('banner'));
        if (serverAvatarRemoveBtn) {
            serverAvatarRemoveBtn.addEventListener('click', async () => {
                try {
                    await this.removeServerAsset('avatar');
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось удалить аватар' });
                    this.renderServerModal();
                }
            });
        }
        if (serverBannerRemoveBtn) {
            serverBannerRemoveBtn.addEventListener('click', async () => {
                try {
                    await this.removeServerAsset('banner');
                } catch (e) {
                    this.setServerModalState({ error: e?.message || 'Не удалось удалить баннер' });
                    this.renderServerModal();
                }
            });
        }
        if (settingsLogoutBtn) settingsLogoutBtn.addEventListener('click', () => this.logout());
        if (resetEncryptionKeysBtn) {
            const resetStatusEl = document.getElementById('resetEncryptionKeysStatus');
            const setResetStatus = (text, ok = true) => {
                if (!resetStatusEl) return;
                resetStatusEl.textContent = text;
                resetStatusEl.style.color = ok ? 'var(--lime)' : 'var(--red)';
                resetStatusEl.hidden = !text;
            };
            resetEncryptionKeysBtn.addEventListener('click', async () => {
                if (!confirm('Сбросить все ключи шифрования?\n\nВсе локальные ключи будут удалены, серверные энвелопы — тоже. После сброса ключи переустановятся автоматически при следующем сообщении.')) return;
                resetEncryptionKeysBtn.disabled = true;
                resetEncryptionKeysBtn.textContent = 'Сбрасываем…';
                setResetStatus('');
                try {
                    await this.resetEncryptionKeys();
                    setResetStatus('Ключи сброшены и перевыпущены');
                    this.addLogEntry({ type: 'SUCCESS', msg: 'Ключи шифрования сброшены и перевыпущены', ts: new Date().toLocaleTimeString() });
                } catch (e) {
                    setResetStatus(`Ошибка: ${e?.message || e}`, false);
                    this.addLogEntry({ type: 'ERROR', msg: `Сброс ключей не удался: ${e?.message || e}`, ts: new Date().toLocaleTimeString() });
                } finally {
                    resetEncryptionKeysBtn.disabled = false;
                    resetEncryptionKeysBtn.textContent = 'Сбросить ключи шифрования';
                    setTimeout(() => setResetStatus(''), 6000);
                }
            });
        }
        if (recentAccounts) {
            recentAccounts.addEventListener('click', (e) => {
                const target = e.target instanceof Element ? e.target : null;
                const switchBtn = target?.closest('[data-switch-account]');
                if (switchBtn && !switchBtn.disabled) {
                    this.switchRecentAccount(switchBtn.getAttribute('data-switch-account'));
                    return;
                }
                const removeBtn = target?.closest('[data-remove-recent-account]');
                if (removeBtn) {
                    this.forgetRecentAccount(removeBtn.getAttribute('data-remove-recent-account'));
                }
            });
        }
        if (avatarUploadBtn) {
            avatarUploadBtn.addEventListener('click', () => openAvatarPicker());
        }
        if (avatarResetBtn) {
            avatarResetBtn.addEventListener('click', async () => {
                try {
                    await this.resetProfileAvatar(this.myName());
                    this.addLogEntry({ type: 'SUCCESS', msg: 'Аватар профиля удалён', ts: new Date().toLocaleTimeString() });
                } catch (err) {
                    this.addLogEntry({ type: 'ERROR', msg: err?.message || 'Не удалось удалить аватар', ts: new Date().toLocaleTimeString() });
                }
            });
        }
        if (meAva) {
            meAva.title = 'Нажмите, чтобы сменить свой аватар';
            meAva.addEventListener('click', () => openAvatarPicker());
        }
        if (clearLogsBtn) {
            clearLogsBtn.addEventListener('click', () => {
                const logBody = document.getElementById('logBody');
                if (logBody) logBody.innerHTML = '';
            });
        }
        if (closeSettings) closeSettings.addEventListener('click', () => showChatView());
        const mobileMenuBtn = document.getElementById('mobileMenuBtn');
        if (mobileMenuBtn) {
            mobileMenuBtn.addEventListener('click', () => this.toggleMobileSidebar());
        }
        const mobileBackdrop = document.getElementById('mobileBackdrop');
        if (mobileBackdrop) {
            mobileBackdrop.addEventListener('click', () => this.closeMobileSidebar());
        }
        const mobileChatsBtn = document.getElementById('mobileChatsBtn');
        if (mobileChatsBtn) {
            mobileChatsBtn.addEventListener('click', () => {
                this.setNavMode('dm');
                this.openChatView({ showList: true });
            });
        }
        const mobileServersBtn = document.getElementById('mobileServersBtn');
        if (mobileServersBtn) {
            mobileServersBtn.addEventListener('click', () => {
                this.setNavMode('servers');
                this.openChatView({ showList: true });
            });
        }
        const mobileHubBtn = document.getElementById('mobileHubBtn');
        if (mobileHubBtn) {
            mobileHubBtn.addEventListener('click', () => this.openHubView());
        }
        const mobileSettingsBtn = document.getElementById('mobileSettingsBtn');
        if (mobileSettingsBtn) {
            mobileSettingsBtn.addEventListener('click', () => {
                this.applyNetworkConfigToInputs();
                showSettingsView();
            });
        }
        const hubGrid = document.getElementById('hubGrid');
        if (hubGrid) {
            hubGrid.addEventListener('click', (e) => {
                const actionCard = e.target.closest('[data-hub-action]');
                if (actionCard) {
                    const action = actionCard.getAttribute('data-hub-action');
                    if (action === 'components') {
                        document.getElementById('hubComponents')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    } else if (action === 'update') {
                        this.handleHubUpdateAction();
                    }
                    return;
                }
                const card = e.target.closest('[data-hub-segment]');
                if (!card) return;
                this.handleHubSegment(card.getAttribute('data-hub-segment'));
            });
        }
        if (networkConfigSaveBtn) {
            networkConfigSaveBtn.addEventListener('click', () => {
                let iceServers = [];
                try {
                    iceServers = this.parseIceServersText(inputIceServers?.value || '');
                } catch (error) {
                    this.addLogEntry({
                        type: 'ERROR',
                        msg: `Не удалось сохранить network config: ${error?.message || error}`,
                        ts: new Date().toLocaleTimeString(),
                    });
                    return;
                }
                const turnUrl = String(document.getElementById('inputTurnUrl')?.value || '').trim();
                if (turnUrl) {
                    try {
                        iceServers = this.appendTurnPresetToIceServers(iceServers);
                    } catch (error) {
                        this.addLogEntry({
                            type: 'ERROR',
                            msg: `Не удалось добавить TURN: ${error?.message || error}`,
                            ts: new Date().toLocaleTimeString(),
                        });
                        return;
                    }
                }
                this.setNetworkConfig({
                    apiBaseUrl: inputApiBaseUrl?.value || '',
                    wsBaseUrl: inputWsBaseUrl?.value || '',
                    iceServers,
                });
            });
        }
        if (networkConfigResetBtn) {
            networkConfigResetBtn.addEventListener('click', () => this.resetNetworkConfig());
        }
        if (networkTurnApplyBtn) {
            networkTurnApplyBtn.addEventListener('click', () => {
                try {
                    const nextIceServers = this.appendTurnPresetToIceServers(
                        this.parseIceServersText(inputIceServers?.value || '')
                    );
                    this.setNetworkConfig({
                        apiBaseUrl: inputApiBaseUrl?.value || '',
                        wsBaseUrl: inputWsBaseUrl?.value || '',
                        iceServers: nextIceServers,
                    });
                } catch (error) {
                    this.addLogEntry({
                        type: 'ERROR',
                        msg: `Не удалось добавить TURN: ${error?.message || error}`,
                        ts: new Date().toLocaleTimeString(),
                    });
                }
            });
        }
        if (networkTurnFillBtn) {
            networkTurnFillBtn.addEventListener('click', () => {
                const turnUrlInput = document.getElementById('inputTurnUrl');
                const turnUsernameInput = document.getElementById('inputTurnUsername');
                const turnCredentialInput = document.getElementById('inputTurnCredential');
                const turnRelayOnlyInput = document.getElementById('inputTurnRelayOnly');
                if (turnUrlInput) turnUrlInput.value = 'turns:turn.example.com:5349';
                if (turnUsernameInput) turnUsernameInput.value = 'user';
                if (turnCredentialInput) turnCredentialInput.value = 'pass';
                if (turnRelayOnlyInput) turnRelayOnlyInput.checked = true;
            });
        }

        this.bindColorWheel({
            wheelId: 'serverColorWheel',
            hiddenId: 'serverColorInput',
            hexId: 'serverColorHexInput',
            initialValue: '#cbff00',
        });
        this.bindColorWheel({
            wheelId: 'serverRoleColorWheel',
            hiddenId: 'serverRoleColorInput',
            hexId: 'serverRoleColorHexInput',
            initialValue: '#cbff00',
        });

    }

    /** Выбор темы и селекторы стилизатора. Вызывается только из bindEvents(). */
    bindStylerEvents() {
        // 6. Dynamic styler selector events
        document.querySelectorAll('.btn-theme').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const themeName = e.currentTarget.getAttribute('data-theme');
                this.bus.send('zali_styler:set_theme', themeName);
            });
        });

        const serverMembersList = document.getElementById('serverMembersList');
        if (serverMembersList) {
            serverMembersList.addEventListener('change', async (e) => {
                const roleSelect = e.target.closest('select[data-member-role]');
                if (!roleSelect) return;
                const serverId = this.S.serverModal.serverId;
                const username = roleSelect.getAttribute('data-member-role');
                if (!serverId || !username) return;
                try {
                    const res = await this.apiFetch(this.apiRoutes.servers.member(serverId, username), {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, role: roleSelect.value }),
                    });
                    if (!res.ok) {
                        throw new Error(await res.text() || 'Не удалось изменить роль');
                    }
                    const data = await res.json();
                    this.setServerModalState({
                        members: Array.isArray(data?.members) ? data.members : this.S.serverModal.members,
                        error: '',
                    });
                    this.renderServerModal();
                    await this.loadServers({ silent: true });
                } catch (err) {
                    this.setServerModalState({ error: err?.message || 'Не удалось изменить роль' });
                    this.renderServerModal();
                }
            });

            serverMembersList.addEventListener('click', async (e) => {
                const removeBtn = e.target.closest('[data-member-remove]');
                if (!removeBtn) return;
                const serverId = this.S.serverModal.serverId;
                const username = removeBtn.getAttribute('data-member-remove');
                if (!serverId || !username) return;
                try {
                    const res = await this.apiFetch(this.apiRoutes.servers.member(serverId, username), {
                        method: 'DELETE',
                    });
                    if (!res.ok && res.status !== 204) {
                        throw new Error(await res.text() || 'Не удалось удалить участника');
                    }
                    if (res.status === 204) {
                        this.setServerModalState({
                            members: (this.S.serverModal.members || []).filter(member => String(member.username || '') !== username),
                            error: '',
                        });
                        this.renderServerModal();
                        await this.loadServers({ silent: true });
                        return;
                    }
                    const data = await res.json();
                    this.setServerModalState({
                        members: Array.isArray(data?.members) ? data.members : this.S.serverModal.members,
                        error: '',
                    });
                    this.renderServerModal();
                    await this.loadServers({ silent: true });
                } catch (err) {
                    this.setServerModalState({ error: err?.message || 'Не удалось удалить участника' });
                    this.renderServerModal();
                }
            });
        }

        const serverRolesList = document.getElementById('serverRolesList');
        if (serverRolesList) {
            serverRolesList.addEventListener('input', () => {
                if (this.S.serverModal.mode !== 'create') return;
                this.syncDraftServerRolesFromDom();
            });
            serverRolesList.addEventListener('click', async (e) => {
                const draftToggleBtn = e.target.closest('[data-draft-role-toggle]');
                if (draftToggleBtn) {
                    if (this.S.serverModal.mode !== 'create') return;
                    const draftId = String(draftToggleBtn.getAttribute('data-draft-role-toggle') || '').trim();
                    if (!draftId) return;
                    const nextRoles = this.syncDraftServerRolesFromDom().map(role => {
                        if (String(role.draftId || '') !== draftId) return role;
                        return {
                            ...role,
                            collapsed: !role.collapsed,
                        };
                    });
                    this.setServerModalState({ draftRoles: nextRoles, error: '' });
                    this.renderServerModal();
                    return;
                }
                const draftHead = e.target.closest('.server-role-head--draft');
                if (draftHead) {
                    if (this.S.serverModal.mode !== 'create') return;
                    const card = draftHead.closest('[data-draft-role-card]');
                    const draftId = String(card?.getAttribute('data-draft-role-card') || '').trim();
                    if (!draftId) return;
                    const nextRoles = this.syncDraftServerRolesFromDom().map(role => {
                        if (String(role.draftId || '') !== draftId) return role;
                        return {
                            ...role,
                            collapsed: !role.collapsed,
                        };
                    });
                    this.setServerModalState({ draftRoles: nextRoles, error: '' });
                    this.renderServerModal();
                    return;
                }
                const draftDeleteBtn = e.target.closest('[data-draft-role-delete]');
                if (draftDeleteBtn) {
                    if (this.S.serverModal.mode !== 'create') return;
                    const draftId = String(draftDeleteBtn.getAttribute('data-draft-role-delete') || '').trim();
                    if (!draftId) return;
                    const nextRoles = this.syncDraftServerRolesFromDom().filter(role => String(role.draftId || '') !== draftId);
                    this.setServerModalState({ draftRoles: nextRoles, error: '' });
                    this.renderServerModal();
                    return;
                }
                const saveBtn = e.target.closest('[data-role-save]');
                if (saveBtn) {
                    const roleId = saveBtn.getAttribute('data-role-save');
                    try {
                        await this.saveServerRole(roleId);
                        this.addLogEntry({ type: 'SUCCESS', msg: `Роль обновлена: ${roleId}`, ts: new Date().toLocaleTimeString() });
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось сохранить роль' });
                        this.renderServerModal();
                    }
                    return;
                }
                const deleteBtn = e.target.closest('[data-role-delete]');
                if (deleteBtn) {
                    const roleId = deleteBtn.getAttribute('data-role-delete');
                    if (!roleId) return;
                    const role = (this.S.serverModal.roles || []).find(item => String(item.roleId || '') === roleId);
                    const confirmDelete = confirm(`Удалить роль "${role?.name || roleId}"?`);
                    if (!confirmDelete) return;
                    try {
                        await this.deleteServerRole(roleId);
                        this.addLogEntry({ type: 'SUCCESS', msg: `Роль удалена: ${role?.name || roleId}`, ts: new Date().toLocaleTimeString() });
                    } catch (err) {
                        this.setServerModalState({ error: err?.message || 'Не удалось удалить роль' });
                        this.renderServerModal();
                    }
                }
            });
        }

    }

    /** Слайдеры оформления. Вызывается только из bindEvents(). */
    bindStyleSliderEvents() {
        const sliderSuggestHeight = document.getElementById('sliderSuggestHeight');
        if (sliderSuggestHeight) {
            sliderSuggestHeight.addEventListener('input', (e) => {
                const height = `${e.target.value}px`;
                const out = document.getElementById('suggestHeightVal');
                if (out) out.textContent = height;
                this.bus.send('zali_styler:set_variable', '--contact-suggest-max-h', height);
            });
        }

        const sliderSuggestContrast = document.getElementById('sliderSuggestContrast');
        if (sliderSuggestContrast) {
            sliderSuggestContrast.addEventListener('input', (e) => {
                const percent = Number(e.target.value) || 0;
                const bgAlpha = Math.min(0.98, Math.max(0.72, 0.58 + (percent / 100) * 0.32));
                const borderAlpha = Math.min(0.95, Math.max(0.18, 0.08 + (percent / 100) * 0.28));
                const shadowAlpha = Math.min(0.65, Math.max(0.24, 0.12 + (percent / 100) * 0.5));
                const bg = `rgba(8,10,14,${bgAlpha.toFixed(3)})`;
                const border = `rgba(255,255,255,${borderAlpha.toFixed(3)})`;
                const shadow = `0 22px 48px rgba(0,0,0,${shadowAlpha.toFixed(3)})`;
                const out = document.getElementById('suggestContrastVal');
                if (out) out.textContent = `${percent}%`;
                this.bus.send('zali_styler:set_variable', '--contact-suggest-bg', bg);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-border', border);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-shadow', shadow);
            });
        }

        const sliderSuggestDensity = document.getElementById('sliderSuggestDensity');
        if (sliderSuggestDensity) {
            sliderSuggestDensity.addEventListener('input', (e) => {
                const density = Number(e.target.value) || 0;
                const padY = Math.max(8, 16 - Math.round(density / 3));
                const padX = Math.max(10, 16 - Math.round(density / 4));
                const gap = Math.max(4, 12 - Math.round(density / 3));
                const font = Math.min(16, 13 + Math.round(density / 8));
                const hint = Math.max(0.34, Math.min(0.72, 0.42 + density / 60));
                const out = document.getElementById('suggestDensityVal');
                if (out) out.textContent = String(density);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-item-pad-y', `${padY}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-item-pad-x', `${padX}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-gap', `${gap}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-font', `${font}px`);
                this.bus.send('zali_styler:set_variable', '--contact-suggest-hint', `rgba(255,255,255,${hint.toFixed(3)})`);
            });
        }

    }

    /** Ручной ввод ключа шифрования. Вызывается только из bindEvents(). */
    bindCryptoKeyEvents() {
        // 7. Cryptography setting custom key
        // Routes through zali_styler which proxies to Swift → Rust backend
        const inputCryptoKey = document.getElementById('inputCryptoKey');
        if (inputCryptoKey) {
            const storedKey = this.loadStoredCryptoKey();
            if (storedKey && !inputCryptoKey.value.trim()) {
                inputCryptoKey.value = storedKey;
            }
            inputCryptoKey.addEventListener('input', (e) => {
                const newKey = e.target.value.trim();
                this.saveStoredCryptoKey(newKey);
                this.bus.send('zali_styler:set_key', newKey);
            });
        }

    }

    /** Перетаскивание окна, ресайз, горячие клавиши. Вызывается только из bindEvents(). */
    bindWindowChromeEvents() {
        // 8. Title bar drag helper
        const titlebar = document.getElementById('titlebar');
        if (titlebar && this.nativeSupports('windowDrag')) {
            titlebar.addEventListener('mousedown', (e) => {
                if (!e.target.closest('.ws-pill') && !e.target.closest('.hdr-btn') && !e.target.closest('.win-controls')) {
                    this.postNativeMessage({ type: NativeMessageTypes.START_DRAG });
                }
            });
        }

        // 8b. In-app window controls (Windows only — native OS decorations are
        // switched off there in favor of this titlebar, see
        // NativeCapabilities::window_controls in apps/windows/src/native.rs).
        if (titlebar && this.nativeSupports('windowControls')) {
            titlebar.classList.add('has-window-controls');
            // Windows only: the connection pill moves to the left of the titlebar so
            // it doesn't crowd the window controls on the right. macOS/browser keep
            // it on the right (default DOM position, untouched here).
            const tbL = titlebar.querySelector('.tb-l');
            const wsPill = document.getElementById('wsPill');
            if (tbL && wsPill) {
                tbL.insertBefore(wsPill, tbL.firstChild);
            }
            document.getElementById('winMinBtn')?.addEventListener('click', () => {
                this.postNativeMessage({ type: NativeMessageTypes.MINIMIZE_WINDOW });
            });
            document.getElementById('winMaxBtn')?.addEventListener('click', () => {
                this.postNativeMessage({ type: NativeMessageTypes.MAXIMIZE_WINDOW });
            });
            document.getElementById('winCloseBtn')?.addEventListener('click', () => {
                this.postNativeMessage({ type: NativeMessageTypes.CLOSE_WINDOW });
            });
            titlebar.addEventListener('dblclick', (e) => {
                if (!e.target.closest('.ws-pill') && !e.target.closest('.hdr-btn') && !e.target.closest('.win-controls') && !e.target.closest('.mobile-menu-btn')) {
                    this.postNativeMessage({ type: NativeMessageTypes.MAXIMIZE_WINDOW });
                }
            });
        }

        // Report app loaded
        this.addLogEntry({ type: 'INFO', msg: 'ZaliMessenger v6.0 (Rust Backend) запущен — шифрование и сетевой стек работают в Rust', ts: new Date().toLocaleTimeString() });
        this.resizeComposer();
        this.syncMobileChrome();
        this.setupMobileNavGestures();
        this.setupMobileForwardNavGesture();
        this.setupMobileKeyboardAvoidance();
        this.setupMobileTouchGestures();
        this.applyUiV2Chrome();
        this.applyExperimentalDesign();
        this.applyVoiceTraceEnabled();
        const mobileQuery = this.mobileLayoutQuery();
        if (mobileQuery) {
            const onMobileChange = () => {
                if (!this.isMobileLayout()) {
                    this.closeMobileSidebar();
                }
                this.syncMobileChrome();
            };
            if (typeof mobileQuery.addEventListener === 'function') {
                mobileQuery.addEventListener('change', onMobileChange);
            } else if (typeof mobileQuery.addListener === 'function') {
                mobileQuery.addListener(onMobileChange);
            }
        }
        // Resize fires continuously while a desktop window is dragged. Coalescing to
        // one frame keeps that from running the mobile-chrome sync (which reads
        // layout) dozens of times per second.
        window.addEventListener('resize', () => {
            if (this._resizeRaf) return;
            this._resizeRaf = requestAnimationFrame(() => {
                this._resizeRaf = 0;
                if (!this.isMobileLayout()) {
                    this.closeMobileSidebar();
                }
                this.syncMobileChrome();
                this.repinMessagesAfterViewportChange();
            });
        }, { passive: true });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isMobileLayout() && document.body?.classList.contains('mobile-sidebar-open')) {
                this.closeMobileSidebar();
            }
        });
        this.setupScrollInertia();
    }

    // Mouse-wheel scrolling has no native deceleration (unlike trackpad momentum,
    // which the OS/compositor handles without extra wheel events) — each notch just
    // jumps and stops dead. This adds a tiny residual glide after the wheel goes
    // idle, capped and decaying fast on purpose: it should read as "less abrupt",
    // never as a distinct animation. #msgs is included deliberately — the coast is
    // a continuation of the user's own gesture, so it must NOT go through
    // markProgrammaticScroll() (see the comment on that method): onMessagesScroll
    // needs to see it as real scrolling so _bottomIntent still clears correctly if
    // the glide carries the view away from the bottom.
    setupScrollInertia() {
        if (window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
        const SELECTOR = '.msgs, .contacts, .sidebar, .server-channel-list, .settings-body, .server-modal-content, .color-picker-body';
        const FRICTION = 0.72;
        const MIN_VELOCITY = 0.5;
        const MAX_VELOCITY = 6;
        const IDLE_MS = 70;
        const states = new WeakMap();

        const coast = (el, st) => {
            st.raf = requestAnimationFrame(() => {
                st.velocity *= FRICTION;
                if (Math.abs(st.velocity) < MIN_VELOCITY) {
                    st.raf = 0;
                    return;
                }
                const max = el.scrollHeight - el.clientHeight;
                const next = Math.max(0, Math.min(max, el.scrollTop + st.velocity));
                el.scrollTop = next;
                if (next <= 0 || next >= max) {
                    st.raf = 0;
                    return;
                }
                coast(el, st);
            });
        };

        document.addEventListener('wheel', (e) => {
            const el = e.target.closest?.(SELECTOR);
            if (!el || el.scrollHeight <= el.clientHeight) return;
            let st = states.get(el);
            if (!st) {
                st = { velocity: 0, raf: 0, idleTimer: 0 };
                states.set(el, st);
            }
            if (st.raf) {
                cancelAnimationFrame(st.raf);
                st.raf = 0;
            }
            const nudge = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, e.deltaY * 0.12));
            st.velocity = st.velocity * 0.3 + nudge * 0.7;
            clearTimeout(st.idleTimer);
            st.idleTimer = setTimeout(() => {
                if (Math.abs(st.velocity) >= MIN_VELOCITY) coast(el, st);
            }, IDLE_MS);
        }, { passive: true });
    }
});
