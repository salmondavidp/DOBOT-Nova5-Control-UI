const THREE_TTT_STORAGE_KEY = "dobot-3ttt-setup-v1";
const THREE_TTT_LEADERBOARD_KEY = "dobot-3ttt-leaderboard-v1";
const TTT_TARGET_ORDER = ["HOME", "STANDBY", "A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];
const TTT_ANCHOR_TARGETS = ["HOME", "STANDBY"];
const BOARD_CELLS = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];
const WIN_LINES = [
  [0, 1, 2],
  [3, 4, 5],
  [6, 7, 8],
  [0, 3, 6],
  [1, 4, 7],
  [2, 5, 8],
  [0, 4, 8],
  [2, 4, 6],
];
const KEYBOARD_LAYOUT = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
  ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
];
const THREE_TTT_PRIORITY_PRESETS = {
  center_first: ["board2", "board1", "board3", "board4"],
  left_first: ["board1", "board2", "board3", "board4"],
  right_first: ["board3", "board2", "board1", "board4"],
};
const ROBOT_MARK_SETTLE_MS = 350;
const PREVIEW_REACHED_MS = 700;
const PREVIEW_MARK_MS = 450;
const OSC_REACHED_TIMEOUT_MS = 30000;
const SERVO_REACHED_TIMEOUT_SECONDS = 120;
const OSC_POLL_MS = 250;
const TTT_CLIENT_ID = (() => {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
})();

const state = {
  stage: "name",
  setup: null,
  boardId: "board1",
  boardConfig: null,
  playerName: "",
  humanMarker: "X",
  robotMarker: "O",
  difficulty: "medium",
  board: Array(9).fill(null),
  started: false,
  currentTurn: "X",
  actionBusy: false,
  finished: false,
  mappingPreview: false,
  mode: "play",
  taskSeq: 1,
  clientId: TTT_CLIENT_ID,
};

function $(id) {
  return document.getElementById(id);
}

function api(path, options = {}) {
  return fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(async (response) => {
    const payload = await response.json();
    if (!response.ok || !payload.ok) {
      throw new Error(payload.error || `Request failed: ${response.status}`);
    }
    return payload;
  });
}

