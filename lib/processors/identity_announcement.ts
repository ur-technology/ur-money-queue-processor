import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import { QueueProcessor } from './queue_processor';
import { BigNumber } from 'bignumber.js';

export class IdentityAnnouncementQueueProcessor extends QueueProcessor {
    init(): Promise<any>[] {

        return [

            this.ensureQueueSpecLoaded("/walletCreatedQueue/specs/wallet_created", {
                "in_progress_state": "processing",
                "error_state": "error",
                "timeout": 120000,
            }),

            this.ensureQueueSpecLoaded("/identityAnnouncementQueue/specs/announce_identity", {
                "start_state": "ready_to_announce",
                "in_progress_state": "processing",
                "error_state": "error",
                "timeout": 120000,
                "retries": 10
            })
        ];
    }

    process(): any[] {
        return [
            this.processWalletCreated(),
            this.processIdentityAnnouncement(),
        ]
    }

    private processWalletCreated(): any {

        let self = this;
        let queueRef = self.db.ref("/walletCreatedQueue");
        let options = { 'specId': 'wallet_created', 'numWorkers': 1, 'sanitize': false };

        let idAnnouncementQueueRef = self.db.ref("/identityAnnouncementQueue/tasks");

        let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {

            self.startTask(queue, task);
            let userId: string = task.userId;

            this.lookupUserNeedingAnnouncementTransaction(userId)

                // user is allowed to receive their reward
                .then(() => {
                    return idAnnouncementQueueRef.push({
                        userId: userId,
                        _state: 'ready_to_announce',
                    });
                },
                (error) => {
                    // Resolve the task to remove it from the queue
                    self.resolveTask(queue, task, resolve, reject);
                })

                // Task has been successfully pushed to ID announcement queue
                .then(() => {
                    self.resolveTask(queue, task, resolve, reject);
                },
                (error) => {
                    self.rejectTask(queue, task, error, reject);
                });

        });
        return queue;
    }

    private processIdentityAnnouncement(): any {
        let self = this;
        let queueRef = self.db.ref("/identityAnnouncementQueue");
        let options = { 'specId': 'announce_identity', 'numWorkers': 1, 'sanitize': false };
        let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
            self.startTask(queue, task);
            let userId: string = task.userId;
            if (!QueueProcessor.web3().isConnected() || !QueueProcessor.web3().eth) {
                self.rejectTask(queue, task, 'unable to get connection to transaction relay', reject);
                return;
            }

            let toAddress: string;
            self.lookupUserNeedingAnnouncementTransaction(userId).then((user: any) => {
                toAddress = user.wallet.address;
                return self.lookupSponsorAnnouncementTransaction(user);
            }).then((sponsorAnnouncementTransaction: any) => {
                return self.buildAnnouncementTransaction(toAddress, sponsorAnnouncementTransaction);
            }).then((announcementTransaction) => {
                return self.publishAnnouncementTransaction(userId, announcementTransaction);
            }).then(() => {
                self.resolveTask(queue, task, resolve, reject);
            }, (error) => {
                if (error === 'sponsor-lacks-announcement-transaction') {
                    self.resolveTask(queue, task, resolve, reject);
                } else {
                    self.rejectTask(queue, task, `got error during identity verification announcement: ${error}`, reject);
                }
            });
        });
        return queue;
    }

    private lookupUserNeedingAnnouncementTransaction(userId: string): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            self.lookupUserById(userId).then((user: any) => {
                let status = self.registrationStatus(user);
                let disallowedStatuses = [
                    'announcement-requested',
                    'announcement-initiated',
                    'announcement-confirmed'
                ];
                if (_.includes(disallowedStatuses, status)) {
                    reject(`unexpected status ${status} before announcement`);
                } else if (user.disabled) {
                    reject('user is disabled');
                } else if (!user.signUpBonusApproved) {
                    reject('user requres approval to receive a sign up bonus');
                } else if (!user.wallet || !user.wallet.address) {
                    reject('user lacks wallet address');
                } else if (user.wallet.announcementTransaction && user.wallet.announcementTransaction.blockNumber) {
                    reject('user already has an announcement transaction');
                } else {
                    resolve(user);
                }
            }, (error) => {
                reject(error);
            });
        });
    }

    private lookupSponsorAnnouncementTransaction(user: any): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            if (user.phone === '+16196746211') { // top-level user needs no wallet
                resolve(undefined);
                return;
            } else if (!user.sponsor || !user.sponsor.userId) {
                reject('No sponsor user id available');
                return;
            }

            self.lookupUserById(user.sponsor.userId).then((sponsor: any) => {
                if (!sponsor) {
                    reject('Could not find associated sponsor');
                } else if (sponsor.disabled) {
                    reject('Sponsor is disabled');
                } else if (!sponsor.wallet || !sponsor.wallet.announcementTransaction || !sponsor.wallet.announcementTransaction.blockNumber || !sponsor.wallet.announcementTransaction.hash) {
                    reject('sponsor-lacks-announcement-transaction');
                } else {
                    resolve(sponsor.wallet.announcementTransaction);
                }
            }, (error) => {
                reject(error);
            });
        });
    }

    private publishAnnouncementTransaction(userId: string, announcementTransaction: any): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            let address = QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_ADDRESS;
            let password = QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_PASSWORD;
            let val: any;
            try {
                val = QueueProcessor.web3().personal.unlockAccount(address, password, 1000);
            } catch (error) {
                reject(`got error when attempting to unlock account ${address}: ${error}`);
                return;
            }

            let registrationRef = self.db.ref(`/users/${userId}/registration`);
            registrationRef.update({ status: "announcement-requested" });
            QueueProcessor.web3().eth.sendTransaction(announcementTransaction, (error: string, announcementTransactionHash: string) => {
                registrationRef.update({
                    status: error ? "announcement-failed" : "announcement-initiated",
                    announcementFinalizedAt: firebase.database.ServerValue.TIMESTAMP
                });
                if (error) {
                    reject(`error sending announcement transaction ${announcementTransactionHash}: ${error}`);
                    return;
                }
                self.db.ref(`/users/${userId}/wallet/announcementTransaction`).set({
                    hash: announcementTransactionHash
                });
                console.log(`successfully sent announcement transaction ${announcementTransactionHash} for user ${userId}`);
                resolve();
            });
        });
    }

    private buildAnnouncementTransaction(to: string, sponsorAnnouncementTransaction: any): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            let announcementTransaction: any = {
                from: QueueProcessor.env.PRIVILEGED_UTI_OUTBOUND_ADDRESS,
                to: to,
                value: 1,
                data: this.transactionDataField(sponsorAnnouncementTransaction)
            };
            try {
                announcementTransaction.gasLimit = QueueProcessor.web3().eth.estimateGas(announcementTransaction); // TODO: handle failure here
            } catch (error) {
                reject(`got error when attempting to estimate gas for transaction ${JSON.stringify(announcementTransaction)}: ${error}`);
                return;
            }
            resolve(announcementTransaction);
        });
    }

    private transactionDataField(sponsorAnnouncementTransaction: any): string {
        if (sponsorAnnouncementTransaction) {
            // encode the block number as an 64 unsigned int (big endian)
            let blockNumber: string = new BigNumber(sponsorAnnouncementTransaction.blockNumber).toString(16);
            blockNumber = _.padStart(blockNumber, 16, '0');
            let hash: string = sponsorAnnouncementTransaction.hash.replace(/^0x/, '');
            return '0x01' + blockNumber + hash; // 84 characters long
        } else {
            return '0x01';
        }
    }

}
