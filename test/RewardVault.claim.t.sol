// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MerkleHelper} from "./helpers/MerkleHelper.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract RewardVaultClaimTest is Test {
    RewardVault internal vault;
    MockERC20 internal token;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint256 internal constant CAP = 1_000e18;
    uint256 internal constant ALICE_CUM = 100e18;
    uint256 internal constant BOB_CUM = 50e18;

    bytes32 internal leafAlice;
    bytes32 internal leafBob;
    bytes32 internal root;

    function setUp() public {
        token = new MockERC20("Tesla Mock", "TSLA");
        vault = new RewardVault(IERC20(address(token)), admin, keeper, CAP);
        token.mint(address(vault), 1_000e18);

        leafAlice = MerkleHelper.leaf(alice, ALICE_CUM);
        leafBob = MerkleHelper.leaf(bob, BOB_CUM);
        root = MerkleHelper.pairRoot(leafAlice, leafBob);
    }

    function _proofForAlice() internal view returns (bytes32[] memory p) {
        p = new bytes32[](1);
        p[0] = leafBob;
    }

    function _publishAndMature(uint64 epoch, bytes32 r, uint256 alloc) internal {
        vm.prank(keeper);
        vault.publishRoot(epoch, r, alloc);
        vm.warp(block.timestamp + 300);
    }

    function test_claim_revertsBeforeAnyRootIsActive() public {
        vm.prank(keeper);
        vault.publishRoot(1, root, 150e18);
        bytes32[] memory p = _proofForAlice();

        vm.prank(alice);
        vm.expectRevert(RewardVault.ClaimNotOpen.selector);
        vault.claim(ALICE_CUM, p);
    }

    function test_claim_transfersAfterDelayElapses() public {
        _publishAndMature(1, root, 150e18);

        vm.prank(alice);
        vault.claim(ALICE_CUM, _proofForAlice());

        assertEq(token.balanceOf(alice), ALICE_CUM);
        assertEq(vault.claimed(alice), ALICE_CUM);
        assertEq(vault.totalClaimed(), ALICE_CUM);
        assertEq(vault.outstanding(), 50e18);
    }

    function test_claim_paysOnlyTheDeltaOnSecondRoot() public {
        _publishAndMature(1, root, 150e18);
        vm.prank(alice);
        vault.claim(ALICE_CUM, _proofForAlice());

        uint256 newAliceCum = 175e18;
        bytes32 newLeafAlice = MerkleHelper.leaf(alice, newAliceCum);
        bytes32 newRoot = MerkleHelper.pairRoot(newLeafAlice, leafBob);
        _publishAndMature(2, newRoot, 225e18);

        bytes32[] memory p = new bytes32[](1);
        p[0] = leafBob;

        vm.prank(alice);
        vault.claim(newAliceCum, p);

        assertEq(token.balanceOf(alice), newAliceCum);
        assertEq(vault.totalClaimed(), newAliceCum);
    }

    function test_claim_revertsOnInvalidProof() public {
        _publishAndMature(1, root, 150e18);
        bytes32[] memory bad = new bytes32[](1);
        bad[0] = bytes32(uint256(0xDEAD));

        vm.prank(alice);
        vm.expectRevert(RewardVault.InvalidProof.selector);
        vault.claim(ALICE_CUM, bad);
    }

    function test_claim_revertsOnRepeatWithoutNewAllocation() public {
        _publishAndMature(1, root, 150e18);
        vm.startPrank(alice);
        vault.claim(ALICE_CUM, _proofForAlice());
        vm.expectRevert(RewardVault.NothingToClaim.selector);
        vault.claim(ALICE_CUM, _proofForAlice());
        vm.stopPrank();
    }

    function test_claim_cannotUseAnotherAccountsLeaf() public {
        _publishAndMature(1, root, 150e18);
        bytes32[] memory p = new bytes32[](1);
        p[0] = leafAlice;

        // Bob supplies Alice's cumulative amount; the leaf is rebuilt from
        // msg.sender, so the proof cannot match.
        vm.prank(bob);
        vm.expectRevert(RewardVault.InvalidProof.selector);
        vault.claim(ALICE_CUM, p);
    }

    function test_publishRoot_promotesMaturedPending() public {
        _publishAndMature(1, root, 150e18);

        vm.prank(keeper);
        vault.publishRoot(2, bytes32(uint256(0xFEED)), 200e18);

        assertEq(vault.activeRoot(), root);
        assertEq(vault.activeThroughEpoch(), 1);
        assertEq(vault.pendingThroughEpoch(), 2);
    }
}
