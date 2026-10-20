import { HardhatUserConfig } from 'hardhat/config'
import '@nomicfoundation/hardhat-toolbox'
import * as dotenv from 'dotenv'

dotenv.config()

const forkUrl = process.env.FORK_RPC
const forkBlock = process.env.FORK_BLOCK ? Number(process.env.FORK_BLOCK) : undefined

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.28',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'cancun',
    },
  },
  networks: {
    hardhat: {
      // 与前端 / MetaMask 的 BSC 链 ID 保持一致（POD_CONFIG.chainId = 56）
      chainId: 56,
      ...(forkUrl ? { forking: { url: forkUrl, blockNumber: forkBlock } } : {}),
    },
    bsc: {
      url: process.env.BSC_RPC || 'https://bsc-dataseed.binance.org/',
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [],
      chainId: 56,
    },
  },
}

export default config
