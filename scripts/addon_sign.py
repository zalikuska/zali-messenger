#!/usr/bin/env python3
"""Подпись и проверка файлов аддонов (ZALIEXTN) — общая часть инструментов.

    python3 scripts/addon_sign.py verify <файл.zali> [--self-key BASE64]
    python3 scripts/addon_sign.py digest <файл.zali>
    python3 scripts/addon_sign.py sign <вход.zali> <выход.zali> --kind official \
        --key <приватный.pem> --owner <логин>

Зачем два вида подписи и почему здесь нет «своей» подписи — docs/ADDONS.md §10.
Кратко: «свободная» (`self`) подпись выдаётся ТОЛЬКО сервером — закрытый
инструмент на его стороне, доступный любому вошедшему пользователю (Хаб →
«Подпись аддонов»). Здесь она только проверяется. Подписать официально
(`official`) может лишь тот, у кого есть приватный ключ разработчиков
ZaliMessenger; обёртка с ключом лежит вне репозитория (`ops/tools/`).

Формат подписи и отпечатка — тот же, что в web/src/modules/addon_format.js и
server/src/addons.rs: менять только все три места сразу.
"""
import argparse
import base64
import hashlib
import json
import struct
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import addon_pack  # noqa: E402  (тот же разбор контейнера и манифеста)

SIGNATURE_PATH = "zali-signature.json"
SIGNATURE_VERSION = 1
OFFICIAL_PUBLIC_KEY = "BDUcWsKrt/KoOeUnExrEScgAqUD3JEPCDLS5OqWmER0pm+FXwhzClXxkEh0KG4WdLkm9czOJXgXSuMuYlOcrMWw="


def _crypto():
    try:
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.hazmat.primitives.asymmetric.utils import (
            decode_dss_signature,
            encode_dss_signature,
        )
        from cryptography.exceptions import InvalidSignature
    except ImportError:  # pragma: no cover
        raise addon_pack.AddonError("Нужен пакет cryptography: pip install cryptography")
    return hashes, serialization, ec, decode_dss_signature, encode_dss_signature, InvalidSignature


def content_digest(files):
    """SHA-256 содержимого без файла подписи (см. contentDigest в addon_format.js)."""
    h = hashlib.sha256()
    h.update(b"zali-addon-content:v1\n")
    for name in sorted(files, key=lambda n: n.encode("utf-8")):
        if name == SIGNATURE_PATH:
            continue
        encoded = name.encode("utf-8")
        data = files[name]
        h.update(struct.pack(">I", len(encoded)))
        h.update(encoded)
        h.update(struct.pack(">Q", len(data)))
        h.update(data)
    return h.hexdigest()


def signature_message(kind, addon_id, version, owner, digest, signed_at):
    return f"zali-addon-sig:v1\n{kind}\n{addon_id}\n{version}\n{owner}\n{digest}\n{signed_at}"


def key_fingerprint(public_key_b64):
    return hashlib.sha256(base64.b64decode(public_key_b64)).hexdigest()


