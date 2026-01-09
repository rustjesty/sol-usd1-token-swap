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
} from "@solana/spl-token";

import {
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
import { ApiV3Token, getPdaLaunchpadConfigId, initialize, initializeV2, LAUNCHPAD_PROGRAM, LaunchpadConfig, LaunchpadPoolInitParam, TxVersion, CpmmCreatorFeeOn, getPdaLaunchpadPoolId, getPdaLaunchpadVaultId } from "@raydium-io/raydium-sdk-v2";
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

// create token by instructions
export const createTokenTxV2 = async (connection: Connection, mainKp: Keypair, mintKp: Keypair) => {
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
      mainKp.publicKey,
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
      tokenMint: mintKp.publicKey
    })

    instructions.push(...swapInstructions.instructions)

    // Build transaction message
    const latestBlockhash = await connection.getLatestBlockhash()
    const messageV0 = new TransactionMessage({
      payerKey: mainKp.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions,
    }).compileToV0Message()

    const transaction = new VersionedTransaction(messageV0)
    transaction.sign([mainKp, mintKp])
    console.log("simulation: ", await connection.simulateTransaction(transaction))

    // const signature = await connection.sendTransaction(transaction)
    // console.log("signature", signature)

    // return signature

  } catch (error) {
    console.error("createTokenTx error:", error);
    throw error;
  }
}

export const createTokenTxV1 = async (connection: Connection, mainKp: Keypair, mintKp: Keypair) => {
  try {
    // Initialize SDK
    const raydium = await initSdk();

    const configId = getPdaLaunchpadConfigId(new PublicKey(LAUNCHPAD_PROGRAM), usd1Mint, 0, 0).publicKey

    const configData = await raydium.connection.getAccountInfo(configId)
    if (!configData) throw new Error('config not found')
    const configInfo  = LaunchpadConfig.decode(configData?.data)
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
      createOnly: buyAmount<=0, // true means create mint only, false will "create and buy together"
  
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
    
    transaction.sign([mainKp, mintKp]);
    
    // Add simulation options to get more detailed error information
    console.log("simulation", await connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true
    }))


    // transaction.sign([mainKp, mintKp]);
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