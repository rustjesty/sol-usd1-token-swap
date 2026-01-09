import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

const payer = new PublicKey('GPfpeaNRoKqfqE4Cgh25Wuqb2fPhGM4ZHm2X2K47iq31');
const wsol = new PublicKey('So11111111111111111111111111111111111111112');
const usd1 = new PublicKey('USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB');

const wsolATA = getAssociatedTokenAddressSync(wsol, payer);
const usd1ATA = getAssociatedTokenAddressSync(usd1, payer);

console.log('Payer:', payer.toBase58());
console.log('WSOL ATA:', wsolATA.toBase58());
console.log('USD1 ATA (corrected mint):', usd1ATA.toBase58());

// Check the typo version
const usd1Wrong = new PublicKey('USD1ttGY1N1NNEEHLmELoaybftRBUSErhqYiQzvEmuB');
const usd1WrongATA = getAssociatedTokenAddressSync(usd1Wrong, payer);
console.log('USD1 ATA (typo mint):', usd1WrongATA.toBase58());
