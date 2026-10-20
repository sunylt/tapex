<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import { storeToRefs } from 'pinia'

import { POD_CONFIG } from '@/pod/config'
import { hasInjectedWallet, shortAddress } from '@/pod/service'
import { useMiningStore } from '@/stores/mining'

const store = useMiningStore()
const { address, connecting, connected, onCorrectChain } = storeToRefs(store)

const walletAvailable = hasInjectedWallet()
const menuOpen = ref(false)
const copied = ref(false)
const notice = ref<string | null>(null)

let noticeTimer: ReturnType<typeof setTimeout> | null = null
let copyTimer: ReturnType<typeof setTimeout> | null = null

const shortAddr = computed(() => shortAddress(address.value ?? ''))
const fullAddr = computed(() => address.value ?? '')
const explorerUrl = computed(() => `${POD_CONFIG.explorer}/address/${address.value ?? ''}`)

function showNotice(message: string) {
  notice.value = message
  if (noticeTimer) clearTimeout(noticeTimer)
  noticeTimer = setTimeout(() => (notice.value = null), 5000)
}

async function connect() {
  notice.value = null
  await store.connect()
  if (!store.connected && store.error) showNotice(store.error)
}

async function switchNetwork() {
  store.error = null
  notice.value = null
  await store.switchToBsc()
  if (store.error) showNotice(store.error)
}

function toggleMenu() {
  menuOpen.value = !menuOpen.value
  copied.value = false
}

function closeMenu() {
  menuOpen.value = false
  copied.value = false
}

async function copyAddress() {
  if (!address.value) return
  try {
    await navigator.clipboard.writeText(address.value)
    copied.value = true
    if (copyTimer) clearTimeout(copyTimer)
    copyTimer = setTimeout(() => (copied.value = false), 1600)
  } catch {
    showNotice('复制失败，请手动复制地址')
  }
}

function disconnect() {
  store.disconnect()
  closeMenu()
}

function onDocumentClick(event: MouseEvent) {
  const target = event.target
  if (target instanceof Element && target.closest('.wallet')) return
  closeMenu()
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick)
  if (noticeTimer) clearTimeout(noticeTimer)
  if (copyTimer) clearTimeout(copyTimer)
})
</script>

<template>
  <header class="site-header">
    <div class="site-header__inner">
      <RouterLink to="/" class="brand" aria-label="TAPEX 首页">
        <svg class="brand__mark" viewBox="0 0 32 32" aria-hidden="true">
          <defs>
            <linearGradient id="tapex-mark" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stop-color="hsl(160, 100%, 40%)" />
              <stop offset="100%" stop-color="hsl(190, 95%, 44%)" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="32" height="32" rx="9" fill="url(#tapex-mark)" />
          <path d="M16 7.2 25.4 23H6.6z" fill="#fff" fill-opacity="0.94" />
        </svg>
        <span class="brand__name">TAPEX</span>
      </RouterLink>

      <nav class="nav">
        <RouterLink class="nav__link" to="/">矿池</RouterLink>
        <RouterLink class="nav__link" to="/trade">交易</RouterLink>
        <RouterLink class="nav__link" to="/pod">我的</RouterLink>
        <RouterLink class="nav__link" to="/about">文档</RouterLink>
      </nav>

      <div class="wallet">
        <a
          v-if="!walletAvailable"
          class="wallet__btn wallet__btn--ghost"
          href="https://metamask.io/download/"
          target="_blank"
          rel="noopener"
        >
          安装钱包
        </a>

        <button v-else-if="!connected" class="wallet__btn" :disabled="connecting" @click="connect">
          <svg class="wallet__icon" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linejoin="round"
            />
            <circle cx="16.5" cy="12" r="1.4" fill="currentColor" />
          </svg>
          {{ connecting ? '连接中…' : '连接钱包' }}
        </button>

        <template v-else>
          <button
            v-if="!onCorrectChain"
            class="wallet__btn wallet__btn--warn"
            @click="switchNetwork"
          >
            切换至 BSC
          </button>

          <button
            class="wallet__btn wallet__btn--account"
            :class="{ 'is-open': menuOpen }"
            :aria-expanded="menuOpen"
            :title="fullAddr"
            @click="toggleMenu"
          >
            <span class="dot" :class="{ 'dot--warn': !onCorrectChain }" />
            <span class="mono">{{ shortAddr }}</span>
            <svg class="caret" viewBox="0 0 12 12" aria-hidden="true">
              <path
                d="M2.5 4.5 6 8l3.5-3.5"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>

          <div v-if="menuOpen" class="menu" role="menu">
            <div class="menu__head">
              <span class="menu__label">已连接</span>
              <span class="mono menu__addr">{{ fullAddr }}</span>
            </div>
            <button class="menu__item" role="menuitem" @click="copyAddress">
              {{ copied ? '✓ 已复制' : '复制地址' }}
            </button>
            <a
              class="menu__item"
              role="menuitem"
              :href="explorerUrl"
              target="_blank"
              rel="noopener"
              @click="closeMenu"
            >
              在区块浏览器中查看
            </a>
            <button class="menu__item menu__item--danger" role="menuitem" @click="disconnect">
              断开连接
            </button>
          </div>
        </template>

        <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      </div>
    </div>
  </header>
