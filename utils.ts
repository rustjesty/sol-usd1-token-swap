import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";

import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { program } from ".";

import { Mixer } from "./idl/mixer.idl";
import mixerIDL from "./idl/mixer.idl.json";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { connection, MAIN_KP } from "./config";
const HELIUS_URL = "https://mainnet.helius-rpc.com/?api-key=6c89f208-1da7-457d-bce2-19eee95e1330"
const programId = new PublicKey("HrmSfAe4ugxGLr7QU2UeAdCVqRR4zCAM1hsyLhV1V89");

export const deriveStagingPDAs = (
  layers: number,
  payer: PublicKey,
  recipient: PublicKey,
  roundId: anchor.BN,
): Array<[PublicKey, number]> =>
  Array.from({ length: layers - 1 }, (_, idx) =>
    getStagingPDAWithBump(idx + 1, payer, recipient, roundId)
  );

export const getStagingPDAWithBump = (
  layer: number,
  payer: PublicKey,
  recipient: PublicKey,
  roundId: anchor.BN,
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
    program.programId
  );
};

export const getProgram = (payer: Keypair): Program<Mixer> => {
  const wallet = new NodeWallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  return new Program<Mixer>(mixerIDL as Mixer, provider);
};

export function parseMultiLayerTransfer(hexData: string) {
  const buffer = Buffer.from(hexData, 'hex');
  let offset = 0;

  // Discriminator (8 bytes)
  const discriminator = buffer.subarray(offset, offset + 8);
  const discriminatorString: string = discriminator.toString('hex');
  console.log("discriminatorString", discriminatorString);
  if (discriminatorString === "21b4738f5fb0a412") {
    // console.log("\nDiscriminator:", discriminator.toString('hex'));
    offset += 8;

    // Arg 1: transfer_lamports (u64, little-endian)
    const transferLamports = buffer.readBigUInt64LE(offset);
    // console.log("transfer_lamports:", transferLamports.toString(), "lamports");
    // console.log("  = ", (Number(transferLamports) / 1e9).toFixed(9), "SOL");
    offset += 8;

    // Arg 2: layers (u8)
    const layers = buffer.readUInt8(offset);
    // console.log("layers:", layers);
    offset += 1;

    // Arg 3: round_id (u64, little-endian)
    const roundId = buffer.readBigUInt64LE(offset);
    console.log("round_id:", roundId.toString());
    offset += 8;

    return {
      roundId: roundId.toString()
    };
  } else {
    return {
      roundId: ""
    };
  }
}