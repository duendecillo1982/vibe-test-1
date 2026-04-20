const form = document.querySelector("#add-item-form");
const list = document.querySelector("#shopping-list");
const emptyState = document.querySelector("#empty-state");
const template = document.querySelector("#item-template");
const clearCheckedButton = document.querySelector("#clear-checked");
const clearAllButton = document.querySelector("#clear-all");
const syncStatus = document.querySelector("#sync-status");
const apiBaseMeta = document.querySelector('meta[name="api-base"]');
const API_BASE = (apiBaseMeta?.content || "").trim().replace(/\/+$/, "");

let items = [];
let refreshTimerId = null;
let syncError = "";

bootstrap();

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const name = String(formData.get("name") || "").trim();
  const quantity = String(formData.get("quantity") || "").trim();
  const addedBy = String(formData.get("addedBy") || "").trim();

  if (!name) {
    return;
  }

  try {
    await request("/api/items", {
      method: "POST",
      body: JSON.stringify({ name, quantity, addedBy }),
    });
    await refreshItems();
    form.reset();
    document.querySelector("#item-name")?.focus();
  } catch (error) {
    setSyncError(error);
  }
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
  try {
    await request(`/api/items/${itemId}`, {
      method: "PATCH",
      body: JSON.stringify({ checked: checkbox.checked }),
    });
    await refreshItems();
  } catch (error) {
    setSyncError(error);
  }
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
  try {
    await request(`/api/items/${itemId}`, { method: "DELETE" });
    await refreshItems();
  } catch (error) {
    setSyncError(error);
  }
});

clearCheckedButton.addEventListener("click", async () => {
  try {
    await request("/api/items/checked", { method: "DELETE" });
    await refreshItems();
  } catch (error) {
    setSyncError(error);
  }
});

clearAllButton.addEventListener("click", async () => {
  if (items.length === 0) {
    return;
  }

  const confirmed = window.confirm("Weet je zeker dat je het hele lijstje wilt leegmaken?");
  if (!confirmed) {
    return;
  }

  try {
    await request("/api/items", { method: "DELETE" });
    await refreshItems();
  } catch (error) {
    setSyncError(error);
  }
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
  const result = await request("/api/items");
  items = Array.isArray(result.items) ? result.items : [];
  syncError = "";
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
    return;
  }

  syncStatus.textContent = `Synchronisatie actief • Laatst bijgewerkt om ${new Date().toLocaleTimeString("nl-NL")}`;
  syncStatus.classList.remove("sync-status--error");
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
    throw new Error(
      "Kan de server niet bereiken. Controleer of de backend draait en dat api-base klopt."
    );
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
