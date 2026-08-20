import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import { ADDRESSES, CHAIN_ID } from "../config.ts";

export const robinhoodChain = defineChain({
  id: CHAIN_ID,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  contracts: { multicall3: { address: ADDRESSES.multicall3 } }
});

export function createReadClient(rpcUrl: string): PublicClient {
  return createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl) });
}
