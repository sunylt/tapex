import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { POD_CONFIG, STAKING_ENABLED } from '@/pod/config'
import {
  fetchMinerRefs,
  getReadProvider,
  hasInjectedWallet,
  readAccounts,
  readChainId,
  readMinerStatus,
  readNetworkStats,
  requestAccounts,
  switchChain,
  watchWallet,
} from '@/pod/service'
import { readDecomposerOwner, readEarned, readEquity } from '@/pod/tx'
import type { EquityToken, MinerRef, MinerStatus, NetworkStats } from '@/pod/types'

const POLL_MS = 20_000
const REFS_CACHE_PREFIX = 'pod:refs:'

function cacheKey(chainId: number, address: string, rpc: string): string {
  return `${REFS_CACHE_PREFIX}${chainId}:${rpc}:${address.toLowerCase()}`
}

function loadCachedRefs(chainId: number, address: string, rpc: string): MinerRef[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(chainId, address, rpc))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as MinerRef[]) : null
  } catch {
    return null
  }
}

function saveCachedRefs(chainId: number, address: string, rpc: string, refs: MinerRef[]): void {
  try {
    localStorage.setItem(cacheKey(chainId, address, rpc), JSON.stringify(refs))
  } catch {
    /* storage unavailable — scan result stays in memory only */
  }
}

