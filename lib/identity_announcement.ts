import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';
import {BigNumber} from 'bignumber.js';

export class IdentityAnnouncementQueueProcessor extends QueueProcessor {
  private eth: any;

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
      self.eth = QueueProcessor.web3().eth;
      if (!QueueProcessor.web3().isConnected() || !self.eth) {
        self.rejectTask(queue, task, 'unable to get connection to transaction relay', reject);
        return;
      }

      let toAddress: string;
      self.lookupUserNeedingAnnouncementTransaction(userId).then((user: any) => {
        toAddress = user.wallet.address;
        return self.lookupSponsorAnnouncementTransaction(user.sponsor);
      }).then((sponsorAnnouncementTransaction: any) => {
        return self.buildAnnouncementTransaction(toAddress, sponsorAnnouncementTransaction);
      }).then((announcementTransaction) => {
        return self.publishAnnouncementTransaction(userId, announcementTransaction);
      }).then(() => {
        self.resolveTask(queue, task, resolve, reject);
      }, (error) => {
        self.rejectTask(queue, task, `got error during identity verification announcement: ${error}`, reject);
      });
    });
    return [queue];
  }

  private lookupUserNeedingAnnouncementTransaction(userId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUserById(userId).then((user: any) => {
        let status = self.registrationStatus(user);
        if (status != "verification-succeeded") {
          reject(`unexpected status ${status}`);
        } else if (user.disabled) {
          reject('user is disabled');
        } else if (!user.wallet || !user.wallet.address) {
          reject('user lacks wallet address');
        } else {
          resolve(user);
        }
      }, (error) => {
        reject(error);
      });
    });
  }

  private lookupSponsorAnnouncementTransaction(sponsorInfo: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      if (!sponsorInfo) {
        resolve(undefined);
        return;
      }

      if (!sponsorInfo.userId) {
        reject('No sponsor user id available');
        return;
      }

      self.lookupUserById(sponsorInfo.userId).then((sponsor: any) => {
        if (!sponsor) {
          reject('Could not find associated sponsor');
          return;
        }

        if (!sponsor.wallet || !sponsor.wallet.announcementTransaction || !sponsor.wallet.announcementTransaction.blockNumber || !sponsor.wallet.announcementTransaction.hash) {
          reject('Could not find complete announcementTransaction for sponsor');
          return;
        }

        resolve(sponsor.wallet.announcementTransaction);
      }, (error) => {
        reject(error);
      });
    });
  }

  private publishAnnouncementTransaction(userId: string, announcementTransaction: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let address = QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_ADDRESS;
      let password = QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_PASSWORD;
      let val: any;
      log.info(`***address=${address}`);
      log.info(`***password=${password}`);
      try {
        val = QueueProcessor.web3().personal.unlockAccount(address, password, 1000);
      } catch(error) {
        reject(`got error when attempting to unlock account ${address}: ${error}`);
        return;
      }

      let registrationRef = self.db.ref(`/users/${userId}/registration`);
      registrationRef.update({ status: "announcement-requested" });
      self.eth.sendTransaction(announcementTransaction, (error: string, announcementTransactionHash: string) => {
        registrationRef.update({
          status: error ? "announcement-failed" : "announcement-succeeded",
          announcementFinalizedAt: firebase.database.ServerValue.TIMESTAMP
        });
        if (error) {
          reject(`error sending announcement transaction ${announcementTransactionHash}: ${error}`);
          return;
        }

        console.log(`successfully sent announcement transaction ${announcementTransactionHash} for user ${userId}`);
        resolve();
      });
    });
  }

  private buildAnnouncementTransaction(to: string, sponsorAnnouncementTransaction: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let gasPrice = self.eth.gasPrice;
      if (!gasPrice) {
        reject('eth.gasPrice not set');
        return;
      }
      if (!self.eth.blockNumber) {
        reject('eth.blockNumber not set');
        return;
      }
      let block = self.eth.getBlock(self.eth.blockNumber);
      let gasLimit = block && block.gasLimit;
      if (!gasLimit) {
        reject('could not get gas limit');
        return;
      }

      let announcementTransaction: any = {
        from: QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_ADDRESS,
        to: to,
        value: 1,
        data: this.transactionDataField(sponsorAnnouncementTransaction),
        gasPrice: gasPrice.toNumber(),
        gasLimit: gasLimit
      };
      announcementTransaction.gas = self.eth.estimateGas(announcementTransaction); // TODO: handle failure here
      resolve(announcementTransaction);
    });
  }

  private transactionDataField(sponsorAnnouncementTransaction: any): string {
    if (sponsorAnnouncementTransaction) {
      // encode the block number as an 64 unsigned int (big endian)
      let blockNumber: string = new BigNumber(sponsorAnnouncementTransaction.blockNumber).toString(16);
      blockNumber = _.padStart(blockNumber, 16, '0');
      let hash: string = sponsorAnnouncementTransaction.hash.replace(/^0x/,'');
      return '0x01' + blockNumber + hash; // 84 characters long
    } else {
      return '0x01';
    }
  }

}
