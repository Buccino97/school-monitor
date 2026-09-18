let ws = null;
let myName = null, roomCode = null;
let lockdownActive = false, liveActive = false, kioskActive = false, kioskUrl = '';
let lockWinId = null, kioskWinId = null, kioskTimer = null;
let violations = [];
let connected = false;

async function cfg() { return await chrome.storage.local.get(['serverUrl','roomCode','studentName']); }
function send(obj) { try { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }

async function autoName() {
  return new Promise(resolve => {
    try {
      chrome.identity.getProfileUserInfo(info => {
        if (info && info.email) resolve(info.email.split('@')[0].split(/[._-]/).map(p => p.charAt(0).toUpperCase() + p.slice(1)).join(' '));
        else resolve('Studente ' + Math.floor(Math.random() * 900 + 100));
      });
    } catch { resolve('Studente ' + Math.floor(Math.random() * 900 + 100)); }
  });
}

async function connect() {
  const c = await cfg();
  roomCode = (c.roomCode || '').toUpperCase();
  const base = (c.serverUrl || '').replace(/\/+$/, '');
  if (!roomCode || !base) { setTimeout(connect, 5000); return; }
  myName = c.studentName || (await autoName());
  if (!c.studentName) chrome.storage.local.set({ studentName: myName });
  try { ws = new WebSocket(base.replace(/^http/, 'ws')); } catch { setTimeout(connect, 5000); return; }
  ws.onopen = () => { connected = true; send({ type: 'register', roomCode, name: myName }); };
  ws.onmessage = ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    switch (m.type) {
      case 'registered':
      case 'rename':
        myName = m.name; chrome.storage.local.set({ studentName: m.name }); break;
      case 'config':
        chrome.storage.local.set({ blockedUrls: m.blocked_urls || [] });
        applyBlockedUrls(m.blocked_urls || []); break;
      case 'lockdown':
        lockdownActive = m.active;
        if (m.active) showLockScreen(); else removeLockScreen(); break;
      case 'set_live':
        liveActive = m.active;
        if (m.active) startVideoCapture(m.fps || 5); else stopVideoCapture(); break;
      case 'set_kiosk':
        kioskActive = m.active; kioskUrl = m.url || '';
        if (kioskActive) showKiosk(); else removeKiosk(); break;
      case 'message':
        chrome.notifications.create({ type: 'basic', iconUrl: 'icon.png', title: 'Messaggio dal docente', message: m.text });
        break;
    }
  };
  ws.onclose = () => { connected = false; setTimeout(connect, 3000); };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

async function applyBlockedUrls(urls) {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(r => r.id) });
  const rules = urls.map((d, i) => ({
    id: i + 1, priority: 1,
    action: { type: 'redirect', redirect: { extensionPath: '/blocked.html?site=' + encodeURIComponent(d) } },
    condition: { urlFilter: '||' + d, resourceTypes: ['main_frame'] }
  }));
  if (rules.length) await chrome.declarativeNetRequest.updateDynamicRules({ addRules: rules });
}

chrome.webNavigation?.onBeforeNavigate?.addListener(async d => {
  if (d.frameId !== 0) return;
  const { blockedUrls = [] } = await chrome.storage.local.get('blockedUrls');
  for (const dom of blockedUrls) { if (d.url.includes(dom)) { send({ type: 'violation', url: d.url }); break; } }
});

setInterval(async () => {
  if (!connected) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    send({ type: 'status', name: myName, window: tab?.title || '', process: 'chrome', violations, lockdown: lockdownActive });
  } catch {}
}, 1000);

setInterval(async () => {
  if (!connected || liveActive) return;
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 60 });
    send({ type: 'screenshot', name: myName, image: dataUrl.split(',')[1] });
  } catch {}
}, 2000);

async function showLockScreen() {
  const wins = await chrome.windows.getAll();
  for (const w of wins) if (w.id !== lockWinId) chrome.windows.update(w.id, { state: 'minimized' }).catch(() => {});
  const win = await chrome.windows.create({ url: chrome.runtime.getURL('lock.html'), type: 'popup', state: 'fullscreen', focused: true });
  lockWinId = win.id;
}
async function removeLockScreen() {
  if (lockWinId !== null) { try { await chrome.windows.remove(lockWinId); } catch {} lockWinId = null; }
  const wins = await chrome.windows.getAll();
  for (const w of wins) if (w.state === 'minimized') chrome.windows.update(w.id, { state: 'normal' }).catch(() => {});
}
setInterval(async () => {
  if (!lockdownActive) return;
  try {
    if (lockWinId !== null) {
      await chrome.windows.update(lockWinId, { focused: true, state: 'fullscreen' }).catch(async () => { await showLockScreen(); });
    } else await showLockScreen();
    const wins = await chrome.windows.getAll();
    for (const w of wins) if (w.id !== lockWinId && w.state !== 'minimized') chrome.windows.update(w.id, { state: 'minimized' }).catch(() => {});
  } catch {}
}, 200);
chrome.windows.onRemoved.addListener(id => { if (lockdownActive && id === lockWinId) showLockScreen(); });
chrome.windows.onCreated.addListener(() => { if (lockdownActive) showLockScreen(); });

async function showKiosk() {
  if (!kioskUrl) return;
  const win = await chrome.windows.create({ url: kioskUrl, type: 'popup', state: 'fullscreen', focused: true });
  kioskWinId = win.id;
  clearInterval(kioskTimer);
  kioskTimer = setInterval(() => { if (!kioskActive) return; chrome.windows.update(kioskWinId, { focused: true }).catch(() => {}); }, 1000);
}
async function removeKiosk() {
  clearInterval(kioskTimer);
  if (kioskWinId !== null) { try { await chrome.windows.remove(kioskWinId); } catch {} kioskWinId = null; }
}

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length === 0) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['USER_MEDIA'], justification: 'Cattura video LIVE' });
}
async function startVideoCapture(fps) {
  await ensureOffscreen();
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'start_capture', streamId, fps, name: myName });
  } catch (e) { console.warn('tabCapture', e); }
}
function stopVideoCapture() {
  try { chrome.runtime.sendMessage({ target: 'offscreen', type: 'stop_capture' }); } catch {}
}

let tabTimer = null;
chrome.tabs.onActivated.addListener(() => {
  if (!liveActive) return;
  clearTimeout(tabTimer);
  tabTimer = setTimeout(async () => {
    stopVideoCapture();
    await new Promise(r => setTimeout(r, 300));
    startVideoCapture(5);
  }, 800);
});

setInterval(async () => {
  if (!roomCode) return;
  const c = await cfg();
  const base = (c.serverUrl || '').replace(/\/+$/, '');
  if (!base) return;
  try {
    const r = await fetch(base + '/api/room/' + roomCode + '/config');
    if (r.ok) { const conf = await r.json(); applyBlockedUrls(conf.blocked_urls || []); }
  } catch {}
}, 30000);

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== 'background') return;
  if (msg.type === 'set_config') {
    (async () => {
      await chrome.storage.local.set({ serverUrl: msg.serverUrl, roomCode: msg.roomCode });
      roomCode = (msg.roomCode || '').toUpperCase();
      if (!myName) { myName = await autoName(); chrome.storage.local.set({ studentName: myName }); }
      try { ws.close(); } catch {}
    })();
    sendResponse({ ok: true });
  }
  if (msg.type === 'raise_hand') send({ type: 'raise_hand' });
  if (msg.type === 'videoChunk') send({ type: 'videoChunk', name: myName, chunk: msg.chunk, mime: msg.mime });
});

connect();
