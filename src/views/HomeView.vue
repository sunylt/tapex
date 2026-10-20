<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'

import { POD_CONFIG, STAKING_ENABLED } from '@/pod/config'
import { formatToken, readNetworkStats, shortAddress } from '@/pod/service'
import {
  describeError,
  readPoolStakes,
  readVaultStats,
  redeemMiner,
  type VaultStats,
} from '@/pod/tx'
import type { NetworkStats, PoolStake } from '@/pod/types'
import { useMiningStore } from '@/stores/mining'

/* 全部数据来自链上：
 *  在押矿机 = MinerDecomposer.stakedAt(index) + 每台的挖矿状态；
 *  全网统计 = IMining.totalVerifWeight / dailyEmission / totalMined…；
 *  金库与质押 = XTokenStaking.totalStaked + 金库 BEM 余额。 */
const store = useMiningStore()
const { connected, address, onCorrectChain } = storeToRefs(store)

const stakes = ref<PoolStake[]>([])
const network = ref<NetworkStats | null>(null)
const vault = ref<VaultStats | null>(null)
const loadingPool = ref(false)
const poolError = ref<string | null>(null)
const loadedAt = ref<number | null>(null)

async function loadPool() {
  if (loadingPool.value) return
  loadingPool.value = true
  poolError.value = null
  try {
    const [list, net, vaultStats] = await Promise.all([
      readPoolStakes(),
      readNetworkStats(),
      readVaultStats(),
    ])
    stakes.value = list
    network.value = net
    vault.value = vaultStats
    loadedAt.value = Date.now()
  } catch (err) {
    poolError.value = describeError(err)
  } finally {
    loadingPool.value = false
  }
}

/* ---------------- 格式化 ---------------- */

const symbol = POD_CONFIG.tokenSymbol

