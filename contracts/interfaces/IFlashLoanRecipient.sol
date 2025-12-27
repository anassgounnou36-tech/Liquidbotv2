// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IVault.sol";

/**
 * @title IFlashLoanRecipient
 * @notice Interface for Balancer V2 flash loan recipients
 */
interface IFlashLoanRecipient {
    /**
     * @dev Called by the Vault when a flash loan is received
     * @param tokens The tokens being borrowed
     * @param amounts The amounts being borrowed
     * @param feeAmounts The fees to be paid
     * @param userData Additional data passed to the flash loan
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}
