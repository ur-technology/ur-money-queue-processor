require('dotenv').load(); //load envirumnet vars

var throng = require('throng');
var Firebase = require("firebase");
var _ = require('underscore');
var s = require('underscore.string');
var twilio = require('twilio');
var moment = require('moment');

start();

throng(start, {
  workers : 1
});

function sendInvitationSmsIfNeeded(twilioClient, snapshot) {
  var user = snapshot.val();
  if (user.invitedAt && !user.verifiedAt && !user.invitationSmsSentAt && !user.invitationSmsFailedAt) {
    twilioClient.sms.messages.create({
        to:'+1' + user.phone,
        from: process.env.twilio_from_number,
        body: 'I just signed up with UR Capital! You can too: https://signup.ur.capital?r=' + user.referralMemberId + '&p=' + user.phone
    }, function(error, message) {
      if (error) {
        console.log('error sending invitation', error);
        snapshot.ref().update({invitationSmsFailedAt: Firebase.ServerValue.TIMESTAMP});
      } else {
        console.log('invitation successfully sent to', user.phone);
        snapshot.ref().update({invitationSmsSentAt: Firebase.ServerValue.TIMESTAMP});
      }
    });
  }
}

function sendWelcomeSmsIfNeeded(twilioClient, snapshot) {
  var user = snapshot.val();
  if (user.memberId > 5 && user.verifiedAt && !user.welcomeSmsSentAt && !user.welcomeSmsFailedAt) {
    var messageToSend = {
        to: '+1' + user.phone,
        from: process.env.twilio_from_number,
        body: 'Congratulations on being part of the UR Capital beta program! Build status by referring friends: https://signup.ur.capital?p=' + user.phone
    };
    twilioClient.sms.messages.create(messageToSend, function(error, message) {
      if (error) {
        console.log('error sending welcome message', error);
        snapshot.ref().update({welcomeSmsFailedAt: Firebase.ServerValue.TIMESTAMP});
      } else {
        console.log('welcome message successfully sent to', user.phone);
        snapshot.ref().update({welcomeSmsSentAt: Firebase.ServerValue.TIMESTAMP});
      }
    });
  }
}

function start() {
  console.log('worker started');

  var ref = new Firebase(process.env.firebase_ref);
  var twilioClient = new twilio.RestClient(process.env.twilio_account_sid, process.env.twilio_auth_token);

  var oneDayAgo = moment().add(-1, 'day').valueOf();

  // get all users invited in the last day
  var invitedUsersRef = ref.child("users").orderByChild("invitedAt").startAt(oneDayAgo);
  invitedUsersRef.on("child_added", function(snapshot) {
    sendInvitationSmsIfNeeded(twilioClient, snapshot);
  });
  invitedUsersRef.on("child_changed", function(snapshot) {
    sendInvitationSmsIfNeeded(twilioClient, snapshot);
  });

  // get all users verified in the last day
  var verifiedUsersRef = ref.child("users").orderByChild("verifiedAt").startAt(oneDayAgo);
  verifiedUsersRef.on("child_changed", function(snapshot) {
    sendWelcomeSmsIfNeeded(twilioClient, snapshot);
  });

};

process.on('SIGTERM', function () {
  console.log('exiting');
  process.exit();
});
