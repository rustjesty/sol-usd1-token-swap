import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey
} from "@solana/web3.js"
import bs58 from "bs58"
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Mixer } from "./idl/mixer.idl";
import mixerIDL from "./idl/mixer.idl.json";
import { connection, MAIN_KP } from "./config";

const commitment = "confirmed";
// Helper function to create program instance with correct payer
const getProgram = (payer: Keypair): Program<Mixer> => {
  const wallet = new NodeWallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment });
  return new Program<Mixer>(mixerIDL as Mixer, provider);
};

const getStagingPDAWithBump = (
  layer: number,
  payer: PublicKey,
  recipient: PublicKey,
  roundId: anchor.BN,
  programId: PublicKey
): [PublicKey, number] => {
  const roundIdBytes = roundId.toArrayLike(Buffer, "le", 8);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("staging"),
      Buffer.from([layer]),
      payer.toBuffer(),
      recipient.toBuffer(),
      roundIdBytes,
    ],
    programId
  );
};

const deriveStagingPDAs = (
  layers: number,
  payer: PublicKey,
  recipient: PublicKey,
  roundId: anchor.BN,
  programId: PublicKey
): Array<[PublicKey, number]> =>
  Array.from({ length: layers - 1 }, (_, idx) =>
    getStagingPDAWithBump(idx + 1, payer, recipient, roundId, programId)
  );

export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

// Process transfers in parallel batches for better performance
const CONCURRENT_BATCH_SIZE = 20; // Process 20 transfers concurrently

