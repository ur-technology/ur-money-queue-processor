require('dotenv').load(); //load envirumnet vars

var throng = require('throng');
var _ = require('underscore');
var s = require('underscore.string');
var moment = require('moment');
var Firebase = require("firebase");
var firebaseUrl = process.env.NODE_ENV == 'production' ? process.env.firebase_url_production : process.env.firebase_url_dev;
var firebaseSecret = process.env.NODE_ENV == 'production' ? process.env.firebase_secret_production : process.env.firebase_secret_dev;
var firebaseRef = new Firebase(firebaseUrl);
var FirebaseTokenGenerator = require("firebase-token-generator");
var usersRef = firebaseRef.child("users");
var twilio = require('twilio');
var twilioClient = new twilio.RestClient(process.env.twilio_account_sid, process.env.twilio_auth_token);
var Web3 = require('web3');

// handleURMoneyTasks(); // uncomment this line for testing in development
// handleURCapitalAppTasks(); // uncomment this line for testing in development

var environment = process.env.NODE_ENV || "development"
console.log("starting with environment " + environment);
if (environment == "development") {
    // development environment
    start(1);
} else {
  // staging or production environment
  throng(start, {
    workers : 1
  });
}

function start(id) {
  console.log('worker started ' + id);

  getBalances();
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


function getBalances() {
  var web3 = new Web3();
  web3.setProvider(new web3.providers.HttpProvider('http://198.74.48.148:9595'));

  usersRef.once("value", function(snapshot) {
    var usersObject = snapshot.val();
    var numUsers = _.size(usersObject);
    var i = 0;
    _.each(usersObject, function(user,uid) {
      if (user.wallet && user.wallet.publicKey) {
        var currentBalanceAmount = web3.eth.getBalance(user.wallet.publicKey).toString();
        if (!user.wallet.currentBalance || currentBalanceAmount != user.wallet.currentBalance.amount) {
          var newBalanceInfo = {amount: currentBalanceAmount, updatedAt: Firebase.ServerValue.TIMESTAMP};
          usersRef.child(uid).child("wallet").child("currentBalance").update(
            {amount: currentBalanceAmount, updatedAt: Firebase.ServerValue.TIMESTAMP}
          ).then(() => {
            usersRef.child(uid).child("wallet").child("currentBalance").once("value", function(snapshot) {
              var currentBalanceRecord = snapshot.val();
              usersRef.child(uid).child("wallet").child("balanceHistory").push(currentBalanceRecord);
            });
          });
        }
      }
      i++;
      if (i == numUsers) {
        var thirtySeconds = 30 * 1000;
        setTimeout(getBalances, thirtySeconds);
      }
    });
  });
}

function handleURMoneyTasks() {

  // send out verification codes for all new phone verifications
  firebaseRef.child("phoneVerifications").on("child_added", function(phoneVerificationSnapshot) {
    var phoneVerificationRef = phoneVerificationSnapshot.ref();
    var phoneVerification = phoneVerificationSnapshot.val();

    // find user with the same phone as this verification
    console.log("processing phone verification for " + phoneVerification.phone);
    console.log("phoneVerification: ", phoneVerification);
    usersRef.orderByChild("phone").equalTo(phoneVerification.phone).limitToFirst(1).once("value", function(usersSnapshot) {

      if (!_.isUndefined(phoneVerification.smsSuccess)) {
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
              console.log("phoneVerification record unexpectedly deleted for  " + phoneVerification.phone + " - skipping");
              return;
            }

            var updatedPhoneVerification = updatedPhoneVerificationSnapshot.val();
            if (!_.isUndefined(updatedPhoneVerification.verificationSuccess)) {
              console.log("phoneVerification.verificationSuccess already set for " + phoneVerification.phone + " - skipping");
              // this record was already processed
              return;
            }

            if (_.isUndefined(updatedPhoneVerification.attemptedVerificationCode)) {
              console.log("phoneVerification.attemptedVerificationCode not set for " + phoneVerification.phone + " - skipping");
              // attemptedVerificationCode not yet set
              return;
            }

            var updatedPhoneVerificationRef = updatedPhoneVerificationSnapshot.ref();
            if (updatedPhoneVerification.attemptedVerificationCode == updatedPhoneVerification.verificationCode) {
              var tokenGenerator = new FirebaseTokenGenerator(firebaseSecret);
              var authToken = tokenGenerator.createToken({uid: uid, some: "arbitrary", data: "here"});
              console.log("attemptedVerificationCode " + updatedPhoneVerification.attemptedVerificationCode + " matches actual verificationCode; sending authToken to user");
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
    to: phone,
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

function prelaunchReferralUrl(user) {
  return "https://signup.ur.capital/go/" + user.phone.replace(/^(\+1|1)/,"");
}

function sendInvitationMessage(user) {
  var messageText = fullName(user.sponsor) + " invites you to be a beta tester for UR Capital! " + prelaunchReferralUrl(user);
  sendMessage(user.phone, messageText, function(error) {
    usersRef.child(user.uid).update(error ? {invitationSmsFailedAt: Firebase.ServerValue.TIMESTAMP} : {invitationSmsSentAt: Firebase.ServerValue.TIMESTAMP});
  });
};

function sendSignUpMessages(user) {
  var welcomeMessageText = "Congratulations on being part of the UR Capital beta program! Build status by referring friends: " + prelaunchReferralUrl(user);
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
