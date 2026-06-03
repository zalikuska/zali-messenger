class ZaliLoader {
    constructor() {
        this.bus = new ZaliBus();
        this.modules = new Map();
    }

    /**
     * Registers a module.
     * @param {Object} module - Module instance must have a name string and optionally an init() method.
     */
    register(module) {
        if (!module || !module.name) {
            console.error("[zali_loader] Failed to register invalid module:", module);
            return;
        }
        this.modules.set(module.name, module);
        console.log(`[zali_loader] Module registered: ${module.name}`);
    }

    /**
     * Initializes all registered modules.
     */
    init() {
        console.log("[zali_loader] Bootstrapping modules...");

        // Register a system command to retrieve module info
        this.bus.registerCommand('loader', 'get_modules', () => Array.from(this.modules.keys()));

        // Initialize each module
        for (let [name, module] of this.modules) {
            try {
                if (typeof module.init === 'function') {
                    module.init(this);
                    console.log(`[zali_loader] Module initialized successfully: ${name}`);
                }
            } catch (e) {
                console.error(`[zali_loader] Error during initialization of module ${name}:`, e);
            }
        }

        console.log("[zali_loader] Bootstrap finished.");
    }
}
window.ZaliLoader = ZaliLoader;
