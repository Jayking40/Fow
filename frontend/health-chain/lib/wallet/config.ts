/**
 * Wallet / network configuration for the Soroban integration.
 * The app's expected network is configured via NEXT_PUBLIC_STELLAR_NETWORK
 * and defaults to TESTNET.
 */

export type StellarNetwork = 'PUBLIC' | 'TESTNET' | 'FUTURENET' | 'STANDALONE';

export const NETWORK_PASSPHRASES: Record<StellarNetwork, string> = {
  PUBLIC: 'Public Global Stellar Network ; September 2015',
  TESTNET: 'Test SDF Network ; September 2015',
  FUTURENET: 'Test SDF Future Network ; October 2022',
  STANDALONE: 'Standalone Network ; February 2017',
};

export function getExpectedNetwork(): StellarNetwork {
  const raw = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? 'TESTNET').toUpperCase();
  if (raw === 'PUBLIC' || raw === 'MAINNET') return 'PUBLIC';
  if (raw === 'FUTURENET') return 'FUTURENET';
  if (raw === 'STANDALONE') return 'STANDALONE';
  return 'TESTNET';
}

export function getExpectedNetworkPassphrase(): string {
  return NETWORK_PASSPHRASES[getExpectedNetwork()];
}

/** Human-readable label used in badges and warnings. */
export function networkLabel(network: string): string {
  switch (network.toUpperCase()) {
    case 'PUBLIC':
      return 'Mainnet';
    case 'TESTNET':
      return 'Testnet';
    case 'FUTURENET':
      return 'Futurenet';
    case 'STANDALONE':
      return 'Standalone';
    default:
      return network;
  }
}

/** stellar.expert explorer URL for an account on the given network. */
export function explorerAccountUrl(address: string, network: string): string {
  const segment = network.toUpperCase() === 'PUBLIC' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${segment}/account/${address}`;
}

/** GABC…WXYZ style truncation for display. */
export function truncateAddress(address: string, visible = 4): string {
  if (address.length <= visible * 2 + 1) return address;
  return `${address.slice(0, visible)}…${address.slice(-visible)}`;
}

export const FREIGHTER_INSTALL_URL = 'https://www.freighter.app/';
