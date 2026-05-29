const TTT_STORAGE_KEY = "dobot-tictactoe-setup-v1";
const TTT_LEADERBOARD_KEY = "dobot-tictactoe-leaderboard-v1";
const TTT_TARGET_ORDER = ["HOME", "STANDBY", "A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];
const TTT_ROUTINE_KEYS = ["celebration", "loss"];
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
const ROBOT_MARK_SETTLE_MS = 350;

const state = {
  stage: "name",
  setup: null,
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
};

let tttAudioContext = null;
let tttAudioUnlockPromise = null;
let tttSoundBuffers = null;
const pendingTttSounds = [];

function $(id) {
  return document.getElementById(id);
}

function tttAudio() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }
  if (!tttAudioContext) {
    tttAudioContext = new AudioContextCtor();
  }
  return tttAudioContext;
}

function buildTttSoundBuffer(context, taps) {
  const totalDuration = Math.max(...taps.map((tap) => tap.at + tap.duration)) + 0.02;
  const length = Math.max(1, Math.ceil(context.sampleRate * totalDuration));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);

  taps.forEach((tap) => {
    const start = Math.floor(tap.at * context.sampleRate);
    const count = Math.max(1, Math.floor(tap.duration * context.sampleRate));
    for (let index = 0; index < count && start + index < data.length; index += 1) {
      const t = index / context.sampleRate;
      const envelope = Math.exp(-index / (count * 0.22));
      const tone = Math.sin(2 * Math.PI * tap.frequency * t);
      const click = (Math.random() * 2 - 1) * 0.1;
      data[start + index] += (tone + click) * envelope * tap.gain;
    }
  });

  return buffer;
}

function ensureTttSoundBuffers(context) {
  if (tttSoundBuffers) {
    return tttSoundBuffers;
  }
  tttSoundBuffers = {
    tic: buildTttSoundBuffer(context, [
      { at: 0, duration: 0.055, frequency: 760, gain: 0.52 },
    ]),
    tac: buildTttSoundBuffer(context, [
      { at: 0, duration: 0.07, frequency: 430, gain: 0.58 },
      { at: 0.045, duration: 0.045, frequency: 310, gain: 0.22 },
    ]),
    celebration: buildTttSoundBuffer(context, [
      { at: 0, duration: 0.1, frequency: 520, gain: 0.42 },
      { at: 0.09, duration: 0.1, frequency: 660, gain: 0.38 },
      { at: 0.18, duration: 0.13, frequency: 880, gain: 0.34 },
    ]),
    loss: buildTttSoundBuffer(context, [
      { at: 0, duration: 0.14, frequency: 300, gain: 0.44 },
      { at: 0.12, duration: 0.16, frequency: 220, gain: 0.36 },
      { at: 0.26, duration: 0.18, frequency: 150, gain: 0.3 },
    ]),
  };
  return tttSoundBuffers;
}

function playBufferedTttSound(kind) {
  const context = tttAudio();
  if (!context || context.state !== "running") {
    return false;
  }
  const buffer = ensureTttSoundBuffers(context)[kind] || ensureTttSoundBuffers(context).tic;
  const source = context.createBufferSource();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.9, context.currentTime);
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(context.destination);
  source.start();
  return true;
}

function flushPendingTttSounds() {
  while (pendingTttSounds.length && tttAudioContext?.state === "running") {
    playBufferedTttSound(pendingTttSounds.shift());
  }
}

function unlockTttAudio() {
  const context = tttAudio();
  if (!context) {
    return Promise.resolve(false);
  }
  if (context.state === "running") {
    ensureTttSoundBuffers(context);
    flushPendingTttSounds();
    return Promise.resolve(true);
  }
  if (!tttAudioUnlockPromise) {
    tttAudioUnlockPromise = context.resume()
      .then(() => {
        ensureTttSoundBuffers(context);
        flushPendingTttSounds();
        return context.state === "running";
      })
      .catch(() => false)
      .finally(() => {
        tttAudioUnlockPromise = null;
      });
  }
  return tttAudioUnlockPromise;
}

function playTicTacSound(kind) {
  if (state.mode === "mapping") {
    return;
  }
  const sound = ["tic", "tac", "celebration", "loss"].includes(kind) ? kind : "tic";
  if (!playBufferedTttSound(sound)) {
    pendingTttSounds.push(sound);
    void unlockTttAudio();
  }
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
    const payload = await api("/api/game-mapping?game=tictactoe");
    if (!payload.exists || !payload.setup) {
      return;
    }
    window.localStorage.setItem(TTT_STORAGE_KEY, JSON.stringify(payload.setup));
    state.setup = loadSetup();
  } catch (error) {
    console.warn("Could not load Tic-Tac-Toe mapping file", error);
  }
}

