import { QueueProcessor } from './queue_processor';

import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';

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

        let options: any = this.acuantRequestOptions(regionSet);

        return new Promise((resolve, reject) => {

            this.readUserIDPhoto(userId, 'national-id-front.jpg')

                // Read the front image
                .then((data: fs.ReadStream) => {
                    options.formData.frontImage = data;
                    return this.readUserIDPhoto(userId, 'national-id-back.jpg');
                },
                // Failed to read the front image
                (error) => {
                    reject(error);
                })

                // Read the back image
                .then((data: fs.ReadStream) => {
                    options.formData.backImage = data;
                    return request(options);
                },
                // Failed to read the back image
                (error) => {
                    reject(error);
                })

                // Acuant connection succeeded
                .then((response: any) => {

                    let error: string = (response.ResponseCodeAuthorization < 0 && response.ResponseCodeAuthorization) ||
                        (response.ResponseCodeAutoDetectState < 0 && response.ResponseCodeAutoDetectState) ||
                        (response.ResponseCodeProcState < 0 && response.ResponseCodeProcState) ||
                        (response.WebResponseCode < 1 && response.WebResponseCode);

                    if (error) {
                        reject(`error processing id: ${error}`);
                    }

                    // FIXME! Make sure ID hasn't been used before

                    // FIXME! This isn't working. Image is invalid
                    return this.uploadUserIDPhoto(userId, 'id-face-image.jpg', response.FaceImage);
                },
                // Acuant connection failed
                (err: any) => {
                    reject('failed to contact remote host');
                })

                // Face image upload succeeded
                .then(() => {

                    // FIXME! Store ID card data

                    reject('debug');
                    // resolve()
                },
                // Face image upload failed
                (error) => {
                    reject(error);
                })
                ;
        });
    }

    private acuantRequestOptions(regionSet: string): any {

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

        let options: any = {
            method: 'POST',
            uri: this.acuantURL(`ProcessDLDuplex/${paramString}`),
            headers: {
                'Authorization': this.acuantAuthHeader(),
            },
            formData: {},
            timeout: 25000,
            json: true,
        };

        return options;
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

    private userIDPhotoRef(userID: string, fileName: string): any {
        return this.storage.file(this.userIDPhotoURL(userID, fileName));
    }

    private downloadFile(remoteFile: any): Promise<string> {

        var localFilename = tmp('.jpg');

        return new Promise((resolve, reject) => {

            remoteFile.createReadStream()
                .on('error', (err: any) => {
                    reject(err);
                })
                .pipe(fs.createWriteStream(localFilename))
                .on('error', (err: any) => {
                    reject(err);
                })
                .on('finish', function() {
                    resolve(localFilename);
                })
        });
    }

    private uploadFile(localFile: string, remoteFileRef: any): Promise<any> {

        return new Promise((resolve, reject) => {
            fs.createReadStream(localFile)
                .pipe(remoteFileRef.createWriteStream({
                    metadata: {
                        contentType: 'image/jpeg',
                    }
                }))
                .on('error', function(err: any) { reject(err) })
                .on('finish', function() {
                    resolve();
                });
        });
    }

    private downloadUserIDPhoto(userID: string, fileName: string): Promise<string> {
        return this.downloadFile(this.userIDPhotoRef(userID, fileName));
    }

    private uploadUserIDPhoto(userID: string, fileName: string, data: any): Promise<any> {

        let tmpfilename: string;

        return new Promise((resolve, reject) => {

            this.writeFile(data)

                // Write succeeded
                .then((filename) => {

                    // Store temp file name for later deletion
                    tmpfilename = filename;

                    return this.uploadFile(filename, this.userIDPhotoRef(userID, fileName));
                },

                // Write failed
                (error) => {
                    reject(error)
                })

                // Upload succeded
                .then(() => {
                    resolve();
                },

                // Upload failed
                (error) => {
                    reject(error);
                })
                ;
        });
    }

    private readFile(path: string): Promise<fs.ReadStream> {

        return new Promise((resolve, reject) => {
            resolve(fs.createReadStream(path));
        });
    }

    private writeFile(data: any): Promise<string> {

        var localFilename = tmp();

        return new Promise((resolve, reject) => {
            fs.writeFile(localFilename, data, (err) => {

                if (err) {
                    reject(err);
                }

                resolve(localFilename);
            });
        });
    }

    private readUserIDPhoto(userID: string, fileName: string): Promise<fs.ReadStream> {

        return new Promise((resolve, reject) => {

            let tmpfilename: string;

            this.downloadUserIDPhoto(userID, fileName)

                // Once downloaded and in a temp file
                .then((filename: string) => {
                    tmpfilename = filename;
                    return this.readFile(filename);
                },
                // Failed to download
                (error) => {
                    reject(error);
                })

                // File read from disk successfully
                .then((data: fs.ReadStream) => {
                    fs.unlink(tmpfilename);
                    resolve(data);
                },
                // Failed to read from disk
                (error) => {
                    reject(error);
                });
        });
    }
}
