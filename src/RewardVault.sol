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

    /// @notice Root that claims are verified against. Always one publication
    ///         behind the pending one.
    bytes32 public activeRoot;
    uint64 public activeThroughEpoch;

    /// @notice Most recently published root. Becomes active after CLAIM_DELAY.
    bytes32 public pendingRoot;
    uint64 public pendingThroughEpoch;
    uint64 public pendingActivatesAt;

    uint256 public totalAllocated;
    uint256 public totalClaimed;

    uint256 public maxAllocationIncreasePerRoot;

    error ZeroAddress();
    error EpochNotAdvancing();
    error AllocationDecreased();
    error AllocationCapExceeded();
    error Insolvent();

    event MaxAllocationIncreaseSet(uint256 value);
    event RootPublished(uint64 indexed throughEpoch, bytes32 root, uint256 totalAllocated);
    event RootActivated(uint64 indexed throughEpoch, bytes32 root);

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

    /// @notice Amount still owed to accounts that have not claimed yet.
    function outstanding() public view returns (uint256) {
        return totalAllocated - totalClaimed;
    }

    /// @dev Promotes a matured pending root to active. Called before every
    ///      operation that depends on the active root.
    function _promoteIfDue() internal {
        if (pendingActivatesAt != 0 && block.timestamp >= pendingActivatesAt) {
            activeRoot = pendingRoot;
            activeThroughEpoch = pendingThroughEpoch;
            pendingActivatesAt = 0;
            emit RootActivated(pendingThroughEpoch, pendingRoot);
        }
    }

    /// @notice Publishes a new cumulative entitlement root.
    /// @dev The keeper can only move entitlements forward within the cap; it
    ///      can never move tokens out of this contract.
    function publishRoot(uint64 newEpoch, bytes32 newRoot, uint256 newTotalAllocated)
        external
        onlyRole(KEEPER_ROLE)
        whenNotPaused
    {
        _promoteIfDue();

        if (newEpoch <= pendingThroughEpoch) revert EpochNotAdvancing();
        if (newTotalAllocated < totalAllocated) revert AllocationDecreased();
        if (newTotalAllocated - totalAllocated > maxAllocationIncreasePerRoot) {
            revert AllocationCapExceeded();
        }
        // Solvency: outstanding obligation must never exceed the balance held.
        // Written in transposed form because the balance drops as accounts
        // claim while totalAllocated only ever grows.
        if (newTotalAllocated > rewardToken.balanceOf(address(this)) + totalClaimed) {
            revert Insolvent();
        }

        pendingRoot = newRoot;
        pendingThroughEpoch = newEpoch;
        pendingActivatesAt = uint64(block.timestamp) + CLAIM_DELAY;
        totalAllocated = newTotalAllocated;

        emit RootPublished(newEpoch, newRoot, newTotalAllocated);
    }
}
