// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

contract RewardVaultAdminTest is Test {
    RewardVault internal vault;
    MockERC20 internal token;
    MockERC20 internal foreign;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal rescuer = makeAddr("rescuer");

    uint256 internal constant CAP = 1_000e18;

    function setUp() public {
        token = new MockERC20("Tesla Mock", "TSLA");
        foreign = new MockERC20("Stray", "STRAY");
        vault = new RewardVault(IERC20(address(token)), admin, keeper, CAP);
        token.mint(address(vault), 1_000e18);
    }

    function test_surplus_isBalanceMinusOutstanding() public {
        assertEq(vault.surplus(), 1_000e18);

        vm.prank(keeper);
        vault.publishRoot(1, bytes32(uint256(0xA1)), 400e18);

        assertEq(vault.surplus(), 600e18);
    }

    function test_withdrawSurplus_movesOnlyFreeBalance() public {
        vm.prank(keeper);
        vault.publishRoot(1, bytes32(uint256(0xA1)), 400e18);

        vm.prank(admin);
        vault.withdrawSurplus(rescuer, 600e18);

        assertEq(token.balanceOf(rescuer), 600e18);
        assertEq(vault.surplus(), 0);
    }

    function test_withdrawSurplus_revertsWhenTouchingObligations() public {
        vm.prank(keeper);
        vault.publishRoot(1, bytes32(uint256(0xA1)), 400e18);

        vm.prank(admin);
        vm.expectRevert(RewardVault.SurplusExceeded.selector);
        vault.withdrawSurplus(rescuer, 600e18 + 1);
    }

    function test_withdrawSurplus_revertsForNonAdmin() public {
        vm.prank(keeper);
        vm.expectRevert();
        vault.withdrawSurplus(rescuer, 1);
    }

    function test_rescueForeignToken_movesStrayToken() public {
        foreign.mint(address(vault), 5e18);

        vm.prank(admin);
        vault.rescueForeignToken(IERC20(address(foreign)), rescuer, 5e18);

        assertEq(foreign.balanceOf(rescuer), 5e18);
    }

    function test_rescueForeignToken_refusesRewardToken() public {
        vm.prank(admin);
        vm.expectRevert(RewardVault.CannotRescueRewardToken.selector);
        vault.rescueForeignToken(IERC20(address(token)), rescuer, 1);
    }

    function test_setMaxAllocationIncreasePerRoot_updatesCap() public {
        vm.prank(admin);
        vault.setMaxAllocationIncreasePerRoot(42e18);
        assertEq(vault.maxAllocationIncreasePerRoot(), 42e18);
    }

    function test_pause_blocksPublishAndClaim() public {
        vm.prank(admin);
        vault.pause();

        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.publishRoot(1, bytes32(uint256(0xA1)), 1e18);

        bytes32[] memory p = new bytes32[](0);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vault.claim(1e18, p);
    }

    function test_unpause_restoresPublishing() public {
        vm.startPrank(admin);
        vault.pause();
        vault.unpause();
        vm.stopPrank();

        vm.prank(keeper);
        vault.publishRoot(1, bytes32(uint256(0xA1)), 1e18);
        assertEq(vault.totalAllocated(), 1e18);
    }

    function test_pause_keeperMayPause() public {
        vm.prank(keeper);
        vault.pause();
        assertTrue(vault.paused(), "keeper must be able to stop the protocol");
    }

    function test_pause_keeperMayNotUnpause() public {
        vm.prank(keeper);
        vault.pause();

        vm.prank(keeper);
        vm.expectRevert();
        vault.unpause();
    }

    function test_pause_adminMayPauseAndUnpause() public {
        vm.prank(admin);
        vault.pause();
        assertTrue(vault.paused());

        vm.prank(admin);
        vault.unpause();
        assertFalse(vault.paused());
    }

    function test_pause_strangerMayNotPause() public {
        address stranger = makeAddr("stranger");
        vm.prank(stranger);
        vm.expectRevert(RewardVault.NotPauser.selector);
        vault.pause();
    }
}
