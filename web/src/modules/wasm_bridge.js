// @ts-check
// Lazily loads the WASM build of core/ (see scripts/build_web_wasm.sh) and exposes
// pack/unpack helpers for the .zali archive format to the rest of interface.js.
// Only relevant when running as a plain browser tab with no native shell — the
// macOS/Windows clients pack/unpack archives natively and never touch this module.
// Dynamic import() here resolves relative to the document URL, so web/wasm-pkg/
// must be served alongside web/index.html.
(function() {
    'use strict';

    let readyPromise = null;

    function load() {
        if (!readyPromise) {
            readyPromise = import('./wasm-pkg/zali_core.js')
                .then(async (mod) => {
                    await mod.default();
                    return mod;
                })
                .catch((error) => {
                    readyPromise = null;
                    throw error;
                });
        }
        return readyPromise;
    }

    window.ZaliWasm = {
        async isAvailable() {
            try {
                await load();
                return true;
            } catch (e) {
                return false;
            }
        },

        /**
         * @param {string} sender
         * @param {string} text
         * @param {string} key
         * @param {number} keyVersion
         * @param {Array<{name:string, archivePath:string, mimeType:string, kind:string, bytes:Uint8Array}>} [attachments]
         * @returns {Promise<Uint8Array>}
         */
        async packMessage(sender, text, key, keyVersion, attachments) {
            const mod = await load();
            const jsAttachments = (attachments || []).map(a => ({
                name: a.name,
                archivePath: a.archivePath,
                mimeType: a.mimeType,
                kind: a.kind,
                bytes: a.bytes instanceof Uint8Array ? a.bytes : new Uint8Array(a.bytes),
            }));
            return mod.pack_message_wasm(sender, text, key, keyVersion || 0, jsAttachments);
        },

        /**
         * @param {Uint8Array} archiveBytes
         * @param {string} key
         * @returns {Promise<{sender:string, text:string, timestamp:number, keyVersion:number, attachments:Array<{name:string,archivePath:string,mimeType:string,kind:string,bytes:Uint8Array}>}>}
         */
        async unpackMessage(archiveBytes, key) {
            const mod = await load();
            const bytes = archiveBytes instanceof Uint8Array ? archiveBytes : new Uint8Array(archiveBytes);
            return mod.unpack_message_wasm(bytes, key);
        },
    };
})();
