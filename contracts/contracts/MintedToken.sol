// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice ERC20 with a single minter and decimals = 0 (1 unit = 1 component).
/// No supply cap. Minting is restricted to the configured minter (e.g. MinerDecomposer).
abstract contract MintedToken is ERC20, ERC20Burnable, Ownable {
    address public minter;
    bool public minterLocked;

    error NotMinter();
    error MinterLockedError();

    event MinterUpdated(address indexed minter);
    event MinterLocked(address indexed minter);

    constructor(
        string memory name_,
        string memory symbol_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {}

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    function setMinter(address minter_) external onlyOwner {
        if (minterLocked) revert MinterLockedError();
        minter = minter_;
        emit MinterUpdated(minter_);
    }

    function lockMinter() external onlyOwner {
        if (minterLocked) revert MinterLockedError();
        minterLocked = true;
        emit MinterLocked(minter);
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }
}
