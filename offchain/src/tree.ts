import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import type { Address } from "./types.ts";

const LEAF_ENCODING = ["address", "uint256"] as const;

export interface TreeEntry {
  readonly account: Address;
  readonly cumulative: bigint;
  readonly proof: string[];
}

export interface BuiltTree {
  readonly root: string;
  proofFor(account: Address): string[];
  leafFor(account: Address): string;
  dump(): TreeEntry[];
}

/**
 * Builds the cumulative-entitlement tree the contract verifies against.
 *
 * StandardMerkleTree hashes a leaf as keccak256(keccak256(abi.encode(...)))
 * and sorts each pair before hashing — byte-for-byte the encoding used by
 * RewardVault.claim and OpenZeppelin's MerkleProof.verify. No hand-rolled
 * cryptography lives here on purpose; the cross-check test pins the
 * compatibility by feeding a proof built here into the real contract.
 *
 * Accounts with a zero cumulative are dropped: they have nothing to claim,
 * and a zero leaf would only enlarge every other account's proof.
 */
export function buildTree(cumulative: ReadonlyMap<Address, bigint>): BuiltTree {
  const values: Array<[Address, string]> = [];
  for (const [account, amount] of cumulative) {
    if (amount < 0n) {
      throw new RangeError(`cumulative for ${account} must not be negative, got ${amount}`);
    }
    if (amount === 0n) continue;
    values.push([account, amount.toString()]);
  }

  if (values.length === 0) {
    throw new Error("tree requires at least one account with a non-zero cumulative");
  }

  // Sort by account so the root depends only on content, never on insertion
  // order — the worker must reproduce an identical root after a restart.
  values.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  const tree = StandardMerkleTree.of(values, [...LEAF_ENCODING]);

  const indexOf = new Map<Address, number>();
  for (const [index, value] of tree.entries()) {
    indexOf.set(value[0] as Address, index);
  }

  function requireIndex(account: Address): number {
    const index = indexOf.get(account);
    if (index === undefined) throw new Error(`account ${account} is not in tree`);
    return index;
  }

  return {
    root: tree.root,
    proofFor: (account) => tree.getProof(requireIndex(account)),
    leafFor: (account) => tree.leafHash(tree.at(requireIndex(account))!),
    dump: () =>
      values.map(([account, amount]) => ({
        account,
        cumulative: BigInt(amount),
        proof: tree.getProof(requireIndex(account))
      }))
  };
}
