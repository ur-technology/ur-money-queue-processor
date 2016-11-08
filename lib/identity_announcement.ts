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
        "retries": 10
      })
    ];
  }

  process(): any[] {
    let self = this;
    let queueRef = self.db.ref("/identityAnnouncementQueue");
    let options = { 'specId': 'announce_identity', 'numWorkers': 1, 'sanitize': false };
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);
      let userId: string = task.userId;
      self.lookupVerifiedUser(userId).then((user: any) => {
        return self.lookupSponsor(user);
      }).then((sponsor) => {
        return self.announceIdentityVerification(user, sponsor);
      }).then((announcementTransactionHash: string) => {
        console.log(`successfully sent announcement transaction ${announcementTransactionHash} for user ${userId}`);
        self.logAndResolveIfPossible(queue, task, resolve, reject);
      }, (error) => {
        self.logAndReject(`got error during identity verification announcement: ${error}`);
      });
    });
    return [queue];
  }

  private lookupVerifiedUser(userId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUserById(userId).then((user: any) => {
        let status = self.registrationStatus(user);
        if (status != "verification-succeeded") {
          reject(`unexpected status ${status}`);
        }

        if (user.disabled) {
          reject('user is disabled');
        }

        if (!user.wallet || !user.wallet.address) {
          reject('user wallet address set');
        }

        resolve(user);
      }, (error) => {
        reject(error);
      }
    });
  }

  private lookupSponsor(user: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      if (!user.sponsor) {
        resolve(undefined);
        return;
      }

      if (user.sponsor.userId) {
        reject('No sponsor user id available');
        return;
      }

      self.lookupUserById(user.sponsor.userId).then((sponsor: any) => {
        if (!sponsor) {
          reject('Could not find associated sponsor');
          return;
        }

        if (sponsor.disabled) {
          reject('Sponsor has been disabled');
          return;
        }

        if (!sponsor.signUpUrTransaction || !sponsor.signUpUrTransaction.blockNumber || !sponsor.signUpUrTransaction.hash) {
          reject('No sign up transaction set');
          return;
        }

        resolve(sponsor);
      }, (error) => {
        reject(error);
      });
    });
  }

  private announceIdentityVerification(user: any, sponsor: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let eth = QueueProcessor.web3().eth;
      if (!QueueProcessor.web3().isConnected() || !eth) {
        reject('unable to get connection to ur transaction relay');
        return;
      }
      if (!eth.gasPrice) {
        reject('eth.gasPrice not set');
        return;
      }
      if (!eth.blockNumber) {
        reject('eth.blockNumber not set');
        return;
      }
      let block = eth.getBlock(eth.blockNumber);
      let gasLimit = block && block.gasLimit;
      if (!gasLimit) {
        reject('could not get gas limit');
        return;
      }

      let address = QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_ADDRESS;
      let password = QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_PASSWORD;
      let val: any;
      try {
        val = QueueProcessor.web3().personal.unlockAccount(address, password, 1000);
      } catch(error) {
        reject(`got error when attempting to unlock account ${address}: ${error}`);
        return;
      }

      let tx = self.buildTransaction(sponsor, user.wallet.address, gasLimit);
      self.db.ref(`/users/${userId}/registration`).update({ status: "announcement-requested" });
      QueueProcessor.web3().eth.sendTransaction(tx, (error: string, announcementTransactionHash: string) => {
        registrationRef.update({
          status: error ? "announcement-failed" : "announcement-succeeded",
          announcementFinalizedAt: firebase.database.ServerValue.TIMESTAMP
        });
        if (error) {
          reject(`error sending transaction ${announcementTransactionHash}: ${error}`);
          return;
        }

        console.log(`successfully sent announcement transaction ${announcementTransactionHash} for user ${userId}`);
        resolve(announcementTransactionHash);
      });
    });
  }

  private buildTransaction(sponsor: any, to: string, gasLimit: number): any {
    let eth = QueueProcessor.web3().eth;
    let tx: any = {
      from: QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_ADDRESS,
      to: to,
      value: 1,
      data: self.transactionDataField(sponsor),
      gasPrice: eth.gasPrice.toNumber(),
      gasLimit: gasLimit
    };
    tx.gas = eth.estimateGas(tx);
    return tx;
  }

  function transactionDataField(sponsor): string {
    if (sponsor) {
      // encode the block number as an 64 unsigned int (big endian)
      let bHex: string = new BigNumber(sponsor.signUpUrTransaction.blockNumber).toString(16);
      bHex = _.padStart(bHex, 16, '0');
      return '01' + bHex + sponsor.signUpUrTransaction.hash;
    } else {
      return '01';
    }
  }

}
