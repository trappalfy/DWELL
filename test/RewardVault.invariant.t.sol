// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Drives the vault with bounded random input so the fuzzer explores real
///      publish/claim sequences instead of bouncing off guards.
///
///      The tree is deliberately a single leaf: root == leaf, so the proof is
///      the empty array and the handler can exercise a full publish -> mature
///      -> claim cycle without building trees inside the fuzzer.
contract VaultHandler is Test {
    RewardVault public vault;
    MockERC20 public token;
    address public keeper;
    address public miner;

    uint64 public epoch;
    uint256 public publishes;
    uint256 public claims;

    constructor(RewardVault vault_, MockERC20 token_, address keeper_, address miner_) {
        vault = vault_;
        token = token_;
        keeper = keeper_;
        miner = miner_;
    }

    function _leaf(address account, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))));
    }

    function fund(uint256 amount) external {
        token.mint(address(vault), bound(amount, 0, 100e18));
    }

    function publish(uint256 increase, uint256 timeJump) external {
        // Read every vault value BEFORE vm.prank: each getter is an external
        // call and would otherwise consume the prank meant for publishRoot.
        uint256 current = vault.totalAllocated();
        uint256 claimedSoFar = vault.totalClaimed();
        uint256 cap = vault.maxAllocationIncreasePerRoot();
        uint256 balance = token.balanceOf(address(vault));

        uint256 headroom = balance + claimedSoFar - current;
        increase = bound(increase, 0, cap);
        if (increase > headroom) increase = headroom;

        uint256 target = current + increase;
        vm.warp(block.timestamp + bound(timeJump, 0, 900));

        epoch += 1;
        bytes32 root = _leaf(miner, target);

        vm.prank(keeper);
        vault.publishRoot(epoch, root, target);
        publishes += 1;
    }

    function claim(uint256 timeJump) external {
        vm.warp(block.timestamp + bound(timeJump, 0, 900));

        uint256 cumulative = vault.pendingThroughEpoch() == 0 ? 0 : vault.totalAllocated();
        if (cumulative == 0) return;
        if (vault.claimed(miner) >= cumulative) return;
        if (vault.activeRoot() == bytes32(0) && vault.pendingActivatesAt() > block.timestamp) return;

        bytes32[] memory proof = new bytes32[](0);
        vm.prank(miner);
        try vault.claim(cumulative, proof) {
            claims += 1;
        } catch {
            // The active root may still lag behind the pending allocation;
            // that is expected and not an invariant violation.
        }
    }
}

contract RewardVaultInvariantTest is Test {
    RewardVault internal vault;
    MockERC20 internal token;
    VaultHandler internal handler;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal miner = makeAddr("miner");

    function setUp() public {
        token = new MockERC20("Tesla Mock", "TSLA");
        vault = new RewardVault(IERC20(address(token)), admin, keeper, 100e18);
        token.mint(address(vault), 500e18);

        handler = new VaultHandler(vault, token, keeper, miner);
        targetContract(address(handler));
    }

    /// The vault can never owe more than it holds.
    function invariant_solvency() public view {
        assertLe(vault.outstanding(), token.balanceOf(address(vault)));
    }

    /// Entitlements are never revoked: claims can never exceed allocation.
    function invariant_claimedNeverExceedsAllocated() public view {
        assertGe(vault.totalAllocated(), vault.totalClaimed());
    }

    /// Active root never runs ahead of the pending one.
    function invariant_activeNeverAheadOfPending() public view {
        assertLe(vault.activeThroughEpoch(), vault.pendingThroughEpoch());
    }

    /// Guards against a vacuous run: the fuzzer must actually reach the
    /// publish and claim paths, otherwise the invariants above prove nothing.
    ///
    /// This is a post-condition, not an invariant — at setup the counters are
    /// still zero, so asserting it as an invariant would fail on the initial
    /// state check before any call is made.
    function afterInvariant() public view {
        assertGt(handler.publishes(), 0, "fuzzer never published a root");
        assertGt(handler.claims(), 0, "fuzzer never completed a claim");
    }
}
