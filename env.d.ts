/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_POD_RPC?: string
  readonly VITE_POD_CFG?: string
  /** fork / 本地链：日志扫描起点（全历史扫描会打爆公开 RPC） */
  readonly VITE_POD_FROMBLOCK?: string
  readonly VITE_POD_DECOMPOSER?: string
  readonly VITE_POD_STAKING?: string
  readonly VITE_POD_XNAND?: string
  readonly VITE_POD_XLATCH?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>
  on?(event: string, listener: (...args: unknown[]) => void): void
  removeListener?(event: string, listener: (...args: unknown[]) => void): void
}

interface Window {
  ethereum?: Eip1193Provider
}