const fmtBig = (n: bigint) => n.toLocaleString('en-US')
const fmtPct = (r: number, frac = 2) => `${(r * 100).toFixed(frac)}%`
const fmtArea = (n: number) =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(2)}M`
    : n >= 1_000
      ? `${(n / 1_000).toFixed(0)}K`
      : String(n)

const updatedText = computed(() =>
  loadedAt.value ? new Date(loadedAt.value).toLocaleTimeString() : '—',
)

/* ---------------- 汇总指标 ---------------- */

/** 算力 = 链上 verifWeight + unverWeight（同量级，可直接相加）。 */
const weightOf = (s: PoolStake): bigint =>
  s.status ? s.status.verifWeight + s.status.unverWeight : 0n

const networkWeight = computed(() =>
  network.value ? network.value.totalVerifWeight + network.value.totalUnverWeight : 0n,
)
const poolWeight = computed(() => stakes.value.reduce((sum, s) => sum + weightOf(s), 0n))
const share = computed(() => {
  const net = networkWeight.value
  return net === 0n ? 0 : Number(poolWeight.value) / Number(net)
})

/** 矿池预计日收益 = 全网日产出 × 矿池算力占比（bigint 精确计算）。 */
const poolDaily = computed(() => {
  const net = networkWeight.value
  if (net === 0n || !network.value) return 0n
  return (network.value.dailyEmission * poolWeight.value) / net
})

const miningCount = computed(() => stakes.value.filter((s) => s.status?.active).length)
const idleCount = computed(() => stakes.value.length - miningCount.value)

/** 矿池在押矿机待领收益之和（金库视角）。 */
const poolPending = computed(() =>
  stakes.value.reduce((sum, s) => sum + (s.status?.live ?? 0n), 0n),
)

const topWeight = computed(() => {
  let max = 1n
  for (const s of stakes.value) if (weightOf(s) > max) max = weightOf(s)
  return max
})

/** 单台预计 24h 产出 = 矿池日收益 × 该台算力 / 矿池算力；空闲不产币。 */
function output24h(s: PoolStake): bigint {
  if (!s.status?.active || poolWeight.value === 0n) return 0n
  return (poolDaily.value * weightOf(s)) / poolWeight.value
}

const STATUS_LABEL: Record<'mining' | 'idle', string> = {
  mining: '挖矿中',
  idle: '空闲',
}
type RowStatus = keyof typeof STATUS_LABEL

function statusOf(s: PoolStake): RowStatus {
  return s.status?.active ? 'mining' : 'idle'
}

/* ---------------- 状态 / 筛选 / 分页 ---------------- */

const filters = [
  { key: 'all', label: '全部' },
  { key: 'mining', label: '挖矿中' },
  { key: 'idle', label: '空闲' },
] as const

type FilterKey = (typeof filters)[number]['key']

const filter = ref<FilterKey>('all')

const counts = computed<Record<FilterKey, number>>(() => ({
  all: stakes.value.length,
  mining: miningCount.value,
  idle: idleCount.value,
}))

const filtered = computed(() =>
  filter.value === 'all' ? stakes.value : stakes.value.filter((s) => statusOf(s) === filter.value),
)

const pageSize = ref(10)
const page = ref(1)

const pageCount = computed(() => Math.max(1, Math.ceil(filtered.value.length / pageSize.value)))

const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

const rangeStart = computed(() =>
  filtered.value.length === 0 ? 0 : (page.value - 1) * pageSize.value + 1,
)
const rangeEnd = computed(() => Math.min(page.value * pageSize.value, filtered.value.length))

/** 页码按钮（超过 7 页时折叠成 1 … n-1 n n+1 … last）。 */
const pageItems = computed<(number | 'gap')[]>(() => {
  const total = pageCount.value
  const current = page.value
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1)

  const items: (number | 'gap')[] = [1]
  const from = Math.max(2, current - 1)
  const to = Math.min(total - 1, current + 1)
  if (from > 2) items.push('gap')
  for (let i = from; i <= to; i += 1) items.push(i)
  if (to < total - 1) items.push('gap')
  items.push(total)
  return items
})

function goPage(next: number) {
  page.value = Math.min(Math.max(1, next), pageCount.value)
}

watch([filter, pageSize], () => {
  page.value = 1
})
watch(pageCount, (total) => {
  if (page.value > total) page.value = total
})

const nftUrl = (s: PoolStake) => `${POD_CONFIG.explorer}/nft/${s.cpu}/${s.id}`

/** 算力构成（按 CPU 型号分组） */
const cpuSlices = computed(() => {
  const groups = new Map<string, { name: string; miners: number; weight: bigint }>()
  for (const s of stakes.value) {
    const g = groups.get(s.cpuName) ?? { name: s.cpuName, miners: 0, weight: 0n }
    g.miners += 1
    g.weight += weightOf(s)
    groups.set(s.cpuName, g)
  }
  return [...groups.values()].sort((a, b) => (b.weight > a.weight ? 1 : -1))
})

const toneOf = (name: string) => {
  const lower = name.toLowerCase()
  if (lower.includes('behemoth')) return 'behemoth'
  if (lower.includes('tapeout')) return 'tapeout'
  return 'refbench'
}

/* ---------------- 赎回（真实交易） ---------------- */

const redeemTarget = ref<PoolStake | null>(null)
const redeemBusy = ref(false)
const toast = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function flash(message: string) {
  toast.value = message
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), 6000)
}

/** 赎回 = 烧掉价格数量的 xNAND / xLATCH，NFT 回到存款人钱包。 */
const isMine = (s: PoolStake) =>
  !!address.value && s.depositor.toLowerCase() === address.value.toLowerCase()

function openRedeem(s: PoolStake) {
  if (!isMine(s)) return
  redeemTarget.value = s
}

function closeRedeem() {
  redeemTarget.value = null
}

async function confirmRedeem() {
  const s = redeemTarget.value
  if (!s) return
  redeemTarget.value = null

  if (!connected.value) {
    flash('请先连接钱包')
    return
  }
  if (!onCorrectChain.value) {
    flash('请先切换到 BNB Smart Chain（56）')
    return
  }
  if (redeemBusy.value) return

  redeemBusy.value = true
  try {
    const hash = await redeemMiner(s.cpu, s.id, s.nandAmount, s.latchAmount)
    flash(`已赎回 ${s.cpuName} #${s.id}（${shortAddress(hash, 6)}）`)
    await loadPool()
    void store.refresh()
  } catch (err) {
    flash(describeError(err))
  } finally {
    redeemBusy.value = false
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && redeemTarget.value) closeRedeem()
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown)
  if (STAKING_ENABLED) void loadPool()
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (toastTimer) clearTimeout(toastTimer)
})
</script>

