import { QueueProcessor } from '../processors/queue_processor';
import { HandlerResponse } from '../interfaces/id-verifier';

var unirest = require('unirest');

export class ManualIDVerifier {

    constructor(
        private db: any,
        private storage: any) {
    }

    handleNationalIDScanVerification(userId: string, regionSet: string): HandlerResponse {

        return this.updateUserRecord(userId, {
            signUpBonusApproved: false,
            idUploaded: true,
            idRecognitionStatus: 'National ID pending manual verification'
        });
    }

    /*
    Don't even try to match the selfie; just update the database and let a human fix it.
    */
    matchSelfie(userID: string): Promise<any> {
        return this.updateUserRecord(userID, {
            selfieMatched: true,
            selfieConfidence: 0,
            signUpBonusApproved: false,
            selfieMatchStatus: "Automatic selfie match pending manual verification",
        });
    }

    /*
    Send the user record and all its images off to freshdesk
    */
    registerManualVerification(userID: string): Promise<any> {

        return new Promise((resolve, reject) => {

            this.lookupUserById(userID)

                // User loaded successfull
                .then((user) => {

                    if (user.freshdeskUrl) {
                        resolve();
                        return;
                    }

                    return this.notifyFreshdesk(user);
                },
                // User failed to load
                (error) => {
                    reject("Failed to find user in database: " + error);
                })

                // Freshdesk notified sucessfully
                .then((freshdeskURL: string) => {
                    return this.updateUserRecord(userID, {
                        selfieMatched: true,
                        selfieConfidence: 0,
                        signUpBonusApproved: false,
                        freshdeskUrl: freshdeskURL,
                        selfieMatchStatus: "Selfie match deferred to " + freshdeskURL,
                    });
                },
                // Freshdesk notification failed
                (error) => {
                    reject("Failed to notify freshdesk: " + error)
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

    private notifyFreshdesk(user: any): Promise<string> {

        return new Promise((resolve, reject) => {

            this.freshdeskMarkup(user)

                // Got markup
                .then((markup: string) => {

                    let PATH = "/api/v2/tickets";
                    let URL = "https://" + QueueProcessor.env.FRESHDESK_DOMAIN + ".freshdesk.com" + PATH;

                    var fields = {
                        'name': user.name,
                        'email': user.email,
                        'phone': user.phone,
                        'subject': `'Identity verification required for ${user.name} (${user.email}, ${user.countryCode})`,
                        'description': markup,
                        'status': 2,
                        'priority': 1,
                        'tags': [
                            'auto-generated',
                            'verification',
                            'country: ' + user.countryCode,
                        ]
                    }

                    var Request = unirest.post(URL);

                    Request.auth({
                        user: QueueProcessor.env.FRESHDESK_API_KEY,
                        pass: "X",
                        sendImmediately: true
                    })
                        .type('json')
                        .send(fields)
                        .end(function(response: any) {
                            if (response.status == 201) {
                                resolve(response.headers['location']);
                            }
                            else {
                                reject("Failed to create ticket. Status: " + response.status);
                            }
                        });
                },
                (error) => {
                    reject(error);
                });
        })
    }

    private freshdeskMarkup(user: any): Promise<string> {

        let frontUrl: string, backUrl: string, selfieUrl: string;

        return new Promise((resolve, reject) => {

            this.publicImageURL(user.userId, 'national-id-front.jpg')

                // Got front URL successfully
                .then((url: string) => {
                    frontUrl = url;
                    return this.publicImageURL(user.userId, 'national-id-back.jpg');
                },
                // Failed to get front URL
                (error) => {
                    reject(error);
                })


                // Got back URL successfully
                .then((url: string) => {
                    backUrl = url;
                    return this.publicImageURL(user.userId, 'selfie.jpg');
                },
                // Failed to get front URL
                (error) => {
                    reject(error);
                })

                // Got selfie URL successfully
                .then((url: string) => {
                    selfieUrl = url;
                    resolve(`
<p><a href="${this.appLink({ redirect: 'user', id: user.userId })}" target="_blank">${user.name}</a> requires manual verification.</p>

<br />
<h3>User details</h3>
<hr />
<table>
	<tr>
		<td>Database ID</td>
		<td>${user.userId}</td>
	</tr>
	<tr>
		<td>Country code</td>
		<td>${user.countryCode}</td>
	</tr>
	<tr>
		<td>Email address</td>
		<td>${user.email}</td>
	</tr>
	<tr>
		<td>Phone number</td>
		<td>${user.phone}</td>
	</tr>
	<tr>
		<td>First name</td>
		<td>${user.firstName}</td>
	</tr>
	<tr>
		<td>Middle name</td>
		<td>${user.middleName}</td>
	</tr>
	<tr>
		<td>Last name</td>
		<td>${user.lastName}</td>
	</tr>
	<tr>
		<td>Display name (chosen by user)</td>
		<td>${user.name}</td>
	</tr>
	<tr>
		<td>ID recognition status</td>
		<td>${user.idRecognitionStatus}</td>
	</tr>
	<tr>
		<td>Sponsor</td>
		<td><a href="${this.appLink({ redirect: 'user', id: user.sponsor.userId })}" target="_blank">${user.sponsor.name}</a></td>
	</tr>
</table>

<br />
<h3>Provided images</h3>
<hr />

<img src="${frontUrl}"/>
<img src="${backUrl}"/>
<img src="${selfieUrl}"/>

<br />
<br />
<h3>Actions</h3>
<hr />

<p><a href="${this.appLink({ redirect: 'user', id: user.userId, approve: true })}" target="_blank">Approve</a> | <a href="${this.appLink({ redirect: 'user', id: user.userId })}" target="_blank">View record</a></p>
                            `)
                },
                // Failed to get selfie URL
                (error) => {
                    reject(error);
                })

        });
    }

    private appLink(args: any): string {

        let str = QueueProcessor.env.APP_BASE_URL + '?admin-redirect=true';

        for (var key in args) {
            if (str != "") {
                str += "&";
            }
            str += key + "=" + encodeURIComponent(args[key]);
        }

        return str;
    }

    private publicImageURL(userId: string, path: string): Promise<string> {

        var config = {
            action: 'read',
            expires: '05-31-2017'
        };

        return new Promise((resolve, reject) => {
            this.userIDPhotoRef(userId, path).getSignedUrl(config, function(err: any, url: string) {
                if (err) {
                    reject(err);
                    return;
                }

                resolve(url);
            });
        })
    }

    private updateUserRecord(userID: string, data: any): Promise<any> {
        let currentUserRef = this.db.ref(`/users/${userID}`);
        return currentUserRef.update(data);
    }

    private userIDPhotoURL(userID: string, fileName: string): string {
        return 'user/' + userID + '/id-images/' + fileName;
    }

    private userIDPhotoRef(userID: string, fileName: string): any {
        return this.storage.file(this.userIDPhotoURL(userID, fileName));
    }

    lookupUserById(userId: string): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            let userRef = self.db.ref(`/users/${userId}`);
            userRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
                let user: any = snapshot.val();
                if (user) {
                    user.userId = userId;
                    resolve(user);
                } else {
                    let error = `no user exists at location ${userRef.toString()}`
                    log.warn('  ' + error);
                    reject(error);
                }
            });
        });
    }
}
