import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class PhoneLookupQueueProcessor extends QueueProcessor {
  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/phoneLookupQueue/specs/phone_lookup", {
        "in_progress_state": "in_progress",
        "finished_state": "finished",
        "error_state": "error",
        "timeout": 30000
      })
    ];
  }

  process(): any[] {
    let self = this;
    let queueRef = self.db.ref("/phoneLookupQueue");
    let options = { 'specId': 'phone_lookup', 'numWorkers': 1, 'sanitize': false };
    let Queue = require('firebase-queue');
    let queue = new self.Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      data.phones = data.phones || [];
      let phonesRemaining = data.phones.length;
      log.debug(`phoneLookup ${data._id} - looking up ${phonesRemaining} contacts`);
      let phoneToUserMapping: any = {};
      let finalized = false;
      _.each(data.phones, (phone) => {
        self.lookupSignedUpUserByPhone(phone).then((result) => {
          if (result.signedUpUser) {
            phoneToUserMapping[phone] = {
              userId: result.signedUpUserId,
              name: result.signedUpUser.name,
              profilePhotoUrl: result.signedUpUser.profilePhotoUrl,
              wallet: result.signedUpUser.wallet
            };
          }
          phonesRemaining--;
          if (!finalized && phonesRemaining == 0) {
            data.result = { numMatches: _.size(phoneToUserMapping) };
            if (data.result.numMatches > 0) {
              data.result.phoneToUserMapping = phoneToUserMapping;
            }
            data._state = "finished";
            self.resolveIfPossible(resolve, reject, data);
            finalized = true
            log.debug(`phoneLookup ${data._id} - finished`);
          }
        }, (error) => {
          finalized = true;
          reject(error);
        });
      });
    });
    return [queue];
  }

  private lookupSignedUpUserByPhone(phone: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUsersByPhone(phone).then((result) => {
        let index = _.findIndex(result.matchingUsers, (user) => {
          return self.isCompletelySignedUp(user);
        });
        resolve({ signedUpUser: result.matchingUsers[index], signedUpUserId: result.matchingUserIds[index] });
      });
    });
  }

  private isCompletelySignedUp(user: any) {
    return !!user.identityVerifiedAt && !!user.name && !!user.profilePhotoUrl && !!user.wallet && !!user.wallet.address;
  }

}
