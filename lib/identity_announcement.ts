import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class IdentityAnnouncementQueueProcessor extends QueueProcessor {
  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/identityAnnouncementQueue/specs/announce_identity", {
        "in_progress_state": "processing",
        "error_state": "error",
        "timeout": 120000,
        "retries": 5
      })
    ];
  }

  process(): any[] {
    let self = this;
    let queueRef = self.db.ref("/identityAnnouncementQueue");
    let options = { 'specId': 'announce_identity', 'numWorkers': 1, 'sanitize': false };
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
        if (status != "verification-succeeded") {
          rejectOnce(`unexpected status ${user.registration.status}`);
          return;
        }
        if (!user.wallet || !user.wallet.address) {
          rejectOnce(`no wallet address set`);
          return;
        }

        let registrationRef = self.db.ref(`/users/${userId}/registration`);
        registrationRef.update({
          status: "announcement-requested",
          announcementRequestedAt: firebase.database.ServerValue.TIMESTAMP
        });

        let txResult = self.buildTransaction(user.wallet.address);
        if (txResult.error) {
          rejectOnce(txResult.error);
          return;
        }

        let web3 = QueueProcessor.web3;
        web3.personal.unlockAccount(
          QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_ADDRESS,
          QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_PASSWORD,
          1000
        );
        web3.eth.sendTransaction(txResult.tx, (error: string, hash: string) => {
          registrationRef.update({
            status: error ? "announcement-failed" : "announcement-succeeded",
            announcementFinalizedAt: firebase.database.ServerValue.TIMESTAMP
          });
          if (error) {
            console.log(`error sending transaction ${hash}: ${error}`);
            reject(error);
          } else {
            console.log(`successfully sent announcement transaction ${hash} for user ${userId}`);
            self.resolveIfPossible(resolve, reject, taskData);
          }
        });
      }, (error) => {
        rejectOnce(`could not find user with id ${userId}: ${error}`);
      });
    });
    return [queue];
  }

  private buildTransaction(to: string): any {
    let eth = QueueProcessor.web3.eth;

    if (!eth.gasPrice) {
      return { error: "eth.gasPrice not set" }
    }

    if (!eth.blockNumber) {
      return { error: "eth.blockNumber not set" }
    }

    let block = eth.getBlock(eth.blockNumber);
    let gasLimit = block && block.gasLimit;
    if (!gasLimit) {
      return { error: "could not get gas limit" }
    }

    let tx: any = {
      from: QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_ADDRESS,
      to: to,
      value: 1,
      data: "01",
      gasPrice: eth.gasPrice.toNumber(),
      gasLimit: gasLimit
    };
    tx.gas = eth.estimateGas(tx)
    return { error: null, tx: tx };
  }

}
