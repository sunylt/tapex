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
  /** MinerDecomposer（拆解 / 赎回金库）。未部署时为空串，相关按钮会禁用。 */
  decomposer?: string
  /** XTokenStaking（xNAND / xLATCH 质押池） */
  staking?: string
  xNand?: string
  xLatch?: string
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

/** xNAND / xLATCH 权益（decimals = 0，数量即整数枚数）。 */
export interface EquityToken {
  /** 展示用符号，如 `xNAND` */
  symbol: string
  /** 代币合约地址（发交易用） */
  address: string
  /** 钱包持有 */
  held: number
  /** 已质押进质押池 */
  staked: number
  /** 质押池总量（算占比用） */
  poolStaked: number
}

/** 矿池里的一台在押矿机（`MinerDecomposer.stakedAt(index)`）。 */
export interface PoolStake {
  /** CPU NFT 合约地址 */
  cpu: string
  /** CPU 型号名（对应 `POD_CONFIG.cpus` 的 key），未知型号回退为地址 */
  cpuName: string
  id: number
  /** 拆解时的存款人 */
  depositor: string
  /** 赎回需要烧掉的 xNAND / xLATCH 数量 */
  nandAmount: number
  latchAmount: number
  /** 链上矿机状态；读取失败时为 null */
  status: MinerStatus | null
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
  /** 全网日产出（BEM，8 decimals） */
  dailyEmission: bigint
  minerCount: number
  verifMinerCount: number
  unverifiedBps: number
  totalForgone: bigint
  totalMined: bigint
  taskCount: number
  startTime: number
  owner: string
}
