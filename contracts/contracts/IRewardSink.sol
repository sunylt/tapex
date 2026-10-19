// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 矿池眼里的「质押池」：接收收益触发。
///
/// 当矿池把挖矿收益归集到位后，owner 调 `MinerDecomposer.distributeRewards()`，
/// 矿池把全部可分配余额锁定额度并调用本接口的 `notifyReward`，质押池据此立刻
/// 更新全局累加器，所有质押者的待领取收益在同一区块内更新。
interface IRewardSink {
    /// @notice 触发一轮收益分配：把 `amount` 立刻摊到所有质押者头上。
    /// 只应由矿池调用。
    function notifyReward(uint256 amount) external;
}
