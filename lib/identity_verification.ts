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
    let queue = new self.Queue(queueRef, options, (taskData: any, progress: any, resolve: any, reject: any) => {
      let rejected = false;
      function rejectOnce(message: string) {
        log.error(message);
        if (!rejected) {
          reject(message);
          rejected = true;
        }
      }
      let userId: string = taskData.userId;
      self.lookupUserById(userId).then((user: any) => {
        let status = _.trim((user.registration && user.registration.status) || "");
        if (status && status != "initial") {
          rejectOnce(`unexpected status ${user.registration.status}`);
          return;
        }

        let verificationArgs: any = {
          "AcceptTruliooTermsAndConditions": true,
          "Demo": false,
          "CleansedAddress": true,
          "ConfigurationName": "Identity Verification",
          "CountryCode": taskData.Location.Country,
          "DataFields": _.pick(taskData, ['PersonInfo', 'Location', 'Communication', 'DriverLicence', 'NationalIds', 'Passport'])
        };
        let options = {
          url: 'https://api.globaldatacompany.com/verifications/v1/verify',
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Basic VVJDYXBpdGFsX0FQSTpOVmhLdDNAVUtZVHJBVlIzWHlR"
          },
          body: verificationArgs,
          json: true
        };
        let registrationRef = self.db.ref(`/users/${userId}/registration`);
        registrationRef.update({
          status: "verification-requested",
          verificationRequestedAt: firebase.database.ServerValue.TIMESTAMP
        });
        var request = require('request');
        request(options, (error: any, response: any, data: any) => {
          if (error) {
            rejectOnce(`something went wrong on the client: ${error}`);
            return;
          }
          let verified: boolean = !!data.Record && data.Record.RecordStatus == "match";
          registrationRef.update({
            status: verified ? "verification-succeeded": "verification-pending",
            verificationFinalizedAt: firebase.database.ServerValue.TIMESTAMP,
            verificationResult: data.Record
          });
          self.resolveIfPossible(resolve, reject, {result: {verified: verified}});
        });
      }, (error: any) => {
        rejectOnce(`could not find user with id ${userId}: ${error}`);
      });
    });
    return [queue];
  }
}
