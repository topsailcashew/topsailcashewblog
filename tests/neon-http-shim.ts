import { createServer, type Server } from "node:http";
import { Pool, type CustomTypesConfig } from "pg";

/**
 * Speaks Neon's SQL-over-HTTP protocol in front of an ordinary Postgres.
 *
 * Lets the tests drive the *real* `@neondatabase/serverless` HTTP driver — the
 * one the Worker uses — against a local database, so driver-specific behaviour
 * (array parameter encoding, the `db.execute` result shape, SQLSTATE
 * propagation) is covered rather than assumed.
 *
 * Test scaffolding only; nothing here ships to Cloudflare.
 */

/**
 * Neon sends every value as text and lets the client parse it, so the shim
 * hands back the raw wire strings instead of pg's parsed values.
 */
const rawText = {
  getTypeParser: () => (value: string) => value,
} as unknown as CustomTypesConfig;

export type NeonShim = { url: string; close: () => Promise<void> };

export async function startNeonShim(
  connectionString: string,
  port = 0,
): Promise<NeonShim> {
  const pool = new Pool({ connectionString, max: 4 });

  const server: Server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);

      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (Array.isArray(body.queries)) {
          send(400, { message: "This shim does not implement batch queries" });
          return;
        }

        const result = await pool.query<unknown[]>({
          text: body.query as string,
          values: (body.params ?? []) as unknown[],
          rowMode: "array",
          types: rawText,
        });

        send(200, {
          command: result.command,
          rowCount: result.rowCount,
          rowAsArray: true,
          fields: result.fields.map((field) => ({
            name: field.name,
            dataTypeID: field.dataTypeID,
            tableID: field.tableID,
            columnID: field.columnID,
            dataTypeSize: field.dataTypeSize,
            dataTypeModifier: field.dataTypeModifier,
            format: field.format,
          })),
          rows: result.rows,
        });
      } catch (error) {
        // Neon reports query failures as 400 with the SQLSTATE fields inline;
        // the driver rebuilds a NeonDbError from exactly these keys.
        const pgError = error as Record<string, unknown> & { message?: string };
        send(400, {
          message: pgError?.message ?? "shim failure",
          code: pgError?.code,
          detail: pgError?.detail,
          constraint: pgError?.constraint,
          severity: pgError?.severity,
          table: pgError?.table,
          column: pgError?.column,
        });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Shim failed to bind a port");
  }

  return {
    url: `http://127.0.0.1:${address.port}/sql`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}
