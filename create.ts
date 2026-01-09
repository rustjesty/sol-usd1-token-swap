import {
  Account,
  createMintToInstruction,
  createTransferInstruction,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  createInitializeMint2Instruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  initializeMint2InstructionData,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  getAccount,
} from "@solana/spl-token";

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction
} from "@solana/web3.js";
import { initSdk, MAIN_KP } from "./config";
import { ApiV3Token, getPdaLaunchpadConfigId, initialize, initializeV2, LAUNCHPAD_PROGRAM, LaunchpadConfig, LaunchpadPoolInitParam, TxVersion, CpmmCreatorFeeOn, getPdaLaunchpadPoolId, getPdaLaunchpadVaultId, buyExactInInstruction, getPdaCreatorVault, getPdaPlatformVault } from "@raydium-io/raydium-sdk-v2";
import axios from "axios";
import base58 from "bs58";
import { BN } from "bn.js";
import { readFile } from "fs/promises";
import { openAsBlob } from "fs";
import { buildSwapInstructions } from "./swap";


export const IMAGE_URL = "./public/slx.png"
export const TOKEN_INFO: any = {
  name: "AAA",
  symbol: "AAA",
}

const usd1Mint = new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB")

// create token by instructions for raydium clmm + raydium launchlab swap
export const createTokenTxV3 = async (connection: Connection, payer: Keypair, mintKp: Keypair) => {
  try {
    // Initialize SDK
    const raydium = await initSdk();

    const configId = getPdaLaunchpadConfigId(new PublicKey(LAUNCHPAD_PROGRAM), usd1Mint, 0, 0).publicKey


    const platformId = new PublicKey('FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1')

    const authProgramId = new PublicKey('WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh')

    const poolId = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintKp.publicKey, usd1Mint).publicKey

    console.log("poolId", poolId)

    // Derive vault PDAs based on poolId and mints
    // vaultA holds base tokens (mintKp.publicKey), vaultB holds quote tokens (usd1Mint)
    const vaultA = getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, poolId, mintKp.publicKey).publicKey
    const vaultB = getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, poolId, usd1Mint).publicKey

    console.log("vaultA (base token vault):", vaultA.toBase58())
    console.log("vaultB (quote token vault):", vaultB.toBase58())

    // Derive metadata PDA for the mint
    // Metaplex metadata PDA: seeds = ["metadata", metadata_program_id, mint_address]
    const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
    const [metadataId] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        METADATA_PROGRAM_ID.toBuffer(),
        mintKp.publicKey.toBuffer(),
      ],
      METADATA_PROGRAM_ID
    )
    console.log("metadataId (derived PDA):", metadataId.toBase58())


    const decimals = 6;

    const file = await openAsBlob(IMAGE_URL)

    let imageMetadata = await createImageMetadata(file);

    console.log("imageMetadata", imageMetadata)

    const tokenInfo = {
      name: TOKEN_INFO.name,
      symbol: TOKEN_INFO.symbol,
      description: "DESCRIPTION",
      createdOn: "https://bonk.fun",
      platformId: "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1",
      image: imageMetadata
    }

    let uri = await createBonkTokenMetadata(tokenInfo);

    console.log("uri", uri);

    if (!uri) {
      throw new Error("Token metadata URI is undefined");
    }

    // Prepare curve parameters for AMM migration
    const curveParam = {
      type: "ConstantCurve" as const,
      migrateType: "amm" as const, // Migrate to AMM (not CPMM)
      supply: LaunchpadPoolInitParam.supply,
      totalFundRaisingB: LaunchpadPoolInitParam.totalFundRaisingB,
      totalSellA: LaunchpadPoolInitParam.totalSellA,
    }

    const tokenCreateInstruction = initializeV2(
      new PublicKey(LAUNCHPAD_PROGRAM),
      payer.publicKey,
      mintKp.publicKey,
      configId,
      platformId,
      authProgramId,
      poolId,
      mintKp.publicKey,
      usd1Mint,
      vaultA,
      vaultB,
      metadataId,
      decimals,
      TOKEN_INFO.name,
      TOKEN_INFO.symbol,
      uri,
      curveParam,
      LaunchpadPoolInitParam.totalLockedAmount,
      LaunchpadPoolInitParam.cliffPeriod,
      LaunchpadPoolInitParam.unlockPeriod,
      CpmmCreatorFeeOn.OnlyTokenB
    )

    const instructions = [tokenCreateInstruction]

    const swapInstructions = await buildSwapInstructions({
      direction: 'buy',
      amountIn: 0.001,
      tokenMint: mintKp.publicKey,
      isDevBuy: true,
      // tokenMint: new PublicKey("CPgobeEZLk82DdXqWxBiwvvE2tkQwDd12AuR1V8TqwXu"),
      // isDevBuy: false,
      payer,
      deployerPubKey: payer.publicKey
    })

    instructions.push(...swapInstructions.instructions)

    // Estimate transaction size before building
    // Rough estimate: each instruction account = 32 bytes, instruction data varies
    // Header overhead for v0 transaction is approximately 3-5 bytes
    // Signatures add ~64 bytes per signature (2 signers = 128 bytes)
    const estimatedSize = instructions.reduce((size, ix) => {
      // Instruction header: 1 byte (program index) + 1-2 bytes (account count) + 1-2 bytes (data length)
      // Account keys: 32 bytes each + 1 byte (writable/signer flags) per account
      // Instruction data: variable length
      return size + 4 + (ix.keys.length * 33) + (ix.data.length || 0)
    }, 0) + 128 + 10 // +128 for signatures, +10 for message header

    console.log(`Estimated transaction size: ~${estimatedSize} bytes`)
    console.log(`Number of instructions: ${instructions.length}`)

    // Solana transaction size limit is 1232 bytes for versioned transactions
    const MAX_TRANSACTION_SIZE = 1232
    // if (estimatedSize > MAX_TRANSACTION_SIZE) {
    //   throw new Error(
    //     `Transaction is too large (estimated ${estimatedSize} bytes, max ${MAX_TRANSACTION_SIZE} bytes). ` +
    //     `Consider splitting into multiple transactions:\n` +
    //     `1. Create token transaction\n` +
    //     `2. Swap transaction (after token creation)`
    //   )
    // }

    // Build transaction message
    const latestBlockhash = await connection.getLatestBlockhash()

    // Fetch lookup table account if provided
    let lookupTables: AddressLookupTableAccount[] | undefined = undefined
    const lutAddress = new PublicKey("4n2KqqgWJcjqJ4U7SVqL8tduhoFZwu15EzjBYjRGmgA7")
    try {
      const lookupTableAccount = await connection.getAddressLookupTable(lutAddress)
      if (lookupTableAccount.value) {
        lookupTables = [lookupTableAccount.value]
      }
    } catch (error) {
      console.warn("Failed to fetch lookup table:", error)
    }
    console.log("lookupTables", lookupTables)
    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message(lookupTables)

    const transaction = new VersionedTransaction(messageV0)

    try {
      transaction.sign([payer, mintKp])
    } catch (error: any) {
      if (error.message?.includes('encoding overruns') || error.message?.includes('RangeError')) {
        throw new Error(
          `Transaction is too large to serialize. The combined token creation and swap instructions exceed Solana's transaction size limit (${MAX_TRANSACTION_SIZE} bytes). ` +
          `Please split into two separate transactions:\n` +
          `1. First transaction: Create token only\n` +
          `2. Second transaction: Execute swap after token is created`
        )
      }
      throw error
    }

    // Calculate actual transaction size after signing
    const txSize = transaction.serialize().length
    console.log(`Actual transaction size: ${txSize} bytes`)

    if (txSize > MAX_TRANSACTION_SIZE) {
      throw new Error(`Transaction size (${txSize} bytes) exceeds maximum allowed size (${MAX_TRANSACTION_SIZE} bytes). Consider splitting into multiple transactions.`)
    }

    console.log("simulation: ", await connection.simulateTransaction(transaction))
    // const signature = await connection.sendTransaction(transaction)
    // console.log("signature", signature)

    // return signature

  } catch (error) {
    console.error("createTokenTx error:", error);
    throw error;
  }
}

