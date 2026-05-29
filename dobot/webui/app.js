const jointNames = ["J1", "J2", "J3", "J4", "J5", "J6"];
const enabledModes = new Set(["ENABLED", "RUNNING", "JOG", "PAUSED"]);
const MAIN_HOME_STORAGE_KEY = "dobot-main-home-v1";
const SEQUENCE_ORIENTATION_LOCK_STORAGE_KEY = "dobot-sequence-orientation-lock-v1";
const TTT_STORAGE_KEY = "dobot-tictactoe-setup-v1";
const THREE_TTT_STORAGE_KEY = "dobot-3ttt-setup-v1";
const MAPPING_FILE_SAVE_DEBOUNCE_MS = 150;
const mappingFileSaveTimers = new Map();
const mappingFileSaveErrors = new Set();
const TTT_TARGET_ORDER = ["HOME", "STANDBY", "A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];
const TTT_ANCHOR_TARGETS = ["HOME", "STANDBY"];
const TTT_BOARD_TARGETS = ["A1", "A2", "A3", "B1", "B2", "B3", "C1", "C2", "C3"];
const TTT_ROUTINE_KEYS = ["celebration", "loss"];
const THREE_TTT_BOARD_COUNTS = [1, 2, 3, 4];
const THREE_TTT_PRIORITY_PRESETS = {
  center_first: ["board2", "board1", "board3", "board4"],
  left_first: ["board1", "board2", "board3", "board4"],
  right_first: ["board3", "board2", "board1", "board4"],
};
const CHESS_STORAGE_KEY = "dobot-chess-setup-v1";
const CHESS_FILES = ["A", "B", "C", "D", "E", "F", "G", "H"];
const CHESS_RANKS = ["1", "2", "3", "4", "5", "6", "7", "8"];
const CHESS_BOARD_TARGETS = CHESS_RANKS.flatMap((rank) => CHESS_FILES.map((file) => `${file}${rank}`));
const CHESS_ANCHOR_TARGETS = ["HOME", "STANDBY", "ANCHOR"];
const CHESS_TARGET_ORDER = [...CHESS_ANCHOR_TARGETS, ...CHESS_BOARD_TARGETS];
const CHESS_CALIBRATION_SQUARES = [
  "A1",
  "A2",
  "B1",
  "A8",
  "A7",
  "B8",
  "H8",
  "G8",
  "H7",
  "H1",
  "G1",
  "H2",
];
const CHESS_CALIBRATION_APPROACH_Z_MM = 40;
const COFFEE_STORAGE_KEY = "dobot-coffee-setup-v1";
const OSC_C_STORAGE_KEY = "dobot-osc-c-setup-v1";
const COFFEE_TARGET_ORDER = ["HOME", "STANDBY"];
const COFFEE_ANCHOR_TARGETS = ["HOME", "STANDBY"];
const COFFEE_ROUTINE_KEYS = [
  "cup_pick",
  "machine_place",
  "machine_pickup",
  "delivery",
  "hot_water",
  "milk",
  "espresso",
  "cappuccino",
  "latte",
];
const COFFEE_CORE_ROUTINE_KEYS = ["cup_pick", "machine_place", "machine_pickup", "delivery"];
const COFFEE_RECIPES = [
  {
    key: "hot_water",
    label: "Hot Water",
    routineKey: "hot_water",
    defaultPourMs: 12000,
  },
  {
    key: "milk",
    label: "Milk",
    routineKey: "milk",
    defaultPourMs: 14000,
  },
  {
    key: "espresso",
    label: "Espresso",
    routineKey: "espresso",
    defaultPourMs: 18000,
  },
  {
    key: "cappuccino",
    label: "Cappuccino",
    routineKey: "cappuccino",
    defaultPourMs: 24000,
  },
  {
    key: "latte",
    label: "Latte",
    routineKey: "latte",
    defaultPourMs: 26000,
  },
];

const state = {
  snapshot: null,
  pollTimer: null,
  appliedSpeedRatio: null,
  speedApplyPromise: null,
  speedAutoApplyTimer: null,
  centerView: "dashboard",
  tictactoeSetup: null,
  tictactoeRoutineKey: "celebration",
  threeTttSetup: null,
  threeTttServoStatus: null,
  threeTttServoError: "",
  chessSetup: null,
  chessCalibrationRunning: false,
  chessCalibrationCancel: false,
  chessCalibrationStatus: "",
  coffeeSetup: null,
  coffeeRoutineKey: "cup_pick",
  oscCSetup: null,
  mainHomeTarget: null,
  sequenceOrientationLock: null,
  jogSpeedUserEdited: false,
  jogAccUserEdited: false,
};

function $(id) {
  return document.getElementById(id);
}

function formatNumber(value, digits = 3) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return Number(value).toFixed(digits);
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function coffeeMsToSeconds(value) {
  return Math.max(1, Math.round(Number(value || 0) / 1000));
}

function coffeeSecondsToMs(value) {
  return Math.max(1000, Math.round((Number(value) || 1) * 1000));
}

function addLog(message, type = "info") {
  const container = $("log-output");
  if (!container) {
    return;
  }

  const empty = container.querySelector(".log-empty");
  if (empty) {
    empty.remove();
  }

  const line = document.createElement("div");
  line.className = "log-line";

  const stamp = document.createElement("span");
  stamp.className = "log-time";
  stamp.textContent = new Date().toLocaleTimeString();

  const msg = document.createElement("span");
  const mappedType = type === "error" ? "err" : type === "success" ? "ok" : "info";
  msg.className = `log-msg ${mappedType}`;
  msg.textContent = message;

  line.append(stamp, msg);
  container.prepend(line);
}

function clearLog() {
  const container = $("log-output");
  container.innerHTML = "";
  const empty = document.createElement("div");
  empty.className = "log-empty";
  empty.textContent = "No events yet.";
  container.appendChild(empty);
}

function setBusy(id, busy, busyLabel) {
  const button = $(id);
  if (!button) {
    return;
  }
  if (!button.dataset.defaultLabel) {
    button.dataset.defaultLabel = button.textContent;
  }
  button.disabled = busy;
  button.textContent = busy ? busyLabel : button.dataset.defaultLabel;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function writeMappingCache(storageKey, setup) {
  try {
    if (setup === null || setup === undefined) {
      window.localStorage.removeItem(storageKey);
      return;
    }
    window.localStorage.setItem(storageKey, JSON.stringify(setup));
  } catch (error) {
    console.warn(`Could not update ${storageKey} cache`, error);
  }
}

async function saveMappingToDiskNow(game, setup) {
  if (mappingFileSaveTimers.has(game)) {
    window.clearTimeout(mappingFileSaveTimers.get(game));
    mappingFileSaveTimers.delete(game);
  }
  return api("/api/game-mapping", {
    method: "POST",
    body: { game, setup },
  });
}

function scheduleMappingFileSave(game, setup) {
  if (mappingFileSaveTimers.has(game)) {
    window.clearTimeout(mappingFileSaveTimers.get(game));
  }
  const timer = window.setTimeout(async () => {
    mappingFileSaveTimers.delete(game);
    try {
      await saveMappingToDiskNow(game, setup);
      mappingFileSaveErrors.delete(game);
    } catch (error) {
      console.warn(`Could not save ${game} mapping file`, error);
      if (!mappingFileSaveErrors.has(game)) {
        mappingFileSaveErrors.add(game);
        addLog(`Could not save ${game} mapping file: ${error.message}`, "error");
      }
    }
  }, MAPPING_FILE_SAVE_DEBOUNCE_MS);
  mappingFileSaveTimers.set(game, timer);
}

function saveMappedSetup(game, storageKey, setup) {
  writeMappingCache(storageKey, setup);
  scheduleMappingFileSave(game, setup);
}

async function flushMappedSetup(game, storageKey, setup) {
  writeMappingCache(storageKey, setup);
  try {
    await saveMappingToDiskNow(game, setup);
    mappingFileSaveErrors.delete(game);
  } catch (error) {
    console.warn(`Could not flush ${game} mapping file`, error);
    if (!mappingFileSaveErrors.has(game)) {
      mappingFileSaveErrors.add(game);
      addLog(`Could not save ${game} mapping file: ${error.message}`, "error");
    }
  }
}

async function loadSavedMapping(game, normalizeSetup, fallback, storageKey, options = {}) {
  try {
    const payload = await api(`/api/game-mapping?game=${encodeURIComponent(game)}`);
    if (!payload.exists || (payload.setup === null && !options.allowNull)) {
      return { loaded: false, value: fallback, path: payload.path };
    }
    const value = normalizeSetup(payload.setup);
    writeMappingCache(storageKey, value);
    return { loaded: true, value, path: payload.path };
  } catch (error) {
    console.warn(`Could not load ${game} mapping file`, error);
    return { loaded: false, value: fallback, error };
  }
}

function readConfigForm() {
  return {
    host: $("host-input").value.trim(),
    dashboard_port: Number($("dashboard-port-input").value),
    motion_port: Number($("motion-port-input").value),
    timeout: Number($("timeout-input").value),
  };
}

function getSpeedRatio() {
  return Number($("speed-factor-input").value) || 20;
}

function getJogStep() {
  const value = Number($("joint-step-input").value);
  return Math.max(0.1, Math.min(180, Number.isFinite(value) ? value : 5));
}

function getJointSpeed() {
  const value = Number($("joint-speed-input").value);
  return Math.max(1, Math.min(100, Number.isFinite(value) ? value : getSpeedRatio()));
}

function getJointAcc() {
  const value = Number($("joint-acc-input").value);
  return Math.max(1, Math.min(100, Number.isFinite(value) ? value : getSpeedRatio()));
}

function syncJogSpeedInputs(ratio) {
  const value = Math.max(1, Math.min(100, Number.isFinite(Number(ratio)) ? Math.round(Number(ratio)) : getSpeedRatio()));
  const speedInput = $("joint-speed-input");
  const accInput = $("joint-acc-input");
  if (speedInput && !state.jogSpeedUserEdited && document.activeElement !== speedInput) {
    speedInput.value = String(value);
  }
  if (accInput && !state.jogAccUserEdited && document.activeElement !== accInput) {
    accInput.value = String(value);
  }
}

function updateSpeedLabel() {
  const ratio = getSpeedRatio();
  const value = `${ratio}%`;
  if ($("speed-display")) {
    $("speed-display").textContent = value;
  }
}

function setCenterView(view) {
  const allowedViews = new Set(["dashboard", "games-menu", "coffee", "tictactoe", "3ttt", "chess", "osc-c"]);
  const nextView = allowedViews.has(view) ? view : "dashboard";
  state.centerView = nextView;

  $("center-dashboard-view").classList.toggle("active", nextView === "dashboard");
  $("center-games-menu-view").classList.toggle("active", nextView === "games-menu");
  $("center-coffee-view").classList.toggle("active", nextView === "coffee");
  $("center-tictactoe-view").classList.toggle("active", nextView === "tictactoe");
  $("center-3ttt-view").classList.toggle("active", nextView === "3ttt");
  $("center-chess-view").classList.toggle("active", nextView === "chess");
  $("center-osc-c-view").classList.toggle("active", nextView === "osc-c");

  const gamesButton = $("games-button");
  const inGameArea = nextView !== "dashboard";
  gamesButton.classList.toggle("btn-nav-active", inGameArea);
  gamesButton.textContent = inGameArea ? "Controls" : "Games";

  if (nextView === "dashboard") {
    window.dobotRobotCad?.requestRender?.();
  }
}

function setConnectionCollapsed(collapsed) {
  const workspace = $("workspace");
  const closeButton = $("connection-collapse-button");
  const openButton = $("connection-drawer-tab");
  if (!workspace || !closeButton || !openButton) {
    return;
  }
  workspace.classList.toggle("left-collapsed", collapsed);
  closeButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
  openButton.setAttribute("aria-expanded", collapsed ? "false" : "true");
  try {
    window.localStorage.setItem("dobot-connection-collapsed-v1", collapsed ? "1" : "0");
  } catch {
    // Ignore unavailable storage.
  }
}

function loadConnectionCollapsed() {
  try {
    return window.localStorage.getItem("dobot-connection-collapsed-v1") === "1";
  } catch {
    return false;
  }
}

function setThemeMode(mode) {
  const nextMode = mode === "light" ? "light" : "dark";
  document.body.classList.toggle("light-theme", nextMode === "light");
  const button = $("theme-toggle-button");
  if (button) {
    button.textContent = nextMode === "light" ? "Dark" : "Light";
    button.setAttribute("aria-pressed", nextMode === "light" ? "true" : "false");
  }
  try {
    window.localStorage.setItem("dobot-theme-mode-v1", nextMode);
  } catch {
    // Ignore unavailable storage.
  }
}

function loadThemeMode() {
  try {
    return window.localStorage.getItem("dobot-theme-mode-v1") === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

function defaultTicTacToeRoutineState() {
  return {
    steps: [],
    selectedStepId: null,
    nextStepId: 1,
  };
}

function htmlText(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function defaultOscCSetup() {
  return {
    enabled: false,
    mode: "preview",
    listenPort: 9012,
    allowedHost: "",
    sendStatus: true,
    statusHost: "127.0.0.1",
    statusPort: 9013,
    statusAddress: "/dobot/osc_c/status",
    directRunAddress: "/dobot/run",
    directLoopAddress: "/dobot/loop",
    directStopAddress: "/dobot/stop",
    selectedSequenceId: "seq_1",
    nextSequenceId: 2,
    sequences: [
      {
        id: "seq_1",
        name: "Sequence 1",
        enabled: true,
        selectedStepId: null,
        nextStepId: 1,
        steps: [],
      },
    ],
    selectedRouteId: "route_1",
    nextRouteId: 2,
    routes: [
      {
        id: "route_1",
        enabled: true,
        address: "/robot/sequence1",
        argMatch: "",
        action: "run_once",
        sequenceId: "seq_1",
        onStartAddress: "",
        onStepAddress: "",
        onCompleteAddress: "",
        onErrorAddress: "",
      },
    ],
  };
}

function normalizeOptionalOscAddress(value) {
  const address = String(value || "").trim();
  return address.startsWith("/") ? address : "";
}

function normalizeOscCStep(raw, index) {
  const step = raw && typeof raw === "object" ? raw : {};
  const stepId = Number.isInteger(step.stepId) ? step.stepId : index + 1;
  const joints = Array.isArray(step.joints) && step.joints.length === 6
    ? step.joints.map((value) => Number(value))
    : null;
  const pose = Array.isArray(step.pose) && step.pose.length >= 3
    ? step.pose.map((value) => Number(value))
    : null;
  return {
    stepId,
    name: String(step.name || `Step ${index + 1}`),
    joints,
    pose,
    dwellMs: Math.max(0, Math.round(Number(step.dwellMs || 0) || 0)),
    capturedAt: typeof step.capturedAt === "string" ? step.capturedAt : null,
  };
}

function normalizeOscCSetup(raw) {
  const defaults = defaultOscCSetup();
  const source = raw && typeof raw === "object" ? raw : {};
  const sequences = Array.isArray(source.sequences)
    ? source.sequences.map((sequence, index) => {
      const next = sequence && typeof sequence === "object" ? sequence : {};
      const steps = Array.isArray(next.steps)
        ? next.steps.map((step, stepIndex) => normalizeOscCStep(step, stepIndex))
        : [];
      const selectedStepId = steps.some((step) => step.stepId === next.selectedStepId)
        ? next.selectedStepId
        : (steps[0]?.stepId ?? null);
      return {
        id: String(next.id || `seq_${index + 1}`),
        name: String(next.name || `Sequence ${index + 1}`),
        enabled: next.enabled !== false,
        selectedStepId,
        nextStepId: Math.max(Number(next.nextStepId) || 1, steps.reduce((maxId, step) => Math.max(maxId, step.stepId), 0) + 1),
        steps,
      };
    }).filter((sequence) => sequence.id)
    : [];
  if (!sequences.length) {
    sequences.push(...defaults.sequences.map((sequence) => ({ ...sequence, steps: [] })));
  }
  const sequenceIds = new Set(sequences.map((sequence) => sequence.id));
  const routes = Array.isArray(source.routes)
    ? source.routes.map((route, index) => {
      const next = route && typeof route === "object" ? route : {};
      const action = ["run_once", "play_loop", "stop"].includes(next.action) ? next.action : "run_once";
      const sequenceId = sequenceIds.has(String(next.sequenceId)) ? String(next.sequenceId) : sequences[0].id;
      const address = String(next.address || `/robot/sequence${index + 1}`).trim();
      return {
        id: String(next.id || `route_${index + 1}`),
        enabled: next.enabled !== false,
        address: address.startsWith("/") ? address : `/robot/sequence${index + 1}`,
        argMatch: String(next.argMatch || ""),
        action,
        sequenceId,
        onStartAddress: normalizeOptionalOscAddress(next.onStartAddress),
        onStepAddress: normalizeOptionalOscAddress(next.onStepAddress),
        onCompleteAddress: normalizeOptionalOscAddress(next.onCompleteAddress),
        onErrorAddress: normalizeOptionalOscAddress(next.onErrorAddress),
      };
    }).filter((route) => route.id)
    : [];
  if (!routes.length) {
    routes.push({ ...defaults.routes[0], sequenceId: sequences[0].id });
  }
  const selectedSequenceId = sequenceIds.has(String(source.selectedSequenceId)) ? String(source.selectedSequenceId) : sequences[0].id;
  const routeIds = new Set(routes.map((route) => route.id));
  const selectedRouteId = routeIds.has(String(source.selectedRouteId)) ? String(source.selectedRouteId) : routes[0]?.id ?? null;
  return {
    enabled: Boolean(source.enabled),
    mode: source.mode === "live" ? "live" : "preview",
    listenPort: Math.max(1, Math.min(65535, Number(source.listenPort || defaults.listenPort) || defaults.listenPort)),
    allowedHost: String(source.allowedHost || ""),
    sendStatus: source.sendStatus !== false,
    statusHost: String(source.statusHost || defaults.statusHost),
    statusPort: Math.max(1, Math.min(65535, Number(source.statusPort || defaults.statusPort) || defaults.statusPort)),
    statusAddress: String(source.statusAddress || defaults.statusAddress).startsWith("/") ? String(source.statusAddress || defaults.statusAddress) : defaults.statusAddress,
    directRunAddress: String(source.directRunAddress || defaults.directRunAddress).startsWith("/") ? String(source.directRunAddress || defaults.directRunAddress) : defaults.directRunAddress,
    directLoopAddress: String(source.directLoopAddress || defaults.directLoopAddress).startsWith("/") ? String(source.directLoopAddress || defaults.directLoopAddress) : defaults.directLoopAddress,
    directStopAddress: String(source.directStopAddress || defaults.directStopAddress).startsWith("/") ? String(source.directStopAddress || defaults.directStopAddress) : defaults.directStopAddress,
    selectedSequenceId,
    nextSequenceId: Math.max(Number(source.nextSequenceId) || 1, sequences.length + 1),
    sequences,
    selectedRouteId,
    nextRouteId: Math.max(Number(source.nextRouteId) || 1, routes.length + 1),
    routes,
  };
}

function loadOscCSetup() {
  try {
    const raw = window.localStorage.getItem(OSC_C_STORAGE_KEY);
    return normalizeOscCSetup(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultOscCSetup();
  }
}

function saveOscCSetup() {
  if (!state.oscCSetup) {
    return;
  }
  writeMappingCache(OSC_C_STORAGE_KEY, state.oscCSetup);
  scheduleMappingFileSave("osc_c", state.oscCSetup);
}

function getOscCSelectedSequence() {
  if (!state.oscCSetup) {
    state.oscCSetup = loadOscCSetup();
  }
  let sequence = state.oscCSetup.sequences.find((candidate) => candidate.id === state.oscCSetup.selectedSequenceId);
  if (!sequence) {
    sequence = state.oscCSetup.sequences[0] || null;
    state.oscCSetup.selectedSequenceId = sequence?.id ?? null;
  }
  return sequence;
}

function getOscCSelectedRoute() {
  if (!state.oscCSetup) {
    state.oscCSetup = loadOscCSetup();
  }
  let route = state.oscCSetup.routes.find((candidate) => candidate.id === state.oscCSetup.selectedRouteId);
  if (!route) {
    route = state.oscCSetup.routes[0] || null;
    state.oscCSetup.selectedRouteId = route?.id ?? null;
  }
  return route;
}

async function applyOscCSetup(showLog = true) {
  state.oscCSetup = normalizeOscCSetup(state.oscCSetup);
  writeMappingCache(OSC_C_STORAGE_KEY, state.oscCSetup);
  const payload = await api("/api/osc-c/config", {
    method: "POST",
    body: { setup: state.oscCSetup },
  });
  state.oscCSetup = normalizeOscCSetup(payload.osc_c.setup);
  if (state.snapshot) {
    state.snapshot.osc_c = payload.osc_c;
  }
  renderOscCSetup(state.snapshot);
  if (showLog) {
    addLog(`OSC_C ${state.oscCSetup.enabled ? "listener applied" : "setup saved"}.`, "success");
  }
  return payload.osc_c;
}

function defaultTicTacToeSetup() {
  return {
    displayMode: "current",
    targets: Object.fromEntries(TTT_TARGET_ORDER.map((slot) => [slot, null])),
    routines: {
      celebration: defaultTicTacToeRoutineState(),
      loss: defaultTicTacToeRoutineState(),
    },
  };
}

function normalizeTicTacToeSetup(raw) {
  const defaults = defaultTicTacToeSetup();
  const merged = raw && typeof raw === "object" ? raw : {};
  const displayMode = merged.displayMode === "secondary" ? "secondary" : "current";
  const targets = { ...defaults.targets };
  const routines = {
    celebration: defaultTicTacToeRoutineState(),
    loss: defaultTicTacToeRoutineState(),
  };
  Object.entries(merged.targets || {}).forEach(([slot, target]) => {
    if (!TTT_TARGET_ORDER.includes(slot) || !target) {
      return;
    }
    const joints = Array.isArray(target.joints) && target.joints.length === 6
      ? target.joints.map((value) => Number(value))
      : null;
    const pose = Array.isArray(target.pose) && target.pose.length >= 3
      ? target.pose.map((value) => Number(value))
      : null;
    if (!joints || joints.some((value) => !Number.isFinite(value))) {
      return;
    }
    targets[slot] = {
      slot,
      joints,
      pose: pose && pose.every((value) => Number.isFinite(value)) ? pose : null,
      capturedAt: typeof target.capturedAt === "string" ? target.capturedAt : null,
    };
  });
  Object.entries(merged.routines || {}).forEach(([key, routine]) => {
    if (!TTT_ROUTINE_KEYS.includes(key) || !routine || typeof routine !== "object") {
      return;
    }
    const steps = Array.isArray(routine.steps)
      ? routine.steps
        .map((step, index) => {
          const joints = Array.isArray(step?.joints) && step.joints.length === 6
            ? step.joints.map((value) => Number(value))
            : null;
          const pose = Array.isArray(step?.pose) && step.pose.length >= 3
            ? step.pose.map((value) => Number(value))
            : null;
          if (!joints || joints.some((value) => !Number.isFinite(value))) {
            return null;
          }
          const stepId = Number.isInteger(step.stepId) ? step.stepId : index + 1;
          return {
            stepId,
            name: String(step.name || `${key === "celebration" ? "Celebrate" : "Recover"} ${index + 1}`),
            joints,
            pose: pose && pose.every((value) => Number.isFinite(value)) ? pose : null,
            dwellMs: Math.max(0, Number(step.dwellMs || 0) || 0),
            capturedAt: typeof step.capturedAt === "string" ? step.capturedAt : null,
          };
        })
        .filter(Boolean)
      : [];
    routines[key] = {
      steps,
      selectedStepId: steps.some((step) => step.stepId === routine.selectedStepId)
        ? routine.selectedStepId
        : (steps[0]?.stepId ?? null),
      nextStepId: Math.max(Number(routine.nextStepId) || 1, steps.reduce((maxId, step) => Math.max(maxId, step.stepId), 0) + 1),
    };
  });
  return {
    displayMode,
    targets,
    routines,
  };
}

function loadTicTacToeSetup() {
  try {
    const raw = window.localStorage.getItem(TTT_STORAGE_KEY);
    return normalizeTicTacToeSetup(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultTicTacToeSetup();
  }
}

function saveTicTacToeSetup() {
  if (!state.tictactoeSetup) {
    return;
  }
  saveMappedSetup("tictactoe", TTT_STORAGE_KEY, state.tictactoeSetup);
}

function getTicTacToeRoutineLabel(key = state.tictactoeRoutineKey) {
  return key === "loss" ? "Loss" : "Celebration";
}

function getActiveTicTacToeRoutineState() {
  const routineKey = TTT_ROUTINE_KEYS.includes(state.tictactoeRoutineKey) ? state.tictactoeRoutineKey : "celebration";
  if (!state.tictactoeSetup?.routines?.[routineKey]) {
    state.tictactoeRoutineKey = "celebration";
    return state.tictactoeSetup?.routines?.celebration || defaultTicTacToeRoutineState();
  }
  return state.tictactoeSetup.routines[routineKey];
}

function countMappedTicTacToeTargets() {
  return TTT_TARGET_ORDER.filter((slot) => Boolean(state.tictactoeSetup?.targets?.[slot])).length;
}

function countTicTacToeRoutineSteps() {
  const routines = state.tictactoeSetup?.routines || {};
  return TTT_ROUTINE_KEYS.reduce((total, key) => total + (routines[key]?.steps?.length || 0), 0);
}

function isTicTacToeReady() {
  return countMappedTicTacToeTargets() === TTT_TARGET_ORDER.length;
}

function hasLiveTicTacToeCaptureSource(snapshot = state.snapshot) {
  return Boolean(snapshot?.angle?.floats?.length === 6);
}

function formatCompactPose(values) {
  if (!values || values.length < 3) {
    return "Pose unavailable";
  }
  return `X ${formatNumber(values[0], 1)}  Y ${formatNumber(values[1], 1)}  Z ${formatNumber(values[2], 1)}`;
}

function formatCompactJoints(values) {
  if (!values || values.length !== 6) {
    return "Joint data unavailable";
  }
  return values
    .map((value, index) => `J${index + 1} ${formatNumber(value, 1)}`)
    .join("   ");
}

function formatCompactOrientation(values) {
  if (!values || values.length < 6) {
    return "RX -  RY -  RZ -";
  }
  return `RX ${formatNumber(values[3], 1)}  RY ${formatNumber(values[4], 1)}  RZ ${formatNumber(values[5], 1)}`;
}

function getSequenceLockStepMm() {
  return Math.max(1, Number($("sequence-lock-step-input")?.value || 10));
}


function isToolAngleLockActive() {
  return Boolean(
    state.sequenceOrientationLock?.enabled
    && Array.isArray(state.sequenceOrientationLock.pose)
    && state.sequenceOrientationLock.pose.length >= 6,
  );
}

function getJogAxisConfig() {
  if (!isToolAngleLockActive()) {
    return jointNames.map((name, index) => ({
      label: name,
      mode: "joint",
      valueIndex: index,
      valueSource: "joint",
      editable: true,
      joggable: true,
    }));
  }

  return [
    { label: "X", mode: "cartesian", valueIndex: 0, valueSource: "pose", editable: true, joggable: true },
    { label: "Y", mode: "cartesian", valueIndex: 1, valueSource: "pose", editable: true, joggable: true },
    { label: "Z", mode: "cartesian", valueIndex: 2, valueSource: "pose", editable: true, joggable: true },
    { label: "RX", mode: "lock", valueIndex: 3, valueSource: "lock", editable: false, joggable: false },
    { label: "RY", mode: "lock", valueIndex: 4, valueSource: "lock", editable: false, joggable: false },
    { label: "RZ", mode: "lock", valueIndex: 5, valueSource: "lock", editable: false, joggable: false },
  ];
}

function captureTicTacToeLiveTarget(snapshot = state.snapshot) {
  const joints = snapshot?.angle?.floats;
  if (!joints || joints.length !== 6) {
    throw new Error("Live joint values are unavailable");
  }
  const pose = snapshot?.pose?.floats || null;
  return {
    joints: joints.map((value) => Number(value)),
    pose: Array.isArray(pose) ? pose.map((value) => Number(value)) : null,
    capturedAt: new Date().toISOString(),
  };
}

function normalizeStandaloneTarget(raw, slot = "HOME") {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const joints = Array.isArray(raw.joints) && raw.joints.length === 6
    ? raw.joints.map((value) => Number(value))
    : null;
  const pose = Array.isArray(raw.pose) && raw.pose.length >= 3
    ? raw.pose.map((value) => Number(value))
    : null;
  if (!joints || joints.some((value) => !Number.isFinite(value))) {
    return null;
  }
  return {
    slot,
    joints,
    pose: pose && pose.every((value) => Number.isFinite(value)) ? pose : null,
    capturedAt: typeof raw.capturedAt === "string" ? raw.capturedAt : null,
    calculated: raw.calculated === true,
    calibratedAt: typeof raw.calibratedAt === "string" ? raw.calibratedAt : null,
    autoRecordedAt: typeof raw.autoRecordedAt === "string" ? raw.autoRecordedAt : null,
  };
}

function loadMainHomeTarget() {
  try {
    const raw = window.localStorage.getItem(MAIN_HOME_STORAGE_KEY);
    return normalizeStandaloneTarget(raw ? JSON.parse(raw) : null);
  } catch {
    return null;
  }
}

function saveMainHomeTarget() {
  if (!state.mainHomeTarget) {
    saveMappedSetup("main_home", MAIN_HOME_STORAGE_KEY, null);
    return;
  }
  saveMappedSetup("main_home", MAIN_HOME_STORAGE_KEY, state.mainHomeTarget);
}

function defaultSequenceOrientationLock() {
  return {
    enabled: false,
    pose: null,
  };
}

function normalizeSequenceOrientationLock(raw) {
  const next = defaultSequenceOrientationLock();
  if (!raw || typeof raw !== "object") {
    return next;
  }
  next.enabled = raw.enabled === true;
  if (Array.isArray(raw.pose) && raw.pose.length >= 6) {
    const pose = raw.pose.slice(0, 6).map((value) => Number(value));
    if (pose.every((value) => Number.isFinite(value))) {
      next.pose = pose;
    }
  }
  if (!next.pose) {
    next.enabled = false;
  }
  return next;
}

function loadSequenceOrientationLock() {
  try {
    const raw = window.localStorage.getItem(SEQUENCE_ORIENTATION_LOCK_STORAGE_KEY);
    return normalizeSequenceOrientationLock(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultSequenceOrientationLock();
  }
}

function saveSequenceOrientationLock() {
  if (!state.sequenceOrientationLock) {
    saveMappedSetup("sequence_orientation_lock", SEQUENCE_ORIENTATION_LOCK_STORAGE_KEY, null);
    return;
  }
  saveMappedSetup("sequence_orientation_lock", SEQUENCE_ORIENTATION_LOCK_STORAGE_KEY, state.sequenceOrientationLock);
}

function sequenceOrientationPayload() {
  const lock = state.sequenceOrientationLock;
  return {
    lock_orientation: Boolean(lock?.enabled && Array.isArray(lock.pose) && lock.pose.length >= 6),
    orientation_pose: Array.isArray(lock?.pose) ? lock.pose.slice(0, 6) : null,
  };
}

function poseBodyFromArray(values, extra = {}) {
  if (!Array.isArray(values) || values.length < 6) {
    throw new Error("Pose data is unavailable");
  }
  return {
    x: Number(values[0]),
    y: Number(values[1]),
    z: Number(values[2]),
    rx: Number(values[3]),
    ry: Number(values[4]),
    rz: Number(values[5]),
    ...extra,
  };
}

function renderMainHomeTarget() {
  const target = state.mainHomeTarget;
  const dot = $("home-position-dot");
  dot.classList.remove("live", "warn", "error");
  if (target) {
    dot.classList.add("live");
  }
  $("home-position-status").textContent = target ? "Saved" : "Not set";
  $("home-position-pose").textContent = target
    ? formatCompactPose(target.pose)
    : "Capture a home position from the live robot state.";
  $("home-position-joints").textContent = target
    ? formatCompactJoints(target.joints)
    : "No saved home position.";
}

function renderSequenceOrientationLock() {
  const lock = state.sequenceOrientationLock || defaultSequenceOrientationLock();
  const enabled = Boolean(lock.enabled && Array.isArray(lock.pose) && lock.pose.length >= 6);
  const livePose = state.snapshot?.pose?.floats || null;
  $("sequence-lock-enabled-input").checked = enabled;
  $("sequence-lock-status").textContent = enabled ? "On" : "Off";
  $("sequence-lock-pose").textContent = lock.pose
    ? formatCompactOrientation(lock.pose)
    : "Capture current tool angle.";
  $("sequence-lock-live").textContent = `Live ${formatCompactOrientation(livePose)}`;
  updateJointRows(state.snapshot?.angle?.floats || null, state.snapshot?.pose?.floats || null);
}

function buildTicTacToeTargetCard(slot, target, snapshot, variant) {
  const card = document.createElement("div");
  const isCellSlot = variant === "cell";
  const isAnchorSlot = variant === "anchor";
  card.className = `ttt-target-card ${isCellSlot ? "cell-slot" : "anchor-slot"}${target ? " mapped" : ""}`;
  card.innerHTML = `
    <div class="ttt-target-head">
      <div class="ttt-target-title">${slot}</div>
      <div class="ttt-target-head-actions">
        <div class="ttt-target-status">${target ? (target.calculated ? "Calculated" : "Mapped") : "Open"}</div>
        <button class="ttt-clear-icon" type="button" data-action="clear-icon" aria-label="Clear ${slot}" title="Clear ${slot}">×</button>
      </div>
    </div>
    ${target ? `
    <div class="ttt-target-meta">
      <div>${formatCompactPose(target.pose)}</div>
      <div>${formatCompactJoints(target.joints)}</div>
    </div>
    ` : `
    <div class="ttt-target-meta">
      <div>${isCellSlot ? "Capture this board square." : "Capture this anchor position."}</div>
    </div>
    `}
    <div class="ttt-target-actions">
      <button class="btn btn-full" type="button" data-action="capture">${target ? "Recapture" : "Capture"}</button>
      <button class="btn btn-full" type="button" data-action="move">Move</button>
    </div>
  `;
  const captureButton = card.querySelector('[data-action="capture"]');
  const clearButton = card.querySelector('[data-action="clear-icon"]');
  const moveButton = card.querySelector('[data-action="move"]');
  captureButton.disabled = !hasLiveTicTacToeCaptureSource(snapshot);
  clearButton.disabled = !target;
  clearButton.classList.toggle("visible", Boolean(target));
  if (moveButton) {
    moveButton.disabled = !target || !state.snapshot?.motion_ready || !state.snapshot?.motion_channel_available;
  }

  captureButton.addEventListener("click", () => {
    try {
      state.tictactoeSetup.targets[slot] = {
        slot,
        ...captureTicTacToeLiveTarget(snapshot),
      };
      saveTicTacToeSetup();
      renderTicTacToeSetup(snapshot);
      addLog(`Captured Tic-Tac-Toe target ${slot}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  clearButton.addEventListener("click", () => {
    state.tictactoeSetup.targets[slot] = null;
    saveTicTacToeSetup();
    renderTicTacToeSetup(snapshot);
    addLog(`Cleared Tic-Tac-Toe target ${slot}.`, "info");
  });
  if (moveButton) {
    moveButton.addEventListener("click", async () => {
      try {
        if (!target) {
          throw new Error(`Map ${slot} first`);
        }
        await ensureSpeedApplied(true, false);
        await api("/api/joint-movej", {
          method: "POST",
          body: {
            joints: target.joints,
            sync: true,
          },
        });
        addLog(`Moved robot to ${slot}.`, "success");
        await refreshState(`ttt-move-${slot.toLowerCase()}`);
      } catch (error) {
        addLog(error.message, "error");
      }
    });
  }
  return card;
}

async function moveTicTacToeRoutineStep(step) {
  await ensureSpeedApplied(true, false);
  await api("/api/joint-movej", {
    method: "POST",
    body: {
      joints: step.joints,
      sync: true,
    },
  });
}

async function playActiveTicTacToeRoutine() {
  const routine = getActiveTicTacToeRoutineState();
  if (!routine.steps.length) {
    throw new Error(`No steps recorded in ${getTicTacToeRoutineLabel()} routine`);
  }
  for (const step of routine.steps) {
    await moveTicTacToeRoutineStep(step);
    if (step.dwellMs > 0) {
      await delay(step.dwellMs);
    }
  }
}

async function moveCoffeeRoutineStep(step) {
  await ensureSpeedApplied(true, false);
  await api("/api/joint-movej", {
    method: "POST",
    body: {
      joints: step.joints,
      sync: true,
    },
  });
}

async function playActiveCoffeeRoutine() {
  throw new Error("Use a specific coffee sequence card");
}

async function playCoffeeRoutineByKey(routineKey) {
  const routine = getCoffeeRoutineState(routineKey);
  if (!routine.steps.length) {
    throw new Error(`No steps recorded in ${getCoffeeRoutineLabel(routineKey)} sequence`);
  }
  for (const step of routine.steps) {
    await moveCoffeeRoutineStep(step);
    if (step.dwellMs > 0) {
      await delay(step.dwellMs);
    }
  }
}

function buildCoffeeRoutineCard(routineKey, snapshot) {
  const routine = getCoffeeRoutineState(routineKey);
  const selectedStep = routine.steps.find((step) => step.stepId === routine.selectedStepId) || null;
  const inputId = `coffee-routine-step-name-${routineKey}`;
  const card = document.createElement("div");
  card.className = "game-plan-card ttt-routine-card coffee-routine-card";
  card.dataset.coffeeRoutineKey = routineKey;
  card.innerHTML = `
    <p class="game-kicker">${COFFEE_CORE_ROUTINE_KEYS.includes(routineKey) ? "Cup / Delivery Sequence" : "Button Sequence"}</p>
    <div class="coffee-routine-headline">
      <strong>${getCoffeeRoutineLabel(routineKey)}</strong>
      <span class="coffee-routine-count">${routine.steps.length} step(s)</span>
    </div>
    <div class="ttt-routine-fields">
      <label>
        <span>Step Name</span>
        <input id="${inputId}" type="text" placeholder="${getCoffeeRoutineLabel(routineKey)} 1">
      </label>
    </div>
    <div class="sequence-controls">
      <button class="btn btn-primary btn-full" type="button" data-action="add">Add Current Position</button>
      <div class="btn-row">
        <button class="btn btn-full" type="button" data-action="add-standby">Add Standby</button>
        <button class="btn btn-full" type="button" data-action="move">Move To Selected</button>
      </div>
      <div class="btn-row">
        <button class="btn btn-full" type="button" data-action="replace">Replace Selected</button>
        <button class="btn btn-full" type="button" data-action="play">Play Sequence</button>
      </div>
      <div class="btn-row">
        <button class="btn btn-full" type="button" data-action="clear">Clear Sequence</button>
      </div>
    </div>
    <div class="ttt-routine-list" data-role="list" data-coffee-routine-list="${routineKey}"></div>
  `;
  const stepName = card.querySelector(`#${inputId}`);
  const list = card.querySelector('[data-role="list"]');
  if (selectedStep) {
    stepName.value = selectedStep.name;
  }

  if (!routine.steps.length) {
    list.innerHTML = `<div class="ttt-routine-empty">Use drag or jog, then record steps for the ${getCoffeeRoutineLabel(routineKey).toLowerCase()} sequence.</div>`;
  } else {
    routine.steps.forEach((step, index) => {
    const row = document.createElement("div");
    row.className = `ttt-routine-row${step.stepId === routine.selectedStepId ? " selected" : ""}`;
    row.innerHTML = `
      <div class="ttt-routine-head">
        <div class="ttt-routine-title">${index + 1}. ${step.name}</div>
        <div class="ttt-target-head-actions">
        <div class="ttt-target-status">${step.pose ? "Recorded" : "Joint Only"}</div>
          <button class="ttt-clear-icon visible" type="button" data-action="delete-icon" aria-label="Delete ${step.name}" title="Delete ${step.name}">×</button>
        </div>
      </div>
      <div class="ttt-routine-detail">${step.joints.map((value, jointIndex) => `J${jointIndex + 1} ${formatNumber(value, 1)}`).join("   ")}</div>
      <div class="ttt-routine-actions">
        <button class="btn" type="button" data-action="select">Select</button>
        <button class="btn" type="button" data-action="up">Up</button>
        <button class="btn" type="button" data-action="down">Down</button>
      </div>
    `;

    row.querySelector('[data-action="select"]').addEventListener("click", () => {
      routine.selectedStepId = step.stepId;
      saveCoffeeSetup();
      renderCoffeeSetup();
    });
    row.querySelector('[data-action="up"]').addEventListener("click", () => {
      if (index === 0) {
        return;
      }
      [routine.steps[index - 1], routine.steps[index]] = [routine.steps[index], routine.steps[index - 1]];
      saveCoffeeSetup();
      renderCoffeeSetup();
    });
    row.querySelector('[data-action="down"]').addEventListener("click", () => {
      if (index >= routine.steps.length - 1) {
        return;
      }
      [routine.steps[index + 1], routine.steps[index]] = [routine.steps[index], routine.steps[index + 1]];
      saveCoffeeSetup();
      renderCoffeeSetup();
    });
    row.querySelector('[data-action="delete-icon"]').addEventListener("click", () => {
      routine.steps = routine.steps.filter((candidate) => candidate.stepId !== step.stepId);
      if (routine.selectedStepId === step.stepId) {
        routine.selectedStepId = routine.steps[0]?.stepId ?? null;
      }
      saveCoffeeSetup();
      renderCoffeeSetup();
      addLog(`Deleted ${getCoffeeRoutineLabel(routineKey)} step ${step.name}.`, "info");
    });

    list.appendChild(row);
    });
  }

  card.querySelector('[data-action="add"]').addEventListener("click", () => {
    try {
      const capture = captureTicTacToeLiveTarget(snapshot);
      const nextRoutine = getCoffeeRoutineState(routineKey);
      const step = {
        stepId: nextRoutine.nextStepId,
        name: stepName.value.trim() || `${getCoffeeRoutineLabel(routineKey)} ${nextRoutine.steps.length + 1}`,
        joints: capture.joints,
        pose: capture.pose,
        dwellMs: 0,
        capturedAt: capture.capturedAt,
      };
      nextRoutine.steps.push(step);
      nextRoutine.nextStepId += 1;
      nextRoutine.selectedStepId = step.stepId;
      saveCoffeeSetup();
      renderCoffeeSetup();
      addLog(`Recorded ${getCoffeeRoutineLabel(routineKey)} step ${step.name}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  card.querySelector('[data-action="add-standby"]').addEventListener("click", () => {
    try {
      const standbyTarget = state.coffeeSetup?.targets?.STANDBY;
      if (!standbyTarget?.joints) {
        throw new Error("Map Standby first");
      }
      const nextRoutine = getCoffeeRoutineState(routineKey);
      const step = {
        stepId: nextRoutine.nextStepId,
        name: "Standby",
        joints: standbyTarget.joints.map((value) => Number(value)),
        pose: Array.isArray(standbyTarget.pose) ? standbyTarget.pose.map((value) => Number(value)) : null,
        dwellMs: 0,
        capturedAt: new Date().toISOString(),
      };
      nextRoutine.steps.push(step);
      nextRoutine.nextStepId += 1;
      nextRoutine.selectedStepId = step.stepId;
      saveCoffeeSetup();
      renderCoffeeSetup();
      addLog(`Added Standby to ${getCoffeeRoutineLabel(routineKey)} sequence.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  card.querySelector('[data-action="replace"]').addEventListener("click", () => {
    try {
      const nextRoutine = getCoffeeRoutineState(routineKey);
      const selected = nextRoutine.steps.find((step) => step.stepId === nextRoutine.selectedStepId);
      if (!selected) {
        throw new Error("Select a coffee sequence step first");
      }
      const capture = captureTicTacToeLiveTarget(snapshot);
      selected.joints = capture.joints;
      selected.pose = capture.pose;
      selected.capturedAt = capture.capturedAt;
      const nextName = stepName.value.trim();
      if (nextName) {
        selected.name = nextName;
      }
      saveCoffeeSetup();
      renderCoffeeSetup();
      addLog(`Replaced ${getCoffeeRoutineLabel(routineKey)} step ${selected.name}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  card.querySelector('[data-action="move"]').addEventListener("click", async () => {
    try {
      const nextRoutine = getCoffeeRoutineState(routineKey);
      const selected = nextRoutine.steps.find((step) => step.stepId === nextRoutine.selectedStepId);
      if (!selected) {
        throw new Error("Select a coffee sequence step first");
      }
      await moveCoffeeRoutineStep(selected);
      addLog(`Moved robot to ${getCoffeeRoutineLabel(routineKey)} step ${selected.name}.`, "success");
      await refreshState(`coffee-routine-move-${routineKey}`);
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  card.querySelector('[data-action="play"]').addEventListener("click", async () => {
    try {
      await playCoffeeRoutineByKey(routineKey);
      addLog(`${getCoffeeRoutineLabel(routineKey)} sequence played.`, "success");
      await refreshState(`coffee-routine-play-${routineKey}`);
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  card.querySelector('[data-action="clear"]').addEventListener("click", () => {
    const nextRoutine = getCoffeeRoutineState(routineKey);
    nextRoutine.steps = [];
    nextRoutine.selectedStepId = null;
    nextRoutine.nextStepId = 1;
    saveCoffeeSetup();
    renderCoffeeSetup();
    addLog(`Cleared ${getCoffeeRoutineLabel(routineKey)} sequence.`, "info");
  });

  return card;
}

function captureCoffeeScrollState() {
  const shell = $("center-coffee-view")?.querySelector(".game-shell-body");
  const listScroll = {};
  document.querySelectorAll("[data-coffee-routine-list]").forEach((list) => {
    const routineKey = list.dataset.coffeeRoutineList;
    if (routineKey) {
      listScroll[routineKey] = list.scrollTop;
    }
  });
  return {
    shellTop: shell ? shell.scrollTop : 0,
    lists: listScroll,
  };
}

function restoreCoffeeScrollState(scrollState) {
  if (!scrollState) {
    return;
  }

  window.requestAnimationFrame(() => {
    const shell = $("center-coffee-view")?.querySelector(".game-shell-body");
    if (shell) {
      shell.scrollTop = scrollState.shellTop;
    }
    Object.entries(scrollState.lists || {}).forEach(([routineKey, scrollTop]) => {
      const list = document.querySelector(`[data-coffee-routine-list="${routineKey}"]`);
      if (list) {
        list.scrollTop = scrollTop;
      }
    });
  });
}

function renderTicTacToeRoutineList() {
  const setup = state.tictactoeSetup;
  const routine = getActiveTicTacToeRoutineState();
  const list = $("ttt-routine-list");
  const stepName = $("ttt-routine-step-name");
  const status = $("ttt-routine-status");
  const selectedStep = routine.steps.find((step) => step.stepId === routine.selectedStepId) || null;

  $("ttt-routine-select").value = state.tictactoeRoutineKey;
  status.textContent = `${getTicTacToeRoutineLabel()} routine · ${routine.steps.length} step(s)`;
  if (selectedStep && document.activeElement !== stepName) {
    stepName.value = selectedStep.name;
  }

  list.innerHTML = "";
  if (!routine.steps.length) {
    list.innerHTML = `<div class="ttt-routine-empty">Use drag or jog, then record steps for the ${getTicTacToeRoutineLabel().toLowerCase()} routine.</div>`;
    return;
  }

  routine.steps.forEach((step, index) => {
    const row = document.createElement("div");
    row.className = `ttt-routine-row${step.stepId === routine.selectedStepId ? " selected" : ""}`;
    row.innerHTML = `
      <div class="ttt-routine-head">
        <div class="ttt-routine-title">${index + 1}. ${step.name}</div>
        <div class="ttt-target-head-actions">
          <div class="ttt-target-status">${step.pose ? "Recorded" : "Joint Only"}</div>
          <button class="ttt-clear-icon visible" type="button" data-action="delete-icon" aria-label="Delete ${step.name}" title="Delete ${step.name}">×</button>
        </div>
      </div>
      <div class="ttt-routine-detail">${step.joints.map((value, jointIndex) => `J${jointIndex + 1} ${formatNumber(value, 1)}`).join("   ")}</div>
      <div class="ttt-routine-actions">
        <button class="btn" type="button" data-action="select">Select</button>
        <button class="btn" type="button" data-action="up">Up</button>
        <button class="btn" type="button" data-action="down">Down</button>
      </div>
    `;

    row.querySelector('[data-action="select"]').addEventListener("click", () => {
      routine.selectedStepId = step.stepId;
      saveTicTacToeSetup();
      renderTicTacToeRoutineList();
    });
    row.querySelector('[data-action="up"]').addEventListener("click", () => {
      if (index === 0) {
        return;
      }
      [routine.steps[index - 1], routine.steps[index]] = [routine.steps[index], routine.steps[index - 1]];
      saveTicTacToeSetup();
      renderTicTacToeRoutineList();
    });
    row.querySelector('[data-action="down"]').addEventListener("click", () => {
      if (index >= routine.steps.length - 1) {
        return;
      }
      [routine.steps[index + 1], routine.steps[index]] = [routine.steps[index], routine.steps[index + 1]];
      saveTicTacToeSetup();
      renderTicTacToeRoutineList();
    });
    row.querySelector('[data-action="delete-icon"]').addEventListener("click", () => {
      routine.steps = routine.steps.filter((candidate) => candidate.stepId !== step.stepId);
      if (routine.selectedStepId === step.stepId) {
        routine.selectedStepId = routine.steps[0]?.stepId ?? null;
      }
      saveTicTacToeSetup();
      renderTicTacToeRoutineList();
      addLog(`Deleted ${getTicTacToeRoutineLabel()} routine step ${step.name}.`, "info");
    });

    list.appendChild(row);
  });
}

function renderTicTacToeSetup(snapshot = state.snapshot) {
  if (!state.tictactoeSetup) {
    state.tictactoeSetup = loadTicTacToeSetup();
  }

  const display = $("ttt-display-select");
  const anchorGrid = $("ttt-anchor-grid");
  const boardGrid = $("ttt-board-map-grid");
  const progress = $("ttt-mapping-progress");
  const readiness = $("ttt-readiness-label");
  const liveNote = $("ttt-live-position-note");
  const launchButton = $("ttt-launch-button");
  const resetButton = $("ttt-reset-mapping-button");
  const saveButton = $("ttt-save-setup-button");
  const setup = state.tictactoeSetup;

  display.value = setup.displayMode;

  const mappedCount = countMappedTicTacToeTargets();
  const routineStepCount = countTicTacToeRoutineSteps();
  progress.textContent = `${mappedCount} / ${TTT_TARGET_ORDER.length} mapped`;
  readiness.textContent = isTicTacToeReady() ? "Ready to launch" : "Waiting for mapping";
  liveNote.textContent = hasLiveTicTacToeCaptureSource(snapshot)
    ? "Ready to capture current robot position."
    : "Connect robot for capture.";

  launchButton.disabled = !isTicTacToeReady();
  resetButton.disabled = mappedCount === 0 && routineStepCount === 0;
  saveButton.disabled = mappedCount === 0 && routineStepCount === 0;

  anchorGrid.innerHTML = "";
  boardGrid.innerHTML = "";
  TTT_ANCHOR_TARGETS.forEach((slot) => {
    anchorGrid.appendChild(buildTicTacToeTargetCard(slot, setup.targets[slot], snapshot, "anchor"));
  });
  TTT_BOARD_TARGETS.forEach((slot) => {
    boardGrid.appendChild(buildTicTacToeTargetCard(slot, setup.targets[slot], snapshot, "cell"));
  });
  renderTicTacToeRoutineList();
}

function buildTicTacToeLaunchConfig() {
  const setup = state.tictactoeSetup || loadTicTacToeSetup();
  return {
    game: "tictactoe",
    displayMode: setup.displayMode,
    targets: setup.targets,
    routines: setup.routines,
    launchedAt: new Date().toISOString(),
  };
}

async function launchTicTacToeWindow(mode = "play") {
  if (mode === "play" && !isTicTacToeReady()) {
    throw new Error("Map Home, Standby, and all board cells before launching Tic-Tac-Toe");
  }
  saveTicTacToeSetup();
  await flushMappedSetup("tictactoe", TTT_STORAGE_KEY, state.tictactoeSetup);

  const url = new URL("/game.html", window.location.href);
  url.searchParams.set("game", "tictactoe");
  url.searchParams.set("mode", mode);
  const features = [
    "popup=yes",
    "width=1280",
    "height=900",
    "resizable=yes",
    "scrollbars=no",
  ];

  if (state.tictactoeSetup.displayMode === "secondary" && typeof window.getScreenDetails === "function") {
    try {
      const details = await window.getScreenDetails();
      const secondary = details.screens.find((screen) => !screen.isPrimary);
      if (secondary) {
        features.push(`left=${Math.round(secondary.availLeft)}`);
        features.push(`top=${Math.round(secondary.availTop)}`);
        features.push(`width=${Math.round(secondary.availWidth)}`);
        features.push(`height=${Math.round(secondary.availHeight)}`);
      } else {
        addLog("No secondary screen detected. Opening Tic-Tac-Toe on the current screen.", "info");
      }
    } catch {
      addLog("Secondary screen access was not granted. Opening Tic-Tac-Toe on the current screen.", "info");
    }
  }

  const popup = window.open(url.toString(), mode === "mapping" ? "dobot-tictactoe-map" : "dobot-tictactoe-screen", features.join(","));
  if (!popup) {
    throw new Error("Game window was blocked by the browser");
  }
  popup.focus();
}

function defaultThreeTttSetup() {
  const boards = {};
  THREE_TTT_BOARD_COUNTS.forEach((count) => {
    const boardId = `board${count}`;
    boards[boardId] = {
      id: boardId,
      label: `Player ${count}`,
      oscName: String(count),
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

function normalizeThreeTttSetup(raw) {
  const defaults = defaultThreeTttSetup();
  const merged = raw && typeof raw === "object" ? raw : {};
  const boardCount = THREE_TTT_BOARD_COUNTS.includes(Number(merged.boardCount))
    ? Number(merged.boardCount)
    : defaults.boardCount;
  const priorityPreset = Object.prototype.hasOwnProperty.call(THREE_TTT_PRIORITY_PRESETS, merged.priorityPreset)
    ? merged.priorityPreset
    : defaults.priorityPreset;
  const displayMode = merged.displayMode === "secondary" ? "secondary" : "current";
  const robotMode = ["api", "servo"].includes(merged.robotMode) ? merged.robotMode : "preview";
  const osc = merged.osc && typeof merged.osc === "object" ? merged.osc : {};
  const activeIds = Array.from({ length: boardCount }, (_, index) => `board${index + 1}`);
  const selectedBoardId = activeIds.includes(merged.selectedBoardId) ? merged.selectedBoardId : activeIds[0];
  const launchBoardId = activeIds.includes(merged.launchBoardId) ? merged.launchBoardId : selectedBoardId;
  const boards = {};
  activeIds.forEach((boardId) => {
    const index = Number(boardId.replace("board", "")) || 1;
    const rawBoard = merged.boards?.[boardId] && typeof merged.boards[boardId] === "object"
      ? merged.boards[boardId]
      : {};
    const targets = { ...defaults.boards[boardId].targets };
    Object.entries(rawBoard.targets || {}).forEach(([slot, target]) => {
      if (!TTT_TARGET_ORDER.includes(slot) || !target) {
        return;
      }
      const normalized = normalizeStandaloneTarget(target, slot);
      if (normalized) {
        targets[slot] = normalized;
      }
    });
    boards[boardId] = {
      id: boardId,
      label: String(rawBoard.label || `Player ${index}`),
      oscName: String(rawBoard.oscName || index).replace(/^board/i, "") || String(index),
      targets,
    };
  });
  return synchronizeThreeTttAnchorTargets({
    displayMode,
    boardCount,
    selectedBoardId,
    launchBoardId,
    priorityPreset,
    robotMode,
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

function saveThreeTttSetup() {
  if (!state.threeTttSetup) {
    return;
  }
  saveMappedSetup("3ttt", THREE_TTT_STORAGE_KEY, state.threeTttSetup);
}

function getThreeTttActiveBoards(setup = state.threeTttSetup || loadThreeTttSetup()) {
  return Array.from({ length: setup.boardCount }, (_, index) => `board${index + 1}`);
}

function getThreeTttSelectedBoard(setup = state.threeTttSetup || loadThreeTttSetup()) {
  const activeBoards = getThreeTttActiveBoards(setup);
  const boardId = activeBoards.includes(setup.selectedBoardId) ? setup.selectedBoardId : activeBoards[0];
  return setup.boards?.[boardId] || null;
}

function getThreeTttLaunchBoard(setup = state.threeTttSetup || loadThreeTttSetup()) {
  const activeBoards = getThreeTttActiveBoards(setup);
  const boardId = activeBoards.includes(setup.launchBoardId) ? setup.launchBoardId : activeBoards[0];
  return setup.boards?.[boardId] || null;
}

function getThreeTttPriorityOrder(setup = state.threeTttSetup || loadThreeTttSetup()) {
  const activeBoards = getThreeTttActiveBoards(setup);
  const preset = THREE_TTT_PRIORITY_PRESETS[setup.priorityPreset] || THREE_TTT_PRIORITY_PRESETS.center_first;
  const ordered = preset.filter((boardId) => activeBoards.includes(boardId));
  activeBoards.forEach((boardId) => {
    if (!ordered.includes(boardId)) {
      ordered.push(boardId);
    }
  });
  return ordered;
}

function synchronizeThreeTttAnchorTargets(setup, preferredBoardId = setup?.selectedBoardId) {
  if (!setup?.boards) {
    return setup;
  }
  const activeBoards = getThreeTttActiveBoards(setup);
  TTT_ANCHOR_TARGETS.forEach((slot) => {
    const preferredIds = [preferredBoardId, setup.launchBoardId, ...activeBoards].filter(Boolean);
    const commonTarget = preferredIds
      .map((boardId) => setup.boards[boardId]?.targets?.[slot])
      .find(Boolean);
    if (!commonTarget) {
      return;
    }
    activeBoards.forEach((boardId) => {
      if (!setup.boards[boardId]?.targets) {
        return;
      }
      setup.boards[boardId].targets[slot] = normalizeStandaloneTarget(commonTarget, slot);
    });
  });
  return setup;
}

function setThreeTttAnchorTarget(slot, target) {
  if (!TTT_ANCHOR_TARGETS.includes(slot) || !state.threeTttSetup?.boards) {
    return;
  }
  getThreeTttActiveBoards(state.threeTttSetup).forEach((boardId) => {
    if (!state.threeTttSetup.boards[boardId]?.targets) {
      return;
    }
    state.threeTttSetup.boards[boardId].targets[slot] = target ? normalizeStandaloneTarget(target, slot) : null;
  });
}

function countMappedThreeTttTargets(board = getThreeTttSelectedBoard()) {
  if (!board) {
    return 0;
  }
  return TTT_TARGET_ORDER.filter((slot) => Boolean(board.targets?.[slot])).length;
}

function countMappedThreeTttSetup(setup = state.threeTttSetup || loadThreeTttSetup()) {
  return getThreeTttActiveBoards(setup).reduce(
    (total, boardId) => total + countMappedThreeTttTargets(setup.boards?.[boardId]),
    0,
  );
}

function isThreeTttBoardReady(board = getThreeTttLaunchBoard()) {
  return Boolean(board && TTT_TARGET_ORDER.every((slot) => Boolean(board.targets?.[slot])));
}

function buildThreeTttTargetCard(slot, target, snapshot, variant) {
  const card = buildTicTacToeTargetCard(slot, target, snapshot, variant);
  const captureButton = card.querySelector('[data-action="capture"]');
  const clearButton = card.querySelector('[data-action="clear-icon"]');
  const moveButton = card.querySelector('[data-action="move"]');
  const board = getThreeTttSelectedBoard();
  const boardId = board?.id;

  captureButton.replaceWith(captureButton.cloneNode(true));
  clearButton.replaceWith(clearButton.cloneNode(true));
  moveButton.replaceWith(moveButton.cloneNode(true));

  const freshCapture = card.querySelector('[data-action="capture"]');
  const freshClear = card.querySelector('[data-action="clear-icon"]');
  const freshMove = card.querySelector('[data-action="move"]');

  freshCapture.addEventListener("click", () => {
    try {
      if (!boardId) {
        throw new Error("Select a 3TTT board first");
      }
      const capturedTarget = {
        slot,
        ...captureTicTacToeLiveTarget(snapshot),
      };
      if (TTT_ANCHOR_TARGETS.includes(slot)) {
        setThreeTttAnchorTarget(slot, capturedTarget);
      } else {
        state.threeTttSetup.boards[boardId].targets[slot] = capturedTarget;
      }
      saveThreeTttSetup();
      renderThreeTttSetup(snapshot);
      addLog(
        TTT_ANCHOR_TARGETS.includes(slot)
          ? `Captured common ${slot} for all active 3TTT boards.`
          : `Captured ${slot} for ${state.threeTttSetup.boards[boardId].label}.`,
        "success",
      );
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  freshClear.addEventListener("click", () => {
    if (!boardId) {
      return;
    }
    if (TTT_ANCHOR_TARGETS.includes(slot)) {
      setThreeTttAnchorTarget(slot, null);
    } else {
      state.threeTttSetup.boards[boardId].targets[slot] = null;
    }
    saveThreeTttSetup();
    renderThreeTttSetup(snapshot);
    addLog(
      TTT_ANCHOR_TARGETS.includes(slot)
        ? `Cleared common ${slot} for all active 3TTT boards.`
        : `Cleared ${slot} for ${state.threeTttSetup.boards[boardId].label}.`,
      "info",
    );
  });

  freshMove.addEventListener("click", async () => {
    try {
      if (!target) {
        throw new Error(`No target mapped for ${slot}`);
      }
      await ensureSpeedApplied(true);
      await api("/api/joint-movej", {
        method: "POST",
        body: {
          joints: target.joints,
          speedj: getJointSpeed(),
          accj: getJointAcc(),
          sync: true,
        },
      });
      addLog(
        TTT_ANCHOR_TARGETS.includes(slot)
          ? `Moved robot to common ${slot}.`
          : `Moved robot to ${board?.label || boardId} ${slot}.`,
        "success",
      );
      await refreshState(`3ttt-move-${boardId}-${slot.toLowerCase()}`);
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  return card;
}

function renderThreeTttPreview() {
  const setup = state.threeTttSetup || loadThreeTttSetup();
  const preview = $("three-ttt-board-preview");
  if (!preview) {
    return;
  }
  preview.innerHTML = "";
  const priority = getThreeTttPriorityOrder(setup);
  getThreeTttActiveBoards(setup).forEach((boardId) => {
    const card = document.createElement("div");
    card.className = "three-ttt-board-card";
    const boardNumber = boardId.replace("board", "");
    const board = setup.boards[boardId];
    const mapped = countMappedThreeTttTargets(board);
    card.innerHTML = `
      <div class="three-ttt-board-name">${board?.label || `Board ${boardNumber}`}</div>
      <div class="three-ttt-board-osc">OSC /board/${board?.oscName || boardId.replace("board", "")}</div>
      <div class="three-ttt-board-osc">${mapped} / ${TTT_TARGET_ORDER.length} mapped</div>
      <div class="three-ttt-board-priority">Priority ${priority.indexOf(boardId) + 1}</div>
    `;
    preview.appendChild(card);
  });
}

function renderThreeTttBoardOptions() {
  const setup = state.threeTttSetup || loadThreeTttSetup();
  const activeBoards = getThreeTttActiveBoards(setup);
  ["three-ttt-map-board-select", "three-ttt-launch-board-select"].forEach((id) => {
    const select = $(id);
    if (!select) {
      return;
    }
    const current = id === "three-ttt-map-board-select" ? setup.selectedBoardId : setup.launchBoardId;
    select.innerHTML = "";
    activeBoards.forEach((boardId) => {
      const option = document.createElement("option");
      option.value = boardId;
      option.textContent = setup.boards[boardId]?.label || boardId;
      select.appendChild(option);
    });
    select.value = activeBoards.includes(current) ? current : activeBoards[0];
  });
}

function formatServoMeters(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) {
    return "-";
  }
  return `${Number(value).toFixed(3)} m`;
}

function selectThreeTttLaunchBoard(boardId) {
  if (!state.threeTttSetup) {
    state.threeTttSetup = loadThreeTttSetup();
  }
  const activeBoards = getThreeTttActiveBoards(state.threeTttSetup);
  if (!activeBoards.includes(boardId)) {
    return;
  }
  state.threeTttSetup.launchBoardId = boardId;
  saveThreeTttSetup();
  renderThreeTttSetup();
}

function renderThreeTttServoPanel() {
  if (!$("three-ttt-servo-card")) {
    return;
  }
  const setup = state.threeTttSetup || loadThreeTttSetup();
  const launchBoard = getThreeTttLaunchBoard(setup);
  const statusLabel = $("three-ttt-servo-status-label");
  const templateLabel = $("three-ttt-servo-template-label");
  const limitsLabel = $("three-ttt-servo-limits-label");
  const positionLabel = $("three-ttt-servo-position-label");
  const speedLabel = $("three-ttt-servo-speed-label");
  const list = $("three-ttt-servo-board-list");
  const message = $("three-ttt-servo-message");
  const stopButton = $("three-ttt-servo-stop-button");
  const disableButton = $("three-ttt-servo-disable-button");
  const resetButton = $("three-ttt-servo-reset-button");
  const enableButton = $("three-ttt-servo-enable-button");
  const moveButton = $("three-ttt-servo-move-button");
  const servo = state.threeTttServoStatus;

  list.innerHTML = "";
  templateLabel.textContent = "-";
  limitsLabel.textContent = "-";
  positionLabel.textContent = "-";
  speedLabel.textContent = "-";
  stopButton.disabled = setup.robotMode !== "servo";
  disableButton.disabled = setup.robotMode !== "servo" || !servo || Boolean(state.threeTttServoError);
  resetButton.disabled = setup.robotMode !== "servo" || !servo || Boolean(state.threeTttServoError);
  enableButton.disabled = setup.robotMode !== "servo" || !servo || Boolean(state.threeTttServoError);
  moveButton.disabled = setup.robotMode !== "servo" || !servo || Boolean(state.threeTttServoError);

  if (setup.robotMode !== "servo") {
    statusLabel.textContent = "Inactive";
    message.textContent = "Set Robot Motion to Direct Servo + DOBOT to use servo board movement.";
    return;
  }

  if (state.threeTttServoError) {
    statusLabel.textContent = "Unavailable";
    message.textContent = state.threeTttServoError;
    return;
  }

  if (!servo) {
    statusLabel.textContent = "Not checked";
    message.textContent = "Start / Refresh starts MotorControl from the DOBOT folder and reads board positions.";
    return;
  }

  const motor = servo.status || {};
  const connected = Number(motor.connected_slaves || 0);
  const total = Number(motor.num_slaves || 0);
  const hasServo = total > 0 && connected > 0;
  const ready = Number(motor.state || 0) === 2;
  statusLabel.textContent = motor.has_fault ? "Fault" : hasServo ? `${ready ? "Ready" : "Disabled"} ${connected}/${total}` : "No Servo";
  templateLabel.textContent = servo.template || "-";
  limitsLabel.textContent = servo.limits ? `${formatServoMeters(servo.limits.min)} to ${formatServoMeters(servo.limits.max)}` : "-";
  const positions = Array.isArray(motor.positions) ? motor.positions : [];
  positionLabel.textContent = formatServoMeters(positions[Number(servo.slave || 0)]);
  const templateSpeed = servo.template_speed;
  speedLabel.textContent = templateSpeed
    ? `Run V ${Number(motor.velocity || 0)} / Template V ${Number(templateSpeed.velocity || 0)}`
    : `Run V ${Number(motor.velocity || 0)} / A ${Number(motor.acceleration || 0)}`;

  const boardPositions = servo.board_positions || {};
  for (let boardNumber = 1; boardNumber <= setup.boardCount; boardNumber += 1) {
    const boardId = `board${boardNumber}`;
    const isActive = launchBoard?.id === boardId;
    const row = document.createElement("div");
    row.className = "three-ttt-servo-board-row";
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.setAttribute("aria-pressed", String(isActive));
    row.title = "Select this board for Move Selected Board";
    row.addEventListener("click", () => selectThreeTttLaunchBoard(boardId));
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectThreeTttLaunchBoard(boardId);
      }
    });
    if (isActive) {
      row.classList.add("active");
    }
    const label = document.createElement("span");
    label.textContent = setup.boards[boardId]?.label || `Board ${boardNumber}`;
    const value = document.createElement("strong");
    value.className = "three-ttt-servo-board-value";
    value.textContent = formatServoMeters(boardPositions[String(boardNumber)]);
    const stateLabel = document.createElement("span");
    stateLabel.className = "three-ttt-servo-board-state";
    stateLabel.textContent = isActive ? "Selected" : "Click to select";
    row.append(label, value, stateLabel);
    list.appendChild(row);
  }

  moveButton.disabled = moveButton.disabled || !hasServo || !ready || motor.has_fault;
  enableButton.disabled = enableButton.disabled || !hasServo || ready || motor.has_fault;
  disableButton.disabled = disableButton.disabled || (!ready && !motor.moving);
  resetButton.disabled = resetButton.disabled || !motor.has_fault;
  message.textContent = motor.has_fault
    ? "MotorControl reports a servo fault. Clear the fault before moving."
    : !hasServo
      ? "MotorControl is running, but no servo slave is detected. Check servo power, EtherCAT adapter, and driver permission."
    : ready
      ? `Move Selected Board will move ${launchBoard?.label || "the launch board"} using MotorControl runtime speed. Template speed is shown for reference.`
      : "Servo is disabled. Click Enable Servo before moving.";
}

async function refreshThreeTttServoStatus() {
  const setup = state.threeTttSetup || loadThreeTttSetup();
  setBusy("three-ttt-servo-refresh-button", true, "Checking");
  try {
    const payload = await api("/api/servo/status", {
      method: "POST",
      body: {
        board_count: setup.boardCount,
        slave: 0,
      },
    });
    state.threeTttServoStatus = payload;
    state.threeTttServoError = "";
    renderThreeTttServoPanel();
  } catch (error) {
    state.threeTttServoStatus = null;
    state.threeTttServoError = `${error.message}. Use Start / Refresh again after the DOBOT UI server is restarted as Administrator if the servo driver asks for permission.`;
    renderThreeTttServoPanel();
  } finally {
    setBusy("three-ttt-servo-refresh-button", false);
  }
}

async function moveThreeTttServoSelectedBoard() {
  const setup = state.threeTttSetup || loadThreeTttSetup();
  const launchBoard = getThreeTttLaunchBoard(setup);
  setBusy("three-ttt-servo-move-button", true, "Moving");
  try {
    const payload = await api("/api/servo/board", {
      method: "POST",
      body: {
        board_name: launchBoard.id,
        board_count: setup.boardCount,
        slave: 0,
        timeout: 120,
      },
    });
    addLog(`Servo moved to ${launchBoard.label}: ${formatServoMeters(payload.target)}.`, "success");
    await refreshThreeTttServoStatus();
  } catch (error) {
    addLog(error.message, "error");
    state.threeTttServoError = error.message;
    renderThreeTttServoPanel();
  } finally {
    setBusy("three-ttt-servo-move-button", false);
    renderThreeTttServoPanel();
  }
}

async function enableThreeTttServo() {
  setBusy("three-ttt-servo-enable-button", true, "Enabling");
  try {
    await api("/api/servo/enable", { method: "POST", body: {} });
    await refreshThreeTttServoStatus();
    addLog("Servo enabled.", "success");
  } catch (error) {
    addLog(error.message, "error");
    state.threeTttServoError = error.message;
    renderThreeTttServoPanel();
  } finally {
    setBusy("three-ttt-servo-enable-button", false);
    renderThreeTttServoPanel();
  }
}

async function runThreeTttServoControl(path, buttonId, busyLabel, successMessage) {
  setBusy(buttonId, true, busyLabel);
  try {
    await api(path, { method: "POST", body: {} });
    state.threeTttServoError = "";
    await refreshThreeTttServoStatus();
    addLog(successMessage, "success");
  } catch (error) {
    addLog(error.message, "error");
    state.threeTttServoError = error.message;
    renderThreeTttServoPanel();
  } finally {
    setBusy(buttonId, false);
    renderThreeTttServoPanel();
  }
}

function renderThreeTttSetup(snapshot = state.snapshot) {
  if (!state.threeTttSetup) {
    state.threeTttSetup = loadThreeTttSetup();
  }
  const setup = state.threeTttSetup;
  const selectedBoard = getThreeTttSelectedBoard(setup);
  const launchBoard = getThreeTttLaunchBoard(setup);
  $("three-ttt-display-select").value = setup.displayMode;
  $("three-ttt-board-count-select").value = String(setup.boardCount);
  $("three-ttt-priority-select").value = setup.priorityPreset;
  $("three-ttt-robot-mode-select").value = setup.robotMode;
  renderThreeTttBoardOptions();
  $("three-ttt-board-label-input").value = selectedBoard?.label || "";
  $("three-ttt-board-osc-name-input").value = selectedBoard?.oscName || selectedBoard?.id?.replace("board", "") || "";
  $("three-ttt-osc-host-input").value = setup.osc.host;
  $("three-ttt-osc-send-port-input").value = String(setup.osc.sendPort);
  $("three-ttt-osc-listen-port-input").value = String(setup.osc.listenPort);
  $("three-ttt-osc-goto-address-input").value = setup.osc.gotoAddress;
  $("three-ttt-osc-reached-address-input").value = setup.osc.reachedAddress;
  $("three-ttt-launch-button").disabled = !isThreeTttBoardReady(launchBoard);
  $("three-ttt-save-setup-button").disabled = countMappedThreeTttSetup(setup) === 0;
  $("three-ttt-reset-mapping-button").disabled = countMappedThreeTttSetup(setup) === 0;
  $("three-ttt-readiness-label").textContent = isThreeTttBoardReady(launchBoard)
    ? `${launchBoard.label} ready`
    : `Map ${launchBoard?.label || "selected board"} first`;
  $("three-ttt-priority-label").textContent = getThreeTttPriorityOrder(setup)
    .map((boardId) => setup.boards[boardId]?.label || boardId)
    .join(" -> ");
  $("three-ttt-mapping-progress").textContent = `${selectedBoard?.label || "Board"}: ${countMappedThreeTttTargets(selectedBoard)} / ${TTT_TARGET_ORDER.length} mapped`;
  const anchorGrid = $("three-ttt-anchor-grid");
  const boardGrid = $("three-ttt-board-map-grid");
  anchorGrid.innerHTML = "";
  boardGrid.innerHTML = "";
  TTT_ANCHOR_TARGETS.forEach((slot) => {
    anchorGrid.appendChild(buildThreeTttTargetCard(slot, selectedBoard?.targets?.[slot], snapshot, "anchor"));
  });
  TTT_BOARD_TARGETS.forEach((slot) => {
    boardGrid.appendChild(buildThreeTttTargetCard(slot, selectedBoard?.targets?.[slot], snapshot, "cell"));
  });
  renderThreeTttPreview();
  renderThreeTttServoPanel();
}

function syncThreeTttSetupFromControls({ preserveBoardFields = true } = {}) {
  if (!state.threeTttSetup) {
    state.threeTttSetup = loadThreeTttSetup();
  }
  const previous = state.threeTttSetup;
  const selectedBoardId = $("three-ttt-map-board-select")?.value || previous.selectedBoardId;
  const launchBoardId = $("three-ttt-launch-board-select")?.value || previous.launchBoardId;
  const next = normalizeThreeTttSetup({
    displayMode: $("three-ttt-display-select").value,
    boardCount: Number($("three-ttt-board-count-select").value),
    selectedBoardId,
    launchBoardId,
    priorityPreset: $("three-ttt-priority-select").value,
    robotMode: $("three-ttt-robot-mode-select").value,
    boards: previous.boards,
    osc: {
      host: $("three-ttt-osc-host-input").value.trim(),
      sendPort: Number($("three-ttt-osc-send-port-input").value),
      listenPort: Number($("three-ttt-osc-listen-port-input").value),
      gotoAddress: $("three-ttt-osc-goto-address-input").value.trim(),
      reachedAddress: $("three-ttt-osc-reached-address-input").value.trim(),
    },
  });
  if (preserveBoardFields && next.boards[next.selectedBoardId]) {
    next.boards[next.selectedBoardId].label = $("three-ttt-board-label-input").value.trim() || next.boards[next.selectedBoardId].label;
    next.boards[next.selectedBoardId].oscName = $("three-ttt-board-osc-name-input").value.trim().replace(/^board/i, "") || next.selectedBoardId.replace("board", "");
  }
  state.threeTttSetup = next;
  saveThreeTttSetup();
  renderThreeTttSetup();
}

async function openThreeTttBoardWindow(board, mode = "play") {
  await flushMappedSetup("3ttt", THREE_TTT_STORAGE_KEY, state.threeTttSetup);

  const url = new URL("/3ttt.html", window.location.href);
  url.searchParams.set("game", "3ttt");
  url.searchParams.set("mode", mode);
  url.searchParams.set("board", board.id);
  const features = [
    "popup=yes",
    "width=1180",
    "height=920",
    "resizable=yes",
    "scrollbars=no",
  ];

  if (state.threeTttSetup.displayMode === "secondary" && typeof window.getScreenDetails === "function") {
    try {
      const details = await window.getScreenDetails();
      const secondary = details.screens.find((screen) => !screen.isPrimary);
      if (secondary) {
        features.push(`left=${Math.round(secondary.availLeft)}`);
        features.push(`top=${Math.round(secondary.availTop)}`);
        features.push(`width=${Math.round(secondary.availWidth)}`);
        features.push(`height=${Math.round(secondary.availHeight)}`);
      } else {
        addLog("No secondary screen detected. Opening 3TTT on the current screen.", "info");
      }
    } catch {
      addLog("Secondary screen access was not granted. Opening 3TTT on the current screen.", "info");
    }
  }

  const popup = window.open(url.toString(), `dobot-3ttt-${mode}-${board.id}`, features.join(","));
  if (!popup) {
    throw new Error("3TTT board window was blocked by the browser");
  }
  popup.focus();
}

async function launchThreeTttMappingWindow() {
  syncThreeTttSetupFromControls();
  const board = getThreeTttSelectedBoard();
  if (!board) {
    throw new Error("Select a board to map first.");
  }
  await openThreeTttBoardWindow(board, "mapping");
}

async function launchThreeTttWindow() {
  syncThreeTttSetupFromControls();
  const launchBoard = getThreeTttLaunchBoard();
  if (!isThreeTttBoardReady(launchBoard)) {
    throw new Error(`Map all positions for ${launchBoard?.label || "the selected board"} before launching its player screen.`);
  }
  await openThreeTttBoardWindow(launchBoard, "play");
}

function defaultChessSetup() {
  const manualTargets = Object.fromEntries(CHESS_TARGET_ORDER.map((slot) => [slot, null]));
  const calibratedTargets = Object.fromEntries(CHESS_TARGET_ORDER.map((slot) => [slot, null]));
  return {
    displayMode: "current",
    robotMode: "preview",
    mappingSource: "manual",
    playerColor: "white",
    difficulty: "medium",
    moveDwellMs: 450,
    selectedSquare: "E2",
    manualTargets,
    calibratedTargets,
    targets: manualTargets,
  };
}

function normalizeChessTargetMap(rawTargets) {
  const targets = Object.fromEntries(CHESS_TARGET_ORDER.map((slot) => [slot, null]));
  Object.entries(rawTargets || {}).forEach(([slot, target]) => {
    if (!CHESS_TARGET_ORDER.includes(slot) || !target) {
      return;
    }
    const normalized = normalizeStandaloneTarget(target, slot);
    if (normalized) {
      targets[slot] = normalized;
    }
  });
  if (!targets.ANCHOR && rawTargets?.CAPTURE) {
    targets.ANCHOR = normalizeStandaloneTarget(rawTargets.CAPTURE, "ANCHOR");
  }
  return targets;
}

function syncChessActiveTargets(setup) {
  const source = setup.mappingSource === "calibrated" ? "calibrated" : "manual";
  const key = source === "calibrated" ? "calibratedTargets" : "manualTargets";
  setup.mappingSource = source;
  setup.targets = normalizeChessTargetMap(setup[key]);
  return setup;
}

function normalizeChessSetup(raw) {
  const defaults = defaultChessSetup();
  const merged = raw && typeof raw === "object" ? raw : {};
  const migratedTargets = normalizeChessTargetMap(merged.targets);
  const manualTargets = normalizeChessTargetMap(merged.manualTargets || merged.targets);
  const calibratedTargets = normalizeChessTargetMap(merged.calibratedTargets || merged.targets);
  const selectedSquare = CHESS_BOARD_TARGETS.includes(merged.selectedSquare) ? merged.selectedSquare : defaults.selectedSquare;
  return syncChessActiveTargets({
    displayMode: merged.displayMode === "secondary" ? "secondary" : "current",
    robotMode: ["preview", "api"].includes(merged.robotMode) ? merged.robotMode : "preview",
    mappingSource: merged.mappingSource === "calibrated" ? "calibrated" : "manual",
    playerColor: merged.playerColor === "black" ? "black" : "white",
    difficulty: ["easy", "medium", "hard"].includes(merged.difficulty) ? merged.difficulty : "medium",
    moveDwellMs: Math.max(100, Math.min(3000, Number(merged.moveDwellMs || defaults.moveDwellMs) || defaults.moveDwellMs)),
    selectedSquare,
    manualTargets,
    calibratedTargets,
    targets: migratedTargets,
  });
}

function loadChessSetup() {
  try {
    const raw = window.localStorage.getItem(CHESS_STORAGE_KEY);
    return normalizeChessSetup(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultChessSetup();
  }
}

function saveChessSetup() {
  if (!state.chessSetup) {
    return;
  }
  syncChessActiveTargets(state.chessSetup);
  saveMappedSetup("chess", CHESS_STORAGE_KEY, state.chessSetup);
}

function getChessSourceKey(source = state.chessSetup?.mappingSource) {
  return source === "calibrated" ? "calibratedTargets" : "manualTargets";
}

function getChessTargets(source = state.chessSetup?.mappingSource) {
  if (!state.chessSetup) {
    state.chessSetup = loadChessSetup();
  }
  return state.chessSetup[getChessSourceKey(source)] || state.chessSetup.targets || {};
}

function setChessTarget(slot, target, source = state.chessSetup?.mappingSource) {
  if (!state.chessSetup) {
    state.chessSetup = loadChessSetup();
  }
  const key = getChessSourceKey(source);
  if (!state.chessSetup[key]) {
    state.chessSetup[key] = Object.fromEntries(CHESS_TARGET_ORDER.map((targetSlot) => [targetSlot, null]));
  }
  state.chessSetup[key][slot] = target;
  if (CHESS_ANCHOR_TARGETS.includes(slot)) {
    const otherKey = key === "manualTargets" ? "calibratedTargets" : "manualTargets";
    if (!state.chessSetup[otherKey]) {
      state.chessSetup[otherKey] = Object.fromEntries(CHESS_TARGET_ORDER.map((targetSlot) => [targetSlot, null]));
    }
    state.chessSetup[otherKey][slot] = target;
  }
  syncChessActiveTargets(state.chessSetup);
}

function clearChessTarget(slot, source = state.chessSetup?.mappingSource) {
  setChessTarget(slot, null, source);
}

function getActiveChessTarget(slot) {
  return getChessTargets(state.chessSetup?.mappingSource)?.[slot] || null;
}

function getCalibratedChessTarget(slot) {
  return getChessTargets("calibrated")?.[slot] || null;
}

function chessTargetHasPose(target) {
  return Boolean(
    target
    && Array.isArray(target.pose)
    && target.pose.length >= 6
    && target.pose.slice(0, 6).every((value) => Number.isFinite(Number(value))),
  );
}

function chessTargetHasJointsAndPose(target) {
  return Boolean(
    chessTargetHasPose(target)
    && Array.isArray(target.joints)
    && target.joints.length === 6
    && target.joints.every((value) => Number.isFinite(Number(value))),
  );
}

function countMappedChessTargets() {
  return CHESS_TARGET_ORDER.filter((slot) => Boolean(getActiveChessTarget(slot))).length;
}

function countChessCalibrationSamples() {
  return CHESS_CALIBRATION_SQUARES.filter((slot) => {
    const target = getCalibratedChessTarget(slot);
    return chessTargetHasJointsAndPose(target) && target.calculated !== true;
  }).length;
}

function isChessCalibrationReady() {
  return countChessCalibrationSamples() === CHESS_CALIBRATION_SQUARES.length;
}

function chessBoardPoseCount() {
  return CHESS_BOARD_TARGETS.filter((slot) => chessTargetHasPose(getCalibratedChessTarget(slot))).length;
}

function hasChessAnchorTarget() {
  return Boolean(getCalibratedChessTarget("ANCHOR")?.joints?.length === 6);
}

function isChessReady() {
  return countMappedChessTargets() === CHESS_TARGET_ORDER.length;
}

function getChessSelectedSlot() {
  return CHESS_BOARD_TARGETS.includes(state.chessSetup?.selectedSquare)
    ? state.chessSetup.selectedSquare
    : "E2";
}

function interpolateVector(start, end, t) {
  return start.map((value, index) => Number(value) + (Number(end[index]) - Number(value)) * t);
}

function normalizeDegrees(value) {
  let next = Number(value);
  while (next > 180) {
    next -= 360;
  }
  while (next <= -180) {
    next += 360;
  }
  return next;
}

function interpolateAngleDegrees(start, end, t) {
  const delta = normalizeDegrees(Number(end) - Number(start));
  return normalizeDegrees(Number(start) + delta * t);
}

function interpolatePoseVector(start, end, t) {
  return start.map((value, index) => {
    if (index >= 3 && index <= 5) {
      return interpolateAngleDegrees(value, end[index], t);
    }
    return Number(value) + (Number(end[index]) - Number(value)) * t;
  });
}

function interpolateCalibrationVector(start, end, t, key) {
  return key === "pose"
    ? interpolatePoseVector(start, end, t)
    : interpolateVector(start, end, t);
}

function alignPoseValueToReference(value, reference) {
  let next = Number(value);
  const base = Number(reference);
  while (next - base > 180) {
    next -= 360;
  }
  while (next - base <= -180) {
    next += 360;
  }
  return next;
}

function normalizeCalibrationVector(values, key) {
  if (key !== "pose") {
    return values;
  }
  return values.map((value, index) => (
    index >= 3 && index <= 5 ? normalizeDegrees(value) : value
  ));
}

function weightedCalibrationVector(terms, key) {
  const first = terms.find((term) => Array.isArray(term.vector))?.vector;
  if (!first) {
    throw new Error(`Missing calibration ${key} values`);
  }
  const result = first.map((_, index) => terms.reduce((total, term) => {
    let value = Number(term.vector[index]);
    if (key === "pose" && index >= 3 && index <= 5) {
      value = alignPoseValueToReference(value, first[index]);
    }
    return total + (value * term.weight);
  }, 0));
  return normalizeCalibrationVector(result, key);
}

function getChessCalibrationValue(slot, key) {
  const target = getCalibratedChessTarget(slot);
  const value = target?.[key];
  if (target?.calculated === true || !Array.isArray(value)) {
    throw new Error(`Record chess calibration sample ${slot} first.`);
  }
  return value.map((entry) => Number(entry));
}

function chessSquareCoordinate(slot) {
  const normalized = String(slot || "").toUpperCase();
  const file = normalized.charAt(0);
  const rank = normalized.charAt(1);
  const fileIndex = CHESS_FILES.indexOf(file);
  const rankIndex = CHESS_RANKS.indexOf(rank);
  if (fileIndex < 0 || rankIndex < 0) {
    throw new Error(`Invalid chess square: ${slot}`);
  }
  return { file, rank, fileIndex, rankIndex };
}

function interpolateChessEdgeValue(startSlot, nearStartSlot, nearEndSlot, endSlot, t, key) {
  if (t <= 1 / 7) {
    return interpolateCalibrationVector(
      getChessCalibrationValue(startSlot, key),
      getChessCalibrationValue(nearStartSlot, key),
      t * 7,
      key,
    );
  }
  if (t >= 6 / 7) {
    return interpolateCalibrationVector(
      getChessCalibrationValue(nearEndSlot, key),
      getChessCalibrationValue(endSlot, key),
      (t * 7) - 6,
      key,
    );
  }
  return interpolateCalibrationVector(
    getChessCalibrationValue(nearStartSlot, key),
    getChessCalibrationValue(nearEndSlot, key),
    ((t * 7) - 1) / 5,
    key,
  );
}

function chessBottomEdgeValue(t, key) {
  return interpolateChessEdgeValue("A1", "B1", "G1", "H1", t, key);
}

function chessTopEdgeValue(t, key) {
  return interpolateChessEdgeValue("A8", "B8", "G8", "H8", t, key);
}

function chessLeftEdgeValue(t, key) {
  return interpolateChessEdgeValue("A1", "A2", "A7", "A8", t, key);
}

function chessRightEdgeValue(t, key) {
  return interpolateChessEdgeValue("H1", "H2", "H7", "H8", t, key);
}

function chessCornerPatchValue(u, v, key) {
  return weightedCalibrationVector([
    { vector: getChessCalibrationValue("A1", key), weight: (1 - u) * (1 - v) },
    { vector: getChessCalibrationValue("H1", key), weight: u * (1 - v) },
    { vector: getChessCalibrationValue("A8", key), weight: (1 - u) * v },
    { vector: getChessCalibrationValue("H8", key), weight: u * v },
  ], key);
}

function interpolateChessCalibrationValue(slot, key) {
  const { fileIndex, rankIndex } = chessSquareCoordinate(slot);
  const u = fileIndex / 7;
  const v = rankIndex / 7;
  const left = chessLeftEdgeValue(v, key);
  const right = chessRightEdgeValue(v, key);
  const bottom = chessBottomEdgeValue(u, key);
  const top = chessTopEdgeValue(u, key);
  const cornerPatch = chessCornerPatchValue(u, v, key);
  return weightedCalibrationVector([
    { vector: left, weight: 1 - u },
    { vector: right, weight: u },
    { vector: bottom, weight: 1 - v },
    { vector: top, weight: v },
    { vector: cornerPatch, weight: -1 },
  ], key);
}

function generateChessCalibrationMapping() {
  if (!state.chessSetup) {
    state.chessSetup = loadChessSetup();
  }
  if (!isChessCalibrationReady()) {
    throw new Error("Record A1/A2/B1, A8/A7/B8, H8/G8/H7, and H1/G1/H2 first.");
  }
  const calibratedAt = new Date().toISOString();
  let generated = 0;
  CHESS_BOARD_TARGETS.forEach((slot) => {
    if (CHESS_CALIBRATION_SQUARES.includes(slot)) {
      return;
    }
    setChessTarget(slot, {
      slot,
      joints: interpolateChessCalibrationValue(slot, "joints"),
      pose: interpolateChessCalibrationValue(slot, "pose"),
      capturedAt: calibratedAt,
      calibratedAt,
      calculated: true,
    }, "calibrated");
    generated += 1;
  });
  state.chessSetup.mappingSource = "calibrated";
  syncChessActiveTargets(state.chessSetup);
  saveChessSetup();
  renderChessSetup();
  addLog(`Generated ${generated} chess square targets from calibration samples.`, "success");
}

async function fetchRobotStateSilently() {
  const payload = await api("/api/state");
  updateSnapshot(payload.state);
  return payload.state;
}

async function ensureChessAutoRecordMotionReady() {
  const latest = await fetchRobotStateSilently();
  if (!latest?.connected || !latest?.motion_channel_available || !latest?.motion_ready) {
    throw new Error(`Robot is ${latest?.mode_name || "not ready"}. Stop drag/backdrive and enable motion before chess auto record.`);
  }
  return latest;
}

async function moveToChessAnchorForCalibration() {
  const anchor = getCalibratedChessTarget("ANCHOR");
  if (!anchor?.joints || anchor.joints.length !== 6) {
    throw new Error("Record the chess ANCHOR position before auto recording.");
  }
  await api("/api/joint-movej", {
    method: "POST",
    body: {
      joints: anchor.joints,
      speedj: getJointSpeed(),
      accj: getJointAcc(),
      sync: true,
    },
  });
}

function chessApproachPose(target) {
  const pose = target.pose.slice(0, 6).map((value) => Number(value));
  pose[2] += CHESS_CALIBRATION_APPROACH_Z_MM;
  return pose;
}

async function moveToChessApproachForCalibration(slot) {
  const target = getCalibratedChessTarget(slot);
  if (!chessTargetHasPose(target)) {
    throw new Error(`Missing calculated pose for ${slot}`);
  }
  await api("/api/movej", {
    method: "POST",
    body: poseBodyFromArray(chessApproachPose(target), {
      speedj: getJointSpeed(),
      accj: getJointAcc(),
      sync: true,
    }),
  });
}

async function descendToChessPoseForCalibration(slot) {
  const target = getCalibratedChessTarget(slot);
  if (!chessTargetHasPose(target)) {
    throw new Error(`Missing calculated pose for ${slot}`);
  }
  await api("/api/movel", {
    method: "POST",
    body: poseBodyFromArray(target.pose, {
      speedl: getJointSpeed(),
      accl: getJointAcc(),
      sync: true,
    }),
  });
}

async function liftFromChessPoseForCalibration(slot) {
  const target = getCalibratedChessTarget(slot);
  if (!chessTargetHasPose(target)) {
    throw new Error(`Missing calculated pose for ${slot}`);
  }
  await api("/api/movel", {
    method: "POST",
    body: poseBodyFromArray(chessApproachPose(target), {
      speedl: getJointSpeed(),
      accl: getJointAcc(),
      sync: true,
    }),
  });
}

async function moveToChessPoseForCalibration(slot) {
  await moveToChessApproachForCalibration(slot);
  await descendToChessPoseForCalibration(slot);
}

function chessPoseDelta(actualPose, targetPose) {
  const xyz = actualPose.slice(0, 3).map((value, index) => Math.abs(Number(value) - Number(targetPose[index])));
  const angles = actualPose.slice(3, 6).map((value, index) => (
    Math.abs(normalizeDegrees(Number(value) - Number(targetPose[index + 3])))
  ));
  return {
    xyz,
    angles,
    maxMm: Math.max(...xyz),
    maxDeg: Math.max(...angles),
  };
}

function assertChessSnapshotAtTarget(slot, snapshot) {
  const target = getCalibratedChessTarget(slot);
  const actualPose = snapshot?.pose?.floats;
  if (!chessTargetHasPose(target) || !Array.isArray(actualPose) || actualPose.length < 6) {
    throw new Error(`Cannot verify robot pose for ${slot}`);
  }
  const delta = chessPoseDelta(actualPose, target.pose);
  if (delta.maxMm > 5 || delta.maxDeg > 5) {
    throw new Error(
      `Robot did not reach ${slot}; live pose differs by ${formatNumber(delta.maxMm, 1)} mm / ${formatNumber(delta.maxDeg, 1)} deg. Not saving this square.`,
    );
  }
}

function captureChessTargetFromSnapshot(slot, snapshot = state.snapshot) {
  return {
    slot,
    ...captureTicTacToeLiveTarget(snapshot),
    autoRecordedAt: new Date().toISOString(),
    calculated: false,
  };
}

async function runChessAutoRecord() {
  if (state.chessCalibrationRunning) {
    return;
  }
  await ensureChessAutoRecordMotionReady();
  if (!hasChessAnchorTarget()) {
    throw new Error("Record the chess ANCHOR position before auto recording.");
  }
  if (!isChessCalibrationReady()) {
    throw new Error("Record A1/A2/B1, A8/A7/B8, H8/G8/H7, and H1/G1/H2 before auto recording.");
  }
  if (chessBoardPoseCount() !== CHESS_BOARD_TARGETS.length) {
    throw new Error("Generate the chess board mapping before auto recording.");
  }

  state.chessCalibrationRunning = true;
  state.chessCalibrationCancel = false;
  state.chessCalibrationStatus = "Moving to Anchor";
  state.chessSetup.mappingSource = "calibrated";
  syncChessActiveTargets(state.chessSetup);
  renderChessSetup();

  try {
    await ensureSpeedApplied(true);
    await ensureChessAutoRecordMotionReady();
    await moveToChessAnchorForCalibration();
    for (const [index, slot] of CHESS_BOARD_TARGETS.entries()) {
      if (state.chessCalibrationCancel) {
        addLog("Chess auto record stopped.", "info");
        return;
      }
      state.chessCalibrationStatus = `${slot} (${index + 1} / ${CHESS_BOARD_TARGETS.length})`;
      renderChessCalibrationPanel(state.snapshot);
      await moveToChessPoseForCalibration(slot);
      await delay(Math.max(100, Number(state.chessSetup.moveDwellMs) || 450));
      const snapshot = await fetchRobotStateSilently();
      assertChessSnapshotAtTarget(slot, snapshot);
      setChessTarget(slot, captureChessTargetFromSnapshot(slot, snapshot), "calibrated");
      saveChessSetup();
      renderChessSetup(snapshot);
      await liftFromChessPoseForCalibration(slot);
      await moveToChessAnchorForCalibration();
    }
    state.chessCalibrationStatus = "Auto record complete";
    saveChessSetup();
    addLog("Chess auto record completed through Anchor.", "success");
  } catch (error) {
    state.chessCalibrationStatus = "Auto record stopped";
    throw error;
  } finally {
    state.chessCalibrationRunning = false;
    state.chessCalibrationCancel = false;
    renderChessSetup();
  }
}

function buildChessTargetCard(slot, target, snapshot, variant) {
  const card = buildTicTacToeTargetCard(slot, target, snapshot, variant);
  card.classList.add("chess-target-card");
  card.classList.toggle("calculated", Boolean(target?.calculated));
  const captureButton = card.querySelector('[data-action="capture"]');
  const clearButton = card.querySelector('[data-action="clear-icon"]');
  const moveButton = card.querySelector('[data-action="move"]');

  captureButton.replaceWith(captureButton.cloneNode(true));
  clearButton.replaceWith(clearButton.cloneNode(true));
  moveButton.replaceWith(moveButton.cloneNode(true));

  const freshCapture = card.querySelector('[data-action="capture"]');
  const freshClear = card.querySelector('[data-action="clear-icon"]');
  const freshMove = card.querySelector('[data-action="move"]');
  const emptyMeta = target ? null : card.querySelector(".ttt-target-meta div");
  if (emptyMeta) {
    emptyMeta.textContent = slot === "ANCHOR"
      ? "Record the middle waypoint."
      : CHESS_ANCHOR_TARGETS.includes(slot)
        ? "Record this shared robot position."
        : "Record this board square.";
  }
  freshCapture.textContent = target ? "Rerecord" : "Record";
  freshCapture.disabled = !hasLiveTicTacToeCaptureSource(snapshot);
  freshClear.disabled = !target;
  freshClear.classList.toggle("visible", Boolean(target));
  freshMove.disabled = !target;

  freshCapture.addEventListener("click", () => {
    try {
      setChessTarget(slot, {
        slot,
        ...captureTicTacToeLiveTarget(snapshot),
        calculated: false,
      });
      saveChessSetup();
      renderChessSetup(snapshot);
      addLog(`Recorded ${state.chessSetup.mappingSource} chess target ${slot}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  freshClear.addEventListener("click", () => {
    clearChessTarget(slot);
    saveChessSetup();
    renderChessSetup(snapshot);
    addLog(`Cleared ${state.chessSetup.mappingSource} chess target ${slot}.`, "info");
  });

  freshMove.addEventListener("click", async () => {
    try {
      if (!target) {
        throw new Error(`No target mapped for ${slot}`);
      }
      await ensureSpeedApplied(true);
      await api("/api/joint-movej", {
        method: "POST",
        body: {
          joints: target.joints,
          speedj: getJointSpeed(),
          accj: getJointAcc(),
          sync: true,
        },
      });
      addLog(`Moved robot to chess target ${slot}.`, "success");
      await refreshState(`chess-move-${slot.toLowerCase()}`);
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  return card;
}

function recordChessCalibrationSample(slot, snapshot = state.snapshot) {
  state.chessSetup.mappingSource = "calibrated";
  setChessTarget(slot, {
    slot,
    ...captureTicTacToeLiveTarget(snapshot),
    calculated: false,
  }, "calibrated");
  state.chessSetup.selectedSquare = slot;
  saveChessSetup();
  renderChessSetup(snapshot);
  addLog(`Recorded chess calibration sample ${slot}.`, "success");
}

function renderChessCalibrationPanel(snapshot = state.snapshot) {
  const grid = $("chess-calibration-grid");
  if (!grid || !state.chessSetup) {
    return;
  }
  const sampleCount = countChessCalibrationSamples();
  const poseCount = chessBoardPoseCount();
  const status = $("chess-calibration-status");
  status.textContent = state.chessCalibrationRunning
    ? (state.chessCalibrationStatus || "Auto recording")
    : `${sampleCount} / ${CHESS_CALIBRATION_SQUARES.length} samples | ${poseCount} / ${CHESS_BOARD_TARGETS.length} poses`;

  grid.innerHTML = "";
  CHESS_CALIBRATION_SQUARES.forEach((slot) => {
    const target = getCalibratedChessTarget(slot);
    const sample = document.createElement("div");
    sample.className = `chess-calibration-sample${target ? " mapped" : ""}`;
    sample.innerHTML = `
      <strong>${slot}</strong>
      <span>${target ? (target.calculated ? "Calculated" : "Mapped") : "Open"}</span>
      <div class="chess-calibration-actions">
        <button class="btn" type="button" data-action="select">Select</button>
        <button class="btn" type="button" data-action="record">Record</button>
      </div>
    `;
    sample.querySelector('[data-action="select"]').addEventListener("click", () => {
      state.chessSetup.mappingSource = "calibrated";
      syncChessActiveTargets(state.chessSetup);
      state.chessSetup.selectedSquare = slot;
      saveChessSetup();
      renderChessSetup(snapshot);
    });
    const recordButton = sample.querySelector('[data-action="record"]');
    recordButton.disabled = state.chessCalibrationRunning || !hasLiveTicTacToeCaptureSource(snapshot);
    recordButton.addEventListener("click", () => {
      try {
        recordChessCalibrationSample(slot, snapshot);
      } catch (error) {
        addLog(error.message, "error");
      }
    });
    grid.appendChild(sample);
  });

  $("chess-generate-calibration-button").disabled = state.chessCalibrationRunning || !isChessCalibrationReady();
  $("chess-auto-record-button").disabled = state.chessCalibrationRunning
    || !hasChessAnchorTarget()
    || !isChessCalibrationReady()
    || poseCount !== CHESS_BOARD_TARGETS.length
    || !state.snapshot?.motion_ready
    || !state.snapshot?.motion_channel_available;
  $("chess-auto-record-stop-button").disabled = !state.chessCalibrationRunning;
}

function renderChessBoardMappingGrid() {
  const grid = $("chess-board-map-grid");
  if (!grid || !state.chessSetup) {
    return;
  }
  grid.innerHTML = "";
  const selected = getChessSelectedSlot();
  [...CHESS_RANKS].reverse().forEach((rank) => {
    CHESS_FILES.forEach((file) => {
      const slot = `${file}${rank}`;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chess-map-square";
      const target = getActiveChessTarget(slot);
      const stateLabel = target ? (target.calculated ? "Calculated" : "Mapped") : "Open";
      button.classList.toggle("mapped", Boolean(target));
      button.classList.toggle("calculated", Boolean(target?.calculated));
      button.classList.toggle("selected", slot === selected);
      button.dataset.state = stateLabel.toLowerCase();
      button.title = `${slot} - ${stateLabel}${slot === selected ? " selected" : ""}`;
      button.setAttribute("aria-label", `${slot} ${stateLabel}${slot === selected ? " selected" : ""}`);
      button.setAttribute("aria-pressed", slot === selected ? "true" : "false");
      button.textContent = slot;
      button.addEventListener("click", () => {
        state.chessSetup.selectedSquare = slot;
        saveChessSetup();
        renderChessSetup();
      });
      grid.appendChild(button);
    });
  });
}

function renderChessSetup(snapshot = state.snapshot) {
  if (!state.chessSetup) {
    state.chessSetup = loadChessSetup();
  }
  syncChessActiveTargets(state.chessSetup);
  const setup = state.chessSetup;
  $("chess-display-select").value = setup.displayMode;
  $("chess-robot-mode-select").value = setup.robotMode;
  $("chess-mapping-source-select").value = setup.mappingSource;
  $("chess-player-color-select").value = setup.playerColor;
  $("chess-difficulty-select").value = setup.difficulty;
  $("chess-dwell-input").value = String(setup.moveDwellMs);

  const mappedCount = countMappedChessTargets();
  $("chess-mapping-progress").textContent = `${mappedCount} / ${CHESS_TARGET_ORDER.length} mapped`;
  $("chess-readiness-label").textContent = setup.robotMode === "preview"
    ? "Preview ready"
    : isChessReady()
      ? "Robot ready"
      : `Map all ${setup.mappingSource} chess targets`;
  $("chess-live-position-note").textContent = hasLiveTicTacToeCaptureSource(snapshot)
    ? "Ready to record current robot position."
    : "Connect robot to record positions.";
  $("chess-launch-button").disabled = setup.robotMode !== "preview" && !isChessReady();
  $("chess-save-setup-button").disabled = mappedCount === 0;
  $("chess-reset-mapping-button").disabled = mappedCount === 0;

  const anchorGrid = $("chess-anchor-grid");
  anchorGrid.innerHTML = "";
  CHESS_ANCHOR_TARGETS.forEach((slot) => {
    anchorGrid.appendChild(buildChessTargetCard(slot, setup.targets[slot], snapshot, "anchor"));
  });

  renderChessBoardMappingGrid();
  renderChessCalibrationPanel(snapshot);
  const selectedSlot = getChessSelectedSlot();
  $("chess-selected-square-label").textContent = selectedSlot;
  const selectedGrid = $("chess-selected-square-card");
  selectedGrid.innerHTML = "";
  selectedGrid.appendChild(buildChessTargetCard(selectedSlot, getActiveChessTarget(selectedSlot), snapshot, "cell"));
}

function syncChessSetupFromControls() {
  if (!state.chessSetup) {
    state.chessSetup = loadChessSetup();
  }
  state.chessSetup = normalizeChessSetup({
    ...state.chessSetup,
    displayMode: $("chess-display-select").value,
    robotMode: $("chess-robot-mode-select").value,
    mappingSource: $("chess-mapping-source-select").value,
    playerColor: $("chess-player-color-select").value,
    difficulty: $("chess-difficulty-select").value,
    moveDwellMs: Number($("chess-dwell-input").value),
  });
  saveChessSetup();
  renderChessSetup();
}

async function launchChessWindow(mode = "play") {
  syncChessSetupFromControls();
  if (mode === "play" && state.chessSetup.robotMode !== "preview" && !isChessReady()) {
    throw new Error("Map Home, Standby, Anchor, and all 64 chess squares before launching robot mode.");
  }
  await flushMappedSetup("chess", CHESS_STORAGE_KEY, state.chessSetup);

  const url = new URL("/chess.html", window.location.href);
  url.searchParams.set("game", "chess");
  url.searchParams.set("mode", mode);
  const features = [
    "popup=yes",
    "width=1220",
    "height=920",
    "resizable=yes",
    "scrollbars=no",
  ];

  if (state.chessSetup.displayMode === "secondary" && typeof window.getScreenDetails === "function") {
    try {
      const details = await window.getScreenDetails();
      const secondary = details.screens.find((screen) => !screen.isPrimary);
      if (secondary) {
        features.push(`left=${Math.round(secondary.availLeft)}`);
        features.push(`top=${Math.round(secondary.availTop)}`);
        features.push(`width=${Math.round(secondary.availWidth)}`);
        features.push(`height=${Math.round(secondary.availHeight)}`);
      } else {
        addLog("No secondary screen detected. Opening Chess on the current screen.", "info");
      }
    } catch {
      addLog("Secondary screen access was not granted. Opening Chess on the current screen.", "info");
    }
  }

  const popup = window.open(url.toString(), mode === "mapping" ? "dobot-chess-map" : "dobot-chess-screen", features.join(","));
  if (!popup) {
    throw new Error("Chess window was blocked by the browser");
  }
  popup.focus();
}

async function saveTicTacToeSetupFile() {
  if (!state.tictactoeSetup) {
    state.tictactoeSetup = loadTicTacToeSetup();
  }
  if (countMappedTicTacToeTargets() === 0 && countTicTacToeRoutineSteps() === 0) {
    throw new Error("Nothing mapped yet. Capture positions before saving.");
  }
  saveTicTacToeSetup();
  const payload = await api("/api/tictactoe/setup", {
    method: "POST",
    body: { setup: state.tictactoeSetup },
  });
  addLog(`Saved Tic-Tac-Toe setup to ${payload.path}.`, "success");
}

async function loadTicTacToeSetupFile() {
  const payload = await api("/api/tictactoe/setup");
  if (!payload.exists || !payload.setup) {
    throw new Error("No saved Tic-Tac-Toe setup file found.");
  }
  state.tictactoeSetup = normalizeTicTacToeSetup(payload.setup);
  saveTicTacToeSetup();
  renderTicTacToeSetup();
  addLog(`Loaded Tic-Tac-Toe setup from ${payload.path}.`, "success");
}

async function saveThreeTttSetupFile() {
  if (!state.threeTttSetup) {
    state.threeTttSetup = loadThreeTttSetup();
  }
  if (countMappedThreeTttSetup() === 0) {
    throw new Error("Nothing mapped yet. Capture positions before saving.");
  }
  syncThreeTttSetupFromControls();
  const payload = await saveMappingToDiskNow("3ttt", state.threeTttSetup);
  writeMappingCache(THREE_TTT_STORAGE_KEY, state.threeTttSetup);
  addLog(`Saved 3TTT setup to ${payload.path}.`, "success");
}

async function loadThreeTttSetupFile() {
  const payload = await loadSavedMapping("3ttt", normalizeThreeTttSetup, state.threeTttSetup, THREE_TTT_STORAGE_KEY);
  if (!payload.loaded) {
    throw new Error("No saved 3TTT setup file found.");
  }
  state.threeTttSetup = payload.value;
  renderThreeTttSetup();
  addLog(`Loaded 3TTT setup from ${payload.path}.`, "success");
}

async function saveChessSetupFile() {
  if (!state.chessSetup) {
    state.chessSetup = loadChessSetup();
  }
  syncChessSetupFromControls();
  if (countMappedChessTargets() === 0) {
    throw new Error("Nothing mapped yet. Capture positions before saving.");
  }
  const payload = await saveMappingToDiskNow("chess", state.chessSetup);
  writeMappingCache(CHESS_STORAGE_KEY, state.chessSetup);
  addLog(`Saved Chess setup to ${payload.path}.`, "success");
}

async function loadChessSetupFile() {
  const payload = await loadSavedMapping("chess", normalizeChessSetup, state.chessSetup, CHESS_STORAGE_KEY);
  if (!payload.loaded) {
    throw new Error("No saved Chess setup file found.");
  }
  state.chessSetup = payload.value;
  renderChessSetup();
  addLog(`Loaded Chess setup from ${payload.path}.`, "success");
}

async function saveCoffeeSetupFile() {
  if (!state.coffeeSetup) {
    state.coffeeSetup = loadCoffeeSetup();
  }
  if (countMappedCoffeeTargets() === 0 && countReadyCoffeeRoutines() === 0) {
    throw new Error("Nothing mapped yet. Capture positions before saving.");
  }
  const payload = await saveMappingToDiskNow("coffee", state.coffeeSetup);
  writeMappingCache(COFFEE_STORAGE_KEY, state.coffeeSetup);
  addLog(`Saved Coffee setup to ${payload.path}.`, "success");
}

async function loadCoffeeSetupFile() {
  const payload = await loadSavedMapping("coffee", normalizeCoffeeSetup, state.coffeeSetup, COFFEE_STORAGE_KEY);
  if (!payload.loaded) {
    throw new Error("No saved Coffee setup file found.");
  }
  state.coffeeSetup = payload.value;
  renderCoffeeSetup();
  addLog(`Loaded Coffee setup from ${payload.path}.`, "success");
}

function defaultCoffeeSetup() {
  return {
    displayMode: "current",
    gripperType: "two_finger",
    targets: Object.fromEntries(COFFEE_TARGET_ORDER.map((slot) => [slot, null])),
    routines: Object.fromEntries(
      COFFEE_ROUTINE_KEYS.map((key) => [key, defaultTicTacToeRoutineState()]),
    ),
    recipes: Object.fromEntries(
      COFFEE_RECIPES.map((recipe) => [
        recipe.key,
        {
          key: recipe.key,
          label: recipe.label,
          routineKey: recipe.routineKey,
          enabled: true,
          pourMs: recipe.defaultPourMs,
        },
      ]),
    ),
  };
}

function normalizeCoffeeSetup(raw) {
  const defaults = defaultCoffeeSetup();
  const merged = raw && typeof raw === "object" ? raw : {};
  const targets = { ...defaults.targets };
  const routines = Object.fromEntries(
    COFFEE_ROUTINE_KEYS.map((key) => [key, defaultTicTacToeRoutineState()]),
  );
  const recipes = {};
  const displayMode = merged.displayMode === "secondary" ? "secondary" : "current";
  const gripperType = ["two_finger", "soft", "suction"].includes(merged.gripperType) ? merged.gripperType : "two_finger";

  Object.entries(merged.targets || {}).forEach(([slot, target]) => {
    if (!COFFEE_TARGET_ORDER.includes(slot) || !target) {
      return;
    }
    const joints = Array.isArray(target.joints) && target.joints.length === 6
      ? target.joints.map((value) => Number(value))
      : null;
    const pose = Array.isArray(target.pose) && target.pose.length >= 3
      ? target.pose.map((value) => Number(value))
      : null;
    if (!joints || joints.some((value) => !Number.isFinite(value))) {
      return;
    }
    targets[slot] = {
      slot,
      joints,
      pose: pose && pose.every((value) => Number.isFinite(value)) ? pose : null,
      capturedAt: typeof target.capturedAt === "string" ? target.capturedAt : null,
    };
  });

  Object.entries(merged.routines || {}).forEach(([key, routine]) => {
    if (!COFFEE_ROUTINE_KEYS.includes(key) || !routine || typeof routine !== "object") {
      return;
    }
    const steps = Array.isArray(routine.steps)
      ? routine.steps
        .map((step, index) => {
          const joints = Array.isArray(step?.joints) && step.joints.length === 6
            ? step.joints.map((value) => Number(value))
            : null;
          const pose = Array.isArray(step?.pose) && step.pose.length >= 3
            ? step.pose.map((value) => Number(value))
            : null;
          if (!joints || joints.some((value) => !Number.isFinite(value))) {
            return null;
          }
          const stepId = Number.isInteger(step.stepId) ? step.stepId : index + 1;
          return {
            stepId,
            name: String(step.name || `${getCoffeeRoutineLabel(key)} ${index + 1}`),
            joints,
            pose: pose && pose.every((value) => Number.isFinite(value)) ? pose : null,
            dwellMs: Math.max(0, Number(step.dwellMs || 0) || 0),
            capturedAt: typeof step.capturedAt === "string" ? step.capturedAt : null,
          };
        })
        .filter(Boolean)
      : [];
    routines[key] = {
      steps,
      selectedStepId: steps.some((step) => step.stepId === routine.selectedStepId)
        ? routine.selectedStepId
        : (steps[0]?.stepId ?? null),
      nextStepId: Math.max(Number(routine.nextStepId) || 1, steps.reduce((maxId, step) => Math.max(maxId, step.stepId), 0) + 1),
    };
  });

  COFFEE_RECIPES.forEach((recipe) => {
    const saved = merged.recipes?.[recipe.key];
    recipes[recipe.key] = {
      key: recipe.key,
      label: recipe.label,
      routineKey: recipe.routineKey,
      enabled: saved?.enabled !== false,
      pourMs: Math.max(1000, Number(saved?.pourMs ?? recipe.defaultPourMs) || recipe.defaultPourMs),
    };
  });

  return {
    displayMode,
    gripperType,
    targets,
    routines,
    recipes,
  };
}

function loadCoffeeSetup() {
  try {
    const raw = window.localStorage.getItem(COFFEE_STORAGE_KEY);
    return normalizeCoffeeSetup(raw ? JSON.parse(raw) : null);
  } catch {
    return defaultCoffeeSetup();
  }
}

function saveCoffeeSetup() {
  if (!state.coffeeSetup) {
    return;
  }
  saveMappedSetup("coffee", COFFEE_STORAGE_KEY, state.coffeeSetup);
}

async function hydrateSavedMappingsFromDisk() {
  const results = await Promise.all([
    loadSavedMapping("main_home", (raw) => normalizeStandaloneTarget(raw), state.mainHomeTarget, MAIN_HOME_STORAGE_KEY, { allowNull: true }),
    loadSavedMapping(
      "sequence_orientation_lock",
      (raw) => normalizeSequenceOrientationLock(raw),
      state.sequenceOrientationLock,
      SEQUENCE_ORIENTATION_LOCK_STORAGE_KEY,
      { allowNull: true },
    ),
    loadSavedMapping("coffee", (raw) => normalizeCoffeeSetup(raw), state.coffeeSetup, COFFEE_STORAGE_KEY),
    loadSavedMapping("tictactoe", (raw) => normalizeTicTacToeSetup(raw), state.tictactoeSetup, TTT_STORAGE_KEY),
    loadSavedMapping("3ttt", (raw) => normalizeThreeTttSetup(raw), state.threeTttSetup, THREE_TTT_STORAGE_KEY),
    loadSavedMapping("chess", (raw) => normalizeChessSetup(raw), state.chessSetup, CHESS_STORAGE_KEY),
    loadSavedMapping("osc_c", (raw) => normalizeOscCSetup(raw), state.oscCSetup, OSC_C_STORAGE_KEY),
  ]);

  [
    state.mainHomeTarget,
    state.sequenceOrientationLock,
    state.coffeeSetup,
    state.tictactoeSetup,
    state.threeTttSetup,
    state.chessSetup,
    state.oscCSetup,
  ] = results.map((result) => result.value);

  const loadedCount = results.filter((result) => result.loaded).length;
  const path = results.find((result) => result.path)?.path;
  if (loadedCount > 0 && path) {
    addLog(`Loaded ${loadedCount} local mapping set${loadedCount === 1 ? "" : "s"} from ${path}.`, "info");
  }
}

function persistCurrentMappingsToDisk() {
  scheduleMappingFileSave("main_home", state.mainHomeTarget);
  scheduleMappingFileSave("sequence_orientation_lock", state.sequenceOrientationLock);
  scheduleMappingFileSave("coffee", state.coffeeSetup);
  scheduleMappingFileSave("tictactoe", state.tictactoeSetup);
  scheduleMappingFileSave("3ttt", state.threeTttSetup);
  scheduleMappingFileSave("chess", state.chessSetup);
  scheduleMappingFileSave("osc_c", state.oscCSetup);
}

function countMappedCoffeeTargets() {
  return COFFEE_TARGET_ORDER.filter((slot) => Boolean(state.coffeeSetup?.targets?.[slot])).length;
}

function getCoffeeRoutineLabel(key) {
  switch (key) {
    case "cup_pick":
      return "Cup Pick";
    case "machine_place":
      return "Machine Place";
    case "machine_pickup":
      return "Machine Pickup";
    case "delivery":
      return "Delivery";
    case "hot_water":
      return "Hot Water Button";
    case "milk":
      return "Milk Button";
    case "espresso":
      return "Espresso Button";
    case "cappuccino":
      return "Cappuccino Button";
    case "latte":
      return "Latte Button";
    default:
      return key
        .split("_")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
  }
}

function getCoffeeRoutineState(key) {
  const routineKey = COFFEE_ROUTINE_KEYS.includes(key) ? key : "cup_pick";
  if (!state.coffeeSetup?.routines?.[routineKey]) {
    return state.coffeeSetup?.routines?.cup_pick || defaultTicTacToeRoutineState();
  }
  return state.coffeeSetup.routines[routineKey];
}

function countReadyCoffeeRoutines() {
  return COFFEE_ROUTINE_KEYS.filter((key) => (state.coffeeSetup?.routines?.[key]?.steps || []).length > 0).length;
}

function hasEnabledCoffeeRecipes() {
  return COFFEE_RECIPES.some((recipe) => state.coffeeSetup?.recipes?.[recipe.key]?.enabled);
}

function isCoffeeReady() {
  if (countMappedCoffeeTargets() !== COFFEE_TARGET_ORDER.length || !hasEnabledCoffeeRecipes()) {
    return false;
  }
  const hasCoreRoutines = COFFEE_CORE_ROUTINE_KEYS.every((key) => (state.coffeeSetup?.routines?.[key]?.steps || []).length > 0);
  const hasDrinkRoutines = COFFEE_RECIPES
    .filter((recipe) => state.coffeeSetup?.recipes?.[recipe.key]?.enabled)
    .every((recipe) => (state.coffeeSetup?.routines?.[recipe.routineKey]?.steps || []).length > 0);
  return hasCoreRoutines && hasDrinkRoutines;
}

function buildCoffeeTargetCard(slot, target, snapshot) {
  const card = document.createElement("div");
  const isPositionSlot = COFFEE_ANCHOR_TARGETS.includes(slot);
  card.className = `ttt-target-card ${isPositionSlot ? "anchor-slot" : "cell-slot"}${target ? " mapped" : ""}`;
  card.innerHTML = `
    <div class="ttt-target-head">
      <div class="ttt-target-title">${slot}</div>
      <div class="ttt-target-head-actions">
        <div class="ttt-target-status">${target ? "Mapped" : "Open"}</div>
        <button class="ttt-clear-icon" type="button" data-action="clear-icon" aria-label="Clear ${slot}" title="Clear ${slot}">×</button>
      </div>
    </div>
    ${target ? `
    <div class="ttt-target-meta">
      <div>${formatCompactPose(target.pose)}</div>
      <div>${formatCompactJoints(target.joints)}</div>
    </div>
    ` : `
    <div class="ttt-target-meta">
      <div>${isPositionSlot ? "Capture this robot station position." : "Capture this machine button press position."}</div>
    </div>
    `}
    <div class="ttt-target-actions">
      <button class="btn btn-full" type="button" data-action="capture">${target ? "Recapture" : "Capture"}</button>
      <button class="btn btn-full" type="button" data-action="move">Move</button>
    </div>
  `;
  const captureButton = card.querySelector('[data-action="capture"]');
  const clearButton = card.querySelector('[data-action="clear-icon"]');
  const moveButton = card.querySelector('[data-action="move"]');
  captureButton.disabled = !hasLiveTicTacToeCaptureSource(snapshot);
  clearButton.disabled = !target;
  clearButton.classList.toggle("visible", Boolean(target));
  moveButton.disabled = !target || !state.snapshot?.motion_ready || !state.snapshot?.motion_channel_available;

  captureButton.addEventListener("click", () => {
    try {
      state.coffeeSetup.targets[slot] = {
        slot,
        ...captureTicTacToeLiveTarget(snapshot),
      };
      saveCoffeeSetup();
      renderCoffeeSetup(snapshot);
      addLog(`Captured coffee target ${slot}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  clearButton.addEventListener("click", () => {
    state.coffeeSetup.targets[slot] = null;
    saveCoffeeSetup();
    renderCoffeeSetup(snapshot);
    addLog(`Cleared coffee target ${slot}.`, "info");
  });

  moveButton.addEventListener("click", async () => {
    try {
      if (!target) {
        throw new Error(`Map ${slot} first`);
      }
      await ensureSpeedApplied(true, false);
      await api("/api/joint-movej", {
        method: "POST",
        body: {
          joints: target.joints,
          speedj: getJointSpeed(),
          accj: getJointAcc(),
          sync: true,
        },
      });
      await refreshState(`coffee-move-${slot.toLowerCase()}`);
      addLog(`Moved robot to coffee target ${slot}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  return card;
}

function renderCoffeeRecipeList() {
  const list = $("coffee-recipe-list");
  list.innerHTML = "";
  COFFEE_RECIPES.forEach((recipe) => {
    const config = state.coffeeSetup.recipes[recipe.key];
    const routineSteps = state.coffeeSetup.routines?.[recipe.routineKey]?.steps || [];
    const isEnabled = config.enabled !== false;
    const statusText = isEnabled
      ? (routineSteps.length ? `${routineSteps.length} step(s)` : "Sequence missing")
      : "Off";
    const card = document.createElement("div");
    card.className = `coffee-recipe-card${isEnabled ? "" : " disabled"}`;
    card.innerHTML = `
      <div class="coffee-recipe-head">
        <div class="coffee-recipe-title">${recipe.label}</div>
        <div class="coffee-recipe-state">${statusText}</div>
      </div>
      <div class="coffee-recipe-fields">
        <label>
          <input type="checkbox" data-coffee-recipe-enabled="${recipe.key}" ${isEnabled ? "checked" : ""}>
          <span>Available</span>
        </label>
        <label>
          <span>Time (s)</span>
          <input type="number" min="1" step="1" value="${coffeeMsToSeconds(config.pourMs)}" data-coffee-recipe-pour="${recipe.key}">
        </label>
      </div>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll("[data-coffee-recipe-enabled]").forEach((node) => {
    node.addEventListener("change", () => {
      const recipeKey = node.dataset.coffeeRecipeEnabled;
      state.coffeeSetup.recipes[recipeKey].enabled = node.checked;
      saveCoffeeSetup();
      renderCoffeeSetup();
    });
  });

  list.querySelectorAll("[data-coffee-recipe-pour]").forEach((node) => {
    node.addEventListener("change", () => {
      const recipeKey = node.dataset.coffeeRecipePour;
      state.coffeeSetup.recipes[recipeKey].pourMs = coffeeSecondsToMs(node.value);
      saveCoffeeSetup();
      renderCoffeeSetup();
    });
  });
}

function renderCoffeeSetup(snapshot = state.snapshot) {
  if (!state.coffeeSetup) {
    state.coffeeSetup = loadCoffeeSetup();
  }
  const scrollState = captureCoffeeScrollState();

  const display = $("coffee-display-select");
  const gripper = $("coffee-gripper-select");
  const anchorGrid = $("coffee-anchor-grid");
  const targetGrid = $("coffee-target-grid");
  const buttonGrid = $("coffee-button-grid");
  const progress = $("coffee-mapping-progress");
  const readiness = $("coffee-readiness-label");
  const liveNote = $("coffee-live-position-note");
  const launchButton = $("coffee-launch-button");
  const saveButton = $("coffee-save-setup-button");
  const resetButton = $("coffee-reset-mapping-button");

  display.value = state.coffeeSetup.displayMode;
  gripper.value = state.coffeeSetup.gripperType;

  const mappedCount = countMappedCoffeeTargets();
  progress.textContent = `${mappedCount} / ${COFFEE_TARGET_ORDER.length} anchors | ${countReadyCoffeeRoutines()} / ${COFFEE_ROUTINE_KEYS.length} sequences`;
  readiness.textContent = isCoffeeReady() ? "Ready to launch" : "Waiting for mapping";
  liveNote.textContent = hasLiveTicTacToeCaptureSource(snapshot)
    ? "Ready for capture."
    : "Connect robot to capture.";

  launchButton.disabled = !isCoffeeReady();
  saveButton.disabled = mappedCount === 0 && countReadyCoffeeRoutines() === 0;
  resetButton.disabled = mappedCount === 0 && countReadyCoffeeRoutines() === 0;

  anchorGrid.innerHTML = "";
  COFFEE_ANCHOR_TARGETS.forEach((slot) => {
    anchorGrid.appendChild(buildCoffeeTargetCard(slot, state.coffeeSetup.targets[slot], snapshot));
  });
  targetGrid.innerHTML = "";
  buttonGrid.innerHTML = "";
  COFFEE_CORE_ROUTINE_KEYS.forEach((key) => {
    targetGrid.appendChild(buildCoffeeRoutineCard(key, snapshot));
  });
  COFFEE_RECIPES.forEach((recipe) => {
    buttonGrid.appendChild(buildCoffeeRoutineCard(recipe.routineKey, snapshot));
  });
  renderCoffeeRecipeList();
  restoreCoffeeScrollState(scrollState);
}

async function launchCoffeeWindow() {
  if (!isCoffeeReady()) {
    throw new Error("Map Home and Standby, complete the required coffee sequences, and enable at least one drink before launching the coffee screen");
  }
  saveCoffeeSetup();
  await flushMappedSetup("coffee", COFFEE_STORAGE_KEY, state.coffeeSetup);

  const url = new URL("/coffee.html", window.location.href);
  const features = [
    "popup=yes",
    "width=1280",
    "height=900",
    "resizable=yes",
    "scrollbars=no",
  ];

  if (state.coffeeSetup.displayMode === "secondary" && typeof window.getScreenDetails === "function") {
    try {
      const details = await window.getScreenDetails();
      const secondary = details.screens.find((screen) => !screen.isPrimary);
      if (secondary) {
        features.push(`left=${Math.round(secondary.availLeft)}`);
        features.push(`top=${Math.round(secondary.availTop)}`);
        features.push(`width=${Math.round(secondary.availWidth)}`);
        features.push(`height=${Math.round(secondary.availHeight)}`);
      } else {
        addLog("No secondary screen detected. Opening coffee screen on the current display.", "info");
      }
    } catch {
      addLog("Secondary screen access was not granted. Opening coffee screen on the current display.", "info");
    }
  }

  const popup = window.open(url.toString(), "dobot-coffee-screen", features.join(","));
  if (!popup) {
    throw new Error("Coffee window was blocked by the browser");
  }
  popup.focus();
}

function openCoffeeOrdersWindow() {
  const popup = window.open("/coffee_orders.html", "dobot-coffee-orders", "width=980,height=720,scrollbars=yes,resizable=yes");
  if (!popup) {
    throw new Error("Coffee order list window was blocked by the browser");
  }
  popup.focus();
}

function buildDisplayedDevices(snapshot) {
  const devices = [...(snapshot.discovered_devices || [])];
  if (!snapshot.connected) {
    return devices;
  }

  const liveDevice = {
    host: snapshot.config.host,
    dashboard_port: snapshot.config.dashboard_port,
    motion_port: snapshot.config.motion_port,
    feedback_port: snapshot.config.feedback_port,
    reachable: snapshot.connected,
    mode_name: snapshot.mode_name || "Unknown",
    pose: snapshot.pose,
  };

  const existingIndex = devices.findIndex((device) => device.host === liveDevice.host);
  if (existingIndex >= 0) {
    devices[existingIndex] = { ...devices[existingIndex], ...liveDevice };
  } else {
    devices.unshift(liveDevice);
  }
  return devices;
}

function setStatus(snapshot) {
  $("robot-host-chip").textContent = snapshot.config.host;
  $("mode-chip").textContent = snapshot.mode_name || "Unknown";
  $("drag-chip").textContent = snapshot.mode_name === "BACKDRIVE" ? "On" : "Off";
  $("connection-chip").textContent = snapshot.status === "connected"
    ? "Connected"
    : snapshot.status === "degraded"
      ? "Degraded"
      : "Disconnected";
  $("motion-chip").textContent = snapshot.motion_ready
    ? "Ready"
    : snapshot.connected
      ? "Blocked"
      : "Offline";

  const connDot = $("conn-dot");
  connDot.classList.remove("connected", "warn", "error");
  if (snapshot.status === "connected") {
    connDot.classList.add("connected");
  } else if (snapshot.status === "degraded") {
    connDot.classList.add("warn");
  } else if (snapshot.connect_error) {
    connDot.classList.add("error");
  }

  const liveDot = $("live-dot");
  liveDot.classList.remove("live", "warn", "error");
  if (snapshot.status === "connected") {
    liveDot.classList.add("live");
  } else if (snapshot.status === "degraded") {
    liveDot.classList.add("warn");
  } else if (snapshot.connect_error) {
    liveDot.classList.add("error");
  }

  if (!snapshot.connected) {
    $("visual-status").textContent = "Waiting for controller response";
  } else if (snapshot.mode_mismatch) {
    $("visual-status").textContent = "Controller reachable, but robot is not in TCP mode";
  } else if (!snapshot.dashboard_available && snapshot.feedback_available) {
    $("visual-status").textContent = "Feedback live. Dashboard actions are limited";
  } else if (snapshot.status === "degraded") {
    $("visual-status").textContent = "Controller connected, but live telemetry is incomplete";
  } else if (!snapshot.motion_ready) {
    $("visual-status").textContent = "Connected, but robot is not motion-ready";
  } else {
    $("visual-status").textContent = "Connected and motion-ready";
  }
}

function setConnectionNote(snapshot) {
  const note = $("connection-note");
  note.className = "connection-note";

  if (snapshot.mode_mismatch) {
    note.textContent = "Robot is reachable, but the controller is not in TCP/IP Secondary Development mode.";
    note.classList.add("warning");
    return;
  }

  if (snapshot.connected && !snapshot.dashboard_available && snapshot.feedback_available) {
    note.textContent = "Live feedback is active. Motion can still run, but dashboard actions may need a reconnect.";
    note.classList.add("warning");
    return;
  }

  if (snapshot.status === "degraded") {
    const failed = Object.entries(snapshot.live_checks || {})
      .filter(([, ok]) => !ok)
      .map(([name]) => name)
      .join(", ");
    note.textContent = `Controller session is degraded. Live checks failing: ${failed || "unknown"}.`;
    note.classList.add("warning");
    return;
  }

  if (snapshot.motion_ready) {
    note.textContent = `Connected to ${snapshot.config.host}. Sequence moves use Global Speed. Jog uses the local Speed and Acc fields.`;
    note.classList.add("connected");
    return;
  }

  if (snapshot.connected) {
    note.textContent = `Connected to ${snapshot.config.host}, but the robot is not ready for motion yet.`;
    return;
  }

  if (snapshot.connect_error) {
    note.textContent = `Connection failed: ${snapshot.connect_error}`;
    note.classList.add("error");
    return;
  }

  note.textContent = "No active controller connection.";
}

function syncButtons(snapshot) {
  const connected = Boolean(snapshot.connected);
  const dashboardAvailable = Boolean(snapshot.dashboard_available);
  const motionReady = Boolean(snapshot.motion_ready);
  const motionChannelAvailable = Boolean(snapshot.motion_channel_available);
  const enabled = connected && enabledModes.has(snapshot.mode_name || "");
  const dragActive = snapshot.mode_name === "BACKDRIVE";
  const sequence = snapshot.sequence || {};
  const hasLiveAngles = Boolean(snapshot.angle?.floats?.length === 6);
  const hasLivePose = Boolean(snapshot.pose?.floats?.length >= 6);
  const hasSelectedStep = Boolean(sequence.selected_step_id);
  const isSequenceRunning = Boolean(sequence.running);
  const hasSavedHomeTarget = Boolean(state.mainHomeTarget);
  const hasSequenceLockPose = Boolean(state.sequenceOrientationLock?.pose?.length >= 6);

  const enableButton = $("toggle-enable-button");
  enableButton.disabled = !connected || !dashboardAvailable;
  enableButton.dataset.action = enabled ? "disable" : "enable";
  enableButton.textContent = enabled ? "Disable Motion" : "Enable Motion";
  enableButton.classList.toggle("btn-enable", !enabled);
  enableButton.classList.toggle("btn-danger", enabled);

  const dragButton = $("drag-toggle-button");
  dragButton.disabled = !connected || !dashboardAvailable || isSequenceRunning;
  dragButton.dataset.action = dragActive ? "stop_drag" : "start_drag";
  dragButton.textContent = dragActive ? "Disable Drag" : "Enable Drag";

  $("connect-button").disabled = connected;
  $("disconnect-button").disabled = !connected;
  $("recover-button").disabled = !connected || !dashboardAvailable;
  $("power-button").disabled = !connected || !dashboardAvailable;
  $("clear-error-button").disabled = !connected || !dashboardAvailable;
  $("speed-factor-input").disabled = !connected || !dashboardAvailable;
  $("speed-factor-button").disabled = !connected || !dashboardAvailable;
  $("sequence-add-button").disabled = !connected || !hasLiveAngles || isSequenceRunning;
  $("sequence-replace-selected-button").disabled = !connected || !hasLiveAngles || !hasSelectedStep || isSequenceRunning;
  $("sequence-move-selected-button").disabled = !(motionReady && motionChannelAvailable) || !hasSelectedStep || isSequenceRunning;
  $("sequence-play-once-button").disabled = !(motionReady && motionChannelAvailable) || !(sequence.steps || []).length || isSequenceRunning;
  $("sequence-loop-button").disabled = !(motionReady && motionChannelAvailable) || !(sequence.steps || []).length || isSequenceRunning;
  $("sequence-stop-button").disabled = !isSequenceRunning;
  $("sequence-new-button").disabled = isSequenceRunning || !(sequence.steps || []).length;
  $("sequence-name-input").disabled = isSequenceRunning;
  $("sequence-lock-enabled-input").disabled = !hasSequenceLockPose || isSequenceRunning;
  $("sequence-lock-capture-button").disabled = !connected || !hasLivePose || isSequenceRunning;
  $("sequence-lock-clear-button").disabled = !hasSequenceLockPose || isSequenceRunning;
  $("sequence-lock-step-input").disabled = !(motionReady && motionChannelAvailable) || !hasSequenceLockPose || isSequenceRunning;
  $("sequence-lock-test-button").disabled = !(motionReady && motionChannelAvailable) || !hasSequenceLockPose || isSequenceRunning;
  $("home-position-set-button").disabled = !connected || !hasLiveAngles || isSequenceRunning;
  $("home-position-move-button").disabled = !(motionReady && motionChannelAvailable) || !hasSavedHomeTarget || isSequenceRunning;

  const axisConfig = getJogAxisConfig();
  axisConfig.forEach((config, index) => {
    const row = $(`joint-row-${index + 1}`);
    const input = $(`joint-value-${index + 1}`);
    if (!row || !input) {
      return;
    }
    const rowBusy = row.dataset.busy === "true";
    const rowEnabled = motionReady && motionChannelAvailable && !rowBusy && config.joggable;
    row.classList.toggle("passive", !config.joggable);
    input.disabled = !(motionReady && motionChannelAvailable) || rowBusy || !config.editable || isSequenceRunning;
    row.querySelectorAll(".jog-btn").forEach((node) => {
      node.disabled = !rowEnabled || isSequenceRunning;
    });
  });
}

function updateDiagnostics(snapshot) {
  const checks = snapshot.live_checks || {};
  $("diag-mode").textContent = checks.robot_mode
    ? (snapshot.dashboard_available ? "OK" : "Feedback")
    : "Fail";
  $("diag-pose").textContent = checks.pose ? "OK" : "Fail";
  $("diag-angle").textContent = checks.angle ? "OK" : "Fail";
  $("diag-error").textContent = snapshot.dashboard_available
    ? (checks.error ? "OK" : "Fail")
    : "Skip";
}

function setPoseValues(values) {
  const pose = values || [];
  $("pose-x").textContent = formatNumber(pose[0]);
  $("pose-y").textContent = formatNumber(pose[1]);
  $("pose-z").textContent = formatNumber(pose[2]);
  $("pose-rx").textContent = formatNumber(pose[3]);
  $("pose-ry").textContent = formatNumber(pose[4]);
  $("pose-rz").textContent = formatNumber(pose[5]);
}

function renderDeviceList(devices) {
  const container = $("device-list");
  if (!devices.length) {
    container.innerHTML = '<div class="device-empty">No devices found yet.</div>';
    return;
  }

  container.innerHTML = "";
  devices.forEach((device) => {
    const pose = device.pose?.floats || [];
    const modeLabel = device.mode_name === "NOT_TCP_MODE" ? "Wrong TCP Mode" : (device.mode_name || "Unknown");
    const canConnect = device.mode_name !== "NOT_TCP_MODE";
    const row = document.createElement("div");
    row.className = "device-row";
    row.innerHTML = `
      <div class="device-copy">
        <strong>${device.host}</strong>
        <span class="device-meta">${modeLabel} | ${device.dashboard_port}/${device.motion_port}</span>
        <span class="device-submeta">${pose.length >= 3
          ? `X ${formatNumber(pose[0], 1)}  Y ${formatNumber(pose[1], 1)}  Z ${formatNumber(pose[2], 1)}`
          : "Telemetry unavailable"}</span>
      </div>
      <button class="device-connect" type="button">${canConnect ? "Connect" : "Set TCP Mode"}</button>
    `;

    const button = row.querySelector("button");
    button.disabled = !canConnect;
    button.addEventListener("click", async () => {
      try {
        await connectRobot(device.host);
      } catch (error) {
        addLog(error.message, "error");
        await refreshState("connect-failed");
      }
    });

    container.appendChild(row);
  });
}

function updateJointRows(values, pose = state.snapshot?.pose?.floats || null) {
  const liveJoints = values || [];
  const livePose = pose || [];
  const lockPose = state.sequenceOrientationLock?.pose || [];
  const cartesianMode = isToolAngleLockActive();
  const axisConfig = getJogAxisConfig();

  $("joint-step-label").textContent = cartesianMode ? "Step (mm)" : "Step (deg)";
  $("joint-speed-label").textContent = cartesianMode ? "SpeedL" : "SpeedJ";
  $("joint-acc-label").textContent = cartesianMode ? "AccL" : "AccJ";

  if (cartesianMode) {
    $("joint-summary").textContent = `X ${formatNumber(livePose[0], 1)}   Y ${formatNumber(livePose[1], 1)}   Z ${formatNumber(livePose[2], 1)}   |   Lock ${formatCompactOrientation(lockPose)}`;
  } else {
    $("joint-summary").textContent = jointNames
      .map((name, index) => `${name} ${formatNumber(liveJoints[index], 2)}`)
      .join("   ");
  }

  axisConfig.forEach((config, index) => {
    const rowIndex = index + 1;
    const labelNode = $(`joint-axis-label-${rowIndex}`);
    const valueNode = $(`joint-value-${rowIndex}`);
    const rowNode = $(`joint-row-${rowIndex}`);
    if (!labelNode || !valueNode || !rowNode) {
      return;
    }

    labelNode.textContent = config.label;
    rowNode.classList.toggle("passive", !config.joggable);
    valueNode.readOnly = !config.editable;
    valueNode.setAttribute("aria-label", `${config.label} target value`);

    if (document.activeElement === valueNode) {
      return;
    }

    let sourceValues = liveJoints;
    if (config.valueSource === "pose") {
      sourceValues = livePose;
    } else if (config.valueSource === "lock") {
      sourceValues = lockPose;
    }
    valueNode.value = formatNumber(sourceValues[config.valueIndex], 3);
  });
}

function currentSequenceStepId() {
  return state.snapshot?.sequence?.selected_step_id || null;
}

function renderSequence(sequence) {
  const sequenceState = sequence || {
    steps: [],
    selected_step_id: null,
    active_step_id: null,
    running: false,
    loop: false,
    last_error: null,
  };

  const dot = $("sequence-dot");
  dot.classList.remove("live", "warn", "error");
  if (sequenceState.running) {
    dot.classList.add("live");
  } else if (sequenceState.last_error) {
    dot.classList.add("error");
  }

  const status = $("sequence-status");
  if (sequenceState.running) {
    status.textContent = sequenceState.loop ? "Loop running" : "Playing sequence";
  } else if (sequenceState.last_error) {
    status.textContent = `Stopped: ${sequenceState.last_error}`;
  } else {
    status.textContent = `${sequenceState.steps.length} step(s)`;
  }

  const list = $("sequence-list");
  const selectedStep = sequenceState.steps.find((step) => step.step_id === sequenceState.selected_step_id) || null;
  if (selectedStep && document.activeElement !== $("sequence-name-input")) {
    $("sequence-name-input").value = selectedStep.name;
  }
  if (!sequenceState.steps.length) {
    list.innerHTML = '<div class="sequence-empty">Jog the robot into position, then use Add Current Position to record a step.</div>';
    return;
  }

  list.innerHTML = "";
  sequenceState.steps.forEach((step, index) => {
    const row = document.createElement("div");
    const selected = step.step_id === sequenceState.selected_step_id;
    const active = step.step_id === sequenceState.active_step_id;
    row.className = `sequence-row${selected ? " selected" : ""}${active ? " active" : ""}`;
    row.innerHTML = `
      <div class="sequence-head">
        <div class="sequence-title">${index + 1}. ${step.name}</div>
        <div class="sequence-subtitle">Uses current Global Speed${step.dwell_ms ? ` | D ${step.dwell_ms}ms` : ""}</div>
      </div>
      <div class="sequence-detail">${step.joints.map((value, jointIndex) => `J${jointIndex + 1} ${formatNumber(value, 1)}`).join("   ")}</div>
      <div class="sequence-actions">
        <button class="btn" type="button" data-action="select">Select</button>
        <button class="btn" type="button" data-action="up">Up</button>
        <button class="btn" type="button" data-action="down">Down</button>
        <button class="btn btn-danger" type="button" data-action="delete">Delete</button>
      </div>
    `;

    row.querySelector('[data-action="select"]').addEventListener("click", async () => {
      try {
        await postSequenceAction("select", { step_id: step.step_id });
      } catch (error) {
        addLog(error.message, "error");
      }
    });
    row.querySelector('[data-action="up"]').addEventListener("click", async () => {
      try {
        await postSequenceAction("move", { step_id: step.step_id, direction: "up" });
      } catch (error) {
        addLog(error.message, "error");
      }
    });
    row.querySelector('[data-action="down"]').addEventListener("click", async () => {
      try {
        await postSequenceAction("move", { step_id: step.step_id, direction: "down" });
      } catch (error) {
        addLog(error.message, "error");
      }
    });
    row.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      try {
        await postSequenceAction("delete", { step_id: step.step_id });
      } catch (error) {
        addLog(error.message, "error");
      }
    });

    list.appendChild(row);
  });
}

function syncOscCSettingsFromControls() {
  if (!state.oscCSetup) {
    state.oscCSetup = loadOscCSetup();
  }
  state.oscCSetup.enabled = $("osc-c-enabled-input").checked;
  state.oscCSetup.mode = $("osc-c-mode-select").value === "live" ? "live" : "preview";
  state.oscCSetup.listenPort = Number($("osc-c-listen-port-input").value) || 9012;
  state.oscCSetup.allowedHost = $("osc-c-allowed-host-input").value.trim();
  state.oscCSetup.sendStatus = $("osc-c-send-status-input").checked;
  state.oscCSetup.statusHost = $("osc-c-status-host-input").value.trim() || "127.0.0.1";
  state.oscCSetup.statusPort = Number($("osc-c-status-port-input").value) || 9013;
  state.oscCSetup.statusAddress = $("osc-c-status-address-input").value.trim() || "/dobot/osc_c/status";
  state.oscCSetup.directRunAddress = $("osc-c-direct-run-input").value.trim() || "/dobot/run";
  state.oscCSetup.directLoopAddress = $("osc-c-direct-loop-input").value.trim() || "/dobot/loop";
  state.oscCSetup.directStopAddress = $("osc-c-direct-stop-input").value.trim() || "/dobot/stop";
  state.oscCSetup = normalizeOscCSetup(state.oscCSetup);
  saveOscCSetup();
}

function syncOscCSelectedSequenceFromControls() {
  const sequence = getOscCSelectedSequence();
  if (!sequence) {
    return;
  }
  sequence.name = $("osc-c-sequence-name-input").value.trim() || sequence.name;
  sequence.enabled = $("osc-c-sequence-enabled-input").checked;
  state.oscCSetup = normalizeOscCSetup(state.oscCSetup);
  saveOscCSetup();
}

function syncOscCSelectedRouteFromControls() {
  const route = getOscCSelectedRoute();
  if (!route) {
    return;
  }
  route.enabled = $("osc-c-route-enabled-input").checked;
  route.address = $("osc-c-route-address-input").value.trim() || route.address;
  route.argMatch = $("osc-c-route-arg-input").value.trim();
  route.action = $("osc-c-route-action-select").value;
  route.sequenceId = $("osc-c-route-sequence-select").value || state.oscCSetup.selectedSequenceId;
  route.onStartAddress = $("osc-c-route-start-address-input").value.trim();
  route.onStepAddress = $("osc-c-route-step-address-input").value.trim();
  route.onCompleteAddress = $("osc-c-route-complete-address-input").value.trim();
  route.onErrorAddress = $("osc-c-route-error-address-input").value.trim();
  state.oscCSetup = normalizeOscCSetup(state.oscCSetup);
  saveOscCSetup();
}

function parseOscCTestArgs() {
  const raw = $("osc-c-test-args-input").value.trim();
  if (!raw) {
    return [];
  }
  return raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function renderOscCSetup(snapshot = state.snapshot) {
  const remote = snapshot?.osc_c;
  if (remote?.setup && (!state.oscCSetup || !document.activeElement?.closest("#center-osc-c-view"))) {
    state.oscCSetup = normalizeOscCSetup(remote.setup);
    writeMappingCache(OSC_C_STORAGE_KEY, state.oscCSetup);
  }
  if (!state.oscCSetup) {
    state.oscCSetup = loadOscCSetup();
  }
  const setup = state.oscCSetup;
  const listener = remote?.listener || {};
  const runtime = remote?.runtime || {};
  const events = remote?.events || [];
  const selectedSequence = getOscCSelectedSequence();
  const selectedRoute = getOscCSelectedRoute();

  if (!$("osc-c-enabled-input")) {
    return;
  }

  $("osc-c-enabled-input").checked = Boolean(setup.enabled);
  $("osc-c-mode-select").value = setup.mode;
  $("osc-c-listen-port-input").value = String(setup.listenPort);
  $("osc-c-allowed-host-input").value = setup.allowedHost;
  $("osc-c-send-status-input").checked = Boolean(setup.sendStatus);
  $("osc-c-status-host-input").value = setup.statusHost;
  $("osc-c-status-port-input").value = String(setup.statusPort);
  $("osc-c-status-address-input").value = setup.statusAddress;
  $("osc-c-direct-run-input").value = setup.directRunAddress;
  $("osc-c-direct-loop-input").value = setup.directLoopAddress;
  $("osc-c-direct-stop-input").value = setup.directStopAddress;

  $("osc-c-listener-label").textContent = listener.listening
    ? `Listening ${listener.port}`
    : setup.enabled ? "Listener stopped" : "Disabled";
  $("osc-c-mode-label").textContent = setup.mode === "live" ? "Live Robot" : "Preview";
  $("osc-c-runtime-label").textContent = runtime.running
    ? `${runtime.loop ? "Looping" : "Running"} ${runtime.activeSequenceName || ""}`.trim()
    : runtime.lastError ? `Stopped: ${runtime.lastError}` : "Idle";

  const sequenceList = $("osc-c-sequence-list");
  sequenceList.innerHTML = "";
  setup.sequences.forEach((sequence) => {
    const row = document.createElement("div");
    const active = runtime.activeSequenceId === sequence.id;
    row.className = `osc-c-row${sequence.id === setup.selectedSequenceId ? " selected" : ""}${active ? " active" : ""}`;
    row.innerHTML = `
      <div>
        <strong>${htmlText(sequence.name)}</strong>
        <span>${sequence.steps.length} step(s) · ${sequence.enabled ? "On" : "Off"}</span>
      </div>
      <button class="btn btn-sm" type="button">Select</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      setup.selectedSequenceId = sequence.id;
      saveOscCSetup();
      renderOscCSetup(snapshot);
    });
    sequenceList.appendChild(row);
  });

  const routeList = $("osc-c-route-list");
  routeList.innerHTML = "";
  setup.routes.forEach((route) => {
    const sequence = setup.sequences.find((candidate) => candidate.id === route.sequenceId);
    const row = document.createElement("div");
    row.className = `osc-c-row${route.id === setup.selectedRouteId ? " selected" : ""}${route.enabled ? "" : " muted"}`;
    row.innerHTML = `
      <div>
        <strong>${htmlText(route.address)}</strong>
        <span>${route.action} · ${htmlText(sequence?.name || "No sequence")}${route.argMatch ? ` · arg ${htmlText(route.argMatch)}` : ""}</span>
      </div>
      <button class="btn btn-sm" type="button">Select</button>
    `;
    row.querySelector("button").addEventListener("click", () => {
      setup.selectedRouteId = route.id;
      saveOscCSetup();
      renderOscCSetup(snapshot);
    });
    routeList.appendChild(row);
  });

  const sequenceOptions = setup.sequences
    .map((sequence) => `<option value="${htmlText(sequence.id)}">${htmlText(sequence.name)}</option>`)
    .join("");
  $("osc-c-route-sequence-select").innerHTML = sequenceOptions;
  if (selectedRoute) {
    $("osc-c-route-enabled-input").checked = Boolean(selectedRoute.enabled);
    $("osc-c-route-address-input").value = selectedRoute.address;
    $("osc-c-route-arg-input").value = selectedRoute.argMatch;
    $("osc-c-route-action-select").value = selectedRoute.action;
    $("osc-c-route-sequence-select").value = selectedRoute.sequenceId;
    $("osc-c-route-start-address-input").value = selectedRoute.onStartAddress || "";
    $("osc-c-route-step-address-input").value = selectedRoute.onStepAddress || "";
    $("osc-c-route-complete-address-input").value = selectedRoute.onCompleteAddress || "";
    $("osc-c-route-error-address-input").value = selectedRoute.onErrorAddress || "";
  }

  if (selectedSequence) {
    $("osc-c-selected-title").textContent = selectedSequence.name;
    $("osc-c-sequence-name-input").value = selectedSequence.name;
    $("osc-c-sequence-enabled-input").checked = Boolean(selectedSequence.enabled);
    $("osc-c-step-count-label").textContent = `${selectedSequence.steps.length} step(s)`;
  }

  const stepList = $("osc-c-step-list");
  stepList.innerHTML = "";
  if (!selectedSequence || !selectedSequence.steps.length) {
    stepList.innerHTML = '<div class="ttt-routine-empty">Add preview steps now, or capture live positions when DOBOT is connected.</div>';
  } else {
    selectedSequence.steps.forEach((step, index) => {
      const row = document.createElement("div");
      const selected = selectedSequence.selectedStepId === step.stepId;
      const active = runtime.activeStepId === step.stepId && runtime.activeSequenceId === selectedSequence.id;
      row.className = `osc-c-step-row${selected ? " selected" : ""}${active ? " active" : ""}`;
      const detail = step.joints
        ? step.joints.map((value, jointIndex) => `J${jointIndex + 1} ${formatNumber(value, 1)}`).join("   ")
        : "Preview only";
      row.innerHTML = `
        <div class="ttt-routine-head">
          <div class="ttt-routine-title">${index + 1}. ${htmlText(step.name)}</div>
          <div class="ttt-target-status">${step.joints ? "Recorded" : "Preview"}</div>
        </div>
        <div class="ttt-routine-detail">${htmlText(detail)}${step.dwellMs ? ` · D ${step.dwellMs}ms` : ""}</div>
        <div class="ttt-routine-actions">
          <button class="btn" type="button" data-action="select">Select</button>
          <button class="btn" type="button" data-action="up">Up</button>
          <button class="btn" type="button" data-action="down">Down</button>
          <button class="btn" type="button" data-action="delete">Delete</button>
        </div>
      `;
      row.querySelector('[data-action="select"]').addEventListener("click", () => {
        selectedSequence.selectedStepId = step.stepId;
        saveOscCSetup();
        renderOscCSetup(snapshot);
      });
      row.querySelector('[data-action="up"]').addEventListener("click", () => {
        if (index > 0) {
          [selectedSequence.steps[index - 1], selectedSequence.steps[index]] = [selectedSequence.steps[index], selectedSequence.steps[index - 1]];
          saveOscCSetup();
          renderOscCSetup(snapshot);
        }
      });
      row.querySelector('[data-action="down"]').addEventListener("click", () => {
        if (index < selectedSequence.steps.length - 1) {
          [selectedSequence.steps[index + 1], selectedSequence.steps[index]] = [selectedSequence.steps[index], selectedSequence.steps[index + 1]];
          saveOscCSetup();
          renderOscCSetup(snapshot);
        }
      });
      row.querySelector('[data-action="delete"]').addEventListener("click", () => {
        selectedSequence.steps = selectedSequence.steps.filter((candidate) => candidate.stepId !== step.stepId);
        selectedSequence.selectedStepId = selectedSequence.steps[0]?.stepId ?? null;
        saveOscCSetup();
        renderOscCSetup(snapshot);
      });
      stepList.appendChild(row);
    });
  }

  const hasLiveCapture = hasLiveTicTacToeCaptureSource(snapshot);
  $("osc-c-capture-step-button").disabled = !hasLiveCapture;
  $("osc-c-replace-step-button").disabled = !hasLiveCapture || !selectedSequence?.selectedStepId;
  $("osc-c-run-button").disabled = !selectedSequence || !selectedSequence.steps.length || Boolean(runtime.running);
  $("osc-c-loop-button").disabled = !selectedSequence || !selectedSequence.steps.length || Boolean(runtime.running);
  $("osc-c-stop-button").disabled = !Boolean(runtime.running);
  $("osc-c-delete-sequence-button").disabled = setup.sequences.length <= 1;
  $("osc-c-delete-route-button").disabled = setup.routes.length <= 1;

  const eventList = $("osc-c-event-list");
  eventList.innerHTML = "";
  if (!events.length) {
    eventList.innerHTML = '<div class="ttt-routine-empty">No OSC_C events yet.</div>';
  } else {
    events.slice(0, 20).forEach((event) => {
      const row = document.createElement("div");
      row.className = `osc-c-event ${event.kind === "error" ? "error" : ""}`;
      const time = event.time ? new Date(event.time * 1000).toLocaleTimeString() : "--";
      row.innerHTML = `<span>${htmlText(time)}</span><strong>${htmlText(event.kind)}</strong><em>${htmlText(event.message)}</em>`;
      eventList.appendChild(row);
    });
  }
}

function updateSnapshot(snapshot) {
  state.snapshot = snapshot;
  if (snapshot.speed_ratio && document.activeElement !== $("speed-factor-input")) {
    $("speed-factor-input").value = String(snapshot.speed_ratio);
  }
  state.appliedSpeedRatio = snapshot.speed_ratio ?? state.appliedSpeedRatio;
  syncJogSpeedInputs(snapshot.speed_ratio);
  updateSpeedLabel();
  setStatus(snapshot);
  setConnectionNote(snapshot);
  syncButtons(snapshot);
  updateDiagnostics(snapshot);
  renderDeviceList(buildDisplayedDevices(snapshot));

  const pose = snapshot.pose?.floats || null;
  const angles = snapshot.angle?.floats || null;
  setPoseValues(pose);
  updateJointRows(angles);
  renderSequence(snapshot.sequence);
  renderSequenceOrientationLock();
  renderMainHomeTarget();
  renderCoffeeSetup(snapshot);
  renderTicTacToeSetup(snapshot);
  renderThreeTttSetup();
  renderChessSetup(snapshot);
  renderOscCSetup(snapshot);
  renderRobot(angles, pose, snapshot.mode_name || "Unknown");
}

async function refreshState(reason = "manual") {
  try {
    const payload = await api("/api/state");
    updateSnapshot(payload.state);
    if (reason !== "poll") {
      addLog(
        `State refreshed. Link=${payload.state.status} Mode=${payload.state.mode_name || "Unknown"} Motion=${payload.state.motion_ready ? "ready" : "blocked"}`,
        "info",
      );
    }
  } catch (error) {
    addLog(error.message, "error");
  }
}

async function saveConfig() {
  const config = readConfigForm();
  const payload = await api("/api/config", { method: "POST", body: config });
  $("robot-host-chip").textContent = payload.config.host;
  addLog(`Target set to ${payload.config.host}:${payload.config.dashboard_port}/${payload.config.motion_port}`, "info");
}

async function ensureSpeedApplied(force = false, announce = true) {
  const ratio = getSpeedRatio();
  if (!state.snapshot?.connected || !state.snapshot.dashboard_available) {
    state.appliedSpeedRatio = null;
    return false;
  }
  if (!force && state.appliedSpeedRatio === ratio) {
    return true;
  }
  if (state.speedApplyPromise) {
    await state.speedApplyPromise;
    if (!force && state.appliedSpeedRatio === getSpeedRatio()) {
      return true;
    }
    return ensureSpeedApplied(force, announce);
  }

  state.speedApplyPromise = (async () => {
    const payload = await api("/api/action", {
      method: "POST",
      body: { action: "speed_factor", ratio },
    });
    state.appliedSpeedRatio = ratio;
    if (announce) {
      addLog(`Speed applied -> ${payload.response.raw || `${ratio}%`}`, "success");
    }
    return true;
  })();

  try {
    return await state.speedApplyPromise;
  } finally {
    state.speedApplyPromise = null;
  }
}

function scheduleAutoApplySpeed() {
  if (state.speedAutoApplyTimer) {
    window.clearTimeout(state.speedAutoApplyTimer);
  }
  state.speedAutoApplyTimer = window.setTimeout(async () => {
    state.speedAutoApplyTimer = null;
    try {
      await ensureSpeedApplied(true, false);
    } catch (error) {
      addLog(error.message, "error");
    }
  }, 180);
}

async function searchDevices() {
  setBusy("search-button", true, "Searching...");
  $("search-status").textContent = "Scanning subnet...";
  try {
    const payload = await api("/api/search", { method: "POST", body: readConfigForm() });
    renderDeviceList(payload.devices || []);
    $("search-status").textContent = `${(payload.devices || []).length} device(s) on ${payload.searched_network}`;
    addLog(`Search complete. Found ${(payload.devices || []).length} candidate device(s).`, "success");
    await refreshState("search");
  } finally {
    setBusy("search-button", false, "Searching...");
  }
}

async function connectRobot(hostOverride = null) {
  setBusy("connect-button", true, "Connecting...");
  try {
    if (hostOverride) {
      $("host-input").value = hostOverride;
    }
    const payload = await api("/api/connect", { method: "POST", body: readConfigForm() });
    state.appliedSpeedRatio = null;
    updateSnapshot(payload.state);
    addLog(`Connected to ${payload.config.host}. Link=${payload.state.status}.`, "success");
    await refreshState("connect");
  } finally {
    setBusy("connect-button", false, "Connecting...");
  }
}

async function disconnectRobot() {
  const payload = await api("/api/disconnect", { method: "POST", body: {} });
  state.appliedSpeedRatio = null;
  if (payload.state) {
    updateSnapshot(payload.state);
  }
  addLog("Disconnected controller session.", "info");
}

async function recoverController() {
  setBusy("recover-button", true, "Recovering...");
  try {
    const payload = await api("/api/action", {
      method: "POST",
      body: { action: "recover" },
    });
    const steps = payload.response.steps || [];
    const summary = steps.map((step) => `${step.step}:${step.ok ? "ok" : "fail"}`).join(" ");
    addLog(`Recovery -> ${summary}`, payload.response.ok ? "success" : "error");
    if (payload.response.state) {
      updateSnapshot(payload.response.state);
    } else {
      await refreshState("recover");
    }
    state.appliedSpeedRatio = null;
  } finally {
    setBusy("recover-button", false, "Recovering...");
  }
}

async function sendAction(action, extra = {}) {
  const payload = await api("/api/action", {
    method: "POST",
    body: { action, ...extra },
  });
  addLog(`${action} -> ${payload.response.raw || "ok"}`, "success");
  if (action === "speed_factor") {
    state.appliedSpeedRatio = getSpeedRatio();
  }
  await delay(220);
  await refreshState(action);
}

async function postSequenceAction(action, extra = {}) {
  const payload = await api("/api/sequence", {
    method: "POST",
    body: { action, ...sequenceOrientationPayload(), ...extra },
  });
  if (state.snapshot) {
    state.snapshot.sequence = payload.sequence;
  }
  renderSequence(payload.sequence);
  syncButtons(state.snapshot || {
    connected: false,
    dashboard_available: false,
    motion_ready: false,
    motion_channel_available: false,
    mode_name: null,
    sequence: payload.sequence,
  });
  return payload.sequence;
}

function setJointRowBusy(joint, busy) {
  const row = $(`joint-row-${joint}`);
  if (!row) {
    return;
  }
  row.dataset.busy = busy ? "true" : "false";
  row.classList.toggle("busy", busy);
  syncButtons(state.snapshot || {
    connected: false,
    dashboard_available: false,
    motion_ready: false,
    motion_channel_available: false,
    mode_name: null,
  });
}

async function jogJoint(joint, direction, announce = true) {
  const delta = getJogStep() * direction;
  return jogJointByDelta(joint, delta, { announce, sync: true, refresh: true });
}

async function jogJointByDelta(
  joint,
  delta,
  { announce = true, sync = true, refresh = true, useBusy = true } = {},
) {
  const speedj = getJointSpeed();
  const accj = getJointAcc();
  if (!state.snapshot?.motion_ready || !Number.isFinite(delta) || Math.abs(delta) < 0.001) {
    return;
  }

  if (useBusy) {
    setJointRowBusy(joint, true);
  }
  try {
    await ensureSpeedApplied(false, false);
    const payload = await api("/api/jog-joint", {
      method: "POST",
      body: {
        joint,
        delta,
        speedj,
        accj,
        sync,
      },
    });
    if (announce) {
      addLog(`J${joint} ${delta > 0 ? "+" : ""}${delta.toFixed(3)} deg -> ${payload.response.raw || "ok"}`, "success");
    }
    if (refresh) {
      await refreshState(`jog-j${joint}`);
    }
  } finally {
    if (useBusy) {
      setJointRowBusy(joint, false);
    }
  }
}

async function executeJogStep(axis, direction, { announce = true } = {}) {
  if (isToolAngleLockActive()) {
    if (axis > 3) {
      return;
    }
    await jogCartesianLocked(axis, direction, announce);
    return;
  }
  await jogJoint(axis, direction, announce);
}

async function jogCartesianLocked(axis, direction, announce = true) {
  const delta = getJogStep() * direction;
  return jogCartesianLockedByDelta(axis, delta, { announce, sync: true, refresh: true });
}

async function jogCartesianLockedByDelta(
  axis,
  delta,
  { announce = true, sync = true, refresh = true, useBusy = true } = {},
) {
  const lockPose = state.sequenceOrientationLock?.pose;
  const livePose = state.snapshot?.pose?.floats;
  if (!livePose || livePose.length < 6) {
    throw new Error("Live pose is unavailable");
  }
  if (!lockPose || lockPose.length < 6) {
    throw new Error("Capture and enable tool angle lock first");
  }
  if (!Number.isFinite(delta) || Math.abs(delta) < 0.001) {
    return;
  }

  const targetPose = livePose.slice(0, 6).map((value) => Number(value));
  targetPose[axis - 1] += delta;
  targetPose[3] = Number(lockPose[3]);
  targetPose[4] = Number(lockPose[4]);
  targetPose[5] = Number(lockPose[5]);

  if (useBusy) {
    setJointRowBusy(axis, true);
  }
  try {
    await ensureSpeedApplied(false, false);
    const payload = await api("/api/movel", {
      method: "POST",
      body: poseBodyFromArray(targetPose, {
        speedl: getJointSpeed(),
        accl: getJointAcc(),
        sync,
      }),
    });
    const axisLabel = ["X", "Y", "Z"][axis - 1] || `A${axis}`;
    if (announce) {
      addLog(`${axisLabel} ${delta > 0 ? "+" : ""}${delta.toFixed(3)} mm -> ${payload.response.raw || "ok"}`, "success");
    }
    if (refresh) {
      await refreshState(`jog-cartesian-${axisLabel.toLowerCase()}`);
    }
  } finally {
    if (useBusy) {
      setJointRowBusy(axis, false);
    }
  }
}

async function moveJointAbsolute(joint, targetValue) {
  const liveAngles = state.snapshot?.angle?.floats;
  if (!liveAngles || liveAngles.length !== 6) {
    throw new Error("Live joint values are unavailable");
  }
  const target = Number(targetValue);
  if (!Number.isFinite(target)) {
    throw new Error("Enter a valid joint angle");
  }
  const joints = liveAngles.map((value) => Number(value));
  joints[joint - 1] = target;

  setJointRowBusy(joint, true);
  try {
    await ensureSpeedApplied(false, false);
    await api("/api/joint-movej", {
      method: "POST",
      body: {
        joints,
        speedj: getJointSpeed(),
        accj: getJointAcc(),
        sync: true,
      },
    });
    addLog(`Moved J${joint} to ${target.toFixed(3)} deg.`, "success");
    await refreshState(`joint-abs-j${joint}`);
  } finally {
    setJointRowBusy(joint, false);
  }
}

async function moveCartesianAbsolute(axis, targetValue) {
  const livePose = state.snapshot?.pose?.floats;
  const lockPose = state.sequenceOrientationLock?.pose;
  if (!livePose || livePose.length < 6) {
    throw new Error("Live pose is unavailable");
  }
  if (!lockPose || lockPose.length < 6) {
    throw new Error("Capture and enable tool angle lock first");
  }
  const target = Number(targetValue);
  if (!Number.isFinite(target)) {
    throw new Error("Enter a valid cartesian value");
  }

  const targetPose = livePose.slice(0, 6).map((value) => Number(value));
  targetPose[axis - 1] = target;
  targetPose[3] = Number(lockPose[3]);
  targetPose[4] = Number(lockPose[4]);
  targetPose[5] = Number(lockPose[5]);

  setJointRowBusy(axis, true);
  try {
    await ensureSpeedApplied(false, false);
    await api("/api/movel", {
      method: "POST",
      body: poseBodyFromArray(targetPose, {
        speedl: getJointSpeed(),
        accl: getJointAcc(),
        sync: true,
      }),
    });
    const axisLabel = ["X", "Y", "Z"][axis - 1] || `A${axis}`;
    addLog(`Moved ${axisLabel} to ${target.toFixed(3)} mm with tool lock.`, "success");
    await refreshState(`cartesian-abs-${axisLabel.toLowerCase()}`);
  } finally {
    setJointRowBusy(axis, false);
  }
}

function buildJointGrid() {
  const grid = $("joint-grid");
  grid.innerHTML = "";
  jointNames.forEach((name, index) => {
    const joint = index + 1;
    const row = document.createElement("div");
    row.className = "joint-row";
    row.id = `joint-row-${joint}`;
    row.dataset.busy = "false";
    row.innerHTML = `
      <div class="joint-label" id="joint-axis-label-${joint}">${name}</div>
      <input class="joint-input" id="joint-value-${joint}" type="number" step="0.1" inputmode="decimal" value="0.000" aria-label="${name} target angle">
      <div class="jog-btn-pair">
        <button class="jog-btn" type="button" data-joint="${joint}" data-direction="-1">-</button>
        <button class="jog-btn" type="button" data-joint="${joint}" data-direction="1">+</button>
      </div>
    `;

    row.querySelectorAll(".jog-btn").forEach((button) => {
      button.addEventListener("click", async (event) => {
        event.preventDefault();
        if (button.disabled) {
          return;
        }
        const direction = Number(button.dataset.direction);
        if (!Number.isFinite(direction)) {
          return;
        }
        if (isToolAngleLockActive() && joint > 3) {
          return;
        }
        try {
          await executeJogStep(joint, direction, { announce: true });
        } catch (error) {
          addLog(error.message, "error");
        }
      });
    });

    const input = row.querySelector(".joint-input");
    input.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") {
        return;
      }
      event.preventDefault();
      try {
        if (isToolAngleLockActive()) {
          if (joint > 3) {
            return;
          }
          await moveCartesianAbsolute(joint, input.value);
        } else {
          await moveJointAbsolute(joint, input.value);
        }
      } catch (error) {
        addLog(error.message, "error");
      }
    });

    grid.appendChild(row);
  });
  updateJointRows(state.snapshot?.angle?.floats || null, state.snapshot?.pose?.floats || null);
}

function buildGridLayer() {
  const grid = $("grid-layer");
  const lines = [];
  for (let i = 0; i <= 10; i += 1) {
    const y = 320 + i * 10;
    lines.push(`<line x1="140" y1="${y}" x2="620" y2="${y}" stroke="rgba(31, 96, 184, 0.12)" stroke-width="1"></line>`);
  }
  for (let i = 0; i <= 8; i += 1) {
    const x = 180 + i * 50;
    lines.push(`<line x1="${x}" y1="110" x2="${x}" y2="350" stroke="rgba(31, 96, 184, 0.06)" stroke-width="1"></line>`);
  }
  grid.innerHTML = lines.join("");
}

function degToRad(value) {
  return (value * Math.PI) / 180;
}

const ROBOT_LIVE_MODEL = {
  fallbackAngles: [0, -35, 70, 0, 35, 0],
  baseHeight: 118,
  shoulderOffset: 62,
  upperArm: 286,
  forearm: 316,
  wristRollOffset: 74,
  wristPitchOffset: 78,
  flangeOffset: 52,
  maxProjectionScale: 0.82,
  targetWidth: 560,
  targetHeight: 250,
  centerX: 380,
  centerY: 245,
  jointSigns: [1, -1, -1, 1, -1, 1],
};

let robotProjection = {
  scale: 0.5,
  offsetX: 334,
  offsetY: 340,
};

function add3(a, b) {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function scale3(a, scalar) {
  return [a[0] * scalar, a[1] * scalar, a[2] * scalar];
}

function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross3(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function normalize3(a) {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
}

function rotateVectorAroundAxis(vector, axis, angle) {
  const unit = normalize3(axis);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return add3(
    add3(scale3(vector, cos), scale3(cross3(unit, vector), sin)),
    scale3(unit, dot3(unit, vector) * (1 - cos)),
  );
}

function rotateBasisAroundLocalAxis(basis, axisKey, angle) {
  const axis = basis[axisKey];
  return {
    x: normalize3(rotateVectorAroundAxis(basis.x, axis, angle)),
    y: normalize3(rotateVectorAroundAxis(basis.y, axis, angle)),
    z: normalize3(rotateVectorAroundAxis(basis.z, axis, angle)),
  };
}

function makeYawBasis(angle) {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: [cos, sin, 0],
    y: [-sin, cos, 0],
    z: [0, 0, 1],
  };
}

function projectRaw([x, y, z]) {
  return [
    x - y * 0.48,
    -z + (x + y) * 0.08,
  ];
}

function configureRobotProjection(points) {
  const rawPoints = points.map(projectRaw);
  const xs = rawPoints.map((point) => point[0]);
  const ys = rawPoints.map((point) => point[1]);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const scale = Math.min(
    ROBOT_LIVE_MODEL.maxProjectionScale,
    ROBOT_LIVE_MODEL.targetWidth / width,
    ROBOT_LIVE_MODEL.targetHeight / height,
  );
  robotProjection = {
    scale,
    offsetX: ROBOT_LIVE_MODEL.centerX - ((minX + maxX) * scale) / 2,
    offsetY: ROBOT_LIVE_MODEL.centerY - ((minY + maxY) * scale) / 2,
  };
}

function project(point) {
  const raw = projectRaw(point);
  return [
    raw[0] * robotProjection.scale + robotProjection.offsetX,
    raw[1] * robotProjection.scale + robotProjection.offsetY,
  ];
}

function setLine(id, a, b) {
  const line = $(id);
  line.setAttribute("x1", a[0]);
  line.setAttribute("y1", a[1]);
  line.setAttribute("x2", b[0]);
  line.setAttribute("y2", b[1]);
}

function setCircle(id, point) {
  const node = $(id);
  node.setAttribute("cx", point[0]);
  node.setAttribute("cy", point[1]);
}

function screenAngleForVector(vector) {
  const origin = project([0, 0, 0]);
  const target = project(vector);
  return Math.atan2(target[1] - origin[1], target[0] - origin[0]) * 180 / Math.PI;
}

function renderAxisLine(center, direction, length, className = "") {
  const start = project(add3(center, scale3(direction, -length)));
  const end = project(add3(center, scale3(direction, length)));
  return `<line class="robot-axis-line ${className}" x1="${start[0]}" y1="${start[1]}" x2="${end[0]}" y2="${end[1]}"></line>`;
}

function renderAxisRing(center, basis, radius, className = "") {
  const screen = project(center);
  const angle = screenAngleForVector(basis.y);
  return `<ellipse class="robot-axis-ring ${className}" cx="${screen[0]}" cy="${screen[1]}" rx="${radius}" ry="${Math.max(5, radius * 0.38)}" transform="rotate(${angle} ${screen[0]} ${screen[1]})"></ellipse>`;
}

function renderJointBadge(label, point, offsetX, offsetY) {
  const screen = project(point);
  const x = screen[0] + offsetX;
  const y = screen[1] + offsetY;
  return `
    <rect class="joint-value-badge" x="${x - 24}" y="${y - 10}" width="48" height="20" rx="6"></rect>
    <text class="joint-value-text" x="${x}" y="${y}">${label}</text>
  `;
}

function liveJointAngles(angles) {
  const source = Array.isArray(angles) && angles.length >= 6 ? angles : ROBOT_LIVE_MODEL.fallbackAngles;
  return source.slice(0, 6).map((value, index) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : ROBOT_LIVE_MODEL.fallbackAngles[index];
  });
}

function renderRobot(angles, pose, modeName) {
  window.dobotRobotCad?.update(angles, pose, modeName);

  const a = liveJointAngles(angles);
  const [j1, j2, j3, j4, j5, j6] = a;
  const signedAngles = a.map((value, index) => degToRad(value * ROBOT_LIVE_MODEL.jointSigns[index]));

  const baseBottom = [0, 0, 0];
  const baseTop = [0, 0, ROBOT_LIVE_MODEL.baseHeight];
  let basis = makeYawBasis(signedAngles[0]);

  const shoulder = add3(baseTop, scale3(basis.x, ROBOT_LIVE_MODEL.shoulderOffset));
  basis = rotateBasisAroundLocalAxis(basis, "y", signedAngles[1]);
  const elbow = add3(shoulder, scale3(basis.x, ROBOT_LIVE_MODEL.upperArm));
  basis = rotateBasisAroundLocalAxis(basis, "y", signedAngles[2]);
  const wristRoll = add3(elbow, scale3(basis.x, ROBOT_LIVE_MODEL.forearm));

  basis = rotateBasisAroundLocalAxis(basis, "x", signedAngles[3]);
  const wristRollBasis = basis;
  const wristPitch = add3(wristRoll, scale3(basis.x, ROBOT_LIVE_MODEL.wristRollOffset));

  basis = rotateBasisAroundLocalAxis(basis, "y", signedAngles[4]);
  const flange = add3(wristPitch, scale3(basis.x, ROBOT_LIVE_MODEL.wristPitchOffset));

  basis = rotateBasisAroundLocalAxis(basis, "x", signedAngles[5]);
  const toolBasis = basis;
  const tcp = add3(flange, scale3(basis.x, ROBOT_LIVE_MODEL.flangeOffset));

  configureRobotProjection([baseBottom, baseTop, shoulder, elbow, wristRoll, wristPitch, flange, tcp]);

  const s0 = project(baseBottom);
  const s1 = project(baseTop);
  const s2 = project(shoulder);
  const s3 = project(elbow);
  const s4 = project(wristRoll);
  const s5 = project(wristPitch);
  const s6 = project(flange);
  const s7 = project(tcp);

  const left = `${s0[0] - 20},${s0[1]} ${s1[0] - 18},${s1[1]} ${s1[0] + 18},${s1[1]} ${s0[0] + 20},${s0[1]}`;
  $("base-column").setAttribute("d", `M ${left} Z`);
  setLine("link-1", s1, s2);
  setLine("link-2", s2, s3);
  setLine("link-3", s3, s4);
  setLine("link-4", s4, s5);
  setLine("tool-link", s5, s7);
  setCircle("joint-0", s1);
  setCircle("joint-1", s2);
  setCircle("joint-2", s3);
  setCircle("joint-3", s4);
  setCircle("joint-4", s5);
  setCircle("joint-5", s6);
  setCircle("joint-6", s7);
  setCircle("tool-point", s7);
  setCircle("tool-halo", s7);

  $("axis-layer").innerHTML = `
    ${renderAxisRing(wristRoll, wristRollBasis, 18)}
    ${renderAxisLine(wristRoll, wristRollBasis.y, 24)}
    ${renderAxisRing(tcp, toolBasis, 14, "tool-roll")}
    ${renderAxisLine(tcp, toolBasis.y, 18, "tool-roll")}
  `;

  $("joint-value-layer").innerHTML = `
    ${renderJointBadge(`J1 ${formatNumber(j1, 0)}`, baseTop, -36, -28)}
    ${renderJointBadge(`J2 ${formatNumber(j2, 0)}`, shoulder, 0, -30)}
    ${renderJointBadge(`J3 ${formatNumber(j3, 0)}`, elbow, 0, -30)}
    ${renderJointBadge(`J4 ${formatNumber(j4, 0)}`, wristRoll, 0, -28)}
    ${renderJointBadge(`J5 ${formatNumber(j5, 0)}`, wristPitch, 0, -26)}
    ${renderJointBadge(`J6 ${formatNumber(j6, 0)}`, tcp, 34, -20)}
  `;

  $("shadow-layer").innerHTML = `
    <ellipse cx="${s0[0]}" cy="${s0[1] + 28}" rx="94" ry="26" fill="rgba(18, 54, 112, 0.08)"></ellipse>
    <ellipse cx="${s7[0]}" cy="${s0[1] + 46}" rx="36" ry="11" fill="rgba(18, 54, 112, 0.06)"></ellipse>
  `;

  $("pose-label").textContent = pose
    ? `TCP  X ${formatNumber(pose[0])}   Y ${formatNumber(pose[1])}   Z ${formatNumber(pose[2])}`
    : "TCP pose unavailable";
  $("joint-label").textContent = `Mode ${modeName || "Unknown"}   J1 ${formatNumber(j1, 1)}   J2 ${formatNumber(j2, 1)}   J3 ${formatNumber(j3, 1)}`;
  $("joint-label-2").textContent = `J4 ${formatNumber(j4, 1)}   J5 ${formatNumber(j5, 1)}   J6 ${formatNumber(j6, 1)}`;
}

function attachEvents() {
  $("search-button").addEventListener("click", async () => {
    try {
      await saveConfig();
      await searchDevices();
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("connect-button").addEventListener("click", async () => {
    try {
      await saveConfig();
      await connectRobot();
    } catch (error) {
      addLog(error.message, "error");
      await refreshState("connect-failed");
    }
  });

  $("disconnect-button").addEventListener("click", async () => {
    try {
      await disconnectRobot();
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("recover-button").addEventListener("click", async () => {
    try {
      await recoverController();
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("refresh-button").addEventListener("click", async () => {
    await refreshState("manual");
  });

  $("theme-toggle-button").addEventListener("click", () => {
    setThemeMode(document.body.classList.contains("light-theme") ? "dark" : "light");
  });

  $("connection-collapse-button").addEventListener("click", () => {
    setConnectionCollapsed(true);
  });

  $("connection-drawer-tab").addEventListener("click", () => {
    setConnectionCollapsed(false);
  });

  $("games-button").addEventListener("click", () => {
    setCenterView(state.centerView === "dashboard" ? "games-menu" : "dashboard");
  });

  $("games-close-button").addEventListener("click", () => {
    setCenterView("dashboard");
  });

  $("game-coffee-button").addEventListener("click", () => {
    setCenterView("coffee");
  });

  $("coffee-back-button").addEventListener("click", () => {
    setCenterView("games-menu");
  });

  $("coffee-close-button").addEventListener("click", () => {
    setCenterView("dashboard");
  });

  $("coffee-display-select").addEventListener("change", () => {
    state.coffeeSetup.displayMode = $("coffee-display-select").value === "secondary" ? "secondary" : "current";
    saveCoffeeSetup();
    renderCoffeeSetup();
  });

  $("coffee-gripper-select").addEventListener("change", () => {
    state.coffeeSetup.gripperType = $("coffee-gripper-select").value;
    saveCoffeeSetup();
    renderCoffeeSetup();
  });

  $("coffee-launch-button").addEventListener("click", async () => {
    try {
      await launchCoffeeWindow();
      addLog("Opened the coffee customer screen.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("coffee-orders-button").addEventListener("click", () => {
    try {
      openCoffeeOrdersWindow();
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("coffee-save-setup-button").addEventListener("click", async () => {
    try {
      setBusy("coffee-save-setup-button", true, "Saving...");
      await saveCoffeeSetupFile();
    } catch (error) {
      addLog(error.message, "error");
    } finally {
      setBusy("coffee-save-setup-button", false, "Saving...");
    }
  });

  $("coffee-load-setup-button").addEventListener("click", async () => {
    try {
      setBusy("coffee-load-setup-button", true, "Loading...");
      await loadCoffeeSetupFile();
    } catch (error) {
      addLog(error.message, "error");
    } finally {
      setBusy("coffee-load-setup-button", false, "Loading...");
    }
  });

  $("coffee-reset-mapping-button").addEventListener("click", () => {
    state.coffeeSetup.targets = Object.fromEntries(COFFEE_TARGET_ORDER.map((slot) => [slot, null]));
    state.coffeeSetup.routines = Object.fromEntries(COFFEE_ROUTINE_KEYS.map((key) => [key, defaultTicTacToeRoutineState()]));
    saveCoffeeSetup();
    renderCoffeeSetup();
    addLog("Cleared all coffee anchors and sequences.", "info");
  });

  $("game-tictactoe-button").addEventListener("click", () => {
    setCenterView("tictactoe");
  });

  $("game-3ttt-button").addEventListener("click", () => {
    setCenterView("3ttt");
  });

  $("game-chess-button").addEventListener("click", () => {
    setCenterView("chess");
  });

  $("game-osc-c-button").addEventListener("click", () => {
    setCenterView("osc-c");
  });

  $("osc-c-back-button").addEventListener("click", () => {
    setCenterView("games-menu");
  });

  $("osc-c-close-button").addEventListener("click", () => {
    setCenterView("dashboard");
  });

  [
    "osc-c-enabled-input",
    "osc-c-mode-select",
    "osc-c-listen-port-input",
    "osc-c-allowed-host-input",
    "osc-c-send-status-input",
    "osc-c-status-host-input",
    "osc-c-status-port-input",
    "osc-c-status-address-input",
    "osc-c-direct-run-input",
    "osc-c-direct-loop-input",
    "osc-c-direct-stop-input",
  ].forEach((id) => {
    $(id).addEventListener("change", () => {
      syncOscCSettingsFromControls();
      renderOscCSetup(state.snapshot);
    });
  });

  $("osc-c-apply-button").addEventListener("click", async () => {
    try {
      syncOscCSettingsFromControls();
      await applyOscCSetup(true);
      await refreshState("osc-c-apply");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("osc-c-refresh-button").addEventListener("click", async () => {
    try {
      const payload = await api("/api/osc-c/state");
      if (state.snapshot) {
        state.snapshot.osc_c = payload.osc_c;
      }
      state.oscCSetup = normalizeOscCSetup(payload.osc_c.setup);
      renderOscCSetup(state.snapshot);
      addLog("OSC_C state refreshed.", "info");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("osc-c-add-sequence-button").addEventListener("click", () => {
    state.oscCSetup = normalizeOscCSetup(state.oscCSetup);
    const id = `seq_${state.oscCSetup.nextSequenceId}`;
    const name = $("osc-c-new-sequence-input").value.trim() || `Sequence ${state.oscCSetup.nextSequenceId}`;
    state.oscCSetup.nextSequenceId += 1;
    state.oscCSetup.sequences.push({
      id,
      name,
      enabled: true,
      selectedStepId: null,
      nextStepId: 1,
      steps: [],
    });
    state.oscCSetup.selectedSequenceId = id;
    $("osc-c-new-sequence-input").value = "";
    saveOscCSetup();
    renderOscCSetup(state.snapshot);
    addLog(`Added OSC_C sequence ${name}.`, "success");
  });

  $("osc-c-sequence-name-input").addEventListener("change", () => {
    syncOscCSelectedSequenceFromControls();
    renderOscCSetup(state.snapshot);
  });

  $("osc-c-sequence-enabled-input").addEventListener("change", () => {
    syncOscCSelectedSequenceFromControls();
    renderOscCSetup(state.snapshot);
  });

  $("osc-c-add-preview-step-button").addEventListener("click", () => {
    const sequence = getOscCSelectedSequence();
    if (!sequence) {
      return;
    }
    const step = {
      stepId: sequence.nextStepId,
      name: $("osc-c-step-name-input").value.trim() || `Step ${sequence.steps.length + 1}`,
      joints: null,
      pose: null,
      dwellMs: Math.max(0, Number($("osc-c-step-dwell-input").value) || 0),
      capturedAt: new Date().toISOString(),
    };
    sequence.steps.push(step);
    sequence.nextStepId += 1;
    sequence.selectedStepId = step.stepId;
    saveOscCSetup();
    renderOscCSetup(state.snapshot);
    addLog(`Added OSC_C test step ${step.name}.`, "success");
  });

  $("osc-c-capture-step-button").addEventListener("click", () => {
    try {
      const sequence = getOscCSelectedSequence();
      const capture = captureTicTacToeLiveTarget(state.snapshot);
      const step = {
        stepId: sequence.nextStepId,
        name: $("osc-c-step-name-input").value.trim() || `Step ${sequence.steps.length + 1}`,
        joints: capture.joints,
        pose: capture.pose,
        dwellMs: Math.max(0, Number($("osc-c-step-dwell-input").value) || 0),
        capturedAt: capture.capturedAt,
      };
      sequence.steps.push(step);
      sequence.nextStepId += 1;
      sequence.selectedStepId = step.stepId;
      saveOscCSetup();
      renderOscCSetup(state.snapshot);
      addLog(`Captured OSC_C step ${step.name}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("osc-c-replace-step-button").addEventListener("click", () => {
    try {
      const sequence = getOscCSelectedSequence();
      const selected = sequence?.steps.find((step) => step.stepId === sequence.selectedStepId);
      if (!selected) {
        throw new Error("Select a sequence step first");
      }
      const capture = captureTicTacToeLiveTarget(state.snapshot);
      selected.joints = capture.joints;
      selected.pose = capture.pose;
      selected.dwellMs = Math.max(0, Number($("osc-c-step-dwell-input").value) || 0);
      selected.capturedAt = capture.capturedAt;
      const nextName = $("osc-c-step-name-input").value.trim();
      if (nextName) {
        selected.name = nextName;
      }
      saveOscCSetup();
      renderOscCSetup(state.snapshot);
      addLog(`Replaced OSC_C step ${selected.name}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("osc-c-clear-steps-button").addEventListener("click", () => {
    const sequence = getOscCSelectedSequence();
    if (!sequence) {
      return;
    }
    sequence.steps = [];
    sequence.selectedStepId = null;
    sequence.nextStepId = 1;
    saveOscCSetup();
    renderOscCSetup(state.snapshot);
    addLog(`Cleared OSC_C sequence ${sequence.name}.`, "info");
  });

  $("osc-c-delete-sequence-button").addEventListener("click", () => {
    if (state.oscCSetup.sequences.length <= 1) {
      return;
    }
    const sequence = getOscCSelectedSequence();
    state.oscCSetup.sequences = state.oscCSetup.sequences.filter((candidate) => candidate.id !== sequence.id);
    state.oscCSetup.selectedSequenceId = state.oscCSetup.sequences[0]?.id ?? null;
    state.oscCSetup.routes.forEach((route) => {
      if (route.sequenceId === sequence.id) {
        route.sequenceId = state.oscCSetup.selectedSequenceId;
      }
    });
    saveOscCSetup();
    renderOscCSetup(state.snapshot);
    addLog(`Deleted OSC_C sequence ${sequence.name}.`, "info");
  });

  $("osc-c-add-route-button").addEventListener("click", () => {
    state.oscCSetup = normalizeOscCSetup(state.oscCSetup);
    const id = `route_${state.oscCSetup.nextRouteId}`;
    state.oscCSetup.nextRouteId += 1;
    state.oscCSetup.routes.push({
      id,
      enabled: true,
      address: $("osc-c-route-address-input").value.trim() || `/robot/sequence${state.oscCSetup.routes.length + 1}`,
      argMatch: $("osc-c-route-arg-input").value.trim(),
      action: $("osc-c-route-action-select").value,
      sequenceId: $("osc-c-route-sequence-select").value || state.oscCSetup.selectedSequenceId,
      onStartAddress: $("osc-c-route-start-address-input").value.trim(),
      onStepAddress: $("osc-c-route-step-address-input").value.trim(),
      onCompleteAddress: $("osc-c-route-complete-address-input").value.trim(),
      onErrorAddress: $("osc-c-route-error-address-input").value.trim(),
    });
    state.oscCSetup.selectedRouteId = id;
    saveOscCSetup();
    renderOscCSetup(state.snapshot);
    addLog("Added OSC_C route.", "success");
  });

  $("osc-c-save-route-button").addEventListener("click", () => {
    syncOscCSelectedRouteFromControls();
    renderOscCSetup(state.snapshot);
    addLog("Saved OSC_C route.", "success");
  });

  $("osc-c-delete-route-button").addEventListener("click", () => {
    if (state.oscCSetup.routes.length <= 1) {
      return;
    }
    const route = getOscCSelectedRoute();
    state.oscCSetup.routes = state.oscCSetup.routes.filter((candidate) => candidate.id !== route.id);
    state.oscCSetup.selectedRouteId = state.oscCSetup.routes[0]?.id ?? null;
    saveOscCSetup();
    renderOscCSetup(state.snapshot);
    addLog(`Deleted OSC_C route ${route.address}.`, "info");
  });

  $("osc-c-send-test-button").addEventListener("click", async () => {
    try {
      syncOscCSettingsFromControls();
      syncOscCSelectedRouteFromControls();
      await applyOscCSetup(false);
      const payload = await api("/api/osc-c/test", {
        method: "POST",
        body: {
          address: $("osc-c-test-address-input").value.trim() || getOscCSelectedRoute()?.address || "/robot/sequence1",
          args: parseOscCTestArgs(),
        },
      });
      if (state.snapshot) {
        state.snapshot.osc_c = payload.osc_c;
      }
      renderOscCSetup(state.snapshot);
      addLog(`Sent OSC_C test ${payload.address}.`, "success");
      await delay(350);
      await refreshState("osc-c-test");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("osc-c-run-button").addEventListener("click", async () => {
    try {
      syncOscCSelectedSequenceFromControls();
      await applyOscCSetup(false);
      const payload = await api("/api/osc-c/action", {
        method: "POST",
        body: { action: "run_once", sequenceId: state.oscCSetup.selectedSequenceId },
      });
      if (state.snapshot) {
        state.snapshot.osc_c = payload.osc_c;
      }
      renderOscCSetup(state.snapshot);
      addLog("OSC_C manual run started.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("osc-c-loop-button").addEventListener("click", async () => {
    try {
      syncOscCSelectedSequenceFromControls();
      await applyOscCSetup(false);
      const payload = await api("/api/osc-c/action", {
        method: "POST",
        body: { action: "play_loop", sequenceId: state.oscCSetup.selectedSequenceId },
      });
      if (state.snapshot) {
        state.snapshot.osc_c = payload.osc_c;
      }
      renderOscCSetup(state.snapshot);
      addLog("OSC_C manual loop started.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("osc-c-stop-button").addEventListener("click", async () => {
    try {
      const payload = await api("/api/osc-c/action", {
        method: "POST",
        body: { action: "stop" },
      });
      if (state.snapshot) {
        state.snapshot.osc_c = payload.osc_c;
      }
      renderOscCSetup(state.snapshot);
      addLog("OSC_C stop requested.", "info");
      await delay(250);
      await refreshState("osc-c-stop");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("tictactoe-back-button").addEventListener("click", () => {
    setCenterView("games-menu");
  });

  $("tictactoe-close-button").addEventListener("click", () => {
    setCenterView("dashboard");
  });

  $("three-ttt-back-button").addEventListener("click", () => {
    setCenterView("games-menu");
  });

  $("three-ttt-close-button").addEventListener("click", () => {
    setCenterView("dashboard");
  });

  $("chess-back-button").addEventListener("click", () => {
    setCenterView("games-menu");
  });

  $("chess-close-button").addEventListener("click", () => {
    setCenterView("dashboard");
  });

  [
    "chess-display-select",
    "chess-robot-mode-select",
    "chess-mapping-source-select",
    "chess-player-color-select",
    "chess-difficulty-select",
    "chess-dwell-input",
  ].forEach((id) => {
    $(id).addEventListener("change", syncChessSetupFromControls);
  });

  $("chess-launch-button").addEventListener("click", async () => {
    try {
      await launchChessWindow("play");
      addLog("Opened the Chess screen.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("chess-map-board-button").addEventListener("click", async () => {
    try {
      await launchChessWindow("mapping");
      addLog("Opened Chess board in mapping mode.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("chess-generate-calibration-button").addEventListener("click", () => {
    try {
      generateChessCalibrationMapping();
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("chess-auto-record-button").addEventListener("click", async () => {
    try {
      await runChessAutoRecord();
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("chess-auto-record-stop-button").addEventListener("click", () => {
    state.chessCalibrationCancel = true;
    state.chessCalibrationStatus = "Stopping after current move";
    renderChessCalibrationPanel(state.snapshot);
  });

  $("chess-save-setup-button").addEventListener("click", async () => {
    try {
      setBusy("chess-save-setup-button", true, "Saving...");
      await saveChessSetupFile();
    } catch (error) {
      addLog(error.message, "error");
    } finally {
      setBusy("chess-save-setup-button", false, "Saving...");
    }
  });

  $("chess-load-setup-button").addEventListener("click", async () => {
    try {
      setBusy("chess-load-setup-button", true, "Loading...");
      await loadChessSetupFile();
    } catch (error) {
      addLog(error.message, "error");
    } finally {
      setBusy("chess-load-setup-button", false, "Loading...");
    }
  });

  $("chess-reset-mapping-button").addEventListener("click", () => {
    const sourceKey = getChessSourceKey();
    state.chessSetup[sourceKey] = Object.fromEntries(CHESS_TARGET_ORDER.map((slot) => [slot, null]));
    syncChessActiveTargets(state.chessSetup);
    saveChessSetup();
    renderChessSetup();
    addLog(`Cleared all ${state.chessSetup.mappingSource} chess mappings.`, "info");
  });

  [
    "three-ttt-display-select",
    "three-ttt-board-count-select",
    "three-ttt-launch-board-select",
    "three-ttt-priority-select",
    "three-ttt-robot-mode-select",
    "three-ttt-osc-host-input",
    "three-ttt-osc-send-port-input",
    "three-ttt-osc-listen-port-input",
    "three-ttt-osc-goto-address-input",
    "three-ttt-osc-reached-address-input",
  ].forEach((id) => {
    $(id).addEventListener("change", syncThreeTttSetupFromControls);
  });

  $("three-ttt-map-board-select").addEventListener("change", () => {
    state.threeTttSetup.selectedBoardId = $("three-ttt-map-board-select").value;
    saveThreeTttSetup();
    renderThreeTttSetup();
  });

  $("three-ttt-board-label-input").addEventListener("change", syncThreeTttSetupFromControls);
  $("three-ttt-board-osc-name-input").addEventListener("change", syncThreeTttSetupFromControls);

  $("three-ttt-map-board-window-button").addEventListener("click", async () => {
    try {
      await launchThreeTttMappingWindow();
      addLog("Opened the selected 3TTT board in mapping mode.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("three-ttt-launch-button").addEventListener("click", async () => {
    try {
      await launchThreeTttWindow();
      addLog("Opened the selected 3TTT board screen.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("three-ttt-save-setup-button").addEventListener("click", async () => {
    try {
      setBusy("three-ttt-save-setup-button", true, "Saving...");
      await saveThreeTttSetupFile();
    } catch (error) {
      addLog(error.message, "error");
    } finally {
      setBusy("three-ttt-save-setup-button", false, "Saving...");
    }
  });

  $("three-ttt-load-setup-button").addEventListener("click", async () => {
    try {
      setBusy("three-ttt-load-setup-button", true, "Loading...");
      await loadThreeTttSetupFile();
    } catch (error) {
      addLog(error.message, "error");
    } finally {
      setBusy("three-ttt-load-setup-button", false, "Loading...");
    }
  });

  $("three-ttt-reset-mapping-button").addEventListener("click", () => {
    Object.values(state.threeTttSetup.boards || {}).forEach((board) => {
      board.targets = Object.fromEntries(TTT_TARGET_ORDER.map((slot) => [slot, null]));
    });
    saveThreeTttSetup();
    renderThreeTttSetup();
    addLog("Cleared all 3TTT board mappings.", "info");
  });

  $("three-ttt-servo-refresh-button").addEventListener("click", async () => {
    await refreshThreeTttServoStatus();
  });

  $("three-ttt-servo-stop-button").addEventListener("click", async () => {
    await runThreeTttServoControl("/api/servo/stop", "three-ttt-servo-stop-button", "Stopping", "Emergency stop sent.");
  });

  $("three-ttt-servo-disable-button").addEventListener("click", async () => {
    await runThreeTttServoControl("/api/servo/disable", "three-ttt-servo-disable-button", "Disabling", "Servo disabled.");
  });

  $("three-ttt-servo-reset-button").addEventListener("click", async () => {
    await runThreeTttServoControl("/api/servo/reset", "three-ttt-servo-reset-button", "Resetting", "Servo fault reset sent.");
  });

  $("three-ttt-servo-enable-button").addEventListener("click", async () => {
    await enableThreeTttServo();
  });

  $("three-ttt-servo-move-button").addEventListener("click", async () => {
    await moveThreeTttServoSelectedBoard();
  });

  $("ttt-display-select").addEventListener("change", () => {
    state.tictactoeSetup.displayMode = $("ttt-display-select").value === "secondary" ? "secondary" : "current";
    saveTicTacToeSetup();
    renderTicTacToeSetup();
  });

  $("ttt-routine-select").addEventListener("change", () => {
    state.tictactoeRoutineKey = TTT_ROUTINE_KEYS.includes($("ttt-routine-select").value)
      ? $("ttt-routine-select").value
      : "celebration";
    $("ttt-routine-step-name").value = "";
    renderTicTacToeSetup();
  });

  $("ttt-routine-step-name").addEventListener("input", () => {
    const routine = getActiveTicTacToeRoutineState();
    const selected = routine.steps.find((step) => step.stepId === routine.selectedStepId);
    const nextName = $("ttt-routine-step-name").value.trim();
    if (!selected || !nextName || selected.name === nextName) {
      return;
    }
    selected.name = nextName;
    saveTicTacToeSetup();

    const selectedRowTitle = $("ttt-routine-list")?.querySelector(".ttt-routine-row.selected .ttt-routine-title");
    const selectedIndex = routine.steps.findIndex((step) => step.stepId === selected.stepId);
    if (selectedRowTitle && selectedIndex >= 0) {
      selectedRowTitle.textContent = `${selectedIndex + 1}. ${selected.name}`;
    }
  });

  $("ttt-map-board-button").addEventListener("click", async () => {
    try {
      await launchTicTacToeWindow("mapping");
      addLog("Opened Tic-Tac-Toe board in mapping mode.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("ttt-launch-button").addEventListener("click", async () => {
    try {
      await launchTicTacToeWindow("play");
      addLog("Opened the Tic-Tac-Toe touch screen.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("ttt-save-setup-button").addEventListener("click", async () => {
    try {
      setBusy("ttt-save-setup-button", true, "Saving...");
      await saveTicTacToeSetupFile();
    } catch (error) {
      addLog(error.message, "error");
    } finally {
      setBusy("ttt-save-setup-button", false, "Saving...");
    }
  });

  $("ttt-load-setup-button").addEventListener("click", async () => {
    try {
      setBusy("ttt-load-setup-button", true, "Loading...");
      await loadTicTacToeSetupFile();
    } catch (error) {
      addLog(error.message, "error");
    } finally {
      setBusy("ttt-load-setup-button", false, "Loading...");
    }
  });

  $("ttt-reset-mapping-button").addEventListener("click", () => {
    state.tictactoeSetup.targets = Object.fromEntries(TTT_TARGET_ORDER.map((slot) => [slot, null]));
    saveTicTacToeSetup();
    renderTicTacToeSetup();
    addLog("Cleared all Tic-Tac-Toe board mappings.", "info");
  });

  $("ttt-routine-add-button").addEventListener("click", () => {
    try {
      const routine = getActiveTicTacToeRoutineState();
      const capture = captureTicTacToeLiveTarget();
      const step = {
        stepId: routine.nextStepId,
        name: $("ttt-routine-step-name").value.trim() || `${getTicTacToeRoutineLabel()} ${routine.steps.length + 1}`,
        joints: capture.joints,
        pose: capture.pose,
        dwellMs: 0,
        capturedAt: capture.capturedAt,
      };
      routine.steps.push(step);
      routine.nextStepId += 1;
      routine.selectedStepId = step.stepId;
      saveTicTacToeSetup();
      $("ttt-routine-step-name").value = "";
      renderTicTacToeRoutineList();
      addLog(`Recorded ${getTicTacToeRoutineLabel()} routine step ${step.name}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("ttt-routine-replace-selected-button").addEventListener("click", () => {
    try {
      const routine = getActiveTicTacToeRoutineState();
      const selected = routine.steps.find((step) => step.stepId === routine.selectedStepId);
      if (!selected) {
        throw new Error("Select a routine step first");
      }
      const capture = captureTicTacToeLiveTarget();
      selected.joints = capture.joints;
      selected.pose = capture.pose;
      selected.capturedAt = capture.capturedAt;
      const nextName = $("ttt-routine-step-name").value.trim();
      if (nextName) {
        selected.name = nextName;
      }
      saveTicTacToeSetup();
      renderTicTacToeRoutineList();
      addLog(`Replaced ${getTicTacToeRoutineLabel()} routine step ${selected.name}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("ttt-routine-move-selected-button").addEventListener("click", async () => {
    try {
      const routine = getActiveTicTacToeRoutineState();
      const selected = routine.steps.find((step) => step.stepId === routine.selectedStepId);
      if (!selected) {
        throw new Error("Select a routine step first");
      }
      await moveTicTacToeRoutineStep(selected);
      addLog(`Moved robot to ${getTicTacToeRoutineLabel()} step ${selected.name}.`, "success");
      await refreshState("ttt-routine-move");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("ttt-routine-play-button").addEventListener("click", async () => {
    try {
      await playActiveTicTacToeRoutine();
      addLog(`${getTicTacToeRoutineLabel()} routine played.`, "success");
      await refreshState("ttt-routine-play");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("ttt-routine-clear-button").addEventListener("click", () => {
    const routine = getActiveTicTacToeRoutineState();
    routine.steps = [];
    routine.selectedStepId = null;
    routine.nextStepId = 1;
    saveTicTacToeSetup();
    renderTicTacToeRoutineList();
    addLog(`Cleared ${getTicTacToeRoutineLabel()} routine.`, "info");
  });

  $("drag-toggle-button").addEventListener("click", async () => {
    try {
      const action = $("drag-toggle-button").dataset.action || "start_drag";
      await sendAction(action);
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("toggle-enable-button").addEventListener("click", async () => {
    try {
      const action = $("toggle-enable-button").dataset.action || "enable";
      await sendAction(action);
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("power-button").addEventListener("click", async () => {
    try {
      await sendAction("power_on");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("clear-error-button").addEventListener("click", async () => {
    try {
      await sendAction("clear_error");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("speed-factor-input").addEventListener("input", updateSpeedLabel);
  $("speed-factor-input").addEventListener("input", () => {
    syncJogSpeedInputs(getSpeedRatio());
    if (state.snapshot?.connected && state.snapshot?.dashboard_available) {
      scheduleAutoApplySpeed();
    }
  });
  $("joint-speed-input").addEventListener("input", () => {
    state.jogSpeedUserEdited = true;
  });
  $("joint-acc-input").addEventListener("input", () => {
    state.jogAccUserEdited = true;
  });
  $("speed-factor-button").addEventListener("click", async () => {
    try {
      await ensureSpeedApplied(true);
      await refreshState("speed");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("clear-log-button").addEventListener("click", clearLog);

  $("sequence-lock-enabled-input").addEventListener("change", () => {
    const hasPose = Boolean(state.sequenceOrientationLock?.pose?.length >= 6);
    state.sequenceOrientationLock.enabled = hasPose && $("sequence-lock-enabled-input").checked;
    saveSequenceOrientationLock();
    renderSequenceOrientationLock();
    syncButtons(state.snapshot || {
      connected: false,
      dashboard_available: false,
      motion_ready: false,
      motion_channel_available: false,
      mode_name: null,
      sequence: { steps: [], selected_step_id: null, running: false },
    });
  });

  $("sequence-lock-capture-button").addEventListener("click", () => {
    try {
      const pose = state.snapshot?.pose?.floats;
      if (!pose || pose.length < 6) {
        throw new Error("Live pose is unavailable");
      }
      state.sequenceOrientationLock = {
        enabled: true,
        pose: pose.slice(0, 6).map((value) => Number(value)),
      };
      saveSequenceOrientationLock();
      renderSequenceOrientationLock();
      syncButtons(state.snapshot || {
        connected: false,
        dashboard_available: false,
        motion_ready: false,
        motion_channel_available: false,
        mode_name: null,
        sequence: { steps: [], selected_step_id: null, running: false },
      });
      addLog(`Captured tool angle lock ${formatCompactOrientation(state.sequenceOrientationLock.pose)}.`, "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("sequence-lock-clear-button").addEventListener("click", () => {
    state.sequenceOrientationLock = defaultSequenceOrientationLock();
    saveSequenceOrientationLock();
    renderSequenceOrientationLock();
    syncButtons(state.snapshot || {
      connected: false,
      dashboard_available: false,
      motion_ready: false,
      motion_channel_available: false,
      mode_name: null,
      sequence: { steps: [], selected_step_id: null, running: false },
    });
    addLog("Cleared tool angle lock.", "info");
  });

  $("sequence-lock-test-button").addEventListener("click", async () => {
    try {
      const lock = state.sequenceOrientationLock;
      const livePose = state.snapshot?.pose?.floats;
      if (!lock?.pose || lock.pose.length < 6) {
        throw new Error("Capture a tool angle first");
      }
      if (!livePose || livePose.length < 6) {
        throw new Error("Live pose is unavailable");
      }
      const stepMm = getSequenceLockStepMm();
      await ensureSpeedApplied(true);
      await api("/api/movel", {
        method: "POST",
        body: poseBodyFromArray([
          Number(livePose[0]) + stepMm,
          Number(livePose[1]),
          Number(livePose[2]),
          Number(lock.pose[3]),
          Number(lock.pose[4]),
          Number(lock.pose[5]),
        ], {
          speedl: getSpeedRatio(),
          accl: getSpeedRatio(),
          sync: true,
        }),
      });
      addLog(`Tool lock test move: +X ${stepMm.toFixed(0)} mm.`, "success");
      await refreshState("sequence-lock-test");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("sequence-add-button").addEventListener("click", async () => {
    try {
      const name = $("sequence-name-input").value.trim();
      await postSequenceAction("add_current", {
        name,
        speedj: getSpeedRatio(),
        accj: getSpeedRatio(),
        dwell_ms: 0,
      });
      $("sequence-name-input").value = "";
      addLog("Recorded current position into sequence.", "success");
      await refreshState("sequence-add");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("sequence-replace-selected-button").addEventListener("click", async () => {
    try {
      const stepId = currentSequenceStepId();
      if (!stepId) {
        throw new Error("Select a sequence step first");
      }
      await postSequenceAction("replace_current", {
        step_id: stepId,
        name: $("sequence-name-input").value.trim(),
        speedj: getSpeedRatio(),
        accj: getSpeedRatio(),
        dwell_ms: 0,
      });
      addLog("Replaced selected sequence step with current position.", "success");
      await refreshState("sequence-replace");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("sequence-move-selected-button").addEventListener("click", async () => {
    try {
      const stepId = currentSequenceStepId();
      if (!stepId) {
        throw new Error("Select a sequence step first");
      }
      await ensureSpeedApplied(true);
      await postSequenceAction("move_selected", { step_id: stepId });
      addLog("Moved robot to selected sequence step.", "success");
      await refreshState("sequence-move-selected");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("home-position-set-button").addEventListener("click", async () => {
    try {
      state.mainHomeTarget = normalizeStandaloneTarget(captureTicTacToeLiveTarget(), "HOME");
      saveMainHomeTarget();
      renderMainHomeTarget();
      syncButtons(state.snapshot || {
        connected: false,
        dashboard_available: false,
        motion_ready: false,
        motion_channel_available: false,
        mode_name: null,
        sequence: { steps: [], selected_step_id: null, running: false },
      });
      addLog("Saved standalone home position.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("home-position-move-button").addEventListener("click", async () => {
    try {
      if (!state.mainHomeTarget) {
        throw new Error("Set a home position first");
      }
      await ensureSpeedApplied(true);
      const lock = state.sequenceOrientationLock;
      if (lock?.enabled && Array.isArray(lock.pose) && lock.pose.length >= 6) {
        if (!Array.isArray(state.mainHomeTarget.pose) || state.mainHomeTarget.pose.length < 3) {
          throw new Error("Saved home position has no pose data for tool angle lock");
        }
        await api("/api/movel", {
          method: "POST",
          body: poseBodyFromArray([
            Number(state.mainHomeTarget.pose[0]),
            Number(state.mainHomeTarget.pose[1]),
            Number(state.mainHomeTarget.pose[2]),
            Number(lock.pose[3]),
            Number(lock.pose[4]),
            Number(lock.pose[5]),
          ], {
            speedl: getSpeedRatio(),
            accl: getSpeedRatio(),
            sync: true,
          }),
        });
      } else {
        await api("/api/joint-movej", {
          method: "POST",
          body: {
            joints: state.mainHomeTarget.joints,
            speedj: getJointSpeed(),
            accj: getJointAcc(),
            sync: true,
          },
        });
      }
      addLog("Moved robot to saved home position.", "success");
      await refreshState("home-position-move");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("sequence-play-once-button").addEventListener("click", async () => {
    try {
      await ensureSpeedApplied(true);
      await postSequenceAction("play_once");
      addLog("Sequence playback started.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("sequence-loop-button").addEventListener("click", async () => {
    try {
      await ensureSpeedApplied(true);
      await postSequenceAction("play_loop");
      addLog("Sequence loop started.", "success");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("sequence-stop-button").addEventListener("click", async () => {
    try {
      await postSequenceAction("stop");
      addLog("Sequence stop requested.", "info");
      await refreshState("sequence-stop");
    } catch (error) {
      addLog(error.message, "error");
    }
  });

  $("sequence-new-button").addEventListener("click", async () => {
    try {
      await postSequenceAction("clear");
      addLog("Sequence cleared.", "info");
      await refreshState("sequence-clear");
    } catch (error) {
      addLog(error.message, "error");
    }
  });
}

function startPolling() {
  stopPolling();
  state.pollTimer = window.setInterval(() => {
    if (state.snapshot?.connected) {
      refreshState("poll");
    }
  }, 1800);
}

function stopPolling() {
  if (state.pollTimer) {
    window.clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

async function init() {
  setThemeMode(loadThemeMode());
  buildJointGrid();
  buildGridLayer();
  clearLog();
  state.mainHomeTarget = loadMainHomeTarget();
  state.sequenceOrientationLock = loadSequenceOrientationLock();
  state.coffeeSetup = loadCoffeeSetup();
  state.tictactoeSetup = loadTicTacToeSetup();
  state.threeTttSetup = loadThreeTttSetup();
  state.chessSetup = loadChessSetup();
  state.oscCSetup = loadOscCSetup();
  await hydrateSavedMappingsFromDisk();
  persistCurrentMappingsToDisk();
  setCenterView("dashboard");
  setConnectionCollapsed(loadConnectionCollapsed());
  updateSpeedLabel();
  updateSnapshot({
    connected: false,
    status: "disconnected",
    motion_ready: false,
    dashboard_available: false,
    feedback_available: false,
    motion_channel_available: false,
    mode_mismatch: false,
    live_checks: { robot_mode: false, pose: false, angle: false, error: false },
    config: readConfigForm(),
    speed_ratio: getSpeedRatio(),
    mode_name: "Unknown",
    pose: null,
    angle: null,
    discovered_devices: [],
    sequence: {
      steps: [],
      selected_step_id: null,
      active_step_id: null,
      running: false,
      loop: false,
      last_error: null,
    },
    osc_c: {
      setup: state.oscCSetup,
      runtime: { running: false, loop: false, mode: state.oscCSetup.mode },
      listener: { enabled: state.oscCSetup.enabled, listening: false, port: null },
      events: [],
    },
  });
  attachEvents();
  renderRobot(null, null, "Unknown");
  await refreshState("startup");
  startPolling();
}

window.addEventListener("DOMContentLoaded", init);
