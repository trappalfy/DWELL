// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract RewardVaultPublishTest is Test {
    RewardVault internal vault;
    MockERC20 internal token;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    uint256 internal constant CAP = 1_000e18;

    function setUp() public {
        token = new MockERC20("Tesla Mock", "TSLA");
        vault = new RewardVault(IERC20(address(token)), admin, keeper, CAP);
    }

    function test_deploy_setsImmutablesAndRoles() public view {
        assertEq(address(vault.rewardToken()), address(token));
        assertEq(vault.maxAllocationIncreasePerRoot(), CAP);
        assertTrue(vault.hasRole(vault.DEFAULT_ADMIN_ROLE(), admin));
        assertTrue(vault.hasRole(vault.KEEPER_ROLE(), keeper));
        assertEq(vault.CLAIM_DELAY(), 300);
    }

    bytes32 internal constant ROOT_A = bytes32(uint256(0xA1));
    bytes32 internal constant ROOT_B = bytes32(uint256(0xB2));

    function _fund(uint256 amount) internal {
        token.mint(address(vault), amount);
    }

    function test_publishRoot_storesPendingAndAllocation() public {
        _fund(500e18);
        vm.prank(keeper);
        vault.publishRoot(10, ROOT_A, 500e18);

        assertEq(vault.pendingRoot(), ROOT_A);
        assertEq(vault.pendingThroughEpoch(), 10);
        assertEq(vault.pendingActivatesAt(), uint64(block.timestamp) + 300);
        assertEq(vault.totalAllocated(), 500e18);
        assertEq(vault.activeRoot(), bytes32(0));
    }

    function test_publishRoot_revertsForNonKeeper() public {
        _fund(500e18);
        vm.expectRevert();
        vault.publishRoot(10, ROOT_A, 500e18);
    }

    function test_publishRoot_revertsWhenEpochNotAdvancing() public {
        _fund(500e18);
        vm.startPrank(keeper);
        vault.publishRoot(10, ROOT_A, 100e18);
        vm.expectRevert(RewardVault.EpochNotAdvancing.selector);
        vault.publishRoot(10, ROOT_B, 200e18);
        vm.stopPrank();
    }

    function test_publishRoot_revertsWhenAllocationDecreases() public {
        _fund(500e18);
        vm.startPrank(keeper);
        vault.publishRoot(10, ROOT_A, 300e18);
        vm.expectRevert(RewardVault.AllocationDecreased.selector);
        vault.publishRoot(11, ROOT_B, 299e18);
        vm.stopPrank();
    }

    function test_publishRoot_revertsWhenCapExceeded() public {
        _fund(5_000e18);
        vm.prank(keeper);
        vm.expectRevert(RewardVault.AllocationCapExceeded.selector);
        vault.publishRoot(10, ROOT_A, CAP + 1);
    }

    function test_publishRoot_revertsWhenInsolvent() public {
        _fund(100e18);
        vm.prank(keeper);
        vm.expectRevert(RewardVault.Insolvent.selector);
        vault.publishRoot(10, ROOT_A, 101e18);
    }

    function test_publishRoot_allowsAllocationUpToBalance() public {
        _fund(100e18);
        vm.prank(keeper);
        vault.publishRoot(10, ROOT_A, 100e18);
        assertEq(vault.outstanding(), 100e18);
    }
}
