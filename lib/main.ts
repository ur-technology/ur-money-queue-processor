/// <reference path="../typings/index.d.ts" />

import * as dotenv from 'dotenv';
import * as log from 'loglevel';
import * as _ from 'lodash';
import {QueueProcessor} from './queue_processor';
import {ChatQueueProcessor} from './chat';
import {IdentityAnnouncementQueueProcessor} from './identity_announcement';
import {InvitationQueueProcessor} from './invitation';
import {AuthenticationQueueProcessor} from './authentication';
import {PhoneAuthQueueProcessor} from './phone_auth';
import {PhoneLookupQueueProcessor} from './phone_lookup';
import {UrTransactionImportQueueProcessor} from './ur_transaction_import';
import {PrefineryImportQueueProcessor} from './prefinery_import';
import {PrefineryCleanupQueueProcessor} from './prefinery_cleanup';
import {SponsorLookupQueueProcessor} from './sponsor_lookup';

if (!process.env.NODE_ENV) {
  dotenv.config(); // if running on local machine, load config vars from .env file, otherwise these come from heroku
}

log.setDefaultLevel(process.env.LOG_LEVEL || "info")

log.info(`starting with NODE_ENV ${process.env.NODE_ENV} and FIREBASE_PROJECT_ID ${process.env.FIREBASE_PROJECT_ID}`);

let serviceAccount = require(`../serviceAccountCredentials.${process.env.FIREBASE_PROJECT_ID}.json`);
let admin = require("firebase-admin");
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

QueueProcessor.env = process.env;
QueueProcessor.db = admin.database();
QueueProcessor.auth = admin.auth();
QueueProcessor.Queue = require('firebase-queue');

let queueProcessors = _.map([
  ChatQueueProcessor,
  IdentityAnnouncementQueueProcessor,
  InvitationQueueProcessor,
  AuthenticationQueueProcessor,
  PhoneAuthQueueProcessor,
  PhoneLookupQueueProcessor,
  UrTransactionImportQueueProcessor,
  PrefineryImportQueueProcessor,
  PrefineryCleanupQueueProcessor,
  SponsorLookupQueueProcessor
], (queueProcessorClass) => {
  return new queueProcessorClass();
});

let initializerPromises = _.flatten(_.map(queueProcessors, (p) => { return p.enabled() ? p.init() : []; }));

let queues: any[] = [];
Promise.all(initializerPromises).then(values => {
  queues = _.flatten(_.map(queueProcessors, (p) => { return p.enabled() ? p.process() : []; }));
});

process.on('SIGTERM', () => {
  log.info(`Exiting...`);
  let shutdownPromises: Promise<any>[] = _.map(queues, (queue) => { return queue.shutdown(); });
  Promise.all(shutdownPromises).then(values => {
    log.info(values);
    log.info('Finished shutting down all queues');
    process.exit(0);
  });
});
