// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {MerkleHelper} from "./helpers/MerkleHelper.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @dev Runs against a fork of Robinhood Chain mainnet with the real TSLA
///      token. Skipped automatically when the RPC is unreachable.
contract RewardVaultForkTest is Test {
    /// Canonical Tesla token on Robinhood Chain. Impostor contracts with the
    /// same name and symbol exist on this chain, so this address is pinned and
    /// never resolved by symbol.
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    RewardVault internal vault;
    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");

    bool internal forked;

    function setUp() public {
        // createSelectFork returns a fork id, so the returns clause is
        // required for the try/catch to compile.
        try vm.createSelectFork("https://rpc.mainnet.chain.robinhood.com") returns (uint256) {
            forked = true;
        } catch {
            forked = false;
            return;
        }
        vault = new RewardVault(IERC20(TSLA), admin, keeper, 100e18);
    }

    function test_fork_tslaIdentityMatchesPinnedAddress() public view {
        if (!forked) return;
        assertEq(IERC20Metadata(TSLA).symbol(), "TSLA");
        assertEq(IERC20Metadata(TSLA).decimals(), 18);
    }

    function test_fork_endToEndPublishAndClaim() public {
        if (!forked) return;

        deal(TSLA, address(vault), 10e18);

        uint256 aliceCum = 4e18;
        bytes32 leafAlice = MerkleHelper.leaf(alice, aliceCum);
        bytes32 other = MerkleHelper.leaf(makeAddr("other"), 1e18);
        bytes32 root = MerkleHelper.pairRoot(leafAlice, other);

        vm.prank(keeper);
        vault.publishRoot(1, root, 5e18);
        vm.warp(block.timestamp + 300);

        bytes32[] memory proof = new bytes32[](1);
        proof[0] = other;

        vm.prank(alice);
        vault.claim(aliceCum, proof);

        assertEq(IERC20(TSLA).balanceOf(alice), aliceCum);
        assertEq(vault.outstanding(), 1e18);
    }
}
