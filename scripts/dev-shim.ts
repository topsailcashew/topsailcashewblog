/**
 * Runs the Neon-over-HTTP shim as a standalone server.
 *
 * Local development and `wrangler dev` both use the real Neon HTTP driver, so
 * pointing DATABASE_URL at this lets the actual Worker run against a local
 * Postgres. Test scaffolding — never deployed.
 */
import { startNeonShim } from "../tests/neon-http-shim";

async function main() {
  const target = process.env.SHIM_TARGET ?? process.env.TEST_DATABASE_URL;
  if (!target) {
    console.error("Set SHIM_TARGET or TEST_DATABASE_URL to the Postgres to front.");
    process.exit(1);
  }

  const shim = await startNeonShim(target, Number(process.env.SHIM_PORT ?? 55444));
  console.log(`Neon shim listening on ${shim.url}`);
}

main().catch((error) => {
  console.error("Shim failed to start:", error);
  process.exit(1);
});
