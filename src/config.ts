import { type Address, type Hex } from "viem";

// ──────────────────────────────────────────────────────────────────────────
// CONFIG  (env vars override these)
// ──────────────────────────────────────────────────────────────────────────

export const RPC_HTTP =
  process.env.RPC_HTTP ?? "https://ethereum-rpc.publicnode.com";
// Optional WebSocket endpoint for true newHeads subscription (lower latency).
// e.g. wss://ethereum-rpc.publicnode.com  — falls back to HTTP polling if unset.
export const RPC_WS = process.env.RPC_WS ?? "";

export const MORPHO_BLUE: Address =
  "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

// Only act when at least this much liquidity AND owner position is available.
// Units = USDC (human, e.g. 50 = $50).
export const MIN_TRIGGER_USDC = Number(process.env.MIN_TRIGGER_USDC ?? "50");

// Withdraw min(liquidity, ownerPosition) minus this buffer (USDC). Covers the
// forceDeallocate penalty + rounding, and reduces same-block reverts.
export const SAFETY_BUFFER_USDC = Number(process.env.SAFETY_BUFFER_USDC ?? "1");

// HTTP block-poll interval (ms). Blocks are ~12s; 3-4s catches every block.
// Ignored when RPC_WS is set (we subscribe to newHeads instead).
export const POLL_MS = Number(process.env.POLL_SECONDS ?? "4") * 1000;

// DRY_RUN=1 (default): simulate + print, broadcast nothing.
// DRY_RUN=0: actually broadcast (requires a per-vault signer below).
export const DRY_RUN = (process.env.DRY_RUN ?? "1") !== "0";

// Aggressive gas to win the inclusion race.
export const PRIORITY_GWEI = process.env.PRIORITY_GWEI ?? "5";
export const MAX_FEE_GWEI = process.env.MAX_FEE_GWEI ?? ""; // empty = auto

export const LOGFILE = process.env.LOGFILE ?? "morpho-monitor.log";

// Stop monitoring a vault after its owner's position is fully drained.
export const EXIT_AFTER_FULL = (process.env.EXIT_AFTER_FULL ?? "0") === "1";

export interface MarketParams {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
}

export interface VaultConfig {
  name: string;
  vault: Address;
  marketId: Hex;
  loanDecimals: number;
  owner: Address; // verified share holder
  receiver: Address;
  keyEnv: string; // env var holding this owner's private key
  adapter: Address; // MorphoMarketV1 adapter
  marketParams: MarketParams; // abi-encoded as `data` for forceDeallocate
  forcePenaltyBps: number; // informational
}

const USDC: Address = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const IRM: Address = "0x870aC11D48B15DB9a138Cf899d20F13F79Ba00BC";

export const VAULTS: VaultConfig[] = [
  {
    name: "Alpha USDC Asia V2 (AZND collat)",
    vault: "0x35Cbe8542E70fa2f7F9cDF129F19e593F4b4f560",
    marketId:
      "0xfd0d72a4f0469598b566b1bc5fe64835f828f90b1fb7d746148c086164cd4cc2",
    loanDecimals: 6,
    owner: "0x6b06da993b1f12d82463fec75006913f98499b7c",
    receiver: (process.env.RECEIVER_ALPHA ??
      "0x6b06da993b1f12d82463fec75006913f98499b7c") as Address,
    keyEnv: "PRIVATE_KEY_ALPHA",
    adapter: "0xc3E1DC28DaFB8369d8BE52334472a87Dd61AbA49",
    marketParams: {
      loanToken: USDC,
      collateralToken: "0x52c66B5E7f8Fde20843De900C5C8B4b0F23708A0", // AZND
      oracle: "0x270B2bD4CC6d935aa08b70eAC518E2907EB5588b",
      irm: IRM,
      lltv: 860000000000000000n,
    },
    forcePenaltyBps: 200, // ~2%
  },
  {
    name: "Api3 dCOMP USDC (dCOMP collat)",
    vault: "0x36cfe1568461E499391ef0A555300F1ae2da2439",
    marketId:
      "0x24852d8d7464402ddcd717415e009d42bf7427d6a8893487f83c75ee0f4a0ea6",
    loanDecimals: 6,
    owner: "0xd87617659957f4d9cea85e9db85b2f1de677646a",
    receiver: (process.env.RECEIVER_API3 ??
      "0xd87617659957f4d9cea85e9db85b2f1de677646a") as Address,
    keyEnv: "PRIVATE_KEY_API3",
    adapter: "0x0854c79eC9600FD1d02caA14Ef0527f93bb5e4cc",
    marketParams: {
      loanToken: USDC,
      collateralToken: "0x91d14789071e5E195FFC9F745348736677De3292", // dCOMP
      oracle: "0x0798dE3DDb22c289A653c020863AaA7ef33C05d7",
      irm: IRM,
      lltv: 625000000000000000n,
    },
    forcePenaltyBps: 1, // ~0.01%
  },
];
