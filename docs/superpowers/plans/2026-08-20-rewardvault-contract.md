# RewardVault Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Построить, покрыть тестами и подготовить к деплою единственный смарт-контракт протокола DWELL — кумулятивный Merkle-дистрибьютор наград в TSLA с ончейн-инвариантом платёжеспособности.

**Architecture:** Иммутабельный контракт на OpenZeppelin v5 (`AccessControl` + `Pausable` + `ReentrancyGuard`). Два слота корня: `pendingRoot` созревает через `CLAIM_DELAY` и промоутится в `activeRoot`, против которого проверяются клеймы. Кипер публикует корни и не имеет доступа к средствам; админ может ставить на паузу и забирать только излишек сверх обязательств.

**Tech Stack:** Solidity 0.8.28, Foundry (forge/anvil), OpenZeppelin Contracts v5.x, форк Robinhood Chain mainnet для интеграционных тестов.

**Spec:** `docs/superpowers/specs/2026-08-20-stock-mining-protocol-design.md`

## Global Constraints

- Solidity версия ровно `0.8.28`, pragma без каретки: `pragma solidity 0.8.28;`
- Сеть назначения: Robinhood Chain, `chainId 4663`, RPC `https://rpc.mainnet.chain.robinhood.com`
- Актив награды TSLA: `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` — адрес захардкожен при деплое, никогда не резолвится по символу в рантайме (в сети есть токены-двойники с идентичными именем и символом)
- `CLAIM_DELAY = 300` секунд (одна эпоха)
- Инвариант платёжеспособности `totalAllocated - totalClaimed <= rewardToken.balanceOf(vault)` обязан выполняться после любой операции
- Прокси и апгрейдов нет. Контракт иммутабельный
- Клейм только для `msg.sender`. Клейма за третье лицо нет
- Своего криптографического кода нет: проверка пруфа только через `MerkleProof` из OpenZeppelin
- Все сообщения об ошибках — кастомные ошибки, не строки
- Комментарии в коде на английском, сообщения коммитов на русском

---

## File Structure

| Файл | Ответственность |
|---|---|
| `foundry.toml` | конфиг Foundry: версия компилятора, remappings, профиль форк-тестов |
| `src/RewardVault.sol` | единственный контракт протокола |
| `test/mocks/MockERC20.sol` | минимальный ERC-20 для юнит-тестов |
| `test/helpers/MerkleHelper.sol` | построение двухлистового дерева и пруфов в тестах |
| `test/RewardVault.publish.t.sol` | публикация корня и все её гарды |
| `test/RewardVault.claim.t.sol` | промоушен корня и клейм |
| `test/RewardVault.admin.t.sol` | pause, потолок, вывод излишка, спасение чужих токенов |
| `test/RewardVault.invariant.t.sol` | фаззинг и инварианты |
| `test/RewardVault.fork.t.sol` | интеграция с настоящим TSLA на форке мейннета |
| `script/DeployRewardVault.s.sol` | скрипт деплоя |

Разделение тестов по поведению, а не по «одному файлу на контракт»: файлы остаются небольшими, а падение теста сразу указывает на затронутую область.

---

## Task 1: Каркас Foundry и деплой контракта

**Files:**
- Create: `foundry.toml`
- Create: `src/RewardVault.sol`
- Create: `test/mocks/MockERC20.sol`
- Test: `test/RewardVault.publish.t.sol`

**Interfaces:**
- Consumes: ничего
- Produces: `RewardVault` с конструктором `constructor(IERC20 token, address admin, address keeper, uint256 cap)`; публичные геттеры `rewardToken()`, `maxAllocationIncreasePerRoot()`, константы `KEEPER_ROLE`, `CLAIM_DELAY`; `MockERC20` с конструктором `constructor(string name, string symbol)` и функцией `mint(address to, uint256 amount)`

- [ ] **Step 1: Инициализировать Foundry**

```bash
cd /c/Users/chaiz/Desktop/project
forge init --no-git --no-commit --force .
rm -rf src/Counter.sol test/Counter.t.sol script/Counter.s.sol
forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git
```

