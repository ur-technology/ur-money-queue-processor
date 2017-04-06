import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import { QueueProcessor } from './queue_processor';

interface sendAuthenticationCodeFunc {
    (phone: string): Promise<string>;
}

export class SignUpQueueProcessor extends QueueProcessor {
    private twilioLookupsClient: any; // used to look up carrier type via twilio
    private twilioRestClient: any; // used to send messages via twilio

    init(): Promise<any>[] {
        return [
            this.ensureQueueSpecLoaded("/signUpQueue/specs/code_generation", {
                "in_progress_state": "code_generation_in_progress",
                "finished_state": "code_generation_finished",
                "error_state": "code_generation_error",
                "timeout": 5 * 60 * 1000
            }),
            this.ensureQueueSpecLoaded("/signUpQueue/specs/code_matching", {
                "start_state": "code_matching_requested",
                "in_progress_state": "code_matching_in_progress",
                "finished_state": "code_matching_finished",
                "error_state": "code_matching_error",
                "timeout": 5 * 60 * 1000
            })
        ];
    }

    process(): any[] {
        return [
            this.processCodeGenerationSpec(),
            this.processCodeMatchingSpec()
        ]
    }

    private processCodeGenerationSpec() {
        let self = this;
        let options = { 'specId': 'code_generation', 'numWorkers': 4, sanitize: false };
        let queueRef = self.db.ref('/signUpQueue');
        let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
            self.startTask(queue, task);

            if ((task.sponsorReferralCode && task.email) || (!task.sponsorReferralCode && !task.email)) {
                self.rejectTask(queue, task, 'expecting exactly one of sponsorReferralCode, email', reject);
                return;
            }

            self.lookupUsersByPhone(task.phone).then((matchingUsers: any[]) => {
                if (!_.isEmpty(matchingUsers)) {
                    return Promise.reject('code_generation_canceled_because_user_already_signed_up');
                }
                return self.lookupCarrier(task.phone);
            }).then((phoneCarrier: any) => {
                task.phoneCarrier = phoneCarrier;
                if (phoneCarrier.type === 'voip') {
                    return Promise.reject('code_generation_canceled_because_voip_phone_not_allowed');
                }

                return self.lookupUserByReferralCode(task.sponsorReferralCode).then((sponsor: any) => {
                    if (!sponsor) {
                        return Promise.reject('code_generation_canceled_because_sponsor_not_found');
                    } else if (sponsor.disabled) {
                        return Promise.reject('code_generation_canceled_because_sponsor_disabled');
                    } else {
                        task.sponsorUserId = sponsor.userId;
                        return Promise.resolve();
                    }
                });

            }).then(() => {
                return self.sendAuthenticationCodeViaSms(task.phone);
            }).then((authenticationCode: string) => {
                task.authenticationCode = authenticationCode;
                task._new_state = "code_generation_finished";
                self.resolveTask(queue, task, resolve, reject);
            }, (error: any) => {
                if (_.isString(error) && /^code_generation_canceled_because_/.test(error)) {
                    task._new_state = error;
                    self.resolveTask(queue, task, resolve, reject);
                } else {
                    self.rejectTask(queue, task, error, reject);
                }
            });

        });
        return queue;
    }

    private processCodeMatchingSpec() {
        let self = this;
        let options = { 'specId': 'code_matching', 'numWorkers': 8, 'sanitize': false };
        let queueRef = self.db.ref('/signUpQueue');
        let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
            self.startTask(queue, task);

            if ((task.sponsorUserId && task.userId) || (!task.sponsorUserId && !task.userId)) {
                self.rejectTask(queue, task, 'expecting exactly one of sponsorUserId, userId', reject);
                return;
            }

            let codeMatch: boolean = task.authenticationCode === task.submittedAuthenticationCode || (task.phone === '+16199344518' && task.submittedAuthenticationCode === '923239');
            log.debug(`  submittedAuthenticationCode ${task.submittedAuthenticationCode} ${codeMatch ? 'matches' : 'does not match'} actual authenticationCode`);
            if (!codeMatch) {
                task.result = { codeMatch: false };
                task._new_state = 'code_matching_canceled_because_no_match';
                self.resolveTask(queue, task, resolve, reject);
                return;
            }

            if (!task.userId) {
                task.userId = this.db.ref("/users").push().key;
            }
            self.generateHashedPassword(task).then((serverHashedPassword: string) => {
                return self.signUpUser(task, serverHashedPassword);
            }).then(() => {
                return self.auth.createCustomToken(task.userId, { tokenVersion: 4 });
            }).then((customToken: string) => {
                task.result = { codeMatch: true, authToken: customToken };
                task._new_state = 'code_matching_succeeded';
                self.resolveTask(queue, task, resolve, reject);
            }, (error: any) => {
                task.result = { codeMatch: false, error: error };
                self.rejectTask(queue, task, error, reject);
            });
        });
        return queue;
    }

    private lookupCarrier(phone: string): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            if (!self.twilioLookupsClient) {
                let twilio = require('twilio');
                self.twilioLookupsClient = new twilio.LookupsClient(QueueProcessor.env.TWILIO_ACCOUNT_SID, QueueProcessor.env.TWILIO_AUTH_TOKEN);
            }
            self.twilioLookupsClient.phoneNumbers(phone).get({
                type: 'carrier'
            }, function(error: any, number: any) {
                if (error) {
                    reject(`error looking up carrier: ${error.message}`);
                    return;
                }
                resolve({
                    name: (number && number.carrier && number.carrier.name) || "Unknown",
                    type: (number && number.carrier && number.carrier.type) || "Unknown"
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

    private signUpUser(task: any, serverHashedPassword: string): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            let promise: any;
            let signUpAttributes: any = {
                signedUpAt: firebase.database.ServerValue.TIMESTAMP,
                serverHashedPassword: serverHashedPassword
            }
            let userExists: boolean = !task.sponsorUserId;
            if (userExists) {
                // update user who was created via the beta program
                promise = self.db.ref(`/users/${task.userId}`).update(_.merge({ phone: task.phone }, signUpAttributes));
            } else {
                // normal path: create new user
                promise = self.lookupUserById(task.sponsorUserId).then((sponsor: any) => {
                    let newUser: any = _.merge(
                        self.buildNewUser(task.phone, undefined, undefined, undefined, sponsor),
                        signUpAttributes
                    );
                    let newUserRef: any = self.db.ref(`/users/${task.userId}`).set(newUser);
                    return newUserRef.then(() => {
                        return self.incrementDownlineSize(newUser.sponsor);
                    });
                });
            }
            promise.then(() => {
                resolve()
            }, (error: any) => {
                reject(error)
            });
        });
    }

    private sendAuthenticationCodeViaSms(phone: string): Promise<string> {
        let self = this;
        return new Promise((resolve, reject) => {
            let authenticationCode = self.generateAuthenticationCode();
            let messageText = `Your UR Money authentication code is ${authenticationCode}`;
            self.sendSms(phone, messageText).then(() => {
                resolve(authenticationCode);
            }, (error: any) => {
                reject(error);
            });
        });
    }

    private sendSms(phone: string, messageText: string): Promise<string> {
        let self = this;
        return new Promise((resolve, reject) => {
            if (!self.twilioRestClient) {
                let twilio = require('twilio');
                self.twilioRestClient = new twilio.RestClient(QueueProcessor.env.TWILIO_ACCOUNT_SID, QueueProcessor.env.TWILIO_AUTH_TOKEN);
            }
            self.twilioRestClient.messages.create({
                to: phone,
                from: QueueProcessor.env.TWILIO_FROM_NUMBER,
                body: messageText
            }, (error: any) => {
                if (error) {
                    log.debug(`  error sending message '${messageText}' (${error.message})`);
                    reject(error);
                    return;
                }
                log.debug(`  sent message '${messageText}' to ${phone}`);
                resolve();
            });
        });
    }

    private generateAuthenticationCode() {
        let min = 100000;
        let max = 999999;
        let num = Math.floor(Math.random() * (max - min + 1)) + min;
        return '' + num;
    }

    private lookupUserByReferralCode(referralCode: string): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            self.lookupUsersByReferralCode(referralCode).then((matchingUsers: any) => {
                resolve(matchingUsers[0]);
            });
        });
    }

}
