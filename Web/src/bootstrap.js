(function() {
    'use strict';

    function createNativeBridge() {
        const macBridge = window.webkit?.messageHandlers?.nativeApp || null;
        const wryBridge = window.ipc?.postMessage ? window.ipc : null;
        const webView2Bridge = window.chrome?.webview?.postMessage ? window.chrome.webview : null;

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
            loader.bus.send('zali_interface:receive_message', args[0]);
            return;
        }
        const [id, sender, receiver, text, attachments, serverId, channelId] = args;
        loader.bus.send('zali_interface:receive_message', { id, sender, receiver, text, attachments, serverId, channelId });
    };
    window.receiveReactionUpdate = function(payload) {
        loader.bus.send('zali_interface:reaction_updated', payload);
    };
    window.receiveVoiceEvent = function(payload) {
        loader.bus.send('zali_interface:voice_event', payload);
    };
    window.setUsers = function(users) {
        loader.bus.send('zali_interface:set_users', users);
    };
    window.setContacts = function(contacts) {
        loader.bus.send('zali_interface:set_contacts', contacts);
    };
    window.setSession = function(session) {
        loader.bus.send('zali_interface:set_session', session);
    };
    window.loadHistory = function(messages) {
        loader.bus.send('zali_interface:load_history', messages);
    };
    window.loadServerHistory = function(serverId, channelId, messages) {
        loader.bus.send('zali_interface:load_server_history', { serverId, channelId, messages });
    };
    window.setLoading = function(on) {
        loader.bus.send('zali_interface:set_loading', on);
    };
    window.setConnectionStatus = function(connected) {
        loader.bus.send('zali_interface:set_connection_status', connected);
    };
    window.avatarUpdated = function(username) {
        loader.bus.send('zali_interface:avatar_updated', { username, deleted: false });
    };
    window.avatarDeleted = function(username) {
        loader.bus.send('zali_interface:avatar_updated', { username, deleted: true });
    };
    window.addLog = function(type, msg) {
        loader.bus.send('zali_interface:add_log_entry', { type, msg, ts: new Date().toLocaleTimeString() });
    };

    const hasNativeBridge = !!window.__ZALI_NATIVE?.available;
    if (!hasNativeBridge) {
        loader.bus.send('zali_interface:set_users', ['Alice', 'Bob', 'Zalikus']);
        loader.bus.send('zali_interface:set_loading', false);
        loader.bus.send('zali_interface:set_connection_status', false);
        loader.bus.send('zali_interface:add_log_entry', {
            type: 'WARN',
            msg: 'Запущен браузерный режим без native bridge: доступен просмотр интерфейса',
            ts: new Date().toLocaleTimeString()
        });
    }
})();
