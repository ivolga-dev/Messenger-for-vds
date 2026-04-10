const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3001;
const MAX_FILE_SIZE_MB = Number(process.env.MAX_FILE_SIZE_MB || 10);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: MAX_FILE_SIZE_MB * 1024 * 1024
});

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  storage: multer.diskStorage({
    destination: (_, __, cb) => cb(null, uploadDir),
    filename: (_, file, cb) => {
      const safeName = `${Date.now()}-${Math.random().toString(16).slice(2)}-${file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      cb(null, safeName);
    }
  }),
  limits: { fileSize: MAX_FILE_SIZE_MB * 1024 * 1024 }
});

app.use(express.json({ limit: '1mb' }));
app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

const state = {
  usersByCode: new Map(),
  onlineByCode: new Map(),
  privateChats: new Map(),
  groups: new Map(),
  pendingPrivate: new Set()
};

const genCode = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const genId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
const privateKey = (a, b) => [a, b].sort().join(':');

function getOrCreateUser(code, nickname) {
  if (state.usersByCode.has(code)) {
    const existing = state.usersByCode.get(code);
    if (nickname) existing.nickname = nickname;
    return existing;
  }
  const user = {
    code,
    nickname: nickname || `User-${code}`,
    contacts: new Set(),
    groups: new Set(),
    createdAt: Date.now()
  };
  state.usersByCode.set(code, user);
  return user;
}

function serializeUser(user) {
  return {
    code: user.code,
    nickname: user.nickname,
    contacts: Array.from(user.contacts),
    groups: Array.from(user.groups)
  };
}

function pushPrivateMessage(from, to, message) {
  const key = privateKey(from, to);
  if (!state.privateChats.has(key)) {
    state.privateChats.set(key, []);
  }
  const list = state.privateChats.get(key);
  list.push(message);
  if (list.length > 200) list.shift();
}

function pushGroupMessage(groupId, message) {
  const group = state.groups.get(groupId);
  if (!group) return;
  group.messages.push(message);
  if (group.messages.length > 200) group.messages.shift();
}

app.get('/api/health', (_, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    online: state.onlineByCode.size,
    users: state.usersByCode.size,
    groups: state.groups.size
  });
});

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    name: req.file.originalname,
    url: `/uploads/${req.file.filename}`,
    size: req.file.size,
    mime: req.file.mimetype
  });
});

io.on('connection', (socket) => {
  socket.on('auth', ({ code, nickname }, cb) => {
    let userCode = code;
    if (!userCode || userCode.length !== 6) {
      do {
        userCode = genCode();
      } while (state.usersByCode.has(userCode));
    }
    const user = getOrCreateUser(userCode, nickname);
    state.onlineByCode.set(userCode, socket.id);
    socket.data.userCode = userCode;
    socket.join(`user:${userCode}`);
    cb?.({ user: serializeUser(user) });
  });

  socket.on('update:nickname', ({ nickname }, cb) => {
    const myCode = socket.data.userCode;
    const user = state.usersByCode.get(myCode);
    if (!user || !nickname?.trim()) return;
    user.nickname = nickname.trim().slice(0, 30);
    cb?.({ ok: true, user: serializeUser(user) });
  });

  socket.on('contact:add', ({ targetCode }, cb) => {
    const myCode = socket.data.userCode;
    const my = state.usersByCode.get(myCode);
    const target = state.usersByCode.get((targetCode || '').toUpperCase());
    if (!my || !target || my.code === target.code) {
      cb?.({ ok: false, error: 'Контакт не найден' });
      return;
    }
    my.contacts.add(target.code);
    target.contacts.add(my.code);

    cb?.({ ok: true, contacts: Array.from(my.contacts), target: serializeUser(target) });
    io.to(`user:${target.code}`).emit('contact:added', { by: serializeUser(my) });
  });

  socket.on('private:history', ({ withCode }, cb) => {
    const myCode = socket.data.userCode;
    const key = privateKey(myCode, withCode);
    cb?.({ ok: true, messages: state.privateChats.get(key) || [] });
  });

  socket.on('private:send', ({ to, text, file, forwardedFrom }, cb) => {
    const from = socket.data.userCode;
    if (!from || !to) return;
    const msg = {
      id: genId(),
      chatType: 'private',
      from,
      to,
      text: (text || '').slice(0, 4000),
      file: file || null,
      forwardedFrom: forwardedFrom || null,
      reactions: {},
      createdAt: Date.now()
    };
    pushPrivateMessage(from, to, msg);
    io.to(`user:${from}`).to(`user:${to}`).emit('private:message', msg);
    cb?.({ ok: true, msg });
  });

  socket.on('group:create', ({ name, members }, cb) => {
    const owner = socket.data.userCode;
    const groupId = genId();
    const allMembers = new Set([owner, ...(members || [])]);
    const group = {
      id: groupId,
      name: (name || 'Новая группа').slice(0, 60),
      owner,
      members: allMembers,
      messages: [],
      createdAt: Date.now()
    };
    state.groups.set(groupId, group);
    for (const code of allMembers) {
      const user = state.usersByCode.get(code);
      if (user) user.groups.add(groupId);
      io.to(`user:${code}`).emit('group:created', {
        id: group.id,
        name: group.name,
        owner: group.owner,
        members: Array.from(group.members)
      });
    }
    cb?.({ ok: true, groupId });
  });

  socket.on('group:history', ({ groupId }, cb) => {
    const code = socket.data.userCode;
    const group = state.groups.get(groupId);
    if (!group || !group.members.has(code)) return;
    cb?.({
      ok: true,
      group: {
        id: group.id,
        name: group.name,
        members: Array.from(group.members),
        messages: group.messages
      }
    });
  });

  socket.on('group:send', ({ groupId, text, file, forwardedFrom }, cb) => {
    const from = socket.data.userCode;
    const group = state.groups.get(groupId);
    if (!group || !group.members.has(from)) return;
    const msg = {
      id: genId(),
      chatType: 'group',
      groupId,
      from,
      text: (text || '').slice(0, 4000),
      file: file || null,
      forwardedFrom: forwardedFrom || null,
      reactions: {},
      createdAt: Date.now()
    };
    pushGroupMessage(groupId, msg);
    for (const member of group.members) {
      io.to(`user:${member}`).emit('group:message', msg);
    }
    cb?.({ ok: true, msg });
  });

  socket.on('reaction:set', ({ chatType, messageId, reaction, peerCode, groupId }) => {
    const code = socket.data.userCode;
    const rxn = (reaction || '').slice(0, 2);
    if (!rxn || !messageId) return;

    const apply = (messageList, emitFn) => {
      const message = messageList.find((m) => m.id === messageId);
      if (!message) return;
      if (!message.reactions[rxn]) message.reactions[rxn] = [];
      const arr = message.reactions[rxn];
      if (arr.includes(code)) {
        message.reactions[rxn] = arr.filter((x) => x !== code);
      } else {
        arr.push(code);
      }
      emitFn(message);
    };

    if (chatType === 'private') {
      const key = privateKey(code, peerCode);
      const messages = state.privateChats.get(key) || [];
      apply(messages, (message) => io.to(`user:${code}`).to(`user:${peerCode}`).emit('reaction:updated', message));
      return;
    }

    if (chatType === 'group') {
      const group = state.groups.get(groupId);
      if (!group || !group.members.has(code)) return;
      apply(group.messages, (message) => {
        for (const member of group.members) {
          io.to(`user:${member}`).emit('reaction:updated', message);
        }
      });
    }
  });

  // WebRTC signaling for p2p audio calls
  socket.on('call:start', ({ to }) => {
    const from = socket.data.userCode;
    if (!from || !to || from === to) return;
    const callKey = privateKey(from, to);
    state.pendingPrivate.add(callKey);
    io.to(`user:${to}`).emit('call:incoming', { from });
  });

  socket.on('call:signal', ({ to, data }) => {
    const from = socket.data.userCode;
    io.to(`user:${to}`).emit('call:signal', { from, data });
  });

  socket.on('call:end', ({ to }) => {
    const from = socket.data.userCode;
    state.pendingPrivate.delete(privateKey(from, to));
    io.to(`user:${to}`).emit('call:ended', { from });
  });

  socket.on('disconnect', () => {
    const code = socket.data.userCode;
    if (code) state.onlineByCode.delete(code);
  });
});

server.listen(PORT, () => {
  console.log(`Server started on :${PORT}`);
});
