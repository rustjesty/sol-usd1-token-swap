import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { connection, MAIN_KP } from "./config";
import { testSwapTransaction } from "./trade";

const main = async () => {
  try {
    console.log("🚀 Starting Raydium Launchpad Swap Transaction Test\n");
    
    const result = await testSwapTransaction();
    
    console.log("\n✅ Test completed successfully!");
    console.log("Transaction is ready to be sent to the network.");
    
    process.exit(0);
  } catch (error: any) {
    console.error("\n❌ Test failed with error:");
    console.error(error);
    process.exit(1);
  }
};

main();