<template>
  <main class="pool">
    <!-- 页头 ---------------------------------------------------------- -->
    <header class="pool__head">
      <h1 class="title">
        TAPEX 矿池
        <span class="pill pill--live"><i class="pulse" />运行中</span>
        <a
          v-if="POD_CONFIG.contracts.decomposer"
          class="tag-mock mono"
          :href="`${POD_CONFIG.explorer}/address/${POD_CONFIG.contracts.decomposer}`"
          target="_blank"
          rel="noopener"
        >
          拆解金库 {{ shortAddress(POD_CONFIG.contracts.decomposer) }}
        </a>
      </h1>
      <p class="sub">
        全网 PoD 算力池 · 结算币种 <b>{{ symbol }}</b> · 链上数据更新于
        <span class="mono">{{ updatedText }}</span>
        <button class="refresh" type="button" :disabled="loadingPool" @click="loadPool()">
          {{ loadingPool ? '读取中…' : '刷新' }}
        </button>
      </p>
    </header>

    <p v-if="!STAKING_ENABLED" class="warn">
      未配置矿池合约地址（VITE_POD_DECOMPOSER 等），无法读取在押矿机。
    </p>
    <p v-else-if="poolError" class="error">读取失败：{{ poolError }}</p>
    <p v-else-if="loadingPool && stakes.length === 0" class="empty">正在读取链上矿池数据…</p>

    <!-- 核心指标 ------------------------------------------------------ -->
    <section class="cards">
      <article class="card">
        <span class="card__label">全网算力</span>
        <span class="card__value mono">{{ fmtBig(networkWeight) }}</span>
        <span class="card__sub">全网 {{ network?.minerCount ?? '—' }} 台矿机</span>
      </article>

      <article class="card card--accent">
        <span class="card__label">矿池算力（在押）</span>
        <span class="card__value mono">{{ fmtBig(poolWeight) }}</span>
        <span class="card__sub">
          占全网 <b class="pos">{{ fmtPct(share) }}</b>
        </span>
        <div class="bar bar--accent"><i :style="{ width: fmtPct(share, 1) }" /></div>
      </article>

      <article class="card">
        <span class="card__label">预计日收益</span>
        <span class="card__value mono">
          {{ formatToken(poolDaily) }} <small>{{ symbol }}</small>
        </span>
        <span class="card__sub">
          全网日产 {{ network ? formatToken(network.dailyEmission, 0) : '—' }} {{ symbol }}
        </span>
      </article>

      <article class="card">
        <span class="card__label">矿池待领收益</span>
        <span class="card__value mono">
          {{ formatToken(poolPending) }} <small>{{ symbol }}</small>
        </span>
        <span class="card__sub">在押 {{ stakes.length }} 台 · 挖矿中 {{ miningCount }}</span>
      </article>
    </section>

    <!-- 次级指标 ------------------------------------------------------ -->
    <section class="strip">
      <div class="strip__item">
        <span class="strip__label">在押矿机</span>
        <b class="mono">{{ stakes.length }}</b>
      </div>
      <div class="strip__item">
        <span class="strip__label"><i class="dot dot--mining" />挖矿中</span>
        <b class="mono">{{ miningCount }}</b>
      </div>
      <div class="strip__item">
        <span class="strip__label"><i class="dot dot--idle" />空闲</span>
        <b class="mono">{{ idleCount }}</b>
      </div>
      <div class="strip__item">
        <span class="strip__label">xNAND 抵押总量</span>
        <b class="mono">{{ vault ? vault.nandStaked.toLocaleString('en-US') : '—' }}</b>
      </div>
      <div class="strip__item">
        <span class="strip__label">xLATCH 抵押总量</span>
        <b class="mono">{{ vault ? vault.latchStaked.toLocaleString('en-US') : '—' }}</b>
      </div>
      <div class="strip__item">
        <span class="strip__label">全网累计产出</span>
        <b class="mono"
          >{{ network ? formatToken(network.totalMined, 0) : '—' }} {{ symbol }}</b
        >
      </div>
    </section>

    <!-- 构成 / 金库 ---------------------------------------------------- -->
    <section class="panels">
      <article class="panel">
        <h2>算力构成</h2>
        <div v-if="cpuSlices.length" class="segbar">
          <i
            v-for="s in cpuSlices"
            :key="s.name"
            :class="`tone-${toneOf(s.name)}`"
            :style="{
              width: fmtPct(
                poolWeight === 0n ? 0 : Number(s.weight) / Number(poolWeight),
                2,
              ),
            }"
            :title="`${s.name} ${fmtBig(s.weight)}`"
          />
        </div>
        <ul class="legend">
          <li v-for="s in cpuSlices" :key="s.name">
            <i class="swatch" :class="`tone-${toneOf(s.name)}`" />
            <span class="legend__name">{{ s.name }}</span>
            <span class="legend__miners">{{ s.miners }} 台</span>
            <b class="mono">{{ fmtBig(s.weight) }}</b>
            <span class="legend__pct mono">{{
              fmtPct(poolWeight === 0n ? 0 : Number(s.weight) / Number(poolWeight))
            }}</span>
          </li>
        </ul>
        <p v-if="cpuSlices.length === 0" class="panel__empty">矿池里还没有在押矿机。</p>
        <p class="panel__foot">
          合计 <b>{{ fmtBig(poolWeight) }}</b> · {{ cpuSlices.length }} 种 CPU 型号
        </p>
      </article>

      <article class="panel">
        <h2>金库与质押池</h2>
        <ul class="statuslist">
          <li>
            <span class="statuslist__label">在押矿机</span>
            <b class="mono">{{ vault ? vault.stakedCount : '—' }}</b>
            <span class="statuslist__pct mono">台</span>
          </li>
          <li>
            <span class="statuslist__label">金库余额</span>
            <b class="mono">{{ vault ? formatToken(vault.vaultBalance) : '—' }}</b>
            <span class="statuslist__pct mono">{{ symbol }}</span>
          </li>
          <li>
            <span class="statuslist__label">已保留未发放</span>
            <b class="mono">{{ vault ? formatToken(vault.reserved) : '—' }}</b>
            <span class="statuslist__pct mono">{{ symbol }}</span>
          </li>
          <li>
            <span class="statuslist__label">可发放</span>
            <b class="mono">{{ vault ? formatToken(vault.free) : '—' }}</b>
            <span class="statuslist__pct mono">{{ symbol }}</span>
          </li>
        </ul>
        <p class="panel__foot">
          xNAND {{ vault ? vault.nandStaked.toLocaleString('en-US') : '—' }} · xLATCH
          {{ vault ? vault.latchStaked.toLocaleString('en-US') : '—' }}（质押池总量）
        </p>
      </article>
    </section>

    <!-- 矿机列表 ------------------------------------------------------ -->
    <section class="miners">
      <div class="miners__bar">
        <h2>
          在押矿机
          <small>来自 MinerDecomposer.stakedAt · 共 {{ stakes.length }} 台</small>
        </h2>
        <div class="filters">
          <button
            v-for="f in filters"
            :key="f.key"
            class="chip"
            :class="{ 'chip--on': filter === f.key }"
            @click="filter = f.key"
          >
            {{ f.label }}<span>{{ counts[f.key] }}</span>
          </button>
        </div>
      </div>

      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>电路名字</th>
              <th>结构</th>
              <th>状态</th>
              <th class="num">算力</th>
              <th class="num">预计 24h 产出</th>
              <th class="action">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in paged" :key="`${s.cpu}-${s.id}`">
              <td data-label="电路名字">
                <a class="name" :href="nftUrl(s)" target="_blank" rel="noopener">
                  <span class="cpu">{{ s.cpuName }}</span>
                  <span class="mono">#{{ s.id }}</span>
                </a>
                <span class="meta mono">存入方 {{ shortAddress(s.depositor) }}</span>
              </td>
              <td data-label="结构">
                <template v-if="s.status">
                  <span class="strong mono">
                    {{ s.status.gateCount.toLocaleString('en-US') }} 门 · 深度
                    {{ s.status.depth }}
                  </span>
                  <span class="meta mono">
                    {{ s.status.stateCount.toLocaleString('en-US') }} 态 · 面积
                    {{ fmtArea(Number(s.status.area)) }}
                  </span>
                </template>
                <span v-else class="strong muted">读取失败</span>
              </td>
              <td data-label="状态">
                <span class="pill" :class="`pill--${statusOf(s)}`">
                  <i class="dot" :class="`dot--${statusOf(s)}`" />{{ STATUS_LABEL[statusOf(s)] }}
                </span>
                <span class="meta"
                  >赎回价 xNAND {{ s.nandAmount.toLocaleString('en-US') }} · xLATCH
                  {{ s.latchAmount.toLocaleString('en-US') }}</span
                >
              </td>
              <td class="num" data-label="算力">
                <b class="mono">{{ fmtBig(weightOf(s)) }}</b>
                <span class="meta mono"
                  >占矿池{{
                    fmtPct(poolWeight === 0n ? 0 : Number(weightOf(s)) / Number(poolWeight), 2)
                  }}</span
                >
                <div class="bar bar--thin">
                  <i
                    :style="{
                      width: `${((Number(weightOf(s)) / Number(topWeight)) * 100).toFixed(1)}%`,
                    }"
                  />
                </div>
              </td>
              <td class="num" data-label="预计 24h 产出">
                <b v-if="output24h(s) > 0n" class="mono pos">{{ formatToken(output24h(s)) }}</b>
                <b v-else class="muted">—</b>
                <span class="meta">{{ output24h(s) > 0n ? symbol : '未在挖矿' }}</span>
              </td>
              <td class="action" data-label="操作">
                <button
                  v-if="isMine(s)"
                  class="redeem"
                  type="button"
                  :disabled="redeemBusy"
                  @click="openRedeem(s)"
                >
                  赎回
                </button>
                <span v-else class="meta">非本人存入</span>
              </td>
            </tr>
            <tr v-if="paged.length === 0">
              <td class="empty" colspan="6">
                {{ loadingPool ? '读取中…' : '矿池里还没有在押矿机。' }}
              </td>
            </tr>
          </tbody>
        </table>

        <!-- 分页 ------------------------------------------------------ -->
        <div class="pager">
          <span class="pager__info">
            第 <b class="mono">{{ rangeStart }}–{{ rangeEnd }}</b> 条 / 共
            <b class="mono">{{ filtered.length }}</b> 条
          </span>

          <div class="pager__ctrl">
            <button class="pg" type="button" :disabled="page <= 1" @click="goPage(page - 1)">
              上一页
            </button>
            <template v-for="(item, i) in pageItems" :key="`${item}-${i}`">
              <span v-if="item === 'gap'" class="pg pg--gap">…</span>
              <button
                v-else
                class="pg"
                :class="{ 'pg--on': item === page }"
                type="button"
                :aria-current="item === page ? 'page' : undefined"
                @click="goPage(item)"
              >
                {{ item }}
              </button>
            </template>
            <button
              class="pg"
              type="button"
              :disabled="page >= pageCount"
              @click="goPage(page + 1)"
            >
              下一页
            </button>
          </div>

          <label class="pager__size">
            每页
            <select v-model.number="pageSize">
              <option :value="5">5</option>
              <option :value="10">10</option>
              <option :value="20">20</option>
            </select>
            条
          </label>
        </div>
      </div>

      <p class="hint">
        预计产出 = 矿池预计日收益 × 该矿机算力 ÷ 矿池算力；空闲矿机不产币。
        赎回会烧掉钱包里相同数量的 xNAND / xLATCH（数量不足时请先在「我的」页解押）。
      </p>
    </section>

    <!-- 赎回确认（链上交易） ----------------------------------------- -->
    <Teleport to="body">
      <div v-if="redeemTarget" class="overlay" @click.self="closeRedeem">
        <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="redeem-title">
          <h3 id="redeem-title">赎回矿机</h3>
          <p class="dialog__lead">
            即将赎回
            <b>{{ redeemTarget.cpuName }} #{{ redeemTarget.id }}</b>
          </p>

          <dl class="dialog__grid">
            <div>
              <dt>结构</dt>
              <dd v-if="redeemTarget.status" class="mono">
                {{ redeemTarget.status.gateCount.toLocaleString('en-US') }} 门 · 深度
                {{ redeemTarget.status.depth }}
              </dd>
              <dd v-else class="muted">—</dd>
            </div>
            <div>
              <dt>算力</dt>
              <dd class="mono">{{ fmtBig(weightOf(redeemTarget)) }}</dd>
            </div>
            <div>
              <dt>待领收益</dt>
              <dd class="mono">
                {{
                  redeemTarget.status && redeemTarget.status.live > 0n
                    ? `${formatToken(redeemTarget.status.live)} ${symbol}`
                    : '—'
                }}
              </dd>
            </div>
            <div>
              <dt>状态</dt>
              <dd>
                <span class="pill" :class="`pill--${statusOf(redeemTarget)}`">
                  <i class="dot" :class="`dot--${statusOf(redeemTarget)}`" />{{
                    STATUS_LABEL[statusOf(redeemTarget)]
                  }}
                </span>
              </dd>
            </div>
          </dl>

          <p class="dialog__cost">
            赎回价格：烧毁
            <b class="mono">{{ redeemTarget.nandAmount.toLocaleString('en-US') }}</b> xNAND +
            <b class="mono">{{ redeemTarget.latchAmount.toLocaleString('en-US') }}</b> xLATCH，
            需先在「我的」页解押到钱包。
          </p>
          <p class="dialog__warn">
            赎回后 NFT 转回你的钱包，矿机退出矿池；矿机上未领取的收益归矿池所有，操作不可撤销。
          </p>

          <div class="dialog__actions">
            <button class="btn btn--ghost" type="button" @click="closeRedeem">取消</button>
            <button
              class="btn btn--danger"
              type="button"
              :disabled="redeemBusy"
              @click="confirmRedeem"
            >
              {{ redeemBusy ? '提交中…' : '确认赎回' }}
            </button>
          </div>
        </div>
      </div>

      <p v-if="toast" class="toast" role="status">{{ toast }}</p>
    </Teleport>
  </main>
