import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from "kysely";
import { describe, expect, it } from "vitest";
import type { DB } from "@/lib/server/db/types.gen";

// Compiles queries against the generated schema without a database. `pnpm typecheck`
// fails here if `pnpm db:types` drops or renames a table or column used below.
const db = new Kysely<DB>({
  dialect: {
    createAdapter: () => new PostgresAdapter(),
    createDriver: () => new DummyDriver(),
    createIntrospector: (k) => new PostgresIntrospector(k),
    createQueryCompiler: () => new PostgresQueryCompiler(),
  },
});

describe("generated database types", () => {
  it("covers the baseline tables in the app schema", () => {
    const query = db
      .selectFrom("app.runtime_flags")
      .select(["key", "enabled", "value", "note", "updated_at", "updated_by"])
      .where("key", "=", "uploads_enabled")
      .compile();

    expect(query.sql).toBe(
      'select "key", "enabled", "value", "note", "updated_at", "updated_by" from "app"."runtime_flags" where "key" = $1',
    );
    expect(query.parameters).toEqual(["uploads_enabled"]);
  });

  it("marks database defaults as optional on insert", () => {
    const query = db
      .insertInto("app.rate_counters")
      .values({ key: "k", window_start: new Date(0), expires_at: new Date(0) })
      .compile();

    expect(query.sql).toBe(
      'insert into "app"."rate_counters" ("key", "window_start", "expires_at") values ($1, $2, $3)',
    );
  });

  it("does not expose tables outside the app schema", () => {
    // @ts-expect-error auth.users is not part of the generated schema
    const query = db.selectFrom("auth.users").selectAll().compile();
    expect(query.sql).toContain('"auth"."users"');
  });
});
