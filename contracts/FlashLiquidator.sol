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
    
    // 1inch Router for collateral -> debt conversions
    address public immutable oneInchRouter;
    
    // Events
    event LiquidationExecuted(
        address indexed borrower,
        address debtAsset,
        address collateralAsset,
        uint256 debtAmount,
        uint256 collateralReceived,
        uint256 profit
    );
    
    event SwapExecuted(
        address indexed fromAsset,
        address indexed toAsset,
        uint256 amountIn,
        uint256 amountOut,
        uint256 minAmountOut
    );
    
    // Errors
    error Unauthorized();
    error InvalidCaller();
    error InsufficientProfit();
    error RepaymentFailed();
    error SwapFailed();
    error InvalidSwapData();
    error SlippageTooHigh();
    
    // Cached approval tracking to avoid repeated approvals
    mapping(address => mapping(address => bool)) private _approvalCache;
    
    /**
     * @dev Constructor
     * @param _aavePool Aave V3 Pool address
     * @param _admin Admin address (receives profits)
     * @param _oneInchRouter 1inch Router address
     */
    constructor(address _aavePool, address _admin, address _oneInchRouter) {
        require(_aavePool != address(0), "Invalid Aave Pool");
        require(_admin != address(0), "Invalid admin");
        require(_oneInchRouter != address(0), "Invalid 1inch Router");
        
        aavePool = _aavePool;
        admin = _admin;
        oneInchRouter = _oneInchRouter;
    }
    
    /**
     * @dev Execute liquidation using flash loan
     * @param borrower Address of the borrower to liquidate
     * @param debtAsset Address of the debt asset
     * @param collateralAsset Address of the collateral asset
     * @param debtAmount Amount of debt to cover
     * @param oneInchData Encoded 1inch swap calldata for collateral->debt swap
     */
    function execute(
        address borrower,
        address debtAsset,
        address collateralAsset,
        uint256 debtAmount,
        bytes calldata oneInchData
    ) external {
        // Only admin/bot can execute
        if (msg.sender != admin) revert Unauthorized();
        
        // Prepare flash loan parameters
        address[] memory tokens = new address[](1);
        tokens[0] = debtAsset;
        
        uint256[] memory amounts = new uint256[](1);
        amounts[0] = debtAmount;
        
        // Encode user data for receiveFlashLoan callback (include 1inch swap data)
        bytes memory userData = abi.encode(borrower, debtAsset, collateralAsset, debtAmount, oneInchData);
        
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
     * @param userData Encoded liquidation parameters including 1inch swap data
     */
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        // Only Balancer Vault can call this
        if (msg.sender != BALANCER_VAULT) revert InvalidCaller();
        
        // Decode parameters (now includes 1inch swap data)
        (address borrower, address debtAsset, address collateralAsset, uint256 debtAmount, bytes memory oneInchData) = 
            abi.decode(userData, (address, address, address, uint256, bytes));
        
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
        
        // Step 3: Swap collateral -> debt asset using 1inch with exact calldata
        uint256 debtAssetAfterSwap = _swapCollateralToDebt(
            collateralAsset,
            debtAsset,
            collateralReceived,
            totalRepayment,
            oneInchData
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
     * @dev Swap collateral to debt asset using 1inch router
     * @param collateralAsset Collateral asset address
     * @param debtAsset Debt asset address
     * @param collateralAmount Amount of collateral to swap
     * @param minDebtAmount Minimum debt asset required (including slippage)
     * @param oneInchData Encoded 1inch swap calldata
     * @return Amount of debt asset received
     */
    function _swapCollateralToDebt(
        address collateralAsset,
        address debtAsset,
        uint256 collateralAmount,
        uint256 minDebtAmount,
        bytes memory oneInchData
    ) internal returns (uint256) {
        // Validate 1inch data is provided
        if (oneInchData.length == 0) revert InvalidSwapData();
        
        // Get decimals for safe calculation
        uint8 collateralDecimals = IERC20(collateralAsset).decimals();
        uint8 debtDecimals = IERC20(debtAsset).decimals();
        
        // Record debt balance before swap
        uint256 debtBalanceBefore = IERC20(debtAsset).balanceOf(address(this));
        
        // Approve 1inch router to spend collateral
        _ensureApproval(IERC20(collateralAsset), oneInchRouter);
        
        // Execute 1inch swap via low-level call
        // The oneInchData contains the complete encoded function call including:
        // - swap function selector
        // - all swap parameters (tokenIn, tokenOut, amount, minReturn, etc.)
        (bool success, ) = oneInchRouter.call(oneInchData);
        
        if (!success) revert SwapFailed();
        
        // Calculate received debt asset
        uint256 debtBalanceAfter = IERC20(debtAsset).balanceOf(address(this));
        
        // This should never underflow as swap should increase balance
        require(debtBalanceAfter >= debtBalanceBefore, "Swap decreased balance");
        uint256 amountOut = debtBalanceAfter - debtBalanceBefore;
        
        // Enforce minimum output (slippage protection)
        if (amountOut < minDebtAmount) revert SlippageTooHigh();
        
        // Emit swap event for transparency
        emit SwapExecuted(
            collateralAsset,
            debtAsset,
            collateralAmount,
            amountOut,
            minDebtAmount
        );
        
        return debtBalanceAfter;
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
        
        // Only approve if allowance is insufficient (less than a reasonable threshold)
        // We use type(uint256).max / 2 as threshold to avoid approval on every small reduction
        if (currentAllowance < type(uint256).max / 2) {
            // Approve maximum to avoid repeated approvals
            bool success = token.approve(spender, type(uint256).max);
            require(success, "Approval failed");
            
            // Cache the approval
            _approvalCache[address(token)][spender] = true;
        } else {
            // Allowance is sufficient, cache it
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
