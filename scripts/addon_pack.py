#!/usr/bin/env python3
"""Упаковщик аддона хаба: папка -> файл .zali с магиком ZALIEXTN.

    python3 scripts/addon_pack.py <папка> <файл.zali>
    python3 scripts/addon_pack.py --check <файл.zali>

Проверяет те же правила, что приложение при установке
(web/src/modules/addon_format.js — pathError и parseManifest): пути, размеры,
обязательные поля манифеста, разрешения, network и backend. Скрытые файлы
(.git, .DS_Store) не попадают в архив. Руководство автора — docs/ADDONS.md.
"""
import argparse
import hashlib
import json
import re
import struct
import sys
from pathlib import Path

MAGIC = b"ZALIEXTN"
FORMAT_VERSION = 1
MANIFEST_PATH = "manifest.json"
FILE_BYTES = 32 * 1024 * 1024
BACKGROUND_BYTES = 512 * 1024
ENTRIES = 2000
MANIFEST_BYTES = 64 * 1024
PATH_BYTES = 255
NETWORK_HOSTS = 16
BACKEND_ARGS = 32

ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{2,63}$")
SEGMENT_RE = re.compile(r"^[A-Za-z0-9._-]+$")
VERSION_RE = re.compile(r"^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$")
HOST_RE = re.compile(
    r"^(\*\.)?[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*(:\d{1,5})?$"
)
CONTROL_RE = re.compile(r"[\x00-\x09\x0b-\x1f\x7f]")

# Порядок — порядок каталога PERMISSIONS в addon_format.js.
PERMISSIONS = [
    "cache", "notifications", "clipboard", "files", "microphone", "network", "cloud", "coins",
    "network.any", "fs.read", "fs.write", "launch", "process",
]
ELEVATED = {"network.any", "fs.read", "fs.write", "launch", "process"}
BACKEND_PLATFORMS = ["macos-arm64", "macos-x64", "windows-x64", "windows-arm64"]
ICON_EXTS = {"png", "svg", "webp", "jpg", "jpeg"}


class AddonError(Exception):
    pass


def ext_of(path):
    name = path.rsplit("/", 1)[-1]
    dot = name.rfind(".")
    return name[dot + 1:].lower() if dot > 0 else ""


def path_error(path):
    if not path:
        return "пустой путь"
    if len(path.encode("utf-8")) > PATH_BYTES:
        return "путь длиннее 255 байт"
    if path.startswith("/") or path.endswith("/"):
        return "путь начинается или кончается «/»"
    for segment in path.split("/"):
        if not segment:
            return "пустой сегмент пути"
        if segment in (".", ".."):
            return "сегмент «.» или «..»"
        if not SEGMENT_RE.match(segment):
            return "недопустимые символы в пути"
    return ""


def text_field(data, field, max_len, required):
    value = data.get(field)
    if value is None:
        value = ""
    if not isinstance(value, str):
        raise AddonError(f"Манифест: «{field}» должно быть строкой.")
    value = value.strip()
    # Длина — в UTF-16, как String.length в приложении.
    if len(value.encode("utf-16-le")) // 2 > max_len:
        raise AddonError(f"Манифест: «{field}» длиннее {max_len} символов.")
    if CONTROL_RE.search(value):
        raise AddonError(f"Манифест: «{field}» содержит управляющие символы.")
    if required and not value:
        raise AddonError(f"Манифест: нет «{field}».")
    return value


def file_ref(value, field, files):
    if not isinstance(value, str):
        raise AddonError(f"Манифест: «{field}» должно быть путём к файлу.")
    problem = path_error(value)
    if problem:
        raise AddonError(f"Манифест: «{field}»: {problem}.")
    if value not in files:
        raise AddonError(f"Манифест: «{field}» ссылается на «{value}», а его нет в папке.")
    return value


