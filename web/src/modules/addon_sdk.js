// --- window.ZaliAddonSdk: SDK `window.zali`, который получает песочница аддона. ---
//
// Функция ниже НЕ выполняется в приложении. Хост (interface/addons_runtime.js)
// берёт её исходник (Function.prototype.toString) и кладёт первым скриптом в
// srcdoc песочницы — до кода аддона. Поэтому она самодостаточна: никаких
// ссылок на внешние переменные, только то, что есть в окне фрейма.
//
// Протокол: postMessage к window.parent.
//   фрейм → хост   {channel: 'zali-addon-rpc', id, method, params}
//   хост → фрейм   {channel: 'zali-addon-rpc', id, ok, result | error: {code, message}}
//   хост → фрейм   {channel: 'zali-addon-event', event, data}
// Байты ходят ArrayBuffer'ами с передачей владения. Разрешения проверяет хост;
// SDK лишь даёт удобные обёртки. Описание для авторов — docs/ADDONS.md.
(function () {
    'use strict';

    function zaliAddonSdk() {
        'use strict';
        if (window.zali) return;
        var host = window.parent;
        var RPC = 'zali-addon-rpc';
        var EVENT = 'zali-addon-event';
        var seq = 0;
        var pending = new Map();
        var listeners = new Map();
        var encoder = new TextEncoder();
        var decoder = new TextDecoder();

        function ZaliAddonError(code, message) {
            var error = new Error(message || 'Ошибка');
            error.name = 'ZaliAddonError';
            error.code = code || 'error';
            return error;
        }

        function call(method, params, transfer) {
            return new Promise(function (resolve, reject) {
                seq += 1;
                var id = seq;
                pending.set(id, { resolve: resolve, reject: reject });
                try {
                    host.postMessage({ channel: RPC, id: id, method: method, params: params || {} }, '*', transfer || []);
                } catch (e) {
                    pending.delete(id);
                    reject(ZaliAddonError('bad_params', (e && e.message) || String(e)));
                }
            });
        }

        function emit(name, data) {
            var set = listeners.get(name);
            if (!set) return;
            set.forEach(function (fn) {
                try { fn(data); } catch (e) { setTimeout(function () { throw e; }, 0); }
            });
        }

        window.addEventListener('message', function (event) {
            if (event.source !== host) return;
            var msg = event.data;
            if (!msg || typeof msg !== 'object') return;
            if (msg.channel === RPC) {
                var entry = pending.get(msg.id);
                if (!entry) return;
                pending.delete(msg.id);
                if (msg.ok) entry.resolve(msg.result);
                else entry.reject(ZaliAddonError(msg.error && msg.error.code, msg.error && msg.error.message));
            } else if (msg.channel === EVENT) {
                emit(String(msg.event || ''), msg.data);
            }
        });

        function on(name, fn) {
            if (typeof fn !== 'function') return function () {};
            var key = String(name);
            if (!listeners.has(key)) listeners.set(key, new Set());
            listeners.get(key).add(fn);
            return function () { off(key, fn); };
        }

        function off(name, fn) {
            var set = listeners.get(String(name));
            if (set) set.delete(fn);
        }

        function bytesOf(data) {
            if (data instanceof Uint8Array) return Promise.resolve(data);
            if (data instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(data));
            if (ArrayBuffer.isView(data)) return Promise.resolve(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
            if (typeof Blob !== 'undefined' && data instanceof Blob) {
                return data.arrayBuffer().then(function (buf) { return new Uint8Array(buf); });
            }
            if (typeof data === 'string') return Promise.resolve(encoder.encode(data));
            return Promise.reject(ZaliAddonError('bad_params', 'Нужны байты: Uint8Array, ArrayBuffer, Blob или строка'));
        }

        // Копия байт отдельным буфером — его владение уходит хосту, исходный
        // массив аддона остаётся целым.
        function withBytes(method, params, data) {
            return bytesOf(data).then(function (bytes) {
                var buffer = bytes.slice().buffer;
                var full = Object.assign({}, params, { data: buffer });
                return call(method, full, [buffer]);
            });
        }

        function asBytes(value) {
            return value === null || value === undefined ? null : new Uint8Array(value);
        }

        var assetUrls = new Map();

        var zali = {
            sdkVersion: 1,
            ready: call('hello'),
            on: on,
            off: off,
            ui: {
                collapse: function () { return call('ui.collapse'); },
                close: function () { return call('ui.close'); },
                setTitle: function (title) { return call('ui.setTitle', { title: String(title == null ? '' : title) }); },
            },
            storage: {
                get: function (key) {
                    return call('storage.get', { key: String(key) }).then(function (json) {
                        return json === null || json === undefined ? null : JSON.parse(json);
                    });
                },
                set: function (key, value) {
                    var json;
                    try { json = JSON.stringify(value === undefined ? null : value); } catch (e) {
                        return Promise.reject(ZaliAddonError('bad_params', 'Значение не сериализуется в JSON'));
                    }
                    return call('storage.set', { key: String(key), json: json });
                },
                remove: function (key) { return call('storage.remove', { key: String(key) }); },
                keys: function () { return call('storage.keys'); },
                clear: function () { return call('storage.clear'); },
            },
            assets: {
                read: function (path) {
                    return call('assets.read', { path: String(path) }).then(function (r) { return new Uint8Array(r.data); });
                },
                text: function (path) {
                    return zali.assets.read(path).then(function (bytes) { return decoder.decode(bytes); });
                },
                url: function (path) {
                    var key = String(path);
                    if (assetUrls.has(key)) return Promise.resolve(assetUrls.get(key));
                    return call('assets.read', { path: key }).then(function (r) {
                        var url = URL.createObjectURL(new Blob([r.data], { type: r.mimeType || '' }));
                        assetUrls.set(key, url);
                        return url;
                    });
                },
            },
            cache: {
                write: function (path, data) { return withBytes('cache.write', { path: String(path) }, data); },
                read: function (path) { return call('cache.read', { path: String(path) }).then(asBytes); },
                text: function (path) {
                    return zali.cache.read(path).then(function (b) { return b === null ? null : decoder.decode(b); });
                },
                list: function (prefix) { return call('cache.list', { prefix: String(prefix || '') }); },
                remove: function (path) { return call('cache.remove', { path: String(path) }); },
                usage: function () { return call('cache.usage'); },
            },
            notify: function (options) {
                var o = options || {};
                return call('notify', { title: String(o.title == null ? '' : o.title), body: String(o.body == null ? '' : o.body) });
            },
            clipboard: {
                writeText: function (text) { return call('clipboard.writeText', { text: String(text == null ? '' : text) }); },
            },
            files: {
                save: function (options) {
                    var o = options || {};
                    return withBytes('files.save', { name: String(o.name || 'file'), mimeType: String(o.mimeType || '') }, o.data);
                },
            },
            mic: {
                start: function () { return call('mic.start'); },
                stop: function () {
                    return call('mic.stop').then(function (r) {
                        return { data: new Uint8Array(r.data), mimeType: r.mimeType, durationMs: r.durationMs };
                    });
                },
                cancel: function () { return call('mic.cancel'); },
            },
            fs: {
                paths: function () { return call('fs.paths'); },
                read: function (path) { return call('fs.read', { path: String(path) }).then(asBytes); },
                readText: function (path) {
                    return zali.fs.read(path).then(function (b) { return decoder.decode(b); });
                },
                write: function (path, data, options) {
                    return withBytes('fs.write', { path: String(path), append: !!(options && options.append) }, data);
                },
                list: function (path) { return call('fs.list', { path: String(path) }); },
                stat: function (path) { return call('fs.stat', { path: String(path) }); },
                mkdir: function (path) { return call('fs.mkdir', { path: String(path) }); },
                remove: function (path, options) {
                    return call('fs.remove', { path: String(path), recursive: !!(options && options.recursive) });
                },
            },
            system: {
                open: function (path) { return call('system.open', { path: String(path) }); },
                exec: function (path, args, options) {
                    return call('system.exec', {
                        path: String(path),
                        args: (args || []).map(String),
                        cwd: options && options.cwd ? String(options.cwd) : '',
                    });
                },
            },
            backend: {
                send: function (message) { return call('backend.send', { message: message }); },
                restart: function () { return call('backend.restart'); },
                on: function (fn) { return on('backend', fn); },
            },
        };

        ['ui', 'storage', 'assets', 'cache', 'clipboard', 'files', 'mic', 'fs', 'system', 'backend'].forEach(function (k) {
            Object.freeze(zali[k]);
        });
        Object.defineProperty(window, 'zali', { value: Object.freeze(zali), enumerable: true });
    }

    window.ZaliAddonSdk = Object.freeze({
        /** Исходник SDK, готовый для вставки в <script> песочницы. */
        source() {
            return `(${zaliAddonSdk.toString()})();`;
        },
    });
})();
