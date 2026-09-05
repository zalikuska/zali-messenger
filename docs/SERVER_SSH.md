# Server SSH

Use these commands from the Mac terminal.

## Connect

```bash
ssh ms
```

If the `zms` alias is not available:

```bash
ssh root@cv7440387
```

## Check Server Status

```bash
ssh ms 'echo HEALTH:; curl -s http://127.0.0.1:3001/health; echo; echo PROCESS:; pidof zali_server || true; echo EXE:; pid=$(pidof zali_server || true); if [ -n "$pid" ]; then readlink -f /proc/$pid/exe; fi; echo LOG:; tail -n 40 /root/zali-server.log'
```

## Watch Realtime Logs

```bash
ssh ms 'tail -f /root/zali-server.log | grep --line-buffered -E "WS upgrade accepted username=(zalikus|pivovarca)|\\[WS\\] '\''(zalikus|pivovarca)'\'' подключился|WS deliver_to_user start username=(zalikus|pivovarca)|WS deliver_to_user done username=(zalikus|pivovarca)|reason=no_connections|UPLOAD complete|UPLOAD failed|HTTP 403"'
```

## Check Current Server Git Commit

```bash
ssh ms 'cd /opt/zali-server && git rev-parse --short HEAD && git status --short --branch'
```
