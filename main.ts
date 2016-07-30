/// <reference path="typings/index.d.ts" />

import * as dotenv from 'dotenv';
import * as log from 'loglevel';
import * as _ from 'lodash';
import * as moment from 'moment';
import * as firebase from 'firebase';
import * as os from 'os'; // defined in node.d.ts
let twilio = require('twilio'); // TODO: create definitions
let throng = require('throng'); // no typings file
_.mixin({
  isDefined: (reference: any) => {
    return !_.isUndefined(reference);
  }
});

var isThere = require("is-there");
if (isThere('.env')) {
  dotenv.config(); // if in dev mode, load config vars from .env file
}
log.setDefaultLevel(process.env.LOG_LEVEL || "info")
firebase.initializeApp({
  serviceAccount: `./serviceAccountCredentials.${process.env.FIREBASE_PROJECT_ID}.json`,
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});
let usersRef = firebase.database().ref("/users"); // TODO: create separate connection per worker
let twilioClient = new twilio.RestClient(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); // TODO: create seperate connection per worker


throng({
  workers: 1,
  master: startMaster,
  start: startWorker
});

function startMaster() {
  log.info(`starting with NODE_ENV ${process.env.NODE_ENV} and FIREBASE_PROJECT_ID ${process.env.FIREBASE_PROJECT_ID}`);
}

function startWorker(id: number) {
  log.info(`Worker ${id} started`);

  processPhoneVerifications();
  processUserSpecificEvents();

  process.on('SIGTERM', () => {
    log.info(`Worker ${id} exiting...`);
    process.exit();
  });

};

//////////////////////////////////////////////
// task handler functions
//////////////////////////////////////////////

function processPhoneVerifications() {
  let verificationsRef = firebase.database().ref("/phoneVerifications");

  // send out verification codes for all new phone verifications
  verificationsRef.on("child_added", (phoneVerificationSnapshot) => {
    let phoneVerificationRef = phoneVerificationSnapshot.ref;
    let phoneVerification = phoneVerificationSnapshot.val();
    if (phoneVerification.status == "verification-code-requested") {
      sendVerificationCodeViaSms(phoneVerification, phoneVerificationRef);
    };
  });

  // check all submitted verification codes
  verificationsRef.on("child_changed", (phoneVerificationSnapshot) => {
    let phoneVerificationRef = phoneVerificationSnapshot.ref;
    let phoneVerification = phoneVerificationSnapshot.val();
    if (phoneVerification.status == "verification-code-submitted-via-app") {
      checkSubmittedVerificationCode(phoneVerification, phoneVerificationRef);
    }
  });
}

function processUserSpecificEvents() {

  _.each(["child_added", "child_changed"], (childEvent) => {
    usersRef.orderByChild("createdAt").on(childEvent, (userSnapshot) => { // TODO: restrict to recently updated ones
      let user = userSnapshot.val();
      let userId = userSnapshot.key;
      let userRef = userSnapshot.ref;

      processChatEvents(user, userId, userRef);
      processContactLookups(user, userId, userRef);
      processInvitations(user, userId, userRef);
      processSmsMessages(user, userId, userRef);
    });
  });
}

function processChatEvents(user: any, userId: string, userRef: firebase.database.Reference) {
  _.each(user.chatSummaries || {}, (chatSummary, chatId) => {
    if (chatSummary.pending && !chatSummary.beingProcessed) {
      copyChatSummary(chatSummary, chatId);
    }
    if (chatSummary.lastMessage && chatSummary.lastMessage.pending && !chatSummary.lastMessage.beingProcessed) {
      copyLastMessage(chatSummary, chatId);
    }
  });
};

