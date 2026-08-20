// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract DeployRewardVault is Script {
    function run() external returns (RewardVault vault) {
        address token = vm.envAddress("TSLA_ADDRESS");
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address keeper = vm.envAddress("KEEPER_ADDRESS");
        uint256 cap = vm.envUint("MAX_ALLOCATION_INCREASE");

        vm.startBroadcast(vm.envUint("DEPLOYER_PRIVATE_KEY"));
        vault = new RewardVault(IERC20(token), admin, keeper, cap);
        vm.stopBroadcast();

        console.log("RewardVault:", address(vault));
        console.log("rewardToken:", token);
        console.log("admin:      ", admin);
        console.log("keeper:     ", keeper);
    }
}
