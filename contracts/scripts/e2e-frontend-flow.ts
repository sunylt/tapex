import { ethers } from 'hardhat'

/**
 * 按前端 UI 的调用顺序，在 fork 上端到端跑一遍完整流程：
 *
 *   拆解矿机 → 抵押 xNAND/xLATCH → owner 发放收益 → 领取收益
 *   → 解押 → 赎回矿机
 *
 *   npx hardhat run scripts/e2e-frontend-flow.ts --network localhost
 *
 * 前置：先跑过 scripts/deploy-fork.ts（地址与 .env.local 一致）。
 * 可断点续跑：每步先读链上状态，已完成的步骤自动跳过。
 * fork 上游 RPC 偶发 429 / 超时，读写都带重试。
 */

const MINING = '0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46'
const DECOMPOSER = '0x1E552327b0a4DdA816B3F8B1011F4d47789bDa6D'
const STAKING = '0xf84C02C69C4CEed9973b165Fd9F7a713d66cC210'
const XNAND = '0x6D33b2F21405D4E238A3bC636F75a4c6019812ee'
const XLATCH = '0x889369D87465Fa2A779f9D3945cbE2c5Ef9ed524'
const CPU_BEHEMOTH = '0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C'
const MINER_ID = 1n

const DECOMPOSER_ABI = [
  'function stake(address,uint256)',
  'function redeem(address,uint256)',
  'function stakedCount() view returns (uint256)',
  'function stakes(bytes32) view returns (address cpu,uint256 id,address depositor,uint256 nandAmount,uint256 latchAmount)',
  'function distributeRewards(uint256)',
  'function owner() view returns (address)',
  'function rewardPayer() view returns (address)',
  'function rewardToken() view returns (address)',
  'function reservedRewards() view returns (uint256)',
]
const STAKING_ABI = [
  'function stake(address,uint256)',
  'function unstake(address,uint256)',
  'function claim()',
  'function earned(address) view returns (uint256)',
  'function stakedOf(address) view returns (uint256,uint256)',
  'function totalWeight() view returns (uint256)',
]
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address,address) view returns (uint256)',
  'function approve(address,uint256) returns (bool)',
]
const ERC721_ABI = [
  'function ownerOf(uint256) view returns (address)',
  'function getApproved(uint256) view returns (address)',
  'function approve(address,uint256)',
]
const MINING_ABI = ['function minerKey(address,uint256) pure returns (bytes32)']

const ZERO = '0x0000000000000000000000000000000000000000'
const BEM_DECIMALS = 8n
const ok = (label: string) => console.log(`  ✔ ${label}`)
const skip = (label: string) => console.log(`  · 跳过（已完成）：${label}`)
const fail = (label: string, detail: unknown): never => {
  console.error(`  ✘ ${label}:`, detail)
  process.exitCode = 1
  throw new Error(label)
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** fork 上游偶发 429/超时：统一重试 */
async function retry<T>(label: string, fn: () => Promise<T>, tries = 5): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < tries; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i === tries - 1) break
      const wait = 2000 * (i + 1)
      const msg = err instanceof Error ? err.message.split('\n')[0] : String(err)
      console.log(`  … ${label}: ${msg}（${wait / 1000}s 后重试 ${i + 1}/${tries - 1}）`)
      await sleep(wait)
    }
  }
  throw lastErr
}

