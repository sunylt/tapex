import {
  BrowserProvider,
  Contract,
  MaxUint256,
  getAddress,
  type ContractRunner,
} from 'ethers'

import {
  DECOMPOSER_ABI,
  ERC20_ABI,
  ERC721_ABI,
  MINING_ABI,
  STAKING_ABI,
} from './abis'
import { POD_CONFIG, STAKING_ENABLED } from './config'
import { getReadProvider, hasInjectedWallet, readMinerStatus } from './service'
import type { EquityToken, MinerRef, PoolStake } from './types'

/**
 * 链上写操作 + 质押相关的链上读操作。
 *
 * 写操作一律走 window.ethereum（浏览器钱包签名），读操作走只读 provider。
 * 合约地址见 `POD_CONFIG.contracts`，本地 fork 由
 * `contracts/scripts/deploy-fork.ts` 部署并写进 `.env.local`。
 */

function requireContracts(): {
  decomposer: string
  staking: string
  xNand: string
  xLatch: string
} {
  const { decomposer, staking, xNand, xLatch } = POD_CONFIG.contracts
  if (!STAKING_ENABLED || !decomposer || !staking || !xNand || !xLatch) {
    throw new Error('未配置拆解 / 质押合约地址（VITE_POD_DECOMPOSER 等）')
  }
  return { decomposer, staking, xNand, xLatch }
}

/* ------------------------------------------------------------------ */
/* 钱包 signer / 交易                                                   */
/* ------------------------------------------------------------------ */

async function getSigner() {
  if (!hasInjectedWallet()) throw new Error('未检测到浏览器钱包（window.ethereum）')
  const provider = new BrowserProvider(window.ethereum!)
  return provider.getSigner()
}

/**
 * ethers v6 里动态 ABI 的 `Contract` 方法会被标成 possibly undefined，
 * 这里和 `pod/service.ts` 一样用宽松类型包一层。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function contractAt(address: string, abi: readonly string[], runner?: ContractRunner): any {
  return new Contract(address, abi, runner ?? getReadProvider())
}

/** 统一的交易提示：签名取消 / 合约 revert 都翻成能看懂的中文。 */
export function describeError(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as { code?: unknown; shortMessage?: string; reason?: string; message?: string }
    if (e.code === 4001 || e.code === 'ACTION_REJECTED') return '已取消签名'
    const text = e.shortMessage || e.reason || e.message || String(err)
    const known: Array<[RegExp, string]> = [
      [/CpuNotAllowed/, '该 CPU 型号未开放质押'],
      [/NotCpuOwner/, '你不是这台矿机 NFT 的持有人'],
      [/AlreadyStaked/, '这台矿机已在矿池中'],
      [/NotStaked/, '这台矿机不在矿池中'],
      [/NotRegisteredMiner/, '矿机未在挖矿合约注册'],
      [/ZeroPrice/, '该矿机拆解价格为 0，无法质押'],
      [/InsufficientReserve/, '金库可用收益不足'],
      [/NoStakers/, '质押池里还没有人质押，先抵押 xNAND / xLATCH'],
      [/NothingToClaim/, '暂无可领取的收益'],
      [/InsufficientStake/, '质押数量超过你已抵押的数量'],
      [/TokenNotAllowed/, '不是允许的代币（仅 xNAND / xLATCH）'],
      [/ZeroAmount/, '数量必须大于 0'],
      [/InsufficientAllowance/, '授权额度不足'],
      [/InsufficientBalance/, '余额不足'],
      [/ERC721IncorrectOwner/, '你不是这台矿机 NFT 的持有人'],
      [/insufficient allowance/i, '授权额度不足'],
      [/insufficient balance/i, '余额不足'],
    ]
    for (const [re, zh] of known) if (re.test(text)) return zh
    return text
  }
  return String(err)
}

async function send(fn: () => Promise<{ hash: string; wait: () => Promise<unknown> }>): Promise<string> {
  const tx = await fn()
  await tx.wait()
  return tx.hash
}

/** ERC20 授权：额度不够就补成无限授权（x 代币是 OZ ERC20，可重复 approve）。 */
async function ensureErc20Allowance(token: string, spender: string, needed: bigint) {
  const signer = await getSigner()
  const owner = await signer.getAddress()
  const erc20 = contractAt(token, ERC20_ABI)
  const current = (await erc20.allowance(owner, spender)) as bigint
  if (current >= needed) return
  const withSigner = contractAt(token, ERC20_ABI, signer)
  await send(() => withSigner.approve(spender, MaxUint256))
}

