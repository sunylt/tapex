<script setup lang="ts">
import { computed, onMounted, onUnmounted } from 'vue'
import { storeToRefs } from 'pinia'

import MinerCard from '@/components/MinerCard.vue'
import { POD_CONFIG } from '@/pod/config'
import { formatToken, hasInjectedWallet, shortAddress } from '@/pod/service'
import { useMiningStore } from '@/stores/mining'

const store = useMiningStore()
const {
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
} = storeToRefs(store)

const walletAvailable = hasInjectedWallet()
const tokenSymbol = POD_CONFIG.tokenSymbol

const updatedText = computed(() =>
  lastUpdated.value ? new Date(lastUpdated.value).toLocaleTimeString() : '—',
)

const scanText = computed(() => {
  const p = scanProgress.value
  if (!p || p.total === 0) return '正在扫描链上历史…'
  return `正在扫描链上历史… ${p.done}/${p.total}`
})

onMounted(() => void store.init())
onUnmounted(() => store.teardown())
</script>

<template>
  <main class="pod">
    <header class="pod__head">
      <div>
        <h1>PoD 挖矿</h1>
        <p class="sub">
          Proof of Design · 链 <span class="mono">{{ chainId ?? POD_CONFIG.chainId }}</span>
          <a :href="POD_CONFIG.explorer" target="_blank" rel="noopener" class="mono">
            {{ shortAddress(POD_CONFIG.contracts.mining) }}
          </a>
        </p>
      </div>

      <div class="pod__actions">
        <template v-if="connected">
          <span class="addr mono" :title="address ?? ''">{{ shortAddress(address ?? '') }}</span>
          <button :disabled="loading" @click="store.refresh()">
            {{ loading ? '刷新中…' : '刷新' }}
          </button>
          <button class="ghost" :disabled="loading || scanning" @click="store.rescan()">
            重新扫描
          </button>
          <button class="ghost" @click="store.disconnect()">断开</button>
        </template>
        <template v-else>
          <button :disabled="connecting || !walletAvailable" @click="store.connect()">
            {{ connecting ? '连接中…' : '连接钱包' }}
          </button>
        </template>
      </div>
    </header>

    <p v-if="!walletAvailable" class="warn">未检测到浏览器钱包（window.ethereum），请安装 MetaMask。</p>
    <p v-else-if="connected && !onCorrectChain" class="warn">
      当前网络不是 BNB Smart Chain（56）。
      <button class="ghost" @click="store.switchToBsc()">切换到 BSC</button>
    </p>
    <p v-if="error" class="error">{{ error }}</p>

    <section v-if="stats" class="stats">
      <div class="stat">
        <span class="stat__label">全网质押权重</span>
        <span class="stat__value">{{ stats.totalVerifWeight.toLocaleString('en-US') }}</span>
      </div>
      <div class="stat">
        <span class="stat__label">矿机总数</span>
        <span class="stat__value">
          {{ stats.verifMinerCount.toLocaleString('en-US') }} / {{ stats.minerCount.toLocaleString('en-US') }}
        </span>
      </div>
      <div class="stat">
        <span class="stat__label">已挖总量</span>
        <span class="stat__value">{{ formatToken(stats.totalMined, 0) }} {{ tokenSymbol }}</span>
      </div>
      <div class="stat">
        <span class="stat__label">当前速率</span>
        <span class="stat__value">{{ formatToken(stats.currentRate, 8) }}<small>/s</small></span>
      </div>
      <div class="stat">
        <span class="stat__label">任务数</span>
        <span class="stat__value">{{ stats.taskCount }}</span>
      </div>
      <div class="stat">
        <span class="stat__label">区块</span>
        <span class="stat__value mono">{{ stats.block }}</span>
      </div>
    </section>

    <section v-if="connected" class="machines">
      <div class="machines__bar">
        <h2>
          我的矿机
          <small v-if="scanning">{{ scanText }}</small>
          <small v-else-if="source === 'onchain'">（链上扫描）</small>
        </h2>
        <span class="counts">
          挖矿中 <b>{{ activeCount }}</b> / 共 <b>{{ miners.length }}</b>
          · 待领 <b>{{ formatToken(totalLive) }} {{ tokenSymbol }}</b>
          · 更新于 {{ updatedText }}
        </span>
      </div>

      <p v-if="miners.length === 0" class="empty">
        {{ scanning ? scanText : loading ? '读取中…' : '该钱包没有矿机，或尚未拥有任何 CPU 电路。' }}
      </p>
      <div v-else class="grid">
        <MinerCard v-for="m in miners" :key="m.key" :miner="m" :symbol="tokenSymbol" />
      </div>
    </section>

    <p v-else class="empty">连接钱包后查看你的矿机与挖矿状态。</p>
  </main>
</template>

<style scoped>
.pod {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 8px 0 48px;
}
.pod__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
h1 {
  font-size: 24px;
  margin: 0 0 4px;
  color: var(--color-heading);
}
.sub {
  margin: 0;
  font-size: 13px;
  opacity: 0.7;
  display: flex;
  gap: 10px;
  align-items: center;
}
.pod__actions {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
.addr {
  padding: 4px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  font-size: 13px;
}
button {
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 8px;
  padding: 8px 14px;
  font-size: 14px;
  color: #fff;
  background: hsla(160, 100%, 37%, 1);
  transition: opacity 0.2s;
}
button.ghost {
  background: transparent;
  color: var(--color-text);
  border-color: var(--color-border);
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.warn,
.error {
  margin: 0;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 14px;
}
.warn {
  background: hsla(45, 100%, 50%, 0.15);
}
.error {
  background: hsla(0, 80%, 50%, 0.15);
  color: hsla(0, 80%, 40%, 1);
}
.stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
}
.stat {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 12px 14px;
  background: var(--color-background-soft);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.stat__label {
  font-size: 12px;
  opacity: 0.65;
}
.stat__value {
  font-size: 18px;
  font-weight: 700;
  color: var(--color-heading);
  font-variant-numeric: tabular-nums;
}
.stat__value small {
  font-size: 12px;
  font-weight: 400;
  opacity: 0.6;
}
.machines__bar {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
h2 {
  font-size: 18px;
  margin: 0;
  color: var(--color-heading);
}
h2 small {
  font-size: 12px;
  font-weight: 400;
  opacity: 0.55;
}
.counts {
  font-size: 13px;
  opacity: 0.75;
}
.counts b {
  color: var(--color-heading);
}
.grid {
  margin-top: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 14px;
}
.empty {
  margin: 12px 0 0;
  opacity: 0.7;
  font-size: 14px;
}
</style>