function processInvitations(user: any, userId: string, userRef: firebase.database.Reference) {
  _.each(user.downlineUsers || {}, (downlineUser, downlineUserId) => {
    if (!downlineUser.pending || downlineUser.beingProcessed) {
      return;
    }

    if (!downlineUser.phone) {
      log.warn(`downline user ${downlineUserId} has no phone - skipping`);
      return;
    }

    log.debug(`downline ${downlineUserId} for user ${userId} -- started`);
    let sourceRef = usersRef.child(userId).child("downlineUsers").child(downlineUserId);
    sourceRef.update({beingProcessed: true})

    lookupUserByPhone(downlineUser.phone, (matchingUser: any, matchingUserId: string) => {
      let error: string;
      if (matchingUser && matchingUser.signedUpAt) {
        error = `Sorry, ${fullName(matchingUser)} has already signed up with UR Money.`
      } else {
        let newUser: any = {
          createdAt: firebase.database.ServerValue.TIMESTAMP,
          firstName: downlineUser.firstName,
          middleName: downlineUser.middleName,
          lastName: downlineUser.lastName,
          profilePhotoUrl: generateProfilePhotoUrl(downlineUser),
          phone: downlineUser.phone,
          sponsor: _.extend({
              userId: userId
            },
            _.pick(user, ['firstName', 'middleName', 'lastName', 'profilePhotoUrl'])
          ),
          downlineLevel: user.downlineLevel + 1
        };
        newUser = _.omitBy(newUser, _.isNil);
        usersRef.child(downlineUserId).set(newUser);
      }

      sourceRef.update(_.omitBy({pending: false, beingProcessed: false, error: error}, _.isNil))
      log.debug(`downline ${downlineUserId} for user ${userId} -- started`);
    });
  });
};

function processContactLookups(user: any, userId: string, userRef: firebase.database.Reference) {
  _.each(user.contactLookups || {}, (contactLookup, contactLookupId) => {
    if (!contactLookup.pending || contactLookup.beingProcessed) {
      return;
    }
    let contactLookupRef = userRef.child("contactLookups").child(contactLookupId);
    contactLookupRef.update({beingProcessed: true});

    log.debug(`contactLookup ${contactLookupId} for user ${userId} -- started`);
    let contactsRemaining = contactLookup.contacts.length;
    let processedContacts = _.clone(contactLookup.contacts);
    _.each(processedContacts, (contact, contactIndex) => {
      _.each(contact.phones, (phone, phoneIndex) => {
        lookupUserByPhone(phone, (matchingUser: any, matchingUserId: string) => {
          if (!contact.userId && matchingUser && matchingUser.signedUpAt) {
            contact.userId = matchingUserId;
            contact.registeredPhoneIndex = phoneIndex;
          }
          contactsRemaining--;
          if (contactsRemaining == 0) {
            userRef.child("contactLookups").child(contactLookupId).update({
              pending: false,
              beingProcessed: false,
              processedContacts: processedContacts
            });
            log.debug(`contactLookup ${contactLookupId} for user ${userId} -- finished`);
          }
        });
      });
    });
  });
}

function processSmsMessages(user: any, userId: string, userRef: firebase.database.Reference) {
  _.each(user.smsMessages || {}, (smsMessage, smsMessageId) => {
    if (smsMessage.pending && !smsMessage.beingProcessed) {
      let sourceRef = userRef.child("smsMessages").child(smsMessageId);
      sourceRef.update({beingProcessed: true});
      log.debug(`smsMessage ${smsMessageId} for user ${userId} -- started`);
      sendMessage(smsMessage.phone, smsMessage.text).then((error: string) => {
        if (error) {
          sourceRef.update({
            pending: false,
            beingProcessed: false,
            sendAttemptedAt: firebase.database.ServerValue.TIMESTAMP,
            error: error
          });
        } else {
          sourceRef.remove();
        }
        log.debug(`smsMessage ${smsMessageId} for user ${userId} -- finished (success: ${!error})`);
      });
    }
  });
}

//////////////////////////////////////////////
// private functions
//////////////////////////////////////////////

