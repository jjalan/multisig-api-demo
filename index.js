var _ = require('lodash');
var restify = require('restify');
var Web3 = require('web3');
var SolidityFunction = require('web3/lib/web3/function');
var EthereumTx = require('ethereumjs-tx');
var Accounts = require('web3-eth-accounts');

// TODO: Move these in a config file
var SERVER_PORT = process.env.PORT || 8080;
var WALLET_FACTORY_CONTRACT_ADDRESS = '0xd18df206913b8e04371c543b631b7121a5c09c14';
var WALLET_FACTORY_CONTRACT_ABI = require('./abi.js');
var ETHEREUM_NODE = 'https://api.myetherapi.com/rop';
var ETHEREUM_NODE_CHAIN_ID = 3;
var SERVER_ETHEREUM_FROM_ADDRESS = '0x4054Db09C41e787cF5014A453f91c71418faB9AF';
var SERVER_ETHEREUM_PRIVATE_KEY = 'b5eae943a077be8b3d53d91dd87818f3c869b7ac58723aca1e57575e2a691e3c';

var MAX_WALLET_OWNERS = 3;
var MIN_SIGNATURES_REQUIRED = 2;

var web3 = new Web3(new Web3.providers.HttpProvider(ETHEREUM_NODE));

// This function creates a wallet from wallet factory
// and stores that entry in database for future quering
function createWallet(req, res, next) {
  
  // Since its going to be a 2/3 multi sig wallet,
  // we will associate three account owners with this wallet
  var ownerAccounts = [];
  var accountOwnerAddresses = [];
  var accounts = new Accounts(ETHEREUM_NODE);
  
  for (var i = 0; i < MAX_WALLET_OWNERS; i++) {
    // Latest version of web3 has option to create account directly
    // However, we are forced to use 0.17.0-alpha version of Web3 (see more below)
    // due to which we are using web3-eth-accounts library to create accounts
    var ethAccount = accounts.create();
    ownerAccounts.push(ethAccount);
    accountOwnerAddresses.push(ethAccount.address);
  }
  
  // Since we are interacting with a node that is not local and we do not own,
  // we need to sign this transaction
  // See here for more details: https://forum.ethereum.org/discussion/5039/how-to-use-web3-js-to-sign-a-contract-call
  // Due to this, we use 0.17.0-alpha version of Web3 which gives us access to SolidityFunction
  // Latest builds do not have access to it.
  var payloadData = new SolidityFunction('', _.find(WALLET_FACTORY_CONTRACT_ABI, { name: 'create' }), '').toPayload([accountOwnerAddresses, MIN_SIGNATURES_REQUIRED]).data;
  
  var nounce = web3.toHex(web3.eth.getTransactionCount(SERVER_ETHEREUM_FROM_ADDRESS));
  var gasPrice = web3.toHex(web3.eth.gasPrice);
  var gasLimit = web3.toHex(web3.eth.getBlock('latest').gasLimit);
  
  var tx = new EthereumTx({
    nonce: nounce,
    gasPrice: gasPrice,
    gasLimit: gasLimit,
    to: WALLET_FACTORY_CONTRACT_ADDRESS, 
    value: '0x00', 
    data: payloadData,
    chainId: ETHEREUM_NODE_CHAIN_ID
  });
  
  tx.sign(Buffer.from(SERVER_ETHEREUM_PRIVATE_KEY, 'hex'));
  
  var serializedTx = tx.serialize();
  
  web3.eth.sendRawTransaction('0x' + serializedTx.toString('hex'), function(err, hash) {
    if (err) {
      console.log(err)
      next(err);
      return;
    }
    console.log(hash)
    res.send({
      hash: hash,
      accounts: ownerAccounts
    });
  });
}

var server = restify.createServer();
server.post('/wallet', createWallet);

server.listen(SERVER_PORT, function () {
  console.log('%s listening at %s', server.name, server.url);
});