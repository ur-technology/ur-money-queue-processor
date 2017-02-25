import * as _ from 'lodash';
import { QueueProcessor } from './queue_processor';

export class SendEmailQueueProcessor extends QueueProcessor {
    init(): Promise<any>[] {

        return [
            this.ensureQueueSpecLoaded('/sendEmailQueue/specs/send_email', {
                in_progress_state: 'send_email_in_progress',
                finished_state: 'send_email_finished',
                error_state: 'send_email_error',
                timeout: 5 * 60 * 1000
            })
            // this.addSampleTask()
        ];
    }

    private addSampleTask(): Promise<any> {
        const data = {
            from: 'support@ur.com',
            to: 'weidai1122@gmail.com',
            subject: 'Hello',
            contentType: 'text/plain',
            content: 'Hello Haohong'
        };

        return new Promise((resolve, reject) => {
            const tasksRef = this.db.ref('/sendEmailQueue/tasks');
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
            this.processSendEmailSpec()
        ]
    }

    private processSendEmailSpec() {
        const options = {
            specId: 'send_email',
            numWorkers: 8,
            sanitize: false
        };
        const queueRef = this.db.ref('/sendEmailQueue');
        const queue = new this.Queue(
            queueRef,
            options,
            (task: any, progress: any, resolve: any, reject: any) => {
                this.startTask(queue, task);

                // TODO: Send email using sendgrid
                this.resolveTask(queue, task, resolve, reject);
            }
        );
        
        return queue;
    }
}
