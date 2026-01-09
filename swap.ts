import {
  VersionedTransaction,
  TransactionMessage,
  ComputeBudgetProgram,
  PublicKey,
  TransactionInstruction,
  AccountMeta,
  AccountInfo,
  LAMPORTS_PER_SOL,
  SystemProgram,
  AddressLookupTableAccount,
  Keypair
} from "@solana/web3.js"
import {
  AccountLayout,
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAssociatedTokenAddressSync,
  RawAccount,
  syncNative,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  NATIVE_MINT
} from "@solana/spl-token"
import { connection, MAIN_KP, initSdk } from "./config"
import BN from "bn.js"
import {
  PoolUtils,
  ApiV3PoolInfoConcentratedItem,
  ComputeClmmPoolInfo,
  ReturnTypeFetchMultiplePoolTickArrays,
  CLMM_PROGRAM_ID,
  PoolFetchType,
  buyExactInInstruction,
  sellExactInInstruction,
  getPdaLaunchpadAuth,
  LaunchpadPool,
  getPdaLaunchpadPoolId,
  getPdaPlatformVault,
  getPdaCreatorVault,
  getPdaLaunchpadVaultId,
  getPdaLaunchpadConfigId,
} from '@raydium-io/raydium-sdk-v2'
import * as anchor from "@coral-xyz/anchor"
import { Program } from "@coral-xyz/anchor"
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet"
import raydiumClmmIDL from "./idl/raydium-clmm.json"

const payer = MAIN_KP
console.log("payer: ", payer.publicKey.toBase58())

const swapAmount = 0.001;

export type SwapDirection = 'buy' | 'sell' // 'buy' = SOL -> Token, 'sell' = Token -> SOL

const usd1Mint = new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB")
// Helper function to find pool by mints
export const findPoolByMints = async (
  baseMint: string | PublicKey,
  quoteMint: string | PublicKey
): Promise<PublicKey | null> => {
  const raydium = await initSdk()

  const baseMintStr = typeof baseMint === 'string' ? baseMint : baseMint.toBase58()
  const quoteMintStr = typeof quoteMint === 'string' ? quoteMint : quoteMint.toBase58()

  // Fetch pools by mints
  const poolsResult = await raydium.api.fetchPoolByMints({
    mint1: baseMintStr,
    mint2: quoteMintStr,
    type: PoolFetchType.Concentrated, // CLMM pools
  })

  // Find the first CLMM pool (type === "Concentrated")
  const clmmPool = poolsResult.data.find(
    (pool): pool is ApiV3PoolInfoConcentratedItem =>
      pool.type === "Concentrated"
  )

  if (!clmmPool) {
    return null
  }

  return new PublicKey(clmmPool.id)
}

export function getDecodedATA(accountData: AccountInfo<Buffer> | null): RawAccount {
  if (!accountData) throw new Error("No account data!")

  return AccountLayout.decode(accountData.data)
}

// Get Anchor program instance
const getClmmProgram = (): Program => {
  const wallet = new NodeWallet(payer)
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" })
  return new Program(raydiumClmmIDL as anchor.Idl, provider)
}

// Types for CLMM swap instruction
export interface ClmmSwapParams {
  direction: SwapDirection
  baseMint: PublicKey
  quoteMint: PublicKey
  amount: number
  payer: PublicKey
  slippage?: number
}

export interface ClmmSwapResult {
  instruction: TransactionInstruction
  setupInstructions: TransactionInstruction[]
  inputTokenAccount: PublicKey
  outputTokenAccount: PublicKey
  inputTokenMint: PublicKey
  outputTokenMint: PublicKey
  expectedOutput: BN
  amountOutMin: BN
  tickArrays: PublicKey[]
  poolId: PublicKey
}

// Types for Launchpad swap instruction
export interface LaunchpadSwapParams {
  tokenMint: PublicKey // Token mint (e.g., Bonk)
  quoteMint: PublicKey // Quote token mint (e.g., USD1)
  direction: SwapDirection // 'buy' = quote -> token, 'sell' = token -> quote
  inputTokenAccount: PublicKey // Account that has the input token
  outputTokenAccount: PublicKey // Account that will receive the output token
  amountIn: BN // Input amount to swap
  payer: PublicKey
  deployer?: PublicKey
  isDevBuy: boolean
}

