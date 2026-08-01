#!/usr/bin/env python3
"""Minimal TURN (RFC 5766) client: Allocate -> CreatePermission -> Send/Data loopback.

Verifies not just that the TURN server answers, but that bytes actually traverse
the relay -- which is what a WebRTC call depends on when both peers are NAT'd.
"""
import hashlib
import hmac
import os
import socket
import struct
import sys

HOST = sys.argv[1] if len(sys.argv) > 1 else "msgs.zalikus.org"
PORT = int(sys.argv[2] if len(sys.argv) > 2 else 3478)
USER = sys.argv[3] if len(sys.argv) > 3 else "zali"
PASS = sys.argv[4] if len(sys.argv) > 4 else "turnpass"

MAGIC = 0x2112A442
MAGIC_B = struct.pack("!I", MAGIC)

BIND_REQ = 0x0001
ALLOC_REQ = 0x0003
PERM_REQ = 0x0008
SEND_IND = 0x0016
DATA_IND = 0x0017

A_MAPPED = 0x0001
A_USERNAME = 0x0006
A_MSG_INTEGRITY = 0x0008
A_ERROR = 0x0009
A_REALM = 0x0014
A_NONCE = 0x0015
A_XOR_PEER = 0x0012
A_DATA = 0x0013
A_XOR_RELAYED = 0x0016
A_LIFETIME = 0x000D
A_REQ_TRANSPORT = 0x0019
A_XOR_MAPPED = 0x0020


def pad4(b):
    return b + b"\x00" * ((4 - len(b) % 4) % 4)


def attrs(pairs):
    out = b""
    for t, v in pairs:
        out += struct.pack("!HH", t, len(v)) + pad4(v)
    return out


def msg(mtype, tid, pairs, key=None):
    body = attrs(pairs)
    if key is not None:
        head = struct.pack("!HH", mtype, len(body) + 24) + MAGIC_B + tid
        mac = hmac.new(key, head + body, hashlib.sha1).digest()
        body += struct.pack("!HH", A_MSG_INTEGRITY, 20) + mac
    return struct.pack("!HH", mtype, len(body)) + MAGIC_B + tid + body


def parse(data):
    mtype, mlen = struct.unpack("!HH", data[:4])
    tid = data[8:20]
    i, end, out = 20, 20 + mlen, {}
    while i + 4 <= end:
        t, l = struct.unpack("!HH", data[i:i + 4])
        v = data[i + 4:i + 4 + l]
        out.setdefault(t, v)
        i += 4 + l + ((4 - l % 4) % 4)
    return mtype, tid, out


def xor_addr(v):
    fam = v[1]
    port = struct.unpack("!H", v[2:4])[0] ^ (MAGIC >> 16)
    if fam == 1:
        ip = bytes(a ^ b for a, b in zip(v[4:8], MAGIC_B))
        return socket.inet_ntoa(ip), port
    return "?", port


def xor_peer_attr(ip, port):
    return b"\x00\x01" + struct.pack("!H", port ^ (MAGIC >> 16)) + bytes(
        a ^ b for a, b in zip(socket.inet_aton(ip), MAGIC_B))


def long_term_key(user, realm, password):
    return hashlib.md5(f"{user}:{realm}:{password}".encode()).digest()


addr = (socket.gethostbyname(HOST), PORT)
print(f"TURN target {HOST} -> {addr[0]}:{addr[1]}  user={USER}")

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.settimeout(5)

# 1) plain STUN Binding, to see our own reflexive address and prove UDP reaches the box
tid = os.urandom(12)
s.sendto(msg(BIND_REQ, tid, []), addr)
try:
    data, _ = s.recvfrom(2048)
    _, _, a = parse(data)
    srflx = xor_addr(a[A_XOR_MAPPED]) if A_XOR_MAPPED in a else None
    print(f"[1] STUN Binding OK  srflx={srflx}")
except socket.timeout:
    print("[1] STUN Binding: TIMEOUT (UDP 3478 unreachable)")
    sys.exit(1)

# 2) unauthenticated Allocate -> expect 401 with realm+nonce
tid = os.urandom(12)
s.sendto(msg(ALLOC_REQ, tid, [(A_REQ_TRANSPORT, b"\x11\x00\x00\x00")]), addr)
data, _ = s.recvfrom(2048)
mt, _, a = parse(data)
realm = a.get(A_REALM, b"").decode()
nonce = a.get(A_NONCE, b"")
err = struct.unpack("!HH", a[A_ERROR][:4])[1] if A_ERROR in a else None
code = (a[A_ERROR][2] * 100 + a[A_ERROR][3]) if A_ERROR in a else None
print(f"[2] Allocate(unauth) -> type=0x{mt:04x} err={code} realm={realm!r} nonce={len(nonce)}B")

# 3) authenticated Allocate
key = long_term_key(USER, realm, PASS)
tid = os.urandom(12)
pairs = [
    (A_REQ_TRANSPORT, b"\x11\x00\x00\x00"),
    (A_USERNAME, USER.encode()),
    (A_REALM, realm.encode()),
    (A_NONCE, nonce),
]
s.sendto(msg(ALLOC_REQ, tid, pairs, key), addr)
data, _ = s.recvfrom(2048)
mt, _, a = parse(data)
if mt != 0x0103:
    code = (a[A_ERROR][2] * 100 + a[A_ERROR][3]) if A_ERROR in a else "?"
    print(f"[3] Allocate(auth) FAILED type=0x{mt:04x} err={code}")
    sys.exit(2)
relayed = xor_addr(a[A_XOR_RELAYED])
mapped = xor_addr(a[A_XOR_MAPPED]) if A_XOR_MAPPED in a else None
lifetime = struct.unpack("!I", a[A_LIFETIME])[0] if A_LIFETIME in a else "?"
print(f"[3] Allocate(auth) OK relayed={relayed} mapped={mapped} lifetime={lifetime}")

# 4) second socket plays "the remote peer": permission for its address, then
#    peer -> relay -> us, which is exactly the path a relayed call uses.
peer = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
peer.settimeout(5)
peer.bind(("0.0.0.0", 0))
tidb = os.urandom(12)
peer.sendto(msg(BIND_REQ, tidb, []), addr)
pdata, _ = peer.recvfrom(2048)
_, _, pa = parse(pdata)
peer_srflx = xor_addr(pa[A_XOR_MAPPED])
print(f"[4] peer socket srflx={peer_srflx}")

tid = os.urandom(12)
pairs = [
    (A_XOR_PEER, xor_peer_attr(*peer_srflx)),
    (A_USERNAME, USER.encode()),
    (A_REALM, realm.encode()),
    (A_NONCE, nonce),
]
s.sendto(msg(PERM_REQ, tid, pairs, key), addr)
data, _ = s.recvfrom(2048)
mt, _, a = parse(data)
print(f"[5] CreatePermission -> type=0x{mt:04x}" + ("  OK" if mt == 0x0108 else "  FAILED"))

payload = b"ZALI-RELAY-PROBE"
peer.sendto(payload, relayed)
try:
    data, src = s.recvfrom(2048)
    mt, _, a = parse(data)
    got = a.get(A_DATA, b"")
    if mt == DATA_IND and got == payload:
        print(f"[6] RELAY DATA OK: {len(got)}B travelled peer -> {relayed} -> client")
    else:
        print(f"[6] unexpected message type=0x{mt:04x} data={got!r}")
except socket.timeout:
    print(f"[6] RELAY DATA TIMEOUT: nothing came back through {relayed} "
          "-> relayed media would be silent")
