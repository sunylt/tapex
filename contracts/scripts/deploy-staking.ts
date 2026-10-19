import { ethers } from 'hardhat'

/**
 * 部署 XTokenStaking（xNAND / xLATCH 质押池），并把它登记为矿池的奖励发放方。
 *
 * 需要先在 `.env` 里给出已经部署好的地址：
 *   XNAND_ADDR / XLATCH_ADDR / DECOMPOSER_ADDR(MinerDecomposer)
 *
 * 说明：奖励不再需要转进质押池。BEM 一直留在 MinerDecomposer，
 * 由 pool(owner) 调 `staking.notifyReward(amount)` 划拨额度，
 * 用户 claim 时由质押池调用 `MinerDecomposer.payReward()` 直接付给用户。
 */
async function main() {
  const [deployer] = await ethers.getSigners()
  console.log('Deploying with:', deployer.address)
  console.log('Balance:', (await ethers.provider.getBalance(deployer.address)).toString())

  const xNand = process.env.XNAND_ADDR
  const xLatch = process.env.XLATCH_ADDR
  const decomposerAddr = process.env.DECOMPOSER_ADDR
  if (!xNand || !xLatch || !decomposerAddr) {
    throw new Error('请在 .env 配置 XNAND_ADDR / XLATCH_ADDR / DECOMPOSER_ADDR')
  }

  const staking = await ethers.deployContract('XTokenStaking', [
    xNand,
    xLatch,
    decomposerAddr,
    deployer.address,
  ])
  await staking.waitForDeployment()
  const stakingAddr = await staking.getAddress()

  console.log('XTokenStaking:', stakingAddr)
  console.log('  xNAND :', await staking.xNand())
  console.log('  xLATCH:', await staking.xLatch())
  console.log('  pool  :', await staking.pool())
  console.log('  reward:', await staking.rewardToken())
  console.log('  owner :', await staking.owner())
  console.log('  durations:', (await staking.rewardsDuration()).toString(), 'seconds')

  const decomposer = await ethers.getContractAt('MinerDecomposer', decomposerAddr)
  await (await decomposer.setRewardPayer(stakingAddr)).wait()
  console.log('MinerDecomposer.rewardPayer ->', stakingAddr)

  console.log('Done!')
  console.log('下一步：给质押池注入一轮收益')
  console.log('  staking.notifyReward(amount)   // 矿池余额需 >= amount')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
