const form = document.querySelector("#add-item-form");
const familyForm = document.querySelector("#family-form");
const confirmPinField = document.querySelector("#confirm-pin-field");
const familySubmitButton = document.querySelector("#family-submit");
const list = document.querySelector("#shopping-list");
const emptyState = document.querySelector("#empty-state");
const template = document.querySelector("#item-template");
const clearCheckedButton = document.querySelector("#clear-checked");
const clearAllButton = document.querySelector("#clear-all");
const switchFamilyButton = document.querySelector("#switch-family");
const syncStatus = document.querySelector("#sync-status");
const authPanel = document.querySelector("#auth-panel");
const listPanel = document.querySelector("#list-panel");
const itemsPanel = document.querySelector("#items-panel");
const listTitle = document.querySelector("#list-title");
const apiBaseMeta = document.querySelector('meta[name="api-base"]');
const API_BASE = (apiBaseMeta?.content || "").trim().replace(/\/+$/, "");
const SESSION_STORAGE_KEY = "shopping-family-session-v1";

let session = loadSession();
let items = [];
let pendingOps = [];
let refreshTimerId = null;
let syncError = "";
let lastSyncedAt = null;
let syncInProgress = false;

bootstrap();
bindAuthModeUi();
stripSensitiveParamsFromUrl();

familyForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(familyForm);
  const authMode = String(formData.get("authMode") || "login");
  const familyName = String(formData.get("familyName") || "").trim();
  const pin = String(formData.get("pin") || "").trim();
  const pinConfirm = String(formData.get("pinConfirm") || "").trim();

  if (!familyName || !/^\d{4,8}$/.test(pin)) {
    setSyncError("Vul een gezinsnaam en pincode van 4-8 cijfers in.");
    return;
  }
  if (authMode === "register" && pin !== pinConfirm) {
    setSyncError("De herhaalde pincode komt niet overeen.");
    return;
  }

  try {
    const endpoint = authMode === "register" ? "/api/session/register" : "/api/session/login";
    const result = await request(endpoint, {
      method: "POST",
      body: JSON.stringify({ familyName, pin }),
      includeAuth: false,
    });
    session = {
      familyId: result.familyId,
      familyName: result.familyName,
      token: result.token,
    };
    saveSession();
    resetStateForActiveFamily();
    showApp();
    await refreshItems();
    startAutoRefresh();
  } catch (error) {
    setSyncError(error);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!session) {
    return;
  }

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
  if (!(checkbox instanceof HTMLInputElement) || !checkbox.matches(".shopping-item__checkbox")) {
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
  if (!(button instanceof HTMLButtonElement) || !button.matches(".shopping-item__delete")) {
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

switchFamilyButton.addEventListener("click", () => {
  const confirmed = window.confirm("Wisselen van gezin op dit toestel?");
  if (!confirmed) {
    return;
  }
  clearSessionAndReturnToAuth();
});

async function bootstrap() {
  if (window.location.protocol === "file:") {
    setSyncError("Open de app via Netlify (of lokaal via `netlify dev`), niet direct als bestand.");
    return;
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

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }

  if (!session) {
    showAuth();
    renderSyncStatus();
    return;
  }

  resetStateForActiveFamily();
  showApp();
  renderItems();
  renderSyncStatus();

  try {
    await request("/api/session/restore", {
      method: "POST",
    });
    await refreshItems();
    startAutoRefresh();
  } catch (error) {
    setSyncError(error);
  }
}

function showAuth() {
  authPanel.hidden = false;
  listPanel.hidden = true;
  itemsPanel.hidden = true;
}

function showApp() {
  authPanel.hidden = true;
  listPanel.hidden = false;
  itemsPanel.hidden = false;
  listTitle.textContent = `Boodschappenlijst - ${session?.familyName || ""}`;
}

function resetStateForActiveFamily() {
  items = loadItemsFromStorage();
  pendingOps = loadPendingOpsFromStorage();
  lastSyncedAt = loadLastSyncedAtFromStorage();
  syncError = "";
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

function stopAutoRefresh() {
  if (refreshTimerId === null) {
    return;
  }
  window.clearInterval(refreshTimerId);
  refreshTimerId = null;
}

async function refreshItems() {
  if (!session) {
    return;
  }
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
  if (item.quantity) details.push(`Aantal: ${item.quantity}`);
  if (item.addedBy) details.push(`Toegevoegd door: ${item.addedBy}`);
  return details.join(" • ") || "Geen extra details";
}

function renderSyncStatus() {
  if (!session) {
    syncStatus.textContent = "Kies je gezin om de lijst te openen.";
    syncStatus.classList.remove("sync-status--error", "sync-status--warning");
    return;
  }
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
  syncStatus.classList.remove("sync-status--error", "sync-status--warning");
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
        ...(options.includeAuth === false ? {} : getAuthHeaders()),
        ...(options.headers || {}),
      },
    });
  } catch {
    throw new Error("Geen verbinding met de server.");
  }

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    if (response.status === 401 && options.includeAuth !== false) {
      clearSessionAndReturnToAuth();
    }
    const message =
      payload && typeof payload.error === "string" ? payload.error : `Serverfout (${response.status})`;
    throw new Error(message);
  }
  return payload ?? {};
}

