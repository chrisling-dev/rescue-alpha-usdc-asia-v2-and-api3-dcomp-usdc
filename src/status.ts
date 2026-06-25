// One-shot real-time status: prints the TRUE on-chain withdrawable state for
// both vaults (market liquidity + idle + a live withdrawal simulation), so you
// can sanity-check against the Morpho app — whose "Liquidity" number LAGS and
// can show funds that no longer exist on-chain. Run with: npm run status
import "./loadenv.js";
import {
  createPublicClient,
  http,
  encodeAbiParameters,
  encodeFunctionData,
  formatUnits,
  parseUnits,
  erc20Abi,
  type Hex,
} from "viem";
import { mainnet } from "viem/chains";
import { morphoAbi, vaultAbi } from "./abi.js";
import { VAULTS, MORPHO_BLUE, RPC_HTTP } from "./config.js";

const pc = createPublicClient({ chain: mainnet, transport: http(RPC_HTTP) });

function marketParamsData(v: (typeof VAULTS)[number]): Hex {
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

const bn = await pc.getBlockNumber();
console.log(`\nReal-time on-chain status @ block ${bn}  (RPC: ${RPC_HTTP})\n`);

for (const v of VAULTS) {
  const m = await pc.readContract({
    address: MORPHO_BLUE,
    abi: morphoAbi,
    functionName: "market",
    args: [v.marketId],
  });
  const liq = m[0] - m[2];
  const idle = await pc.readContract({
    address: v.marketParams.loanToken,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [v.vault],
  });
  const shares = await pc.readContract({
    address: v.vault,
    abi: vaultAbi,
    functionName: "balanceOf",
    args: [v.owner],
  });
  const own =
    shares === 0n
      ? 0n
      : await pc.readContract({
          address: v.vault,
          abi: vaultAbi,
          functionName: "convertToAssets",
          args: [shares],
        });

  // Live: would a $100 withdrawal actually go through right now?
  let canWithdraw = "n/a (no position)";
  if (own > parseUnits("100", 6)) {
    const amt = parseUnits("100", 6);
    const c1 = encodeFunctionData({
      abi: vaultAbi,
      functionName: "forceDeallocate",
      args: [v.adapter, marketParamsData(v), amt, v.owner],
    });
    const c2 = encodeFunctionData({
      abi: vaultAbi,
      functionName: "withdraw",
      args: [amt, v.owner, v.owner],
    });
    try {
      await pc.simulateContract({
        account: v.owner,
        address: v.vault,
        abi: vaultAbi,
        functionName: "multicall",
        args: [[c1, c2]],
      });
      canWithdraw = "✅ YES (a window is open)";
    } catch {
      canWithdraw = "❌ no (0 withdrawable)";
    }
  }

  console.log(`${v.name}`);
  console.log(`  market liquidity : ${formatUnits(liq, 6)} USDC`);
  console.log(`  vault idle USDC  : ${formatUnits(idle, 6)} USDC`);
  console.log(`  owner=${v.owner}`);
  console.log(`  owner position   : ${formatUnits(own, 6)} USDC`);
  console.log(`  withdraw now?    : ${canWithdraw}\n`);
}
