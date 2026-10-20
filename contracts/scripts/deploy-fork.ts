import { ethers, network } from 'hardhat'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * 本地 fork 一键部署 + 播种。
 *
 *   npx hardhat run scripts/deploy-fork.ts --network localhost
 *
 * 顺序 = deploy-mainnet.ts + deploy-staking.ts（地址不再靠手填 .env），
 * 外加三步「让流程在 fork 上真正跑得通」的播种：
 *   1. 把主网上真实存在、且由 EOA 持有的已注册矿机转给部署者（前端要能读到「我的矿机」）
 *   2. 给金库铸一笔 BEM（真实入口是 mining.claim → 由挖矿合约铸造，这里直接借它的 minter 权限）
 *   3. 把地址写进前端 .env.local（VITE_POD_*）
 *
 * 部署者 = Hardhat Account #0，同时也是 owner：前端连这个钱包就能走完
 * 质押 / 抵押 / 领取 / 赎回，外加 owner 专属的「发放收益」。
 */

const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46'
const BEM = '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'
const CPU_BEHEMOTH = '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C'
const CPU_TAPEOUT = '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C'

/** fork 块高：前端日志扫描的起点（全历史扫描会打爆公开 RPC） */
const FORK_BLOCK = Number(process.env.FORK_BLOCK || 128705124)

/** 主网上真实持有者（EOA），矿机已在挖矿合约注册且 status=1 */
const SEED_MINERS: Array<{ cpu: string; id: bigint; holder: string }> = [
  { cpu: CPU_BEHEMOTH, id: 1n, holder: '0x7425bdd73ca0ece0cee1e71a9745e4ec20012f1d' },
  { cpu: CPU_TAPEOUT, id: 17993n, holder: '0x4759472fac9084ef1a919848e7740c915143a4b4' },
]

/** 播种给金库的 BEM（8 decimals），用于 distributeRewards 划拨 */
const SEED_BEM = 500n * 10n ** 8n

const ERC721_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function transferFrom(address,address,uint256)',
]
const ERC20_ABI = ['function mint(address,uint256)', 'function balanceOf(address) view returns (uint256)']

async function impersonate(who: string) {
  await network.provider.request({ method: 'hardhat_impersonateAccount', params: [who] })
  await network.provider.send('hardhat_setBalance', [who, '0x56BC75E2D63100000'])
  return ethers.getSigner(who)
}

/** 合并写入前端 .env.local（保留文件里其它键） */
function writeFrontendEnv(addresses: Record<string, string>) {
  const file = resolve(__dirname, '..', '..', '.env.local')
  const lines: string[] = []
  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const key = line.split('=')[0]?.trim()
      if (key && !(key in addresses) && line.trim()) lines.push(line)
    }
  }
  for (const [key, value] of Object.entries(addresses)) lines.push(`${key}=${value}`)
  writeFileSync(file, lines.join('\n') + '\n', 'utf8')
  console.log('frontend env ->', file)
}

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('network:', network.name)
  console.log('deployer:', deployer.address)
  console.log('balance:', (await ethers.provider.getBalance(deployer.address)).toString())
  const block = await ethers.provider.getBlockNumber()
  console.log('block:', block)

  /* ---------------- 1. 合约（= deploy-mainnet + deploy-staking） ---------------- */

  const xNand = await ethers.deployContract('XNAND')
  await xNand.waitForDeployment()
  const xLatch = await ethers.deployContract('XLATCH')
  await xLatch.waitForDeployment()

  const decomposer = await ethers.deployContract('MinerDecomposer', [
    MINING,
    await xNand.getAddress(),
    await xLatch.getAddress(),
    BEM,
    deployer.address,
  ])
  await decomposer.waitForDeployment()
  const decoAddr = await decomposer.getAddress()

  await (await xNand.setMinter(decoAddr)).wait()
  await (await xNand.lockMinter()).wait()
  await (await xLatch.setMinter(decoAddr)).wait()
  await (await xLatch.lockMinter()).wait()
  console.log('XNAND:', await xNand.getAddress())
  console.log('XLATCH:', await xLatch.getAddress())

  for (const cpu of [CPU_BEHEMOTH, CPU_TAPEOUT]) {
    await (await decomposer.setCpu(cpu, true)).wait()
  }
  console.log('MinerDecomposer:', decoAddr)

  const staking = await ethers.deployContract('XTokenStaking', [
    await xNand.getAddress(),
    await xLatch.getAddress(),
    decoAddr,
    deployer.address,
  ])
  await staking.waitForDeployment()
  const stakingAddr = await staking.getAddress()
  await (await decomposer.setRewardPayer(stakingAddr)).wait()
  console.log('XTokenStaking:', stakingAddr)

  /* ---------------- 2. 播种：把矿机转给部署者 ---------------- */

  for (const m of SEED_MINERS) {
    const nft = new ethers.Contract(m.cpu, ERC721_ABI, ethers.provider)
    const owner = (await nft.ownerOf(m.id)) as string
    if (owner.toLowerCase() === deployer.address.toLowerCase()) {
      console.log(`miner ${m.cpu} #${m.id}: already with deployer`)
      continue
    }
    if (owner.toLowerCase() !== m.holder.toLowerCase()) {
      console.log(`miner ${m.cpu} #${m.id}: 跳过，当前 owner=${owner} 与预期 ${m.holder} 不符`)
      continue
    }
    const signer = await impersonate(owner)
    await (await nft.connect(signer).transferFrom(owner, deployer.address, m.id)).wait()
    console.log(`miner ${m.cpu} #${m.id}: ${owner} -> ${deployer.address}`)
  }

  /* ---------------- 3. 播种：金库 BEM ---------------- */

  const bem = new ethers.Contract(BEM, ERC20_ABI, ethers.provider)
  const before = (await bem.balanceOf(decoAddr)) as bigint
  if (before < SEED_BEM) {
    const minter = await impersonate(MINING)
    await (await bem.connect(minter).mint(decoAddr, SEED_BEM - before)).wait()
  }
  console.log('decomposer BEM:', (await bem.balanceOf(decoAddr)).toString())

  /* ---------------- 4. 回写前端配置 ---------------- */

  writeFrontendEnv({
    VITE_POD_RPC: 'http://127.0.0.1:8545',
    VITE_POD_FROMBLOCK: String(FORK_BLOCK),
    VITE_POD_DECOMPOSER: decoAddr,
    VITE_POD_STAKING: stakingAddr,
    VITE_POD_XNAND: await xNand.getAddress(),
    VITE_POD_XLATCH: await xLatch.getAddress(),
  })

  console.log('\nDone. 前端用 Account #0 连接即可（Private Key 见 hardhat node 输出）。')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
