import * as log from 'loglevel';
import * as _ from 'lodash';
import {QueueProcessor} from './queue_processor';

export class InvitationQueueProcessor extends QueueProcessor {
  init(): Promise<any>[] {
    return [];
  }

  process(): any[] {
    let self = this;
    let queueRef = self.db.ref("/invitationQueue");
    let options = { 'numWorkers': 1 };
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);
      try { // TODO: remove this try
        self.lookupUsersByPhone(task.invitee.phone).then((result) => {
          let matchingUser: any = _.first(result.matchingUsers);
          if (matchingUser && matchingUser.identityVerificationRequestedAt) {
            reject(`Sorry, ${matchingUser.name} has already signed up with UR Money.`);
            return;
          }

          self.lookupUserById(task.sponsorUserId).then((sponsor: any) => {
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
              downlineLevel: sponsor.downlineLevel + 1
            };
            newUser.name = self.fullName(newUser);
            newUser.profilePhotoUrl = self.generateProfilePhotoUrl(newUser.name);
            let newUserRef = self.db.ref('/users').push(newUser);

            // add new user to sponsor's downline users
            let newUserId = newUserRef.key;
            let sponsorRef = self.db.ref(`/users/${task.sponsorUserId}`);
            sponsorRef.child(`downlineUsers/${newUserId}`).set({ name: newUser.name, profilePhotoUrl: newUser.profilePhotoUrl });
            log.debug(`processed invitation of ${newUserId} (${newUser.name}) by ${task.sponsorUserId}`);
            self.logAndResolveIfPossible(queue, task, resolve, reject);
          });
        }, (error) => {
          reject(error);
          return;
        });
      } catch (e) {
        reject(e.message);
        return;
      }
    });
    return [queue];
  }

}
