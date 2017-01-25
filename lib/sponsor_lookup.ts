import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class SponsorLookupQueueProcessor extends QueueProcessor {

  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/sponsorLookupQueue/specs/sponsor_lookup", {
        "in_progress_state": "sponsor_lookup_in_progress",
        "finished_state": "sponsor_lookup_finished",
        "error_state": "sponsor_lookup_error",
        "timeout": 5 * 60 * 1000
      })
    ];
  }

  process(): any[] {
    return [
      this.processSponsorLookupSpec()
    ]
  }


  private processSponsorLookupSpec() {
    let self = this;
    let options = { 'specId': 'sponsor_lookup', 'numWorkers': 1, sanitize: false };
    let queueRef = self.db.ref('/sponsorLookupQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);

      if (!task.sponsorReferralCode && !task.phone) {
        self.rejectTask(queue, task, 'expecting either a phone or a sponsorReferralCode', reject);
        return;
      }

      let resolveAsNotFound = (referralCode: string) => {
        log.info(`  no matching user found for referral code ${referralCode}`);
        task.result = { found: false };
        task._new_state = "sponsor_lookup_canceled_because_user_not_found";
        self.resolveTask(queue, task, resolve, reject);
      };

      let resolveAsPhoneAlreadyRegistered = (phone: string) => {
        log.info(`Phone already registered ${phone}`);
        task.result = { found: true };
        task._new_state = "sponsor_lookup_canceled_because_phone_already_registered";
        self.resolveTask(queue, task, resolve, reject);
      };
      if (task.phone) {
        self.lookupIfPhoneAlreadyExists(task.phone).then(user => {
          if (user) {
            resolveAsPhoneAlreadyRegistered(task.phone);
            return;
          }
          task.result = { found: false };
          task._new_state = "sponsor_lookup_finished";
          self.resolveTask(queue, task, resolve, reject);
        }, (error) => {
          self.rejectTask(queue, task, error, reject);
        });
      } else {
        self.lookupUserByReferralCode(task.sponsorReferralCode).then((sponsor: any) => {
          if (!sponsor) {
            log.info(`  no sponsor found with referral code ${task.sponsorReferralCode}`);
            resolveAsNotFound(task.sponsorReferralCode);
            return;
          }

          task.result = { found: true, sponsorName: sponsor.name ? sponsor.name : `${sponsor.firstName} ${sponsor.lastName}`, disabled: sponsor.disabled || false }

          task._new_state = "sponsor_lookup_finished";
          self.resolveTask(queue, task, resolve, reject);

        }, (error) => {
          self.rejectTask(queue, task, error, reject);
        });
      }
    });

    return queue;
  }

  lookupIfPhoneAlreadyExists(phone: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUsersByPhone(phone).then((matchingUsers: any) => {
        resolve(matchingUsers[0]);
      });
    });
  }

  lookupUserByReferralCode(referralCode: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUsersByReferralCode(referralCode).then((matchingUsers: any) => {
        resolve(matchingUsers[0]);
      });
    });
  }

}