</template>

<style scoped>
.pool {
  display: flex;
  flex-direction: column;
  gap: 18px;
  padding: 4px 0 56px;
}

/* 页头 -------------------------------------------------------------- */

.title {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin: 0 0 6px;
  font-size: 26px;
  font-weight: 700;
  color: var(--color-heading);
}

.sub {
  margin: 0;
  font-size: 13px;
  opacity: 0.7;
}

.refresh {
  margin-left: 10px;
  padding: 3px 10px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  transition:
    border-color 0.2s,
    background-color 0.2s;
}

.refresh:hover:not(:disabled) {
  border-color: var(--color-border-hover);
  background: var(--color-background-mute);
}

.refresh:disabled {
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

.tag-mock {
  padding: 3px 9px;
  border: 1px dashed var(--color-border-hover);
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.02em;
  opacity: 0.75;
  text-decoration: none;
}

.tag-mock:hover {
  opacity: 1;
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
}

.pill--live {
  color: hsla(160, 100%, 28%, 1);
  background: hsla(160, 100%, 37%, 0.14);
}

.pill--mining {
  color: hsla(160, 100%, 28%, 1);
  background: hsla(160, 100%, 37%, 0.14);
}

.pill--idle {
  color: var(--color-text);
  background: var(--color-background-mute);
  opacity: 0.8;
}

.pill--offline {
  color: hsla(0, 70%, 45%, 1);
  background: hsla(0, 70%, 50%, 0.14);
}

.pulse {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: hsla(160, 100%, 37%, 1);
  animation: pulse 1.8s ease-out infinite;
}

@keyframes pulse {
  0% {
    box-shadow: 0 0 0 0 hsla(160, 100%, 37%, 0.5);
  }
  70% {
    box-shadow: 0 0 0 7px hsla(160, 100%, 37%, 0);
  }
  100% {
    box-shadow: 0 0 0 0 hsla(160, 100%, 37%, 0);
  }
}

/* 核心指标卡 -------------------------------------------------------- */

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(215px, 1fr));
  gap: 12px;
}