export interface LaunchpadSwapResult {
  instruction: TransactionInstruction
  setupInstructions: TransactionInstruction[]
}

/**
 * Builds a CLMM swap_v2 instruction
 */
export const buildClmmSwapInstruction = async (
  params: ClmmSwapParams
): Promise<ClmmSwapResult> => {
  const { baseMint, quoteMint, direction, amount, payer, slippage = 0.01 } = params

  let poolId: PublicKey

  const foundPoolId = await findPoolByMints(baseMint, quoteMint)
  if (!foundPoolId) {
    throw new Error(`Pool not found for mints: ${baseMint} / ${quoteMint}`)
  }
  poolId = foundPoolId


  const raydium = await initSdk()
  // Fetch pool info using SDK
  const poolData = await raydium.clmm.getPoolInfoFromRpc(poolId.toBase58())

  if (!poolData) {
    throw new Error("Pool not found")
  }

  const { poolInfo, poolKeys, computePoolInfo } = poolData

  // Convert string addresses to PublicKeys
  const mintA = new PublicKey(poolInfo.mintA.address)
  const mintB = new PublicKey(poolInfo.mintB.address)

  // Determine which mint is SOL/WSOL
  const isMintASOL = mintA.equals(NATIVE_MINT)
  const isMintBSOL = mintB.equals(NATIVE_MINT)
  const isSOLPool = isMintASOL || isMintBSOL

  if (!isSOLPool) {
    throw new Error("Pool does not contain SOL/WSOL. This function only handles SOL swaps.")
  }

  // Determine swap direction
  let inputTokenMint: PublicKey
  let outputTokenMint: PublicKey

  if (direction === 'buy') {
    inputTokenMint = NATIVE_MINT
    outputTokenMint = isMintASOL ? mintB : mintA
  } else {
    inputTokenMint = isMintASOL ? mintB : mintA
    outputTokenMint = NATIVE_MINT
  }

  // Get token accounts
  const inputTokenAccount = getAssociatedTokenAddressSync(inputTokenMint, payer)
  const outputTokenAccount = getAssociatedTokenAddressSync(outputTokenMint, payer)

  // Calculate swap amounts
  let amountIn: BN
  if (inputTokenMint.equals(NATIVE_MINT)) {
    amountIn = new BN(amount * LAMPORTS_PER_SOL)
  } else {
    const inputTokenInfo = isMintASOL ? poolInfo.mintB : poolInfo.mintA
    const inputDecimals = inputTokenInfo.decimals
    console.log("inputDecimals", inputDecimals)
    amountIn = new BN(amount * Math.pow(10, inputDecimals))
  }

  // Get pool state accounts
  const poolState = new PublicKey(poolKeys.id)
  const ammConfig = new PublicKey(poolKeys.config.id)
  const tokenVault0 = new PublicKey(poolKeys.vault.A)
  const tokenVault1 = new PublicKey(poolKeys.vault.B)
  const observationState = new PublicKey(poolKeys.observationId)

  // Determine which vault is input/output
  const isZeroForOne = mintA.equals(inputTokenMint)
  const inputVault = isZeroForOne ? tokenVault0 : tokenVault1
  const outputVault = isZeroForOne ? tokenVault1 : tokenVault0
  const inputVaultMint = isZeroForOne ? mintA : mintB
  const outputVaultMint = isZeroForOne ? mintB : mintA

  // Calculate tick arrays and expected output
  let uniqueTickArrays: PublicKey[] = []
  let expectedSwapOutput: BN | null = null
  let amountOutMin: BN = new BN(0)

  try {
    const tickCache = await PoolUtils.fetchMultiplePoolTickArrays({
      connection: raydium.connection,
      poolKeys: [computePoolInfo],
    })

    const tokenOutInfo = isZeroForOne ? poolInfo.mintB : poolInfo.mintA

    // Calculate with 0% slippage for exact expected output
    const { remainingAccounts: remainingAccountsExact, minAmountOut: exactAmountOut } = await PoolUtils.computeAmountOutFormat({
      poolInfo: computePoolInfo,
      tickArrayCache: tickCache[poolInfo.id],
      amountIn,
      tokenOut: tokenOutInfo,
      slippage: 0,
      epochInfo: await raydium.fetchEpochInfo(),
    })

    // Calculate with slippage for minimum protection
    const { minAmountOut } = await PoolUtils.computeAmountOutFormat({
      poolInfo: computePoolInfo,
      tickArrayCache: tickCache[poolInfo.id],
      amountIn,
      tokenOut: tokenOutInfo,
      slippage,
      epochInfo: await raydium.fetchEpochInfo(),
    })

    uniqueTickArrays = remainingAccountsExact.map(acc => acc as PublicKey)
    expectedSwapOutput = exactAmountOut.amount.raw
    amountOutMin = minAmountOut.amount.raw
  } catch (error) {
    console.warn("Failed to get tick arrays from SDK, falling back to manual calculation:", error)

    // Fallback to manual calculation
    const tickSpacing = poolInfo.config.tickSpacing
    const currentTick = computePoolInfo.tickCurrent
    const tickArraySize = 60
    const ticksPerArray = tickArraySize * tickSpacing
    const currentTickArrayStart = Math.floor(currentTick / ticksPerArray) * ticksPerArray
    const tickArrays: PublicKey[] = []
    const maxTickArrays = 5
    const swapDirection = isZeroForOne ? -1 : 1

    for (let i = 0; i < maxTickArrays; i++) {
      const offset = i * swapDirection
      const tickIndex = currentTickArrayStart + (offset * ticksPerArray)

      const [tickArrayPDA] = PublicKey.findProgramAddressSync(
        [
          Buffer.from("tick_array"),
          poolState.toBuffer(),
          Buffer.from(new BN(tickIndex).toArray("le", 4))
        ],
        CLMM_PROGRAM_ID
      )
      tickArrays.push(tickArrayPDA)
    }

    uniqueTickArrays = Array.from(new Set(tickArrays.map(ta => ta.toBase58())))
      .map(addr => new PublicKey(addr))

    if (!expectedSwapOutput) {
      amountOutMin = new BN(0)
    }
  }

  if (!expectedSwapOutput) {
    amountOutMin = new BN(0)
    expectedSwapOutput = new BN(0)
  }

  // Build setup instructions for accounts
  const setupInstructions: TransactionInstruction[] = []

  // Handle input token account (WSOL for buy, regular token for sell)
  const wsolAccount = inputTokenMint.equals(NATIVE_MINT) ? inputTokenAccount : null

  if (inputTokenMint.equals(NATIVE_MINT)) {
    if (wsolAccount) {
      const wsolAccountInfo = await connection.getAccountInfo(wsolAccount)
      const wsolAccountExists = !!wsolAccountInfo

      if (!wsolAccountExists) {
        setupInstructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            payer,
            wsolAccount,
            payer,
            NATIVE_MINT
          )
        )
      }

      let wsolBalance = 0n
      if (wsolAccountExists && wsolAccountInfo) {
        const decoded = getDecodedATA(wsolAccountInfo)
        wsolBalance = decoded.amount
      }

      const neededLamports = amountIn.toNumber() - Number(wsolBalance)
      console.log(`neededLamports`, neededLamports)
      if (neededLamports > 0) {


        console.log(`direction === buy`)
        setupInstructions.push(
          SystemProgram.transfer({
            fromPubkey: payer,
            toPubkey: wsolAccount,
            lamports: neededLamports,
          })
        )
        setupInstructions.push(createSyncNativeInstruction(wsolAccount))

      }
    }
  } else {
    const inputAccountInfo = await connection.getAccountInfo(inputTokenAccount)
    const inputAccountExists = !!inputAccountInfo
    if (!inputAccountExists) {
      setupInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          inputTokenAccount,
          payer,
          inputTokenMint
        )
      )
    }
  }

  // Handle output token account
  const wsolOutputAccount = outputTokenMint.equals(NATIVE_MINT) ? outputTokenAccount : null

  if (outputTokenMint.equals(NATIVE_MINT)) {
    if (wsolOutputAccount) {
      const wsolOutputAccountInfo = await connection.getAccountInfo(wsolOutputAccount)
      const wsolOutputAccountExists = !!wsolOutputAccountInfo
      if (!wsolOutputAccountExists) {
        setupInstructions.push(
          createAssociatedTokenAccountIdempotentInstruction(
            payer,
            wsolOutputAccount,
            payer,
            NATIVE_MINT
          )
        )
      }
    }
  } else {
    const outputAccountInfo = await connection.getAccountInfo(outputTokenAccount)
    const outputAccountExists = !!outputAccountInfo
    if (!outputAccountExists) {
      setupInstructions.push(
        createAssociatedTokenAccountIdempotentInstruction(
          payer,
          outputTokenAccount,
          payer,
          outputTokenMint
        )
      )
    }
  }

  // Build swap_v2 instruction
  const discriminator = Buffer.from([43, 4, 237, 11, 26, 201, 30, 98])
  const sqrtPriceLimitX64 = new BN(0)
  // isBaseInput: true if swapping base token (mintA) in, false if swapping quote token (mintB) in
  // isZeroForOne is true when swapping mintA -> mintB, which means base -> quote, so isBaseInput = true
  // isZeroForOne is false when swapping mintB -> mintA, which means quote -> base, so isBaseInput = false
  const isBaseInput = isZeroForOne

  const amountBuffer = Buffer.alloc(8)
  console.log("amountBuffer/amountIn", amountIn.toString())
  amountIn.toArrayLike(Buffer, "le", 8).copy(amountBuffer)

  const otherAmountThresholdBuffer = Buffer.alloc(8)
  console.log("amountOutMin", amountOutMin)
  amountOutMin.toArrayLike(Buffer, "le", 8).copy(otherAmountThresholdBuffer)

  const sqrtPriceLimitBuffer = Buffer.alloc(16)
  sqrtPriceLimitX64.toArrayLike(Buffer, "le", 16).copy(sqrtPriceLimitBuffer)
  console.log("sqrtPriceLimitBuffer", sqrtPriceLimitBuffer)

  const isBaseInputBuffer = Buffer.from([1])
  console.log("isBaseInputBuffer", isBaseInputBuffer)

  const instructionData = Buffer.concat([
    discriminator,
    amountBuffer,
    otherAmountThresholdBuffer,
    sqrtPriceLimitBuffer,
    isBaseInputBuffer,
  ])

  const accounts: AccountMeta[] = [
    { pubkey: payer, isSigner: true, isWritable: false },
    { pubkey: ammConfig, isSigner: false, isWritable: false },
    { pubkey: poolState, isSigner: false, isWritable: true },
    { pubkey: inputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: outputTokenAccount, isSigner: false, isWritable: true },
    { pubkey: inputVault, isSigner: false, isWritable: true },
    { pubkey: outputVault, isSigner: false, isWritable: true },
    { pubkey: observationState, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), isSigner: false, isWritable: false },
    { pubkey: inputVaultMint, isSigner: false, isWritable: false },
    { pubkey: outputVaultMint, isSigner: false, isWritable: false },
    ...uniqueTickArrays.map(ta => ({ pubkey: ta, isSigner: false, isWritable: true })),
  ]


  console.log("accounts", accounts)

  const instruction = new TransactionInstruction({
    programId: CLMM_PROGRAM_ID,
    keys: accounts,
    data: instructionData,
  })

  return {
    instruction,
    setupInstructions,
    inputTokenAccount,
    outputTokenAccount,
    inputTokenMint,
    outputTokenMint,
    expectedOutput: expectedSwapOutput,
    amountOutMin,
    tickArrays: uniqueTickArrays,
    poolId,
  }
}

