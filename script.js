const form = document.querySelector("#add-item-form");
const list = document.querySelector("#shopping-list");
const emptyState = document.querySelector("#empty-state");
const template = document.querySelector("#item-template");
const clearCheckedButton = document.querySelector("#clear-checked");
const clearAllButton = document.querySelector("#clear-all");
const syncStatus = document.querySelector("#sync-status");
const apiBaseMeta = document.querySelector('meta[name="api-base"]');
const API_BASE = (apiBaseMeta?.content || "").trim().replace(/\/+$/, "");
const ITEMS_STORAGE_KEY = "shopping-items-cache-v1";
const PENDING_OPS_STORAGE_KEY = "shopping-pending-ops-v1";
const LAST_SYNC_STORAGE_KEY = "shopping-last-sync-v1";

let items = loadItemsFromStorage();
let pendingOps = loadPendingOpsFromStorage();
let refreshTimerId = null;
let syncError = "";
let lastSyncedAt = loadLastSyncedAtFromStorage();
let syncInProgress = false;

bootstrap();
renderItems();
renderSyncStatus();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const name = String(formData.get("name") || "").trim();
  const quantity = String(formData.get("quantity") || "").trim();
  const addedBy = String(formData.get("addedBy") || "").trim();

  if (!name) {
    return;
  }

  const newItem = {
    id: createId(),
    name,
    quantity,
    addedBy,
    checked: false,
    createdAt: Date.now(),
  };

  items = [newItem, ...items];
  queueOperation({
    type: "add",
    item: {
      id: newItem.id,
      name: newItem.name,
      quantity: newItem.quantity,
      addedBy: newItem.addedBy,
    },
  });
  persistState();
  renderItems();
  renderSyncStatus();

  form.reset();
  document.querySelector("#item-name")?.focus();
  triggerSyncInBackground();
});

list.addEventListener("change", async (event) => {
  const checkbox = event.target;
  if (!(checkbox instanceof HTMLInputElement)) {
    return;
  }

  if (!checkbox.matches(".shopping-item__checkbox")) {
    return;
  }

  const itemElement = checkbox.closest(".shopping-item");
  if (!itemElement) {
    return;
  }

  const itemId = itemElement.dataset.itemId;
  items = items.map((item) => (item.id === itemId ? { ...item, checked: checkbox.checked } : item));
  queueOperation({ type: "setChecked", id: itemId, checked: checkbox.checked });
  persistState();
  renderItems();
  renderSyncStatus();
  triggerSyncInBackground();
});

list.addEventListener("click", async (event) => {
  const button = event.target;
  if (!(button instanceof HTMLButtonElement)) {
    return;
  }

  if (!button.matches(".shopping-item__delete")) {
    return;
  }

  const itemElement = button.closest(".shopping-item");
  if (!itemElement) {
    return;
  }

  const itemId = itemElement.dataset.itemId;
  items = items.filter((item) => item.id !== itemId);
  queueOperation({ type: "delete", id: itemId });
  persistState();
  renderItems();
  renderSyncStatus();
  triggerSyncInBackground();
});

clearCheckedButton.addEventListener("click", async () => {
  items = items.filter((item) => !item.checked);
  queueOperation({ type: "clearChecked" });
  persistState();
  renderItems();
  renderSyncStatus();
  triggerSyncInBackground();
});

clearAllButton.addEventListener("click", async () => {
  if (items.length === 0) {
    return;
  }

  const confirmed = window.confirm("Weet je zeker dat je het hele lijstje wilt leegmaken?");
  if (!confirmed) {
    return;
  }

  items = [];
  queueOperation({ type: "clearAll" });
  persistState();
  renderItems();
  renderSyncStatus();
  triggerSyncInBackground();
});

async function bootstrap() {
  if (window.location.protocol === "file:") {
    setSyncError(
      "Open de app via Netlify (of lokaal via `netlify dev`), niet direct als bestand."
    );
    return;
  }

  try {
    await refreshItems();
    startAutoRefresh();
  } catch (error) {
    setSyncError(error);
  }

  window.addEventListener("online", () => {
    syncError = "";
    renderSyncStatus();
    triggerSyncInBackground();
  });
  window.addEventListener("offline", () => {
    syncError = "";
    renderSyncStatus();
  });

  if ("serviceWorker" in navigator && window.location.protocol !== "file:") {
    navigator.serviceWorker.register("./sw.js").catch(() => {
      // Service worker is optional; app keeps working without it.
    });
  }
}

function startAutoRefresh() {
  if (refreshTimerId !== null) {
    return;
  }

  refreshTimerId = window.setInterval(async () => {
    try {
      await refreshItems();
    } catch (error) {
      setSyncError(error);
    }
  }, 3000);
}

async function refreshItems() {
  await flushPendingOps();
  const result = await request("/api/items");
  items = Array.isArray(result.items) ? result.items : [];
  syncError = "";
  lastSyncedAt = Date.now();
  persistState();
  renderItems();
  renderSyncStatus();
}

function renderItems() {
  list.innerHTML = "";

  const sortedItems = [...items].sort((a, b) => {
    if (a.checked !== b.checked) {
      return a.checked ? 1 : -1;
    }
    return b.createdAt - a.createdAt;
  });

  for (const item of sortedItems) {
    const node = createItemNode(item);
    list.append(node);
  }

  emptyState.hidden = items.length > 0;
}

