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
