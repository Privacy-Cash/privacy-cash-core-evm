const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const MERKLE_TREE_HEIGHT = 26
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther('1')
const MINIMUM_AMOUNT = utils.parseEther('0.0005')

describe('Minimum amount enforcement (PCEVM-L03)', function () {
  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, , admin] = await ethers.getSigners()
    const verifier2 = await deploy('Verifier2')
    const hasher = await deploy('Hasher')

    const EtherPool = await ethers.getContractFactory('EtherPool')
    const implementation = await EtherPool.deploy(
      verifier2.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
    )
    await implementation.deployed()

    const initData = EtherPool.interface.encodeFunctionData('initialize', [
      MAXIMUM_DEPOSIT_AMOUNT,
      MINIMUM_AMOUNT,
      admin.address,
    ])
    const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy')
    const proxy = await ERC1967Proxy.deploy(implementation.address, initData)
    await proxy.deployed()

    const etherPool = EtherPool.attach(proxy.address)
    return { etherPool, sender, admin }
  }

  function dummyProof() {
    return {
      pA: [0, 0],
      pB: [[0, 0], [0, 0]],
      pC: [0, 0],
      root: ethers.constants.HashZero,
      inputNullifiers: [ethers.constants.HashZero, ethers.constants.HashZero],
      outputCommitments: [ethers.constants.HashZero, ethers.constants.HashZero],
      publicAmount: 0,
      extDataHash: ethers.constants.HashZero,
    }
  }

  function dummyExtData(overrides = {}) {
    return {
      recipient: ethers.constants.AddressZero,
      extAmount: 0,
      feeRecipient: ethers.constants.AddressZero,
      fee: 0,
      encryptedOutput1: '0x',
      encryptedOutput2: '0x',
      ...overrides,
    }
  }

  it('minimumAmount is initialized to 0.0005 ether', async function () {
    const { etherPool } = await loadFixture(fixture)
    expect(await etherPool.minimumAmount()).to.equal(MINIMUM_AMOUNT)
  })

  // --- Deposit checks ---

  it('rejects deposit below minimumAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    const dust = 1

    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({ extAmount: dust }),
        { value: dust, gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Amount too small')
  })

  it('rejects deposit just below minimumAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    const justBelow = MINIMUM_AMOUNT.sub(1)

    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({ extAmount: justBelow }),
        { value: justBelow, gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Amount too small')
  })

  it('accepts deposit at exactly minimumAmount (passes to next check)', async function () {
    const { etherPool } = await loadFixture(fixture)

    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({ extAmount: MINIMUM_AMOUNT }),
        { value: MINIMUM_AMOUNT, gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('deposit: fee is included in minimumAmount (extAmount covers fee)', async function () {
    const { etherPool } = await loadFixture(fixture)
    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({
          extAmount: MINIMUM_AMOUNT,
          fee: utils.parseEther('0.0002'),
          feeRecipient: '0xDeaD00000000000000000000000000000000BEEf',
        }),
        { value: MINIMUM_AMOUNT, gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Invalid merkle root')
  })

  // --- Withdrawal checks ---

  it('rejects dust withdrawal (1 wei, no fee)', async function () {
    const { etherPool } = await loadFixture(fixture)

    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({
          extAmount: -1,
          recipient: '0xDeaD00000000000000000000000000000000BEEf',
        }),
        { gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Amount too small')
  })

  it('rejects withdrawal just below minimumAmount (no fee)', async function () {
    const { etherPool } = await loadFixture(fixture)
    const justBelow = MINIMUM_AMOUNT.sub(1)

    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({
          extAmount: justBelow.mul(-1),
          recipient: '0xDeaD00000000000000000000000000000000BEEf',
        }),
        { gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Amount too small')
  })

  it('accepts withdrawal at exactly minimumAmount (passes to next check)', async function () {
    const { etherPool } = await loadFixture(fixture)

    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({
          extAmount: MINIMUM_AMOUNT.mul(-1),
          recipient: '0xDeaD00000000000000000000000000000000BEEf',
        }),
        { gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('withdrawal: fee counts toward minimumAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    const halfMin = MINIMUM_AMOUNT.div(2)

    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({
          extAmount: halfMin.mul(-1),
          fee: halfMin,
          recipient: '0xDeaD00000000000000000000000000000000BEEf',
          feeRecipient: '0x000000000000000000000000000000000000dEaD',
        }),
        { gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('withdrawal: fee alone does not satisfy minimumAmount when extAmount is dust', async function () {
    const { etherPool } = await loadFixture(fixture)

    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({
          extAmount: -1,
          fee: MINIMUM_AMOUNT.sub(2),
          recipient: '0xDeaD00000000000000000000000000000000BEEf',
          feeRecipient: '0x000000000000000000000000000000000000dEaD',
        }),
        { gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Amount too small')
  })

  // --- Admin configurability ---

  it('admin can update minimumAmount via configureMinimumAmount', async function () {
    const { etherPool, admin } = await loadFixture(fixture)
    const newMin = utils.parseEther('0.01')

    await etherPool.connect(admin).configureMinimumAmount(newMin)
    expect(await etherPool.minimumAmount()).to.equal(newMin)
  })

  it('non-admin cannot update minimumAmount', async function () {
    const { etherPool, sender } = await loadFixture(fixture)

    await expect(
      etherPool.connect(sender).configureMinimumAmount(utils.parseEther('0.01')),
    ).to.be.revertedWith('only admin')
  })

  it('updated minimumAmount is enforced on deposits', async function () {
    const { etherPool, admin } = await loadFixture(fixture)
    const newMin = utils.parseEther('0.1')

    await etherPool.connect(admin).configureMinimumAmount(newMin)

    // 0.05 ETH was above old minimum but below the new one
    const amount = utils.parseEther('0.05')
    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({ extAmount: amount }),
        { value: amount, gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Amount too small')

    // 0.1 ETH meets the new minimum
    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({ extAmount: newMin }),
        { value: newMin, gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('admin can set minimumAmount to zero', async function () {
    const { etherPool, admin } = await loadFixture(fixture)

    await etherPool.connect(admin).configureMinimumAmount(0)
    expect(await etherPool.minimumAmount()).to.equal(0)

    // 1 wei deposit should now pass the minimum check
    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({ extAmount: 1 }),
        { value: 1, gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Invalid merkle root')
  })
})
