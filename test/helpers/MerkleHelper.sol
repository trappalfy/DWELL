// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Builds two-leaf trees matching the contract's leaf encoding and
///      OpenZeppelin's commutative pair hashing.
library MerkleHelper {
    function leaf(address account, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))));
    }

    function pairRoot(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
