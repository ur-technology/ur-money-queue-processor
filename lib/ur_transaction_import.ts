import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';
import {BigNumber} from 'bignumber.js';
import {sprintf} from 'sprintf-js';

export class UrTransactionImportQueueProcessor extends QueueProcessor {
  private eth: any;
  private transactionWrappers: any = {};
  private TRANSACTION_WRAPPERS_LIMIT = 5000;
  private priorHash: string;
  private priorChanges: any[];

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
      self.startTask(waitQueue, task, true);
      let blockNumber: number = parseInt(task._id);
      setTimeout(() => {
        self.resolveTask(waitQueue, _.merge(task, { _new_state: "ready_to_import" }), resolve, reject, true);
      }, 3 * 1000);
    });

    let importOptions = { 'specId': 'import', 'numWorkers': 1, sanitize: false };
    let importQueue = new self.Queue(queueRef, importOptions, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(importQueue, task, true);
      let blockNumber: number = parseInt(task._id);
      self.eth = QueueProcessor.web3().eth;
      if (!QueueProcessor.web3().isConnected() || !self.eth) {
        self.rejectTask(importQueue, task, 'unable to get connection to transaction relay', reject, true);
        return;
      }

      let lastMinedBlockNumber = self.eth.blockNumber;
      if (blockNumber > lastMinedBlockNumber) {
        if (blockNumber - lastMinedBlockNumber > 1) {
          log.warn(`  ready to import block number ${blockNumber} but lastMinedBlockNumber is ${lastMinedBlockNumber}`);
        }
        // let's wait for more blocks to get mined
        self.resolveTask(importQueue, _.merge(task, { _new_state: "ready_to_wait" }), resolve, reject, true);
        return;
      }

      self.importUrTransactions(blockNumber).then(() => {
        // queue another task to import the next block
        self.db.ref(`/urTransactionImportQueue/tasks/${blockNumber + 1}`).set({ _state: "ready_to_import", updatedAt: firebase.database.ServerValue.TIMESTAMP }).then(() => {
          self.resolveTask(importQueue, task, resolve, reject, true);
        }, (error: string) => {
          log.warn(`  unable to add task for next block to queue: ${error}`)
          self.resolveTask(importQueue, task, resolve, reject, true);
        });
      }, (error) => {
        log.warn(`  unable to import transactions for block ${blockNumber}: ${error}`);
        self.rejectTask(importQueue, task, error, reject, true);
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
          let startingBlock = QueueProcessor.env.UR_TRANSACTION_IMPORT_STARTING_BLOCK_NUMBER || 1;
          tasksRef.child(startingBlock).set({ _state: "ready_to_import", createdAt: firebase.database.ServerValue.TIMESTAMP }).then(() => {
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

  private userTransactionType(urTransaction: any, addressToUserMapping: any, userId: string) {
    let fromUserId: any = addressToUserMapping[urTransaction.from] && addressToUserMapping[urTransaction.from].userId;
    let toUserId: any = addressToUserMapping[urTransaction.to] && addressToUserMapping[urTransaction.to].userId;
    if (this.isAnnouncementTransaction(urTransaction)) {
      return 'earned';
    } else if (toUserId == userId) {
      return 'received';
    } else if (fromUserId == userId) {
      return 'sent';
    } else {
      return 'unknown';
    }
  }

  private calculateFee(userTransaction: any): BigNumber {
    if (_.includes(['received', 'earned'], userTransaction.type)) {
      return new BigNumber(0);
    } else {
      let x: BigNumber = new BigNumber(userTransaction.urTransaction.gasPrice).times(21000)
      return new BigNumber(userTransaction.urTransaction.gasPrice).times(21000);
    }
  }

  private calculateChange(userTransaction: any, fee: BigNumber) {
    let sign = _.includes(['received', 'earned'], userTransaction.type) ? 1 : -1;
    return new BigNumber(userTransaction.amount).times(sign).minus(fee);
  }

  private createUserTransaction(blockTimestamp: number, urTransaction: any, addressToUserMapping: any, user: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {

      let userId: string = user.userId;
      self.getPriorBalance(urTransaction.blockNumber, userId).then((priorBalance: BigNumber) => {
        let amount: BigNumber = self.userTransactionAmount(urTransaction, addressToUserMapping, userId);

        let userTransaction: any = {
          type: self.userTransactionType(urTransaction, addressToUserMapping, userId),
          level: self.userTransactionLevel(urTransaction, addressToUserMapping, userId),
          sender: self.sender(urTransaction, addressToUserMapping),
          receiver: self.receiver(urTransaction, addressToUserMapping),
          createdAt: firebase.database.ServerValue.TIMESTAMP,
          createdBy: self.isAnnouncementTransaction(urTransaction) ? "UR Network" : "Unknown",
          updatedAt: firebase.database.ServerValue.TIMESTAMP,
          minedAt: blockTimestamp * 1000,
          sortKey: sprintf("%09d-%06d", urTransaction.blockNumber, urTransaction.transactionIndex),
          urTransaction: _.merge(urTransaction, { gasPrice: urTransaction.gasPrice.toString(), value: urTransaction.value.toString() }),
          amount: amount.toPrecision()
        };

        let fee = self.calculateFee(userTransaction);
        let change = self.calculateChange(userTransaction, fee);
        let balance = priorBalance.plus(change);

        _.merge( userTransaction, {
          fee: fee.toPrecision(),
          change: change.toPrecision(),
          balance: balance.toPrecision(),
          title: self.userTransactionTitle(userTransaction),
          messageText: self.userTransactionMessageText(userTransaction, amount),
          profilePhotoUrl: self.userTransactionProfilePhotoUrl(userTransaction)
        });
        let ignorableValue = (e: any) => {
          return _.isNil(e) ||
            ((_.isArray(e) || _.isObject(e)) && _.isEmpty(e)) ||
            (_.isString(e) && _.isEmpty(_.trim(e)));
        };
        userTransaction = _.omitBy(userTransaction, ignorableValue);

        self.db.ref(`/users/${userId}/transactions/${userTransaction.urTransaction.hash}`).once('value', (snapshot: firebase.database.DataSnapshot) => {
          if (snapshot.exists()) {
            // if a pending userTransaction was already created by the app,
            // make sure we don't overwrite certain fields
            let existingValues = _.pick(snapshot.val(), [
              'createdAt',
              'createdBy',
              'sender',
              'receiver',
              'type',
              'title',
              'messageText'
            ]);
            existingValues = _.omitBy(existingValues, ignorableValue);
            _.merge(userTransaction, existingValues);
          }

          return self.db.ref(`/users/${userId}/transactions/${userTransaction.urTransaction.hash}`).set(userTransaction);
        }).then(() => {
          return self.updateCurrentBalance(user);
        }).then(() => {
          return self.db.ref(`/users/${userId}/events`).push(self.generateEvent(userTransaction));
        }).then(() => {
          return self.recordAnnouncementInfoIfApplicable(userTransaction.urTransaction, addressToUserMapping, userId);
        }).then(() => {
          resolve();
        }, (error: string) => {
          reject(error);
        });
      }, (error: string) => {
        reject(error);
      });
    });
  }

  private updateCurrentBalance(user: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      if (!user.wallet || !user.wallet.address) {
        reject(`no user address found`);
        return;
      }

      let currentBalance: BigNumber;
      try {
        currentBalance = QueueProcessor.web3().eth.getBalance(user.wallet.address);
      } catch(error) {
        reject(`got error when attempting to get balance for address ${user.wallet.address} and user ${user.userId}`);
        return;
      }
      self.db.ref(`/users/${user.userId}/wallet/currentBalance`).set(currentBalance.toFixed()).then(() => {
        resolve();
      }, (error: any) => {
        reject(`could not update current balance for user ${user.userId}: ${error}`);
      })
    });
  }

  private recordAnnouncementInfoIfApplicable(urTransaction: any, addressToUserMapping: any, userId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let toUser: any = addressToUserMapping[urTransaction.to];
      if (toUser && toUser.userId === userId && self.isAnnouncementTransaction(urTransaction)) {
        let attrs = _.pick(urTransaction, ['blockNumber', 'hash']);
        self.db.ref(`/users/${userId}/wallet/announcementTransaction`).set(attrs).then(() => {
          return self.db.ref(`/users/${userId}/registration/status`).set('announcement-confirmed');
        }).then(() => {
          return self.updateReferralsOfSponsor(userId);
        }).then(() => {
          resolve();
        }, (error: any) => {
          reject(error);
        });
      } else {
        resolve();
      }
    });
  }

  private updateReferralsOfSponsor(userId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.db.ref('/users').orderByChild('sponsor/userId').equalTo(userId).once('value').then((snapshot: firebase.database.DataSnapshot) => {
        let referralsMapping = snapshot.val() || {};
        let numRecordsRemaining = _.size(referralsMapping);
        if (numRecordsRemaining === 0) {
          resolve();
          return;
        }
        let finalized = false;
        _.each(referralsMapping, (referral, referralUserId) => {
          self.db.ref(`/users/${referralUserId}/sponsor`).update({announcementTransactionConfirmed: true}).then(() => {
            let referralStatus: string = (referral.registration && referral.registration.status) || 'initial';
            if (!!referral.wallet &&
              !!referral.wallet.announcementTransaction &&
              !!referral.wallet.announcementTransaction.blockNumber &&
              !!referral.wallet.announcementTransaction.hash) {
              referralStatus = 'announcement-confirmed';
            }
            let statusesNotNeedingAnnouncement = [
              'announcement-requested',
              'announcement-initiated',
              'announcement-confirmed'
            ];
            if (referral.disbled || !referral.wallet || !referral.wallet.address || _.includes(statusesNotNeedingAnnouncement, referralStatus)) {
              return Promise.resolve();
            }
            return self.db.ref('/identityAnnouncementQueue/tasks').push({userId: referralUserId});
          }).then(() => {
            numRecordsRemaining--;
            if (!finalized && numRecordsRemaining == 0) {
              finalized = true;
              resolve();
            }
          }, (error: any) => {
            if (!finalized) {
              finalized = true;
              reject(error);
            }
          });
        });
      }, (error: any) => {
        reject(error);
      });
    });
  }

  formatUR(amount: number): string {
    return (new BigNumber(amount || 0)).toFormat(2);
  }

  generateEvent(userTransaction: any): any {
    let urAmount = this.formatUR(QueueProcessor.web3().fromWei(parseFloat(userTransaction.amount)));
    let event: any = {
      createdAt: firebase.database.ServerValue.TIMESTAMP,
      updatedAt: firebase.database.ServerValue.TIMESTAMP,
      notificationProcessed: false,
      sourceId: userTransaction.urTransaction.hash,
      sourceType: 'transaction',
      title: userTransaction.title,
      messageText: userTransaction.messageText,
      profilePhotoUrl: userTransaction.profilePhotoUrl
    }
    return _.omitBy(event, _.isNil);
  }


  private userTransactionProfilePhotoUrl(userTransaction: any) {
    return userTransaction.type == 'received' ? userTransaction.sender.profilePhotoUrl : userTransaction.receiver.profilePhotoUrl;
  }

  private userTransactionTitle(userTransaction: any) {
    switch (userTransaction.type) {
      case 'earned':
        return userTransaction.level == 0 ? 'Sign Up Bonus Earned' : `Referral Bonus Earned`;

      case 'received':
        return 'UR Received';

      case 'sent':
        return 'UR Sent';

      default:
        return 'Unrecognized Transaction';
    }
  }

  private userTransactionMessageText(userTransaction: any, amount: BigNumber): string {
    let amountInUr: string = amount.dividedBy('1000000000000000000').toFormat(2);

    switch (userTransaction.type) {
      case 'sent':
        return `You sent ${ amountInUr } UR to ${ userTransaction.receiver.name }`;

      case 'received':
        return `You received ${ amountInUr } UR from ${ userTransaction.sender.name }`;

      case 'earned':
        if (userTransaction.level == 0) {
          return `You earned a bonus of ${ amountInUr } UR for signing up`;
        } else if (userTransaction.level == 1 || !(userTransaction.sender && userTransaction.sender.name)) {
          return `You earned a bonus of ${ amountInUr } UR for referring ${ userTransaction.receiver.name }`;
        } else {
          return `You earned a bonus of ${ amountInUr } UR because ${userTransaction.sender.name} referred ${ userTransaction.receiver.name }`;
        }
    }
  }

  private addressesAssociatedWithTransaction(urTransaction: any): string[] {
    let addresses: string[] = [];
    addresses.push(urTransaction.from);
    if (this.isAnnouncementTransaction(urTransaction)) {
      let newAddresses: string[] = <string[]> _.map(this.announcementTransactionBalanceChanges(urTransaction), 'to');
      addresses = addresses.concat(newAddresses);
    } else {
      addresses.push(urTransaction.to);
    }
    return _.uniq(addresses) as string[];
  }

  private importUrTransactions(blockNumber: number): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {

      self.eth.getBlock(blockNumber, true, function(error: string, block: any) {
        if (error) {
          reject(`Got error from getBlock(): ${error}`);
          return;
        }

        if (!block) {
          reject(`Got empty block`);
          return;
        }

        let urTransactions = _.sortBy(block.transactions, 'transactionIndex');
        if (_.isEmpty(urTransactions)) {
          resolve();
          return
        }

        self.importUrTransactionsInOrder(block.timestamp, urTransactions).then(() => {
          resolve();
        }, (error: string) => {
          reject(error);
        });
      });
    });
  }

  private importUrTransactionsInOrder(blockTimestamp: number, urTransactions: any[]): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let urTransaction = urTransactions[0];
      if (!urTransaction) {
        resolve();
        return;
      }

      // import the first transaction in the array
      self.importUrTransaction(blockTimestamp, urTransaction).then(() => {
        // ...then import the remaining transactions
        return self.importUrTransactionsInOrder(blockTimestamp, urTransactions.slice(1));
      }).then(() => {
        resolve();
      }, (error) => {
        reject(error);
      });
    });
  }

  private importUrTransaction(blockTimestamp: number, urTransaction: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let addresses = self.addressesAssociatedWithTransaction(urTransaction);
      if (addresses === undefined) {
        reject(`could not get associated addresses`);
        return;
      }

      self.lookupUsersByAddresses(addresses).then((addressToUserMapping) => {
        // create user transactions for all users affected by this ur transaction
        let users = _.uniqBy(_.values(addressToUserMapping), 'userId');
        return self.createUserTransactions(blockTimestamp, urTransaction, addressToUserMapping, users);
      }).then(() => {
        resolve();
      }, (error) => {
        reject(error);
      });
    });
  }

  private sender(urTransaction: any, addressToUserMapping: any): any {
    let user: any = this.isAnnouncementTransaction(urTransaction) ? { name: "UR Network" } : ( addressToUserMapping[urTransaction.from] || { name: "Unknown User" } );
    return _.pick(user, ['name', 'profilePhotoUrl', 'userId']);
  }

  private receiver(urTransaction: any, addressToUserMapping: any): any {
    let user: any = addressToUserMapping[urTransaction.to] || { name: "Unknown User" };
    return _.pick(user, ['name', 'profilePhotoUrl', 'userId']);
  }

  private isAnnouncementTransaction(urTransaction: any): boolean {
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

  private createUserTransactions(blockTimestamp: number, urTransaction: any, addressToUserMapping: any, users: any[]): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      if (_.isEmpty(users)) {
          resolve();
          return;
      }
      let user: any = users[0];
      // create user transaction for the first user in the array
      self.createUserTransaction(blockTimestamp, urTransaction, addressToUserMapping, user).then(() => {
        // ...then create user transactions for the remaining users
        return self.createUserTransactions(blockTimestamp, urTransaction, addressToUserMapping, users.slice(1));
      }).then(() => {
        resolve();
      }, (error: string) => {
        reject(error);
      });
    });
  }

  private userTransactionAmount(urTransaction: any, addressToUserMapping: any, userId: string): BigNumber {
    if (this.isAnnouncementTransaction(urTransaction)) {
      let change: any = _.find(this.announcementTransactionBalanceChanges(urTransaction), (change) => {
        let user: any = addressToUserMapping[change.to];
        return user && user.userId == userId;
      });
      return change ? change.amount : undefined;
    } else {
      return new BigNumber(urTransaction.value);
    }
  }

  private userTransactionLevel(urTransaction: any, addressToUserMapping: any, userId: string): number {
    if (this.isAnnouncementTransaction(urTransaction)) {
      let level: number = _.findIndex(this.announcementTransactionBalanceChanges(urTransaction), (change, index) => {
        let user: any = addressToUserMapping[change.to];
        return user && user.userId == userId;
      });
      return level;
    } else {
      return undefined;
    }
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
            log.debug('  no prior balance available - using 0 instead');
            resolve(new BigNumber(0));
          }
        } else {
          // if no prior userTransaction, start with zero balance.
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
          log.trace(`  found user ${userId} associated with address ${address}`);
        } else {
          log.trace(`  no user associated with address ${address}`);
        }
        resolve({ user: user, userId: userId });
      }, (error: string) => {
        reject(error);
      });
    });
  }

  private announcementTransactionBalanceChanges(announcementTransaction: any): any[] {
    if (this.priorHash === announcementTransaction.hash) {
      return this.priorChanges;
    }

    let changes: any[] = [];
    let rewards = [
      new BigNumber("2000000000000000000000"),
      new BigNumber("60600000000000000000"),
      new BigNumber("60600000000000000000"),
      new BigNumber("121210000000000000000"),
      new BigNumber("181810000000000000000"),
      new BigNumber("303030000000000000000"),
      new BigNumber("484840000000000000000"),
      new BigNumber("787910000000000000000")
    ];
    let urTransaction: any = announcementTransaction;
    for (let index: number = 0; index < 8; index++) {
      changes.push({ to: urTransaction.to, amount: rewards[index] });
      urTransaction = this.referralTransaction(urTransaction);
      if (urTransaction === undefined) {
        return undefined;
      }
      if (_.isEmpty(urTransaction)) {
        // short upline
        break;
      }
    }

    // save results in case the next call is for the same transaction
    this.priorHash = announcementTransaction.hash;
    this.priorChanges = changes;

    return changes;
  }

  private referralTransaction(urTransaction: any): any {
    if (!urTransaction.input) {
      log.warn('  sign up transaction lacks input field');
      log.warn('  ' + urTransaction);
      return undefined;
    }
    let version: string = urTransaction.input.slice(2, 4);
    if (version !== "01") {
      log.warn( '  unrecognized transaction version');
      return undefined;
    }
    if (urTransaction.input.length == 4) {
      // this signup was made by one of the privileged addresses
      return {};
    } else if (urTransaction.input.length == 84) {
      // there are more members in the chain
      let hash: string = '0x' + urTransaction.input.slice(20, 84);
      if (!this.transactionWrappers[hash]) {
        let fetchedTransaction = this.eth.getTransaction(hash);
        if (!fetchedTransaction) {
          log.warn( '  unable to fetch transaction');
          return undefined;
        }
        this.discardExcessiveTransactionWrappers();
        this.transactionWrappers[hash] = {
          time: new Date().getTime(),
          hash: hash,
          transaction: fetchedTransaction
        };
      }
      return this.transactionWrappers[hash].transaction;
    } else {
      log.warn(`  unexpected transaction input length ${urTransaction.input}`);
      return undefined;
    }
  }

  private discardExcessiveTransactionWrappers() {
    if (_.size(this.transactionWrappers) >= this.TRANSACTION_WRAPPERS_LIMIT) {
      let sortedTransactionWrappers = _.sortBy(this.transactionWrappers, 'time');
      _.each(_.slice(sortedTransactionWrappers, 0, this.TRANSACTION_WRAPPERS_LIMIT / 2 ), (transactionWrapper: any) => {
        delete this.transactionWrappers[transactionWrapper.hash];
      });
    }
  }

}
