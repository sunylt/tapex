// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMining} from "./IMining.sol";
import {MintedToken} from "./MintedToken.sol";
import {IRewardSink} from "./IRewardSink.sol";

/// @title MinerDecomposer
/// @notice Shared redemption vault for PoD CPU NFTs.
///
///  - Anyone can `stake` a whitelisted CPU NFT. The vault escrows the NFT and
///    immediately mints `nandBurn * mult` xNAND + `latchBurn * mult` xLATCH to
///    the depositor (the price of that miner).
///  - While escrowed the vault is the NFT owner, so all mining rewards are
///    minted to the vault.
///  - Anyone holding enough xNAND/xLATCH can `redeem` any escrowed miner by
///    burning that miner's price, receiving the NFT. Redemption is
///    permissionless and not bound to the original depositor.
///  - 在押矿机产生的 BEM 留在本合约。运营把收益 claim 进本合约后，调
///    `distributeRewards()` 触发一轮分配：合约把**全部可分配余额**一次性分掉，
///    并通知质押池（XTokenStaking）当场更新所有质押者的待领取收益。用户领取时由
///    质押池调用 `payReward` 直接付给用户。已分配未领取的额度不能用 `withdraw` 拿走。
///
/// Invariants:
///  - total x-token supply == summed price of all escrowed miners.
///    This holds because x-tokens can only be minted on `stake` and only burned
///    by the decomposer itself inside `redeem` (`MintedToken.burnFrom` is minter-only).
///  - rewardToken.balanceOf(this) >= reservedRewards (已划拨的奖励永远付得出来).
contract MinerDecomposer is Ownable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    IMining public immutable mining;
    MintedToken public immutable xNand;
    MintedToken public immutable xLatch;
    /// @notice 挖矿收益代币（BEM）。矿池的收益来源，也是质押池发放的奖励。
    IERC20 public immutable rewardToken;

    mapping(address cpu => bool allowed) public cpuAllowed;

    /// @notice 被授权从本合约发放奖励的质押池（XTokenStaking）。
    address public rewardPayer;
    /// @notice 已划拨给质押池、但用户还没领走的 BEM。这部分不允许被 `withdraw` 拿走。
    uint256 public reservedRewards;

    /// @notice 单次允许释放的最大「灰尘」额度（BEM 8 位小数时 = 0.01 BEM）。
    /// 由不变量 `reservedRewards >= 用户未领总额`，剩余额度整体 ≤ 这个数时，
    /// 说明剩下的全是取整灰尘，放掉最多只影响灰尘级别的收益。
    uint256 public constant MAX_DUST_RELEASE = 1e6;

    struct Stake {
        address cpu;
        uint256 id;
        address depositor;
        uint256 nandAmount;
        uint256 latchAmount;
    }

    mapping(bytes32 key => Stake) public stakes;

    bytes32[] private _stakedKeys;
    mapping(bytes32 key => uint256 index) private _keyIndex;

    event CpuSet(address indexed cpu, bool allowed);
    event Staked(
        address indexed depositor,
        address indexed cpu,
        uint256 indexed id,
        uint256 nandAmount,
        uint256 latchAmount
    );
    event Redeemed(
        address indexed redeemer,
        address indexed cpu,
        uint256 indexed id,
        uint256 nandAmount,
        uint256 latchAmount
    );
    event Harvested(address indexed cpu, uint256 indexed id);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Rescued(address indexed cpu, uint256 indexed id, address indexed to);
    event RewardPayerSet(address indexed payer);
    event RewardsDistributed(uint256 amount);
    event RewardsReleased(uint256 amount);
    event RewardPaid(address indexed to, uint256 amount);

    error CpuNotAllowed();
    error NotCpuOwner();
    error AlreadyStaked();
    error NotStaked();
    error StakedToken();
    error NotRegisteredMiner();
    error ZeroAddress();
    error ZeroPrice();
    error NotRewardPayer();
    error InsufficientReserve();
    error ReserveNotEmpty();
    error NotAContract();
    error ReserveNotDust();
    error NothingToDistribute();

    constructor(
        address mining_,
        address xNand_,
        address xLatch_,
        address rewardToken_,
        address owner_
    ) Ownable(owner_) {
        if (
            mining_ == address(0) ||
            xNand_ == address(0) ||
            xLatch_ == address(0) ||
            rewardToken_ == address(0)
        ) {
            revert ZeroAddress();
        }
        mining = IMining(mining_);
        xNand = MintedToken(xNand_);
        xLatch = MintedToken(xLatch_);
        rewardToken = IERC20(rewardToken_);
    }

    function setCpu(address cpu, bool allowed) external onlyOwner {
        cpuAllowed[cpu] = allowed;
        emit CpuSet(cpu, allowed);
    }

    // ---------------------------------------------------------------------
    // Browse / enumerate escrowed miners (for the frontend).
    // ---------------------------------------------------------------------

    function stakedCount() external view returns (uint256) {
        return _stakedKeys.length;
    }

    function stakedAt(uint256 index) external view returns (Stake memory) {
        return stakes[_stakedKeys[index]];
    }

    // ---------------------------------------------------------------------
    // Staking / redemption.
    // ---------------------------------------------------------------------

    /// @notice Escrow a CPU NFT and mint the derived xNAND/xLATCH to the caller.
    /// The vault becomes the NFT owner, so all rewards of the escrowed miner
    /// (including anything still pending at deposit time) accrue to the vault.
    function stake(address cpu, uint256 id) external nonReentrant {
        if (!cpuAllowed[cpu]) revert CpuNotAllowed();

        bytes32 key = mining.minerKey(cpu, id);
        if (stakes[key].depositor != address(0)) revert AlreadyStaked();
        if (IERC721(cpu).ownerOf(id) != msg.sender) revert NotCpuOwner();

        IMining.Miner memory m = mining.getMiner(key);
        if (m.circuits != cpu || uint256(m.circuitId) != id) revert NotRegisteredMiner();

        uint256 nandAmount = uint256(m.nandBurn) * uint256(m.mult);
        uint256 latchAmount = uint256(m.latchBurn) * uint256(m.mult);
        // A miner worth nothing would be redeemable by anyone for free, so it
        // must never enter the vault.
        if (nandAmount == 0 && latchAmount == 0) revert ZeroPrice();

        stakes[key] = Stake({
            cpu: cpu,
            id: id,
            depositor: msg.sender,
            nandAmount: nandAmount,
            latchAmount: latchAmount
        });
        _keyIndex[key] = _stakedKeys.length;
        _stakedKeys.push(key);

        IERC721(cpu).safeTransferFrom(msg.sender, address(this), id);

        if (nandAmount != 0) xNand.mint(msg.sender, nandAmount);
        if (latchAmount != 0) xLatch.mint(msg.sender, latchAmount);

        emit Staked(msg.sender, cpu, id, nandAmount, latchAmount);
    }

    /// @notice Redeem a specific escrowed miner by burning its price in
    /// x-tokens. Permissionless: the caller only needs enough xNAND/xLATCH.
    ///
    /// Rewards accrued while the miner was escrowed belong to the vault, so the
    /// pending claim is settled *before* the NFT leaves. If that claim fails the
    /// whole redemption reverts — releasing the NFT anyway would hand those
    /// rewards to the redeemer.
    function redeem(address cpu, uint256 id) external nonReentrant {
        bytes32 key = mining.minerKey(cpu, id);
        Stake memory s = stakes[key];
        if (s.depositor == address(0)) revert NotStaked();

        mining.claim(key);

        _removeKey(key);
        delete stakes[key];

        if (s.nandAmount != 0) xNand.burnFrom(msg.sender, s.nandAmount);
        if (s.latchAmount != 0) xLatch.burnFrom(msg.sender, s.latchAmount);

        IERC721(s.cpu).safeTransferFrom(address(this), msg.sender, s.id);

        emit Redeemed(msg.sender, cpu, id, s.nandAmount, s.latchAmount);
    }

    /// @notice Permissionlessly push a still-escrowed miner's rewards into the
    /// vault (the vault is the current owner).
    function harvest(address cpu, uint256 id) external nonReentrant {
        bytes32 key = mining.minerKey(cpu, id);
        if (stakes[key].depositor == address(0)) revert NotStaked();

        mining.claim(key);
        emit Harvested(cpu, id);
    }

    // ---------------------------------------------------------------------
    // Admin.
    // ---------------------------------------------------------------------

    /// @notice Owner can move any ERC20 token (e.g. mined BEM) out of the vault.
    /// BEM 中已经划拨给质押池的部分（`reservedRewards`）动不了，否则用户 claim 会失败。
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (token == address(rewardToken)) {
            uint256 balance = rewardToken.balanceOf(address(this));
            uint256 free = balance > reservedRewards ? balance - reservedRewards : 0;
            if (amount > free) revert InsufficientReserve();
        }
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
    }

    // ---------------------------------------------------------------------
    // 质押池收益（BEM 由本合约持有，领取时直接付给用户）
    // ---------------------------------------------------------------------

    /// @notice 指定唯一可以从本合约发放奖励的质押池。
    /// 只允许在「没有未领取奖励」时切换，避免把已经划拨出去的额度带走。
    function setRewardPayer(address payer) external onlyOwner {
        if (reservedRewards != 0) revert ReserveNotEmpty();
        rewardPayer = payer;
        emit RewardPayerSet(payer);
    }

    /// @notice 触发一轮收益分配：把合约里**所有可分配**的 BEM 一次性分给当前质押者。
    ///
    /// 可分配 = `余额 − reservedRewards`。`reservedRewards` 是已经记在用户账上、
    /// 只是还没被领走的部分，再分一次等于把同一笔钱承诺两次，所以要扣掉。
    /// 分配不需要指定数量：运营把收益 claim 进本合约后，调一次本函数就全部分完。
    ///
    /// 质押池无人质押时 `notifyReward` 会 revert，整笔回滚，BEM 继续留在本合约。
    function distributeRewards() external onlyOwner nonReentrant {
        address payer = rewardPayer;
        if (payer == address(0)) revert ZeroAddress();
        // 收益接收方必须是合约：指向 EOA 的话 `notifyReward` 会「静默成功」，
        // 额度被锁死却没有任何质押者被记账。
        if (payer.code.length == 0) revert NotAContract();

        uint256 balance = rewardToken.balanceOf(address(this));
        if (balance <= reservedRewards) revert NothingToDistribute();
        uint256 amount = balance - reservedRewards;

        reservedRewards = balance; // 已分配未领取 = 全部余额
        IRewardSink(payer).notifyReward(amount);
        emit RewardsDistributed(amount);
    }

    /// @notice 用户领取时由质押池调用，BEM 直接由本合约打给用户。
    function payReward(address to, uint256 amount) external nonReentrant {
        if (msg.sender != rewardPayer) revert NotRewardPayer();
        if (to == address(0)) revert ZeroAddress();
        if (amount > reservedRewards) revert InsufficientReserve();
        reservedRewards -= amount;
        rewardToken.safeTransfer(to, amount);
        emit RewardPaid(to, amount);
    }

    /// @notice 清掉剩余的取整灰尘，让 `reservedRewards` 归零（之后才能 `setRewardPayer` 迁移）。
    ///
    /// 安全性来自不变量 `reservedRewards >= 用户未领总额`：只有在剩余额度整体
    /// ≤ `MAX_DUST_RELEASE` 时才允许调用，所以最多只可能让灰尘级别的收益领不出来，
    /// **永远动不了用户真正应得的奖励**。额度还大就 revert。
    function releaseRewardReserve() external onlyOwner {
        uint256 dust = reservedRewards;
        if (dust > MAX_DUST_RELEASE) revert ReserveNotDust();
        reservedRewards = 0;
        emit RewardsReleased(dust);
    }

    /// @notice Recover a CPU NFT that was sent to this vault outside of `stake`.
    /// Escrowed NFTs (with a live record) can never be rescued.
    function rescueERC721(address cpu, uint256 id, address to) external onlyOwner nonReentrant {
        bytes32 key = mining.minerKey(cpu, id);
        if (stakes[key].depositor != address(0)) revert StakedToken();
        IERC721(cpu).safeTransferFrom(address(this), to, id);
        emit Rescued(cpu, id, to);
    }

    function onERC721Received(
        address,
        address,
        uint256,
        bytes calldata
    ) external pure override returns (bytes4) {
        return IERC721Receiver.onERC721Received.selector;
    }

    // ---------------------------------------------------------------------
    // Internal.
    // ---------------------------------------------------------------------

    function _removeKey(bytes32 key) private {
        uint256 idx = _keyIndex[key];
        uint256 last = _stakedKeys.length - 1;
        if (idx != last) {
            bytes32 lastKey = _stakedKeys[last];
            _stakedKeys[idx] = lastKey;
            _keyIndex[lastKey] = idx;
        }
        _stakedKeys.pop();
        delete _keyIndex[key];
    }
}