/**
 * Builds a Launchpad swap instruction (buy or sell)
 */
export const buildLaunchpadSwapInstruction = async (
  params: LaunchpadSwapParams
): Promise<LaunchpadSwapResult> => {
  const { tokenMint, quoteMint, direction, inputTokenAccount, outputTokenAccount, amountIn, payer, isDevBuy, deployer } = params

  console.log("buildLaunchpadSwapInstruction amountIn", amountIn)

  const launchpadProgramId = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj")
  const poolId = getPdaLaunchpadPoolId(launchpadProgramId, tokenMint, quoteMint).publicKey

  const platformId = new PublicKey('FfYek5vEz23cMkWsdJwG2oa6EphsvXSHrGpdALN4g6W1')
  const configId = getPdaLaunchpadConfigId(new PublicKey(launchpadProgramId), quoteMint, 0, 0).publicKey
  const vaultA = getPdaLaunchpadVaultId(launchpadProgramId, poolId, tokenMint).publicKey
  const vaultB = getPdaLaunchpadVaultId(launchpadProgramId, poolId, quoteMint).publicKey
  const platformVault = getPdaPlatformVault(launchpadProgramId, platformId, quoteMint).publicKey
  const authProgramId = getPdaLaunchpadAuth(launchpadProgramId).publicKey

  console.log("poolId", poolId)
  let creatorVault: PublicKey
  if (isDevBuy && deployer) {
    console.log("deployer", deployer)
    creatorVault = getPdaCreatorVault(launchpadProgramId, deployer, quoteMint).publicKey
    console.log("creatorVault", creatorVault)
  } else {
    // Retry logic for newly created pools
    let poolData: any = await connection.getAccountInfo(poolId)

    if (!poolData) {
      const maxAttempts = 10
      const delayMs = 250
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        await new Promise((r) => setTimeout(r, delayMs))
        poolData = await connection.getAccountInfo(poolId)
        if (poolData) break
      }
    }

    if (!poolData) {
      throw new Error(`Launchpad pool not found: ${poolId.toBase58()}`)
    }

    const poolInfo = LaunchpadPool.decode(poolData.data)

    creatorVault = getPdaCreatorVault(launchpadProgramId, poolInfo.creator, quoteMint).publicKey
  }


  const minAmountOut = new BN(0) // Minimum amount out (0 for sell, program will validate)
  // Build setup instructions
  const setupInstructions: TransactionInstruction[] = []

  // Determine input/output mints and accounts based on direction
  let mintA: PublicKey
  let mintB: PublicKey
  let userTokenAccountA: PublicKey
  let userTokenAccountB: PublicKey

  if (direction === 'buy') {
    // Buy: quote -> token
    // mintA = token (output), mintB = quote (input)
    mintA = tokenMint
    mintB = quoteMint
    userTokenAccountA = outputTokenAccount // Receives token
    userTokenAccountB = inputTokenAccount // Has quote token
  } else {
    // Sell: token -> quote
    // mintA = token (input), mintB = quote (output)
    mintA = tokenMint
    mintB = quoteMint
    userTokenAccountA = inputTokenAccount // Has token
    userTokenAccountB = outputTokenAccount // Receives quote token
  }

  // Create output token account if needed
  const outputAccountInfo = await connection.getAccountInfo(outputTokenAccount)
  const outputAccountExists = !!outputAccountInfo
  if (!outputAccountExists) {
    const outputMint = direction === 'buy' ? tokenMint : quoteMint
    setupInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        payer,
        outputTokenAccount,
        payer,
        outputMint
      )
    )
  }

  // Build instruction based on direction
  let instruction: TransactionInstruction

  if (direction === 'buy') {
    // Buy instruction: swap quote token for token
    instruction = buyExactInInstruction(
      launchpadProgramId,
      payer,
      authProgramId,
      configId,
      platformId,
      poolId,
      userTokenAccountA, // Receives token (output, mintA)
      userTokenAccountB, // Has quote token (input, mintB)
      vaultA,
      vaultB,
      mintA, // mintA: token being bought
      mintB, // mintB: input token (quote token)
      TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      platformVault,
      creatorVault,
      amountIn, // Amount of quote token to spend
      minAmountOut, // Minimum tokens to receive
    )
  } else {
    // Sell instruction: swap token for quote token
    instruction = sellExactInInstruction(
      launchpadProgramId,
      payer,
      authProgramId,
      configId,
      platformId,
      poolId,
      userTokenAccountA, // Has token (input, mintA)
      userTokenAccountB, // Receives quote token (output, mintB)
      vaultA,
      vaultB,
      mintA, // mintA: token being sold
      mintB, // mintB: output token (quote token)
      TOKEN_PROGRAM_ID,
      TOKEN_PROGRAM_ID,
      platformVault,
      creatorVault,
      amountIn, // Amount of tokens to sell
      minAmountOut, // Minimum quote tokens to receive
    )
  }

  return {
    instruction,
    setupInstructions,
  }
}

