require('dotenv').load(); //load envirumnet vars

var _ = require('underscore');
var s = require('underscore.string');
var moment = require('moment');
var Firebase = require("firebase");
var firebaseUrl = process.env.NODE_ENV == 'production' ? process.env.firebase_url_production : process.env.firebase_url_dev;
var firebaseSecret = process.env.NODE_ENV == 'production' ? process.env.firebase_secret_production : process.env.firebase_secret_dev;
var firebaseRef = new Firebase(firebaseUrl);
var FirebaseTokenGenerator = require("firebase-token-generator");
var usersRef = firebaseRef.child("users");

doBlast();

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
    userSnapshot.ref().child("smsMessages").push({
      name: messageName,
      type: user.signedUpAt ? "signUp" : "invitation",
      createdAt: Firebase.ServerValue.TIMESTAMP,
      sendAttempted: false,
      phone: user.phone,
      text: text
    });
  });
}

//////////////////////////////////////////////
// helper functions
//////////////////////////////////////////////

function fullName(user) {
  return user.firstName + " " + user.lastName;
}

function prelaunchReferralUrl() {
  return "http://beta.ur.capital";
}
