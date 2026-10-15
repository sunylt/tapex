// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockCircuit is ERC721 {
    constructor(string memory name_) ERC721(name_, "CPU") {}

    function mint(address to, uint256 id) external {
        _mint(to, id);
    }
}