interface BuildSwapInstructionsParams {
  direction: SwapDirection
  amountIn: number
  tokenMint: PublicKey
  isDevBuy: boolean
  payer: Keypair
  deployerPubKey: PublicKey
}

interface BuildSwapInstructionsResult {
  instructions: TransactionInstruction[]
}

export const buildSwapInstructions = async (
  params: BuildSwapInstructionsParams
): Promise<BuildSwapInstructionsResult> => {
  const { direction, amountIn, tokenMint, isDevBuy, payer, deployerPubKey } = params

  const tokenAccount = getAssociatedTokenAddressSync(tokenMint, payer.publicKey)
  const quoteTokenAccount = getAssociatedTokenAddressSync(usd1Mint, payer.publicKey)

  const instructions: TransactionInstruction[] = []

  if (direction === 'buy') {
    let inputTokenAccount: PublicKey
    let amountInForLaunchpad: BN
    let clmmPoolId: PublicKey
    const clmmSwap = await buildClmmSwapInstruction({
      direction: 'buy',
      baseMint: new PublicKey("So11111111111111111111111111111111111111112"),
      quoteMint: new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"),
      amount: amountIn,
      payer: payer.publicKey,
      slippage: 0.01,
    })

    instructions.push(...clmmSwap.setupInstructions)
    instructions.push(clmmSwap.instruction)

    inputTokenAccount = clmmSwap.outputTokenAccount
    amountInForLaunchpad = clmmSwap.expectedOutput
    if (isDevBuy) {
      // For dev buy, skip CLMM swap and use existing USD1
      inputTokenAccount = quoteTokenAccount
      // Convert amountIn from SOL to USD1 raw units (assuming 1:1 for dev buy, adjust as needed)
      const usd1Decimals = 6
      amountInForLaunchpad = new BN(Math.floor(amountIn * Math.pow(10, usd1Decimals)))
      // Still need poolId for return value - fetch it
      const foundPoolId = await findPoolByMints(
        new PublicKey("So11111111111111111111111111111111111111112"),
        new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB")
      )
      if (!foundPoolId) {
        throw new Error("Pool not found for CLMM pool")
      }
      clmmPoolId = foundPoolId
    } else {
      // Normal buy flow: CLMM swap WSOL -> USD1, then Launchpad swap USD1 -> Token

      clmmPoolId = clmmSwap.poolId
    }

    console.log("clmmPoolId", clmmPoolId)

    const launchpadSwap = await buildLaunchpadSwapInstruction({
      tokenMint,
      quoteMint: usd1Mint,
      direction: 'buy',
      inputTokenAccount: inputTokenAccount,
      outputTokenAccount: tokenAccount,
      amountIn: amountInForLaunchpad,
      deployer: deployerPubKey,
      payer: payer.publicKey,
      isDevBuy,
    })

    instructions.push(...launchpadSwap.setupInstructions)
    instructions.push(launchpadSwap.instruction)

    console.log("instructions", instructions)
    return { instructions}
  } else {
    const tokenAccountInfo = await connection.getAccountInfo(tokenAccount)
    if (!tokenAccountInfo) {
      throw new Error(`Token account does not exist at ${tokenAccount.toBase58()}. Cannot sell tokens you don't have.`)
    }

    const tokenAccountData = getDecodedATA(tokenAccountInfo)
    const tokenBalance = new BN(tokenAccountData.amount.toString())

    const { getMint } = await import("@solana/spl-token")
    const mintInfo = await getMint(connection, tokenMint)
    const tokenDecimals = mintInfo.decimals
    const amountInTokens = new BN(Math.floor(amountIn * Math.pow(10, tokenDecimals)))

    if (tokenBalance.lte(new BN(0))) {
      throw new Error(`Cannot sell: Token account has zero balance. Please buy tokens first using 'buy' direction.`)
    }

    if (amountInTokens.lte(new BN(0))) {
      throw new Error(`Invalid sell amount: ${amountInTokens.toString()}. Amount must be greater than 0.`)
    }

    if (amountInTokens.gt(tokenBalance)) {
      throw new Error(`Insufficient token balance. Have: ${tokenBalance.toString()} raw units, Need: ${amountInTokens.toString()} raw units`)
    }

    const launchpadSwap = await buildLaunchpadSwapInstruction({
      tokenMint,
      quoteMint: usd1Mint,
      direction: 'sell',
      inputTokenAccount: tokenAccount,
      outputTokenAccount: quoteTokenAccount,
      amountIn: amountInTokens,
      deployer: deployerPubKey,
      payer: payer.publicKey,
      isDevBuy
    })

    const tempInstructions = [
      ...launchpadSwap.setupInstructions,
      launchpadSwap.instruction,
    ]

    const tempLatestBlockhash = await connection.getLatestBlockhash()
    const tempMessageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: tempLatestBlockhash.blockhash,
      instructions: tempInstructions,
    }).compileToV0Message()

    const tempTransaction = new VersionedTransaction(tempMessageV0)
    tempTransaction.sign([payer])

    const simulation = await connection.simulateTransaction(tempTransaction, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    })

    if (simulation.value.err) {
      throw new Error(`Launchpad swap simulation failed: ${JSON.stringify(simulation.value.err)}`)
    }

    const usd1Decimals = 6
    let actualUsd1Amount = 0
    const simulationValue = simulation.value as any

    const preUsd1Balance = simulationValue.preTokenBalances?.find(
      (balance: any) => balance.owner === payer.publicKey.toBase58() &&
        balance.mint === usd1Mint.toBase58()
    )
    const postUsd1Balance = simulationValue.postTokenBalances?.find(
      (balance: any) => balance.owner === payer.publicKey.toBase58() &&
        balance.mint === usd1Mint.toBase58()
    )

    if (postUsd1Balance) {
      const postAmountUi = postUsd1Balance.uiTokenAmount.uiAmount
      const preAmountUi = preUsd1Balance?.uiTokenAmount?.uiAmount ?? 0

      if (postAmountUi !== null && postAmountUi !== undefined) {
        actualUsd1Amount = postAmountUi - preAmountUi
      } else {
        const postAmountRaw = new BN(postUsd1Balance.uiTokenAmount.amount)
        const preAmountRaw = preUsd1Balance ? new BN(preUsd1Balance.uiTokenAmount.amount) : new BN(0)
        const usd1OutputRaw = postAmountRaw.sub(preAmountRaw)
        actualUsd1Amount = usd1OutputRaw.toNumber() / Math.pow(10, usd1Decimals)
      }
    }

    if (actualUsd1Amount <= 0) {
      throw new Error(`Invalid USD1 output from Launchpad swap: ${actualUsd1Amount}. The swap may have failed or produced 0 output.`)
    }

    const clmmSwap = await buildClmmSwapInstruction({
      direction: 'sell',
      baseMint: new PublicKey("So11111111111111111111111111111111111111112"),
      quoteMint: new PublicKey("USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB"),
      amount: actualUsd1Amount,
      payer: payer.publicKey,
      slippage: 0.01,
    })

    instructions.push(...launchpadSwap.setupInstructions)
    instructions.push(launchpadSwap.instruction)
    instructions.push(...clmmSwap.setupInstructions)
    instructions.push(clmmSwap.instruction)

    console.log("instructions", instructions)
    return { instructions }
  }
}

