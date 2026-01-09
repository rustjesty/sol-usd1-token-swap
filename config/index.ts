import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import dotenv from 'dotenv';
import { Raydium, TxVersion, parseTokenAccountResp, DEV_API_URLS } from '@raydium-io/raydium-sdk-v2'
dotenv.config();

const getEnvVar = (name: string) => {
  const value = process.env[name];
  if (!value) {
    console.log(`${name} is not set`);
    process.exit(1);
  }
  return value;
};

export const PRIVATE_KEY = getEnvVar('PRIVATE_KEY')

export const MAIN_KP = Keypair.fromSecretKey(bs58.decode(PRIVATE_KEY));

export const commitment = "confirmed";
export const HELIUS_URL = "https://mainnet.helius-rpc.com/?api-key=6c89f208-1da7-457d-bce2-19eee95e1330"
export const programId = new PublicKey("BhdU135mdBb1V7jcKdAZoFueNMLMeAtAbBgUZehqRte7");

const cluster = 'mainnet' as 'mainnet' | 'devnet' // 'mainnet' | 'devnet'
export const connection = new Connection(HELIUS_URL);
let raydium: Raydium | undefined
export const initSdk = async (params?: { loadToken?: boolean }) => {
  if (raydium) return raydium
  if (connection.rpcEndpoint === clusterApiUrl('mainnet-beta'))
    console.warn('using free rpc node might cause unexpected error, strongly suggest uses paid rpc node')
  console.log(`connect to rpc ${connection.rpcEndpoint} in ${cluster}`)
  raydium = await Raydium.load({
    owner: MAIN_KP,
    connection,
    cluster,
    disableFeatureCheck: true,
    disableLoadToken: !params?.loadToken,
    blockhashCommitment: 'finalized',
    ...(cluster === 'devnet'
      ? {
          urlConfigs: {
            ...DEV_API_URLS,
            BASE_HOST: 'https://api-v3-devnet.raydium.io',
            OWNER_BASE_HOST: 'https://owner-v1-devnet.raydium.io',
            SWAP_HOST: 'https://transaction-v1-devnet.raydium.io',
            CPMM_LOCK: 'https://dynamic-ipfs-devnet.raydium.io/lock/cpmm/position',
          },
        }
      : {}),
  })

  /**
   * By default: sdk will automatically fetch token account data when need it or any sol balace changed.
   * if you want to handle token account by yourself, set token account data after init sdk
   * code below shows how to do it.
   * note: after call raydium.account.updateTokenAccount, raydium will not automatically fetch token account
   */

  /*  
  raydium.account.updateTokenAccount(await fetchTokenAccountData())
  connection.onAccountChange(owner.publicKey, async () => {
    raydium!.account.updateTokenAccount(await fetchTokenAccountData())
  })
  */

  return raydium
}