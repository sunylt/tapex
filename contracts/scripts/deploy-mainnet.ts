import { ethers } from 'hardhat'

async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying with:', deployer.address)
  console.log('Balance:', (await ethers.provider.getBalance(deployer.address)).toString())

  const MINING_ADDR = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46'
  // BEM（挖矿收益代币）：矿池把在押矿机的收益收在这里，也是质押池的奖励来源。
  const REWARD_TOKEN_ADDR =
    process.env.BEM_ADDR || '0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a'

  const xNand = await ethers.deployContract('XNAND')
  await xNand.waitForDeployment()
  const xNandAddr = await xNand.getAddress()
  console.log('XNAND:', xNandAddr)

  const xLatch = await ethers.deployContract('XLATCH')
  await xLatch.waitForDeployment()
  const xLatchAddr = await xLatch.getAddress()
  console.log('XLATCH:', xLatchAddr)

  const decomposer = await ethers.deployContract('MinerDecomposer', [
    MINING_ADDR,
    xNandAddr,
    xLatchAddr,
    REWARD_TOKEN_ADDR,
    deployer.address,
  ])
  await decomposer.waitForDeployment()
  const decoAddr = await decomposer.getAddress()
  console.log('MinerDecomposer:', decoAddr)

  await (await xNand.setMinter(decoAddr)).wait()
  await (await xNand.lockMinter()).wait()
  console.log('XNAND: minter set & locked')

  await (await xLatch.setMinter(decoAddr)).wait()
  await (await xLatch.lockMinter()).wait()
  console.log('XLATCH: minter set & locked')

  const cpuList = [
    '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C',
    '0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C',
  ]
  for (const c of cpuList) {
    await (await decomposer.setCpu(c, true)).wait()
    console.log('setCpu:', c)
  }

  console.log('Done!')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
