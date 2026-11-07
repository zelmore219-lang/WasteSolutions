import { Pool } from "pg";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
export async function migrateDatabase(
  databaseUrl = process.env.DATABASE_URL,
  directory = resolve(__dirname, "../../../database"),
) {
  if (!databaseUrl) throw Error("DATABASE_URL is required for migrations");
  const files = (await readdir(directory))
    .filter((name) => /^\d{3}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
  if (!files.length) throw Error("No database migrations are packaged");
  const prefixes = files.map((name) => name.slice(0, 3));
  if (new Set(prefixes).size !== prefixes.length)
    throw Error("Migration sequence numbers must be unique");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query(
        "SELECT pg_advisory_xact_lock(hashtext('corewaste-migrations'))",
      );
      await c.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const file of files) {
        const version = file.slice(0, -4);
        if (
          (
            await c.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
              version,
            ])
          ).rowCount
        )
          continue;
        await c.query(await readFile(resolve(directory, file), "utf8"));
        await c.query("INSERT INTO schema_migrations(version) VALUES($1)", [
          version,
        ]);
        console.log("Applied " + version);
      }
      await c.query("COMMIT");
    } catch (error) {
      await c.query("ROLLBACK");
      throw error;
    } finally {
      c.release();
    }
  } finally {
    await pool.end();
  }
}
if (require.main === module)
  void migrateDatabase().catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Database migration failed",
    );
    process.exitCode = 1;
  });