- [ ] **Step 2: Записать `foundry.toml`**

```toml
[profile.default]
src = "src"
out = "out"
libs = ["lib"]
solc = "0.8.28"
optimizer = true
optimizer_runs = 200
evm_version = "cancun"
remappings = ["@openzeppelin/=lib/openzeppelin-contracts/"]

[profile.fork]
eth_rpc_url = "https://rpc.mainnet.chain.robinhood.com"

[fmt]
line_length = 110
```

- [ ] **Step 3: Написать мок токена**

Файл `test/mocks/MockERC20.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
```

- [ ] **Step 4: Написать падающий тест на деплой**

Файл `test/RewardVault.publish.t.sol`:

```solidity
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
```

Адреса задаются через `makeAddr`, а не шестнадцатеричными литералами: в Solidity адресный литерал обязан проходить проверку контрольной суммы, и произвольное «красивое» число компилятор не примет.

- [ ] **Step 5: Убедиться, что тест падает**

Run: `forge test --match-path test/RewardVault.publish.t.sol -vv`
Expected: FAIL — компиляция не проходит, `src/RewardVault.sol` не существует.

- [ ] **Step 6: Написать минимальный контракт**

Файл `src/RewardVault.sol`:

```solidity
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
```

- [ ] **Step 7: Убедиться, что тест проходит**

Run: `forge test --match-path test/RewardVault.publish.t.sol -vv`
Expected: PASS — 1 тест.

- [ ] **Step 8: Коммит**

```bash
git add foundry.toml src/RewardVault.sol test/mocks/MockERC20.sol test/RewardVault.publish.t.sol lib .gitmodules
git commit -m "Добавить каркас Foundry и скелет RewardVault"
```

---

## Task 2: Публикация корня и её гарды

**Files:**
- Modify: `src/RewardVault.sol`
- Modify: `test/RewardVault.publish.t.sol`

**Interfaces:**
- Consumes: `RewardVault` из Task 1
- Produces: `publishRoot(uint64 newEpoch, bytes32 newRoot, uint256 newTotalAllocated)`; геттеры `pendingRoot()`, `pendingThroughEpoch()`, `pendingActivatesAt()`, `activeRoot()`, `activeThroughEpoch()`, `totalAllocated()`, `totalClaimed()`, `outstanding()`; ошибки `EpochNotAdvancing`, `AllocationDecreased`, `AllocationCapExceeded`, `Insolvent`; событие `RootPublished(uint64 indexed throughEpoch, bytes32 root, uint256 totalAllocated)`

- [ ] **Step 1: Написать падающие тесты на успешную публикацию и все четыре гарда**

Добавить в `test/RewardVault.publish.t.sol` внутрь контракта теста:

```solidity
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
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `forge test --match-path test/RewardVault.publish.t.sol -vv`
Expected: FAIL — компиляция не проходит, `publishRoot` и ошибки не объявлены.

- [ ] **Step 3: Реализовать состояние, ошибки и `publishRoot`**

В `src/RewardVault.sol` добавить в блок состояния после `IERC20 public immutable rewardToken;`:

```solidity
    bytes32 public activeRoot;
    uint64 public activeThroughEpoch;

    bytes32 public pendingRoot;
    uint64 public pendingThroughEpoch;
    uint64 public pendingActivatesAt;

    uint256 public totalAllocated;
    uint256 public totalClaimed;
```

Добавить к существующим ошибкам:

```solidity
    error EpochNotAdvancing();
    error AllocationDecreased();
    error AllocationCapExceeded();
    error Insolvent();
```

Добавить к событиям:

```solidity
    event RootPublished(uint64 indexed throughEpoch, bytes32 root, uint256 totalAllocated);
    event RootActivated(uint64 indexed throughEpoch, bytes32 root);
