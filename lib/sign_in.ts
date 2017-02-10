import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class SignInQueueProcessor extends QueueProcessor {
  private twilioLookupsClient: any; // used to look up carrier type via twilio
  private twilioRestClient: any; // used to send messages via twilio

  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/signInQueue/specs/sign_in", {
        "in_progress_state": "sign_in_in_progress",
        "finished_state": "sign_in_storage_finished",
        "error_state": "sign_in_storage_error",
        "timeout": 5*60*1000
      })
    ];
  }

  process(): any[] {
    return [
      this.processSignInSpec()
    ]
  }

  private processSignInSpec() {
    let self = this;
    let options = { 'specId': 'sign_in', 'numWorkers': 8, 'sanitize': false };
    let queueRef = self.db.ref('/signInQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);

      if (!task.phone || !task.clientHashedPassword) {
        self.rejectTask(queue, task, 'expecting phone and clientHashedPassword', reject);
        return;
      }

      let user: any;
      self.lookupUsersByPhone(task.phone).then((matchingUsers: any[]) => {
        if (_.isEmpty(matchingUsers)) {
          throw 'sign_in_canceled_because_user_not_found';
        }
        user = matchingUsers[0];
        task.userId = user.userId;
        if (user.disabled) {
          throw 'sign_in_canceled_because_user_disabled';
        }
        return self.generateHashedPassword(task);
      }).then((serverHashedPassword: string) => {
        if (user.serverHashedPassword !== serverHashedPassword) {
          throw 'sign_in_canceled_because_password_incorrect';
        }
        return self.auth.createCustomToken(task.userId, { tokenVersion: 4 });
      }).then((customToken: string) => {
        task._new_state = 'sign_in_finished';
        task.result = { passwordMatch: true, state: task._new_state, authToken: customToken };
        self.resolveTask(queue, task, resolve, reject);
      }, (error: any) => {
        if (_.isString(error) && /^sign_in_canceled_/.test(error)) {
          task._new_state = error;
          task.result = { passwordMatch: false, state: task._new_state };
          self.resolveTask(queue, task, resolve, reject);
        } else {
          task.result = { passwordMatch: false, state: 'sign_in_error', error: error };
          self.rejectTask(queue, task, error, reject);
        }
      });
    });
    return queue;
  }

  private generateHashedPassword(task: any): Promise<string> {
    return new Promise((resolve, reject) => {
      let scryptAsync = require('scrypt-async');
      scryptAsync(task.clientHashedPassword, task.userId, { N: 16384, r: 16, p: 1, dkLen: 64, encoding: 'hex' }, (serverHashedPassword: string) => {
        resolve(serverHashedPassword);
      });
    });
  }


}
