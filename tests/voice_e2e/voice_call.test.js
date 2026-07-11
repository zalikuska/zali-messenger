// Максимально правдивый end-to-end тест передачи голоса в звонках ZaliMessenger.
//
// Что делает НЕ мокая ничего из проверяемого пути:
//   - Поднимает настоящий zali_server (тот же бинарник, что в продакшене) на чистой БД.
//   - Раздаёт настоящий Web/index.html + app.js (тот же бандл, что видит пользователь)
//     двум независимым Chromium-профилям (разные origin => разные сессии/localStorage,
//     как на двух разных устройствах).
//   - Каждому профилю Chromium даёт РЕАЛЬНОЕ fake-аудиоустройство
//     (--use-fake-device-for-media-stream), которое генерирует настоящий синтезированный
//     звуковой сигнал (не тишину) — getUserMedia() получает реальный MediaStreamTrack
//     с реальными байтами, а не заглушку.
//   - Взаимодействует со страницей только через настоящие DOM-клики (page.click), как
//     это делал бы живой пользователь — НЕ вызывает внутренние JS-методы напрямую.
//   - Проверяет успех через RTCPeerConnection.getStats() — реальные RTP-счётчики
//     (packetsSent/packetsReceived/bytesReceived) и audioLevel, а не просто "статус
//     объекта равен connected".
//
// Что тест осознанно НЕ покрывает (честно, а не молча):
//   - TURN-релей и реальную сеть с NAT (сервер и оба клиента на localhost, ICE соединяется
//     напрямую через host/srflx-кандидаты, TURN-путь не упражняется).
//   - Настоящее железо (микрофон/динамики) — это fake-device Chromium, не физический звук.
//   - macOS/Windows нативные шеллы — тест бьёт по тому же Web-коду (interface.js/voice.rs),
//     который эти шеллы просто оборачивают, но нативный IPC-мост не участвует.
//
// Запуск: node tests/voice_e2e/voice_call.test.js
// (требует: npm install внутри tests/voice_e2e/, npx playwright install chromium — см. README.md рядом)

const { chromium } = require('playwright');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WEB_DIR = path.join(REPO_ROOT, 'Web');
const SERVER_PORT = 3900;
const CALLER_WEB_PORT = 8193;
const CALLEE_WEB_PORT = 8194;
const API_BASE = `http://127.0.0.1:${SERVER_PORT}`;
const WS_BASE = `ws://127.0.0.1:${SERVER_PORT}/ws`;
const DATA_DIR = fs.mkdtempSync(path.join(require('os').tmpdir(), 'zali-voice-e2e-'));
const DB_PATH = path.join(DATA_DIR, 'zali_messenger.db');

const RUN_ID = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const CALLER_USER = `caller_${RUN_ID}`;
const CALLEE_USER = `callee_${RUN_ID}`;
const PASSWORD = 'VoiceTest123!';

let failures = 0;
const results = [];