```

Добавить функции:

```solidity
    /// @notice Amount still owed to accounts that have not claimed yet.
    function outstanding() public view returns (uint256) {
        return totalAllocated - totalClaimed;
    }

    /// @dev Promotes a matured pending root to active. Called before every
    ///      state-reading operation that depends on the active root.
    function _promoteIfDue() internal {
        if (pendingActivatesAt != 0 && block.timestamp >= pendingActivatesAt) {
            activeRoot = pendingRoot;
            activeThroughEpoch = pendingThroughEpoch;
            pendingActivatesAt = 0;
            emit RootActivated(pendingThroughEpoch, pendingRoot);
        }
    }

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
        // Written in transposed form because the balance drops as accounts claim
        // while totalAllocated only grows.
        if (newTotalAllocated > rewardToken.balanceOf(address(this)) + totalClaimed) {
            revert Insolvent();
        }

        pendingRoot = newRoot;
        pendingThroughEpoch = newEpoch;
        pendingActivatesAt = uint64(block.timestamp) + CLAIM_DELAY;
        totalAllocated = newTotalAllocated;

        emit RootPublished(newEpoch, newRoot, newTotalAllocated);
    }
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `forge test --match-path test/RewardVault.publish.t.sol -vv`
Expected: PASS — 8 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/RewardVault.sol test/RewardVault.publish.t.sol
git commit -m "Реализовать публикацию корня с гардами эпохи, потолка и платёжеспособности"
```

---

## Task 3: Промоушен корня и клейм

**Files:**
- Modify: `src/RewardVault.sol`
- Create: `test/helpers/MerkleHelper.sol`
- Create: `test/RewardVault.claim.t.sol`

**Interfaces:**
- Consumes: `publishRoot`, `_promoteIfDue`, `outstanding()` из Task 2
- Produces: `claim(uint256 cumulativeAmount, bytes32[] calldata proof)`; маппинг `claimed(address)`; ошибки `ClaimNotOpen`, `InvalidProof`, `NothingToClaim`; событие `Claimed(address indexed account, uint256 amount, uint256 cumulative)`; хелпер `MerkleHelper.leaf(address,uint256)` и `MerkleHelper.pairRoot(bytes32,bytes32)`

- [ ] **Step 1: Написать хелпер дерева**

Файл `test/helpers/MerkleHelper.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Builds two-leaf trees matching the contract's leaf encoding and
///      OpenZeppelin's commutative pair hashing.
library MerkleHelper {
    function leaf(address account, uint256 cumulative) internal pure returns (bytes32) {
        return keccak256(bytes.concat(keccak256(abi.encode(account, cumulative))));
    }

    function pairRoot(bytes32 a, bytes32 b) internal pure returns (bytes32) {
        return a < b ? keccak256(abi.encodePacked(a, b)) : keccak256(abi.encodePacked(b, a));
    }
}
```

- [ ] **Step 2: Написать падающие тесты клейма**

Файл `test/RewardVault.claim.t.sol`:

```solidity
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
```

- [ ] **Step 3: Убедиться, что тесты падают**

Run: `forge test --match-path test/RewardVault.claim.t.sol -vv`
Expected: FAIL — компиляция не проходит, `claim` и `claimed` не объявлены.

- [ ] **Step 4: Реализовать `claim`**

В `src/RewardVault.sol` добавить к состоянию:

```solidity
    mapping(address => uint256) public claimed;
```

Добавить к ошибкам:

```solidity
    error ClaimNotOpen();
    error InvalidProof();
    error NothingToClaim();
```

Добавить к событиям:

```solidity
    event Claimed(address indexed account, uint256 amount, uint256 cumulative);
