<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue'

import { shortAddress } from '@/pod/service'
import type { MinerStatus } from '@/pod/types'

/**
 * 拆解确认弹窗（纯交互，未接链上）。
 *
 * 与 MinerDecomposer 合约对齐：
 *  - 铸造数量 = `nandBurn × mult` / `latchBurn × mult`（不是裸的 nandBurn！）
 *  - 拆解后合约成为 NFT 持有者，矿机继续挖矿但收益归矿池；
 *    想拿回来需要用同样数量的 xNAND / xLATCH 走 redeem。
 *  - 存入时未领取的收益也会一并归矿池，所以提示用户先领。
 */
const props = defineProps<{
  /** 为 null 时不显示弹窗 */
  miner: MinerStatus | null
  symbol: string
}>()

const emit = defineEmits<{
  close: []
  confirm: [miner: MinerStatus]
}>()

const fmt = (n: number) => n.toLocaleString('en-US')

/** 合约里是 `nandBurn * mult` / `latchBurn * mult`。 */
const mult = computed(() => props.miner?.mult ?? 1)
const nand = computed(() => (props.miner ? props.miner.nandBurn * mult.value : 0))
const latch = computed(() => (props.miner ? props.miner.latchBurn * mult.value : 0))

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.miner) emit('close')
}

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="miner" class="overlay" @click.self="emit('close')">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="disassemble-title">
        <h3 id="disassemble-title">拆解矿机</h3>
        <p class="dialog__lead">
          将 <b>{{ miner.ref.cpu }} #{{ miner.ref.circuitId }}</b> 质押进 TAPEX 矿池
        </p>

        <section class="block">
          <h4>矿机构成</h4>
          <dl class="grid">
            <div>
              <dt>门数</dt>
              <dd class="mono">{{ fmt(miner.gateCount) }}</dd>
            </div>
            <div>
              <dt>状态数</dt>
              <dd class="mono">{{ fmt(miner.stateCount) }}</dd>
            </div>
            <div>
              <dt>深度</dt>
              <dd class="mono">{{ miner.depth }}</dd>
            </div>
            <div>
              <dt>面积</dt>
              <dd class="mono">{{ fmt(Number(miner.area)) }}</dd>
            </div>
          </dl>
        </section>

        <section class="block block--mint">
          <h4>拆解后重新铸造</h4>
          <div class="mint">
            <div class="mint__item">
              <span class="mint__label">xNAND</span>
              <b class="mint__value mono">{{ fmt(nand) }}</b>
              <span class="mint__calc mono">{{ fmt(miner.nandBurn) }} × {{ mult }}</span>
            </div>
            <span class="mint__plus">+</span>
            <div class="mint__item">
              <span class="mint__label">xLATCH</span>
              <b class="mint__value mono">{{ fmt(latch) }}</b>
              <span class="mint__calc mono">{{ fmt(miner.latchBurn) }} × {{ mult }}</span>
            </div>
          </div>
          <p class="mint__note">
            按矿机构成 1:1 铸造至
            <span class="mono">{{ shortAddress(miner.ref.owner) }}</span>
          </p>
        </section>

        <p class="warn">
          注意：拆解后该矿机将质押进 TAPEX 矿池，你需要支付同样数量的 xNAND 与 xLATCH
          才能赎回。
        </p>
        <p class="warn warn--hint">
          建议先领取这台矿机的当前收益：拆解后矿机归矿池，未领取的收益也会一并归矿池所有。
        </p>

        <div class="actions">
          <button class="btn btn--ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn btn--primary" type="button" @click="emit('confirm', miner)">
            确认拆解
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
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
  width: min(520px, 100%);
  max-height: 100%;
  overflow-y: auto;
  padding: 22px;
  border: 1px solid var(--color-border);
  border-radius: 16px;
  background: var(--color-background-soft);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.35);
  animation: pop 0.18s ease-out;
}

.dialog h3 {
  margin: 0 0 8px;
  font-size: 18px;
  font-weight: 700;
  color: var(--color-heading);
}

.dialog__lead {
  margin: 0 0 18px;
  font-size: 14px;
  opacity: 0.8;
}

.dialog__lead b {
  color: var(--color-heading);
}

.block {
  margin-bottom: 14px;
}

.block h4 {
  margin: 0 0 10px;
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.04em;
  opacity: 0.55;
}

.grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px 14px;
  margin: 0;
  padding: 14px 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
}

.grid dt {
  margin-bottom: 4px;
  font-size: 11.5px;
  opacity: 0.55;
}

.grid dd {
  margin: 0;
  font-size: 15px;
  color: var(--color-heading);
  font-variant-numeric: tabular-nums;
}

/* 拆解后返还的 NAND / LATCH 是这张弹窗的重点 */
.block--mint {
  padding: 14px 16px 12px;
  border: 1px solid hsla(160, 100%, 37%, 0.4);
  border-radius: 12px;
  background:
    linear-gradient(180deg, hsla(160, 100%, 37%, 0.1), transparent 80%),
    var(--color-background);
}

.block--mint h4 {
  color: hsla(160, 100%, 30%, 1);
  opacity: 1;
}

.mint {
  display: flex;
  align-items: center;
  gap: 12px;
}

.mint__item {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 14px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-background-soft);
}

.mint__label {
  font-size: 11.5px;
  letter-spacing: 0.06em;
  opacity: 0.6;
}

.mint__value {
  font-size: 24px;
  font-weight: 700;
  color: hsla(160, 100%, 30%, 1);
  font-variant-numeric: tabular-nums;
}

.mint__calc {
  font-size: 11.5px;
  opacity: 0.5;
}

.mint__plus {
  font-size: 18px;
  opacity: 0.45;
}

.mint__note {
  margin: 10px 0 0;
  font-size: 12.5px;
  opacity: 0.6;
}

.warn {
  margin: 0 0 6px;
  font-size: 13px;
  line-height: 1.6;
}

.warn--hint {
  margin: 10px 0 20px;
  padding: 9px 12px;
  border-radius: 10px;
  background: hsla(45, 100%, 50%, 0.13);
  font-size: 12.5px;
}

.mock {
  margin: 0 0 20px;
  font-size: 12px;
  opacity: 0.55;
}

.actions {
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
    border-color 0.2s;
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

.btn--primary {
  color: #fff;
  background: hsla(160, 100%, 37%, 1);
}

.btn--primary:hover {
  background: hsla(160, 100%, 32%, 1);
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

@media (prefers-color-scheme: dark) {
  .block--mint h4,
  .mint__value {
    color: hsla(160, 100%, 60%, 1);
  }
}

@media (max-width: 560px) {
  .dialog {
    padding: 18px;
  }
  .grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .mint {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  .mint__plus {
    display: none;
  }
  .actions {
    flex-direction: column;
    gap: 8px;
  }
  .actions .btn {
    width: 100%;
  }
}
</style>
