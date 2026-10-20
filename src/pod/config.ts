import type { CpuInfo, PodConfig } from './types'

// Static mainnet configuration mirrored from
// https://tapeout.net/pod/pod-mainnet.json
//
// RPC: tapeout.net's `/rpc` is a public JSON-RPC proxy (CORS `*`) that allows
// `eth_getLogs` ranges up to 50_000 blocks. The public RPCs listed in tapeout's
// CSP (drpc/publicnode/1rpc/ankr/dataseed) either need an API key or cap
// `getLogs` far below what a full historical scan needs.

/** 本地 fork 时用 `.env.local` 的 `VITE_POD_FROMBLOCK` 覆盖日志扫描起点。 */
const forkFromBlock = Number(import.meta.env.VITE_POD_FROMBLOCK || 0) || 0

function withFromBlock(cpu: CpuInfo): CpuInfo {
  return { ...cpu, fromBlock: forkFromBlock || cpu.fromBlock }
}

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
    // 拆解金库 / 质押池 / x 代币：主网未部署，本地 fork 由
    // `contracts/scripts/deploy-fork.ts` 写入 .env.local。
    decomposer: import.meta.env.VITE_POD_DECOMPOSER || '',
    staking: import.meta.env.VITE_POD_STAKING || '',
    xNand: import.meta.env.VITE_POD_XNAND || '',
    xLatch: import.meta.env.VITE_POD_XLATCH || '',
  },
  tokenSymbol: 'BEM',
  // BEM token `decimals()` on BSC is 8 (also hardcoded as /1e8 in tapeout.net's UI).
  tokenDecimals: 8,
  cpus: {
    Behemoth: withFromBlock(
      {
        address: '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
        multiplier: 6,
        fromBlock: 116079229,
        // 质押开关：镜像 MinerDecomposer.cpuAllowed(Behemoth)
        stakeEnabled: true,
      },
    ),
    TapeOut: withFromBlock(
      {
        address: '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
        multiplier: 1,
        fromBlock: 116140775,
        // 质押开关：镜像 MinerDecomposer.cpuAllowed(TapeOut)
        stakeEnabled: true,
      },
    ),
  },
  // Max `eth_getLogs` range accepted by tapeout.net/rpc.
  logChunk: 50_000,
  fromBlock: forkFromBlock || 117234441,
}

/** 拆解 / 质押功能是否已接入（合约地址齐全）。 */
export const STAKING_ENABLED = Boolean(
  POD_CONFIG.contracts.decomposer &&
    POD_CONFIG.contracts.staking &&
    POD_CONFIG.contracts.xNand &&
    POD_CONFIG.contracts.xLatch,
)
