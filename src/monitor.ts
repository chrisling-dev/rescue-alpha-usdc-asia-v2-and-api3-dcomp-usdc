/**
 * Morpho Vault V2 withdrawal monitor + auto-withdrawer (TypeScript / viem).
 *
 * Watches two illiquid (100%-utilization) Morpho Blue markets that back two
 * Vault V2 vaults. The instant available liquidity appears in a market
 * (a borrower repays, a position is liquidated, or someone supplies), it pulls
 * that liquidity out for the owner — racing the vault's other depositors.
 *
 * Liquidity is read directly from Morpho Blue:
 *     liquidity = market.totalSupplyAssets - market.totalBorrowAssets
 * Exact at 100% utilization (interest accrues equally to supply and borrow,
 * so their difference is unaffected — no accrual needed).
 *
 * WITHDRAWAL MECHANISM (important): a plain ERC-4626 `withdraw`/`redeem` reverts
 * with an arithmetic underflow on these vaults — the auto-liquidity path is fed
 * empty/misconfigured market data, and `maxWithdraw(owner)` returns 0 even when
 * the market has liquidity. The working exit is to pull liquidity into the
 * vault's idle balance ourselves and withdraw it in the SAME transaction:
 *
 *     multicall([
 *       forceDeallocate(adapter, abi.encode(marketParams), amount, owner),
 *       withdraw(amount, receiver, owner),
 *     ])
 *
 * forceDeallocate charges a penalty (dCOMP ~0.01%, AZND ~2%). We simulate the
 * multicall (eth_call) before every broadcast, so a closed/shrunk window just
 * reverts harmlessly (gas only) and we retry on the next block.
 *
 * Trigger model: block-driven (newHeads via WebSocket if RPC_WS is set, else
 * HTTP block polling). SAFETY: starts in DRY_RUN — simulates and prints, but
 * broadcasts nothing until DRY_RUN=0 and a per-vault signer are provided.
 */
import { appendFileSync } from "node:fs";
import {
  createPublicClient,
  createWalletClient,
  http,
  webSocket,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  parseUnits,
  parseGwei,
  getAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
  BaseError,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";
import { morphoAbi, vaultAbi } from "./abi.js";
import {
  VAULTS,
  MORPHO_BLUE,
  RPC_HTTP,
  RPC_WS,
  POLL_MS,
  DRY_RUN,
  MIN_TRIGGER_USDC,
  SAFETY_BUFFER_USDC,
  PRIORITY_GWEI,
  MAX_FEE_GWEI,
  LOGFILE,
  EXIT_AFTER_FULL,
  type VaultConfig,
} from "./config.js";

// ── logging ────────────────────────────────────────────────────────────────
function log(msg: string, level = "INFO") {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  try {
    appendFileSync(LOGFILE, line + "\n");
  } catch {
    /* ignore */
  }
}

// ── clients ──────────────────────────────────────────────────────────────
const publicClient: PublicClient = createPublicClient({
  chain: mainnet,
  transport: RPC_WS ? webSocket(RPC_WS) : http(RPC_HTTP),
  pollingInterval: POLL_MS,
});

// Per-vault signer (only needed when DRY_RUN=0). Keyed by vault address.
const wallets = new Map<Address, { account: Account; client: WalletClient }>();

function loadSigners() {
  for (const v of VAULTS) {
    const pk = process.env[v.keyEnv];
    if (!pk) continue;
    const account = privateKeyToAccount(pk as Hex);
    if (getAddress(account.address) !== getAddress(v.owner)) {
      log(
        `signer for ${v.name} is ${account.address} but vault owner is ` +
          `${v.owner} — they must match. Skipping this vault's signer.`,
        "ERROR",
      );
      continue;
    }
    const client = createWalletClient({
      account,
      chain: mainnet,
      transport: http(RPC_HTTP),
    });
    wallets.set(getAddress(v.vault), { account, client });
  }
}

// ── reads ──────────────────────────────────────────────────────────────────
async function readMarketLiquidity(v: VaultConfig): Promise<bigint> {
  const m = await publicClient.readContract({
    address: MORPHO_BLUE,
    abi: morphoAbi,
    functionName: "market",
    args: [v.marketId],
  });
  // [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, ...]
  const supply = m[0];
  const borrow = m[2];
  return supply - borrow;
}

async function readOwnerAssets(v: VaultConfig): Promise<bigint> {
  const shares = await publicClient.readContract({
    address: v.vault,
    abi: vaultAbi,
    functionName: "balanceOf",
    args: [v.owner],
  });
  if (shares === 0n) return 0n;
  return publicClient.readContract({
    address: v.vault,
    abi: vaultAbi,
    functionName: "convertToAssets",
    args: [shares],
  });
}

// ── exit path: build + simulate + send ──────────────────────────────────────
function encodeMarketParams(v: VaultConfig): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "loanToken", type: "address" },
          { name: "collateralToken", type: "address" },
          { name: "oracle", type: "address" },
          { name: "irm", type: "address" },
          { name: "lltv", type: "uint256" },
        ],
      },
    ],
    [v.marketParams],
  );
}

