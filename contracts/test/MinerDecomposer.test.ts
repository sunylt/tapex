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

});
