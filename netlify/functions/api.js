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

    if (method === "GET" && path === "/items") {
      const result = await pool.query(
        "SELECT id, name, quantity, added_by, checked, created_at FROM shopping_items ORDER BY checked ASC, created_at DESC"
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
        "INSERT INTO shopping_items (id, name, quantity, added_by, checked, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING",
        [providedId || crypto.randomUUID(), name, quantity, addedBy, false, Date.now()]
      );
      return json(201, { ok: true });
    }

    if (method === "DELETE" && path === "/items") {
      await pool.query("DELETE FROM shopping_items");
      return json(200, { ok: true });
    }

    if (method === "DELETE" && path === "/items/checked") {
      await pool.query("DELETE FROM shopping_items WHERE checked = TRUE");
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

        const result = await pool.query("UPDATE shopping_items SET checked = $1 WHERE id = $2", [
          body.checked,
          itemId,
        ]);
        if (result.rowCount === 0) {
          return json(404, { error: "Product niet gevonden" });
        }
        return json(200, { ok: true });
      }

      if (method === "DELETE") {
        await pool.query("DELETE FROM shopping_items WHERE id = $1", [itemId]);
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
    CREATE TABLE IF NOT EXISTS shopping_items (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      quantity TEXT NOT NULL DEFAULT '',
      added_by TEXT NOT NULL DEFAULT '',
      checked BOOLEAN NOT NULL DEFAULT FALSE,
      created_at BIGINT NOT NULL
    )
  `);

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
  const withoutPrefix = rawPath.replace(/^\/api/, "");
  return withoutPrefix || "/items";
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
