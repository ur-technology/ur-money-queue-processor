import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import { QueueProcessor } from './queue_processor';
import { SendGridService } from '../services/sendgrid.service';


export class ResetPasswordQueueProcessor extends QueueProcessor {
    private sendGridService: SendGridService;

    constructor() {
        super();

        this.sendGridService = new SendGridService(process.env.SENDGRID_API_KEY);
    }

    init(): Promise<any>[] {

        this._queueName = 'resetPasswordQueue';
        this._queueRef = this.db.ref(`/${this._queueName}`);

        return [
            this.ensureQueueSpecLoaded(`/${this._queueName}/specs/send_reset_code`, {
                "in_progress_state": "send_reset_code_in_progress",
                "finished_state": "send_reset_code_finished",
                "error_state": "send_reset_code_error",
                "timeout": 5 * 60 * 1000
            }),
            this.ensureQueueSpecLoaded(`/${this._queueName}/specs/reset_password`, {
                "start_state": "send_reset_code_finished",
                "in_progress_state": "reset_password_in_progress",
                "finished_state": "reset_password_finished",
                "error_state": "reset_password_error",
                "timeout": 5 * 60 * 1000
            }),
            this.addSendResetCodeSampleTask()
        ];
    }

    private addSendResetCodeSampleTask(): Promise<any> {
        let data = {
            email: 'weidai1122@gmail.com'
        };

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
            // this.processResetPasswordSpec(),
        ]
    }

    /**
     * Process send_reset_code spec
     * 
     * The data provided are:
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
                let resetCode: string;

                self.startTask(queue, task);

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

                        let user = matchingUsers[0];
                        
                        task.userId = user.userId;
                        if (user.disabled) {
                            throw 'send_reset_code_canceled_because_user_disabled';
                        }

                        // Generate reset code
                        resetCode = self.generateResetCode();
                        // Send reset code email
                        return self.sendResetCodeEmail(task.email, resetCode);
                    })
                    .then((response: any) => {
                        // Update task
                        task.resetCode = resetCode;
                        // Resolve task
                        self.resolveTask(queue, task, resolve, reject);
                    }, (error: any) => {
                        self.rejectTask(queue, task, error, reject);
                    });
            }
        );
        return queue;
    }

    private generateResetCode() {
        let chars: string = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
        return _.sampleSize(chars, 6).join('');
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

    /**
     * Process reset_password spec
     * 
     * The data provided are:
     *  @server_reset_code: server reset code
     *  @reset_code:        reset code entered by user
     *  @new_password:      new password entered by user
     */
    private processResetPasswordSpec() {}
}