export const swap = async (
  direction: SwapDirection = 'buy',
  amountIn: number = swapAmount,
  tokenMint: PublicKey,
  isDevBuy: boolean = false
) => {
  const { instructions } = await buildSwapInstructions({
    direction,
    amountIn,
    tokenMint,
    isDevBuy,
    payer,
    deployerPubKey: payer.publicKey
  })

  const latestBlockhash = await connection.getLatestBlockhash()

  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message()

  const transaction = new VersionedTransaction(messageV0)
  transaction.sign([payer])

  try {
    const txid = await connection.sendTransaction(transaction)
    console.log("Transaction sent:", txid)
    console.log("View on Solscan:", `https://solscan.io/tx/${txid}`)

    await connection.confirmTransaction({
      signature: txid,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight,
    })

    return txid
  } catch (error: any) {
    if (error?.transactionLogs?.some((log: string) =>
      log.includes('RequireGtViolated') ||
      log.includes('0x9c9') ||
      log.includes('Error Number: 2505')
    )) {
      const errorMsg = direction === 'sell'
        ? `Sell amount too small: The output amount is 0 USD1, which violates the pool's minimum requirement. ` +
        `Try selling a larger amount (e.g., 1.0+ tokens instead of ${amountIn} tokens). ` +
        `The Launchpad pool requires a minimum output amount greater than 0.`
        : `Transaction failed with RequireGtViolated error. This usually means the output amount is 0.`
      throw new Error(errorMsg)
    }
    throw error
  }
}