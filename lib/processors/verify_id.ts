import { QueueProcessor } from './queue_processor';

import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';

// This is the minimum confidence threshold for the selfie matcher. 
// It's a percentage, so 100 would only allow for perfect matches,
// and 1 would match almost anything.
const selfieMatchThreshold = 75;

var request = require('request-promise');
var tmp = require('tempfile');
import fs = require('fs');

interface idScanRequest {
    id: string; // user ID
    type: string; // 'national' or 'passport'
    regionSet: string;
    result: any;
    _new_state: string;
    state: string;
    frontImage: Blob;
}

type handlerResponse = Promise<any>;

export class VerifyIDQueueProcessor extends QueueProcessor {

    init(): Promise<any>[] {

        return [
            this.ensureQueueSpecLoaded("/verifyIDQueue/specs/verify_id", {
                "in_progress_state": "id_verification_in_progress",
                "finished_state": "id_verification_success",
                "error_state": "id_verification_error",
                "timeout": 5 * 60 * 1000
            }),
            this.ensureQueueSpecLoaded("/verifySelfieQueue/specs/verify_selfie", {
                "in_progress_state": "selfie_verification_in_progress",
                "finished_state": "selfie_verification_success",
                "error_state": "selfie_verification_error",
                "timeout": 5 * 60 * 1000
            })
        ];
    }

    process(): any[] {
        return [
            this.processVerifyIDSpec(),
            this.processVerifySelfieSpec()
        ]
    }

    private processVerifyIDSpec() {

        let self = this;
        let options = { 'specId': 'verify_id', 'numWorkers': 8, 'sanitize': false };
        let queueRef = self.db.ref('/verifyIDQueue');

        let queue = new self.Queue(queueRef, options, (task: idScanRequest, progress: any, resolve: any, reject: any) => {

            self.startTask(queue, task);

            let p: handlerResponse;

            switch (task.type) {

                case 'national':
                    p = this.idVerifier.handleNationalIDScanVerification(task.id, task.regionSet);
                    break;

                default:
                    self.rejectTask(queue, task, 'unknown ID type: ' + task.type, reject)
                    return;
            }

            p.then(
                () => {
                    task._new_state = 'id_verification_success';
                    task.result = { state: task._new_state };
                    self.resolveTask(queue, task, resolve, reject);
                },
                (error) => {
                    task._new_state = 'id_verification_error';
                    task.result = { state: task._new_state, error: error };
                    self.resolveTask(queue, task, resolve, reject)
                });
        });

        return queue;
    }

    private processVerifySelfieSpec() {

        let self = this;
        let options = { 'specId': 'verify_selfie', 'numWorkers': 8, 'sanitize': false };
        let queueRef = self.db.ref('/verifySelfieQueue');

        let queue = new self.Queue(queueRef, options, (task: idScanRequest, progress: any, resolve: any, reject: any) => {

            self.startTask(queue, task);

            this.idVerifier.bypassSelfieMatch(task.id).then(
                () => {
                    task._new_state = 'selfie_verification_success';
                    task.result = { state: task._new_state };
                    self.resolveTask(queue, task, resolve, reject);
                },
                (error) => {
                    task._new_state = 'selfie_verification_error';
                    task.result = { state: task._new_state, error: error };
                    self.resolveTask(queue, task, resolve, reject)
                });
        });

        return queue;
    }
}
