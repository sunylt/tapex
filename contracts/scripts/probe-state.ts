import { ethers } from 'hardhat'

const DECOMPOSER = '0x1E552327b0a4DdA816B3F8B1011F4d47789bDa6D'
const STAKING = '0xf84C02C69C4CEed9973b165Fd9F7a713d66cC210'

async function main() {
  const [user] = await ethers.getSigners()
  const me = await user.getAddress()
  const decomposer = new ethers.Contract(
    DECOMPOSER,
    ['function reservedRewards() view returns (uint256)', 'function rewardToken() view returns (address)', 'function stakedCount() view returns (uint256)'],
    ethers.provider,
  )
  const staking = new ethers.Contract(STAKING, ['function totalWeight() view returns (uint256)'], ethers.provider)
  const bem = new ethers.Contract(await decomposer.rewardToken(), ['function balanceOf(address) view returns (uint256)'], ethers.provider)
  const [reserved, vaultBem, userBem, count, weight] = await Promise.all([
    decomposer.reservedRewards() as Promise<bigint>,
    bem.balanceOf(DECOMPOSER) as Promise<bigint>,
    bem.balanceOf(me) as Promise<bigint>,
    decomposer.stakedCount() as Promise<bigint>,
    staking.totalWeight() as Promise<bigint>,
  ])
  console.log(`vault BEM balance = ${vaultBem}`)
  console.log(`reservedRewards   = ${reserved}`)
  console.log(`vault free (可发放) = ${vaultBem > reserved ? vaultBem - reserved : 0n}`)
  console.log(`user BEM          = ${userBem}`)
  console.log(`stakedCount       = ${count}, totalWeight = ${weight}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
