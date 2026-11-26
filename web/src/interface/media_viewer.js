// --- ZaliInterface: медиа на весь экран и поворот экрана на телефоне. ---
//
// Интерфейс телефона живёт только в портрете: оболочка Android держит портретную
// ориентацию (MainActivity.applyOrientation). Альбомный разрешён лишь пока на экране
// медиа на весь экран:
//   - видео звонка — камера или показ экрана (#voiceFocus, voice_ui.js openVoiceFocus);
//   - фото из ленты (#mediaViewer, ниже);
//   - видео из ленты, развёрнутое кнопкой своей панели (document.fullscreenElement).
// Веб сообщает оболочке SCREEN_ROTATION { free }, она переключает ориентацию на
// пользовательскую (с учётом системной блокировки поворота) и обратно на портрет.
//
// В альбомном ширина телефона больше 760 px, и раскладка за оверлеем становится
// «настольной». Сбрасывать навигацию телефона из-за этого нельзя (syncMobileChrome
// снял бы открытый чат и вложенные экраны), поэтому обработчики смены раскладки в
// events.js пропускают ход, пока mobileRotationHeld() — и пока экран возвращается в
// портрет после закрытия медиа.
ZaliMixin(ZaliInterface, class {

    setupMediaViewer() {
        if (this._mediaViewerReady) return;
        this._mediaViewerReady = true;
        document.addEventListener('click', (event) => {
            // Не только телефон: на десктопе фото из ленты тоже разворачивается
            // (раньше клик по нему не делал ничего — репорты a9227ff3, 1a749380).
            const img = event.target?.closest?.('#msgs img.media-img');
            if (!img || img.classList.contains('compact') || !(img.currentSrc || img.src)) return;
            // В режиме жалобы тап по сообщению выбирает его.
            if (img.closest('.is-reporting')) return;
            event.preventDefault();
            event.stopPropagation();
            this.openMediaViewer(img.currentSrc || img.src, img.getAttribute('alt') || '');
        }, true);
        const onFullscreen = () => this.syncScreenRotation();
        document.addEventListener('fullscreenchange', onFullscreen);
        document.addEventListener('webkitfullscreenchange', onFullscreen);
    }

    openMediaViewer(src, label = '') {
        if (!src) return;
        this.closeMediaViewer();
        if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
        const root = document.createElement('div');
        root.id = 'mediaViewer';
        root.className = 'voice-focus media-viewer';
        root.setAttribute('role', 'dialog');
        root.setAttribute('aria-modal', 'true');
        root.innerHTML = `<div class="voice-focus-media"><img alt=""></div>
            <div class="voice-focus-bar">
                <span class="voice-focus-name"></span>
                <button type="button" class="voice-focus-close" aria-label="Закрыть фото" title="Закрыть">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>
                </button>
            </div>`;
        const img = root.querySelector('img');
        img.src = src;
        img.alt = label;
        root.querySelector('.voice-focus-name').textContent = label;
        // Клик/тап в любом месте закрывает — тот же жест, что открыл.
        root.addEventListener('click', () => this.closeMediaViewer());
        this._mediaViewerKeyHook = (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            this.closeMediaViewer();
        };
        document.addEventListener('keydown', this._mediaViewerKeyHook, true);
        document.body.appendChild(root);
        this.syncScreenRotation();
    }

    closeMediaViewer() {
        const root = document.getElementById('mediaViewer');
        if (this._mediaViewerKeyHook) {
            document.removeEventListener('keydown', this._mediaViewerKeyHook, true);
            this._mediaViewerKeyHook = null;
        }
        if (!root) return;
        root.remove();
        this.syncScreenRotation();
    }

    mediaRotationWanted() {
        return !!(document.getElementById('voiceFocus')
            || document.getElementById('mediaViewer')
            || document.fullscreenElement
            || document.webkitFullscreenElement);
    }

    syncScreenRotation() {
        const free = this.mediaRotationWanted();
        if (free === !!this._rotationFree) return;
        this._rotationFree = free;
        clearTimeout(this._rotationSettleTimer);
        if (free) {
            this._rotationSettleUntil = 0;
        } else {
            // Экран ещё секунду-другую в альбомном, пока оболочка возвращает портрет.
            this._rotationSettleUntil = Date.now() + 2000;
            // Не вернулся (планшет, поворот не сработал) — догоняем раскладку сами.
            this._rotationSettleTimer = setTimeout(() => {
                if (this._rotationFree) return;
                this._rotationSettleUntil = 0;
                if (!this.isMobileLayout()) this.closeMobileSidebar?.();
                this.syncMobileChrome?.();
                this.repinMessagesAfterViewportChange?.();
            }, 2100);
        }
        if (this.nativeSupports?.('screenRotation')) {
            this.postNativeMessage({ type: NativeMessageTypes.SCREEN_ROTATION, free });
        }
    }

    // true — смену раскладки сейчас вызвал поворот ради медиа, навигацию не трогать.
    mobileRotationHeld() {
        if (this._rotationFree) return true;
        if (!this._rotationSettleUntil) return false;
        if (this.isMobileLayout() || Date.now() > this._rotationSettleUntil) {
            this._rotationSettleUntil = 0;
            return false;
        }
        return true;
    }
});
