# Server Update

Use this when server code was pushed to GitHub and the VPS must pull, build, and restart.

## Full HTTPS Update

```bash
ssh zms 'cd /opt/zali-server && git remote set-url origin https://github.com/zalikuska/zali-messenger-server.git && git fetch origin && git checkout zali-server && git pull --ff-only origin zali-server && git rev-parse --short HEAD && cargo build --release && pkill -x zali_server || true; sleep 1; cd /opt/zali-server; set -a; source /etc/zali/zali-server.env; set +a; nohup ./target/release/zali_server >/root/zali-server.log 2>&1 & echo $! >/root/zali-server.pid; sleep 2; curl -s http://127.0.0.1:3000/health; echo; pidof zali_server; readlink -f /proc/$(pidof zali_server)/exe; tail -n 30 /root/zali-server.log'
```

Expected output includes:

```text
Already on 'zali-server'
Finished `release` profile
{"status":"ok","version":"0.1.0"}
/opt/zali-server/target/release/zali_server
```

## Build Only

```bash
ssh zms 'cd /opt/zali-server && cargo build --release && find /opt/zali-server -type f -name zali_server -perm -111 -ls'
```

## Verify Fresh Binary Is Running

```bash
ssh zms 'pid=$(pidof zali_server || true); echo PID:${pid:-none}; if [ -n "$pid" ]; then echo EXE:; readlink -f /proc/$pid/exe; echo CWD:; readlink -f /proc/$pid/cwd; echo CMDLINE:; tr "\0" " " < /proc/$pid/cmdline; echo; fi; echo HEAD:; cd /opt/zali-server && git rev-parse --short HEAD'
```
