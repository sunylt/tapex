// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view of the PoD mining contract that the decomposer needs.
/// Struct layout matches the on-chain `getMiner(bytes32)` tuple (chain 56,
/// 0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46).
interface IMining {
    struct Miner {
        address circuits;
        uint64 circuitId;
        uint32 taskId;
        uint32 gateCount;
        uint32 stateCount;
        uint32 depth;
        uint64 area;
        uint32 mult;
        uint64 since;
        uint8 status;
        address registrant;
        uint32 nandBurn;
        uint32 latchBurn;
        uint64 bstar;
        uint64 bonus;
        bool optimal;
        uint64 commitBlock;
        uint64 firstUnusedId;
        uint64 stopBlock;
        uint128 verifWeight;
        uint128 unverWeight;
        uint256 debt;
    }

    function minerKey(address circuits, uint256 circuitId) external pure returns (bytes32);

    function getMiner(bytes32 key) external view returns (Miner memory);

    /// @notice Permissionless. Rewards are minted to the current NFT owner
    /// (`ICircuit.ownerOf(circuitId)`), so whoever custodies the NFT earns.
    function claim(bytes32 key) external;
}
