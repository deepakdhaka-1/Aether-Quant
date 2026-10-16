export const signInMessage = (address: string, nonce: string, issuedAt: string, host: string) =>
  `${host} wants you to sign in to Aether Quant with your wallet.\n\n` +
  `This request does not move funds or trigger a transaction.\n\n` +
  `Wallet: ${address}\nNonce: ${nonce}\nIssued At: ${issuedAt}`;
