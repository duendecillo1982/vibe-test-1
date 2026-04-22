"use strict";

const { Pool } = require("pg");
const crypto = require("crypto");

const DATABASE_URL = process.env.NETLIFY_DATABASE_URL || process.env.DATABASE_URL;
const isLocal =
  process.env.NETLIFY_DEV === "true" || process.env.NODE_ENV === "development";
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      // Supabase requires TLS for remote connections.
      ssl: isLocal ? false : { rejectUnauthorized: false },
    })
  : null;

let schemaReady = false;

exports.handler = async (event) => {
  try {
    if (!pool) {
      return json(500, {
        error:
          "Database is niet geconfigureerd. Stel NETLIFY_DATABASE_URL of DATABASE_URL in.",
      });
    }

    await ensureSchema();

    const method = event.httpMethod || "GET";
    const path = getApiPath(event.path || "/api/items");

    if (method === "POST" && path === "/session/register") {
      const body = parseBody(event.body);
      const familyName = sanitize(body.familyName, 80);
      const pin = sanitize(body.pin, 20);
      const familyId = normalizeFamilyId(familyName);

      if (!familyId) {
        return json(400, { error: "Gezinsnaam is verplicht" });
      }
      if (!isValidPin(pin)) {
        return json(400, { error: "Pincode moet uit 4 tot 8 cijfers bestaan" });
      }

      const existing = await pool.query(
        "SELECT id, name, pin_hash FROM shopping_families WHERE id = $1 LIMIT 1",
        [familyId]
      );
      const pinHash = hashPin(pin, familyId);

      if (existing.rowCount > 0) {
        return json(409, { error: "Dit gezin bestaat al. Kies Inloggen." });
      }

      await pool.query(
        "INSERT INTO shopping_families (id, name, pin_hash, created_at) VALUES ($1, $2, $3, $4)",
        [familyId, familyName, pinHash, Date.now()]
      );
      const token = await createSession(familyId);
      return json(200, { familyId, familyName, token, created: true });
    }

    if (method === "POST" && path === "/session/login") {
      const body = parseBody(event.body);
      const familyName = sanitize(body.familyName, 80);
      const pin = sanitize(body.pin, 20);
      const familyId = normalizeFamilyId(familyName);

      if (!familyId || !isValidPin(pin)) {
        return json(400, { error: "Vul een geldige gezinsnaam en pincode in." });
      }

      const existing = await pool.query(
        "SELECT id, name, pin_hash FROM shopping_families WHERE id = $1 LIMIT 1",
        [familyId]
      );
      if (existing.rowCount === 0) {
        return json(401, { error: "Onbekend gezin of onjuiste pincode" });
      }
      const family = existing.rows[0];
      if (!verifyPin(pin, family.id, family.pin_hash)) {
        return json(401, { error: "Onbekend gezin of onjuiste pincode" });
      }

      const token = await createSession(family.id);
      return json(200, { familyId: family.id, familyName: family.name, token, created: false });
    }

    if (method === "POST" && path === "/session/restore") {
      const auth = await authenticateSession(event.headers || {});
      if (!auth.ok) {
        return json(auth.statusCode, { error: auth.error });
      }
      return json(200, { familyId: auth.familyId, familyName: auth.familyName });
    }

    const auth = await authenticateSession(event.headers || {});
    if (!auth.ok) {
      return json(auth.statusCode, { error: auth.error });
    }

    if (method === "GET" && path === "/items") {
      const result = await pool.query(
        "SELECT id, name, quantity, added_by, checked, created_at FROM shopping_items WHERE family_id = $1 ORDER BY checked ASC, created_at DESC",
        [auth.familyId]
      );
      return json(200, {
        items: result.rows.map(toClientItem),
      });
    }

    if (method === "POST" && path === "/items") {
      const body = parseBody(event.body);
      const providedId = sanitize(body.id, 120);
      const name = sanitize(body.name, 80);
      const quantity = sanitize(body.quantity, 30);
      const addedBy = sanitize(body.addedBy, 40);

      if (!name) {
        return json(400, { error: "Naam is verplicht" });
      }

      await pool.query(
        "INSERT INTO shopping_items (id, family_id, name, quantity, added_by, checked, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING",
        [providedId || crypto.randomUUID(), auth.familyId, name, quantity, addedBy, false, Date.now()]
      );
      return json(201, { ok: true });
    }

    if (method === "DELETE" && path === "/items") {
      await pool.query("DELETE FROM shopping_items WHERE family_id = $1", [auth.familyId]);
      return json(200, { ok: true });
    }

    if (method === "DELETE" && path === "/items/checked") {
      await pool.query("DELETE FROM shopping_items WHERE family_id = $1 AND checked = TRUE", [
        auth.familyId,
      ]);
      return json(200, { ok: true });
    }

    if (path.startsWith("/items/")) {
      const itemId = path.slice("/items/".length).trim();
      if (!itemId) {
        return json(404, { error: "Product niet gevonden" });
      }

      if (method === "PATCH") {
        const body = parseBody(event.body);
        if (typeof body.checked !== "boolean") {
          return json(400, { error: "checked moet true of false zijn" });
        }

        const result = await pool.query(
          "UPDATE shopping_items SET checked = $1 WHERE id = $2 AND family_id = $3",
          [body.checked, itemId, auth.familyId]
        );
        if (result.rowCount === 0) {
          return json(404, { error: "Product niet gevonden" });
        }
        return json(200, { ok: true });
      }

      if (method === "DELETE") {
        await pool.query("DELETE FROM shopping_items WHERE id = $1 AND family_id = $2", [
          itemId,
          auth.familyId,
        ]);
        return json(200, { ok: true });
      }
    }

    return json(404, { error: "Endpoint niet gevonden" });
  } catch (error) {
    console.error(error);
    if (isDatabaseConfigError(error)) {
      return json(500, {
        error:
          "Databaseverbinding mislukt. Controleer NETLIFY_DATABASE_URL (juiste wachtwoord en URL-encoding).",
      });
    }
    return json(500, { error: "Interne serverfout" });
  }
};

