import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class IdentityVerificationQueueProcessor extends QueueProcessor {
  init(): Promise<any>[] {
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
          self.verifyIdentity(task.userId, task.verificationArgs).then((status: string) => {
            self.resolveTask(queue, _.merge(task, {result: {status: status}}), resolve, reject);
          }, (error: any) => {
            self.rejectTask(queue, task, error, reject);
          });
        };

        if (task.stripeTokenId) {
          let stripe = require("stripe")("sk_test_6iHyRQYCfUVredh4fK3q0yER");
          let token = task.stripeTokenId;
          let charge = stripe.charges.create({
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

  private verifyIdentity(userId: string, verificationArgs: any): Promise<string> {
    let self = this;
    return new Promise((resolve, reject) => {
      let registrationRef = self.db.ref(`/users/${userId}/registration`);
      registrationRef.update({
        status: "verification-requested",
        verificationRequestedAt: firebase.database.ServerValue.TIMESTAMP
      });
      var request = require('request');
      let options = {
        url: 'https://api.globaldatacompany.com/verifications/v1/verify',
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Basic ${QueueProcessor.env.TRULIOO_BASIC_AUTHORIZATION}`
        },
        body: verificationArgs,
        json: true
      };
      request(options, (error: any, response: any, verificationData: any) => {
        if (error) {
          reject(`something went wrong on the client: ${error}`);
          return;
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
}
