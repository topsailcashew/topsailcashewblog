import { existsSync } from "node:fs";
import { config } from "dotenv";

/**
 * Mirrors Next's env precedence for the standalone Node scripts, so
 * `npm run db:migrate` reads the same DATABASE_URL that `next dev` does.
 */
export function loadEnv(): void {
  for (const file of [".env.local", ".env"]) {
    if (existsSync(file)) config({ path: file, quiet: true });
  }
}

export function requireDatabaseUrl(): string {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error(
      "DATABASE_URL is not set.\n" +
        "  cp .env.example .env.local  and paste your Neon connection string.",
    );
    process.exit(1);
  }
  return url;
}
