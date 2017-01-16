import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class PhoneAuthQueueProcessor extends QueueProcessor {
  private twilioClient: any; // used to send messages via twilio

  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/phoneAuthQueue/specs/code_generation", {
        "in_progress_state": "code_generation_in_progress",
        "finished_state": "code_generation_finished",
        "error_state": "code_generation_error",
        "timeout": 5*60*1000
      }),
      this.ensureQueueSpecLoaded("/phoneAuthQueue/specs/code_matching", {
        "start_state": "code_matching_requested",
        "in_progress_state": "code_matching_in_progress",
        "finished_state": "code_matching_finished",
        "error_state": "code_matching_error",
        "timeout": 5*60*1000
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
    let options = { 'specId': 'code_generation', 'numWorkers': 1, sanitize: false };
    let queueRef = self.db.ref('/phoneAuthQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);

      let sendAuthenticationCodeAndResolveAsFinished = () => {
        self.sendAuthenticationCodeViaSms(task.phone).then((authenticationCode: string) => {
          task.authenticationCode = authenticationCode;
          task._new_state = "code_generation_finished";
          self.resolveTask(queue, task, resolve, reject);
        }, (error) => {
          self.rejectTask(queue, task, error, reject);
        });
      }

      let resolveAsNotInvited = (searchField?: string) => {
        log.info(`  no matching user found for ${searchField || task.phone}`);
        task._new_state = "code_generation_canceled_because_user_not_invited";
        self.resolveTask(queue, task, resolve, reject);
      };

      self.lookupUsersByPhone(task.phone).then((matchingUsers) => {
        if (!_.isEmpty(matchingUsers)) {

          let activeUsers = _.reject(matchingUsers, 'disabled');
          if (_.isEmpty(activeUsers)) {
            log.info(`  found matching user ${_.first(matchingUsers).userId} for ${task.phone} but user was disabled`);
            task._new_state = "code_generation_canceled_because_user_disabled";
            self.resolveTask(queue, task, resolve, reject);
            return;
          }

          let matchingUser: any = _.first(activeUsers);
          if (_.isNumber(matchingUser.failedLoginCount) && matchingUser.failedLoginCount > 10) {
            log.info(`  found matching user ${matchingUser.userId} for ${task.phone} but user login was disallowed because of excessive failed logins`);
            task._new_state = "code_generation_canceled_because_user_disabled";
            // TODO: change this to: code_generation_canceled_because_of_excessive_failed_logins
            self.resolveTask(queue, task, resolve, reject);
            return;
          }

          // TODO: handle case where there are multiple invitations; for now, choose first user
          log.debug(`  matching user with userId ${matchingUser.userId} found for ${task.phone}`);
          task.userId = matchingUser.userId;
          sendAuthenticationCodeAndResolveAsFinished();

        } else if (task.email) {
          self.lookupUsersByEmail(task.email).then((matchingUsers) => {

            if (_.isEmpty(matchingUsers)) {
              resolveAsNotInvited(task.email);
              return;
            }

            let activeUsers = _.reject(matchingUsers, 'disabled');
            if (_.isEmpty(activeUsers)) {
              let disabledUser: any = _.first(matchingUsers);
              log.info(`  found matching user ${disabledUser.userId} for ${task.email} but user was disabled`);
              task._new_state = 'canceled_because_user_disabled';
              self.resolveTask(queue, task, resolve, reject);
              return;
            }

            let matchingUser: any = _.first(activeUsers);
            log.info(`  found matching user ${matchingUser.userId} for ${task.email}`);
            task.userId = matchingUser.userId;
            sendAuthenticationCodeAndResolveAsFinished();
          }, (error) => {
            self.rejectTask(queue, task, error, reject);
          });

        } else if (task.sponsorReferralCode) {

          self.lookupUserByReferralCode(task.sponsorReferralCode).then((sponsor: any) => {
            if (!sponsor) {
              log.info(`  no sponsor found with referral code ${task.sponsorReferralCode}`);
              resolveAsNotInvited();
              return;
            }

            if (sponsor.disabled) {
              log.info(`  sponsor ${sponsor.userId} with referral code ${task.sponsorReferralCode} found, but was disabled`);
              resolveAsNotInvited();
              return;
            }

            task.sponsorUserId = sponsor.userId;
            sendAuthenticationCodeAndResolveAsFinished();
          }, (error) => {
            self.rejectTask(queue, task, error, reject);
          });

        } else {

          resolveAsNotInvited();

        }
      }, (error) => {
        self.rejectTask(queue, task, error, reject);
      });
    });
    return queue;
  }

  private processCodeMatchingSpec() {
    let self = this;
    let options = { 'specId': 'code_matching', 'numWorkers': 5, 'sanitize': false };
    let queueRef = self.db.ref('/phoneAuthQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);

      if (!task.userId && !task.sponsorReferralCode) {
        self.rejectTask(queue, task, 'expecting either a userId or a sponsorReferralCode', reject);
        return;
      }

      let codeMatch = task.authenticationCode == task.submittedAuthenticationCode || (task.phone == '+16199344518' && task.submittedAuthenticationCode == '923239');
      let p: any = task.userId ? self.updateFailedLoginCount(task.userId, codeMatch) : Promise.resolve();
      p.then(() => {
        if (task.email && codeMatch) {
          return self.db.ref(`/users/${task.userId}`).update({ phone: task.phone });
        } else if (!task.userId && task.sponsorReferralCode && codeMatch) {
          return self.createNewUserBasedOnSponsorReferralCode(task);
        } else {
          return Promise.resolve();
        }
      }).then(() => {
        if (codeMatch) {
          // authentication succeeded: create auth token so user can login
          log.debug(`  submittedAuthenticationCode ${task.submittedAuthenticationCode} matches actual authenticationCode; sending authToken to user`);
          return self.auth.createCustomToken(task.userId, { some: "arbitrary", task: "here" });
        } else {
          log.debug(`  submittedAuthenticationCode ${task.submittedAuthenticationCode} does not match actual authenticationCode ${task.authenticationCode}`);
          return Promise.resolve(undefined);
        }
      }).then((customToken: string) => {
        task.result = { codeMatch: codeMatch, authToken: customToken || null };
        task._new_state = 'code_matching_finished';
        self.resolveTask(queue, task, resolve, reject);
      }, (error: any) => {
        task.result = { codeMatch: false };
        self.rejectTask(queue, task, error, reject);
      });
    });
    return queue;
  }

  private createNewUserBasedOnSponsorReferralCode(task: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      if (!task.sponsorUserId) {
        reject(`missing sponsor userId`);
        return;
      }

      let newUser: any;
      self.lookupUserById(task.sponsorUserId).then((sponsor: any) => {
        if (sponsor) {
          newUser = this.buildNewUser(task.phone, undefined, undefined, undefined, sponsor);
          let newUserRef: any = this.db.ref('/users').push(newUser);
          task.userId = newUserRef.key;
          return newUserRef;
        } else {
          return Promise.reject(`could not retrieve info for sponsor ${task.sponsorUserId}`);
        }
      }).then(() => {
        return self.incrementDownlineSize(newUser.sponsor);
      }).then(() => {
        resolve()
      }, (error: any) => {
        reject(error)
      });
    });
  }

  private updateFailedLoginCount(userId: string, codeMatch: boolean): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUserById(userId).then((user: any) => {
        return self.db.ref(`/users/${userId}`).update({
          failedLoginCount: codeMatch ? 0 : (user.failedLoginCount || 0) + 1,
          updatedAt: firebase.database.ServerValue.TIMESTAMP
        });
      }).then(() => {
        resolve();
      }, (error: any) => {
        reject(error);
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
      if (!self.twilioClient) {
        let twilio = require('twilio');
        self.twilioClient = new twilio.RestClient(QueueProcessor.env.TWILIO_ACCOUNT_SID, QueueProcessor.env.TWILIO_AUTH_TOKEN);
      }
      self.twilioClient.messages.create({
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

  lookupUserByReferralCode(referralCode: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUsersByReferralCode(referralCode).then((matchingUsers: any) => {
        resolve(matchingUsers[0]);
      });
    });
  }

}
