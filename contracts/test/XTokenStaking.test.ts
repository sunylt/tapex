import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const WEEK = 7n * 24n * 60n * 60n;
const PRECISION = 10n ** 18n;
/** MockBEM uses 18 decimals. */
const REWARD = ethers.parseEther("7000");

describe("XTokenStaking (即时累加模型)", () => {
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    const bem = await ethers.deployContract("MockBEM");
    const mining = await ethers.deployContract("MockMining", [await bem.getAddress()]);
    const circuit = await ethers.deployContract("MockCircuit", ["Behemoth"]);
    const xNand = await ethers.deployContract("XNAND");
    const xLatch = await ethers.deployContract("XLATCH");

    // 矿池（MinerDecomposer）产生并持有 BEM，是质押池的奖励来源。
    const pool = await ethers.deployContract("MinerDecomposer", [
      await mining.getAddress(),
      await xNand.getAddress(),
      await xLatch.getAddress(),
      await bem.getAddress(),
      owner.address,
    ]);
    const poolAddr = await pool.getAddress();

    const staking = await ethers.deployContract("XTokenStaking", [
      await xNand.getAddress(),
      await xLatch.getAddress(),
      poolAddr,
      owner.address,
    ]);
    const addr = await staking.getAddress();
    await pool.setRewardPayer(addr);

    // Fund the stakers with x-tokens straight from the minter.
    await xNand.setMinter(owner.address);
    await xLatch.setMinter(owner.address);
    await xNand.mint(alice.address, 1_000);
    await xLatch.mint(alice.address, 1_000);
    await xNand.mint(bob.address, 1_000);
    await xLatch.mint(bob.address, 1_000);

    return { owner, alice, bob, bem, mining, circuit, xNand, xLatch, pool, poolAddr, staking, addr };
  }

  async function stake(f: any, user: any, token: "nand" | "latch", amount: bigint) {
    const t = token === "nand" ? f.xNand : f.xLatch;
    await t.connect(user).approve(f.addr, ethers.MaxUint256);
    await f.staking.connect(user).stake(await t.getAddress(), amount);
  }

  /** 模拟运营把 `amount` 收益 claim 进矿池，然后触发一次「全部分配」。 */
  async function distribute(f: any, amount: bigint) {
    await f.bem.mint(f.poolAddr, amount);
    await f.pool.connect(f.owner).distributeRewards();
  }

  it("stakes both tokens and tracks totals + weights", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, xNand, xLatch, staking } = f;

    await stake(f, alice, "nand", 300n);
    await stake(f, alice, "latch", 100n);

    const [nand, latch] = await staking.stakedOf(alice.address);
    expect(nand).to.equal(300n);
    expect(latch).to.equal(100n);
    expect((await staking.accounts(alice.address)).weight).to.equal(400n * PRECISION);

    const [totalNand, totalLatch] = await staking.totalStaked();
    expect(totalNand).to.equal(300n);
    expect(totalLatch).to.equal(100n);
    expect(await staking.totalWeight()).to.equal(400n * PRECISION);

    expect(await xNand.balanceOf(alice.address)).to.equal(700n);
    expect(await xLatch.balanceOf(alice.address)).to.equal(900n);
  });

  it("distributes a reward instantly, proportional to weight (no time travel)", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bob, staking, bem } = f;

    // alice 300 weight, bob 100 weight -> 3:1
    await stake(f, alice, "nand", 300n);
    await stake(f, bob, "nand", 100n);

    await distribute(f, REWARD);

    // 触发后立刻可领，无需等待任何时间。
    const aliceEarned = await staking.earned(alice.address);
    const bobEarned = await staking.earned(bob.address);

    expect(aliceEarned + bobEarned).to.be.closeTo(REWARD, 10n ** 6n);
    expect(aliceEarned).to.be.closeTo((REWARD * 3n) / 4n, 10n ** 6n);
    expect(bobEarned).to.be.closeTo(REWARD / 4n, 10n ** 6n);

    const before = await bem.balanceOf(alice.address);
    await staking.connect(alice).claim();
    expect((await bem.balanceOf(alice.address)) - before).to.equal(aliceEarned);
    expect(await staking.earned(alice.address)).to.equal(0);
  });

  it("accrual has no time component: it only moves when the pool triggers", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, staking } = f;
    await stake(f, alice, "nand", 100n);

    await distribute(f, REWARD);
    const justAfter = await staking.earned(alice.address);
    expect(justAfter).to.be.closeTo(REWARD, 10n ** 6n);

    // 时间流逝不会让收益增长（这与旧的线性释放模型不同）。
    await time.increase(Number(WEEK * 3n));
    expect(await staking.earned(alice.address)).to.equal(justAfter);

    // 再触发一轮才会继续增长。
    await distribute(f, REWARD);
    expect(await staking.earned(alice.address)).to.be.closeTo(REWARD * 2n, 10n ** 6n);
  });

  it("a reward triggered before someone stakes never reaches them", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bob, staking } = f;

    await stake(f, alice, "nand", 100n);
    await distribute(f, REWARD); // 只有 alice 在质押，全部归她
    const aliceBefore = await staking.earned(alice.address);
    expect(aliceBefore).to.be.closeTo(REWARD, 10n ** 6n);

    // bob 之后才加入：拿不到上一轮，只分之后的。
    await stake(f, bob, "nand", 100n);
    expect(await staking.earned(bob.address)).to.equal(0);

    await distribute(f, REWARD);
    const aliceAfter = await staking.earned(alice.address);
    const bobEarned = await staking.earned(bob.address);
    expect(aliceAfter - aliceBefore).to.be.closeTo(REWARD / 2n, 10n ** 6n);
    expect(bobEarned).to.be.closeTo(REWARD / 2n, 10n ** 6n);
  });

  it("unstake returns tokens and stops future accrual, keeping what was earned", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, xNand, staking } = f;
    await stake(f, alice, "nand", 100n);
    await distribute(f, REWARD);

    await staking.connect(alice).unstake(await xNand.getAddress(), 100n);
    expect(await xNand.balanceOf(alice.address)).to.equal(1_000n);

    const earnedAtUnstake = await staking.earned(alice.address);
    expect(earnedAtUnstake).to.be.closeTo(REWARD, 10n ** 6n);
    expect(await staking.totalWeight()).to.equal(0n);

    // 已赚的收益仍然可以领走。
    await time.increase(Number(WEEK));
    expect(await staking.earned(alice.address)).to.equal(earnedAtUnstake);
    await staking.connect(alice).claim();
  });

  it("exit() returns everything and pays the reward", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bem, xNand, xLatch, staking } = f;
    await stake(f, alice, "nand", 120n);
    await stake(f, alice, "latch", 80n);
    await distribute(f, REWARD);

    const before = await bem.balanceOf(alice.address);
    await staking.connect(alice).exit();

    expect(await xNand.balanceOf(alice.address)).to.equal(1_000n);
    expect(await xLatch.balanceOf(alice.address)).to.equal(1_000n);
    expect(await bem.balanceOf(alice.address)).to.be.gt(before);
    const [nand, latch] = await staking.stakedOf(alice.address);
    expect(nand).to.equal(0n);
    expect(latch).to.equal(0n);
    expect(await staking.totalWeight()).to.equal(0n);
  });

  it("respects per-token weights", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bob, staking } = f;

    // xNAND worth 3x xLATCH
    await staking.connect(owner).setWeights(3n * PRECISION, PRECISION);
    await stake(f, alice, "nand", 100n); // weight 300
    await stake(f, bob, "latch", 100n); // weight 100

    await distribute(f, REWARD);

    const a = await staking.earned(alice.address);
    const b = await staking.earned(bob.address);
    expect(a).to.be.closeTo((REWARD * 3n) / 4n, 10n ** 6n);
    expect(b).to.be.closeTo(REWARD / 4n, 10n ** 6n);
  });

  it("sums multiple triggered rounds", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, staking } = f;
    await stake(f, alice, "nand", 100n);

    await distribute(f, REWARD);
    await distribute(f, REWARD);
    await distribute(f, REWARD);

    expect(await staking.earned(alice.address)).to.be.closeTo(REWARD * 3n, 10n ** 6n);
  });

  it("each round goes to exactly whoever is staked at that moment", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bob, xNand, staking } = f;
    const nand = await xNand.getAddress();

    // 第 1 轮：只有 alice 在场
    await stake(f, alice, "nand", 100n);
    await distribute(f, REWARD);
    expect(await staking.earned(alice.address)).to.be.closeTo(REWARD, 10n ** 6n);
    expect(await staking.earned(bob.address)).to.equal(0n);

    // 轮间换人：alice 全退、bob 进来
    await staking.connect(alice).unstake(nand, 100n);
    await stake(f, bob, "nand", 100n);

    // 第 2 轮：只有 bob 在场，全部归 bob
    await distribute(f, REWARD);
    expect(await staking.earned(alice.address)).to.be.closeTo(REWARD, 10n ** 6n); // 没变
    expect(await staking.earned(bob.address)).to.be.closeTo(REWARD, 10n ** 6n);

    // 第 3 轮：alice 再进来（50），bob 还有 100 -> 按 1:2 分
    await stake(f, alice, "nand", 50n);
    await distribute(f, REWARD);
    const aliceDelta = (await staking.earned(alice.address)) - REWARD;
    const bobDelta = (await staking.earned(bob.address)) - REWARD;
    expect(aliceDelta).to.be.closeTo(REWARD / 3n, 10n ** 6n);
    expect(bobDelta).to.be.closeTo((REWARD * 2n) / 3n, 10n ** 6n);
    expect(aliceDelta + bobDelta).to.be.closeTo(REWARD, 10n ** 6n);
  });

  // ------------------------------------------------------------------ //
  // 触发权限 / 边界                                                    //
  // ------------------------------------------------------------------ //

  it("only the owner can trigger a distribution", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, pool } = f;
    await stake(f, alice, "nand", 100n);

    await expect(pool.connect(alice).distributeRewards()).to.be.revertedWithCustomError(
      pool,
      "OwnableUnauthorizedAccount",
    );
  });

  it("cannot trigger while nobody is staked", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, bem, pool, poolAddr, staking } = f;
    await bem.mint(poolAddr, REWARD);
    await expect(
      pool.connect(owner).distributeRewards(),
    ).to.be.revertedWithCustomError(staking, "NoStakers");
  });

  it("reverts when there is nothing new to distribute", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, pool } = f;
    await stake(f, alice, "nand", 100n);
    await expect(
      pool.connect(owner).distributeRewards(),
    ).to.be.revertedWithCustomError(pool, "NothingToDistribute");
  });

  it("notifyReward is callable only by the pool", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, staking } = f;
    await stake(f, alice, "nand", 100n);

    await expect(staking.connect(alice).notifyReward(1n)).to.be.revertedWithCustomError(
      staking,
      "NotRewardSource",
    );
    await expect(staking.connect(owner).notifyReward(1n)).to.be.revertedWithCustomError(
      staking,
      "NotRewardSource",
    );
  });

  // ------------------------------------------------------------------ //
  // 本金安全 / claim 行为                                              //
  // ------------------------------------------------------------------ //

  it("claim settles into `rewards`, pays it out, and zeroes it", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bem, staking } = f;
    await stake(f, alice, "nand", 100n);
    await distribute(f, REWARD);

    const earnedBefore = await staking.earned(alice.address);
    const balanceBefore = await bem.balanceOf(alice.address);
    await staking.connect(alice).claim();

    const accountAfter = await staking.accounts(alice.address);
    expect((await bem.balanceOf(alice.address)) - balanceBefore).to.equal(earnedBefore);
    expect(accountAfter.rewards).to.equal(0n);
    expect(await staking.earned(alice.address)).to.equal(0n);
    expect(accountAfter.nand).to.equal(100n); // 本金完全没动
    expect(accountAfter.weight).to.equal(100n * PRECISION);

    await expect(staking.connect(alice).claim()).to.be.revertedWithCustomError(
      staking,
      "NothingToClaim",
    );
  });

  it("claim still pays out rewards settled before a full unstake", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bem, xNand, staking } = f;
    await stake(f, alice, "nand", 100n);
    await distribute(f, REWARD);

    await staking.connect(alice).unstake(await xNand.getAddress(), 100n);
    const afterUnstake = await staking.earned(alice.address);
    expect(afterUnstake).to.be.gt(0n);
    expect((await staking.accounts(alice.address)).weight).to.equal(0n);

    const before = await bem.balanceOf(alice.address);
    await staking.connect(alice).claim();
    expect((await bem.balanceOf(alice.address)) - before).to.equal(afterUnstake);
  });

  it("never promises more BEM than the pool actually holds", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bob, bem, pool, poolAddr, staking } = f;
    await stake(f, alice, "nand", 300n);
    await stake(f, bob, "latch", 100n);
    await distribute(f, REWARD);

    // 触发时锁定额度：钱还在矿池里
    expect(await pool.reservedRewards()).to.equal(REWARD);
    expect(await bem.balanceOf(await staking.getAddress())).to.equal(0n);

    await staking.connect(alice).claim();
    await staking.connect(bob).claim();

    // 用户领完，划拨额度基本归零（只剩取整灰尘）
    expect(await pool.reservedRewards()).to.be.lt(10n ** 6n);
    // 领完之后矿池里只剩灰尘，且恰好等于 reserved
    expect(await bem.balanceOf(poolAddr)).to.equal(await pool.reservedRewards());
    expect(await bem.balanceOf(alice.address)).to.be.gt(0n);
  });

  it("reserved budget always covers everything still owed", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bob, pool, staking } = f;
    await stake(f, alice, "nand", 300n);
    await stake(f, bob, "latch", 100n);

    const owed = async () =>
      (await staking.earned(alice.address)) + (await staking.earned(bob.address));

    await distribute(f, REWARD);
    expect(await pool.reservedRewards()).to.be.gte(await owed());

    await staking.connect(alice).claim();
    await distribute(f, REWARD);
    expect(await pool.reservedRewards()).to.be.gte(await owed());

    await staking.connect(bob).claim();
    expect(await pool.reservedRewards()).to.be.gte(await owed());
  });

  it("owner cannot withdraw BEM that has been reserved for stakers", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bem, pool, poolAddr, staking } = f;
    await stake(f, alice, "nand", 100n);
    await distribute(f, REWARD);

    // 分配后全部余额都是待发放奖励 -> 一分都提不走
    await expect(
      pool.connect(owner).withdraw(await bem.getAddress(), owner.address, 1n),
    ).to.be.revertedWithCustomError(pool, "InsufficientReserve");

    // 新到账 500（还没分配）-> 只能提这 500
    await bem.mint(poolAddr, 500n);
    await expect(
      pool.connect(owner).withdraw(await bem.getAddress(), owner.address, 501n),
    ).to.be.revertedWithCustomError(pool, "InsufficientReserve");
    await pool.connect(owner).withdraw(await bem.getAddress(), owner.address, 500n);

    await staking.connect(alice).claim();
    expect(await pool.reservedRewards()).to.be.lt(10n ** 6n);
  });

  it("dust release can only clear dust, never real staker rewards", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, pool, staking } = f;
    await stake(f, alice, "nand", 100n);
    await distribute(f, REWARD);

    // 剩余额度还是整轮奖励 -> 不允许当作灰尘释放
    await expect(
      pool.connect(owner).releaseRewardReserve(),
    ).to.be.revertedWithCustomError(pool, "ReserveNotDust");

    // 用户领完之后只剩灰尘 -> 可以清掉，然后迁移 payer
    await staking.connect(alice).claim();
    const dust = await pool.reservedRewards();
    expect(dust).to.be.lte(await pool.MAX_DUST_RELEASE());

    await pool.connect(owner).releaseRewardReserve();
    expect(await pool.reservedRewards()).to.equal(0n);
    await pool.connect(owner).setRewardPayer(owner.address);
  });

  it("exit never blocks principal when the reward payout fails", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bem, xNand, xLatch } = f;

    // 用可开关的 mock 收益来源，精确模拟「矿池付不出钱」
    const source = await ethers.deployContract("MockRewardSource", [await bem.getAddress()]);
    const staking = await ethers.deployContract("XTokenStaking", [
      await xNand.getAddress(),
      await xLatch.getAddress(),
      await source.getAddress(),
      owner.address,
    ]);
    const stakingAddr = await staking.getAddress();
    await bem.mint(await source.getAddress(), REWARD);
    await xNand.connect(alice).approve(stakingAddr, ethers.MaxUint256);
    await xLatch.connect(alice).approve(stakingAddr, ethers.MaxUint256);

    await staking.connect(alice).stake(await xNand.getAddress(), 100n);
    await staking.connect(alice).stake(await xLatch.getAddress(), 50n);
    await source.trigger(stakingAddr, REWARD);

    // 让 payReward 开始失败
    await source.setPayReverts(true);
    const bemBefore = await bem.balanceOf(alice.address);

    // 本金照退，交易不 revert
    await staking.connect(alice).exit();
    expect(await xNand.balanceOf(alice.address)).to.equal(1_000n);
    expect(await xLatch.balanceOf(alice.address)).to.equal(1_000n);
    expect(await bem.balanceOf(alice.address)).to.equal(bemBefore);

    // 收益没丢，还记在账上
    const account = await staking.accounts(alice.address);
    expect(account.rewards).to.be.gt(0n);
    expect(account.weight).to.equal(0n);

    // 矿池恢复之后依然能领
    await source.setPayReverts(false);
    await staking.connect(alice).claim();
    expect((await bem.balanceOf(alice.address)) - bemBefore).to.equal(account.rewards);
  });

  // ------------------------------------------------------------------ //
  // Admin / 误转回收                                                   //
  // ------------------------------------------------------------------ //

  it("keeps x-tokens out of reach of the owner", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bem, xNand, xLatch, staking } = f;
    await stake(f, alice, "nand", 100n);

    await expect(
      staking.connect(owner).recoverERC20(await xNand.getAddress(), owner.address, 1),
    ).to.be.revertedWithCustomError(staking, "ProtectedToken");
    await expect(
      staking.connect(owner).recoverERC20(await xLatch.getAddress(), owner.address, 1),
    ).to.be.revertedWithCustomError(staking, "ProtectedToken");

    // 奖励不存放在质押池，所以误转进来的 BEM 可以取走
    await bem.mint(await staking.getAddress(), 7);
    await staking.connect(owner).recoverERC20(await bem.getAddress(), owner.address, 7);
    expect(await bem.balanceOf(owner.address)).to.equal(7n);

    const other = await ethers.deployContract("MockBEM");
    await other.mint(await staking.getAddress(), 5);
    await staking.connect(owner).recoverERC20(await other.getAddress(), owner.address, 5);
    expect(await other.balanceOf(owner.address)).to.equal(5n);
  });

  it("locks weights while anything is staked", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, staking } = f;
    await stake(f, alice, "nand", 10n);
    await expect(
      staking.connect(owner).setWeights(PRECISION, PRECISION),
    ).to.be.revertedWithCustomError(staking, "WeightsLockedWhileStaked");
  });

  it("rejects a zero weight (it would make rewards undistributable)", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, staking } = f;

    await expect(
      staking.connect(owner).setWeights(0n, PRECISION),
    ).to.be.revertedWithCustomError(staking, "InvalidWeight");
    await expect(
      staking.connect(owner).setWeights(PRECISION, 0n),
    ).to.be.revertedWithCustomError(staking, "InvalidWeight");

    // 非 0 权重正常生效
    await staking.connect(owner).setWeights(2n * PRECISION, PRECISION);
    expect(await staking.nandWeight()).to.equal(2n * PRECISION);
    expect(await staking.latchWeight()).to.equal(PRECISION);
  });

  it("rejects bad input", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, staking, xNand } = f;
    const other = await ethers.deployContract("MockBEM");

    await expect(
      staking.connect(alice).stake(await other.getAddress(), 1),
    ).to.be.revertedWithCustomError(staking, "TokenNotAllowed");
    await expect(
      staking.connect(alice).stake(await xNand.getAddress(), 0),
    ).to.be.revertedWithCustomError(staking, "ZeroAmount");
    await expect(
      staking.connect(alice).unstake(await xNand.getAddress(), 1),
    ).to.be.revertedWithCustomError(staking, "InsufficientStake");
    await expect(staking.connect(alice).claim()).to.be.revertedWithCustomError(
      staking,
      "NothingToClaim",
    );
  });

  it("exposes the pool's reward token", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.staking.rewardToken()).to.equal(await f.bem.getAddress());
  });

  it("refuses a pool that is not a contract", async () => {
    const f = await loadFixture(deployFixture);
    const factory = await ethers.getContractFactory("XTokenStaking");
    await expect(
      factory.deploy(
        await f.xNand.getAddress(),
        await f.xLatch.getAddress(),
        f.alice.address, // EOA：调用会「静默成功」，必须挡掉
        f.owner.address,
      ),
    ).to.be.revertedWithCustomError(factory, "NotAContract");
  });
});
