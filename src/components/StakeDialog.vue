<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import type { EquityToken } from '@/pod/types'

/**
 * 抵押 / 解押弹窗（真实交易：XTokenStaking.stake / unstake）。
 *
 * 抵押 = 把钱包里的 xNAND / xLATCH 质押进 TAPEX 矿池
 * 解押 = 从矿池取回已质押的数量
 *
 * xNAND / xLATCH 的 decimals = 0，所以数量只能是整数。
 */
const props = defineProps<{
  /** 为 null 时不显示弹窗 */
  token: EquityToken | null
  mode: 'stake' | 'unstake'
}>()

const emit = defineEmits<{
  close: []
  confirm: [payload: { token: EquityToken; mode: 'stake' | 'unstake'; amount: number }]
}>()

const amount = ref('')
const inputEl = ref<HTMLInputElement | null>(null)

const isStake = computed(() => props.mode === 'stake')
const actionText = computed(() => (isStake.value ? '抵押' : '解押'))
const sourceLabel = computed(() => (isStake.value ? '当前持有' : '已质押'))

/** 可操作上限：抵押看钱包余额，解押看已质押数量 */
const max = computed(() => (isStake.value ? (props.token?.held ?? 0) : (props.token?.staked ?? 0)))

const value = computed(() => {
  const n = Number(amount.value)
  return Number.isSafeInteger(n) && n > 0 ? n : 0
})
const tooMuch = computed(() => value.value > max.value)
const canSubmit = computed(() => value.value > 0 && !tooMuch.value)

const fmt = (n: number) => n.toLocaleString('en-US')

const afterHeld = computed(() => {
  if (!props.token) return 0
  return isStake.value ? props.token.held - value.value : props.token.held + value.value
})
const afterStaked = computed(() => {
  if (!props.token) return 0
  return isStake.value ? props.token.staked + value.value : props.token.staked - value.value
})

const ratios = [0.25, 0.5, 0.75, 1]

function setRatio(r: number) {
  amount.value = String(Math.floor(max.value * r))
}

function onAmountInput(event: Event) {
  const el = event.target as HTMLInputElement
  // decimals = 0：只允许整数
  const next = el.value.replace(/\D/g, '')
  amount.value = next
  if (el.value !== next) el.value = next
}

function submit() {
  if (!props.token || !canSubmit.value) return
  emit('confirm', { token: props.token, mode: props.mode, amount: value.value })
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.token) emit('close')
  if (event.key === 'Enter' && props.token) submit()
}

watch(
  () => props.token,
  async (token) => {
    if (!token) return
    amount.value = ''
    await nextTick()
    inputEl.value?.focus()
  },
)

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => document.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="token" class="overlay" @click.self="emit('close')">
      <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="stake-title">
        <h3 id="stake-title">{{ actionText }} {{ token.symbol }}</h3>
        <p class="dialog__lead">
          {{
            isStake
              ? `将 ${token.symbol} 质押进 TAPEX 矿池`
              : `从矿池取回已质押的 ${token.symbol}`
          }}
        </p>

        <label class="field">
          <span class="field__head">
            <span class="field__label">{{ actionText }}数量</span>
            <span class="field__max mono">{{ sourceLabel }} {{ fmt(max) }}</span>
          </span>
          <span class="field__box">
            <input
              ref="inputEl"
              class="field__input mono"
              type="text"
              inputmode="numeric"
              placeholder="0"
              :value="amount"
              @input="onAmountInput"
            />
            <span class="field__unit">{{ token.symbol }}</span>
          </span>
        </label>

        <div class="ratios">
          <button
            v-for="r in ratios"
            :key="r"
            type="button"
            class="ratio"
            @click="setRatio(r)"
          >
            {{ r === 1 ? '全部' : `${r * 100}%` }}
          </button>
        </div>

        <p v-if="tooMuch" class="error">超过可{{ actionText }}数量，最多 {{ fmt(max) }} {{ token.symbol }}</p>

        <dl class="preview">
          <div>
            <dt>当前持有</dt>
            <dd class="mono">
              {{ fmt(token.held) }} <span class="arrow">→</span>
              <b v-if="!tooMuch">{{ fmt(afterHeld) }}</b>
              <b v-else class="muted">—</b>
            </dd>
          </div>
          <div>
            <dt>已质押</dt>
            <dd class="mono">
              {{ fmt(token.staked) }} <span class="arrow">→</span>
              <b v-if="!tooMuch">{{ fmt(afterStaked) }}</b>
              <b v-else class="muted">—</b>
            </dd>
          </div>
        </dl>

        <p class="hint">确认后钱包会依次请求授权（额度不足时）与{{ actionText }}两笔交易。</p>

        <div class="actions">
          <button class="btn btn--ghost" type="button" @click="emit('close')">取消</button>
          <button class="btn btn--primary" type="button" :disabled="!canSubmit" @click="submit">
            确认{{ actionText }}
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
  width: min(440px, 100%);
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

/* 数量输入 ---------------------------------------------------------- */

.field {
  display: block;
}

.field__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}

.field__label {
  font-size: 12.5px;
  opacity: 0.65;
}

.field__max {
  font-size: 12px;
  opacity: 0.6;
}

.field__box {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 0 14px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
  transition: border-color 0.2s;
}

.field__box:focus-within {
  border-color: hsla(160, 100%, 37%, 0.7);
}

.field__input {
  flex: 1;
  min-width: 0;
  padding: 13px 0;
  border: 0;
  background: transparent;
  color: var(--color-heading);
  font-family: inherit;
  font-size: 20px;
  font-weight: 700;
  outline: none;
}

.field__input::placeholder {
  color: var(--color-text);
  opacity: 0.35;
  font-weight: 400;
}

.field__unit {
  flex: none;
  font-size: 13px;
  font-weight: 600;
  opacity: 0.65;
}

.ratios {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.ratio {
  flex: 1;
  padding: 7px 0;
  border: 1px solid var(--color-border);
  border-radius: 9px;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 12.5px;
  cursor: pointer;
  transition:
    background-color 0.2s,
    border-color 0.2s;
}

.ratio:hover {
  border-color: hsla(160, 100%, 37%, 0.55);
  background: hsla(160, 100%, 37%, 0.1);
}

.error {
  margin: 10px 0 0;
  font-size: 12.5px;
  color: hsla(0, 70%, 50%, 1);
}

/* 变更预览 ---------------------------------------------------------- */

.preview {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 16px 0 0;
  padding: 13px 16px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background);
}

.preview dt {
  margin-bottom: 5px;
  font-size: 11.5px;
  opacity: 0.55;
}

.preview dd {
  margin: 0;
  font-size: 14px;
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.preview dd b {
  color: var(--color-heading);
  font-weight: 700;
}

.arrow {
  margin: 0 3px;
  opacity: 0.5;
}

.muted {
  opacity: 0.45;
}

.hint {
  margin: 12px 0 20px;
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

.btn--primary {
  color: #fff;
  background: hsla(160, 100%, 37%, 1);
}

.btn--primary:hover:not(:disabled) {
  background: hsla(160, 100%, 32%, 1);
}

.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 560px) {
  .dialog {
    padding: 18px;
  }
  .preview {
    grid-template-columns: 1fr;
    gap: 10px;
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
