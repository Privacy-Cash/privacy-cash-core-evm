const hre = require('hardhat')
const { ethers, waffle } = hre
const { loadFixture } = waffle
const { expect } = require('chai')
const { utils } = ethers

const Utxo = require('../src/utxo')
const { transaction, prepareTransaction, buildMerkleTree } = require('../src/index')
const { toFixedHex, poseidonHash } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const MERKLE_TREE_HEIGHT = 26
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther('1')

describe('EtherPool', function () {
  this.timeout(20000)

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName)
    const instance = await Factory.deploy(...args)
    return instance.deployed()
  }

  async function fixture() {
    require('../scripts/compileHasher')
    const [sender, gov, admin] = await ethers.getSigners()
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
      admin.address,
    ])
    const ERC1967Proxy = await ethers.getContractFactory('ERC1967Proxy')
    const proxy = await ERC1967Proxy.deploy(implementation.address, initData)
    await proxy.deployed()

    const etherPool = EtherPool.attach(proxy.address)

    return { etherPool, gov, admin, sender }
  }

  it('should configure', async () => {
    const { etherPool, admin } = await loadFixture(fixture)
    const newDepositLimit = utils.parseEther('1337')

    await etherPool.connect(admin).configureLimits(newDepositLimit)

    expect(await etherPool.maximumDepositAmount()).to.be.equal(newDepositLimit)
  })

  it('encrypt -> decrypt should work', () => {
    const data = Buffer.from([0xff, 0xaa, 0x00, 0x01])
    const keypair = new Keypair()

    const ciphertext = keypair.encrypt(data)
    const result = keypair.decrypt(ciphertext)
    expect(result).to.be.deep.equal(data)
  })

  it('constants check', async () => {
    const { etherPool } = await loadFixture(fixture)
    const maxFee = await etherPool.MAX_FEE()
    const maxExtAmount = await etherPool.MAX_EXT_AMOUNT()
    const fieldSize = await etherPool.FIELD_SIZE()

    expect(maxExtAmount.add(maxFee)).to.be.lt(fieldSize)
  })

  it('should deposit, transact and withdraw', async function () {
    const { etherPool } = await loadFixture(fixture)

    // Alice deposits into privacy cash pool
    const aliceKeypair = new Keypair()
    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair: aliceKeypair })
    await transaction({ etherPool, outputs: [aliceDepositUtxo] })

    // Alice withdraws a portion to Bob's address
    const bobEthAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const bobSendAmount = utils.parseEther('0.06')
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(bobSendAmount),
      keypair: aliceKeypair,
    })
    await transaction({
      etherPool,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: bobEthAddress,
    })

    const bobBalance = await ethers.provider.getBalance(bobEthAddress)
    expect(bobBalance).to.be.equal(bobSendAmount)

    // Alice withdraws the remaining balance
    const aliceEthAddress = '0x000000000000000000000000000000000000dEaD'
    await transaction({
      etherPool,
      inputs: [aliceChangeUtxo],
      outputs: [],
      recipient: aliceEthAddress,
    })

    const aliceBalance = await ethers.provider.getBalance(aliceEthAddress)
    expect(aliceBalance).to.be.equal(aliceDepositAmount.sub(bobSendAmount))
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(0)
  })

  it('should deposit and withdraw with relayer fee', async function () {
    const { etherPool, sender } = await loadFixture(fixture)
    const [, , , relayer] = await ethers.getSigners()

    const aliceKeypair = new Keypair()
    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair: aliceKeypair })

    const poolBalanceBefore = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceBefore).to.be.equal(0)

    const senderBalanceBefore = await ethers.provider.getBalance(sender.address)

    const depositTx = await transaction({ etherPool, outputs: [aliceDepositUtxo] })

    const senderBalanceAfterDeposit = await ethers.provider.getBalance(sender.address)
    const depositGasUsed = utils.parseUnits(depositTx.gasUsed.toString(), 'wei').mul(depositTx.effectiveGasPrice)
    expect(senderBalanceBefore.sub(senderBalanceAfterDeposit)).to.be.equal(aliceDepositAmount.add(depositGasUsed))

    const poolBalanceAfterDeposit = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceAfterDeposit).to.be.equal(aliceDepositAmount)

    // Withdraw with relayer fee
    const withdrawAmount = utils.parseEther('0.08')
    const fee = utils.parseEther('0.01')
    const changeAmount = aliceDepositAmount.sub(withdrawAmount).sub(fee)
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    const aliceChangeUtxo = new Utxo({
      amount: changeAmount,
      keypair: aliceKeypair,
    })

    const relayerBalanceBefore = await ethers.provider.getBalance(relayer.address)

    const withdrawTx = await transaction({
      etherPool,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient,
      fee,
      relayer: relayer.address,
    })

    // Recipient gets the withdrawal amount
    const recipientBalance = await ethers.provider.getBalance(recipient)
    expect(recipientBalance).to.be.equal(withdrawAmount)

    // Relayer gets the fee
    const relayerBalanceAfter = await ethers.provider.getBalance(relayer.address)
    expect(relayerBalanceAfter.sub(relayerBalanceBefore)).to.be.equal(fee)

    // Pool retains only the change amount
    const poolBalanceAfterWithdraw = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceAfterWithdraw).to.be.equal(changeAmount)

    // Sender paid gas for the withdraw tx but no ETH value
    const senderBalanceAfterWithdraw = await ethers.provider.getBalance(sender.address)
    const withdrawGasUsed = utils.parseUnits(withdrawTx.gasUsed.toString(), 'wei').mul(withdrawTx.effectiveGasPrice)
    expect(senderBalanceAfterDeposit.sub(senderBalanceAfterWithdraw)).to.be.equal(withdrawGasUsed)
  })

  it('should deposit and withdraw with zero fee', async function () {
    const { etherPool, sender } = await loadFixture(fixture)
    const [, , , relayer] = await ethers.getSigners()

    const aliceKeypair = new Keypair()
    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair: aliceKeypair })

    const poolBalanceBefore = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceBefore).to.be.equal(0)

    const senderBalanceBefore = await ethers.provider.getBalance(sender.address)

    const depositTx = await transaction({ etherPool, outputs: [aliceDepositUtxo] })

    const senderBalanceAfterDeposit = await ethers.provider.getBalance(sender.address)
    const depositGasUsed = utils.parseUnits(depositTx.gasUsed.toString(), 'wei').mul(depositTx.effectiveGasPrice)
    expect(senderBalanceBefore.sub(senderBalanceAfterDeposit)).to.be.equal(aliceDepositAmount.add(depositGasUsed))

    const poolBalanceAfterDeposit = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceAfterDeposit).to.be.equal(aliceDepositAmount)

    // Withdraw with relayer fee
    const withdrawAmount = utils.parseEther('0.08')
    const fee = 0
    const changeAmount = aliceDepositAmount.sub(withdrawAmount).sub(fee)
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    const aliceChangeUtxo = new Utxo({
      amount: changeAmount,
      keypair: aliceKeypair,
    })

    const relayerBalanceBefore = await ethers.provider.getBalance(relayer.address)

    const withdrawTx = await transaction({
      etherPool,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient,
      fee,
      relayer: relayer.address,
    })

    // Recipient gets the withdrawal amount
    const recipientBalance = await ethers.provider.getBalance(recipient)
    expect(recipientBalance).to.be.equal(withdrawAmount)

    // Relayer gets the fee
    const relayerBalanceAfter = await ethers.provider.getBalance(relayer.address)
    expect(relayerBalanceAfter.sub(relayerBalanceBefore)).to.be.equal(fee)

    // Pool retains only the change amount
    const poolBalanceAfterWithdraw = await ethers.provider.getBalance(etherPool.address)
    expect(poolBalanceAfterWithdraw).to.be.equal(changeAmount)

    // Sender paid gas for the withdraw tx but no ETH value
    const senderBalanceAfterWithdraw = await ethers.provider.getBalance(sender.address)
    const withdrawGasUsed = utils.parseUnits(withdrawTx.gasUsed.toString(), 'wei').mul(withdrawTx.effectiveGasPrice)
    expect(senderBalanceAfterDeposit.sub(senderBalanceAfterWithdraw)).to.be.equal(withdrawGasUsed)
  })

  it('attacker cannot frontrun withdraw by replacing recipient', async function () {
    const { etherPool } = await loadFixture(fixture)
    const [, , , , attacker] = await ethers.getSigners()

    const aliceKeypair = new Keypair()
    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair: aliceKeypair })
    await transaction({ etherPool, outputs: [aliceDepositUtxo] })

    // Alice prepares a withdrawal to her own address
    const aliceWithdrawAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const { args, extData } = await prepareTransaction({
      etherPool,
      inputs: [aliceDepositUtxo],
      outputs: [],
      recipient: aliceWithdrawAddress,
    })

    // Attacker intercepts and replaces recipient with their own address
    const attackerExtData = { ...extData, recipient: attacker.address }

    await expect(
      etherPool.transact(args, attackerExtData, { gasLimit: 50e6 }),
    ).to.be.revertedWith('Incorrect external data hash')

    // Verify attacker received nothing
    const attackerBalanceBefore = await ethers.provider.getBalance(attacker.address)

    // Original transaction still works with the correct recipient
    await etherPool.transact(args, extData, { gasLimit: 50e6 })

    const recipientBalance = await ethers.provider.getBalance(aliceWithdrawAddress)
    expect(recipientBalance).to.be.equal(aliceDepositAmount)

    const attackerBalanceAfter = await ethers.provider.getBalance(attacker.address)
    expect(attackerBalanceAfter).to.be.equal(attackerBalanceBefore)
  })

  it('should reject tampered publicAmount', async function () {
    const { etherPool } = await loadFixture(fixture)

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      etherPool,
      outputs: [utxo],
    })

    // Tamper with publicAmount after proof was generated
    args.publicAmount = toFixedHex(42)

    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Invalid public amount')
  })

  it('should reject tampered fee', async function () {
    const { etherPool } = await loadFixture(fixture)

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      etherPool,
      outputs: [utxo],
    })

    // Tamper with fee after proof was generated
    extData.fee = toFixedHex(utils.parseEther('0.01'))

    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Incorrect external data hash')
  })

  it('should reject double spend', async function () {
    const { etherPool } = await loadFixture(fixture)

    const aliceKeypair = new Keypair()
    const aliceDepositAmount = utils.parseEther('0.1')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount, keypair: aliceKeypair })
    await transaction({ etherPool, outputs: [aliceDepositUtxo] })

    const bobAddress = '0xDeaD00000000000000000000000000000000BEEf'
    const withdrawAmount = utils.parseEther('0.05')
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(withdrawAmount),
      keypair: aliceKeypair,
    })
    await transaction({
      etherPool,
      inputs: [aliceDepositUtxo],
      outputs: [aliceChangeUtxo],
      recipient: bobAddress,
    })

    // Attempt to reuse the same UTXO (double spend)
    const aliceChangeUtxo2 = new Utxo({ amount: 0, keypair: aliceKeypair })
    await expect(
      transaction({
        etherPool,
        inputs: [aliceDepositUtxo],
        outputs: [aliceChangeUtxo2],
        recipient: bobAddress,
      }),
    ).to.be.revertedWith('Input is already spent')
  })

  it('should reject deposit exceeding limit', async function () {
    const { etherPool } = await loadFixture(fixture)

    const overLimitAmount = MAXIMUM_DEPOSIT_AMOUNT.add(1)
    const utxo = new Utxo({ amount: overLimitAmount })
    await expect(
      transaction({ etherPool, outputs: [utxo] }),
    ).to.be.revertedWith('amount is larger than maximumDepositAmount')
  })

  it('non-admin cannot configure limits', async () => {
    const { etherPool, sender } = await loadFixture(fixture)
    await expect(
      etherPool.connect(sender).configureLimits(utils.parseEther('999')),
    ).to.be.revertedWith('only admin')
  })

  it('should reject direct ETH transfers', async function () {
    const { etherPool, sender } = await loadFixture(fixture)
    await expect(
      sender.sendTransaction({ to: etherPool.address, value: utils.parseEther('1') }),
    ).to.be.revertedWith('Use transact() to deposit')
  })

  it('admin can transfer admin to new address', async function () {
    const { etherPool, admin, gov } = await loadFixture(fixture)

    await etherPool.connect(admin).transferAdmin(gov.address)
    expect(await etherPool.pendingAdmin()).to.equal(gov.address)
    expect(await etherPool.admin()).to.equal(admin.address)

    await etherPool.connect(gov).claimAdmin()
    expect(await etherPool.admin()).to.equal(gov.address)
    expect(await etherPool.pendingAdmin()).to.equal(ethers.constants.AddressZero)
  })

  it('non-admin cannot transfer admin', async function () {
    const { etherPool, sender, gov } = await loadFixture(fixture)
    await expect(
      etherPool.connect(sender).transferAdmin(gov.address),
    ).to.be.revertedWith('only admin')
  })

  it('non-pending admin cannot claim admin', async function () {
    const { etherPool, admin, sender, gov } = await loadFixture(fixture)
    await etherPool.connect(admin).transferAdmin(gov.address)
    await expect(
      etherPool.connect(sender).claimAdmin(),
    ).to.be.revertedWith('not pending admin')
  })

  it('cannot transfer admin to zero address', async function () {
    const { etherPool, admin } = await loadFixture(fixture)
    await expect(
      etherPool.connect(admin).transferAdmin(ethers.constants.AddressZero),
    ).to.be.revertedWith('new admin is zero address')
  })

  it('admin can overwrite pending admin before claim', async function () {
    const { etherPool, admin, gov, sender } = await loadFixture(fixture)

    await etherPool.connect(admin).transferAdmin(gov.address)
    expect(await etherPool.pendingAdmin()).to.equal(gov.address)

    await etherPool.connect(admin).transferAdmin(sender.address)
    expect(await etherPool.pendingAdmin()).to.equal(sender.address)

    await expect(
      etherPool.connect(gov).claimAdmin(),
    ).to.be.revertedWith('not pending admin')

    await etherPool.connect(sender).claimAdmin()
    expect(await etherPool.admin()).to.equal(sender.address)
  })

  it('new admin can configure limits after transfer', async function () {
    const { etherPool, admin, gov } = await loadFixture(fixture)

    await etherPool.connect(admin).transferAdmin(gov.address)
    await etherPool.connect(gov).claimAdmin()

    const newLimit = utils.parseEther('500')
    await etherPool.connect(gov).configureLimits(newLimit)
    expect(await etherPool.maximumDepositAmount()).to.equal(newLimit)

    await expect(
      etherPool.connect(admin).configureLimits(utils.parseEther('1')),
    ).to.be.revertedWith('only admin')
  })

  it('cannot initialize twice', async function () {
    const { etherPool, admin } = await loadFixture(fixture)
    await expect(
      etherPool.connect(admin).initialize(utils.parseEther('2'), admin.address),
    ).to.be.reverted
  })

  it('should deposit and withdraw full amount, then deposit again', async function () {
    const { etherPool } = await loadFixture(fixture)

    // First cycle: deposit and withdraw everything
    const depositAmount1 = utils.parseEther('0.1')
    const depositUtxo1 = new Utxo({ amount: depositAmount1 })
    await transaction({ etherPool, outputs: [depositUtxo1] })

    const recipient1 = '0xDeaD00000000000000000000000000000000BEEf'
    await transaction({
      etherPool,
      inputs: [depositUtxo1],
      outputs: [],
      recipient: recipient1,
    })

    expect(await ethers.provider.getBalance(recipient1)).to.be.equal(depositAmount1)
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(0)

    // Second cycle: deposit again after pool was fully drained
    const depositAmount2 = utils.parseEther('0.05')
    const depositUtxo2 = new Utxo({ amount: depositAmount2 })
    await transaction({ etherPool, outputs: [depositUtxo2] })

    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(depositAmount2)

    // Withdraw from the second deposit
    const recipient2 = '0x000000000000000000000000000000000000dEaD'
    await transaction({
      etherPool,
      inputs: [depositUtxo2],
      outputs: [],
      recipient: recipient2,
    })

    expect(await ethers.provider.getBalance(recipient2)).to.be.equal(depositAmount2)
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(0)
  })

  it('can deposit after increasing limit', async function () {
    const { etherPool, admin } = await loadFixture(fixture)

    const largeAmount = utils.parseEther('5')
    const utxo = new Utxo({ amount: largeAmount })

    // Should fail with default limit (1 ETH)
    await expect(
      transaction({ etherPool, outputs: [utxo] }),
    ).to.be.revertedWith('amount is larger than maximumDepositAmount')

    // Increase limit
    await etherPool.connect(admin).configureLimits(utils.parseEther('1000'))

    // Should now succeed
    await transaction({ etherPool, outputs: [utxo] })
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(largeAmount)
  })

  it('cannot deposit after decreasing limit', async function () {
    const { etherPool, admin } = await loadFixture(fixture)

    // Deposit 0.5 ETH (within default 1 ETH limit)
    const depositUtxo = new Utxo({ amount: utils.parseEther('0.5') })
    await transaction({ etherPool, outputs: [depositUtxo] })

    // Decrease limit to 0.1 ETH
    await etherPool.connect(admin).configureLimits(utils.parseEther('0.1'))

    // Now 0.5 ETH deposit should fail
    const utxo = new Utxo({ amount: utils.parseEther('0.5') })
    await expect(
      transaction({ etherPool, outputs: [utxo] }),
    ).to.be.revertedWith('amount is larger than maximumDepositAmount')
  })

  it('withdrawal has no limit', async function () {
    const { etherPool, admin } = await loadFixture(fixture)

    // Set limit high enough for initial deposit
    await etherPool.connect(admin).configureLimits(utils.parseEther('200'))

    // Deposit 100 ETH
    const depositAmount = utils.parseEther('100')
    const depositUtxo = new Utxo({ amount: depositAmount })
    await transaction({ etherPool, outputs: [depositUtxo] })

    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(depositAmount)

    // Lower deposit limit to 50 ETH
    await etherPool.connect(admin).configureLimits(utils.parseEther('50'))

    // Verify new 100 ETH deposit fails
    const blockedUtxo = new Utxo({ amount: depositAmount })
    await expect(
      transaction({ etherPool, outputs: [blockedUtxo] }),
    ).to.be.revertedWith('amount is larger than maximumDepositAmount')

    // Withdraw the full 100 ETH -- should succeed despite 50 ETH deposit limit
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    await transaction({
      etherPool,
      inputs: [depositUtxo],
      outputs: [],
      recipient,
    })

    expect(await ethers.provider.getBalance(recipient)).to.be.equal(depositAmount)
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(0)
  })

  it('arithmetic overflow protection', async function () {
    const { etherPool } = await loadFixture(fixture)

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      etherPool,
      outputs: [utxo],
    })

    // Set publicAmount to max uint256 (would overflow in unchecked math)
    args.publicAmount = ethers.constants.MaxUint256.toHexString()

    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.reverted
  })

  it('should deposit with zero fee and withdraw with positive fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    const [, , , relayer] = await ethers.getSigners()

    // Deposit with zero fee
    const depositAmount = utils.parseEther('0.1')
    const depositUtxo = new Utxo({ amount: depositAmount })
    await transaction({ etherPool, outputs: [depositUtxo], fee: 0 })

    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(depositAmount)

    // Withdraw with positive relayer fee
    const withdrawFee = utils.parseEther('0.02')
    const recipient = '0xDeaD00000000000000000000000000000000BEEf'
    await transaction({
      etherPool,
      inputs: [depositUtxo],
      outputs: [],
      recipient,
      fee: withdrawFee,
      relayer: relayer.address,
    })

    const recipientBalance = await ethers.provider.getBalance(recipient)
    expect(recipientBalance).to.be.equal(depositAmount.sub(withdrawFee))
    expect(await ethers.provider.getBalance(etherPool.address)).to.be.equal(0)
  })

  it('should reject incorrect ETH value on deposit', async function () {
    const { etherPool } = await loadFixture(fixture)

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      etherPool,
      outputs: [utxo],
    })
    // Send wrong msg.value (too little)
    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount.sub(1),
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Incorrect ETH value')
  })

  it('should reject withdraw to zero address', async function () {
    const { etherPool } = await loadFixture(fixture)

    const depositAmount = utils.parseEther('0.05')
    const depositUtxo = new Utxo({ amount: depositAmount })
    await transaction({ etherPool, outputs: [depositUtxo] })

    await expect(
      transaction({
        etherPool,
        inputs: [depositUtxo],
        outputs: [],
        recipient: '0x0000000000000000000000000000000000000000',
      }),
    ).to.be.revertedWith("Can't withdraw to zero address")
  })

  it('should reject unknown root', async function () {
    const { etherPool } = await loadFixture(fixture)

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      etherPool,
      outputs: [utxo],
    })

    // Replace root with an unknown value
    args.root = toFixedHex(123456789)

    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('should reject zero root', async function () {
    const { etherPool } = await loadFixture(fixture)

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      etherPool,
      outputs: [utxo],
    })

    args.root = toFixedHex(0)

    await expect(
      etherPool.transact(args, extData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Invalid merkle root')
  })

  it('should reject wrong extDataHash', async function () {
    const { etherPool } = await loadFixture(fixture)

    const depositAmount = utils.parseEther('0.05')
    const utxo = new Utxo({ amount: depositAmount })
    const { args, extData } = await prepareTransaction({
      etherPool,
      outputs: [utxo],
    })

    // Tamper with extData after proof was generated (changing recipient)
    const tamperedExtData = { ...extData, recipient: '0xDeaD00000000000000000000000000000000BEEf' }

    await expect(
      etherPool.transact(args, tamperedExtData, {
        value: depositAmount,
        gasLimit: 50e6,
      }),
    ).to.be.revertedWith('Incorrect external data hash')
  })

  it('should reject zero extAmount (no shielded transfers)', async function () {
    const { etherPool } = await loadFixture(fixture)
    await expect(
      etherPool.calculatePublicAmount(0, 0),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should reject zero extAmount with positive fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    await expect(
      etherPool.calculatePublicAmount(0, utils.parseEther('0.01')),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should reject deposit where fee equals extAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    const amount = utils.parseEther('0.1')
    await expect(
      etherPool.calculatePublicAmount(amount, amount),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should reject deposit where fee exceeds extAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    await expect(
      etherPool.calculatePublicAmount(utils.parseEther('0.05'), utils.parseEther('0.1')),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should reject withdrawal where fee equals extAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    const amount = utils.parseEther('0.1')
    await expect(
      etherPool.calculatePublicAmount(amount.mul(-1), amount),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should reject withdrawal where fee exceeds extAmount', async function () {
    const { etherPool } = await loadFixture(fixture)
    await expect(
      etherPool.calculatePublicAmount(utils.parseEther('-0.05'), utils.parseEther('0.1')),
    ).to.be.revertedWith('ext amount must exceed fee for deposits')
  })

  it('should accept deposit where extAmount exceeds fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    const result = await etherPool.calculatePublicAmount(
      utils.parseEther('0.1'),
      utils.parseEther('0.01'),
    )
    expect(result).to.be.equal(utils.parseEther('0.09'))
  })

  it('should accept withdrawal where extAmount exceeds fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    const fieldSize = await etherPool.FIELD_SIZE()
    const result = await etherPool.calculatePublicAmount(
      utils.parseEther('-0.1'),
      utils.parseEther('0.01'),
    )
    expect(result).to.be.equal(fieldSize.sub(utils.parseEther('0.11')))
  })

  it('should accept deposit with zero fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    const result = await etherPool.calculatePublicAmount(utils.parseEther('0.1'), 0)
    expect(result).to.be.equal(utils.parseEther('0.1'))
  })

  it('should accept withdrawal with zero fee', async function () {
    const { etherPool } = await loadFixture(fixture)
    const fieldSize = await etherPool.FIELD_SIZE()
    const result = await etherPool.calculatePublicAmount(utils.parseEther('-0.1'), 0)
    expect(result).to.be.equal(fieldSize.sub(utils.parseEther('0.1')))
  })

  it('should be compliant', async function () {
    // basically verifier should check if a commitment and a nullifier hash are on chain
    const { etherPool } = await loadFixture(fixture)
    const aliceDepositAmount = utils.parseEther('0.07')
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount })
    const [sender] = await ethers.getSigners()

    const { args, extData } = await prepareTransaction({
      etherPool,
      outputs: [aliceDepositUtxo],
    })
    const receipt = await etherPool.transact(args, extData, {
      value: aliceDepositAmount,
      gasLimit: 50e6,
    })
    await receipt.wait()

    // withdrawal
    await transaction({
      etherPool,
      inputs: [aliceDepositUtxo],
      outputs: [],
      recipient: sender.address,
    })

    const tree = await buildMerkleTree({ etherPool })
    const commitment = aliceDepositUtxo.getCommitment()
    const index = tree.indexOf(toFixedHex(commitment)) // it's the same as merklePath and merklePathIndexes and index in the tree
    aliceDepositUtxo.index = index
    const nullifier = aliceDepositUtxo.getNullifier()

    // commitment = hash(amount, pubKey, blinding, mintAddress)
    // nullifier = hash(commitment, merklePath, sign(merklePath, privKey))
    const dataForVerifier = {
      commitment: {
        amount: aliceDepositUtxo.amount,
        pubkey: aliceDepositUtxo.keypair.pubkey,
        blinding: aliceDepositUtxo.blinding,
        mintAddress: aliceDepositUtxo.mintAddress,
      },
      nullifier: {
        commitment,
        merklePath: index,
        signature: aliceDepositUtxo.keypair.sign(commitment, index),
      },
    }

    // generateReport(dataForVerifier) -> compliance report
    // on the verifier side we compute commitment and nullifier and then check them onchain
    const commitmentV = poseidonHash([...Object.values(dataForVerifier.commitment)])
    const nullifierV = poseidonHash([
      commitmentV,
      dataForVerifier.nullifier.merklePath,
      dataForVerifier.nullifier.signature,
    ])

    expect(commitmentV).to.be.equal(commitment)
    expect(nullifierV).to.be.equal(nullifier)
    expect(await etherPool.nullifierHashes(nullifierV)).to.be.equal(true)
    // expect commitmentV present onchain (it will be in NewCommitment events)

    // in report we can see the tx with NewCommitment event (this is how alice got money)
    // and the tx with NewNullifier event is where alice spent the UTXO
  })
})
