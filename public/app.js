const socket = window.io();
const homeScreen = document.querySelector('#home-screen');
const roomScreen = document.querySelector('#room-screen');
const nameInput = document.querySelector('#player-name');
const codeInput = document.querySelector('#room-code');
const homeError = document.querySelector('#home-error');
const toast = document.querySelector('#toast');
const timerEnabledInput = document.querySelector('#timer-enabled');
const timerDurationInput = document.querySelector('#timer-duration');
const gameModeInput = document.querySelector('#game-mode');
const gameModeLabels = {
  classic: 'Cổ điển',
  random: 'Ngẫu nhiên',
  emoji: 'Emoji',
  splash: 'Splash',
  quote: 'Câu gợi ý',
  ability: 'Kỹ năng',
};
const clueStatusIndicators = {
  correct: ['✓', 'Đúng'],
  wrong: ['✗', 'Sai'],
  partial: ['?', 'Gần đúng'],
  unknown: ['?', 'Chưa rõ'],
  higher: ['↑', 'Mục tiêu có năm ra mắt cao hơn'],
  lower: ['↓', 'Mục tiêu có năm ra mắt thấp hơn'],
};
let champions = [];
let roomState = null;
let toastTimer;
let timerInterval;
let reconnectingRoom = false;
let roomJoinPending = false;
let reconnectAttempts = 0;
let reconnectRetryTimer;
let roomJoinAttempt = 0;

const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function showHomeError(message = '') {
  homeError.textContent = message;
}

function getName() {
  return nameInput.value.trim();
}

function emitWithAck(eventName, payload, onSuccess) {
  socket.emit(eventName, payload, (response) => {
    if (!response?.ok) {
      if (!roomState) showHomeError(response?.error ?? 'Đã xảy ra lỗi, hãy thử lại.');
      else showToast(response?.error ?? 'Đã xảy ra lỗi, hãy thử lại.');
      return;
    }
    if (!roomState) showHomeError();
    onSuccess?.(response);
  });
}

function enterRoom(room) {
  roomJoinAttempt += 1;
  reconnectingRoom = false;
  roomJoinPending = false;
  reconnectAttempts = 0;
  clearTimeout(reconnectRetryTimer);
  reconnectRetryTimer = null;
  roomState = room;
  showHomeError();
  homeScreen.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  renderRoom();
}

function returnToHome(code, name) {
  roomJoinAttempt += 1;
  clearTimeout(reconnectRetryTimer);
  reconnectRetryTimer = null;
  reconnectingRoom = false;
  roomJoinPending = false;
  reconnectAttempts = 0;
  clearInterval(timerInterval);
  timerInterval = null;
  roomState = null;
  nameInput.value = name;
  codeInput.value = code;
  homeScreen.classList.remove('hidden');
  roomScreen.classList.add('hidden');
  showHomeError();
}

function reconnectToRoom() {
  if (!reconnectingRoom || !roomState || !socket.connected || roomJoinPending) return;
  clearTimeout(reconnectRetryTimer);
  reconnectRetryTimer = null;
  const self = roomState.players.find((player) => player.isSelf);
  if (!self) {
    const code = roomState.code;
    returnToHome(code, nameInput.value);
    return showHomeError('Không tìm thấy thông tin để kết nối lại phòng. Hãy vào lại bằng mã phòng.');
  }

  roomJoinPending = true;
  const code = roomState.code;
  const attempt = ++roomJoinAttempt;
  socket.timeout(5000).emit('room:join', { name: self.name, code }, (error, response) => {
    if (attempt !== roomJoinAttempt) return;
    roomJoinPending = false;
    if (!error && response?.ok) {
      enterRoom(response.room);
      showToast('Đã kết nối lại phòng.');
      return;
    }

    if (reconnectAttempts < 10 && (error || response?.error === 'Phòng đã đủ 2 người chơi.')) {
      reconnectAttempts += 1;
      reconnectRetryTimer = setTimeout(() => {
        reconnectRetryTimer = null;
        reconnectToRoom();
      }, 500);
      return;
    }

    returnToHome(code, self.name);
    showHomeError(response?.error ?? 'Không thể kết nối lại phòng. Hãy thử vào lại bằng mã phòng.');
  });
}

