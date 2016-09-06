/// <reference path="../typings/index.d.ts" />

import * as log from 'loglevel';
import * as _ from 'lodash';
import * as moment from 'moment';
import * as firebase from 'firebase';
import {BigNumber} from 'bignumber.js';
import {sprintf} from 'sprintf-js';
let twilio = require('twilio');
let Queue = require('firebase-queue');

export class Notifier {
  private env: any;
  public queues: any[];
  private db: any;

  private twilioClient: any; // used to send messages via twilio
  private web3: any; // used to populate and process ur blocks

  constructor(env: any) {
    this.env = env;
    this.db = firebase.database();
    this.queues = [];
  }

  start() {
    this.setUpQueues().then(() => {
      this.processPhoneAuthenticationQueueForCodeGeneration();
      this.processPhoneAuthenticationQueueForCodeMatching();
      this.processChatSummaryCopyingQueue();
      this.processChatMessageCopyingQueue();
      this.processPhoneLookupQueue();
      this.processInvitationQueue();
      if (this.env.PROCESSING_UR_BLOCKS == "true") {
        this.processUrBlockQueue();
      }
      this.processIdentityVerificationQueue();
    });
  };

  //////////////////////////////////////////////
  // queue processing functions
  //////////////////////////////////////////////


  private processUrBlockQueue() {
    let self = this;
    let queueRef = self.db.ref("/urBlockQueue");

    let wait_options = { 'specId': 'wait', 'numWorkers': 1, sanitize: false };
    let wait_queue = new Queue(queueRef, wait_options, (data: any, progress: any, resolve: any, reject: any) => {
      let blockNumber: number = parseInt(data._id);
      setTimeout(() => {
        resolve({ _new_state: "ready_to_import" });
      }, 15 * 1000);
    });

    let import_options = { 'specId': 'import', 'numWorkers': 1, sanitize: false };
    let import_queue = new Queue(queueRef, import_options, (data: any, progress: any, resolve: any, reject: any) => {
      let blockNumber: number = parseInt(data._id);

      let lastMinedBlockNumber = self.web3.eth.blockNumber;
      if (blockNumber > lastMinedBlockNumber) {
        // let's wait for more blocks to get mined
        resolve({ _new_state: "ready_to_wait" });
        return;
      }

      self.importTransactions(blockNumber).then(() => {
        // queue another task to import the next block
        self.db.ref(`/urBlockQueue/tasks/${blockNumber + 1}`).set({ _state: "ready_to_import", createdAt: firebase.database.ServerValue.TIMESTAMP }).then(() => {
          self.resolveIfPossible(resolve, reject, data);
        }, (error: string) => {
          log.warn(`unable to add task for next block to queue: ${error}`)
          self.resolveIfPossible(resolve, reject, data);
        });
      }, (error) => {
        reject(error);
      });
    });
  }

