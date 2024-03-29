import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import { QueueProcessor } from './queue_processor';

// This should be kept in sync with the UR Money app's UserModel!
enum UserStates {
    NoSponsor = 0,
    Disabled,
    FraudSuspected,
    BonusReceived,
    InvalidBonus,
    WaitingForBonus,
    MissingID,
    AwaitingReview,
    MissingWallet,
}

export class UserQueueProcessor extends QueueProcessor {
    init(): Promise<any>[] {
        return [
            this.ensureQueueSpecLoaded("/userQueue/specs/user_password_change", {
                "start_state": "user_password_change_requested",
                "in_progress_state": "user_password_change_in_progress",
                "finished_state": "user_password_change_finished",
                "error_state": "user_password_change_error",
                "timeout": 5 * 60 * 1000
            }),
            this.ensureQueueSpecLoaded("/userQueue/specs/user_check_password", {
                "start_state": "user_check_password_requested",
                "in_progress_state": "user_check_password_in_progress",
                "finished_state": "user_check_password_finished",
                "error_state": "user_check_password_error",
                "timeout": 5 * 60 * 1000
            }),
            this.ensureQueueSpecLoaded("/userQueue/specs/user_referrals", {
                "start_state": "user_referrals_requested",
                "in_progress_state": "user_referrals_in_progress",
                "finished_state": "user_referrals_finished",
                "error_state": "user_referrals_error",
                "timeout": 5 * 60 * 1000
            }),
            this.ensureQueueSpecLoaded("/userQueue/specs/search_recipients_wallets", {
                "start_state": "search_recipients_wallets_requested",
                "in_progress_state": "search_recipients_wallets_in_progress",
                "finished_state": "search_recipients_wallets_finished",
                "error_state": "search_recipients_wallets_error",
                "timeout": 5 * 60 * 1000
            })
        ];
    }

    process(): any[] {
        return [
            this.processChangePasswordQueue(), this.processCheckPassword(), this.processUserReferrals(), this.processSearchRecipientsWithWallets()
        ];
    }

