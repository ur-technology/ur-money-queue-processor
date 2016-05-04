require('dotenv').load(); //load envirumnet vars

var throng = require('throng');
var Firebase = require("firebase");
var _ = require('underscore');
var s = require('underscore.string');
var twilio = require('twilio');
var moment = require('moment');
var twilioClient = new twilio.RestClient(process.env.twilio_account_sid, process.env.twilio_auth_token);
var usersRef = (new Firebase(process.env.firebase_url)).child("users");
var TIMESTAMP = Firebase.ServerValue.TIMESTAMP;

// start();

throng(start, {
  workers : 1
});

function start() {
  console.log('worker started');

  var oneDayAgo = moment().add(-1, 'day').valueOf();

  // get all users invited in the last day
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
};

process.on('SIGTERM', function () {
  console.log('exiting');
  process.exit();
});

//////////////////////////////////////////////
// private functions
//////////////////////////////////////////////

function fullName(user) {
  return user.firstName + " " + user.lastName;
}

function sendMessage(phone, messageText, callback) {
  twilioClient.sms.messages.create({
    to:'+1' + phone,
    from: process.env.twilio_from_number,
    body: messageText
  }, function(error, message) {
    if (error) {
      console.log("error sending message '" + message + "'", error);
    }
    if (callback) {
      callback(error);
    }
  });
}

function sendInvitationMessage(user) {
  var messageText = fullName(user.sponsor) + ' invites you to be a beta tester for UR Capital!  https://signup.ur.capital?p=' + user.phone;
  sendMessage(user.phone, messageText, function(error) {
    usersRef.child(user.uid).update(error ? {invitationSmsFailedAt: TIMESTAMP} : {invitationSmsSentAt: TIMESTAMP});
  });
};

function sendSignUpMessages(user) {
  var welcomeMessageText = 'Congratulations on being part of the UR Capital beta program! Build status by referring friends: https://signup.ur.capital?p=' + user.phone;
  sendMessage(user.phone, welcomeMessageText, function(error) {
    updateInfo = error ? {signUpMessagesFailedAt: TIMESTAMP} : {signUpMessagesSentAt: TIMESTAMP};
    usersRef.child(user.uid).update(updateInfo, function(error) {
      if (user.sponsor) {
        sendUplineSignUpMessages(user, null, user.sponsor.uid, 1);
      }
    });
  });
};

function sendUplineSignUpMessages(newUser, newUserSponsor, uplineUid, uplineLevel) {
  usersRef.child(uplineUid).once("value", function(snapshot) {
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
      sendUplineSignUpMessages(newUser, newUserSponsor, uplineUser.sponsor.uid, uplineLevel + 1);
    }
  });
};