function buildCalls(v: VaultConfig, amount: bigint): [Hex, Hex] {
  const forceDeallocate = encodeFunctionData({
    abi: vaultAbi,
    functionName: "forceDeallocate",
    args: [v.adapter, encodeMarketParams(v), amount, v.owner],
  });
  const withdraw = encodeFunctionData({
    abi: vaultAbi,
    functionName: "withdraw",
    args: [amount, v.receiver, v.owner],
  });
  return [forceDeallocate, withdraw];
}

function revertReason(err: unknown): string {
  const collapse = (s: string) =>
    s.replace(/\s*\n\s*/g, " ").trim().slice(0, 200);
  if (err instanceof BaseError) {
    return collapse(err.shortMessage || err.message);
  }
  return err instanceof Error ? collapse(err.message) : String(err);
}

/** Simulate the atomic multicall from the owner. Returns true if it would succeed. */
async function simulate(v: VaultConfig, calls: [Hex, Hex]): Promise<boolean> {
  try {
    await publicClient.simulateContract({
      account: v.owner, // msg.sender override for the simulation
      address: v.vault,
      abi: vaultAbi,
      functionName: "multicall",
      args: [[calls[0], calls[1]]],
    });
    return true;
  } catch (err) {
    log(
      `  simulation reverted (${revertReason(err)}); window likely ` +
        `closed/shrank. Retrying next block.`,
      "WARN",
    );
    return false;
  }
}

async function execute(
  v: VaultConfig,
  amount: bigint,
  amountHuman: string,
): Promise<boolean> {
  const calls = buildCalls(v, amount);

  // Always simulate first — confirms the window is open and the sizes are valid.
  if (!(await simulate(v, calls))) return false;

  if (DRY_RUN) {
    log(
      `[DRY_RUN] simulation OK — WOULD withdraw ${amountHuman} USDC from ` +
        `${v.name} (owner ${v.owner}) via forceDeallocate+withdraw multicall.`,
      "ACTION",
    );
    return false;
  }

  const signer = wallets.get(getAddress(v.vault));
  if (!signer) {
    log(`  no signer for ${v.name}; cannot broadcast.`, "ERROR");
    return false;
  }

  log(
    `BROADCASTING forceDeallocate+withdraw of ${amountHuman} USDC from ` +
      `${v.name} ...`,
    "ACTION",
  );
  try {
    const hash = await signer.client.writeContract({
      account: signer.account,
      chain: mainnet,
      address: v.vault,
      abi: vaultAbi,
      functionName: "multicall",
      args: [[calls[0], calls[1]]],
      maxPriorityFeePerGas: parseGwei(PRIORITY_GWEI),
      ...(MAX_FEE_GWEI ? { maxFeePerGas: parseGwei(MAX_FEE_GWEI) } : {}),
    });
    log(`  sent tx=${hash} — waiting for receipt...`, "ACTION");
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === "success") {
      log(`  SUCCESS  tx=${hash}  block=${receipt.blockNumber}`, "ACTION");
      return true;
    }
    log(`  tx REVERTED on-chain  tx=${hash}`, "ERROR");
    return false;
  } catch (err) {
    log(`  send FAILED: ${revertReason(err)}`, "ERROR");
    return false;
  }
}

