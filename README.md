### To start the project:

```
npm install
```

```
npm start
```

This project uses MongoDB in order to store wallets created by it. Please make sure that you have a mongo db server instance running on port 27017. If there is any conflict, try setting `DATABASE_URI` node environment variable.

### To create a multisig wallet:

```
curl -is -X POST http://localhost:8080/wallet
```

Since it can take sometime to confirm the transaction, this API would return transaction hash. When the wallet info is available it could be queries as follows:

```
curl -is http://localhost:8080/wallet/tx/:txhash
```

### To get all multisig wallets created via API:

```
curl -is http://localhost:8080/wallets
```