async function loadSetupFromMappingFile() {
  try {
    const payload = await api("/api/game-mapping?game=3ttt");
    if (!payload.exists || !payload.setup) {
      return;
    }
    window.localStorage.setItem(THREE_TTT_STORAGE_KEY, JSON.stringify(payload.setup));
    state.setup = loadThreeTttSetup();
  } catch (error) {
    console.warn("Could not load 3TTT mapping file", error);
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function titleCase(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "-";
}

function defaultThreeTttSetup() {
  const boards = {};
  [1, 2, 3, 4].forEach((number) => {
    const boardId = `board${number}`;
    boards[boardId] = {
      id: boardId,
      label: `Player ${number}`,
      oscName: String(number),
      targets: Object.fromEntries(TTT_TARGET_ORDER.map((slot) => [slot, null])),
    };
  });
  return {
    displayMode: "current",
    boardCount: 3,
    selectedBoardId: "board1",
    launchBoardId: "board1",
    priorityPreset: "center_first",
    robotMode: "preview",
    boards,
    osc: {
      host: "127.0.0.1",
      sendPort: 9000,
      listenPort: 9001,
      gotoAddress: "/board",
      reachedAddress: "/reached",
    },
  };
}

function normalizeTarget(raw, slot) {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const joints = Array.isArray(raw.joints) && raw.joints.length === 6
    ? raw.joints.map((value) => Number(value))
    : null;
  if (!joints || joints.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return {
    ...raw,
    slot,
    joints,
    pose: Array.isArray(raw.pose) ? raw.pose.map((value) => Number(value)) : null,
  };
}

function synchronizeAnchorTargets(setup) {
  if (!setup?.boards) {
    return setup;
  }
  const activeIds = Array.from({ length: setup.boardCount }, (_, index) => `board${index + 1}`);
  TTT_ANCHOR_TARGETS.forEach((slot) => {
    const preferredIds = [setup.selectedBoardId, setup.launchBoardId, ...activeIds].filter(Boolean);
    const commonTarget = preferredIds
      .map((boardId) => setup.boards[boardId]?.targets?.[slot])
      .find(Boolean);
    if (!commonTarget) {
      return;
    }
    activeIds.forEach((boardId) => {
      if (!setup.boards[boardId]?.targets) {
        return;
      }
      setup.boards[boardId].targets[slot] = normalizeTarget(commonTarget, slot);
    });
  });
  return setup;
}

function normalizeThreeTttSetup(raw) {
  const defaults = defaultThreeTttSetup();
  const merged = raw && typeof raw === "object" ? raw : {};
  const boardCount = [1, 2, 3, 4].includes(Number(merged.boardCount)) ? Number(merged.boardCount) : defaults.boardCount;
  const activeIds = Array.from({ length: boardCount }, (_, index) => `board${index + 1}`);
  const boards = {};
  activeIds.forEach((boardId) => {
    const number = Number(boardId.replace("board", "")) || 1;
    const rawBoard = merged.boards?.[boardId] && typeof merged.boards[boardId] === "object" ? merged.boards[boardId] : {};
    const targets = Object.fromEntries(TTT_TARGET_ORDER.map((slot) => [slot, null]));
    Object.entries(rawBoard.targets || {}).forEach(([slot, target]) => {
      if (TTT_TARGET_ORDER.includes(slot)) {
        targets[slot] = normalizeTarget(target, slot);
      }
    });
    boards[boardId] = {
      id: boardId,
      label: String(rawBoard.label || `Player ${number}`),
      oscName: String(rawBoard.oscName || number).replace(/^board/i, "") || String(number),
      targets,
    };
  });
  const osc = merged.osc && typeof merged.osc === "object" ? merged.osc : {};
  return synchronizeAnchorTargets({
    displayMode: merged.displayMode === "secondary" ? "secondary" : "current",
    boardCount,
    selectedBoardId: activeIds.includes(merged.selectedBoardId) ? merged.selectedBoardId : activeIds[0],
    launchBoardId: activeIds.includes(merged.launchBoardId) ? merged.launchBoardId : activeIds[0],
    priorityPreset: Object.prototype.hasOwnProperty.call(THREE_TTT_PRIORITY_PRESETS, merged.priorityPreset)
      ? merged.priorityPreset
      : defaults.priorityPreset,
    robotMode: ["api", "servo"].includes(merged.robotMode) ? merged.robotMode : "preview",
    boards,
    osc: {
      host: String(osc.host || defaults.osc.host),
      sendPort: Math.max(1, Math.min(65535, Number(osc.sendPort || defaults.osc.sendPort) || defaults.osc.sendPort)),
      listenPort: Math.max(1, Math.min(65535, Number(osc.listenPort || defaults.osc.listenPort) || defaults.osc.listenPort)),
      gotoAddress: String(!osc.gotoAddress || String(osc.gotoAddress).startsWith("/3ttt") ? defaults.osc.gotoAddress : osc.gotoAddress),
      reachedAddress: String(!osc.reachedAddress || String(osc.reachedAddress).startsWith("/3ttt") ? defaults.osc.reachedAddress : osc.reachedAddress),
    },
  });
}

function loadThreeTttSetup() {
  try {
    const raw = window.localStorage.getItem(THREE_TTT_STORAGE_KEY);
    return normalizeThreeTttSetup(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultThreeTttSetup();
  }
}

function getPriority() {
  const activeIds = Array.from({ length: state.setup.boardCount }, (_, index) => `board${index + 1}`);
  const preset = THREE_TTT_PRIORITY_PRESETS[state.setup.priorityPreset] || THREE_TTT_PRIORITY_PRESETS.center_first;
  const order = preset.filter((boardId) => activeIds.includes(boardId));
  activeIds.forEach((boardId) => {
    if (!order.includes(boardId)) {
      order.push(boardId);
    }
  });
  return order.indexOf(state.boardId) + 1;
}

function oscAddress(base, suffix) {
  const cleanBase = String(base || "").replace(/\/+$/, "") || "/";
  const cleanSuffix = String(suffix || "").replace(/^\/+|\/+$/g, "");
  return cleanSuffix ? `${cleanBase}/${cleanSuffix}` : cleanBase;
}

function isSetupReady() {
  return Boolean(state.boardConfig && TTT_TARGET_ORDER.every((slot) => Boolean(state.boardConfig.targets?.[slot])));
}

function loadLeaderboard() {
  try {
    const entries = JSON.parse(window.localStorage.getItem(THREE_TTT_LEADERBOARD_KEY) || "[]");
    return Array.isArray(entries) ? entries.filter((entry) => entry && typeof entry.name === "string") : [];
  } catch {
    return [];
  }
}

function saveLeaderboard(entries) {
  window.localStorage.setItem(THREE_TTT_LEADERBOARD_KEY, JSON.stringify(entries));
}

function recordLeaderboardResult(resultType) {
  const name = (state.playerName || "Player").trim() || "Player";
  const entries = loadLeaderboard();
  const existing = entries.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  if (existing) {
    existing.games = Number(existing.games || 0) + 1;
    if (resultType === "win") {
      existing.wins = Number(existing.wins || 0) + 1;
    } else if (resultType === "lose") {
      existing.losses = Number(existing.losses || 0) + 1;
    } else {
      existing.draws = Number(existing.draws || 0) + 1;
    }
  } else {
    entries.push({
      name,
      wins: resultType === "win" ? 1 : 0,
      losses: resultType === "lose" ? 1 : 0,
      draws: resultType === "draw" ? 1 : 0,
      games: 1,
    });
  }
  entries.sort((a, b) => {
    if ((b.wins || 0) !== (a.wins || 0)) {
      return (b.wins || 0) - (a.wins || 0);
    }
    if ((a.losses || 0) !== (b.losses || 0)) {
      return (a.losses || 0) - (b.losses || 0);
    }
    return (b.games || 0) - (a.games || 0);
  });
  saveLeaderboard(entries.slice(0, 8));
}

function renderLeaderboard() {
  const list = $("leaderboard-list");
  const entries = loadLeaderboard();
  list.innerHTML = "";
  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "leaderboard-empty";
    empty.textContent = "No games yet";
    list.appendChild(empty);
    return;
  }
  entries.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "leaderboard-row";
    row.innerHTML = `
      <div class="leaderboard-rank">#${index + 1}</div>
      <div>
        <div class="leaderboard-name">${entry.name}</div>
        <div class="leaderboard-meta">${entry.wins || 0}W / ${entry.losses || 0}L / ${entry.draws || 0}D</div>
      </div>
      <div class="leaderboard-score">${entry.games || 0} games</div>
    `;
    list.appendChild(row);
  });
}

function setStage(nextStage) {
  state.stage = nextStage;
  $("name-stage").classList.toggle("active", nextStage === "name");
  $("setup-stage").classList.toggle("active", nextStage === "setup");
  $("play-stage").classList.toggle("active", nextStage === "play");
}

function updateNameDisplay() {
  $("player-name-display").textContent = state.playerName || "_";
  $("name-next-button").disabled = state.playerName.trim().length < 1;
}

function renderSetupSummary() {
  $("setup-summary").textContent = isSetupReady()
    ? `${state.playerName || "Player"} vs Robot`
    : "This board is not fully mapped yet.";
  $("start-game-button").disabled = !isSetupReady() || state.actionBusy;
}

function renderSetupChoices() {
  document.querySelectorAll("[data-marker]").forEach((button) => {
    button.classList.toggle("active", button.dataset.marker === state.humanMarker);
  });
  document.querySelectorAll("[data-difficulty]").forEach((button) => {
    button.classList.toggle("active", button.dataset.difficulty === state.difficulty);
  });
  renderSetupSummary();
}

function renderMeta() {
  $("meta-player-name").textContent = state.playerName || "Player";
  $("meta-player-marker").textContent = state.humanMarker;
  $("meta-difficulty").textContent = titleCase(state.difficulty);
}

function updatePlayCopy(title, note) {
  $("play-title").textContent = title;
  $("turn-note").textContent = note;
}

function renderBoard() {
  document.querySelectorAll(".touch-cell").forEach((button) => {
    const index = BOARD_CELLS.indexOf(button.dataset.cell);
    const mark = state.board[index];
    button.textContent = mark || "";
    button.classList.toggle("played-x", mark === "X");
    button.classList.toggle("played-o", mark === "O");
    button.disabled = state.mappingPreview || !state.started || state.finished || state.actionBusy || Boolean(mark) || state.currentTurn !== state.humanMarker;
  });
}

function showResult(type, title, copy) {
  const overlay = $("result-overlay");
  const card = $("result-card");
  card.classList.remove("win", "lose", "draw");
  card.classList.add(type);
  $("result-title").textContent = title;
  $("result-copy").textContent = copy;
  overlay.classList.add("active");
}

function hideResult() {
  $("result-overlay").classList.remove("active");
}

function resetRoundState() {
  state.board = Array(9).fill(null);
  state.started = false;
  state.currentTurn = "X";
  state.actionBusy = false;
  state.finished = false;
  state.mappingPreview = false;
  hideResult();
}

function openMappingBoard() {
  resetRoundState();
  state.mappingPreview = true;
  renderMeta();
  renderBoard();
  setStage("play");
  updatePlayCopy("Board Mapping", `${state.boardConfig?.label || "Selected board"} mapping view.`);
}

function availableMoves(board) {
  return board.map((value, index) => (value ? null : index)).filter((value) => value !== null);
}

function getOutcome(board) {
  for (const [a, b, c] of WIN_LINES) {
    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return { winner: board[a], draw: false };
    }
  }
  return { winner: null, draw: board.every(Boolean) };
}

