import {
  ApiV3PoolInfoConcentratedItem,
  ClmmKeys,
  ComputeClmmPoolInfo,
  PoolUtils,
  ReturnTypeFetchMultiplePoolTickArrays,
  RAYMint,
  TxVersion,
} from '@raydium-io/raydium-sdk-v2'

import BN from 'bn.js'
import { connection, initSdk, MAIN_KP } from './config'

import { CLMM_PROGRAM_ID, DEVNET_PROGRAM_ID } from '@raydium-io/raydium-sdk-v2'
import { swap } from './swap'
import { Keypair, PublicKey } from '@solana/web3.js'
import { createTokenTxV2 } from './create'

const VALID_PROGRAM_ID = new Set([CLMM_PROGRAM_ID.toBase58(), DEVNET_PROGRAM_ID.CLMM_PROGRAM_ID.toBase58()])
export const txVersion = TxVersion.V0 // or TxVersion.LEGACY
export const isValidClmm = (id: string) => VALID_PROGRAM_ID.has(id)

const main = async () => {
  const raydium = await initSdk()

  const tokenMint = new PublicKey("CPgobeEZLk82DdXqWxBiwvvE2tkQwDd12AuR1V8TqwXu")
  // // Buy: WSOL -> USD1 -> Token

  const isDevBuy = false;
  // await swap('sell', 20000, tokenMint, isDevBuy)
  const mintKp = Keypair.generate()

  createTokenTxV2(connection, MAIN_KP, mintKp)
}

main()