document.querySelector('#create-room').addEventListener('click', () => {
  showHomeError();
  const timerSeconds = timerEnabledInput.checked ? Number(timerDurationInput.value) : 0;
  emitWithAck('room:create', {
    name: getName(),
    timerSeconds,
    gameMode: gameModeInput.value,
  }, ({ room }) => enterRoom(room));
});

document.querySelector('#join-room').addEventListener('click', () => {
  showHomeError();
  emitWithAck('room:join', { name: getName(), code: codeInput.value }, ({ room }) => enterRoom(room));
});

timerEnabledInput.addEventListener('change', () => {
  timerDurationInput.disabled = !timerEnabledInput.checked;
});

codeInput.addEventListener('input', () => {
  codeInput.value = codeInput.value.replace(/[^a-z0-9]/gi, '').toUpperCase().slice(0, 5);
});

socket.on('room:state', (state) => {
  roomState = state;
  homeScreen.classList.add('hidden');
  roomScreen.classList.remove('hidden');
  renderRoom();
});

socket.on('disconnect', () => {
  if (!roomState) return;
  roomJoinAttempt += 1;
  reconnectingRoom = true;
  reconnectAttempts = 0;
  roomJoinPending = false;
  clearTimeout(reconnectRetryTimer);
  reconnectRetryTimer = null;
  showToast('Mất kết nối. Đang thử kết nối lại phòng…');
});

socket.on('connect', () => {
  if (!reconnectingRoom) return;
  showToast('Đang kết nối lại phòng…');
  reconnectToRoom();
});

socket.on('room:chat-message', (message) => {
  if (!roomState) return;
  roomState.chatMessages ??= [];
  if (roomState.chatMessages.some((existing) => existing.id === message.id)) return;
  roomState.chatMessages.push(message);
  renderChatMessages();
});

socket.on('connect_error', () => {
  if (roomState) showToast('Mất kết nối. Đang thử kết nối lại phòng…');
  else showHomeError('Không thể kết nối máy chủ trò chơi. Hãy tải lại trang.');
});

function playerById(id) {
  return roomState.players.find((player) => player.id === id);
}

function setPickerOpen(wrapper, isOpen) {
  const input = wrapper.querySelector('input');
  const list = wrapper.querySelector('.champion-suggestions');
  wrapper.classList.toggle('is-open', isOpen);
  list.hidden = !isOpen;
  input.setAttribute('aria-expanded', String(isOpen));
  if (!isOpen) input.removeAttribute('aria-activedescendant');
}

function renderChampionSuggestions(input, list, activeIndex = -1) {
  input.removeAttribute('aria-activedescendant');
  const query = input.value.trim().toLocaleLowerCase();
  const matchingChampions = champions
    .filter((champion) => `${champion.name} ${champion.title} ${(champion.tags ?? []).join(' ')}`
      .toLocaleLowerCase()
      .includes(query));
  const alreadyGuessedIds = new Set(roomState?.log.map((entry) => entry.championId).filter(Boolean));
  const matches = matchingChampions
    .filter((champion) => !alreadyGuessedIds.has(champion.id))
    .slice(0, 8);

  if (!matches.length) {
    const message = matchingChampions.length
      ? 'Tướng này đã được đoán trong ván đấu.'
      : 'Không tìm thấy tướng phù hợp.';
    list.innerHTML = `<div class="champion-empty">${message}</div>`;
    input.removeAttribute('aria-activedescendant');
    return matches;
  }

  list.innerHTML = matches.map((champion, index) => {
    const optionId = `${input.id}-option-${index}`;
    if (index === activeIndex) input.setAttribute('aria-activedescendant', optionId);
    return `<button id="${optionId}" class="champion-option${index === activeIndex ? ' active' : ''}" type="button" role="option" aria-selected="${index === activeIndex}" data-index="${index}">
      <span class="champion-option-copy"><span class="champion-option-name">${escapeHtml(champion.name)}</span><span class="champion-option-title">${escapeHtml(champion.title)}</span></span>
      <span class="champion-option-tags">${escapeHtml((champion.tags ?? []).join(' · '))}</span>
    </button>`;
  }).join('');
  return matches;
}

