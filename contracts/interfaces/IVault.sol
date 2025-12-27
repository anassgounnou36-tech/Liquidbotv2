// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IFlashLoanRecipient.sol";

/**
 * @title IVault
 * @notice Minimal interface for Balancer V2 Vault
 */
interface IVault {
    /**
     * @dev Performs a flash loan
     * @param recipient The contract receiving the flash loan
     * @param tokens The tokens to borrow
     * @param amounts The amounts to borrow
     * @param userData Additional data to pass to the recipient
     */
    function flashLoan(
        IFlashLoanRecipient recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}
