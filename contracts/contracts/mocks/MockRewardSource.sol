// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {IRewardSink} from "../IRewardSink.sol";
import {IRewardSource} from "../IRewardSource.sol";

/// @notice 测试用收益来源：可以主动触发一轮分配，也能按开关让 `payReward` 失败，
/// 用来覆盖「矿池付不出钱时，用户本金依然能退出」这类路径。
contract MockRewardSource is IRewardSource {
    IERC20 public immutable token;
    bool public payReverts;

    constructor(address token_) {
        token = IERC20(token_);
    }

    function rewardToken() external view returns (address) {
        return address(token);
    }

    function setPayReverts(bool value) external {
        payReverts = value;
    }

    /// @notice 以本合约（= pool）的身份触发质押池记账。
    function trigger(address staking, uint256 amount) external {
        IRewardSink(staking).notifyReward(amount);
    }

    function payReward(address to, uint256 amount) external {
        require(!payReverts, "pay disabled");
        token.transfer(to, amount);
    }
}