.card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 16px 18px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-background-soft);
  overflow: hidden;
}

.card--accent {
  border-color: hsla(160, 100%, 37%, 0.45);
  background:
    linear-gradient(180deg, hsla(160, 100%, 37%, 0.1), transparent 70%),
    var(--color-background-soft);
}

.card__label {
  font-size: 12.5px;
  opacity: 0.65;
}

.card__value {
  font-size: 26px;
  font-weight: 700;
  line-height: 1.15;
  color: var(--color-heading);
  font-variant-numeric: tabular-nums;
}

.card__value small {
  font-size: 13px;
  font-weight: 600;
  opacity: 0.6;
}

.card__sub {
  font-size: 12.5px;
  opacity: 0.62;
}

.pos {
  color: hsla(160, 100%, 32%, 1);
}

/* 次级指标条 -------------------------------------------------------- */

.strip {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 1px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-border);
  overflow: hidden;
}

.strip__item {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 12px 16px;
  background: var(--color-background-soft);
}

.strip__label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  opacity: 0.62;
}

.strip__item b {
  font-size: 16px;
  color: var(--color-heading);
  font-variant-numeric: tabular-nums;
}

/* 面板 -------------------------------------------------------------- */

.panels {
  display: grid;
  grid-template-columns: 1.45fr 1fr;
  gap: 12px;
}

