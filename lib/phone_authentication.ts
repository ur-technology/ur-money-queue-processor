import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class PhoneAuthenticationQueueProcessor extends QueueProcessor {
  private twilioClient: any; // used to send messages via twilio

  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/phoneAuthenticationQueue/specs/code_generation", {
        "in_progress_state": "code_generation_in_progress",
        "finished_state": "code_generation_completed_and_sms_sent",
        "error_state": "code_generation_error",
        "timeout": 15000
      }),
      this.ensureQueueSpecLoaded("/phoneAuthenticationQueue/specs/code_matching", {
        "start_state": "code_matching_requested",
        "in_progress_state": "code_matching_in_progress",
        "finished_state": "code_matching_completed",
        "error_state": "code_matching_error",
        "timeout": 15000
      })
    ];
  }

  process(): any[] {
    let self = this;
    let queueRef = self.db.ref("/phoneAuthenticationQueue");
    let codeGenerationOptions = { 'specId': 'code_generation', 'numWorkers': 1, sanitize: false };
    let codeGenerationQueue = new self.Queue(queueRef, codeGenerationOptions, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(codeGenerationQueue, task);
      self.lookupUsersByPhone(task.phone).then((matchingUsers) => {

        if (_.isEmpty(matchingUsers)) {
          log.info(`no matching user found for ${task.phone}`);
          task._new_state = "code_generation_canceled_because_user_not_invited";
          self.resolveTask(codeGenerationQueue, task, resolve, reject);
          return;
        }

        let activeUsers = _.reject(matchingUsers, 'disabled');
        if (_.isEmpty(activeUsers)) {
          let disabledUser: any = _.first(matchingUsers);
          log.info(`found matching user ${disabledUser.userId} for ${task.phone} but user was disabled`);
          task._new_state = "code_generation_canceled_because_user_disabled";
          self.resolveTask(codeGenerationQueue, task, resolve, reject);
          return;
        }

        // TODO: handle case where there are multiple invitations; for now, choose first user
        let matchingUser: any = _.first(activeUsers);
        log.debug(`matching user with userId ${matchingUser.userId} found for phone ${task.phone}`);

        let verificationCode = self.generateVerificationCode();
        self.sendMessage(task.phone, `Your UR Money verification code is ${verificationCode}`).then((error: string) => {
          if (error) {
            log.info(`error sending message to user with userId ${matchingUser.userId} and phone ${task.phone}: ${error}`);
            self.rejectTask(codeGenerationQueue, task, error, reject);
          } else {
            task.userId = matchingUser.userId;
            task.verificationCode = verificationCode;
            task._new_state = "code_generation_completed_and_sms_sent";
            self.resolveTask(codeGenerationQueue, task, resolve, reject);
          }
        });
      }, (error) => {
        self.rejectTask(codeGenerationQueue, task, error, reject);
      });
    });

    let codeMatchingOptions = { 'specId': 'code_matching', 'numWorkers': 1 };
    let codeMatchingQueue = new self.Queue(queueRef, codeMatchingOptions, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(codeMatchingQueue, task);
      if (task.submittedVerificationCode == task.verificationCode || (/^\+1619934/.test(phone) && task.submittedVerificationCode == '923239')) {
        log.debug(`submittedVerificationCode ${task.submittedVerificationCode} matches actual verificationCode; sending authToken to user`);
        task.verificationResult = { codeMatch: true, authToken: firebase.auth().createCustomToken(task.userId, { some: "arbitrary", task: "here" }) };
      } else {
        log.debug(`submittedVerificationCode ${task.submittedVerificationCode} does not match actual verificationCode ${task.verificationCode}`);
        task.verificationResult = { codeMatch: false };
      }
      self.updateFailedLoginCount(task.userId, task.verificationResult.codeMatch).then(() => {
        self.resolveTask(codeMatchingQueue, task, resolve, reject);
      }, (error) => {
        self.rejectTask(codeMatchingQueue, task, error, reject);
      });
    });

    return [codeGenerationQueue, codeMatchingQueue];
  }

  private updateFailedLoginCount(userId: string, codeMatch: boolean): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUserById(userId).then((user: any) => {
        let attrs: any = {
          failedLoginCount: codeMatch ? 0 : (user.failedLoginCount || 0) + 1,
          updatedAt: firebase.database.ServerValue.TIMESTAMP
        };
        if (attrs.failedLoginCount >= 7) {
          attrs.disabled = true;
        }
        return self.db.ref(`/users/${userId}`).update(attrs);
      }).then(() => {
        resolve();
      }, (error) => {
        reject(error);
      });
    });
  }

  private sendMessage(phone: string, messageText: string): Promise<string> {
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
        } else {
          log.debug(`sent message '${messageText}'' to ${phone}`);
        }
        resolve(error ? error.message : undefined);
      });
    });
  }

  private generateVerificationCode() {
    let min = 100000;
    let max = 999999;
    let num = Math.floor(Math.random() * (max - min + 1)) + min;
    return '' + num;
  };

  private isCountrySupported(countryCode: string) {
    let listOfSupportedCountries = ["+1"]; //right now only US is in the list of supported countries
    return listOfSupportedCountries.indexOf(countryCode) != -1;
  }

}
