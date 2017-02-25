/// <reference path="../typings/index.d.ts" />

import * as dotenv from 'dotenv';
import * as log from 'loglevel';
import * as _ from 'lodash';
import { QueueProcessor } from './processors/queue_processor';
import { ChatQueueProcessor } from './processors/chat';
import { IdentityAnnouncementQueueProcessor } from './processors/identity_announcement';
import { PhoneLookupQueueProcessor } from './processors/phone_lookup';
import { SendEmailQueueProcessor } from './processors/send_email';
import { SignUpQueueProcessor } from './processors/sign_up';
import { SignInQueueProcessor } from './processors/sign_in';
import { VerifyIDQueueProcessor } from './processors/verify_id';
import { UrTransactionImportQueueProcessor } from './processors/ur_transaction_import';
import { AcuantIDVerifier } from './id-verification/acuant';

if (!process.env.NODE_ENV) {
    dotenv.config(); // if running on local machine, load config vars from .env file, otherwise these come from heroku
}

log.setDefaultLevel(process.env.LOG_LEVEL || "info")

let serviceAccount = require(`../serviceAccountCredentials.${process.env.FIREBASE_PROJECT_ID}.json`);
let admin = require("firebase-admin");
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

var google_cloud_storage = require('@google-cloud/storage')({
    projectId: process.env.FIREBASE_PROJECT_ID,
    keyFilename: `serviceAccountCredentials.${process.env.FIREBASE_PROJECT_ID}.json`,
});

QueueProcessor.env = process.env;
QueueProcessor.db = admin.database();
QueueProcessor.auth = admin.auth();
QueueProcessor.storage = google_cloud_storage.bucket(`${process.env.FIREBASE_PROJECT_ID}.appspot.com`);
QueueProcessor.Queue = require('firebase-queue');

QueueProcessor.idVerifier = new AcuantIDVerifier(
    QueueProcessor.db,
    QueueProcessor.storage,
    QueueProcessor.env.ACUANT_API_KEY
);

let queueProcessors = _.map([
    ChatQueueProcessor,
    IdentityAnnouncementQueueProcessor,
    PhoneLookupQueueProcessor,
    SendEmailQueueProcessor,
    SignUpQueueProcessor,
    SignInQueueProcessor,
    VerifyIDQueueProcessor,
    UrTransactionImportQueueProcessor
], (queueProcessorClass) => {
    return new queueProcessorClass();
});

log.info(`starting with NODE_ENV ${process.env.NODE_ENV} and FIREBASE_PROJECT_ID ${process.env.FIREBASE_PROJECT_ID}`);
_.each(queueProcessors, (p) => {
    if (p.enabled()) {
        log.info(`processing enabled for ${p.className()}`);
    }
});

let initializerPromises = _.flatten(_.map(queueProcessors, (p) => {
    return p.enabled() ? p.init() : [];
}));

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
