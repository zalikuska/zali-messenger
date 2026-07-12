class ZaliSecurityShieldPlugin {
    constructor() {
        this.name = 'zali_security_shield';
    }

    init(loader) {
        this.bus = loader.bus;

        // Register custom audit service on the bus
        this.bus.registerCommand('zali_security_shield', 'audit_message', (text) => this.auditMessage(text));

        this.bus.send('zali_net:add_log', 'INFO', 'security_shield: Модуль мониторинга безопасности загружен.');
    }

    /**
     * Audit a message payload.
     * Returns an audit analysis object.
     */
    auditMessage(text) {
        if (!text) {
            return { secure: true, status: 'Empty' };
        }
        
        // If message has decryption error prefix/text, audit it as compromised/unsafe
        if (text.includes('🚨') || text.includes('[Ошибка')) {
            return { secure: false, status: 'КЛЮЧИ НЕ СОВПАДАЮТ' };
        }
        
        return { secure: true, status: 'E2E Защищено' };
    }
}
window.ZaliSecurityShieldPlugin = ZaliSecurityShieldPlugin;
