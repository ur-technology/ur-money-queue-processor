import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

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
    let options = { 'numWorkers': 1 };
    let queue = new self.Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      self.lookupChatSummary(data.userId, data.chatId).then((chatSummary) => {
        let otherUserIds = _.without(_.keys(chatSummary.users), chatSummary.creatorUserId);
        _.each(otherUserIds, (otherUserId, index) => {
          let chatSummaryCopy: any = _.extend(chatSummary, { displayUserId: chatSummary.creatorUserId });
          let destinationRef = self.db.ref(`/users/${otherUserId}/chatSummaries/${data.chatId}`);
          destinationRef.set(chatSummaryCopy);
          log.trace(`copied chatSummary to ${destinationRef.toString()}`);
        });
        self.resolveIfPossible(resolve, reject, data);
      }, (error) => {
        reject(error);
      });
    });
    return queue;
  }

  private processChatMessageCopyingQueue() {
    let self = this;
    let queueRef = self.db.ref("/chatMessageCopyingQueue");
    let options = { 'numWorkers': 1 };
    let queue = new self.Queue(queueRef, options, (data: any, progress: any, resolve: any, reject: any) => {
      self.lookupChatSummary(data.userId, data.chatId).then((chatSummary) => {
        self.lookupMessage(data.userId, data.chatId, data.messageId).then((message) => {
          let otherUserIds = _.without(_.keys(chatSummary.users), message.senderUserId);
          _.each(otherUserIds, (otherUserId, index) => {

            // append copy of message to the chat messages collection of other user
            let messageCopy: any = _.clone(message);
            let destinationRef = self.db.ref(`/users/${otherUserId}/chats/${data.chatId}/messages/${data.messageId}`);
            destinationRef.set(messageCopy);
            log.trace(`copied message to ${destinationRef.toString()}`);

            // copy message to chat summary of other user unless the this is the first message in the chat
            // summary, in which case the chat summary already contains this message
            if (!data.isFirstMessageInChat) {
              let destinationRef = self.db.ref(`/users/${otherUserId}/chatSummaries/${data.chatId}/lastMessage`);
              destinationRef.set(_.merge(message, { messageId: data.messageId }));
              log.trace(`copied message to ${destinationRef.toString()}`);
            }

            // create event for other user
            let sender = chatSummary.users[message.senderUserId];
            let eventRef = self.db.ref(`/users/${otherUserId}/events/${data.chatId}`);
            eventRef.set({
              createdAt: firebase.database.ServerValue.TIMESTAMP,
              messageText: message.text,
              notificationProcessed: 'false',
              profilePhotoUrl: sender.profilePhotoUrl,
              sourceId: data.chatId,
              sourceType: 'message',
              title: sender.name,
              updatedAt: message.sentAt,
              userdId: message.senderUserId
            });
          });
          self.resolveIfPossible(resolve, reject, data);
        }, (error) => {
          reject(error);
        });
      }, (error) => {
        reject(error);
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
          log.warn(error);
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
