import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';
import {BigNumber} from 'bignumber.js';
import {sprintf} from 'sprintf-js';

export class UrTransactionImportQueueProcessor extends QueueProcessor {
  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/urTransactionImportQueue/specs/import", {
        "start_state": "ready_to_import",
        "in_progress_state": "processing",
        "error_state": "error",
        "timeout": 120000,
        "retries": 5
      }),
      this.ensureQueueSpecLoaded("/urTransactionImportQueue/specs/wait", {
        "start_state": "ready_to_wait",
        "in_progress_state": "waiting",
        "error_state": "error",
        "timeout": 120000,
        "retries": 5
      }),
      this.setUpUrTransactionImportQueue()
    ];
  }

  process(): any[] {
    let self = this;
    let queueRef = self.db.ref("/urTransactionImportQueue");

    let waitOptions = { 'specId': 'wait', 'numWorkers': 1, sanitize: false };
    let waitQueue = new self.Queue(queueRef, waitOptions, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(waitQueue, task);
      let blockNumber: number = parseInt(task._id);
      setTimeout(() => {
        self.logAndResolveIfPossible(waitQueue, _.merge(task, { _new_state: "ready_to_import" }), resolve, reject);
      }, 15 * 1000);
    });

    let importOptions = { 'specId': 'import', 'numWorkers': 1, sanitize: false };
    let importQueue = new self.Queue(queueRef, importOptions, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(importQueue, task);
      let blockNumber: number = parseInt(task._id);
      let eth = QueueProcessor.web3().eth;
      let lastMinedBlockNumber = eth.blockNumber;
      if (blockNumber > lastMinedBlockNumber) {
        // let's wait for more blocks to get mined
        self.logAndResolveIfPossible(importQueue, _.merge(task, { _new_state: "ready_to_wait" }), resolve, reject);
        return;
      }

      self.importTransactions(blockNumber).then(() => {
        // queue another task to import the next block
        self.db.ref(`/urTransactionImportQueue/tasks/${blockNumber + 1}`).set({ _state: "ready_to_import", createdAt: firebase.database.ServerValue.TIMESTAMP }).then(() => {
          self.logAndResolveIfPossible(importQueue, task, resolve, reject);
        }, (error: string) => {
          log.warn(`unable to add task for next block to queue: ${error}`)
          self.logAndResolveIfPossible(importQueue, task, resolve, reject);
        });
      }, (error) => {
        reject(error);
      });
    });
    return [waitQueue, importQueue];
  };

  private setUpUrTransactionImportQueue(): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      // make sure there is at least one task in the queue
      let tasksRef = self.db.ref(`/urTransactionImportQueue/tasks`);
      tasksRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
        if (snapshot.exists()) {
          resolve();
        } else {
          tasksRef.child(1).set({ _state: "ready_to_import", createdAt: firebase.database.ServerValue.TIMESTAMP }).then(() => {
            resolve();
          }, (error: string) => {
            reject(error);
          });
        }
      }, (error: string) => {
        reject(error);
      });
    });
  }

  private addTransactionsToRoot(blockNumber: number, transactions: any[]): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let numTransactionsRemaining = transactions.length;
      let finalized = false;
      _.each(transactions, (transaction) => {
        let transactionRef = self.db.ref(`/transactions/${transaction.urTransaction.hash}`);
        transactionRef.set(transaction).then(() => {
          numTransactionsRemaining--;
          if (!finalized && numTransactionsRemaining == 0) {
            resolve();
            finalized = true;
          }
        }, (error: string) => {
          reject(error);
          finalized = true;
        });
      });
    });
  }

  private transactionType(transaction: any, userId: string) {
    if (this.isSignUpBonus(transaction.urTransaction)) {
      return "earned";
    } else if (transaction.sender.userId == userId) {
      return "sent";
    } else if (transaction.receiver.userId == userId) {
      return "received";
    } else {
      return "unknown";
    }
  }

  private addTransactionsToUser(blockNumber: number, transactions: any[], userId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.getPriorBalance(blockNumber, userId).then((priorBalance: BigNumber) => {
        let transactionsRemaining = transactions.length;
        let balance = priorBalance;
        let finalized = false;
        _.each(transactions, (transaction: any) => {
          balance = balance.plus(new BigNumber(transaction.amount));
          transaction.balance = balance.toPrecision();
          transaction.type = self.transactionType(transaction, userId);
          self.db.ref(`/users/${userId}/transactions/${transaction.urTransaction.hash}`).set(transaction).then(() => {
            self.db.ref(`/users/${userId}/events`).push(self.generateEvent(transaction)).then(() => {
              transactionsRemaining--;
              if (!finalized && transactionsRemaining == 0) {
                resolve();
                finalized = true;
              }
            }, (error: string) => {
              reject(error);
              finalized = true;
            });
          }, (error: string) => {
            reject(error);
            finalized = true;
          });
        });
      }, (error: string) => {
        reject(error);
      });
    });
  }

  formatUR(amount: number): string {
    return (new BigNumber(amount || 0)).toFormat(2);
  }

  generateEvent(transaction: any): any {
    let urAmount = this.formatUR(QueueProcessor.web3().fromWei(parseFloat(transaction.amount)));
    let event: any = {
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
      notificationProcessed: false,
      sourceId: transaction.urTransaction.hash,
      sourceType: 'transaction'
    };
    switch (transaction.type) {
      case "earned":
        event.title = "Bonus Received";
        event.messageText = `You earned a bonus of ${ urAmount } UR because of a sign up`;
        event.profilePhotoUrl = transaction.receiver.profilePhotoUrl; // TODO: make this match the photo of the person who signed up
        break;
      case "sent":
        event.title = "UR Sent";
        event.messageText = `You sent ${ urAmount } UR to ${ transaction.receiver.name }`;
        event.profilePhotoUrl = transaction.receiver.profilePhotoUrl;
        break;
      case "received":
        event.title = "UR Received";
        event.messageText = `You received ${ urAmount } UR from ${ transaction.sender.name }`;
        event.profilePhotoUrl = transaction.sender.profilePhotoUrl;
    }
    return _.omitBy(event, _.isNil);
  }

  private getAssociatedAddresses(urTransactions: any[]): string[] {
    let addresses: string[] = [];
    _.each(urTransactions, (urTransaction) => {
      addresses.push(urTransaction.from);
      // if (self.isPrivilegedTransaction(urTransaction)) {
      //   let balanceChanges = self.getBalanceChangesFromSignupTransaction(urTransaction.transaction.hash);
      //   addresses.concat(_.keys(balanceChanges));
      // } else {
      //   addresses.push(urTransaction.transaction.to);
      // }
      addresses.push(urTransaction.to);
    });
    return _.uniq(addresses) as string[];
  }

  private importTransactions(blockNumber: number): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {

      QueueProcessor.web3().eth.getBlock(blockNumber, true, function(error: string, block: any) {
        if (error) {
          error = `Could not retrieve transactions for blockNumber ${blockNumber}: ${error};`
          log.warn(error);
          reject(error);
          return;
        }

        let urTransactions = _.sortBy(block.transactions, 'transactionIndex');
        if (urTransactions.length == 0) {
          resolve();
          return;
        }

        let associatedAddresses: string[] = self.getAssociatedAddresses(urTransactions);
        let transactions: any[];
        self.lookupUsersByAddresses(associatedAddresses).then((addressToUserMapping) => {
          self.buildTransactions(urTransactions, block.timestamp, addressToUserMapping).then((transactions) => {
            self.addTransactionsToRoot(blockNumber, transactions).then(() => {

              let users = _.values(addressToUserMapping);
              let userIds = _.uniq(_.map(users, 'userId')) as string[];
              let userIdsRemaining = userIds.length;
              if (userIdsRemaining == 0) {
                resolve();
                return;
              }

              let finalized = false;
              _.each(userIds, (userId) => {
                let associatedTransactions = _.filter(transactions, (t: any) => {
                  return t.sender.userId == userId || t.receiver.userId == userId;
                });
                self.addTransactionsToUser(blockNumber, associatedTransactions, userId).then(() => {
                  userIdsRemaining--;
                  if (!finalized && userIdsRemaining == 0) {
                    resolve();
                    finalized = true;
                  };
                }, (error: string) => {
                  reject(error);
                  finalized = true;
                });
              });

            }, (error: string) => {
              reject(error);
            });
          }, (error: string) => {
            reject(error);
          });
        }, (error: string) => {
          reject(error);
        });
      });
    });
  }


  private sender(urTransaction: any, addressToUserMapping: any): any {
    let user: any = this.isSignUpBonus(urTransaction) ? { name: "UR Network" } : ( addressToUserMapping[urTransaction.from] || { name: "Unknown User" } );
    return _.pick(user, ['name', 'profilePhotoUrl', 'userId']);
  }

  private receiver(urTransaction: any, addressToUserMapping: any): any {
    let user: any = addressToUserMapping[urTransaction.to] || { name: "Unknown User" };
    return _.pick(user, ['name', 'profilePhotoUrl', 'userId']);
  }

  private buildTransaction(urTransaction: any, blockTimestamp: number, addressToUserMapping: any, existingTransaction: any): any {
    let transaction: any = {
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      sender: this.sender(urTransaction, addressToUserMapping),
      receiver: this.receiver(urTransaction, addressToUserMapping),
      createdBy: this.isSignUpBonus(urTransaction) ? "UR Network" : "Unknown"
    };
    _.merge(transaction, existingTransaction);
    _.merge(transaction, {
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
      minedAt: blockTimestamp * 1000,
      sortKey: sprintf("%09d-%06d", urTransaction.blockNumber, urTransaction.transactionIndex),
      urTransaction: _.merge(urTransaction, { gasPrice: urTransaction.gasPrice.toString(), value: urTransaction.value.toString() }),
      amount: this.isSignUpBonus(urTransaction) ? new BigNumber(2000).times(1000000000000000000).toPrecision() : urTransaction.value
    });
    return transaction;
  }

  private isSignUpBonus(urTransaction: any): boolean {
    return _.includes([
      "0x482cf297b08d4523c97ec3a54e80d2d07acd76fa",
      "0xcc74e28cec33a784c5cd40e14836dd212a937045",
      "0xc07a55758f896449805bae3851f57e25bb7ee7ef",
      "0x48a24dd26a32564e2697f25fc8605700ec4c0337",
      "0x3cac5f7909f9cb666cc4d7ef32047b170e454b16",
      "0x0827d93936df936134dd7b7acaeaea04344b11f2",
      "0xa63e936e0eb36c103f665d53bd7ca9c31ec7e1ad"
    ], urTransaction.from);
  }

  private buildTransactions(urTransactions: any[], blockTimestamp: number, addressToUserMapping: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let transactions: any[] = [];
      let finalized = false
      let urTransactionsRemaining = urTransactions.length;
      _.each(urTransactions, (urTransaction) => {
        self.db.ref(`/transactions/${urTransaction.hash}`).once('value', (existingTransactionSnapshot: firebase.database.DataSnapshot) => {
          let transaction = self.buildTransaction(urTransaction, blockTimestamp, addressToUserMapping, existingTransactionSnapshot.val() || {});
          transactions.push(transaction);
          urTransactionsRemaining--;
          if (!finalized && urTransactionsRemaining == 0) {
            resolve(transactions);
            finalized == true;
          }
        }, (error: string) => {
          reject(error);
          finalized == true;
        });
      });
    });
  }

  private lookupUsersByAddresses(addresses: string[]): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let addressesRemaining = _.size(addresses);
      if (addressesRemaining == 0) {
        resolve({});
        return;
      }

      let addressToUserMapping: any = {}
      _.each(addresses, (address) => {
        self.lookupUserByAddress(address).then((result) => {
          if (result.user) {
            addressToUserMapping[address] = result.user;
            addressToUserMapping[address].userId = result.userId;
          }
          addressesRemaining--;
          if (addressesRemaining == 0) {
            resolve(addressToUserMapping);
          }
        }, (error) => {
          reject(error);
        })
      });
    })
  }

  private getPriorBalance(blockNumber: number, userId: string): Promise<BigNumber> {
    let self = this;
    return new Promise((resolve, reject) => {
      let priorSortKey = sprintf("%09d-999999", blockNumber - 1);
      let query = self.db.ref(`/users/${userId}/transactions`).orderByChild('sortKey').endAt(priorSortKey).limitToLast(1);
      query.once('value', (snapshot: firebase.database.DataSnapshot) => {
        if (snapshot.exists()) {
          let priorTransaction = _.last(_.values(snapshot.val())) as any;
          if (priorTransaction.balance) {
            let priorBalance: BigNumber = new BigNumber(priorTransaction.balance);
            resolve(priorBalance);
          } else {
            log.debug("no prior balance available - using 0 instead");
            resolve(new BigNumber(0));
          }
        } else {
          // no prior transaction; start with zero balance
          resolve(new BigNumber(0));
        }
      });
    });
  }

  private lookupUserByAddress(address: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.db.ref("/users").orderByChild("wallet/address").equalTo(address).limitToFirst(1).once('value', function(snapshot: firebase.database.DataSnapshot) {
        let users = snapshot.val();
        let userId = _.first(_.keys(users));
        let user = _.first(_.values(users));
        if (userId) {
          log.trace(`found user ${userId} associated with address ${address}`);
        } else {
          log.trace(`no user associated with address ${address}`);
        }
        resolve({ user: user, userId: userId });
      }, (error: string) => {
        reject(error);
      });
    });
  }

}
