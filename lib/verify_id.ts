import { QueueProcessor } from './queue_processor';

import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';

var request = require('request-promise');

interface idScanRequest {
    id: string; // user ID
    type: string; // 'national' or 'passport'
    regionSet: string;
    result: any;
    _new_state: string;
    state: string;
}

type handlerResponse = Promise<any>;

export class VerifyIDQueueProcessor extends QueueProcessor {

    storageRef: firebase.storage.Reference;

    init(): Promise<any>[] {

        return [
            this.ensureQueueSpecLoaded("/verifyIDQueue/specs/verify_id", {
                "in_progress_state": "id_verification_in_progress",
                "finished_state": "id_verification_success",
                "error_state": "id_verification_error",
                "timeout": 5 * 60 * 1000
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
        let options = { 'specId': 'verify_id', 'numWorkers': 8, 'sanitize': false };
        let queueRef = self.db.ref('/verifyIDQueue');

        let queue = new self.Queue(queueRef, options, (task: idScanRequest, progress: any, resolve: any, reject: any) => {

            self.startTask(queue, task);

            let p: handlerResponse;

            switch (task.type) {

                case 'national':
                    p = this.handleNationalIDScanVerification(task.id, task.regionSet);
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

    private handleNationalIDScanVerification(userId: string, regionSet: string): handlerResponse {

        let params: any[] = [
            regionSet, // REGIONSET
            true, // AUTODETECTSTATE
            -1, // PROCSTATE
            true, // GETFACEIMAGE
            true, // GETSIGNIMAGE
            true, // REFORMATIMAGE
            0, // REFORMATIMAGECOLOR
            150, // REFORMATIMAGEDPI
            105, // IMAGESOURCE
            true // USEPREPROCESSING
        ];

        let paramString = _.join(_.map(params, _.toString), '/');

        var options = {
            method: 'POST',
            uri: this.acuantURL(`ProcessDLDuplex/${paramString}`),
            headers: {
                'Authorization': this.acuantAuthHeader(),
            },
            json: true
        };

        return new Promise((resolve, reject) => {

            request(options)
                .then((response: any) => {
                    console.log('A');
                    resolve()
                },
                (err: any) => {
                    console.log('B');
                    reject('failed to contact remote host');
                });
        });
    }

    private acuantURL(path: string): string {
        return 'https://cssnwebservices.com/CSSNService/CardProcessor/' + path;
    }

    private acuantAuthHeader(): string {
        // FIXME! Move to config   
        return 'LicenseKey ' + new Buffer('EE92924A123D').toString('base64');
    }

    private userIDPhotoURL(userID: string, fileName: string): string {
        return 'user/' + userID + '/id-images/' + fileName;
    }

    private userIDPhotoRef(userID: string, fileName: string): firebase.storage.Reference {
        return firebase.storage().ref(this.userIDPhotoURL(userID, fileName));
    }
}
