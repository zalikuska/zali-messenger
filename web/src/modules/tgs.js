// @ts-check
// TGS (Telegram animated sticker) support.
//
// A .tgs file is nothing but a gzip-compressed Lottie/Bodymovin JSON animation.
// Rendering one therefore needs two things this module provides:
//   1. gunzip in the browser — `DecompressionStream('gzip')` where available,
//      falling back to the small pure-JS inflate below (WKWebView only got
//      DecompressionStream in Safari 16.4, and the macOS shell has to keep
//      working on older systems);
//   2. a Lottie player — the vendored lottie-web "light" build (SVG renderer,
//      no expressions) in web/src/vendor/lottie_light.min.js.
//
// Exposed as `window.ZaliTgs`; interface.js calls `hydrate()` after every
// message render and this module owns the animation lifecycle from there on
// (play/pause on visibility, destroy when the node leaves the DOM).
(function() {
    'use strict';

    const TGS_MIME = 'application/x-tgsticker';
    // A .tgs is capped at 64 KB by Telegram itself; be generous but bounded so a
    // hostile peer can't hand us a gzip bomb to inflate.
    const MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
    const MAX_INFLATED_BYTES = 32 * 1024 * 1024;
    const ANIMATION_CACHE_LIMIT = 24;

    /* ------------------------------------------------------------------ */
    /* inflate (RFC 1951) + gzip container (RFC 1952) — fallback only      */
    /* ------------------------------------------------------------------ */

    const MAX_BITS = 15;
    const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59,
        67, 83, 99, 115, 131, 163, 195, 227, 258];
    const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3,
        4, 4, 4, 4, 5, 5, 5, 5, 0];
    const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769,
        1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
    const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8,
        9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
    const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

    // Canonical Huffman decoding table in the "count per length + sorted symbols"
    // form used by zlib's puff.c: compact, allocation-light, and easy to verify.
    function buildHuffman(lengths) {
        const count = new Int32Array(MAX_BITS + 1);
        for (let i = 0; i < lengths.length; i += 1) count[lengths[i]] += 1;
        count[0] = 0;
        const offsets = new Int32Array(MAX_BITS + 2);
        for (let len = 1; len <= MAX_BITS; len += 1) offsets[len + 1] = offsets[len] + count[len];
        const symbols = new Int32Array(lengths.length);
        for (let sym = 0; sym < lengths.length; sym += 1) {
            const len = lengths[sym];
            if (len) {
                symbols[offsets[len]] = sym;
                offsets[len] += 1;
            }
        }
        return { count, symbols };
    }

    const FIXED_LITERAL_LENGTHS = (() => {
        const lengths = new Uint8Array(288);
        for (let i = 0; i < 144; i += 1) lengths[i] = 8;
        for (let i = 144; i < 256; i += 1) lengths[i] = 9;
        for (let i = 256; i < 280; i += 1) lengths[i] = 7;
        for (let i = 280; i < 288; i += 1) lengths[i] = 8;
        return lengths;
    })();
    const FIXED_DISTANCE_LENGTHS = (() => {
        const lengths = new Uint8Array(30);
        lengths.fill(5);
        return lengths;
    })();
    let fixedLiteralTable = null;
    let fixedDistanceTable = null;

    function inflateRaw(input, startPos) {
        let pos = startPos;
        let bitBuffer = 0;
        let bitCount = 0;
        let output = new Uint8Array(Math.max(1024, (input.length - startPos) * 4));
        let outLen = 0;

        function needBits(n) {
            while (bitCount < n) {
                if (pos >= input.length) throw new Error('tgs: truncated deflate stream');
                bitBuffer |= input[pos] << bitCount;
                pos += 1;
                bitCount += 8;
            }
        }

        function takeBits(n) {
            if (n === 0) return 0;
            needBits(n);
            const value = bitBuffer & ((1 << n) - 1);
            bitBuffer >>>= n;
            bitCount -= n;
            return value;
        }

        function decodeSymbol(table) {
            let code = 0;
            let first = 0;
            let index = 0;
            for (let len = 1; len <= MAX_BITS; len += 1) {
                code |= takeBits(1);
                const count = table.count[len];
                if (code - first < count) return table.symbols[index + (code - first)];
                index += count;
                first = (first + count) << 1;
                code <<= 1;
            }
            throw new Error('tgs: invalid huffman code');
        }

        function grow(extra) {
            if (outLen + extra <= output.length) return;
            let size = output.length * 2;
            while (size < outLen + extra) size *= 2;
            if (size > MAX_INFLATED_BYTES) {
                if (outLen + extra > MAX_INFLATED_BYTES) throw new Error('tgs: animation too large');
                size = MAX_INFLATED_BYTES;
            }
            const next = new Uint8Array(size);
            next.set(output.subarray(0, outLen));
            output = next;
        }

        for (;;) {
            const isFinal = takeBits(1);
            const type = takeBits(2);

            if (type === 0) {
                // Stored: discard the partial byte, then LEN/NLEN and raw payload.
                bitBuffer = 0;
                bitCount = 0;
                if (pos + 4 > input.length) throw new Error('tgs: truncated stored block');
                const len = input[pos] | (input[pos + 1] << 8);
                const nlen = input[pos + 2] | (input[pos + 3] << 8);
                pos += 4;
                if ((len ^ 0xffff) !== nlen) throw new Error('tgs: corrupt stored block');
                if (pos + len > input.length) throw new Error('tgs: truncated stored block');
                grow(len);
                output.set(input.subarray(pos, pos + len), outLen);
                outLen += len;
                pos += len;
            } else if (type === 1 || type === 2) {
                let literalTable;
                let distanceTable;
                if (type === 1) {
                    if (!fixedLiteralTable) {
                        fixedLiteralTable = buildHuffman(FIXED_LITERAL_LENGTHS);
                        fixedDistanceTable = buildHuffman(FIXED_DISTANCE_LENGTHS);
                    }
                    literalTable = fixedLiteralTable;
                    distanceTable = fixedDistanceTable;
                } else {
                    const literalCount = takeBits(5) + 257;
                    const distanceCount = takeBits(5) + 1;
                    const codeLengthCount = takeBits(4) + 4;
                    const codeLengths = new Uint8Array(19);
                    for (let i = 0; i < codeLengthCount; i += 1) {
                        codeLengths[CODE_LENGTH_ORDER[i]] = takeBits(3);
                    }
                    const codeLengthTable = buildHuffman(codeLengths);
                    const lengths = new Uint8Array(literalCount + distanceCount);
                    let index = 0;
                    while (index < lengths.length) {
                        const symbol = decodeSymbol(codeLengthTable);
                        if (symbol < 16) {
                            lengths[index] = symbol;
                            index += 1;
                        } else if (symbol === 16) {
                            if (index === 0) throw new Error('tgs: no previous code length');
                            const previous = lengths[index - 1];
                            let repeat = 3 + takeBits(2);
                            while (repeat > 0 && index < lengths.length) {
                                lengths[index] = previous;
                                index += 1;
                                repeat -= 1;
                            }
                        } else if (symbol === 17) {
                            index += 3 + takeBits(3);
                        } else {
                            index += 11 + takeBits(7);
                        }
                    }
                    if (index > lengths.length) throw new Error('tgs: code length overflow');
                    literalTable = buildHuffman(lengths.subarray(0, literalCount));
                    distanceTable = buildHuffman(lengths.subarray(literalCount));
                }

                for (;;) {
                    const symbol = decodeSymbol(literalTable);
                    if (symbol < 256) {
                        grow(1);
                        output[outLen] = symbol;
                        outLen += 1;
                    } else if (symbol === 256) {
                        break;
                    } else {
                        const lengthIndex = symbol - 257;
                        if (lengthIndex >= LENGTH_BASE.length) throw new Error('tgs: invalid length code');
                        const length = LENGTH_BASE[lengthIndex] + takeBits(LENGTH_EXTRA[lengthIndex]);
                        const distanceSymbol = decodeSymbol(distanceTable);
                        if (distanceSymbol >= DIST_BASE.length) throw new Error('tgs: invalid distance code');
                        const distance = DIST_BASE[distanceSymbol] + takeBits(DIST_EXTRA[distanceSymbol]);
                        if (distance > outLen) throw new Error('tgs: distance beyond output');
                        grow(length);
                        let from = outLen - distance;
                        for (let i = 0; i < length; i += 1) {
                            output[outLen] = output[from];
                            outLen += 1;
                            from += 1;
                        }
                    }
                }
            } else {
                throw new Error('tgs: invalid block type');
            }

            if (isFinal) break;
        }

        return output.subarray(0, outLen);
    }

    function gunzipFallback(bytes) {
        if (bytes.length < 18) throw new Error('tgs: file too short');
        if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) throw new Error('tgs: not a gzip file');
        if (bytes[2] !== 8) throw new Error('tgs: unsupported gzip compression method');
        const flags = bytes[3];
        let pos = 10;
        if (flags & 0x04) {
            const extraLen = bytes[pos] | (bytes[pos + 1] << 8);
            pos += 2 + extraLen;
        }
        if (flags & 0x08) {
            while (pos < bytes.length && bytes[pos] !== 0) pos += 1;
            pos += 1;
        }
        if (flags & 0x10) {
            while (pos < bytes.length && bytes[pos] !== 0) pos += 1;
            pos += 1;
        }
        if (flags & 0x02) pos += 2;
        if (pos >= bytes.length) throw new Error('tgs: truncated gzip header');
        return inflateRaw(bytes, pos);
    }

    async function gunzip(bytes) {
        if (typeof DecompressionStream === 'function' && typeof Response === 'function') {
            try {
                const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
                const buffer = await new Response(stream).arrayBuffer();
                if (buffer.byteLength > MAX_INFLATED_BYTES) throw new Error('tgs: animation too large');
                return new Uint8Array(buffer);
            } catch (error) {
                // Older WKWebView builds expose DecompressionStream but reject the
                // Blob stream pipeline; the pure-JS path below always works.
                console.warn('ZaliTgs: DecompressionStream failed, falling back', error);
            }
        }
        return gunzipFallback(bytes);
    }

    /* ------------------------------------------------------------------ */
    /* attachment helpers                                                  */
    /* ------------------------------------------------------------------ */

    function isTgsName(name) {
        return /\.tgs$/i.test(String(name || '').trim());
    }

    function isTgsMime(mimeType) {
        const value = String(mimeType || '').trim().toLowerCase();
        return value === TGS_MIME || value === 'application/x-tgsticker' || value === 'application/tgs';
    }

    // Peers (and older builds of this app) may hand a .tgs over as
    // application/gzip or application/octet-stream, so the filename is the
    // authoritative signal and the mime type is only a shortcut.
    function isTgsAttachment(att) {
        if (!att) return false;
        if (att.kind === 'sticker') return true;
        if (isTgsMime(att.mimeType || att.mime_type)) return true;
        return isTgsName(att.name) || isTgsName(att.archivePath || att.archive_path);
    }

    /* ------------------------------------------------------------------ */
    /* animation data loading                                              */
    /* ------------------------------------------------------------------ */

    const animationCache = new Map();

    function decodeDataUrl(src) {
        const commaIndex = src.indexOf(',');
        if (commaIndex < 0) throw new Error('tgs: malformed data URL');
        const meta = src.slice(5, commaIndex);
        const payload = src.slice(commaIndex + 1);
        if (/;base64/i.test(meta)) {
            const binary = atob(payload);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            return bytes;
        }
        return new TextEncoder().encode(decodeURIComponent(payload));
    }

    async function fetchBytes(src) {
        if (src.startsWith('data:')) return decodeDataUrl(src);
        const response = await fetch(src);
        if (!response.ok) throw new Error(`tgs: fetch failed (${response.status})`);
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    }

    // TGS forbids raster images and text layers, and this app has no business
    // letting a peer's animation reach out to the network or load fonts. Drop
    // those pieces instead of trusting the player to ignore them.
    function sanitizeAnimation(animation) {
        if (animation && typeof animation === 'object') {
            delete animation.fonts;
            delete animation.chars;
            if (Array.isArray(animation.assets)) {
                animation.assets = animation.assets.filter(asset => {
                    if (!asset || typeof asset !== 'object') return false;
                    if (Array.isArray(asset.layers)) {
                        asset.layers = sanitizeLayers(asset.layers);
                        return true;
                    }
                    return false;
                });
            }
            if (Array.isArray(animation.layers)) {
                animation.layers = sanitizeLayers(animation.layers);
            }
        }
        return animation;
    }

    function sanitizeLayers(layers) {
        // ty 2 = image layer, ty 5 = text layer — neither is valid in a TGS.
        return layers.filter(layer => layer && typeof layer === 'object' && layer.ty !== 2 && layer.ty !== 5);
    }

    function rememberAnimation(key, data) {
        if (animationCache.has(key)) animationCache.delete(key);
        animationCache.set(key, data);
        while (animationCache.size > ANIMATION_CACHE_LIMIT) {
            const oldest = animationCache.keys().next().value;
            animationCache.delete(oldest);
        }
    }

    async function loadAnimationData(src) {
        const cached = animationCache.get(src);
        if (cached) {
            rememberAnimation(src, cached);
            return cached;
        }

        const bytes = await fetchBytes(src);
        if (bytes.length > MAX_COMPRESSED_BYTES) throw new Error('tgs: sticker file too large');
        const inflated = await gunzip(bytes);
        const json = new TextDecoder().decode(inflated);
        const animation = JSON.parse(json);
        if (!animation || typeof animation !== 'object' || !Array.isArray(animation.layers)) {
            throw new Error('tgs: not a lottie animation');
        }
        const sanitized = sanitizeAnimation(animation);
        rememberAnimation(src, sanitized);
        return sanitized;
    }

    /* ------------------------------------------------------------------ */
    /* mounting                                                            */
    /* ------------------------------------------------------------------ */

    const mounted = new Set();
    let observer = null;

    function ensureObserver() {
        if (observer || typeof IntersectionObserver !== 'function') return observer;
        observer = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                const animation = entry.target.__zaliTgsAnimation;
                if (!animation) return;
                if (entry.isIntersecting) {
                    animation.play();
                } else {
                    animation.pause();
                }
            });
        }, { rootMargin: '200px' });
        return observer;
    }

    // Re-rendering the message list replaces every node wholesale, which would
    // otherwise leave orphaned animations running their rAF loop forever.
    function pruneDetached() {
        mounted.forEach((element) => {
            if (element.isConnected) return;
            mounted.delete(element);
            observer?.unobserve(element);
            try {
                element.__zaliTgsAnimation?.destroy();
            } catch (error) {
                /* the player is gone either way */
            }
            element.__zaliTgsAnimation = null;
        });
    }

    function showFallback(element, reason) {
        element.dataset.tgsState = 'error';
        element.classList.add('media-sticker-failed');
        const fallback = element.querySelector('.media-sticker-fallback');
        if (fallback instanceof HTMLElement) fallback.hidden = false;
        console.warn('ZaliTgs: failed to render sticker', reason);
    }

    async function mount(element) {
        const src = element.dataset.tgsSrc || '';
        if (!src) return;
        element.dataset.tgsState = 'loading';

        let animationData;
        try {
            animationData = await loadAnimationData(src);
        } catch (error) {
            showFallback(element, error);
            return;
        }

        // The node may have been replaced by another render while we decoded.
        if (!element.isConnected || element.dataset.tgsState !== 'loading') return;
        if (typeof window.lottie === 'undefined') {
            showFallback(element, new Error('tgs: lottie player unavailable'));
            return;
        }

        const stage = element.querySelector('.media-sticker-stage') || element;
        let animation;
        try {
            animation = window.lottie.loadAnimation({
                container: stage,
                renderer: 'svg',
                loop: true,
                autoplay: true,
                animationData,
                rendererSettings: {
                    preserveAspectRatio: 'xMidYMid meet',
                    progressiveLoad: true,
                    hideOnTransparent: true,
                },
            });
        } catch (error) {
            showFallback(element, error);
            return;
        }

        element.__zaliTgsAnimation = animation;
        element.dataset.tgsState = 'ready';
        mounted.add(element);
        ensureObserver()?.observe(element);
    }

    /**
     * Boots every not-yet-mounted `.media-sticker` under `root` and reaps the
     * animations whose nodes have since left the document.
     * @param {ParentNode} [root]
     */
    function hydrate(root) {
        pruneDetached();
        const scope = root || document;
        const nodes = scope.querySelectorAll?.('.media-sticker[data-tgs-src]') || [];
        nodes.forEach((node) => {
            if (!(node instanceof HTMLElement)) return;
            if (node.dataset.tgsState) return;
            mount(node);
        });
    }

    window.ZaliTgs = {
        TGS_MIME,
        isTgsAttachment,
        isTgsName,
        isTgsMime,
        loadAnimationData,
        gunzip,
        hydrate,
    };
})();
