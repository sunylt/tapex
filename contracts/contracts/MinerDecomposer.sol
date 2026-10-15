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
///
/// Invariant: total x-token supply == summed price of all escrowed miners.
contract MinerDecomposer is Ownable, ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    IMining public immutable mining;
    MintedToken public immutable xNand;
    MintedToken public immutable xLatch;

    mapping(address cpu => bool allowed) public cpuAllowed;

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

    error CpuNotAllowed();
    error NotCpuOwner();
    error AlreadyStaked();
    error NotStaked();
    error StakedToken();
    error NotRegisteredMiner();
    error ZeroAddress();

    constructor(
        address mining_,
        address xNand_,
        address xLatch_,
        address owner_
    ) Ownable(owner_) {
        if (mining_ == address(0) || xNand_ == address(0) || xLatch_ == address(0)) {
            revert ZeroAddress();
        }
        mining = IMining(mining_);
        xNand = MintedToken(xNand_);
        xLatch = MintedToken(xLatch_);
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
    function redeem(address cpu, uint256 id) external nonReentrant {
        bytes32 key = mining.minerKey(cpu, id);
        Stake memory s = stakes[key];
        if (s.depositor == address(0)) revert NotStaked();

        _tryClaim(key); // rewards accrued while escrowed stay with the vault

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
    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        IERC20(token).safeTransfer(to, amount);
        emit Withdrawn(token, to, amount);
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

    function _tryClaim(bytes32 key) private {
        try mining.claim(key) {} catch {}
    }
}