function randomChoice(items) {
  return items[Math.floor(Math.random() * items.length)];
}

function minimax(board, currentMarker, robotMarker, humanMarker) {
  const outcome = getOutcome(board);
  if (outcome.winner === robotMarker) {
    return { score: 10 };
  }
  if (outcome.winner === humanMarker) {
    return { score: -10 };
  }
  if (outcome.draw) {
    return { score: 0 };
  }

  const moves = [];
  for (const index of availableMoves(board)) {
    const next = [...board];
    next[index] = currentMarker;
    const nextMarker = currentMarker === robotMarker ? humanMarker : robotMarker;
    const result = minimax(next, nextMarker, robotMarker, humanMarker);
    moves.push({ index, score: result.score });
  }
  if (currentMarker === robotMarker) {
    return moves.reduce((best, move) => (move.score > best.score ? move : best));
  }
  return moves.reduce((best, move) => (move.score < best.score ? move : best));
}

function pickHeuristicMove(board, marker, opponent) {
  for (const index of availableMoves(board)) {
    const next = [...board];
    next[index] = marker;
    if (getOutcome(next).winner === marker) {
      return index;
    }
  }
  for (const index of availableMoves(board)) {
    const next = [...board];
    next[index] = opponent;
    if (getOutcome(next).winner === opponent) {
      return index;
    }
  }
  const priority = [4, 0, 2, 6, 8, 1, 3, 5, 7];
  return priority.find((index) => !board[index]) ?? availableMoves(board)[0];
}

