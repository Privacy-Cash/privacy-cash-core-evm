const hre = require('hardhat')
const { ethers, upgrades, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const { MerkleTree } = require('fixed-merkle-tree')
const Utxo = require('../src/utxo')
const { toFixedHex, poseidonHash2, getExtDataHash, FIELD_SIZE } = require('../src/utils')
const { signIn } = require('../src/encryption')
const { prove } = require('../src/prover')
const { BigNumber } = ethers

const MERKLE_TREE_HEIGHT = 26
const MERKLE_TREE_ZERO_VALUE = '2795675251356313514992617062594790716374808130983166135938897961178374655502'
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther('1')
const MINIMUM_AMOUNT = utils.parseEther('0.0005')

function createEmptyTree() {
  return new MerkleTree(MERKLE_TREE_HEIGHT, [], { hashFunction: poseidonHash2, zeroElement: MERKLE_TREE_ZERO_VALUE })
}

async function getProof({ inputs, outputs, tree, extAmount, fee, recipient, feeRecipient, encryptionKey }) {
  const inputMerklePathIndices = []
  const inputMerklePathElements = []

  for (const input of inputs) {
    if (input.amount.gt(0)) {
      input.index = tree.indexOf(toFixedHex(input.getCommitment()))
      if (input.index < 0) {
        throw new Error(`Input commitment ${toFixedHex(input.getCommitment())} was not found`)
      }
      inputMerklePathIndices.push(input.index)
      inputMerklePathElements.push(tree.path(input.index).pathElements)
    } else {
      inputMerklePathIndices.push(0)
      inputMerklePathElements.push(new Array(MERKLE_TREE_HEIGHT).fill(0))
    }
  }

  let nextIndex = tree._layers[0].length
  for (const output of outputs) {
    output.index = nextIndex++
  }

  const extData = {
    recipient: toFixedHex(recipient, 20),
    extAmount: toFixedHex(extAmount),
    feeRecipient: toFixedHex(feeRecipient, 20),
    fee: toFixedHex(fee),
    encryptedOutput1: outputs[0].encrypt(encryptionKey),
    encryptedOutput2: outputs[1].encrypt(encryptionKey),
  }

  const extDataHash = getExtDataHash(extData)
  const input = {
    root: toFixedHex(tree.root),
    inputNullifier: inputs.map((x) => x.getNullifier().toString()),
    outputCommitment: outputs.map((x) => x.getCommitment().toString()),
    publicAmount: BigNumber.from(extAmount).sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE).toString(),
    extDataHash: extDataHash.toString(),
    mintAddress: inputs[0].mintAddress.toString(),
    inAmount: inputs.map((x) => x.amount.toString()),
    inPrivateKey: inputs.map((x) => x.keypair.privkey.toString()),
    inBlinding: inputs.map((x) => x.blinding.toString()),
    inPathIndices: inputMerklePathIndices,
    inPathElements: inputMerklePathElements,
    outAmount: outputs.map((x) => x.amount.toString()),
    outBlinding: outputs.map((x) => x.blinding.toString()),
    outPubkey: outputs.map((x) => x.keypair.pubkey.toString()),
  }

  const { pA, pB, pC } = await prove(input, `./build/circuits/transaction${inputs.length}`)

  const args = {
    pA,
    pB,
    pC,
    root: toFixedHex(input.root),
    inputNullifiers: inputs.map((x) => toFixedHex(x.getNullifier())),
    outputCommitments: outputs.map((x) => toFixedHex(x.getCommitment())),
    publicAmount: toFixedHex(input.publicAmount),
    extDataHash: toFixedHex(extDataHash),
  }

  return { extData, args, outputs }
}

async function prepareTransaction({ tree, inputs = [], outputs = [], fee = 0, recipient = 0, feeRecipient = 0, encryptionKey }) {
  if (inputs.length > 2 || outputs.length > 2) {
    throw new Error('Incorrect inputs/outputs count')
  }
  while (inputs.length < 2) {
    inputs.push(new Utxo())
  }
  while (outputs.length < 2) {
    outputs.push(new Utxo())
  }

  const extAmount = BigNumber.from(fee)
    .add(outputs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))
    .sub(inputs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))

  const { args, extData, outputs: paddedOutputs } = await getProof({
    inputs,
    outputs,
    tree,
    extAmount,
    fee,
    recipient,
    feeRecipient,
    encryptionKey,
  })

  return { args, extData, outputs: paddedOutputs }
}

