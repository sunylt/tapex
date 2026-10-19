<script setup lang="ts">
import { computed } from 'vue'

import { POD_CONFIG } from '@/pod/config'
import { formatToken, shortAddress } from '@/pod/service'
import type { MinerStatus } from '@/pod/types'

const props = defineProps<{
  miner: MinerStatus
  symbol: string
}>()

const emit = defineEmits<{
  /** 拆解：质押进矿池，并按矿机构成重新铸造 NAND / LATCH */
  disassemble: [miner: MinerStatus]
}>()

const cpuMultiplier = computed(() => POD_CONFIG.cpus[props.miner.ref.cpu]?.multiplier ?? 1)
/** 该型号是否开放质押（链上以 cpuAllowed 为准，前端用同一份开关先挡一层）。 */
const stakeEnabled = computed(() => POD_CONFIG.cpus[props.miner.ref.cpu]?.stakeEnabled ?? false)
const nftUrl = computed(
  () => `${POD_CONFIG.explorer}/nft/${props.miner.ref.circuits}/${props.miner.ref.circuitId}`,
)

const fmt = (value: bigint) => value.toLocaleString('en-US')

function onDisassemble() {
  if (!stakeEnabled.value) return
  emit('disassemble', props.miner)
}
</script>

<template>
  <article class="miner" :class="{ active: miner.active }">
    <header class="miner__head">
      <div>
        <span class="miner__cpu">{{ miner.ref.cpu }}</span>
        <span class="miner__mult">×{{ cpuMultiplier }}</span>
        <a
          class="miner__id"
          :href="nftUrl"
          target="_blank"
          rel="noopener"
          :title="miner.ref.circuits"
          >#{{ miner.ref.circuitId }}</a
        >
      </div>
      <span class="badge" :class="miner.active ? 'badge--on' : 'badge--off'">
        {{ miner.active ? '挖矿中' : '空闲' }}
      </span>
    </header>

    <dl class="miner__grid">
      <div>
        <dt>任务</dt>
        <dd>#{{ miner.taskId }}</dd>
      </div>
      <div>
        <dt>门数 / 状态</dt>
        <dd>{{ miner.gateCount }} / {{ miner.stateCount }}</dd>
      </div>
      <div>
        <dt>深度 / 面积</dt>
        <dd>{{ miner.depth }} / {{ fmt(miner.area) }}</dd>
      </div>
      <div>
        <dt>烧毁 NAND</dt>
        <dd>{{ miner.nandBurn.toLocaleString('en-US') }}</dd>
      </div>
      <div>
        <dt>烧毁 LATCH</dt>
        <dd>{{ miner.latchBurn.toLocaleString('en-US') }}</dd>
      </div>
      <div>
        <dt>验证权重</dt>
        <dd>{{ fmt(miner.verifWeight) }}</dd>
      </div>
      <div>
        <dt>未验证权重</dt>
        <dd>{{ fmt(miner.unverWeight) }}</dd>
      </div>
      <div>
        <dt>合约</dt>
        <dd :title="miner.ref.circuits">{{ shortAddress(miner.ref.circuits) }}</dd>
      </div>
    </dl>

    <footer class="miner__foot">
      <div class="miner__foot-info">
        <template v-if="miner.active">
          <span class="live">待领取 {{ formatToken(miner.live) }} {{ symbol }}</span>
          <span v-if="miner.optimal" class="badge badge--best">最优</span>
        </template>
        <template v-else-if="miner.preview">
          <span class="preview">预估权重 {{ fmt(miner.preview.verifWeight) }}</span>
          <span class="reason">{{ miner.preview.reason }}</span>
        </template>
        <template v-else>
          <span class="reason">未挖矿</span>
        </template>
      </div>

      <div class="miner__cta">
        <span v-if="!stakeEnabled" class="stake-off">暂未开放</span>
        <button
          class="disassemble"
          type="button"
          :disabled="!stakeEnabled"
          :title="
            stakeEnabled ? '拆解：质押进矿池并铸造 xNAND / xLATCH' : `${miner.ref.cpu} 暂未开放质押`
          "
          @click="onDisassemble"
        >
          拆解
        </button>
      </div>
    </footer>
  </article>
</template>

<style scoped>
.miner {
  border: 1px solid var(--color-border);
  border-radius: 10px;
  padding: 14px 16px;
  background: var(--color-background-soft);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.miner.active {
  border-color: hsla(160, 100%, 37%, 0.7);
  box-shadow: 0 0 0 1px hsla(160, 100%, 37%, 0.25) inset;
}
.miner__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.miner__cpu {
  font-weight: 700;
  color: var(--color-heading);
}
.miner__mult {
  margin-left: 6px;
  font-size: 12px;
  opacity: 0.6;
}
.miner__id {
  margin-left: 8px;
  font-variant-numeric: tabular-nums;
}
.badge {
  font-size: 12px;
  padding: 2px 8px;
  border-radius: 999px;
  white-space: nowrap;
}
.badge--on {
  background: hsla(160, 100%, 37%, 0.18);
  color: hsla(160, 100%, 30%, 1);
}
.badge--off {
  background: var(--color-background-mute);
  color: var(--color-text);
  opacity: 0.7;
}
.badge--best {
  background: hsla(45, 100%, 50%, 0.2);
  color: hsla(35, 100%, 30%, 1);
}
.miner__grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px 12px;
  margin: 0;
}
.miner__grid dt {
  font-size: 12px;
  opacity: 0.6;
}
.miner__grid dd {
  margin: 0;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  text-overflow: ellipsis;
}
.miner__foot {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  font-size: 13px;
}
.miner__cta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
}
.miner__foot-info {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.disassemble {
  flex: none;
  padding: 5px 14px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 13px;
  cursor: pointer;
  transition:
    color 0.2s,
    border-color 0.2s,
    background-color 0.2s;
}
.disassemble:hover {
  color: hsla(160, 100%, 30%, 1);
  border-color: hsla(160, 100%, 37%, 0.55);
  background: hsla(160, 100%, 37%, 0.12);
}
.disassemble:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.disassemble:disabled:hover {
  color: var(--color-text);
  border-color: var(--color-border);
  background: transparent;
}
.stake-off {
  font-size: 11.5px;
  opacity: 0.6;
  white-space: nowrap;
}
.disassemble:focus-visible {
  outline: 2px solid hsla(160, 100%, 37%, 0.6);
  outline-offset: 2px;
}
.live {
  color: hsla(160, 100%, 30%, 1);
  font-weight: 600;
}
.reason {
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (prefers-color-scheme: dark) {
  .badge--on,
  .live {
    color: hsla(160, 100%, 60%, 1);
  }
  .badge--best {
    color: hsla(45, 100%, 70%, 1);
  }
  .disassemble:hover {
    color: hsla(160, 100%, 62%, 1);
  }
}
</style>
