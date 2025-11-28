import { bs58 } from "@coral-xyz/anchor/dist/cjs/utils/bytes";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import dotenv from 'dotenv';

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
export const programId = new PublicKey("HrmSfAe4ugxGLr7QU2UeAdCVqRR4zCAM1hsyLhV1V89");


export const connection = new Connection(HELIUS_URL);