const { ethers } = require('hardhat')
const { utils } = ethers
const { prepareTransaction, buildMerkleTree } = require('../src/index')
const Utxo = require('../src/utxo')
const { Keypair } = require('../src/keypair')
const { toFixedHex } = require('../src/utils')
const fs = require('fs')
const path = require('path')

const ETHER_POOL_ADDRESS = '0x74A6EBe030d07ae8653344d291DF87d7c0e2868B'
const DEPLOY_BLOCK = 38062882
const WITHDRAW_AMOUNT = process.env.WITHDRAW_AMOUNT || '0.001'
const RECIPIENT = process.env.RECIPIENT
const UTXO_STORE_PATH = path.join(__dirname, '..', '.utxos.json')

function loadStore() {
  if (fs.existsSync(UTXO_STORE_PATH)) {
    return JSON.parse(fs.readFileSync(UTXO_STORE_PATH, 'utf8'))
  }
  return []
}

function saveStore(store) {
  fs.writeFileSync(UTXO_STORE_PATH, JSON.stringify(store, null, 2))
}

async function findUnspentUtxos(etherPool, store) {
  const tree = await buildMerkleTree({ etherPool, fromBlock: DEPLOY_BLOCK })
  const unspent = []

  for (const entry of store) {
    const keypair = new Keypair(entry.privkey)
    const utxo = new Utxo({ amount: entry.amount, blinding: entry.blinding, keypair })
    const commitment = toFixedHex(utxo.getCommitment())
    const index = tree.indexOf(commitment)

    if (index < 0) continue

    utxo.index = index
    const nullifier = toFixedHex(utxo.getNullifier())
    const isSpent = await etherPool.isSpent(nullifier)
    if (!isSpent) {
      unspent.push(utxo)
    }
  }

  return unspent
}

async function main() {
  require('./compileHasher')

  const [sender] = await ethers.getSigners()
  const recipient = RECIPIENT || sender.address
  const network = await ethers.provider.getNetwork()
  console.log(`Network: chainId ${network.chainId}`)
  console.log(`Sender: ${sender.address}`)
  console.log(`Recipient: ${recipient}`)
  console.log(`Balance: ${utils.formatEther(await sender.getBalance())} ETH`)

  const etherPool = await ethers.getContractAt('EtherPool', ETHER_POOL_ADDRESS)
  console.log(`EtherPool: ${etherPool.address}`)
  console.log(`Pool balance: ${utils.formatEther(await ethers.provider.getBalance(etherPool.address))} ETH`)

  const withdrawAmount = utils.parseEther(WITHDRAW_AMOUNT)

  // Find unspent UTXOs
  const store = loadStore()
  const unspent = await findUnspentUtxos(etherPool, store)
  console.log(`\nUnspent UTXOs found: ${unspent.length}`)

  if (unspent.length === 0) {
    console.log('No unspent UTXOs available to withdraw.')
    return
  }

  // Pick inputs: use up to 2 unspent UTXOs
  let inputs
  if (unspent.length >= 2) {
    inputs = [unspent[0], unspent[1]]
  } else {
    inputs = [unspent[0]]
  }

  const inputSum = inputs.reduce((sum, u) => sum.add(u.amount), ethers.BigNumber.from(0))
  console.log(`Input UTXOs: ${inputs.length} (total: ${utils.formatEther(inputSum)} ETH)`)

  if (inputSum.lt(withdrawAmount)) {
    console.log(`Insufficient balance. Have ${utils.formatEther(inputSum)} ETH, need ${WITHDRAW_AMOUNT} ETH.`)
    return
  }

  // Change goes back into a new UTXO
  const changeAmount = inputSum.sub(withdrawAmount)
  const outputs = []
  let changeKeypair

  if (changeAmount.gt(0)) {
    changeKeypair = new Keypair()
    outputs.push(new Utxo({ amount: changeAmount, keypair: changeKeypair }))
    console.log(`Change UTXO: ${utils.formatEther(changeAmount)} ETH`)
  }

  console.log(`\nWithdrawing ${WITHDRAW_AMOUNT} ETH to ${recipient}...`)

  const { args, extData } = await prepareTransaction({
    etherPool,
    inputs,
    outputs,
    recipient,
    fromBlock: DEPLOY_BLOCK,
  })

  const tx = await etherPool.transact(args, extData, { gasLimit: 3000000 })
  console.log(`Transaction sent: ${tx.hash}`)

  const receipt = await tx.wait()
  console.log(`Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`)

  // Save change UTXO if any
  if (changeAmount.gt(0) && changeKeypair) {
    store.push({
      amount: changeAmount.toString(),
      blinding: outputs[0].blinding.toString(),
      privkey: changeKeypair.privkey,
      index: null,
      timestamp: new Date().toISOString(),
    })
    saveStore(store)
    console.log(`\nChange UTXO saved (${utils.formatEther(changeAmount)} ETH)`)
  }

  console.log(`Pool balance after: ${utils.formatEther(await ethers.provider.getBalance(etherPool.address))} ETH`)
  console.log(`Recipient balance: ${utils.formatEther(await ethers.provider.getBalance(recipient))} ETH`)
  console.log('\nWithdrawal successful!')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
