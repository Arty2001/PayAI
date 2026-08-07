/**
 * Generate a throwaway EVM keypair for testnet payments.
 *
 * Usage:  npm run keygen
 *
 * Testnet only. Do not reuse this key on mainnet or fund it with real money —
 * it is printed to your terminal and will end up in shell history.
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
const { address } = privateKeyToAccount(privateKey);

console.log(`
Testnet payer keypair
─────────────────────────────────────────────────────────
  address      ${address}
  private key  ${privateKey}

Add to .env:

  PAYAI_PAYER_PRIVATE_KEY=${privateKey}

Then fund the address with Base Sepolia USDC:

  https://faucet.circle.com

No ETH needed — x402 uses gasless EIP-3009 transfers.
`);
