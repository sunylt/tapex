/**
 * ⚠️ 模拟数据（MOCK）——仅用于「矿池」首页与「我的」页面的设计评审。
 *
 * 所有数字都是编造的，但**内部保持自洽**：
 *   矿池占比 = 矿池算力 / 全网算力
 *   矿池日收益 = 全网日产出 × 矿池占比
 *   单台预计产出 = 矿池日收益 × 该台算力 / 矿池算力
 * 等接入链上数据后，把这里换成 `@/pod/service` 里的
 * `readNetworkStats()` / `scanMinerRefsOnChain()` 结果即可，页面组件无需改动。
 */
import { POD_CONFIG } from './config'

export type PoolMinerStatus = 'mining' | 'idle' | 'offline'

export interface PoolMiner {
  /** 列表 key */
  id: string
  /** CPU 注册表名称：Behemoth / TapeOut / RefBench */
  cpu: string
  /** 电路（矿机）编号 */
  circuitId: number
  /** 结构：门数 / 状态数 / 深度 / 面积 */
  gates: number
  states: number
  depth: number
  area: number
  status: PoolMinerStatus
  /** 在线率 % */
  uptime: number
  /** 算力（与链上权重同量级） */
  hashrate: number
  /** 矿工地址（模拟） */
  owner: string
  /** 预计 24h 产出，由矿池日收益推导 */
  output24h: number
}

export interface PoolCpuSlice {
  name: string
  hashrate: number
  miners: number
  /** 取色用 */
  tone: 'behemoth' | 'refbench' | 'tapeout'
}

export interface PoolOverview {
  networkHashrate: number
  networkMiners: number
  /** 全网日产出（BEM/天） */
  networkDaily: number
  poolHashrate: number
  poolMiners: number
  mining: number
  idle: number
  offline: number
  /** 矿池在线率 0..1 */
  uptime: number
  /** 矿池算力占全网比例 0..1 */
  share: number
  /** 矿池预计日收益 */
  poolDaily: number
  /** 矿池 24h 实际产出 */
  produced24h: number
  /** 矿池累计产出 */
  totalProduced: number
  tokenSymbol: string
  updatedAt: number
}

/* ------------------------------------------------------------------ */
/* 基准数字（改这里就能整体调参）                                        */
/* ------------------------------------------------------------------ */

/** 与链上 totalVerifWeight 同量级（截图里约 1,575,388） */
const NETWORK_HASHRATE = 1_575_388
const NETWORK_MINERS = 19_429
/** ≈ 链上 currentRate 0.0833 BEM/s × 86400 */
const NETWORK_DAILY = 7_200
/** 全网已挖总量量级（totalMined） */
const NETWORK_MINED = 368_398

const POOL_HASHRATE = 243_660
const POOL_MINERS = 3_012
const POOL_MINING = 2_946
const POOL_IDLE = 48
const POOL_OFFLINE = 18
const POOL_UPTIME = 0.972

const share = POOL_HASHRATE / NETWORK_HASHRATE
const poolDaily = NETWORK_DAILY * share
const produced24h = poolDaily * POOL_UPTIME
const totalProduced = NETWORK_MINED * share

export const MOCK_POOL_OVERVIEW: PoolOverview = {
  networkHashrate: NETWORK_HASHRATE,
  networkMiners: NETWORK_MINERS,
  networkDaily: NETWORK_DAILY,
  poolHashrate: POOL_HASHRATE,
  poolMiners: POOL_MINERS,
  mining: POOL_MINING,
  idle: POOL_IDLE,
  offline: POOL_OFFLINE,
  uptime: POOL_UPTIME,
  share,
  poolDaily,
  produced24h,
  totalProduced,
  tokenSymbol: POD_CONFIG.tokenSymbol,
  updatedAt: Date.now(),
}

/** 矿池算力在不同 CPU 型号上的构成 */
export const MOCK_CPU_SLICES: PoolCpuSlice[] = [
  { name: 'Behemoth', miners: 1_206, hashrate: POOL_HASHRATE * 0.62, tone: 'behemoth' },
  { name: 'RefBench', miners: 1_024, hashrate: POOL_HASHRATE * 0.24, tone: 'refbench' },
  { name: 'TapeOut', miners: 782, hashrate: POOL_HASHRATE * 0.14, tone: 'tapeout' },
]

/* ------------------------------------------------------------------ */
/* 矿机列表（模拟：矿池算力 Top 12）                                     */
/* ------------------------------------------------------------------ */

interface MinerSeed {
  cpu: string
  circuitId: number
  gates: number
  states: number
  depth: number
  area: number
  status: PoolMinerStatus
  uptime: number
  hashrate: number
  owner: string
}

