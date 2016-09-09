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
    let queue = new self.Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      try { // TODO: remove this try
        self.lookupUsersByPhone(data.invitee.phone).then((result) => {
          let matchingUser: any = _.first(result.matchingUsers);
          if (matchingUser && matchingUser.identityVerificationRequestedAt) {
            reject(`Sorry, ${matchingUser.name} has already signed up with UR Money.`);
            return;
          }

          self.lookupUserById(data.sponsorUserId).then((sponsor: any) => {
            // add new user to users list
            let newUser: any = {
              createdAt: firebase.database.ServerValue.TIMESTAMP,
              firstName: data.invitee.firstName,
              middleName: data.invitee.middleName,
              lastName: data.invitee.lastName,
              phone: data.invitee.phone,
              sponsor: {
                userId: data.sponsorUserId,
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
            let sponsorRef = self.db.ref(`/users/${data.sponsorUserId}`);
            sponsorRef.child(`downlineUsers/${newUserId}`).set({ name: newUser.name, profilePhotoUrl: newUser.profilePhotoUrl });
            log.debug(`processed invitation of ${newUserId} (${newUser.name}) by ${data.sponsorUserId}`);
            self.resolveIfPossible(resolve, reject, data);
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

  private lookupUserById(userId: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      let userRef = self.db.ref(`/users/${userId}`);
      userRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
        let user = snapshot.val();
        if (user) {
          resolve(user);
        } else {
          let error = `no user exists at location ${userRef.toString()}`
          log.warn(error);
          reject(error);
        }
      });
    });
  }

}