.panel {
  padding: 16px 18px;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-background-soft);
}

.panel h2 {
  margin: 0 0 14px;
  font-size: 15px;
  font-weight: 600;
  color: var(--color-heading);
}

.segbar {
  display: flex;
  gap: 2px;
  height: 12px;
  border-radius: 999px;
  overflow: hidden;
}

.segbar i {
  display: block;
  /* 极小占比（如离线 0.6%）也要看得见 */
  min-width: 3px;
}

.segbar--status {
  margin-bottom: 16px;
}

.legend {
  list-style: none;
  margin: 14px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
}

.legend li {
  display: grid;
  grid-template-columns: 10px minmax(0, 1fr) auto auto 58px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.legend__name {
  color: var(--color-heading);
  font-weight: 600;
}

.legend__miners {
  font-size: 12px;
  opacity: 0.55;
}

.legend li b {
  font-variant-numeric: tabular-nums;
}

.legend__pct {
  min-width: 58px;
  text-align: right;
  font-size: 12px;
  opacity: 0.7;
}

.swatch {
  width: 10px;
  height: 10px;
  border-radius: 3px;
}

.statuslist {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.statuslist li {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto 56px;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}

.statuslist__label {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.statuslist li b {
  font-variant-numeric: tabular-nums;
  color: var(--color-heading);
}

.statuslist__pct {
  text-align: right;
  font-size: 12px;
  opacity: 0.6;
}

.panel__foot {
  margin: 16px 0 0;
  padding-top: 12px;
  border-top: 1px solid var(--color-border);
  font-size: 12.5px;
  opacity: 0.62;
}

.panel__empty {
  margin: 14px 0 0;
  font-size: 13px;
  opacity: 0.6;
}

.panel__foot b {
  color: var(--color-heading);
  font-variant-numeric: tabular-nums;
}

/* 通用：圆点与进度条 ------------------------------------------------ */

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex: none;
  display: inline-block;
}

.dot--mining {
  background: hsla(160, 100%, 37%, 1);
}

.dot--idle {
  background: currentColor;
  opacity: 0.35;
}

.dot--offline {
  background: hsla(0, 70%, 55%, 1);
}

.bar {
  height: 5px;
  margin-top: 2px;
  border-radius: 999px;
  background: var(--color-background-mute);
  overflow: hidden;
}

.bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: var(--color-heading);
  opacity: 0.75;
}

.bar--accent i {
  background: hsla(160, 100%, 37%, 1);
  opacity: 1;
}

.bar--thin {
  height: 3px;
  margin-top: 7px;
  width: 100%;
}

.tone-behemoth {
  background: hsl(258, 70%, 62%);
}
.tone-refbench {
  background: hsla(160, 100%, 37%, 1);
}
.tone-tapeout {
  background: hsl(38, 92%, 52%);
}
.tone-mining {
  background: hsla(160, 100%, 37%, 1);
}
.tone-idle {
  background: hsl(215, 12%, 58%);
}
.tone-offline {
  background: hsla(0, 70%, 55%, 1);
}

/* 矿机列表 ---------------------------------------------------------- */

.miners__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}

