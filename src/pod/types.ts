export interface CpuInfo {
  address: string
  multiplier: number
  fromBlock: number
}

export interface PodContracts {
  mining: string
  lens: string
  lensNext?: string
  token: string
  factory?: string
}

export interface PodConfig {
  chainId: number
  rpc: string
  explorer: string
  contracts: PodContracts
  tokenSymbol: string
  tokenDecimals: number
  cpus: Record<string, CpuInfo>
  logChunk: number
  fromBlock: number
}

export interface MinerRef {
  owner: string
  cpu: string
  circuits: string
  circuitId: number
  taskId: number
  note?: string
}

export interface MinerPreview {
  verifWeight: bigint
  unverWeight: bigint
  h: bigint
  bstar: bigint
  bonus: bigint
  optimal: boolean
  samples: number
  reason: string
}

export interface MinerStatus {
  ref: MinerRef
  key: string
  active: boolean
  status: number
  taskId: number
  gateCount: number
  stateCount: number
  depth: number
  area: bigint
  mult: number
  nandBurn: number
  latchBurn: number
  bstar: bigint
  bonus: bigint
  optimal: boolean
  verifWeight: bigint
  unverWeight: bigint
  since: bigint
  debt: bigint
  live: bigint
  preview: MinerPreview | null
}

export interface NetworkStats {
  block: number
  totalVerifWeight: bigint
  totalUnverWeight: bigint
  currentRate: bigint
  minerCount: number
  verifMinerCount: number
  unverifiedBps: number
  totalForgone: bigint
  totalMined: bigint
  taskCount: number
  startTime: number
  owner: string
}
