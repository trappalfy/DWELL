import type { DatabaseSync } from "node:sqlite";

export class EpochStore {
  readonly #insert;
  readonly #last;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      "INSERT INTO epochs (epoch, total_weight, release, settled_at) VALUES (?, ?, ?, ?)"
    );
    this.#last = db.prepare("SELECT max(epoch) AS epoch FROM epochs");
  }

  /** The primary key makes double settlement impossible at the storage layer. */
  markSettled(epoch: number, totalWeight: bigint, release: bigint): void {
    try {
      this.#insert.run(epoch, totalWeight.toString(), release.toString(), Date.now());
    } catch (error) {
      throw new Error(`epoch ${epoch} already settled`, { cause: error });
    }
  }

  lastSettled(): number | null {
    const row = this.#last.get() as Record<string, unknown> | undefined;
    const value = row?.epoch;
    return value === null || value === undefined ? null : Number(value);
  }
}