/** ERC721 单 token 授权：已授权给金库就跳过，省一笔交易。 */
async function ensureErc721Approval(nft: string, id: bigint, spender: string) {
  const signer = await getSigner()
  const registry = contractAt(nft, ERC721_ABI)
  const approved = (await registry.getApproved(id)) as string
  if (approved.toLowerCase() === spender.toLowerCase()) return
  const withSigner = contractAt(nft, ERC721_ABI, signer)
  await send(() => withSigner.approve(spender, id))
}

/* ------------------------------------------------------------------ */
/* 写操作                                                               */
/* ------------------------------------------------------------------ */

/** 质押（拆解）矿机：approve NFT → MinerDecomposer.stake，铸出 xNAND / xLATCH。 */
export async function stakeMiner(circuits: string, id: number): Promise<string> {
  const { decomposer } = requireContracts()
  await ensureErc721Approval(circuits, BigInt(id), decomposer)
  const signer = await getSigner()
  const vault = contractAt(decomposer, DECOMPOSER_ABI, signer)
  return send(() => vault.stake(circuits, BigInt(id)))
}

/** 赎回矿机：烧掉价格数量的 xNAND / xLATCH，NFT 转回给调用者。 */
export async function redeemMiner(
  circuits: string,
  id: number,
  nandAmount: number,
  latchAmount: number,
): Promise<string> {
  const { decomposer, xNand, xLatch } = requireContracts()
  if (nandAmount > 0) await ensureErc20Allowance(xNand, decomposer, BigInt(nandAmount))
  if (latchAmount > 0) await ensureErc20Allowance(xLatch, decomposer, BigInt(latchAmount))
  const signer = await getSigner()
  const vault = contractAt(decomposer, DECOMPOSER_ABI, signer)
  return send(() => vault.redeem(circuits, BigInt(id)))
}

/** 抵押 xNAND / xLATCH 进质押池（decimals = 0，amount 必须是整数）。 */
export async function stakeX(token: string, amount: number): Promise<string> {
  const { staking } = requireContracts()
  assertIntegerAmount(amount)
  await ensureErc20Allowance(token, staking, BigInt(amount))
  const signer = await getSigner()
  const pool = contractAt(staking, STAKING_ABI, signer)
  return send(() => pool.stake(token, BigInt(amount)))
}

/** 解押 xNAND / xLATCH，代币回到钱包。 */
export async function unstakeX(token: string, amount: number): Promise<string> {
  const { staking } = requireContracts()
  assertIntegerAmount(amount)
  const signer = await getSigner()
  const pool = contractAt(staking, STAKING_ABI, signer)
  return send(() => pool.unstake(token, BigInt(amount)))
}

/** 领取质押收益（BEM 由金库直付给钱包）。 */
export async function claimStakingRewards(): Promise<string> {
  const { staking } = requireContracts()
  const signer = await getSigner()
  const pool = contractAt(staking, STAKING_ABI, signer)
  return send(() => pool.claim())
}

/** 领取矿机挖矿收益（打进当前 NFT 持有人 = 钱包）。 */
export async function claimMiningRewards(keys: string[]): Promise<string> {
  if (keys.length === 0) throw new Error('没有待领取的矿机收益')
  const signer = await getSigner()
  const mining = contractAt(POD_CONFIG.contracts.mining, MINING_ABI, signer)
  return send(() => mining.claimMany(keys))
}

/** Owner 专属：把金库可用的 BEM 全部分给质押池（触发 notifyReward）。 */
export async function distributeAllRewards(): Promise<{ hash: string; amount: bigint }> {
  const { decomposer } = requireContracts()
  const signer = await getSigner()
  const vault = contractAt(decomposer, DECOMPOSER_ABI)
  const rewardToken = (await vault.rewardToken()) as string
  const reserved = (await vault.reservedRewards()) as bigint
  const token = contractAt(rewardToken, ERC20_ABI)
  const balance = (await token.balanceOf(decomposer)) as bigint
  const free = balance - reserved
  if (free <= 0n) throw new Error('金库可用收益为 0，无法发放')

  const withSigner = contractAt(decomposer, DECOMPOSER_ABI, signer)
  const hash = await send(() => withSigner.distributeRewards(free))
  return { hash, amount: free }
}

function assertIntegerAmount(amount: number) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error('xNAND / xLATCH 数量必须是正整数（decimals = 0）')
  }
}

/* ------------------------------------------------------------------ */
/* 读操作                                                               */
/* ------------------------------------------------------------------ */