  private processPhoneAuthenticationQueueForCodeGeneration() {
    let self = this;
    let queueRef = self.db.ref("/phoneAuthenticationQueue");
    let options = { 'specId': 'code_generation', 'numWorkers': 1, sanitize: false };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      self.lookupUsersByPhone(data.phone).then((result) => {
        // TODO: handle case where there are multiple invitations
        let matchingUser = _.first(result.matchingUsers);
        let matchingUserId = _.first(result.matchingUserIds);
        if (matchingUser) {
          log.debug(`matching user with userId ${matchingUserId} found for phone ${data.phone}`);
          let verificationCode = self.generateVerificationCode();
          self.sendMessage(data.phone, `Your UR Money verification code is ${verificationCode}`).then((error: string) => {
            if (error) {
              log.info(`error sending message to user with userId ${matchingUserId} and phone ${data.phone}: ${error}`);
              reject(error);
            } else {
              data.userId = matchingUserId;
              data.verificationCode = verificationCode;
              data._state = "code_generation_completed_and_sms_sent"; // TODO: change this from _state to _new_state
              self.resolveIfPossible(resolve, reject, data);
            }
          });
        } else {
          log.info(`no matching user found for ${data.phone}`);
          data._new_state = "code_generation_canceled_because_user_not_invited";
          self.resolveIfPossible(resolve, reject, data);
        }
      }, (error) => {
        reject(error);
      });
    });
    self.queues.push(queue);
  }

  private processPhoneAuthenticationQueueForCodeMatching() {
    let self = this;
    let queueRef = self.db.ref("/phoneAuthenticationQueue");
    let options = { 'specId': 'code_matching', 'numWorkers': 1 };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      if (data.submittedVerificationCode == data.verificationCode) {
        log.debug(`submittedVerificationCode ${data.submittedVerificationCode} matches actual verificationCode; sending authToken to user`);
        data.verificationResult = { codeMatch: true, authToken: firebase.auth().createCustomToken(data.userId, { some: "arbitrary", data: "here" }) };
      } else {
        log.debug(`submittedVerificationCode ${data.submittedVerificationCode} does not match actual verificationCode ${data.verificationCode}`);
        data.verificationResult = { codeMatch: false };
      }
      self.resolveIfPossible(resolve, reject, data);
    });
    self.queues.push(queue);
  }

  private processChatSummaryCopyingQueue() {
    let self = this;
    let queueRef = self.db.ref("/chatSummaryCopyingQueue");
    let options = { 'numWorkers': 1 };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      self.lookupChatSummary(data.userId, data.chatId).then((chatSummary) => {
        let otherUserIds = _.without(_.keys(chatSummary.users), chatSummary.creatorUserId);
        _.each(otherUserIds, (otherUserId, index) => {
          let chatSummaryCopy: any = _.extend(chatSummary, { displayUserId: chatSummary.creatorUserId });
          let destinationRef = self.db.ref(`/users/${otherUserId}/chatSummaries/${data.chatId}`);
          destinationRef.set(chatSummaryCopy);
          log.trace(`copied chatSummary to ${destinationRef.toString()}`);
        });
        self.resolveIfPossible(resolve, reject, data);
      }, (error) => {
        reject(error);
      });
    });
  }

  private processChatMessageCopyingQueue() {
    let self = this;
    let queueRef = self.db.ref("/chatMessageCopyingQueue");
    let options = { 'numWorkers': 1 };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      self.lookupChatSummary(data.userId, data.chatId).then((chatSummary) => {
        self.lookupMessage(data.userId, data.chatId, data.messageId).then((message) => {
          let otherUserIds = _.without(_.keys(chatSummary.users), message.senderUserId);
          _.each(otherUserIds, (otherUserId, index) => {

            // append copy of message to the chat messages collection of other user
            let messageCopy: any = _.clone(message);
            let destinationRef = self.db.ref(`/users/${otherUserId}/chats/${data.chatId}/messages/${data.messageId}`);
            destinationRef.set(messageCopy);
            log.trace(`copied message to ${destinationRef.toString()}`);

            // copy message to chat summary of other user unless the this is the first message in the chat
            // summary, in which case the chat summary already contains this message
            if (!data.isFirstMessageInChat) {
              let destinationRef = self.db.ref(`/users/${otherUserId}/chatSummaries/${data.chatId}/lastMessage`);
              destinationRef.set(_.merge(message, { messageId: data.messageId }));
              log.trace(`copied message to ${destinationRef.toString()}`);
            }

            // create event for other user
            let sender = chatSummary.users[message.senderUserId];
            let eventRef = self.db.ref(`/users/${otherUserId}/events/${data.chatId}`);
            eventRef.set({
              createdAt: firebase.database.ServerValue.TIMESTAMP,
              messageText: message.text,
              notificationProcessed: 'false',
              profilePhotoUrl: sender.profilePhotoUrl,
              sourceId: data.chatId,
              sourceType: 'message',
              title: sender.name,
              updatedAt: message.sentAt,
              userdId: message.senderUserId
            });
          });
          self.resolveIfPossible(resolve, reject, data);
        }, (error) => {
          reject(error);
        });
      }, (error) => {
        reject(error);
      });
    });
  }

  private processPhoneLookupQueue() {
    let self = this;
    let queueRef = self.db.ref("/phoneLookupQueue");
    let options = { 'specId': 'phone_lookup', 'numWorkers': 1, 'sanitize': false };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      data.phones = data.phones || [];
      let phonesRemaining = data.phones.length;
      log.debug(`phoneLookup ${data._id} - looking up ${phonesRemaining} contacts`);
      let phoneToUserMapping: any = {};
      let finalized = false;
      _.each(data.phones, (phone) => {
        self.lookupSignedUpUserByPhone(phone).then((result) => {
          if (result.signedUpUser) {
            phoneToUserMapping[phone] = {
              userId: result.signedUpUserId,
              name: result.signedUpUser.name,
              profilePhotoUrl: result.signedUpUser.profilePhotoUrl,
              wallet: result.signedUpUser.wallet
            };
          }
          phonesRemaining--;
          if (!finalized && phonesRemaining == 0) {
            data.result = { numMatches: _.size(phoneToUserMapping) };
            if (data.result.numMatches > 0) {
              data.result.phoneToUserMapping = phoneToUserMapping;
            }
            data._state = "finished";
            self.resolveIfPossible(resolve, reject, data);
            finalized = true
            log.debug(`phoneLookup ${data._id} - finished`);
          }
        }, (error) => {
          finalized = true;
          reject(error);
        });
      });
    });
  }

  private processInvitationQueue() {
    let self = this;
    let queueRef = self.db.ref("/invitationQueue");
    let options = { 'numWorkers': 1 };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      try {
        self.lookupUsersByPhone(data.invitee.phone).then((result) => {
          let matchingUser: any = _.first(result.matchingUsers);
          if (matchingUser && matchingUser.identityVerificationRequestedAt) {
            reject(`Sorry, ${matchingUser.name} has already signed up with UR Money.`);
            return;
          }

          self.lookupUser(data.sponsorUserId).then((sponsor: any) => {
            // add new user to users list
            let newUser: any = {
              createdAt: firebase.database.ServerValue.TIMESTAMP,
              firstName: data.invitee.firstName,
              middleName: data.invitee.middleName,
              lastName: data.invitee.lastName,
              phone: data.invitee.phone,
              sponsor: {
                userId: data.sponsorUserId,
                name: sponsor.name,
                profilePhotoUrl: sponsor.profilePhotoUrl
              },
              downlineLevel: sponsor.downlineLevel + 1
            };
            newUser.name = self.fullName(newUser);
            newUser.profilePhotoUrl = self.generateProfilePhotoUrl(newUser.name);
            let newUserRef = self.db.ref('/users').push(newUser);

            // add new user to sponsor's downline users
            let newUserId = newUserRef.key;
            let sponsorRef = self.db.ref(`/users/${data.sponsorUserId}`);
            sponsorRef.child(`downlineUsers/${newUserId}`).set({ name: newUser.name, profilePhotoUrl: newUser.profilePhotoUrl });
            log.debug(`processed invitation of ${newUserId} (${newUser.name}) by ${data.sponsorUserId}`);
            self.resolveIfPossible(resolve, reject, data);
          });
        }, (error) => {
          reject(error);
          return;
        });
      } catch (e) {
        reject(e.message);
        return;
      }
    });
  }

  private processIdentityVerificationQueue() {
    let self = this;
    let queueRef = self.db.ref("/identityVerificationQueue");
    let options = { 'specId': 'verify_identity', 'numWorkers': 1, 'sanitize': false };
    let queue = new Queue(queueRef, options, (taskData: any, progress: any, resolve: any, reject: any) => {
      let rejected = false;
      function rejectOnce(message: string) {
        log.error(message);
        if (!rejected) {
          reject(message);
          rejected = true;
        }
      }
      let userId: string = taskData._id;
      let verificationArgs: any = {
        "AcceptTruliooTermsAndConditions": true,
        "Demo": true,
        "CleansedAddress": true,
        "ConfigurationName": "Identity Verification",
        "CountryCode": taskData.Location.Country,
        "DataFields": _.pick(taskData, ['PersonInfo', 'Location', 'Communication', 'DriverLicence', 'NationalIds', 'Passport'])
      };      
      let options = {
        url: 'https://api.globaldatacompany.com/verifications/v1/verify',
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Basic VVJDYXBpdGFsX0RlbW9fQVBJOnVaTkFkOEVlRjJyZGhkb01VcXgh"
        },
        body: verificationArgs,
        json: true
      };
      var request = require('request');

      request(options, (error, response, data) => {
        if (!error) {
          self.db.ref(`/users/${userId}`).update({
            identityVerificationResult: data.Record,
            identityVerificationRequestedAt: firebase.database.ServerValue.TIMESTAMP,
            identityVerifiedAt: data.Record.RecordStatus == "match" ? firebase.database.ServerValue.TIMESTAMP : null,
          });
          self.resolveIfPossible(resolve, reject, { result: data.Record });
        }
        else {
            rejectOnce(`something went wrong on the client: ${error}`);
        }
      });
    });
  }

  //////////////////////////////////////////////
  // helper functions
  //////////////////////////////////////////////

  private ensureQueueSpecLoaded(specPath: string, specValue: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let specRef = self.db.ref(specPath);
      specRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
        if (!snapshot.exists()) {
          specRef.set(specValue);
        };
        resolve();
      }, (error: string) => {
        reject(error);
      });
    });
  }

  private setUpURBlockQueue(): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      if (!this.web3) {
        // NOTE: This code assumes a tunnel to the UR rpc node is open.
        //       Run this to check for tunnel: nc -z localhost 9595 || echo 'no tunnel open'
        //       Run this to set up tunnel: RPCNODE1=45.55.7.79 ssh -f -o StrictHostKeyChecking=no -N -L 9595:127.0.0.1:9595 root@${RPCNODE1}

        let Web3 = require('web3');
        this.web3 = new Web3();
        this.web3.setProvider(new this.web3.providers.HttpProvider('http://localhost:9595'));
      }

      let tasksRef = this.db.ref(`/urBlockQueue/tasks`);
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

  private setUpQueues(): Promise<any> {
    let self = this;
    return self.ensureQueueSpecLoaded("/phoneAuthenticationQueue/specs/code_generation", {
      "in_progress_state": "code_generation_in_progress",
      "finished_state": "code_generation_completed_and_sms_sent",
      "error_state": "code_generation_error",
      "timeout": 15000
    }).then(() => {
      return self.ensureQueueSpecLoaded("/phoneAuthenticationQueue/specs/code_matching", {
        "start_state": "code_matching_requested",
        "in_progress_state": "code_matching_in_progress",
        "finished_state": "code_matching_completed",
        "error_state": "code_matching_error",
        "timeout": 15000
      });
    }).then(() => {
      return self.ensureQueueSpecLoaded("/phoneLookupQueue/specs/phone_lookup", {
        "in_progress_state": "in_progress",
        "finished_state": "finished",
        "error_state": "error",
        "timeout": 30000
      });
    }).then(() => {
      return self.ensureQueueSpecLoaded("/identityVerificationQueue/specs/verify_identity", {
        "in_progress_state": "processing",
        "finished_state": "finished",
        "error_state": "error",
        "timeout": 120000,
        "retries": 5
      });
    }).then(() => {
      return self.ensureQueueSpecLoaded("/urBlockQueue/specs/import", {
        "start_state": "ready_to_import",
        "in_progress_state": "processing",
        "error_state": "error",
        "timeout": 120000,
        "retries": 5
      });
    }).then(() => {
      return self.ensureQueueSpecLoaded("/urBlockQueue/specs/wait", {
        "start_state": "ready_to_wait",
        "in_progress_state": "waiting",
        "error_state": "error",
        "timeout": 120000,
        "retries": 5
      });
    }).then(() => {
      return self.setUpURBlockQueue();
    });
  };

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

  private importTransactions(blockNumber: number): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {

      self.web3.eth.getBlock(blockNumber, true, function(error: string, block: any) {
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

  private lookupChatSummary(userId: string, chatId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let chatSummaryRef = self.db.ref(`/users/${userId}/chatSummaries/${chatId}`);
      chatSummaryRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
        let chatSummary = snapshot.val();
        if (chatSummary) {
          resolve(chatSummary);
        } else {
          let error = `no chat summary exists at location ${chatSummaryRef.toString()}`
          log.warn(error);
          reject(error);
        }
      });
    });
  }

  private lookupMessage(userId: string, chatId: string, messageId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let messageRef = self.db.ref(`/users/${userId}/chats/${chatId}/messages/${messageId}`);
      messageRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
        let message = snapshot.val();
        if (message) {
          resolve(message);
        } else {
          let error = `no message exists at location ${messageRef.toString()}`
          log.warn(error);
          reject(error);
        }
      });
    });
  }

  private generateProfilePhotoUrl(user: any) {
    let colorScheme = _.sample([{
      background: "DD4747",
      foreground: "FFFFFF"
    }, {
        background: "ED6D54",
        foreground: "FFFFFF"
      }, {
        background: "FFBE5B",
        foreground: "FFFFFF"
      }, {
        background: "FFE559",
        foreground: "FFFFFF"
      }]);
    let initials = 'XX';
    if (user.firstName) {
      let firstLetters = user.firstName.match(/\b\w/g);
      initials = firstLetters[0];
      let lastNameFirstLetter = (user.lastName || '').match(/\b\w/g);
      initials = initials + lastNameFirstLetter[0];
      initials = initials.toUpperCase();
    }
    return "https://dummyimage.com/100x100/" + colorScheme.background + "/" + colorScheme.foreground + "&text=" + initials;
  };

  private fullName(user: any) {
    return `${user.firstName || ""} ${user.middleName || ""} ${user.lastName || ""}`.trim().replace(/  /, " ");
  }

  private sendMessage(phone: string, messageText: string): Promise<string> {
    let self = this;
    return new Promise((resolve, reject) => {
      if (!self.twilioClient) {
        self.twilioClient = new twilio.RestClient(self.env.TWILIO_ACCOUNT_SID, self.env.TWILIO_AUTH_TOKEN);
      }
      self.twilioClient.messages.create({
        to: phone,
        from: self.env.TWILIO_FROM_NUMBER,
        body: messageText
      }, (error: any) => {
        if (error) {
          log.debug(`error sending message '${messageText}' (${error.message})`);
        } else {
          log.debug(`sent message '${messageText}'' to ${phone}`);
        }
        resolve(error ? error.message : undefined);
      });
    });
  }

  private generateVerificationCode() {
    let min = 100000;
    let max = 999999;
    let num = Math.floor(Math.random() * (max - min + 1)) + min;
    return '' + num;
  };

  private doBlast() {
    let self = this;
    let messageName: string = "updated-url";
    self.db.ref("/users").orderByChild("invitedAt").on("child_added", (userSnapshot: firebase.database.DataSnapshot) => {
      let user: any = userSnapshot.val();
      let alreadySent: boolean = _.some(user.smsMessages, (message: any, messageId: string) => { return message.name == messageName; });
      if (alreadySent) {
        return;
      }

      let text: string;
      if (user.identityVerifiedAt) {
        text = "Thanks again for taking part in the UR Capital beta program! In the coming weeks, we’ll be releasing our new, free mobile app—UR Money—aimed at making it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. As a beta tester, you will be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
      } else {
        text = "This is a reminder that " + self.fullName(user.sponsor) + " has invited you to take part in the UR Capital beta test. There are only a few weeks left to sign up. As a beta tester, you will be the first to access UR Money, a free mobile app that makes it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. You will also be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
      }
      text = text + " put url here";
      userSnapshot.ref.child("smsMessages").push({
        name: messageName,
        type: user.identityVerifiedAt ? "signUp" : "invitation",
        createdAt: firebase.database.ServerValue.TIMESTAMP,
        sendAttempted: false,
        phone: user.phone,
        text: text
      });
    });

  }

  private fixUserData() {
    let self = this;
    self.db.ref("/users").on("child_added", (userSnapshot: firebase.database.DataSnapshot) => {
      let user = userSnapshot.val();
      let userId = userSnapshot.key;
      self.traverseObject(`/users/${userId}`, user, (valuePath: string, value: any, key: string) => {
        if (_.isObject(value) && value.firstName && /dummyimage/.test(value.profilePhotoUrl)) {
          let ref = self.db.ref(valuePath);
          log.info(`about to update value at ${valuePath}, firstName=${value.firstName}`);
          ref.update({ profilePhotoUrl: self.generateProfilePhotoUrl(value) });
        }
      });
    });
  };


  private traverseObject(parentPath: string, object: any, callback: any) {
    _.forEach(object, (value, key) => {
      let currentPath: string = `${parentPath}/${key}`;
      callback(currentPath, value, key);
      if (_.isObject(value) || _.isArray(value)) {
        this.traverseObject(currentPath, value, callback);
      }
    });
  }

  private lookupSignedUpUserByPhone(phone: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUsersByPhone(phone).then((result) => {
        let index = _.findIndex(result.matchingUsers, (user) => {
          return self.isCompletelySignedUp(user);
        });
        resolve({ signedUpUser: result.matchingUsers[index], signedUpUserId: result.matchingUserIds[index] });
      });
    });
  }

  private lookupUsersByPhone(phone: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.db.ref("/users").orderByChild("phone").equalTo(phone).once("value", (snapshot: firebase.database.DataSnapshot) => {

        // sort matching users with most completely signed up users first
        let userMapping = snapshot.val() || {};
        let users = _.values(userMapping);
        let userIds = _.keys(userMapping);
        _.each(users, (user: any, index: number) => { user.userId = userIds[index]; });
        let sortedUsers = _.reverse(_.sortBy(users, (user) => { return self.completenessRank(user); }));
        let sortedUserIds = _.map(sortedUsers, (user) => { return user.userId });

        resolve({ matchingUsers: sortedUsers, matchingUserIds: sortedUserIds });
      }, (error: string) => {
        reject(error);
      });
    });
  };

  private lookupUser(userId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let userRef = self.db.ref(`/users/${userId}`);
      userRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
        let user = snapshot.val();
        if (user) {
          resolve(user);
        } else {
          let error = `no user exists at location ${userRef.toString()}`
          log.warn(error);
          reject(error);
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

  private numberToHexString(n: number) {
    return "0x" + n.toString(16);
  }

  private hexStringToNumber(hexString: string) {
    return parseInt(hexString, 16);
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

  private completenessRank(user: any) {
    return (user.identityVerifiedAt ? 10000 : 0) + (user.wallet && !!user.wallet.address ? 1000 : 0) + (user.identityVerificationRequestedAt ? 100 : 0) +  (user.name ? 10 : 0) + (user.profilePhotoUrl ? 1 : 0);
  }

  private isCompletelySignedUp(user: any) {
    return !!user.identityVerifiedAt && !!user.name && !!user.profilePhotoUrl && !!user.wallet && !!user.wallet.address;
  }

  private containsUndefinedValue(objectOrArray: any): boolean {
    return _.some(objectOrArray, (value, key) => {
      let type = typeof (value);
      if (type == 'undefined') {
        return true;
      } else if (type == 'object') {
        return this.containsUndefinedValue(value);
      } else {
        return false;
      }
    });
  }

  private resolveIfPossible(resolve: any, reject: any, data: any) {
    if (this.containsUndefinedValue(data)) {
      reject(`undefined value in object ${JSON.stringify(data)}`);
      return false
    } else {
      resolve(data);
      return true;
    }
  }
}
