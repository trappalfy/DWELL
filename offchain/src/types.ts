/** Lowercase 0x-prefixed EVM address. */
export type Address = `0x${string}`;

/** One accepted heartbeat: an account was active in a bucket holding a balance. */
export interface HeartbeatRecord {
  readonly account: Address;
  readonly bucketId: number;
  readonly balance: bigint;
}

/** On-chain state of the reward vault at settlement time. */
export interface VaultState {
  /** Reward-asset balance held by the vault. */
  readonly balance: bigint;
  readonly totalAllocated: bigint;
  readonly totalClaimed: bigint;
}

export interface SettlementInput {
  readonly epoch: number;
  readonly heartbeats: readonly HeartbeatRecord[];
  readonly vault: VaultState;
  readonly minBalance: bigint;
  readonly priorCumulative: ReadonlyMap<Address, bigint>;
  /** Epochs that actually had miners, deciding whether the launch window still applies. */
  readonly minedEpochs: number;
}

export interface SettlementResult {
  readonly epoch: number;
  readonly totalWeight: bigint;
  readonly release: bigint;
  readonly allocations: ReadonlyMap<Address, bigint>;
  /** Remainder of integer division. Stays in the reserve, never lost. */
  readonly dust: bigint;
  readonly cumulative: ReadonlyMap<Address, bigint>;
  readonly totalAllocated: bigint;
}