async function ensureSchema() {
  if (schemaReady) {
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_families (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pin_hash TEXT NOT NULL,
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_sessions (
      token_hash TEXT PRIMARY KEY,
      family_id TEXT NOT NULL,
      expires_at BIGINT NOT NULL,
      created_at BIGINT NOT NULL,
      last_used_at BIGINT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shopping_items (
      id TEXT PRIMARY KEY,
      family_id TEXT NOT NULL DEFAULT 'legacy',
      name TEXT NOT NULL,
      quantity TEXT NOT NULL DEFAULT '',
      added_by TEXT NOT NULL DEFAULT '',
      checked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL
    )
  `);
  await pool.query(
    "ALTER TABLE shopping_items ADD COLUMN IF NOT EXISTS family_id TEXT NOT NULL DEFAULT 'legacy'"
  );
  await pool.query(
    "CREATE INDEX IF NOT EXISTS shopping_items_family_created_idx ON shopping_items (family_id, created_at DESC)"
  );
  await pool.query(
    "INSERT INTO shopping_families (id, name, pin_hash, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING",
    ["legacy", "Bestaand gezin", hashPin("0000", "legacy"), Date.now()]
  );
  await pool.query("CREATE INDEX IF NOT EXISTS shopping_sessions_family_idx ON shopping_sessions (family_id)");
  await pool.query("DELETE FROM shopping_sessions WHERE expires_at < $1", [Date.now()]);

  schemaReady = true;
}

function parseBody(rawBody) {
  if (!rawBody) {
    return {};
  }
  try {
    return JSON.parse(rawBody);
  } catch {
    return {};
  }
}

function sanitize(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function getApiPath(rawPath) {
  const normalized = String(rawPath || "").trim();
  const withoutFunctionPrefix = normalized.replace(/^\/\.netlify\/functions\/api/, "");
  const withoutApiPrefix = withoutFunctionPrefix.replace(/^\/api/, "");
  const path = withoutApiPrefix || "/items";
  return path.startsWith("/") ? path : `/${path}`;
}

async function authenticateSession(headers) {
  const authHeader = String(headers.authorization || headers.Authorization || "");
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice("Bearer ".length).trim() : "";
  if (!token) {
    return { ok: false, statusCode: 401, error: "Geen geldige sessie" };
  }

  const tokenHash = hashSessionToken(token);
  const now = Date.now();
  const result = await pool.query(
    `SELECT s.family_id, f.name, s.expires_at
     FROM shopping_sessions s
     INNER JOIN shopping_families f ON f.id = s.family_id
     WHERE s.token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );
  if (result.rowCount === 0) {
    return { ok: false, statusCode: 401, error: "Sessie verlopen, log opnieuw in." };
  }

  const session = result.rows[0];
  if (Number(session.expires_at) < now) {
    await pool.query("DELETE FROM shopping_sessions WHERE token_hash = $1", [tokenHash]);
    return { ok: false, statusCode: 401, error: "Sessie verlopen, log opnieuw in." };
  }

  await pool.query("UPDATE shopping_sessions SET last_used_at = $1 WHERE token_hash = $2", [
    now,
    tokenHash,
  ]);
  return { ok: true, familyId: session.family_id, familyName: session.name };
}

function normalizeFamilyId(input) {
  return String(input || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[-\s]+/g, "-")
    .slice(0, 64);
}

function isValidPin(pin) {
  return /^\d{4,8}$/.test(pin);
}

function hashPin(pin, familyId) {
  return crypto.scryptSync(pin, familyId, 32).toString("hex");
}

function verifyPin(pin, familyId, expectedHash) {
  const incoming = Buffer.from(hashPin(pin, familyId), "hex");
  const expected = Buffer.from(String(expectedHash || ""), "hex");
  if (incoming.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(incoming, expected);
}

async function createSession(familyId) {
  const token = crypto.randomBytes(48).toString("hex");
  const now = Date.now();
  const expiresAt = now + 1000 * 60 * 60 * 24 * 90;
  await pool.query(
    "INSERT INTO shopping_sessions (token_hash, family_id, expires_at, created_at, last_used_at) VALUES ($1, $2, $3, $4, $5)",
    [hashSessionToken(token), familyId, expiresAt, now, now]
  );
  return token;
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function toClientItem(row) {
  return {
    id: row.id,
    name: row.name,
    quantity: row.quantity,
    addedBy: row.added_by,
    checked: row.checked,
    createdAt: Number(row.created_at),
  };
}

function json(statusCode, payload) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
    body: JSON.stringify(payload),
  };
}

function isDatabaseConfigError(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toUpperCase();
  return (
    code === "28P01" ||
    code === "3D000" ||
    code === "ECONNREFUSED" ||
    message.includes("password authentication failed") ||
    message.includes("no pg_hba.conf entry") ||
    message.includes("self signed certificate") ||
    message.includes("connect etimedout")
  );
}
