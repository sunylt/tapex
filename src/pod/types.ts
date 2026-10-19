export interface CpuInfo {
  address: string
  multiplier: number
  fromBlock: number
  /**
   * 该型号的矿机是否允许质押进矿池（拆解）。
   * 链上以 `MinerDecomposer.cpuAllowed(cpu)` 为准，这里是前端开关：
   * 关掉后卡片上的「拆解」按钮会置灰，避免用户白跑一笔会被 revert 的交易。
   */
  stakeEnabled: boolean
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
