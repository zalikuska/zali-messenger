# Server Restart

Use this when the code is already built and you only need to restart `zali_server`.

## Restart Server

```bash
ssh zms 'pkill -x zali_server || true; sleep 1; cd /opt/zali-server; set -a; source /etc/zali/zali-server.env; set +a; nohup ./target/release/zali_server >/root/zali-server.log 2>&1 & echo $! >/root/zali-server.pid; sleep 2; curl -s http://127.0.0.1:3000/health; echo; pidof zali_server; readlink -f /proc/$(pidof zali_server)/exe'
```

Expected output includes:

```text
{"status":"ok","version":"0.1.0"}
/opt/zali-server/target/release/zali_server
```

## If Port 3000 Is Busy

```bash
ssh zms 'ss -ltnp | grep :3000 || true; ps -ef | grep zali_server | grep -v grep || true'
```

Then restart again with the command above.

## Read Last Logs

```bash
ssh zms 'tail -n 120 /root/zali-server.log'
```
