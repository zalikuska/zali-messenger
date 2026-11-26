// SFU e2e на N участников (по умолчанию 4): канал сервера, один показывает экран (canvas),
// остальные видят заглушку «Смотреть», жмут её и должны получить кадры.
// Сервер: launch-конфиг zali-server-sfu-rig (release, :3001, SFU UDP 3480) + web-static :8090.
// Запуск: node four.mjs [N]   (в каталоге скрипта: npm i --no-save playwright-core)
import { chromium, webkit } from 'playwright-core';
const N = Number(process.argv[2] || 4);
const API = 'http://127.0.0.1:3001';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const LATE = process.env.LATE === '1';
const OLD = process.env.OLD === '1';
const run = Date.now().toString(36).slice(-4);
const names = Array.from({ length: N }, (_, i) => `r${run}u${i + 1}`);
const wk = process.env.WK === '1' ? await webkit.launch({ headless: true }) : null;
async function open(me, engine = browser) {
  const ctx = await engine.newContext(engine === browser ? { permissions: ['camera', 'microphone'] } : {});
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !t.includes('404')) console.log(`[${me} console]`, t.slice(0, 300)); });
  await page.goto(`http://127.0.0.1:8090/?as=${me}&api=${encodeURIComponent(API)}`);
  await page.waitForFunction(() => typeof window.__zaliControl === 'function', null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  return page;
}
const ctl = (p, cmd, args = {}) => p.evaluate(([c, a]) => window.__zaliControl(c, a), [cmd, args]);
const ev = (p, code) => ctl(p, 'eval', { code });
const pages = [];
for (const [i, n] of names.entries()) pages.push(await open(n, wk && i >= N - 2 ? wk : browser));
const [host, ...guests] = pages;

const created = await ctl(host, 'server.create', { name: 'Rig' + run });
const srv = created?.result;
console.log('server id', srv?.id);
await host.waitForTimeout(1000);
console.log('channel', JSON.stringify(await ctl(host, 'channel.create', { server: 'Rig' + run, name: 'V', kind: 'voice' })).slice(0, 120));
const inv = await ctl(host, 'api', { method: 'POST', path: `/api/servers/${srv.id}/invites`, body: {} });
const code = inv?.result?.body?.code || inv?.result?.code || inv?.body?.code || inv?.data?.code || inv?.code;
console.log('invite', JSON.stringify(inv).slice(0, 200));
for (const g of guests) console.log('join', JSON.stringify(await ctl(g, 'api', { method: 'POST', path: `/api/invites/${code}/join`, body: { code } })).slice(0, 120));
await host.waitForTimeout(1500);
for (const p of pages) { try { await p.reload(); await p.waitForFunction(() => typeof window.__zaliControl === 'function', null, { timeout: 30000 }); await p.waitForTimeout(2500); } catch (e) { console.log('reload fail', e.message); } }

if (OLD) await pages[N - 1].evaluate(() => localStorage.setItem('zali_voice_sfu_off', '1'));
const early = LATE ? pages.slice(0, N - 1) : pages;
for (const p of early) console.log('voice.join', JSON.stringify(await ctl(p, 'voice.join', { server: 'Rig' + run, channel: 'V' })).slice(0, 160));
console.log('waitConnected', JSON.stringify(await ctl(host, 'wait', { code: `this.voice.status === 'connected' && this.voice.participants.length >= ${LATE ? N - 1 : N}`+(OLD ? '' : ` && this.voice.videoTransport === 'sfu'`)+``, timeout: 30000 })).slice(0, 200));
await host.waitForTimeout(4000);
if (process.env.RESTART === '1') {
  const fs = await import('node:fs');
  try { fs.unlinkSync('/tmp/rig-restarted'); } catch {}
  console.log('RESTART_NOW');
  while (!fs.existsSync('/tmp/rig-restarted')) await host.waitForTimeout(500);
  await host.waitForTimeout(30000);
  console.log('post-restart', JSON.stringify(await ev(host, 'return {st:this.voice.status, parts:this.voice.participants, tr:this.voice.videoTransport, joined:this.voice.sfu?.joined}')));
}
const brief = `return { st: this.voice.status, transport: this.voice.videoTransport, parts: this.voice.participants, sfuSub: this.voice.sfu?.sub?.pc?.connectionState, sfuPub: this.voice.sfu?.pub?.pc?.connectionState, states: Object.fromEntries(Object.entries(this.voice.memberStates||{}).map(([k,v])=>[k,{screen:!!v.screen,camera:!!v.camera}])), remoteScreens:[...this.voice.remoteScreens.keys()], tiles: document.querySelectorAll('#voiceStage .voice-stage-tile').length, placeholders: document.querySelectorAll('#voiceStage .voice-stage-tile.is-placeholder').length, gated: document.querySelectorAll('#voiceStage .voice-stage-tile.is-gated').length, capable: this.voice.sfuCapable };`;
for (const [i, p] of pages.entries()) console.log(`P${i + 1} before`, JSON.stringify(await ev(p, brief)));

if (process.env.CAMS === '1') { for (const p of pages) await ctl(p, 'voice.camera', { on: true }); await host.waitForTimeout(8000); }
await ev(host, `
  const c = document.createElement('canvas'); c.width = 1280; c.height = 720; const g = c.getContext('2d'); let n = 0;
  setInterval(() => { n++; g.fillStyle = 'hsl(' + (n*3%360) + ',60%,40%)'; g.fillRect(0,0,1280,720); g.fillStyle='#fff'; g.font='90px sans-serif'; g.fillText('frame ' + n, 100 + (n*7)%800, 360); }, 33);
  navigator.mediaDevices.getDisplayMedia = async () => new MediaStream([c.captureStream(30).getVideoTracks()[0]]);
  await this.startScreenShare({ surface: 'monitor', height: 720, fps: 30, audio: false });
  return this.voice.screenSharing;`);
await host.waitForTimeout(6000);
if (LATE) { const p = pages[N - 1]; console.log('late voice.join', JSON.stringify(await ctl(p, 'voice.join', { server: 'Rig' + run, channel: 'V' })).slice(0, 80)); await host.waitForTimeout(6000); }
for (const [i, p] of pages.entries()) console.log(`P${i + 1} after share`, JSON.stringify(await ev(p, brief)));

for (const [i, p] of guests.entries()) {
  const r = await ev(p, `this.watchRemoteScreen(${JSON.stringify(names[0])}); return true;`);
}
await host.waitForTimeout(8000);
const frames = `const sub=this.voice.sfu?.sub; const inb=[]; if (sub?.pc) (await sub.pc.getStats()).forEach(r=>{ if(r.type==='inbound-rtp'){ const i=sub.tracks.get(String(r.mid))||{}; inb.push([r.kind,i.user,i.source,r.frameWidth,r.framesDecoded]); }}); const out={}; for (const [u,v] of this.voice.remoteScreens) out[u]={w:v.videoWidth,h:v.videoHeight,paused:v.paused,t:v.currentTime}; return { inb, remoteVideos:[...this.voice.remoteVideos.keys()], screens: out, tiles: document.querySelectorAll('#voiceStage .voice-stage-tile').length, gated: document.querySelectorAll('#voiceStage .voice-stage-tile.is-gated').length, loading: document.querySelectorAll('#voiceStage .voice-stage-tile.is-loading').length, remote: [...this.voice.remoteScreens.keys()] };`;
for (const [i, p] of guests.entries()) console.log(`P${i + 2} after watch`, JSON.stringify(await ev(p, frames)));
await browser.close(); await wk?.close();
