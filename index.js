var _ = require('lodash');
var restify = require('restify');
var corsMiddleware = require('restify-cors-middleware');
var Web3 = require('web3');
var SolidityFunction = require('web3/lib/web3/function');
var EthereumTx = require('ethereumjs-tx');
var Accounts = require('web3-eth-accounts');
var MongoClient = require('mongodb').MongoClient;

// TODO: Move these in a config file
var SERVER_PORT = process.env.PORT || 8080;
var WALLET_FACTORY_CONTRACT_ADDRESS = '0xd18df206913b8e04371c543b631b7121a5c09c14';
var WALLET_FACTORY_CONTRACT_ABI = require('./abi/wallet-factory.js');
var WALLET_CONTRACT_ABI = require('./abi/wallet.js');
var ETHEREUM_NODE = 'https://api.myetherapi.com/rop';
var ETHEREUM_NODE_CHAIN_ID = 3;
var SERVER_ETHEREUM_FROM_ADDRESS = '0x4054Db09C41e787cF5014A453f91c71418faB9AF';
var SERVER_ETHEREUM_PRIVATE_KEY = 'b5eae943a077be8b3d53d91dd87818f3c869b7ac58723aca1e57575e2a691e3c';
var DB_URI = process.env.DATABASE_URI || 'mongodb://localhost:27017/multisig';

var MAX_WALLET_OWNERS = 3;
var MIN_SIGNATURES_REQUIRED = 2;

var web3 = new Web3(new Web3.providers.HttpProvider(ETHEREUM_NODE));
var db = null;

