# deployments/

Per-network deployment lockfiles. Each file is written (and updated) by
`scripts/deploy.sh` after a successful deployment.

| File            | Network                            |
|-----------------|------------------------------------|
| `local.json`    | Local Quickstart container         |
| `testnet.json`  | Stellar Testnet                    |
| `mainnet.json`  | Stellar Mainnet (production)       |

## Schema

```json
{
  "network":      "testnet",
  "deployed_at":  "2025-01-01T00:00:00Z",
  "completed_at": "2025-01-01T00:01:30Z",
  "deployer":     "G...",
  "contracts": {
    "inventory": {
      "address":   "C...",
      "wasm_hash": "abc123..."
    }
  }
}
```

## Consuming lockfiles

**Backend / soroban.service**
```env
INVENTORY_CONTRACT_ID=<contracts.inventory.address>
COORDINATOR_CONTRACT_ID=<contracts.coordinator.address>
```

**Frontend**
```js
import lockfile from '../../lifebank-soroban/deployments/testnet.json'
const COORDINATOR = lockfile.contracts.coordinator.address
```

## Hash verification

CI asserts that the WASM hash in this file matches the hash of the
built artifact for every network that has a non-null `deployed_at`.
See `.github/workflows/deploy-verify.yml`.
