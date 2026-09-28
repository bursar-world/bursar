import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

import { encodeAbiParameters, encodeFunctionData, keccak256, pad, toHex } from 'viem';
import type { Address, Hex } from 'viem';

/**
 * A fork of chain 4663 this process owns.
 *
 * `--hardfork shanghai` because anvil reads a Robinhood Chain block header as Cancun and then
 * refuses every call for want of a blob gas field Arbitrum never sets. The live contracts were
 * compiled for Shanghai, so nothing they do is lost.
 */
export type Anvil = {
  readonly url: string;
  rpc<T>(method: string, params?: readonly unknown[]): Promise<T>;
  warpTo(timestamp: bigint): Promise<void>;
  stop(): Promise<void>;
};

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => reject(new Error('the OS gave no port')));
        return;
      }
      probe.close(() => resolve(address.port));
    });
  });
}

async function call<T>(url: string, method: string, params: readonly unknown[]): Promise<T> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  const body = (await response.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

async function awaitReady(url: string, child: ChildProcess, stderr: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode}: ${stderr()}`);
    try {
      await call(url, 'eth_chainId', []);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  child.kill('SIGKILL');
  throw new Error(`anvil did not answer within 90s: ${stderr()}`);
}

export async function startFork(forkUrl: string): Promise<Anvil> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const child = spawn(
    'anvil',
    ['--fork-url', forkUrl, '--hardfork', 'shanghai', '--port', String(port), '--host', '127.0.0.1', '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  await awaitReady(url, child, () => stderr);

  return {
    url,
    rpc: (method, params = []) => call(url, method, params),
    warpTo: async (timestamp) => {
      await call(url, 'evm_setNextBlockTimestamp', [toHex(timestamp)]);
      await call(url, 'evm_mine', []);
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    },
  };
}

const BALANCE_OF = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ name: 'a', type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

/**
 * The storage slot of a token's balance mapping, found by watching which slots `balanceOf` reads
 * for an address known to hold some. Works through a proxy, because the storage is the proxy's.
 */
export async function balanceSlot(anvil: Anvil, token: Address, holder: Address): Promise<bigint> {
  const data = encodeFunctionData({ abi: BALANCE_OF, functionName: 'balanceOf', args: [holder] });
  const trace = await anvil.rpc<Record<string, { storage?: Record<string, Hex> }>>('debug_traceCall', [
    { to: token, data },
    'latest',
    { tracer: 'prestateTracer' },
  ]);
  const touched = new Set(Object.keys(trace[token.toLowerCase()]?.storage ?? {}).map((slot) => slot.toLowerCase()));

  for (let slot = 0n; slot < 256n; slot += 1n) {
    if (touched.has(mappingSlot(holder, slot).toLowerCase())) return slot;
  }
  throw new Error(`no balance mapping for ${token} among the slots balanceOf read`);
}

export function mappingSlot(holder: Address, slot: bigint): Hex {
  return keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [holder, slot]));
}

export async function setTokenBalance(anvil: Anvil, token: Address, slot: bigint, holder: Address, amount: bigint): Promise<void> {
  await anvil.rpc('anvil_setStorageAt', [token, mappingSlot(holder, slot), pad(toHex(amount), { size: 32 })]);
}
