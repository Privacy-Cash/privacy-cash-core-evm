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
const DEPOSIT_AMOUNT = process.env.DEPOSIT_AMOUNT || '0.001'
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
  const network = await ethers.provider.getNetwork()
  console.log(`Network: chainId ${network.chainId}`)
  console.log(`Depositor: ${sender.address}`)
  console.log(`Balance: ${utils.formatEther(await sender.getBalance())} ETH`)

  const etherPool = await ethers.getContractAt('EtherPool', ETHER_POOL_ADDRESS)
  console.log(`EtherPool: ${etherPool.address}`)
  console.log(`Pool balance: ${utils.formatEther(await ethers.provider.getBalance(etherPool.address))} ETH`)

  const depositAmount = utils.parseEther(DEPOSIT_AMOUNT)

  // Find unspent UTXOs to use as inputs
  const store = loadStore()
  const unspent = await findUnspentUtxos(etherPool, store)
  console.log(`\nUnspent UTXOs found: ${unspent.length}`)

  let inputs = []
  let inputSum = ethers.BigNumber.from(0)

  if (unspent.length >= 2) {
    inputs = [unspent[0], unspent[1]]
    inputSum = inputs[0].amount.add(inputs[1].amount)
    console.log(`Using 2 existing UTXOs as inputs (${utils.formatEther(inputSum)} ETH)`)
  } else if (unspent.length === 1) {
    inputs = [unspent[0]]
    inputSum = inputs[0].amount
    console.log(`Using 1 existing UTXO as input (${utils.formatEther(inputSum)} ETH)`)
  } else {
    console.log('No existing UTXOs, creating fresh deposit')
  }

  // Single output UTXO that consolidates inputs + new deposit
  const outputAmount = inputSum.add(depositAmount)
  const outputKeypair = new Keypair()
  const outputUtxo = new Utxo({ amount: outputAmount, keypair: outputKeypair })

  console.log(`Depositing ${DEPOSIT_AMOUNT} ETH (new output: ${utils.formatEther(outputAmount)} ETH)`)

  const { args, extData } = await prepareTransaction({
    etherPool,
    inputs,
    outputs: [outputUtxo],
    fromBlock: DEPLOY_BLOCK,
  })

  const tx = await etherPool.transact(args, extData, {
    value: depositAmount,
    gasLimit: 3000000,
  })
  console.log(`Transaction sent: ${tx.hash}`)

  const receipt = await tx.wait()
  console.log(`Confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`)

  // Save the new output UTXO
  store.push({
    amount: outputUtxo.amount.toString(),
    blinding: outputUtxo.blinding.toString(),
    privkey: outputKeypair.privkey,
    index: null,
    timestamp: new Date().toISOString(),
  })
  saveStore(store)

  console.log(`\nNew UTXO saved (${utils.formatEther(outputAmount)} ETH)`)
  console.log(`Pool balance after: ${utils.formatEther(await ethers.provider.getBalance(etherPool.address))} ETH`)
  console.log(`Sender balance after: ${utils.formatEther(await sender.getBalance())} ETH`)
  console.log('\nDeposit successful!')
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
