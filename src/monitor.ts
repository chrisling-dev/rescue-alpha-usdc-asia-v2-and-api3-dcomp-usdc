/**
 * Morpho Vault V2 liquidity ALARM (TypeScript / viem).
 *
 * Watches two illiquid (100%-utilization) Morpho Blue markets that back two
 * Vault V2 vaults. The instant withdrawable liquidity appears in a market
 * (a borrower repays, a position is liquidated, or someone supplies), it sounds
 * a loud alarm so the owner can withdraw manually — there is NO automated
 * withdrawal and NO private key here. It only watches and screams.
 *
 * Liquidity is read directly from Morpho Blue:
 *     liquidity = market.totalSupplyAssets - market.totalBorrowAssets
 * Exact at 100% utilization (interest accrues equally to supply and borrow).
 *
 * The alarm fires on the on-chain liquidity reading itself: when the market has
 * at least MIN_TRIGGER_USDC of available liquidity and the owner has a position.
 * (An earlier version gated on simulating the full forceDeallocate+withdraw, but
 * that suppressed real, minutes-long windows where the exact-max withdrawal
 * didn't simulate — a false negative is the worst outcome here, so we trust the
 * liquidity read and wake the human.) The owner then withdraws manually via the
 * Morpho app (link printed in the alert).
 *
 * Trigger model: block-driven (newHeads via WebSocket if RPC_WS is set, else
 * HTTP block polling).
 */
import "./loadenv.js"; // MUST be first — populates process.env before config reads it
import { appendFileSync } from "node:fs";
import { spawn } from "node:child_process";
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
  MIN_TRIGGER_USDC,
  SAFETY_BUFFER_USDC,
  ALARM_COOLDOWN_SEC,
  ALARM_CMD,
  SAY,
  LOGFILE,
  EXECUTE,
  PRIVATE_KEY,
  PRIORITY_GWEI,
  MAX_FEE_GWEI,
  GAS_LIMIT,
  HOT_ADDRESS,
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

function revertReason(err: unknown): string {
  const collapse = (s: string) =>
    s.replace(/\s*\n\s*/g, " ").trim().slice(0, 200);
  if (err instanceof BaseError) return collapse(err.shortMessage || err.message);
  return err instanceof Error ? collapse(err.message) : String(err);
}

// ── client ──────────────────────────────────────────────────────────────────
const publicClient: PublicClient = createPublicClient({
  chain: mainnet,
  transport: RPC_WS ? webSocket(RPC_WS) : http(RPC_HTTP),
  pollingInterval: POLL_MS,
});