def check_manifest(files):
    raw = files.get(MANIFEST_PATH)
    if raw is None:
        raise AddonError("Нет manifest.json.")
    if len(raw) > MANIFEST_BYTES:
        raise AddonError("manifest.json больше 64 КБ.")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as e:
        raise AddonError(f"manifest.json — не JSON: {e}")
    if not isinstance(data, dict):
        raise AddonError("manifest.json должен быть объектом.")
    if data.get("zaliAddon") != 1 or isinstance(data.get("zaliAddon"), bool):
        raise AddonError('Манифест: нужно "zaliAddon": 1.')

    addon_id = text_field(data, "id", 64, True)
    if not ID_RE.match(addon_id) or ".." in addon_id:
        raise AddonError("Манифест: id — от 3 до 64 символов a-z, 0-9, «.», «_», «-», начинается с буквы или цифры.")
    text_field(data, "name", 64, True)
    version = text_field(data, "version", 32, True)
    if not VERSION_RE.match(version):
        raise AddonError("Манифест: version — например 1.0.0.")
    text_field(data, "description", 300, False)
    text_field(data, "author", 80, False)

    entry = file_ref(data.get("entry", "index.html"), "entry", files)
    if ext_of(entry) not in ("html", "htm"):
        raise AddonError("Манифест: entry должен быть .html.")
    if data.get("icon") not in (None, ""):
        icon = file_ref(data["icon"], "icon", files)
        if ext_of(icon) not in ICON_EXTS:
            raise AddonError("Манифест: icon — png, svg, webp или jpeg.")

    if data.get("background") not in (None, ""):
        background = file_ref(data["background"], "background", files)
        if ext_of(background) not in ICON_EXTS:
            raise AddonError("Манифест: background — png, svg, webp или jpeg.")
        if len(files[background]) > BACKGROUND_BYTES:
            raise AddonError("Манифест: background больше 512 КБ.")

    permissions = data.get("permissions") or []
    if not isinstance(permissions, list):
        raise AddonError("Манифест: permissions должен быть списком.")
    for item in permissions:
        if str(item) not in PERMISSIONS:
            raise AddonError(f"Манифест: неизвестное разрешение «{item}».")
    permissions = set(map(str, permissions))

    network = data.get("network")
    hosts = []
    if network is not None:
        if not isinstance(network, list):
            raise AddonError("Манифест: network должен быть списком хостов.")
        for item in network:
            host = str(item or "").strip().lower()
            if not HOST_RE.match(host):
                raise AddonError(f"Манифест: «{host}» — не имя хоста (без схемы и пути).")
            if host not in hosts:
                hosts.append(host)
        if len(hosts) > NETWORK_HOSTS:
            raise AddonError(f"Манифест: в network больше {NETWORK_HOSTS} хостов.")
    if hosts and "network" not in permissions:
        raise AddonError("Манифест: network указан без разрешения «network».")
    if "network" in permissions and not hosts:
        raise AddonError("Манифест: разрешение «network» без списка хостов в network.")

    backend = data.get("backend")
    if backend is not None:
        if not isinstance(backend, dict):
            raise AddonError("Манифест: backend должен быть объектом.")
        if backend.get("type") != "process":
            raise AddonError('Манифест: backend.type — только "process".')
        if "process" not in permissions:
            raise AddonError("Манифест: backend без разрешения «process».")
        commands = backend.get("commands")
        if not isinstance(commands, dict) or not commands:
            raise AddonError("Манифест: backend.commands — непустой объект «платформа → путь».")
        for platform, path in commands.items():
            if platform not in BACKEND_PLATFORMS:
                raise AddonError(f"Манифест: платформа «{platform}» в backend.commands не поддерживается.")
            file_ref(path, f"backend.commands.{platform}", files)
        args = backend.get("args", [])
        if not isinstance(args, list) or len(args) > BACKEND_ARGS:
            raise AddonError(f"Манифест: backend.args — список до {BACKEND_ARGS} строк.")
        for i, arg in enumerate(args):
            if not isinstance(arg, str) or len(arg) > 256 or "\x00" in arg:
                raise AddonError(f"Манифест: backend.args[{i}] — строка до 256 символов.")
    if "process" in permissions and backend is None:
        raise AddonError("Манифест: разрешение «process» без backend.")
    return data


def collect(folder):
    root = Path(folder)
    if not root.is_dir():
        raise AddonError(f"«{folder}» — не папка.")
    files = {}
    seen = set()
    for path in sorted(root.rglob("*")):
        rel = path.relative_to(root).as_posix()
        if any(part.startswith(".") for part in rel.split("/")):
            continue
        if path.is_symlink():
            raise AddonError(f"«{rel}» — символическая ссылка; положите сам файл.")
        if not path.is_file():
            continue
        problem = path_error(rel)
        if problem:
            raise AddonError(f"Файл «{rel}»: {problem}.")
        folded = rel.lower()
        if folded in seen:
            raise AddonError(f"Файлы «{rel}» и другой отличаются только регистром.")
        seen.add(folded)
        files[rel] = path.read_bytes()
    if len(files) > ENTRIES:
        raise AddonError(f"Больше {ENTRIES} файлов.")
    return files


