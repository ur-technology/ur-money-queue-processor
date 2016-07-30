require('dotenv').load(); // load environment vars

var log = require('loglevel');
log.setDefaultLevel(process.env.LOG_LEVEL || "info")

var throng = require('throng'); // no typings file
var _ = require('lodash');
_.mixin({
  isDefined: function(reference) {
    return !_.isUndefined(reference);
  }
});
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
    workers: 1
  });
} else {
  start(1);
}

function start(id) {
  log.info('worker started ' + id);

  processPhoneVerifications();
  // processUserSpecificEvents();

  process.on('SIGTERM', function() {
    log.info(`Worker ${ id } exiting...`);
    process.exit();
  });

};

//////////////////////////////////////////////
// task handler functions
//////////////////////////////////////////////

function processPhoneVerifications() {

  var verificationsRef = firebase.database().ref("/phoneVerifications");

  // send out verification codes for all new phone verifications
  verificationsRef.on("child_added", function(phoneVerificationSnapshot) {
    var phoneVerificationRef = phoneVerificationSnapshot.ref;
    var phoneVerification = phoneVerificationSnapshot.val();
    sendVerificationCodeViaSms(phoneVerification, phoneVerificationRef);
  });

  // check all submitted verification codes
  verificationsRef.on("child_changed", function(phoneVerificationSnapshot) {
    var phoneVerificationRef = phoneVerificationSnapshot.ref;
    var phoneVerification = phoneVerificationSnapshot.val();
    if (phoneVerification.status == "verification-code-submitted-via-app") {
      checkSubmittedVerificationCode(phoneVerification, phoneVerificationRef);
    }
  });
}

function processUserSpecificEvents() {

  _.each(["child_added", "child_changed"], function(childEvent) {
    usersRef.orderByChild("createdAt").on(childEvent, function(userSnapshot) { // TODO: restrict to recently updated ones
      var user = userSnapshot.val();
      var userId = userSnapshot.key;
      var userRef = userSnapshot.ref;

      processChatEvents(user, userId, userRef);
      processContactLookups(user, userId, userRef);
      processInvitations(user, userId, userRef);
      processSmsMessages(user, userId, userRef);
    });
  });
}

function processChatEvents(user, userId, userRef) {
  _.each(user.chatSummaries || {}, function(chatSummary, chatId) {
    if (chatSummary.pending && !chatSummary.beingProcessed) {
      copyChatSummary(chatSummary, chatId);
    }
    if (chatSummary.lastMessage && chatSummary.lastMessage.pending && !chatSummary.lastMessage.beingProcessed) {
      copyLastMessage(chatSummary, chatId);
    }
  });
};

