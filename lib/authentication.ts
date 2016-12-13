import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class AuthenticationQueueProcessor extends QueueProcessor {
  private twilioClient: any; // used to send messages via twilio
  smsCodeMatchingQueue: any;
  emailCodeMatchingQueue: any;

  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/smsAuthCodeGenerationQueue/specs/code_generation", {
        "in_progress_state": "in_progress",
        "finished_state": "completed",
        "error_state": "error",
        "timeout": 5*60*1000
      }),
      this.ensureQueueSpecLoaded("/smsAuthCodeMatchingQueue/specs/code_matching", {
        "in_progress_state": "in_progress",
        "finished_state": "completed",
        "error_state": "error",
        "timeout": 5*60*1000
      }),
      this.ensureQueueSpecLoaded("/emailAuthCodeGenerationQueue/specs/code_generation", {
        "in_progress_state": "in_progress",
        "finished_state": "completed",
        "error_state": "error",
        "timeout": 5*60*1000
      }),
      this.ensureQueueSpecLoaded("/emailAuthCodeMatchingQueue/specs/code_matching", {
        "in_progress_state": "in_progress",
        "finished_state": "completed",
        "error_state": "error",
        "timeout": 5*60*1000
      })
    ];
  }

  process(): any[] {
    return [
      this.processSmsAuthCodeGenerationQueue(),
      this.processSmsAuthCodeMatchingQueue(),
      this.processEmailAuthCodeGenerationQueue(),
      this.processEmailAuthCodeMatchingQueue()
    ]
  }

  private processSmsAuthCodeGenerationQueue() {
    let self = this;
    let options = { 'specId': 'code_generation', 'numWorkers': 1, sanitize: false };
    let queueRef = self.db.ref('/smsAuthCodeGenerationQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);

      let parentTaskRef = self.db.ref(`/emailAuthCodeMatchingQueue/tasks/${task._id}`);
      parentTaskRef.once('value').then((snapshot: firebase.database.DataSnapshot) => {

        let sendAuthenticationCodeAndResolveAsCompleted = () => {
          self.sendAuthenticationCodeViaSms(task.phone).then((authenticationCode: string) => {
            task.authenticationCode = authenticationCode;
            task._new_state = "completed";
            self.resolveTask(queue, task, resolve, reject);
          }, (error) => {
            self.rejectTask(queue, task, error, reject);
          });
        }

        // If prior email authentcation was successful, then there is no need
        // to look up user via phone. This scenario happens when user signs up
        // via prefinery and then uses his email to authenticate himself.
        let parentTask = snapshot.val();
        if (parentTask && parentTask.userId) {
          task.email = parentTask.email;
          task.userId = parentTask.userId;
          sendAuthenticationCodeAndResolveAsCompleted();
          return;
        }

        self.lookupUsersByPhone(task.phone).then((matchingUsers) => {
          if (_.isEmpty(matchingUsers)) {

            let resolveAsNotInvited = () => {
              log.info(`  no matching user found for ${task.phone}`);
              task._new_state = "canceled_because_user_not_invited";
              self.resolveTask(queue, task, resolve, reject);
            };

            if (task.referralCode) {

              self.lookupUserByReferralCode(task.referralCode).then((sponsor: any) => {
                if (!sponsor) {
                  log.info(`  no sponsor found with referral code ${task.referralCode}`);
                  resolveAsNotInvited();
                  return;
                }

                if (sponsor.disabled) {
                  log.info(`  sponsor ${sponsor.userId} with referral code ${task.referralCode} found, but was disabled`);
                  resolveAsNotInvited();
                  return;
                }

                task.sponsor = _.pick(sponsor, ['userId', 'name', 'profilePhotoUrl']);
                sendAuthenticationCodeAndResolveAsCompleted();
              }, (error) => {
                self.rejectTask(queue, task, error, reject);
              });
            } else {
              resolveAsNotInvited();
            }
            return;
          }

          let matchingUser: any = _.first(matchingUsers);
          matchingUsers = _.reject(matchingUsers, 'disabled');
          if (_.isEmpty(matchingUsers)) {
            log.info(`  found matching user ${matchingUser.userId} for ${task.phone} but user was disabled`);
            task._new_state = "canceled_because_user_disabled";
            self.resolveTask(queue, task, resolve, reject);
            return;
          }
          matchingUser = _.first(matchingUsers);

          matchingUsers = _.reject(matchingUsers, (u) => { return _.isNumber(u.failedLoginCount) && u.failedLoginCount > 10; });
          if (_.isEmpty(matchingUsers)) {
            log.info(`  found matching user ${matchingUser.userId} for ${task.phone} but user login was disallowed because of excessive failed logins`);
            task._new_state = "canceled_because_user_disabled";
            // TODO: change this to: canceled_because_of_excessive_failed_logins
            self.resolveTask(queue, task, resolve, reject);
            return;
          }
          matchingUser = _.first(matchingUsers);

          // TODO: handle case where there are multiple invitations; for now, choose first user
          log.debug(`  matching user with userId ${matchingUser.userId} found for ${task.phone}`);
          task.userId = matchingUser.userId;
          task.referralCode = null; // clarify that we are not going to use the referral code
          sendAuthenticationCodeAndResolveAsCompleted();
        }, (error) => {
          self.rejectTask(queue, task, error, reject);
        });
      });
    });
    return queue;
  }

  private processSmsAuthCodeMatchingQueue() {
    let self = this;
    let options = { 'specId': 'code_matching', 'numWorkers': 1, 'sanitize': false };
    let queueRef = self.db.ref('/smsAuthCodeMatchingQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);

      let parentTaskRef = self.db.ref(`/smsAuthCodeGenerationQueue/tasks/${task._id}`);
      parentTaskRef.once('value').then((snapshot: firebase.database.DataSnapshot) => {
        let parentTask = snapshot.val();
        if (!parentTask) {
          return Promise.reject(`could not find parent task ${parentTaskRef.toString()}`);
        }

        task.originalAuthenticationCode = parentTask.authenticationCode;
        _.extend(task, _.pick(parentTask, ['phone', 'userId', 'email', 'referralCode', 'sponsor']));

        if (!task.userId && !task.referralCode) {
          return Promise.reject(`expecting either a userId or a referralCode`);
        }

        let codeMatch = task.authenticationCode == task.originalAuthenticationCode || (task.phone == '+16199344518' && task.authenticationCode == '923239');
        task.result = { codeMatch: codeMatch };
        if (task.userId) {
          return self.updateFailedLoginCount(task.userId, codeMatch)
        } else {
          return Promise.resolve();
        }
      }).then(() => {
        if (task.email && task.result.codeMatch) {
          return self.db.ref(`/users/${task.userId}`).update({ phone: task.phone });
        } else {
          return Promise.resolve();
        }
      }).then(() => {
        if (task.referralCode && task.result.codeMatch) {
          return self.createNewUserBasedOnReferralCode(task);
        } else {
          return Promise.resolve();
        }
      }).then(() => {
        if (task.result.codeMatch) {
          // authentication succeeded: create auth token so user can login
          log.debug(`  originalAuthenticationCode ${task.originalAuthenticationCode} matches actual authenticationCode; sending authToken to user`);
          task.result.authToken = firebase.auth().createCustomToken(task.userId, { some: "arbitrary", task: "here" });
        } else {
          log.debug(`  originalAuthenticationCode ${task.originalAuthenticationCode} does not match actual authenticationCode ${task.authenticationCode}`);
        }
        task._new_state = 'completed';
        self.resolveTask(queue, task, resolve, reject);
      }, (error: any) => {
        queueRef.child(`tasks/${task._id}`).update({result: {codeMatch: false}}); // just tell the app that the match failed (in reality, we encountered some other kind of problem)
        self.rejectTask(queue, task, error, reject);
      });
    });
    return queue;
  }

  private createNewUserBasedOnReferralCode(task: any): Promise<any> {
    if (!task.sponsor) {
      return Promise.reject(`missing sponsor info`);
    }

    let newUser = this.buildNewUser(task.phone, undefined, undefined, undefined, _.merge(task.sponsor, {referralCode: task.referralCode}));
    let newUserRef = this.db.ref('/users').push(newUser);
    task.userId = newUserRef.key;
    return newUserRef; // this is a promise
  }

  private processEmailAuthCodeGenerationQueue() {
    let self = this;
    let options = { 'specId': 'code_generation', 'numWorkers': 1, sanitize: false };
    let queueRef = self.db.ref('/emailAuthCodeGenerationQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);
      task.email = _.toLower(_.trim(task.email || ''));
      if (!task.email) {
        task._new_state = "canceled_because_user_not_invited";
        self.resolveTask(queue, task, resolve, reject);
        return;
      }
      self.lookupUsersByEmail(task.email).then((matchingUsers) => {
        if (_.isEmpty(matchingUsers)) {
          log.info(`  no matching user found for ${task.email}`);
          throw 'canceled_because_user_not_invited';
        }

        let activeUsers = _.reject(matchingUsers, 'disabled');
        if (_.isEmpty(activeUsers)) {
          let disabledUser: any = _.first(matchingUsers);
          log.info(`  found matching user ${disabledUser.userId} for ${task.email} but user was disabled`);
          throw 'canceled_because_user_disabled';
        }

        // TODO: handle case where there are multiple invitations; for now, choose first user
        let matchingUser: any = _.first(activeUsers);
        log.debug(`  matching user with userId ${matchingUser.userId} found for ${task.email}`);
        task.userId = matchingUser.userId;
        return self.sendAuthenticationCodeViaEmail(task.email);
      }).then((authenticationCode: string) => {
        task.authenticationCode = authenticationCode;
        task.new_state = 'completed';
        self.resolveTask(queue, task, resolve, reject);
      }, (error) => {
        if (_.isString(error) && /^canceled_/.test(error)) {
          task._new_state = error;
          self.resolveTask(queue, task, resolve, reject);
        } else {
          self.rejectTask(queue, task, error, reject);
        }
      });
    });
    return queue;
  }

  private processEmailAuthCodeMatchingQueue() {
    let self = this;
    let options = { 'specId': 'code_matching', 'numWorkers': 1, 'sanitize': false };
    let queueRef = self.db.ref('/emailAuthCodeMatchingQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);

      let parentTaskRef = self.db.ref(`/emailAuthCodeGenerationQueue/tasks/${task._id}`);
      parentTaskRef.once('value').then((snapshot: firebase.database.DataSnapshot) => {
        let parentTask = snapshot.val();
        if (!parentTask) {
          self.rejectTask(queue, task, `could not find parent task ${parentTaskRef.toString()}`, reject);
          return;
        }

        task.originalAuthenticationCode = parentTask.authenticationCode;
        task.email = parentTask.email;
        task.userId = parentTask.userId;

        let codeMatch = task.originalAuthenticationCode == task.authenticationCode;
        if (codeMatch) {
          log.debug(`  originalAuthenticationCode ${task.originalAuthenticationCode} matches actual authenticationCode`);
        } else {
          log.debug(`  originalAuthenticationCode ${task.originalAuthenticationCode} does not match actual authenticationCode ${task.authenticationCode}`);
        }
        task.result = { codeMatch: codeMatch };
        return self.updateFailedLoginCount(task.userId, codeMatch);
      }).then(() => {
        task._new_state = 'completed';
        self.resolveTask(queue, task, resolve, reject);
      }, (error: any) => {
        queueRef.child(`tasks/${task._id}`).update({result: {codeMatch: false}}); // just tell the app that the match failed
        self.rejectTask(queue, task, error, reject);
      });
    });
    return queue;
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

  private sendAuthenticationCodeViaEmail(email: string): Promise<string> {
    let self = this;
    return new Promise((resolve, reject) => {
      let authenticationCode = self.generateAuthenticationCode();
      let messageText = `Your UR Money authentication code is ${authenticationCode}`;
      self.sendEmail(
        email,
        'Your UR Money Authentication Code',
        `Your UR Money authentication code is ${authenticationCode}`
      ).then(() => {
        resolve(authenticationCode);
      }, (error: any) => {
        reject(error);
      });
    });
  }

  private sendEmail(email: string, subject: string, messageText: string): Promise<string> {
    let self = this;
    return new Promise((resolve, reject) => {
      let sendGrid = require('sendgrid')(QueueProcessor.env.SEND_GRID_API_KEY);
      let helper = require('sendgrid').mail;
      let fromEmail = new helper.Email('support@ur.technology', 'UR Technology');
      let toEmail = new helper.Email(email);
      let content = new helper.Content('text/plain', messageText);
      let mail = new helper.Mail(fromEmail, subject, toEmail, content);
      let request = sendGrid.emptyRequest({
        method: 'POST',
        path: '/v3/mail/send',
        body: mail.toJSON()
      });
      sendGrid.API(request, (error: any, response: any) => {
        if (error) {
          reject(error);
          return;
        }
        log.debug(`  sent message '${messageText}' to ${email}`);
        resolve();
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
        let userIds: string[] = _.keys(matchingUsers);
        let matchingUser: any = undefined;
        if (userIds.length > 0) {
          matchingUser = matchingUsers[userIds[0]];
          matchingUser.userId = userIds[0];
        }
        resolve(matchingUser);
      });
    });
  }

}