function setupChampionPicker(inputId, onSelect) {
  const input = document.querySelector(`#${inputId}`);
  if (!input) return;
  const wrapper = input.closest('.champion-picker');
  const list = wrapper.querySelector('.champion-suggestions');
  let matches = [];
  let activeIndex = -1;

  const open = () => {
    matches = renderChampionSuggestions(input, list, activeIndex);
    setPickerOpen(wrapper, true);
  };
  const choose = (champion) => {
    input.value = champion.name;
    setPickerOpen(wrapper, false);
    onSelect(champion);
  };

  input.addEventListener('focus', () => {
    activeIndex = -1;
    open();
  });
  input.addEventListener('input', () => {
    activeIndex = -1;
    open();
  });
  input.addEventListener('blur', () => {
    setTimeout(() => {
      if (!wrapper.contains(document.activeElement)) setPickerOpen(wrapper, false);
    }, 0);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      setPickerOpen(wrapper, false);
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) open();
      if (!matches.length) return;
      const direction = event.key === 'ArrowDown' ? 1 : -1;
      activeIndex = activeIndex < 0
        ? direction > 0 ? 0 : matches.length - 1
        : (activeIndex + direction + matches.length) % matches.length;
      matches = renderChampionSuggestions(input, list, activeIndex);
      return;
    }
    if (event.key === 'Enter' && !list.hidden) {
      event.preventDefault();
      const exactMatch = matches.find((champion) => champion.name.toLocaleLowerCase() === input.value.trim().toLocaleLowerCase());
      const selected = matches[activeIndex] ?? exactMatch;
      if (selected) choose(selected);
    }
  });
  list.addEventListener('mousedown', (event) => event.preventDefault());
  list.addEventListener('click', (event) => {
    const option = event.target.closest('[data-index]');
    if (!option) return;
    const selected = matches[Number(option.dataset.index)];
    if (selected) choose(selected);
  });
}

document.addEventListener('pointerdown', (event) => {
  const openPicker = document.querySelector('.champion-picker.is-open');
  if (openPicker && !openPicker.contains(event.target)) setPickerOpen(openPicker, false);
});

