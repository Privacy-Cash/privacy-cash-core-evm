const { ethers } = require('hardhat')
const { utils } = ethers
const { buildMerkleTree } = require('../src/index')
const { toFixedHex, poseidonHash } = require('../src/utils')
const { Keypair } = require('../src/keypair')
const Utxo = require('../src/utxo')
const fs = require('fs')
const path = require('path')

const ETHER_POOL_ADDRESS = '0x74A6EBe030d07ae8653344d291DF87d7c0e2868B'
const DEPLOY_BLOCK = 38062882
const UTXO_STORE_PATH = path.join(__dirname, '..', '.utxos.json')

async function main() {
  require('./compileHasher')

  const etherPool = await ethers.getContractAt('EtherPool', ETHER_POOL_ADDRESS)
  const poolBalance = await ethers.provider.getBalance(etherPool.address)
  console.log(`EtherPool: ${etherPool.address}`)
  console.log(`Pool on-chain balance: ${utils.formatEther(poolBalance)} ETH`)

  if (!fs.existsSync(UTXO_STORE_PATH)) {
    console.log('\nNo UTXOs found. Run deposit:testnet first.')
    return
  }

  const store = JSON.parse(fs.readFileSync(UTXO_STORE_PATH, 'utf8'))
  console.log(`\nLocal UTXOs: ${store.length}`)

  // Rebuild the on-chain Merkle tree
  const tree = await buildMerkleTree({ etherPool, fromBlock: DEPLOY_BLOCK })
  console.log(`On-chain commitments: ${tree.elements().length}`)

  let unspentTotal = ethers.BigNumber.from(0)
  let spentCount = 0
  let unspentCount = 0

  for (let i = 0; i < store.length; i++) {
    const entry = store[i]
    const keypair = new Keypair(entry.privkey)
    const utxo = new Utxo({
      amount: entry.amount,
      blinding: entry.blinding,
      keypair,
    })

    const commitment = toFixedHex(utxo.getCommitment())
    const index = tree.indexOf(commitment)

    if (index < 0) {
      console.log(`  #${i}: ${utils.formatEther(entry.amount)} ETH - NOT IN TREE (pending or invalid)`)
      continue
    }

    utxo.index = index
    const nullifier = toFixedHex(utxo.getNullifier())
    const isSpent = await etherPool.isSpent(nullifier)

    if (isSpent) {
      console.log(`  #${i}: ${utils.formatEther(entry.amount)} ETH - SPENT`)
      spentCount++
    } else {
      console.log(`  #${i}: ${utils.formatEther(entry.amount)} ETH - UNSPENT (index: ${index})`)
      unspentTotal = unspentTotal.add(entry.amount)
      unspentCount++
    }
  }

  console.log(`\n--- Summary ---`)
  console.log(`Unspent UTXOs: ${unspentCount}`)
  console.log(`Spent UTXOs:   ${spentCount}`)
  console.log(`Total unspent: ${utils.formatEther(unspentTotal)} ETH`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
