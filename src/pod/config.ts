import type { PodConfig } from './types'

// Static mainnet configuration mirrored from
// https://tapeout.net/pod/pod-mainnet.json
//
// RPC: tapeout.net's `/rpc` is a public JSON-RPC proxy (CORS `*`) that allows
// `eth_getLogs` ranges up to 50_000 blocks. The public RPCs listed in tapeout's
// CSP (drpc/publicnode/1rpc/ankr/dataseed) either need an API key or cap
// `getLogs` far below what a full historical scan needs.
export const POD_CONFIG: PodConfig = {
  chainId: 56,
  rpc: import.meta.env.VITE_POD_RPC || 'https://tapeout.net/rpc',
  explorer: 'https://bscscan.com',
  contracts: {
    mining: '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46',
    lens: '0xdD20B9537b9f5DB9d2A23E6B11Ad863cF81930d8',
    lensNext: '0x2243Eaf4Dd308AeA7E243C06d7b95265a90b0134',
    token: '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a',
    factory: '0x68224F668083c29e9800Be2a646d42d18cedF7e2',
  },
  tokenSymbol: 'BEM',
  // BEM token `decimals()` on BSC is 8 (also hardcoded as /1e8 in tapeout.net's UI).
  tokenDecimals: 8,
  cpus: {
    Behemoth: {
      address: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
      multiplier: 6,
      fromBlock: 116079229,
    },
    TapeOut: {
      address: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
      multiplier: 1,
      fromBlock: 116140775,
    },
    RefBench: {
      address: '0xF4412C52ec3DDf7CAf5f518B6662F77B02Bde28E',
      multiplier: 1,
      fromBlock: 117234441,
    },
  },
  // Max `eth_getLogs` range accepted by tapeout.net/rpc.
  logChunk: 50_000,
  fromBlock: 117234441,
}
