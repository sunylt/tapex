import {
  BrowserProvider,
  Contract,
  FetchRequest,
  JsonRpcProvider,
  formatUnits,
  getAddress,
  type Provider,
} from 'ethers'

import { CIRCUIT_ABI, LENS_ABI, MINING_ABI, TOKEN_ABI, TRANSFER_TOPIC } from './abis'
import { POD_CONFIG } from './config'
import type { MinerPreview, MinerRef, MinerStatus, NetworkStats } from './types'

let readProvider: JsonRpcProvider | null = null

/**
 * Shared read-only JSON-RPC provider.
 *
 * tapeout.net/rpc answers cross-origin POSTs (returns `Access-Control-Allow-Origin: *`)
 * but rejects the CORS preflight (`OPTIONS` -> 403). Since ethers otherwise sends
 * `Content-Type: application/json` (which is not a CORS-safelisted value and thus
 * triggers a preflight), we force a *simple* `text/plain` content-type so the
 * browser sends the request directly. JSON-RPC servers parse the body regardless
 * of the declared content-type.
 */
function createReadProvider(): JsonRpcProvider {
  const request = new FetchRequest(POD_CONFIG.rpc)
  request.preflightFunc = async (req) => {
    req.setHeader('content-type', 'text/plain;charset=UTF-8')
    return req
  }
  return new JsonRpcProvider(request, POD_CONFIG.chainId, { staticNetwork: true })
}

export function getReadProvider(): JsonRpcProvider {
  if (!readProvider) readProvider = createReadProvider()
  return readProvider
}

/**
 * ethers v6 types methods on a dynamic-ABI `Contract` as possibly undefined
 * and `noUncheckedIndexedAccess` makes index access even stricter, so we keep
 * these dynamic view calls loosely typed.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function contractAt(address: string, abi: readonly string[]): any {
  return new Contract(address, abi, getReadProvider())
}

/* ------------------------------------------------------------------ */
/* Wallet (window.ethereum / EIP-1193)                                 */
/* ------------------------------------------------------------------ */

export function hasInjectedWallet(): boolean {
  return typeof window !== 'undefined' && !!window.ethereum
}

function browserProvider(): BrowserProvider {
  if (!hasInjectedWallet()) throw new Error('未检测到浏览器钱包（window.ethereum）')
  return new BrowserProvider(window.ethereum!)
}

/** Silently read already-authorized accounts (no popup). */
export async function readAccounts(): Promise<string[]> {
  const accounts = (await browserProvider().send('eth_accounts', [])) as string[]
  return accounts.map((a) => getAddress(a))
}

/** Prompt the user to connect (popup). */
export async function requestAccounts(): Promise<string[]> {
  const accounts = (await browserProvider().send('eth_requestAccounts', [])) as string[]
  return accounts.map((a) => getAddress(a))
}

export async function readChainId(): Promise<number> {
  const net = await browserProvider().getNetwork()
  return Number(net.chainId)
}

export async function switchChain(chainId = POD_CONFIG.chainId): Promise<void> {
  if (!window.ethereum) throw new Error('未检测到浏览器钱包')
  await window.ethereum.request({
    method: 'wallet_switchEthereumChain',
    params: [{ chainId: '0x' + chainId.toString(16) }],
  })
}

export function watchWallet(handler: () => void): () => void {
  if (!window.ethereum?.on) return () => {}
  const events = ['accountsChanged', 'chainChanged']
  for (const e of events) window.ethereum.on(e, handler)
  return () => {
    for (const e of events) window.ethereum?.removeListener?.(e, handler)
  }
}

/* ------------------------------------------------------------------ */
/* Machine list ("矿机") — on-chain Transfer log scan                   */
/* ------------------------------------------------------------------ */

/** Max concurrent `eth_getLogs` requests against the RPC during a scan.
 *  tapeout.net/rpc tolerates this well (233 chunks in ~6s, 0 errors); 64 was
 *  slower, so this is the measured sweet spot. */
const SCAN_CONCURRENCY = 32

export interface MinerListResult {
  list: MinerRef[]
  source: 'onchain'
}

export interface ScanOptions {
  /** Called after each scanned chunk (`done` / `total`) for one address. */
  onProgress?: (done: number, total: number) => void
  signal?: AbortSignal
}

function padTopic(address: string): string {
  return '0x' + address.toLowerCase().replace(/^0x/, '').padStart(64, '0')
}

/** Run `fn` over `items` with a bounded number of concurrent promises. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await fn(items[index]!)
    }
  }
  const workers = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

/**
 * Resolve the machines owned by an address by scanning the CPU registries for
 * `Transfer(_, to, _)` logs (one log query per block chunk, per CPU contract),
 * then verifying current ownership with `ownerOf`.
 */
export async function fetchMinerRefs(
  address: string,
  opts: ScanOptions = {},
): Promise<MinerListResult> {
  const list = await scanMinerRefsOnChain(address, opts)
  return { list, source: 'onchain' }
}

