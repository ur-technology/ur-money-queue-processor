import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class IdentityVerificationQueueProcessor extends QueueProcessor {
  stripe: any;
  request: any;

  init(): Promise<any>[] {
    this.stripe = require("stripe")(QueueProcessor.env.STRIPE_SECRET_KEY);
    this.request = require('request');
    return [
      this.ensureQueueSpecLoaded("/identityVerificationQueue/specs/verify_identity", {
        "in_progress_state": "processing",
        "finished_state": "finished",
        "error_state": "error",
        "timeout": 120000,
        "retries": 5
      })
    ];
  }

  process(): any[] {
    let self = this;
    let queueRef = self.db.ref("/identityVerificationQueue");
    let options = { 'specId': 'verify_identity', 'numWorkers': 1, 'sanitize': false };
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);
      let rejected = false;
      self.lookupUserById(task.userId).then((user: any) => {
        if (!user) {
          self.rejectTask(queue, task, `could not find user with id ${task.userId}`, reject);
          return;
        }

        let status = self.registrationStatus(user);
        if (!_.includes(['initial', 'verification-failed', 'verification-payment-failed'], status)) {
          self.rejectTask(queue, task, `unexpected status ${user.registration.status}`, reject);
          return;
        }

        let verifyIdentityAndResolve = () => {
          self.verifyIdentity(task.userId, task.verificationArgs, task.version).then((status: string) => {
            self.resolveTask(queue, _.merge(task, {result: {status: status}}), resolve, reject);
          }, (error: any) => {
            self.rejectTask(queue, task, error, reject);
          });
        };

        if (task.version === 2) {
          let token = task.stripeTokenId;
          let charge = self.stripe.charges.create({
            amount: 299, // Amount in cents
            currency: "usd",
            source: task.stripeTokenId,
            description: "UR Money ID Verification"
          }, (error: any, charge: any) => {
            if (error && error.type === 'StripeCardError') {
              log.debug(`card declined; stripe error: `, JSON.stringify(error));
              self.resolveTask(queue, _.merge(task, {result: {status: 'verification-payment-failed'}}), resolve, reject);
            } else if (error) {
              log.warn(`error processing payment: ${error}`);
              self.rejectTask(queue, task, `There was an error processing your payment.`, reject);
            } else {
              verifyIdentityAndResolve();
            }
          });
        } else {
          verifyIdentityAndResolve();
        }
      });
    });
    return [queue];
  }

  private verifyIdentity(userId: string, verificationArgs: any, version: number): Promise<string> {
    let self = this;
    return new Promise((resolve, reject) => {
      let registrationRef = self.db.ref(`/users/${userId}/registration`);
      registrationRef.update({
        status: "verification-initiated",
        verificationRequestedAt: firebase.database.ServerValue.TIMESTAMP
      });
      let options:any = {
        url: 'https://api.globaldatacompany.com/verifications/v1/verify',
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${QueueProcessor.env.TRULIOO_BASIC_AUTHORIZATION}`
        },
        body: self.generateRequestBody(verificationArgs, version),
        json: true
      };

      self.request(options, (error: any, response: any, verificationData: any) => {
        if (error) {
          reject(`something went wrong on the client: ${error}`);
          return;
        }
        if (!verificationData.Record) {
          reject('no data returned from Trulioo');
          return;
        }
        if (self.containsUndefinedValue(verificationData.Record)) {
          log.warn('data returned from Trulioo contains undefined values');
          self.removeUndefineds(verificationData.Record);
        }
        let status = verificationData.Record && verificationData.Record.RecordStatus === "match" ? "verification-succeeded": "verification-failed";
        registrationRef.update({
          status: status,
          verificationFinalizedAt: firebase.database.ServerValue.TIMESTAMP,
          verificationArgs: verificationArgs,
          verificationResult: verificationData.Record
        });
        resolve(status);
      });
    });
  }

  private generateRequestBody(verificationArgs: any, version: number): any {
    if (!version || version < 2) {
      return verificationArgs;
    }

    verificationArgs = this.changeKeysToUpperFirst(verificationArgs);

    let body: any = {
      AcceptTruliooTermsAndConditions: true,
      Demo: false,
      CleansedAddress: true,
      ConfigurationName: 'Identity Verification',
      CountryCode: verificationArgs.CountryCode,
      DataFields: _.pick( verificationArgs, ['PersonInfo', 'Location', 'Communication'])
    };

    // for Malaysia, add a FullName field wrapped in an AdditionalFields object
    if (body.CountryCode === 'MY') {
      let p: any = body.DataFields.PersonInfo;
      p.AdditionalFields = { FullName: `${p.FirstSurName} ${p.FirstGivenName}` };
    }

    // wrap Address1 field in AdditionalFields object
    let l: any = body.DataFields.Location;
    if (l.Address1) {
      l.AdditionalFields = { Address1: l.Address1 };
      delete l.Address1;
    }

    if (verificationArgs.IdentificationType === 'Driver License') {
      body.DataFields.DriverLicense = verificationArgs.DriverLicense;
    } else if (verificationArgs.IdentificationType === 'National Id') {
      body.DataFields.NationalIds = [verificationArgs.NationalId];
    } else if (verificationArgs.IdentificationType === 'Passport') {
      body.DataFields.Passport = verificationArgs.Passport;
    }

    return body;
  }

  private changeKeysToUpperFirst(origObj: any) {
    return Object.keys(origObj).reduce((newObj: any, key: any) => {
      let val = origObj[key];
      let newVal = (typeof val === 'object') ? this.changeKeysToUpperFirst(val) : val;
      let newKey = _.isString(key) ? _.upperFirst(key) : key;
      newObj[newKey] = newVal;
      return newObj;
    }, {});
  }

}
