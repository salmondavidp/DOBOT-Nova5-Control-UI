const COFFEE_STORAGE_KEY = "dobot-coffee-setup-v1";
const COFFEE_TARGET_ORDER = ["HOME", "STANDBY"];
const COFFEE_RECIPES = [
  { key: "hot_water", label: "Hot Water", routineKey: "hot_water", pourMs: 12000 },
  { key: "milk", label: "Milk", routineKey: "milk", pourMs: 14000 },
  { key: "espresso", label: "Espresso", routineKey: "espresso", pourMs: 18000 },
  { key: "cappuccino", label: "Cappuccino", routineKey: "cappuccino", pourMs: 24000 },
  { key: "latte", label: "Latte", routineKey: "latte", pourMs: 26000 },
];
const KEYBOARD_LAYOUT = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["Z", "X", "C", "V", "B", "N", "M"],
  ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"],
];

const state = {
  stage: "name",
  setup: null,
  customerName: "",
  selectedRecipeKey: null,
  lastOrder: null,
  activeOrderId: null,
  orderPollTimer: null,
  previewStage: null,
};

function $(id) {
  return document.getElementById(id);
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

async function loadSetupFromMappingFile() {
  try {
    const payload = await api("/api/game-mapping?game=coffee");
    if (!payload.exists || !payload.setup) {
      return;
    }
    window.localStorage.setItem(COFFEE_STORAGE_KEY, JSON.stringify(payload.setup));
    state.setup = loadSetup();
  } catch (error) {
    console.warn("Could not load Coffee mapping file", error);
  }
}

function getPreviewStage() {
  const params = new URLSearchParams(window.location.search);
  const stage = params.get("stage");
  return ["name", "order", "preparing", "thanks"].includes(stage) ? stage : null;
}

function titleCase(value) {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getDrinkAccent(recipeKey) {
  switch (recipeKey) {
    case "hot_water":
      return { fill: "#f1b15a", foam: "#fff0cf", steam: "#c76b2f" };
    case "milk":
      return { fill: "#f6efe4", foam: "#fffaf3", steam: "#d8b58d" };
    case "espresso":
      return { fill: "#6a3a1e", foam: "#c58b54", steam: "#8f4b1d" };
    case "cappuccino":
      return { fill: "#b46b3b", foam: "#f5dfbf", steam: "#995425" };
    case "latte":
      return { fill: "#c48757", foam: "#f7ead6", steam: "#a36031" };
    default:
      return { fill: "#8d5328", foam: "#f6e5cd", steam: "#9b5d2d" };
  }
}

function getDrinkMood(recipeKey) {
  switch (recipeKey) {
    case "hot_water":
      return "Clean and warm";
    case "milk":
      return "Smooth and light";
    case "espresso":
      return "Bold and intense";
    case "cappuccino":
      return "Foamy and rich";
    case "latte":
      return "Soft and balanced";
    default:
      return "Freshly prepared";
  }
}

function getDrinkIllustration(recipeKey, label) {
  const accent = getDrinkAccent(recipeKey);
  return `
    <svg class="drink-illustration" viewBox="0 0 88 88" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="glassGlow-${recipeKey}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.92)"></stop>
          <stop offset="100%" stop-color="rgba(246,232,214,0.42)"></stop>
        </linearGradient>
      </defs>
      <circle cx="44" cy="44" r="39" fill="#fff8ee"></circle>
      <circle cx="44" cy="44" r="38" fill="none" stroke="rgba(164,81,26,0.12)" stroke-width="2"></circle>
      <ellipse cx="44" cy="61" rx="21" ry="5.5" fill="rgba(109,59,20,0.12)"></ellipse>
      <path d="M24 33h38v21c0 11-7.5 18-18 18h-2c-10.5 0-18-7-18-18z" fill="url(#glassGlow-${recipeKey})" fill-opacity="0.9" stroke="rgba(185,134,86,0.95)" stroke-width="2.2"></path>
      <path d="M62 38h4.5c5.2 0 9.5 4 9.5 9s-4.3 9-9.5 9H62" fill="none" stroke="rgba(185,134,86,0.95)" stroke-width="2.2" stroke-linecap="round"></path>
      <path d="M29 38h28v15c0 8.5-5.6 13.8-13.6 13.8h-.8c-8 0-13.6-5.3-13.6-13.8z" fill="${accent.fill}" fill-opacity="0.78"></path>
      <ellipse cx="43" cy="38" rx="14" ry="4.2" fill="${accent.fill}" fill-opacity="0.84"></ellipse>
      <path d="M31 33.8c5.6 1.8 17.5 1.8 23 0" fill="none" stroke="rgba(255,255,255,0.58)" stroke-width="1.4" stroke-linecap="round"></path>
      <path d="M31 35.8h4" fill="none" stroke="rgba(255,255,255,0.46)" stroke-width="1.6" stroke-linecap="round"></path>
      <path d="M30 43c1-6 1.4-8 3.5-8" fill="none" stroke="rgba(255,255,255,0.34)" stroke-width="1.6" stroke-linecap="round"></path>
    </svg>
  `;
}

function getPreparingDrinkIllustration(recipeKey) {
  const accent = getDrinkAccent(recipeKey);
  return `
    <svg class="preparing-illustration" viewBox="0 0 260 260" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="prepGlass-${recipeKey}" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="rgba(255,255,255,0.94)"></stop>
          <stop offset="100%" stop-color="rgba(246,232,214,0.35)"></stop>
        </linearGradient>
        <linearGradient id="prepDrink-${recipeKey}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="${accent.foam}"></stop>
          <stop offset="18%" stop-color="${accent.fill}"></stop>
          <stop offset="100%" stop-color="${accent.fill}"></stop>
        </linearGradient>
        <clipPath id="prepCupClip-${recipeKey}">
          <path d="M72 84h96v60c0 33-20 56-48 56s-48-23-48-56z"></path>
        </clipPath>
      </defs>
      <circle cx="130" cy="130" r="112" fill="rgba(255,248,238,0.9)"></circle>
      <circle cx="130" cy="130" r="110" fill="none" stroke="rgba(164,81,26,0.12)" stroke-width="3"></circle>
      <ellipse cx="126" cy="207" rx="58" ry="12" fill="rgba(109,59,20,0.11)"></ellipse>
      <path d="M72 84h96v60c0 33-20 56-48 56s-48-23-48-56z" fill="url(#prepGlass-${recipeKey})" stroke="rgba(185,134,86,0.95)" stroke-width="4"></path>
      <path d="M168 95h13c14 0 25 11 25 24 0 14-11 25-25 25h-13" fill="none" stroke="rgba(185,134,86,0.95)" stroke-width="4" stroke-linecap="round"></path>
      <g clip-path="url(#prepCupClip-${recipeKey})">
        <path fill="url(#prepDrink-${recipeKey})" d="M88 156h64v0c0 18-12 31-32 31s-32-13-32-31z">
          <animate attributeName="d" values="
            M88 156h64v0c0 18-12 31-32 31s-32-13-32-31z;
            M84 136h72v22c0 22-14 37-36 37s-36-15-36-37z;
            M81 121h78v34c0 25-16 41-39 41s-39-16-39-41z;
            M85 141h70v18c0 21-14 35-35 35s-35-14-35-35z;
            M88 156h64v0c0 18-12 31-32 31s-32-13-32-31z
          " dur="3.2s" repeatCount="indefinite"></animate>
        </path>
        <ellipse cx="120" cy="156" rx="32" ry="7.5" fill="${accent.foam}" opacity="0.92">
          <animate attributeName="cy" values="156;136;121;141;156" dur="3.2s" repeatCount="indefinite"></animate>
          <animate attributeName="rx" values="30;34;37;33;30" dur="3.2s" repeatCount="indefinite"></animate>
        </ellipse>
        <path d="M92 154c12 4 40 4 56 0" fill="none" stroke="rgba(255,255,255,0.5)" stroke-width="2.8" stroke-linecap="round">
          <animate attributeName="d" values="
            M92 154c12 4 40 4 56 0;
            M89 134c14 4 45 4 62 0;
            M86 119c15 4 49 4 68 0;
            M90 139c14 4 43 4 60 0;
            M92 154c12 4 40 4 56 0
          " dur="3.2s" repeatCount="indefinite"></animate>
        </path>
      </g>
      <path d="M85 83c12 3.4 52 3.4 82 0" fill="none" stroke="rgba(255,255,255,0.58)" stroke-width="2.6" stroke-linecap="round"></path>
    </svg>
  `;
}

function renderPreparingVisual(recipeKey) {
  $("preparing-drink-visual").innerHTML = getPreparingDrinkIllustration(recipeKey);
}

function loadSetup() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(COFFEE_STORAGE_KEY) || "{}");
    const targets = Object.fromEntries(
      COFFEE_TARGET_ORDER.map((slot) => {
        const target = raw.targets?.[slot];
        const joints = Array.isArray(target?.joints) && target.joints.length === 6
          ? target.joints.map((value) => Number(value))
          : null;
        const pose = Array.isArray(target?.pose) && target.pose.length >= 3
          ? target.pose.map((value) => Number(value))
          : null;
        return [
          slot,
          joints && joints.every((value) => Number.isFinite(value))
            ? {
              slot,
              joints,
              pose: pose && pose.every((value) => Number.isFinite(value)) ? pose : null,
              capturedAt: typeof target?.capturedAt === "string" ? target.capturedAt : null,
            }
            : null,
        ];
      }),
    );
    const recipes = COFFEE_RECIPES.map((recipe) => {
      const saved = raw.recipes?.[recipe.key];
      return {
        key: recipe.key,
        label: String(saved?.label || recipe.label),
        routineKey: String(saved?.routineKey || recipe.routineKey),
        pourMs: Math.max(1000, Number(saved?.pourMs ?? recipe.pourMs) || recipe.pourMs),
        enabled: saved?.enabled !== false,
      };
    }).filter((recipe) => recipe.enabled);
    return {
      gripperType: raw.gripperType || "two_finger",
      targets,
      routines: raw.routines && typeof raw.routines === "object" ? raw.routines : {},
      recipes: recipes.map((recipe) => ({
        key: String(recipe.key),
        label: String(recipe.label || titleCase(recipe.key)),
        routineKey: String(recipe.routineKey || recipe.key),
        pourMs: Math.max(1000, Number(recipe.pourMs) || 1000),
      })),
    };
  } catch {
    return {
      gripperType: "two_finger",
      targets: Object.fromEntries(COFFEE_TARGET_ORDER.map((slot) => [slot, null])),
      routines: {},
      recipes: COFFEE_RECIPES.map((recipe) => ({
        key: recipe.key,
        label: recipe.label,
        routineKey: recipe.routineKey,
        pourMs: recipe.pourMs,
      })),
    };
  }
}