async function main() {
  const [user] = await ethers.getSigners()
  const me = await user.getAddress()
  console.log(`signer = ${me}`)

  const decomposer = new ethers.Contract(DECOMPOSER, DECOMPOSER_ABI, user)
  const staking = new ethers.Contract(STAKING, STAKING_ABI, user)
  const xnand = new ethers.Contract(XNAND, ERC20_ABI, user)
  const xlatch = new ethers.Contract(XLATCH, ERC20_ABI, user)
  const cpu = new ethers.Contract(CPU_BEHEMOTH, ERC721_ABI, user)
  const mining = new ethers.Contract(MINING, MINING_ABI, user)
  const call = <T>(label: string, fn: () => Promise<T>) => retry(label, fn)
  const send = (label: string, fn: () => Promise<{ wait: () => Promise<unknown> }>) =>
    retry(label, async () => {
      const tx = await fn()
      return tx.wait()
    })
  const bemAddress = await call('rewardToken()', () => decomposer.rewardToken() as Promise<string>)
  const bem = new ethers.Contract(bemAddress, ERC20_ABI, user)

  /* 前置检查 ---------------------------------------------------------- */
  const owner = await call('owner()', () => decomposer.owner() as Promise<string>)
  if (owner.toLowerCase() !== me.toLowerCase()) fail('owner is not signer', owner)
  const payer = await call('rewardPayer()', () => decomposer.rewardPayer() as Promise<string>)
  if (payer.toLowerCase() !== STAKING.toLowerCase()) fail('rewardPayer != staking', payer)
  ok(`前置检查通过（owner=${me.slice(0, 10)}…, rewardPayer 已指向质押池）`)

  const key = await call('minerKey()', () => mining.minerKey(CPU_BEHEMOTH, MINER_ID) as Promise<string>)
  let record = await call('stakes(key)', () =>
    decomposer.stakes(key) as Promise<{ cpu: string; id: bigint; depositor: string; nandAmount: bigint; latchAmount: bigint }>,
  )

  /* 1. 拆解矿机（UI: 拆解确认 → stakeMiner） -------------------------- */
  if (record.depositor.toLowerCase() === ZERO) {
    const approved = await call('getApproved()', () => cpu.getApproved(MINER_ID) as Promise<string>)
    if (approved.toLowerCase() !== DECOMPOSER.toLowerCase()) {
      await send('ERC721 approve', () => cpu.approve(DECOMPOSER, MINER_ID))
      ok('ERC721 approve（前端会自动补这一步）')
    }
    await send('decomposer.stake', () => decomposer.stake(CPU_BEHEMOTH, MINER_ID))
    record = await call('stakes(key)', () => decomposer.stakes(key) as Promise<typeof record>)
    ok(`拆解成功：铸造 xNAND ${record.nandAmount} / xLATCH ${record.latchAmount}，NFT 已托管进金库`)
  } else {
    skip('拆解矿机')
  }
  if ((await call('ownerOf()', () => cpu.ownerOf(MINER_ID) as Promise<string>)) !== DECOMPOSER) {
    fail('NFT not escrowed')
  }
  const mintedNand = record.nandAmount
  const mintedLatch = record.latchAmount
  const [nandWallet, latchWallet, staked0] = await Promise.all([
    call('xNAND.balanceOf', () => xnand.balanceOf(me) as Promise<bigint>),
    call('xLATCH.balanceOf', () => xlatch.balanceOf(me) as Promise<bigint>),
    call('stakedOf()', () => staking.stakedOf(me) as Promise<[bigint, bigint]>),
  ])
  let [stakedNand, stakedLatch] = staked0
  // 钱包 + 在押池 == 拆解价（断点续跑时可能有一半已经进池了）
  if (nandWallet + stakedNand !== mintedNand || latchWallet + stakedLatch !== mintedLatch) {
    fail('wallet + staked != stake price', {
      nandWallet,
      latchWallet,
      stakedNand,
      stakedLatch,
      mintedNand,
      mintedLatch,
    })
  }

  /* 2. 抵押 xNAND / xLATCH（UI: 抵押确认 → stakeX） ------------------- */
  const wantNand = mintedNand / 2n
  const wantLatch = mintedLatch / 2n
  for (const [token, contract, want, staked] of [
    [XNAND, xnand, wantNand, stakedNand],
    [XLATCH, xlatch, wantLatch, stakedLatch],
  ] as const) {
    const amount = want > staked ? want - staked : 0n
    if (amount === 0n) continue
    const allowance = await call('allowance()', () => contract.allowance(me, STAKING) as Promise<bigint>)
    if (allowance < amount) await send('approve(staking)', () => contract.approve(STAKING, ethers.MaxUint256))
    await send(`staking.stake(${token === XNAND ? 'xNAND' : 'xLATCH'})`, () => staking.stake(token, amount))
    ok(`抵押成功：${token === XNAND ? 'xNAND' : 'xLATCH'} ${amount}`)
  }
  ;[stakedNand, stakedLatch] = (await call('stakedOf()', () =>
    staking.stakedOf(me) as Promise<[bigint, bigint]>,
  )) as [bigint, bigint]
  if (stakedNand !== wantNand || stakedLatch !== wantLatch) fail('stakedOf mismatch', {
    stakedNand,
    stakedLatch,
    wantNand,
    wantLatch,
  })

  /* 3. owner 发放收益（UI: 发放收益 → distributeAllRewards） ----------- */
  const earnedBefore = await call('earned()', () => staking.earned(me) as Promise<bigint>)
  const reserved = await call('reservedRewards()', () => decomposer.reservedRewards() as Promise<bigint>)
  const vaultBem = await call('BEM.balanceOf(vault)', () => bem.balanceOf(DECOMPOSER) as Promise<bigint>)
  const free = vaultBem > reserved ? vaultBem - reserved : 0n
  if (free > 0n && (await call('totalWeight()', () => staking.totalWeight() as Promise<bigint>)) > 0n) {
    await send('distributeRewards', () => decomposer.distributeRewards(free))
    ok(`发放收益：${free / 10n ** BEM_DECIMALS} BEM 已划拨给质押池`)
  } else if (earnedBefore > 0n || reserved > 0n) {
    skip('发放收益（额度已划拨）')
  } else {
    fail('nothing to distribute and nothing earned', { free, reserved, earnedBefore })
  }

  /* 4. 领取质押收益（UI: 领取 → claimStakingRewards） ------------------ */
  const earned = await call('earned()', () => staking.earned(me) as Promise<bigint>)
  if (earned > 0n) {
    const bemBefore = await call('BEM.balanceOf(me)', () => bem.balanceOf(me) as Promise<bigint>)
    await send('staking.claim', () => staking.claim())
    const got = (await call('BEM.balanceOf(me)', () => bem.balanceOf(me) as Promise<bigint>)) - bemBefore
    if (got !== earned) fail('claim paid wrong amount', { earned, got })
    if ((await call('earned()', () => staking.earned(me) as Promise<bigint>)) !== 0n) fail('earned not zeroed')
    ok(`领取成功：到账 ${got} BEM`)
  } else {
    skip('领取质押收益（无可领）')
  }

  /* 5. 解押（UI: 解押确认 → unstakeX） -------------------------------- */
  if (stakedNand > 0n) await send('staking.unstake(xNAND)', () => staking.unstake(XNAND, stakedNand))
  if (stakedLatch > 0n) await send('staking.unstake(xLATCH)', () => staking.unstake(XLATCH, stakedLatch))
  const stakedAfter = (await call('stakedOf()', () => staking.stakedOf(me) as Promise<[bigint, bigint]>)) as [
    bigint,
    bigint,
  ]
  if (stakedAfter[0] !== 0n || stakedAfter[1] !== 0n) fail('unstake incomplete', stakedAfter)
  ok('解押成功：xNAND / xLATCH 全部回到钱包')

  /* 6. 赎回矿机（UI: 赎回确认 → redeemMiner） ------------------------- */
  if ((await call('ownerOf()', () => cpu.ownerOf(MINER_ID) as Promise<string>)).toLowerCase() === me.toLowerCase()) {
    skip('赎回矿机')
  } else {
    for (const [token, contract, amount] of [
      [XNAND, xnand, mintedNand],
      [XLATCH, xlatch, mintedLatch],
    ] as const) {
      const allowance = await call('allowance()', () => contract.allowance(me, DECOMPOSER) as Promise<bigint>)
      if (allowance < amount) await send('approve(decomposer)', () => contract.approve(DECOMPOSER, ethers.MaxUint256))
    }
    await send('decomposer.redeem', () => decomposer.redeem(CPU_BEHEMOTH, MINER_ID))
    ok('赎回成功：NFT 回到钱包，xNAND / xLATCH 全部烧毁，矿池清空')
  }

  /* 终态断言 ---------------------------------------------------------- */
  const [finalNft, finalCount, finalNand, finalLatch] = await Promise.all([
    call('ownerOf()', () => cpu.ownerOf(MINER_ID) as Promise<string>),
    call('stakedCount()', () => decomposer.stakedCount() as Promise<bigint>),
    call('xNAND.balanceOf', () => xnand.balanceOf(me) as Promise<bigint>),
    call('xLATCH.balanceOf', () => xlatch.balanceOf(me) as Promise<bigint>),
  ])
  if (finalNft.toLowerCase() !== me.toLowerCase()) fail('final: NFT not with user', finalNft)
  if (finalCount !== 0n) fail('final: stakedCount != 0', finalCount)
  if (finalNand !== 0n || finalLatch !== 0n) fail('final: x tokens not burned', { finalNand, finalLatch })

  console.log('\n全部通过 ✔ 拆解 → 抵押 → 发放 → 领取 → 解押 → 赎回')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
