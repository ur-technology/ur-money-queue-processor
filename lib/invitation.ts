import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class InvitationQueueProcessor extends QueueProcessor {
  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/invitationQueue/specs/process_invitation", {
        "in_progress_state": "processing",
        "error_state": "error",
        "timeout": 120000,
        "retries": 5
      })
    ];
  }

  process(): any[] {
    let self = this;
    let queueRef = self.db.ref("/invitationQueue");
    let options = { 'specId': 'process_invitation', 'numWorkers': 1, 'sanitize': false };
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);
      self.lookupUsersByPhone(task.invitee.phone).then((matchingUsers) => {
        let matchingUser: any = _.first(matchingUsers);
        let status = self.registrationStatus(matchingUser);
        if (status !== 'initial') {
          self.logAndReject(queue, task, `Sorry, ${matchingUser.name} has already responded to an invitation.`, reject);
          return;
        }

        self.lookupUserById(task.sponsorUserId).then((sponsor: any) => {
          if (!sponsor) {
            self.logAndReject(queue, task, "Could not find associated sponsor.", reject);
            return;
          }

          if (sponsor.disabled) {
            self.logAndReject(queue, task, `Canceling invitation because sponsor has been disabled`, reject);
            return;
          }

          if (sponsor.invitesDisabled) {
            self.logAndReject(queue, task, `Canceling invitation because invites have been disabled for sponsor`, reject);
            return;
          }

          if (!sponsor.downlineLevel) {
            log.warn('sponsor lacks a downline level');
          }

          // add new user to users list
          let newUser: any = {
            createdAt: firebase.database.ServerValue.TIMESTAMP,
            firstName: task.invitee.firstName,
            middleName: task.invitee.middleName,
            lastName: task.invitee.lastName,
            phone: task.invitee.phone,
            sponsor: {
              userId: task.sponsorUserId,
              name: sponsor.name,
              profilePhotoUrl: sponsor.profilePhotoUrl
            },
            downlineLevel: (sponsor.downlineLevel || 0) + 1
          };
          newUser.name = self.fullName(newUser);
          newUser.profilePhotoUrl = self.generateProfilePhotoUrl(newUser);
          let newUserRef = self.db.ref('/users').push(newUser);

          // add new user to sponsor's downline users
          let newUserId = newUserRef.key;
          let sponsorRef = self.db.ref(`/users/${task.sponsorUserId}`);
          sponsorRef.child(`downlineUsers/${newUserId}`).set({ name: newUser.name, profilePhotoUrl: newUser.profilePhotoUrl });
          log.debug(`processed invitation of ${newUserId} (${newUser.name}) by ${task.sponsorUserId}`);
          self.logAndResolveIfPossible(queue, task, resolve, reject);
        });
      }, (error) => {
        self.logAndReject(queue, task, error, reject);
        return;
      });
    });
    return [queue];
  }

}
