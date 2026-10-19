import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";


const MULT = 6n;
const NAND = 938n;
const LATCH = 0n;
const PRICE_NAND = NAND * MULT; // 5628
const PRICE_LATCH = LATCH * MULT;

describe("MinerDecomposer", () => {
  async function deployFixture() {
    const [owner, alice, bob] = await ethers.getSigners();

    const bem = await ethers.deployContract("MockBEM");
    const mining = await ethers.deployContract("MockMining", [await bem.getAddress()]);
    const circuit = await ethers.deployContract("MockCircuit", ["Behemoth"]);
    const xNand = await ethers.deployContract("XNAND");
    const xLatch = await ethers.deployContract("XLATCH");

    const decomposer = await ethers.deployContract("MinerDecomposer", [
      await mining.getAddress(),
      await xNand.getAddress(),
      await xLatch.getAddress(),
      await bem.getAddress(),
      owner.address,
    ]);
    const decoAddr = await decomposer.getAddress();

    await xNand.setMinter(decoAddr); await xNand.lockMinter();
    await xLatch.setMinter(decoAddr); await xLatch.lockMinter();
    await decomposer.setCpu(await circuit.getAddress(), true);

    return { owner, alice, bob, bem, mining, circuit, xNand, xLatch, decomposer, decoAddr };
  }

  async function stakeBehemoth(f: any, user: any, id = 156) {
    await f.circuit.mint(user.address, id);
    await f.circuit.connect(user).approve(f.decoAddr, id);
    await f.mining.setMiner(await f.circuit.getAddress(), id, NAND, LATCH, MULT, 1);
    await f.decomposer.connect(user).stake(await f.circuit.getAddress(), id);
    return ethers.keccak256(
      ethers.solidityPacked(["address", "uint256"], [await f.circuit.getAddress(), id]),
    );
  }

  it("stake mints nandBurn*mult and latchBurn*mult and escrows the NFT", async () => {
    const f = await loadFixture(deployFixture);
    const { alice } = f;
    await stakeBehemoth(f, alice);

    expect(await f.xNand.balanceOf(alice.address)).to.equal(PRICE_NAND);
    expect(await f.xLatch.balanceOf(alice.address)).to.equal(PRICE_LATCH);
    expect(await f.circuit.ownerOf(156)).to.equal(f.decoAddr);
    expect(await f.xNand.decimals()).to.equal(0);
    expect(await f.decomposer.stakedCount()).to.equal(1);
  });

  it("routes mining rewards to the vault while escrowed", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bem } = f;
    const key = await stakeBehemoth(f, alice);

    const reward = await f.mining.rewardPerClaim();
    expect(await bem.balanceOf(alice.address)).to.equal(0);
    await f.mining.claim(key);

    expect(await bem.balanceOf(f.decoAddr)).to.equal(reward);
    expect(await bem.balanceOf(alice.address)).to.equal(0);
  });

  it("all escrowed miner rewards accrue to the vault (depositor gets none)", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bem, circuit, mining } = f;
    await circuit.mint(alice.address, 156);
    await circuit.connect(alice).approve(f.decoAddr, 156);
    await mining.setMiner(await circuit.getAddress(), 156, NAND, LATCH, MULT, 1);

    await f.decomposer.connect(alice).stake(await circuit.getAddress(), 156);
    expect(await bem.balanceOf(alice.address)).to.equal(0);

    const key = ethers.keccak256(
      ethers.solidityPacked(["address", "uint256"], [await circuit.getAddress(), 156]),
    );
    await mining.claim(key);
    expect(await bem.balanceOf(f.decoAddr)).to.equal(await mining.rewardPerClaim());
    expect(await bem.balanceOf(alice.address)).to.equal(0);
  });

  it("redeem burns the price in x-tokens and returns the NFT (self)", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, circuit, xNand } = f;
    await stakeBehemoth(f, alice);

    await xNand.connect(alice).approve(f.decoAddr, ethers.MaxUint256);
    await f.decomposer.connect(alice).redeem(await circuit.getAddress(), 156);

    expect(await circuit.ownerOf(156)).to.equal(alice.address);
    expect(await xNand.balanceOf(alice.address)).to.equal(0);
    expect(await xNand.totalSupply()).to.equal(0);
    expect(await f.decomposer.stakedCount()).to.equal(0);
  });

  it("redeem is permissionless: another token holder can take the miner", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bob, circuit, xNand } = f;
    await stakeBehemoth(f, alice);

    // Bob acquires the required xNAND and redeems Alice's escrowed miner.
    await xNand.connect(alice).transfer(bob.address, PRICE_NAND);
    await xNand.connect(bob).approve(f.decoAddr, ethers.MaxUint256);

    await f.decomposer.connect(bob).redeem(await circuit.getAddress(), 156);

    expect(await circuit.ownerOf(156)).to.equal(bob.address);
    expect(await xNand.balanceOf(bob.address)).to.equal(0);
    expect(await xNand.balanceOf(alice.address)).to.equal(0);
    expect(await xNand.totalSupply()).to.equal(0);
  });

  it("redeem reverts without enough x-tokens", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bob, circuit } = f;
    await stakeBehemoth(f, alice);
    await expect(
      f.decomposer.connect(bob).redeem(await circuit.getAddress(), 156),
    ).to.be.reverted;
  });

  it("redeem reverts for a non-escrowed miner", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, circuit } = f;
    await expect(
      f.decomposer.connect(alice).redeem(await circuit.getAddress(), 156),
    ).to.be.revertedWithCustomError(f.decomposer, "NotStaked");
  });

  it("enumerates escrowed miners and removes redeemed ones", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, circuit, xNand } = f;
    await stakeBehemoth(f, alice, 156);
    await stakeBehemoth(f, alice, 157);
    expect(await f.decomposer.stakedCount()).to.equal(2);

    const a = await f.decomposer.stakedAt(0);
    const b = await f.decomposer.stakedAt(1);
    expect([a.id, b.id].map((x) => Number(x)).sort()).to.deep.equal([156, 157]);
    expect(a.cpu).to.equal(await circuit.getAddress());
    expect(a.depositor).to.equal(alice.address);

    await xNand.connect(alice).approve(f.decoAddr, ethers.MaxUint256);
    await f.decomposer.connect(alice).redeem(await circuit.getAddress(), 156);
    expect(await f.decomposer.stakedCount()).to.equal(1);
    expect((await f.decomposer.stakedAt(0)).id).to.equal(157);
  });

  it("redeem harvests pending rewards to the vault before releasing the NFT", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bem, circuit, xNand } = f;
    await stakeBehemoth(f, alice);

    await xNand.connect(alice).approve(f.decoAddr, ethers.MaxUint256);
    await f.decomposer.connect(alice).redeem(await circuit.getAddress(), 156);

    // vault claimed the reward accrued while escrowed (owner at redeem time)
    expect(await bem.balanceOf(f.decoAddr)).to.equal(await f.mining.rewardPerClaim());
  });

  it("reverts on disallowed CPU and double stake", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, circuit, decomposer } = f;

    await expect(decomposer.connect(alice).stake(await circuit.getAddress(), 156)).to.be.reverted;

    await stakeBehemoth(f, alice);
    await expect(
      decomposer.connect(alice).stake(await circuit.getAddress(), 156),
    ).to.be.revertedWithCustomError(decomposer, "AlreadyStaked");
  });

  it("reverts staking an NFT that is not a registered miner", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, circuit, decomposer } = f;
    await circuit.mint(alice.address, 5000);
    await circuit.connect(alice).approve(f.decoAddr, 5000);
    await expect(
      decomposer.connect(alice).stake(await circuit.getAddress(), 5000),
    ).to.be.revertedWithCustomError(decomposer, "NotRegisteredMiner");
  });

  it("blocks staking when CPU is not allowed", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, circuit, decomposer } = f;
    await decomposer.setCpu(await circuit.getAddress(), false);
    await circuit.mint(alice.address, 156);
    await circuit.connect(alice).approve(f.decoAddr, 156);
    await expect(decomposer.connect(alice).stake(await circuit.getAddress(), 156))
      .to.be.revertedWithCustomError(decomposer, "CpuNotAllowed");
  });

  it("restricts withdraw to the owner", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bem, decomposer } = f;
    await expect(
      decomposer.connect(alice).withdraw(await bem.getAddress(), alice.address, 1),
    ).to.be.revertedWithCustomError(decomposer, "OwnableUnauthorizedAccount");
  });

  it("harvests escrowed rewards to the vault and lets owner withdraw", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, owner, bem, circuit, decomposer } = f;
    await stakeBehemoth(f, alice);

    await decomposer.connect(alice).harvest(await circuit.getAddress(), 156);
    const bal = await bem.balanceOf(f.decoAddr);
    expect(bal).to.be.gt(0);

    await decomposer.connect(owner).withdraw(await bem.getAddress(), owner.address, bal);
    expect(await bem.balanceOf(owner.address)).to.equal(bal);
  });

  it("reverts harvest for a non-escrowed miner", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, circuit, decomposer } = f;
    await expect(
      decomposer.connect(alice).harvest(await circuit.getAddress(), 156),
    ).to.be.revertedWithCustomError(decomposer, "NotStaked");
  });

  it("implements onERC721Received", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, decomposer } = f;
    expect(
      await decomposer.onERC721Received.staticCall(alice.address, alice.address, 1, "0x"),
    ).to.equal("0x150b7a02");
  });

  it("rescues stray NFTs but never escrowed ones", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, owner, circuit, decomposer } = f;

    await circuit.mint(alice.address, 999);
    await circuit.connect(alice).transferFrom(alice.address, f.decoAddr, 999);
    expect(await circuit.ownerOf(999)).to.equal(f.decoAddr);

    await decomposer.connect(owner).rescueERC721(await circuit.getAddress(), 999, alice.address);
    expect(await circuit.ownerOf(999)).to.equal(alice.address);

    await stakeBehemoth(f, alice, 200);
    await expect(
      decomposer.connect(owner).rescueERC721(await circuit.getAddress(), 200, owner.address),
    ).to.be.revertedWithCustomError(decomposer, "StakedToken");
  });

  // ---------------------------------------------------------------- //
  // Rules added after the contract review                             //
  // ---------------------------------------------------------------- //

  it("holders can no longer burn x-tokens (only redeem can)", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, xNand, decomposer, decoAddr } = f;
    await stakeBehemoth(f, alice);

    // ERC20Burnable is gone: there is no public `burn`, and `burnFrom` is minter-only.
    expect(xNand.interface.getFunction("burn")).to.equal(null);
    expect(xNand.interface.getFunction("burnFrom")).to.not.equal(null);
    await expect(
      xNand.connect(alice).burnFrom(alice.address, 1n),
    ).to.be.revertedWithCustomError(xNand, "NotMinter");

    // the decomposer may burn, but only with an allowance and only via redeem
    await expect(
      decomposer.connect(alice).redeem(await f.circuit.getAddress(), 156),
    ).to.be.reverted;
    await xNand.connect(alice).approve(decoAddr, ethers.MaxUint256);
    await decomposer.connect(alice).redeem(await f.circuit.getAddress(), 156);
    expect(await xNand.totalSupply()).to.equal(0n);
  });

  it("mints and burns both components when latchBurn is non-zero", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, circuit, mining, xNand, xLatch, decomposer, decoAddr } = f;
    const cpu = await circuit.getAddress();

    await circuit.mint(alice.address, 321);
    await circuit.connect(alice).approve(decoAddr, 321);
    await mining.setMiner(cpu, 321, NAND, 200, MULT, 1);
    await decomposer.connect(alice).stake(cpu, 321);

    expect(await xNand.balanceOf(alice.address)).to.equal(NAND * MULT);
    expect(await xLatch.balanceOf(alice.address)).to.equal(200n * MULT);

    await xNand.connect(alice).approve(decoAddr, ethers.MaxUint256);
    await xLatch.connect(alice).approve(decoAddr, ethers.MaxUint256);
    await decomposer.connect(alice).redeem(cpu, 321);

    expect(await xNand.totalSupply()).to.equal(0n);
    expect(await xLatch.totalSupply()).to.equal(0n);
    expect(await circuit.ownerOf(321)).to.equal(alice.address);
  });

  it("refuses to stake a miner whose price is zero", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, circuit, decomposer, mining } = f;
    await circuit.mint(alice.address, 777);
    await circuit.connect(alice).approve(f.decoAddr, 777);
    // nandBurn = 0, latchBurn = 0 -> free for anyone to redeem
    await mining.setMiner(await circuit.getAddress(), 777, 0, 0, MULT, 1);

    await expect(
      decomposer.connect(alice).stake(await circuit.getAddress(), 777),
    ).to.be.revertedWithCustomError(decomposer, "ZeroPrice");

    // mult = 0 has the same effect
    await mining.setMiner(await circuit.getAddress(), 777, NAND, LATCH, 0, 1);
    await expect(
      decomposer.connect(alice).stake(await circuit.getAddress(), 777),
    ).to.be.revertedWithCustomError(decomposer, "ZeroPrice");
  });

  it("redeem reverts when the pending claim fails, so rewards stay with the vault", async () => {
    const f = await loadFixture(deployFixture);
    const { alice, bob, bem, circuit, mining, xNand, decomposer, decoAddr } = f;
    await stakeBehemoth(f, alice);

    await xNand.connect(alice).transfer(bob.address, PRICE_NAND);
    await xNand.connect(bob).approve(decoAddr, ethers.MaxUint256);

    await mining.setClaimReverts(true);
    await expect(
      decomposer.connect(bob).redeem(await circuit.getAddress(), 156),
    ).to.be.revertedWith("claim disabled");

    // nothing moved: NFT still escrowed, bob's tokens intact, no reward paid out
    expect(await circuit.ownerOf(156)).to.equal(decoAddr);
    expect(await xNand.balanceOf(bob.address)).to.equal(PRICE_NAND);
    expect(await decomposer.stakedCount()).to.equal(1);
    expect(await bem.balanceOf(bob.address)).to.equal(0);

    // once claiming works again the vault takes the reward and the redeem goes through
    await mining.setClaimReverts(false);
    await decomposer.connect(bob).redeem(await circuit.getAddress(), 156);
    expect(await circuit.ownerOf(156)).to.equal(bob.address);
    expect(await bem.balanceOf(decoAddr)).to.equal(await mining.rewardPerClaim());
    expect(await bem.balanceOf(bob.address)).to.equal(0);
  });

  // ---------------------------------------------------------------- //
  // 矿池作为收益来源：触发分配 / 领取时直接付给用户                    //
  // ---------------------------------------------------------------- //

  async function rewardFixture() {
    const f = await loadFixture(deployFixture);
    // 用 MockRewardSink 顶替质押池：distributeRewards 会真的调它的 notifyReward，
    // 而发放则由它转发回 payReward（payReward 只认 rewardPayer 本人）。
    const sink = await ethers.deployContract("MockRewardSink", [f.decoAddr]);
    await f.decomposer.connect(f.owner).setRewardPayer(await sink.getAddress());
    await f.bem.mint(f.decoAddr, 1_000n);
    return { ...f, sink };
  }

  it("distributes the entire free balance and notifies the staking pool", async () => {
    const f = await rewardFixture();
    const { owner, sink, decomposer, decoAddr, bem } = f;

    // 合约里有 1,000 BEM，reserved 为 0 -> 一次全部分出去
    await decomposer.connect(owner).distributeRewards();
    expect(await decomposer.reservedRewards()).to.equal(1_000n);
    expect(await sink.lastNotified()).to.equal(1_000n);
    // 钱没有离开矿池
    expect(await bem.balanceOf(decoAddr)).to.equal(1_000n);

    // 再调一次：可分配余额已经是 0 -> 拒绝
    await expect(
      decomposer.connect(owner).distributeRewards(),
    ).to.be.revertedWithCustomError(decomposer, "NothingToDistribute");

    // 用户领走 150 之后，剩下的仍然锁着
    await sink.payFromPool(owner.address, 150n);
    expect(await bem.balanceOf(owner.address)).to.equal(150n);
    expect(await decomposer.reservedRewards()).to.equal(850n);
    expect(await bem.balanceOf(decoAddr)).to.equal(850n);
  });

  it("never redistributes BEM that is already owed to stakers", async () => {
    const f = await rewardFixture();
    const { owner, sink, decomposer, decoAddr, bem } = f;

    await decomposer.connect(owner).distributeRewards(); // reserved = 1,000
    // 又来了一笔新收益（运营 harvest 进来）
    await bem.mint(decoAddr, 500n);

    // 只会分配新增的 500，不会把已分配未领取的 1,000 再分一次
    await decomposer.connect(owner).distributeRewards();
    expect(await sink.lastNotified()).to.equal(500n);
    expect(await decomposer.reservedRewards()).to.equal(1_500n);
  });

  it("rejects triggers from anyone but the owner, and over-budget payouts", async () => {
    const f = await rewardFixture();
    const { owner, alice, bob, sink, decomposer } = f;

    // 只有 owner 能触发分配
    await expect(
      decomposer.connect(alice).distributeRewards(),
    ).to.be.revertedWithCustomError(decomposer, "OwnableUnauthorizedAccount");
    // 发放只能由质押池本人发起
    await expect(
      decomposer.connect(bob).payReward(bob.address, 1n),
    ).to.be.revertedWithCustomError(decomposer, "NotRewardPayer");
    await expect(
      decomposer.connect(alice).payReward(bob.address, 1n),
    ).to.be.revertedWithCustomError(decomposer, "NotRewardPayer");

    await decomposer.connect(owner).distributeRewards(); // reserved = 1,000

    // 不能付出超过已分配额度的钱
    await expect(sink.payFromPool(bob.address, 1_001n)).to.be.revertedWithCustomError(
      decomposer,
      "InsufficientReserve",
    );

    // 也不能打给零地址
    await expect(
      sink.payFromPool(ethers.ZeroAddress, 10n),
    ).to.be.revertedWithCustomError(decomposer, "ZeroAddress");
  });

  it("owner cannot withdraw the reserved reward budget", async () => {
    const f = await rewardFixture();
    const { owner, sink, decomposer, decoAddr, bem } = f;
    await decomposer.connect(owner).distributeRewards(); // reserved = 1,000，free = 0

    // 全部余额都是待发放奖励 -> 一分都提不走
    await expect(
      decomposer.connect(owner).withdraw(await bem.getAddress(), owner.address, 1n),
    ).to.be.revertedWithCustomError(decomposer, "InsufficientReserve");

    // 新到账 500（尚未分配）-> 只能提这 500
    await bem.mint(decoAddr, 500n);
    await expect(
      decomposer.connect(owner).withdraw(await bem.getAddress(), owner.address, 501n),
    ).to.be.revertedWithCustomError(decomposer, "InsufficientReserve");
    await decomposer.connect(owner).withdraw(await bem.getAddress(), owner.address, 500n);
    expect(await bem.balanceOf(decoAddr)).to.equal(1_000n);

    // 已分配的 1,000 仍然能正常发放
    await sink.payFromPool(owner.address, 1_000n);
    expect(await decomposer.reservedRewards()).to.equal(0n);
  });

  it("rewardPayer can only be switched when nothing is reserved", async () => {
    const f = await rewardFixture();
    const { owner, sink, bob, decomposer } = f;

    await decomposer.connect(owner).distributeRewards();
    await expect(
      decomposer.connect(owner).setRewardPayer(bob.address),
    ).to.be.revertedWithCustomError(decomposer, "ReserveNotEmpty");

    await sink.payFromPool(owner.address, 1_000n);
    await decomposer.connect(owner).setRewardPayer(bob.address);
    expect(await decomposer.rewardPayer()).to.equal(bob.address);
  });

  it("lets the owner clear rounding dust so the payer can be migrated", async () => {
    const f = await rewardFixture();
    const { owner, sink, bob, decomposer } = f;

    await decomposer.connect(owner).distributeRewards(); // reserved = 1,000
    await sink.payFromPool(owner.address, 999n); // 剩 1 wei 灰尘
    expect(await decomposer.reservedRewards()).to.equal(1n);

    // 剩余额度整体就是灰尘 -> 可以清掉，然后迁移
    await decomposer.connect(owner).releaseRewardReserve();
    expect(await decomposer.reservedRewards()).to.equal(0n);
    await decomposer.connect(owner).setRewardPayer(bob.address);
  });

  it("refuses to dust-release while a meaningful reserve is still owed", async () => {
    const f = await rewardFixture();
    const { owner, bem, decoAddr, decomposer } = f;

    // 让余额远大于灰尘阈值
    await bem.mint(decoAddr, 2n * (await decomposer.MAX_DUST_RELEASE()));
    await decomposer.connect(owner).distributeRewards();

    await expect(
      decomposer.connect(owner).releaseRewardReserve(),
    ).to.be.revertedWithCustomError(decomposer, "ReserveNotDust");
  });

  it("refuses to trigger when the payer is not a contract", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bem, decoAddr, decomposer } = f;
    // 指向 EOA 的话 notifyReward 会「静默成功」，额度被锁死却没人记账
    await decomposer.connect(owner).setRewardPayer(alice.address);
    await bem.mint(decoAddr, 10n);

    await expect(
      decomposer.connect(owner).distributeRewards(),
    ).to.be.revertedWithCustomError(decomposer, "NotAContract");
    expect(await decomposer.reservedRewards()).to.equal(0n);
  });

  // ---------------------------------------------------------------- //
  // 复核：收益「待领取」时不能直接触发，必须先 harvest 进金库          //
  // ---------------------------------------------------------------- //

  it("reward distribution needs BEM that has already been harvested", async () => {
    const f = await loadFixture(deployFixture);
    const { owner, alice, bob, bem, circuit, decomposer, decoAddr } = f;
    const sink = await ethers.deployContract("MockRewardSink", [decoAddr]);
    await decomposer.connect(owner).setRewardPayer(await sink.getAddress());
    await stakeBehemoth(f, alice);

    // 矿机在质押期间产出，但收益还挂在 mining 合约里（未 harvest）
    expect(await bem.balanceOf(decoAddr)).to.equal(0n);
    await expect(
      decomposer.connect(owner).distributeRewards(),
    ).to.be.revertedWithCustomError(decomposer, "NothingToDistribute");

    // harvest 之后金库才有可分配的余额
    await decomposer.connect(bob).harvest(await circuit.getAddress(), 156);
    expect(await bem.balanceOf(decoAddr)).to.equal(await f.mining.rewardPerClaim());
    await decomposer.connect(owner).distributeRewards();
    expect(await decomposer.reservedRewards()).to.equal(await f.mining.rewardPerClaim());
    expect(await sink.lastNotified()).to.equal(await f.mining.rewardPerClaim());
  });
});
