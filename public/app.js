const socket = io();

const state = {
  me: null,
  users: new Map(),
  groups: new Map(),
  activeChat: null,
  messages: new Map(),
  lastMessage: null,
  pendingFile: null,
  pc: null,
  localStream: null
};

const els = {
  myCode: document.getElementById('myCode'),
  nickname: document.getElementById('nickname'),
  saveNickname: document.getElementById('saveNickname'),
  themeSelect: document.getElementById('themeSelect'),
  contactCode: document.getElementById('contactCode'),
  addContact: document.getElementById('addContact'),
  contacts: document.getElementById('contacts'),
  groupName: document.getElementById('groupName'),
  createGroup: document.getElementById('createGroup'),
  groups: document.getElementById('groups'),
  chatTitle: document.getElementById('chatTitle'),
  messages: document.getElementById('messages'),
  messageInput: document.getElementById('messageInput'),
  fileInput: document.getElementById('fileInput'),
  sendBtn: document.getElementById('sendBtn'),
  audioCall: document.getElementById('audioCall'),
  forwardBtn: document.getElementById('forwardBtn')
};

const theme = localStorage.getItem('theme') || 'light';
document.documentElement.dataset.theme = theme;
els.themeSelect.value = theme;

els.themeSelect.addEventListener('change', () => {
  document.documentElement.dataset.theme = els.themeSelect.value;
  localStorage.setItem('theme', els.themeSelect.value);
});

function initAuth() {
  const code = localStorage.getItem('code');
  const nickname = localStorage.getItem('nickname') || '';
  socket.emit('auth', { code, nickname }, ({ user }) => {
    state.me = user;
    localStorage.setItem('code', user.code);
    els.myCode.textContent = `Ваш код: ${user.code}`;
    els.nickname.value = user.nickname;
    user.contacts.forEach((c) => state.users.set(c, { code: c, nickname: c }));
    renderContacts();
  });
}

function addMessage(msg) {
  const key = msg.chatType === 'group' ? `g:${msg.groupId}` : `p:${[msg.from, msg.to].sort().join(':')}`;
  if (!state.messages.has(key)) state.messages.set(key, []);
  const list = state.messages.get(key);
  const idx = list.findIndex((x) => x.id === msg.id);
  if (idx >= 0) list[idx] = msg;
  else list.push(msg);
  state.lastMessage = msg;

  if (state.activeChat?.key === key) renderMessages();
}

function renderContacts() {
  els.contacts.innerHTML = '';
  state.users.forEach((u, code) => {
    const li = document.createElement('li');
    li.innerHTML = `<button>${u.nickname || code} (${code})</button>`;
    li.onclick = () => openPrivate(code);
    els.contacts.appendChild(li);
  });
}

function renderGroups() {
  els.groups.innerHTML = '';
  state.groups.forEach((g, id) => {
    const li = document.createElement('li');
    li.innerHTML = `<button>${g.name}</button>`;
    li.onclick = () => openGroup(id);
    els.groups.appendChild(li);
  });
}

function renderMessages() {
  if (!state.activeChat) return;
  const list = state.messages.get(state.activeChat.key) || [];
  els.messages.innerHTML = '';

  list.forEach((msg) => {
    const div = document.createElement('div');
    div.className = 'msg';

    const reactions = Object.entries(msg.reactions || {})
      .filter(([, users]) => users.length)
      .map(([emoji, users]) => `${emoji} ${users.length}`)
      .join(' ');

    div.innerHTML = `
      <strong>${msg.from}</strong>
      <div>${msg.forwardedFrom ? `↪ переслано от ${msg.forwardedFrom}` : ''}</div>
      <div>${msg.text || ''}</div>
      <div>${msg.file ? `<a href="${msg.file.url}" target="_blank">📎 ${msg.file.name}</a>` : ''}</div>
      <small>${new Date(msg.createdAt).toLocaleString()}</small>
      <div class="reactions">${reactions}</div>
      <div class="actions">
        <button data-rxn="👍">👍</button>
        <button data-rxn="❤️">❤️</button>
        <button data-rxn="🔥">🔥</button>
      </div>
    `;

    div.querySelectorAll('button[data-rxn]').forEach((btn) => {
      btn.addEventListener('click', () => {
        socket.emit('reaction:set', {
          chatType: state.activeChat.type,
          messageId: msg.id,
          reaction: btn.dataset.rxn,
          peerCode: state.activeChat.peer,
          groupId: state.activeChat.groupId
        });
      });
    });

    els.messages.appendChild(div);
  });

  els.messages.scrollTop = els.messages.scrollHeight;
}

