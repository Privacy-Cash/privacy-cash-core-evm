const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const MERKLE_TREE_HEIGHT = 26
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther('1')
const MINIMUM_AMOUNT = utils.parseEther('0.0005')

describe('Encrypted output size limit (PCEVM-L02)', function () {
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

  it('MAX_ENCRYPTED_OUTPUT_SIZE is 256', async function () {
    const { etherPool } = await loadFixture(fixture)
    expect(await etherPool.MAX_ENCRYPTED_OUTPUT_SIZE()).to.equal(256)
  })

  it('rejects encryptedOutput1 exceeding MAX_ENCRYPTED_OUTPUT_SIZE', async function () {
    const { etherPool } = await loadFixture(fixture)
    const oversized = '0x' + 'aa'.repeat(257)

    await expect(
      etherPool.transact(dummyProof(), dummyExtData({ encryptedOutput1: oversized }), { gasLimit: 1e6 }),
    ).to.be.revertedWith('Encrypted output too large')
  })

  it('rejects encryptedOutput2 exceeding MAX_ENCRYPTED_OUTPUT_SIZE', async function () {
    const { etherPool } = await loadFixture(fixture)
    const oversized = '0x' + 'bb'.repeat(257)

    await expect(
      etherPool.transact(dummyProof(), dummyExtData({ encryptedOutput2: oversized }), { gasLimit: 1e6 }),
    ).to.be.revertedWith('Encrypted output too large')
  })

  it('rejects both outputs oversized', async function () {
    const { etherPool } = await loadFixture(fixture)
    const oversized = '0x' + 'cc'.repeat(300)

    await expect(
      etherPool.transact(
        dummyProof(),
        dummyExtData({ encryptedOutput1: oversized, encryptedOutput2: oversized }),
        { gasLimit: 1e6 },
      ),
    ).to.be.revertedWith('Encrypted output too large')
  })

  it('accepts encryptedOutput at exactly MAX_ENCRYPTED_OUTPUT_SIZE', async function () {
    const { etherPool } = await loadFixture(fixture)
    const exact = '0x' + 'dd'.repeat(256)

    // Passes the size check, then fails on the next validation (merkle root)
    await expect(
      etherPool.transact(dummyProof(), dummyExtData({ encryptedOutput1: exact, encryptedOutput2: exact }), { gasLimit: 1e6 }),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('accepts empty encryptedOutputs', async function () {
    const { etherPool } = await loadFixture(fixture)

    // Passes the size check, then fails on the next validation (merkle root)
    await expect(
      etherPool.transact(dummyProof(), dummyExtData(), { gasLimit: 1e6 }),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('rejects encryptedOutput1 at MAX + 1', async function () {
    const { etherPool } = await loadFixture(fixture)
    const justOver = '0x' + 'ee'.repeat(257)
    const exact = '0x' + 'ff'.repeat(256)

    await expect(
      etherPool.transact(dummyProof(), dummyExtData({ encryptedOutput1: justOver, encryptedOutput2: exact }), { gasLimit: 1e6 }),
    ).to.be.revertedWith('Encrypted output too large')
  })

  it('rejects encryptedOutput2 at MAX + 1 when output1 is valid', async function () {
    const { etherPool } = await loadFixture(fixture)
    const exact = '0x' + 'ff'.repeat(256)
    const justOver = '0x' + 'ee'.repeat(257)

    await expect(
      etherPool.transact(dummyProof(), dummyExtData({ encryptedOutput1: exact, encryptedOutput2: justOver }), { gasLimit: 1e6 }),
    ).to.be.revertedWith('Encrypted output too large')
  })
})