    private processChangePasswordQueue() {
        let self = this;
        let queueRef = self.db.ref("/userQueue");
        let options = { 'specId': 'user_password_change', 'numWorkers': 3, 'sanitize': false };
        let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
            self.startTask(queue, task);
            if (!task.clientHashedPassword) {
                self.rejectTask(queue, task, 'expecting clientHashedPassword', reject);
                return;
            }

            self.generateHashedPassword(task).then((serverHashedPassword) => {
                self.db.ref(`/users/${task.userId}`).update({ serverHashedPassword: serverHashedPassword });
                task.result = { state: 'user_password_change_succeeded' };
                self.resolveTask(queue, task, resolve, reject);
            });

        });
        return queue;
    }

    private processCheckPassword() {
        let self = this;
        let options = { specId: 'user_check_password', numWorkers: 5, sanitize: false };
        let queueRef = self.db.ref('/userQueue');
        let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {

            self.startTask(queue, task);

            if (!task.clientHashedPassword) {
                self.rejectTask(queue, task, 'expecting clientHashedPassword', reject);
                return;
            }

            let user: any;
            self.lookupUserById(task.userId).then((matchedUser: any[]) => {
                user = matchedUser;
                if (!user) {
                    task.result = { state: 'user_check_password_canceled_because_user_not_found' };
                    self.resolveTask(queue, task, resolve, reject);
                }
                return self.generateHashedPassword(task);
            }).then((hashedPassword: string) => {
                if (user.serverHashedPassword !== hashedPassword) {
                    task.result = { state: 'user_check_password_canceled_because_wrong_password' };
                    self.resolveTask(queue, task, resolve, reject);
                }

                task.result = { state: 'user_check_password_succeded' };
                self.resolveTask(queue, task, resolve, reject);
            });

        });
    }

    processUserReferrals() {
        let self = this;
        let options = { specId: 'user_referrals', numWorkers: 5, sanitize: false };
        let queueRef = self.db.ref('/userQueue');
        let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
            // var startDate = new Date();
            self.startTask(queue, task);
            if (!task.userId) {
                self.rejectTask(queue, task, 'expecting userId', reject);
                return;
            }

            self.db.ref('/users')
                .orderByChild('sponsor/userId')
                .equalTo(task.userIdToLook)
                .once('value').then((snapshot: any) => {
                    let referrals = snapshot.val();
                    let result: any = {};

                    _.each(referrals, (referral, referralUserId) => {
                        let objeto: any = _.pick(referral, ['name', 'profilePhotoUrl', 'email', 'downlineSize', 'phone', 'countryCode']);
                        objeto.userId = referralUserId;
                        if (task.searchText && task.searchText.length > 0) {
                            if (objeto.name && String(objeto.name).toUpperCase().includes(task.searchText.toUpperCase())) {
                                result[referralUserId] = objeto;
                            } else if (objeto.email && String(objeto.email).toUpperCase().includes(task.searchText.toUpperCase())) {
                                result[referralUserId] = objeto;
                            } else if (objeto.phone && String(objeto.phone).toUpperCase().includes(task.searchText.toUpperCase())) {
                                result[referralUserId] = objeto;
                            }
                        } else {
                            result[referralUserId] = objeto;
                        }

                        if (result[referralUserId]) {
                            result[referralUserId].state = this.userState(referral);
                        }
                    });
                    let numOfItemsToReturn = task.numOfItemsToReturn;
                    result = _.sortBy(result, (r: any) => { return 1000000 - (r.downlineSize || 0); });
                    let size = _.size(result);
                    let startAt = task.startAt ? task.startAt : 0;
                    result = result.slice(startAt, startAt + numOfItemsToReturn);
                    let endOfResults = (startAt + numOfItemsToReturn) > size;

                    if (_.size(result) > 0) {
                        task.result = { state: 'user_referrals_succeeded', referrals: result, endOfResults: endOfResults };
                    } else {
                        task.result = { state: 'user_referrals_canceled_because_no_referrals', endOfResults: endOfResults };
                    }
                    // var endDate = new Date();
                    // var seconds = (endDate.getTime() - startDate.getTime()) / 1000;
                    // console.log('seconds', seconds)
                    self.resolveTask(queue, task, resolve, reject);
                });
        });
    }

    private userState(user: any): number {

        if (!user.sponsor) {
            return UserStates.NoSponsor;
        }

        if (user.disabled) {
            return UserStates.Disabled
        }

        if (user.fraudSuspected) {
            return UserStates.FraudSuspected
        }

        if (user.wallet &&
            user.wallet.announcementTransaction &&
            user.wallet.announcementTransaction.hash &&
            user.wallet.announcementTransaction.blockNumber &&
            user.signUpBonusApproved) {
            return UserStates.BonusReceived;
        }

        if (user.wallet &&
            user.wallet.announcementTransaction &&
            user.wallet.announcementTransaction.hash &&
            user.wallet.announcementTransaction.blockNumber) {
            return UserStates.InvalidBonus;
        }

        if (user.wallet &&
            user.wallet.announcementTransaction &&
            user.wallet.announcementTransaction.hash) {
            return UserStates.WaitingForBonus;
        }

        if (!user.signUpBonusApproved &&
            !(user.idUploaded && user.selfieMatched)) {
            return UserStates.MissingID;
        }

        if (!user.signUpBonusApproved) {
            return UserStates.AwaitingReview;
        }

        if (!(user.wallet && user.wallet.address)) {
            return UserStates.MissingWallet;
        }

        return -1;
    }


    processSearchRecipientsWithWallets() {
        let self = this;
        let options = { specId: 'search_recipients_wallets', numWorkers: 5, sanitize: false };
        let queueRef = self.db.ref('/userQueue');
        let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
            self.startTask(queue, task);

            if (!task.userId) {
                self.rejectTask(queue, task, 'expecting userId', reject);
                return;
            }

            let dataToReturn: any[] = [];
            self.lookupUsersByPhone(task.searchText).then((results) => {
                if (results && results.length > 0) {
                    dataToReturn = _.map(results, user => {
                        let userToReturn: any = _.pick(user, ['name', 'profilePhotoUrl', 'userId', 'countryCode']);
                        if (user.wallet && user.wallet.address) {
                            userToReturn.walletAddress = user.wallet.address;
                            return userToReturn;
                        }
                    });
                }

            }).then(() => {
                self.lookupUsersByEmail(task.searchText).then((results) => {
                    if (results && results.length > 0) {
                        dataToReturn = _.map(results, user => {
                            let userToReturn: any = _.pick(user, ['name', 'profilePhotoUrl', 'userId', 'countryCode']);
                            if (user.wallet && user.wallet.address) {
                                userToReturn.walletAddress = user.wallet.address;
                                return userToReturn;
                            }
                        });
                    }

                    dataToReturn = _.compact(dataToReturn);
                    if (!_.isEmpty(dataToReturn)) {
                        task.result = { state: 'search_recipients_wallets_succeeded', data: dataToReturn }
                    } else {
                        task.result = { state: 'search_recipients_wallets_canceled_because_no_results' }
                    }

                    self.resolveTask(queue, task, resolve, reject);
                });
            });
        });
    }


    private generateHashedPassword(task: any): Promise<string> {
        return new Promise((resolve, reject) => {
            let scryptAsync = require('scrypt-async');
            scryptAsync(task.clientHashedPassword, task.userId, { N: 16384, r: 16, p: 1, dkLen: 64, encoding: 'hex' }, (serverHashedPassword: string) => {
                resolve(serverHashedPassword);
            });
        });
    }
}
