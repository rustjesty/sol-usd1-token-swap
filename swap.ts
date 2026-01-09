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
  AddressLookupTableAccount
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
  poolId: PublicKey
  direction: SwapDirection
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
  const raydium = await initSdk()
  const { poolId, direction, amount, payer, slippage = 0.01 } = params

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
  }
}

/**
 * Builds a Launchpad swap instruction (buy or sell)
 */
export const buildLaunchpadSwapInstruction = async (
  params: LaunchpadSwapParams
): Promise<LaunchpadSwapResult> => {
  const { tokenMint, quoteMint, direction, inputTokenAccount, outputTokenAccount, amountIn, payer } = params

  console.log("buildLaunchpadSwapInstruction amountIn", amountIn)

  const launchpadProgramId = new PublicKey("LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj")
  const poolId = getPdaLaunchpadPoolId(launchpadProgramId, tokenMint, quoteMint).publicKey

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
  const configId = poolInfo.configId
  const platformId = poolInfo.platformId
  const vaultA = poolInfo.vaultA
  const vaultB = poolInfo.vaultB
  const platformVault = getPdaPlatformVault(launchpadProgramId, platformId, quoteMint).publicKey
  const creatorVault = getPdaCreatorVault(launchpadProgramId, poolInfo.creator, quoteMint).publicKey
  const minAmountOut = new BN(0) // Minimum amount out (0 for sell, program will validate)
  const authProgramId = getPdaLaunchpadAuth(launchpadProgramId).publicKey

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

export const swap = async (
  direction: SwapDirection = 'buy',
  amountIn: number = swapAmount,
  pool: PublicKey | { baseMint: string | PublicKey; quoteMint: string | PublicKey }
) => {
  // Resolve pool ID
  let poolId: PublicKey
  if (pool instanceof PublicKey) {
    poolId = pool
  } else {
    const foundPoolId = await findPoolByMints(pool.baseMint, pool.quoteMint)
    if (!foundPoolId) {
      throw new Error(`Pool not found for mints: ${pool.baseMint} / ${pool.quoteMint}`)
    }
    poolId = foundPoolId
  }

  const tokenMint = new PublicKey("CPgobeEZLk82DdXqWxBiwvvE2tkQwDd12AuR1V8TqwXu")
  const tokenAccount = getAssociatedTokenAddressSync(tokenMint, payer.publicKey)
  const quoteTokenAccount = getAssociatedTokenAddressSync(usd1Mint, payer.publicKey)

  const instructions: TransactionInstruction[] = []

  if (direction === 'buy') {
    // Buy flow: WSOL -> USD1 (CLMM) -> Token (Launchpad)

    // Step 1: CLMM swap WSOL -> USD1
    const clmmSwap = await buildClmmSwapInstruction({
      poolId,
      direction: 'buy',
      amount: amountIn,
      payer: payer.publicKey,
      slippage: 0.01,
    })

    instructions.push(...clmmSwap.setupInstructions)
    instructions.push(clmmSwap.instruction)

    // Step 2: Launchpad swap USD1 -> Token
    const launchpadSwap = await buildLaunchpadSwapInstruction({
      tokenMint,
      quoteMint: usd1Mint,
      direction: 'buy',
      inputTokenAccount: clmmSwap.outputTokenAccount,
      outputTokenAccount: tokenAccount,
      amountIn: clmmSwap.expectedOutput,
      payer: payer.publicKey,
    })

    instructions.push(...launchpadSwap.setupInstructions)
    instructions.push(launchpadSwap.instruction)

  } else {
    console.log("direction===> ", direction)
    // Sell flow: Token -> USD1 (Launchpad) -> WSOL (CLMM)

    // Step 1: Launchpad swap Token -> USD1
    // Check token account balance first
    const tokenAccountInfo = await connection.getAccountInfo(tokenAccount)
    if (!tokenAccountInfo) {
      throw new Error(`Token account does not exist at ${tokenAccount.toBase58()}. Cannot sell tokens you don't have.`)
    }

    const tokenAccountData = getDecodedATA(tokenAccountInfo)
    const tokenBalance = new BN(tokenAccountData.amount.toString())

    // Get actual token decimals from mint
    const { getMint } = await import("@solana/spl-token")
    const mintInfo = await getMint(connection, tokenMint)
    const tokenDecimals = mintInfo.decimals

    console.log(`Token decimals: ${tokenDecimals}`)

    const amountInTokens = new BN(Math.floor(amountIn * Math.pow(10, tokenDecimals)))

    console.log(`Token account: ${tokenAccount.toBase58()}`)
    console.log(`Token balance: ${tokenBalance.toString()} raw units (${tokenBalance.div(new BN(10).pow(new BN(tokenDecimals))).toString()} tokens)`)
    console.log(`Amount to sell: ${amountInTokens.toString()} raw units (${amountIn} tokens, decimals: ${tokenDecimals})`)

    if (tokenBalance.lte(new BN(0))) {
      throw new Error(`Cannot sell: Token account has zero balance. Please buy tokens first using 'buy' direction.`)
    }

    if (amountInTokens.lte(new BN(0))) {
      throw new Error(`Invalid sell amount: ${amountInTokens.toString()}. Amount must be greater than 0.`)
    }

    if (amountInTokens.gt(tokenBalance)) {
      throw new Error(`Insufficient token balance. Have: ${tokenBalance.toString()} raw units, Need: ${amountInTokens.toString()} raw units`)
    }

    // The RequireGtViolated error occurs when output amount is 0
    // This happens when selling very small amounts that round to 0 USD1
    // Try with larger amounts (e.g., 1.0 or more tokens) if you encounter this error
    if (amountInTokens.lt(new BN(100000))) {
      console.warn(`Warning: Selling a small amount (${amountInTokens.toString()} raw units = ${amountIn} tokens) may result in 0 USD1 output due to rounding. If you get RequireGtViolated error, try selling a larger amount (e.g., 1.0+ tokens).`)
    }

    const launchpadSwap = await buildLaunchpadSwapInstruction({
      tokenMint,
      quoteMint: usd1Mint,
      direction: 'sell',
      inputTokenAccount: tokenAccount,
      outputTokenAccount: quoteTokenAccount,
      amountIn: amountInTokens,
      payer: payer.publicKey,
    })

    // Step 2: Simulate Launchpad swap to get actual USD1 output
    // Build a temporary transaction with just the Launchpad swap to simulate it
    const tempInstructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 }),
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

    // Simulate the Launchpad swap to get actual USD1 output
    const simulation = await connection.simulateTransaction(tempTransaction, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    })

    if (simulation.value.err) {
      throw new Error(`Launchpad swap simulation failed: ${JSON.stringify(simulation.value.err)}`)
    }

    // Extract USD1 output from simulation
    const usd1Decimals = 6 // USD1 has 6 decimals
    let actualUsd1Amount = 0

    if (simulation.value.logs) {
      console.log("Launchpad swap simulation logs:", simulation.value.logs)
    }

    // Get postTokenBalances from simulation to find USD1 output
    const simulationValue = simulation.value as any
    
    // Log all token balances for debugging
    console.log("Pre token balances:", JSON.stringify(simulationValue.preTokenBalances, null, 2))
    console.log("Post token balances:", JSON.stringify(simulationValue.postTokenBalances, null, 2))
    
    // Get pre and post balances for USD1 account
    const preUsd1Balance = simulationValue.preTokenBalances?.find(
      (balance: any) => balance.owner === payer.publicKey.toBase58() && 
                       balance.mint === usd1Mint.toBase58()
    )
    const postUsd1Balance = simulationValue.postTokenBalances?.find(
      (balance: any) => balance.owner === payer.publicKey.toBase58() && 
                       balance.mint === usd1Mint.toBase58()
    )

    if (postUsd1Balance) {
      // Try to use uiAmount if available (human-readable), otherwise calculate from raw amount
      const postAmountRaw = new BN(postUsd1Balance.uiTokenAmount.amount)
      const preAmountRaw = preUsd1Balance ? new BN(preUsd1Balance.uiTokenAmount.amount) : new BN(0)
      const usd1OutputRaw = postAmountRaw.sub(preAmountRaw)
      
      // Check if uiAmount is available (more reliable)
      let postAmountUi = postUsd1Balance.uiTokenAmount.uiAmount
      let preAmountUi = preUsd1Balance?.uiTokenAmount?.uiAmount ?? 0
      
      if (postAmountUi !== null && postAmountUi !== undefined) {
        // Use uiAmount if available (already in human-readable format)
        actualUsd1Amount = postAmountUi - preAmountUi
        console.log(`Using uiAmount from simulation - Pre: ${preAmountUi} USD1, Post: ${postAmountUi} USD1, Output: ${actualUsd1Amount} USD1`)
      } else {
        // Fallback to calculating from raw amount
        actualUsd1Amount = usd1OutputRaw.toNumber() / Math.pow(10, usd1Decimals)
        console.log(`Calculated from raw amount - Pre: ${preAmountRaw.toString()}, Post: ${postAmountRaw.toString()}, Output: ${usd1OutputRaw.toString()} raw units (${actualUsd1Amount} USD1)`)
      }
      
      console.log(`Pre USD1 balance: ${preAmountRaw.toString()} raw units (${preAmountRaw.toNumber() / Math.pow(10, usd1Decimals)} USD1)`)
      console.log(`Post USD1 balance: ${postAmountRaw.toString()} raw units (${postAmountRaw.toNumber() / Math.pow(10, usd1Decimals)} USD1)`)
      console.log(`USD1 output from Launchpad swap: ${usd1OutputRaw.toString()} raw units (${actualUsd1Amount} USD1)`)
      console.log(`Will use ${actualUsd1Amount} USD1 for CLMM swap`)
    } else if (preUsd1Balance) {
      // Account existed before but not after - this shouldn't happen, but handle it
      console.warn(`USD1 account existed before but not found in postTokenBalances`)
    } else {
      // Account didn't exist before - check if it was created
      console.warn(`USD1 account not found in simulation balances. It may have been created but balance is 0.`)
    }

    // If we couldn't get the amount from simulation, try to get it from the account directly
    // after a dry-run, or use a calculation based on the bonding curve
    if (actualUsd1Amount === 0) {
      console.warn("Could not determine USD1 output from simulation. Checking account balance...")
      // As a fallback, we could check the quoteTokenAccount balance, but it might not exist yet
      // For now, we'll use a very small amount to avoid the insufficient funds error
      // The user should ensure they have enough USD1 from the Launchpad swap
      actualUsd1Amount = 0.01 // Very conservative fallback
      console.warn(`Using fallback USD1 amount: ${actualUsd1Amount} USD1`)
    }

    // Ensure we have a minimum amount
    if (actualUsd1Amount <= 0) {
      throw new Error(`Invalid USD1 output from Launchpad swap: ${actualUsd1Amount}. The swap may have failed or produced 0 output.`)
    }

    console.log(`Using actual USD1 amount from Launchpad swap: ${actualUsd1Amount} USD1 for CLMM swap`)
    console.log(`This amount will be converted to raw units: ${actualUsd1Amount * Math.pow(10, usd1Decimals)} raw units`)
    
    // Step 3: CLMM swap USD1 -> WSOL using actual amount from Launchpad swap
    console.log(`Building CLMM swap instruction with amount: ${actualUsd1Amount} USD1`)
    const clmmSwap = await buildClmmSwapInstruction({
      poolId,
      direction: 'sell',
      amount: actualUsd1Amount, // Use actual amount from Launchpad swap
      payer: payer.publicKey,
      slippage: 0.01,
    })
    console.log(`CLMM swap built. AmountIn (raw): ${clmmSwap.expectedOutput ? 'calculated' : 'not calculated'}`)

    // Build the full transaction with both swaps
    instructions.push(...launchpadSwap.setupInstructions)
    instructions.push(launchpadSwap.instruction)
    instructions.push(...clmmSwap.setupInstructions)
    instructions.push(clmmSwap.instruction)
  }

  // Add compute budget
  instructions.unshift(
    ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100000 })
  )

  // Fetch pool info for lookup table
  const raydium = await initSdk()
  const poolData = await raydium.clmm.getPoolInfoFromRpc(poolId.toBase58())
  if (!poolData) {
    throw new Error("Pool not found")
  }

  // Build transaction
  const latestBlockhash = await connection.getLatestBlockhash()
  let lookupTables: AddressLookupTableAccount[] | undefined = undefined

  if (poolData.poolKeys.lookupTableAccount) {
    try {
      const lookupTableAccount = await connection.getAddressLookupTable(
        new PublicKey(poolData.poolKeys.lookupTableAccount)
      )
      if (lookupTableAccount.value) {
        lookupTables = [lookupTableAccount.value]
      }
    } catch (error) {
      console.warn("Failed to fetch lookup table:", error)
    }
  }

  const messageV0 = new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message(lookupTables)

  console.log("instructions", instructions)

  const transaction = new VersionedTransaction(messageV0)
  transaction.sign([payer])

  const txSize = transaction.serialize().length
  console.log(`Transaction size 727: ${txSize} bytes`)

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
    // Check for RequireGtViolated error (0x9c9 = 2505) - output amount is 0
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