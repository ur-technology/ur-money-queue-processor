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
      function rejectOnce(message: string) {
        log.error(message);
        if (!rejected) {
          reject(message);
          rejected = true;
        }
      }
      let userId: string = task.userId;
      self.lookupUserById(userId).then((user: any) => {
        let status = self.registrationStatus(user);
        if (status !== 'initial') {
          rejectOnce(`unexpected status ${user.registration.status}`);
          return;
        }

        let options = {
          url: 'https://api.globaldatacompany.com/verifications/v1/verify',
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Basic VVJDYXBpdGFsX0FQSTpOVmhLdDNAVUtZVHJBVlIzWHlR"
          },
          body: task.verificationArgs,
          json: true
        };
        let registrationRef = self.db.ref(`/users/${userId}/registration`);
        registrationRef.update({
          status: "verification-requested",
          verificationRequestedAt: firebase.database.ServerValue.TIMESTAMP
        });
        var request = require('request');
        request(options, (error: any, response: any, verificationData: any) => {
          if (error) {
            rejectOnce(`something went wrong on the client: ${error}`);
            return;
          }
          let status = verificationData.Record && verificationData.Record.RecordStatus == "match" ? "verification-succeeded": "verification-pending";
          registrationRef.update({
            status: status,
            verificationFinalizedAt: firebase.database.ServerValue.TIMESTAMP,
            verificationArgs: task.verificationArgs,
            verificationResult: verificationData.Record
          });
          self.resolveTask(queue, _.merge(task, {result: {status: status}}), resolve, reject);
        });
      }, (error: any) => {
        rejectOnce(`could not find user with id ${userId}: ${error}`);
      });
    });
    return [queue];
  }
}