const SEEDS: MinerSeed[] = [
  { cpu: 'Behemoth', circuitId: 1284, gates: 4096, states: 1024, depth: 12, area: 2_410_000, status: 'mining', uptime: 99.98, hashrate: 2_412, owner: '0x8a3f19c4d05b7e2188f0a6c3d9e4172b5c8a21c9' },
  { cpu: 'Behemoth', circuitId: 937, gates: 4096, states: 1024, depth: 12, area: 2_380_000, status: 'mining', uptime: 99.91, hashrate: 2_287, owner: '0x1d7b45e2a9083c6f14bd72e5a03c98f6b21d4e70' },
  { cpu: 'Behemoth', circuitId: 1761, gates: 4096, states: 1024, depth: 11, area: 2_200_000, status: 'mining', uptime: 99.87, hashrate: 2_140, owner: '0x8a3f19c4d05b7e2188f0a6c3d9e4172b5c8a21c9' },
  { cpu: 'Behemoth', circuitId: 452, gates: 4096, states: 1024, depth: 11, area: 2_050_000, status: 'idle', uptime: 98.42, hashrate: 1_976, owner: '0xc40e8b1a7f236d95e01b78a4c63d02f9e5a71b38' },
  { cpu: 'RefBench', circuitId: 3310, gates: 2048, states: 512, depth: 8, area: 1_180_000, status: 'mining', uptime: 99.75, hashrate: 1_684, owner: '0x2f96c3d85a41e70b9d23c6f8a15e40b7c9d38a62' },
  { cpu: 'RefBench', circuitId: 2874, gates: 2048, states: 512, depth: 8, area: 1_120_000, status: 'mining', uptime: 99.62, hashrate: 1_512, owner: '0x77a1e40c9b38d52f6017ea4c29b83d5017cf6a24' },
  { cpu: 'RefBench', circuitId: 4102, gates: 2048, states: 512, depth: 7, area: 980_000, status: 'mining', uptime: 99.1, hashrate: 1_436, owner: '0xbe25d7f031984a6c7021de59b846a03c7fe2195d' },
  { cpu: 'RefBench', circuitId: 2596, gates: 2048, states: 512, depth: 7, area: 940_000, status: 'offline', uptime: 71.3, hashrate: 1_287, owner: '0x39c8f2a6b015d74e98c3a51f62b09d4e7a15c830' },
  { cpu: 'TapeOut', circuitId: 5821, gates: 1024, states: 256, depth: 6, area: 520_000, status: 'mining', uptime: 99.44, hashrate: 1_043, owner: '0x6d10b95e3c7a248f5019db6e28a47c053f9b26d1' },
  { cpu: 'TapeOut', circuitId: 6033, gates: 1024, states: 256, depth: 6, area: 500_000, status: 'mining', uptime: 99.21, hashrate: 968, owner: '0x6d10b95e3c7a248f5019db6e28a47c053f9b26d1' },
  { cpu: 'TapeOut', circuitId: 5477, gates: 1024, states: 256, depth: 5, area: 440_000, status: 'idle', uptime: 96.85, hashrate: 902, owner: '0xa8e34c71d902b6f35e1a08c47d29b6035ef1a7c4' },
  { cpu: 'TapeOut', circuitId: 6109, gates: 1024, states: 256, depth: 5, area: 410_000, status: 'mining', uptime: 98.9, hashrate: 861, owner: '0x52fb7e04a936c1d805b7e29a46c31f087d5be294' },
]

/** 单台预计产出 = 矿池日收益 × 算力占比；未挖矿的矿机不产币。 */
export const MOCK_POOL_MINERS: PoolMiner[] = SEEDS.map((seed) => {
  const output24h = seed.status === 'mining' ? (poolDaily * seed.hashrate) / POOL_HASHRATE : 0
  return {
    ...seed,
    id: `${seed.cpu}-${seed.circuitId}`,
    output24h,
  }
})

/* ------------------------------------------------------------------ */
/* 矿池权益（「我的」页面）                                              */
/* ------------------------------------------------------------------ */

export interface EquityToken {
  symbol: string
  /** 钱包中当前持有 */
  held: number
  /** 已质押进矿池 */
  staked: number
  /** 矿池中该代币的质押总量（用于算矿池占比） */
  poolStaked: number
}

export const MOCK_MY_EQUITY: EquityToken[] = [
  { symbol: 'xNAND', held: 18_640, staked: 9_400, poolStaked: 86_000 },
  { symbol: 'xLATCH', held: 4_720, staked: 2_180, poolStaked: 24_000 },
]
