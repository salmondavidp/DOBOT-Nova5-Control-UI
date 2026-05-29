import { Chess } from "/vendor/chess.js";

const CHESS_STORAGE_KEY = "dobot-chess-setup-v1";
const CHESS_PLAYER_KEY = "dobot-chess-player-name-v1";
const STOCKFISH_SCRIPT = "/vendor/stockfish-nnue-16-single.js";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"];
const RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];
const KEYBOARD_LAYOUT = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
  ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
];
const PIECE_VALUES = {
  p: 100,
  n: 320,
  b: 330,
  r: 500,
  q: 900,
  k: 0,
};
const PIECE_NAMES = {
  p: "Pawn",
  n: "Knight",
  b: "Bishop",
  r: "Rook",
  q: "Queen",
  k: "King",
};
const PIECE_SYMBOLS = {
  p: "\u265F",
  n: "\u265E",
  b: "\u265D",
  r: "\u265C",
  q: "\u265B",
  k: "\u265A",
};
const CHECKMATE_SCORE = 1000000;
const SEARCH_PROFILES = {
  easy: {
    label: "Easy 800-1000",
    maxDepth: 2,
    timeMs: 700,
    randomTop: 3,
    noise: 28,
  },
  medium: {
    label: "Medium 1200-1800",
    maxDepth: 4,
    timeMs: 2200,
    randomTop: 2,
    noise: 8,
  },
  hard: {
    label: "Hard engine-like",
    maxDepth: 6,
    timeMs: 6500,
    randomTop: 1,
    noise: 0,
  },
};
const STOCKFISH_PROFILES = {
  easy: {
    label: "Easy 800-1000",
    elo: 1320,
    skill: 2,
    movetime: 150,
    limitStrength: true,
  },
  medium: {
    label: "Medium 1200-1800",
    elo: 1650,
    skill: 9,
    movetime: 450,
    limitStrength: true,
  },
  hard: {
    label: "Hard 2800-3000",
    skill: 20,
    movetime: 1200,
    limitStrength: false,
  },
};
const DIALOG_SOUND_FILES = {
  gameCheckmate: ["check mate.mp3"],
  playerInteresting: ["hmm intresting move u got.mp3"],
  playerNice: ["nice move lets see where this goes.mp3"],
  playerPressure: ["your putting pressure on my king now.mp3"],
  playerTrap: ["trying to trap me .mp3", "trying to trap me  2.mp3"],
  robotBigCapture: ["awww so soad.mp3"],
  robotGotcha: ["Gotcha..mp3"],
  robotWaiting: ["i have been waiting to make that move.mp3"],
  robotYourMove: ["its your move human.mp3"],
  robotWorried: ["Your king should be worrid now.mp3"],
};
const DIALOG_COOLDOWN_TURNS = 2;
const DIALOG_DELAY_MS = 420;
const DIALOG_VOLUME = 0.95;
const PIECE_SQUARE_TABLES = {
  p: [
    [0, 0, 0, 0, 0, 0, 0, 0],
    [50, 50, 50, 55, 55, 50, 50, 50],
    [12, 12, 22, 34, 34, 22, 12, 12],
    [6, 6, 14, 28, 28, 14, 6, 6],
    [2, 2, 8, 24, 24, 8, 2, 2],
    [6, -4, -12, 4, 4, -12, -4, 6],
    [6, 12, 12, -18, -18, 12, 12, 6],
    [0, 0, 0, 0, 0, 0, 0, 0],
  ],
  n: [
    [-50, -38, -28, -25, -25, -28, -38, -50],
    [-38, -20, -8, 0, 0, -8, -20, -38],
    [-28, -8, 18, 24, 24, 18, -8, -28],
    [-24, 2, 24, 34, 34, 24, 2, -24],
    [-24, 2, 24, 34, 34, 24, 2, -24],
    [-28, -8, 18, 24, 24, 18, -8, -28],
    [-38, -20, -8, 0, 0, -8, -20, -38],
    [-50, -38, -28, -25, -25, -28, -38, -50],
  ],
  b: [
    [-22, -12, -10, -8, -8, -10, -12, -22],
    [-12, 6, 2, 4, 4, 2, 6, -12],
    [-10, 8, 14, 16, 16, 14, 8, -10],
    [-8, 4, 16, 18, 18, 16, 4, -8],
    [-8, 4, 16, 18, 18, 16, 4, -8],
    [-10, 8, 14, 16, 16, 14, 8, -10],
    [-12, 6, 2, 4, 4, 2, 6, -12],
    [-22, -12, -10, -8, -8, -10, -12, -22],
  ],
  r: [
    [0, 0, 4, 8, 8, 4, 0, 0],
    [10, 12, 14, 16, 16, 14, 12, 10],
    [-4, 0, 2, 4, 4, 2, 0, -4],
    [-4, 0, 2, 4, 4, 2, 0, -4],
    [-4, 0, 2, 4, 4, 2, 0, -4],
    [-4, 0, 2, 4, 4, 2, 0, -4],
    [-4, 0, 2, 4, 4, 2, 0, -4],
    [0, 0, 4, 8, 8, 4, 0, 0],
  ],
  q: [
    [-20, -10, -8, -4, -4, -8, -10, -20],
    [-10, 0, 4, 4, 4, 4, 0, -10],
    [-8, 4, 8, 10, 10, 8, 4, -8],
    [-4, 4, 10, 12, 12, 10, 4, -4],
    [-4, 4, 10, 12, 12, 10, 4, -4],
    [-8, 4, 8, 10, 10, 8, 4, -8],
    [-10, 0, 4, 4, 4, 4, 0, -10],
    [-20, -10, -8, -4, -4, -8, -10, -20],
  ],
  k: [
    [28, 36, 14, 0, 0, 14, 36, 28],
    [22, 20, 0, -10, -10, 0, 20, 22],
    [-12, -22, -24, -30, -30, -24, -22, -12],
    [-28, -38, -40, -48, -48, -40, -38, -28],
    [-34, -44, -46, -54, -54, -46, -44, -34],
    [-38, -48, -50, -58, -58, -50, -48, -38],
    [-26, -34, -38, -42, -42, -38, -34, -26],
    [-12, -18, -22, -26, -26, -22, -18, -12],
  ],
};
const CLIENT_ID = (() => {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
})();

const state = {
  stage: "name",
  mode: "play",
  game: new Chess(),
  setup: null,
  playerName: "Player",
  selectedSquare: null,
  legalMoves: [],
  busy: false,
  taskSeq: 1,
  lastMove: null,
  robotStage: null,
  robotRemovedSquare: null,
  dialogTurn: 0,
  lastDialogTurn: -10,
  lastDialogKey: null,
  lastDialogFile: null,
  dialogGeneration: 0,
};

let stockfishEngine = null;
let chessAudioContext = null;
let chessAudioUnlockPromise = null;
let chessSoundBuffers = null;
const chessDialogBuffers = new Map();
const chessDialogLoadPromises = new Map();
let chessAudioKeepAlive = null;
const pendingChessSounds = [];

