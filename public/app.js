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
  localStream: null,
  remoteAudio: null,
  callPeer: null,
  incomingFrom: null
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
  forwardBtn: document.getElementById('forwardBtn'),
  profileName: document.getElementById('profileName'),
  profileCode: document.getElementById('profileCode'),
  tabs: document.getElementById('tabs'),
  incomingCallModal: document.getElementById('incomingCallModal'),
  incomingCallText: document.getElementById('incomingCallText'),
  acceptCall: document.getElementById('acceptCall'),
  rejectCall: document.getElementById('rejectCall')
};

const theme = localStorage.getItem('theme') || 'dark';
document.documentElement.dataset.theme = theme;
els.themeSelect.value = theme;

els.themeSelect.addEventListener('change', () => {
  document.documentElement.dataset.theme = els.themeSelect.value;
  localStorage.setItem('theme', els.themeSelect.value);
});

els.tabs.addEventListener('click', (event) => {
  const tabButton = event.target.closest('.tab');
  if (!tabButton) return;
  document.querySelectorAll('.tab').forEach((tab) => tab.classList.remove('active'));
  tabButton.classList.add('active');
  const name = tabButton.dataset.tab;
  document.querySelectorAll('.tab-pane').forEach((pane) => {
    pane.classList.toggle('active', pane.dataset.pane === name);
  });
});

function initAuth() {
  const code = localStorage.getItem('code');
  const nickname = localStorage.getItem('nickname') || '';

  socket.emit('auth', { code, nickname }, ({ user }) => {
    state.me = user;
    localStorage.setItem('code', user.code);
    els.myCode.textContent = `Код: ${user.code}`;
    els.nickname.value = user.nickname;
    els.profileName.textContent = user.nickname || `User-${user.code}`;
    els.profileCode.textContent = `Код: ${user.code}`;

    user.contacts.forEach((c) => state.users.set(c, { code: c, nickname: c }));
    user.groups.forEach((groupId) => state.groups.set(groupId, { id: groupId, name: `Group ${groupId}` }));

    renderContacts();
    renderGroups();
  });
}

function chatKeyFromMessage(msg) {
  return msg.chatType === 'group' ? `g:${msg.groupId}` : `p:${[msg.from, msg.to].sort().join(':')}`;
}

function addMessage(msg) {
  const key = chatKeyFromMessage(msg);
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
  const sorted = Array.from(state.users.values()).sort((a, b) => (a.nickname || a.code).localeCompare(b.nickname || b.code));
  sorted.forEach((u) => {
    const li = document.createElement('li');
    li.innerHTML = `<button>${u.nickname || u.code} <small>(${u.code})</small></button>`;
    li.onclick = () => openPrivate(u.code);
    els.contacts.appendChild(li);
  });
}

function renderGroups() {
  els.groups.innerHTML = '';
  Array.from(state.groups.values()).forEach((g) => {
    const li = document.createElement('li');
    li.innerHTML = `<button>${g.name}</button>`;
    li.onclick = () => openGroup(g.id);
    els.groups.appendChild(li);
  });
}

function renderMessages() {
  if (!state.activeChat) return;
  const list = state.messages.get(state.activeChat.key) || [];
  els.messages.innerHTML = '';

  list.forEach((msg) => {
    const div = document.createElement('div');
    const isMine = msg.from === state.me.code;
    div.className = `msg ${isMine ? 'mine' : ''}`;

    const reactions = Object.entries(msg.reactions || {})
      .filter(([, users]) => users.length)
      .map(([emoji, users]) => `${emoji} ${users.length}`)
      .join(' · ');

    div.innerHTML = `
      <strong>${msg.from}</strong>
      <div class="forward">${msg.forwardedFrom ? `↪ переслано от ${msg.forwardedFrom}` : ''}</div>
      <div>${msg.text || ''}</div>
      <div>${msg.file ? `<a href="${msg.file.url}" target="_blank">📎 ${msg.file.name}</a>` : ''}</div>
      <div class="meta">${new Date(msg.createdAt).toLocaleString()}</div>
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
  const user = state.users.get(code);
  els.chatTitle.textContent = `Чат с ${user?.nickname || code}`;
  socket.emit('private:history', { withCode: code }, ({ messages }) => {
    state.messages.set(state.activeChat.key, messages || []);
    renderMessages();
  });
}

function openGroup(groupId) {
  const g = state.groups.get(groupId);
  state.activeChat = { type: 'group', groupId, key: `g:${groupId}` };
  els.chatTitle.textContent = `Группа: ${g?.name || groupId}`;
  socket.emit('group:history', { groupId }, ({ group }) => {
    state.messages.set(state.activeChat.key, group?.messages || []);
    renderMessages();
  });
}

els.saveNickname.onclick = () => {
  const nickname = els.nickname.value.trim();
  localStorage.setItem('nickname', nickname);
  socket.emit('update:nickname', { nickname }, (res) => {
    if (res?.ok) {
      state.me = res.user;
      els.profileName.textContent = res.user.nickname || res.user.code;
    }
  });
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
  const text = els.messageInput.value.trim();
  if (!text && !state.pendingFile) return;
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

function showIncomingModal(from) {
  state.incomingFrom = from;
  els.incomingCallText.textContent = `${from} звонит вам`;
  els.incomingCallModal.classList.remove('hidden');
}

function hideIncomingModal() {
  state.incomingFrom = null;
  els.incomingCallModal.classList.add('hidden');
}

els.acceptCall.onclick = async () => {
  if (!state.incomingFrom) return;
  const caller = state.incomingFrom;
  hideIncomingModal();
  await startAudio(caller, false);
};

els.rejectCall.onclick = () => {
  if (state.incomingFrom) {
    socket.emit('call:end', { to: state.incomingFrom });
  }
  hideIncomingModal();
};

els.audioCall.onclick = async () => {
  if (!state.activeChat || state.activeChat.type !== 'private') return alert('Звонки только в личном чате');
  await startAudio(state.activeChat.peer, true);
};

socket.on('call:incoming', ({ from }) => {
  showIncomingModal(from);
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
    try {
      await state.pc.addIceCandidate(new RTCIceCandidate(data.candidate));
    } catch (error) {
      console.error('ICE candidate error', error);
    }
  }
});

socket.on('call:ended', ({ from }) => {
  if (state.incomingFrom === from) hideIncomingModal();
  stopAudio();
  alert('Звонок завершён');
});

async function startAudio(peer, isCaller) {
  state.callPeer = peer;
  if (!state.localStream) {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  }

  if (state.pc) {
    state.pc.close();
  }

  state.pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  state.localStream.getTracks().forEach((track) => state.pc.addTrack(track, state.localStream));

  state.pc.onicecandidate = (e) => {
    if (e.candidate && state.callPeer) {
      socket.emit('call:signal', { to: state.callPeer, data: { candidate: e.candidate } });
    }
  };

  state.pc.ontrack = (e) => {
    if (!state.remoteAudio) {
      state.remoteAudio = document.createElement('audio');
      state.remoteAudio.autoplay = true;
      state.remoteAudio.playsInline = true;
      document.body.appendChild(state.remoteAudio);
    }
    state.remoteAudio.srcObject = e.streams[0];
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
    state.localStream.getTracks().forEach((track) => track.stop());
    state.localStream = null;
  }
  if (state.remoteAudio) {
    state.remoteAudio.srcObject = null;
    state.remoteAudio.remove();
    state.remoteAudio = null;
  }
  state.callPeer = null;
}

initAuth();