function setStage(nextStage) {
  state.stage = nextStage;
  $("name-stage").classList.toggle("active", nextStage === "name");
  $("order-stage").classList.toggle("active", nextStage === "order");
  $("preparing-stage").classList.toggle("active", nextStage === "preparing");
  $("thanks-stage").classList.toggle("active", nextStage === "thanks");
}

function updateNameDisplay() {
  $("customer-name-display").textContent = state.customerName || "_";
  $("name-next-button").disabled = state.customerName.trim().length < 1;
}

function getSelectedRecipe() {
  return state.setup.recipes.find((recipe) => recipe.key === state.selectedRecipeKey) || null;
}

function renderOrderSummary() {
  const recipe = getSelectedRecipe();
  $("summary-name").textContent = state.customerName || "-";
  $("summary-drink").textContent = recipe?.label || "-";
  $("summary-gripper").textContent = titleCase(state.setup.gripperType);
  $("summary-copy").textContent = recipe
    ? "Your drink will be prepared and delivered by the robot."
    : "Select a drink to create the order.";
  $("place-order-button").disabled = !recipe;
}

function renderDrinkGrid() {
  const grid = $("drink-grid");
  grid.innerHTML = "";
  if (!state.setup.recipes.length) {
    grid.innerHTML = `<div class="empty-drinks">No drinks are enabled in the main Coffee Setup screen yet.</div>`;
    $("place-order-button").disabled = true;
    return;
  }

  state.setup.recipes.forEach((recipe) => {
    const card = document.createElement("button");
    card.className = `drink-card${recipe.key === state.selectedRecipeKey ? " active" : ""}`;
    card.type = "button";
    card.innerHTML = `
      <div class="drink-card-visual">
        ${getDrinkIllustration(recipe.key, recipe.label)}
      </div>
      <div class="drink-card-copy">
        <div class="drink-title">${recipe.label}</div>
        <div class="drink-note">${getDrinkMood(recipe.key)}</div>
      </div>
    `;
    card.addEventListener("click", () => {
      state.selectedRecipeKey = recipe.key;
      renderDrinkGrid();
      renderOrderSummary();
    });
    grid.appendChild(card);
  });
}