function sendVerificationCodeViaSms(phoneVerification: any, phoneVerificationRef: firebase.database.Reference) {
  if (_.isUndefined(phoneVerification.phone)) {
    let error = `no phone submitted in phoneVerification record ${phoneVerificationRef.key}`;
    log.warn(error);
    phoneVerificationRef.update({ status: "verification-code-not-sent-via-sms", error: error});
    return;
  }

  // find user with the same phone as this verification
  lookupUserByPhone(phoneVerification.phone, (user: any, userId: string) => {

    if (!user) {
      log.info("no matching user found for " + phoneVerification.phone + " - skipping");
      phoneVerificationRef.update({
        status: "verification-code-not-sent-via-sms",
        error: "Use of UR Money is currently available by invitation only, and you phone number was not on the invitee list."
      });
      return;
    }

    log.debug(`matching user with userId ${userId}  found for phone ${phoneVerification.phone}`);
    let verificationCode = generateVerificationCode();
    sendMessage(phoneVerification.phone, `Your UR Money verification code is ${verificationCode}`).then((error: string) => {
      if (error) {
        error = `error sending message to user with userId ${userId} and phone ${phoneVerification.phone}: ${error}`
        phoneVerificationRef.update({ status: "verification-code-not-sent-via-sms", error: error});
      } else {
        // save verification code to db and notifiy client that it was sent via sms
        // NOTE: client is prevent via security rules from reading the verification code from the db
        phoneVerificationRef.update({ status: "verification-code-sent-via-sms", verificationCode: verificationCode, userId: userId });
      }
    });
  });
}

function checkSubmittedVerificationCode(phoneVerification: any, phoneVerificationRef: firebase.database.Reference) {
  if (phoneVerification.submittedVerificationCode == phoneVerification.verificationCode) {
    log.debug(`submittedVerificationCode ${phoneVerification.submittedVerificationCode} matches actual verificationCode; sending authToken to user`);
    let authToken = firebase.auth().createCustomToken(phoneVerification.userId, { some: "arbitrary", data: "here" });
    phoneVerificationRef.update({ status: "verification-succeeded", authToken: authToken });
  } else {
    let error = `submittedVerificationCode ${phoneVerification.submittedVerificationCode} does not match actual verificationCode ${phoneVerification.verificationCode}`;
    log.debug(error);
    phoneVerificationRef.update({ status: "verification-failed", error: error });
  }
}

