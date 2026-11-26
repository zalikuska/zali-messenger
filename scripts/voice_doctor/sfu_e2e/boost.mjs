// Громкость собеседника выше 100 %: два Chrome с фейковым микрофоном (он пищит), у B
// ползунок A ставится на 100 % и на 200 %; сравнивается уровень на выходе до и после.
// Сервер: launch-конфиг zali-server-sfu-rig (:3001) + web-static :8090.
import { chromium } from 'playwright-core';
const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1228/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const API = 'http://127.0.0.1:3001';
const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
const run = Date.now().toString(36).slice(-4);
const [a, b] = [`bsa${run}`, `bsb${run}`];
async function open(me, peer) {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  page.on('console', m => { const t = m.text(); if (m.type() === 'error' && !t.includes('404')) console.log(`[${me} console]`, t.slice(0, 200)); });
  await page.goto(`http://127.0.0.1:8090/?as=${me}&contact=${peer}&chat=${peer}&api=${encodeURIComponent(API)}`);
  await page.waitForFunction(() => typeof window.__zaliControl === 'function', null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  return page;
}
const ctl = (p, cmd, args = {}) => p.evaluate(([c, x]) => window.__zaliControl(c, x), [cmd, args]);
const ev = (p, code) => ctl(p, 'eval', { code });
const A = await open(a, b); const B = await open(b, a);
console.log('contacts', JSON.stringify(await ctl(A, 'contact.add', { user: b })).slice(0, 60), JSON.stringify(await ctl(B, 'contact.add', { user: a })).slice(0, 60));
await A.waitForTimeout(1500);
console.log('call', JSON.stringify(await ctl(A, 'voice.call', { user: b })).slice(0, 80));
await B.waitForTimeout(2500);
console.log('accept', JSON.stringify(await ctl(B, 'voice.accept', {})).slice(0, 80));
console.log('wait', JSON.stringify(await ctl(B, 'wait', { code: `this.voice.status === 'connected' && this.voice.remoteAudios.size > 0`, timeout: 20000 })).slice(0, 80));
await B.waitForTimeout(3000);
await ev(B, `this.audioPrefs.autoLevelRemote = false; return true`);
const measure = `
  const name = this.__boostName || [...this.voice.remoteAudios.keys()][0]; const audio = this.voice.remoteAudios.get(name);
  const ctx = this.voice.audioContext; const meter = this.voice.meterRemote.get(name);
  const node = this.voice.remoteBoost?.get(name);
  // Что реально уходит на выход: у усиленного пути — выход ограничителя, иначе — сам поток.
  const tap = ctx.createAnalyser(); tap.fftSize = 2048;
  if (node) node.limiter.connect(tap); else meter.source.connect(tap);
  const buf = new Float32Array(tap.fftSize); let peak = 0, sum = 0, n = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 3000) { await new Promise(r => setTimeout(r, 50)); tap.getFloatTimeDomainData(buf); let s = 0; for (const v of buf) { s += v * v; } const rms = Math.sqrt(s / buf.length); sum += rms; n++; peak = Math.max(peak, ...buf.map(Math.abs)); }
  try { tap.disconnect(); } catch (e) {}
  return { name, elementVolume: audio.volume, boost: !!node, gain: node?.gain.gain.value ?? null, ctx: ctx.state, meanRms: +(sum / n).toFixed(4), peak: +peak.toFixed(3), factor: this.remoteVolumeFactor(name) };`;
for (const pct of [100, 200]) {
  await ev(B, `this.setPeerVolumePercent([...this.voice.remoteAudios.keys()][0], ${pct}); return true`);
  await B.waitForTimeout(500);
  console.log(`B peer=${pct}%`, JSON.stringify((await ev(B, measure)).result));
}
// Общий ползунок: 100 % у человека, 150 % общий → 1.5.
await ev(B, `this.setPeerVolumePercent([...this.voice.remoteAudios.keys()][0], 100); this.setMasterVolumePercent(150); return true`);
await B.waitForTimeout(500);
console.log('B master=150%', JSON.stringify((await ev(B, measure)).result));
// «Звук» выключен — усиленный путь молчит.
await ev(B, `this.setMasterVolumePercent(200); this.toggleVoiceDeafen(); return true`);
await B.waitForTimeout(500);
console.log('B deafened', JSON.stringify((await ev(B, measure)).result));
await ev(B, `this.toggleVoiceDeafen(); this.setMasterVolumePercent(100); return true`);
await B.waitForTimeout(500);
console.log('B back 100', JSON.stringify((await ev(B, measure)).result));
// Тихий синтетический «собеседник» (тон −20 дБFS): усиление должно быть слышно в уровне.
await ev(B, `const ac = new AudioContext(); const o = ac.createOscillator(); o.frequency.value = 440; const g = ac.createGain(); g.gain.value = 0.1; const d = ac.createMediaStreamDestination(); o.connect(g); g.connect(d); o.start(); this.__tone = { ac, o }; this.attachRemoteVoiceStream('tone', d.stream); this.__boostName = 'tone'; return true`);
await B.waitForTimeout(800);
for (const pct of [100, 200]) {
  await ev(B, `this.setPeerVolumePercent('tone', ${pct}); return true`);
  await B.waitForTimeout(500);
  console.log(`tone peer=${pct}%`, JSON.stringify((await ev(B, measure)).result));
}
await browser.close();
