/// <reference path="../typings/index.d.ts" />

import * as dotenv from 'dotenv';
import * as log from 'loglevel';
import * as _ from 'lodash';
import * as firebase from 'firebase';
import {Notifier} from './notifier';

if (!process.env.NODE_ENV) {
  dotenv.config(); // if running on local machine, load config vars from .env file, otherwise these come from heroku
}

log.setDefaultLevel(process.env.LOG_LEVEL || "info")

log.info(`starting with NODE_ENV ${process.env.NODE_ENV} and FIREBASE_PROJECT_ID ${process.env.FIREBASE_PROJECT_ID}`);

firebase.initializeApp({
  serviceAccount: `./serviceAccountCredentials.${process.env.FIREBASE_PROJECT_ID}.json`,
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
});

let twilioOptions = _.pick(process.env, ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_FROM_NUMBER']);
let notifier = new Notifier(twilioOptions);
notifier.start();

process.on('SIGTERM', () => {
  log.info(`Exiting...`);
  let promises: Promise<any>[] = _.map(notifier.queues, (queue) => { return queue.shutdown(); });
  Promise.all(promises).then(values => {
    console.log(values);
    console.log('Finished shutting down all queues');
    process.exit(0);
  });
});
