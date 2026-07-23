// @ts-check
/**
 * @enum {string}
 */
const ZaliBusEvents = window.ZaliBusEvents || Object.freeze({
    RECEIVE_MESSAGE: 'receive_message',
    SET_USERS: 'set_users',
    SET_CONTACTS: 'set_contacts',
    SET_SESSION: 'set_session',
    LOAD_HISTORY: 'load_history',
    LOAD_SERVER_HISTORY: 'load_server_history',
    REFRESH_AFTER_KEY: 'refresh_after_key',
    RETRY_PUBLISH_KEYS: 'retry_publish_keys',
    SYNC_ACTIVE_CONVERSATION: 'sync_active_conversation',
    SET_LOADING: 'set_loading',
    SET_CONNECTION_STATUS: 'set_connection_status',
    ON_SEND_SUCCESS: 'on_send_success',
    ON_SEND_ERROR: 'on_send_error',
    REACTION_UPDATED: 'reaction_updated',
    AVATAR_UPDATED: 'avatar_updated',
    TENOR_RESOLVED: 'tenor_resolved',
    AUTH_RESPONSE: 'auth_response',
    NATIVE_RESPONSE: 'native_response',
    ADD_LOG_ENTRY: 'add_log_entry',
    VOICE_EVENT: 'voice_event',
    UPDATE_EVENT: 'update_event',
});

window.ZaliBusEvents = ZaliBusEvents;

class ZaliBus {
    constructor() {
        this.handlers = new Map(); // "address:command" -> function
        this.listeners = new Map(); // eventName -> Array<function>
    }

    /**
     * Register a command handler for a specific module namespace and command.
     * @param {string} address - Namespace (e.g. 'zali_crypto')
     * @param {string} command - Action name (e.g. 'encrypt')
     * @param {Function} handler - The handler function
     */
    registerCommand(address, command, handler) {
        const key = `${address}:${command}`;
        if (address === 'zali_interface') {
            const known = new Set(Object.values(ZaliBusEvents));
            if (!known.has(command)) {
                console.warn(`[zali_bus] Unknown command registered: ${key}`);
            }
        }
        if (this.handlers.has(key)) {
            console.warn(`[zali_bus] Command handler for ${key} is already registered. Overwriting.`);
        }
        this.handlers.set(key, handler);
    }

    /**
     * Call a registered command and return its result.
     * @param {string} addressCommand - In format "namespace:command"
     * @param  {...any} args - Arguments passed to the handler
     */
    send(addressCommand, ...args) {
        if (this.handlers.has(addressCommand)) {
            const handler = this.handlers.get(addressCommand);
            return handler(...args);
        } else {
            console.error(`[zali_bus] No handler registered for command: ${addressCommand}`);
            return null;
        }
    }

    /**
     * Register a listener for an event broadcasted by pub/sub.
     * @param {string} event - Event name
     * @param {Function} callback - Callback function
     */
    subscribe(event, callback) {
        if (!this.listeners.has(event)) {
            this.listeners.set(event, []);
        }
        this.listeners.get(event).push(callback);
    }

    /**
     * Publish an event to all subscribers.
     * @param {string} event - Event name
     * @param  {...any} args - Arguments passed to the subscribers
     */
    publish(event, ...args) {
        if (this.listeners.has(event)) {
            this.listeners.get(event).forEach(cb => {
                try {
                    cb(...args);
                } catch (e) {
                    console.error(`[zali_bus] Error in subscriber for event ${event}:`, e);
                }
            });
        }
    }
}
window.ZaliBus = ZaliBus;
