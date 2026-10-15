// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice ERC20 with a fixed supply cap, a single minter, and decimals = 0
/// (1 gate = 1 token). `burnFrom` is inherited from ERC20Burnable and uses the
/// caller's allowance, so returning a dismantled miner requires the user to
/// approve the decomposer first.
abstract contract MintedToken is ERC20, ERC20Burnable, Ownable {
    uint256 public immutable maxSupply;
    address public minter;

    error NotMinter();
    error CapExceeded();

    event MinterUpdated(address indexed minter);

    constructor(
        string memory name_,
        string memory symbol_,
        uint256 cap_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        maxSupply = cap_;
    }

    modifier onlyMinter() {
        if (msg.sender != minter) revert NotMinter();
        _;
    }

    function setMinter(address minter_) external onlyOwner {
        minter = minter_;
        emit MinterUpdated(minter_);
    }

    function mint(address to, uint256 amount) external onlyMinter {
        if (totalSupply() + amount > maxSupply) revert CapExceeded();
        _mint(to, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }
}