async function deploy(contractName, ...args) {
  const Factory = await ethers.getContractFactory(contractName)
  const instance = await Factory.deploy(...args)
  return instance.deployed()
}

async function ercTransaction({ ercPool, token, tree, from, encryptionKey, ...rest }) {
  const { args, extData, outputs } = await prepareTransaction({ tree, encryptionKey, ...rest })
  const overrides = { gasLimit: 3000000 }
  const extAmount = BigNumber.from(extData.extAmount)
  const signer = from || (await ethers.getSigners())[0]

  if (extAmount.gt(0)) {
    await token.connect(signer).approve(ercPool.address, extAmount)
  }

  const receipt = await ercPool.connect(signer).transact(args, extData, overrides)
  const result = await receipt.wait()

  for (const output of outputs) {
    tree.insert(toFixedHex(output.getCommitment()))
  }

  return result
}

describe('ERCPool', function () {
  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, admin] = await ethers.getSigners()
    const token = await deploy('MockERC20')
    const verifier2 = await deploy('Verifier2')
    const hasher = await deploy('Hasher')

    const ERCPool = await ethers.getContractFactory('ERCPool')
    const implementation = await ERCPool.deploy(verifier2.address, MERKLE_TREE_HEIGHT, hasher.address, token.address)
    await implementation.deployed()

    const initData = ERCPool.interface.encodeFunctionData('initialize', [
      MAXIMUM_DEPOSIT_AMOUNT,
      MINIMUM_AMOUNT,
      admin.address,
    ])
    const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy')
    const proxy = await ERC1967Proxy.deploy(implementation.address, initData)
    await proxy.deployed()

    const ercPool = ERCPool.attach(proxy.address)
    const { encryptionKey, keypair } = await signIn(sender)

    return { ercPool, token, gov, admin, sender, encryptionKey, keypair, verifier2, hasher }
  }

  function dummyProof() {
    return {
      pA: [0, 0],
      pB: [
        [0, 0],
        [0, 0],
      ],
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

  it('exposes token, verifier2, levels, hasher immutables', async () => {
    const { ercPool, token, verifier2, hasher } = await loadFixture(fixture)
    expect(await ercPool.token()).to.equal(token.address)
    expect(await ercPool.verifier2()).to.equal(verifier2.address)
    expect(await ercPool.levels()).to.equal(MERKLE_TREE_HEIGHT)
    expect(await ercPool.hasher()).to.equal(hasher.address)
  })

  it('rejects zero token in constructor', async () => {
    require('../scripts/compileHasher')
    const verifier2 = await deploy('Verifier2')
    const hasher = await deploy('Hasher')
    const ERCPool = await ethers.getContractFactory('ERCPool')
    await expect(
      ERCPool.deploy(verifier2.address, MERKLE_TREE_HEIGHT, hasher.address, ethers.constants.AddressZero),
    ).to.be.revertedWith('token is zero address')
  })

  it('should configure maximum deposit amount', async () => {
    const { ercPool, admin } = await loadFixture(fixture)
    const newLimit = utils.parseEther('1337')
    await ercPool.connect(admin).configureMaximumDepositAmount(newLimit)
    expect(await ercPool.maximumDepositAmount()).to.equal(newLimit)
  })

  it('constants check', async () => {
    const { ercPool } = await loadFixture(fixture)
    const maxFee = await ercPool.MAX_FEE()
    const maxExtAmount = await ercPool.MAX_EXT_AMOUNT()
    const fieldSize = await ercPool.FIELD_SIZE()
    expect(maxExtAmount.add(maxFee)).to.be.lt(fieldSize)
  })

  it('MAX_ENCRYPTED_OUTPUT_SIZE is 256', async () => {
    const { ercPool } = await loadFixture(fixture)
    expect(await ercPool.MAX_ENCRYPTED_OUTPUT_SIZE()).to.equal(256)
  })

  it('rejects encryptedOutput exceeding limit', async () => {
    const { ercPool } = await loadFixture(fixture)
    const oversized = '0x' + 'aa'.repeat(257)
    await expect(
      ercPool.transact(dummyProof(), dummyExtData({ encryptedOutput1: oversized }), { gasLimit: 1e6 }),
    ).to.be.revertedWith('Encrypted output too large')
  })

  it('rejects transact with native value attached (non-payable)', async () => {
    const { ercPool, sender } = await loadFixture(fixture)
    const data = ercPool.interface.encodeFunctionData('transact', [
      dummyProof(),
      dummyExtData({ extAmount: MINIMUM_AMOUNT }),
    ])
    await expect(
      sender.sendTransaction({ to: ercPool.address, data, value: 1, gasLimit: 1e6 }),
    ).to.be.reverted
  })

  it('rejects plain ETH transfers (no receive)', async () => {
    const { ercPool, sender } = await loadFixture(fixture)
    await expect(sender.sendTransaction({ to: ercPool.address, value: 1 })).to.be.reverted
  })

  it('rejects deposit below minimumAmount', async () => {
    const { ercPool } = await loadFixture(fixture)
    const dust = 1
    await expect(
      ercPool.transact(dummyProof(), dummyExtData({ extAmount: dust }), { gasLimit: 1e6 }),
    ).to.be.revertedWith('Amount too small')
  })

  it('accepts deposit at minimumAmount then fails merkle check', async () => {
    const { ercPool } = await loadFixture(fixture)
    await expect(
      ercPool.transact(dummyProof(), dummyExtData({ extAmount: MINIMUM_AMOUNT }), { gasLimit: 1e6 }),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('rejects deposit without token approval', async () => {
    const { ercPool, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({ tree, outputs: [utxo], encryptionKey })
    await expect(ercPool.transact(args, extData, { gasLimit: 50e6 })).to.be.reverted
  })

  it('should deposit, transact and withdraw (ERC-20)', async function () {
    const { ercPool, token, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair })
    await ercTransaction({ ercPool, token, tree, outputs: [aliceDepositUtxo], encryptionKey })

    const bobAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const bobSendAmount = utils.parseEther('0.06')
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(bobSendAmount),
      keypair,
    })
    await ercTransaction({
      ercPool,
      token,
      tree,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: bobAddress,
      encryptionKey,
    })

    expect(await token.balanceOf(bobAddress)).to.equal(bobSendAmount)

    const aliceRecv = '0x000000000000000000000000000000000000dEaD'
    await ercTransaction({
      ercPool,
      token,
      tree,
      inputs: [aliceChangeUtxo],
      outputs: [],
      recipient: aliceRecv,
      encryptionKey,
    })

    expect(await token.balanceOf(aliceRecv)).to.equal(aliceDepositAmount.sub(bobSendAmount))
    expect(await token.balanceOf(ercPool.address)).to.equal(0)
  })

  it('should deposit and withdraw with relayer fee (ERC-20)', async function () {
    const { ercPool, token, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const [, , , relayer] = await ethers.getSigners()

    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair })
    await ercTransaction({ ercPool, token, tree, outputs: [aliceDepositUtxo], encryptionKey })

    const withdrawAmount = utils.parseEther('0.08')
    const fee = utils.parseEther('0.01')
    const changeAmount = aliceDepositAmount.sub(withdrawAmount).sub(fee)
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    const aliceChangeUtxo = new Utxo({ amount: changeAmount, keypair })

    await ercTransaction({
      ercPool,
      token,
      tree,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient,
      fee,
      feeRecipient: relayer.address,
      encryptionKey,
    })

    expect(await token.balanceOf(recipient)).to.equal(withdrawAmount)
    expect(await token.balanceOf(relayer.address)).to.equal(fee)
    expect(await token.balanceOf(ercPool.address)).to.equal(changeAmount)
  })

  it('attacker cannot frontrun withdraw by replacing recipient', async function () {
    const { ercPool, token, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const [, , , , attacker] = await ethers.getSigners()

    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair })
    await ercTransaction({ ercPool, token, tree, outputs: [aliceDepositUtxo], encryptionKey })

    const aliceWithdrawAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const { args, extData } = await prepareTransaction({
      tree,
      inputs: [aliceDepositUtxo],
      outputs: [],
      recipient: aliceWithdrawAddress,
      encryptionKey,
    })

    const attackerExtData = { ...extData, recipient: attacker.address }
    await expect(ercPool.connect(attacker).transact(args, attackerExtData, { gasLimit: 50e6 })).to.be.revertedWith(
      'Incorrect external data hash',
    )

    const attackerBefore = await token.balanceOf(attacker.address)
    await ercPool.transact(args, extData, { gasLimit: 50e6 })
    expect(await token.balanceOf(aliceWithdrawAddress)).to.equal(aliceDepositAmount)
    expect(await token.balanceOf(attacker.address)).to.equal(attackerBefore)
  })

  it('should reject tampered publicAmount', async function () {
    const { ercPool, token, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({ tree, outputs: [utxo], encryptionKey })
    args.publicAmount = toFixedHex(42)
    await token.approve(ercPool.address, depositAmount)
    await expect(ercPool.transact(args, extData, { gasLimit: 50e6 })).to.be.revertedWith('Invalid public amount')
  })

  it('should reject double spend', async function () {
    const { ercPool, token, encryptionKey, keypair } = await loadFixture(fixture)
    const tree = createEmptyTree()

    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair })
    await ercTransaction({ ercPool, token, tree, outputs: [aliceDepositUtxo], encryptionKey })

    const bobAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const withdrawAmount = utils.parseEther('0.05')
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(withdrawAmount),
      keypair,
    })
    await ercTransaction({
      ercPool,
      token,
      tree,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: bobAddress,
      encryptionKey,
    })

    const aliceChangeUtxo2 = new Utxo({ amount: 0, keypair })
    await expect(
      ercTransaction({
        ercPool,
        token,
        tree,
        inputs: [aliceDepositUtxo],
        outputs: [aliceChangeUtxo2],
        recipient: bobAddress,
        encryptionKey,
      }),
    ).to.be.revertedWith('Input is already spent')
  })

  it('should reject deposit exceeding limit', async function () {
    const { ercPool, token, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const overLimitAmount = MAXIMUM_DEPOSIT_AMOUNT.add(1)
    const utxo = new Utxo({ amount: overLimitAmount })
    await expect(
      ercTransaction({ ercPool, token, tree, outputs: [utxo], encryptionKey }),
    ).to.be.revertedWith('amount is larger than maximumDepositAmount')
  })

  it('non-admin cannot configure limits', async () => {
    const { ercPool, sender } = await loadFixture(fixture)
    await expect(ercPool.connect(sender).configureMaximumDepositAmount(utils.parseEther('999'))).to.be.revertedWith(
      'only admin',
    )
  })

  it('admin can transfer admin to new address', async function () {
    const { ercPool, admin, gov } = await loadFixture(fixture)
    await ercPool.connect(admin).transferAdmin(gov.address)
    expect(await ercPool.pendingAdmin()).to.equal(gov.address)
    await ercPool.connect(gov).claimAdmin()
    expect(await ercPool.admin()).to.equal(gov.address)
  })

  it('cannot initialize twice', async function () {
    const { ercPool, admin } = await loadFixture(fixture)
    await expect(
      ercPool.connect(admin).initialize(utils.parseEther('2'), MINIMUM_AMOUNT, admin.address),
    ).to.be.reverted
  })

  it('should reject withdraw to zero address', async function () {
    const { ercPool, token, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const depositAmount = utils.parseEther('0.05')
    const depositUtxo = new Utxo({ amount: depositAmount })
    await ercTransaction({ ercPool, token, tree, outputs: [depositUtxo], encryptionKey })

    await expect(
      ercTransaction({
        ercPool,
        token,
        tree,
        inputs: [depositUtxo],
        outputs: [],
        recipient: '0x0000000000000000000000000000000000000000',
        encryptionKey,
      }),
    ).to.be.revertedWith("Can't withdraw to zero address")
  })

  it('should reject unknown root', async function () {
    const { ercPool, token, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({ tree, outputs: [utxo], encryptionKey })
    args.root = toFixedHex(123456789)
    await token.approve(ercPool.address, depositAmount)
    await expect(ercPool.transact(args, extData, { gasLimit: 50e6 })).to.be.revertedWith('Invalid merkle root')
  })

  it('should reject wrong extDataHash', async function () {
    const { ercPool, token, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({ tree, outputs: [utxo], encryptionKey })
    const tampered = { ...extData, recipient: '0xDeaD00000000000000000000000000000000BEEf' }
    await token.approve(ercPool.address, depositAmount)
    await expect(ercPool.transact(args, tampered, { gasLimit: 50e6 })).to.be.revertedWith('Incorrect external data hash')
  })

  it('calculatePublicAmount rules match EtherPool', async function () {
    const { ercPool } = await loadFixture(fixture)
    await expect(ercPool.calculatePublicAmount(0, 0)).to.be.revertedWith('ext amount must exceed fee for deposits')
    const r1 = await ercPool.calculatePublicAmount(utils.parseEther('0.1'), utils.parseEther('0.01'))
    expect(r1).to.equal(utils.parseEther('0.09'))
    const fieldSize = await ercPool.FIELD_SIZE()
    const r2 = await ercPool.calculatePublicAmount(utils.parseEther('-0.1'), utils.parseEther('0.01'))
    expect(r2).to.equal(fieldSize.sub(utils.parseEther('0.11')))
  })

  it('admin can pause and unpause; transact blocked when paused', async function () {
    const { ercPool, token, admin, encryptionKey } = await loadFixture(fixture)
    const tree = createEmptyTree()
    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({ tree, outputs: [utxo], encryptionKey })

    await ercPool.connect(admin).pause()
    await token.approve(ercPool.address, depositAmount)
    await expect(ercPool.transact(args, extData, { gasLimit: 50e6 })).to.be.reverted

    await ercPool.connect(admin).unpause()
    await ercTransaction({ ercPool, token, tree, outputs: [utxo], encryptionKey })
    expect(await token.balanceOf(ercPool.address)).to.equal(depositAmount)
  })

  it('non-admin cannot pause', async () => {
    const { ercPool, sender } = await loadFixture(fixture)
    await expect(ercPool.connect(sender).pause()).to.be.revertedWith('only admin')
  })
})

describe('ERCPool upgrades', function () {
  upgrades.silenceWarnings()

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, , admin] = await ethers.getSigners()
    const token = await deploy('MockERC20')
    const verifier2 = await deploy('Verifier2')
    const hasher = await deploy('Hasher')

    const ERCPool = await ethers.getContractFactory('ERCPool')
    const ercPool = await upgrades.deployProxy(
      ERCPool,
      [utils.parseEther('1'), utils.parseEther('0.0005'), admin.address],
      {
        kind: 'uups',
        initializer: 'initialize',
        constructorArgs: [verifier2.address, MERKLE_TREE_HEIGHT, hasher.address, token.address],
        unsafeAllow: ['state-variable-immutable', 'constructor'],
      },
    )
    await ercPool.deployed()
    return { ercPool, verifier2, hasher, admin, sender, token }
  }

  it('deployProxy initializes and exposes token', async () => {
    const { ercPool, admin, token } = await loadFixture(fixture)
    expect(await ercPool.admin()).to.equal(admin.address)
    expect(await ercPool.token()).to.equal(token.address)
  })

  it('upgrade preserves storage and immutables', async () => {
    const { ercPool, verifier2, hasher, admin, token } = await loadFixture(fixture)
    const newLimit = utils.parseEther('5')
    await ercPool.connect(admin).configureMaximumDepositAmount(newLimit)
    expect(await ercPool.maximumDepositAmount()).to.equal(newLimit)

    const ERCPoolV2 = await ethers.getContractFactory('ERCPoolV2Mock', admin)
    const upgraded = await upgrades.upgradeProxy(ercPool.address, ERCPoolV2, {
      kind: 'uups',
      constructorArgs: [verifier2.address, MERKLE_TREE_HEIGHT, hasher.address, token.address],
      unsafeAllow: ['state-variable-immutable', 'constructor', 'missing-initializer-call'],
      call: { fn: 'initializeV2', args: [42] },
    })

    expect(await upgraded.admin()).to.equal(admin.address)
    expect(await upgraded.maximumDepositAmount()).to.equal(newLimit)
    expect(await upgraded.token()).to.equal(token.address)
    expect(await upgraded.version()).to.equal(2)
    expect(await upgraded.newVariable()).to.equal(42)
  })

  it('non-admin cannot upgrade', async () => {
    const { ercPool, verifier2, hasher, sender, token } = await loadFixture(fixture)
    const ERCPoolV2 = await ethers.getContractFactory('ERCPoolV2Mock')
    const newImpl = await ERCPoolV2.deploy(verifier2.address, MERKLE_TREE_HEIGHT, hasher.address, token.address)
    await newImpl.deployed()
    await expect(ercPool.connect(sender).upgradeToAndCall(newImpl.address, '0x')).to.be.revertedWith('only admin')
  })
})
