/**
 * Types for the browser encoder. The implementation lives in abi.js so the
 * page can load it without a build step; this file exists so the Node test
 * that pins it against viem is type-checked too.
 */
export declare const CLAIM_SELECTOR: "0x2f52ebb7";
export declare function padWord(value: bigint): string;
export declare function encodeClaim(
  cumulativeAmount: bigint,
  proof: readonly string[]
): `0x${string}`;
