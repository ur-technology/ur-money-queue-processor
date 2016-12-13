import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class PrefineryImportQueueProcessor extends QueueProcessor {
  candidates: any;
  importBatchId: string;

  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/prefineryImportQueue/specs/import", {
        "start_state": "ready_to_import",
        "in_progress_state": "processing",
        "error_state": "error",
        "timeout": 120000,
        "retries": 5
      }),
      this.setUpPrefineryImportQueue()
    ];
  }

  private setUpPrefineryImportQueue(): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      // make sure there is at least one task in the queue
      let tasksRef = self.db.ref(`/prefineryImportQueue/tasks`);
      tasksRef.once('value').then((snapshot: firebase.database.DataSnapshot) => {
        if (snapshot.exists()) {
          return Promise.resolve();
        } else {
          return tasksRef.child("only-one-task").set({ _state: "ready_to_import", delaySeconds: 0, createdAt: firebase.database.ServerValue.TIMESTAMP });
        }
      }).then(() => {
        resolve();
      }, (error: string) => {
        reject(error);
      });
    });
  }

  process(): any[] {
    let self = this;
    let queueRef = self.db.ref("/prefineryImportQueue");

    let importOptions = { 'specId': 'import', 'numWorkers': 1, sanitize: false };
    let importQueue = new self.Queue(queueRef, importOptions, (task: any, progress: any, resolve: any, reject: any) => {
      self.startTask(importQueue, task, true);
      self.candidates = {};
      self.importBatchId = self.db.ref("/users").push().key; // HACK to generate unique id
      let delaySeconds = _.isNumber(_.toNumber(task.delaySeconds)) ? _.toNumber(task.delaySeconds) : 0;
      setTimeout(() => {
        progress(50);
        self.loadCandidatesFromPrefinery(1).then(() => {
          self.resolveTask(importQueue, _.merge(task, { _new_state: "ready_to_import", delaySeconds: 45 }), resolve, reject, true);
        });
      }, delaySeconds * 1000);
    });

    return [importQueue];
  };

  private showStats() {
    log.info(`    ${_.size(this.candidates)} total candidates processed`);
    _.each(_.groupBy(this.candidates, 'importStatus'), (group, importStatus) => {
      let suffix = '';
      if (importStatus === 'skipped-for-sponsor-email-lookup-failure') {
        let count = _.size(_.uniq(_.map(group, (c: any) => { return c.prefineryUser && c.prefineryUser.referredBy; })));
        suffix = `(${count} unique sponsor emails)`;
      }
      log.info(`      ${_.size(group)} candidates ${importStatus} ${suffix}`);
    });
  }

  private importCandidate(candidate: any): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {

      self.lookupUserByEmailLoosely(candidate.email).then((matchingUser: any) => {
        if (matchingUser) {
          return Promise.reject('skipped-for-duplicate-email')
        } else {
          return self.lookupUserByEmailLoosely(candidate.prefineryUser.referredBy);
        }
      }).then((sponsor: any) => {
        if (sponsor) {
          self.addSponsorInfo(candidate, sponsor);
          return self.db.ref(`/users/${candidate.userId}`).set(_.omit(candidate,['importStatus', 'userId']));
        } else {
          return Promise.reject('skipped-for-sponsor-email-lookup-failure');
        }
      }).then(() => {
        return self.db.ref(`/users/${candidate.sponsor.userId}/downlineUsers/${candidate.userId}`).set({
          name: candidate.name,
          profilePhotoUrl: candidate.profilePhotoUrl
        });
      }).then(() => {
        _.each(self.candidates, (c) => {
          if (c.importStatus === 'skipped-for-sponsor-email-lookup-failure' && c.prefineryUser && c.prefineryUser.referredBy === candidate.email) {
            c.importStatus = 'unprocessed';
          }
        });
        resolve('imported');
      }, (errorOrStatus: any) => {
        if (_.isString(errorOrStatus) && /^skipped\-/.test(errorOrStatus)) {
          resolve(errorOrStatus)
        } else {
          reject(errorOrStatus);
        }
      });
    });
  }

  private addSponsorInfo(candidate: any, sponsor: any) {
    candidate.sponsor = {
      userId: sponsor.userId,
      announcementTransactionConfirmed: !!sponsor.wallet &&
        !!sponsor.wallet.announcementTransaction &&
        !!sponsor.wallet.announcementTransaction.blockNumber &&
        !!sponsor.wallet.announcementTransaction.hash
    };
    if (!_.isEmpty(sponsor.name || '')) {
      candidate.sponsor.name = sponsor.name;
    }
    if (!_.isEmpty(sponsor.profilePhotoUrl || '')) {
      candidate.sponsor.profilePhotoUrl = sponsor.profilePhotoUrl;
    }
    if (_.isNumber(sponsor.downlineLevel)) {
      candidate.downlineLevel = sponsor.downlineLevel + 1;
    }
  }

  private importUnprocessedCandidates(newDataEncountered: boolean): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {

      let numCandidates = _.size(self.candidates);
      let randomCandidate = _.sample(self.candidates);
      let unprocessedCandidates: any = _.pickBy(self.candidates, (c: any): boolean => { return c.importStatus === 'unprocessed'; });
      let numRecordsRemaining = _.size(unprocessedCandidates);
      if (numRecordsRemaining === 0) {
        resolve(newDataEncountered);
        return;
      }

      log.info(`  starting round of imports...`);
      let finalized = false;
      _.each(unprocessedCandidates, (candidate) => {
        self.importCandidate(candidate).then((importStatus) => {
          candidate.importStatus = importStatus;
          if (importStatus !== 'skipped-for-duplicate-email') {
            newDataEncountered = true;
          }
          numRecordsRemaining--;
          if (!finalized && numRecordsRemaining === 0) {
            self.importUnprocessedCandidates(newDataEncountered).then(() => {
              if (!finalized) {
                finalized = true;
                resolve(newDataEncountered);
              }
            }, (error) => {
              if (!finalized) {
                finalized = true;
                reject(error);
              }
            });
          }
        }, (error) => {
          if (!finalized) {
            finalized = true;
            reject(error);
          }
        });

      });
    });
  }

  private loadCandidatesFromPrefinery(startPage: number): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      var request = require('request');

      log.info(`requesting page ${startPage} of testers from prefinery...`);
      try {
        let options = {
          url: `https://api.prefinery.com/api/v2/betas/9505/testers.json?api_key=dypeGz4qErzRuN143ZVN2fk2SagFqKPN&page=${startPage}`,
          method: 'GET',
          headers: { 'Content-Type': 'application/json' },
          body: {},
          json: true
        };
        request(options, (error: any, response: any, prefineryUsers: any) => {
          if (error) {
            reject(`error retrieving data from the prefinery api: ${error}`);
            return;
          }
          _.each(prefineryUsers, (prefineryUser: any, index: number) => {
            if (_.includes(['active', 'applied'],prefineryUser.status)) {
              let candidate: any = self.buildCandidate(prefineryUser);
              self.candidates[candidate.userId] = candidate;
            }
          });
          self.importUnprocessedCandidates(false).then((newDataEncountered: boolean) => {
            self.showStats();
            if (newDataEncountered) {
              return self.loadCandidatesFromPrefinery(startPage + 1);
            } else {
              return Promise.resolve(undefined);
            }
          }).then(() => {
            resolve();
          }, (error) => {
            reject(error);
          });
        });
      } catch(error) {
        reject(`got error when attempting to get data from prefinery: ${error}`);
      }
    });
  }

  buildCandidate(prefineryUser: any) {
    let processedPrefineryUser: any = {
      importBatchId: this.importBatchId,
      id: prefineryUser.id,
      email: prefineryUser.email,
      ipAddress: prefineryUser.ip_address,
      joinedAt: prefineryUser.joined_at,
      firstName: prefineryUser.profile.first_name,
      lastName: prefineryUser.profile.last_name,
      country: prefineryUser.profile.country,
      phone: prefineryUser.profile.telephone,
      referralLink: prefineryUser.profile.http_referrer,
      referredBy: prefineryUser.referred_by || 'unknownuser@ur.technology',
      userReportedCountry: (_.find((prefineryUser.responses || []), (r: any) => { return r.question_id === 82186 }) || {}).answer,
      userReportedReferrer: (_.find((prefineryUser.responses || []), (r: any) => { return r.question_id === 82178 }) || {}).answer
    };
    processedPrefineryUser = _.mapValues(_.omitBy(processedPrefineryUser, _.isNil), (value: string) => { return _.trim(value || ''); });
    let candidate: any = this.buildNewUser(undefined, prefineryUser.profile.first_name, undefined, prefineryUser.profile.last_name, undefined);
    candidate.email = _.toLower(_.trim(prefineryUser.email || ''));
    candidate.prefineryUser = processedPrefineryUser;
    let matches = candidate.prefineryUser.referralLink.match(/[\?\&]r\=(\w+)\b/);
    if (matches && matches[1]) {
      candidate.referralCode = matches[1];
    }
    candidate.importStatus = 'unprocessed';
    candidate.userId = this.db.ref("/users").push().key;
    return candidate;
  }

  generateProfilePhotoUrl(user: any) {
    let colorScheme = _.sample([{
      background: "DD4747",
      foreground: "FFFFFF"
    }, {
      background: "ED6D54",
      foreground: "FFFFFF"
    }, {
      background: "FFBE5B",
      foreground: "FFFFFF"
    }, {
      background: "FFE559",
      foreground: "FFFFFF"
    }, {
      background: "e9F0A1",
      foreground: "000000"
    }, {
      background: "C79DC7",
      foreground: "000000"
    }, {
      background: "8ADED7",
      foreground: "000000"
    }, {
      background: "A1EDA1",
      foreground: "000000"
    }]);
    let initials = 'XX';
    if (user.firstName) {
      let firstLetters = user.firstName.match(/\b\w/g);
      initials = firstLetters ? firstLetters[0] : 'X';
      let lastNameFirstLetters = (user.lastName || '').match(/\b\w/g);
      if (lastNameFirstLetters) {
        initials = initials + lastNameFirstLetters[0];
      }
      initials = initials.toUpperCase();
    }
    return "https://dummyimage.com/100x100/" + colorScheme.background + "/" + colorScheme.foreground + "&text=" + initials;
  };

  private lookupUserByEmailLoosely(email: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUsersByEmail(email).then((matchingUsers) => {
        resolve(_.first(matchingUsers));
      }, (error) => {
        reject(error);
      });
    });
  }

}