function chooseRobotMove() {
  const robot = state.robotMarker;
  const human = state.humanMarker;
  const open = availableMoves(state.board);
  if (!open.length) {
    return null;
  }
  if (state.difficulty === "easy") {
    return randomChoice(open);
  }
  if (state.difficulty === "medium") {
    return Math.random() < 0.4 ? randomChoice(open) : pickHeuristicMove(state.board, robot, human);
  }
  return minimax([...state.board], robot, robot, human).index ?? open[0];
}

async function enterFullscreen() {
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Ignore blocked fullscreen.
    }
  }
}

async function ensureRobotReady() {
  if (state.setup.robotMode === "preview") {
    return;
  }
  const payload = await api("/api/state");
  if (!payload.state.connected) {
    throw new Error("Connect the robot before starting the game");
  }
  if (!payload.state.motion_ready) {
    throw new Error("Robot is connected but not motion-ready");
  }
}

async function moveRobotTo(slot) {
  const target = state.boardConfig.targets[slot];
  if (!target) {
    throw new Error(`Missing target for ${slot}`);
  }
  if (state.setup.robotMode === "preview") {
    await sleep(PREVIEW_MARK_MS);
    return;
  }
  await api("/api/joint-movej", {
    method: "POST",
    body: {
      joints: target.joints,
      sync: true,
    },
  });
}

async function sendBoardGoto(taskId) {
  const boardName = state.boardConfig.oscName || state.boardId;
  const priority = getPriority();
  if (state.setup.robotMode === "preview") {
    await sleep(PREVIEW_REACHED_MS);
    return;
  }
  if (state.setup.robotMode === "servo") {
    await api("/api/servo/board", {
      method: "POST",
      body: {
        board_name: boardName,
        board_count: state.setup.boardCount,
        slave: 0,
        timeout: SERVO_REACHED_TIMEOUT_SECONDS,
      },
    });
    return;
  }
  await api("/api/3ttt/osc/goto", {
    method: "POST",
    body: {
      host: state.setup.osc.host,
      port: state.setup.osc.sendPort,
      listen_port: state.setup.osc.listenPort,
      goto_address: state.setup.osc.gotoAddress,
      reached_address: state.setup.osc.reachedAddress,
      task_id: taskId,
      board_name: boardName,
      priority,
    },
  });
}

