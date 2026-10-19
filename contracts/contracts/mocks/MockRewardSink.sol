// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IRewardSink} from "../IRewardSink.sol";

/// @notice 测试用的「质押池」替身（MinerDecomposer.rewardPayer）。
///  - `notifyReward`：记录矿池通知过来的额度，确认触发链路真的走通了；
///  - `payFromPool`：转发给 `MinerDecomposer.payReward`，代表质押池发起发放。
///    用低级调用回抛 revert，让矿池的自定义错误能直接被测试断言到。
contract MockRewardSink is IRewardSink {
    address public immutable pool;

    uint256 public lastNotified;
    uint256 public totalNotified;

    constructor(address pool_) {
        pool = pool_;
    }

    function notifyReward(uint256 amount) external override {
        lastNotified = amount;
        totalNotified += amount;
    }

    function payFromPool(address to, uint256 amount) external {
        (bool ok, bytes memory ret) = pool.call(
            abi.encodeWithSignature("payReward(address,uint256)", to, amount)
        );
        if (!ok) {
            assembly {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }
}
