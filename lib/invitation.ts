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
      let newUserId: string = self.db.ref('/users').push().key;
      let sponsorRef = self.db.ref(`/users/${task.sponsorUserId}`);
      self.lookupUsersByPhone(task.invitee.phone).then((matchingUsers) => {
        let matchingUser: any = _.first(matchingUsers);
        let status = self.registrationStatus(matchingUser);
        if (status !== 'initial') {
          return Primose.reject(`Sorry, ${matchingUser.name} has already responded to an invitation.`);
        }

        return self.lookupUserById(task.sponsorUserId);
      }).then((sponsor: any) => {
        if (!sponsor) {
          return Promise.reject(`Could not find associated sponsor.`);
        }

        if (sponsor.disabled) {
          return Promise.reject(`Canceling invitation because sponsor has been disabled`);
        }

        if (sponsor.invitesDisabled) {
          return Promise.reject(`Canceling invitation because invites have been disabled for sponsor.`);
        }

        if (!sponsor.downlineLevel) {
          log.warn('  sponsor lacks a downline level');
        }

        // add new user to users list
        let newUser: any = {
          createdAt: firebase.database.ServerValue.TIMESTAMP,
          firstName: task.invitee.firstName || '',
          middleName: task.invitee.middleName || '',
          lastName: task.invitee.lastName || '',
          phone: task.invitee.phone,
          sponsor: {
            userId: task.sponsorUserId,
            name: sponsor.name,
            profilePhotoUrl: sponsor.profilePhotoUrl,
            announcementTransactionConfirmed: !!sponsor.wallet &&
              !!sponsor.wallet.announcementTransaction &&
              !!sponsor.wallet.announcementTransaction.blockNumber &&
              !!sponsor.wallet.announcementTransaction.hash
          },
          downlineLevel: (sponsor.downlineLevel || 0) + 1,
          downlineSize: 0
        };
        newUser.name = self.fullName(newUser);
        newUser.profilePhotoUrl = self.generateProfilePhotoUrl(newUser);
        return self.db.ref(`/users/${newUserId}`).set(newUser);
      }).then(() => {
        // add new user to sponsor's downline users
        return sponsorRef.child(`downlineUsers/${newUserId}`).set({ name: newUser.name, profilePhotoUrl: newUser.profilePhotoUrl });
      }).then(() => {
        // get downline size of sponsor...
        return sponsorRef.child(`downlineSize`).once('value');
      }).then((snapshot: firebase.database.DataSnapshot) => {
        // ...and increment it by one.
        let sponsorDownlineSize: number = _.isNumber(snapshot.val()) ? snapshot.val() : 0;
        return sponsorRef.child(`downlineSize`).set(sponsorDownlineSize + 1);
      }).then(() => {
        log.debug(`  processed invitation of ${newUserId} by ${task.sponsorUserId}`);
        self.resolveTask(queue, task, resolve, reject);
      }, (error) => {
        self.rejectTask(queue, task, error, reject);
        return;
      });
    });
    return [queue];
  }

}
