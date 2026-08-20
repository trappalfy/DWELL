import type { Address } from "./types.ts";

export const CHAIN_ID = 4663;

/**
 * Pinned protocol addresses on Robinhood Chain.
 *
 * Established by decoding real on-chain transactions, not by assumption.
 * Two hazards make dynamic resolution unacceptable here:
 *
 *  1. The chain hosts impostor tokens with the identical name
 *     "Tesla • Robinhood Token" and symbol TSLA. Resolving by symbol would
 *     eventually buy a worthless copy.
 *  2. The Uniswap v3 factory is NOT at its canonical cross-chain address, so
 *     the well-known constant from documentation is wrong here.
 */
export const ADDRESSES = {
  tsla: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  swapRouter: "0xCaf681a66D020601342297493863E78C959E5cb2",
  v3Factory: "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA",
  wethTslaPool: "0xA953CA88ff430e9487c60cA34d757414f4efdA07",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11"
} as const satisfies Record<string, Address>;

/** The WETH/TSLA pool exists only in the 0.3% tier on this chain. */
export const POOL_FEE = 3000;

/**
 * Slippage budget in basis points. Must exceed the pool fee: at 0.3% the fee
 * alone would consume a third of a 1% budget and every swap would revert.
 */
export const SLIPPAGE_BPS = 200;

export interface RuntimeConfig {
  readonly rpcUrl: string;
  readonly rewardVault: Address;
  readonly minBalance: bigint;
  readonly databasePath: string;
  readonly port: number;
}

function required(env: NodeJS.ProcessEnv, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`${key} is required`);
  return value;
}

function requireAddress(env: NodeJS.ProcessEnv, key: string): Address {
  const value = required(env, key);
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${key} must be a 20-byte hex address, got ${value}`);
  }
  return value as Address;
}

/** Reads deployment-specific values. Secrets are never returned from here. */
export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  return {
    rpcUrl: required(env, "RPC_URL"),
    rewardVault: requireAddress(env, "REWARD_VAULT"),
    minBalance: BigInt(required(env, "MIN_BALANCE")) * 10n ** 18n,
    databasePath: required(env, "DATABASE_PATH"),
    port: Number(env.PORT ?? 8787)
  };
}