def build(files, addon_id):
    out = bytearray(MAGIC)
    out.append(FORMAT_VERSION)
    for value in (addon_id.encode("utf-8")[:255], b"addon"):
        out.append(len(value))
        out += value
    out.append(0)
    out += struct.pack("<I", len(files))
    # manifest.json первым — приложению всё равно, но так файл удобнее смотреть.
    for name in sorted(files, key=lambda n: (n != MANIFEST_PATH, n)):
        encoded = name.encode("utf-8")
        data = files[name]
        out += struct.pack("<H", len(encoded)) + encoded
        out += struct.pack("<QQ", len(data), len(data)) + data
    if len(out) > FILE_BYTES:
        raise AddonError(f"Файл аддона {len(out)} байт — больше 32 МБ.")
    return bytes(out)


def parse(blob):
    """Разбор контейнера — для --check и самопроверки после сборки."""
    if len(blob) > FILE_BYTES:
        raise AddonError("Файл больше 32 МБ.")
    if blob[:8] != MAGIC:
        raise AddonError("Это не файл аддона (нет ZALIEXTN).")
    pos = 8

    def take(n):
        nonlocal pos
        if pos + n > len(blob):
            raise AddonError("Файл обрезан.")
        chunk = blob[pos:pos + n]
        pos += n
        return chunk

    if take(1)[0] != FORMAT_VERSION:
        raise AddonError("Версия формата не 1.")
    take(take(1)[0])
    take(take(1)[0])
    if take(1)[0] != 0:
        raise AddonError("flags ≠ 0: аддон нельзя шифровать.")
    (count,) = struct.unpack("<I", take(4))
    if count > ENTRIES:
        raise AddonError(f"Больше {ENTRIES} записей.")
    files = {}
    seen = set()
    for _ in range(count):
        (name_len,) = struct.unpack("<H", take(2))
        name = take(name_len).decode("utf-8")
        problem = path_error(name)
        if problem:
            raise AddonError(f"Файл «{name}»: {problem}.")
        if name.lower() in seen:
            raise AddonError(f"Файл «{name}» встречается дважды.")
        seen.add(name.lower())
        size, stored = struct.unpack("<QQ", take(16))
        if size != stored:
            raise AddonError(f"Файл «{name}»: размеры не сходятся.")
        files[name] = take(size)
    if pos != len(blob):
        raise AddonError("После последнего файла лишние данные.")
    return files


def describe(blob, manifest):
    permissions = manifest.get("permissions") or []
    elevated = [p for p in permissions if p in ELEVATED]
    normal = [p for p in permissions if p not in ELEVATED]
    print(f"{manifest['name']} {manifest['version']} ({manifest['id']})")
    print(f"  размер {len(blob)} байт, sha256 {hashlib.sha256(blob).hexdigest()}")
    print(f"  разрешения: {', '.join(normal) or '—'}")
    if elevated:
        print(f"  повышенные: {', '.join(elevated)}")


def main():
    parser = argparse.ArgumentParser(description="Упаковать папку аддона в .zali (ZALIEXTN).")
    parser.add_argument("--check", action="store_true", help="только проверить готовый .zali")
    parser.add_argument("source", help="папка аддона (или .zali с --check)")
    parser.add_argument("output", nargs="?", help="куда записать .zali")
    args = parser.parse_args()
    try:
        if args.check:
            blob = Path(args.source).read_bytes()
            manifest = check_manifest(parse(blob))
        else:
            if not args.output:
                parser.error("нужен путь к .zali")
            files = collect(args.source)
            manifest = check_manifest(files)
            blob = build(files, manifest["id"])
            if parse(blob) != files:
                raise AddonError("Самопроверка не сошлась — это ошибка упаковщика.")
            Path(args.output).write_bytes(blob)
        describe(blob, manifest)
    except AddonError as e:
        print(f"Ошибка: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
