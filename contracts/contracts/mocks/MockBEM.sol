// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockBEM is ERC20 {
    constructor() ERC20("Behemoth", "BEM") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
