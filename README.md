# Morpho vault withdrawal monitor

Monitors two illiquid (100%-utilization) Morpho Blue markets and, the moment
withdrawable liquidity appears, auto-withdraws the owner's position — racing the
vault's other depositors.

## The two positions

| Vault | Vault address | Underlying market | Collateral | Status |
|---|---|---|---|---|
| Alpha USDC Asia V2 | `0x35Cbe8542E70fa2f7F9cDF129F19e593F4b4f560` | `0xfd0d72…4cc2` | AZND | ~80% LTV (LLTV 86%), solvent, 100% util |
| Api3 dCOMP USDC | `0x36cfe1568461E499391ef0A555300F1ae2da2439` | `0x24852d…0ea6` | dCOMP | ~40% LTV (LLTV 62.5%), solvent, 100% util |

Both have **$0 bad debt** today. Money is illiquid, not lost. Liquidity returns
when a borrower repays, a position is liquidated, or new deposits arrive — then
withdrawal is a first-come-first-served race. Windows can be short: on 2026-06-25
the dCOMP market briefly held **$226.97k** of liquidity and it was re-borrowed
within ~6 minutes.

Liquidity is read directly from Morpho Blue (`0xBBBB…FFCb`):
`liquidity = market.totalSupplyAssets − market.totalBorrowAssets` (exact, no
interest accrual needed at 100% util).

## How withdrawal actually works on these vaults (important)

A plain ERC-4626 `withdraw`/`redeem` **reverts with an arithmetic underflow** —
the vault's automatic liquidity path is fed empty/misconfigured market data, and
`maxWithdraw(owner)` returns 0 even when the market has liquidity. (This is why
the app header shows "Liquidity $< 0.01" while the allocation table shows the
market's real 226.97k.)

The working exit is to pull liquidity from the market into the vault's idle
balance yourself and withdraw it in the **same transaction**, atomically:

```
multicall([
    forceDeallocate(adapter, abi.encode(marketParams), amount, owner),
    withdraw(amount, receiver, owner),
])
```

`forceDeallocate` charges a penalty: **~0.01% on dCOMP, ~2% on AZND**. The script
**simulates the multicall (eth_call) before broadcasting**, so a closed/shrunk
window just reverts harmlessly (gas only) and it retries on the next block. This
was verified on-chain: `forceDeallocate` succeeded while the 226.97k window was
open and reverts with `insufficient liquidity` when it's closed.

The owners are **verified on-chain** and baked into `src/config.ts` (different
wallet per vault, so each needs its own signer):

| Vault | Owner | Position |
|---|---|---|
| Alpha USDC Asia V2 | `0x6b06da993b1f12d82463fec75006913f98499b7c` | ~$250.3k |
| Api3 dCOMP USDC | `0xd87617659957f4d9cea85e9db85b2f1de677646a` | ~$118.2k |

## Stack

TypeScript + [viem](https://viem.sh), run with `tsx`. Files:
`src/config.ts` (addresses, markets, owners, knobs), `src/abi.ts`, `src/monitor.ts`.

```bash
npm install
npm run typecheck   # optional
```

## Run (safe, no broadcasts)

```bash
npm start
```

Starts in **DRY_RUN**: per block it reads both markets, and when a window opens
it *simulates* the forceDeallocate+withdraw multicall and logs what it WOULD
broadcast — but sends nothing. Watch the heartbeat to confirm it's live.

## Run live (auto-withdraw)

```bash
DRY_RUN=0 \
PRIVATE_KEY_ALPHA=0x...   \  # owner 0x6b06…9b7c (AZND vault) — omit to skip this vault
PRIVATE_KEY_API3=0x...    \  # owner 0xd876…646a (dCOMP vault) — omit to skip this vault
PRIORITY_GWEI=10 \
npm start
```

The private key for each vault **must** be that vault's owner (the script checks
`account.address === owner` and refuses otherwise). ERC-4626 `withdraw` requires
`msg.sender == owner`. Put some ETH for gas in each owner address. Secrets are
never logged. You can run with just one key to cover only that vault.

## Key env vars

| Var | Default | Meaning |
|---|---|---|
| `DRY_RUN` | `1` | `0` to actually broadcast |
| `PRIVATE_KEY_ALPHA` / `PRIVATE_KEY_API3` | — | per-vault owner signer (live mode) |
| `RECEIVER_ALPHA` / `RECEIVER_API3` | = owner | where withdrawn USDC lands |
| `MIN_TRIGGER_USDC` | `50` | only act on liquidity ≥ this |
| `SAFETY_BUFFER_USDC` | `1` | shave off the grab; covers penalty + rounding |
| `POLL_SECONDS` | `4` | HTTP block-poll interval (~12s blocks) |
| `PRIORITY_GWEI` | `5` | priority fee to win inclusion |
| `MAX_FEE_GWEI` | auto | optional max fee per gas cap |
| `RPC_HTTP` | publicnode | use a private/paid RPC for speed/reliability |
| `RPC_WS` | — | set a `wss://` endpoint for true newHeads subscription |
| `EXIT_AFTER_FULL` | `0` | `1` to stop once a position is fully drained |

## Honest limitations

- **Block-driven, not mempool-driven.** It reacts in block N+1 after a repay
  lands in block N. Bots watching the mempool can bundle a withdraw *in the same
  block* and beat you. (The 226.97k window stayed open ~6 min, so per-block has a
  real shot — but it's not guaranteed.) Same-block competing needs mempool
  watching + Flashbots bundling (a larger build).
- Public RPCs rate-limit; for live racing use a private endpoint, set `RPC_WS`,
  and/or lower `POLL_SECONDS`.
- The **2% AZND penalty** means a full ~$250k exit there costs ~$5k. The dCOMP
  penalty is negligible (~$12 on $118k). Decide if that tradeoff beats waiting.
- The AZND market trends toward liquidation as ~79% APY interest compounds the
  LTV upward (~weeks if price is flat); the dCOMP market is healthy with no
  liquidation pressure, so it depends on the borrower repaying.
