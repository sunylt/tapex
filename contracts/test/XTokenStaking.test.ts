import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";

const WEEK = 7n * 24n * 60n * 60n;
const PRECISION = 10n ** 18n;
/** MockBEM uses 18 decimals. */
const REWARD = ethers.parseEther("7000");
/** One second worth of emissions — hardhat mines a block per tx, so allow a little drift. */
const ONE_SECOND = REWARD / WEEK + 1n;

describe("XTokenStaking", () => {
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

    // 矿池手里要有 BEM 才付得出来（真实场景来自 harvest 的在押矿机收益）
    await bem.mint(poolAddr, REWARD * 10n);

    return { owner, alice, bob, bem, mining, circuit, xNand, xLatch, pool, poolAddr, staking, addr };
  }

  async function stake(f: any, user: any, token: "nand" | "latch", amount: bigint) {
    const t = token === "nand" ? f.xNand : f.xLatch;
    await t.connect(user).approve(f.addr, ethers.MaxUint256);
    await f.staking.connect(user).stake(await t.getAddress(), amount);
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

  it("splits rewards proportionally to weight", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bob, staking, bem } = f;

    // alice 300 weight, bob 100 weight -> 3:1
    await stake(f, alice, "nand", 300n);
    await stake(f, bob, "nand", 100n);

    await staking.connect(owner).notifyReward(REWARD);
    await time.increase(WEEK);

    const aliceEarned = await staking.earned(alice.address);
    const bobEarned = await staking.earned(bob.address);

    // rounding dust of at most a few wei is expected
    expect(aliceEarned + bobEarned).to.be.closeTo(REWARD, 10n ** 6n);
    expect(aliceEarned).to.be.closeTo((REWARD * 3n) / 4n, 10n ** 6n);
    expect(bobEarned).to.be.closeTo(REWARD / 4n, 10n ** 6n);

    const before = await bem.balanceOf(alice.address);
    await staking.connect(alice).claim();
    expect((await bem.balanceOf(alice.address)) - before).to.equal(aliceEarned);
    expect(await staking.earned(alice.address)).to.equal(0);
  });

  it("accrues over time, not all at once", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, staking } = f;
    await stake(f, alice, "nand", 100n);
    await staking.connect(owner).notifyReward(REWARD);

    const half = await time.latest().then((t) => t);
    await time.increase(Number(WEEK / 2n));
    const earnedHalf = await staking.earned(alice.address);
    await time.increase(Number(WEEK / 2n));
    const earnedFull = await staking.earned(alice.address);

    expect(earnedHalf).to.be.gt((REWARD * 45n) / 100n);
    expect(earnedHalf).to.be.lt((REWARD * 55n) / 100n);
    expect(earnedFull).to.be.gt(earnedHalf);
    expect(earnedFull).to.be.closeTo(REWARD, 10n ** 6n);
    expect(half).to.be.gt(0);
  });

  it("rewards stop growing after periodFinish", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, staking } = f;
    await stake(f, alice, "nand", 100n);
    await staking.connect(owner).notifyReward(REWARD);
    await time.increase(Number(WEEK * 3n));

    const earned = await staking.earned(alice.address);
    expect(earned).to.be.closeTo(REWARD, 10n ** 6n);
  });

  it("unstake returns tokens and stops future accrual", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, xNand, staking } = f;
    await stake(f, alice, "nand", 100n);
    await staking.connect(owner).notifyReward(REWARD);

    await time.increase(Number(WEEK / 2n));
    await staking.connect(alice).unstake(await xNand.getAddress(), 100n);
    expect(await xNand.balanceOf(alice.address)).to.equal(1_000n);

    const earnedAtUnstake = await staking.earned(alice.address);
    await time.increase(Number(WEEK));
    expect(await staking.earned(alice.address)).to.equal(earnedAtUnstake);
    expect(await staking.totalWeight()).to.equal(0n);
  });

  it("exit() returns everything and pays the reward", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bem, xNand, xLatch, staking } = f;
    await stake(f, alice, "nand", 120n);
    await stake(f, alice, "latch", 80n);
    await staking.connect(owner).notifyReward(REWARD);
    await time.increase(Number(WEEK));

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

    await staking.connect(owner).notifyReward(REWARD);
    await time.increase(Number(WEEK));

    const a = await staking.earned(alice.address);
    const b = await staking.earned(bob.address);
    expect(a).to.be.closeTo((REWARD * 3n) / 4n, 10n ** 6n);
    expect(b).to.be.closeTo(REWARD / 4n, 10n ** 6n);
  });

  it("rolls leftover rewards into the next round", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, staking } = f;
    await stake(f, alice, "nand", 100n);

    await staking.connect(owner).notifyReward(REWARD);
    await time.increase(Number(WEEK / 2n));

    // second round starts before the first one ends; the leftover is rolled in
    await staking.connect(owner).notifyReward(REWARD);
    await time.increase(Number(WEEK * 2n));

    const earned = await staking.earned(alice.address);
    // nothing is lost: the sole staker ends up with both rounds in full
    expect(earned).to.be.closeTo(REWARD * 2n, ONE_SECOND * 3n);
    expect(await staking.getRewardForDuration()).to.be.gt(0n);
  });

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

    // an unrelated token can be recovered too
    const other = await ethers.deployContract("MockBEM");
    await other.mint(await staking.getAddress(), 5);
    await staking.connect(owner).recoverERC20(await other.getAddress(), owner.address, 5);
    expect(await other.balanceOf(owner.address)).to.equal(5n);
  });

  it("enforces admin rules", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, staking } = f;

    await expect(staking.connect(alice).notifyReward(1)).to.be.revertedWithCustomError(
      staking,
      "OwnableUnauthorizedAccount",
    );
    await expect(
      staking.connect(alice).setRewardsDuration(1),
    ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");

    await stake(f, alice, "nand", 10n);
    await expect(
      staking.connect(owner).setWeights(PRECISION, PRECISION),
    ).to.be.revertedWithCustomError(staking, "WeightsLockedWhileStaked");

    // duration can only change once the running round is over
    await staking.connect(owner).notifyReward(REWARD);
    await expect(
      staking.connect(owner).setRewardsDuration(24n * 60n * 60n),
    ).to.be.revertedWithCustomError(staking, "RewardsStillStreaming");
    await time.increase(Number(WEEK));
    await staking.connect(owner).setRewardsDuration(24n * 60n * 60n);
    expect(await staking.rewardsDuration()).to.equal(24n * 60n * 60n);
  });

  it("rejects bad input", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bob, staking, bem, xNand } = f;
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
    await expect(
      staking.connect(f.owner).notifyReward(0),
    ).to.be.revertedWithCustomError(staking, "ZeroAmount");

    // notifyReward pulls the tokens from the caller
    await expect(
      staking.connect(bob).notifyReward(1),
    ).to.be.revertedWithCustomError(staking, "OwnableUnauthorizedAccount");
    await bem.connect(bob).approve(await staking.getAddress(), 1);
    await expect(staking.connect(bob).notifyReward(1)).to.be.reverted;
  });

  it("a late staker does not dilute rewards earned before they joined", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bob, staking } = f;
    await stake(f, alice, "nand", 100n);
    await staking.connect(owner).notifyReward(REWARD);

    await time.increase(Number(WEEK / 2n));
    const aliceBefore = await staking.earned(alice.address);
    await stake(f, bob, "nand", 100n); // joins halfway

    await time.increase(Number(WEEK / 2n));
    const aliceAfter = await staking.earned(alice.address);
    const bobEarned = await staking.earned(bob.address);

    // alice's first half is untouched by bob's arrival (one block of drift)
    expect(aliceAfter).to.be.gt(aliceBefore);
    expect(aliceAfter).to.be.closeTo((REWARD * 3n) / 4n, ONE_SECOND * 3n);
    expect(bobEarned).to.be.closeTo(REWARD / 4n, ONE_SECOND * 3n);
  });

  // ------------------------------------------------------------------ //
  // claim() 的具体行为                                                  //
  // ------------------------------------------------------------------ //

  it("claim settles into `rewards`, pays it out, and zeroes it", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bem, staking } = f;
    await stake(f, alice, "nand", 100n);
    await staking.connect(owner).notifyReward(REWARD);
    await time.increase(Number(WEEK));

    // 领取前：`a.rewards` 还是 0（上次结算是在 stake 时，那时收益为 0），
    // 真正可领的钱只存在于「水位差」里，由 earned() 实时算出来。
    const accountBefore = await staking.accounts(alice.address);
    const earnedBefore = await staking.earned(alice.address);
    expect(accountBefore.rewards).to.equal(0n);
    expect(earnedBefore).to.be.closeTo(REWARD, ONE_SECOND * 3n);

    const balanceBefore = await bem.balanceOf(alice.address);
    await staking.connect(alice).claim();

    const accountAfter = await staking.accounts(alice.address);
    expect((await bem.balanceOf(alice.address)) - balanceBefore).to.equal(earnedBefore);
    expect(accountAfter.rewards).to.equal(0n); // 已清零
    expect(await staking.earned(alice.address)).to.equal(0n); // 水位线已推到最新
    expect(accountAfter.nand).to.equal(100n); // 本金完全没动
    expect(accountAfter.weight).to.equal(100n * PRECISION);

    // 同一区块再领一次：没有可领的，直接 revert
    await expect(staking.connect(alice).claim()).to.be.revertedWithCustomError(
      staking,
      "NothingToClaim",
    );
  });

  it("claim still pays out rewards that were settled before a full unstake", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bem, xNand, staking } = f;
    await stake(f, alice, "nand", 100n);
    await staking.connect(owner).notifyReward(REWARD);
    await time.increase(Number(WEEK / 2n));

    // 全部解押：这一步的 updateReward 会把当时已产生的收益结算进 a.rewards
    await staking.connect(alice).unstake(await xNand.getAddress(), 100n);
    const afterUnstake = await staking.earned(alice.address);
    expect(afterUnstake).to.be.gt(0n); // 权重已归零，但收益仍然记在账上
    expect((await staking.accounts(alice.address)).weight).to.equal(0n);

    // 再等很久也不会有新增
    await time.increase(Number(WEEK * 2n));
    expect(await staking.earned(alice.address)).to.equal(afterUnstake);

    // 依然可以领走
    const before = await bem.balanceOf(alice.address);
    await staking.connect(alice).claim();
    expect((await bem.balanceOf(alice.address)) - before).to.equal(afterUnstake);
  });

  it("never promises more BEM than the pool actually holds", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bob, bem, pool, poolAddr, staking } = f;
    await stake(f, alice, "nand", 300n);
    await stake(f, bob, "latch", 100n);
    await staking.connect(owner).notifyReward(REWARD);

    // 划拨额度：钱还在矿池里
    expect(await pool.reservedRewards()).to.equal(REWARD);
    expect(await bem.balanceOf(await staking.getAddress())).to.equal(0n);

    await time.increase(Number(WEEK * 2n));
    await staking.connect(alice).claim();
    await staking.connect(bob).claim();

    // 用户领完，划拨额度基本归零（只剩取整灰尘），BEM 全部到了用户手里
    expect(await pool.reservedRewards()).to.be.lt(10n ** 6n);
    const left = await bem.balanceOf(poolAddr);
    expect(left).to.be.gt((REWARD * 9n));
    expect(await bem.balanceOf(alice.address)).to.be.gt(0n);
  });

  it("only the staking contract may reserve / pay from the pool", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, owner, bem, pool, poolAddr, staking } = f;

    await expect(pool.connect(alice).reserveRewards(1)).to.be.revertedWithCustomError(
      pool,
      "NotRewardPayer",
    );
    await expect(
      pool.connect(alice).payReward(alice.address, 1),
    ).to.be.revertedWithCustomError(pool, "NotRewardPayer");

    // 矿池余额不够时 notifyReward 直接失败，不会发出付不出来的承诺
    await staking.connect(owner).notifyReward(REWARD);
    const tooMuch = (await bem.balanceOf(poolAddr)) + 1n;
    await expect(
      staking.connect(owner).notifyReward(tooMuch),
    ).to.be.revertedWithCustomError(pool, "InsufficientReserve");
  });

  it("owner cannot withdraw BEM that has been reserved for stakers", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bem, pool, poolAddr, staking } = f;
    await stake(f, alice, "nand", 100n);
    await staking.connect(owner).notifyReward(REWARD);

    const balance = await bem.balanceOf(poolAddr);
    expect(balance).to.be.gt(REWARD);

    // 只能取走未被划拨的部分
    const free = balance - REWARD;
    await expect(
      pool.connect(owner).withdraw(await bem.getAddress(), owner.address, free + 1n),
    ).to.be.revertedWithCustomError(pool, "InsufficientReserve");
    if (free > 0n) {
      await pool.connect(owner).withdraw(await bem.getAddress(), owner.address, free);
    }

    // 划拨部分仍在，用户依然能领
    await time.increase(Number(WEEK));
    await staking.connect(alice).claim();
    expect(await pool.reservedRewards()).to.be.lt(10n ** 6n);
  });

  it("rewardPayer can only be re-pointed when nothing is reserved", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, pool, staking } = f;
    await stake(f, alice, "nand", 100n);
    await staking.connect(owner).notifyReward(REWARD);

    await expect(
      pool.connect(owner).setRewardPayer(alice.address),
    ).to.be.revertedWithCustomError(pool, "ReserveNotEmpty");
  });

  // ------------------------------------------------------------------ //
  // pull 模式的边界：本金不能被收益发放卡住                              //
  // ------------------------------------------------------------------ //

  it("exposes the pool's reward token", async () => {
    const f = await loadFixture(deployFixture);
    expect(await f.staking.rewardToken()).to.equal(await f.bem.getAddress());
  });

  it("exit never blocks principal when the reward payout fails", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bem, xNand, xLatch, pool, staking } = f;
    await stake(f, alice, "nand", 100n);
    await stake(f, alice, "latch", 50n);
    await staking.connect(owner).notifyReward(REWARD);
    await time.increase(Number(WEEK));

    // 把划拨额度清掉 -> payReward 会 revert
    await pool.connect(owner).releaseRewardReserve(REWARD);
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
    expect(await staking.totalWeight()).to.equal(0n);

    // 矿池重新有额度之后依然能领
    await staking.connect(owner).notifyReward(REWARD);
    const before = await bem.balanceOf(alice.address);
    await staking.connect(alice).claim();
    expect((await bem.balanceOf(alice.address)) - before).to.equal(account.rewards);
  });

  it("reserved budget always covers everything still owed", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bob, pool, staking } = f;
    await stake(f, alice, "nand", 300n);
    await stake(f, bob, "latch", 100n);

    const owed = async () =>
      (await staking.earned(alice.address)) + (await staking.earned(bob.address));

    await staking.connect(owner).notifyReward(REWARD);
    await time.increase(Number(WEEK / 3n));
    expect(await pool.reservedRewards()).to.be.gte(await owed());

    await staking.connect(alice).claim();
    await time.increase(Number(WEEK / 3n));
    // 中途再注入一轮（剩余额度滚进新速率）
    await staking.connect(owner).notifyReward(REWARD);
    expect(await pool.reservedRewards()).to.be.gte(await owed());

    await time.increase(Number(WEEK));
    await staking.connect(bob).claim();
    expect(await pool.reservedRewards()).to.be.gte(await owed());
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
