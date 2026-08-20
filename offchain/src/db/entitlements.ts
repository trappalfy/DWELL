import type { DatabaseSync } from "node:sqlite";
import type { Address } from "../types.ts";

export class EntitlementStore {
  readonly #db;
  readonly #all;
  readonly #upsert;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#all = db.prepare("SELECT account, cumulative FROM entitlements");
    this.#upsert = db.prepare(
      `INSERT INTO entitlements (account, cumulative) VALUES (?, ?)
       ON CONFLICT (account) DO UPDATE SET cumulative = excluded.cumulative`
    );
  }

  load(): Map<Address, bigint> {
    const result = new Map<Address, bigint>();
    for (const row of this.#all.all()) {
      const record = row as Record<string, unknown>;
      result.set(String(record.account) as Address, BigInt(String(record.cumulative)));
    }
    return result;
  }

  /** Written in one transaction so a crash cannot leave a partial epoch. */
  save(cumulative: ReadonlyMap<Address, bigint>): void {
    this.#db.exec("BEGIN");
    try {
      for (const [account, amount] of cumulative) {
        this.#upsert.run(account, amount.toString());
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
