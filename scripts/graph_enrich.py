#!/usr/bin/env python3
"""Дописывает в graphify-out/graph.json межплатформенные рёбра, которых AST-проход не видит.

`graphify update .` строит только внутрифайловые/внутриязыковые связи (calls, contains…).
Здесь добавляется то, что связывает параллельные реализации из CLAUDE.md:

  bridge:<MSG>   — сообщение IPC-моста (web/bridge_protocol.json) ↔ web, macOS, iOS, Windows, Android
  api:<METHOD> <path> — HTTP-маршрут сервера ↔ вызывающие его клиенты (web и нативные шеллы)
  ffi:<fn>       — #[no_mangle] экспорт core/ ↔ вызывающие его шеллы и JNI
  mirror         — одноимённые функции sdk/Rust ↔ sdk/Swift (зеркальный формат .zali)

Все рёбра помечены `_origin: "enrich"`; повторный запуск сначала удаляет прежние.
После `graphify update .` запускать заново:  python3 scripts/graph_enrich.py
"""
from __future__ import annotations

import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRAPH = ROOT / "graphify-out" / "graph.json"

CLIENT_DIRS = {
    "web": ("web/src",),
    "macos": ("apps/macos/Sources",),
    "ios": ("apps/ios/ZaliMessenger",),
    "windows": ("apps/windows/src",),
    "android": ("apps/android/app/src/main/java",),
}
CLIENT_EXT = {".js", ".swift", ".rs", ".kt"}
SKIP_PARTS = ("Resources/Web", "/assets/", "BridgeProtocol.generated", "Assets.swift", "wasm-pkg")


def line_of(loc: str | None) -> int:
    m = re.match(r"L(\d+)", loc or "")
    return int(m.group(1)) if m else 0


def read_files(dirs):
    for d in dirs:
        base = ROOT / d
        if not base.exists():
            continue
        for p in base.rglob("*"):
            if p.suffix in CLIENT_EXT and p.is_file():
                rel = p.relative_to(ROOT).as_posix()
                if any(s in rel for s in SKIP_PARTS):
                    continue
                try:
                    yield rel, p.read_text(encoding="utf-8", errors="replace").splitlines()
                except OSError:
                    continue