def sign_message(private_pem, message):
    hashes, serialization, ec, decode_dss, _encode, _invalid = _crypto()
    key = serialization.load_pem_private_key(private_pem, password=None)
    der = key.sign(message.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss(der)
    return r.to_bytes(32, "big") + s.to_bytes(32, "big")


def public_key_b64(private_pem):
    _hashes, serialization, _ec, _d, _e, _i = _crypto()
    key = serialization.load_pem_private_key(private_pem, password=None)
    raw = key.public_key().public_bytes(
        serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint
    )
    return base64.b64encode(raw).decode()


def verify_message(public_b64, message, signature_b64):
    hashes, _s, ec, _d, encode_dss, InvalidSignature = _crypto()
    raw = base64.b64decode(signature_b64)
    if len(raw) != 64:
        return False
    try:
        key = ec.EllipticCurvePublicKey.from_encoded_point(ec.SECP256R1(), base64.b64decode(public_b64))
        der = encode_dss(int.from_bytes(raw[:32], "big"), int.from_bytes(raw[32:], "big"))
        key.verify(der, message.encode("utf-8"), ec.ECDSA(hashes.SHA256()))
        return True
    except (InvalidSignature, ValueError):
        return False


def sign_files(files, manifest, kind, private_pem, owner, signed_at=None):
    """Возвращает объект подписи для `files` (файл подписи в расчёт не входит)."""
    signed_at = int(signed_at if signed_at is not None else time.time() * 1000)
    digest = content_digest(files)
    message = signature_message(kind, manifest["id"], manifest["version"], owner, digest, signed_at)
    return {
        "zaliSignature": SIGNATURE_VERSION,
        "kind": kind,
        "alg": "ES256",
        "publicKey": public_key_b64(private_pem),
        "id": manifest["id"],
        "version": manifest["version"],
        "owner": owner,
        "digest": digest,
        "signedAt": signed_at,
        "signature": base64.b64encode(sign_message(private_pem, message)).decode(),
    }


def with_signature(files, manifest, signature):
    out = {name: data for name, data in files.items() if name != SIGNATURE_PATH}
    out[SIGNATURE_PATH] = json.dumps(signature, ensure_ascii=False).encode("utf-8")
    return addon_pack.build(out, manifest["id"])


def verify_files(files, manifest, self_key=None):
    """Возвращает (состояние, подробности) — как verifySignature в addon_format.js."""
    raw = files.get(SIGNATURE_PATH)
    if raw is None:
        return "none", {}
    try:
        sig = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return "invalid", {"reason": "zali-signature.json — не JSON"}
    if not isinstance(sig, dict):
        return "invalid", {"reason": "подпись должна быть объектом"}
    kind = sig.get("kind")
    if sig.get("zaliSignature") != SIGNATURE_VERSION or sig.get("alg") != "ES256" or kind not in ("self", "official"):
        return "invalid", {"reason": "неизвестный формат подписи"}
    if sig.get("id") != manifest["id"] or sig.get("version") != manifest["version"]:
        return "invalid", {"reason": "подпись выдана другому аддону или версии"}
    digest = content_digest(files)
    if sig.get("digest") != digest:
        return "invalid", {"reason": "файл изменён после подписания"}
    detail = {
        "kind": kind,
        "owner": sig.get("owner"),
        "fingerprint": key_fingerprint(sig["publicKey"]),
        "signedAt": sig.get("signedAt"),
    }
    if kind == "official":
        if sig.get("publicKey") != OFFICIAL_PUBLIC_KEY:
            return "invalid", {"reason": "подпись сделана не официальным ключом"}
    elif not self_key or sig.get("publicKey") != self_key:
        return "unverified", {**detail, "reason": "нужен ключ сервера (--self-key)"}
    message = signature_message(kind, sig["id"], sig["version"], sig["owner"], digest, sig["signedAt"])
    if not verify_message(sig["publicKey"], message, sig["signature"]):
        return "invalid", {"reason": "подпись не сходится"}
    return kind, detail


def main():
    parser = argparse.ArgumentParser(description="Подпись и проверка аддонов (ZALIEXTN).")
    sub = parser.add_subparsers(dest="command", required=True)
    v = sub.add_parser("verify", help="проверить подпись файла")
    v.add_argument("file")
    v.add_argument("--self-key", help="публичный ключ «свободной» подписи сервера (base64)")
    d = sub.add_parser("digest", help="отпечаток содержимого (без подписи)")
    d.add_argument("file")
    s = sub.add_parser("sign", help="подписать приватным ключом (официальная подпись)")
    s.add_argument("input")
    s.add_argument("output")
    s.add_argument("--kind", choices=["official"], default="official")
    s.add_argument("--key", required=True, help="приватный ключ PKCS#8 PEM")
    s.add_argument("--owner", required=True, help="логин аккаунта, за которым закрепляется аддон")
    args = parser.parse_args()
    try:
        if args.command == "sign":
            files = addon_pack.parse(Path(args.input).read_bytes())
            manifest = addon_pack.check_manifest(files)
            pem = Path(args.key).read_bytes()
            if public_key_b64(pem) != OFFICIAL_PUBLIC_KEY:
                raise addon_pack.AddonError(
                    "Этот ключ не совпадает с официальным публичным ключом в приложении — "
                    "такая подпись не будет принята."
                )
            signature = sign_files(files, manifest, args.kind, pem, args.owner)
            Path(args.output).write_bytes(with_signature(files, manifest, signature))
            print(f"Подписано: {manifest['id']} {manifest['version']} → владелец @{args.owner}")
            print(f"  отпечаток содержимого {signature['digest']}")
            return 0
        files = addon_pack.parse(Path(args.file).read_bytes())
        if args.command == "digest":
            print(content_digest(files))
            return 0
        manifest = addon_pack.check_manifest(files)
        state, detail = verify_files(files, manifest, args.self_key)
        print(f"{manifest['id']} {manifest['version']}: подпись — {state}")
        for key, value in detail.items():
            print(f"  {key}: {value}")
        return 0 if state in ("official", "self") else 1
    except addon_pack.AddonError as e:
        print(f"Ошибка: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
