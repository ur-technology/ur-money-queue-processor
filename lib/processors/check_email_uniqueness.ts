import * as _ from 'lodash';
import { QueueProcessor } from './queue_processor';


export class CheckEmailUniquenessQueueProcessor extends QueueProcessor {
    constructor() {
        super();

        this._queueName = 'checkEmailUniquenessQueue';
        this._queueRef = this.db.ref(`/${this._queueName}`);
        this._specs = {
            check_email_uniqueness: {
                start_state: 'check_email_uniqueness_requested',
                in_progress_state: 'check_email_uniqueness_in_progress',
                finished_state: 'check_email_uniqueness_finished',
                error_state: 'check_email_uniqueness_error',
                timeout: 5 * 60 * 1000
            }
        };
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
            //     _state: 'check_email_uniqueness_requested',
            //     email: 'weidai1122@gmail.com',
            // })
        ];
    }

    process(): any[] {
        return [
            this.processCheckEmailUniquenessSpec()
        ]
    }

    /**
     * Process check_email_uniqueness spec
     * 
     * The data provided are:
     *  @email:      Email
     */
    private processCheckEmailUniquenessSpec() {
        const queueOptions = {
            specId: 'check_email_uniqueness',
            numWorkers: 8,
            sanitize: false
        };
        const queue = new this.Queue(
            this._queueRef,
            queueOptions,
            (task: any, progress: any, resolve: any, reject: any) => {
                this.startTask(queue, task);

                try {
                    if (!task.email) {
                        throw 'check_email_uniqueness_canceled_because_email_empty';
                    }
                } catch (error) {
                    task.result = {
                        state: error,
                        error,
                    };
                    this.resolveTask(queue, task, resolve, reject);
                    return;
                }

                this.lookupUsersByEmail(task.email)
                    .then((matchingUsers: any[]) => {
                        task.result = {
                            state: this._specs['check_email_uniqueness']['finished_state'],
                            isUnique: _.isEmpty(matchingUsers),
                        };
                        this.resolveTask(queue, task, resolve, reject);
                    }, (error: any) => {
                        if (_.isString(error) && /^check_email_uniqueness_canceled_/.test(error)) {
                            task.result = {
                                state: error,
                                error,
                            };
                            this.resolveTask(queue, task, resolve, reject);
                        } else {
                            task.result = {
                                state: this._specs['check_email_uniqueness']['error_state'],
                                error,
                            };
                            this.resolveTask(queue, task, resolve, reject);
                        }
                    });
            }
        );
        
        return queue;
    }
}
