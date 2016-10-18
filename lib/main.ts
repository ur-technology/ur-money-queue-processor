/// <reference path="../typings/index.d.ts" />

import * as dotenv from 'dotenv';
import * as log from 'loglevel';
import * as _ from 'lodash';
import * as firebase from 'firebase';
import {QueueProcessor} from './queue_processor';
import {ChatQueueProcessor} from './chat';
import {IdentityVerificationQueueProcessor} from './identity_verification';
import {IdentityAnnouncementQueueProcessor} from './identity_announcement';
import {InvitationQueueProcessor} from './invitation';
import {PhoneAuthenticationQueueProcessor} from './phone_authentication';
import {PhoneLookupQueueProcessor} from './phone_lookup';
import {UrTransactionImportQueueProcessor} from './ur_transaction_import';

if (!process.env.NODE_ENV) {
  dotenv.config(); // if running on local machine, load config vars from .env file, otherwise these come from heroku
}

log.setDefaultLevel(process.env.LOG_LEVEL || "info")

log.info(`starting with NODE_ENV ${process.env.NODE_ENV} and FIREBASE_PROJECT_ID ${process.env.FIREBASE_PROJECT_ID}`);

firebase.initializeApp({
  serviceAccount: `./serviceAccountCredentials.${process.env.FIREBASE_PROJECT_ID}.json`,
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

let queueProcessors = _.map([
  ChatQueueProcessor,
  IdentityVerificationQueueProcessor,
  IdentityAnnouncementQueueProcessor,
  InvitationQueueProcessor,
  PhoneAuthenticationQueueProcessor,
  PhoneLookupQueueProcessor,
  UrTransactionImportQueueProcessor
], (queueProcessorClass) => {
  return new queueProcessorClass();
});

QueueProcessor.initializeClass(process.env);

let initializerPromises = _.flatten(_.map(queueProcessors, (p) => { return p.disabled() ? [] : p.init(); }));

let queues: any[] = [];
Promise.all(initializerPromises).then(values => {
  queues = _.flatten(_.map(queueProcessors, (p) => { return p.disabled() ? [] : p.process(); }));
});

process.on('SIGTERM', () => {
  log.info(`Exiting...`);
  let shutdownPromises: Promise<any>[] = _.map(queues, (queue) => { return queue.shutdown(); });
  Promise.all(shutdownPromises).then(values => {
    console.log(values);
    console.log('Finished shutting down all queues');
    process.exit(0);
  });
});
