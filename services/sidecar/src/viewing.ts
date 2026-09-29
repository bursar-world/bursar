import { deriveViewingKey, encodeMetaAddress, erc6538Abi, ERC5564_SCHEME_SECP256K1, viewingKeyMessage } from '@bursar/sdk';
import { encodeFunctionData } from 'viem';
import type { Hex, PrivateKeyAccount } from 'viem';

/**
 * The payee's viewing key. The payee key signs the fixed viewing-key message and the SDK derives
 * the key from that signature, so the key a payer seals to (the one published through ERC-6538)
 * is recomputed on every start and never stored.
 */
export async function payeeViewingKey(account: PrivateKeyAccount): Promise<{ privateKey: Hex; publicKey: Hex }> {
  const { privateKey, publicKey } = deriveViewingKey(await account.signMessage({ message: viewingKeyMessage(account.address) }));
  return { privateKey, publicKey };
}

/** The ERC-6538 scheme-1 meta-address and the `registerKeys` calldata that publishes it. */
export async function viewingKeyRegistration(account: PrivateKeyAccount): Promise<{ meta: Hex; calldata: Hex; viewingPublicKey: Hex }> {
  const { publicKey } = await payeeViewingKey(account);
  const meta = encodeMetaAddress(account.publicKey, publicKey);
  const calldata = encodeFunctionData({
    abi: erc6538Abi,
    functionName: 'registerKeys',
    args: [ERC5564_SCHEME_SECP256K1, meta],
  });
  return { meta, calldata, viewingPublicKey: publicKey };
}
