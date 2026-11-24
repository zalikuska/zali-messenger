// SFU e2e (2026-11-22): два headless Chrome for Testing из кеша Playwright с фейковой камерой
// против локального сервера (.claude/launch.json → zali-server-sfu) и web-static :8090.
// Запуск: в каталоге со скриптом `npm i --no-save playwright-core` (ESM не читает NODE_PATH), затем node call.mjs [hi: W H FPS]
// Аккаунты sfu1/sfu2 создаются dev-ссылкой; первый прогон может упасть на not_a_contact — повторить.
import { chromium } from 'playwright-core';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream','--autoplay-policy=no-user-gesture-required'] });
async function open(me, peer) {
  const ctx = await browser.newContext({ permissions: ['camera','microphone'] });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type()==='error' && !t.includes('404')) console.log(`[${me} console]`, t.slice(0,300)); });
  await page.goto(`http://127.0.0.1:8090/?as=${me}&contact=${peer}&chat=${peer}`);
  await page.waitForFunction(() => typeof window.__zaliControl === 'function', null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  return page;
}
const ctl = (p, cmd, args={}) => p.evaluate(([c,a]) => window.__zaliControl(c, a), [cmd, args]);
const ev = (p, code) => ctl(p, 'eval', { code });
const A = await open('sfu1','sfu2'); const B = await open('sfu2','sfu1');
console.log('call', JSON.stringify(await ctl(A, 'voice.call', { user: 'sfu2' })).slice(0,200));
await B.waitForTimeout(2500);
console.log('accept', JSON.stringify(await ctl(B, 'voice.accept', {})).slice(0,200));
console.log('waitConnected', JSON.stringify(await ctl(A, 'wait', { code: "this.voice.status === 'connected' && this.voice.videoTransport === 'sfu'", timeout: 15000 })).slice(0,200));
console.log('transport A/B', JSON.stringify(await ev(A,'return this.voice.videoTransport')), JSON.stringify(await ev(B,'return this.voice.videoTransport')));
console.log('camA', JSON.stringify(await ctl(A, 'voice.camera', { on: true })).slice(0,200));
console.log('camB', JSON.stringify(await ctl(B, 'voice.camera', { on: true })).slice(0,200));
const probe = `
  const sfu = this.voice.sfu; const out = { transport: this.voice.videoTransport, pubState: sfu?.pub?.pc?.connectionState, subState: sfu?.sub?.pc?.connectionState, outbound: [], inbound: [], remoteVideos: [...this.voice.remoteVideos.keys()], remoteScreens: [...this.voice.remoteScreens.keys()], meshVideoSenders: [...this.voice.peerConnections.values()].filter(e => e.videoSender || e.screenSender).length };
  if (sfu?.pub?.pc) (await sfu.pub.pc.getStats()).forEach(r => { if (r.type==='candidate-pair' && r.state==='succeeded') out.pubAvail = Math.round((r.availableOutgoingBitrate||0)/1000); if (r.type==='outbound-rtp' && r.kind==='video') out.outbound.push({rid:r.rid, w:r.frameWidth, h:r.frameHeight, fps:r.framesPerSecond, kB:Math.round(r.bytesSent/1024), lim:r.qualityLimitationReason, tgt:Math.round((r.targetBitrate||0)/1000), mid:r.mid}); if (r.type==='candidate-pair' && r.nominated) out.availOut = Math.round((r.availableOutgoingBitrate||0)/1000); });
  if (sfu?.sub?.pc) (await sfu.sub.pc.getStats()).forEach(r => { if (r.type==='inbound-rtp') { const i = sfu.sub.tracks.get(String(r.mid)) || {}; out.inbound.push({kind:r.kind, from:i.user, src:i.source, w:r.frameWidth, h:r.frameHeight, fps:r.framesPerSecond, decoded:r.framesDecoded, kB:Math.round(r.bytesReceived/1024), lost:r.packetsLost, frz:r.freezeCount, codec:r.codecId}); } });
  for (const [u,v] of this.voice.remoteVideos) out['video:'+u] = { w: v.videoWidth, h: v.videoHeight, sfu: !!v.srcObject?.__zaliSfu };
  for (const [u,v] of this.voice.remoteScreens) out['screen:'+u] = { w: v.videoWidth, h: v.videoHeight, sfu: !!v.srcObject?.__zaliSfu, tracks: v.srcObject?.getTracks().map(t=>t.kind) };
  return out;`;
await A.waitForTimeout(12000);
console.log('A after cams', JSON.stringify(await ev(A, probe), null, 0));
console.log('B after cams', JSON.stringify(await ev(B, probe), null, 0));
// screen share on A via canvas stub
await ev(A, `
  const c = document.createElement('canvas'); c.width = 1920; c.height = 1080; const g = c.getContext('2d'); let n = 0;
  setInterval(() => { n++; g.fillStyle = 'hsl(' + (n*3%360) + ',60%,40%)'; g.fillRect(0,0,1920,1080); g.fillStyle='#fff'; g.font='120px sans-serif'; g.fillText('frame ' + n, 100 + (n*7)%1200, 500); for (let i=0;i<40;i++){ g.fillRect((i*97+n*5)%1920, (i*53)%1080, 30, 30);} }, 33);
  const ac = new AudioContext(); const osc = ac.createOscillator(); const dst = ac.createMediaStreamDestination(); osc.connect(dst); osc.start();
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream([c.captureStream(30).getVideoTracks()[0], dst.stream.getAudioTracks()[0]]);
  await this.startScreenShare({ surface: 'monitor', height: 1080, fps: 30, audio: true });
  return this.voice.screenSharing;`);
await A.waitForTimeout(30000);
console.log('A after screen', JSON.stringify(await ev(A, probe), null, 0));
console.log('B after screen', JSON.stringify(await ev(B, probe), null, 0));
// camera off on A and stop screen
await ctl(A, 'voice.camera', { on: false });
await A.waitForTimeout(5000);
console.log('B after A cam off', JSON.stringify(await ev(B, probe), null, 0));
await ev(A, 'this.stopScreenShare(); return true');
await A.waitForTimeout(5000);
console.log('B after A screen off', JSON.stringify(await ev(B, probe), null, 0));
const logs = await ctl(B, 'logs', { n: 300, kind: 'voice' });
console.log('B sfu logs', JSON.stringify(logs).match(/[^"]*sfu[^"]*/g)?.slice(-30).join('\n'));
console.log('A sfu log', JSON.stringify(await ev(A, "return (this.voice.traceLines||[]).filter(l => /sfu|video-transport/.test(JSON.stringify(l))).slice(-25)")).slice(0,3000));
await browser.close();
