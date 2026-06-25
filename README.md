# Morpho vault liquidity alarm

Sounds a loud alarm the moment withdrawable liquidity appears in two illiquid
(100%-utilization) Morpho Blue markets, so the owner can withdraw **manually**.
There is **no automated withdrawal and no private key here** — it only watches and
screams. The alarm is gated on a successful withdrawal simulation, so it only
fires when the money is genuinely withdrawable that block (no false alarms).

## The two positions

| Vault | Vault address | Underlying market | Collateral | Owner (Trezor) | Size |
|---|---|---|---|---|---|
| Alpha USDC Asia V2 | `0x35Cbe8…f560` | `0xfd0d72…4cc2` | AZND | `0x6b06…9b7c` | ~$250.3k |
| Api3 dCOMP USDC | `0x36cfe1…2439` | `0x24852d…0ea6` | dCOMP | `0xd876…646a` | ~$118.2k |

Both have **$0 bad debt** — money is illiquid, not lost. Liquidity returns when a
borrower repays, a position is liquidated, or new deposits arrive — then
withdrawal is a first-come-first-served race. Windows can be short: on 2026-06-25
the dCOMP market briefly held **$226.97k** and it was re-borrowed within ~6 min.

Liquidity is read directly from Morpho Blue (`0xBBBB…FFCb`):
`liquidity = market.totalSupplyAssets − market.totalBorrowAssets` (exact at 100%
util, no interest accrual needed).

## Why a plain withdraw won't work (important)

A normal ERC-4626 `withdraw`/`redeem` **reverts with an arithmetic underflow** on
these vaults — the auto-liquidity path is fed empty/misconfigured market data, and
`maxWithdraw(owner)` returns 0 even when the market has liquidity. (That's why the
app header shows "Liquidity $< 0.01" while the allocation table shows the market's
real 226.97k.)

The working exit pulls liquidity from the market into the vault's idle balance and
withdraws it in the **same transaction**, atomically:

```
multicall([
  forceDeallocate(adapter, abi.encode(marketParams), amount, owner),
  withdraw(amount, receiver, owner),
])
```

`forceDeallocate` charges a penalty: **~0.01% on dCOMP, ~2% on AZND**. The alarm
only fires when this multicall **simulates successfully** (so no false alarms),
and it prints that exact command for you to run.

## Stack

TypeScript + [viem](https://viem.sh), run with `tsx`. Files: `src/config.ts`
(addresses, markets, owners, knobs), `src/abi.ts`, `src/monitor.ts`.

```bash
npm install
cp .env.example .env     # optional — tweak knobs; no keys needed
```

## Run

```bash
npm start
```

That's it — no keys, nothing to broadcast. It reads both markets every block and
prints a heartbeat. When a real window opens it:
1. prints a 🚨 banner with the market liquidity, your position, the withdrawable
   amount, and the vault's Morpho app link,
2. plays a loud, repeating sound + macOS notification + spoken announcement.

Test the sound first so you know it's audible:

```bash
TEST_ALARM=1 npm start
```

## When the alarm fires — withdraw manually

Open the vault in the Morpho app (link is printed in the alert) and withdraw with
your wallet:

- Alpha USDC Asia V2: https://app.morpho.org/ethereum/vault/0x35Cbe8542E70fa2f7F9cDF129F19e593F4b4f560
- Api3 dCOMP USDC: https://app.morpho.org/ethereum/vault/0x36cfe1568461E499391ef0A555300F1ae2da2439

Heads-up: a plain "Withdraw" can fail on these vaults (the underflow above) — if
the app errors or shows 0 withdrawable, you need the `forceDeallocate`+`withdraw`
path instead. Ping me and I'll hand you the exact transaction to sign.

## Auto-withdraw mode (to beat the draining bot)

These windows are taken by an automated bot (e.g. `0x5B07d71f…`) that drains any
liquidity within ~1–2 minutes. A human reacting to the alarm will usually lose.
To actually recover the funds you must **automate** — but the shares are on a
Trezor that can't export its key. The workaround: **move the vault shares to a
fresh hot wallet** and let the bot sign from there. The withdrawn USDC is sent
straight to a cold `RECEIVER`, so the hot wallet only ever holds shares.

**Step 1 — make a fresh wallet.** Generate a brand-new private key/address used
*only* for this. Fund it with ~0.02 ETH for gas.

**Step 2 — move the shares (signed on the Trezor, once per vault).** The vault
*is* the share ERC-20. Transfer your full balance to the new address — e.g. via
Etherscan "Write Contract" (connect Trezor through MetaMask) calling
`transfer(newWallet, amount)`, or `cast send <vault> "transfer(address,uint256)"
<newWallet> <amount> --trezor`:

| Vault (share token) | From (Trezor) | amount (full balance) |
|---|---|---|
| `0x35Cbe8542E70fa2f7F9cDF129F19e593F4b4f560` | `0x6b06…9b7c` | `243741816417157013848116` |
| `0x36cfe1568461E499391ef0A555300F1ae2da2439` | `0xd876…646a` | `115040624393998888579688` |

(Re-check `balanceOf` before sending — use the exact current value. You can move
just one vault first to test, then the other.)

**Step 3 — run the bot:**

```bash
EXECUTE=1 \
PRIVATE_KEY=0x<new hot wallet key> \
RECEIVER=0x<your cold address for the USDC> \
PRIORITY_GWEI=20 \
npm start
```

It validates the signer owns the shares, then fires the exact
`forceDeallocate+withdraw` multicall the winning bot uses — the instant liquidity
appears — sending USDC to `RECEIVER`. Raise `PRIORITY_GWEI` if you keep losing
the race; set `RPC_WS` and a private RPC to cut latency.

**Risk:** while running, the hot wallet holds the shares; if that key leaks,
someone could withdraw to themselves. Use a dedicated fresh key, keep it only on
the monitoring machine, and pull the USDC to cold storage as it arrives.

## Key env vars (all optional)

| Var | Default | Meaning |
|---|---|---|
| `MIN_TRIGGER_USDC` | `50` | only alarm when liquidity ≥ this |
| `CONFIRM_BY_SIM` | `1` | only alarm if the withdrawal actually simulates |
| `ALARM_COOLDOWN_SEC` | `8` | min seconds between sounds while a window stays open |
| `ALARM_CMD` | macOS afplay | custom shell command to run on alarm |
| `SAY` | `1` on macOS | speak the alert with `say` |
| `POLL_SECONDS` | `4` | HTTP block-poll interval (~12s blocks) |
| `RPC_HTTP` | publicnode | a private/paid endpoint is more reliable |
| `RPC_WS` | — | set a `wss://` endpoint for true newHeads (lower latency) |

## Notes / limitations

- **Block-driven, not mempool-driven.** It detects a window in block N+1 after a
  repay lands in N. Bots watching the mempool can act in the same block. The
  ~6-min window we saw means a human with the Trezor has a real shot, but it's
  not guaranteed.
- Keep this running on a machine that stays awake with the speakers on.
- The **2% AZND penalty** means a full ~$250k exit there costs ~$5k; dCOMP is
  ~$12 on $118k. Decide if that beats waiting.
