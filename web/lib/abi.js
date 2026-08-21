/**
 * Minimal ABI encoding for the one transaction this page ever sends.
 *
 * Pulling a full library into the browser would mean adding a bundler to a
 * project that deliberately has no build step. `claim` takes a uint256 and a
 * bytes32[], which is the simplest possible dynamic encoding, so it is
 * written out by hand and pinned against viem in offchain/test/abi.test.ts —
 * that test imports THIS file, so what is verified is what ships.
 */

/** keccak256("claim(uint256,bytes32[])")[0:4] */
export const CLAIM_SELECTOR = "0x2f52ebb7";

const WORD = 64; // 32 bytes as hex characters

/** Left-pads a bigint to one 32-byte EVM word. */
export function padWord(value) {
  if (value < 0n) throw new RangeError("cannot encode a negative value");
  const hex = value.toString(16);
  if (hex.length > WORD) throw new RangeError("value exceeds 32 bytes");
  return hex.padStart(WORD, "0");
}

function bare32(hex) {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (stripped.length !== WORD || !/^[0-9a-fA-F]+$/.test(stripped)) {
    throw new RangeError(`proof element must be 32 bytes, got ${hex}`);
  }
  return stripped.toLowerCase();
}

/**
 * Builds calldata for RewardVault.claim(uint256,bytes32[]).
 *
 * Layout: selector, then the head — the amount and the offset to the array —
 * then the array itself as length followed by elements. The offset is a
 * constant 0x40 because the head is always exactly two words.
 */
export function encodeClaim(cumulativeAmount, proof) {
  const head = padWord(cumulativeAmount) + padWord(64n);
  const body = padWord(BigInt(proof.length)) + proof.map(bare32).join("");
  return CLAIM_SELECTOR + head + body;
}
