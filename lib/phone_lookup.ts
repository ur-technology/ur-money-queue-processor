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
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);
      task.phones = task.phones || [];
      let phonesRemaining = task.phones.length;
      let phoneToUserMapping: any = {};
      let finalized = false;
      _.each(task.phones, (phone) => {
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
            task.result = { numMatches: _.size(phoneToUserMapping) };
            if (task.result.numMatches > 0) {
              task.result.phoneToUserMapping = phoneToUserMapping;
            }
            task._state = "finished";
            self.logAndResolveIfPossible(queue, task, resolve, reject);
            finalized = true
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
    return user.registration && user.registration.verified && !!user.name && !!user.profilePhotoUrl && !!user.wallet && !!user.wallet.address;
  }

}
