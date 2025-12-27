// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IPool
 * @notice Minimal interface for Aave V3 Pool
 */
interface IPool {
    /**
     * @dev Performs a liquidation call
     * @param collateralAsset The address of the collateral asset
     * @param debtAsset The address of the debt asset
     * @param user The address of the borrower
     * @param debtToCover The amount of debt to cover
     * @param receiveAToken True if the liquidator wants to receive aTokens, false otherwise
     */
    function liquidationCall(
        address collateralAsset,
        address debtAsset,
        address user,
        uint256 debtToCover,
        bool receiveAToken
    ) external;
}