function createItemNode(item) {
  const fragment = template.content.cloneNode(true);
  const itemElement = fragment.querySelector(".shopping-item");
  const checkbox = fragment.querySelector(".shopping-item__checkbox");
  const name = fragment.querySelector(".shopping-item__name");
  const meta = fragment.querySelector(".shopping-item__meta");

  itemElement.dataset.itemId = item.id;
  checkbox.checked = item.checked;
  name.textContent = item.name;
  meta.textContent = getMetaText(item);
  itemElement.classList.toggle("shopping-item--checked", item.checked);

  return fragment;
}

function getMetaText(item) {
  const details = [];
  if (item.quantity) {
    details.push(`Aantal: ${item.quantity}`);
  }
  if (item.addedBy) {
    details.push(`Toegevoegd door: ${item.addedBy}`);
  }

  return details.join(" • ") || "Geen extra details";
}

function renderSyncStatus() {
  if (syncError) {
    syncStatus.textContent = syncError;
    syncStatus.classList.add("sync-status--error");
    syncStatus.classList.remove("sync-status--warning");
    return;
  }

  const lastSyncText = lastSyncedAt
    ? `Laatst gesynchroniseerd om ${new Date(lastSyncedAt).toLocaleTimeString("nl-NL")}`
    : "Nog niet gesynchroniseerd";

  if (!navigator.onLine) {
    syncStatus.textContent = `Geen internetverbinding • Je werkt met lokaal opgeslagen gegevens (${lastSyncText}). Gegevens kunnen verouderd zijn.`;
    syncStatus.classList.add("sync-status--warning");
    syncStatus.classList.remove("sync-status--error");
    return;
  }

  if (pendingOps.length > 0) {
    syncStatus.textContent = `Verbinding actief • ${pendingOps.length} wijziging(en) wachten op synchronisatie (${lastSyncText}).`;
    syncStatus.classList.add("sync-status--warning");
    syncStatus.classList.remove("sync-status--error");
    return;
  }

  syncStatus.textContent = `Synchronisatie actief • ${lastSyncText}`;
  syncStatus.classList.remove("sync-status--error");
  syncStatus.classList.remove("sync-status--warning");
}

function setSyncError(error) {
  syncError = error instanceof Error ? error.message : "Synchroniseren mislukt";
  renderSyncStatus();
}

async function request(url, options = {}) {
  const targetUrl = `${API_BASE}${url}`;
  let response;
  try {
    response = await fetch(targetUrl, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error("Geen verbinding met de server.");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 404 && url.startsWith("/api/")) {
      throw new Error(
        "API endpoint niet gevonden. Op Netlify heb je een losse backend nodig en moet api-base daarnaar verwijzen."
      );
    }
    const message =
      payload && typeof payload.error === "string"
        ? payload.error
        : `Serverfout (${response.status})`;
    throw new Error(message);
  }

  return payload ?? {};
}

function queueOperation(operation) {
  pendingOps.push(operation);
}

async function triggerSyncInBackground() {
  if (!navigator.onLine) {
    return;
  }
  try {
    await refreshItems();
  } catch (error) {
    setSyncError(error);
  }
}

async function flushPendingOps() {
  if (!navigator.onLine || pendingOps.length === 0 || syncInProgress) {
    return;
  }

  syncInProgress = true;
  try {
    const remaining = [];
    for (let index = 0; index < pendingOps.length; index += 1) {
      const operation = pendingOps[index];
      try {
        await sendOperation(operation);
      } catch (error) {
        if (isNetworkError(error)) {
          remaining.push(operation, ...pendingOps.slice(index + 1));
          throw error;
        }
      }
    }
    pendingOps = remaining;
    persistState();
  } finally {
    syncInProgress = false;
  }
}

async function sendOperation(operation) {
  if (operation.type === "add") {
    await request("/api/items", {
      method: "POST",
      body: JSON.stringify(operation.item),
    });
    return;
  }
  if (operation.type === "setChecked") {
    await request(`/api/items/${operation.id}`, {
      method: "PATCH",
      body: JSON.stringify({ checked: operation.checked }),
    });
    return;
  }
  if (operation.type === "delete") {
    await request(`/api/items/${operation.id}`, { method: "DELETE" });
    return;
  }
  if (operation.type === "clearChecked") {
    await request("/api/items/checked", { method: "DELETE" });
    return;
  }
  if (operation.type === "clearAll") {
    await request("/api/items", { method: "DELETE" });
  }
}

function isNetworkError(error) {
  return error instanceof Error && error.message === "Geen verbinding met de server.";
}

function persistState() {
  localStorage.setItem(ITEMS_STORAGE_KEY, JSON.stringify(items));
  localStorage.setItem(PENDING_OPS_STORAGE_KEY, JSON.stringify(pendingOps));
  if (lastSyncedAt) {
    localStorage.setItem(LAST_SYNC_STORAGE_KEY, String(lastSyncedAt));
  }
}

function loadItemsFromStorage() {
  return parseStoredJson(ITEMS_STORAGE_KEY, []);
}

function loadPendingOpsFromStorage() {
  return parseStoredJson(PENDING_OPS_STORAGE_KEY, []);
}

function loadLastSyncedAtFromStorage() {
  const value = localStorage.getItem(LAST_SYNC_STORAGE_KEY);
  if (!value) {
    return null;
  }
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function parseStoredJson(key, fallback) {
  const raw = localStorage.getItem(key);
  if (!raw) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function createId() {
  if (window.crypto?.randomUUID) {
    return window.crypto.randomUUID();
  }
  return `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
