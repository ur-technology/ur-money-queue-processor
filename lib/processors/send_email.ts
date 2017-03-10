import * as _ from 'lodash';
import { QueueProcessor } from './queue_processor';
import { MailerService } from '../services/mailer.service';


export class SendEmailQueueProcessor extends QueueProcessor {
    private mailerService: MailerService;

    constructor() {
        super();

        this.mailerService = MailerService.getInstance();
    }

    init(): Promise<any>[] {

        return [
            this.ensureQueueSpecLoaded('/sendEmailQueue/specs/send_email', {
                in_progress_state: 'send_email_in_progress',
                finished_state: 'send_email_finished',
                error_state: 'send_email_error',
                timeout: 5 * 60 * 1000
            }),
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

    /**
     * Process send_email spec
     * 
     * The data provided are:
     *  @from:      From
     *  @to:        To
     *  @subject:   Subject
     *  @text:      Text
     *  @html:      Html
     */
    private processSendEmailSpec() {
        const queueOptions = {
            specId: 'send_email',
            numWorkers: 8,
            sanitize: false
        };
        const queueRef = this.db.ref('/sendEmailQueue');
        const queue = new this.Queue(
            queueRef,
            queueOptions,
            (task: any, progress: any, resolve: any, reject: any) => {
                this.startTask(queue, task);

                if (!task.from) {
                    this.rejectTask(queue, task, 'expecting from address', reject);
                    return;
                }
                if (!task.to) {
                    this.rejectTask(queue, task, 'expecting to address', reject);
                    return;
                }
                if (!task.subject) {
                    this.rejectTask(queue, task, 'expecting subject address', reject);
                    return;
                }

                this.mailerService
                    .send(
                        task.from,
                        task.to,
                        task.subject,
                        task.text,
                        task.html
                    )
                    .then((response: any) => {
                        task._new_state = 'send_email_finished';
                        task.result = response;

                        this.resolveTask(queue, task, resolve, reject);
                    })
                    .catch((error: any) => {
                        task.result = {
                            state: 'send_email_error',
                            error: error
                        };

                        this.rejectTask(queue, task, resolve, reject);
                    });
            }
        );
        
        return queue;
    }
}
