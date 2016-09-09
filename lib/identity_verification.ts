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
          matched = true;
          self.db.ref(`/users/${userId}`).update({
            identityVerificationResult: data.Record,
            identityVerificationRequestedAt: firebase.database.ServerValue.TIMESTAMP,
            identityVerifiedAt: matched ? firebase.database.ServerValue.TIMESTAMP : null,
          });
          if (matched) {
            // create transaction
            let privilegedAddress = "5d32e21bf3594aa66c205fde8dbee3dc726bd61d";
            let to = taskData.wallet.address;
            let eth = QueueProcessor.web3.eth;
            var rawTx: any = {
              nonce: eth.getTransactionCount(privilegedAddress),
              from: privilegedAddress,
              to: to,
              value: 1,
              data: "01",
              gasPrice: eth.gasPrice.toNumber(),
              gasLimit: eth.getBlock(eth.blockNumber).gasLimit
            };
            rawTx.gas = eth.estimateGas(rawTx)
            let ethTx = require('ethereumjs-tx');
            var tx = new ethTx(rawTx);

            // sign key
            let keythereum = require("keythereum");
            let keyObject: any = keythereum.importFromFile(privilegedAddress, "ur_data");
            let password = "password";
            let privateKey = keythereum.recover(password, keyObject);
            tx.sign(privateKey);
            var serializedTx = tx.serialize().toString('hex');
            eth.sendRawTransaction(serializedTx, (error: string, hash: string) => {
              console.log("result from sendRawTransaction", error, hash);
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
