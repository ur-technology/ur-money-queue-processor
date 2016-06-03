require('dotenv').load(); //load envirumnet vars

var throng = require('throng');
var _ = require('underscore');
var s = require('underscore.string');
var moment = require('moment');
var Firebase = require("firebase");
var firebaseRef = new Firebase(process.env.firebase_url);
var FirebaseTokenGenerator = require("firebase-token-generator");
var usersRef = firebaseRef.child("users");
var twilio = require('twilio');
var twilioClient = new twilio.RestClient(process.env.twilio_account_sid, process.env.twilio_auth_token);

handleURMoneyTasks(); // uncomment this line for testing in development
// handleURCapitalAppTasks(); // uncomment this line for testing in development

throng(start, {
  workers : 1
});

function start(id) {
  console.log('worker started ' + id);

  handleURCapitalAppTasks();
  handleURMoneyTasks();

  process.on('SIGTERM', function () {
    console.log(`Worker ${ id } exiting...`);
    process.exit();
  });

};

//////////////////////////////////////////////
// task handler functions
//////////////////////////////////////////////

function handleURMoneyTasks() {

  // send out verification codes for all new phone verifications
  firebaseRef.child("phoneVerifications").on("child_added", function(phoneVerificationSnapshot) {
    var phoneVerificationRef = phoneVerificationSnapshot.ref();
    var phoneVerification = phoneVerificationSnapshot.val();
    if (!_.isUndefined(phoneVerification.smsSuccess)) {
      // this record was already processed
      return;
    }

    // find user with the same phone as this verification
    console.log("processing phone verification for " + phoneVerification.phone);
    usersRef.orderByChild("phone").equalTo(phoneVerification.phone).limitToFirst(1).once("value", function(usersSnapshot) {

      if (!usersSnapshot.exists()) {
        // let user know no sms was sent because of an error
        console.log("warning: no matching user found for " + phoneVerification.phone);
        phoneVerificationRef.update({smsSuccess: false, smsError: "No user account or invitation was found matching the given phone number."});
        return;
      }
      var uid = _.keys(usersSnapshot.val())[0]; // get uid of first user with matching phone
      console.log("matching user with uid " + uid + " found for " + phoneVerification.phone);

      // send sms to user with verification code
      var verificationCode = generateVerificationCode();
      sendMessage(phoneVerification.phone, "Your UR Money verification code is " + verificationCode, function() {

        // save verificationCode and let user know sms was sent
        phoneVerificationRef.update({smsSuccess: true, verificationCode: verificationCode}).then( () => {

          // wait for attemptedVerificationCode to be set
          phoneVerificationRef.on("value", function(updatedPhoneVerificationSnapshot) {
            if (!updatedPhoneVerificationSnapshot.exists()) {
              // record was deleted
              return;
            }

            var updatedPhoneVerification = updatedPhoneVerificationSnapshot.val();
            if (!_.isUndefined(updatedPhoneVerification.verificationSuccess)) {
              // this record was already processed
              return;
            }

            if (!updatedPhoneVerification.attemptedVerificationCode) {
              // attemptedVerificationCode not yet set
              return;
            }

            var updatedPhoneVerificationRef = updatedPhoneVerificationSnapshot.ref();
            if (updatedPhoneVerification.attemptedVerificationCode == updatedPhoneVerification.verificationCode) {
              var tokenGenerator = new FirebaseTokenGenerator(process.env.firebase_secret);
              var authToken = tokenGenerator.createToken({uid: uid, some: "arbitrary", data: "here"});
              console.log("attemptedVerificationCode " + verificationCode + " matches verificationCode; sending authToken to user");
              updatedPhoneVerificationRef.update({verificationSuccess: true, authToken: authToken});
            } else {
              console.log("warning: attemptedVerificationCode " + verificationCode + " doesn't matches correct code");
              updatedPhoneVerificationRef.update({verificationSuccess: false});
            }
          });
        });
      });
    });
  });
};

function handleURCapitalAppTasks() {
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
// helper functions
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
    } else {
      console.log("sent message '" + messageText + "' to '" + phone + "'");
    }
    if (callback) {
      callback(error);
    }
  });
}

function sendInvitationMessage(user) {
  var messageText = fullName(user.sponsor) + ' invites you to be a beta tester for UR Capital!  https://signup.ur.capital/go/' + user.phone;
  sendMessage(user.phone, messageText, function(error) {
    usersRef.child(user.uid).update(error ? {invitationSmsFailedAt: Firebase.ServerValue.TIMESTAMP} : {invitationSmsSentAt: Firebase.ServerValue.TIMESTAMP});
  });
};

function sendSignUpMessages(user) {
  var welcomeMessageText = 'Congratulations on being part of the UR Capital beta program! Build status by referring friends: https://signup.ur.capital/go/' + user.phone;
  sendMessage(user.phone, welcomeMessageText, function(error) {
    updateInfo = error ? {signUpMessagesFailedAt: Firebase.ServerValue.TIMESTAMP} : {signUpMessagesSentAt: Firebase.ServerValue.TIMESTAMP};
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

function generateVerificationCode() {
  var min = 100000;
  var max = 999999;
  var num = Math.floor(Math.random() * (max - min + 1)) + min;
  return '' + num;
};