.miners__bar h2 {
  margin: 0;
  font-size: 18px;
  color: var(--color-heading);
}

.miners__bar h2 small {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 400;
  opacity: 0.55;
}

.filters {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    background-color 0.2s,
    border-color 0.2s;
}

.chip:hover {
  background: var(--color-background-mute);
}

.chip span {
  font-size: 11px;
  opacity: 0.5;
  font-variant-numeric: tabular-nums;
}

.chip--on {
  border-color: hsla(160, 100%, 37%, 0.5);
  background: hsla(160, 100%, 37%, 0.12);
  color: hsla(160, 100%, 28%, 1);
  font-weight: 600;
}

.chip--on span {
  opacity: 0.7;
}

.table-wrap {
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-background-soft);
  overflow: hidden;
}

.table {
  width: 100%;
  border-collapse: collapse;
  font-size: 14px;
}

.table th {
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.03em;
  text-align: left;
  opacity: 0.6;
  white-space: nowrap;
}

.table th.num,
.table td.num {
  text-align: right;
}

.table th.action,
.table td.action {
  text-align: right;
}

.table th:nth-child(1) {
  width: 22%;
}
.table th:nth-child(2) {
  width: 20%;
}
.table th:nth-child(3) {
  width: 14%;
}
.table th:nth-child(4) {
  width: 15%;
}
.table th:nth-child(5) {
  width: 16%;
}
.table th:nth-child(6) {
  width: 13%;
}

.table td {
  padding: 13px 16px;
  border-bottom: 1px solid var(--color-border);
  vertical-align: top;
}

.table tbody tr:last-child td {
  border-bottom: 0;
}

.table tbody tr:hover {
  background: var(--color-background-mute);
}

.table .name {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 0;
  color: var(--color-heading);
  font-weight: 600;
}

.table .name:hover {
  background: transparent;
  text-decoration: underline;
}

.cpu {
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--color-background-mute);
  border: 1px solid var(--color-border);
  font-size: 12px;
  font-weight: 600;
}

.table .strong {
  display: block;
  color: var(--color-heading);
}

.meta {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  opacity: 0.55;
}

.table .num b {
  font-size: 16px;
  font-variant-numeric: tabular-nums;
}

.table .num .meta {
  margin-top: 2px;
}

.table .num .bar {
  margin-left: auto;
  max-width: 120px;
}

.table .pill {
  font-size: 12px;
  padding: 3px 9px;
}

.muted {
  opacity: 0.4;
}

.empty {
  text-align: center;
  opacity: 0.6;
  padding: 28px 16px;
}

/* 分页 -------------------------------------------------------------- */

.pager {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-top: 1px solid var(--color-border);
  background: var(--color-background-soft);
  font-size: 12.5px;
}

.pager__info {
  opacity: 0.65;
}

.pager__info b {
  color: var(--color-heading);
  font-variant-numeric: tabular-nums;
}

.pager__ctrl {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pg {
  min-width: 30px;
  padding: 5px 9px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition:
    background-color 0.2s,
    border-color 0.2s,
    color 0.2s;
}

.pg:hover:not(:disabled):not(.pg--on) {
  border-color: var(--color-border-hover);
  background: var(--color-background-mute);
}

.pg--on {
  border-color: hsla(160, 100%, 37%, 0.5);
  background: hsla(160, 100%, 37%, 0.14);
  color: hsla(160, 100%, 28%, 1);
  font-weight: 600;
}

.pg--gap {
  border-color: transparent;
  cursor: default;
  opacity: 0.5;
}

.pg:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.pager__size {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  opacity: 0.7;
}

.pager__size select {
  padding: 5px 8px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-background);
  color: var(--color-text);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
}

.hint {
  margin: 12px 2px 0;
  font-size: 12.5px;
  opacity: 0.55;
}

/* 赎回按钮 ---------------------------------------------------------- */

.redeem {
  padding: 6px 14px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
  transition:
    color 0.2s,
    border-color 0.2s,
    background-color 0.2s;
}

.redeem:hover {
  color: hsla(0, 70%, 48%, 1);
  border-color: hsla(0, 70%, 50%, 0.55);
  background: hsla(0, 70%, 50%, 0.1);
}

.redeem:focus-visible {
  outline: 2px solid hsla(0, 70%, 55%, 0.6);
  outline-offset: 2px;
}

/* 赎回确认弹窗 ------------------------------------------------------ */

.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  animation: fade 0.15s ease-out;
}

@keyframes fade {
  from {
    opacity: 0;
  }
}