async function waitForBoardReached(taskId) {
  if (state.setup.robotMode === "preview" || state.setup.robotMode === "servo") {
    return;
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt < OSC_REACHED_TIMEOUT_MS) {
    const query = new URLSearchParams({ task_id: taskId });
    const payload = await api(`/api/3ttt/osc/task?${query.toString()}`);
    if (payload.event?.status === "reached") {
      return;
    }
    if (payload.event?.status === "error") {
      throw new Error(payload.event.message || "Servo software reported an OSC error");
    }
    await sleep(OSC_POLL_MS);
  }
  const boardName = state.boardConfig.oscName || state.boardId;
  throw new Error(`Timed out waiting for ${oscAddress(state.setup.osc.reachedAddress, boardName)}`);
}

async function acquireRobotQueue(taskId, cell) {
  if (state.setup.robotMode === "preview") {
    return null;
  }
  const boardName = state.boardConfig.oscName || state.boardId;
  const payload = await api("/api/3ttt/queue/acquire", {
    method: "POST",
    body: {
      task_id: taskId,
      board_id: state.boardId,
      board_name: boardName,
      player_name: state.playerName,
      cell,
      timeout: 600,
    },
  });
  return payload.queue;
}

async function releaseRobotQueue(taskId) {
  if (state.setup.robotMode === "preview" || !taskId) {
    return;
  }
  try {
    await api("/api/3ttt/queue/release", {
      method: "POST",
      body: { task_id: taskId },
    });
  } catch (error) {
    console.warn("3TTT queue release failed", error);
  }
}

async function finishRound(outcome) {
  state.finished = true;
  state.actionBusy = true;
  renderBoard();
  let type = "draw";
  let title = "Draw";
  let copy = "Round complete.";

  if (outcome.winner === state.humanMarker) {
    type = "win";
    title = `${state.playerName || "Player"} Wins`;
    copy = "You took the round.";
  } else if (outcome.winner === state.robotMarker) {
    type = "lose";
    title = "Robot Wins";
    copy = "The robot took the round.";
  } else {
    copy = "Nobody won this round.";
  }

  recordLeaderboardResult(type);
  renderLeaderboard();

  try {
    if (state.setup.robotMode !== "preview") {
      updatePlayCopy(title, "Returning robot to home...");
      await moveRobotTo("HOME");
      copy += " Robot returned home.";
    }
  } catch (error) {
    copy += ` Home return failed: ${error.message}`;
  }
  state.actionBusy = false;
  showResult(type, title, copy);
}

async function runRobotTurn() {
  state.actionBusy = true;
  renderBoard();
  updatePlayCopy("Robot turn", "Robot is choosing a move...");
  await sleep(250);
  let taskId = "";
  let queueAcquired = false;

  try {
    const moveIndex = chooseRobotMove();
    if (moveIndex === null || moveIndex === undefined) {
      throw new Error("No valid move available");
    }
    const cell = BOARD_CELLS[moveIndex];
    taskId = `task_${state.boardId}_${state.clientId}_${String(state.taskSeq++).padStart(3, "0")}`;

    if (state.setup.robotMode !== "preview") {
      updatePlayCopy("Robot queue", "Waiting for the shared robot...");
      await acquireRobotQueue(taskId, cell);
      queueAcquired = true;
    }

    updatePlayCopy("Robot turn", "Moving to board...");
    await sendBoardGoto(taskId);
    await waitForBoardReached(taskId);

    updatePlayCopy("Robot turn", `Moving to ${cell}...`);
    await moveRobotTo("STANDBY");
    await moveRobotTo(cell);
    state.board[moveIndex] = state.robotMarker;
    renderBoard();
    updatePlayCopy("Robot turn", `Placed ${state.robotMarker} on ${cell}.`);
    await sleep(ROBOT_MARK_SETTLE_MS);
    updatePlayCopy("Robot turn", "Returning to standby...");
    await moveRobotTo("STANDBY");

    const outcome = getOutcome(state.board);
    if (outcome.winner || outcome.draw) {
      await finishRound(outcome);
      return;
    }

    state.currentTurn = state.humanMarker;
    state.actionBusy = false;
    renderBoard();
    updatePlayCopy(`${state.playerName || "Player"}'s turn`, "Tap an empty square.");
  } catch (error) {
    state.actionBusy = false;
    updatePlayCopy("Robot move failed", error.message);
    renderBoard();
  } finally {
    if (queueAcquired) {
      await releaseRobotQueue(taskId);
    }
  }
}