function processInvitations(user, userId, userRef) {
  _.each(user.downlineUsers || {}, function(downlineUser, downlineUserId) {
    if (!downlineUser.pending || downlineUser.beingProcessed) {
      return;
    }

    if (!downlineUser.phone) {
      log.warn(`downline user ${downlineUserId} has no phone - skipping`);
      return;
    }

    log.debug(`downline ${downlineUserId} for user ${userId} -- started`);
    var sourceRef = usersRef.child(userId).child("downlineUsers").child(downlineUserId);
    sourceRef.update({beingProcessed: true})

    lookupUserByPhone(downlineUser.phone, function(matchingUser, matchingUserId) {
      var error;
      if (matchingUser && matchingUser.signedUpAt) {
        error = `Sorry, ${fullName(matchingUser)} has already signed up with UR Money.`
      } else {
        var newUser = {
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

function processContactLookups(user, userId, userRef) {
  _.each(user.contactLookups || {}, function(contactLookup, contactLookupId) {
    if (!contactLookup.pending || contactLookup.beingProcessed) {
      return;
    }
    var contactLookupRef = userRef.child("contactLookups").child(contactLookupId);
    contactLookupRef.update({beingProcessed: true});

    log.debug(`contactLookup ${contactLookupId} for user ${userId} -- started`);
    var contactsRemaining = contactLookup.contacts.length;
    var processedContacts = _.clone(contactLookup.contacts);
    _.each(processedContacts, (contact, contactIndex) => {
      _.each(contact.phones, (phone, phoneIndex) => {
        lookupUserByPhone(phone, function(matchingUser, matchingUserId) {
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

function processSmsMessages(user, userId, userRef) {
  _.each(user.smsMessages || {}, function(smsMessage, smsMessageId) {
    if (smsMessage.pending && !smsMessage.beingProcessed) {
      var sourceRef = userRef.child("smsMessages").child(smsMessageId);
      sourceRef.update({beingProcessed: true});
      log.debug(`smsMessage ${smsMessageId} for user ${userId} -- started`);
      sendMessage(smsMessage.phone, smsMessage.text, function(error) {
        if (error) {
          sourceRef.update({
            pending: false,
            beingProcessed: false,
            sendAttemptedAt: Firebase.ServerValue.TIMESTAMP,
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

function sendVerificationCodeViaSms(phoneVerification, phoneVerificationRef) {
  if (_.isUndefined(phoneVerification.phone)) {
    var error = `no phone submitted in phoneVerification record ${phoneVerificationRef.key}`;
    log.warn(error);
    phoneVerificationRef.update({ status: "verification-code-not-sent-via-sms", error: error});
    return;
  }

  // find user with the same phone as this verification
  lookupUserByPhone(phoneVerification.phone, function(user, userId) {

    if (!user) {
      log.info("no matching user found for " + phoneVerification.phone + " - skipping");
      phoneVerificationRef.update({
        status: "verification-code-not-sent-via-sms",
        error: "Use of UR Money is currently available by invitation only, and you phone number was not on the invitee list."
      });
      return;
    }

    log.debug(`matching user with userId ${userId}  found for phone ${phoneVerification.phone}`);
    var verificationCode = generateVerificationCode();
    sendMessage(phoneVerification.phone, `Your UR Money verification code is ${verificationCode}`, function(error) {
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

function checkSubmittedVerificationCode(phoneVerification, phoneVerificationRef) {
  if (phoneVerification.submittedVerificationCode == phoneVerification.verificationCode) {
    log.debug(`submittedVerificationCode ${phoneVerification.submittedVerificationCode} matches actual verificationCode; sending authToken to user`);
    var authToken = firebase.auth().createCustomToken(phoneVerification.userId, { some: "arbitrary", data: "here" });
    phoneVerificationRef.update({ status: "verification-succeeded", authToken: authToken });
  } else {
    error = `submittedVerificationCode ${phoneVerification.submittedVerificationCode} does not match actual verificationCode ${phoneVerification.verificationCode}`;
    log.debug(error);
    phoneVerificationRef.update({ status: "verification-failed", error: error });
  }
}

function generateProfilePhotoUrl(user) {
  var colorScheme = _.sample([{
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
  var initials = 'XX';
  if (user.firstName) {
    var firstLetters = user.firstName.match(/\b\w/g);
    initials = firstLetters[0];
    var lastNameFirstLetter = (user.lastName || '').match(/\b\w/g);
    initials = initials + lastNameFirstLetter[0];
    initials = initials.toUpperCase();
  }
  return "https://dummyimage.com/100x100/" + colorScheme.background + "/" + colorScheme.foreground + "&text=" + initials;
};

function copyChatSummary(chatSummary, chatId) {
  var creatorUserId = chatSummary.creatorUserId;
  var sourceRef = usersRef.child(creatorUserId).child("chatSummaries").child(chatId);
  sourceRef.update({beingProcessed: true});

  // copy chat summary to all participants other than the creator
  var otherUserIds = _.without(_.keys(chatSummary.users), creatorUserId);
  _.each(otherUserIds, function(otherUserId, index) {
    var chatSummaryCopy = _.extend(_.omit(chatSummary, 'pending'), {
      displayUserId: creatorUserId
    });
    chatSummaryCopy.lastMessage = _.omit(chatSummary.lastMessage, 'pending');
    var destinationRef = usersRef.child(otherUserId).child("chatSummaries").child(chatId);
    destinationRef.set(chatSummaryCopy);
    log.debug(`copied chatSummary to ${destinationRef.toString()}`);
  });

  sourceRef.update({pending: false, beingProcessed: false});
  log.debug(`marked chatSummary at ${sourceRef.toString()} as no longer needing to be copied`);
}

function copyLastMessage(chatSummary, chatId) {
  // create various copies of last message for all participants other than the sender
  var senderUserId = chatSummary.lastMessage.senderUserId;
  var otherUserIds = _.without(_.keys(chatSummary.users), senderUserId);
  var sourceRef = usersRef.child(senderUserId).child("chatSummaries").child(chatId).child("lastMessage");
  sourceRef.update({beingProcessed: true});

  _.each(otherUserIds, function(otherUserId, index) {

    if (!chatSummary.pending) {
      // copy last message to chat summary of other user unless this was already done above
      var lastMessageCopy = _.omit(chatSummary.lastMessage, 'pending');
      var destinationRef = usersRef.child(otherUserId).child("chatSummaries").child(chatId).child("lastMessage");
      destinationRef.set(lastMessageCopy);
      log.debug(`copied lastMessage to ${destinationRef.toString()}`);
    }

    // append copy of last message to the chat messages collection of other user
    var lastMessageCopy = _.omit(chatSummary.lastMessage, ['pending', 'messageId']);
    var destinationRef = usersRef.child(otherUserId).child("chats").child(chatId).child("messages").child(chatSummary.lastMessage.messageId);
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

  sourceRef.update({pending: false, beingProcessed: false});
  log.debug(`marked lastMessage at ${sourceRef.toString()} as no longer needing to be copied`);
}

function fullName(user) {
  return `${user.firstName || ""} ${user.middleName || ""} ${user.lastName || ""}`.trim().replace(/  /," ");
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
    var alreadySent = _.any(user.smsMessages, function(message, messageId) {
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

function fixUserData() {
  usersRef.on("child_added", function(userSnapshot) {
    var user = userSnapshot.val();
    var userId = userSnapshot.key;
    traverseObject(`/users/${userId}`, user, (valuePath, value, key) => {
      if (_.isObject(value) && value.firstName && /dummyimage/.test(value.profilePhotoUrl)) {
        var ref = firebase.database().ref(valuePath);
        log.info(`about to update value at ${valuePath}, firstName=${value.firstName}`);
        ref.update({profilePhotoUrl: generateProfilePhotoUrl(value)});
      }
    });
  });
};

function traverseObject(parentPath, object, callback) {
  _.forEach(object, function(value, key) {
    var currentPath = `${parentPath}/${key}`;
    callback(currentPath, value, key);
    if (_.isObject(value) || _.isArray(value)) {
      traverseObject(currentPath, value, callback);
    }
  });
}

function lookupUserByPhone(phone, callback) {
  usersRef.orderByChild("phone").equalTo(phone).limitToFirst(1).once("value", (matchingUsersSnapshot) => {
    var matchingUser;
    var matchingUserId;
    if (matchingUsersSnapshot.exists()) {
      matchingUser = _.values(matchingUsersSnapshot.val())[0];
      matchingUserId = _.keys(matchingUsersSnapshot.val())[0];
    }
    callback(matchingUser, matchingUserId);
  });
}
