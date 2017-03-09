import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import { QueueProcessor } from './queue_processor';

export class ChatQueueProcessor extends QueueProcessor {
    init(): Promise<any>[] {
        return [];
    }

    process(): any[] {
        return [
            this.processChatSummaryCopyingQueue(),
            this.processChatMessageCopyingQueue()
        ];
    }

    private processChatSummaryCopyingQueue() {
        let self = this;
        let queueRef = self.db.ref("/chatSummaryCopyingQueue");
        let options = { 'numWorkers': 1, 'sanitize': false };
        let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
            self.startTask(queue, task);
            self.lookupChatSummary(task.userId, task.chatId).then((chatSummary) => {
                let otherUserIds = _.without(_.keys(chatSummary.users), chatSummary.creatorUserId);
                _.each(otherUserIds, (otherUserId, index) => {
                    let chatSummaryCopy: any = _.extend(chatSummary, { displayUserId: chatSummary.creatorUserId });
                    let destinationRef = self.db.ref(`/users/${otherUserId}/chatSummaries/${task.chatId}`);
                    destinationRef.set(chatSummaryCopy);
                    log.trace(`  copied chatSummary to ${destinationRef.toString()}`);
                });
                self.resolveTask(queue, task, resolve, reject);
            }, (error) => {
                this.rejectTask(queue, task, error, reject);
            });
        });
        return queue;
    }

    private processChatMessageCopyingQueue() {
        let self = this;
        let queueRef = self.db.ref("/chatMessageCopyingQueue");
        let options = { 'numWorkers': 1, 'sanitize': false };
        let queue = new self.Queue(queueRef, options, (task: any, progress: any, resolve: any, reject: any) => {
            self.startTask(queue, task);
            self.lookupChatSummary(task.userId, task.chatId).then((chatSummary) => {
                self.lookupMessage(task.userId, task.chatId, task.messageId).then((message) => {
                    let otherUserIds = _.without(_.keys(chatSummary.users), message.senderUserId);
                    _.each(otherUserIds, (otherUserId, index) => {

                        // append copy of message to the chat messages collection of other user
                        let messageCopy: any = _.clone(message);
                        let destinationRef = self.db.ref(`/users/${otherUserId}/chats/${task.chatId}/messages/${task.messageId}`);
                        destinationRef.set(messageCopy);
                        log.trace(`  copied message to ${destinationRef.toString()}`);

                        // copy message to chat summary of other user unless the this is the first message in the chat
                        // summary, in which case the chat summary already contains this message
                        if (!task.isFirstMessageInChat) {
                            let destinationRef = self.db.ref(`/users/${otherUserId}/chatSummaries/${task.chatId}/lastMessage`);
                            destinationRef.set(_.merge(message, { messageId: task.messageId }));
                            log.trace(`  copied message to ${destinationRef.toString()}`);
                        }

                        // create event for other user
                        let sender = chatSummary.users[message.senderUserId];
                        let eventRef = self.db.ref(`/users/${otherUserId}/events/${task.chatId}`);
                        eventRef.set({
                            createdAt: firebase.database.ServerValue.TIMESTAMP,
                            title: sender.name,
                            messageText: message.text,
                            notificationProcessed: false,
                            profilePhotoUrl: sender.profilePhotoUrl,
                            sourceId: task.chatId,
                            sourceType: 'message',
                            updatedAt: message.sentAt
                        });
                    });
                    self.resolveTask(queue, task, resolve, reject);
                }, (error) => {
                    this.rejectTask(queue, task, error, reject);
                });
            }, (error) => {
                this.rejectTask(queue, task, error, reject);
            });
        });
        return [queue];
    }

    private lookupChatSummary(userId: string, chatId: string): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            let chatSummaryRef = self.db.ref(`/users/${userId}/chatSummaries/${chatId}`);
            chatSummaryRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
                let chatSummary = snapshot.val();
                if (chatSummary) {
                    resolve(chatSummary);
                } else {
                    let error = `no chat summary exists at location ${chatSummaryRef.toString()}`
                    log.warn('  ' + error);
                    reject(error);
                }
            });
        });
    }

    private lookupMessage(userId: string, chatId: string, messageId: string): Promise<any> {
        let self = this;
        return new Promise((resolve, reject) => {
            let messageRef = self.db.ref(`/users/${userId}/chats/${chatId}/messages/${messageId}`);
            messageRef.once('value', (snapshot: firebase.database.DataSnapshot) => {
                let message = snapshot.val();
                if (message) {
                    resolve(message);
                } else {
                    let error = `no message exists at location ${messageRef.toString()}`
                    log.warn(error);
                    reject(error);
                }
            });
        });
    }
}
