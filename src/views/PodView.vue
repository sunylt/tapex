<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { storeToRefs } from 'pinia'

import DisassembleDialog from '@/components/DisassembleDialog.vue'
import MinerCard from '@/components/MinerCard.vue'
import StakeDialog from '@/components/StakeDialog.vue'
import { POD_CONFIG, STAKING_ENABLED } from '@/pod/config'
import { formatToken, hasInjectedWallet, shortAddress } from '@/pod/service'
import {
  claimMiningRewards,
  claimStakingRewards,
  describeError,
  distributeAllRewards,
  stakeMiner,
  stakeX,
  unstakeX,
} from '@/pod/tx'
import type { EquityToken, MinerStatus } from '@/pod/types'
import { useMiningStore } from '@/stores/mining'

const store = useMiningStore()
const {
  chainId,
  loading,
  scanning,
  scanProgress,
  error,
  miners,
  source,
  lastUpdated,
  connected,
  onCorrectChain,
  activeCount,
  totalLive,
  equity,
  earned,
  equityLoaded,
  isPoolOwner,
} = storeToRefs(store)

const walletAvailable = hasInjectedWallet()
const tokenSymbol = POD_CONFIG.tokenSymbol

/** 矿池占比 = 我的质押量 ÷ 矿池质押总量 */
const poolShare = (t: EquityToken) => (t.poolStaked === 0 ? 0 : t.staked / t.poolStaked)
const pctText = (ratio: number) => `${(ratio * 100).toFixed(2)}%`

const updatedText = computed(() =>
  lastUpdated.value ? new Date(lastUpdated.value).toLocaleTimeString() : '—',
)

const scanText = computed(() => {
  const p = scanProgress.value
  if (!p || p.total === 0) return '正在扫描链上历史…'
  return `正在扫描链上历史… ${p.done}/${p.total}`
})

/* ---------------- 链上交易 ---------------- */

const busy = ref<string | null>(null)

const disassembleTarget = ref<MinerStatus | null>(null)
const toast = ref<string | null>(null)
let toastTimer: ReturnType<typeof setTimeout> | null = null

function flash(message: string) {
  toast.value = message
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (toast.value = null), 6000)
}

/** 交易前置检查：已连接钱包、链正确、没有正在进行的交易。 */
function guardChain(): boolean {
  if (!connected.value) {
    flash('请先连接钱包')
    return false
  }
  if (!onCorrectChain.value) {
    flash('请先切换到 BNB Smart Chain（56）')
    return false
  }
  if (busy.value) return false
  return true
}

async function run(
  label: string,
  fn: () => Promise<string>,
  ok: (hash: string) => string,
) {
  if (!guardChain()) return
  busy.value = label
  try {
    const hash = await fn()
    flash(`${ok(hash)}（${shortAddress(hash, 6)}）`)
    await store.refresh()
  } catch (err) {
    flash(describeError(err))
  } finally {
    busy.value = null
  }
}

/* ---------------- 拆解（质押矿机进矿池） ---------------- */

function openDisassemble(miner: MinerStatus) {
  if (!guardChain()) return
  if (!STAKING_ENABLED) {
    flash('未配置拆解合约地址（VITE_POD_DECOMPOSER）')
    return
  }
  if (!POD_CONFIG.cpus[miner.ref.cpu]?.stakeEnabled) return
  disassembleTarget.value = miner
}

function closeDisassemble() {
  disassembleTarget.value = null
}

function confirmDisassemble(miner: MinerStatus) {
  disassembleTarget.value = null
  const { circuits, circuitId } = miner.ref
  const mult = miner.mult || 1
  void run(
    'stake-miner',
    () => stakeMiner(circuits, circuitId),
    () =>
      `已拆解 ${miner.ref.cpu} #${circuitId}：铸造 xNAND ${(
        miner.nandBurn * mult
      ).toLocaleString('en-US')} / xLATCH ${(miner.latchBurn * mult).toLocaleString('en-US')}`,
  )
}

/* ---------------- 领取收益 ---------------- */

/** 矿机收益：claimMany(全部挖矿中的矿机 key)，打进当前 NFT 持有人 = 钱包。 */
function claimMining() {
  const keys = miners.value.filter((m) => m.active).map((m) => m.key)
  if (keys.length === 0) return
  void run(
    'claim-mining',
    () => claimMiningRewards(keys),
    () => `已提交领取矿机收益 ${formatToken(totalLive.value)} ${tokenSymbol}`,
  )
}

/** 质押收益：XTokenStaking.claim()，金库直付给钱包。 */
function claimStaking() {
  void run(
    'claim-staking',
    () => claimStakingRewards(),
    () => `已提交领取质押收益 ${formatToken(earned.value)} ${tokenSymbol}`,
  )
}

/** Owner 专属：把金库可用 BEM 全部分给质押池。 */
async function distribute() {
  if (!guardChain()) return
  busy.value = 'distribute'
  try {
    const { hash, amount } = await distributeAllRewards()
    flash(`已发放 ${formatToken(amount)} ${tokenSymbol} 给质押池（${shortAddress(hash, 6)}）`)
    await store.refresh()
  } catch (err) {
    flash(describeError(err))
  } finally {
    busy.value = null
  }
}