function getAuthHeaders() {
  if (!session) {
    return {};
  }
  return {
    Authorization: `Bearer ${session.token}`,
  };
}

function queueOperation(operation) {
  pendingOps.push(operation);
}

async function triggerSyncInBackground() {
  if (!session || !navigator.onLine) {
    return;
  }
  try {
    await refreshItems();
  } catch (error) {
    setSyncError(error);
  }
}

async function flushPendingOps() {
  if (!session || !navigator.onLine || pendingOps.length === 0 || syncInProgress) {
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
    await request("/api/items", { method: "POST", body: JSON.stringify(operation.item) });
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

function saveSession() {
  if (session) {
    localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  }
}

function loadSession() {
  const loaded = parseStoredJson(SESSION_STORAGE_KEY, null);
  if (!loaded || typeof loaded !== "object") {
    return null;
  }
  if (!loaded.familyId || !loaded.familyName || !loaded.token) {
    return null;
  }
  return loaded;
}

function persistState() {
  if (!session) {
    return;
  }
  localStorage.setItem(getStorageKey("items"), JSON.stringify(items));
  localStorage.setItem(getStorageKey("pending"), JSON.stringify(pendingOps));
  if (lastSyncedAt) {
    localStorage.setItem(getStorageKey("last-sync"), String(lastSyncedAt));
  }
}

function loadItemsFromStorage() {
  if (!session) return [];
  return parseStoredJson(getStorageKey("items"), []);
}

function loadPendingOpsFromStorage() {
  if (!session) return [];
  return parseStoredJson(getStorageKey("pending"), []);
}

function loadLastSyncedAtFromStorage() {
  if (!session) return null;
  const value = localStorage.getItem(getStorageKey("last-sync"));
  if (!value) return null;
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function getStorageKey(type) {
  return `shopping-${session.familyId}-${type}-v1`;
}

function parseStoredJson(key, fallback) {
  const raw = localStorage.getItem(key);
  if (!raw) return fallback;
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

function bindAuthModeUi() {
  if (!familyForm) {
    return;
  }
  familyForm.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.name !== "authMode") {
      return;
    }
    updateAuthModeUi(target.value === "register");
  });
  updateAuthModeUi(false);
}

function updateAuthModeUi(isRegisterMode) {
  if (confirmPinField) {
    confirmPinField.hidden = !isRegisterMode;
  }
  if (familySubmitButton) {
    familySubmitButton.textContent = isRegisterMode ? "Gezin aanmaken" : "Inloggen";
  }
}

function clearSessionAndReturnToAuth() {
  session = null;
  localStorage.removeItem(SESSION_STORAGE_KEY);
  stopAutoRefresh();
  items = [];
  pendingOps = [];
  lastSyncedAt = null;
  syncError = "";
  showAuth();
  renderItems();
  renderSyncStatus();
}

function stripSensitiveParamsFromUrl() {
  const url = new URL(window.location.href);
  const hadSensitiveParams =
    url.searchParams.has("pin") ||
    url.searchParams.has("pinConfirm") ||
    url.searchParams.has("familyName") ||
    url.searchParams.has("authMode");
  if (!hadSensitiveParams) {
    return;
  }
  url.search = "";
  window.history.replaceState({}, "", url.toString());
}
