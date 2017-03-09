import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import { QueueProcessor } from './queue_processor';
import { PasswordService } from '../services/password.service';
import { SendGridService } from '../services/sendgrid.service';


export class ResetPasswordQueueProcessor extends QueueProcessor {
    private passwordService: PasswordService;
    private sendGridService: SendGridService;

    constructor() {
        super();

        this._queueName = 'resetPasswordQueue';
        this._queueRef = this.db.ref(`/${this._queueName}`);
        this._specs = {
            send_reset_code: {
                start_state: 'send_reset_code_requested',
                in_progress_state: 'send_reset_code_in_progress',
                finished_state: 'send_reset_code_finished',
                error_state: 'send_reset_code_error',
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
        this.sendGridService = SendGridService.getInstance();
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
            //     _state: 'send_reset_code_requested',
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

    private addSampleTask(data: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const tasksRef = this._queueRef.child('tasks');
            tasksRef.push(data, (error: any) => {
                if (error) {
                    reject(error.message);
                } else {
                    resolve(data);
                }
            });
        });
    }

    process(): any[] {
        return [
            this.processSendResetCodeSpec(),
            this.processResetPasswordSpec(),
        ]
    }

    /**
     * Process send_reset_code spec
     * 
     * The data provided are:
     *  @phone: phone of user who requested to reset password
     *  @email: email of user who requested to reset password
     */
    private processSendResetCodeSpec() {
        let self = this;
        let options = {
            specId: 'send_reset_code',
            numWorkers: 8,
            sanitize: false
        };
        let queue = new self.Queue(
            self._queueRef,
            options,
            (task: any, progress: any, resolve: any, reject: any) => {
                let user: any;
                let resetCode: string;

                self.startTask(queue, task);

                // Check phone emptiness
                if (!task.phone) {
                    throw 'send_reset_code_canceled_because_phone_empty';
                }
                
                // Check email emptiness
                if (!task.email) {
                    throw 'send_reset_code_canceled_because_email_empty';
                }
                
                // Check if email exists
                self.lookupUsersByEmail(task.email)
                    .then((matchingUsers: any[]) => {
                        if (_.isEmpty(matchingUsers)) {
                            throw 'send_reset_code_canceled_because_user_not_found';
                        }

                        user = matchingUsers[0];
                        if (user.disabled) {
                            throw 'send_reset_code_canceled_because_user_disabled';
                        }

                        // Generate reset code
                        resetCode = self.passwordService.generateCode();
                        // Send reset code email
                        return self.sendResetCodeEmail(task.email, resetCode);
                    })
                    .then((response: any) => {
                        // Update user
                        return this.updateUser(user.userId, {
                            resetCode,
                        });
                    })
                    .then((response: any) => {
                        // Resolve task
                        task.result = {
                            state: this._specs['send_reset_code']['finished_state'],
                        };
                        self.resolveTask(queue, task, resolve, reject);
                    }, (error: any) => {
                        if (_.isString(error) && /^send_reset_code_canceled_/.test(error)) {
                            task.result = {
                                state: error,
                                error,
                            };
                            self.resolveTask(queue, task, resolve, reject);
                        } else {
                            task.result = {
                                state: this._specs['send_reset_code']['error_state'],
                                error,
                            };
                            self.resolveTask(queue, task, resolve, reject);
                        }
                    });
            }
        );
        
        return queue;
    }

    private sendResetCodeEmail(email: string, resetCode: string) {
        let from = process.env.UR_SUPPORT_EMAIL;
        let to = email;
        let subject = 'Password reset code';
        let content = `Password reset code is ${resetCode}`;
        let contentType = 'text/plain';
        
        this.sendGridService
            .send(
                from,
                to,
                subject,
                content,
                contentType
            );
    }

    private updateUser(userId: string, payload: any) {
        let userRef = this.db.ref(`/users/${userId}`);

        return userRef.update(payload);
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

                // Check emptiness of reset code
                if (!task.resetCode) {
                    throw 'reset_password_canceled_because_reset_code_empty';
                }

                // Check emptiness of new password
                if (!task.newPassword) {
                    throw 'reset_password_canceled_because_new_password_empty';
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