/* ---------------- 抵押 / 解押 xNAND / xLATCH ---------------- */

const stakeToken = ref<EquityToken | null>(null)
const stakeMode = ref<'stake' | 'unstake'>('stake')

function openStake(token: EquityToken, mode: 'stake' | 'unstake') {
  stakeToken.value = token
  stakeMode.value = mode
}

function closeStake() {
  stakeToken.value = null
}

function confirmStake(payload: {
  token: EquityToken
  mode: 'stake' | 'unstake'
  amount: number
}) {
  stakeToken.value = null
  const { token, mode, amount } = payload
  const label = mode === 'stake' ? '抵押' : '解押'
  const send = mode === 'stake' ? stakeX : unstakeX
  void run(
    `x-${mode}`,
    () => send(token.address, amount),
    () => `已${label} ${amount.toLocaleString('en-US')} ${token.symbol}`,
  )
}

onBeforeUnmount(() => {
  if (toastTimer) clearTimeout(toastTimer)
})
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

      <div v-if="connected" class="pod__actions">
        <button :disabled="loading" @click="store.refresh()">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
        <button class="ghost" :disabled="loading || scanning" @click="store.rescan()">
          重新扫描
        </button>
      </div>
    </header>

    <p v-if="!walletAvailable" class="warn">未检测到浏览器钱包（window.ethereum），请安装 MetaMask。</p>
    <p v-else-if="connected && !onCorrectChain" class="warn">
      当前网络不是 BNB Smart Chain（56）。
      <button class="ghost" @click="store.switchToBsc()">切换到 BSC</button>
    </p>
    <p v-if="error" class="error">{{ error }}</p>

    <!-- 矿池权益 ------------------------------------------------------ -->
    <section v-if="connected && STAKING_ENABLED" class="equity">
      <div class="section__bar">
        <h2>矿池权益</h2>
        <span class="tag-mock">
          拆解金库
          <a
            class="mono"
            :href="`${POD_CONFIG.explorer}/address/${POD_CONFIG.contracts.decomposer}`"
            target="_blank"
            rel="noopener"
          >
            {{ shortAddress(POD_CONFIG.contracts.decomposer ?? '') }}
          </a>
        </span>
      </div>

      <p v-if="!equityLoaded" class="empty">正在读取 xNAND / xLATCH 链上余额…</p>

      <article v-else class="equity__card">
        <div class="equity__list">
          <div v-for="t in equity" :key="t.symbol" class="equity__item">
            <span class="equity__symbol">{{ t.symbol }}</span>

            <div class="equity__cell">
              <span class="equity__label">当前持有</span>
              <b class="equity__value mono">{{ t.held.toLocaleString('en-US') }}</b>
            </div>

            <div class="equity__cell">
              <span class="equity__label">已抵押</span>
              <b class="equity__value mono">{{ t.staked.toLocaleString('en-US') }}</b>
            </div>

            <div class="equity__cell equity__cell--rate">
              <span class="equity__label">
                矿池占比 <b class="mono">{{ pctText(poolShare(t)) }}</b>
              </span>
              <div class="bar"><i :style="{ width: pctText(poolShare(t)) }" /></div>
            </div>

            <div class="equity__actions">
              <button
                class="mini"
                type="button"
                :disabled="t.held === 0 || !!busy"
                @click="openStake(t, 'stake')"
              >
                抵押
              </button>
              <button
                class="mini mini--ghost"
                type="button"
                :disabled="t.staked === 0 || !!busy"
                @click="openStake(t, 'unstake')"
              >
                解押
              </button>
            </div>
          </div>
        </div>

        <footer class="equity__foot">
          <div class="equity__cell">
            <span class="equity__label">矿机待领（claimMany）</span>
            <b class="equity__earn mono">
              {{ formatToken(totalLive) }} <small>{{ tokenSymbol }}</small>
            </b>
          </div>

          <button
            class="claim"
            type="button"
            :disabled="totalLive === 0n || !!busy"
            @click="claimMining"
          >
            领取
          </button>

          <div class="equity__cell">
            <span class="equity__label">质押待领（XTokenStaking.claim）</span>
            <b class="equity__earn mono">
              {{ formatToken(earned) }} <small>{{ tokenSymbol }}</small>
            </b>
          </div>

          <button
            class="claim"
            type="button"
            :disabled="earned === 0n || !!busy"
            @click="claimStaking"
          >
            领取
          </button>
        </footer>

        <footer v-if="isPoolOwner" class="equity__foot equity__foot--owner">
          <div class="equity__cell">
            <span class="equity__label">Owner 操作</span>
            <b class="owner-hint">把金库可用收益全部发放给质押池（distributeRewards）</b>
          </div>
          <button class="claim claim--owner" type="button" :disabled="!!busy" @click="distribute">
            发放收益
          </button>
        </footer>
      </article>
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
        <MinerCard
          v-for="m in miners"
          :key="m.key"
          :miner="m"
          :symbol="tokenSymbol"
          @disassemble="openDisassemble"
        />
      </div>
    </section>

    <p v-else class="empty">连接钱包后查看你的矿机与挖矿状态。</p>

    <DisassembleDialog
      :miner="disassembleTarget"
      :symbol="tokenSymbol"
      @close="closeDisassemble"
      @confirm="confirmDisassemble"
    />

    <StakeDialog
      :token="stakeToken"
      :mode="stakeMode"
      @close="closeStake"
      @confirm="confirmStake"
    />

    <p v-if="toast" class="toast" role="status">{{ toast }}</p>
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
/* 矿池权益 ---------------------------------------------------------- */

