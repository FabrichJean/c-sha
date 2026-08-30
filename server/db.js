const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "ledger.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    company TEXT,
    email TEXT,
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    client_id TEXT,
    project_keys TEXT NOT NULL DEFAULT '[]',
    rate REAL,
    billing_mode TEXT NOT NULL DEFAULT 'tokens',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS invoices (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    total REAL NOT NULL DEFAULT 0,
    line_items TEXT NOT NULL DEFAULT '[]',
    notes TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS usage_entries (
    id TEXT PRIMARY KEY,
    project_key TEXT NOT NULL,
    yyyymm TEXT NOT NULL,
    model TEXT NOT NULL,
    totals TEXT NOT NULL,
    daily TEXT NOT NULL,
    imported_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    hostname TEXT,
    client_id TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

/* migration: usage_entries predates per-device tracking */
const usageCols = db.prepare("PRAGMA table_info(usage_entries)").all().map(c => c.name);
if (!usageCols.includes("device_id")) {
  db.exec("ALTER TABLE usage_entries ADD COLUMN device_id TEXT NOT NULL DEFAULT 'legacy'");
}

/* migration: devices predates the shareable view-link feature */
const deviceCols = db.prepare("PRAGMA table_info(devices)").all().map(c => c.name);
if (!deviceCols.includes("view_token")) {
  db.exec("ALTER TABLE devices ADD COLUMN view_token TEXT");
}

/* migration: projects predates the billing-mode feature */
const projectCols = db.prepare("PRAGMA table_info(projects)").all().map(c => c.name);
if (!projectCols.includes("billing_mode")) {
  db.exec("ALTER TABLE projects ADD COLUMN billing_mode TEXT NOT NULL DEFAULT 'tokens'");
}

/* migration: devices predates client linking */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

module.exports = { db, uid };