// create token by instructions
export const createTokenTxV2 = async (connection: Connection, payer: Keypair, mintKp: Keypair) => {
  try {
    // Initialize SDK
    const raydium = await initSdk();
    const payer = MAIN_KP

    const configId = getPdaLaunchpadConfigId(new PublicKey(LAUNCHPAD_PROGRAM), usd1Mint, 0, 0).publicKey


    const platformId = new PublicKey('FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1')

    const authProgramId = new PublicKey('WLHv2UAZm6z4KyaaELi5pjdbJh6RESMva1Rnn8pJVVh')
    const platformVault = getPdaPlatformVault(LAUNCHPAD_PROGRAM, platformId, usd1Mint).publicKey
    const poolId = getPdaLaunchpadPoolId(LAUNCHPAD_PROGRAM, mintKp.publicKey, usd1Mint).publicKey

    console.log("poolId", poolId)

    // Derive vault PDAs based on poolId and mints
    // vaultA holds base tokens (mintKp.publicKey), vaultB holds quote tokens (usd1Mint)
    const vaultA = getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, poolId, mintKp.publicKey).publicKey
    const vaultB = getPdaLaunchpadVaultId(LAUNCHPAD_PROGRAM, poolId, usd1Mint).publicKey

    console.log("vaultA (base token vault):", vaultA.toBase58())
    console.log("vaultB (quote token vault):", vaultB.toBase58())

    // Derive metadata PDA for the mint
    // Metaplex metadata PDA: seeds = ["metadata", metadata_program_id, mint_address]
    const METADATA_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s")
    const [metadataId] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("metadata"),
        METADATA_PROGRAM_ID.toBuffer(),
        mintKp.publicKey.toBuffer(),
      ],
      METADATA_PROGRAM_ID
    )
    console.log("metadataId (derived PDA):", metadataId.toBase58())


    const decimals = 6;

    const file = await openAsBlob(IMAGE_URL)

    let imageMetadata = await createImageMetadata(file);

    console.log("imageMetadata", imageMetadata)

    const tokenInfo = {
      name: TOKEN_INFO.name,
      symbol: TOKEN_INFO.symbol,
      description: "DESCRIPTION",
      createdOn: "https://bonk.fun",
      platformId: "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1",
      image: imageMetadata
    }

    let uri = await createBonkTokenMetadata(tokenInfo);

    console.log("uri", uri);

    if (!uri) {
      throw new Error("Token metadata URI is undefined");
    }

    // Prepare curve parameters for AMM migration
    const curveParam = {
      type: "ConstantCurve" as const,
      migrateType: "amm" as const, // Migrate to AMM (not CPMM)
      supply: LaunchpadPoolInitParam.supply,
      totalFundRaisingB: LaunchpadPoolInitParam.totalFundRaisingB,
      totalSellA: LaunchpadPoolInitParam.totalSellA,
    }

    const tokenCreateInstruction = initializeV2(
      new PublicKey(LAUNCHPAD_PROGRAM),
      payer.publicKey,
      mintKp.publicKey,
      configId,
      platformId,
      authProgramId,
      poolId,
      mintKp.publicKey,
      usd1Mint,
      vaultA,
      vaultB,
      metadataId,
      decimals,
      TOKEN_INFO.name,
      TOKEN_INFO.symbol,
      uri,
      curveParam,
      LaunchpadPoolInitParam.totalLockedAmount,
      LaunchpadPoolInitParam.cliffPeriod,
      LaunchpadPoolInitParam.unlockPeriod,
      CpmmCreatorFeeOn.OnlyTokenB
    )

    const instructions = [tokenCreateInstruction]

    const creatorVault = getPdaCreatorVault(LAUNCHPAD_PROGRAM, payer.publicKey, usd1Mint).publicKey
    const userTokenAccountA = getAssociatedTokenAddressSync(mintKp.publicKey, payer.publicKey)
    const userTokenAccountB = getAssociatedTokenAddressSync(usd1Mint, payer.publicKey)
  
    // Check USD1 account balance for buy instruction
    let usd1Balance = new BN(0)
    try {
      const usd1Account = await getAccount(connection, userTokenAccountB)
      usd1Balance = new BN(usd1Account.amount.toString())
      console.log(`USD1 account balance: ${usd1Balance.toString()} raw units (${usd1Balance.toNumber() / Math.pow(10, 6)} USD1)`)
    } catch (error) {
      console.log("USD1 account doesn't exist yet or has zero balance")
    }

    // For newly created Launchpad pools, minimum buy is typically 1 USD1 or more
    // Only include buy instruction if we have sufficient balance
    const usd1Decimals = 6
    const minRequiredBuyAmount = new BN(1 * Math.pow(10, usd1Decimals)) // 1 USD1 minimum for newly created pool
    
    if (usd1Balance.gte(minRequiredBuyAmount)) {
      // Create token account for receiving tokens before buy
      const tokenAccountAInfo = await connection.getAccountInfo(userTokenAccountA)
      if (!tokenAccountAInfo) {
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            userTokenAccountA,
            payer.publicKey,
            mintKp.publicKey
          )
        )
      }

      const tokenAccountBInfo = await connection.getAccountInfo(userTokenAccountB)
      if (!tokenAccountBInfo) {
        instructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            payer.publicKey,
            userTokenAccountB,
            payer.publicKey,
            usd1Mint
          )
        )
      }

      // Use 1 USD1 for buy (safe minimum for newly created pools)
      const buyAmount = minRequiredBuyAmount
      console.log(`Including buy instruction with amount: ${buyAmount.toString()} raw units (${buyAmount.toNumber() / Math.pow(10, usd1Decimals)} USD1)`)
      
      const buyInstruction = buyExactInInstruction(
        LAUNCHPAD_PROGRAM,
        payer.publicKey,
        authProgramId,
        configId,
        platformId,
        poolId,
        userTokenAccountA, // Receives token (output, mintA)
        userTokenAccountB, // Has quote token (input, mintB)
        vaultA,
        vaultB,
        mintKp.publicKey, // mintA: token being bought
        usd1Mint, // mintB: input token (quote token)
        TOKEN_PROGRAM_ID,
        TOKEN_PROGRAM_ID,
        platformVault,
        creatorVault,
        buyAmount,
        new BN(0), // Minimum tokens to receive
      )
      instructions.push(buyInstruction)
    } else {
      console.log(`Skipping buy instruction - insufficient USD1 balance. Have: ${usd1Balance.toString()} raw units (${usd1Balance.toNumber() / Math.pow(10, usd1Decimals)} USD1), Need at least: ${minRequiredBuyAmount.toString()} raw units (${minRequiredBuyAmount.toNumber() / Math.pow(10, usd1Decimals)} USD1)`)
      console.log(`Token will be created but no buy will be executed. Please add more USD1 and buy separately.`)
    }

    // Estimate transaction size before building
    // Rough estimate: each instruction account = 32 bytes, instruction data varies
    // Header overhead for v0 transaction is approximately 3-5 bytes
    // Signatures add ~64 bytes per signature (2 signers = 128 bytes)
    const estimatedSize = instructions.reduce((size, ix) => {
      // Instruction header: 1 byte (program index) + 1-2 bytes (account count) + 1-2 bytes (data length)
      // Account keys: 32 bytes each + 1 byte (writable/signer flags) per account
      // Instruction data: variable length
      return size + 4 + (ix.keys.length * 33) + (ix.data.length || 0)
    }, 0) + 128 + 10 // +128 for signatures, +10 for message header

    console.log(`Estimated transaction size: ~${estimatedSize} bytes`)
    console.log(`Number of instructions: ${instructions.length}`)

    // Solana transaction size limit is 1232 bytes for versioned transactions
    const MAX_TRANSACTION_SIZE = 1232
    // if (estimatedSize > MAX_TRANSACTION_SIZE) {
    //   throw new Error(
    //     `Transaction is too large (estimated ${estimatedSize} bytes, max ${MAX_TRANSACTION_SIZE} bytes). ` +
    //     `Consider splitting into multiple transactions:\n` +
    //     `1. Create token transaction\n` +
    //     `2. Swap transaction (after token creation)`
    //   )
    // }

    // Build transaction message
    const latestBlockhash = await connection.getLatestBlockhash()

    // Fetch lookup table account if provided
    let lookupTables: AddressLookupTableAccount[] | undefined = undefined
    const lutAddress = new PublicKey("4n2KqqgWJcjqJ4U7SVqL8tduhoFZwu15EzjBYjRGmgA7")
    try {
      const lookupTableAccount = await connection.getAddressLookupTable(lutAddress)
      if (lookupTableAccount.value) {
        lookupTables = [lookupTableAccount.value]
      }
    } catch (error) {
      console.warn("Failed to fetch lookup table:", error)
    }
    console.log("lookupTables", lookupTables)
    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message(lookupTables)

    const transaction = new VersionedTransaction(messageV0)

    try {
      transaction.sign([payer, mintKp])
    } catch (error: any) {
      if (error.message?.includes('encoding overruns') || error.message?.includes('RangeError')) {
        throw new Error(
          `Transaction is too large to serialize. The combined token creation and swap instructions exceed Solana's transaction size limit (${MAX_TRANSACTION_SIZE} bytes). ` +
          `Please split into two separate transactions:\n` +
          `1. First transaction: Create token only\n` +
          `2. Second transaction: Execute swap after token is created`
        )
      }
      throw error
    }

    // Calculate actual transaction size after signing
    const txSize = transaction.serialize().length
    console.log(`Actual transaction size: ${txSize} bytes`)

    if (txSize > MAX_TRANSACTION_SIZE) {
      throw new Error(`Transaction size (${txSize} bytes) exceeds maximum allowed size (${MAX_TRANSACTION_SIZE} bytes). Consider splitting into multiple transactions.`)
    }

    console.log("simulation: ", await connection.simulateTransaction(transaction))
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: true
    })
    console.log("signature", signature)

    return signature

  } catch (error) {
    console.error("createTokenTx error:", error);
    throw error;
  }
}

