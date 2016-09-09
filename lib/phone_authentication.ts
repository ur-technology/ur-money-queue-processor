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
    let codeGenerationQueue = new self.Queue(queueRef, codeGenerationOptions, (data: any, progress: any, resolve: any, reject: any) => {
      self.lookupUsersByPhone(data.phone).then((result) => {
        // TODO: handle case where there are multiple invitations
        let matchingUser = _.first(result.matchingUsers);
        let matchingUserId = _.first(result.matchingUserIds);
        if (!matchingUser) {
          log.info(`no matching user found for ${data.phone}`);
          data._new_state = "code_generation_canceled_because_user_not_invited";
          self.resolveIfPossible(resolve, reject, data);
          return;
        }

        log.debug(`matching user with userId ${matchingUserId} found for phone ${data.phone}`);

        if (!this.isCountrySupported(data.countryCode)) {
          data._new_state = "code_generation_canceled_because_user_from_not_supported_country";
          self.resolveIfPossible(resolve, reject, data);
          return;
        }

        let verificationCode = self.generateVerificationCode();
        self.sendMessage(data.phone, `Your UR Money verification code is ${verificationCode}`).then((error: string) => {
          if (error) {
            log.info(`error sending message to user with userId ${matchingUserId} and phone ${data.phone}: ${error}`);
            reject(error);
          } else {
            data.userId = matchingUserId;
            data.verificationCode = verificationCode;
            data._state = "code_generation_completed_and_sms_sent"; // TODO: change this from _state to _new_state
            self.resolveIfPossible(resolve, reject, data);
          }
        });
      }, (error) => {
        reject(error);
      });
    });

    let codeMatchingOptions = { 'specId': 'code_matching', 'numWorkers': 1 };
    let codeMatchingQueue = new self.Queue(queueRef, codeMatchingOptions, (data: any, progress: any, resolve: any, reject: any) => {
      if (data.submittedVerificationCode == data.verificationCode) {
        log.debug(`submittedVerificationCode ${data.submittedVerificationCode} matches actual verificationCode; sending authToken to user`);
        data.verificationResult = { codeMatch: true, authToken: firebase.auth().createCustomToken(data.userId, { some: "arbitrary", data: "here" }) };
      } else {
        log.debug(`submittedVerificationCode ${data.submittedVerificationCode} does not match actual verificationCode ${data.verificationCode}`);
        data.verificationResult = { codeMatch: false };
      }
      self.resolveIfPossible(resolve, reject, data);
    });

    return [codeGenerationQueue, codeMatchingQueue];
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
    let listOfSupportedCountries = ["+1"];//right now only US is in the list of supported countries
    listOfSupportedCountries.indexOf(countryCode) != -1;
  }

}