function $(id) {
  return document.getElementById(id);
}

function chessAudio() {
  const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextCtor) {
    return null;
  }
  if (!chessAudioContext) {
    chessAudioContext = new AudioContextCtor();
  }
  return chessAudioContext;
}

function buildChessSoundBuffer(context, taps) {
  const totalDuration = Math.max(...taps.map((tap) => tap.at + tap.duration)) + 0.035;
  const length = Math.max(1, Math.ceil(context.sampleRate * totalDuration));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);

  taps.forEach((tap) => {
    const start = Math.floor(tap.at * context.sampleRate);
    const count = Math.max(1, Math.floor(tap.duration * context.sampleRate));
    for (let index = 0; index < count && start + index < data.length; index += 1) {
      const t = index / context.sampleRate;
      const envelope = Math.exp(-index / (count * 0.24));
      const tone = Math.sin(2 * Math.PI * tap.frequency * t) * 0.72;
      const body = Math.sin(2 * Math.PI * tap.frequency * 0.48 * t) * 0.35;
      const noise = (Math.random() * 2 - 1) * 0.18;
      data[start + index] += (tone + body + noise) * envelope * tap.gain;
    }
  });

  return buffer;
}

function ensureChessSoundBuffers(context) {
  if (chessSoundBuffers) {
    return chessSoundBuffers;
  }
  chessSoundBuffers = {
    select: buildChessSoundBuffer(context, [
      { at: 0, duration: 0.07, frequency: 620, gain: 0.5 },
    ]),
    move: buildChessSoundBuffer(context, [
      { at: 0, duration: 0.1, frequency: 430, gain: 0.56 },
      { at: 0.055, duration: 0.06, frequency: 280, gain: 0.28 },
    ]),
    capture: buildChessSoundBuffer(context, [
      { at: 0, duration: 0.12, frequency: 360, gain: 0.62 },
      { at: 0.055, duration: 0.08, frequency: 520, gain: 0.34 },
    ]),
    check: buildChessSoundBuffer(context, [
      { at: 0, duration: 0.08, frequency: 660, gain: 0.48 },
      { at: 0.075, duration: 0.08, frequency: 880, gain: 0.36 },
    ]),
    "game-over": buildChessSoundBuffer(context, [
      { at: 0, duration: 0.12, frequency: 320, gain: 0.52 },
      { at: 0.1, duration: 0.14, frequency: 240, gain: 0.42 },
    ]),
  };
  return chessSoundBuffers;
}

function startChessAudioKeepAlive(context) {
  if (chessAudioKeepAlive || !context || context.state !== "running") {
    return;
  }
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.setValueAtTime(18, context.currentTime);
  gain.gain.setValueAtTime(0.00001, context.currentTime);
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  chessAudioKeepAlive = { oscillator, gain };
}

function playBufferedChessSound(kind) {
  const context = chessAudio();
  if (!context || context.state !== "running") {
    return false;
  }
  const buffer = ensureChessSoundBuffers(context)[kind] || ensureChessSoundBuffers(context).move;
  const source = context.createBufferSource();
  const gain = context.createGain();
  gain.gain.setValueAtTime(0.85, context.currentTime);
  source.buffer = buffer;
  source.connect(gain);
  gain.connect(context.destination);
  source.start();
  return true;
}

function flushPendingChessSounds() {
  while (pendingChessSounds.length && chessAudioContext?.state === "running") {
    playBufferedChessSound(pendingChessSounds.shift());
  }
}

function unlockChessAudio() {
  const context = chessAudio();
  if (!context) {
    return Promise.resolve(false);
  }
  if (context.state === "running") {
    ensureChessSoundBuffers(context);
    startChessAudioKeepAlive(context);
    flushPendingChessSounds();
    preloadChessDialogSounds();
    return Promise.resolve(true);
  }
  if (!chessAudioUnlockPromise) {
    chessAudioUnlockPromise = context.resume()
      .then(() => {
        ensureChessSoundBuffers(context);
        startChessAudioKeepAlive(context);
        flushPendingChessSounds();
        preloadChessDialogSounds();
        return context.state === "running";
      })
      .catch(() => false)
      .finally(() => {
        chessAudioUnlockPromise = null;
      });
  }
  return chessAudioUnlockPromise;
}

function playChessSound(kind) {
  if (state.mode === "mapping") {
    return;
  }
  const sound = ["select", "move", "capture", "check", "game-over"].includes(kind) ? kind : "move";
  if (!playBufferedChessSound(sound)) {
    pendingChessSounds.push(sound);
    void unlockChessAudio();
  }
}

function playMoveSound(move) {
  if (state.game.isGameOver()) {
    return;
  } else if (state.game.isCheck()) {
    playChessSound("check");
  } else if (move?.captured) {
    playChessSound("capture");
  } else {
    playChessSound("move");
  }
}

function moveSoundKind(move) {
  if (state.game.isGameOver()) {
    return "game-over";
  }
  if (state.game.isCheck()) {
    return "check";
  }
  return move?.captured ? "capture" : "move";
}

function soundFileUrl(fileName) {
  return `/sounds/${fileName.split("/").map((part) => encodeURIComponent(part)).join("/")}`;
}

async function loadChessDialogBuffer(fileName) {
  if (chessDialogBuffers.has(fileName)) {
    return chessDialogBuffers.get(fileName);
  }
  if (chessDialogLoadPromises.has(fileName)) {
    return chessDialogLoadPromises.get(fileName);
  }
  const context = chessAudio();
  if (!context) {
    return null;
  }
  const promise = fetch(soundFileUrl(fileName), { cache: "force-cache" })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`Could not load dialog sound: ${fileName}`);
      }
      return response.arrayBuffer();
    })
    .then((raw) => context.decodeAudioData(raw))
    .then((buffer) => {
      chessDialogBuffers.set(fileName, buffer);
      return buffer;
    })
    .catch((error) => {
      console.warn(error);
      return null;
    })
    .finally(() => {
      chessDialogLoadPromises.delete(fileName);
    });
  chessDialogLoadPromises.set(fileName, promise);
  return promise;
}

function preloadChessDialogSounds() {
  Object.values(DIALOG_SOUND_FILES).flat().forEach((fileName) => {
    void loadChessDialogBuffer(fileName);
  });
}

