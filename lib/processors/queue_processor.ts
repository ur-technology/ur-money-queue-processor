/// <reference path="../../typings/index.d.ts" />

import { IDVerifier } from './interfaces/id-verifier';

import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';

export class QueueProcessor {
    db: any;
    auth: any;
    storage: any;
    idVerifier: IDVerifier;
    Queue: any;
    _enabled: boolean;

    static db: any;
    static auth: any;
    static storage: any;
    static idVerifier: IDVerifier;
    static Queue: any;

    static env: any;
    static _web3: any;

    static web3() {
        if (!this._web3) {
            let Web3 = require('web3');
            this._web3 = new Web3();
            this._web3.setProvider(new this._web3.providers.HttpProvider("http://127.0.0.1:9595"));
        }
        return this._web3;
    }

    constructor() {
        this.db = QueueProcessor.db;
        this.auth = QueueProcessor.auth;
        this.storage = QueueProcessor.storage;
        this.idVerifier = QueueProcessor.idVerifier;
        this.Queue = QueueProcessor.Queue;
    }

    className(): string {
        let funcNameRegex = /function (.{1,})\(/;
        let results = (funcNameRegex).exec((this).constructor.toString());
        return results[1];
    }

    enabled(): boolean {

        if (_.isUndefined(this._enabled)) {
            let className = this.className();
            let flag = _.toUpper(_.snakeCase(className)).replace(/$/, '_ENABLED');
            let flagValue = QueueProcessor.env[flag];
            this._enabled = !!flagValue && /true/i.test(flagValue);
        }
        return this._enabled;
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
        let firstLetters = user.firstName && user.firstName.match(/\b\w/g);
        if (firstLetters) {
            initials = firstLetters[0];
            let lastNameFirstLetter = (user.lastName || '').match(/\b\w/g);
            if (lastNameFirstLetter) {
                initials = initials + lastNameFirstLetter[0];
            }
            initials = initials.toUpperCase();
        }
        return "https://dummyimage.com/100x100/" + colorScheme.background + "/" + colorScheme.foreground + "&text=" + initials;
    };

    fullName(user: any) {
        return `${user.firstName || ''} ${user.middleName || ''} ${user.lastName || ''}`.trim().replace(/  /, ' ');
    }

    startTask(queue: any, task: any, suppressLogging?: boolean) {
        if (!suppressLogging) {
            log.info(`task ${queue.tasksRef.path.toString()}/${task._id} with specId ${queue.specId} - started`);
        }
    }

    resolveTask(queue: any, task: any, resolve: any, reject: any, suppressLogging?: boolean) {
        if (this.containsUndefinedValue(task)) {
            this.rejectTask(queue, task, `undefined value in object ${JSON.stringify(task)}`, reject, suppressLogging);
        } else {
            if (!suppressLogging) {
                if (!queue.specId) {
                    log.info(`  specId not defined!`);
                }
                log.info(`task ${queue.tasksRef.path.toString()}/${task._id} with specId ${queue.specId} - resolved`);
            }
            resolve(task);
        }
    }

    rejectTask(queue: any, task: any, error: any, reject: any, suppressLogging?: boolean) {
        if (!suppressLogging) {
            log.info(`task ${queue.tasksRef.path.toString()}/${task._id} with specId ${queue.specId} - rejected - error: ${error}`);
        }
        reject(error);
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

            let text: string = "Thanks again for taking part in the UR Capital beta program! In the coming weeks, we’ll be releasing our new, free mobile app—UR Money—aimed at making it easier for non-technical people to acquire and use cryptocurrency for everyday transactions. As a beta tester, you will be awarded an amount of cryptocurrency based on the status you build by referring others to the beta test. We look forward to welcoming you to the world of cryptocurrency!";
            text = text + " put url here";
            userSnapshot.ref.child("smsMessages").push({
                name: messageName,
                type: "signUp",
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
                    log.info(`  about to update value at ${valuePath}, firstName=${value.firstName}`);
                    ref.update({ profilePhotoUrl: self.generateProfilePhotoUrl(value) });
                }
            });
        });
    }

    private traverseObject(parentPath: string, object: any, callback: any) {
        _.forEach(object, (value, key) => {
            let currentPath: string = `${parentPath}/${key}`;
            callback(currentPath, value, key);
            if (_.isObject(value) || _.isArray(value)) {
                this.traverseObject(currentPath, value, callback);
            }
        });
    }

    lookupUsersByPhone(phone: string): Promise<any[]> {
        let ref = this.db.ref("/users").orderByChild("phone").equalTo(phone);
        return this.lookupUsers(ref);
    }

    lookupUsersByEmail(email: string): Promise<any[]> {
        let ref = this.db.ref("/users").orderByChild("email").equalTo(email);
        return this.lookupUsers(ref);
    }

    lookupUsersByReferralCode(referralCode: string): Promise<any[]> {
        let ref = this.db.ref("/users").orderByChild("referralCode").equalTo(referralCode);
        return this.lookupUsers(ref);
    }

    lookupUsersByPrefineryId(id: string): Promise<any[]> {
        let ref = this.db.ref("/users").orderByChild("prefineryUser/id").equalTo(id);
        return this.lookupUsers(ref);
    }

    lookupUsers(ref: any): Promise<any[]> {
        let self = this;
        return new Promise((resolve, reject) => {
            ref.once("value", (snapshot: firebase.database.DataSnapshot) => {

                // sort matching users with most completely signed up users first
                let userMapping = snapshot.val() || {};
                let users = _.values(userMapping);
                let userIds = _.keys(userMapping);
                _.each(users, (user: any, index: number) => { user.userId = userIds[index]; });
                let sortedUsers = _.reverse(_.sortBy(users, (user) => { return self.completenessRank(user); }));
                let sortedUserIds = _.map(sortedUsers, (user) => { return user.userId });

                resolve(sortedUsers);
            }, (error: string) => {
                reject(error);
            });
        });
    };


    lookupUserById(userId: string): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            let userRef = self.db.ref(`/users/${userId}`);
            userRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
                let user: any = snapshot.val();
                if (user) {
                    user.userId = userId;
                    resolve(user);
                } else {
                    let error = `no user exists at location ${userRef.toString()}`
                    log.warn('  ' + error);
                    reject(error);
                }
            });
        });
    }

    registrationStatus(user: any): string {
        return _.trim((user && user.registration && user.registration.status) || "initial");
    }

    verificationCompleted(user: any) {
        return _.includes([
            'verification-succeeded',
            'announcement-initiated',
            'announcement-requested', // deprecated
            'announcement-failed',
            'announcement-confirmed'
        ], this.registrationStatus(user));
    }

    isCompletelySignedUp(user: any) {
        return !user.disabled &&
            this.verificationCompleted(user) &&
            !!user.wallet && !!user.wallet.address;
    }

    private numberToHexString(n: number) {
        return "0x" + n.toString(16);
    }

    private hexStringToNumber(hexString: string) {
        return parseInt(hexString, 16);
    }

    private completenessRank(user: any) {
        return (this.verificationCompleted(user) ? 1000 : 0) +
            (user.wallet && !!user.wallet.address ? 100 : 0) +
            (user.name ? 10 : 0) +
            (user.profilePhotoUrl ? 1 : 0);
    }

    containsUndefinedValue(objectOrArray: any): boolean {
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

    removeUndefineds(objectOrArray: any) {
        var isArray = objectOrArray instanceof Array;
        for (var k in objectOrArray) {
            if (objectOrArray[k] === undefined) {
                if (isArray) {
                    objectOrArray.splice(k, 1);
                } else {
                    delete objectOrArray[k];
                }
            } else if (typeof objectOrArray[k] === 'object') {
                this.removeUndefineds(objectOrArray[k]);
            }
        };
    }

    buildNewUser(phone: string, firstName: string, middleName: string, lastName: string, sponsor: any) {
        let cleanUpNamePart = (namePart: string) => {
            return _.startCase(_.toLower(_.trim(namePart || '')));
        };
        let newUser: any = {
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            firstName: cleanUpNamePart(firstName),
            middleName: cleanUpNamePart(middleName),
            lastName: cleanUpNamePart(lastName),
            downlineSize: 0
        };
        phone = _.trim(phone || '');
        if (phone) {
            newUser.phone = phone;
        }
        newUser.name = this.fullName(newUser);
        newUser.profilePhotoUrl = this.generateProfilePhotoUrl(newUser);
        if (sponsor && sponsor.userId) {
            newUser.sponsor = _.pick(sponsor, ['userId', 'name', 'profilePhotoUrl']);
            newUser.sponsor.announcementTransactionConfirmed = !!sponsor.wallet &&
                !!sponsor.wallet.announcementTransaction &&
                !!sponsor.wallet.announcementTransaction.blockNumber &&
                !!sponsor.wallet.announcementTransaction.hash;
            newUser.downlineLevel = (sponsor.downlineLevel || 0) + 1;
        }
        let chars: string = "23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ";
        newUser.referralCode = _.sampleSize(chars, 6).join('');
        return newUser;
    }

    incrementDownlineSize(userInfo: any): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            let user: any;

            self.lookupUserById(userInfo.userId).then((matchedUser: any) => {
                user = matchedUser;
                if (!user) {
                    return Promise.reject(`unable to find user with userId ${user.userId}`);
                }
                return self.db.ref(`/users/${user.userId}`).update({
                    downlineSize: (user.downlineSize || 0) + 1
                });
            }).then(() => {
                return user.sponsor ? self.incrementDownlineSize(user.sponsor) : Promise.resolve();
            }).then(() => {
                resolve();
            }, (error) => {
                reject(error);
            });
        });
    }
}