@keyframes pop {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
}

.dialog {
  width: min(460px, 100%);
  padding: 22px;
  border: 1px solid var(--color-border);
  border-radius: 16px;
  background: var(--color-background-soft);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
  animation: pop 0.18s ease-out;
}

.dialog h3 {
  margin: 0 0 10px;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-heading);
}

.dialog__lead {
  margin: 0 0 16px;
  font-size: 14px;
  opacity: 0.8;
}

.dialog__lead b {
  color: var(--color-heading);
}

.dialog__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px 16px;
  margin: 0 0 16px;
  padding: 14px 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
}

.dialog__grid dt {
  margin-bottom: 4px;
  font-size: 11.5px;
  opacity: 0.55;
}

.dialog__grid dd {
  margin: 0;
  font-size: 14px;
  color: var(--color-heading);
  font-variant-numeric: tabular-nums;
}

.dialog__warn {
  margin: 0 0 20px;
  font-size: 13px;
  line-height: 1.6;
}

.dialog__warn span {
  display: block;
  color: hsla(0, 70%, 48%, 1);
}

.dialog__cost {
  margin: 0 0 8px;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-background);
  font-size: 13px;
  line-height: 1.6;
}

.dialog__cost b {
  color: var(--color-heading);
  font-variant-numeric: tabular-nums;
}

.dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.btn {
  padding: 9px 18px;
  border: 1px solid transparent;
  border-radius: 10px;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color 0.2s,
    border-color 0.2s,
    opacity 0.2s;
}

.btn--ghost {
  border-color: var(--color-border);
  background: transparent;
  color: var(--color-text);
}

.btn--ghost:hover {
  background: var(--color-background-mute);
  border-color: var(--color-border-hover);
}

.btn--danger {
  color: #fff;
  background: hsla(0, 70%, 50%, 1);
}

.btn--danger:hover {
  background: hsla(0, 70%, 44%, 1);
}

/* 操作提示 ---------------------------------------------------------- */

.toast {
  position: fixed;
  left: 50%;
  bottom: 32px;
  z-index: 110;
  transform: translateX(-50%);
  margin: 0;
  padding: 10px 18px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-background-soft);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  font-size: 13.5px;
  white-space: nowrap;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

@media (prefers-color-scheme: dark) {
  .pill--live,
  .pill--mining,
  .chip--on {
    color: hsla(160, 100%, 62%, 1);
  }
  .pill--offline {
    color: hsla(0, 80%, 68%, 1);
  }
  .pos {
    color: hsla(160, 100%, 58%, 1);
  }
}

/* 窄屏：表格转卡片 -------------------------------------------------- */

@media (max-width: 900px) {
  .panels {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .title {
    font-size: 22px;
  }
  .card__value {
    font-size: 22px;
  }
  .table thead {
    display: none;
  }
  .table,
  .table tbody,
  .table tr,
  .table td {
    display: block;
    width: 100%;
  }
  .table tr {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px 14px;
    padding: 14px 16px;
    border-bottom: 1px solid var(--color-border);
  }
  .table tbody tr:last-child {
    border-bottom: 0;
  }
  .table td {
    padding: 0;
    border: 0;
  }
  .table td.num {
    text-align: left;
  }
  .table td::before {
    content: attr(data-label);
    display: block;
    margin-bottom: 5px;
    font-size: 11px;
    letter-spacing: 0.03em;
    opacity: 0.5;
  }
  .table .num .bar {
    margin-left: 0;
    max-width: none;
  }
  .table .action {
    grid-column: 1 / -1;
    text-align: left;
  }
  .table .action .redeem {
    width: 100%;
    padding: 9px 14px;
  }
  .toast {
    left: 16px;
    right: 16px;
    bottom: 20px;
    transform: none;
    text-align: center;
    white-space: normal;
  }
  /* 弹窗：窄屏改单列，避免"深度 12"被拆行 */
  .overlay {
    align-items: flex-start;
    padding: 16px;
    overflow-y: auto;
  }
  .dialog {
    padding: 18px;
  }
  .dialog__grid {
    grid-template-columns: 1fr;
    gap: 10px;
  }
  .dialog__actions {
    flex-direction: column;
    gap: 8px;
  }
  .dialog__actions .btn {
    width: 100%;
  }
}

@media (max-width: 560px) {
  .cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  .card {
    padding: 12px 14px;
    gap: 4px;
  }
  .card__value {
    font-size: 19px;
  }
  .card__value small {
    font-size: 11px;
  }
  .card__sub {
    font-size: 11.5px;
  }
  .strip {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .strip__item {
    padding: 10px 13px;
  }
  .strip__item b {
    font-size: 15px;
  }
  .legend li {
    grid-template-columns: 10px minmax(0, 1fr) auto auto;
  }
  .legend__pct {
    display: none;
  }
}
</style>
