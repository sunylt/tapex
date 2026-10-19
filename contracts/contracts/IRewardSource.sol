// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice 质押池（XTokenStaking）眼里的「矿池」。
///
/// 矿池负责产生收益并持有 BEM；质押池只负责记账（谁该分多少）。
/// 因此奖励走「先划拨额度、领取时由矿池直接付给用户」的模型：
///  - `reserveRewards`：质押池在开始发放一轮奖励时，把额度从矿池划出来（只记账、钱不动）
///  - `payReward`：用户 claim 时，矿池把 BEM 直接从自己的余额打给用户
///
/// 这样 BEM 全程不经过质押池，质押池里也没有可被挪用的奖励余额。
interface IRewardSource {
    /// @notice 奖励代币地址（BEM）。
    function rewardToken() external view returns (address);

    /// @notice 划拨 `amount` 的奖励额度给质押池（只做记账，不转账）。
    function reserveRewards(uint256 amount) external;

    /// @notice 把 `amount` 奖励直接打给 `to`（只能由质押池调用）。
    function payReward(address to, uint256 amount) external;
}
