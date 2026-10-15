import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

import { POD_CONFIG } from '@/pod/config'
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
import type { MinerRef, MinerStatus, NetworkStats } from '@/pod/types'

const POLL_MS = 20_000
const REFS_CACHE_PREFIX = 'pod:refs:'

function cacheKey(chainId: number, address: string): string {
  return `${REFS_CACHE_PREFIX}${chainId}:${address.toLowerCase()}`
}

function loadCachedRefs(chainId: number, address: string): MinerRef[] | null {
  try {
    const raw = localStorage.getItem(cacheKey(chainId, address))
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as MinerRef[]) : null
  } catch {
    return null
  }
}

function saveCachedRefs(chainId: number, address: string, refs: MinerRef[]): void {
  try {
    localStorage.setItem(cacheKey(chainId, address), JSON.stringify(refs))
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
      const cached = loadCachedRefs(net, current)
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
      saveCachedRefs(net, current, list)
    } finally {
      scanning.value = false
      scanProgress.value = null
    }
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
      const [statuses, network] = await Promise.all([
        Promise.all(current.map((ref) => readMinerStatus(ref))),
        readNetworkStats().catch(() => null),
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
    connected,
    onCorrectChain,
    activeCount,
    totalLive,
    connect,
    switchToBsc,
    disconnect,
    refresh,
    rescan,
    init,
    teardown,
  }
})