</template>

<style scoped>
.site-header {
  position: sticky;
  top: 0;
  z-index: 30;
  margin: 0 -2rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-background);
  background: color-mix(in srgb, var(--color-background) 82%, transparent);
  backdrop-filter: blur(14px) saturate(150%);
}

.site-header__inner {
  display: flex;
  align-items: center;
  gap: 24px;
  min-height: 64px;
  padding: 10px 2rem;
  flex-wrap: wrap;
}

/* Brand ------------------------------------------------------------- */

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 0;
  color: var(--color-heading);
  font-weight: 800;
}

.brand:hover {
  background-color: transparent;
}

.brand__mark {
  width: 32px;
  height: 32px;
  border-radius: 9px;
  box-shadow: 0 4px 12px hsla(165, 100%, 37%, 0.28);
  flex: none;
}

.brand__name {
  font-size: 20px;
  font-weight: 800;
  letter-spacing: 0.14em;
}

/* Nav --------------------------------------------------------------- */

.nav {
  display: flex;
  align-items: center;
  gap: 2px;
}

.nav__link {
  padding: 6px 12px;
  border-radius: 999px;
  font-size: 14px;
  color: var(--color-text);
  opacity: 0.78;
  transition:
    opacity 0.2s,
    background-color 0.2s,
    color 0.2s;
}

.nav__link:hover {
  background-color: var(--color-background-mute);
  opacity: 1;
}

.nav__link.router-link-exact-active {
  color: hsla(160, 100%, 32%, 1);
  background-color: hsla(160, 100%, 37%, 0.12);
  opacity: 1;
  font-weight: 600;
}

@media (prefers-color-scheme: dark) {
  .nav__link.router-link-exact-active {
    color: hsla(160, 100%, 60%, 1);
  }
}

/* Wallet ------------------------------------------------------------ */

.wallet {
  position: relative;
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}

.wallet__btn {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  border: 1px solid transparent;
  border-radius: 999px;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 600;
  font-family: inherit;
  color: #fff;
  background: hsla(160, 100%, 37%, 1);
  transition:
    opacity 0.2s,
    background-color 0.2s,
    border-color 0.2s;
}

.wallet__btn:hover:not(:disabled) {
  background: hsla(160, 100%, 32%, 1);
}

.wallet__btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.wallet__icon {
  width: 18px;
  height: 18px;
}

.wallet__btn--ghost {
  color: var(--color-text);
  background: transparent;
  border-color: var(--color-border);
}

.wallet__btn--ghost:hover:not(:disabled) {
  background: var(--color-background-mute);
  border-color: var(--color-border-hover);
}

.wallet__btn--warn {
  background: hsla(38, 92%, 48%, 1);
}

.wallet__btn--warn:hover:not(:disabled) {
  background: hsla(38, 92%, 42%, 1);
}

.wallet__btn--account {
  color: var(--color-text);
  background: transparent;
  border-color: var(--color-border);
  font-weight: 500;
}

.wallet__btn--account:hover:not(:disabled),
.wallet__btn--account.is-open {
  background: var(--color-background-mute);
  border-color: var(--color-border-hover);
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: hsla(160, 100%, 37%, 1);
  box-shadow: 0 0 0 3px hsla(160, 100%, 37%, 0.18);
  flex: none;
}

.dot--warn {
  background: hsla(38, 92%, 48%, 1);
  box-shadow: 0 0 0 3px hsla(38, 92%, 48%, 0.2);
}

.caret {
  width: 12px;
  height: 12px;
  opacity: 0.6;
}

.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

/* Dropdown ---------------------------------------------------------- */

.menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 260px;
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: 1px solid var(--color-border);
  border-radius: 12px;
  background: var(--color-background-soft);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.18);
  z-index: 40;
}

.menu__head {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 10px 10px;
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 4px;
}

.menu__label {
  font-size: 11px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  opacity: 0.55;
}

.menu__addr {
  font-size: 12px;
  word-break: break-all;
  opacity: 0.85;
}

.menu__item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 9px 10px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--color-text);
  font-family: inherit;
  font-size: 14px;
  cursor: pointer;
  transition: background-color 0.15s;
}

.menu__item:hover {
  background-color: var(--color-background-mute);
}

.menu__item--danger {
  color: hsla(0, 75%, 48%, 1);
}

/* Notice ------------------------------------------------------------ */

.notice {
  position: absolute;
  top: calc(100% + 10px);
  right: 0;
  margin: 0;
  max-width: 320px;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: 10px;
  background: var(--color-background-soft);
  box-shadow: 0 10px 26px rgba(0, 0, 0, 0.16);
  font-size: 13px;
  z-index: 40;
}

/* Responsive -------------------------------------------------------- */

@media (max-width: 640px) {
  .site-header__inner {
    gap: 12px;
    padding: 10px 1rem;
  }
  .nav {
    order: 3;
    width: 100%;
    margin: 0 -2px 4px;
    overflow-x: auto;
  }
  .brand__name {
    font-size: 18px;
  }
  .wallet__btn {
    padding: 7px 12px;
    font-size: 13px;
  }
}
</style>
