import type { DatabaseSync } from "node:sqlite";

export interface PublishedRoot {
  readonly throughEpoch: number;
  readonly root: string;
  readonly txHash: string | null;
}

export class RootStore {
  readonly #insert;
  readonly #last;
  readonly #byEpoch;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      "INSERT INTO roots (through_epoch, root, tx_hash, published_at) VALUES (?, ?, ?, ?)"
    );
    this.#last = db.prepare("SELECT max(through_epoch) AS epoch FROM roots");
    this.#byEpoch = db.prepare(
      "SELECT through_epoch, root, tx_hash FROM roots WHERE through_epoch = ?"
    );
  }

  /** The primary key on through_epoch makes a double publish impossible. */
  record(throughEpoch: number, root: string, txHash: string): void {
    this.#insert.run(throughEpoch, root, txHash, Date.now());
  }

  lastPublished(): number | null {
    const row = this.#last.get() as Record<string, unknown> | undefined;
    const value = row?.epoch;
    return value === null || value === undefined ? null : Number(value);
  }

  rootFor(throughEpoch: number): PublishedRoot | null {
    const row = this.#byEpoch.get(throughEpoch) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      throughEpoch: Number(row.through_epoch),
      root: String(row.root),
      txHash: row.tx_hash === null ? null : String(row.tx_hash)
    };
  }
}
