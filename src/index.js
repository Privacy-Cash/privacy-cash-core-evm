/* eslint-disable no-console */
const MerkleTree = require('fixed-merkle-tree')
const { ethers } = require('hardhat')
const { BigNumber } = ethers
const { toFixedHex, poseidonHash2, getExtDataHash, FIELD_SIZE, shuffle } = require('./utils')
const Utxo = require('./utxo')

const { prove } = require('./prover')
const MERKLE_TREE_HEIGHT = 26
const MERKLE_TREE_ZERO_VALUE = '21663839004416932945382355908790599225266501822907911457504978515578255421292'

async function buildMerkleTree({ etherPool, fromBlock = 0 }) {
  const filter = etherPool.filters.NewCommitment()
  const currentBlock = await etherPool.provider.getBlockNumber()

  const BATCH_SIZE = 9
  let allEvents = []
  for (let from = fromBlock; from <= currentBlock; from += BATCH_SIZE + 1) {
    const to = Math.min(from + BATCH_SIZE, currentBlock)
    const events = await etherPool.queryFilter(filter, from, to)
    allEvents = allEvents.concat(events)
  }

  const leaves = allEvents.sort((a, b) => a.args.index - b.args.index).map((e) => toFixedHex(e.args.commitment))
  return new MerkleTree(MERKLE_TREE_HEIGHT, leaves, { hashFunction: poseidonHash2, zeroElement: MERKLE_TREE_ZERO_VALUE })
}

async function getProof({
  inputs,
  outputs,
  tree,
  extAmount,
  fee,
  recipient,
  relayer,
}) {
  inputs = shuffle(inputs)
  outputs = shuffle(outputs)

  let inputMerklePathIndices = []
  let inputMerklePathElements = []

  for (const input of inputs) {
    if (input.amount > 0) {
      input.index = tree.indexOf(toFixedHex(input.getCommitment()))
      if (input.index < 0) {
        throw new Error(`Input commitment ${toFixedHex(input.getCommitment())} was not found`)
      }
      inputMerklePathIndices.push(input.index)
      inputMerklePathElements.push(tree.path(input.index).pathElements.map((x) => x.toString()))
    } else {
      inputMerklePathIndices.push(0)
      inputMerklePathElements.push(new Array(tree.levels).fill(0))
    }
  }

  const extData = {
    recipient: toFixedHex(recipient, 20),
    extAmount: toFixedHex(extAmount),
    relayer: toFixedHex(relayer, 20),
    fee: toFixedHex(fee),
    encryptedOutput1: outputs[0].encrypt(),
    encryptedOutput2: outputs[1].encrypt(),
  }

  const extDataHash = getExtDataHash(extData)
  let input = {
    root: tree.root().toString(),
    inputNullifier: inputs.map((x) => x.getNullifier().toString()),
    outputCommitment: outputs.map((x) => x.getCommitment().toString()),
    publicAmount: BigNumber.from(extAmount).sub(fee).add(FIELD_SIZE).mod(FIELD_SIZE).toString(),
    extDataHash: extDataHash.toString(),
    mintAddress: inputs[0].mintAddress.toString(),

    // data for 2 transaction inputs
    inAmount: inputs.map((x) => x.amount.toString()),
    inPrivateKey: inputs.map((x) => x.keypair.privkey.toString()),
    inBlinding: inputs.map((x) => x.blinding.toString()),
    inPathIndices: inputMerklePathIndices,
    inPathElements: inputMerklePathElements,

    // data for 2 transaction outputs
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
  // console.log('Solidity args', args)

  return {
    extData,
    args,
  }
}

async function prepareTransaction({
  etherPool,
  inputs = [],
  outputs = [],
  fee = 0,
  recipient = 0,
  relayer = 0,
  fromBlock = 0,
}) {
  if (inputs.length > 2 || outputs.length > 2) {
    throw new Error('Incorrect inputs/outputs count')
  }
  while (inputs.length < 2) {
    inputs.push(new Utxo())
  }
  while (outputs.length < 2) {
    outputs.push(new Utxo())
  }

  let extAmount = BigNumber.from(fee)
    .add(outputs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))
    .sub(inputs.reduce((sum, x) => sum.add(x.amount), BigNumber.from(0)))

  const { args, extData } = await getProof({
    inputs,
    outputs,
    tree: await buildMerkleTree({ etherPool, fromBlock }),
    extAmount,
    fee,
    recipient,
    relayer,
  })

  return {
    args,
    extData,
  }
}

async function transaction({ etherPool, ...rest }) {
  const { args, extData } = await prepareTransaction({
    etherPool,
    ...rest,
  })

  const overrides = { gasLimit: 50e6 }
  const extAmount = BigNumber.from(extData.extAmount)
  if (extAmount.gt(0)) {
    overrides.value = extAmount
  }

  const receipt = await etherPool.transact(args, extData, overrides)
  return await receipt.wait()
}

async function registerAndTransact({ etherPool, account, ...rest }) {
  const { args, extData } = await prepareTransaction({
    etherPool,
    ...rest,
  })

  const overrides = { gasLimit: 50e6 }
  const extAmount = BigNumber.from(extData.extAmount)
  if (extAmount.gt(0)) {
    overrides.value = extAmount
  }

  const receipt = await etherPool.registerAndTransact(account, args, extData, overrides)
  await receipt.wait()
}

module.exports = { transaction, registerAndTransact, prepareTransaction, buildMerkleTree }