function updateOrderDisplays(order) {
  state.lastOrder = order;
  state.activeOrderId = order?.id || null;
  if (!order) {
    return;
  }
  renderPreparingVisual(order.recipeKey);
  $("prep-name").textContent = order.customerName;
  $("prep-drink").textContent = order.recipeLabel;
  $("prep-order").textContent = order.id;
  $("preparing-copy").textContent = order.message || `${order.recipeLabel} is being prepared.`;
  $("ticket-name").textContent = order.customerName;
  $("ticket-drink").textContent = order.recipeLabel;
  $("ticket-order").textContent = order.id;
  $("thanks-copy").textContent = order.status === "completed"
    ? (order.message || `${order.recipeLabel} is ready at the delivery point.`)
    : (order.message || `${order.recipeLabel} order is being tracked by the robot.`);
}

function stopOrderPolling() {
  if (state.orderPollTimer) {
    window.clearInterval(state.orderPollTimer);
    state.orderPollTimer = null;
  }
}

function applyLiveOrderState(order) {
  if (!order) {
    return;
  }
  updateOrderDisplays(order);
  if (order.status === "completed") {
    stopOrderPolling();
    setStage("thanks");
    return;
  }
  setStage("preparing");
  if (order.status === "failed") {
    stopOrderPolling();
  }
}