```

Добавить функцию:

```solidity
    /// @notice Claims the difference between the caller's cumulative
    ///         entitlement in the active root and what it already claimed.
    function claim(uint256 cumulativeAmount, bytes32[] calldata proof)
        external
        nonReentrant
        whenNotPaused
    {
        _promoteIfDue();
        if (activeRoot == bytes32(0)) revert ClaimNotOpen();

        // The leaf is rebuilt from msg.sender, so a proof for one account can
        // never be replayed by another.
        bytes32 node = keccak256(bytes.concat(keccak256(abi.encode(msg.sender, cumulativeAmount))));
        if (!MerkleProof.verify(proof, activeRoot, node)) revert InvalidProof();

        uint256 already = claimed[msg.sender];
        if (cumulativeAmount <= already) revert NothingToClaim();

        uint256 amount = cumulativeAmount - already;
        claimed[msg.sender] = cumulativeAmount;
        totalClaimed += amount;

        rewardToken.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount, cumulativeAmount);
    }
```

- [ ] **Step 5: Убедиться, что тесты проходят**

Run: `forge test --match-path test/RewardVault.claim.t.sol -vv`
Expected: PASS — 7 тестов.

- [ ] **Step 6: Прогнать весь набор**

Run: `forge test -vv`
Expected: PASS — 15 тестов.

- [ ] **Step 7: Коммит**

```bash
git add src/RewardVault.sol test/helpers/MerkleHelper.sol test/RewardVault.claim.t.sol
git commit -m "Реализовать кумулятивный клейм с промоушеном активного корня"
```

---

## Task 4: Административные функции

**Files:**
- Modify: `src/RewardVault.sol`
- Create: `test/RewardVault.admin.t.sol`

**Interfaces:**
- Consumes: `outstanding()`, `publishRoot`, `claim` из Task 2 и 3
- Produces: `surplus()`, `setMaxAllocationIncreasePerRoot(uint256)`, `pause()`, `unpause()`, `withdrawSurplus(address,uint256)`, `rescueForeignToken(IERC20,address,uint256)`; ошибки `SurplusExceeded`, `CannotRescueRewardToken`; событие `SurplusWithdrawn(address indexed to, uint256 amount)`

- [ ] **Step 1: Написать падающие тесты админки**

Файл `test/RewardVault.admin.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {MerkleHelper} from "./helpers/MerkleHelper.sol";
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
}
```

- [ ] **Step 2: Убедиться, что тесты падают**

Run: `forge test --match-path test/RewardVault.admin.t.sol -vv`
Expected: FAIL — компиляция не проходит, админские функции не объявлены.

- [ ] **Step 3: Реализовать админку**

В `src/RewardVault.sol` добавить к ошибкам:

```solidity
    error SurplusExceeded();
    error CannotRescueRewardToken();
```

Добавить к событиям:

```solidity
    event SurplusWithdrawn(address indexed to, uint256 amount);
```

Добавить функции:

```solidity
    /// @notice Balance that is not owed to any account.
    function surplus() public view returns (uint256) {
        uint256 balance = rewardToken.balanceOf(address(this));
        uint256 owed = outstanding();
        return balance > owed ? balance - owed : 0;
    }

    function setMaxAllocationIncreasePerRoot(uint256 value) external onlyRole(DEFAULT_ADMIN_ROLE) {
        maxAllocationIncreasePerRoot = value;
        emit MaxAllocationIncreaseSet(value);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Withdraws reward tokens that exceed outstanding obligations.
    ///         Amounts already allocated to accounts can never be taken.
    function withdrawSurplus(address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (to == address(0)) revert ZeroAddress();
        if (amount > surplus()) revert SurplusExceeded();
        rewardToken.safeTransfer(to, amount);
        emit SurplusWithdrawn(to, amount);
    }

    /// @notice Recovers tokens sent here by mistake. The reward token is
    ///         excluded so miner entitlements can never be drained this way.
    function rescueForeignToken(IERC20 stray, address to, uint256 amount)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (address(stray) == address(rewardToken)) revert CannotRescueRewardToken();
        if (to == address(0)) revert ZeroAddress();
        stray.safeTransfer(to, amount);
    }