export const obfuscateWallets_v2 = async (
  destinations: any[],
  amounts: number[],
  sender: string,
  logIdentifier: string
) => {
  const length = destinations.length;
  console.log("calling obfuscateWallets_v2...", length);
  const startTime = performance.now();
  const finalLogId = logIdentifier || `obfuscateWallets-${Date.now()}`;
  const signatures: string[] = [];
  const errors: Array<{ index: number; error: string }> = [];
  
  console.log("sender", sender);
  try {
    const fundingKeypair = Keypair.fromSecretKey(bs58.decode(sender));
    
    // CRITICAL: Check if funding account exists on-chain
    const fundingAccountInfo = await connection.getAccountInfo(fundingKeypair.publicKey);

    console.log("fundingAccountInfo", fundingAccountInfo);
    if (!fundingAccountInfo) {
      throw new Error(
        `Funding account ${fundingKeypair.publicKey.toBase58()} does not exist on-chain. ` +
        `Please fund this account first with SOL before attempting transfers.`
      );
    }
    
    // Check total cost upfront
    const rentLamports = await connection.getMinimumBalanceForRentExemption(0);
    const totalRentCost = rentLamports * 4 * length; // 4 staging accounts per transfer
    const totalTransferAmount = amounts.reduce((sum, amt) => {
      const lamports = amt >= LAMPORTS_PER_SOL ? Math.round(amt) : Math.round(amt * LAMPORTS_PER_SOL);
      return sum + lamports;
    }, 0);
    const estimatedFees = 10000 * length; // ~10k lamports per transaction
    const totalRequired = totalRentCost + totalTransferAmount + estimatedFees;

    const payerBalance = fundingAccountInfo.lamports;
    
    console.log(`Funding account balance: ${(payerBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    console.log(`Total required: ${(totalRequired / LAMPORTS_PER_SOL).toFixed(6)} SOL`);
    
    if (payerBalance < totalRequired) {
      const shortfall = totalRequired - payerBalance;
      throw new Error(
        `Insufficient balance. Required: ${(totalRequired / LAMPORTS_PER_SOL).toFixed(6)} SOL, ` +
        `Available: ${(payerBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL, ` +
        `Shortfall: ${(shortfall / LAMPORTS_PER_SOL).toFixed(6)} SOL`
      );
    }

    // Validate all amounts before processing
    for (let i = 0; i < length; i++) {
      const amount = amounts[i];
      if (!Number.isFinite(amount) || amount <= 0) {
        throw new Error(`Invalid mixer transfer amount at index ${i}: ${amount}`);
      }
    }

    // Create transfer promises with unique roundIds to avoid collisions
    const baseTimestamp = Date.now();
    const transferPromises = destinations.map((destination, index) => {
      const recipient = new PublicKey(destination);
      const amount = amounts[index];
      // Use index + timestamp to ensure unique roundId for each transfer
      const uniqueRoundId = baseTimestamp + index;
      return mediatedTransferWithRoundId(
        fundingKeypair,
        recipient,
        amount,
        new anchor.BN(uniqueRoundId),
        index
      );
    });

    // Process transfers in parallel batches
    console.log(`[${finalLogId}]: Processing ${length} transfers in parallel batches of ${CONCURRENT_BATCH_SIZE}`);
    
    for (let i = 0; i < transferPromises.length; i += CONCURRENT_BATCH_SIZE) {
      const batch = transferPromises.slice(i, i + CONCURRENT_BATCH_SIZE);
      const batchNumber = Math.floor(i / CONCURRENT_BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(transferPromises.length / CONCURRENT_BATCH_SIZE);
      
      console.log(`[${finalLogId}]: Processing batch ${batchNumber}/${totalBatches} (${batch.length} transfers)`);
      
      const batchResults = await Promise.allSettled(batch);
      
      // Process batch results
      batchResults.forEach((result, batchIndex) => {
        const actualIndex = i + batchIndex;
        if (result.status === 'fulfilled') {
          signatures.push(result.value);
          console.log(`[${finalLogId}]: Transfer ${actualIndex + 1}/${length} succeeded: ${result.value}`);
        } else {
          const errorMsg = result.reason?.message || 'Unknown error';
          errors.push({ index: actualIndex, error: errorMsg });
          console.error(`[${finalLogId}]: Transfer ${actualIndex + 1}/${length} failed:`, errorMsg);
        }
      });
      
      // Small delay between batches to avoid overwhelming the RPC
      if (i + CONCURRENT_BATCH_SIZE < transferPromises.length) {
        await sleep(500); // 500ms delay between batches
      }
    }

    const completedTime = performance.now() - startTime;
    const successCount = signatures.length;
    const failureCount = errors.length;

    console.log(`[${finalLogId}]: Completed ${successCount}/${length} transfers successfully in ${(completedTime / 1000).toFixed(2)}s`);

    return [{
      success: successCount === length,
      signatures,
      totalTime: Math.round(completedTime),
      successCount,
      failureCount,
      errors: errors.length > 0 ? errors : undefined
    }];

  } catch (error: any) {
    const totalTime = performance.now() - startTime;
    console.log("Wallet obfuscation failed Error ==> ", error);

    return [{
      success: false,
      mixerWallets: [],
      signatures,
      totalTime: Math.round(totalTime),
      error: error.message,
      successCount: signatures.length,
      failureCount: length - signatures.length
    }];
  }
};

// Internal function that accepts a specific roundId for parallel processing
const mediatedTransferWithRoundId = async (
  payer: Keypair, 
  recipient: PublicKey, 
  amount: number,
  roundId: anchor.BN,
  index: number
): Promise<string> => {
  const lamports =
    amount >= LAMPORTS_PER_SOL
      ? Math.round(amount)
      : Math.round(amount * LAMPORTS_PER_SOL);

  if (!Number.isFinite(lamports) || lamports <= 0) {
    throw new Error(`Invalid transfer amount supplied: ${amount}`);
  }

  // Create program instance with the actual payer
  const program = getProgram(payer);

  // Check if payer account exists on-chain
  const payerAccountInfo = await connection.getAccountInfo(payer.publicKey);
  
  if (!payerAccountInfo) {
    throw new Error(
      `Payer account ${payer.publicKey.toBase58()} does not exist on-chain. ` +
      `Please fund this account first before attempting transfers.`
    );
  }

  // Validate payer has sufficient balance (note: this check happens per-transfer
  // but the upfront check in obfuscateWallets_v2 ensures total balance is sufficient)
  const rentLamports = await connection.getMinimumBalanceForRentExemption(0);
  const requiredLamports = lamports + (rentLamports * 4) + 20000; // transfer + rent for 4 staging + fees
  const payerBalance = payerAccountInfo.lamports;

  if (payerBalance < requiredLamports) {
    const shortfall = requiredLamports - payerBalance;
    throw new Error(
      `Payer has insufficient balance. Required: ${(requiredLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL ` +
      `(${(lamports / LAMPORTS_PER_SOL).toFixed(6)} transfer + ${(rentLamports * 4 / LAMPORTS_PER_SOL).toFixed(6)} rent + fees), ` +
      `Available: ${(payerBalance / LAMPORTS_PER_SOL).toFixed(6)} SOL, ` +
      `Shortfall: ${(shortfall / LAMPORTS_PER_SOL).toFixed(6)} SOL`
    );
  }

  console.log(`[Transfer ${index}]: roundId: ${roundId.toString()}, recipient: ${recipient.toBase58()}`);

  const stagingAccountsWithBumps = deriveStagingPDAs(
    5, 
    payer.publicKey, 
    recipient, 
    roundId,
    program.programId
  );
  const [staging1, staging2, staging3, staging4] = stagingAccountsWithBumps.map(([pk, _]) => pk);

  // Verify none of the staging accounts already exist (to avoid conflicts)
  const stagingChecks = await Promise.all([
    connection.getAccountInfo(staging1),
    connection.getAccountInfo(staging2),
    connection.getAccountInfo(staging3),
    connection.getAccountInfo(staging4),
  ]);

  stagingChecks.forEach((info, idx) => {
    if (info && info.lamports > 0) {
      console.warn(`[Transfer ${index}]: Warning: staging${idx + 1} already exists with ${info.lamports} lamports`);
    }
  });

  try {
    const signature = await program.methods
      // @ts-ignore
      .multiLayerTransfer(new anchor.BN(lamports), 5, roundId)
      .accounts({
        payer: payer.publicKey,
        staging1,
        staging2,
        staging3,
        staging4,
        recipient: recipient,
      })
      .signers([payer])
      .rpc();

    console.log(`[Transfer ${index}]: Mediated Transfer Signature: ${signature}`);
    
    // Wait for confirmation with processed commitment (faster than finalized)
    await connection.confirmTransaction(signature, "processed");
    
    return signature;
  } catch (error: any) {
    console.error(`[Transfer ${index}]: Transaction failed:`, error);
    
    // Try to get more detailed error information
    if (error.logs) {
      console.error(`[Transfer ${index}]: Transaction logs:`, error.logs);
    }
    
    throw new Error(`Mediated transfer failed: ${error.message}`);
  }
};

// Public API that uses current timestamp (for backward compatibility)
export const mediatedTransfer = async (
  payer: Keypair, 
  recipient: PublicKey, 
  amount: number
) => {
  const roundId = new anchor.BN(Date.now());
  return mediatedTransferWithRoundId(payer, recipient, amount, roundId, -1);
};

mediatedTransfer(
  MAIN_KP,
  new PublicKey("mAWPeEHpPm7KpYKAdfmNJ8wme8fQdo5JJbdSsH83e2q"),
  0.57
)