function generateProfilePhotoUrl(user: any) {
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

function copyChatSummary(chatSummary: any, chatId: string) {
  let creatorUserId = chatSummary.creatorUserId;
  let sourceRef = usersRef.child(creatorUserId).child("chatSummaries").child(chatId);
  sourceRef.update({beingProcessed: true});

  // copy chat summary to all participants other than the creator
  let otherUserIds = _.without(_.keys(chatSummary.users), creatorUserId);
  _.each(otherUserIds, (otherUserId, index) => {
    let chatSummaryCopy: any = _.extend(_.omit(chatSummary, 'pending'), {
      displayUserId: creatorUserId
    });
    chatSummaryCopy.lastMessage = _.omit(chatSummary.lastMessage, 'pending');
    let destinationRef = usersRef.child(otherUserId).child("chatSummaries").child(chatId);
    destinationRef.set(chatSummaryCopy);
    log.debug(`copied chatSummary to ${destinationRef.toString()}`);
  });

  sourceRef.update({pending: false, beingProcessed: false});
  log.debug(`marked chatSummary at ${sourceRef.toString()} as no longer needing to be copied`);
}

function copyLastMessage(chatSummary: any, chatId: string) {
  // create various copies of last message for all participants other than the sender
  let senderUserId = chatSummary.lastMessage.senderUserId;
  let otherUserIds = _.without(_.keys(chatSummary.users), senderUserId);
  let sourceRef = usersRef.child(senderUserId).child("chatSummaries").child(chatId).child("lastMessage");
  sourceRef.update({beingProcessed: true});

  _.each(otherUserIds, (otherUserId, index) => {

    if (!chatSummary.pending) {
      // copy last message to chat summary of other user unless this was already done above
      let lastMessageCopy = _.omit(chatSummary.lastMessage, 'pending');
      let destinationRef = usersRef.child(otherUserId).child("chatSummaries").child(chatId).child("lastMessage");
      destinationRef.set(lastMessageCopy);
      log.debug(`copied lastMessage to ${destinationRef.toString()}`);
    }

    // append copy of last message to the chat messages collection of other user
    let lastMessageCopy = _.omit(chatSummary.lastMessage, ['pending', 'messageId']);
    let destinationRef = usersRef.child(otherUserId).child("chats").child(chatId).child("messages").child(chatSummary.lastMessage.messageId);
    destinationRef.set(lastMessageCopy);
    log.debug(`copied lastMessage to ${destinationRef.toString()}`);

    // create notification for other user
    let sender = chatSummary.users[senderUserId];
    destinationRef = usersRef.child(otherUserId).child("notifications");
    destinationRef.push({
      senderName: `${sender.firstName} ${sender.lastName}`,
      profilePhotoUrl: sender.profilePhotoUrl ? sender.profilePhotoUrl : "",
      text: chatSummary.lastMessage.text,
      chatId: chatId,
      messageId: chatSummary.lastMessage.messageId
    });
    log.debug(`pushed notification to ${destinationRef.toString()}`);
  });

  sourceRef.update({pending: false, beingProcessed: false});
  log.debug(`marked lastMessage at ${sourceRef.toString()} as no longer needing to be copied`);
}

function fullName(user: any) {
  return `${user.firstName || ""} ${user.middleName || ""} ${user.lastName || ""}`.trim().replace(/  /," ");
}

function sendMessage(phone: string, messageText: string): Promise<string> {
  let self = this;
  return new Promise((resolve, reject) => {
    twilioClient.messages.create({
      to: phone,
      from: process.env.TWILIO_FROM_NUMBER,
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

function generateVerificationCode() {
  let min = 100000;
  let max = 999999;
  let num = Math.floor(Math.random() * (max - min + 1)) + min;
  return '' + num;
};

function doBlast() {
  let messageName: string = "updated-url";
  usersRef.orderByChild("invitedAt").on("child_added", (userSnapshot: firebase.database.DataSnapshot) => {
    let user: any = userSnapshot.val();
    let alreadySent: boolean = _.some(user.smsMessages, (message: any, messageId: string) => { return message.name == messageName; });
    if (alreadySent) {
      return;
    }

    let text: string;
    if (user.signedUpAt) {
      text = "Thanks again for taking part in the UR Capital beta program! In the coming weeks, we’ll be releasing our new, free mobile app—UR Money—aimed at making it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. As a beta tester, you will be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
    } else {
      text = "This is a reminder that " + fullName(user.sponsor) + " has invited you to take part in the UR Capital beta test. There are only a few weeks left to sign up. As a beta tester, you will be the first to access UR Money, a free mobile app that makes it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. You will also be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
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

function fixUserData() {
  usersRef.on("child_added", (userSnapshot) => {
    let user = userSnapshot.val();
    let userId = userSnapshot.key;
    traverseObject(`/users/${userId}`, user, (valuePath: string, value: any, key: string) => {
      if (_.isObject(value) && value.firstName && /dummyimage/.test(value.profilePhotoUrl)) {
        let ref = firebase.database().ref(valuePath);
        log.info(`about to update value at ${valuePath}, firstName=${value.firstName}`);
        ref.update({profilePhotoUrl: generateProfilePhotoUrl(value)});
      }
    });
  });
};


function traverseObject(parentPath: string, object: any, callback: any) {
  _.forEach(object, (value, key) => {
    let currentPath: string = `${parentPath}/${key}`;
    callback(currentPath, value, key);
    if (_.isObject(value) || _.isArray(value)) {
      traverseObject(currentPath, value, callback);
    }
  });
}

function lookupUserByPhone(phone: string, callback: any) {
  usersRef.orderByChild("phone").equalTo(phone).limitToFirst(1).once("value", (matchingUsersSnapshot) => {
    let matchingUser: any;
    let matchingUserId: string;
    if (matchingUsersSnapshot.exists()) {
      matchingUser = _.values(matchingUsersSnapshot.val())[0];
      matchingUserId = _.keys(matchingUsersSnapshot.val())[0];
    }
    callback(matchingUser, matchingUserId);
  });
}
