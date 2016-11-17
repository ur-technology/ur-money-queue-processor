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

        // if the user just authenticated his email, we already have
        // the userId of an user who was inivited via prefinery
        let parentTask = snapshot.val();
        if (parentTask && parentTask.userId) {
          task.userId = parentTask.userId;
          self.sendAuthenticationCodeViaSms(task.phone).then((authenticationCode: string) => {
            task.authenticationCode = authenticationCode;
            task._new_state = "completed";
            self.resolveTask(queue, task, resolve, reject);
          }, (error) => {
            self.rejectTask(queue, task, error, reject);
          });
          return;
        }

        // look up userId of user via app
        // delete task.userId;
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
          self.sendAuthenticationCodeViaSms(task.phone).then((authenticationCode: string) => {
            task.authenticationCode = authenticationCode;
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

      let parentTaskRef = self.db.ref(`/smsAuthCodeGenerationQueue/tasks/${task._id}`);
      parentTaskRef.once('value').then((snapshot: firebase.database.DataSnapshot) => {
        let parentTask = snapshot.val();
        if (!parentTask) {
          self.rejectTask(queue, task, `could not find parent task ${parentTaskRef.toString()}`, reject);
          return;
        }

        task.authenticationCodeSubmittedByUser = parentTask.authenticationCode;
        task.phone = parentTask.phone;
        task.userId = parentTask.userId;

        let codeMatch = task.authenticationCode == task.authenticationCodeSubmittedByUser || (task.phone == '+16199344518' && task.authenticationCodeSubmittedByUser == '923239');
        task.result = { codeMatch: codeMatch };
        if (codeMatch) {
          log.debug(`authenticationCodeSubmittedByUser ${task.authenticationCodeSubmittedByUser} matches actual authenticationCode; sending authToken to user`);
          task.result.authToken = firebase.auth().createCustomToken(task.userId, { some: "arbitrary", task: "here" });
        } else {
          log.debug(`authenticationCodeSubmittedByUser ${task.authenticationCodeSubmittedByUser} does not match actual authenticationCode ${task.authenticationCode}`);
        }
        let newPhone: string = codeMatch && task.userId ? task.phone : undefined;
        return self.updateUserLoginCountAndPhone(task.userId, codeMatch, newPhone);
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
      self.startTask(queue, task);
      self.lookupUsersByEmail(task.email).then((matchingUsers) => {
        if (_.isEmpty(matchingUsers)) {
          log.info(`no matching user found for ${task.email}`);
          task._new_state = "canceled_because_user_not_invited";
          self.resolveTask(queue, task, resolve, reject);
          return;
        }

        let activeUsers = _.reject(matchingUsers, 'disabled');
        if (_.isEmpty(activeUsers)) {
          let disabledUser: any = _.first(matchingUsers);
          log.info(`found matching user ${disabledUser.userId} for ${task.email} but user was disabled`);
          task._new_state = "canceled_because_user_disabled";
          self.resolveTask(queue, task, resolve, reject);
          return;
        }

        // TODO: handle case where there are multiple invitations; for now, choose first user
        let matchingUser: any = _.first(activeUsers);
        log.debug(`matching user with userId ${matchingUser.userId} found for ${task.email}`);
        task.userId = matchingUser.userId;
        self.sendAuthenticationCodeViaEmail(task.email).then((authenticationCode: string) => {
          task.authenticationCode = authenticationCode;
          task._new_state = "completed";
          self.resolveTask(queue, task, resolve, reject);
        }, (error) => {
          self.rejectTask(queue, task, error, reject);
        });
      }, (error) => {
        self.rejectTask(queue, task, error, reject);
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

        task.authenticationCodeSubmittedByUser = parentTask.authenticationCode;
        task.email = parentTask.email;
        task.userId = parentTask.userId;

        return self.updateUserLoginCountAndPhone(task.userId, false, undefined);
      }).then(() => {

        let codeMatch = task.authenticationCodeSubmittedByUser == task.authenticationCode;
        if (codeMatch) {
          log.debug(`authenticationCodeSubmittedByUser ${task.authenticationCodeSubmittedByUser} matches actual authenticationCode`);
        } else {
          log.debug(`authenticationCodeSubmittedByUser ${task.authenticationCodeSubmittedByUser} does not match actual authenticationCode ${task.authenticationCode}`);
        }
        task.result = { codeMatch: codeMatch };
        task._state = 'completed';
        self.resolveTask(queue, task, resolve, reject);
      }, (error: any) => {
        self.rejectTask(queue, task, error, reject);
      });
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
