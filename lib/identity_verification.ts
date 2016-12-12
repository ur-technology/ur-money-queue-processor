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
          self.rejectTask(queue, task, `unexpected status ${user.registration.status} before announcement`, reject);
          return;
        }

        let verifyIdentityAndResolve = () => {
          self.verifyIdentity(task.userId, task.verificationArgs).then((status: string) => {
            self.resolveTask(queue, _.merge(task, {result: {status: status}}), resolve, reject);
          }, (error: any) => {
            self.rejectTask(queue, task, error, reject);
          });
        };

        if (!task.verificationArgs.Version || task.verificationArgs.Version < 2) {
          verifyIdentityAndResolve();
          return;
        }

        let charge = self.stripe.charges.create({
          amount: 299, // Amount in cents
          currency: "usd",
          source: task.stripeTokenId,
          description: "UR Money ID Verification"
        }, (error: any, charge: any) => {
          if (error && error.type === 'StripeCardError') {
            log.debug(`card declined; stripe error: `, JSON.stringify(error));
            self.resolveTask(queue, _.merge(task, {result: {status: 'verification-payment-failed'}}), resolve, reject);
            return;
          }
          if (error) {
            log.warn(`error processing payment: ${error}`);
            self.rejectTask(queue, task, `There was an error processing your payment.`, reject);
            return;
          }
          verifyIdentityAndResolve();
        });
      });
    });
    return [queue];
  }

  private verifyIdentity(userId: string, verificationArgs: any): Promise<string> {
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
        body: self.generateRequestBody(verificationArgs),
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
          verificationResult: verificationData.Record,
        });
        resolve(status);
      });
    });
  }

  private generateRequestBody(verificationArgs: any): any {
    if (!verificationArgs.Version || verificationArgs.Version < 2) {
      return verificationArgs;
    }

    verificationArgs = this.standardizeObject(verificationArgs);

    let body: any = {
      AcceptTruliooTermsAndConditions: true,
      Demo: false,
      CleansedAddress: true,
      ConfigurationName: 'Identity Verification',
      CountryCode: verificationArgs.CountryCode,
      DataFields: _.pick( verificationArgs, ['PersonInfo', 'Location', 'Communication'])
    };

    if (body.CountryCode === 'MY') {
      // for Malaysia, add a FullName field wrapped in an AdditionalFields object
      let p: any = body.DataFields.PersonInfo;
      if (p) {
        p.AdditionalFields = { FullName: `${p.FirstSurName} ${p.FirstGivenName}` };
      }
    }

    if (body.CountryCode === 'MX') {
      // for Mexico, split surname into two fields if necessary
      let p: any = body.DataFields.PersonInfo;
      if (p && p.FirstSurName && !p.SecondSurname) {
        let surnames = p.FirstSurName.split(' ');
        if (surnames.length > 1) {
          p.FirstSurName = surnames[0];
          p.SecondSurname = _.slice(surnames, 1).join(' ');
        }
      }
    }

    let l: any = body.DataFields.Location;
    if (l && l.Address1) {
      // wrap Address1 field in AdditionalFields object
      l.AdditionalFields = { Address1: l.Address1 };
      delete l.Address1;
    }

    if (verificationArgs.IdentificationType === 'DriverLicense') {
      body.DataFields.DriverLicense = verificationArgs.DriverLicense;
    } else if (verificationArgs.IdentificationType === 'NationalId') {
      body.DataFields.NationalIds = [
        _.merge(verificationArgs.NationalId, { Type: this.nationalIdType(body.CountryCode) })
      ];
    } else if (verificationArgs.IdentificationType === 'Passport') {
      body.DataFields.Passport = verificationArgs.Passport;
    }

    return body;
  }

  private nationalIdType(countryCode: string) {
    if (countryCode === 'GB') {
      return 'Health';
    } else if (countryCode === 'US') {
      return 'SocialService';
    } else {
      return 'NationalID';
    }
  }

  private standardizeObject(origObj: any) {
    // changes key strings from format 'keyName' to 'KeyName'
    // also trims key strings and value strings
    return Object.keys(origObj).reduce((newObj: any, key: any) => {
      let val = origObj[key];
      let newVal = (typeof val === 'object') ? this.standardizeObject(val) : (_.isString(val) ? _.trim(val) : val);
      let newKey = _.isString(key) ? _.upperFirst(_.trim(key)) : key;
      newObj[newKey] = newVal;
      return newObj;
    }, {});
  }

}
