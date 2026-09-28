import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import type { Address, Hex } from 'viem';

/**
 * A throwaway EVM node for the tests that are about how a node fails.
 *
 * Gas failures are the one area where a hand-written error proves nothing: the wording differs
 * between clients, viem wraps each action in a different class, and the numbers that matter are
 * in whichever field that particular client filled in. Every assertion in the gas suite is made
 * against an error this node actually produced.
 */
export type Anvil = {
  readonly url: string;
  readonly chainId: number;
  setBalance(address: Address, wei: bigint): Promise<void>;
  setCode(address: Address, bytecode: Hex): Promise<void>;
  stop(): Promise<void>;
};

/** Robinhood Chain mainnet, so the chain guard in connect() sees the chain the SDK settles on. */
const CHAIN_ID = 4663;

/** JUMPDEST, PUSH1 0, JUMP: burns every unit of gas it is given and returns nothing. */
export const BURNER_CODE: Hex = '0x5b600056';

/** Where the gas burner is installed. Any address will do; a memorable one reads better in a log. */
export const BURNER: Address = '0x00000000000000000000000000000000deadbeef';

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

async function rpc(url: string, method: string, params: readonly unknown[]): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

  const body = (await response.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);

  return body.result;
}

async function reachable(url: string): Promise<boolean> {
  try {
    return (await rpc(url, 'eth_chainId', [])) !== undefined;
  } catch {
    return false;
  }
}

async function awaitReady(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`anvil exited with ${child.exitCode}`);
    if (await reachable(url)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  child.kill('SIGKILL');
  throw new Error(`anvil did not answer on ${url} within 20s`);
}

/**
 * Starts a node this process owns and nothing else does.
 *
 * The port is taken from the OS rather than fixed, and only the child spawned here is ever
 * signalled, because this machine runs other people's services on ports a test has no business
 * guessing at.
 */
export async function startAnvil(): Promise<Anvil> {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;

  const child = spawn(
    'anvil',
    ['--port', String(port), '--host', '127.0.0.1', '--chain-id', String(CHAIN_ID), '--silent'],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  child.once('error', () => {
    stderr += 'anvil could not be started. It ships with Foundry, which this repo already needs.';
  });

  try {
    await awaitReady(url, child);
  } catch (error) {
    throw new Error(`${(error as Error).message}\n${stderr}`.trim());
  }

  return {
    url,
    chainId: CHAIN_ID,
    setBalance: async (address, wei) => {
      await rpc(url, 'anvil_setBalance', [address, `0x${wei.toString(16)}`]);
    },
    setCode: async (address, bytecode) => {
      await rpc(url, 'anvil_setCode', [address, bytecode]);
    },
    stop: async () => {
      if (child.exitCode !== null) return;
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      await exited;
    },
  };
}