async function refreshOrderState() {
  if (!state.activeOrderId) {
    return;
  }
  try {
    const payload = await api(`/api/coffee/state?order_id=${encodeURIComponent(state.activeOrderId)}`);
    const order = payload.coffee?.requested_order;
    if (!order) {
      return;
    }
    applyLiveOrderState(order);
  } catch (error) {
    $("preparing-copy").textContent = error.message;
  }
}

function startOrderPolling() {
  stopOrderPolling();
  state.orderPollTimer = window.setInterval(() => {
    refreshOrderState();
  }, 1000);
}

function buildKeyboard() {
  const grid = $("keyboard-grid");
  grid.innerHTML = "";
  KEYBOARD_LAYOUT.forEach((row) => {
    const rowNode = document.createElement("div");
    rowNode.className = `keyboard-row${row.length <= 7 ? " compact" : ""}`;
    row.forEach((key) => {
      const button = document.createElement("button");
      button.className = "key-btn";
      button.type = "button";
      button.textContent = key;
      button.addEventListener("click", () => {
        if (state.customerName.length >= 18) {
          return;
        }
        state.customerName += key;
        updateNameDisplay();
      });
      rowNode.appendChild(button);
    });
    grid.appendChild(rowNode);
  });
}

async function placeOrder() {
  const recipe = getSelectedRecipe();
  if (!recipe) {
    return;
  }
  const order = {
    id: `COF-${Date.now().toString().slice(-6)}`,
    customerName: state.customerName.trim() || "Customer",
    recipeKey: recipe.key,
    recipeLabel: recipe.label,
    pourMs: recipe.pourMs,
    recipeRoutineKey: recipe.routineKey,
    gripperType: state.setup.gripperType,
    createdAt: new Date().toISOString(),
    targets: state.setup.targets,
    routines: state.setup.routines,
  };
  const button = $("place-order-button");
  button.disabled = true;
  try {
    const payload = await api("/api/coffee/order", {
      method: "POST",
      body: order,
    });
    applyLiveOrderState(payload.order);
    startOrderPolling();
    void refreshOrderState();
  } catch (error) {
    $("summary-copy").textContent = error.message;
    button.disabled = false;
  }
}