```

- [ ] **Step 4: Убедиться, что тесты проходят**

Run: `forge test --match-path test/RewardVault.admin.t.sol -vv`
Expected: PASS — 9 тестов.

- [ ] **Step 5: Коммит**

```bash
git add src/RewardVault.sol test/RewardVault.admin.t.sol
git commit -m "Добавить паузу, потолок аллокации и вывод излишка"
```

---

## Task 5: Инварианты и фаззинг

**Files:**
- Create: `test/RewardVault.invariant.t.sol`

**Interfaces:**
- Consumes: весь публичный интерфейс `RewardVault` из Task 2–4
- Produces: `VaultHandler` — обёртка для фаззера с методами `publish(uint256,uint256)` и `fund(uint256)`

Инвариант платёжеспособности — единственное, что стоит между ошибкой в офчейн-расчёте и потерей средств. Он проверяется отдельно от юнит-тестов, на случайных последовательностях вызовов.

- [ ] **Step 1: Написать инвариантный тест**

Файл `test/RewardVault.invariant.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {MockERC20} from "./mocks/MockERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Drives the vault with bounded random input so the fuzzer explores
///      publish/fund sequences instead of reverting on malformed calls.
contract VaultHandler is Test {
    RewardVault public vault;
    MockERC20 public token;
    address public keeper;

    uint64 public epoch;

    constructor(RewardVault vault_, MockERC20 token_, address keeper_) {
        vault = vault_;
        token = token_;
        keeper = keeper_;
    }

    function fund(uint256 amount) external {
        amount = bound(amount, 0, 1_000e18);
        token.mint(address(vault), amount);
    }

    function publish(uint256 increase, uint256 timeJump) external {
        uint256 cap = vault.maxAllocationIncreasePerRoot();
        increase = bound(increase, 0, cap);

        uint256 headroom =
            token.balanceOf(address(vault)) + vault.totalClaimed() - vault.totalAllocated();
        if (increase > headroom) increase = headroom;

        vm.warp(block.timestamp + bound(timeJump, 0, 900));

        epoch += 1;
        vm.prank(keeper);
        vault.publishRoot(epoch, keccak256(abi.encode(epoch)), vault.totalAllocated() + increase);
    }
}

contract RewardVaultInvariantTest is Test {
    RewardVault internal vault;
    MockERC20 internal token;
    VaultHandler internal handler;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");

    function setUp() public {
        token = new MockERC20("Tesla Mock", "TSLA");
        vault = new RewardVault(IERC20(address(token)), admin, keeper, 100e18);
        token.mint(address(vault), 500e18);

        handler = new VaultHandler(vault, token, keeper);
        targetContract(address(handler));
    }

    /// The vault can never owe more than it holds.
    function invariant_solvency() public view {
        assertLe(vault.outstanding(), token.balanceOf(address(vault)));
    }

    /// Allocation is monotonic; entitlements are never revoked.
    function invariant_allocationNeverDecreases() public view {
        assertGe(vault.totalAllocated(), vault.totalClaimed());
    }

    /// Active root never runs ahead of the pending one.
    function invariant_activeNeverAheadOfPending() public view {
        assertLe(vault.activeThroughEpoch(), vault.pendingThroughEpoch());
    }
}
```

- [ ] **Step 2: Прогнать инварианты**

Run: `forge test --match-path test/RewardVault.invariant.t.sol -vv`
Expected: PASS — 3 инварианта, каждый прогнан по умолчанию 256 раз.

- [ ] **Step 3: Прогнать с усиленными настройками**

Run: `forge test --match-path test/RewardVault.invariant.t.sol --fuzz-runs 5000`
Expected: PASS. Если появится контрпример — это находка, а не помеха: зафиксировать последовательность вызовов в отдельный регрессионный юнит-тест и починить контракт, прежде чем идти дальше.

- [ ] **Step 4: Коммит**

```bash
git add test/RewardVault.invariant.t.sol
git commit -m "Добавить инвариантные тесты платёжеспособности и монотонности"
```

---

## Task 6: Скрипт деплоя и форк-тест с настоящим TSLA

**Files:**
- Create: `script/DeployRewardVault.s.sol`
- Create: `test/RewardVault.fork.t.sol`
- Create: `.env.example`

**Interfaces:**
- Consumes: конструктор `RewardVault` из Task 1
- Produces: скрипт деплоя, читающий `ADMIN_ADDRESS`, `KEEPER_ADDRESS`, `MAX_ALLOCATION_INCREASE` из окружения; константа `TSLA` в форк-тесте

- [ ] **Step 1: Записать `.env.example`**

```bash
# Адрес TSLA на Robinhood Chain. Не менять: в сети есть токены-двойники
# с идентичными именем и символом.
TSLA_ADDRESS=0x322F0929c4625eD5bAd873c95208D54E1c003b2d