/** 钱包的 xNAND / xLATCH 持有量、已抵押量与池子总量。 */
export async function readEquity(address: string): Promise<EquityToken[]> {
  const { staking, xNand, xLatch } = requireContracts()
  const nand = contractAt(xNand, ERC20_ABI)
  const latch = contractAt(xLatch, ERC20_ABI)
  const pool = contractAt(staking, STAKING_ABI)

  const [nandHeld, latchHeld, staked, totals] = await Promise.all([
    nand.balanceOf(address) as Promise<bigint>,
    latch.balanceOf(address) as Promise<bigint>,
    pool.stakedOf(address) as Promise<readonly [bigint, bigint]>,
    pool.totalStaked() as Promise<readonly [bigint, bigint]>,
  ])

  return [
    {
      symbol: 'xNAND',
      address: xNand,
      held: Number(nandHeld),
      staked: Number(staked[0]),
      poolStaked: Number(totals[0]),
    },
    {
      symbol: 'xLATCH',
      address: xLatch,
      held: Number(latchHeld),
      staked: Number(staked[1]),
      poolStaked: Number(totals[1]),
    },
  ]
}

/** 我在质押池里待领取的 BEM 收益。 */
export async function readEarned(address: string): Promise<bigint> {
  const { staking } = requireContracts()
  const pool = contractAt(staking, STAKING_ABI)
  return (await pool.earned(address)) as bigint
}

/** 拆解金库 owner（只有它能发放收益）。 */
export async function readDecomposerOwner(): Promise<string> {
  const { decomposer } = requireContracts()
  const vault = contractAt(decomposer, DECOMPOSER_ABI)
  return getAddress((await vault.owner()) as string)
}

/** 矿池里全部在押矿机（含链上状态）。 */
export async function readPoolStakes(): Promise<PoolStake[]> {
  const { decomposer } = requireContracts()
  const vault = contractAt(decomposer, DECOMPOSER_ABI)

  const count = Number((await vault.stakedCount()) as bigint)
  if (count === 0) return []

  const rows = await Promise.all(
    Array.from({ length: count }, (_, i) => vault.stakedAt(i) as Promise<readonly [string, bigint, string, bigint, bigint]>),
  )

  const cpuNames = new Map<string, string>()
  for (const [name, cpu] of Object.entries(POD_CONFIG.cpus)) cpuNames.set(cpu.address.toLowerCase(), name)

  const stakes: PoolStake[] = rows.map((row) => {
    const cpu = getAddress(row[0])
    const id = Number(row[1])
    return {
      cpu,
      cpuName: cpuNames.get(cpu.toLowerCase()) ?? cpu,
      id,
      depositor: getAddress(row[2]),
      nandAmount: Number(row[3]),
      latchAmount: Number(row[4]),
      status: null,
    }
  })

  // 状态逐台读；单台失败不影响整页
  await Promise.all(
    stakes.map(async (s) => {
      const ref: MinerRef = {
        owner: s.depositor,
        cpu: s.cpuName,
        circuits: s.cpu,
        circuitId: s.id,
        taskId: 0,
      }
      s.status = await readMinerStatus(ref).catch(() => null)
    }),
  )
  return stakes
}

export interface VaultStats {
  /** 在押矿机数 */
  stakedCount: number
  /** 质押池中 xNAND / xLATCH 总量 */
  nandStaked: number
  latchStaked: number
  /** 金库持有的 BEM、其中已保留未发放的部分，以及可发放余额 */
  vaultBalance: bigint
  reserved: bigint
  free: bigint
}

/** 金库 / 质押池总览（矿池首页的「金库与质押」面板）。 */
export async function readVaultStats(): Promise<VaultStats> {
  const { decomposer, staking } = requireContracts()
  const vault = contractAt(decomposer, DECOMPOSER_ABI)
  const pool = contractAt(staking, STAKING_ABI)

  const [count, totals, rewardToken, reserved] = await Promise.all([
    vault.stakedCount() as Promise<bigint>,
    pool.totalStaked() as Promise<readonly [bigint, bigint]>,
    vault.rewardToken() as Promise<string>,
    vault.reservedRewards() as Promise<bigint>,
  ])
  const token = contractAt(rewardToken, ERC20_ABI)
  const balance = (await token.balanceOf(decomposer)) as bigint

  return {
    stakedCount: Number(count),
    nandStaked: Number(totals[0]),
    latchStaked: Number(totals[1]),
    vaultBalance: balance,
    reserved,
    free: balance - reserved,
  }
}
