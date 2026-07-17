/**
 * Soroban fixture harness — thin wrapper around the Stellar Quickstart Docker
 * image that provides a local RPC node for contract integration tests.
 *
 * Usage (in Jest globalSetup):
 *   import { startSorobanNode, stopSorobanNode, getRpcUrl } from './fixture-harness';
 *   await startSorobanNode();
 *   // ... tests ...
 *   await stopSorobanNode();
 */

import { GenericContainer, StartedTestContainer, Wait } from 'testcontainers';
import { SorobanRpc, Keypair, Networks, TransactionBuilder, BASE_FEE } from '@stellar/stellar-sdk';

const QUICKSTART_IMAGE = 'stellar/quickstart:latest';
const RPC_PORT = 8000;

let _container: StartedTestContainer | null = null;
let _rpcUrl: string | null = null;

export async function startSorobanNode(): Promise<void> {
  if (_container) return;

  _container = await new GenericContainer(QUICKSTART_IMAGE)
    .withCommand(['--standalone', '--enable-soroban-rpc'])
    .withExposedPorts(RPC_PORT)
    .withWaitStrategy(
      Wait.forLogMessage('Soroban RPC server listening', 1).withStartupTimeout(120_000),
    )
    .start();

  _rpcUrl = `http://${_container.getHost()}:${_container.getMappedPort(RPC_PORT)}/soroban/rpc`;
}

export async function stopSorobanNode(): Promise<void> {
  await _container?.stop();
  _container = null;
  _rpcUrl = null;
}

export function getRpcUrl(): string {
  if (!_rpcUrl) throw new Error('Soroban node not started — call startSorobanNode() first');
  return _rpcUrl;
}

export function getServer(): SorobanRpc.Server {
  return new SorobanRpc.Server(getRpcUrl(), { allowHttp: true });
}

// ── Funded account factory ────────────────────────────────────────────────────

export async function createFundedKeypair(): Promise<Keypair> {
  const kp = Keypair.random();
  const server = getServer();

  // Quickstart friendbot
  const friendbotUrl = getRpcUrl().replace('/soroban/rpc', `/friendbot?addr=${kp.publicKey()}`);
  const res = await fetch(friendbotUrl);
  if (!res.ok) throw new Error(`Friendbot failed: ${res.status} ${await res.text()}`);

  // Wait for account to appear on-chain
  for (let i = 0; i < 20; i++) {
    try {
      await server.getAccount(kp.publicKey());
      return kp;
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`Account ${kp.publicKey()} never appeared after funding`);
}

// ── Contract upload helper ────────────────────────────────────────────────────

export async function uploadWasm(wasmBytes: Buffer, signer: Keypair): Promise<string> {
  const server = getServer();
  const account = await server.getAccount(signer.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: Networks.STANDALONE,
  })
    .addOperation(
      // @ts-expect-error — uploadContractWasm is available on SorobanRpc but typing varies
      SorobanRpc.Operation.uploadContractWasm({ wasm: wasmBytes }),
    )
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  prepared.sign(signer);

  const result = await server.sendTransaction(prepared);
  await waitForConfirmation(result.hash);

  // The wasm hash is in the returned ledger entry
  return result.hash;
}

async function waitForConfirmation(txHash: string): Promise<void> {
  const server = getServer();
  for (let i = 0; i < 30; i++) {
    const status = await server.getTransaction(txHash);
    if (status.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) return;
    if (status.status === SorobanRpc.Api.GetTransactionStatus.FAILED)
      throw new Error(`Transaction ${txHash} failed`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Transaction ${txHash} not confirmed within timeout`);
}
