// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./interfaces/IFlashLoanRecipient.sol";
import "./interfaces/IVault.sol";
import "./interfaces/IPool.sol";
import "./interfaces/IERC20.sol";

/**
 * @title FlashLiquidator
 * @notice Flash loan based liquidation contract for Aave V3
 * @dev Uses Balancer V2 flash loans to perform zero-capital liquidations
 */
contract FlashLiquidator is IFlashLoanRecipient {
    // Balancer Vault address (Base mainnet)
    address public constant BALANCER_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    
    // Aave Pool address (Base mainnet)
    address public immutable aavePool;
    
    // Admin/bot address (receives profits)
    address public immutable admin;
    
    // Swap router for collateral -> debt conversions (configurable)
    address public swapRouter;
    
    // Events
    event LiquidationExecuted(
        address indexed borrower,
        address debtAsset,
        address collateralAsset,
        uint256 debtAmount,
        uint256 collateralReceived,
        uint256 profit
    );
    
    event SwapRouterUpdated(address indexed oldRouter, address indexed newRouter);
    
    // Errors
    error Unauthorized();
    error InvalidCaller();
    error InsufficientProfit();
    error RepaymentFailed();
    error SwapFailed();
    
    // Cached approval tracking to avoid repeated approvals
    mapping(address => mapping(address => bool)) private _approvalCache;
    
    /**
     * @dev Constructor
     * @param _aavePool Aave V3 Pool address
     * @param _admin Admin address (receives profits)
     * @param _swapRouter Initial swap router address
     */
    constructor(address _aavePool, address _admin, address _swapRouter) {
        require(_aavePool != address(0), "Invalid Aave Pool");
        require(_admin != address(0), "Invalid admin");
        
        aavePool = _aavePool;
        admin = _admin;
        swapRouter = _swapRouter;
    }
    
    /**
     * @dev Update swap router (only admin)
     * @param _newRouter New swap router address
     */
    function updateSwapRouter(address _newRouter) external {
        if (msg.sender != admin) revert Unauthorized();
        
        address oldRouter = swapRouter;
        swapRouter = _newRouter;
        
        emit SwapRouterUpdated(oldRouter, _newRouter);
    }
    
    /**
     * @dev Execute liquidation using flash loan
     * @param borrower Address of the borrower to liquidate
     * @param debtAsset Address of the debt asset
     * @param collateralAsset Address of the collateral asset
     * @param debtAmount Amount of debt to cover
     */
    function execute(
        address borrower,
        address debtAsset,
        address collateralAsset,
        uint256 debtAmount
    ) external {
        // Only admin/bot can execute
        if (msg.sender != admin) revert Unauthorized();
        
        // Prepare flash loan parameters
        address[] memory tokens = new address[](1);
        tokens[0] = debtAsset;
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = debtAmount;
        
        // Encode user data for receiveFlashLoan callback
        bytes memory userData = abi.encode(borrower, debtAsset, collateralAsset, debtAmount);
        
        // Request flash loan from Balancer Vault
        IVault(BALANCER_VAULT).flashLoan(
            IFlashLoanRecipient(address(this)),
            tokens,
            amounts,
            userData
        );
    }
    
    /**
     * @dev Callback from Balancer Vault with flash loan
     * @param tokens Borrowed tokens
     * @param amounts Borrowed amounts
     * @param feeAmounts Flash loan fees
     * @param userData Encoded liquidation parameters
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        // Only Balancer Vault can call this
        if (msg.sender != BALANCER_VAULT) revert InvalidCaller();
        
        // Decode parameters
        (address borrower, address debtAsset, address collateralAsset, uint256 debtAmount) = 
            abi.decode(userData, (address, address, address, uint256));
        
        // Ensure we received the debt asset
        require(tokens[0] == debtAsset, "Token mismatch");
        require(amounts[0] == debtAmount, "Amount mismatch");
        
        uint256 flashLoanFee = feeAmounts[0];
        uint256 totalRepayment = debtAmount + flashLoanFee;
        
        // Step 1: Approve Aave Pool to spend debt asset
        _ensureApproval(IERC20(debtAsset), aavePool);
        
        // Step 2: Execute liquidation on Aave
        uint256 collateralBefore = IERC20(collateralAsset).balanceOf(address(this));
        
        IPool(aavePool).liquidationCall(
            collateralAsset,
            debtAsset,
            borrower,
            debtAmount,
            false // Don't receive aTokens
        );
        
        uint256 collateralReceived = IERC20(collateralAsset).balanceOf(address(this)) - collateralBefore;
        require(collateralReceived > 0, "No collateral received");
        
        // Step 3: Swap collateral -> debt asset to repay flash loan
        // Note: This is a placeholder. In production, integrate with actual DEX router
        uint256 debtAssetAfterSwap = _swapCollateralToDebt(
            collateralAsset,
            debtAsset,
            collateralReceived,
            totalRepayment
        );
        
        // Ensure we have enough to repay
        if (debtAssetAfterSwap < totalRepayment) revert RepaymentFailed();
        
        // Step 4: Repay flash loan
        _ensureApproval(IERC20(debtAsset), BALANCER_VAULT);
        
        // Step 5: Calculate and verify profit
        uint256 profit = debtAssetAfterSwap - totalRepayment;
        if (profit == 0) revert InsufficientProfit();
        
        // Step 6: Send profit to admin
        IERC20(debtAsset).transfer(admin, profit);
        
        emit LiquidationExecuted(
            borrower,
            debtAsset,
            collateralAsset,
            debtAmount,
            collateralReceived,
            profit
        );
    }
    
    /**
     * @dev Swap collateral to debt asset (placeholder)
     * @param collateralAsset Collateral asset address
     * @param debtAsset Debt asset address
     * @param collateralAmount Amount of collateral to swap
     * @param minDebtAmount Minimum debt asset required
     * @return Amount of debt asset received
     */
    function _swapCollateralToDebt(
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 minDebtAmount
    ) internal returns (uint256) {
        // PLACEHOLDER: Integrate with actual swap router (Uniswap, 1inch, etc.)
        // For now, this is a simplified version that assumes swap router is set
        
        if (swapRouter == address(0)) {
            // If no router configured, assume 1:1 swap for testing
            // In production, this should revert
            revert SwapFailed();
        }
        
        // Approve router to spend collateral
        _ensureApproval(IERC20(collateralAsset), swapRouter);
        
        // TODO: Call actual swap router here
        // Example: ISwapRouter(swapRouter).swap(...)
        
        // Return the balance we now have
        uint256 debtBalance = IERC20(debtAsset).balanceOf(address(this));
        
        if (debtBalance < minDebtAmount) revert SwapFailed();
        
        return debtBalance;
    }
    
    /**
     * @dev Ensure token approval (cached to avoid redundant approvals)
     * @param token Token to approve
     * @param spender Spender address
     */
    function _ensureApproval(IERC20 token, address spender) internal {
        // Check cache first
        if (_approvalCache[address(token)][spender]) {
            return;
        }
        
        // Check current allowance
        uint256 currentAllowance = token.allowance(address(this), spender);
        
        if (currentAllowance == 0) {
            // Approve maximum to avoid repeated approvals
            bool success = token.approve(spender, type(uint256).max);
            require(success, "Approval failed");
            
            // Cache the approval
            _approvalCache[address(token)][spender] = true;
        }
    }
    
    /**
     * @dev Emergency withdrawal (only admin)
     * @param token Token to withdraw
     */
    function emergencyWithdraw(address token) external {
        if (msg.sender != admin) revert Unauthorized();
        
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            IERC20(token).transfer(admin, balance);
        }
    }
    
    /**
     * @dev Get decimals for an asset (handles decimals safely)
     * @param asset Asset address
     * @return Number of decimals
     */
    function getDecimals(address asset) external view returns (uint8) {
        return IERC20(asset).decimals();
    }
}