// This function creates a wallet from wallet factory
// and stores that entry in database for future quering
function createWallet(req, res, next) {
  
  // Since its going to be a 2/3 multi sig wallet,
  // we will associate three account owners with this wallet
  var accountOwnerAddresses = [SERVER_ETHEREUM_FROM_ADDRESS];
  var accounts = new Accounts(ETHEREUM_NODE);
  
  for (var i = 0; i < MAX_WALLET_OWNERS-1; i++) {
    // Latest version of web3 has option to create account directly
    // However, we are forced to use 0.17.0-alpha version of Web3 (see more below)
    // due to which we are using web3-eth-accounts library to create accounts
    var ethAccount = accounts.create();
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
  
  // Whenever a new wallet is created, it will return the contract address
  // via ContractInstantiation event
  var walletFactoryContractInstance = web3.eth.contract(WALLET_FACTORY_CONTRACT_ABI).at(WALLET_FACTORY_CONTRACT_ADDRESS);
  walletFactoryContractInstance.ContractInstantiation({}, function (err, event) {
    
    if (err) {
      return;
    }
    
    if (event 
      && event.args 
      && event.args.sender === SERVER_ETHEREUM_FROM_ADDRESS.toLowerCase()) {
        
        var hash = event.transactionHash;
        var walletAddress = event.args.instantiation;
      
        // Get details about the wallet
        var walletContractInstance = web3.eth.contract(WALLET_CONTRACT_ABI).at(walletAddress);
        var numberOfConfirmationsRequired = parseFloat(walletContractInstance.required());
        var balance = getBalanceInEther(parseFloat(walletContractInstance._eth.getBalance(walletAddress)));
        var owners = walletContractInstance.getOwners();
      
        var obj = {
          walletAddress: walletAddress,
          owners: owners,
          balance: balance,
          numberOfConfirmationsRequired: numberOfConfirmationsRequired
        };
        
        db.collection('wallets').update({txHash: hash}, {$set: obj}, function () {});
      }
  });
          
  web3.eth.sendRawTransaction('0x' + serializedTx.toString('hex'), function(err, hash) {
    if (err) {
      next(err);
      return;
    }
    
    var obj = {
      txHash: hash,
      createdAt: (new Date()).getTime()
    }
    
    db.collection('wallets').insertOne(obj, function (err, result) {
      if (err) {
        return;
      }
      
      obj._id = result.insertedId;
      res.send(obj);
    });
  });
}

// Returns all the wallets created by /wallet API
function getAllWallets(req, res, next) {
  db.collection('wallets').find({}).sort({createdAt: -1}).toArray(function (err, wallets) {
    if (err) {
      next(err);
      return;
    }
    
    // Get balance for each wallet
    for (var i = 0; i < wallets.length; i++) {
      var wallet = wallets[i];
      if (wallet.walletAddress) {
        // Get its balance as it may change between queries
        var walletContractInstance = web3.eth.contract(WALLET_CONTRACT_ABI).at(wallet.walletAddress);
        wallet.balance = getBalanceInEther(parseFloat(walletContractInstance._eth.getBalance(wallet.walletAddress)));
      }
    }
    res.send(wallets);
  });
}

// Gets information about a wallet using transaction hash
function getWalletInfo(req, res, next) {
  db.collection('wallets').findOne({txHash: req.params.txhash}, function (err, wallet) {
    if (err) {
      next(err);
      return;
    }
    
    if (wallet && wallet.walletAddress) {
      var walletContractInstance = web3.eth.contract(WALLET_CONTRACT_ABI).at(wallet.walletAddress);
      wallet.balance = getBalanceInEther(parseFloat(walletContractInstance._eth.getBalance(wallet.walletAddress)));
      res.send(wallet);
    } else {
      res.send({});
    }
  });
}

// Sends money from one account to another
function sendMoney(req, res, next) {
  var origin = req.params.walletaddress;
  var destination = req.body.destination;
  var amount = new Web3().toBigNumber(parseFloat(req.body.amount)).mul('1e18');
  var payloadData = new SolidityFunction('', _.find(WALLET_CONTRACT_ABI, { name: 'submitTransaction' }), '').toPayload([destination, amount, '0x0']).data;
  var nonce = web3.toHex(web3.eth.getTransactionCount(SERVER_ETHEREUM_FROM_ADDRESS));
  var gasPrice = web3.toHex(web3.eth.gasPrice);
  var gasLimit = web3.toHex(web3.eth.getBlock('latest').gasLimit);
  
  var tx = new EthereumTx({
    nonce: nonce,
    gasPrice: gasPrice,
    gasLimit: gasLimit,
    to: origin, 
    value: '0x00', 
    data: payloadData,
    chainId: ETHEREUM_NODE_CHAIN_ID
  });
  
  tx.sign(Buffer.from(SERVER_ETHEREUM_PRIVATE_KEY, 'hex'));
  
  var serializedTx = tx.serialize();
  
  // Whenever a new transaction is submitted, it will return the contract address
  // via ContractInstantiation event
  var walletContractInstance = web3.eth.contract(WALLET_CONTRACT_ABI).at(origin);
  walletContractInstance.Confirmation({}, function (err, event) {
    if (err) {
      return;
    }
    
    if (event 
      && event.args 
      && event.args.sender === SERVER_ETHEREUM_FROM_ADDRESS.toLowerCase()) {
        var hash = event.transactionHash;
        var obj = {
          transactionId: web3.toHex(event.args.transactionId)
        };
        
        db.collection('transactions').update({txHash: hash}, {$set: obj}, function () {});
      }
  });
  web3.eth.sendRawTransaction('0x' + serializedTx.toString('hex'), function(err, hash) {
    if (err) {
      next(err);
      return;
    }
    
    var obj = {
      txHash: hash,
      createdAt: (new Date()).getTime()
    }
    
    db.collection('transactions').insertOne(obj, function (err, result) {
      if (err) {
        next(err);
        return;
      }
      
      obj._id = result.insertedId;
      res.send(obj);
    });
  });
}

// Returns information about 
function getSelfInfo(req, res, next) {
  var balance = getBalanceInEther(parseFloat(web3.eth.getBalance(SERVER_ETHEREUM_FROM_ADDRESS)));
  res.send({balance: balance});
}

function getBalanceInEther(val) {
  return (val/1000000000000000000);
}

MongoClient.connect(DB_URI, function(err, database) {
	if (err) {
		console.log(err);
    return;
	}
  
  db = database;
  var server = restify.createServer();
  var cors = corsMiddleware({
    origins: ['*']
  });
  server.pre(cors.preflight);
  server.use(cors.actual);
  server.use(restify.plugins.acceptParser(server.acceptable));
  server.use(restify.plugins.queryParser());
  server.use(restify.plugins.bodyParser());
  
  server.get('/me', getSelfInfo);
  server.get('/wallets', getAllWallets);
  server.get('/wallet/tx/:txhash', getWalletInfo);
  
  server.post('/wallet', createWallet);
  server.post('/wallet/:walletaddress/send', sendMoney);
  
  server.listen(SERVER_PORT, function () {
    console.log('%s listening at %s', server.name, server.url);
  });
});