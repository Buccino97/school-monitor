const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: '30mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();

function newCode(len = 6) {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let s = '';
  do { s = Array.from({ length: len }, () => chars[crypto.randomInt(chars.length)]).join(''); } while (rooms.has(s));
  return s;
}

function createRoom() {
  const room = {
    code: newCode(),
    teacherToken: crypto.randomBytes(24).toString('hex'),
    createdAt: Date.now(),
    dashboards: new Set(),
    students: {},
    config: { blocked_urls: [], blocked_apps: [], groups: [] }
  };
  rooms.set(room.code, room);
  return room;
}

setInterval(() => {
  const now = Date.now();
  for (const [code, r] of rooms) {
    if (now - r.createdAt > 12 * 3600 * 1000) {
      r.students.forEach(s => { try { s.ws.close(); } catch {} });
      r.dashboards.forEach(w => { try { w.close(); } catch {} });
      rooms.delete(code);
    }
  }
}, 3600 * 1000);

function getRoom(code) { return rooms.get(String(code || '').toUpperCase()); }

function requireTeacher(req, res) {
  const room = getRoom(req.params.code || req.body?.code);
  if (!room) { res.status(404).json({ error: 'Aula non trovata' }); return null; }
  if (req.get('X-Teacher-Token') !== room.teacherToken) { res.status(401).json({ error: 'Non autorizzato' }); return null; }
  return room;
}

function sendTo(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch {} }

function broadcastDashboards(room, obj) {
  const msg = JSON.stringify(obj);
  room.dashboards.forEach(ws => { try { if (ws.readyState === 1) ws.send(msg); } catch {} });
}

function roomStatus(room) {
  const now = Date.now();
  return Object.entries(room.students).map(([name, s]) => ({
    name, window: s.window, process: s.process,
    violations: s.violations, lockdown: s.lockdown, live: s.live,
    handRaised: s.handRaised, kiosk: s.kiosk,
    online: s.ws.readyState === 1 && (now - s.lastSeen) < 10000
  }));
}

app.get('/api/discover', (req, res) => res.json({ service: 'school-monitor', version: '2.0-cloud', mode: 'cloud' }));

app.post('/api/room/create', (req, res) => {
  const room = createRoom();
  res.json({ code: room.code, teacherToken: room.teacherToken });
});

app.get('/api/room/:code/info', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Aula non trovata' });
  res.json({ code: room.code, students: roomStatus(room) });
});

app.get('/api/room/:code/students', (req, res) => {
  const room = requireTeacher(req, res);
  if (!room) return;
  res.json(roomStatus(room));
});

app.post('/api/room/:code/lockdown', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  const { target, active } = req.body;
  const names = target === 'all' ? Object.keys(room.students) : [target];
  names.forEach(n => { const s = room.students[n]; if (s) { s.lockdown = !!active; sendTo(s.ws, { type: 'lockdown', active: !!active }); } });
  res.json({ ok: true });
});

app.post('/api/room/:code/kiosk', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  const { target, url, active } = req.body;
  const names = target === 'all' ? Object.keys(room.students) : [target];
  names.forEach(n => { const s = room.students[n]; if (s) { s.kiosk = !!active; sendTo(s.ws, { type: 'set_kiosk', active: !!active, url: url || '' }); } });
  res.json({ ok: true });
});

app.post('/api/room/:code/live', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  const { target, active, fps } = req.body;
  const s = room.students[target];
  if (s) { s.live = !!active; sendTo(s.ws, { type: 'set_live', active: !!active, fps: fps || 5 }); }
  res.json({ ok: true });
});

app.post('/api/room/:code/config', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  const { target, blocked_urls, blocked_apps } = req.body;
  if (target === 'all' || !target) {
    room.config.blocked_urls = blocked_urls || [];
    room.config.blocked_apps = blocked_apps || [];
  }
  const payload = { type: 'config', blocked_urls, blocked_apps };
  const names = (target === 'all' || !target) ? Object.keys(room.students) : [target];
  names.forEach(n => { const s = room.students[n]; if (s) sendTo(s.ws, payload); });
  res.json({ ok: true, config: room.config });
});

app.get('/api/room/:code/config', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ error: 'Aula non trovata' });
  res.json(room.config);
});

app.get('/api/room/:code/groups', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  res.json(room.config.groups);
});

app.post('/api/room/:code/groups', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  room.config.groups = req.body.groups || [];
  res.json({ ok: true, groups: room.config.groups });
});

app.post('/api/room/:code/groups/action', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  const { groupName, action, payload } = req.body;
  const group = room.config.groups.find(g => g.name === groupName);
  if (!group) return res.status(404).json({ error: 'Gruppo non trovato' });
  group.members.forEach(n => {
    const s = room.students[n]; if (!s) return;
    if (action === 'lockdown') { s.lockdown = !!payload.active; sendTo(s.ws, { type: 'lockdown', active: !!payload.active }); }
    if (action === 'config') sendTo(s.ws, { type: 'config', blocked_urls: payload.blocked_urls || [], blocked_apps: payload.blocked_apps || [] });
  });
  res.json({ ok: true });
});

app.post('/api/room/:code/message', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  const { target, text } = req.body;
  const names = target === 'all' ? Object.keys(room.students) : [target];
  names.forEach(n => { const s = room.students[n]; if (s) sendTo(s.ws, { type: 'message', text }); });
  res.json({ ok: true });
});