def main() -> int:
    data = json.loads(GRAPH.read_text(encoding="utf-8"))
    nodes = data["nodes"]
    links = data.get("links") or data.get("edges") or []
    # идемпотентность: убираем собственные прежние узлы/рёбра
    nodes = [n for n in nodes if n.get("_origin") != "enrich"]
    links = [e for e in links if e.get("_origin") != "enrich"]
    ids = {n["id"] for n in nodes}

    # индекс: файл -> [(строка, id)] по узлам-определениям (не файловому узлу)
    by_file: dict[str, list[tuple[int, str]]] = defaultdict(list)
    file_node: dict[str, str] = {}
    for n in nodes:
        f = n.get("source_file")
        if not f:
            continue
        ln = line_of(n.get("source_location"))
        if ln <= 1 and n.get("label", "") == Path(f).name:
            file_node[f] = n["id"]
        else:
            by_file[f].append((ln, n["id"]))
    for f in by_file:
        by_file[f].sort()

    def owner(f: str, line: int) -> str | None:
        """Ближайшее предшествующее определение в файле, иначе узел файла."""
        best = None
        for ln, nid in by_file.get(f, ()):
            if ln <= line:
                best = nid
            else:
                break
        return best or file_node.get(f)

    new_nodes: dict[str, dict] = {}
    new_links: list[dict] = []

    def add_node(nid: str, label: str, kind: str):
        if nid not in ids and nid not in new_nodes:
            new_nodes[nid] = {"id": nid, "label": label, "norm_label": label.lower(),
                              "file_type": "concept", "source_file": "", "source_location": "",
                              "_origin": "enrich", "kind": kind}

    def add_edge(src: str, tgt: str, rel: str, conf: str, f: str, line: int):
        if src == tgt:
            return
        new_links.append({"source": src, "target": tgt, "relation": rel, "confidence": conf,
                          "confidence_score": 0.9 if conf == "EXTRACTED" else 0.6,
                          "source_file": f, "source_location": f"L{line}",
                          "weight": 1.0, "_origin": "enrich"})

    # ---------- 1. сообщения IPC-моста ----------
    proto = json.loads((ROOT / "web" / "bridge_protocol.json").read_text(encoding="utf-8"))
    msgs = sorted(proto["messages"], key=len, reverse=True)

    def camel(m: str) -> str:
        parts = m.lower().split("_")
        return parts[0] + "".join(w.capitalize() for w in parts[1:])

    camel_to_msg = {camel(m): m for m in msgs}
    msg_re = re.compile(r'(?<![A-Za-z0-9_])(' + "|".join(map(re.escape, msgs)) + r')(?![A-Za-z0-9_])')
    case_re = re.compile(r'\bcase\s+\.(' + "|".join(map(re.escape, camel_to_msg)) + r')\b')
    seen = set()
    counts = defaultdict(int)
    for plat, dirs in CLIENT_DIRS.items():
        for rel, lines in read_files(dirs):
            for i, text in enumerate(lines, 1):
                hits = []
                for m in msg_re.finditer(text):
                    msg = m.group(1)
                    # «как строка»: в кавычках, в начале строки трассировки ("MSG detail…") или ветка match/case
                    if re.search(r'["\'`]' + re.escape(msg) + r'(["\'`]|[ :])|case\s+' + re.escape(msg) + r'\b|' + re.escape(msg) + r'\s*(=>|->)', text):
                        hits.append(msg)
                if rel.endswith(".swift"):
                    hits += [camel_to_msg[m.group(1)] for m in case_re.finditer(text)]
                for msg in hits:
                    own = owner(rel, i)
                    if not own or (own, msg) in seen:
                        continue
                    seen.add((own, msg))
                    nid = "bridge_" + msg.lower()
                    add_node(nid, f"bridge:{msg}", "bridge_message")
                    add_edge(own, nid, "uses_message", "INFERRED", rel, i)
                    counts["bridge"] += 1

    # ---------- 2. HTTP-маршруты сервера ↔ клиенты ----------
    route_re = re.compile(r'\.route\(\s*"(/[^"]*)"\s*,\s*(.+)$')
    method_re = re.compile(r'\b(get|post|put|patch|delete)\s*\(\s*([A-Za-z_][\w:]*)')
    routes: list[tuple[re.Pattern, str, str]] = []  # (regex, api node id, path)
    for p in (ROOT / "server" / "src").rglob("*.rs"):
        rel = p.relative_to(ROOT).as_posix()
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        for i, text in enumerate(lines, 1):
            m = route_re.search(text)
            if not m:
                continue
            path, rest = m.group(1), m.group(2)
            pat = re.sub(r"[:{][A-Za-z_]\w*\}?", r"[^/?]+", re.escape(path).replace("\\{", "{").replace("\\}", "}"))
            pat = re.sub(r"\\?\{[A-Za-z_]\w*\\?\}", r"[^/?]+", pat)
            for mm in method_re.finditer(rest):
                verb, handler = mm.group(1).upper(), mm.group(2).split("::")[-1]
                nid = f"api_{verb.lower()}_{re.sub(r'[^a-z0-9]+', '_', path.lower()).strip('_')}"
                add_node(nid, f"{verb} {path}", "api_route")
                routes.append((re.compile("^" + pat + r"/?(\?.*)?$"), nid, path))
                own = owner(rel, i)
                if own:
                    add_edge(nid, own, "routed_in", "EXTRACTED", rel, i)
                counts["routes"] += 1
    handler_ids = {}
    for n in nodes:
        f = n.get("source_file") or ""
        if f.startswith("server/src") and n.get("label", "").endswith("()"):
            handler_ids.setdefault(n["label"][:-2], n["id"])
    for p in (ROOT / "server" / "src").rglob("*.rs"):
        rel = p.relative_to(ROOT).as_posix()
        for i, text in enumerate(p.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            m = route_re.search(text)
            if not m:
                continue
            path = m.group(1)
            for mm in method_re.finditer(m.group(2)):
                verb, handler = mm.group(1).upper(), mm.group(2).split("::")[-1]
                nid = f"api_{verb.lower()}_{re.sub(r'[^a-z0-9]+', '_', path.lower()).strip('_')}"
                if handler in handler_ids:
                    add_edge(nid, handler_ids[handler], "handled_by", "EXTRACTED", rel, i)
    url_re = re.compile(r'/api/[A-Za-z0-9_\-/.:${}]*')
    seen = set()
    for plat, dirs in CLIENT_DIRS.items():
        for rel, lines in read_files(dirs):
            for i, text in enumerate(lines, 1):
                for m in url_re.finditer(text):
                    raw = re.sub(r"\$\{[^}]*\}|\\\([^)]*\)|\{[^}]*\}", "X", m.group(0)).rstrip("/")
                    for rx, nid, path in routes:
                        if rx.match(raw) or rx.match(raw + "/"):
                            own = owner(rel, i)
                            key = (own, nid)
                            if own and key not in seen:
                                seen.add(key)
                                add_edge(own, nid, "calls_api", "INFERRED", rel, i)
                                counts["client_api"] += 1

    # ---------- 3. FFI core ↔ шеллы ----------
    ffi: dict[str, tuple[str, int]] = {}
    for p in (ROOT / "core" / "src").rglob("*.rs"):
        rel = p.relative_to(ROOT).as_posix()
        lines = p.read_text(encoding="utf-8", errors="replace").splitlines()
        for i, text in enumerate(lines):
            if "#[no_mangle]" in text:
                for j in range(i + 1, min(i + 15, len(lines))):
                    m = re.search(r'fn\s+([A-Za-z_]\w*)', lines[j])
                    if m:
                        name = m.group(1)
                        ffi[name] = (rel, j + 1)
                        if name.startswith("Java_"):  # JNI: Java_pkg_Class_method -> Kotlin `external fun method`
                            ffi[name.rsplit("_", 1)[-1]] = (rel, j + 1)
                        break
    if ffi:
        ffi_re = re.compile(r'(?<![A-Za-z0-9_])(' + "|".join(map(re.escape, sorted(ffi, key=len, reverse=True))) + r')(?![A-Za-z0-9_])')
        seen = set()
        for plat, dirs in CLIENT_DIRS.items():
            for rel, lines in read_files(dirs + ("core/src",)):
                for i, text in enumerate(lines, 1):
                    for m in ffi_re.finditer(text):
                        fn = m.group(1)
                        if rel == ffi[fn][0] and i == ffi[fn][1]:
                            continue
                        own = owner(rel, i)
                        if not own or (own, fn) in seen:
                            continue
                        seen.add((own, fn))
                        nid = "ffi_" + fn.lower()
                        add_node(nid, f"ffi:{fn}", "ffi_export")
                        add_edge(own, nid, "calls_ffi", "INFERRED", rel, i)
                        counts["ffi"] += 1
        for fn, (rel, ln) in ffi.items():
            own = owner(rel, ln)
            if own and ("ffi_" + fn.lower()) in new_nodes:
                add_edge("ffi_" + fn.lower(), own, "implemented_by", "EXTRACTED", rel, ln)

    # ---------- 4. зеркала sdk/Rust ↔ sdk/Swift ----------
    def norm(label: str) -> str:
        s = label.strip(".").rstrip("()").replace("_", "").lower()
        return s
    rust, swift = defaultdict(list), defaultdict(list)
    for n in nodes:
        f = n.get("source_file") or ""
        lab = n.get("label", "")
        if not lab.endswith("()") or len(norm(lab)) < 6:
            continue
        if f.startswith("sdk/Rust"):
            rust[norm(lab)].append(n["id"])
        elif f.startswith("sdk/Swift"):
            swift[norm(lab)].append(n["id"])
    for k in rust.keys() & swift.keys():
        if len(rust[k]) == 1 and len(swift[k]) == 1:
            add_edge(rust[k][0], swift[k][0], "mirrors", "INFERRED", "sdk", 0)
            counts["mirror"] += 1

    # ---------- 5. документированные параллельные реализации (CLAUDE.md) ----------
    A = "apps/android/app/src/main/java/org/zalikus/messenger/"
    file_pairs = [
        # нативный слой: IPC-бридж WebView ↔ ядро
        ("apps/macos/Sources/ZaliMessenger/Views/WebView.swift", "apps/windows/src/native.rs"),
        ("apps/macos/Sources/ZaliMessenger/Views/WebView.swift", A + "NativeBridge.kt"),
        ("apps/windows/src/native.rs", A + "NativeBridge.kt"),
        ("apps/macos/Sources/ZaliMessenger/Views/WebView.swift", "apps/ios/ZaliMessenger/WebView.swift"),
        # обёртка над core FFI
        ("apps/macos/Sources/ZaliMessenger/Services/ZaliCore.swift", "apps/ios/ZaliMessenger/ZaliCore.swift"),
        ("apps/macos/Sources/ZaliMessenger/Services/ZaliCore.swift", A + "ZaliCoreBridge.kt"),
        ("apps/macos/Sources/ZaliMessenger/Services/ZaliCore.swift", "apps/windows/src/native/messages.rs"),
        # формат .zali
        ("sdk/Rust/src/lib.rs", "sdk/Swift/ZaliArc.swift"),
    ]
    for a, b in file_pairs:
        if a in file_node and b in file_node:
            add_edge(file_node[a], file_node[b], "mirrors", "INFERRED", a, 1)
            counts["mirror_file"] += 1
    # функции SDK: имена разные, смысл один
    fn_pairs = [("create_archive", "pack"), ("create_archive_bytes", "pack"), ("pack_internal", "pack"),
                ("extract_all", "unpack"), ("extract_all_bytes", "unpack"), ("unpack_internal", "unpack")]
    lab = {}
    for n in nodes:
        f = n.get("source_file") or ""
        if f.startswith(("sdk/Rust", "sdk/Swift")):
            lab[(f.split("/")[1], n["label"].lstrip(".").rstrip("()"))] = n["id"]
    for r, sw in fn_pairs:
        if ("Rust", r) in lab and ("Swift", sw) in lab:
            add_edge(lab[("Rust", r)], lab[("Swift", sw)], "mirrors", "INFERRED", "sdk", 0)
            counts["mirror_fn"] += 1

    # сброс рёбер с пустой целью
    new_links = [e for e in new_links if e["source"] and e["target"]
                 and (e["source"] in ids or e["source"] in new_nodes)
                 and (e["target"] in ids or e["target"] in new_nodes)]

    data["nodes"] = nodes + list(new_nodes.values())
    data["links" if "links" in data else "edges"] = links + new_links
    GRAPH.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    print(f"+{len(new_nodes)} узлов, +{len(new_links)} рёбер  {dict(counts)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
