require('dotenv').load(); // load environment vars

var log = require('loglevel');
log.setDefaultLevel(process.env.DEFAULT_LOG_LEVEL)

var throng = require('throng');
var _ = require('underscore');
_.mixin({
  isDefined: function(reference) {
    return !_.isUndefined(reference);
  }
});
var s = require('underscore.string');
var moment = require('moment');
var firebase = require("firebase");
firebase.initializeApp({
  serviceAccount: `./serviceAccountCredentials.${process.env.FIREBASE_PROJECT_ID}.json`,
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

var usersRef = firebase.database().ref("/users");
var twilio = require('twilio');
var twilioClient = new twilio.RestClient(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

log.info(`starting with NODE_ENV ${process.env.NODE_ENV} and FIREBASE_PROJECT_ID ${process.env.FIREBASE_PROJECT_ID}`);
if (process.env.NODE_ENV == "staging" || process.env.NODE_ENV == "production") {
  throng(start, {
    workers : 1
  });
} else {
  start(1);
}

function start(id) {
  log.info('worker started ' + id);

  processNewChatData();
  doPhoneVerification();
  processQueuedSmsMessages();

  process.on('SIGTERM', function () {
    log.info(`Worker ${ id } exiting...`);
    process.exit();
  });

};

//////////////////////////////////////////////
// task handler functions
//////////////////////////////////////////////

function doPhoneVerification() {

  // send out verification codes for all new phone verifications
  firebase.database().ref("/phoneVerifications").on("child_added", function(phoneVerificationSnapshot) {
    var phoneVerificationRef = phoneVerificationSnapshot.ref;
    var phoneVerification = phoneVerificationSnapshot.val();

    if (_.isUndefined(phoneVerification.phone)) {
      log.warn("no phone in phoneVerification record " + phoneVerificationSnapshot.key + " - skipping");
      return;
    }

    // find user with the same phone as this verification
    log.debug("processing phone verification for " + phoneVerification.phone);
    usersRef.orderByChild("phone").equalTo(phoneVerification.phone).limitToFirst(1).once("value", function(usersSnapshot) {

      if (_.isDefined(phoneVerification.smsSuccess)) {
        // this record was already processed
        log.debug("phone verification for " + phoneVerification.phone + " was already processed - skipping");
        return;
      }

      if (!usersSnapshot.exists()) {
        // let user know no sms was sent because of an error
        log.info("no matching user found for " + phoneVerification.phone + " - skipping");
        phoneVerificationRef.update({smsSuccess: false, smsError: "Use of UR Money is currently available by invitation only, and you phone number was not on the invitee list."});
        return;
      }
      var userId = _.keys(usersSnapshot.val())[0]; // get userId of first user with matching phone
      log.debug("matching user with userId " + userId + " found for " + phoneVerification.phone);

      // send sms to user with verification code
      var verificationCode = generateVerificationCode();
      sendMessage(phoneVerification.phone, "Your UR Money verification code is " + verificationCode, function(error) {
        if (error) {
          log.warn("error sending message to user with userId " + userId + " and phone " + phoneVerification.phone, error);
          phoneVerificationRef.update({smsSuccess: false, smsError: error});
          return;
        }

        // save verificationCode and let user know sms was sent
        phoneVerificationRef.update({smsSuccess: true, verificationCode: verificationCode}).then( () => {

          // wait for attemptedVerificationCode to be set
          phoneVerificationRef.on("value", function(updatedPhoneVerificationSnapshot) {
            if (!updatedPhoneVerificationSnapshot.exists()) {
              // record was deleted
              log.warn("phoneVerification record unexpectedly deleted for  " + phoneVerification.phone + " - skipping");
              return;
            }

            var updatedPhoneVerification = updatedPhoneVerificationSnapshot.val();
            if (_.isDefined(updatedPhoneVerification.verificationSuccess)) {
              log.info("phoneVerification.verificationSuccess already set for " + phoneVerification.phone + " - skipping");
              // this record was already processed
              return;
            }

            if (_.isUndefined(updatedPhoneVerification.attemptedVerificationCode)) {
              // attemptedVerificationCode not yet set, need to keep waiting
              log.debug("phoneVerification.attemptedVerificationCode not set for " + phoneVerification.phone + " - skipping");
              return;
            }

            var updatedPhoneVerificationRef = updatedPhoneVerificationSnapshot.ref;
            if (updatedPhoneVerification.attemptedVerificationCode == updatedPhoneVerification.verificationCode) {
              log.debug("attemptedVerificationCode " + updatedPhoneVerification.attemptedVerificationCode + " matches actual verificationCode; sending authToken to user");
              var authToken = firebase.auth().createCustomToken(userId, {some: "arbitrary", data: "here"});
              updatedPhoneVerificationRef.update({verificationSuccess: true, authToken: authToken});
            } else {
              log.debug("attemptedVerificationCode " + updatedPhoneVerification.attemptedVerificationCode + " does not match actual verificationCode " + updatedPhoneVerification.verificationCode);
              updatedPhoneVerificationRef.update({verificationSuccess: false});
            }
          });
        });
      });
    });
  });
};

function processNewChatData() {
  // loop through all chats for all users
  _.each(["child_added", "child_changed"], function(childEvent) {
    usersRef.orderByChild("createdAt").on(childEvent, function(userSnapshot) { // TODO: restrict to recently created ones
      var user = userSnapshot.val();
      _.each(user.chatSummaries || {}, function(chatSummary, chatId) {
        if (chatSummary.needsToBeCopied || (chatSummary.lastMessage && chatSummary.lastMessage.needsToBeCopied)) {
          makeCopyOfChatInfoForOtherUsers(chatSummary, chatId);
        }
      });
    });
  });
}

function processQueuedSmsMessages() {
  usersRef.orderByChild("invitedAt").on("child_added", function(userSnapshot) {
    userSnapshot.ref.child("smsMessages").orderByChild("sendAttempted").equalTo(false).on("child_added", function(smsMessageSnapshot) {
      var smsMessage = smsMessageSnapshot.val();
      sendMessage(smsMessage.phone, smsMessage.text, function(error) {
        smsMessageSnapshot.ref.update({
          sendAttempted: true,
          sendAttemptedAt: Firebase.ServerValue.TIMESTAMP,
          error: error
        });
      });
    });
  });
}

//////////////////////////////////////////////
// private functions
//////////////////////////////////////////////

function makeCopyOfChatInfoForOtherUsers(chatSummary, chatId) {
  var destinationRef;
  if (chatSummary.needsToBeCopied) {
    var creatorUserId = chatSummary.creatorUserId;

    // copy chat summary to all participants other than the creator
    var otherUserIds = _.without(_.keys(chatSummary.users), creatorUserId);
    _.each(otherUserIds, function(otherUserId, index) {
      var chatSummaryCopy = _.extend(_.omit(chatSummary, 'needsToBeCopied'), {displayUserId: creatorUserId});
      chatSummaryCopy.lastMessage = _.omit(chatSummary.lastMessage, 'needsToBeCopied');
      var destinationRef = usersRef.child(otherUserId).child("chatSummaries").child(chatId);
      destinationRef.set(chatSummaryCopy);
      log.debug(`copied chatSummary to ${destinationRef.toString()}`);
    });

    // mark chatSummary as no longer needing to be copied
    var destinationRef = usersRef.child(creatorUserId).child("chatSummaries").child(chatId).child("needsToBeCopied");
    destinationRef.remove();
    log.debug(`marked chatSummary at ${destinationRef.toString()} as no longer needing to be copied` );
  }

  // create various copies of last message for all participants other than the sender
  if (chatSummary.lastMessage && chatSummary.lastMessage.needsToBeCopied) {
    var senderUserId = chatSummary.lastMessage.senderUserId;
    var otherUserIds = _.without(_.keys(chatSummary.users), senderUserId);
    _.each(otherUserIds, function(otherUserId, index) {

      if (!chatSummary.needsToBeCopied) {
        // copy last message to chat summary of other user unless this was already done above
        var lastMessageCopy = _.omit(chatSummary.lastMessage, 'needsToBeCopied');
        destinationRef = usersRef.child(otherUserId).child("chatSummaries").child(chatId).child("lastMessage");
        destinationRef.set(lastMessageCopy);
        log.debug(`copied lastMessage to ${destinationRef.toString()}`);
      }

      // append copy of last message to the chat messages collection of other user
      var lastMessageCopy = _.omit(chatSummary.lastMessage, ['needsToBeCopied', 'messageId']);
      destinationRef = usersRef.child(otherUserId).child("chats").child(chatId).child("messages").child(chatSummary.lastMessage.messageId);
      destinationRef.set(lastMessageCopy);
      log.debug(`copied lastMessage to ${destinationRef.toString()}`);

      // create notification for other user
      var sender = chatSummary.users[senderUserId];
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

    // mark lastMessage as no longer needing to be copied
    destinationRef = usersRef.child(senderUserId).child("chatSummaries").child(chatId).child("lastMessage").child("needsToBeCopied");
    destinationRef.remove();
    log.debug(`marked lastMessage at ${destinationRef.toString()} as no longer needing to be copied` );
  }
}

function fullName(user) {
  return user.firstName + " " + user.lastName;
}

function sendMessage(phone, messageText, callback) {
  twilioClient.messages.create({
    to: phone,
    from: process.env.TWILIO_FROM_NUMBER,
    body: messageText
  }, function(error) {
    if (error) {
      error = "error sending message '" + messageText + "' (" + error.message + ")";
      log.debug(error);
    } else {
      log.debug("sent message '" + messageText + "' to '" + phone + "'");
    }
    if (callback) {
      callback(error);
    }
  });
}

function generateVerificationCode() {
  var min = 100000;
  var max = 999999;
  var num = Math.floor(Math.random() * (max - min + 1)) + min;
  return '' + num;
};

function doBlast() {
  var messageName = "updated-url";
  usersRef.orderByChild("invitedAt").on("child_added", function(userSnapshot) {
    var user = userSnapshot.val();
    var alreadySent = _.any(user.smsMessages, function(message,messageId) {
      return message.name == messageName;
    });
    if (alreadySent) {
      return;
    }

    var text;
    if (user.signedUpAt) {
      text = "Thanks again for taking part in the UR Capital beta program! In the coming weeks, we’ll be releasing our new, free mobile app—UR Money—aimed at making it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. As a beta tester, you will be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
    } else {
      text = "This is a reminder that " + fullName(user.sponsor) + " has invited you to take part in the UR Capital beta test. There are only a few weeks left to sign up. As a beta tester, you will be the first to access UR Money, a free mobile app that makes it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. You will also be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
    }
    text = text + " put url here";
    userSnapshot.ref.child("smsMessages").push({
      name: messageName,
      type: user.signedUpAt ? "signUp" : "invitation",
      createdAt: Firebase.ServerValue.TIMESTAMP,
      sendAttempted: false,
      phone: user.phone,
      text: text
    });
  });
}
