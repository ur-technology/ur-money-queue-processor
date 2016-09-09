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

    let wait_options = { 'specId': 'wait', 'numWorkers': 1, sanitize: false };
    let wait_queue = new self.Queue(queueRef, wait_options, (data: any, progress: any, resolve: any, reject: any) => {
      let blockNumber: number = parseInt(data._id);
      setTimeout(() => {
        resolve({ _new_state: "ready_to_import" });
      }, 15 * 1000);
    });

    let import_options = { 'specId': 'import', 'numWorkers': 1, sanitize: false };
    let import_queue = new self.Queue(queueRef, import_options, (data: any, progress: any, resolve: any, reject: any) => {
      let blockNumber: number = parseInt(data._id);

      let lastMinedBlockNumber = QueueProcessor.web3.eth.blockNumber;
      if (blockNumber > lastMinedBlockNumber) {
        // let's wait for more blocks to get mined
        resolve({ _new_state: "ready_to_wait" });
        return;
      }

      self.importTransactions(blockNumber).then(() => {
        // queue another task to import the next block
        self.db.ref(`/urTransactionImportQueue/tasks/${blockNumber + 1}`).set({ _state: "ready_to_import", createdAt: firebase.database.ServerValue.TIMESTAMP }).then(() => {
          self.resolveIfPossible(resolve, reject, data);
        }, (error: string) => {
          log.warn(`unable to add task for next block to queue: ${error}`)
          self.resolveIfPossible(resolve, reject, data);
        });
      }, (error) => {
        reject(error);
      });
    });
    return [wait_queue, import_queue];
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
          if (transaction.type != "earned") {
            transaction.type = transaction.sender.userId == userId ? "sent" : "received";
          }
          self.db.ref(`/users/${userId}/transactions/${transaction.urTransaction.hash}`).set(transaction).then(() => {
            transactionsRemaining--;
            if (!finalized && transactionsRemaining == 0) {
              resolve();
              finalized = true;
            }
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

  private importTransactions(blockNumber: number): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {

      QueueProcessor.web3.eth.getBlock(blockNumber, true, function(error: string, block: any) {
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

        let uniqueAddresses = _.uniq(_.map(urTransactions, 'from').concat(_.map(urTransactions, 'to'))) as string[];
        let transactions: any[];
        self.lookupUsersByAddresses(uniqueAddresses).then((addressToUserMapping) => {
          self.buildTransactions(urTransactions, block.timestamp, addressToUserMapping).then((transactions) => {
            self.addTransactionsToRoot(blockNumber, transactions).then(() => {

              let users = _.values(addressToUserMapping);
              let userIds = _.uniq(_.map(users, 'userId')) as string[];
              let userIdsRemaining = userIds.length;
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

  private buildTransaction(urTransaction: any, blockTimestamp: number, addressToUserMapping: any, existingTransaction: any): any {
    let fromUser: any = addressToUserMapping[urTransaction.from] || { name: "Unknown User" };
    let toUser: any = addressToUserMapping[urTransaction.to] || { name: "Unknown User" };
    let transaction: any = {
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      sender: _.pick(fromUser, ['name', 'profilePhotoUrl', 'userId']),
      receiver: _.pick(toUser, ['name', 'profilePhotoUrl', 'userId']),
      source: "external"
    };
    _.merge(transaction, existingTransaction);
    _.merge(transaction, {
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
      minedAt: blockTimestamp * 1000,
      sortKey: sprintf("%09d-%06d", urTransaction.blockNumber, urTransaction.transactionIndex),
      urTransaction: _.merge(urTransaction, { gasPrice: urTransaction.gasPrice.toString(), value: urTransaction.value.toString() })
    });
    if (this.isPrivilegedTransaction(transaction)) {
      transaction.type = "earned";
      transaction.amount = new BigNumber(transaction.urTransaction.value).times(1000000000000000).toPrecision();
    } else {
      transaction.amount = transaction.urTransaction.value;
    }
    return transaction;
  }

  private isPrivilegedTransaction(transaction: any): boolean {
    let privilegedAddresses = [
      "0x5d32e21bf3594aa66c205fde8dbee3dc726bd61d",
      "0x9194d1fa799d9feb9755aadc2aa28ba7904b0efd",
      "0xab4b7eeb95b56bae3b2630525b4d9165f0cab172",
      "0xea82e994a02fb137ffaca8051b24f8629b478423",
      "0xb1626c3fc1662410d85d83553d395cabba148be1",
      "0x65afd2c418a1005f678f9681f50595071e936d7c",
      "0x49158a28df943acd20be7c8e758d8f4a9dc07d05"
    ];
    return _.includes(privilegedAddresses, transaction.urTransaction.from);
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
            log.warn("no prior balance available - using 0 instead");
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
