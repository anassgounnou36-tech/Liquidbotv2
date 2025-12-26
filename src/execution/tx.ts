import { ethers } from 'ethers';
import { SimulationResult } from './sim';
import { getAaveAddresses, AAVE_POOL_ABI, getAssetAddress, ERC20_ABI } from '../aave/addresses';
import { CachedTransaction } from '../state/borrower';
import { getConfig } from '../config/env';
import logger from '../logging/logger';

// Build liquidation transaction
export async function buildLiquidationTx(
  provider: ethers.JsonRpcProvider,
  signer: ethers.Wallet,
  borrowerAddress: string,
  simResult: SimulationResult
): Promise<CachedTransaction | null> {
  if (!simResult.success) {
    logger.error('Cannot build tx for failed simulation');
    return null;
  }
  
  const addresses = getAaveAddresses();
  
  try {
    // Get pool contract with signer
    const poolContract = new ethers.Contract(
      addresses.pool,
      AAVE_POOL_ABI,
      signer
    );
    
    // Get asset addresses
    const debtAssetAddress = getAssetAddress(simResult.debtAsset);
    const collateralAssetAddress = getAssetAddress(simResult.collateralAsset);
    
    // Check and approve debt asset if needed
    await ensureApproval(signer, debtAssetAddress, addresses.pool, simResult.debtToCover);
    
    // Build transaction data
    const data = poolContract.interface.encodeFunctionData('liquidationCall', [
      collateralAssetAddress,
      debtAssetAddress,
      borrowerAddress,
      simResult.debtToCover,
      false // receiveAToken
    ]);
    
    // Get fee data
    const feeData = await provider.getFeeData();
    const maxFeePerGas = feeData.maxFeePerGas || 0n;
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas || 0n;
    
    // Add 10% buffer to gas estimate
    const gasLimit = (simResult.gasEstimate * 110n) / 100n;
    
    const cachedTx: CachedTransaction = {
      to: addresses.pool,
      data,
      value: 0n,
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      expectedProfitUsd: simResult.profitUsd,
      estimatedGasUsd: simResult.gasUsd,
      preparedAt: Date.now()
    };
    
    logger.info('Liquidation transaction built', {
      borrower: borrowerAddress,
      debtAsset: simResult.debtAsset,
      collateralAsset: simResult.collateralAsset,
      debtToCover: simResult.debtToCover.toString(),
      expectedProfit: simResult.profitUsd.toFixed(2),
      gasLimit: gasLimit.toString()
    });
    
    return cachedTx;
  } catch (error: any) {
    logger.error('Failed to build liquidation tx', {
      borrower: borrowerAddress,
      error: error.message
    });
    return null;
  }
}

// Ensure token approval for liquidation
async function ensureApproval(
  signer: ethers.Wallet,
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint
): Promise<void> {
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  
  try {
    const currentAllowance = await tokenContract.allowance(signer.address, spenderAddress);
    
    if (currentAllowance < amount) {
      logger.info('Approving token for liquidation', {
        token: tokenAddress,
        spender: spenderAddress,
        amount: amount.toString()
      });
      
      // Approve max uint256 to avoid repeated approvals
      const approveTx = await tokenContract.approve(spenderAddress, ethers.MaxUint256);
      await approveTx.wait();
      
      logger.info('Token approved');
    }
  } catch (error) {
    logger.error('Failed to approve token', { error });
    throw error;
  }
}

// Sign transaction
export async function signTransaction(
  signer: ethers.Wallet,
  cachedTx: CachedTransaction,
  nonce?: number
): Promise<string> {
  try {
    const tx: ethers.TransactionRequest = {
      to: cachedTx.to,
      data: cachedTx.data,
      value: cachedTx.value,
      gasLimit: cachedTx.gasLimit,
      maxFeePerGas: cachedTx.maxFeePerGas,
      maxPriorityFeePerGas: cachedTx.maxPriorityFeePerGas,
      nonce: nonce !== undefined ? nonce : await signer.getNonce(),
      chainId: (await signer.provider?.getNetwork())?.chainId || BigInt(getConfig().chainId),
      type: 2 // EIP-1559
    };
    
    const signedTx = await signer.signTransaction(tx);
    
    logger.debug('Transaction signed', {
      nonce: tx.nonce,
      gasLimit: tx.gasLimit?.toString()
    });
    
    return signedTx;
  } catch (error: any) {
    logger.error('Failed to sign transaction', { error: error.message });
    throw error;
  }
}
