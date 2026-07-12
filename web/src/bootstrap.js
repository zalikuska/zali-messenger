// @ts-check
(function() {
    'use strict';

    function createNativeBridge() {
        const macBridge = window.webkit?.messageHandlers?.nativeApp || null;
        const wryBridge = window.ipc?.postMessage ? window.ipc : null;
        const webView2Bridge = window.chrome?.webview?.postMessage ? window.chrome.webview : null;
        // Android's WebView.addJavascriptInterface() only exposes plain methods on a
        // named window object (not a .postMessage(obj) pattern that accepts arbitrary
        // JS objects like WKWebView's message handlers) — the native side only ever
        // sees strings, so payloads are always JSON-stringified first, same as wry/webview2.
        const androidBridge = window.ZaliAndroidBridge?.postMessage ? window.ZaliAndroidBridge : null;

        const transport = macBridge
            ? {
                kind: 'webkit',
                postMessage(payload) {
                    macBridge.postMessage(payload);
                    return true;
                },
            }
            : wryBridge
                ? {
                    kind: 'ipc',
                    postMessage(payload) {
                        const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
                        wryBridge.postMessage(data);
                        return true;
                    },
                }
                : webView2Bridge
                    ? {
                        kind: 'webview2',
                        postMessage(payload) {
                            const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
                            webView2Bridge.postMessage(data);
                            return true;
                        },
                    }
                    : androidBridge
                        ? {
                            kind: 'android',
                            postMessage(payload) {
                                const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
                                androidBridge.postMessage(data);
                                return true;
                            },
                        }
                        : null;

        const defaultCaps = macBridge
            ? {
                sendMessage: true,
                sessionSync: true,
                networkConfig: true,
                setKey: true,
                saveStyle: true,
                saveMessageCache: true,
                downloadAttachment: true,
                serverHistory: true,
                avatarFetch: true,
                tenor: true,
                voice: true,
                windowDrag: true,
            }
            : transport
                ? {
                    sendMessage: true,
                sessionSync: true,
                networkConfig: true,
                setKey: true,
                saveStyle: true,
                saveMessageCache: true,
                downloadAttachment: false,
                serverHistory: false,
                tenor: false,
                voice: false,
                    windowDrag: false,
                }
                : {};

        const injectedCaps = window.__ZALI_NATIVE_CAPS__ && typeof window.__ZALI_NATIVE_CAPS__ === 'object'
            ? window.__ZALI_NATIVE_CAPS__
            : {};

        return {
            available: !!transport,
            transport: transport ? transport.kind : 'none',
            supports: { ...defaultCaps, ...injectedCaps },
            postMessage(payload) {
                if (!transport) return false;
                return transport.postMessage(payload);
            },
        };
    }

    window.__ZALI_NATIVE = createNativeBridge();

    // Register the app-shell service worker only in standalone browser/PWA mode — native
    // shells (macOS/Windows) load this HTML via loadHTMLString/a data string with no real
    // origin, where SW registration would be meaningless at best. See web/service-worker.js.
    if (!window.__ZALI_NATIVE?.available && 'serviceWorker' in navigator) {
        window.addEventListener('load', () => {
            navigator.serviceWorker.register('./service-worker.js').catch(() => {});
        });
    }

    // Create the minimal JS-side loader (only interface + styler)
    const loader = new ZaliLoader();

    // Register only frontend modules.
    // Crypto, Net, Bus logic live in the Rust backend (Core crate).
    loader.register(new ZaliStyler());
    loader.register(new ZaliInterface());

    // Initialize all registered modules
    loader.init();

    // Expose loader to window for native iOS/macOS WebView invocation
    window.loader = loader;
    
    // Legacy helper functions that native layer calls directly
    window.receiveMessage = function(...args) {
        if (args.length === 1 && args[0] && typeof args[0] === 'object') {
            loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.RECEIVE_MESSAGE || 'receive_message'}`, args[0]);
            return;
        }
        const [id, sender, receiver, text, attachments, serverId, channelId] = args;
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.RECEIVE_MESSAGE || 'receive_message'}`, { id, sender, receiver, text, attachments, serverId, channelId });
    };
    window.receiveReactionUpdate = function(payload) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.REACTION_UPDATED || 'reaction_updated'}`, payload);
    };
    window.receiveVoiceEvent = function(payload) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.VOICE_EVENT || 'voice_event'}`, payload);
    };
    window.setUsers = function(users) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_USERS || 'set_users'}`, users);
    };
    window.setContacts = function(contacts) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_CONTACTS || 'set_contacts'}`, contacts);
    };
    window.setSession = function(session) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_SESSION || 'set_session'}`, session);
    };
    window.loadHistory = function(messages) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.LOAD_HISTORY || 'load_history'}`, messages);
    };
    window.refreshAfterKey = function() {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.REFRESH_AFTER_KEY || 'refresh_after_key'}`);
    };
    window.loadServerHistory = function(serverId, channelId, messages) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.LOAD_SERVER_HISTORY || 'load_server_history'}`, { serverId, channelId, messages });
    };
    window.setLoading = function(on) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_LOADING || 'set_loading'}`, on);
    };
    window.setConnectionStatus = function(connected) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_CONNECTION_STATUS || 'set_connection_status'}`, connected);
    };
    window.avatarUpdated = function(username) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.AVATAR_UPDATED || 'avatar_updated'}`, { username, deleted: false });
    };
    window.avatarDeleted = function(username) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.AVATAR_UPDATED || 'avatar_updated'}`, { username, deleted: true });
    };
    window.addLog = function(type, msg) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.ADD_LOG_ENTRY || 'add_log_entry'}`, { type, msg, ts: new Date().toLocaleTimeString() });
    };

    const hasNativeBridge = !!window.__ZALI_NATIVE?.available;
    if (!hasNativeBridge) {
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_USERS || 'set_users'}`, ['Alice', 'Bob', 'Zalikus']);
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_LOADING || 'set_loading'}`, false);
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.SET_CONNECTION_STATUS || 'set_connection_status'}`, false);
        loader.bus.send(`${'zali_interface'}:${window.ZaliBusEvents?.ADD_LOG_ENTRY || 'add_log_entry'}`, {
            type: 'WARN',
            msg: 'Запущен браузерный режим без native bridge: доступен просмотр интерфейса',
            ts: new Date().toLocaleTimeString()
        });
    }
})();
