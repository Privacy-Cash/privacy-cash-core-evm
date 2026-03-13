const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')

const BOMB_SIZE = 1_000_000 // 1 MB return payload

describe('Returnbomb resistance (PCEVM-L01)', function () {
  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    const mock = await deploy('SafeTransferMock')
    const bomb = await deploy('ReturnBombSuccess', BOMB_SIZE)
    const [sender] = await ethers.getSigners()

    await sender.sendTransaction({ to: mock.address, value: ethers.utils.parseEther('10') })

    return { mock, bomb, sender }
  }

  it('safeTransferETH succeeds when recipient returns large payload', async function () {
    const { mock, bomb } = await loadFixture(fixture)
    const amount = ethers.utils.parseEther('1')

    const balanceBefore = await ethers.provider.getBalance(bomb.address)
    await mock.safeTransferETH(bomb.address, amount)
    const balanceAfter = await ethers.provider.getBalance(bomb.address)

    expect(balanceAfter.sub(balanceBefore)).to.equal(amount)
  })

  it('safeTransferETH uses less gas than unsafeTransferETH against returnbomb', async function () {
    const { mock, bomb } = await loadFixture(fixture)
    const amount = ethers.utils.parseEther('0.01')

    const gasSafe = await mock.estimateGas.safeTransferETH(bomb.address, amount)
    const gasUnsafe = await mock.estimateGas.unsafeTransferETH(bomb.address, amount)

    // The unsafe (Solidity .call) version copies the 1 MB return payload into
    // caller memory via RETURNDATACOPY, paying quadratic expansion costs.
    // The safe (assembly) version skips RETURNDATACOPY entirely.
    expect(gasUnsafe).to.be.gt(gasSafe)

    // The caller-side overhead from RETURNDATACOPY should be significant (>1M gas)
    const overhead = gasUnsafe.sub(gasSafe)
    expect(overhead).to.be.gt(1_000_000)
  })

  it('safeTransferETH has no caller-side overhead vs EOA relative to unsafeTransferETH', async function () {
    const { mock, bomb, sender } = await loadFixture(fixture)
    const amount = ethers.utils.parseEther('0.01')

    // Gas deltas: (bomb - eoa) for each variant.
    // Both include the subcall's internal memory cost, but only the unsafe
    // variant adds caller-side RETURNDATACOPY overhead.
    const safeEoa = await mock.estimateGas.safeTransferETH(sender.address, amount)
    const safeBomb = await mock.estimateGas.safeTransferETH(bomb.address, amount)
    const safeDelta = safeBomb.sub(safeEoa)

    const unsafeEoa = await mock.estimateGas.unsafeTransferETH(sender.address, amount)
    const unsafeBomb = await mock.estimateGas.unsafeTransferETH(bomb.address, amount)
    const unsafeDelta = unsafeBomb.sub(unsafeEoa)

    // The unsafe delta should be meaningfully larger because it includes the
    // caller-side memory expansion. We expect at least 1.5x.
    expect(unsafeDelta).to.be.gt(safeDelta.mul(3).div(2))
  })

  it('safeTransferETH reverts when recipient reverts (returnbomb revert)', async function () {
    const { mock } = await loadFixture(fixture)
    const revertBomb = await deploy('ReturnBomb', BOMB_SIZE)

    await expect(
      mock.safeTransferETH(revertBomb.address, ethers.utils.parseEther('0.01')),
    ).to.be.revertedWith('ETH transfer failed')
  })

  it('safeTransferETH succeeds for normal EOA', async function () {
    const { mock } = await loadFixture(fixture)
    const recipient = ethers.Wallet.createRandom().address

    const amount = ethers.utils.parseEther('0.5')
    await mock.safeTransferETH(recipient, amount)

    expect(await ethers.provider.getBalance(recipient)).to.equal(amount)
  })

  it('safeTransferETH reverts when insufficient balance', async function () {
    const { mock } = await loadFixture(fixture)
    const recipient = ethers.Wallet.createRandom().address

    await expect(
      mock.safeTransferETH(recipient, ethers.utils.parseEther('999')),
    ).to.be.revertedWith('ETH transfer failed')
  })
})