function startNewOrder() {
  stopOrderPolling();
  state.customerName = "";
  state.selectedRecipeKey = null;
  state.lastOrder = null;
  state.activeOrderId = null;
  updateNameDisplay();
  renderDrinkGrid();
  renderOrderSummary();
  setStage("name");
}

function reloadSetupFromStorage() {
  const activeRecipeKey = state.selectedRecipeKey;
  state.setup = loadSetup();
  if (activeRecipeKey && !state.setup.recipes.some((recipe) => recipe.key === activeRecipeKey)) {
    state.selectedRecipeKey = null;
  }
  renderDrinkGrid();
  renderOrderSummary();
}

function seedPreviewOrder() {
  const recipe = state.setup.recipes[0] || {
    key: "latte",
    label: "Latte",
    routineKey: "latte",
    pourMs: 26000,
  };
  state.customerName = "Customer";
  state.selectedRecipeKey = recipe.key;
  const order = {
    id: "COF-PREVIEW",
    customerName: state.customerName,
    recipeKey: recipe.key,
    recipeLabel: recipe.label,
    pourMs: recipe.pourMs,
    recipeRoutineKey: recipe.routineKey,
    gripperType: state.setup.gripperType,
    createdAt: new Date().toISOString(),
    status: "preview",
  };
  updateOrderDisplays({
    ...order,
    status: "running",
    phase: "waiting_for_pour",
    message: `${order.recipeLabel} is being prepared. The robot is handling the cup and will move it to the delivery point next.`,
  });
  $("summary-name").textContent = order.customerName;
  $("summary-drink").textContent = order.recipeLabel;
  $("summary-gripper").textContent = titleCase(state.setup.gripperType);
  $("summary-copy").textContent = "Your drink will be prepared and delivered by the robot.";
}

async function init() {
  state.setup = loadSetup();
  await loadSetupFromMappingFile();
  state.previewStage = getPreviewStage();
  buildKeyboard();
  updateNameDisplay();
  renderDrinkGrid();
  renderOrderSummary();
  if (state.previewStage) {
    seedPreviewOrder();
  }
  setStage(state.previewStage || "name");

  $("keyboard-backspace-button").addEventListener("click", () => {
    state.customerName = state.customerName.slice(0, -1);
    updateNameDisplay();
  });

  $("keyboard-space-button").addEventListener("click", () => {
    if (state.customerName.length >= 18) {
      return;
    }
    state.customerName += " ";
    updateNameDisplay();
  });

  $("name-next-button").addEventListener("click", () => {
    if (state.customerName.trim()) {
      setStage("order");
      renderOrderSummary();
    }
  });

  $("order-back-button").addEventListener("click", () => {
    setStage("name");
  });

  $("place-order-button").addEventListener("click", () => {
    void placeOrder();
  });

  $("new-order-button").addEventListener("click", startNewOrder);

  $("close-button").addEventListener("click", () => {
    window.close();
  });

  $("fullscreen-button").addEventListener("click", async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
      return;
    }
    await document.documentElement.requestFullscreen();
  });

  window.addEventListener("storage", (event) => {
    if (event.key === COFFEE_STORAGE_KEY && !state.activeOrderId) {
      reloadSetupFromStorage();
    }
  });
}

window.addEventListener("DOMContentLoaded", init);
