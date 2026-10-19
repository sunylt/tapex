// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IRewardSource} from "./IRewardSource.sol";

/// @title XTokenStaking
/// @notice xNAND / xLATCH 质押池：按权重份额分 BEM 收益（即时累加模型）。
///
/// 设计要点
///  - 一个池子同时接受 xNAND 与 xLATCH，两者各自有可配置权重（默认 1:1）。
///    用户权重 = Σ(质押量 × 该代币权重)，收益按 `用户权重 / 总权重` 分配。
///  - 收益用累加器（`rewardPerWeightStored`）实现：O(1) 更新、O(1) 领取，
///    任意多人、任意次存取都不会算错。
///  - **奖励即时分配，不按时间线性释放**：矿池（`IRewardSource`）每触发一次
///    `notifyReward(amount)`，全局指数立刻 += `amount / 总权重`，所有质押者的
///    待领取收益在同一个区块内瞬间更新。谁能拿到这笔奖励，取决于触发那一刻
///    谁在质押；没人质押时矿池无法触发（`NoStakers`）。
///  - **奖励不进入本合约**：BEM 一直留在矿池里。用户 `claim` 时由本合约调用
///    `pool.payReward()`，矿池直接把 BEM 打给用户。本合约只负责记账。
///  - `notifyReward` 只能由矿池调用：额度由矿池侧在触发时锁定，矿池负责保证
///    这些钱始终付得出来。
///  - 质押的 xNAND / xLATCH **永远不可被 owner 取走**。
///
/// 注意：合约不做任何 xNAND / xLATCH 的铸造或销毁，只负责托管与分配。
contract XTokenStaking is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    /// @dev 权重与累加器的定点精度。
    uint256 private constant PRECISION = 1e18;

    IERC20 public immutable xNand;
    IERC20 public immutable xLatch;
    /// @notice 收益来源（矿池）：产生并持有 BEM，领取时负责打款。
    IRewardSource public immutable pool;

    /// @notice 每个 xNAND / xLATCH 的权重，1e18 == 1.0。
    uint256 public nandWeight = PRECISION;
    uint256 public latchWeight = PRECISION;

    /// @notice 累计到「每单位权重」的奖励，1e18 精度。
    uint256 public rewardPerWeightStored;
    uint256 public totalWeight;

    uint256 public totalNandStaked;
    uint256 public totalLatchStaked;

    struct Account {
        uint256 nand;
        uint256 latch;
        uint256 weight;
        uint256 rewardPerWeightPaid;
        uint256 rewards;
    }

    mapping(address account => Account) public accounts;

    event Staked(address indexed account, address indexed token, uint256 amount, uint256 weight);
    event Unstaked(address indexed account, address indexed token, uint256 amount, uint256 weight);
    event RewardPaid(address indexed account, uint256 amount);
    event RewardAdded(uint256 amount, uint256 rewardPerWeight);
    event WeightsUpdated(uint256 nandWeight, uint256 latchWeight);
    event Recovered(address indexed token, address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error TokenNotAllowed();
    error NothingToClaim();
    error InsufficientStake();
    error ProtectedToken();
    error WeightsLockedWhileStaked();
    error NotAContract();
    error NotRewardSource();
    error NoStakers();
    error InvalidWeight();

    constructor(
        address xNand_,
        address xLatch_,
        address pool_,
        address owner_
    ) Ownable(owner_) {
        if (xNand_ == address(0) || xLatch_ == address(0) || pool_ == address(0)) {
            revert ZeroAddress();
        }
        // 收益来源必须真的能应答 `payReward`：指向 EOA 的话调用会「静默成功」，
        // 用户收益被清零却一分钱没收到。
        if (pool_.code.length == 0) revert NotAContract();
        xNand = IERC20(xNand_);
        xLatch = IERC20(xLatch_);
        pool = IRewardSource(pool_);
    }

    /// @notice 奖励代币地址（从矿池透传，方便前端展示）。
    function rewardToken() external view returns (address) {
        return pool.rewardToken();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    /// @notice 某地址当前可领取的收益。
    function earned(address account) public view returns (uint256) {
        Account storage a = accounts[account];
        return
            (a.weight * (rewardPerWeightStored - a.rewardPerWeightPaid)) / PRECISION +
            a.rewards;
    }

    function stakedOf(address account) external view returns (uint256 nand, uint256 latch) {
        Account storage a = accounts[account];
        return (a.nand, a.latch);
    }

    function totalStaked() external view returns (uint256 nand, uint256 latch) {
        return (totalNandStaked, totalLatchStaked);
    }

    // ---------------------------------------------------------------------
    // Staking
    // ---------------------------------------------------------------------

    modifier updateReward(address account) {
        if (account != address(0)) {
            Account storage a = accounts[account];
            a.rewards = earned(account);
            a.rewardPerWeightPaid = rewardPerWeightStored;
        }
        _;
    }

    /// @notice 质押 xNAND 或 xLATCH。`token` 必须是两个质押代币之一。
    function stake(address token, uint256 amount) external nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        uint256 weight = _weightOf(token, amount);

        Account storage a = accounts[msg.sender];
        if (token == address(xNand)) {
            a.nand += amount;
            totalNandStaked += amount;
        } else if (token == address(xLatch)) {
            a.latch += amount;
            totalLatchStaked += amount;
        } else {
            revert TokenNotAllowed();
        }
        a.weight += weight;
        totalWeight += weight;

        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, token, amount, weight);
    }

    /// @notice 解押，随时可提，没有锁仓与冷却期。
    function unstake(
        address token,
        uint256 amount
    ) external nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        uint256 weight = _weightOf(token, amount);

        Account storage a = accounts[msg.sender];
        if (token == address(xNand)) {
            if (amount > a.nand) revert InsufficientStake();
            a.nand -= amount;
            totalNandStaked -= amount;
        } else if (token == address(xLatch)) {
            if (amount > a.latch) revert InsufficientStake();
            a.latch -= amount;
            totalLatchStaked -= amount;
        } else {
            revert TokenNotAllowed();
        }
        a.weight -= weight;
        totalWeight -= weight;

        IERC20(token).safeTransfer(msg.sender, amount);
        emit Unstaked(msg.sender, token, amount, weight);
    }

    /// @notice 领取 BEM 收益：先结算，再让矿池把这笔 BEM 直接打给用户。
    function claim() public nonReentrant updateReward(msg.sender) {
        uint256 reward = accounts[msg.sender].rewards;
        if (reward == 0) revert NothingToClaim();
        accounts[msg.sender].rewards = 0;
        pool.payReward(msg.sender, reward);
        emit RewardPaid(msg.sender, reward);
    }

    /// @notice 解押全部 + 领取收益。没有质押 / 没有收益时也不会 revert。
    /// 收益付不出来**不能挡住本金**：`payReward` 失败时把收益留在账上，用户之后还能单独 claim。
    function exit() external nonReentrant updateReward(msg.sender) {
        Account storage a = accounts[msg.sender];

        uint256 nandAmount = a.nand;
        if (nandAmount != 0) {
            uint256 weight = nandAmount * nandWeight;
            a.nand = 0;
            a.weight -= weight;
            totalNandStaked -= nandAmount;
            totalWeight -= weight;
            xNand.safeTransfer(msg.sender, nandAmount);
            emit Unstaked(msg.sender, address(xNand), nandAmount, weight);
        }

        uint256 latchAmount = a.latch;
        if (latchAmount != 0) {
            uint256 weight = latchAmount * latchWeight;
            a.latch = 0;
            a.weight -= weight;
            totalLatchStaked -= latchAmount;
            totalWeight -= weight;
            xLatch.safeTransfer(msg.sender, latchAmount);
            emit Unstaked(msg.sender, address(xLatch), latchAmount, weight);
        }

        uint256 reward = a.rewards;
        if (reward != 0) {
            a.rewards = 0;
            try pool.payReward(msg.sender, reward) {
                emit RewardPaid(msg.sender, reward);
            } catch {
                a.rewards = reward;
            }
        }
    }

    // ---------------------------------------------------------------------
    // Rewards / admin
    // ---------------------------------------------------------------------

    /// @notice 矿池触发一轮收益分配：把这个 `amount` 立刻按当前权重摊到所有质押者头上。
    /// 只有矿池可以调用；矿池在调用前已经把这笔 BEM 锁定（保证付得出来）。
    /// 没有人在质押时不能触发——否则这笔奖励无从分配，矿池继续持有着即可。
    function notifyReward(uint256 amount) external {
        if (msg.sender != address(pool)) revert NotRewardSource();
        if (amount == 0) revert ZeroAmount();
        if (totalWeight == 0) revert NoStakers();

        rewardPerWeightStored += (amount * PRECISION) / totalWeight;
        emit RewardAdded(amount, rewardPerWeightStored);
    }

    /// @notice 调整两个质押代币的权重。
    /// 只允许在池子里没有任何质押时修改：用户权重是「质押量 × 当时权重」算出来的，
    /// 质押期间改权重会让 `totalWeight` 与个人权重对不上（早晚解押的人会算错账）。
    /// 权重不能为 0：否则质押该代币的人权重为 0，`totalWeight` 可能恒为 0，
    /// `notifyReward` 会一直 `NoStakers`，奖励永远分不出去。
    function setWeights(uint256 nandWeight_, uint256 latchWeight_) external onlyOwner {
        if (totalWeight != 0) revert WeightsLockedWhileStaked();
        if (nandWeight_ == 0 || latchWeight_ == 0) revert InvalidWeight();
        nandWeight = nandWeight_;
        latchWeight = latchWeight_;
        emit WeightsUpdated(nandWeight_, latchWeight_);
    }

    /// @notice 回收误转入的其他代币。
    /// xNAND / xLATCH（用户本金）在保护名单里，永远不可取。
    /// 奖励代币（BEM）不在保护名单：本合约按设计不持有奖励，误转进来的可以直接取走或转给矿池。
    function recoverERC20(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(xNand) || token == address(xLatch)) {
            revert ProtectedToken();
        }
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit Recovered(token, to, amount);
    }

    // ---------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------

    function _weightOf(address token, uint256 amount) private view returns (uint256) {
        if (token == address(xNand)) return amount * nandWeight;
        if (token == address(xLatch)) return amount * latchWeight;
        revert TokenNotAllowed();
    }
}
