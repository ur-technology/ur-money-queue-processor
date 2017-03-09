import { HandlerResponse } from '../interfaces/id-verifier';

import * as _ from 'lodash';
import * as log from 'loglevel';

var request = require('request-promise');
var tmp = require('tempfile');
import fs = require('fs');

// This is the minimum confidence threshold for the selfie matcher. 
// It's a percentage, so 100 would only allow for perfect matches,
// and 1 would match almost anything.
const selfieMatchThreshold = 75;

export class AcuantIDVerifier {

    constructor(
        private db: any,
        private storage: any,
        private apiKey: string
    ) {
    }

    handleNationalIDScanVerification(userId: string, regionSet: string): HandlerResponse {

        let options: any = this.acuantDuplexIDVerficationRequestOptions(regionSet);
        let faceImage: any;
        let idCardData: any;

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
                        this.updateUserRecord(userId, {
                            idUploaded: true,
                            signUpBonusApproved: false,
                            idRecognitionStatus: 'National ID not recognised by Acuant'
                        })
                            .then(() => {
                                reject(`error processing id: ${error}`);
                            },
                            (error2) => {
                                reject(`error processing id: ${error}, and database updated failed: ${error2}`);
                            });

                    } else {

                        idCardData = response;
                        faceImage = response.FaceImage;

                        return this.assertIdUniqueness(this.idHash(response), userId);
                    }
                },
                // Acuant connection failed
                (err: any) => {
                    reject('failed to contact remote host');
                })

                // ID is unique
                .then(() => {
                    return this.uploadUserIDPhoto(userId, 'id-face-image.jpg', faceImage);
                },
                // ID is not unique
                (error) => {
                    reject('Failed to assert uniqueness: ' + error);
                })

                // Face image upload succeeded
                .then(() => {
                    return this.updateUserRecord(userId, {
                        idHash: this.idHash(idCardData),
                        idCardData: _.omitBy(idCardData, _.isArray),
                        idUploaded: true,
                        firstName: this.properNounCase(idCardData.NameFirst),
                        middleName: this.properNounCase(idCardData.NameMiddle),
                        lastName: this.properNounCase(idCardData.NameLast),
                        idRecognitionStatus: 'National ID successfully recognised by Acuant'
                    });
                },
                // Face image upload failed
                (error) => {
                    reject(error);
                })

                // Database record update succeeded
                .then(() => {
                    resolve();
                },
                // Database record update failed
                (error) => {
                    reject(error);
                })
        });
    }

    matchSelfie(userID: string): Promise<any> {

        let options = this.acuantFaceMatchRequestOptions();

        return new Promise((resolve, reject) => {

            this.readUserIDPhoto(userID, 'id-face-image.jpg')

                // Read the id-face image
                .then((data: fs.ReadStream) => {
                    options.formData.photo1 = data;
                    return this.readUserIDPhoto(userID, 'selfie.jpg');
                },
                // Failed to read the id-face image
                (error) => {
                    reject(error);
                })

                // Read the selfie image
                .then((data: fs.ReadStream) => {
                    options.formData.photo2 = data;
                    return request(options);
                },
                // Failed to read the selfie image
                (error) => {
                    reject(error);
                })

                // Acuant connection succeeded
                .then((response: any) => {

                    let bonusApproved = true;
                    let statusMessage = `Selfie match succeeded; confidence rating ${response.FacialMatchConfidenceRating}%`;

                    if (!response.FacialMatch || response.FacialMatchConfidenceRating < selfieMatchThreshold) {
                        bonusApproved = false;
                        statusMessage = `Selfie match failed; confidence rating ${response.FacialMatchConfidenceRating}%`;
                        reject(`Can't automatically match selfie`);
                    }

                    return this.updateUserRecord(userID, {
                        faceMatchData: response,
                        selfieMatched: true,
                        selfieConfidence: response.FacialMatchConfidenceRating,
                        signUpBonusApproved: bonusApproved,
                        selfieMatchStatus: statusMessage,
                    });
                },
                // Acuant connection failed
                (err: any) => {
                    reject('failed to contact remote host');
                })

                // Database record update succeeded
                .then(() => {
                    resolve();
                },
                // Database record update failed
                (error) => {
                    reject(error);
                })
        });
    }

    private properNounCase(input: string): string {
        return input.charAt(0).toUpperCase() + input.slice(1).toLowerCase();
    }

    private updateUserRecord(userID: string, data: any): Promise<any> {
        let currentUserRef = this.db.ref(`/users/${userID}`);
        return currentUserRef.update(data);
    }

    // Genererate a deterministic hash that uniquely identifies an ID
    private idHash(idObject: any): string {
        return new Buffer(idObject.Id + idObject.IdCountry + idObject.CardType).toString('base64')
    }

    private assertIdUniqueness(idHash: string, userID: string): Promise<any> {

        return new Promise((resolve, reject) => {

            this.lookupUsers(this.db.ref("/users").orderByChild("idHash").equalTo(idHash))

                // Got results from DB
                .then((results) => {

                    if (results.length > 0) {
                        reject('That ID has been used before');
                    }

                    resolve();
                },
                // DB lookup failed
                (error) => {
                    reject(error);
                })
                ;
        });
    }

    private acuantDuplexIDVerficationRequestOptions(regionSet: string): any {

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

    private acuantFaceMatchRequestOptions(): any {

        let options: any = {
            method: 'POST',
            uri: this.acuantURL(`FacialMatch`),
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
        return 'LicenseKey ' + new Buffer(this.apiKey).toString('base64');
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

        let localFilename = tmp();

        let byteArray: Uint8Array = new Uint8Array(data);
        let buf = new Buffer(byteArray.buffer.byteLength);

        for (let i = 0; i < buf.length; ++i) {
            buf[i] = byteArray[i];
        }

        return new Promise((resolve, reject) => {
            fs.writeFile(localFilename, buf, (err) => {

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

    private lookupUsers(ref: any): Promise<any[]> {
        let self = this;
        return new Promise((resolve, reject) => {
            ref.once("value", (snapshot: firebase.database.DataSnapshot) => {

                // sort matching users with most completely signed up users first
                let userMapping = snapshot.val() || {};
                let users = _.values(userMapping);
                let userIds = _.keys(userMapping);
                _.each(users, (user: any, index: number) => { user.userId = userIds[index]; });
                resolve(users);
            }, (error: string) => {
                reject(error);
            });
        });
    };

}
