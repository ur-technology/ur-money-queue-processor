import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import { QueueProcessor } from './queue_processor';

export class UserQueueProcessor extends QueueProcessor {
  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/userQueue/specs/user_password_change", {
        "start_state": "user_password_change_requested",
        "in_progress_state": "user_password_change_in_progress",
        "finished_state": "user_password_change_finished",
        "error_state": "user_password_change_error",
        "timeout": 5 * 60 * 1000
      }),
      this.ensureQueueSpecLoaded("/userQueue/specs/user_check_password", {
        "start_state": "user_check_password_requested",
        "in_progress_state": "user_check_password_in_progress",
        "finished_state": "user_check_password_finished",
        "error_state": "user_check_password_error",
        "timeout": 5 * 60 * 1000
      })
    ];
  }

  process(): any[] {
    return [
      this.processChangePasswordQueue(), this.processCheckPassword()
    ];
  }

  private processChangePasswordQueue() {
    let self = this;
    let queueRef = self.db.ref("/userQueue");
    let options = { 'specId': 'user_password_change', 'numWorkers': 3, 'sanitize': false };
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(queue, task);
      if (!task.clientHashedPassword) {
        self.rejectTask(queue, task, 'expecting clientHashedPassword', reject);
        return;
      }

      self.generateHashedPassword(task).then((serverHashedPassword) => {
        self.db.ref(`/users/${task.userId}`).update({ serverHashedPassword: serverHashedPassword });
        task.result = { state: 'user_password_change_succeeded' };
        self.resolveTask(queue, task, resolve, reject);
      });

    });
    return queue;
  }

  private processCheckPassword() {
    let self = this;
    let options = { specId: 'user_check_password', numWorkers: 5, sanitize: false };
    let queueRef = self.db.ref('/userQueue');
    let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {

      self.startTask(queue, task);

      if (!task.clientHashedPassword) {
        self.rejectTask(queue, task, 'expecting clientHashedPassword', reject);
        return;
      }

      let user: any;
      self.lookupUserById(task.userId).then((matchedUser: any[]) => {
        user = matchedUser;
        if (!user) {
          task.result = { state: 'user_check_password_canceled_because_user_not_found' };
          self.resolveTask(queue, task, resolve, reject);
        }
        return self.generateHashedPassword(task);
      }).then((hashedPassword: string) => {
        if (user.serverHashedPassword !== hashedPassword) {
          task.result = { state: 'user_check_password_canceled_because_wrong_password' };
          self.resolveTask(queue, task, resolve, reject);
        }

        task.result = { state: 'user_check_password_succeded' };
        self.resolveTask(queue, task, resolve, reject);
      });

    });
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
