// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MintedToken} from "./MintedToken.sol";

contract XNAND is MintedToken {
    constructor(uint256 cap) MintedToken("Dismantled NAND", "xNAND", cap) {}
}
