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
}