async function handleHumanMove(cell) {
  if (!state.started || state.finished || state.actionBusy || state.currentTurn !== state.humanMarker) {
    return;
  }
  const index = BOARD_CELLS.indexOf(cell);
  if (index < 0 || state.board[index]) {
    return;
  }
  state.board[index] = state.humanMarker;
  renderBoard();

  const outcome = getOutcome(state.board);
  if (outcome.winner || outcome.draw) {
    await finishRound(outcome);
    return;
  }

  state.currentTurn = state.robotMarker;
  await runRobotTurn();
}

async function startRound() {
  if (!isSetupReady()) {
    renderSetupSummary();
    return;
  }

  resetRoundState();
  state.started = true;
  state.currentTurn = "X";
  state.actionBusy = true;
  renderMeta();
  renderBoard();
  setStage("play");
  updatePlayCopy("Starting game", "Preparing robot...");

  try {
    await ensureRobotReady();
    state.actionBusy = false;

    if (state.robotMarker === "X") {
      state.currentTurn = state.robotMarker;
      await runRobotTurn();
    } else {
      state.currentTurn = state.humanMarker;
      renderBoard();
      updatePlayCopy(`${state.playerName || "Player"}'s turn`, "Tap an empty square.");
    }
  } catch (error) {
    state.actionBusy = false;
    renderBoard();
    updatePlayCopy("Unable to start", error.message);
  }
}

function buildKeyboard() {
  const grid = $("keyboard-grid");
  grid.innerHTML = "";
  KEYBOARD_LAYOUT.forEach((rowKeys) => {
    const row = document.createElement("div");
    row.className = "keyboard-row";
    rowKeys.forEach((key) => {
      const button = document.createElement("button");
      button.className = "key-btn";
      button.type = "button";
      button.textContent = key;
      button.addEventListener("click", () => {
        if (state.playerName.length >= 14) {
          return;
        }
        state.playerName += key;
        updateNameDisplay();
      });
      row.appendChild(button);
    });
    grid.appendChild(row);
  });
}

function attachEvents() {
  $("close-button").addEventListener("click", () => window.close());
  $("fullscreen-button").addEventListener("click", enterFullscreen);
  $("keyboard-backspace-button").addEventListener("click", () => {
    state.playerName = state.playerName.slice(0, -1);
    updateNameDisplay();
  });
  $("keyboard-space-button").addEventListener("click", () => {
    if (state.playerName.length >= 14 || state.playerName.endsWith(" ")) {
      return;
    }
    state.playerName += " ";
    updateNameDisplay();
  });
  $("name-next-button").addEventListener("click", () => {
    if (state.playerName.trim()) {
      setStage("setup");
      renderSetupChoices();
    }
  });
  $("setup-back-button").addEventListener("click", () => {
    setStage("name");
  });
  $("start-game-button").addEventListener("click", startRound);
  $("restart-button").addEventListener("click", startRound);
  $("result-back-button").addEventListener("click", () => {
    hideResult();
    resetRoundState();
    state.playerName = "";
    updateNameDisplay();
    setStage("name");
    renderSetupChoices();
  });

  document.querySelectorAll("[data-marker]").forEach((button) => {
    button.addEventListener("click", () => {
      state.humanMarker = button.dataset.marker;
      state.robotMarker = state.humanMarker === "X" ? "O" : "X";
      renderSetupChoices();
    });
  });

  document.querySelectorAll("[data-difficulty]").forEach((button) => {
    button.addEventListener("click", () => {
      state.difficulty = button.dataset.difficulty;
      renderSetupChoices();
    });
  });

  document.querySelectorAll(".touch-cell").forEach((button) => {
    button.addEventListener("click", async () => {
      await handleHumanMove(button.dataset.cell);
    });
  });
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  state.setup = loadThreeTttSetup();
  await loadSetupFromMappingFile();
  state.mode = params.get("mode") === "mapping" ? "mapping" : "play";
  const requestedBoardId = params.get("board") || state.setup.launchBoardId || "board1";
  state.boardId = state.setup.boards[requestedBoardId] ? requestedBoardId : Object.keys(state.setup.boards)[0];
  state.boardConfig = state.setup.boards[state.boardId];
  buildKeyboard();
  attachEvents();
  renderLeaderboard();
  updateNameDisplay();
  renderSetupChoices();
  renderMeta();
  renderBoard();
  if (state.mode === "mapping") {
    openMappingBoard();
  } else {
    updatePlayCopy("Touch Tic-Tac-Toe", "Enter your name to begin.");
    setStage("name");
  }
  setTimeout(() => {
    void enterFullscreen();
  }, 250);
}

window.addEventListener("DOMContentLoaded", init);