export const createTokenTxV1 = async (connection: Connection, payer: Keypair, mintKp: Keypair) => {
  try {
    // Initialize SDK
    const raydium = await initSdk();

    const configId = getPdaLaunchpadConfigId(new PublicKey(LAUNCHPAD_PROGRAM), usd1Mint, 0, 0).publicKey

    const configData = await raydium.connection.getAccountInfo(configId)
    if (!configData) throw new Error('config not found')
    const configInfo = LaunchpadConfig.decode(configData?.data)
    const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB)


    console.log("configInfo", configInfo)
    console.log("configId", configId)

    const owner = raydium.ownerPubKey;

    const newMintData = {
      wallet: owner.toBase58(),
      name: 'testname',
      symbol: 'test',
      // website: '',
      // twitter: '',
      // telegram: '',
      configId: configId.toString(),
      decimals: LaunchpadPoolInitParam.decimals,
      supply: LaunchpadPoolInitParam.supply, // or custom set up supply
      totalSellA: LaunchpadPoolInitParam.totalSellA, // or custom set up totalSellA
      totalFundRaisingB: LaunchpadPoolInitParam.totalFundRaisingB,
      totalLockedAmount: LaunchpadPoolInitParam.totalLockedAmount,
      cliffPeriod: LaunchpadPoolInitParam.cliffPeriod,
      unlockPeriod: LaunchpadPoolInitParam.unlockPeriod,
      // set your platform id, current platform: bonk
      platformId: new PublicKey('FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1'),
      migrateType: 'amm', // or cpmm
      description: 'description',
    }

    // Set up transaction parameters
    // buyAmount is in quote token (USD1) units, so use mintB decimals (6 for USD1)
    const buyAmount = 0.455; // 0.001 USD1
    const buyAmountBN = new BN(buyAmount * Math.pow(10, mintBInfo.decimals))
    console.log(`Buy amount: ${buyAmount} ${mintBInfo.symbol} = ${buyAmountBN.toString()} raw units (decimals: ${mintBInfo.decimals})`)
    const slippageAmount = 0.1;
    const slippage = new BN(slippageAmount * 100);
    const buffer = await readFile(IMAGE_URL);
    const blob = new Blob([new Uint8Array(buffer)]);


    const file = await openAsBlob(IMAGE_URL)

    let imageMetadata = await createImageMetadata(file);

    console.log("imageMetadata", imageMetadata)

    const tokenInfo = {
      name: TOKEN_INFO.name,
      symbol: TOKEN_INFO.symbol,
      description: "DESCRIPTION",
      createdOn: "https://bonk.fun",
      platformId: "FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1",
      image: imageMetadata
    }

    let uri = await createBonkTokenMetadata(tokenInfo);

    console.log("uri", uri);

    if (!uri) {
      throw new Error("Token metadata URI is undefined");
    }

    // Create launchpad transaction

    const { execute, transactions, extInfo } = await raydium.launchpad.createLaunchpad({
      programId: LAUNCHPAD_PROGRAM,
      mintA: mintKp.publicKey,
      decimals: newMintData.decimals,
      name: newMintData.name,
      symbol: newMintData.symbol,
      uri,
      configId,
      configInfo, // optional, sdk will get data by configId if not provided
      migrateType: newMintData.migrateType as 'amm' | 'cpmm',
      mintBDecimals: mintBInfo.decimals, // Use decimals from config response

      platformId: newMintData.platformId,
      txVersion: TxVersion.V0,
      slippage: slippage, // means 1%
      buyAmount: buyAmountBN,
      createOnly: buyAmount <= 0, // true means create mint only, false will "create and buy together"

      supply: newMintData.supply, // lauchpad mint supply amount, default: LaunchpadPoolInitParam.supply
      totalSellA: newMintData.totalSellA, // lauchpad mint sell amount, default: LaunchpadPoolInitParam.totalSellA
      totalFundRaisingB: newMintData.totalFundRaisingB, // if mintB = SOL, means 85 SOL, default: LaunchpadPoolInitParam.totalFundRaisingB
      totalLockedAmount: newMintData.totalLockedAmount, // total locked amount, default 0
      cliffPeriod: newMintData.cliffPeriod, // unit: seconds, default 0
      unlockPeriod: newMintData.unlockPeriod, // unit: seconds, default 0
      initV2: true,
    });

    console.log("extInfo", extInfo)
    console.log("extInfo======>", extInfo)
    const amountA = extInfo.swapInfo.amountA.amount.toString()
    console.log("amountA======>", amountA)
    const amountB = extInfo.swapInfo.amountB.toString()
    console.log("amountB======>", amountB)
    const tipAccounts = [
      "Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY",
      "DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL",
      "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
      "3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT",
      "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
      "ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49",
      "ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt",
      "DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh",
    ];

    const jitoFeeWallet = new PublicKey(
      tipAccounts[Math.floor(Math.random() * tipAccounts.length)]
    );

    const { blockhash } = await connection.getLatestBlockhash();

    console.log("transactions", transactions)

    const transaction: VersionedTransaction = transactions[0]

    // Set the recent blockhash before signing
    // transaction.message.recentBlockhash = blockhash;

    transaction.sign([payer, mintKp]);

    // Add simulation options to get more detailed error information
    console.log("simulation", await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true
    }))


    // transaction.sign([payer, mintKp]);
    // const signature = await connection.sendTransaction(transaction)
    // console.log("signature", signature)

    // const confirmation = await connection.confirmTransaction(signature)
    // console.log("confirmation", confirmation);

    return transaction;
  } catch (error) {
    console.error("createTokenTx error:", error);
    throw error;
  }
}

export const createImageMetadata = async (file: any) => {
  let formData = new FormData();
  formData.append("image", file);

  try {
    const response = await fetch("https://storage.letsbonk.fun/upload/img", {
      method: "POST",
      body: formData,
    });

    const resultText = await response.text(); // the response is plain text (IPFS URL)
    console.log("Uploaded image link:", resultText);
    return resultText;
  } catch (error) {
    console.error("Upload failed:", error);
  }
}


export const createBonkTokenMetadata = async (create: any) => {
  const metadata = {
    name: create.name,
    symbol: create.symbol,
    description: create.description,
    createdOn: create.createdOn,
    platformId: create.platformId,
    image: create.image, // replace with your actual IPFS image link
  };


  try {
    const response = await fetch("https://storage.letsbonk.fun/upload/meta", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(metadata),
    });

    const resultText = await response.text(); // The response is a plain text IPFS URL
    console.log("Metadata IPFS link:", resultText);
    return resultText;
  } catch (error) {
    console.error("Metadata upload failed:", error);
  }
}