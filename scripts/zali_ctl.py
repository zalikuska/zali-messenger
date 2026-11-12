#!/usr/bin/env python3
"""Управление запущенным ZaliMessenger (macOS/Windows) из терминала.

Включение: в приложении Настройки → «Для разработчиков» → «Управление из терминала»,
скопировать строку подключения и один раз выполнить:

    python3 scripts/zali_ctl.py pair 'zalictl://<токен>@127.0.0.1:<порт>' [--name mac]

Строка хранится в ~/.config/zali_ctl.json (права 0600). Несколько приложений —
несколько имён, выбор `-t <имя>`; без -t — последнее подключённое. Переменная
ZALI_CTL_URL перекрывает сохранённое.

Примеры:
    zali_ctl.py state
    zali_ctl.py chats
    zali_ctl.py messages bob -n 10
    zali_ctl.py send bob 'привет'
    zali_ctl.py send --server Test --channel general 'всем привет'
    zali_ctl.py voice join Test 'Голосовой'
    zali_ctl.py voice mute | unmute | deafen | camera on | leave | state
    zali_ctl.py call bob            # личный звонок; accept / reject
    zali_ctl.py screen sources      # экраны и окна (номер, id, название)
    zali_ctl.py screen start 0      # по номеру, id или части названия; --window, --no-audio
    zali_ctl.py screen stop
    zali_ctl.py logs -n 100         # журнал звонков; --journal — общий журнал
    zali_ctl.py snapshot shot.png   # снимок окна (macOS)
    zali_ctl.py window show
    zali_ctl.py eval 'this.voice.status'
    zali_ctl.py wait 'this.voice.status === "connected"' --timeout 20000
    zali_ctl.py raw voice.state '{}'

Браузер (без приложения) — ссылка разработчика на локальный веб-клиент и сервер:
    zali_ctl.py url --as alice --contact bob --chat bob
    zali_ctl.py url --as alice --channel 'Test/general' --view settings
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

CONFIG = Path(os.environ.get("ZALI_CTL_CONFIG", Path.home() / ".config" / "zali_ctl.json"))


def load_config() -> dict:
    try:
        return json.loads(CONFIG.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"targets": {}, "default": ""}


def save_config(cfg: dict) -> None:
    CONFIG.parent.mkdir(parents=True, exist_ok=True)
    CONFIG.write_text(json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(CONFIG, 0o600)
    except OSError:
        pass


def parse_url(url: str) -> tuple[str, int, str]:
    parsed = urllib.parse.urlsplit(url.strip())
    if parsed.scheme != "zalictl" or not parsed.username or not parsed.port:
        raise SystemExit("ожидается строка вида zalictl://<токен>@127.0.0.1:<порт> из настроек приложения")
    if parsed.hostname not in ("127.0.0.1", "localhost"):
        raise SystemExit("вход управления слушает только 127.0.0.1")
    return parsed.hostname, parsed.port, parsed.username


def target_url(name: str | None) -> str:
    env = os.environ.get("ZALI_CTL_URL")
    if env and not name:
        return env
    cfg = load_config()
    key = name or cfg.get("default") or ""
    url = cfg.get("targets", {}).get(key)
    if not url:
        known = ", ".join(cfg.get("targets", {})) or "нет"
        raise SystemExit(f"не подключено: {key or '(по умолчанию)'}; сохранённые: {known}. Сначала: zali_ctl.py pair '<строка>'")
    return url


class Client:
    def __init__(self, url: str):
        self.host, self.port, self.token = parse_url(url)

    def request(self, method: str, path: str, body: dict | None = None, timeout: float = 70.0):
        data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
        req = urllib.request.Request(f"http://{self.host}:{self.port}{path}", data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        if data is not None:
            req.add_header("Content-Type", "application/json")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as res:
                return res.headers.get("Content-Type", ""), res.read()
        except urllib.error.HTTPError as err:
            return err.headers.get("Content-Type", ""), err.read()
        except urllib.error.URLError as err:
            raise SystemExit(f"приложение не отвечает на {self.host}:{self.port} ({err.reason}). Оно запущено и управление включено?")

    def cmd(self, cmd: str, args: dict | None = None, timeout_ms: int = 60000) -> dict:
        _, raw = self.request("POST", "/cmd", {"cmd": cmd, "args": args or {}, "timeoutMs": timeout_ms}, timeout=timeout_ms / 1000 + 10)
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return {"ok": False, "error": raw.decode("utf-8", "replace")}


def out(value) -> int:
    print(json.dumps(value, ensure_ascii=False, indent=2))
    return 0 if not (isinstance(value, dict) and value.get("ok") is False) else 1


def conversation_args(ns) -> dict:
    if getattr(ns, "server", None):
        return {"server": ns.server, "channel": ns.channel}
    if getattr(ns, "chat", None):
        return {"chat": ns.chat}
    return {}


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="zali_ctl.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("-t", "--target", help="имя сохранённого приложения")
    p.add_argument("--timeout", type=int, default=60000, help="мс на команду (по умолчанию 60000)")
    sub = p.add_subparsers(dest="action", required=True)

    s = sub.add_parser("pair", help="сохранить строку подключения из настроек")
    s.add_argument("url")
    s.add_argument("--name", default="")
    sub.add_parser("targets", help="сохранённые приложения")
    sub.add_parser("ping")
    sub.add_parser("help", help="команды страницы")
    sub.add_parser("state")
    sub.add_parser("chats")
    sub.add_parser("devices")

    s = sub.add_parser("open")
    s.add_argument("chat", nargs="?")
    s.add_argument("--server")
    s.add_argument("--channel")

    s = sub.add_parser("messages")
    s.add_argument("chat", nargs="?")
    s.add_argument("--server")
    s.add_argument("--channel")
    s.add_argument("-n", type=int, default=20)

    s = sub.add_parser("send")
    s.add_argument("parts", nargs="+", help="[собеседник] текст")
    s.add_argument("--server")
    s.add_argument("--channel")

    s = sub.add_parser("view")
    s.add_argument("name", choices=["chat", "settings", "hub", "coin"])

    s = sub.add_parser("contact")
    s.add_argument("user")

    s = sub.add_parser("voice")
    s.add_argument("op", choices=["join", "leave", "mute", "unmute", "deafen", "undeafen", "camera", "state"])
    s.add_argument("rest", nargs="*", help="join: <сервер> <канал>; camera: on|off [устройство]")

    s = sub.add_parser("call")
    s.add_argument("user")
    s.add_argument("--video", action="store_true")
    s = sub.add_parser("accept")
    s.add_argument("--video", action="store_true")
    sub.add_parser("reject")

    s = sub.add_parser("screen")
    s.add_argument("op", choices=["sources", "start", "stop"])
    s.add_argument("source", nargs="?", help="номер, id или часть названия")
    s.add_argument("--window", action="store_true", help="искать среди окон")
    s.add_argument("--display", action="store_true", help="искать среди экранов")
    s.add_argument("--no-audio", action="store_true")
    s.add_argument("--fps", type=int, default=30)
    s.add_argument("--height", type=int, default=1080, help="0 — исходное")
    s.add_argument("--thumbs", help="sources: сохранить превью в эту папку")

    s = sub.add_parser("logs")
    s.add_argument("-n", type=int, default=60)
    s.add_argument("--journal", action="store_true")

    s = sub.add_parser("eval")
    s.add_argument("code")
    s = sub.add_parser("wait")
    s.add_argument("code")
    s.add_argument("--for", dest="wait_ms", type=int, default=10000, help="мс ожидания")

    s = sub.add_parser("api")
    s.add_argument("method")
    s.add_argument("path")
    s.add_argument("body", nargs="?")

    s = sub.add_parser("raw", help="любая команда страницы: raw <cmd> ['{json}']")
    s.add_argument("cmd")
    s.add_argument("args", nargs="?", default="{}")

    s = sub.add_parser("snapshot", help="PNG окна (macOS)")
    s.add_argument("file", nargs="?", default="zali-snapshot.png")

    s = sub.add_parser("window")
    s.add_argument("op", choices=["show", "hide"])

    s = sub.add_parser("url", help="ссылка разработчика для браузера")
    s.add_argument("--base", default="http://127.0.0.1:8090/")
    s.add_argument("--as", dest="as_user")
    s.add_argument("--pw", help="пароль, если аккаунт заведён не ссылкой")
    s.add_argument("--api")
    s.add_argument("--contact")
    s.add_argument("--chat", help="личный чат")
    s.add_argument("--channel", help="<сервер>/<канал>")
    s.add_argument("--view")
    s.add_argument("--voice")
    s.add_argument("--run", help="JSON [[cmd, args], …]")
    return p


def main(argv: list[str]) -> int:
    ns = build_parser().parse_args(argv)
    a = ns.action

    if a == "pair":
        host, port, _ = parse_url(ns.url)
        _, raw = Client(ns.url).request("GET", "/ping", timeout=5)
        try:
            ping = json.loads(raw.decode("utf-8"))
        except ValueError:
            ping = {"ok": False, "error": raw.decode("utf-8", "replace")}
        if not ping.get("ok"):
            print(f"не сохранено: {ping.get('error') or ping}", file=sys.stderr)
            return 1
        cfg = load_config()
        name = ns.name or f"{ping.get('platform', host)}:{port}"
        cfg.setdefault("targets", {})[name] = ns.url.strip()
        cfg["default"] = name
        save_config(cfg)
        print(f"сохранено как «{name}»: {json.dumps(ping, ensure_ascii=False)}")
        return 0
    if a == "targets":
        cfg = load_config()
        return out({name: {"default": name == cfg.get("default"), "endpoint": url.split("@", 1)[-1]} for name, url in cfg.get("targets", {}).items()})
    if a == "url":
        params = {k: v for k, v in {"as": ns.as_user, "pw": ns.pw, "api": ns.api, "contact": ns.contact, "chat": ns.chat, "channel": ns.channel,
                                     "view": ns.view, "voice": ns.voice, "run": ns.run}.items() if v}
        print(ns.base + ("?" + urllib.parse.urlencode(params) if params else ""))
        return 0

    c = Client(target_url(ns.target))
    t = ns.timeout
    if a == "ping":
        return out(json.loads(c.request("GET", "/ping", timeout=5)[1]))
    if a == "snapshot":
        ctype, raw = c.request("GET", "/snapshot", timeout=15)
        if not ctype.startswith("image/"):
            return out(json.loads(raw))
        Path(ns.file).write_bytes(raw)
        print(os.path.abspath(ns.file))
        return 0
    if a == "window":
        return out(json.loads(c.request("POST", "/window", {"action": ns.op}, timeout=5)[1]))

    simple = {"help": "help", "state": "state", "chats": "chats", "devices": "devices", "reject": "voice.reject"}
    if a in simple:
        return out(c.cmd(simple[a], {}, t))
    if a == "open":
        return out(c.cmd("open", conversation_args(ns), t))
    if a == "messages":
        return out(c.cmd("messages", {**conversation_args(ns), "limit": ns.n}, t))
    if a == "send":
        parts = list(ns.parts)
        args = {}
        if ns.server:
            args = {"server": ns.server, "channel": ns.channel}
        elif len(parts) > 1:
            args = {"chat": parts.pop(0)}
        args["text"] = " ".join(parts)
        return out(c.cmd("send", args, t))
    if a == "view":
        return out(c.cmd("view", {"name": ns.name}, t))
    if a == "contact":
        return out(c.cmd("contact.add", {"user": ns.user}, t))
    if a == "voice":
        rest = ns.rest
        if ns.op == "join":
            if len(rest) < 2:
                raise SystemExit("voice join <сервер> <канал>")
            return out(c.cmd("voice.join", {"server": rest[0], "channel": " ".join(rest[1:])}, t))
        if ns.op in ("mute", "unmute"):
            return out(c.cmd("voice.mute", {"on": ns.op == "mute"}, t))
        if ns.op in ("deafen", "undeafen"):
            return out(c.cmd("voice.deafen", {"on": ns.op == "deafen"}, t))
        if ns.op == "camera":
            args = {"on": (rest[0] if rest else "on") != "off"}
            if len(rest) > 1:
                args["device"] = rest[1]
            return out(c.cmd("voice.camera", args, t))
        return out(c.cmd(f"voice.{ns.op}", {}, t))
    if a == "call":
        return out(c.cmd("voice.call", {"user": ns.user, "video": ns.video}, t))
    if a == "accept":
        return out(c.cmd("voice.accept", {"video": ns.video}, t))
    if a == "screen":
        if ns.op == "stop":
            return out(c.cmd("screen.stop", {}, t))
        kind = "window" if ns.window else "display" if ns.display else None
        if ns.op == "sources":
            res = c.cmd("screen.sources", {"thumbs": bool(ns.thumbs)}, t)
            if ns.thumbs and res.get("ok"):
                folder = Path(ns.thumbs)
                folder.mkdir(parents=True, exist_ok=True)
                for src in res["result"]:
                    thumb = src.pop("thumb", "")
                    if thumb.startswith("data:image/"):
                        ext = "png" if thumb.startswith("data:image/png") else "jpg"
                        path = folder / f"{src['index']:02d}-{src['kind']}.{ext}"
                        path.write_bytes(base64.b64decode(thumb.split(",", 1)[1]))
                        src["thumbFile"] = str(path.resolve())
            if kind and res.get("ok"):
                res["result"] = [s for s in res["result"] if s["kind"] == kind]
            return out(res)
        args = {"kind": kind, "fps": ns.fps, "height": ns.height, "audio": not ns.no_audio}
        if ns.source is not None:
            args["source"] = ns.source
        return out(c.cmd("screen.start", args, t))
    if a == "logs":
        res = c.cmd("logs", {"n": ns.n, "kind": "journal" if ns.journal else "voice"}, t)
        if res.get("ok"):
            print("\n".join(res["result"]))
            return 0
        return out(res)
    if a == "eval":
        return out(c.cmd("eval", {"code": ns.code}, t))
    if a == "wait":
        return out(c.cmd("wait", {"code": ns.code, "timeout": ns.wait_ms}, max(t, ns.wait_ms + 5000)))
    if a == "api":
        body = json.loads(ns.body) if ns.body else None
        return out(c.cmd("api", {"method": ns.method, "path": ns.path, "body": body}, t))
    if a == "raw":
        return out(c.cmd(ns.cmd, json.loads(ns.args), t))
    raise SystemExit(f"неизвестное действие {a}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
