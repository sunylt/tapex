// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice ERC20 with a single minter and decimals = 0 (1 unit = 1 component).
/// No supply cap. Minting is restricted to the configured minter (e.g. MinerDecomposer).
///
/// Burning is deliberately **not** open to holders: the only way x-tokens can be
/// destroyed is the minter (the decomposer) burning them inside `redeem`. Public
/// `burn` would let anyone shrink the supply below the summed price of the
/// escrowed miners, which can make some escrowed NFTs permanently unredeemable.
abstract contract MintedToken is ERC20, Ownable {
    address public minter;
    bool public minterLocked;

    error NotMinter();
    error MinterLockedError();
    error ZeroAddress();

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
        if (minter_ == address(0)) revert ZeroAddress();
        minter = minter_;
        emit MinterUpdated(minter_);
    }

    function lockMinter() external onlyOwner {
        if (minterLocked) revert MinterLockedError();
        if (minter == address(0)) revert ZeroAddress();
        minterLocked = true;
        emit MinterLocked(minter);
    }

    function mint(address to, uint256 amount) external onlyMinter {
        _mint(to, amount);
    }

    /// @notice Burn `amount` of `from`, callable only by the minter (the
    /// decomposer, inside `redeem`). A holder allowance for the minter is still
    /// required, mirroring `ERC20Burnable.burnFrom`.
    function burnFrom(address from, uint256 amount) external onlyMinter {
        _spendAllowance(from, msg.sender, amount);
        _burn(from, amount);
    }

    function decimals() public pure override returns (uint8) {
        return 0;
    }
}