// ── reads ──────────────────────────────────────────────────────────────────
async function readMarketLiquidity(v: VaultConfig): Promise<bigint> {
  const m = await publicClient.readContract({
    address: MORPHO_BLUE,
    abi: morphoAbi,
    functionName: "market",
    args: [v.marketId],
  });
  return m[0] - m[2]; // totalSupplyAssets - totalBorrowAssets
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

// ── auto-withdraw (EXECUTE mode) ─────────────────────────────────────────────
// The exact forceDeallocate+withdraw multicall the winning bot uses. We send it
// the instant liquidity appears, racing the competing bot. Confirmed on-chain
// (block 25392975 replay): this succeeds for the owner whenever liquidity exists.
let signer: { account: Account; client: WalletClient } | undefined;

function loadSigner() {
  if (!EXECUTE) return;
  if (!PRIVATE_KEY) throw new Error("EXECUTE=1 but PRIVATE_KEY is not set");
  const account = privateKeyToAccount(PRIVATE_KEY);
  const client = createWalletClient({
    account,
    chain: mainnet,
    transport: http(RPC_HTTP),
  });
  signer = { account, client };
}

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

function buildMulticall(v: VaultConfig, amount: bigint): [Hex, Hex] {
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

const submitting = new Set<string>(); // vaults with an in-flight tx

// Sequential nonce allocator so two same-block withdrawals (both vaults from the
// one hot wallet) don't grab the same pending nonce and collide.
let managedNonce: number | undefined;
let nonceChain: Promise<void> = Promise.resolve();
async function allocNonce(): Promise<number> {
  const prev = nonceChain;
  let release!: () => void;
  nonceChain = new Promise<void>((r) => (release = r));
  await prev;
  try {
    if (managedNonce === undefined) {
      managedNonce = await publicClient.getTransactionCount({
        address: signer!.account.address,
        blockTag: "pending",
      });
    }
    return managedNonce++;
  } finally {
    release();
  }
}

async function executeWithdraw(v: VaultConfig, amount: bigint, amtH: string) {
  if (!signer) return;
  if (submitting.has(v.vault)) return; // don't double-submit
  submitting.add(v.vault);
  const calls = buildMulticall(v, amount);
  try {
    log(
      `>>> EXECUTING forceDeallocate+withdraw ${amtH} USDC from ${v.name} ` +
        `(racing the bot, priority ${PRIORITY_GWEI} gwei)...`,
      "EXEC",
    );
    const nonce = await allocNonce();
    const hash = await signer.client.writeContract({
      account: signer.account,
      chain: mainnet,
      address: v.vault,
      abi: vaultAbi,
      functionName: "multicall",
      args: [[calls[0], calls[1]]],
      nonce,
      gas: GAS_LIMIT, // fixed limit → skip estimateGas latency
      maxPriorityFeePerGas: parseGwei(PRIORITY_GWEI),
      ...(MAX_FEE_GWEI ? { maxFeePerGas: parseGwei(MAX_FEE_GWEI) } : {}),
    });
    log(`    tx sent: ${hash}`, "EXEC");
    const rcpt = await publicClient.waitForTransactionReceipt({ hash });
    if (rcpt.status === "success") {
      log(`    ✅ WITHDRAW CONFIRMED  tx=${hash}  block=${rcpt.blockNumber}`, "EXEC");
    } else {
      log(`    ❌ tx reverted (lost the race or window shrank)  tx=${hash}`, "EXEC");
    }
  } catch (err) {
    log(`    send failed: ${revertReason(err)}`, "WARN");
    managedNonce = undefined; // resync from chain (pending count) next time
  } finally {
    submitting.delete(v.vault);
  }
}

// ── alarm ────────────────────────────────────────────────────────────────────
function runDetached(cmd: string) {
  try {
    const child = spawn("sh", ["-c", cmd], { detached: true, stdio: "ignore" });
    child.unref();
    child.on("error", () => {});
  } catch {
    /* ignore */
  }
}

function soundAlarm(spoken: string) {
  process.stdout.write("\x07\x07\x07"); // terminal bell (cross-platform)
  if (ALARM_CMD) {
    runDetached(ALARM_CMD);
  } else if (process.platform === "darwin") {
    // Loud, repeating system sound.
    runDetached(
      "for i in 1 2 3 4 5; do afplay /System/Library/Sounds/Sonar.aiff; done",
    );
    // Desktop notification.
    runDetached(
      `osascript -e 'display notification "${spoken}" with title "Morpho liquidity!" sound name "Sonar"'`,
    );
  }
  if (SAY && process.platform === "darwin") {
    runDetached(`say -r 190 ${JSON.stringify(spoken)}`);
  }
}

// ── per-block logic ──────────────────────────────────────────────────────────
const triggerWei = parseUnits(String(MIN_TRIGGER_USDC), 6);
const bufferWei = parseUnits(String(SAFETY_BUFFER_USDC), 6);
const open = new Set<string>(); // vaults currently in an open window (edge state)
const lastSound = new Map<string, number>(); // vault -> ms timestamp
// Print the "block … liquidity →" line every N blocks so you can see it's alive.
// 1 = every block (~12s). Raise it if the log gets too chatty.
const HEARTBEAT_BLOCKS = Number(process.env.HEARTBEAT_BLOCKS ?? "1");
let processing = false;
let heartbeat = 0;

async function onBlock(blockNumber: bigint) {
  if (processing) return;
  processing = true;
  try {
    const status: string[] = [];
    for (const v of VAULTS) {
      let liq: bigint;
      try {
        liq = await readMarketLiquidity(v);
      } catch (err) {
        log(`${v.name}: market read error: ${revertReason(err)}`, "WARN");
        continue;
      }
      status.push(`${v.name.split(" ")[0]}=${formatUnits(liq, 6)}`);

      if (liq < triggerWei) {
        if (open.has(v.vault)) {
          log(`${v.name}: window closed (liquidity back below trigger).`, "INFO");
          open.delete(v.vault);
        }
        continue;
      }

      // There's liquidity. Size the grab by the owner's position.
      let own: bigint;
      try {
        own = await readOwnerAssets(v);
      } catch (err) {
        log(`${v.name}: owner-assets read error: ${revertReason(err)}`, "WARN");
        continue;
      }
      if (own < triggerWei) continue;

      const amount = (liq < own ? liq : own) - bufferWei;
      if (amount <= 0n) continue;

      // Alarm directly on the on-chain liquidity reading. We do NOT gate on a
      // full forceDeallocate+withdraw simulation: these windows flicker in and
      // out within a block, so by the time a heavier sim call returns the
      // window may have momentarily closed — suppressing a REAL window (the
      // worst outcome). Liquidity > 0 means it's genuinely withdrawable via the
      // forceDeallocate+withdraw path; wake the human and let them race it.

      const liqH = formatUnits(liq, 6);
      const amtH = formatUnits(amount, 6);
      const spoken =
        `Liquidity in ${v.name.split(" ")[0]} vault. ` +
        `You can withdraw about ${Math.floor(Number(amtH))} dollars now.`;

      // Banner every block; sound is cooldown-gated.
      log("", "ALERT");
      log("🚨".repeat(20), "ALERT");
      log(
        `*** WITHDRAW WINDOW OPEN — ${v.name} @ block ${blockNumber} ***`,
        "ALERT",
      );
      log(
        `    market liquidity: ${liqH} USDC   your position: ` +
          `${formatUnits(own, 6)} USDC   -> up to ~${amtH} USDC withdrawable NOW`,
        "ALERT",
      );
      if (EXECUTE) {
        log(`    EXECUTE mode: firing the withdrawal now (racing the bot).`, "ALERT");
      } else {
        log(
          `    GO WITHDRAW: https://app.morpho.org/ethereum/vault/${v.vault}`,
          "ALERT",
        );
        log(
          `    (if it won't let you take the full amount, withdraw a bit ` +
            `less — exact-max can fail)`,
          "ALERT",
        );
      }
      log("🚨".repeat(20), "ALERT");

      // Fire the auto-withdraw (fire-and-forget; guarded against double-submit).
      if (EXECUTE) void executeWithdraw(v, amount, amtH);

      const now = Date.now();
      if (now - (lastSound.get(v.vault) ?? 0) >= ALARM_COOLDOWN_SEC * 1000) {
        soundAlarm(spoken);
        lastSound.set(v.vault, now);
      }
      open.add(v.vault);
    }

    heartbeat += 1;
    if (status.length && (heartbeat - 1) % HEARTBEAT_BLOCKS === 0) {
      log(`block ${blockNumber}  liquidity → ${status.join("  ")}`);
    }
  } finally {
    processing = false;
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  loadSigner();

  log("=".repeat(70));
  log(
    `Morpho Vault V2 liquidity monitor (viem/TS) — ` +
      `${EXECUTE ? "AUTO-WITHDRAW mode" : "ALERT ONLY"}`,
  );
  log(`RPC=${RPC_WS || RPC_HTTP}  mode=${RPC_WS ? "newHeads" : "poll"}`);
  log(
    `trigger>=${MIN_TRIGGER_USDC} USDC  ` +
      `sound=${process.platform === "darwin" ? "macOS" : ALARM_CMD ? "custom" : "bell-only"}`,
  );
  // Read each owner's share position up front and SAY it loudly — if it's 0,
  // the wallet we're watching is empty (shares moved? wrong owner/mode?) and the
  // bot can't do anything for that vault no matter what liquidity appears.
  let anyShares = false;
  for (const v of VAULTS) {
    log(`  watching ${v.name}`);
    log(`    owner=${v.owner}  receiver=${v.receiver}`);
    try {
      const bal = await readOwnerAssets(v);
      if (bal === 0n) {
        log(
          `    ⚠️  this owner holds 0 shares in this vault — nothing to ` +
            `withdraw here. (Shares moved to a hot wallet? Then run with ` +
            `EXECUTE=1 PRIVATE_KEY=<hot wallet>.)`,
          "WARN",
        );
      } else {
        anyShares = true;
        log(`    position: ${formatUnits(bal, 6)} USDC ✓`);
      }
    } catch {
      log(`    (could not read position — RPC issue)`, "WARN");
    }
  }
  if (!anyShares) {
    log(
      "NONE of the watched owners hold any shares — the bot will sit idle. " +
        "Point it at the wallet that holds the shares (see warning above).",
      "ERROR",
    );
  }
  if (EXECUTE) {
    // Sanity: the signer must own the shares it's withdrawing.
    for (const v of VAULTS) {
      if (getAddress(v.owner) !== getAddress(HOT_ADDRESS as Hex)) {
        log(
          `owner for ${v.name} (${v.owner}) != signer ${HOT_ADDRESS}. Move the ` +
            `shares to the signer, or set OWNER. Exiting.`,
          "ERROR",
        );
        process.exit(1);
      }
    }
    log(
      `AUTO-WITHDRAW armed. Signer=${HOT_ADDRESS}, USDC -> ${VAULTS[0]!.receiver}. ` +
        `priority=${PRIORITY_GWEI}gwei gas=${GAS_LIMIT}`,
      "EXEC",
    );
    log("⚠️  Make sure the hot wallet holds the shares and has ETH for gas.");
  } else {
    if (PRIVATE_KEY) {
      log(
        "⚠️  PRIVATE_KEY is set but EXECUTE is not 1 — running ALERT-ONLY and " +
          "ignoring the key. Set EXECUTE=1 to actually auto-withdraw.",
        "WARN",
      );
    }
    log("No private keys active. When it fires, withdraw manually.");
  }
  log("=".repeat(70));

  // Smoke-test the alarm once at startup so you know it's audible.
  if (process.env.TEST_ALARM === "1") {
    log("TEST_ALARM=1 — firing a test alarm now.", "ALERT");
    soundAlarm("Test alarm. Morpho monitor is working.");
  }

  publicClient.watchBlockNumber({
    emitOnBegin: true,
    onBlockNumber: (bn) => void onBlock(bn),
    onError: (err) => log(`watch error: ${revertReason(err)}`, "WARN"),
  });
}

main().catch((err) => {
  log(`fatal: ${revertReason(err)}`, "ERROR");
  process.exit(1);
});