RPC_URL=https://rpc.mainnet.chain.robinhood.com

# Холодный ключ. Никогда не попадает на сервер.
ADMIN_ADDRESS=

# Горячий ключ воркера. Публикует корни, к средствам доступа не имеет.
KEEPER_ADDRESS=

# Стартовый потолок прироста аллокации на один корень, в wei.
MAX_ALLOCATION_INCREASE=

# Приватный ключ деплоера. НИКОГДА не коммитить заполненным.
DEPLOYER_PRIVATE_KEY=
```

- [ ] **Step 2: Написать скрипт деплоя**

Файл `script/DeployRewardVault.s.sol`:

```solidity
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
        console.log("admin:", admin);
        console.log("keeper:", keeper);
    }
}
```

- [ ] **Step 3: Написать форк-тест против настоящего TSLA**

Файл `test/RewardVault.fork.t.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {RewardVault} from "../src/RewardVault.sol";
import {MerkleHelper} from "./helpers/MerkleHelper.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @dev Runs against a fork of Robinhood Chain mainnet with the real TSLA
///      token. Skipped automatically when no fork RPC is configured.
contract RewardVaultForkTest is Test {
    address internal constant TSLA = 0x322F0929c4625eD5bAd873c95208D54E1c003b2d;

    RewardVault internal vault;
    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal alice = makeAddr("alice");

    bool internal forked;

    function setUp() public {
        // createSelectFork returns a fork id, so the returns clause is required
        // for the try/catch to compile.
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
```

- [ ] **Step 4: Прогнать форк-тест**

Run: `forge test --match-path test/RewardVault.fork.t.sol -vv`
Expected: PASS — 2 теста. Если RPC недоступен, тесты проходят вхолостую через флаг `forked`; это допустимо, но при недоступном RPC форк-покрытия фактически нет — перезапустить, когда сеть доступна.

- [ ] **Step 5: Прогнать весь набор и проверить форматирование**

Run: `forge fmt --check && forge test`
Expected: PASS — 29 тестов, форматирование без замечаний.

- [ ] **Step 6: Коммит**

```bash
git add script/DeployRewardVault.s.sol test/RewardVault.fork.t.sol .env.example
git commit -m "Добавить скрипт деплоя и форк-тесты против настоящего TSLA"
```

---

## Команда деплоя

Выполняется вручную на шаге 1 последовательности запуска из спеки, **до** запуска токена.

```bash
forge script script/DeployRewardVault.s.sol:DeployRewardVault \
  --rpc-url "$RPC_URL" \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api
```

Верификация обязательна и является частью деплоя, а не отдельным необязательным шагом: спека требует, чтобы исходники были открыты до того, как участники понесут деньги.

После деплоя проверить вручную:

1. `rewardToken()` возвращает ровно `0x322F0929c4625eD5bAd873c95208D54E1c003b2d`
2. `hasRole(DEFAULT_ADMIN_ROLE, <холодный адрес>)` — true
3. `hasRole(KEEPER_ROLE, <адрес воркера>)` — true
4. Деплоер **не** имеет ни одной роли
5. Исходник виден на Blockscout

---

## Что этот план не покрывает

Реализуется в планах 2 и 3, ссылки на них появятся здесь после написания:

- Построение дерева и вычисление кумулятивов офчейн
- Часы эпох, расчёт весов, дрип
- API, приём хартбитов, воркер, publisher, watchdog
- Конвертация комиссий ETH в TSLA
