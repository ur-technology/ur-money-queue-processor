/// <reference path="../typings/index.d.ts" />

import * as log from 'loglevel';
import * as _ from 'lodash';
import * as moment from 'moment';
import * as firebase from 'firebase';
let twilio = require('twilio');
let Queue = require('firebase-queue');

export class Notifier {
  public queues: any[];
  private db: any;
  private twilioClient: any;
  private twilioFromNumber: string;
  private web3: any;
  private previousBlockCount: number;
  private processingUrBlocks: boolean;

  constructor(env: any) {
    this.db = firebase.database();
    this.twilioClient = new twilio.RestClient(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);
    this.twilioFromNumber = env.TWILIO_FROM_NUMBER
    this.processingUrBlocks = env.PROCESSING_UR_BLOCKS == "true";
    this.queues = [];
  }

  start() {
    this.setUpQueueSpecs().then(() => {
      this.processPhoneAuthenticationQueueForCodeGeneration();
      this.processPhoneAuthenticationQueueForCodeMatching();
      this.processChatSummaryCopyingQueue();
      this.processChatMessageCopyingQueue();
      this.processPhoneLookupQueue();
      this.processInvitationQueue();
      if (this.processingUrBlocks) {
        this.populateUrBlockQueue();
        this.processUrBlockQueue()
      }
    });
  };

  //////////////////////////////////////////////
  // queue processing functions
  //////////////////////////////////////////////


