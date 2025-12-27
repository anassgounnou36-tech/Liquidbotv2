import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  console.log("Deploying FlashLiquidator...");
  
  // Get deployment parameters from environment
  const aavePoolAddress = process.env.AAVE_POOL_ADDRESS || "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
  const oneInchRouter = process.env.ONEINCH_ROUTER_ADDRESS || "0x1111111254EEB25477B68fb85Ed929f73A960582";
  
  // Get signer address (admin will be the deployer)
  const [deployer] = await ethers.getSigners();
  const adminAddress = deployer.address;
  
  console.log("Deploying from:", adminAddress);
  console.log("Aave Pool:", aavePoolAddress);
  console.log("1inch Router:", oneInchRouter);
  
  // Deploy FlashLiquidator with 1inch router
  const FlashLiquidator = await ethers.getContractFactory("FlashLiquidator");
  const flashLiquidator = await FlashLiquidator.deploy(
    aavePoolAddress,
    adminAddress,
    oneInchRouter
  );
  
  await flashLiquidator.waitForDeployment();
  
  const address = await flashLiquidator.getAddress();
  console.log("FlashLiquidator deployed to:", address);
  
  // Save deployment info to JSON file
  const deploymentInfo = {
    flashLiquidator: address,
    aavePool: aavePoolAddress,
    admin: adminAddress,
    oneInchRouter: oneInchRouter,
    network: "base",
    chainId: 8453,
    deployedAt: new Date().toISOString(),
  };
  
  const deploymentPath = path.join(__dirname, "..", "deployment.json");
  fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
  console.log("Deployment info saved to deployment.json");
  
  // Update .env file with flash liquidator address
  const envPath = path.join(__dirname, "..", ".env");
  if (fs.existsSync(envPath)) {
    let envContent = fs.readFileSync(envPath, "utf-8");
    
    // Check if FLASH_LIQUIDATOR_ADDRESS exists
    if (envContent.includes("FLASH_LIQUIDATOR_ADDRESS=")) {
      // Update existing
      envContent = envContent.replace(
        /FLASH_LIQUIDATOR_ADDRESS=.*/,
        `FLASH_LIQUIDATOR_ADDRESS=${address}`
      );
    } else {
      // Add new
      envContent += `\n# Flash Liquidator Contract\nFLASH_LIQUIDATOR_ADDRESS=${address}\n`;
    }
    
    fs.writeFileSync(envPath, envContent);
    console.log(".env file updated with FlashLiquidator address");
  }
  
  console.log("\n=== Deployment Complete ===");
  console.log("FlashLiquidator is configured with 1inch router for swaps:");
  console.log("  - WETH -> USDC");
  console.log("  - cbETH -> USDC");
  console.log("\nNext steps:");
  console.log("1. Ensure ONEINCH_ROUTER_ADDRESS and MAX_SLIPPAGE_BPS are set in .env");
  console.log("2. Test flash liquidation with dry run before enabling execution");
  console.log("3. Monitor logs for 1inch swap details and slippage");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