function updateTimerDisplay() {
  const timer = document.querySelector('#turn-timer');
  if (!timer || !roomState?.turnExpiresAt) return;
  const seconds = Math.max(0, Math.ceil((roomState.turnExpiresAt - Date.now()) / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = String(seconds % 60).padStart(2, '0');
  timer.textContent = `⏱ ${String(minutes).padStart(2, '0')}:${remainder}`;
  timer.classList.toggle('urgent', seconds <= 10);
  timer.setAttribute('aria-label', `Còn ${seconds} giây`);
}

function playerCard(player, active, isPlaying) {
  if (!player) {
    return `<div class="player-card"><span class="player-avatar">?</span><div class="player-info"><div class="player-name">Đang chờ đối thủ</div><div class="player-meta">CHƯA KẾT NỐI</div></div></div>`;
  }
  const ownChampion = player.ownChampion ? ` · ${escapeHtml(player.ownChampion)}` : '';
  const meta = player.ready ? `SẴN SÀNG${ownChampion}` : 'ĐANG CHUẨN BỊ';
  const initial = escapeHtml(player.name.slice(0, 1).toUpperCase());
  const turnBadge = isPlaying
    ? `<span class="player-turn-badge${active ? ' active' : ''}">${active ? 'ĐẾN LƯỢT' : 'ĐANG CHỜ'}</span>`
    : '';
  return `<div class="player-card${active ? ' active' : ''}">
    <span class="player-avatar">${initial}</span>
    <div class="player-info"><div class="player-heading"><div class="player-name">${escapeHtml(player.name)}</div>${turnBadge}</div><div class="player-meta">${meta}</div></div>
  </div>`;
}

function renderLog() {
  if (!roomState.log.length) {
    return '<div class="empty-history">Các lượt đoán và manh mối sẽ xuất hiện ở đây.<br>Hãy chọn tướng bí mật để bắt đầu.</div>';
  }
  return roomState.log.slice().reverse().map((entry) => {
    if (entry.type === 'timeout') {
      return `<article class="guess-timeout"><span class="guess-timeout-mark">⏱</span><span><strong>${escapeHtml(entry.playerName)}</strong> hết giờ — lượt được tự động bỏ qua.</span></article>`;
    }
    const clues = entry.clues.map((clue) => {
      const [symbol, description] = clueStatusIndicators[clue.status] ?? clueStatusIndicators.unknown;
      return `<div class="clue"><span class="clue-label">${escapeHtml(clue.label)}</span><span class="clue-value">${escapeHtml(clue.value)}</span><span class="clue-symbol" role="img" aria-label="${escapeHtml(description)}">${escapeHtml(symbol)}</span></div>`;
    }).join('');
    const clueGrid = ['classic', 'random'].includes(roomState.gameMode) ? `<div class="clue-grid">${clues}</div>` : '';
    return `<article class="guess-entry${clueGrid ? '' : ' no-clues'}">
      <div><div class="guess-author">${escapeHtml(entry.playerName)} đoán</div><div class="guess-champion-row"><span class="guess-champion">${escapeHtml(entry.championName)}${entry.isCorrect ? ' ✓' : ''}</span></div></div>
      ${clueGrid}
    </article>`;
  }).join('');
}

function renderSkillHints(abilities, label = 'GỢI Ý KỸ NĂNG', colorRevealed = true) {
  if (!abilities?.length) return '';
  return `<section class="mode-hint"><div class="mode-hint-label">${label}</div><div class="mode-abilities">${abilities.map((ability) => `<div class="mode-ability"><img class="mode-hint-image${colorRevealed ? '' : ' mode-ability-obscured'}" src="${escapeHtml(ability.imageUrl)}" alt="Kỹ năng ${escapeHtml(ability.key)}"><span>${escapeHtml(ability.key)}</span></div>`).join('')}</div></section>`;
}

function renderModeHint(hint, revealedSkillHints = [], wrongGuessCount = 0, abilityColorRevealed = false) {
  if (!hint) return '';
  if (hint.kind === 'emoji') {
    return `<section class="mode-hint"><div class="mode-hint-label">GỢI Ý EMOJI</div><div class="mode-emojis">${hint.emojis.map(escapeHtml).join(' ')}</div></section>`;
  }
  if (hint.kind === 'splash') {
    const zoom = Math.max(1, 3 - wrongGuessCount / 3);
    const cropX = Number.isFinite(hint.cropX) ? hint.cropX : 50;
    const cropY = Number.isFinite(hint.cropY) ? hint.cropY : 50;
    return `<section class="mode-hint"><div class="mode-hint-label">GỢI Ý SPLASH</div><div class="mode-splash-frame"><img class="mode-hint-image mode-splash" src="${escapeHtml(hint.imageUrl)}" style="--splash-x:${cropX}%;--splash-y:${cropY}%;--splash-zoom:${zoom}" alt="Gợi ý splash art của đối thủ"></div></section>`;
  }
  if (hint.kind === 'quote') {
    return `<section class="mode-hint"><div class="mode-hint-label">CÂU GỢI Ý TỰ TẠO</div><p class="mode-quote">${escapeHtml(hint.text)}</p></section>`;
  }
  if (hint.kind === 'ability') {
    return renderSkillHints(revealedSkillHints.length ? revealedSkillHints : hint.abilities, 'GỢI Ý KỸ NĂNG', abilityColorRevealed);
  }
  return '';
}

function chatMessageMarkup(message) {
  const self = roomState.players.find((player) => player.isSelf);
  const isSelf = message.playerId === self?.id;
  const time = new Date(message.createdAt).toLocaleTimeString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `<article class="chat-message${isSelf ? ' own' : ''}">
    <div class="chat-message-meta"><span>${isSelf ? 'Bạn' : escapeHtml(message.playerName)}</span><time>${time}</time></div>
    <div class="chat-bubble">${escapeHtml(message.text)}</div>
  </article>`;
}

function renderChatMessages() {
  const list = document.querySelector('#chat-messages');
  if (!list || !roomState) return;
  const messages = roomState.chatMessages ?? [];
  list.innerHTML = messages.length
    ? messages.map(chatMessageMarkup).join('')
    : '<div class="chat-empty">Chưa có tin nhắn.<br>Hãy bắt đầu trò chuyện với đối thủ.</div>';
  list.scrollTop = list.scrollHeight;
}

function setupChat() {
  const form = document.querySelector('#chat-form');
  const input = document.querySelector('#chat-input');
  const counter = document.querySelector('#chat-counter');
  if (!form || !input || !counter) return;

  const updateCounter = () => {
    chatDraft = input.value;
    counter.textContent = `${input.value.length}/500`;
  };
  input.value = chatDraft;
  updateCounter();
  input.addEventListener('input', updateCounter);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    emitWithAck('room:chat:send', { text }, () => {
      chatDraft = '';
      const currentInput = document.querySelector('#chat-input');
      const currentCounter = document.querySelector('#chat-counter');
      if (currentInput) currentInput.value = '';
      if (currentCounter) currentCounter.textContent = '0/500';
      currentInput?.focus();
    });
  });
}