/** On-chain ERC-721 Transfer-log scan across configured CPU registries. */
export async function scanMinerRefsOnChain(
  address: string,
  opts: ScanOptions = {},
): Promise<MinerRef[]> {
  const provider = getReadProvider()
  const addr = getAddress(address)
  const latest = await provider.getBlockNumber()
  const topicTo = padTopic(addr)
  const span = POD_CONFIG.logChunk
  const found: MinerRef[] = []

  for (const [name, cpu] of Object.entries(POD_CONFIG.cpus)) {
    if (!cpu.address || cpu.multiplier === 0) continue
    const circuit = contractAt(cpu.address, CIRCUIT_ABI)
    const balance = (await circuit.balanceOf(addr).catch(() => 0n)) as bigint
    if (balance === 0n) continue

    const ranges: Array<{ from: number; to: number }> = []
    for (let from = cpu.fromBlock; from <= latest; from += span) {
      ranges.push({ from, to: Math.min(from + span - 1, latest) })
    }

    let done = 0
    const chunkLogs = await mapLimit(ranges, SCAN_CONCURRENCY, async (r) => {
      if (opts.signal?.aborted) return []
      try {
        return await provider.getLogs({
          address: cpu.address,
          fromBlock: r.from,
          toBlock: r.to,
          topics: [TRANSFER_TOPIC, null, topicTo],
        })
      } finally {
        done += 1
        opts.onProgress?.(done, ranges.length)
      }
    })

    const ids = new Set<string>()
    for (const logs of chunkLogs) {
      for (const log of logs) if (log.topics[3]) ids.add(BigInt(log.topics[3]!).toString())
    }

    for (const id of ids) {
      const owner = (await circuit.ownerOf(id).catch(() => '')) as string
      if (owner.toLowerCase() !== addr.toLowerCase()) continue
      found.push({ owner: addr, cpu: name, circuits: cpu.address, circuitId: Number(id), taskId: 0 })
    }
  }
  return found
}

/* ------------------------------------------------------------------ */
/* Mining status ("挖矿状态")                                           */
/* ------------------------------------------------------------------ */

/** Read the on-chain mining status for a single machine. */
export async function readMinerStatus(ref: MinerRef): Promise<MinerStatus> {
  const mining = contractAt(POD_CONFIG.contracts.mining, MINING_ABI)
  const lens = contractAt(POD_CONFIG.contracts.lens, LENS_ABI)

  const key = (await mining.minerKey(ref.circuits, ref.circuitId)) as string
  const m = await mining.getMiner(key)

  const status = Number(m.status)
  const active = status === 1
  // Prefer the on-chain task id (retained even when idle) for `previewScore`,
  // falling back to the indexed value if any.
  const taskId = Number(m.taskId) || ref.taskId || 0

  const live = active ? ((await lens.pendingLive(key)) as bigint) : 0n

  let preview: MinerPreview | null = null
  if (!active) {
    try {
      const p = await lens.previewScore(ref.circuits, ref.circuitId, taskId)
      preview = {
        verifWeight: p.verifWeight,
        unverWeight: p.unverWeight,
        h: p.h,
        bstar: p.bstar,
        bonus: p.bonus,
        optimal: Boolean(p.optimal),
        samples: Number(p.samples),
        reason: String(p.reason ?? ''),
      }
    } catch {
      preview = null
    }
  }

  return {
    ref,
    key,
    active,
    status,
    taskId,
    gateCount: Number(m.gateCount),
    stateCount: Number(m.stateCount),
    depth: Number(m.depth),
    area: m.area as bigint,
    mult: Number(m.mult),
    nandBurn: Number(m.nandBurn),
    latchBurn: Number(m.latchBurn),
    bstar: m.bstar as bigint,
    bonus: m.bonus as bigint,
    optimal: Boolean(m.optimal),
    verifWeight: m.verifWeight as bigint,
    unverWeight: m.unverWeight as bigint,
    since: m.since as bigint,
    debt: m.debt as bigint,
    live,
    preview,
  }
}

/* ------------------------------------------------------------------ */
/* Network-wide stats                                                   */
/* ------------------------------------------------------------------ */

export async function readNetworkStats(): Promise<NetworkStats> {
  const provider = getReadProvider()
  const mining = contractAt(POD_CONFIG.contracts.mining, MINING_ABI)

  const block = await provider.getBlockNumber()
  const [
    totalVerifWeight,
    totalUnverWeight,
    currentRate,
    minerCount,
    verifMinerCount,
    unverifiedBps,
    totalForgone,
    totalMined,
    taskCount,
    startTime,
    owner,
  ] = await Promise.all([
    mining.totalVerifWeight(),
    mining.totalUnverWeight(),
    mining.currentRate(),
    mining.minerCount(),
    mining.verifMinerCount(),
    mining.UNVERIFIED_BPS(),
    mining.totalForgone(),
    mining.totalMined(),
    mining.taskCount(),
    mining.startTime(),
    mining.owner(),
  ])

  return {
    block,
    totalVerifWeight: totalVerifWeight as bigint,
    totalUnverWeight: totalUnverWeight as bigint,
    currentRate: currentRate as bigint,
    minerCount: Number(minerCount),
    verifMinerCount: Number(verifMinerCount),
    unverifiedBps: Number(unverifiedBps),
    totalForgone: totalForgone as bigint,
    totalMined: totalMined as bigint,
    taskCount: Number(taskCount),
    startTime: Number(startTime),
    owner: owner as string,
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

export function formatToken(value: bigint, maxFrac = 8): string {
  const decimals = formatUnits(value, POD_CONFIG.tokenDecimals)
  const n = Number(decimals)
  if (!Number.isFinite(n)) return decimals
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac })
}

export function shortAddress(address: string, size = 4): string {
  if (!address) return ''
  return `${address.slice(0, 2 + size)}…${address.slice(-size)}`
}

export type { Provider }
