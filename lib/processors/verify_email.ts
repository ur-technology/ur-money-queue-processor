import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import { QueueProcessor } from './queue_processor';
import { PasswordService } from '../services/password.service';
import { MailerService } from '../services/mailer.service';


export class VerifyEmailQueueProcessor extends QueueProcessor {
    private passwordService: PasswordService;
    private mailerService: MailerService;

    constructor() {
        super();

        this._queueName = 'verifyEmailQueue';
        this._queueRef = this.db.ref(`/${this._queueName}`);
        this._specs = {
            send_verification_email: {
                start_state: 'send_verification_email_requested',
                in_progress_state: 'send_verification_email_in_progress',
                finished_state: 'send_verification_email_finished',
                error_state: 'send_verification_email_error',
                timeout: 5 * 60 * 1000
            },
            verify_email: {
                start_state: 'verify_email_requested',
                in_progress_state: 'verify_email_in_progress',
                finished_state: 'verify_email_finished',
                error_state: 'verify_email_error',
                timeout: 5 * 60 * 1000
            }
        };
        
        this.passwordService = PasswordService.getInstance();
        this.mailerService = MailerService.getInstance();
    }

    init(): Promise<any>[] {
        return [
            ...(_.map(this._specs, (val: any, key: string) => {
                return this.ensureQueueSpecLoaded(
                    `/${this._queueName}/specs/${key}`,
                    val
                );
            })),
            // this.addSampleTask({
            //     _state: 'send_verification_email_requested',
            //     phone: '+8617099967948',
            //     email: 'weidai1122@gmail.com'
            // }),
            // this.addSampleTask({
            //     _state: 'verify_email_requested',
            //     verificationCode: 'jDUrSvxHhFCuTscYZ9df2RNqBty5z7kp',
            // }),
        ];
    }

    process(): any[] {
        return [
            this.processSendVerificationEmailSpec(),
            this.processVerifyEmailSpec(),
        ]
    }

    /**
     * Process send_verification_email spec
     * 
     * The data provided are:
     *  @phone: phone of user who requested to verify email
     *  @email: email of user who requested to verify email
     */
    private processSendVerificationEmailSpec() {
        let self = this;
        let options = {
            specId: 'send_verification_email',
            numWorkers: 8,
            sanitize: false
        };
        let queue = new self.Queue(
            self._queueRef,
            options,
            (task: any, progress: any, resolve: any, reject: any) => {
                let user: any;

                self.startTask(queue, task);

                try {
                    // Check phone emptiness
                    if (!task.phone) {
                        throw 'send_verification_email_canceled_because_phone_empty';
                    }
                    
                    // Check email emptiness
                    if (!task.email) {
                        throw 'send_verification_email_canceled_because_email_empty';
                    }
                } catch (error) {
                    task.result = {
                        state: error,
                        error,
                    };
                    self.resolveTask(queue, task, resolve, reject);
                    return;
                }
                
                // Check if email exists
                self.lookupUsersByPhoneAndEmail(task.phone, task.email)
                    .then((matchingUsers: any[]) => {
                        if (_.isEmpty(matchingUsers)) {
                            throw 'send_verification_email_canceled_because_user_not_found';
                        }

                        user = matchingUsers[0];
                        if (user.disabled) {
                            throw 'send_verification_email_canceled_because_user_disabled';
                        }

                        if (user.isEmailVerified) {
                            throw 'send_verification_email_canceled_because_user_verified';
                        }

                        // Generate verification code
                        user.verificationCode = self.passwordService.generateCode(32);
                        // Update user
                        return this.updateUser(user.userId, {
                            verificationCode: user.verificationCode
                        });
                    })
                    .then((response: any) => {
                        // Add verification attempt
                        return this.addVerificationAttempt(user.userId, user.verificationCode);
                    })
                    .then((response: any) => {
                        // Send verification code email
                        return self.sendVerificationEmail(user);
                    })
                    .then((response: any) => {
                        // Resolve task
                        task.result = {
                            state: this._specs['send_verification_email']['finished_state'],
                        };
                        self.resolveTask(queue, task, resolve, reject);
                    }, (error: any) => {
                        if (_.isString(error) && /^send_verification_email_canceled_/.test(error)) {
                            task.result = {
                                state: error,
                                error,
                            };
                            self.resolveTask(queue, task, resolve, reject);
                        } else {
                            task.result = {
                                state: this._specs['send_verification_email']['error_state'],
                                error,
                            };
                            self.resolveTask(queue, task, resolve, reject);
                        }
                    });
            }
        );
        
        return queue;
    }

    private addVerificationAttempt(userId: string, verificationCode: string) {
        let userRef = this.db.ref(`/users/${userId}`);
        let newAttemptRef = userRef.child('verificationAttempts').push();

        return newAttemptRef.update({
            verificationCode,
            createdAt: firebase.database.ServerValue.TIMESTAMP,
        });
    }

    private sendVerificationEmail(user: any): Promise<any> {
        const verifyLink = `${process.env.APP_BASE_URL}?verification-code=${user.verificationCode}`;
        
        return this.mailerService
            .sendWithTemplate(
                process.env.UR_SUPPORT_EMAIL,
                user.email,
                'verify-email',
                {
                    name: user.name,
                    verifyLink
                }
            );
    }

    /**
     * Process verify_email spec
     * 
     * The data provided are:
     *  @verification_code:  verification code entered by user
     */
    private processVerifyEmailSpec() {
        let self = this;
        let options = {
            specId: 'verify_email',
            numWorkers: 8,
            sanitize: false
        };
        let queue = new self.Queue(
            self._queueRef,
            options,
            (task: any, progress: any, resolve: any, reject: any) => {
                let user: any;

                self.startTask(queue, task);

                try {
                    // Check emptiness of verification code
                    if (!task.verificationCode) {
                        throw 'verify_email_canceled_because_verification_code_empty';
                    }
                } catch (error) {
                    task.result = {
                        state: error,
                        error,
                    };
                    self.resolveTask(queue, task, resolve, reject);
                    return;
                }

                // Find user by verification code
                self.lookupUsersByVerificationCode(task.verificationCode)
                    .then((matchingUsers: any[]) => {
                        if (_.isEmpty(matchingUsers)) {
                            throw 'verify_email_canceled_because_user_not_found';
                        }

                        user = matchingUsers[0];
                        if (user.disabled) {
                            throw 'verify_email_canceled_because_user_disabled';
                        }

                        if (user.isEmailVerified) {
                            throw 'verify_email_canceled_because_user_verified';
                        }

                        // Mark the user as verified
                        return this.updateUser(user.userId, {
                            isEmailVerified: true,
                            verificationCode: '',
                        });
                    })
                    .then((response: any) => {
                        // Resolve task
                        task.result = {
                            state: this._specs['verify_email']['finished_state'],
                        };
                        self.resolveTask(queue, task, resolve, reject);
                    }, (error: any) => {
                        if (_.isString(error) && /^verify_email_canceled_/.test(error)) {
                            task.result = {
                                state: error,
                                error,
                            };
                            self.resolveTask(queue, task, resolve, reject);
                        } else {
                            task.result = {
                                state: this._specs['verify_email']['error_state'],
                                error,
                            };
                            self.resolveTask(queue, task, resolve, reject);
                        }
                    });
            }
        );

        return queue;
    }
}
