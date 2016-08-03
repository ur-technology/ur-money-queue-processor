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

  constructor(twilioOptions: any) {
    this.db = firebase.database();
    this.twilioFromNumber = twilioOptions.TWILIO_FROM_NUMBER
    this.twilioClient = new twilio.RestClient(twilioOptions.TWILIO_ACCOUNT_SID, twilioOptions.TWILIO_AUTH_TOKEN);
    this.queues = [];
  }

  start() {
    this.processPhoneAuthenticationQueueForCodeGeneration();
    this.processPhoneAuthenticationQueueForCodeMatching();
    this.processChatSummaryCopyingQueue();
    this.processChatMessageCopyingQueue();
    this.processContactLookupQueue();
    this.processInvitationQueue();
  };

  //////////////////////////////////////////////
  // queue processing functions
  //////////////////////////////////////////////

  private processPhoneAuthenticationQueueForCodeGeneration() {
    let self = this;
    let queueRef = firebase.database().ref("/phoneAuthenticationQueue");
    let options = { 'specId': 'code_generation', 'numWorkers': 1 };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      // TODO: skip this request if there is another more recent request for this phone number
      self.lookupUserByPhone(data.phone).then((result) => {
        if (result.matchingUserId) {
          log.debug(`matching user with userId ${result.matchingUserId} found for phone ${data.phone}`);
          let verificationCode = self.generateVerificationCode();
          self.sendMessage(data.phone, `Your UR Money verification code is ${verificationCode}`).then((error: string) => {
            if (error) {
              log.info(`error sending message to user with userId ${result.matchingUserId} and phone ${data.phone}: ${error}`);
              reject(error);
            } else {
              data.userId = result.matchingUserId;
              data.verificationCode = verificationCode;
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

  private processContactLookupQueue() {
    let self = this;
    let queueRef = self.db.ref("/contactLookupQueue");
    let options = { 'specId': 'contact_lookup', 'numWorkers': 1 };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      let contactsRemaining = data.contacts.length;
      data.processedContacts = _.clone(data.contacts);
      _.each(data.processedContacts, (contact, contactIndex) => {
        _.each(contact.phones, (phone, phoneIndex) => {
          self.lookupUserByPhone(phone).then((result) => {
            if (!contact.userId && result.matchingUser && result.matchingUserId && result.matchingUser.signedUpAt) {
              contact.userId = result.matchingUserId;
              contact.registeredPhoneIndex = phoneIndex;
            }
            contactsRemaining--;
            if (contactsRemaining == 0) {
              resolve(data);
            }
          }, (error) => {
            reject(error);
          });
        });
      });
    });
  }

  private processInvitationQueue() {
    let self = this;
    let queueRef = self.db.ref("/invitationQueue");
    let options = { 'numWorkers': 1 };
    let queue = new Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {

      self.lookupUserByPhone(data.downlineUser.phone).then((result) => {
        let error: string;
        if (result.matchingUser && result.matchingUser.signedUpAt) {
          reject(`Sorry, ${self.fullName(result.matchingUser)} has already signed up with UR Money.`);
          return;
        }

        self.lookupUser(data.sponsorUserId).then((sponsor: any) => {
          // add new user to users list
          let summaryFields = ['firstName', 'middleName', 'lastName', 'profilePhotoUrl'];
          let sponsorSummary = _.extend({ userId: data.sponsorUserId },_.pick(sponsor, summaryFields));
          let newUser: any = {
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            firstName: data.downlineUser.firstName,
            middleName: data.downlineUser.middleName,
            lastName: data.downlineUser.lastName,
            profilePhotoUrl: self.generateProfilePhotoUrl(data.downlineUser),
            phone: data.downlineUser.phone,
            sponsor: sponsorSummary,
            downlineLevel: sponsor.downlineLevel + 1
          };
          newUser = _.omitBy(newUser, _.isNil);
          let newUserRef = self.db.ref('/users').push(newUser);

          // add new user to sponsor's downline users
          let newUserId = newUserRef.key;
          let newUserSummary = _.pick(newUser, summaryFields);
          self.db.ref(`/users/${data.sponsorUserId}/downlineUsers/${newUserId}`).set(newUserSummary);
        });
        log.debug(`processed invitation of ${data.downlineUserId} (${self.fullName(data.downlineUser)}) by ${data.userId}`);
      }, (error) => {
        reject(error);
        return;
      });
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

  private lookupUserByPhone(phone: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.db.ref("/users").orderByChild("phone").equalTo(phone).limitToFirst(1).once("value", (snapshot: firebase.database.DataSnapshot) => {
        let matchingUser: any;
        let matchingUserId: string;
        if (snapshot.exists()) {
          let matchingUsers = snapshot.val();
          matchingUser = _.first(_.values(matchingUsers));
          matchingUserId = _.first(_.keys(matchingUsers));
        }
        resolve({matchingUser: matchingUser, matchingUserId: matchingUserId});
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

}