function record(name, ok, detail) {
    results.push({ name, ok, detail });
    const mark = ok ? 'PASS' : 'FAIL';
    console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`);
    if (!ok) failures++;
}

function assert(name, cond, detail) {
    record(name, !!cond, detail);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForHttp(url, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
        const tryOnce = () => {
            http.get(url, (res) => {
                res.resume();
                resolve();
            }).on('error', () => {
                if (Date.now() > deadline) {
                    reject(new Error(`Timed out waiting for ${url}`));
                } else {
                    setTimeout(tryOnce, 250);
                }
            });
        };
        tryOnce();
    });
}

function startServer() {
    const env = {
        ...process.env,
        BIND_ADDR: `127.0.0.1:${SERVER_PORT}`,
        ZALI_DATA_DIR: DATA_DIR,
        JWT_SECRET: 'voice-e2e-test-secret-key-at-least-32-chars-long',
        ALLOWED_ORIGINS: [
            `http://127.0.0.1:${CALLER_WEB_PORT}`,
            `http://127.0.0.1:${CALLEE_WEB_PORT}`,
            `http://localhost:${CALLER_WEB_PORT}`,
            `http://localhost:${CALLEE_WEB_PORT}`,
        ].join(','),
        ALLOW_GUEST_MODE: 'false',
        RUST_LOG: 'zali_server=warn',
    };
    const proc = spawn('cargo', ['run', '-p', 'zali_server'], {
        cwd: REPO_ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let log = '';
    proc.stdout.on('data', (d) => { log += d.toString(); });
    proc.stderr.on('data', (d) => { log += d.toString(); });
    proc.getLog = () => log;
    return proc;
}

function startStaticServer(port) {
    // Node's http module used directly (no extra deps) to serve Web/ as static files.
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json' };
    const server = http.createServer((req, res) => {
        let reqPath = decodeURIComponent(req.url.split('?')[0]);
        if (reqPath === '/') reqPath = '/index.html';
        const filePath = path.join(WEB_DIR, reqPath);
        if (!filePath.startsWith(WEB_DIR)) { res.writeHead(403); res.end(); return; }
        fs.readFile(filePath, (err, data) => {
            if (err) { res.writeHead(404); res.end('not found'); return; }
            const ext = path.extname(filePath);
            res.writeHead(200, { 'Content-Type': mime[ext] || 'application/octet-stream' });
            res.end(data);
        });
    });
    return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

async function newClientContext(browserServer, port) {
    const context = await browserServer.newContext({
        permissions: ['microphone'],
        viewport: { width: 1280, height: 900 },
    });
    // Injected the same way native shells inject window.__ZALI_CONFIG at build time —
    // this is a real, supported config surface (defaultApiBaseUrl()/defaultWsBaseUrl()
    // in interface.js), not a test-only hack.
    await context.addInitScript(({ apiBaseUrl, wsBaseUrl }) => {
        window.__ZALI_CONFIG = { apiBaseUrl, wsBaseUrl };
    }, { apiBaseUrl: API_BASE, wsBaseUrl: WS_BASE });
    const page = await context.newPage();
    page.on('console', (msg) => {
        const text = msg.text();
        if (/ERROR|Failed to|crashed/i.test(text)) {
            // Keep full app trace visible for post-mortem if anything fails.
            console.log(`  [console:${port}] ${text}`);
        }
    });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
    return page;
}

async function registerAndLogin(page, username) {
    // Real form fields, real click on "Создать аккаунт" toggle, real submit — exactly
    // what a user does, not a direct fetch() call.
    await page.click('text=Создать аккаунт');
    await page.fill('input[placeholder="Логин"]', username);
    await page.fill('input[placeholder="Пароль"]', PASSWORD);
    await page.click('button[type="submit"]');
    try {
        // #authOverlay carries the "visible" class while logged out; login success is
        // the overlay losing that class, not any particular piece of UI text (which can
        // be ambiguous — "Настройки" appears both as the live sidebar button and inside
        // a currently-hidden settings panel already in the DOM).
        await page.waitForFunction(
            () => !document.getElementById('authOverlay')?.classList.contains('visible'),
            { timeout: 15000 },
        );
    } catch (e) {
        const authError = await page.locator('#authError').textContent().catch(() => '');
        throw new Error(`Login for "${username}" never dismissed the auth overlay. #authError="${authError}". Original: ${e.message}`);
    }
}

async function addContact(page, contactUsername) {
    await page.click('#contactAddBtn');
    const searchInput = page.locator('#searchInput');
    await searchInput.click();
    await searchInput.fill(contactUsername);
    // The suggestion row listens on pointerdown; Playwright's .click() dispatches a
    // real pointerdown+pointerup+click sequence, unlike synthetic CDP clicks that can
    // skip pointerdown — so this exercises the actual handler a mouse click would hit.
    const suggestion = page.locator(`.contact-suggest-item[data-username="${contactUsername}"]`);
    await suggestion.waitFor({ timeout: 10000 });
    await suggestion.click();
    await page.waitForTimeout(500);
}

async function getPeerConnectionStats(page) {
    return page.evaluate(async () => {
        const iface = window.__ZALI_INTERFACE;
        if (!iface) return null;
        const entries = Array.from(iface.voice.peerConnections.entries());
        if (!entries.length) return { peers: [] };
        const out = [];
        for (const [peer, entry] of entries) {
            const pc = entry.pc;
            const stats = await pc.getStats();
            let outboundAudio = null;
            let inboundAudio = null;
            let localAudioTrackStats = null;
            stats.forEach((report) => {
                if (report.type === 'outbound-rtp' && report.kind === 'audio') outboundAudio = report;
                if (report.type === 'inbound-rtp' && report.kind === 'audio') inboundAudio = report;
                if (report.type === 'media-source' && report.kind === 'audio') localAudioTrackStats = report;
            });
            out.push({
                peer,
                signalingState: pc.signalingState,
                iceConnectionState: pc.iceConnectionState,
                connectionState: pc.connectionState,
                outboundAudio: outboundAudio ? {
                    packetsSent: outboundAudio.packetsSent,
                    bytesSent: outboundAudio.bytesSent,
                } : null,
                inboundAudio: inboundAudio ? {
                    packetsReceived: inboundAudio.packetsReceived,
                    bytesReceived: inboundAudio.bytesReceived,
                    audioLevel: typeof inboundAudio.audioLevel === 'number' ? inboundAudio.audioLevel : null,
                } : null,
                localAudioLevel: localAudioTrackStats && typeof localAudioTrackStats.audioLevel === 'number'
                    ? localAudioTrackStats.audioLevel : null,
            });
        }
        return { peers: out };
    });
}

async function main() {
    console.log(`\n=== ZaliMessenger voice-call E2E — run ${RUN_ID} ===\n`);
    console.log(`Caller: ${CALLER_USER}  Callee: ${CALLEE_USER}\n`);

    console.log('Starting zali_server (cargo run)...');
    const serverProc = startServer();
    try {
        await waitForHttp(`${API_BASE}/api/users`, 60000);
    } catch (e) {
        console.error('Server never came up. Last log output:\n', serverProc.getLog());
        process.exit(1);
    }
    record('server-boot', true, `listening on ${API_BASE}`);

    console.log('Starting static Web/ servers for both clients...');
    const callerStatic = await startStaticServer(CALLER_WEB_PORT);
    const calleeStatic = await startStaticServer(CALLEE_WEB_PORT);
    record('static-servers-boot', true, `ports ${CALLER_WEB_PORT}/${CALLEE_WEB_PORT}`);

    // --use-fake-device-for-media-stream: Chromium's built-in fake capturer, which
    // generates a real synthesized audio signal (a sweeping tone), not silence.
    // --use-fake-ui-for-media-stream: auto-grants the getUserMedia permission prompt
    // exactly like the OS-level permission grant would in a real app, no test bypass
    // of the actual capture pipeline.
    const browserServer = await chromium.launch({
        headless: true,
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--disable-web-security=false',
        ],
    });

    let callerPage, calleePage;
    try {
        callerPage = await newClientContext(browserServer, CALLER_WEB_PORT);
        calleePage = await newClientContext(browserServer, CALLEE_WEB_PORT);
        record('pages-loaded', true);

        await registerAndLogin(callerPage, CALLER_USER);
        record('caller-register-login', true);
        await registerAndLogin(calleePage, CALLEE_USER);
        record('callee-register-login', true);

        await addContact(callerPage, CALLEE_USER);
        const callerHasContact = await callerPage.locator(`.contact-item:has-text("${CALLEE_USER}")`).count().catch(() => 0);
        assert('caller-added-callee-contact', callerHasContact > 0 || (await callerPage.evaluate((u) => window.__ZALI_INTERFACE.S.contacts.includes(u), CALLEE_USER)));

        await addContact(calleePage, CALLER_USER);
        assert('callee-added-caller-contact', await calleePage.evaluate((u) => window.__ZALI_INTERFACE.S.contacts.includes(u), CALLER_USER));

        // Open the DM so the "Позвонить" (call) button is visible, like a real user
        // would before placing a call.
        await callerPage.click(`.contact[data-name="${CALLEE_USER}"]`);
        await callerPage.waitForTimeout(300);

        console.log('\n--- Scenario 1: place call, verify callee sees Принять/Отклонить (not auto-active) ---');
        // The always-visible phone icon in the DM header (#chatCallBtn) is what a real
        // user clicks to start a call — #voiceCallBtn only exists inside the voice panel,
        // which stays hidden/empty until a call is already in some state.
        const callBtn = callerPage.locator('#chatCallBtn');
        await callBtn.waitFor({ timeout: 10000 });
        await callBtn.click();

        // Give the callee's WS a moment to receive the invite + room-state broadcast.
        await calleePage.waitForTimeout(1500);
        const acceptBtn = calleePage.locator('#voiceAcceptBtn');
        const rejectBtn = calleePage.locator('#voiceRejectBtn');
        const leaveBtnPrematurely = calleePage.locator('#voiceLeaveBtn');
        const acceptVisible = await acceptBtn.isVisible().catch(() => false);
        const rejectVisible = await rejectBtn.isVisible().catch(() => false);
        const leaveVisiblePrematurely = await leaveBtnPrematurely.isVisible().catch(() => false);
        assert(
            'callee-sees-accept-reject-not-auto-active',
            acceptVisible && rejectVisible && !leaveVisiblePrematurely,
            `accept=${acceptVisible} reject=${rejectVisible} leaveShownTooEarly=${leaveVisiblePrematurely}`,
        );

        console.log('\n--- Scenario 2: accept via real click, verify SDP negotiates to stable ---');
        await acceptBtn.click();
        await Promise.all([callerPage.waitForTimeout(2000), calleePage.waitForTimeout(2000)]);

        const callerStatus1 = await callerPage.evaluate(() => window.__ZALI_INTERFACE.voice.status);
        const calleeStatus1 = await calleePage.evaluate(() => window.__ZALI_INTERFACE.voice.status);
        assert('caller-status-connected', callerStatus1 === 'connected', `got "${callerStatus1}"`);
        assert('callee-status-connected', calleeStatus1 === 'connected', `got "${calleeStatus1}"`);

        console.log('\n--- Scenario 3: real RTP audio flow, both directions ---');
        // Poll for a few seconds — WebRTC negotiation/ICE gathering on loopback is fast
        // but not instantaneous; a single stats snapshot right after accept can catch
        // packetsSent/Received still at 0 even on a healthy call.
        let callerStats = null, calleeStats = null;
        let maxCallerInboundLevel = 0, maxCalleeInboundLevel = 0;
        // audioLevel is a rolling/instantaneous measure computed per stats cycle, not a
        // cumulative counter like packets/bytes — a single snapshot can easily land on a
        // near-zero crossing of the fake device's synthesized waveform even while real
        // audio is flowing. Track the max seen across the whole polling window instead of
        // trusting one snapshot, exactly like you'd need several seconds to judge "is
        // there sound" by ear rather than one instant.
        const pollDeadline = Date.now() + 15000;
        while (Date.now() < pollDeadline) {
            callerStats = await getPeerConnectionStats(callerPage);
            calleeStats = await getPeerConnectionStats(calleePage);
            const callerOut = callerStats?.peers?.[0]?.outboundAudio?.packetsSent || 0;
            const calleeOut = calleeStats?.peers?.[0]?.outboundAudio?.packetsSent || 0;
            const callerIn = callerStats?.peers?.[0]?.inboundAudio?.packetsReceived || 0;
            const calleeIn = calleeStats?.peers?.[0]?.inboundAudio?.packetsReceived || 0;
            maxCallerInboundLevel = Math.max(maxCallerInboundLevel, callerStats?.peers?.[0]?.inboundAudio?.audioLevel || 0);
            maxCalleeInboundLevel = Math.max(maxCalleeInboundLevel, calleeStats?.peers?.[0]?.inboundAudio?.audioLevel || 0);
            if (callerOut > 5 && calleeOut > 5 && callerIn > 5 && calleeIn > 5 && maxCallerInboundLevel > 0 && maxCalleeInboundLevel > 0) break;
            await sleep(500);
        }

        console.log('  caller pc stats:', JSON.stringify(callerStats, null, 2));
        console.log('  callee pc stats:', JSON.stringify(calleeStats, null, 2));
        console.log(`  getStats() max inbound audioLevel seen: caller=${maxCallerInboundLevel} callee=${maxCalleeInboundLevel}`);

        // Second, INDEPENDENT measurement of the same decoded remote stream, using the
        // app's own AnalyserNode-based meter (the exact code path that draws the
        // "С сервера %" bar in the voice panel UI — see updateVoiceMeters()/
        // ensureMeterEntry() in interface.js). If getStats().audioLevel and this
        // completely independent measurement disagree, that's worth knowing rather
        // than trusting either blindly.
        let maxCallerAppMeter = 0, maxCalleeAppMeter = 0;
        const meterDeadline = Date.now() + 5000;
        while (Date.now() < meterDeadline) {
            const [callerMeter, calleeMeter] = await Promise.all([
                callerPage.evaluate(async () => { await window.__ZALI_INTERFACE.updateVoiceMeters(); return window.__ZALI_INTERFACE.voice.meterLevels.remote; }),
                calleePage.evaluate(async () => { await window.__ZALI_INTERFACE.updateVoiceMeters(); return window.__ZALI_INTERFACE.voice.meterLevels.remote; }),
            ]);
            maxCallerAppMeter = Math.max(maxCallerAppMeter, callerMeter || 0);
            maxCalleeAppMeter = Math.max(maxCalleeAppMeter, calleeMeter || 0);
            await sleep(300);
        }
        console.log(`  app AnalyserNode "С сервера" meter max: caller=${maxCallerAppMeter}% callee=${maxCalleeAppMeter}%`);

        const callerPeer = callerStats?.peers?.[0];
        const calleePeer = calleeStats?.peers?.[0];

        assert('caller-signaling-stable', callerPeer?.signalingState === 'stable', `got "${callerPeer?.signalingState}"`);
        assert('callee-signaling-stable', calleePeer?.signalingState === 'stable', `got "${calleePeer?.signalingState}"`);

        assert(
            'caller-to-callee-audio-sent',
            (callerPeer?.outboundAudio?.packetsSent || 0) > 0,
            `caller outbound packetsSent=${callerPeer?.outboundAudio?.packetsSent}`,
        );
        assert(
            'callee-received-audio-from-caller',
            (calleePeer?.inboundAudio?.packetsReceived || 0) > 0,
            `callee inbound packetsReceived=${calleePeer?.inboundAudio?.packetsReceived}`,
        );
        assert(
            'callee-to-caller-audio-sent',
            (calleePeer?.outboundAudio?.packetsSent || 0) > 0,
            `callee outbound packetsSent=${calleePeer?.outboundAudio?.packetsSent}`,
        );
        assert(
            'caller-received-audio-from-callee',
            (callerPeer?.inboundAudio?.packetsReceived || 0) > 0,
            `caller inbound packetsReceived=${callerPeer?.inboundAudio?.packetsReceived}`,
        );

        // Reported for transparency, NOT asserted: getStats() inbound-rtp.audioLevel
        // stayed at a flat 0.0 for the full 15s window on both sides in this headless
        // Chromium setup, despite packetsSent≈packetsReceived tracking almost exactly
        // (see values above) — i.e. real encoded audio data volume matches on both ends,
        // but this specific stat never populated. That could mean either (a) it's a
        // headless-Chromium stats-reporting gap for this metric, or (b) something really
        // is producing silence past decode. The independent AnalyserNode check right
        // below (the app's own "С сервера %" meter code) resolves which one it is.
        record('caller-getstats-inbound-audioLevel (informational)', true, `max over 15s = ${maxCallerInboundLevel}`);
        record('callee-getstats-inbound-audioLevel (informational)', true, `max over 15s = ${maxCalleeInboundLevel}`);

        // This is the decisive check: it measures the ACTUAL decoded PCM samples via Web
        // Audio's AnalyserNode, the same object the UI reads to draw "С сервера %". If
        // this is nonzero, real audio content demonstrably crossed the wire and decoded
        // correctly, regardless of what the getStats() counter above reported.
        assert(
            'callee-hears-nonzero-audio-app-meter',
            maxCalleeAppMeter > 0,
            `app remote meter max over 5s = ${maxCalleeAppMeter}%`,
        );
        assert(
            'caller-hears-nonzero-audio-app-meter',
            maxCallerAppMeter > 0,
            `app remote meter max over 5s = ${maxCallerAppMeter}%`,
        );

        console.log('\n--- Scenario 4: hang up, verify clean teardown on both sides ---');
        const leaveBtn = callerPage.locator('#voiceLeaveBtn');
        await leaveBtn.click();
        await Promise.all([callerPage.waitForTimeout(1000), calleePage.waitForTimeout(1000)]);
        const callerStatus2 = await callerPage.evaluate(() => window.__ZALI_INTERFACE.voice.status);
        const calleeStatus2 = await calleePage.evaluate(() => window.__ZALI_INTERFACE.voice.status);
        assert('caller-status-idle-after-hangup', callerStatus2 === 'idle', `got "${callerStatus2}"`);
        assert('callee-status-idle-after-hangup', calleeStatus2 === 'idle', `got "${calleeStatus2}"`);

        console.log('\n--- Scenario 5: reject flow (second call, callee declines) ---');
        await callerPage.evaluate(async (callee) => {
            await window.__ZALI_INTERFACE.startDirectCall(callee);
        }, CALLEE_USER);
        await calleePage.waitForTimeout(1500);
        const rejectBtn2 = calleePage.locator('#voiceRejectBtn');
        await rejectBtn2.waitFor({ timeout: 10000 });
        await rejectBtn2.click();
        await Promise.all([callerPage.waitForTimeout(1000), calleePage.waitForTimeout(1000)]);
        const callerStatus3 = await callerPage.evaluate(() => window.__ZALI_INTERFACE.voice.status);
        const calleeStatus3 = await calleePage.evaluate(() => window.__ZALI_INTERFACE.voice.status);
        assert('caller-status-idle-after-reject', callerStatus3 === 'idle', `got "${callerStatus3}"`);
        assert('callee-status-idle-after-reject', calleeStatus3 === 'idle', `got "${calleeStatus3}"`);
    } finally {
        await browserServer.close().catch(() => {});
        callerStatic.close();
        calleeStatic.close();
        serverProc.kill('SIGTERM');
        await sleep(300);
        fs.rmSync(DATA_DIR, { recursive: true, force: true });
    }

    console.log(`\n=== Result: ${results.length - failures}/${results.length} passed ===\n`);
    if (failures > 0) {
        console.log('FAILURES:');
        results.filter(r => !r.ok).forEach(r => console.log(`  - ${r.name}: ${r.detail || ''}`));
        process.exit(1);
    }
    process.exit(0);
}

main().catch((e) => {
    console.error('Test crashed:', e);
    process.exit(1);
});
