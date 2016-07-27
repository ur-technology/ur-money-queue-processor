require('dotenv').load(); //load envirumnet vars

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
  serviceAccount: `./serviceAccountCredentials.${process.env.NODE_ENV}.json`,
  databaseURL: `https://ur-money-${process.env.NODE_ENV}.firebaseio.com`
});

var usersRef = firebase.database().ref("/users");
var twilio = require('twilio');
var twilioClient = new twilio.RestClient(process.env.twilio_account_sid, process.env.twilio_auth_token);

console.log("starting with environment " + process.env.NODE_ENV);
if (process.env.NODE_ENV == "staging" || process.env.NODE_ENV == "production") {
  throng(start, {
    workers : 1
  });
} else {
  start(1);
}

function start(id) {
  console.log('worker started ' + id);

  // handlePrelaunchTasks();
  processNewChatData();
  doPhoneVerification();
  // processQueuedSmsMessages();

  process.on('SIGTERM', function () {
    console.log(`Worker ${ id } exiting...`);
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
      console.log("no phone in phoneVerification record " + phoneVerificationSnapshot.key + " - skipping");
      return;
    }

    // find user with the same phone as this verification
    console.log("processing phone verification for " + phoneVerification.phone);
    usersRef.orderByChild("phone").equalTo(phoneVerification.phone).limitToFirst(1).once("value", function(usersSnapshot) {

      if (_.isDefined(phoneVerification.smsSuccess)) {
        // this record was already processed
        console.log("phone verification for " + phoneVerification.phone + " was already processed - skipping");
        return;
      }

      if (!usersSnapshot.exists()) {
        // let user know no sms was sent because of an error
        console.log("no matching user found for " + phoneVerification.phone + " - skipping");
        phoneVerificationRef.update({smsSuccess: false, smsError: "No user account or invitation was found matching the given phone number."});
        return;
      }
      var userId = _.keys(usersSnapshot.val())[0]; // get userId of first user with matching phone
      console.log("matching user with userId " + userId + " found for " + phoneVerification.phone);

      // send sms to user with verification code
      var verificationCode = generateVerificationCode();
      sendMessage(phoneVerification.phone, "Your UR Money verification code is " + verificationCode, function(error) {
        if (error) {
          phoneVerificationRef.update({smsSuccess: false, smsError: error});
          return;
        }

        // save verificationCode and let user know sms was sent
        phoneVerificationRef.update({smsSuccess: true, verificationCode: verificationCode}).then( () => {

          // wait for attemptedVerificationCode to be set
          phoneVerificationRef.on("value", function(updatedPhoneVerificationSnapshot) {
            if (!updatedPhoneVerificationSnapshot.exists()) {
              // record was deleted
              console.log("phoneVerification record unexpectedly deleted for  " + phoneVerification.phone + " - skipping");
              return;
            }

            var updatedPhoneVerification = updatedPhoneVerificationSnapshot.val();
            if (_.isDefined(updatedPhoneVerification.verificationSuccess)) {
              console.log("phoneVerification.verificationSuccess already set for " + phoneVerification.phone + " - skipping");
              // this record was already processed
              return;
            }

            if (_.isUndefined(updatedPhoneVerification.attemptedVerificationCode)) {
              console.log("phoneVerification.attemptedVerificationCode not set for " + phoneVerification.phone + " - skipping");
              // attemptedVerificationCode not yet set
              return;
            }

            var updatedPhoneVerificationRef = updatedPhoneVerificationSnapshot.ref;
            if (updatedPhoneVerification.attemptedVerificationCode == updatedPhoneVerification.verificationCode) {
              console.log("attemptedVerificationCode " + updatedPhoneVerification.attemptedVerificationCode + " matches actual verificationCode; sending authToken to user");
              var authToken = firebase.auth().createCustomToken(userId, {some: "arbitrary", data: "here"});
              updatedPhoneVerificationRef.update({verificationSuccess: true, authToken: authToken});
            } else {
              console.log("attemptedVerificationCode " + updatedPhoneVerification.attemptedVerificationCode + " does not match actual verificationCode " + updatedPhoneVerification.verificationCode);
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
          copyChatSummaryAndLastMessage(chatSummary, chatId);
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

function handlePrelaunchTasks() {
  // get all users invited in the last day
  var oneDayAgo = moment().add(-1, 'day').valueOf();
  _.each(["child_added", "child_changed"], function(event) {
    usersRef.orderByChild("invitedAt").startAt(oneDayAgo).on(event, function(snapshot) {
      var user = snapshot.val();
      if (user.invitedAt && !user.signedUpAt && !user.invitationSmsSentAt && !user.invitationSmsFailedAt) {
        sendInvitationMessage(user);
      }
    });
  });

  // get all users signed up in the last day
  usersRef.orderByChild("signedUpAt").startAt(oneDayAgo).on("child_changed", function(snapshot) {
    var user = snapshot.val();
    if (user.signedUpAt && !user.signUpMessagesSentAt && !user.signUpMessagesFailedAt) {
      sendSignUpMessages(user);
    }
  });
}


//////////////////////////////////////////////
// private functions
//////////////////////////////////////////////

function copyChatSummaryAndLastMessage(chatSummary, chatId) {
  var creatorUserId = chatSummary.creatorUserId;
  var otherUserIds = _.without(_.keys(chatSummary.users), creatorUserId);
  _.each(otherUserIds, function(otherUserId, index) {
    if (chatSummary.needsToBeCopied) {
      // copy chat summary to other user (but change display user to be the chatSummary creator)
      var chatSummaryCopy = _.extend(_.omit(chatSummary, 'needsToBeCopied'), {displayUserId: creatorUserId});
      chatSummaryCopy.lastMessage = _.omit(chatSummary.lastMessage, 'needsToBeCopied');
      usersRef.child(otherUserId).child("chatSummaries").child(chatId).set(chatSummaryCopy);
    }
    if (chatSummary.lastMessage && chatSummary.lastMessage.needsToBeCopied) {
      if (!chatSummary.needsToBeCopied) {
        // copy last message to chat summary of other user if this was not already done
        var lastMessageCopy = _.omit(chatSummary.lastMessage, 'needsToBeCopied');
        usersRef.child(otherUserId).child("chatSummaries").child(chatId).update({lastMessage: lastMessageCopy});
      }

      // also append copy of last message to the chat messages collection of other user
      lastMessageCopy = _.omit(chatSummary.lastMessage, ['needsToBeCopied', 'messageId']);
      usersRef.child(otherUserId).child("chats").child(chatId).child("messages").child(chatSummary.lastMessage.messageId).set(lastMessageCopy);
    }
  });
  if (chatSummary.needsToBeCopied) {
    // mark chatSummary as no longer needing to be copied
    usersRef.child(creatorUserId).child("chatSummaries").child(chatId).child("needsToBeCopied").remove();
  }
  if (chatSummary.lastMessage && chatSummary.lastMessage.needsToBeCopied) {
    // mark lastMessage as no longer needing to be copied
    usersRef.child(creatorUserId).child("chatSummaries").child(chatId).child("lastMessage").child("needsToBeCopied").remove();
  }
}

function fullName(user) {
  return user.firstName + " " + user.lastName;
}

function sendMessage(phone, messageText, callback) {
  twilioClient.messages.create({
    to: phone,
    from: process.env.twilio_from_number,
    body: messageText
  }, function(error) {
    if (error) {
      error = "error sending message '" + messageText + "' (" + error.message + ")";
      console.log(error);
    } else {
      console.log("sent message '" + messageText + "' to '" + phone + "'");
    }
    if (callback) {
      callback(error);
    }
  });
}

function prelaunchReferralUrl() {
  return "http://beta.ur.capital";
}

function sendInvitationMessage(user) {
  var messageText = fullName(user.sponsor) + " invites you to be a beta tester of a new mobile app, UR Money! " + prelaunchReferralUrl();
  sendMessage(user.phone, messageText, function(error) {
    usersRef.child(user.userId).update(error ? {invitationSmsFailedAt: Firebase.ServerValue.TIMESTAMP} : {invitationSmsSentAt: Firebase.ServerValue.TIMESTAMP});
  });
};

function sendSignUpMessages(user) {
  var welcomeMessageText = "Congrats on being part of the UR Money beta program! Build status and increase your rewards by referring friends here: " + prelaunchReferralUrl();
  sendMessage(user.phone, welcomeMessageText, function(error) {
    updateInfo = error ? {signUpMessagesFailedAt: Firebase.ServerValue.TIMESTAMP} : {signUpMessagesSentAt: Firebase.ServerValue.TIMESTAMP};
    usersRef.child(user.userId).update(updateInfo, function(error) {
      if (user.sponsor) {
        sendUplineSignUpMessages(user, null, user.sponsor.userId, 1);
      }
    });
  });
};

function sendUplineSignUpMessages(newUser, newUserSponsor, uplineUserId, uplineLevel) {
  usersRef.child(uplineUserId).once("value", function(snapshot) {
    var uplineUser = snapshot.val();
    var messageText = "Your status has been updated because ";
    if (newUserSponsor) {
      messageText = messageText + " " + fullName(newUserSponsor) + " referred " + fullName(newUser) + " to be a beta tester for UR.capital!"
    } else {
      newUserSponsor = uplineUser
      messageText = messageText + fullName(newUser) + " has signed up as a beta tester with UR.capital!"
    }
    sendMessage(uplineUser.phone, messageText);
    if (uplineLevel < 7 && uplineUser.sponsor) {
      sendUplineSignUpMessages(newUser, newUserSponsor, uplineUser.sponsor.userId, uplineLevel + 1);
    }
  });
};

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
    text = text + " " + prelaunchReferralUrl();
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
