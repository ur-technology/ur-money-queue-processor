import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import { QueueProcessor } from './queue_processor';


export class ResetPasswordQueueProcessor extends QueueProcessor {
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
        ];
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
     *  @email: email of user who requested to reset password
     */
    private processSendResetCodeSpec() {}

    /**
     * Process reset_password spec
     * 
     * The data provided are:
     *  @reset_code: reset code
     */
    private processResetPasswordSpec() {}
}
