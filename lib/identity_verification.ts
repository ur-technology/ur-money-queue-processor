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
      let userId: string = taskData._id;
      let verificationArgs: any = {
        "AcceptTruliooTermsAndConditions": true,
        "Demo": true,
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
          "Authorization": "Basic VVJDYXBpdGFsX0RlbW9fQVBJOnVaTkFkOEVlRjJyZGhkb01VcXgh"
        },
        body: verificationArgs,
        json: true
      };
      var request = require('request');

      request(options, (error: any, response: any, data: any) => {
        if (!error) {
          let matched: boolean = data.Record.RecordStatus == "match";
          self.db.ref(`/users/${userId}`).update({
            identityVerificationResult: data.Record,
            identityVerificationRequestedAt: firebase.database.ServerValue.TIMESTAMP,
            identityVerifiedAt: matched ? firebase.database.ServerValue.TIMESTAMP : null,
          });
          if (matched) {
            // create transaction
            let eth = QueueProcessor.web3.eth;
            let from = "5d32e21bf3594aa66c205fde8dbee3dc726bd61d";
            let tx: any = {
              from: from,
              to: taskData.wallet.address,
              value: 1,
              data: "01",
              gasPrice: eth.gasPrice.toNumber(),
              gasLimit: eth.getBlock(eth.blockNumber).gasLimit
            };
            tx.gas = eth.estimateGas(tx)
            let personal = QueueProcessor.web3.personal;
            let password = "password";
            personal.unlockAccount(from,password,1000);
            eth.sendTransaction(tx, (error: string, hash: string) => {
              console.log("result from sendTransaction", error, hash);
              if (error) {
                reject(error);
              } else {
                self.resolveIfPossible(resolve, reject, { result: data.Record });
              }
            });
          } else {
            self.resolveIfPossible(resolve, reject, { result: data.Record });
          }
        } else {
          rejectOnce(`something went wrong on the client: ${error}`);
        }
      });
    });
    return [queue];
  }
}
