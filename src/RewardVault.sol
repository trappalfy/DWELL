// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title RewardVault
/// @notice Cumulative Merkle distributor for the DWELL protocol. Holds the
///         reward asset and pays each account the difference between its
///         cumulative entitlement and what it has already claimed.
contract RewardVault is AccessControl, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    /// @notice Delay between publishing a root and it becoming claimable.
    uint64 public constant CLAIM_DELAY = 300;

    IERC20 public immutable rewardToken;

    uint256 public maxAllocationIncreasePerRoot;

    error ZeroAddress();

    event MaxAllocationIncreaseSet(uint256 value);

    constructor(IERC20 token, address admin, address keeper, uint256 cap) {
        if (address(token) == address(0) || admin == address(0) || keeper == address(0)) {
            revert ZeroAddress();
        }
        rewardToken = token;
        maxAllocationIncreasePerRoot = cap;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);
        emit MaxAllocationIncreaseSet(cap);
    }
}