// ── per-block logic ──────────────────────────────────────────────────────────
const drained = new Set<Address>();
const triggerWei = parseUnits(String(MIN_TRIGGER_USDC), 6);
const bufferWei = parseUnits(String(SAFETY_BUFFER_USDC), 6);
let processing = false;
let heartbeat = 0;

async function onBlock(blockNumber: bigint) {
  if (processing) return; // avoid overlapping runs on slow RPC
  processing = true;
  try {
    const status: string[] = [];
    for (const v of VAULTS) {
      if (drained.has(getAddress(v.vault))) continue;

      let liq: bigint;
      try {
        liq = await readMarketLiquidity(v);
      } catch (err) {
        log(`${v.name}: market read error: ${revertReason(err)}`, "WARN");
        continue;
      }
      status.push(`${v.name.split(" ")[0]}=${formatUnits(liq, 6)}`);

      if (liq < triggerWei) continue;

      // Liquidity appeared — cap the grab by the owner's own position value.
      let own: bigint;
      try {
        own = await readOwnerAssets(v);
      } catch (err) {
        log(`${v.name}: owner-assets read error: ${revertReason(err)}`, "WARN");
        continue;
      }

      log(
        `*** LIQUIDITY DETECTED in ${v.name} at block ${blockNumber}: ` +
          `${formatUnits(liq, 6)} USDC in market, owner position=` +
          `${formatUnits(own, 6)} USDC`,
        "ALERT",
      );

      if (own < triggerWei) {
        log(
          `    owner position (${formatUnits(own, 6)}) below trigger; skipping.`,
          "ALERT",
        );
        continue;
      }

      const amount = (liq < own ? liq : own) - bufferWei;
      if (amount <= 0n) continue;

      const ok = await execute(v, amount, formatUnits(amount, 6));
      if (ok) {
        let rem = -1n;
        try {
          rem = await readOwnerAssets(v);
        } catch {
          /* ignore */
        }
        if (rem >= 0n && rem < triggerWei) {
          log(
            `    ${v.name}: position drained (remaining ${formatUnits(
              rem,
              6,
            )} USDC).`,
            "ACTION",
          );
          drained.add(getAddress(v.vault));
          if (EXIT_AFTER_FULL) {
            log("EXIT_AFTER_FULL set — done.", "ACTION");
            process.exit(0);
          }
        }
      }
    }

    heartbeat += 1;
    if (status.length && heartbeat % 25 === 1) {
      log(`block ${blockNumber}  liquidity → ${status.join("  ")}`);
    }

    if (drained.size === VAULTS.length) {
      log("All positions withdrawn. Monitor done.", "ACTION");
      process.exit(0);
    }
  } finally {
    processing = false;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  loadSigners();

  log("=".repeat(70));
  log("Morpho Vault V2 withdrawal monitor starting (viem/TS)");
  log(`RPC=${RPC_WS || RPC_HTTP}  mode=${RPC_WS ? "newHeads" : "poll"}`);
  log(
    `DRY_RUN=${DRY_RUN ? "ON (no broadcasts)" : "OFF — WILL BROADCAST"}  ` +
      `trigger>=${MIN_TRIGGER_USDC} USDC  priority=${PRIORITY_GWEI}gwei`,
  );
  for (const v of VAULTS) {
    const sig = wallets.has(getAddress(v.vault)) ? "signer SET" : "NO signer";
    log(`  watching ${v.name}`);
    log(
      `    vault=${v.vault}  owner=${v.owner}  receiver=${v.receiver}  [${sig}]`,
    );
  }
  if (!DRY_RUN) {
    const missing = VAULTS.filter((v) => !wallets.has(getAddress(v.vault)));
    if (missing.length) {
      log(
        `DRY_RUN=0 but no signer for: ${missing
          .map((v) => v.name)
          .join(", ")}. Set the per-vault key env vars. Exiting.`,
        "ERROR",
      );
      process.exit(1);
    }
  }
  log("=".repeat(70));

  // Block-driven trigger.
  publicClient.watchBlockNumber({
    emitOnBegin: true,
    onBlockNumber: (bn) => {
      void onBlock(bn);
    },
    onError: (err) => log(`watch error: ${revertReason(err)}`, "WARN"),
  });
}

main().catch((err) => {
  log(`fatal: ${revertReason(err)}`, "ERROR");
  process.exit(1);
});