  private ensureSpecLoaded(specPath: string, specValue: any): Promise<any> {
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

  private setUpQueueSpecs(): Promise<any> {
    let self = this;
    return self.ensureSpecLoaded("/phoneAuthenticationQueue/specs/code_generation", {
      "in_progress_state": "code_generation_in_progress",
      "finished_state": "code_generation_completed_and_sms_sent",
      "error_state": "code_generation_error",
      "timeout": 15000
    }).then(() => {
      return self.ensureSpecLoaded("/phoneAuthenticationQueue/specs/code_matching", {
        "start_state": "code_matching_requested",
        "in_progress_state": "code_matching_in_progress",
        "finished_state": "code_matching_completed",
        "error_state": "code_matching_error",
        "timeout": 15000
      });
    }).then(() => {
      return self.ensureSpecLoaded("/phoneLookupQueue/specs/phone_lookup", {
        "in_progress_state": "in_progress",
        "finished_state": "finished",
        "error_state": "error",
        "timeout": 30000
      });
    });
  };

  private populateUrBlockQueueLater(previousBlockCount: number) {
    let self = this;
    self.previousBlockCount = previousBlockCount;
    setTimeout((function() {
      log.trace("Sleeping for 10 seconds!");
      self.populateUrBlockQueue();
    }), 15000); // calling self in 15 seconds
  }

  private populateUrBlockQueue() {
    let self = this;

    if (!self.web3) {
      // NOTE: Need to make sure tunnel to rpc node is open.
      //       Run this to check for tunnel: nc -z localhost 9595 || echo 'no tunnel open'
      //       Run this to set up tunnel: RPCNODE1=45.33.72.14 ssh -f -o StrictHostKeyChecking=no -N -L 9595:127.0.0.1:9595 root@${RPCNODE1}

      let Web3 = require('web3');
      self.web3 = new Web3();
      self.web3.setProvider(new this.web3.providers.HttpProvider('http://localhost:9595'));
    }



    self.getLastQueuedBlockNumber().then((lastQueuedBlockNumber: number) => {
      self.getLastMinedBlockNumber().then((lastMinedBlockNumber: number) => {
        if (!lastMinedBlockNumber) {
          lastMinedBlockNumber = 0;
        }
        if (!lastQueuedBlockNumber) {
          lastQueuedBlockNumber = 0;
        }

        let totalBlockCount: number = lastMinedBlockNumber - lastQueuedBlockNumber;
        if (totalBlockCount > 0 || self.previousBlockCount !== 0) {
          log.info(`Last mined blockNumber is ${lastMinedBlockNumber}`);
          log.info(`Last queued blockNumber is ${lastQueuedBlockNumber}`);
          log.info(`Need to add ${totalBlockCount} new blocks to the queue`);
        }
        if (totalBlockCount == 0) {
          self.populateUrBlockQueueLater(0);
        }

        let blockNumber: number = lastQueuedBlockNumber;
        let blocksRemainingCount: number = totalBlockCount;
        let blocksQueuedCount: number = 0;
        while (true) {
          blockNumber++;
          if (blockNumber > lastMinedBlockNumber) {
            break;
          }

          var taskRef = self.db.ref(`/urBlockQueue/tasks/${blockNumber}`);
          taskRef.transaction((existingTask: any) => {
            if (existingTask === null) {
              log.trace(`block ${blockNumber} added to queue ${taskRef.toString()}`);
              return {createdBy: "worker1"};
            } else {
              log.trace(`block ${blockNumber} already exists in queue - skipping`);
              return; // cancel the transaction
            }
          }, (error: string, committed: boolean, snapshot: firebase.database.DataSnapshot) => {
            let blockNumberProcessed = snapshot.key;
            if (error) {
              log.warn(`Queueing of block ${blockNumberProcessed} failed abnormally: ${error}`);
            } else if (committed) {
              log.trace(`Queueing of block ${blockNumberProcessed} succeeded`);
              blocksQueuedCount++;
            } else {
              log.debug(`Queueing of block ${blockNumberProcessed} canceled because another worker already added it`);
            }
            blocksRemainingCount--;
            if (blocksRemainingCount == 0) {
              let extraDebuggingInfo = totalBlockCount > 0 ? `(Blocks ${lastQueuedBlockNumber + 1} through ${lastMinedBlockNumber})` : '';
              log.info(`processed ${totalBlockCount} blocks / queued ${blocksQueuedCount} blocks ${extraDebuggingInfo}`);
              self.setLastQueuedBlockNumber(lastMinedBlockNumber).then(() => {
                self.populateUrBlockQueueLater(totalBlockCount);
              });
            }
          });
        };
      });
    });
  }

  private processUrBlockQueue() {
    function importTransactions(transactions: any[]) {
      var urTransactionsRef = self.db.ref("/urTransactions");
      _.each(transactions, (transactionHash) => {
        urTransactionsRef.child(transactionHash).set(true);
      });
    }

    let self = this;
    let queueRef = self.db.ref("/urBlockQueue");
    let options = { 'numWorkers': 1, 'sanitize': false };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      let blockNumber = data._id;

      self.web3.eth.getBlock(blockNumber, true, function(error: string, result: any) {
        if (error) {
          error = `Could not get transaction for blockNumber ${blockNumber}: ${error};`
          log.warn(error);
          reject(error);
          return;
        }

        let transactions: any[] = result.transactions;

        // import transcactions into firebase
        var urTransactionsRef = self.db.ref("/urTransactions");
        _.each(transactions, (transactionHash) => {
          urTransactionsRef.child(transactionHash).set(true);
        });
        resolve(data);
      });

      // // a second way to call getBlock
      // let restler = require("restler");
      // let requestData = {
      //   "jsonrpc": "2.0",
      //   "method": "eth_getBlockByNumber",
      //   "params": `["${self.numberToHexString(blockNumber)}",true]`,
      //   "id": 1
      // };
      // restler.post('http://localhost:9595', { data: requestData }).on('complete', function(data: any, response: any) {
      //   if (data.error) {
      //     let error: string = `Could not get transaction for blockNumber ${blockNumber}: ${data.error.message};`
      //     log.warn(error);
      //     reject(error);
      //   }
      //   let transactions: any[] = data.tranaactions;
      //
      //   // import transcactions into firebase
      //   var urTransactionsRef = self.db.ref("/urTransactions");
      //   _.each(transactions, (transactionHash) => {
      //     urTransactionsRef.child(transactionHash).set(true);
      //   });
      //   resolve(data);
      // });

      // // a third way to call getBlock
      // let transactions: any[];
      // try {
      //   let command = `curl -X POST --data '{"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["${self.numberToHexString(blockNumber)}", true],"id":1}' localhost:9595`;
      //   let shelljs = require("shelljs");
      //   let outputString = shelljs.exec(command).stdout;
      //   let outputObject = JSON.parse(outputString);
      //   let result = outputObject.result
      //   transactions = result ? result.transactions : [];
      // } catch(e) {
      //   let error: string = `Could not get transaction for blockNumber ${blockNumber}: ${e.message};`
      //   log.warn(error);
      //   reject(error);
      //   return;
      // }
      // var urTransactionsRef = self.db.ref("/urTransactions");
      // _.each(transactions, (transactionHash) => {
      //   urTransactionsRef.child(transactionHash).set(true);
      // });
      // resolve(data);
    });
  }

  private processPhoneAuthenticationQueueForCodeGeneration() {
    let self = this;
    let queueRef = firebase.database().ref("/phoneAuthenticationQueue");
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
              data._state = "code_generation_completed_and_sms_sent";
              resolve(data);
            }
          });
        } else {
          log.info(`no matching user found for ${data.phone}`);
          data._new_state = "code_generation_canceled_because_user_not_invited";
          resolve(data);
        }
      }, (error) => {
        reject(error);
      });
    });
    self.queues.push(queue);
  }

  private processPhoneAuthenticationQueueForCodeMatching() {
    let self = this;
    let queueRef = firebase.database().ref("/phoneAuthenticationQueue");
    let options = { 'specId': 'code_matching', 'numWorkers': 1 };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      if (data.submittedVerificationCode == data.verificationCode) {
        log.debug(`submittedVerificationCode ${data.submittedVerificationCode} matches actual verificationCode; sending authToken to user`);
        data.verificationResult = { codeMatch: true, authToken: firebase.auth().createCustomToken(data.userId, { some: "arbitrary", data: "here" }) };
      } else {
        log.debug(`submittedVerificationCode ${data.submittedVerificationCode} does not match actual verificationCode ${data.verificationCode}`);
        data.verificationResult = { codeMatch: false };
      }
      resolve(data);
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
          let chatSummaryCopy: any = _.extend(chatSummary, {displayUserId: chatSummary.creatorUserId});
          let destinationRef = self.db.ref(`/users/${otherUserId}/chatSummaries/${data.chatId}`);
          destinationRef.set(chatSummaryCopy);
          log.trace(`copied chatSummary to ${destinationRef.toString()}`);
        });
        resolve(data)
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

            // create notification for other user
            let sender = chatSummary.users[message.senderUserId];
            let notificationRef = self.db.ref(`/users/${otherUserId}/notificationQueue/tasks`).push({
              // "createdAt" : the date that the message was sent
              // "messageText" :: The text of the message
              // "notificationProcessed" : "false"
              // "profilePhotoUrl" : The photo of the other user involved in the chat
              // "sourceId" : the chat id
              // "sourceType" : "message"
              // "title" : The title to be presented in the notification and in the event list. Example: Alpha Andrews has sent you a message
              // "updatedAt" : The date that message was sent
              // "userdId" : the id of the other user user involved in the chat
              senderName: `${sender.firstName} ${sender.lastName}`,
              text: message.text,
              chatId: data.chatId,
              messageId: data.messageId
            });
            log.trace(`created notification for message at ${notificationRef.toString()}`);
          });
          resolve(data)
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
    let rejected: boolean = false;
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      data.phones = data.phones || [];
      let phonesRemaining = data.phones.length;
      log.debug(`phoneLookup ${data._id} - started`);
      let phoneToUserMapping: any = {};
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
          if (phonesRemaining == 0 && !rejected) {
            log.debug(`phoneLookup ${data._id} - finished - ${data.phones.length} contacts`);
            data.result = { numMatches: _.size(phoneToUserMapping) };
            if (data.result.numMatches > 0) {
              data.result.phoneToUserMapping = phoneToUserMapping;
            }
            resolve(data);
          }
        }, (error) => {
          rejected = true;
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
          if (matchingUser && matchingUser.signedUpAt) {
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
            sponsorRef.child(`downlineUsers/${newUserId}`).set({name: newUser.name, profilePhotoUrl: newUser.profilePhotoUrl});
            log.debug(`processed invitation of ${newUserId} (${newUser.name}) by ${data.sponsorUserId}`);
            resolve(data);
          });
        }, (error) => {
          reject(error);
          return;
        });
      } catch(e) {
        reject(e.message);
        return;
      }
    });
  }

  //////////////////////////////////////////////
  // helper functions
  //////////////////////////////////////////////

  private lookupChatSummary(userId: string, chatId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let chatSummaryRef = firebase.database().ref(`/users/${userId}/chatSummaries/${chatId}`);
      chatSummaryRef.once('value', (snapshot) => {
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
      let messageRef = firebase.database().ref(`/users/${userId}/chats/${chatId}/messages/${messageId}`);
      messageRef.once('value', (snapshot) => {
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
    return `${user.firstName || ""} ${user.middleName || ""} ${user.lastName || ""}`.trim().replace(/  /," ");
  }

  private sendMessage(phone: string, messageText: string): Promise<string> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.twilioClient.messages.create({
        to: phone,
        from: self.twilioFromNumber,
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
      if (user.signedUpAt) {
        text = "Thanks again for taking part in the UR Capital beta program! In the coming weeks, we’ll be releasing our new, free mobile app—UR Money—aimed at making it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. As a beta tester, you will be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
      } else {
        text = "This is a reminder that " + self.fullName(user.sponsor) + " has invited you to take part in the UR Capital beta test. There are only a few weeks left to sign up. As a beta tester, you will be the first to access UR Money, a free mobile app that makes it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. You will also be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
      }
      text = text + " put url here";
      userSnapshot.ref.child("smsMessages").push({
        name: messageName,
        type: user.signedUpAt ? "signUp" : "invitation",
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
          let ref = firebase.database().ref(valuePath);
          log.info(`about to update value at ${valuePath}, firstName=${value.firstName}`);
          ref.update({profilePhotoUrl: self.generateProfilePhotoUrl(value)});
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
        resolve({signedUpUser: result.matchingUsers[index], signedUpUserId: result.matchingUserIds[index]});
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

        resolve({matchingUsers: sortedUsers, matchingUserIds: sortedUserIds});
      }, (error: string) => {
        reject(error);
      });
    });
  };

  private lookupUser(userId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let userRef = firebase.database().ref(`/users/${userId}`);
      userRef.once('value', (snapshot) => {
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
      self.db.ref("/users").orderByChild("wallet/address").equalTo(address).limitToFirst(1).once(function(snapshot: firebase.database.DataSnapshot) {
        let users = snapshot.val();
        let userId = _.first(_.keys(users));
        let user = _.first(_.values(users));
        if (!userId) {
          log.warn(`no user associated with address ${address}`);
        }
        resolve({user: user, userId: userId});
      });
    });
  }

  private numberToHexString(n: number) {
    return "0x" + n.toString(16);
  }

  private hexStringToNumber(hexString: string) {
    return parseInt(hexString,16);
  }

  private getLastQueuedBlockNumber(): Promise<number> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.db.ref("/urBlockQueue/lastQueuedUrBlockNumber").once('value', function(snapshot: firebase.database.DataSnapshot) {
        resolve(snapshot.val());
      }, (error: string) => {
        reject(error);
      });
    });
  }

  private setLastQueuedBlockNumber(blockNumber: number): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      var lastQueuedUrBlockNumberRef = self.db.ref("/urBlockQueue/lastQueuedUrBlockNumber");
      lastQueuedUrBlockNumberRef.transaction(function(existingBlockNumber: number) {
        if (existingBlockNumber === null || existingBlockNumber < blockNumber) {
          log.trace(`proceeding - existingBlockNumber ${existingBlockNumber} / blockNumber ${blockNumber}`);
          return blockNumber;
        } else {
          log.trace(`canceling - existingBlockNumber ${existingBlockNumber} / blockNumber ${blockNumber}`);
          return; // cancel the transaction
        }
      }, function(error: string, committed: boolean, snapshot: firebase.database.DataSnapshot) {
        if (error) {
          error = `an error occurred when trying to update /lastQueuedUrBlockNumber: ${error}`;
          log.warn(error);
          reject(error);
          return;
        }
        if (committed) {
          log.debug(`updated lastQueuedUrBlockNumber to ${snapshot.val()}`);
        } else {
          log.debug(`didn't update lastQueuedUrBlockNumber because another worker already updated it to ${snapshot.val()}`);
        }
        resolve();
      });
    });
  }

  private getLastMinedBlockNumber(): Promise<number> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.web3.eth.getBlockNumber(function(error: string, blockNumber: number) {
        if (error) {
          error = `Unable to retrieve latest block number: ${error}`;
          log.warn(error);
          reject(error);
        } else {
          resolve(blockNumber);
        }
      });
    });
  }

  private completenessRank(user: any) {
    return (user.signedUpAt ? 1000 : 0) + (user.wallet && !!user.wallet.address ? 100 : 0) + (user.name ? 10 : 0) + (user.profilePhotoUrl ? 1 : 0);
  }

  private isCompletelySignedUp(user: any) {
    return !!user.signedUpAt && !!user.name && !!user.profilePhotoUrl && !!user.wallet && !!user.wallet.address;
  }

}
