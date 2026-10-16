// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MintedToken} from "./MintedToken.sol";

contract XNAND is MintedToken {
    constructor() MintedToken("Dismantled NAND", "xNAND") {}
}