function chooseDialogFile(key) {
  const files = DIALOG_SOUND_FILES[key] || [];
  if (!files.length) {
    return null;
  }
  const freshFiles = files.filter((fileName) => fileName !== state.lastDialogFile);
  const pool = freshFiles.length ? freshFiles : files;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function playChessDialog(key) {
  if (state.mode === "mapping") {
    return;
  }
  const fileName = chooseDialogFile(key);
  if (!fileName) {
    return;
  }
  const unlocked = await unlockChessAudio();
  const context = chessAudio();
  if (!unlocked || !context || context.state !== "running") {
    return;
  }
  const buffer = await loadChessDialogBuffer(fileName);
  if (!buffer || state.mode === "mapping") {
    return;
  }
  const source = context.createBufferSource();
  const gain = context.createGain();
  source.buffer = buffer;
  gain.gain.setValueAtTime(DIALOG_VOLUME, context.currentTime);
  source.connect(gain);
  gain.connect(context.destination);
  source.start();
  state.lastDialogFile = fileName;
}

function squarePoint(square) {
  return {
    file: FILES.indexOf(square[0]),
    rank: RANKS.indexOf(square[1]),
  };
}

function pointSquare(file, rank) {
  if (file < 0 || file >= FILES.length || rank < 0 || rank >= RANKS.length) {
    return null;
  }
  return `${FILES[file]}${RANKS[rank]}`;
}

function clearAttackLine(game, fromSquare, toSquare, fileStep, rankStep) {
  const from = squarePoint(fromSquare);
  const to = squarePoint(toSquare);
  let file = from.file + fileStep;
  let rank = from.rank + rankStep;
  while (file !== to.file || rank !== to.rank) {
    const square = pointSquare(file, rank);
    if (!square || game.get(square)) {
      return false;
    }
    file += fileStep;
    rank += rankStep;
  }
  return true;
}

function pieceAttacksSquare(game, piece, fromSquare, toSquare) {
  if (!piece || fromSquare === toSquare) {
    return false;
  }
  const from = squarePoint(fromSquare);
  const to = squarePoint(toSquare);
  const fileDelta = to.file - from.file;
  const rankDelta = to.rank - from.rank;
  const absFile = Math.abs(fileDelta);
  const absRank = Math.abs(rankDelta);
  const fileStep = Math.sign(fileDelta);
  const rankStep = Math.sign(rankDelta);

  if (piece.type === "p") {
    const pawnRankStep = piece.color === "w" ? 1 : -1;
    return absFile === 1 && rankDelta === pawnRankStep;
  }
  if (piece.type === "n") {
    return (absFile === 1 && absRank === 2) || (absFile === 2 && absRank === 1);
  }
  if (piece.type === "k") {
    return Math.max(absFile, absRank) === 1;
  }
  if (piece.type === "b") {
    return absFile === absRank && clearAttackLine(game, fromSquare, toSquare, fileStep, rankStep);
  }
  if (piece.type === "r") {
    return (absFile === 0 || absRank === 0) && clearAttackLine(game, fromSquare, toSquare, fileStep, rankStep);
  }
  if (piece.type === "q") {
    const straight = absFile === 0 || absRank === 0;
    const diagonal = absFile === absRank;
    return (straight || diagonal) && clearAttackLine(game, fromSquare, toSquare, fileStep, rankStep);
  }
  return false;
}

function findKingSquareInGame(game, color) {
  for (const rank of RANKS) {
    for (const file of FILES) {
      const square = `${file}${rank}`;
      const piece = game.get(square);
      if (piece?.color === color && piece.type === "k") {
        return square;
      }
    }
  }
  return null;
}

function squareDistance(a, b) {
  const left = squarePoint(a);
  const right = squarePoint(b);
  return Math.max(Math.abs(left.file - right.file), Math.abs(left.rank - right.rank));
}

function kingZoneSquares(kingSquare) {
  const center = squarePoint(kingSquare);
  const squares = [];
  for (let fileOffset = -1; fileOffset <= 1; fileOffset += 1) {
    for (let rankOffset = -1; rankOffset <= 1; rankOffset += 1) {
      const square = pointSquare(center.file + fileOffset, center.rank + rankOffset);
      if (square) {
        squares.push(square);
      }
    }
  }
  return squares;
}

function movedPieceAttacksValue(game, move, defenderColor, minimumValue) {
  const attacker = game.get(move.to);
  if (!attacker) {
    return false;
  }
  for (const rank of RANKS) {
    for (const file of FILES) {
      const square = `${file}${rank}`;
      const defender = game.get(square);
      if (
        defender?.color === defenderColor
        && defender.type !== "k"
        && (PIECE_VALUES[defender.type] || 0) >= minimumValue
        && pieceAttacksSquare(game, attacker, move.to, square)
      ) {
        return true;
      }
    }
  }
  return false;
}

function movePressuresKing(game, move, defenderColor) {
  if (game.isCheck()) {
    return true;
  }
  const kingSquare = findKingSquareInGame(game, defenderColor);
  if (!kingSquare) {
    return false;
  }
  const movedPiece = game.get(move.to);
  if (!movedPiece) {
    return false;
  }
  return squareDistance(move.to, kingSquare) <= 2
    && kingZoneSquares(kingSquare).some((square) => pieceAttacksSquare(game, movedPiece, move.to, square));
}

function moveCreatesThreat(game, move, defenderColor) {
  return movedPieceAttacksValue(game, move, defenderColor, PIECE_VALUES.n) || movePressuresKing(game, move, defenderColor);
}

function captureDialogChance(move, pawnChance, pieceChance) {
  return (PIECE_VALUES[move?.captured] || 0) >= PIECE_VALUES.n ? pieceChance : pawnChance;
}

function choosePlayerDialog(move) {
  if (state.game.isCheckmate()) {
    return { key: "gameCheckmate", chance: 1, ignoreCooldown: true };
  }
  if (state.game.isGameOver()) {
    return null;
  }
  const defenderColor = robotChessColor();
  if (movePressuresKing(state.game, move, defenderColor)) {
    return { key: "playerPressure", chance: 0.7 };
  }
  if (moveCreatesThreat(state.game, move, defenderColor)) {
    return { key: "playerTrap", chance: move?.captured ? 0.55 : 0.45 };
  }
  if (move?.promotion) {
    return { key: "playerNice", chance: 0.65 };
  }
  if (move?.captured) {
    return { key: "playerNice", chance: captureDialogChance(move, 0.3, 0.55) };
  }
  return { key: "playerInteresting", chance: 0.18 };
}

function chooseRobotDialog(move) {
  if (state.game.isCheckmate()) {
    return { key: "gameCheckmate", chance: 1, ignoreCooldown: true };
  }
  if (state.game.isGameOver()) {
    return null;
  }
  const defenderColor = playerChessColor();
  if (movePressuresKing(state.game, move, defenderColor)) {
    return { key: "robotWorried", chance: 0.75 };
  }
  if (move?.promotion) {
    return { key: "robotWaiting", chance: 0.65 };
  }
  if (move?.captured && (PIECE_VALUES[move.captured] || 0) >= PIECE_VALUES.r) {
    return { key: "robotBigCapture", chance: 0.62 };
  }
  if (move?.captured) {
    return { key: "robotGotcha", chance: captureDialogChance(move, 0.42, 0.58) };
  }
  if (moveCreatesThreat(state.game, move, defenderColor)) {
    return { key: "robotWaiting", chance: 0.45 };
  }
  return { key: "robotYourMove", chance: 0.24 };
}

function maybePlaySituationalDialog(speaker, move) {
  if (state.mode === "mapping") {
    return;
  }
  state.dialogTurn += 1;
  const candidate = speaker === "robot" ? chooseRobotDialog(move) : choosePlayerDialog(move);
  if (!candidate) {
    return;
  }
  if (!candidate.ignoreCooldown && state.dialogTurn - state.lastDialogTurn < DIALOG_COOLDOWN_TURNS) {
    return;
  }
  const chance = candidate.key === state.lastDialogKey ? candidate.chance * 0.35 : candidate.chance;
  if (Math.random() > chance) {
    return;
  }
  const generation = state.dialogGeneration;
  state.lastDialogTurn = state.dialogTurn;
  state.lastDialogKey = candidate.key;
  window.setTimeout(() => {
    if (state.dialogGeneration === generation && state.stage === "play") {
      void playChessDialog(candidate.key);
    }
  }, DIALOG_DELAY_MS);
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

class OfflineStockfishEngine {
  constructor() {
    this.worker = null;
    this.readyPromise = null;
    this.listeners = [];
  }

  ensure() {
    if (this.readyPromise) {
      return this.readyPromise;
    }
    if (typeof Worker !== "function") {
      return Promise.reject(new Error("Web Workers are unavailable"));
    }

    this.readyPromise = new Promise((resolve, reject) => {
      this.worker = new Worker(STOCKFISH_SCRIPT);
      const timeout = window.setTimeout(() => {
        reject(new Error("Offline Stockfish did not initialize"));
      }, 15000);

      this.worker.addEventListener("message", (event) => {
        this.handleLine(String(event.data || ""));
      });
      this.worker.addEventListener("error", (event) => {
        reject(new Error(event.message || "Offline Stockfish failed"));
      });

      this.waitForLine((line) => line === "uciok", 12000)
        .then(() => {
          const ready = this.waitForLine((line) => line === "readyok", 12000);
          this.post("isready");
          return ready;
        })
        .then(() => {
          window.clearTimeout(timeout);
          resolve();
        })
        .catch((error) => {
          window.clearTimeout(timeout);
          reject(error);
        });

      this.post("uci");
    }).catch((error) => {
      this.dispose();
      throw error;
    });

    return this.readyPromise;
  }

  handleLine(line) {
    this.listeners = this.listeners.filter((listener) => {
      if (!listener.match(line)) {
        return true;
      }
      window.clearTimeout(listener.timer);
      listener.resolve(line);
      return false;
    });
  }

  post(command) {
    if (!this.worker) {
      throw new Error("Offline Stockfish is not ready");
    }
    this.worker.postMessage(command);
  }

  waitForLine(match, timeoutMs) {
    return new Promise((resolve, reject) => {
      const listener = {
        match,
        resolve,
        timer: window.setTimeout(() => {
          this.listeners = this.listeners.filter((candidate) => candidate !== listener);
          reject(new Error("Offline Stockfish timed out"));
        }, timeoutMs),
      };
      this.listeners.push(listener);
    });
  }

  async configure(difficulty) {
    const profile = STOCKFISH_PROFILES[difficulty] || STOCKFISH_PROFILES.medium;
    this.post("stop");
    this.post("ucinewgame");
    this.post(`setoption name Skill Level value ${profile.skill}`);
    this.post(`setoption name UCI_LimitStrength value ${profile.limitStrength ? "true" : "false"}`);
    if (profile.limitStrength) {
      this.post(`setoption name UCI_Elo value ${profile.elo}`);
    }
    const ready = this.waitForLine((line) => line === "readyok", 7000);
    this.post("isready");
    await ready;
    return profile;
  }

  async bestMove(fen, difficulty) {
    await this.ensure();
    try {
      const profile = await this.configure(difficulty);
      this.post(`position fen ${fen}`);
      const bestMove = this.waitForLine((message) => message.startsWith("bestmove "), profile.movetime + 7000);
      this.post(`go movetime ${profile.movetime}`);
      const line = await bestMove;
      const uci = line.split(/\s+/)[1];
      return uci && uci !== "(none)" ? uci : null;
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  dispose() {
    if (this.worker) {
      this.worker.terminate();
    }
    this.worker = null;
    this.readyPromise = null;
    this.listeners.forEach((listener) => window.clearTimeout(listener.timer));
    this.listeners = [];
  }
}

async function loadSetupFromMappingFile() {
  try {
    const payload = await api("/api/game-mapping?game=chess");
    if (!payload.exists || !payload.setup) {
      return;
    }
    window.localStorage.setItem(CHESS_STORAGE_KEY, JSON.stringify(payload.setup));
    state.setup = loadSetup();
  } catch (error) {
    console.warn("Could not load Chess mapping file", error);
  }
}

function saveSetupToMappingFile() {
  void api("/api/game-mapping", {
    method: "POST",
    body: { game: "chess", setup: state.setup },
  }).catch((error) => {
    console.warn("Could not save Chess mapping file", error);
  });
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function titleCase(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "-";
}

function robotModeLabel() {
  return state.setup?.robotMode === "api" ? "DOBOT + Queue" : "Preview Only";
}

function difficultyLabel(value = state.setup?.difficulty) {
  if (value === "easy") {
    return "Easy";
  }
  if (value === "hard") {
    return "Hard";
  }
  return "Medium";
}

function squareToTarget(square) {
  return square.toUpperCase();
}

function targetFor(squareOrTarget) {
  const key = squareOrTarget.length === 2 ? squareOrTarget.toUpperCase() : squareOrTarget;
  const target = state.setup.targets?.[key];
  if (!target?.joints) {
    throw new Error(`Missing chess mapping for ${key}`);
  }
  return target;
}

function normalizeTarget(target, slot) {
  if (!target || typeof target !== "object" || !Array.isArray(target.joints) || target.joints.length !== 6) {
    return null;
  }
  const joints = target.joints.map((value) => Number(value));
  if (joints.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return {
    ...target,
    slot,
    joints,
    pose: Array.isArray(target.pose) ? target.pose.map((value) => Number(value)) : null,
  };
}

function loadSetup() {
  const defaults = {
    displayMode: "current",
    robotMode: "preview",
    playerColor: "white",
    difficulty: "medium",
    moveDwellMs: 450,
    targets: {},
  };
  try {
    const raw = JSON.parse(window.localStorage.getItem(CHESS_STORAGE_KEY) || "{}");
    const setup = {
      ...defaults,
      ...raw,
      robotMode: ["preview", "api"].includes(raw.robotMode) ? raw.robotMode : defaults.robotMode,
      playerColor: raw.playerColor === "black" ? "black" : "white",
      difficulty: ["easy", "medium", "hard"].includes(raw.difficulty) ? raw.difficulty : defaults.difficulty,
      moveDwellMs: Math.max(100, Math.min(3000, Number(raw.moveDwellMs || defaults.moveDwellMs) || defaults.moveDwellMs)),
      targets: {},
    };
    Object.entries(raw.targets || {}).forEach(([slot, target]) => {
      setup.targets[slot] = normalizeTarget(target, slot);
    });
    if (!setup.targets.ANCHOR && raw.targets?.CAPTURE) {
      setup.targets.ANCHOR = normalizeTarget(raw.targets.CAPTURE, "ANCHOR");
    }
    return setup;
  } catch {
    return defaults;
  }
}

function saveSetup() {
  window.localStorage.setItem(CHESS_STORAGE_KEY, JSON.stringify(state.setup));
  saveSetupToMappingFile();
}

function loadPlayerName() {
  try {
    return window.localStorage.getItem(CHESS_PLAYER_KEY) || "";
  } catch {
    return "";
  }
}

function savePlayerName() {
  window.localStorage.setItem(CHESS_PLAYER_KEY, state.playerName || "Player");
}

function playerDisplayColor() {
  return state.setup.playerColor === "black" ? "b" : "w";
}

function robotDisplayColor() {
  return playerDisplayColor() === "w" ? "b" : "w";
}

function playerChessColor() {
  return state.setup.playerColor === "black" ? "b" : "w";
}

function robotChessColor() {
  return playerChessColor() === "w" ? "b" : "w";
}

function visualPieceColor(color) {
  return color;
}

function colorName(color) {
  return color === "w" ? "White" : "Black";
}

function isHumanTurn() {
  return state.mode !== "mapping" && !state.busy && !state.game.isGameOver() && state.game.turn() === playerChessColor();
}

function orientedFiles() {
  return FILES;
}

function orientedRanks() {
  return [...RANKS].reverse();
}

function isDarkSquare(square) {
  const fileIndex = FILES.indexOf(square[0]);
  const rank = Number(square[1]);
  return (fileIndex + rank) % 2 === 1;
}

function getLegalMoves(square) {
  return state.game.moves({ square, verbose: true });
}

function choosePromotionMove(moves) {
  return moves.find((move) => move.promotion === "q") || moves[0] || null;
}

function setStage(nextStage) {
  state.stage = nextStage;
  document.body.dataset.stage = nextStage;
  document.body.dataset.mode = state.mode;
  $("name-stage").classList.toggle("active", nextStage === "name");
  $("setup-stage").classList.toggle("active", nextStage === "setup");
  $("play-stage").classList.toggle("active", nextStage === "play");
}

async function enterFullscreen() {
  if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // Browsers may block fullscreen unless the popup was opened by a direct click.
    }
  }
}

function buildKeyboard() {
  const grid = $("keyboard-grid");
  grid.innerHTML = "";
  KEYBOARD_LAYOUT.flat().forEach((key) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "key-button";
    button.textContent = key;
    button.addEventListener("click", () => {
      if (state.playerName.length >= 18) {
        return;
      }
      state.playerName += key;
      updateNameDisplay();
    });
    grid.appendChild(button);
  });
}

function updateNameDisplay() {
  $("player-name-display").textContent = state.playerName || "_";
  $("name-next-button").disabled = state.playerName.trim().length < 1;
}

function renderSetupChoices() {
  document.querySelectorAll("[data-side]").forEach((button) => {
    button.classList.toggle("active", button.dataset.side === state.setup.playerColor);
  });
  document.querySelectorAll("[data-difficulty]").forEach((button) => {
    button.classList.toggle("active", button.dataset.difficulty === state.setup.difficulty);
  });
  $("setup-summary").textContent = `${state.playerName || "Player"} plays ${titleCase(state.setup.playerColor)} at ${difficultyLabel()} difficulty. Motion: ${robotModeLabel()}.`;
}

function renderLabels() {
  $("rank-labels").innerHTML = orientedRanks().map((rank) => `<span>${rank}</span>`).join("");
  $("file-labels").innerHTML = orientedFiles().map((file) => `<span>${file.toUpperCase()}</span>`).join("");
}

function renderMeta() {
  $("player-name-label").textContent = state.playerName || "Player";
  $("player-color-label").textContent = colorName(playerDisplayColor());
  $("robot-color-label").textContent = colorName(robotDisplayColor());
  $("difficulty-label").textContent = difficultyLabel();
  $("robot-step-note").textContent = state.setup.robotMode === "api"
    ? "DOBOT movement is live. The robot uses source square, Anchor, destination, then returns to standby."
    : "Preview Only is active. The screen simulates robot timing, but no DOBOT movement command is sent.";
}

function renderBoard() {
  renderLabels();
  renderMeta();
  const board = $("chess-board");
  board.classList.toggle("input-paused", state.busy);
  board.classList.toggle("mapping-preview", state.mode === "mapping");
  const legalTargets = new Map();
  state.legalMoves.forEach((move) => {
    if (!legalTargets.has(move.to)) {
      legalTargets.set(move.to, []);
    }
    legalTargets.get(move.to).push(move);
  });
  board.innerHTML = "";

  orientedRanks().forEach((rank) => {
    orientedFiles().forEach((file) => {
      const square = `${file}${rank}`;
      const piece = state.mode === "mapping" || state.robotRemovedSquare === square ? null : state.game.get(square);
      const displayColor = piece ? visualPieceColor(piece.color) : null;
      const legal = legalTargets.has(square);
      const legalMove = legal ? choosePromotionMove(legalTargets.get(square)) : null;
      const robotStage = state.robotStage;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chess-square";
      button.dataset.square = square;
      button.classList.toggle("dark", isDarkSquare(square));
      button.classList.toggle("has-piece", Boolean(piece));
      button.classList.toggle("white-piece", displayColor === "w");
      button.classList.toggle("black-piece", displayColor === "b");
      button.classList.toggle("selected", state.selectedSquare === square);
      button.classList.toggle("legal", legal);
      button.classList.toggle("capture", Boolean(legalMove?.captured));
      button.classList.toggle("last-move", state.lastMove?.from === square || state.lastMove?.to === square);
      button.classList.toggle("check", isKingInCheck(square, piece));
      button.classList.toggle("robot-selected", robotStage?.phase === "selected" && robotStage.from === square);
      button.classList.toggle("robot-destination", robotStage?.phase === "destination" && robotStage.to === square);
      button.classList.toggle("robot-capture", robotStage?.phase === "capture" && robotStage.capture === square);
      button.innerHTML = state.mode === "mapping"
        ? `<span class="square-label">${squareToTarget(square)}</span>`
        : piece
        ? `<span class="piece-token" aria-label="${colorName(displayColor)} ${PIECE_NAMES[piece.type]}">${PIECE_SYMBOLS[piece.type]}</span>`
        : "";
      button.disabled = state.mode === "mapping" || state.game.isGameOver();
      button.setAttribute("aria-disabled", state.mode === "mapping" || state.busy ? "true" : "false");
      button.addEventListener("click", () => handleSquareClick(square));
      board.appendChild(button);
    });
  });
}

function isKingInCheck(square, piece) {
  if (!piece || piece.type !== "k" || !state.game.isCheck()) {
    return false;
  }
  return piece.color === state.game.turn() && square === findKingSquare(piece.color);
}

function findKingSquare(color) {
  for (const rank of RANKS) {
    for (const file of FILES) {
      const square = `${file}${rank}`;
      const piece = state.game.get(square);
      if (piece?.type === "k" && piece.color === color) {
        return square;
      }
    }
  }
  return null;
}

function renderMoveList() {
  const list = $("move-list");
  const history = state.game.history({ verbose: true });
  list.innerHTML = "";
  if (!history.length) {
    const empty = document.createElement("div");
    empty.className = "move-empty";
    empty.textContent = "No moves yet";
    list.appendChild(empty);
    return;
  }
  for (let index = 0; index < history.length; index += 2) {
    const white = history[index];
    const black = history[index + 1];
    const row = document.createElement("div");
    row.className = "move-row";
    row.textContent = `${Math.floor(index / 2) + 1}. ${white?.san || ""}${black ? `  ${black.san}` : ""}`;
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

function updateTurnCopy() {
  if (state.mode === "mapping" && state.stage === "play") {
    $("play-title").textContent = "Board Mapping";
    $("turn-note").textContent = "Use this exact board size and location while mapping A1 through H8.";
    return;
  }
  if (state.stage !== "play" || state.game.isGameOver() || state.busy) {
    return;
  }
  if (isHumanTurn()) {
    $("play-title").textContent = `${state.playerName || "Player"} to move`;
    $("turn-note").textContent = state.selectedSquare
      ? "Green borders show the legal destination cells."
      : "Select one of your pieces.";
  } else {
    $("play-title").textContent = "Robot turn";
    $("turn-note").textContent = "DOBOT is choosing a legal move.";
  }
}

function renderAll() {
  renderBoard();
  renderMoveList();
  updateTurnCopy();
}

function clearSelection() {
  state.selectedSquare = null;
  state.legalMoves = [];
}

function selectSquare(square) {
  state.selectedSquare = square;
  state.legalMoves = getLegalMoves(square);
  playChessSound("select");
  renderAll();
}

async function handleSquareClick(square) {
  void unlockChessAudio();
  if (!isHumanTurn()) {
    return;
  }

  const piece = state.game.get(square);
  const selectedMoves = state.selectedSquare
    ? state.legalMoves.filter((move) => move.to === square)
    : [];

  if (selectedMoves.length) {
    const move = choosePromotionMove(selectedMoves);
    await makeHumanMove(move);
    return;
  }

  if (piece?.color === playerChessColor()) {
    selectSquare(square);
    return;
  }

  clearSelection();
  renderAll();
}

async function makeHumanMove(move) {
  clearSelection();
  const moved = state.game.move({
    from: move.from,
    to: move.to,
    promotion: move.promotion || "q",
  });
  state.lastMove = moved;
  playMoveSound(moved);
  renderAll();
  maybePlaySituationalDialog("player", moved);
  if (finishIfGameOver()) {
    return;
  }
  $("play-title").textContent = "Robot turn";
  $("turn-note").textContent = "DOBOT is choosing a legal move.";
  await sleep(350);
  await runRobotTurn();
}

function pieceSquareScore(piece, square) {
  const table = PIECE_SQUARE_TABLES[piece.type];
  if (!table) {
    return 0;
  }
  const fileIndex = FILES.indexOf(square[0]);
  const rankIndex = Number(square[1]) - 1;
  const tableRank = piece.color === "w" ? rankIndex : 7 - rankIndex;
  return table[tableRank]?.[fileIndex] || 0;
}

function evaluateBoard(game, color) {
  if (game.isCheckmate()) {
    return game.turn() === color ? -CHECKMATE_SCORE : CHECKMATE_SCORE;
  }
  if (game.isDraw()) {
    return 0;
  }

  let score = 0;
  let bishops = { w: 0, b: 0 };
  for (const rank of RANKS) {
    for (const file of FILES) {
      const square = `${file}${rank}`;
      const piece = game.get(square);
      if (!piece) {
        continue;
      }
      const sign = piece.color === color ? 1 : -1;
      score += sign * ((PIECE_VALUES[piece.type] || 0) + pieceSquareScore(piece, square));
      if (piece.type === "b") {
        bishops[piece.color] += 1;
      }
    }
  }

  if (bishops[color] >= 2) {
    score += 35;
  }
  const opponent = color === "w" ? "b" : "w";
  if (bishops[opponent] >= 2) {
    score -= 35;
  }
  if (game.isCheck()) {
    score += game.turn() === color ? -45 : 45;
  }
  return score;
}

function moveSearchScore(move) {
  let score = 0;
  if (move.captured) {
    score += (PIECE_VALUES[move.captured] || 0) * 10 - (PIECE_VALUES[move.piece] || 0);
  }
  if (move.promotion) {
    score += PIECE_VALUES[move.promotion] || 900;
  }
  if (move.flags?.includes("k") || move.flags?.includes("q")) {
    score += 80;
  }
  if (move.san?.includes("+")) {
    score += 55;
  }
  return score;
}

function orderedMoves(game) {
  return game.moves({ verbose: true }).sort((a, b) => moveSearchScore(b) - moveSearchScore(a));
}

function applySearchMove(game, move) {
  return game.move({
    from: move.from,
    to: move.to,
    promotion: move.promotion || "q",
  });
}

function searchTimedOut(context) {
  context.nodes += 1;
  if ((context.nodes & 1023) !== 0) {
    return context.timedOut;
  }
  context.timedOut = Date.now() >= context.endTime;
  return context.timedOut;
}

function quiescence(game, alpha, beta, color, context, depth) {
  const standPat = evaluateBoard(game, color);
  const maximizing = game.turn() === color;
  if (depth <= 0 || searchTimedOut(context)) {
    return standPat;
  }

  if (maximizing) {
    if (standPat >= beta) {
      return beta;
    }
    let best = Math.max(alpha, standPat);
    const captures = orderedMoves(game).filter((move) => move.captured || move.promotion);
    for (const move of captures) {
      applySearchMove(game, move);
      const score = quiescence(game, best, beta, color, context, depth - 1);
      game.undo();
      if (score > best) {
        best = score;
      }
      if (best >= beta || context.timedOut) {
        break;
      }
    }
    return best;
  }

  if (standPat <= alpha) {
    return alpha;
  }
  let best = Math.min(beta, standPat);
  const captures = orderedMoves(game).filter((move) => move.captured || move.promotion);
  for (const move of captures) {
    applySearchMove(game, move);
    const score = quiescence(game, alpha, best, color, context, depth - 1);
    game.undo();
    if (score < best) {
      best = score;
    }
    if (best <= alpha || context.timedOut) {
      break;
    }
  }
  return best;
}

function searchPosition(game, depth, alpha, beta, color, context) {
  if (depth <= 0 || game.isGameOver() || searchTimedOut(context)) {
    return quiescence(game, alpha, beta, color, context, 2);
  }

  const moves = orderedMoves(game);
  if (!moves.length) {
    return evaluateBoard(game, color);
  }

  if (game.turn() === color) {
    let best = -Infinity;
    for (const move of moves) {
      applySearchMove(game, move);
      const score = searchPosition(game, depth - 1, alpha, beta, color, context);
      game.undo();
      if (score > best) {
        best = score;
      }
      alpha = Math.max(alpha, best);
      if (alpha >= beta || context.timedOut) {
        break;
      }
    }
    return best;
  }

  let best = Infinity;
  for (const move of moves) {
    applySearchMove(game, move);
    const score = searchPosition(game, depth - 1, alpha, beta, color, context);
    game.undo();
    if (score < best) {
      best = score;
    }
    beta = Math.min(beta, best);
    if (alpha >= beta || context.timedOut) {
      break;
    }
  }
  return best;
}

function chooseScoredMove(scoredMoves, profile) {
  const ranked = [...scoredMoves].sort((a, b) => b.score - a.score);
  const topCount = Math.min(profile.randomTop, ranked.length);
  if (topCount <= 1) {
    return ranked[0]?.move || null;
  }
  return ranked[Math.floor(Math.random() * topCount)]?.move || ranked[0]?.move || null;
}

function chooseFallbackRobotMove() {
  const rootMoves = orderedMoves(state.game);
  if (!rootMoves.length) {
    return null;
  }

  const difficulty = state.setup.difficulty;
  const profile = SEARCH_PROFILES[difficulty] || SEARCH_PROFILES.medium;
  const color = robotChessColor();
  const searchGame = new Chess(state.game.fen());
  const context = {
    endTime: Date.now() + profile.timeMs,
    nodes: 0,
    timedOut: false,
  };
  let bestScored = rootMoves.map((move) => ({ move, score: -Infinity }));

  for (let depth = 1; depth <= profile.maxDepth; depth += 1) {
    const scored = [];
    let completedDepth = true;
    for (const move of rootMoves) {
      applySearchMove(searchGame, move);
      let score = searchPosition(searchGame, depth - 1, -Infinity, Infinity, color, context);
      searchGame.undo();
      if (profile.noise > 0) {
        score += (Math.random() - 0.5) * profile.noise;
      }
      scored.push({ move, score });
      if (context.timedOut) {
        completedDepth = false;
        break;
      }
    }
    if (completedDepth && scored.length) {
      bestScored = scored;
    } else if (bestScored.every((entry) => entry.score === -Infinity) && scored.length) {
      bestScored = scored;
    }
    if (!completedDepth) {
      break;
    }
  }

  return chooseScoredMove(bestScored, profile);
}

function stockfishEngineInstance() {
  if (!stockfishEngine) {
    stockfishEngine = new OfflineStockfishEngine();
  }
  return stockfishEngine;
}

function moveFromUci(uci) {
  if (!uci || uci.length < 4) {
    return null;
  }
  const from = uci.slice(0, 2);
  const to = uci.slice(2, 4);
  const promotion = uci.slice(4, 5) || undefined;
  return state.game.moves({ verbose: true }).find((move) => (
    move.from === from
    && move.to === to
    && (!promotion || move.promotion === promotion)
  )) || null;
}

async function chooseRobotMove() {
  try {
    const uci = await stockfishEngineInstance().bestMove(state.game.fen(), state.setup.difficulty);
    const engineMove = moveFromUci(uci);
    if (engineMove) {
      return engineMove;
    }
  } catch (error) {
    console.warn("Offline Stockfish unavailable, using local search fallback", error);
  }
  return chooseFallbackRobotMove();
}

function getCastleRookMove(move) {
  if (!move.flags?.includes("k") && !move.flags?.includes("q")) {
    return null;
  }
  const rank = move.color === "w" ? "1" : "8";
  if (move.flags.includes("k")) {
    return { from: `h${rank}`, to: `f${rank}` };
  }
  return { from: `a${rank}`, to: `d${rank}` };
}

async function acquireRobotQueue(taskId, move) {
  if (state.setup.robotMode === "preview") {
    return;
  }
  await api("/api/3ttt/queue/acquire", {
    method: "POST",
    body: {
      task_id: taskId,
      board_id: "chess",
      board_name: "chess",
      player_name: state.playerName,
      cell: `${squareToTarget(move.from)}-${squareToTarget(move.to)}`,
      timeout: 900,
    },
  });
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
    console.warn("Chess queue release failed", error);
  }
}

async function moveRobotTo(slot) {
  if (state.setup.robotMode === "preview") {
    await sleep(300);
    return;
  }
  const target = targetFor(slot);
  await api("/api/joint-movej", {
    method: "POST",
    body: {
      joints: target.joints,
      sync: true,
    },
  });
}

function setRobotStage(stage) {
  state.robotStage = stage;
  renderAll();
}

async function transferPiece(fromSquare, toSquare, label, moveForSound = null) {
  $("turn-note").textContent = `${label}: DOBOT moving to ${squareToTarget(fromSquare)}.`;
  await moveRobotTo(squareToTarget(fromSquare));
  setRobotStage({ phase: "selected", from: fromSquare, to: toSquare });
  playChessSound("select");
  $("turn-note").textContent = `${label}: DOBOT selected ${squareToTarget(fromSquare)}.`;
  await sleep(state.setup.moveDwellMs);
  $("turn-note").textContent = `${label}: DOBOT moving through anchor.`;
  await moveRobotTo("ANCHOR");
  $("turn-note").textContent = `${label}: DOBOT moving to ${squareToTarget(toSquare)}.`;
  await moveRobotTo(squareToTarget(toSquare));
  setRobotStage({ phase: "destination", from: fromSquare, to: toSquare });
  playChessSound(moveForSound?.captured ? "capture" : "move");
  $("turn-note").textContent = `${label}: DOBOT placed on ${squareToTarget(toSquare)}.`;
  await sleep(state.setup.moveDwellMs);
}

function moveEndsGame(move) {
  const copy = new Chess(state.game.fen());
  copy.move({ from: move.from, to: move.to, promotion: move.promotion || "q" });
  return copy.isGameOver();
}

async function executeRobotMove(move, commitMove) {
  const taskId = `chess_${CLIENT_ID}_${String(state.taskSeq++).padStart(3, "0")}`;
  const gameEnds = moveEndsGame(move);
  let queueAcquired = false;
  await acquireRobotQueue(taskId, move);
  queueAcquired = state.setup.robotMode !== "preview";

  try {
    $("turn-note").textContent = queueAcquired ? "Robot queue acquired." : "Previewing DOBOT move.";
    await moveRobotTo("STANDBY");

    await transferPiece(move.from, move.to, "Move robot piece", move);

    const rookMove = getCastleRookMove(move);
    if (rookMove) {
      await moveRobotTo("STANDBY");
      await transferPiece(rookMove.from, rookMove.to, "Move castling rook", rookMove);
    }

    commitMove();
    state.robotStage = null;
    state.robotRemovedSquare = null;
    renderAll();
    $("turn-note").textContent = gameEnds ? "DOBOT returning home." : "DOBOT returning to standby.";
    await moveRobotTo(gameEnds ? "HOME" : "STANDBY");
  } finally {
    if (queueAcquired) {
      await releaseRobotQueue(taskId);
    }
  }
}

async function runRobotTurn() {
  await unlockChessAudio();
  state.busy = true;
  state.robotStage = null;
  state.robotRemovedSquare = null;
  $("play-title").textContent = "Robot turn";
  $("turn-note").textContent = "DOBOT is thinking with the offline engine.";
  renderAll();

  try {
    const move = await chooseRobotMove();
    if (!move) {
      state.busy = false;
      finishIfGameOver();
      return;
    }
    $("turn-note").textContent = "DOBOT is moving to make its selection.";
    renderAll();
    let moved = null;
    await executeRobotMove(move, () => {
      moved = state.game.move({
        from: move.from,
        to: move.to,
        promotion: move.promotion || "q",
      });
      state.lastMove = moved;
      playChessSound(moveSoundKind(moved));
      maybePlaySituationalDialog("robot", moved);
    });
    state.busy = false;
    state.robotStage = null;
    state.robotRemovedSquare = null;
    renderAll();
    if (!finishIfGameOver()) {
      $("play-title").textContent = `${state.playerName || "Player"} to move`;
      $("turn-note").textContent = "Select one of your pieces. Legal destinations get green borders.";
    }
  } catch (error) {
    state.busy = false;
    state.robotStage = null;
    $("play-title").textContent = "Robot move failed";
    $("turn-note").textContent = error.message;
    renderAll();
  }
}

function finishIfGameOver() {
  if (!state.game.isGameOver()) {
    return false;
  }
  let title = "Game Over";
  let copy = "The game is complete.";
  if (state.game.isCheckmate()) {
    const winner = state.game.turn() === "w" ? "Black" : "White";
    title = "Checkmate";
    copy = `${winner} wins.`;
  } else if (state.game.isDraw()) {
    title = "Draw";
    copy = "The game ended in a draw.";
  }
  const alreadyVisible = $("result-overlay").classList.contains("visible");
  $("play-title").textContent = title;
  $("turn-note").textContent = copy;
  $("result-title").textContent = title;
  $("result-copy").textContent = copy;
  $("result-overlay").classList.add("visible");
  if (!alreadyVisible) {
    playChessSound("game-over");
  }
  renderAll();
  return true;
}

function resetGame() {
  state.game = new Chess();
  clearSelection();
  state.busy = false;
  state.lastMove = null;
  state.robotStage = null;
  state.robotRemovedSquare = null;
  state.dialogTurn = 0;
  state.lastDialogTurn = -10;
  state.lastDialogKey = null;
  state.lastDialogFile = null;
  state.dialogGeneration += 1;
  $("result-overlay").classList.remove("visible");
  renderAll();
  if (state.stage === "play" && state.game.turn() === robotChessColor()) {
    window.setTimeout(() => {
      runRobotTurn();
    }, 450);
  }
}

function startGame() {
  state.playerName = state.playerName.trim() || "Player";
  savePlayerName();
  saveSetup();
  void unlockChessAudio();
  playChessSound("move");
  setStage("play");
  resetGame();
}

function showSetupStage() {
  if (state.busy) {
    return;
  }
  $("result-overlay").classList.remove("visible");
  renderSetupChoices();
  setStage("setup");
}

function openMappingBoard() {
  state.game = new Chess();
  clearSelection();
  state.busy = false;
  state.lastMove = null;
  state.robotStage = null;
  state.robotRemovedSquare = null;
  state.dialogTurn = 0;
  state.lastDialogTurn = -10;
  state.lastDialogKey = null;
  state.lastDialogFile = null;
  state.dialogGeneration += 1;
  $("result-overlay").classList.remove("visible");
  setStage("play");
  renderAll();
}

function attachEvents() {
  ["pointerdown", "keydown", "touchstart"].forEach((eventName) => {
    document.addEventListener(eventName, () => {
      void unlockChessAudio();
    }, { capture: true, passive: true });
  });

  $("close-button").addEventListener("click", () => {
    window.close();
    if (!window.closed) {
      window.location.href = "/";
    }
  });

  $("fullscreen-button").addEventListener("click", async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await enterFullscreen();
    }
  });

  $("keyboard-backspace-button").addEventListener("click", () => {
    state.playerName = state.playerName.slice(0, -1);
    updateNameDisplay();
  });

  $("keyboard-space-button").addEventListener("click", () => {
    if (state.playerName.length >= 18 || state.playerName.endsWith(" ")) {
      return;
    }
    state.playerName += " ";
    updateNameDisplay();
  });

  $("name-next-button").addEventListener("click", () => {
    if (state.playerName.trim().length < 1) {
      return;
    }
    state.playerName = state.playerName.trim();
    savePlayerName();
    renderSetupChoices();
    setStage("setup");
  });

  $("setup-back-button").addEventListener("click", () => {
    setStage("name");
  });

  $("start-game-button").addEventListener("click", startGame);

  document.querySelectorAll("[data-side]").forEach((button) => {
    button.addEventListener("click", () => {
      state.setup.playerColor = button.dataset.side === "black" ? "black" : "white";
      saveSetup();
      renderSetupChoices();
    });
  });

  document.querySelectorAll("[data-difficulty]").forEach((button) => {
    button.addEventListener("click", () => {
      state.setup.difficulty = ["easy", "medium", "hard"].includes(button.dataset.difficulty)
        ? button.dataset.difficulty
        : "medium";
      saveSetup();
      renderSetupChoices();
    });
  });

  $("new-game-button").addEventListener("click", resetGame);
  $("change-setup-button").addEventListener("click", showSetupStage);
  $("result-new-button").addEventListener("click", resetGame);
  $("result-setup-button").addEventListener("click", showSetupStage);
}

async function init() {
  const params = new URLSearchParams(window.location.search);
  state.mode = params.get("mode") === "mapping" ? "mapping" : "play";
  document.body.dataset.mode = state.mode;
  state.setup = loadSetup();
  await loadSetupFromMappingFile();
  state.playerName = loadPlayerName();
  buildKeyboard();
  attachEvents();
  updateNameDisplay();
  renderSetupChoices();
  renderAll();
  if (state.mode === "mapping") {
    openMappingBoard();
  } else {
    setStage("name");
  }
  setTimeout(() => {
    void enterFullscreen();
  }, 250);
}

window.addEventListener("DOMContentLoaded", init);
