import {
  Account,
  createMintToInstruction,
  createTransferInstruction,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  createInitializeMint2Instruction,
  TOKEN_PROGRAM_ID,
  NATIVE_MINT,
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
import { ApiV3Token, LAUNCHPAD_PROGRAM, LaunchpadConfig, LaunchpadPoolInitParam, TxVersion } from "@raydium-io/raydium-sdk-v2";
import axios from "axios";
import base58 from "bs58";
import { BN } from "bn.js";
import { readFile } from "fs/promises";
import { openAsBlob } from "fs";

interface ConfigInfo {
  name: string
  pubKey: string
  epoch: number
  curveType: number
  index: number
  migrateFee: string
  tradeFeeRate: string
  maxShareFeeRate: string
  minSupplyA: string
  maxLockRate: string
  minSellRateA: string
  minMigrateRateA: string
  minFundRaisingB: string
  protocolFeeOwner: string
  migrateFeeOwner: string
  migrateToAmmWallet: string
  migrateToCpmmWallet: string
  mintB: string
}

export const IMAGE_URL = "./public/im.png"
export const TOKEN_INFO: any = {
  name: "AAA",
  symbol: "AAA",
}

export const createTokenTx = async (connection: Connection, mainKp: Keypair, mintKp: Keypair) => {
  try {
    // Initialize SDK
    const raydium = await initSdk();
    const mintHost = 'https://launch-mint-v1.raydium.io'

    const configRes: {
      data: {
        data: {
          data: {
            key: ConfigInfo
            mintInfoB: ApiV3Token
          }[]
        }
      }
    } = await axios.get(`${mintHost}/main/configs`)

    const configs = configRes.data.data.data[0].key
    const configInfo: ReturnType<typeof LaunchpadConfig.decode> = {
      index: configs.index,
      mintB: new PublicKey(configs.mintB),
      tradeFeeRate: new BN(configs.tradeFeeRate),
      epoch: new BN(configs.epoch),
      curveType: configs.curveType,
      migrateFee: new BN(configs.migrateFee),
      maxShareFeeRate: new BN(configs.maxShareFeeRate),
      minSupplyA: new BN(configs.minSupplyA),
      maxLockRate: new BN(configs.maxLockRate),
      minSellRateA: new BN(configs.minSellRateA),
      minMigrateRateA: new BN(configs.minMigrateRateA),
      minFundRaisingB: new BN(configs.minFundRaisingB),
      protocolFeeOwner: new PublicKey(configs.protocolFeeOwner),
      migrateFeeOwner: new PublicKey(configs.migrateFeeOwner),
      migrateToAmmWallet: new PublicKey(configs.migrateToAmmWallet),
      migrateToCpmmWallet: new PublicKey(configs.migrateToCpmmWallet),
    }
    const configId = new PublicKey(configRes.data.data.data[0].key.pubKey)
    const mintBInfo = configRes.data.data.data[0].mintInfoB

    console.log("configInfo", configInfo)
    console.log("configId", configId)
    console.log("mintBInfo", mintBInfo)

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


    // const configInfo = LaunchpadConfig.decode(configData.data);
    // const mintBInfo = await raydium.token.getTokenInfo(configInfo.mintB);

    // Set up transaction parameters
    const solBuyAmount = 0.01;
    const buyAmount = new BN(solBuyAmount * 10 ** 9);
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
      mintBDecimals: mintBInfo.decimals, // default 9
  
      platformId: newMintData.platformId,
      txVersion: TxVersion.V0,
      slippage: new BN(100), // means 1%
      buyAmount: new BN(10000),
      createOnly: true, // true means create mint only, false will "create and buy together"
  
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
    
    // // Add simulation options to get more detailed error information
    // console.log("simulation", await connection.simulateTransaction(transaction, {
    //   sigVerify: false,
    //   replaceRecentBlockhash: true
    // }))


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