function openPrivate(code) {
  state.activeChat = { type: 'private', peer: code, key: `p:${[state.me.code, code].sort().join(':')}` };
  els.chatTitle.textContent = `Чат с ${code}`;
  socket.emit('private:history', { withCode: code }, ({ messages }) => {
    state.messages.set(state.activeChat.key, messages || []);
    renderMessages();
  });
}

function openGroup(groupId) {
  const g = state.groups.get(groupId);
  state.activeChat = { type: 'group', groupId, key: `g:${groupId}` };
  els.chatTitle.textContent = `Группа: ${g.name}`;
  socket.emit('group:history', { groupId }, ({ group }) => {
    state.messages.set(state.activeChat.key, group.messages || []);
    renderMessages();
  });
}

els.saveNickname.onclick = () => {
  const nickname = els.nickname.value.trim();
  localStorage.setItem('nickname', nickname);
  socket.emit('update:nickname', { nickname });
};

els.addContact.onclick = () => {
  const targetCode = els.contactCode.value.trim().toUpperCase();
  socket.emit('contact:add', { targetCode }, (res) => {
    if (!res.ok) return alert(res.error);
    state.users.set(res.target.code, res.target);
    renderContacts();
    els.contactCode.value = '';
  });
};

els.createGroup.onclick = () => {
  const name = els.groupName.value.trim() || 'Новая группа';
  const members = Array.from(state.users.keys());
  socket.emit('group:create', { name, members }, ({ groupId }) => {
    state.groups.set(groupId, { id: groupId, name, members });
    renderGroups();
    els.groupName.value = '';
  });
};

els.fileInput.onchange = async () => {
  const file = els.fileInput.files[0];
  if (!file) return;
  const fd = new FormData();
  fd.append('file', file);
  const res = await fetch('/api/upload', { method: 'POST', body: fd });
  if (!res.ok) return alert('Ошибка загрузки файла');
  state.pendingFile = await res.json();
};

els.sendBtn.onclick = () => {
  if (!state.activeChat) return alert('Выберите чат');
  const text = els.messageInput.value;
  const payload = { text, file: state.pendingFile };

  if (state.activeChat.type === 'private') {
    socket.emit('private:send', { ...payload, to: state.activeChat.peer });
  } else {
    socket.emit('group:send', { ...payload, groupId: state.activeChat.groupId });
  }

  els.messageInput.value = '';
  els.fileInput.value = '';
  state.pendingFile = null;
};

els.forwardBtn.onclick = () => {
  if (!state.lastMessage || !state.activeChat) return;
  const payload = {
    text: state.lastMessage.text,
    file: state.lastMessage.file,
    forwardedFrom: state.lastMessage.from
  };
  if (state.activeChat.type === 'private') {
    socket.emit('private:send', { ...payload, to: state.activeChat.peer });
  } else {
    socket.emit('group:send', { ...payload, groupId: state.activeChat.groupId });
  }
};

socket.on('contact:added', ({ by }) => {
  state.users.set(by.code, by);
  renderContacts();
});

socket.on('group:created', (group) => {
  state.groups.set(group.id, group);
  renderGroups();
});

socket.on('private:message', addMessage);
socket.on('group:message', addMessage);
socket.on('reaction:updated', addMessage);

// P2P audio calls
els.audioCall.onclick = async () => {
  if (!state.activeChat || state.activeChat.type !== 'private') return alert('Звонки только для личного чата');
  await startAudio(state.activeChat.peer, true);
};

socket.on('call:incoming', async ({ from }) => {
  if (!confirm(`Входящий аудио звонок от ${from}. Принять?`)) {
    socket.emit('call:end', { to: from });
    return;
  }
  await startAudio(from, false);
});

socket.on('call:signal', async ({ from, data }) => {
  if (!state.pc) await startAudio(from, false);
  if (data.sdp) {
    await state.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === 'offer') {
      const answer = await state.pc.createAnswer();
      await state.pc.setLocalDescription(answer);
      socket.emit('call:signal', { to: from, data: { sdp: state.pc.localDescription } });
    }
  }
  if (data.candidate) {
    await state.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
  }
});

socket.on('call:ended', () => {
  stopAudio();
  alert('Звонок завершен');
});

async function startAudio(peer, isCaller) {
  state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  state.pc = new RTCPeerConnection();

  state.localStream.getTracks().forEach((track) => state.pc.addTrack(track, state.localStream));

  state.pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit('call:signal', { to: peer, data: { candidate: e.candidate } });
  };

  state.pc.ontrack = (e) => {
    const audio = new Audio();
    audio.srcObject = e.streams[0];
    audio.play().catch(() => {});
  };

  if (isCaller) {
    socket.emit('call:start', { to: peer });
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    socket.emit('call:signal', { to: peer, data: { sdp: state.pc.localDescription } });
  }
}

function stopAudio() {
  if (state.pc) {
    state.pc.close();
    state.pc = null;
  }
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
}

initAuth();
