import type { DatabaseSync } from "node:sqlite";

export class EpochStore {
  readonly #insert;
  readonly #last;
  readonly #countAll;
  readonly #countAfter;
  readonly #countReleasing;

  constructor(db: DatabaseSync) {
    this.#insert = db.prepare(
      "INSERT INTO epochs (epoch, total_weight, release, settled_at) VALUES (?, ?, ?, ?)"
    );
    this.#last = db.prepare("SELECT max(epoch) AS epoch FROM epochs");
    this.#countAll = db.prepare("SELECT count(*) AS total FROM epochs");
    this.#countAfter = db.prepare("SELECT count(*) AS total FROM epochs WHERE epoch > ?");
    // Amounts are stored as decimal strings, so an epoch that paid out
    // nothing reads "0".
    this.#countReleasing = db.prepare("SELECT count(*) AS total FROM epochs WHERE release != '0'");
  }

  /** The primary key makes double settlement impossible at the storage layer. */
  markSettled(epoch: number, totalWeight: bigint, release: bigint): void {
    try {
      this.#insert.run(epoch, totalWeight.toString(), release.toString(), Date.now());
    } catch (error) {
      throw new Error(`epoch ${epoch} already settled`, { cause: error });
    }
  }

  /**
   * How many epochs are settled beyond the given one.
   *
   * Counts rows rather than subtracting epoch numbers: epoch ids are derived
   * from unix time and run in the millions, so `lastSettled - lastPublished`
   * would be a time span, not an amount of work — and on the very first
   * publish there is nothing to subtract from at all. Counting also stays
   * honest across gaps left by an outage.
   */
  countSettledAfter(epoch: number | null): number {
    const row = (epoch === null ? this.#countAll.get() : this.#countAfter.get(epoch)) as
      | Record<string, unknown>
      | undefined;
    return Number(row?.total ?? 0);
  }

  /**
   * How many epochs actually paid something out.
   *
   * Distinct from countSettledAfter, which counts every closed epoch. Two
   * kinds of epoch settle without distributing anything: one with nobody
   * present, and one where the vault is still empty. Neither may consume the
   * launch window — counting either would hand the bank to whatever hour the
   * worker happened to start in, or burn it before the vault was funded at
   * all.
   *
   * Counting payouts rather than presence is what makes funding the vault
   * the act that starts the distribution.
   */
  countReleasing(): number {
    const row = this.#countReleasing.get() as Record<string, unknown> | undefined;
    return Number(row?.total ?? 0);
  }

  lastSettled(): number | null {
    const row = this.#last.get() as Record<string, unknown> | undefined;
    const value = row?.epoch;
    return value === null || value === undefined ? null : Number(value);
  }
}
