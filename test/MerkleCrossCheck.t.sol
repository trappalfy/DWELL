// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Proves the off-chain tree and the on-chain verifier agree. The fixture
///      is produced by offchain/scripts/generate-merkle-fixture.ts; if the leaf
///      encodings ever diverge, miners could not claim, so this test is the
///      guard that keeps the two halves in sync.
contract MerkleCrossCheckTest is Test {
    RewardVault internal vault;
    MockERC20 internal token;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");

    string internal fixture;

    function setUp() public {
        token = new MockERC20("Tesla Mock", "TSLA");
        vault = new RewardVault(IERC20(address(token)), admin, keeper, 1_000e18);
        fixture = vm.readFile("test/fixtures/merkle.json");
    }

    function _entryPath(uint256 index, string memory field) internal pure returns (string memory) {
        return string.concat("$.entries[", vm.toString(index), "].", field);
    }

    function test_contractAcceptsProofsBuiltOffchain() public {
        bytes32 root = vm.parseJsonBytes32(fixture, "$.root");
        uint256 count = vm.parseJsonUint(fixture, "$.count");
        assertGt(count, 0, "fixture is empty");

        uint256 totalCumulative;
        for (uint256 i = 0; i < count; i++) {
            totalCumulative += vm.parseJsonUint(fixture, _entryPath(i, "cumulative"));
        }

        token.mint(address(vault), totalCumulative);

        vm.prank(admin);
        vault.setMaxAllocationIncreasePerRoot(totalCumulative);

        vm.prank(keeper);
        vault.publishRoot(1, root, totalCumulative);
        vm.warp(block.timestamp + 300);

        for (uint256 i = 0; i < count; i++) {
            address account = vm.parseJsonAddress(fixture, _entryPath(i, "account"));
            uint256 cumulative = vm.parseJsonUint(fixture, _entryPath(i, "cumulative"));
            bytes32[] memory proof = vm.parseJsonBytes32Array(fixture, _entryPath(i, "proof"));

            vm.prank(account);
            vault.claim(cumulative, proof);

            assertEq(token.balanceOf(account), cumulative, "claimed amount mismatch");
        }

        assertEq(vault.totalClaimed(), totalCumulative, "not every entitlement was claimed");
        assertEq(vault.outstanding(), 0, "obligations remain after full claim");
    }

    function test_tamperedCumulativeIsRejected() public {
        bytes32 root = vm.parseJsonBytes32(fixture, "$.root");
        address account = vm.parseJsonAddress(fixture, _entryPath(0, "account"));
        uint256 cumulative = vm.parseJsonUint(fixture, _entryPath(0, "cumulative"));
        bytes32[] memory proof = vm.parseJsonBytes32Array(fixture, _entryPath(0, "proof"));

        token.mint(address(vault), 1_000e18);
        vm.prank(keeper);
        vault.publishRoot(1, root, 1_000e18);
        vm.warp(block.timestamp + 300);

        vm.prank(account);
        vm.expectRevert(RewardVault.InvalidProof.selector);
        vault.claim(cumulative + 1, proof);
    }
}
