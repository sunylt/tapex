// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 质押池（XTokenStaking）眼里的「矿池」。
///
/// 矿池负责产生并持有 BEM；质押池只负责记账（谁该分多少）。收益走「矿池触发、
/// 领取时由矿池直接付给用户」的模型：
///  - 矿池自己在收益到位后调用 `XTokenStaking.notifyReward`（见 IRewardSink），
///    在矿池一侧锁定对应额度；
///  - `payReward`：用户 claim 时，矿池把 BEM 直接从自己的余额打给用户。
///
/// 这样 BEM 全程不经过质押池，质押池里也没有可被挪用的奖励余额。
interface IRewardSource {
    /// @notice 奖励代币地址（BEM）。
    function rewardToken() external view returns (address);

    /// @notice 把 `amount` 奖励直接打给 `to`（只能由质押池调用）。
    function payReward(address to, uint256 amount) external;
}