function saveSetupToMappingFile(setup) {
  void api("/api/game-mapping", {
    method: "POST",
    body: { game: "tictactoe", setup },
  }).catch((error) => {
    console.warn("Could not save Tic-Tac-Toe mapping file", error);
  });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function titleCase(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "-";
}

function loadSetup() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(TTT_STORAGE_KEY) || "{}");
    const targets = {};
    const routines = {
      celebration: [],
      loss: [],
    };
    TTT_TARGET_ORDER.forEach((slot) => {
      const target = raw.targets?.[slot];
      targets[slot] = target && Array.isArray(target.joints) && target.joints.length === 6 ? target : null;
    });
    TTT_ROUTINE_KEYS.forEach((key) => {
      const steps = Array.isArray(raw.routines?.[key]?.steps) ? raw.routines[key].steps : [];
      routines[key] = steps
        .map((step, index) => {
          const joints = Array.isArray(step?.joints) && step.joints.length === 6 ? step.joints.map((value) => Number(value)) : null;
          const pose = Array.isArray(step?.pose) ? step.pose.map((value) => Number(value)) : null;
          if (!joints || joints.some((value) => !Number.isFinite(value))) {
            return null;
          }
          return {
            stepId: Number.isInteger(step.stepId) ? step.stepId : index + 1,
            name: String(step.name || `${key} ${index + 1}`),
            joints,
            pose: pose && pose.every((value) => Number.isFinite(value)) ? pose : null,
            dwellMs: Math.max(0, Number(step.dwellMs || 0) || 0),
          };
        })
        .filter(Boolean);
    });
    return { targets, routines };
  } catch {
    return {
      targets: Object.fromEntries(TTT_TARGET_ORDER.map((slot) => [slot, null])),
      routines: { celebration: [], loss: [] },
    };
  }
}

function loadLeaderboard() {
  try {
    const entries = JSON.parse(window.localStorage.getItem(TTT_LEADERBOARD_KEY) || "[]");
    if (!Array.isArray(entries)) {
      return [];
    }
    return entries.filter((entry) => entry && typeof entry.name === "string");
  } catch {
    return [];
  }
}

function saveLeaderboard(entries) {
  window.localStorage.setItem(TTT_LEADERBOARD_KEY, JSON.stringify(entries));
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

function saveRuntimeSetup() {
  const raw = JSON.parse(window.localStorage.getItem(TTT_STORAGE_KEY) || "{}");
  raw.humanMarker = state.humanMarker;
  raw.difficulty = state.difficulty;
  window.localStorage.setItem(TTT_STORAGE_KEY, JSON.stringify(raw));
  saveSetupToMappingFile(raw);
}

function isSetupReady() {
  return TTT_TARGET_ORDER.every((slot) => Boolean(state.setup.targets[slot]));
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
    : "Map Home, Standby, and all board cells before starting.";
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
  updatePlayCopy("Board Mapping", "Use this exact board for mapping. Tap Fullscreen if needed.");
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
  const payload = await api("/api/state");
  if (!payload.state.connected) {
    throw new Error("Connect the robot before starting the game");
  }
  if (!payload.state.motion_ready) {
    throw new Error("Robot is connected but not motion-ready");
  }
}

async function moveRobotTo(slot) {
  const target = state.setup.targets[slot];
  if (!target) {
    throw new Error(`Missing target for ${slot}`);
  }
  await moveRobotJoints(target.joints);
}

async function moveRobotJoints(joints) {
  await api("/api/joint-movej", {
    method: "POST",
    body: {
      joints,
      sync: true,
    },
  });
}

async function runRobotRoutine(kind) {
  const routine = Array.isArray(state.setup?.routines?.[kind]) ? state.setup.routines[kind] : [];
  if (!routine.length) {
    return false;
  }
  for (const step of routine) {
    updatePlayCopy("Robot routine", `${titleCase(kind)}: ${step.name}`);
    await moveRobotJoints(step.joints);
    if (step.dwellMs > 0) {
      await sleep(step.dwellMs);
    }
  }
  return true;
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
    playTicTacSound("celebration");
  } else if (outcome.winner === state.robotMarker) {
    type = "lose";
    title = "Robot Wins";
    copy = "The robot took the round.";
    playTicTacSound("loss");
  } else {
    copy = "Nobody won this round.";
  }

  recordLeaderboardResult(type);
  renderLeaderboard();

  if (outcome.winner === state.robotMarker) {
    try {
      updatePlayCopy(title, "Running celebration routine...");
      if (await runRobotRoutine("celebration")) {
        copy += " Celebration routine finished.";
      }
    } catch (error) {
      copy += ` Celebration routine failed: ${error.message}`;
    }
  } else if (outcome.winner === state.humanMarker) {
    try {
      updatePlayCopy(title, "Running loss routine...");
      if (await runRobotRoutine("loss")) {
        copy += " Loss routine finished.";
      }
    } catch (error) {
      copy += ` Loss routine failed: ${error.message}`;
    }
  }

  updatePlayCopy(title, "Returning robot to home...");
  try {
    await moveRobotTo("HOME");
    copy += " Robot returned home.";
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

  try {
    const moveIndex = chooseRobotMove();
    if (moveIndex === null || moveIndex === undefined) {
      throw new Error("No valid move available");
    }
    const cell = BOARD_CELLS[moveIndex];
    updatePlayCopy("Robot turn", `Moving to ${cell}...`);
    await moveRobotTo(cell);
    state.board[moveIndex] = state.robotMarker;
    playTicTacSound("tac");
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
  playTicTacSound("tic");
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

  void unlockTttAudio();
  saveRuntimeSetup();
  resetRoundState();
  state.mappingPreview = false;
  state.started = true;
  state.currentTurn = "X";
  state.actionBusy = true;
  renderMeta();
  renderBoard();
  setStage("play");
  updatePlayCopy("Starting game", "Moving robot to standby...");

  try {
    await ensureRobotReady();
    await moveRobotTo("STANDBY");
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
  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    document.addEventListener(eventName, () => {
      void unlockTttAudio();
    }, { capture: true, passive: true });
  });

  $("close-button").addEventListener("click", () => {
    if (state.stage === "play" && state.mappingPreview) {
      window.close();
      return;
    }
    window.close();
  });
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
      void unlockTttAudio();
      await handleHumanMove(button.dataset.cell);
    });
  });
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  state.mode = params.get("mode") === "mapping" ? "mapping" : "play";
  state.setup = loadSetup();
  await loadSetupFromMappingFile();
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