.section__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.tag-mock {
  padding: 2px 9px;
  border: 1px dashed var(--color-border-hover);
  border-radius: 999px;
  font-size: 11.5px;
  opacity: 0.7;
}
.equity__card {
  padding: 4px 18px 0;
  border: 1px solid var(--color-border);
  border-radius: 14px;
  background: var(--color-background-soft);
}
.equity__item {
  display: grid;
  grid-template-columns: 100px minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.1fr) auto;
  align-items: center;
  gap: 18px;
  padding: 14px 0;
  border-bottom: 1px solid var(--color-border);
}
.equity__actions {
  display: flex;
  gap: 8px;
  justify-self: end;
}
.mini {
  padding: 6px 14px;
  border: 1px solid transparent;
  border-radius: 9px;
  background: hsla(160, 100%, 37%, 1);
  color: #fff;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition:
    background-color 0.2s,
    border-color 0.2s;
}
.mini:hover {
  background: hsla(160, 100%, 32%, 1);
}
.mini--ghost {
  border-color: var(--color-border);
  background: transparent;
  color: var(--color-text);
  font-weight: 500;
}
.mini--ghost:hover {
  border-color: var(--color-border-hover);
  background: var(--color-background-mute);
}
.mini:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.mini:disabled:hover {
  background: hsla(160, 100%, 37%, 1);
}
.mini--ghost:disabled:hover {
  background: transparent;
  border-color: var(--color-border);
}
.equity__symbol {
  justify-self: start;
  padding: 3px 10px;
  border: 1px solid hsla(160, 100%, 37%, 0.4);
  border-radius: 999px;
  background: hsla(160, 100%, 37%, 0.1);
  color: hsla(160, 100%, 28%, 1);
  font-size: 13px;
  font-weight: 700;
}
.equity__cell {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.equity__label {
  font-size: 12px;
  opacity: 0.6;
}
.equity__label b {
  color: var(--color-heading);
  font-variant-numeric: tabular-nums;
}
.equity__value {
  font-size: 20px;
  font-weight: 700;
  color: var(--color-heading);
  font-variant-numeric: tabular-nums;
}
.equity__cell--rate .bar {
  margin-top: 6px;
}
.equity__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 15px 0 16px;
  flex-wrap: wrap;
}
.equity__foot--owner {
  border-top: 1px dashed var(--color-border);
}
.owner-hint {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-heading);
}
.claim--owner {
  background: hsla(210, 90%, 48%, 1);
}
.claim--owner:hover:not(:disabled) {
  background: hsla(210, 90%, 42%, 1);
}
.equity__earn {
  font-size: 24px;
  font-weight: 700;
  color: hsla(160, 100%, 30%, 1);
  font-variant-numeric: tabular-nums;
}
.equity__earn small {
  font-size: 13px;
  font-weight: 600;
  opacity: 0.7;
}
.claim {
  flex: none;
  padding: 10px 26px;
  border: 0;
  border-radius: 10px;
  background: hsla(160, 100%, 37%, 1);
  color: #fff;
  font-family: inherit;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.2s;
}
.claim:hover:not(:disabled) {
  background: hsla(160, 100%, 32%, 1);
}
.claim:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.bar {
  height: 5px;
  border-radius: 999px;
  background: var(--color-background-mute);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  border-radius: 999px;
  background: hsla(160, 100%, 37%, 1);
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
.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  z-index: 110;
  transform: translateX(-50%);
  margin: 0;
  width: max-content;
  max-width: min(680px, calc(100vw - 32px));
  padding: 11px 18px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background-soft);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  font-size: 13.5px;
  line-height: 1.5;
  text-align: center;
}

@media (prefers-color-scheme: dark) {
  .equity__symbol,
  .equity__earn {
    color: hsla(160, 100%, 60%, 1);
  }
}

@media (max-width: 640px) {
  .equity__card {
    padding: 2px 14px 0;
  }
  .equity__item {
    grid-template-columns: auto minmax(0, 1fr);
    gap: 10px 16px;
  }
  .equity__symbol,
  .equity__cell--rate {
    grid-column: 1 / -1;
  }
  .equity__actions {
    grid-column: 1 / -1;
    justify-self: stretch;
  }
  .equity__actions .mini {
    flex: 1;
    padding: 9px 0;
  }
  .equity__value {
    font-size: 18px;
  }
  .equity__foot {
    align-items: flex-end;
  }
  .equity__earn {
    font-size: 21px;
  }
  .claim {
    padding: 10px 20px;
  }
}
</style>