export const useMiningStore = defineStore('mining', () => {
  const address = ref<string | null>(null)
  const chainId = ref<number | null>(null)
  const connecting = ref(false)
  const loading = ref(false)
  const scanning = ref(false)
  const scanProgress = ref<{ done: number; total: number } | null>(null)
  const error = ref<string | null>(null)
  const miners = ref<MinerStatus[]>([])
  const stats = ref<NetworkStats | null>(null)
  const source = ref<'onchain' | null>(null)
  const lastUpdated = ref<number | null>(null)

  /* xNAND / xLATCH 权益与待领收益（链上真实值，见 pod/tx.ts） */
  const equity = ref<EquityToken[]>([])
  const earned = ref<bigint>(0n)
  const poolOwner = ref<string | null>(null)
  const equityLoaded = ref(false)

  // Machine refs are resolved by an (expensive) historical log scan. Cache them
  // per address so the 20s status poll only re-reads cheap on-chain state.
  let refs: MinerRef[] = []
  let refsLoadedFor: string | null = null
  let timer: ReturnType<typeof setInterval> | null = null
  let stopWatch: (() => void) | null = null
  let inflight = false

  const connected = computed(() => !!address.value)
  const onCorrectChain = computed(() => chainId.value === POD_CONFIG.chainId)
  const activeCount = computed(() => miners.value.filter((m) => m.active).length)
  const totalLive = computed(() => miners.value.reduce((sum, m) => sum + m.live, 0n))
  /** 拆解金库 owner：只有它能发放收益 */
  const isPoolOwner = computed(
    () =>
      STAKING_ENABLED &&
      !!address.value &&
      !!poolOwner.value &&
      address.value.toLowerCase() === poolOwner.value.toLowerCase(),
  )

  function resetRefs() {
    refs = []
    refsLoadedFor = null
  }

  async function syncFromWallet() {
    if (!hasInjectedWallet()) return
    chainId.value = await readChainId()
    const accounts = await readAccounts()
    address.value = accounts[0] ?? null
  }

  /** Resolve (and cache) the machine list for the current address. */
  async function resolveRefs(force: boolean) {
    if (!address.value) return
    const current = address.value
    if (!force && refsLoadedFor === current) return

    const net = chainId.value ?? POD_CONFIG.chainId
    if (!force) {
      const cached = loadCachedRefs(net, current, POD_CONFIG.rpc)
      if (cached) {
        refs = cached
        refsLoadedFor = current
        return
      }
    }

    scanning.value = true
    scanProgress.value = null
    try {
      const { list } = await fetchMinerRefs(current, {
        onProgress: (done, total) => {
          scanProgress.value = { done, total }
        },
      })
      refs = list
      refsLoadedFor = current
      saveCachedRefs(net, current, POD_CONFIG.rpc, list)
    } finally {
      scanning.value = false
      scanProgress.value = null
    }
  }

  /** 读 xNAND / xLATCH 权益、待领收益与金库 owner（单步失败不拖垮整页刷新）。 */
  async function loadStakeState(owner: string) {
    if (!STAKING_ENABLED) return
    const [equityResult, earnedResult, ownerResult] = await Promise.allSettled([
      readEquity(owner),
      readEarned(owner),
      readDecomposerOwner(),
    ])
    if (equityResult.status === 'fulfilled') {
      equity.value = equityResult.value
      equityLoaded.value = true
    }
    if (earnedResult.status === 'fulfilled') earned.value = earnedResult.value
    if (ownerResult.status === 'fulfilled') poolOwner.value = ownerResult.value
  }

  /** Load machines + mining status for the current address. */
  async function refresh(options: { rescan?: boolean } = {}) {
    if (!address.value || inflight) return
    inflight = true
    loading.value = true
    error.value = null
    try {
      getReadProvider()
      await resolveRefs(!!options.rescan)
      const current = refs
      const owner = address.value
      const [statuses, network] = await Promise.all([
        Promise.all(current.map((ref) => readMinerStatus(ref))),
        readNetworkStats().catch(() => null),
        loadStakeState(owner),
      ])
      miners.value = statuses.sort(
        (a, b) => Number(b.active) - Number(a.active) || a.ref.circuitId - b.ref.circuitId,
      )
      if (network) stats.value = network
      source.value = 'onchain'
      lastUpdated.value = Date.now()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      loading.value = false
      inflight = false
    }
  }

  /** Force a fresh on-chain scan (e.g. after minting a new machine). */
  function rescan(): Promise<void> {
    return refresh({ rescan: true })
  }

  async function handleWalletChange() {
    try {
      const previous = address.value
      await syncFromWallet()
      if (address.value !== previous) resetRefs()
      if (address.value) {
        await refresh()
        startPolling()
      } else {
        stopPolling()
        miners.value = []
        stats.value = null
        source.value = null
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  /** Explicit connect (popup) + chain switch. */
  async function connect() {
    if (!hasInjectedWallet()) {
      error.value = '未检测到浏览器钱包，请安装 MetaMask 等扩展'
      return
    }
    connecting.value = true
    error.value = null
    try {
      const accounts = await requestAccounts()
      address.value = accounts[0] ?? null
      chainId.value = await readChainId()
      if (chainId.value !== POD_CONFIG.chainId) {
        try {
          await switchChain(POD_CONFIG.chainId)
          chainId.value = await readChainId()
        } catch {
          /* user rejected the switch */
        }
      }
      await refresh()
      startPolling()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    } finally {
      connecting.value = false
    }
  }

  async function switchToBsc() {
    try {
      await switchChain(POD_CONFIG.chainId)
      chainId.value = await readChainId()
      await refresh()
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  function disconnect() {
    stopPolling()
    address.value = null
    resetRefs()
    miners.value = []
    stats.value = null
    source.value = null
    error.value = null
    equity.value = []
    earned.value = 0n
    poolOwner.value = null
    equityLoaded.value = false
  }

  function startPolling() {
    if (timer) return
    timer = setInterval(() => void refresh(), POLL_MS)
  }

  function stopPolling() {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  }

  /** Call once (e.g. on mount): silent account read + wallet event listeners. */
  async function init() {
    if (!stopWatch) stopWatch = watchWallet(() => void handleWalletChange())
    await handleWalletChange()
  }

  function teardown() {
    stopPolling()
    stopWatch?.()
    stopWatch = null
  }

  return {
    address,
    chainId,
    connecting,
    loading,
    scanning,
    scanProgress,
    error,
    miners,
    stats,
    source,
    lastUpdated,
    equity,
    earned,
    poolOwner,
    equityLoaded,
    connected,
    onCorrectChain,
    activeCount,
    totalLive,
    isPoolOwner,
    connect,
    switchToBsc,
    disconnect,
    refresh,
    rescan,
    init,
    teardown,
  }
})
