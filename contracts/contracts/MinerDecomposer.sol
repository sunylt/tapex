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
///  - 在押矿机产生的 BEM 留在本合约。owner 通过 `reserveRewards` 把额度划拨给
///    质押池（XTokenStaking），用户领取时由质押池调用 `payReward` 直接付给用户。
///    已划拨的额度不能用 `withdraw` 拿走。
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
    event RewardsReserved(uint256 amount);
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
    error ZeroAmount();
    error NotRewardPayer();
    error InsufficientReserve();
    error ReserveNotEmpty();

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

    /// @notice 质押池划拨一轮奖励额度：只记账，BEM 留在本合约。
    /// 必须确保余额能覆盖「已划拨 + 本次」，否则后面用户 claim 会付不出来。
    function reserveRewards(uint256 amount) external nonReentrant {
        if (msg.sender != rewardPayer) revert NotRewardPayer();
        if (amount == 0) revert ZeroAmount();
        if (rewardToken.balanceOf(address(this)) < reservedRewards + amount) {
            revert InsufficientReserve();
        }
        reservedRewards += amount;
        emit RewardsReserved(amount);
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

    /// @notice 释放一部分划拨额度（退回「可 withdraw」状态）。
    /// 取整会在 `reservedRewards` 里留下几 wei 灰尘，不清掉的话 `setRewardPayer` 永远无法执行。
    /// 只能在确认没有未领取奖励时调用；随意调用会让质押池付不出用户应得的钱。
    function releaseRewardReserve(uint256 amount) external onlyOwner {
        if (amount > reservedRewards) revert InsufficientReserve();
        reservedRewards -= amount;
        emit RewardsReleased(amount);
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
