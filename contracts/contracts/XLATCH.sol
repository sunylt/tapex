// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MintedToken} from "./MintedToken.sol";

contract XLATCH is MintedToken {
    constructor(uint256 cap) MintedToken("Dismantled LATCH", "xLATCH", cap) {}
}
