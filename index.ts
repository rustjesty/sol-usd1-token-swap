import { Connection, Keypair, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction, Transaction, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Mixer } from "./idl/mixer.idl";
import mixerIDL from "./idl/mixer.idl.json";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import { MAIN_KP, HELIUS_URL, programId, connection } from "./config";
import { deriveStagingPDAs, getProgram, parseMultiLayerTransfer } from "./utils";




const payer = MAIN_KP;
export const program = getProgram(payer);

let paginationToken = null;
let allData: any[] = [];

const getNextPage = async (paginationToken = null) => {
  const response = await fetch(HELIUS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransactionsForAddress',
      params: [
        programId.toBase58(),
        {
          transactionDetails: 'full',
          sortOrder: 'asc',
          limit: 100,
          ...(paginationToken ? { paginationToken } : {}),
          filters: {
            blockTime: {
              gte: 1764956224,   // Jan 1, 2025
              lte: 1765146627    // Jan 31, 2025
              
            },

            status: 'succeeded'  // Only successful transactions
          }
        }
      ]
    })
  });

  const data: any = await response.json();
  return data.result;
};

async function getAllTransactionsFromFirst() {
  do {
    const result: any = await getNextPage(paginationToken);
    allData.push(...result.data);
    paginationToken = result.paginationToken;

    console.log(`Fetched ${result.data.length} transactions, total: ${allData.length}`);
  } while (paginationToken);


  const trans = allData
  console.log("trans", trans.length)

  let allInstructions: TransactionInstruction[] = [];

  for (let i = 0; i < trans.length; i++) {
    try {
      if (trans[i] === undefined) {

      } else {
        // console.log("trans[i]", trans[i])
        // const transaction  = trans[i].transaction;
        // console.log("transaction", transaction)
        const signatures = trans[i].transaction.signatures;
        console.log("signatures", signatures)
        let sender = "";
        let receiver = "";
        // const meta = trans[i].meta;
        const message = trans[i].transaction.message;
        const instructions = message.instructions;
        const accountKeys = message.accountKeys;
        // console.log("accountKeys", accountKeys)
        const mixerInstr = instructions.map((inst: any) => {
          if (accountKeys[inst.programIdIndex] === 'HrmSfAe4ugxGLr7QU2UeAdCVqRR4zCAM1hsyLhV1V89') {
            return inst;
          }
        })[0];

        // console.log("mixerInstr", mixerInstr);
        sender = accountKeys[mixerInstr.accounts[0]];
        receiver = accountKeys[mixerInstr.accounts[mixerInstr.accounts.length - 2]];

        if (sender === "undefined") {

        } else {
          if (receiver === "undefined") {

          } else {
            const mixerInstData = mixerInstr.data;
            // console.log("mixerInstData (base58):", mixerInstData)

            // Decode base58 to bytes, then convert to hex
            const decodedBytes = bs58.decode(mixerInstData);
            const hexData = Buffer.from(decodedBytes).toString('hex');

            // console.log("mixerInstData (hex):", hexData)



            const parsed = parseMultiLayerTransfer(hexData);
            if (parsed.roundId === "") continue;
            const roundId = new anchor.BN(parsed.roundId);


            const stagingAccountsWithBumps = deriveStagingPDAs(new PublicKey(sender), new PublicKey(receiver), roundId);
            const transaction = new Transaction();
            for (let i = 0; i < 4; i++) {
              const stagingPDA = stagingAccountsWithBumps[i][0];
              const layer = i + 1;

              const instruction = await program.methods
                // @ts-ignore
                .closeMultiLayerStaging(layer, roundId)
                .accounts({
                  closer: payer.publicKey,       // Anyone can close and receive rent
                  staging: stagingPDA,
                  originalPayer: new PublicKey(sender),  // Just for PDA derivation
                  recipient: new PublicKey(receiver),
                }).instruction();

              if (!instruction) {
                console.warn(`No instruction returned for layer ${layer}, skipping`);
                continue;
              }

              // transaction.add(instruction);
              allInstructions.push(instruction);
            }

            // transaction.feePayer = payer.publicKey;
            // const { blockhash } = await connection.getLatestBlockhash();
            // transaction.recentBlockhash = blockhash;
            // transaction.sign(payer);

            // const simResult = await connection.simulateTransaction(transaction);
            // if (simResult.value.err) {
            //   console.error(`Simulation failed`, simResult.value.err);
            // } else {
            //   console.log(`Simulation success`, simResult.value.logs ?? []);

            //   // Serialize the signed transaction to raw bytes
            //   const rawTransaction = transaction.serialize();

            //   const txSignature = await connection.sendRawTransaction(rawTransaction);

            //   // Confirm the transaction
            //   const confirmation = await connection.confirmTransaction(txSignature, 'confirmed');
            //   console.log(`Closed staging accounts: https://solscan.io/tx/${txSignature}`);
            // }


          }
        }
      }
    } catch (error) {
      console.log("error", error)
      continue;
    }
  }

  const num_of_trans = Math.ceil(allInstructions.length / 14);
  console.log("num_of_trans", num_of_trans)
  console.log("total instructions", allInstructions.length)

  for (let j = 0; j < num_of_trans; j++) {
    const startIdx = j * 14;
    const endIdx = Math.min(startIdx + 14, allInstructions.length);
    const batchInstructions = allInstructions.slice(startIdx, endIdx);
    
    console.log(`Processing batch ${j + 1}/${num_of_trans} with ${batchInstructions.length} instructions`);

    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('finalized');

    const messageV0 = new TransactionMessage({
      payerKey: payer.publicKey,
      recentBlockhash: blockhash,
      instructions: batchInstructions,
    }).compileToV0Message();

    // 3. Create VersionedTransaction
    const transaction = new VersionedTransaction(messageV0);

    transaction.sign([payer])

    try {
      // 5. Send transaction
      const signature = await connection.sendTransaction(transaction, {
        maxRetries: 5,
      });

      console.log(`Transaction ${j + 1}/${num_of_trans} sent: https://solscan.io/tx/${signature}`);
      
      // Wait for confirmation
      const confirmation = await connection.confirmTransaction(signature, 'confirmed');
      if (confirmation.value.err) {
        console.error(`Transaction ${j + 1} failed:`, confirmation.value.err);
      } else {
        console.log(`Transaction ${j + 1} confirmed successfully`);
      }
    } catch (error) {
      console.error(`Error sending transaction ${j + 1}:`, error);
    }
  }
}

getAllTransactionsFromFirst()