app.post('/api/room/:code/lower_hand', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  const s = room.students[req.body.target];
  if (s) { s.handRaised = false; broadcastDashboards(room, { type: 'hand_lowered', name: req.body.target }); }
  res.json({ ok: true });
});

app.post('/api/room/:code/rename', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  const { oldName, newName } = req.body;
  const s = room.students[oldName];
  if (!s || room.students[newName]) return res.status(400).json({ error: 'Rinomina non valida' });
  room.students[newName] = s; delete room.students[oldName];
  s.name = newName; if (s.ws) s.ws._studentName = newName;
  broadcastDashboards(room, { type: 'student_renamed', oldName, newName });
  sendTo(s.ws, { type: 'rename', name: newName });
  res.json({ ok: true });
});

app.delete('/api/room/:code/students/:name', (req, res) => {
  const room = requireTeacher(req, res); if (!room) return;
  const name = decodeURIComponent(req.params.name);
  const s = room.students[name];
  if (!s) return res.status(404).json({ error: 'Studente non trovato' });
  if (s.ws.readyState === 1 && (Date.now() - s.lastSeen) < 10000) return res.status(400).json({ error: 'Studente ancora online' });
  try { s.ws.close(); } catch {}
  delete room.students[name];
  broadcastDashboards(room, { type: 'student_removed', name });
  res.json({ ok: true });
});

wss.on('connection', (ws) => {
  ws._kind = null;
  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === 'register') {
      const room = getRoom(msg.roomCode);
      if (!room) { sendTo(ws, { type: 'error', error: 'Codice aula non valido' }); return; }
      ws._kind = 'student'; ws._room = room.code;
      let name = String(msg.name || 'Studente').trim().slice(0, 40);
      if (room.students[name] && room.students[name].ws.readyState === 1) {
        let i = 2;
        while (room.students[name + ' (' + i + ')']) i++;
        name = name + ' (' + i + ')';
      }
      const student = room.students[name] || {};
      student.ws = ws; student.lastSeen = Date.now();
      student.screenshot = null; student.window = ''; student.process = '';
      student.violations = []; student.lockdown = false; student.live = false;
      student.handRaised = false; student.kiosk = false; student.name = name;
      room.students[name] = student;
      ws._studentName = name;
      sendTo(ws, { type: 'registered', name });
      sendTo(ws, { type: 'config', blocked_urls: room.config.blocked_urls, blocked_apps: room.config.blocked_apps });
      broadcastDashboards(room, { type: 'student_connected', name });
      const st = roomStatus(room).find(x => x.name === name);
      broadcastDashboards(room, Object.assign({ type: 'status', name }, st));
      return;
    }

    if (msg.type === 'teacher_auth') {
      const room = getRoom(msg.roomCode);
      if (!room || msg.token !== room.teacherToken) { sendTo(ws, { type: 'auth_failed' }); return; }
      ws._kind = 'teacher'; ws._room = room.code;
      room.dashboards.add(ws);
      sendTo(ws, { type: 'auth_ok', code: room.code, students: roomStatus(room), config: room.config });
      return;
    }

    if (!ws._room) return;
    const room = getRoom(ws._room);
    if (!room) return;

    if (ws._kind === 'student') {
      const name = ws._studentName;
      const student = room.students[name];
      if (!student) return;
      student.lastSeen = Date.now();

      switch (msg.type) {
        case 'status':
          student.window = msg.window || '';
          student.process = msg.process || '';
          student.violations = msg.violations || [];
          broadcastDashboards(room, { type: 'status', name, window: student.window, process: student.process, violations: student.violations, online: true });
          break;
        case 'screenshot':
          student.screenshot = msg.image;
          broadcastDashboards(room, { type: 'screenshot', name, image: msg.image });
          break;
        case 'videoChunk':
          broadcastDashboards(room, { type: 'videoChunk', name, chunk: msg.chunk, mime: msg.mime });
          break;
        case 'violation':
          if (!(student.violations || []).includes(msg.url)) {
            student.violations = [...(student.violations || []), msg.url].slice(-10);
            broadcastDashboards(room, { type: 'alert', name, url: msg.url, time: Date.now() });
          }
          break;
        case 'raise_hand':
          student.handRaised = true;
          broadcastDashboards(room, { type: 'hand_raised', name });
          sendTo(ws, { type: 'hand_acknowledged' });
          break;
        case 'lower_hand':
          student.handRaised = false;
          broadcastDashboards(room, { type: 'hand_lowered', name });
          break;
      }
    }
  });

  ws.on('close', () => {
    if (ws._kind === 'teacher' && ws._room) {
      const room = getRoom(ws._room);
      if (room) room.dashboards.delete(ws);
    }
    if (ws._kind === 'student' && ws._room) {
      const room = getRoom(ws._room);
      const name = ws._studentName;
      if (room && room.students[name]) {
        room.students[name].live = false;
        broadcastDashboards(room, { type: 'student_disconnected', name });
      }
    }
  });

  setTimeout(() => { if (!ws._kind && ws.readyState === 1) ws.close(); }, 2000);
});

server.listen(PORT, () => console.log('School Monitor Cloud attivo sulla porta ' + PORT));