let chatDraft = '';
let privateNote = '';
let privateNoteScope = '';

function renderRoom() {
  if (!roomState) return;
  clearInterval(timerInterval);
  const self = roomState.players.find((player) => player.isSelf);
  const nextPrivateNoteScope = `${roomState.code}:${self?.id ?? ''}`;
  if (privateNoteScope !== nextPrivateNoteScope) {
    privateNoteScope = nextPrivateNoteScope;
    privateNote = '';
  }
  const opponent = roomState.players.find((player) => !player.isSelf);
  const isClassic = roomState.gameMode === 'classic';
  const isPlaying = roomState.phase === 'playing';
  const isMyTurn = isPlaying && roomState.turnPlayerId === self?.id;
  const winner = playerById(roomState.winnerId);
  const gameModeLabel = gameModeLabels[roomState.gameMode] ?? gameModeLabels.classic;
  const revealedSkillHints = roomState.revealedSkillHints ?? [];
  const wrongGuessCount = roomState.log.filter((entry) => entry.championId && !entry.isCorrect).length;
  const modeHintMarkup = isPlaying
    ? `${renderModeHint(roomState.modeHint, revealedSkillHints, wrongGuessCount, roomState.abilityColorRevealed)}${roomState.gameMode === 'ability' ? '' : renderSkillHints(revealedSkillHints, 'KỸ NĂNG ĐÃ MỞ')}`
    : '';
  let mainContent = '';
  if (roomState.phase === 'lobby') {
    const readyLabel = self?.ready ? 'Hủy sẵn sàng' : 'Sẵn sàng';
    const waitText = roomState.players.length < 2
      ? 'Gửi mã phòng cho đối thủ để cùng bắt đầu.'
      : self?.ready && opponent?.ready
        ? 'Đang bắt đầu ván đấu…'
        : isClassic
          ? 'Cả hai người chơi cần chọn tướng riêng và sẵn sàng.'
          : 'Cả hai người chơi cần sẵn sàng; máy sẽ chọn một tướng chung.';
    const readyButton = `<button id="ready-button" class="button ${self?.ready ? 'button-secondary' : 'button-primary'} ready-button" ${roomState.players.length < 2 || (isClassic && !self?.ownChampion) ? 'disabled' : ''}>${readyLabel}</button>`;
    const lobbyControls = isClassic
      ? `<div class="champion-select-row">
          <div class="champion-picker">
            <input id="secret-champion" class="text-input" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="secret-champion-list" placeholder="Tìm tướng theo tên..." autocomplete="off" value="${escapeHtml(self?.ownChampion ?? '')}" ${self?.ready ? 'disabled' : ''}>
            <div id="secret-champion-list" class="champion-suggestions" role="listbox" hidden></div>
          </div>
          ${readyButton}
        </div>`
      : `<p class="lobby-mode-note">Hai người sẽ lần lượt đoán cùng một vị tướng do máy chọn ngẫu nhiên.</p>${readyButton}`;
    mainContent = `<section class="lobby-pick">
      <h3>${isClassic ? 'Chọn tướng bí mật' : 'Sẵn sàng bắt đầu'}</h3>
      <p>${isClassic ? 'Đối thủ sẽ đoán tướng này. Lựa chọn chỉ hiển thị với bạn cho đến khi ván kết thúc.' : `Mode ${escapeHtml(gameModeLabel)} không cần chọn tướng bí mật.`}</p>
      ${lobbyControls}
      <div class="lobby-wait">${waitText}</div>
    </section>`;
  } else if (isPlaying) {
    const currentPlayer = playerById(roomState.turnPlayerId);
    const turnPrompt = isClassic ? 'Hãy đoán tướng của đối thủ.' : 'Hãy đoán tướng bí mật.';
    const revealedSkillCount = revealedSkillHints.length;
    const hintAttemptsRemaining = Math.max(0, (roomState.nextHintAt ?? 7) - (roomState.wrongGuessCount ?? 0));
    const hintButtonLabel = roomState.gameMode === 'ability'
      ? roomState.abilityColorRevealed
        ? 'Đã mở màu kỹ năng'
        : roomState.hintAvailable
          ? 'Mở màu kỹ năng'
          : `Mở màu sau ${hintAttemptsRemaining} lượt đoán sai nữa`
      : revealedSkillCount >= 4
        ? 'Đã mở đủ 4 kỹ năng'
        : roomState.hintAvailable
          ? 'Mở thêm 1 kỹ năng'
          : `Gợi ý sau ${hintAttemptsRemaining} lượt đoán sai nữa`;
    const hintButton = !isClassic
      ? `<button id="hint-button" class="button button-secondary hint-button" ${roomState.hintAvailable ? '' : 'disabled'}>${escapeHtml(hintButtonLabel)}</button>`
      : '';
    const timerLabel = roomState.timerSeconds
      ? `<span class="turn-timer" id="turn-timer" aria-label="Thời gian còn lại"></span>`
      : '<span class="turn-timer">⏱ Không giới hạn</span>';
    mainContent = `<div class="turn-banner ${isMyTurn ? '' : 'waiting'}"><span class="turn-indicator"></span><span class="turn-banner-message">${isMyTurn ? `<strong>Đến lượt bạn.</strong> ${turnPrompt}` : `Đang chờ ${escapeHtml(currentPlayer?.name ?? 'đối thủ')} đoán.`}</span>${timerLabel}</div>
      <section class="guess-area">
        <h3>Đoán một vị tướng</h3>
        <p>Chọn một cái tên trong danh sách. Dùng ↑/↓ để chọn, Enter để xác nhận; nhấn Enter lần nữa để đoán.</p>
        <div class="champion-select-row">
          <div class="champion-picker">
            <input id="guess-champion" class="text-input" role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded="false" aria-controls="guess-champion-list" placeholder="Nhập tên tướng..." autocomplete="off" ${isMyTurn ? '' : 'disabled'}>
            <div id="guess-champion-list" class="champion-suggestions" role="listbox" hidden></div>
          </div>
          <button id="guess-button" class="button button-primary" ${isMyTurn ? '' : 'disabled'}>Đoán tướng <span>→</span></button>
        </div>
        ${hintButton}
      </section>`;
  } else {
    mainContent = `<div class="result-banner">
        <h2>${winner?.isSelf ? 'Bạn đã đoán đúng!' : `${escapeHtml(winner?.name ?? 'Đối thủ')} đã chiến thắng!`}</h2>
        <p>Đáp án đã được hé lộ. Sẵn sàng cho một ván mới?</p>
        <div class="revealed">${(roomState.revealedTargets ?? []).map((item) => `<span>${escapeHtml(item.name)}: <strong>${escapeHtml(item.champion)}</strong></span>`).join('')}</div>
        <button id="rematch-button" class="button button-primary rematch-button">Chơi ván mới</button>
      </div>`;
  }

  roomScreen.innerHTML = `<header class="room-head">
      <div><p class="room-caption">BÀN ĐẤU RIÊNG · ${roomState.players.length}/2 NGƯỜI</p><h1 class="room-title">${roomState.phase === 'lobby' ? 'Chuẩn bị vào trận' : roomState.phase === 'playing' ? 'Ván đấu đang diễn ra' : 'Kết thúc ván đấu'}</h1></div>
      <div class="room-code-box"><div><small>MÃ PHÒNG · GỬI CHO BẠN</small><span class="room-code">${escapeHtml(roomState.code)}</span></div><button id="copy-code" class="copy-button">Sao chép</button><button id="leave-room" class="copy-button" type="button">Rời phòng</button></div>
    </header>
    <div class="room-grid">
      <section class="panel game-panel">
        <div class="section-kicker">NGƯỜI CHƠI · MODE ${escapeHtml(gameModeLabel.toLocaleUpperCase())}</div>
        <div class="players-row">${playerCard(self, roomState.turnPlayerId === self?.id, isPlaying)}<span class="versus">VS</span>${playerCard(opponent, roomState.turnPlayerId === opponent?.id, isPlaying)}</div>
        ${modeHintMarkup}
        ${mainContent}
        <div class="history-head"><h3>Lịch sử đoán</h3><span class="guess-count">${roomState.log.length} LƯỢT</span></div>
        <div class="history-list">${renderLog()}</div>
      </section>
      <aside class="side-stack">
        <section class="private-note-panel">
          <div class="private-note-heading">
            <div><label for="private-note">Ghi chú riêng</label><small>Chỉ bạn thấy trên thiết bị này</small></div>
            <button id="clear-note" class="copy-button" type="button">Xóa</button>
          </div>
          <textarea id="private-note" class="text-input private-note-input" rows="4" placeholder="Ghi lại suy luận về vị tướng...">${escapeHtml(privateNote)}</textarea>
        </section>
        <section class="panel chat-panel">
          <div class="chat-heading">
            <div><h2>Trò chuyện</h2><p>Chỉ người trong phòng đọc được.</p></div>
            <span class="chat-room-tag">PHÒNG RIÊNG</span>
          </div>
          <div id="chat-messages" class="chat-messages" role="log" aria-live="polite" aria-relevant="additions text"></div>
          <form id="chat-form" class="chat-form">
            <textarea id="chat-input" class="text-input chat-input" maxlength="500" rows="2" placeholder="Nhắn tin cho đối thủ..." aria-label="Tin nhắn"></textarea>
            <button type="submit" class="button button-primary chat-send" aria-label="Gửi tin nhắn">➤</button>
          </form>
          <div class="chat-footer"><span>Enter gửi · Shift+Enter xuống dòng</span><span id="chat-counter">0/500</span></div>
        </section>
      </aside>
    </div>`;

  const privateNoteInput = roomScreen.querySelector('#private-note');
  privateNoteInput.addEventListener('input', () => {
    privateNote = privateNoteInput.value;
  });
  roomScreen.querySelector('#clear-note').addEventListener('click', () => {
    privateNote = '';
    privateNoteInput.value = '';
  });

  roomScreen.querySelectorAll('.mode-hint-image').forEach((image) => {
    image.addEventListener('error', () => showToast('Không tải được hình gợi ý. Hãy kiểm tra kết nối mạng.'), { once: true });
  });
  renderChatMessages();
  setupChat();
  if (isPlaying) {
    const guessInput = document.querySelector('#guess-champion');
    setupChampionPicker('guess-champion', () => {});
    guessInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.defaultPrevented) return;
      event.preventDefault();
      submitGuess();
    });
    if (roomState.timerSeconds) {
      updateTimerDisplay();
      timerInterval = setInterval(updateTimerDisplay, 250);
    }
  } else if (roomState.phase === 'lobby') {
    if (isClassic) {
      setupChampionPicker('secret-champion', (champion) => {
        emitWithAck('room:choose', { championId: champion.id });
      });
    }
  }

  document.querySelector('#copy-code')?.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(roomState.code);
      showToast('Đã sao chép mã phòng.');
    } catch {
      showToast(`Mã phòng: ${roomState.code}`);
    }
  });

  document.querySelector('#ready-button')?.addEventListener('click', () => {
    emitWithAck('room:ready', {});
  });
  document.querySelector('#guess-button')?.addEventListener('click', submitGuess);
  document.querySelector('#hint-button')?.addEventListener('click', (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    socket.emit('room:hint', {}, (response) => {
      if (response?.ok) return;
      showToast(response?.error ?? 'Đã xảy ra lỗi, hãy thử lại.');
      if (button.isConnected) button.disabled = false;
    });
  });
  document.querySelector('#rematch-button')?.addEventListener('click', () => {
    emitWithAck('room:rematch', {});
  });
  document.querySelector('#leave-room')?.addEventListener('click', () => {
    const self = roomState.players.find((player) => player.isSelf);
    const code = roomState.code;
    const name = self?.name ?? getName();
    const finishLeaving = () => {
      returnToHome(code, name);
      showToast('Đã rời phòng. Có thể vào lại bằng mã phòng.');
    };

    if (!socket.connected) {
      finishLeaving();
      return;
    }
    socket.timeout(5000).emit('room:leave', {}, (error, response) => {
      if (error && !socket.connected) {
        finishLeaving();
        return;
      }
      if (error || !response?.ok) {
        showToast(response?.error ?? 'Không thể rời phòng. Hãy thử lại.');
        return;
      }
      finishLeaving();
    });
  });
}

function submitGuess() {
  const guessInput = document.querySelector('#guess-champion');
  const champion = champions.find((item) => item.name.toLowerCase() === guessInput.value.trim().toLowerCase());
  if (!champion) return showToast('Chọn một tướng có trong danh sách.');
  if (roomState.log.some((entry) => entry.championId === champion.id)) {
    return showToast('Vị tướng này đã được đoán trong ván đấu.');
  }
  emitWithAck('room:guess', { championId: champion.id }, () => { guessInput.value = ''; });
}

async function loadChampions() {
  document.querySelector('#create-room').disabled = true;
  document.querySelector('#join-room').disabled = true;
  try {
    const response = await fetch('/api/champions');
    if (!response.ok) throw new Error(`Máy chủ trả về HTTP ${response.status}`);
    const payload = await response.json();
    champions = payload.champions;
    document.querySelector('#create-room').disabled = false;
    document.querySelector('#join-room').disabled = false;
  } catch (error) {
    showHomeError(`Không tải được danh sách tướng: ${error.message}`);
    document.querySelector('#create-room').disabled = true;
    document.querySelector('#join-room').disabled = true;
  }
}

loadChampions();
