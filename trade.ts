import {
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
  TransactionMessage,
  Keypair,
  AccountMeta,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import BN from "bn.js";
import raydiumLaunchLabIDL from "./raydiumLaunchLab.json";
import { connection, MAIN_KP } from "./config";
import {
  getPdaLaunchpadAuth,
  getPdaLaunchpadPoolId,
  getPdaLaunchpadVaultId,
  getPdaLaunchpadConfigId,
  getPdaCreatorVault,
  getPdaPlatformVault,
  LaunchpadPool,
} from "@raydium-io/raydium-sdk-v2";

const LAUNCHPAD_PROGRAM_ID = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj");

// Get Anchor program instance for raydiumLaunchLab
const getLaunchpadProgram = (payer: Keypair): Program => {
  const wallet = new NodeWallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new Program(raydiumLaunchLabIDL as anchor.Idl, provider);
};

export type SwapDirection = "buy" | "sell";

interface SwapParams {
  baseMint: PublicKey; // Token mint (the token being traded)
  quoteMint: PublicKey; // Quote token mint (e.g., USD1)
  direction: SwapDirection; // "buy" = quote -> base, "sell" = base -> quote
  amountIn: BN; // Amount in raw units (considering decimals)
  minimumAmountOut?: BN; // Minimum amount out for slippage protection
  payer: Keypair; // The payer/signer
  shareFeeRate?: BN; // Fee rate (default 0)
  platformConfig?: PublicKey; // Platform config (optional, will derive if not provided)
  deployer?: PublicKey; // Deployer/creator (for creator vault)
}


export const buildTradeTransaction = async (
  params: SwapParams
): Promise<{
  transaction: VersionedTransaction;
  instructions: TransactionInstruction[];
}> => {
  const {
    baseMint,
    quoteMint,
    direction,
    amountIn,
    minimumAmountOut = new BN(0),
    payer,
    shareFeeRate = new BN(0),
    platformConfig,
    deployer,
  } = params;

  const program = getLaunchpadProgram(payer);
  const programId = program.programId;

  // Derive pool ID
  const poolId = getPdaLaunchpadPoolId(programId, baseMint, quoteMint).publicKey;

  // Derive vaults
  const baseVault = getPdaLaunchpadVaultId(programId, poolId, baseMint).publicKey;
  const quoteVault = getPdaLaunchpadVaultId(programId, poolId, quoteMint).publicKey;

  // Derive authority PDA
  const authority = getPdaLaunchpadAuth(programId).publicKey;

  // Derive global config
  const globalConfig = getPdaLaunchpadConfigId(programId, quoteMint, 0, 0).publicKey;

  // Derive platform config (default platform ID if not provided)
  const platformId = platformConfig || new PublicKey("FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1");
  const platformConfigPubkey = platformConfig || platformId;

  // Derive platform vault
  const platformVault = getPdaPlatformVault(programId, platformId, quoteMint).publicKey;

  // Derive creator vault - need to get creator from pool or use deployer
  let creatorVault: PublicKey;
  if (deployer) {
    creatorVault = getPdaCreatorVault(programId, deployer, quoteMint).publicKey;
  } else {
    // Fetch pool data to get creator
    const poolData = await connection.getAccountInfo(poolId);
    if (!poolData) {
      throw new Error(`Launchpad pool not found: ${poolId.toBase58()}`);
    }
    const poolInfo = LaunchpadPool.decode(poolData.data);
    creatorVault = getPdaCreatorVault(programId, poolInfo.creator, quoteMint).publicKey;
  }

  // Derive event authority PDA
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId
  );

  // Get user token accounts
  const userBaseTokenAccount = getAssociatedTokenAddressSync(baseMint, payer.publicKey);
  const userQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, payer.publicKey);

  // Setup instructions (create token accounts if needed)
  const setupInstructions: TransactionInstruction[] = [];

  // Check if base token account exists
  const baseAccountInfo = await connection.getAccountInfo(userBaseTokenAccount);
  if (!baseAccountInfo) {
    setupInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        userBaseTokenAccount,
        payer.publicKey,
        baseMint
      )
    );
  }

  // Check if quote token account exists
  const quoteAccountInfo = await connection.getAccountInfo(userQuoteTokenAccount);
  if (!quoteAccountInfo) {
    setupInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        userQuoteTokenAccount,
        payer.publicKey,
        quoteMint
      )
    );
  }

  // Determine token program IDs (assuming standard token program, can be extended for Token-2022)
  const baseTokenProgram = TOKEN_PROGRAM_ID;
  const quoteTokenProgram = TOKEN_PROGRAM_ID;

  // Build instruction based on direction
  let instruction: TransactionInstruction;

  // Prepare remaining accounts (SystemProgram, platformVault, and creatorVault)
  // Based on SDK implementation: SystemProgram is added, then platformVault, then creatorVault
  const remainingAccounts = [
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: platformVault, isSigner: false, isWritable: true },
    { pubkey: creatorVault, isSigner: false, isWritable: true },
  ];

  if (direction === "buy") {
    // Buy: quote -> base (buy_exact_in)
    instruction = await program.methods
      .buyExactIn(amountIn, minimumAmountOut, shareFeeRate)
      .accounts({
        payer: payer.publicKey,
        authority,
        globalConfig,
        platformConfig: platformConfigPubkey,
        poolState: poolId,
        userBaseToken: userBaseTokenAccount,
        userQuoteToken: userQuoteTokenAccount,
        baseVault,
        quoteVault,
        baseTokenMint: baseMint,
        quoteTokenMint: quoteMint,
        baseTokenProgram,
        quoteTokenProgram,
        eventAuthority,
        program: programId,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();
  } else {
    // Sell: base -> quote (sell_exact_in)
    instruction = await program.methods
      .sellExactIn(amountIn, minimumAmountOut, shareFeeRate)
      .accounts({
        payer: payer.publicKey,
        authority,
        globalConfig,
        platformConfig: platformConfigPubkey,
        poolState: poolId,
        userBaseToken: userBaseTokenAccount,
        userQuoteToken: userQuoteTokenAccount,
        baseVault,
        quoteVault,
        baseTokenMint: baseMint,
        quoteTokenMint: quoteMint,
        baseTokenProgram,
        quoteTokenProgram,
        eventAuthority,
        program: programId,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();
  }

  const instructions = [...setupInstructions, instruction];

  console.log("instructions", instructions)

  // Build transaction
  const latestBlockhash = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([payer]);

  return {
    transaction,
    instructions,
  };
};


export const buildRaydiumLaunchlabTransaction = async (
  params: SwapParams
): Promise<{
  transaction: VersionedTransaction;
  instructions: TransactionInstruction[];
}> => {
  const {
    baseMint,
    quoteMint,
    direction,
    amountIn,
    minimumAmountOut = new BN(0),
    payer,
    shareFeeRate = new BN(0),
    platformConfig,
    deployer,
  } = params;

  const program = getLaunchpadProgram(payer);
  const programId = program.programId;

  // Derive pool ID
  const poolId = getPdaLaunchpadPoolId(programId, baseMint, quoteMint).publicKey;

  // Derive vaults
  const baseVault = getPdaLaunchpadVaultId(programId, poolId, baseMint).publicKey;
  const quoteVault = getPdaLaunchpadVaultId(programId, poolId, quoteMint).publicKey;

  // Derive authority PDA
  const authority = getPdaLaunchpadAuth(programId).publicKey;

  // Derive global config
  const globalConfig = getPdaLaunchpadConfigId(programId, quoteMint, 0, 0).publicKey;

  // Derive platform config (default platform ID if not provided)
  const platformId = platformConfig || new PublicKey("FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1");
  const platformConfigPubkey = platformConfig || platformId;

  // Derive platform vault
  const platformVault = getPdaPlatformVault(programId, platformId, quoteMint).publicKey;

  // Derive creator vault - need to get creator from pool or use deployer
  let creatorVault: PublicKey;
  if (deployer) {
    creatorVault = getPdaCreatorVault(programId, deployer, quoteMint).publicKey;
  } else {
    // Fetch pool data to get creator
    const poolData = await connection.getAccountInfo(poolId);
    if (!poolData) {
      throw new Error(`Launchpad pool not found: ${poolId.toBase58()}`);
    }
    const poolInfo = LaunchpadPool.decode(poolData.data);
    creatorVault = getPdaCreatorVault(programId, poolInfo.creator, quoteMint).publicKey;
  }

  // Derive event authority PDA
  const [eventAuthority] = PublicKey.findProgramAddressSync(
    [Buffer.from("__event_authority")],
    programId
  );

  // Get user token accounts
  const userBaseTokenAccount = getAssociatedTokenAddressSync(baseMint, payer.publicKey);
  const userQuoteTokenAccount = getAssociatedTokenAddressSync(quoteMint, payer.publicKey);

  // Setup instructions (create token accounts if needed)
  const setupInstructions: TransactionInstruction[] = [];

  // Check if base token account exists
  const baseAccountInfo = await connection.getAccountInfo(userBaseTokenAccount);
  if (!baseAccountInfo) {
    setupInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        userBaseTokenAccount,
        payer.publicKey,
        baseMint
      )
    );
  }

  // Check if quote token account exists
  const quoteAccountInfo = await connection.getAccountInfo(userQuoteTokenAccount);
  if (!quoteAccountInfo) {
    setupInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,
        userQuoteTokenAccount,
        payer.publicKey,
        quoteMint
      )
    );
  }

  // Determine token program IDs (assuming standard token program, can be extended for Token-2022)
  const baseTokenProgram = TOKEN_PROGRAM_ID;
  const quoteTokenProgram = TOKEN_PROGRAM_ID;

  // Build instruction based on direction
  let instruction: TransactionInstruction;

  // Prepare remaining accounts (SystemProgram, platformVault, and creatorVault)
  // Based on SDK implementation: SystemProgram is added, then platformVault, then creatorVault
  const remainingAccounts = [
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: platformVault, isSigner: false, isWritable: true },
    { pubkey: creatorVault, isSigner: false, isWritable: true },
  ];

  if (direction === "buy") {
    // Buy: quote -> base (buy_exact_in)
    instruction = await program.methods
      .buyExactIn(amountIn, minimumAmountOut, shareFeeRate)
      .accounts({
        payer: payer.publicKey,
        authority,
        globalConfig,
        platformConfig: platformConfigPubkey,
        poolState: poolId,
        userBaseToken: userBaseTokenAccount,
        userQuoteToken: userQuoteTokenAccount,
        baseVault,
        quoteVault,
        baseTokenMint: baseMint,
        quoteTokenMint: quoteMint,
        baseTokenProgram,
        quoteTokenProgram,
        eventAuthority,
        program: programId,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();
  } else {
    // Sell: base -> quote (sell_exact_in)
    instruction = await program.methods
      .sellExactIn(amountIn, minimumAmountOut, shareFeeRate)
      .accounts({
        payer: payer.publicKey,
        authority,
        globalConfig,
        platformConfig: platformConfigPubkey,
        poolState: poolId,
        userBaseToken: userBaseTokenAccount,
        userQuoteToken: userQuoteTokenAccount,
        baseVault,
        quoteVault,
        baseTokenMint: baseMint,
        quoteTokenMint: quoteMint,
        baseTokenProgram,
        quoteTokenProgram,
        eventAuthority,
        program: programId,
      })
      .remainingAccounts(remainingAccounts)
      .instruction();
  }

  const instructions = [...setupInstructions, instruction];

  console.log("instructions", instructions)

  // Build transaction
  const latestBlockhash = await connection.getLatestBlockhash();
  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([payer]);

  return {
    transaction,
    instructions,
  };
};

// Test function to verify the transaction
export const testSwapTransaction = async () => {
  try {
    console.log("🧪 Testing Raydium Launchpad Swap Transaction...");
    console.log("Payer:", MAIN_KP.publicKey.toBase58());

    // Use a known token mint from the codebase
    const tokenMint = new PublicKey("CPgobeEZLk82DdXqWxBiwvvE2tkQwDd12AuR1V8TqwXu");
    const usd1Mint = new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB");

    console.log("\n📊 Swap Parameters:");
    console.log("  Token Mint (base):", tokenMint.toBase58());
    console.log("  Quote Mint (USD1):", usd1Mint.toBase58());
    console.log("  Direction: buy (quote -> base)");
    
    // USD1 has 6 decimals, so 0.1 USD1 = 100000 raw units
    const amountInUSD1 = 0.1; // 0.1 USD1
    const usd1Decimals = 6;
    const amountIn = new BN(amountInUSD1 * Math.pow(10, usd1Decimals));
    console.log("  Amount In:", amountInUSD1, "USD1 (", amountIn.toString(), "raw units)");

    console.log("\n🔨 Building transaction...");
    const { transaction, instructions } = await buildRaydiumLaunchlabTransaction({
      baseMint: tokenMint,
      quoteMint: usd1Mint,
      direction: "buy",
      amountIn,
      minimumAmountOut: new BN(0), // No slippage protection for testing
      payer: MAIN_KP,
      shareFeeRate: new BN(0),
    });

    console.log("✅ Transaction built successfully!");
    console.log("  Number of instructions:", instructions.length);
    console.log("  Transaction size:", transaction.serialize().length, "bytes");

    console.log("\n🔍 Simulating transaction...");
    const simulation = await connection.simulateTransaction(transaction, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });

    if (simulation.value.err) {
      console.error("❌ Simulation failed!");
      console.error("Error:", JSON.stringify(simulation.value.err, null, 2));
      if (simulation.value.logs) {
        console.error("Logs:");
        simulation.value.logs.forEach((log: string) => console.error("  ", log));
      }
      throw new Error("Transaction simulation failed");
    }

    console.log("✅ Simulation successful!");
    console.log("  Compute units used:", simulation.value.unitsConsumed?.toString() || "N/A");
    
    if (simulation.value.logs) {
      console.log("\n📝 Transaction logs (last 10):");
      simulation.value.logs.slice(-10).forEach((log: string) => console.log("  ", log));
    }

    console.log("\n✨ Transaction is valid and ready to send!");
    console.log("\nTo send the transaction, use:");
    console.log("  const txid = await connection.sendTransaction(transaction);");
    console.log("  await connection.confirmTransaction(txid);");

    const txid = await connection.sendTransaction(transaction);
    console.log("txid", txid)
    await connection.confirmTransaction(txid);

    return {
      success: true,
      transaction,
      instructions,
      simulation: simulation.value,
    };
  } catch (error: any) {
    console.error("❌ Test failed:", error);
    if (error.message) {
      console.error("Error message:", error.message);
    }
    if (error.logs) {
      console.error("Error logs:", error.logs);
    }
    throw error;
  }
};

// Uncomment to run test directly:
// testSwapTransaction().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1); });
