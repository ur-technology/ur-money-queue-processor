/// <reference path="../typings/index.d.ts" />

import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';

export class QueueProcessor {
  env: any;
  db: any;
  Queue: any;
  _disabled: boolean;
  static env: any;
  static web3: any;

  static initializeClass(env: any) {
    this.env = env;
    let Web3 = require('web3');
    this.web3 = new Web3();
    this.web3.setProvider(new this.web3.providers.HttpProvider("http://127.0.0.1:9595"));
  }

  constructor() {
    this.db = firebase.database();
    this.Queue = require('firebase-queue');
  }

  disabled(): boolean {
    if (_.isUndefined(this._disabled)) {
      let funcNameRegex = /function (.{1,})\(/;
      let results = (funcNameRegex).exec((this).constructor.toString());
      let className = results[1];
      let flag = _.toUpper(_.snakeCase(className)).replace(/_QUEUE_PROCESSOR$/,'_DISABLED');
      let flagValue = QueueProcessor.env[flag];
      this._disabled = !!flagValue && /true/i.test(flagValue);
    }
    return this._disabled;
  }

  ensureQueueSpecLoaded(specPath: string, specValue: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let specRef = self.db.ref(specPath);
      specRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
        if (!snapshot.exists()) {
          specRef.set(specValue);
        };
        resolve();
      }, (error: string) => {
        reject(error);
      });
    });
  }

  generateProfilePhotoUrl(user: any) {
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

  fullName(user: any) {
    return `${user.firstName || ""} ${user.middleName || ""} ${user.lastName || ""}`.trim().replace(/  /, " ");
  }

  resolveIfPossible(resolve: any, reject: any, data: any) {
    if (this.containsUndefinedValue(data)) {
      reject(`undefined value in object ${JSON.stringify(data)}`);
      return false
    } else {
      resolve(data);
      return true;
    }
  }

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
      if (user.identityVerifiedAt) {
        text = "Thanks again for taking part in the UR Capital beta program! In the coming weeks, we’ll be releasing our new, free mobile app—UR Money—aimed at making it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. As a beta tester, you will be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
      } else {
        text = "This is a reminder that " + self.fullName(user.sponsor) + " has invited you to take part in the UR Capital beta test. There are only a few weeks left to sign up. As a beta tester, you will be the first to access UR Money, a free mobile app that makes it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. You will also be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
      }
      text = text + " put url here";
      userSnapshot.ref.child("smsMessages").push({
        name: messageName,
        type: user.identityVerifiedAt ? "signUp" : "invitation",
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
          let ref = self.db.ref(valuePath);
          log.info(`about to update value at ${valuePath}, firstName=${value.firstName}`);
          ref.update({ profilePhotoUrl: self.generateProfilePhotoUrl(value) });
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

  lookupUsersByPhone(phone: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.db.ref("/users").orderByChild("phone").equalTo(phone).once("value", (snapshot: firebase.database.DataSnapshot) => {

        // sort matching users with most completely signed up users first
        let userMapping = snapshot.val() || {};
        let users = _.values(userMapping);
        let userIds = _.keys(userMapping);
        _.each(users, (user: any, index: number) => { user.userId = userIds[index]; });
        let sortedUsers = _.reverse(_.sortBy(users, (user) => { return self.completenessRank(user); }));
        let sortedUserIds = _.map(sortedUsers, (user) => { return user.userId });

        resolve({ matchingUsers: sortedUsers, matchingUserIds: sortedUserIds });
      }, (error: string) => {
        reject(error);
      });
    });
  };

  private numberToHexString(n: number) {
    return "0x" + n.toString(16);
  }

  private hexStringToNumber(hexString: string) {
    return parseInt(hexString, 16);
  }

  private completenessRank(user: any) {
    return (user.identityVerifiedAt ? 10000 : 0) + (user.wallet && !!user.wallet.address ? 1000 : 0) + (user.identityVerificationRequestedAt ? 100 : 0) +  (user.name ? 10 : 0) + (user.profilePhotoUrl ? 1 : 0);
  }

  private containsUndefinedValue(objectOrArray: any): boolean {
    return _.some(objectOrArray, (value, key) => {
      let type = typeof (value);
      if (type == 'undefined') {
        return true;
      } else if (type == 'object') {
        return this.containsUndefinedValue(value);
      } else {
        return false;
      }
    });
  }

}