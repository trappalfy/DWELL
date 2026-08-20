import type { DatabaseSync } from "node:sqlite";

export class PurchaseStore {
  readonly #insert;
  readonly #all;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      "INSERT INTO purchases (eth_in, tsla_out, tx_hash, bought_at) VALUES (?, ?, ?, ?)"
    );
    this.#all = db.prepare("SELECT eth_in, tsla_out FROM purchases");
  }

  record(ethIn: bigint, tslaOut: bigint, txHash: string): void {
    this.#insert.run(ethIn.toString(), tslaOut.toString(), txHash, Date.now());
  }

  /** Summed in JS, not in SQL: these are wei and SQLite would overflow them. */
  total(): { ethIn: bigint; tslaOut: bigint } {
    let ethIn = 0n;
    let tslaOut = 0n;
    for (const row of this.#all.all()) {
      const record = row as Record<string, unknown>;
      ethIn += BigInt(String(record.eth_in));
      tslaOut += BigInt(String(record.tsla_out));
    }
    return { ethIn, tslaOut };
  }
}
