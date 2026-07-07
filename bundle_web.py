#!/usr/bin/env python3
import json
import os
import shutil
import re

def main():
    print("📦 Начинаем сборку веб-модулей...")

    project_root = os.path.abspath(os.path.dirname(__file__))
    web_dir = os.path.join(project_root, "Web")
    src_dir = os.path.join(web_dir, "src")

    bridge_protocol_path = os.path.join(web_dir, "bridge_protocol.json")
    with open(bridge_protocol_path, "r", encoding="utf-8") as f:
        bridge_protocol = json.load(f)

    native_types = bridge_protocol.get("messages", {})
    if not isinstance(native_types, dict) or not native_types:
        raise RuntimeError("bridge_protocol.json must define bridge messages")

    native_types_path = os.path.join(src_dir, "modules", "native_types.js")
    native_types_content = (
        "(function() {\n"
        "    'use strict';\n\n"
        "    /**\n"
        "     * @enum {string}\n"
        "     */\n"
        "    const ZaliNativeMessageTypes = Object.freeze({\n"
    )
    for key in sorted(native_types.keys()):
        native_types_content += f"        {key}: {json.dumps(key, ensure_ascii=False)},\n"
    native_types_content += (
        "    });\n\n"
        "    window.ZaliNativeMessageTypes = ZaliNativeMessageTypes;\n"
        "})();\n"
    )
    with open(native_types_path, "w", encoding="utf-8") as f:
        f.write(native_types_content)

    swift_protocol_dir = os.path.join(project_root, "macOS", "Sources", "ZaliMessenger")
    if os.path.isdir(swift_protocol_dir):
        swift_protocol_path = os.path.join(swift_protocol_dir, "BridgeProtocol.generated.swift")
        def swift_case_name(key):
            parts = key.lower().split("_")
            if not parts:
                return key.lower()
            first, *rest = parts
            return first + "".join(piece[:1].upper() + piece[1:] for piece in rest)

        swift_protocol_content = (
            "import Foundation\n\n"
            "enum BridgeProtocolMessageType: String, CaseIterable {\n"
        )
        for key in sorted(native_types.keys()):
            swift_protocol_content += f"    case {swift_case_name(key)} = {json.dumps(key, ensure_ascii=False)}\n"
        swift_protocol_content += "}\n"
        with open(swift_protocol_path, "w", encoding="utf-8") as f:
            f.write(swift_protocol_content)
    else:
        # Windows-only source drops (see zali-windows-source.zip) don't include macOS/ —
        # nothing there needs the generated Swift file, so skip it instead of failing the build.
        print("ℹ️  macOS/ not present, skipping BridgeProtocol.generated.swift")

    js_files = [
        os.path.join(src_dir, "modules", "bus_events.js"),
        os.path.join(src_dir, "modules", "api_routes.js"),
        os.path.join(src_dir, "modules", "native_types.js"),
        os.path.join(src_dir, "modules", "auth.js"),
        os.path.join(src_dir, "modules", "contacts.js"),
        os.path.join(src_dir, "modules", "messaging.js"),
        os.path.join(src_dir, "modules", "servers.js"),
        os.path.join(src_dir, "modules", "voice.js"),
        os.path.join(src_dir, "bus.js"),
        os.path.join(src_dir, "loader.js"),
        os.path.join(src_dir, "styler.js"),
        os.path.join(src_dir, "interface.js"),
        os.path.join(src_dir, "bootstrap.js"),
    ]

    # 2. Чтение и объединение JS модулей
    bundled_js = ""
    for js_path in js_files:
        if not os.path.exists(js_path):
            print(f"❌ Ошибка: Файл {js_path} не найден!")
            return

        name = os.path.basename(js_path)
        print(f"  -> Добавление JS модуля: {name}")
        with open(js_path, "r", encoding="utf-8") as f:
            bundled_js += f"// --- MODULE: {name} ---\n"
            bundled_js += f.read()
            bundled_js += "\n\n"
    bundled_js = bundled_js.rstrip() + "\n"

    # 3. Чтение CSS и HTML
    css_path = os.path.join(web_dir, "style.css")
    with open(css_path, "r", encoding="utf-8") as f:
        css_content = f.read()

    html_path = os.path.join(web_dir, "index.html")
    with open(html_path, "r", encoding="utf-8") as f:
        html_content = f.read()

    # 4. Inject CSS and JS inline into HTML so it works as a self-contained string
    # (no external file loading needed in WKWebView)
    inline_html = html_content

    # Replace <link rel="stylesheet" href="style.css"> with an inline <style> block
    inline_html = inline_html.replace(
        '<link rel="stylesheet" href="style.css">',
        f'<style id="zali-base-style">\n{css_content}\n</style>'
    )

    # Inject saved CSS loader script right after <head> open tag or before </head>
    saved_css_loader = """
    <script>
    // Inject persisted custom CSS overrides from UserDefaults (set by native Swift layer)
    (function() {
        if (window.__ZALI_SAVED_CSS) {
            var s = document.createElement('style');
            s.id = 'zali-custom-style';
            s.textContent = window.__ZALI_SAVED_CSS;
            document.head.appendChild(s);
        }
    })();
    </script>"""
    inline_html = inline_html.replace('</head>', saved_css_loader + '\n</head>')

    def parse_ice_servers(raw):
        if not raw:
            return None
        try:
            value = json.loads(raw)
        except Exception:
            return None
        return value if isinstance(value, list) else None

    def parse_bool(raw):
        if raw is None:
            return None
        value = str(raw).strip().lower()
        if value in ("1", "true", "yes", "on"):
            return True
        if value in ("0", "false", "no", "off"):
            return False
        return None

    turn_url = os.environ.get("ZALI_TURN_URL", "").strip()
    turn_username = os.environ.get("ZALI_TURN_USERNAME", "").strip()
    turn_credential = os.environ.get("ZALI_TURN_CREDENTIAL", "").strip()
    turn_relay_only = parse_bool(os.environ.get("ZALI_TURN_RELAY_ONLY", "").strip())

    zali_config = {
        "apiBaseUrl": os.environ.get("ZALI_API_BASE_URL", "").strip(),
        "wsBaseUrl": os.environ.get("ZALI_WS_BASE_URL", "").strip(),
        "iceServers": parse_ice_servers(os.environ.get("ZALI_ICE_SERVERS_JSON", "").strip())
            or parse_ice_servers(os.environ.get("ZALI_ICE_SERVERS", "").strip()),
    }
    if turn_url:
        turn_cfg = {"url": turn_url}
        if turn_username:
            turn_cfg["username"] = turn_username
        if turn_credential:
            turn_cfg["credential"] = turn_credential
        if turn_relay_only is not None:
            turn_cfg["relayOnly"] = turn_relay_only
        zali_config["turn"] = turn_cfg
    zali_config = {k: v for k, v in zali_config.items() if v}
    config_loader = f"""
    <script>
    window.__ZALI_CONFIG = {json.dumps(zali_config, ensure_ascii=False)};
    </script>"""
    inline_html = inline_html.replace('</head>', config_loader + '\n</head>')

    protocol_loader = f"""
    <script>
    window.__ZALI_BRIDGE_PROTOCOL__ = {json.dumps(bridge_protocol, ensure_ascii=False)};
    </script>"""
    inline_html = inline_html.replace('</head>', protocol_loader + '\n</head>')

    # Replace app.js script tag even if it carries a cache-busting query string.
    inline_html, replaced = re.subn(
        r'<script\s+src="app\.js(?:\?[^"]*)?"\s*></script>',
        lambda _: f'<script>\n{bundled_js}\n</script>',
        inline_html,
        count=1,
    )
    if not replaced:
        # Inject before </body> if no explicit app.js reference
        inline_html = inline_html.replace(
            '</body>',
            f'<script>\n{bundled_js}\n</script>\n</body>'
        )

    # 5. Формирование содержимого Assets.swift
    # Using raw string literals (#""" ... """#) so JS/CSS content with backslashes is safe
    assets_swift_content = (
        'import Foundation\n\n'
        'struct WebAssets {\n\n'
        '    // MARK: - Inline HTML (with embedded CSS + JS)\n\n'
        '    static let html = #"""\n'
        + inline_html + '\n'
        '"""#\n'
        '}\n'
    )

    # Paths where Assets.swift lives
    dest_paths = [
        os.path.join(project_root, "macOS", "Sources", "ZaliMessenger", "Assets.swift"),
    ]

    for dest in dest_paths:
        dest_dir = os.path.dirname(dest)
        if os.path.exists(dest_dir):
            print(f"💾 Запись Assets.swift в: {dest}")
            with open(dest, "w", encoding="utf-8") as f:
                f.write(assets_swift_content)

    # 6. Копирование ресурсов в ресурсы SPM пакета (если они есть)
    resources_web_dir = os.path.join(project_root, "macOS", "Sources", "ZaliMessenger", "Resources", "Web")
    if os.path.exists(resources_web_dir):
        print(f"📂 Копирование файлов в ресурсы бандла: {resources_web_dir}")
        shutil.copy2(html_path, os.path.join(resources_web_dir, "index.html"))
        shutil.copy2(css_path, os.path.join(resources_web_dir, "style.css"))
        shutil.copy2(bridge_protocol_path, os.path.join(resources_web_dir, "bridge_protocol.json"))
        shutil.copy2(native_types_path, os.path.join(resources_web_dir, "native_types.js"))
        with open(os.path.join(resources_web_dir, "app.js"), "w", encoding="utf-8") as f:
            f.write(bundled_js)

    # 7. Также сохраняем собранный app.js в папке Web для отладки в браузере
    with open(os.path.join(web_dir, "app.js"), "w", encoding="utf-8") as f:
        f.write(bundled_js)

    print("✅ Сборка успешно завершена!")
    print(f"   JS модулей в бандле: {len(js_files)}")
    print(f"   Криптография и сеть: Rust backend (Core)")
    print(f"   Фронтенд модули: ZaliStyler + ZaliInterface")

if __name__ == "__main__":
    main()
