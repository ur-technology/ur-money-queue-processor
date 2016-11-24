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
        "timeout": 180000
      })
    ];
  }

  process(): any[] {
    let self = this;
    let queueRef = self.db.ref("/phoneLookupQueue");
    let options = { 'specId': 'phone_lookup', 'numWorkers': 1, 'sanitize': false };
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);
      task.phones = task.phones || [];
      if (task.phones.length > 5000) {
        log.info(`  limiting lookup of ${task.phones.length} phones to first 5000`);
        task.phones = _.slice(task.phones, 0, 5000);
      }
      let phonesRemaining = task.phones.length;
      log.info(`  about to search for ${task.phones.length} phones`);
      let phoneToUserMapping: any = {};
      let finalized = false;
      _.each(task.phones, (phone) => {
        self.lookupSignedUpUserByPhone(phone).then((signedUpUser) => {
          if (signedUpUser && signedUpUser.userId && signedUpUser.name) {
            phoneToUserMapping[phone] = _.omitBy(
              _.pick(signedUpUser, ['userId', 'name', 'profilePhotoUrl', 'wallet']),
              _.isNil
            );
          }
          phonesRemaining--;
          if (!finalized && phonesRemaining == 0) {
            task.result = { numMatches: _.size(phoneToUserMapping) };
            if (task.result.numMatches > 0) {
              task.result.phoneToUserMapping = phoneToUserMapping;
            }
            log.info(`  found ${task.result.numMatches} matching users`);
            task._new_state = "finished";
            self.resolveTask(queue, task, resolve, reject);
            finalized = true;
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
      self.lookupUsersByPhone(phone).then((matchingUsers) => {
        let index = _.findIndex(matchingUsers, (user) => {
          return self.isCompletelySignedUp(user);
        });
        resolve(matchingUsers[index]);
      });
    });
  }

}
