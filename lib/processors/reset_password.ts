import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import { QueueProcessor } from './queue_processor';
import { PasswordService } from '../services/password.service';
import { MailerService } from '../services/mailer.service';


export class ResetPasswordQueueProcessor extends QueueProcessor {
    private passwordService: PasswordService;
    private mailerService: MailerService;

    constructor() {
        super();

        this._queueName = 'resetPasswordQueue';
        this._queueRef = this.db.ref(`/${this._queueName}`);
        this._specs = {
            send_recovery_email: {
                start_state: 'send_recovery_email_requested',
                in_progress_state: 'send_recovery_email_in_progress',
                finished_state: 'send_recovery_email_finished',
                error_state: 'send_recovery_email_error',
                timeout: 5 * 60 * 1000
            },
            reset_password: {
                start_state: 'reset_password_requested',
                in_progress_state: 'reset_password_in_progress',
                finished_state: 'reset_password_finished',
                error_state: 'reset_password_error',
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
            //     _state: 'send_recovery_email_requested',
            //     phone: '+8617099967948',
            //     email: 'weidai1122@gmail.com'
            // }),
            // this.addSampleTask({
            //     _state: 'reset_password_requested',
            //     resetCode: 'cRxCDf',
            //     newPassword: 'password',
            // }),
        ];
    }

    process(): any[] {
        return [
            this.processSendRecoveryEmailSpec(),
            this.processResetPasswordSpec(),
        ]
    }

    /**
     * Process send_recovery_email spec
     * 
     * The data provided are:
     *  @phone: phone of user who requested to reset password
     *  @email: email of user who requested to reset password
     */
    private processSendRecoveryEmailSpec() {
        let self = this;
        let options = {
            specId: 'send_recovery_email',
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
                        throw 'send_recovery_email_canceled_because_phone_empty';
                    }
                    
                    // Check email emptiness
                    if (!task.email) {
                        throw 'send_recovery_email_canceled_because_email_empty';
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
                            throw 'send_recovery_email_canceled_because_user_not_found';
                        }

                        user = matchingUsers[0];
                        if (user.disabled) {
                            throw 'send_recovery_email_canceled_because_user_disabled';
                        }
                        
                        if (!user.isEmailVerified) {
                            throw 'send_recovery_email_canceled_because_email_not_verified';
                        }

                        // Generate reset code
                        user.resetCode = self.passwordService.generateCode(32);
                        // Update user
                        return this.updateUser(user.userId, {
                            resetCode: user.resetCode
                        });
                    })
                    .then((response: any) => {
                        // Send reset code email
                        return self.sendRecoveryEmail(user);
                    })
                    .then((response: any) => {
                        // Resolve task
                        task.result = {
                            state: this._specs['send_recovery_email']['finished_state'],
                        };
                        self.resolveTask(queue, task, resolve, reject);
                    }, (error: any) => {
                        if (_.isString(error) && /^send_recovery_email_canceled_/.test(error)) {
                            task.result = {
                                state: error,
                                error,
                            };
                            self.resolveTask(queue, task, resolve, reject);
                        } else {
                            task.result = {
                                state: this._specs['send_recovery_email']['error_state'],
                                error,
                            };
                            self.resolveTask(queue, task, resolve, reject);
                        }
                    });
            }
        );
        
        return queue;
    }

    private sendRecoveryEmail(user: any): Promise<any> {
        const resetLink = `${process.env.APP_BASE_URL}?reset-code=${user.resetCode}`;
        
        return this.mailerService
            .sendWithTemplate(
                process.env.UR_SUPPORT_EMAIL,
                user.email,
                'reset-password',
                {
                    name: user.name,
                    resetLink
                }
            );
    }

    /**
     * Process reset_password spec
     * 
     * The data provided are:
     *  @reset_code:        reset code entered by user
     *  @new_password:      new password entered by user
     */
    private processResetPasswordSpec() {
        let self = this;
        let options = {
            specId: 'reset_password',
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
                    // Check emptiness of reset code
                    if (!task.resetCode) {
                        throw 'reset_password_canceled_because_reset_code_empty';
                    }

                    // Check emptiness of new password
                    if (!task.newPassword) {
                        throw 'reset_password_canceled_because_new_password_empty';
                    }
                } catch (error) {
                    task.result = {
                        state: error,
                        error,
                    };
                    self.resolveTask(queue, task, resolve, reject);
                    return;
                }

                // Find user by reset code
                self.lookupUsersByResetCode(task.resetCode)
                    .then((matchingUsers: any[]) => {
                        if (_.isEmpty(matchingUsers)) {
                            throw 'reset_password_canceled_because_user_not_found';
                        }

                        user = matchingUsers[0];
                        if (user.disabled) {
                            throw 'reset_password_canceled_because_user_disabled';
                        }

                        if (!user.isEmailVerified) {
                            throw 'reset_password_canceled_because_email_not_verified';
                        }

                        // Generate hashed password
                        return this.passwordService.hashPassword(task.newPassword, user.userId);
                    })
                    .then((hashedPassword: string) => {
                        // Update password of user
                        return this.updateUser(user.userId, {
                            serverHashedPassword: hashedPassword,
                            resetCode: '',
                        });
                    })
                    .then((response: any) => {
                        // Resolve task
                        task.result = {
                            state: this._specs['reset_password']['finished_state'],
                        };
                        self.resolveTask(queue, task, resolve, reject);
                    }, (error: any) => {
                        if (_.isString(error) && /^reset_password_canceled_/.test(error)) {
                            task.result = {
                                state: error,
                                error,
                            };
                            self.resolveTask(queue, task, resolve, reject);
                        } else {
                            task.result = {
                                state: this._specs['reset_password']['error_state'],
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
