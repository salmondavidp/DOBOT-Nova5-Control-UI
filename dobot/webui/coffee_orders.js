const state = {
  orders: [],
};

function $(id) {
  return document.getElementById(id);
}

async function api(path) {
  const response = await fetch(path, { cache: "no-store" });
  const payload = await response.json();
  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function formatTiming(value) {
  if (!value) {
    return "-";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function renderOrders() {
  const body = $("orders-body");
  body.innerHTML = "";
  $("order-count").textContent = `${state.orders.length} order${state.orders.length === 1 ? "" : "s"}`;

  if (!state.orders.length) {
    body.innerHTML = `
      <tr>
        <td colspan="4" class="empty-cell">No coffee orders have been recorded yet.</td>
      </tr>
    `;
    return;
  }

  state.orders.forEach((order) => {
    const row = document.createElement("tr");
    const nameCell = document.createElement("td");
    const drinkCell = document.createElement("td");
    const timingCell = document.createElement("td");
    const statusCell = document.createElement("td");
    const status = document.createElement("span");

    nameCell.textContent = order.customerName || "-";
    drinkCell.textContent = order.drinkName || "-";
    timingCell.textContent = formatTiming(order.createdAt);
    status.className = "status-pill";
    status.textContent = order.status || "recorded";
    statusCell.appendChild(status);

    row.append(nameCell, drinkCell, timingCell, statusCell);
    body.appendChild(row);
  });
}

async function loadOrders() {
  $("orders-status").textContent = "Loading...";
  try {
    const payload = await api("/api/coffee/orders");
    state.orders = Array.isArray(payload.orders) ? payload.orders : [];
    renderOrders();
    $("orders-status").textContent = "Ready";
  } catch (error) {
    $("orders-status").textContent = error.message;
  }
}

function exportOrders() {
  window.location.href = "/api/coffee/orders/export";
}

function init() {
  $("refresh-button").addEventListener("click", () => {
    void loadOrders();
  });
  $("export-button").addEventListener("click", exportOrders);
  void loadOrders();
}

window.addEventListener("DOMContentLoaded", init);
