// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IMining} from "../IMining.sol";
import {MockBEM} from "./MockBEM.sol";

/// @notice Mirror of the PoD mining contract's relevant behaviour: rewards are
/// minted to the current NFT owner when `claim` is called (permissionless).
contract MockMining is IMining {
    MockBEM public immutable bem;
    uint256 public rewardPerClaim = 1e18;
    /// @notice Test switch: make `claim` revert so failure paths can be exercised.
    bool public claimReverts;

    mapping(bytes32 => Miner) private _miners;
    mapping(bytes32 => uint256) private _lastClaim;

    constructor(address bem_) {
        bem = MockBEM(bem_);
    }

    function setRewardPerClaim(uint256 amount) external {
        rewardPerClaim = amount;
    }

    function setClaimReverts(bool value) external {
        claimReverts = value;
    }

    function minerKey(address circuits, uint256 circuitId) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(circuits, circuitId));
    }

    function setMiner(
        address circuits,
        uint256 circuitId,
        uint32 nandBurn,
        uint32 latchBurn,
        uint32 mult,
        uint8 status
    ) external {
        bytes32 key = keccak256(abi.encodePacked(circuits, circuitId));
        Miner storage m = _miners[key];
        m.circuits = circuits;
        m.circuitId = uint64(circuitId);
        m.nandBurn = nandBurn;
        m.latchBurn = latchBurn;
        m.mult = mult;
        m.status = status;
    }

    function getMiner(bytes32 key) external view returns (Miner memory) {
        return _miners[key];
    }

    /// @notice Mints a fixed reward to the current owner of the circuit NFT.
    function claim(bytes32 key) external {
        require(!claimReverts, "claim disabled");
        Miner memory m = _miners[key];
        require(m.circuits != address(0), "no miner");
        address owner = IERC721(m.circuits).ownerOf(m.circuitId);
        _lastClaim[key] += 1;
        bem.mint(owner, rewardPerClaim);
    }
}
