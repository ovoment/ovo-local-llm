import Database from "@tauri-apps/plugin-sql";

const DB_URL = "sqlite:chats.sqlite";

let dbPromise: Promise<Database> | null = null;

// [START] Lazy singleton — the DB handle survives hot reload via module scope.
// Migrations (version=1, migrations/001_init.sql) run automatically on first load
// from the Rust side (see src-tauri/src/lib.rs::chats_migrations).
export function getDb(): Promise<Database> {
  if (!dbPromise) {
    dbPromise = Database.load(DB_URL);
  }
  return dbPromise;
}
// [END]

export function nowMs(): number {
  return Date.now();
}

export function newId(): string {
  return crypto.randomUUID();
}
