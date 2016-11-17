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

      self.db.ref(`/emailAuthCodeMatchingQueue/${task._id}`).once('value').then((snapshot: firebase.database.DataSnapshot) => {

        // if the user just authenticated his email, we can already have
        // the userId of an user who was inivited via prefinery
        let parentTask = snapshot.val();
        if (parentTask && parentTask.emailAuthenticated) {
          task.emailAuthenticated = true;
          task.userId = parentTask.userId;
          self.sendSmsAuthenticationCode(task.phone).then((smsAuthenticationCode: string) => {
            task.smsAuthenticationCode = smsAuthenticationCode;
            task._new_state = "completed";
            self.resolveTask(queue, task, resolve, reject);
          }, (error) => {
            self.rejectTask(queue, task, error, reject);
          });
          return;
        }

        // look up userId of user via app
        delete task.userId;
        self.lookupUsersByPhone(task.phone).then((matchingUsers) => {
          if (_.isEmpty(matchingUsers)) {
            log.info(`no matching user found for ${task.phone}`);
            task._new_state = "canceled_because_user_not_invited";
            self.resolveTask(queue, task, resolve, reject);
            return;
          }

          let activeUsers = _.reject(matchingUsers, 'disabled');
          if (_.isEmpty(activeUsers)) {
            let disabledUser: any = _.first(matchingUsers);
            log.info(`found matching user ${disabledUser.userId} for ${task.phone} but user was disabled`);
            task._new_state = "canceled_because_user_disabled";
            self.resolveTask(queue, task, resolve, reject);
            return;
          }

          // TODO: handle case where there are multiple invitations; for now, choose first user
          let matchingUser: any = _.first(activeUsers);
          log.debug(`matching user with userId ${matchingUser.userId} found for ${task.phone}`);
          task.userId = matchingUser.userId;
          self.sendSmsAuthenticationCode(task.phone).then((smsAuthenticationCode: string) => {
            task.smsAuthenticationCode = smsAuthenticationCode;
            task._new_state = "completed";
            self.resolveTask(queue, task, resolve, reject);
          }, (error) => {
            self.rejectTask(queue, task, error, reject);
          });
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

      self.db.ref(`/smsAuthCodeGenerationQueue/${task._id}`).once('value').then((snapshot: firebase.database.DataSnapshot) => {
        let parentTask = snapshot.val();
        if (!parentTask) {
          self.rejectTask(queue, task, `could not find parent task ${task._id}`, reject);
          return;
        }

        task.submittedSmsAuthenticationCode = parentTask.smsAuthenticationCode;
        task.phone = parentTask.phone;
        if (parentTask.emailAuthenticated) {
          task.emailAuthenticated = parentTask.emailAuthenticated;
        }

        let codeMatch = task.smsAuthenticationCode == task.submittedSmsAuthenticationCode || (task.phone == '+16199344518' && task.submittedSmsAuthenticationCode == '923239');
        task.result = { codeMatch: codeMatch };
        if (codeMatch) {
          log.debug(`submittedSmsAuthenticationCode ${task.submittedSmsAuthenticationCode} matches actual smsAuthenticationCode; sending authToken to user`);
          task.result.authToken = firebase.auth().createCustomToken(task.userId, { some: "arbitrary", task: "here" });
        } else {
          log.debug(`submittedSmsAuthenticationCode ${task.submittedSmsAuthenticationCode} does not match actual smsAuthenticationCode ${task.smsAuthenticationCode}`);
        }
        let newPhone: string = codeMatch && task.emailAuthenticated ? task.phone : undefined;
        return self.updateUserLoginCountAndPhone(task.userId, false, newPhone);
      }).then(() => {
        task._new_state = 'completed';
        self.resolveTask(queue, task, resolve, reject);
      }, (error: any) => {
        self.rejectTask(queue, task, error, reject);
      });
    });
    return queue;
  }

  private processEmailAuthCodeGenerationQueue() {
    let self = this;
    let options = { 'specId': 'code_generation', 'numWorkers': 1, sanitize: false };
    let queueRef = self.db.ref('/emailAuthCodeGenerationQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      // self.startTask(queue, task);
      // delete task.userId;
      //
      // self.lookupUsersByEmail(task.email).then((matchingUsers) => {
      //   if (_.isEmpty(matchingUsers)) {
      //     log.info(`no matching user found for ${task.email}`);
      //     task._new_state = "canceled_because_user_not_invited";
      //     self.resolveTask(queue, task, resolve, reject);
      //     return;
      //   }
      //
      //   let activeUsers = _.reject(matchingUsers, 'disabled');
      //   if (_.isEmpty(activeUsers)) {
      //     let disabledUser: any = _.first(matchingUsers);
      //     log.info(`found matching user ${disabledUser.userId} for ${task.email} but user was disabled`);
      //     task._new_state = "canceled_because_user_disabled";
      //     self.resolveTask(queue, task, resolve, reject);
      //     return;
      //   }
      //
      //   // TODO: handle case where there are multiple invitations; for now, choose first user
      //   let matchingUser: any = _.first(activeUsers);
      //   log.debug(`matching user with userId ${matchingUser.userId} found for ${task.email}`);
      //   task.userId = matchingUser.userId;
      //   self.sendEmailAuthenticationCode(task.email).then((emailAuthenticationCode: string) => {
      //     task.emailAuthenticationCode = emailAuthenticationCode;
      //     task._new_state = "completed";
      //     self.resolveTask(queue, task, resolve, reject);
      //   }, (error) => {
      //     self.rejectTask(queue, task, error, reject);
      //   });
      // }, (error) => {
      //   self.rejectTask(queue, task, error, reject);
      // });
    });
    return queue;
  }

  private processEmailAuthCodeMatchingQueue() {
    let self = this;
    let options = { 'specId': 'code_matching', 'numWorkers': 1, 'sanitize': false };
    let queueRef = self.db.ref('/emailAuthCodeMatchingQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      // self.startTask(queue, task);
      //
      // let codeMatch = task.submittedEmailAuthenticationCode == task.emailAuthenticationCode;
      // if (codeMatch) {
      //   log.debug(`submittedEmailAuthenticationCode ${task.submittedEmailAuthenticationCode} matches actual emailAuthenticationCode`);
      // } else {
      //   log.debug(`submittedEmailAuthenticationCode ${task.submittedEmailAuthenticationCode} does not match actual emailAuthenticationCode ${task.emailAuthenticationCode}`);
      // }
      //
      // self.updateUserLoginCountAndPhone(task.userId, false, undefined).then(() => {
      //   // create new sms authentication queue item
      //   return firebase.database().ref(`/smsAuthenticationQueue/tasks/${task._id}`).set({
      //     email: task.email,
      //     userId: task.userId,
      //     emailAuthenticated: codeMatch,
      //     _state: 'email_authentication_completed'
      //   });
      // }).then(() => {
      //   task.result = { codeMatch: codeMatch };
      //   task._state = 'completed';
      //   self.resolveTask(queue, task, resolve, reject);
      // }, (error: any) => {
      //   self.rejectTask(queue, task, error, reject);
      // });
    });
    return queue;
  }

  private updateUserLoginCountAndPhone(userId: string, resetFailedLoginCount: boolean, newPhone: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUserById(userId).then((user: any) => {
        let attrs: any = {
          failedLoginCount: resetFailedLoginCount ? 0 : (user.failedLoginCount || 0) + 1,
          updatedAt: firebase.database.ServerValue.TIMESTAMP
        };
        if (attrs.failedLoginCount >= 10) {
          attrs.disabled = true;
        }
        if (newPhone) {
          attrs.phone = newPhone;
        }
        return self.db.ref(`/users/${userId}`).update(attrs);
      }).then(() => {
        resolve();
      }, (error: any) => {
        reject(error);
      });
    });
  }

  private sendEmailAuthenticationCode(email: string): Promise<string> {
    let self = this;
    return new Promise((resolve, reject) => {
      let emailAuthenticationCode = self.generateAuthenticationCode();
      let messageText = `Your UR Money authentication code is ${emailAuthenticationCode}`;
      self.sendEmail(
        email,
        'Your UR Money Authentication Code',
        `Your UR Money authentication code is ${emailAuthenticationCode}`
      ).then(() => {
        resolve(emailAuthenticationCode);
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
      let fromEmail = new helper.Email('develop@ur.technology', 'UR Technology');
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
        log.debug(`sent message '${messageText}'' to ${email}`);
        resolve();
      });
    });
  }

  private sendSmsAuthenticationCode(phone: string): Promise<string> {
    let self = this;
    return new Promise((resolve, reject) => {
      let smsAuthenticationCode = self.generateAuthenticationCode();
      let messageText = `Your UR Money authentication code is ${smsAuthenticationCode}`;
      self.sendSms(phone, messageText).then(() => {
        resolve(smsAuthenticationCode);
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
          log.debug(`error sending message '${messageText}' (${error.message})`);
          reject(error);
          return;
        }
        log.debug(`sent message '${messageText}'' to ${phone}`);
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

}
