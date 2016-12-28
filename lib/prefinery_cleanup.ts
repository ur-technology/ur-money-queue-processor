import * as firebase from 'firebase';
import * as _ from 'lodash';
import * as log from 'loglevel';
import {QueueProcessor} from './queue_processor';

export class PrefineryCleanupQueueProcessor extends QueueProcessor {
  candidates: any;
  importBatchId: string;

  init(): Promise<any>[] {
    return [
      this.ensureQueueSpecLoaded("/prefineryCleanupQueue/specs/import", {
        "start_state": "ready_to_import",
        "in_progress_state": "processing",
        "error_state": "error",
        "timeout": 120000,
        "retries": 5
      }),
      this.setUpPrefineryCleanupQueue()
    ];
  }

  private setUpPrefineryCleanupQueue(): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      // make sure there is at least one task in the queue
      let tasksRef = self.db.ref(`/prefineryCleanupQueue/tasks`);
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
    let queueRef = self.db.ref("/prefineryCleanupQueue");

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
      }, 0 * 1000);
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

      let existingUser: any;
      let resolveValue: string;
      self.lookupUserByPrefineryId(candidate.prefineryUser.id).then((matchingUser: any) => {
        if (!matchingUser) {
          return self.lookupUserByEmailLoosely(candidate.email).then((matchingUser) => {
            if (matchingUser) {
              log.info(`matching email ${candidate.email} but missing prefinery id ${candidate.prefineryUser.id}`);
              return Promise.reject('skipped-for-matching-email-but-missing-prefinery-id');
            } else if (_.includes(candidate.prefineryUser.status, ['applied', 'active'])) {
              return Promise.reject('skipped-for-missing-email-and-prefinery-id-with-valid-status');
            } else {
              return Promise.reject('skipped-for-missing-email-and-prefinery-id-with-invalid-status');
            }
          });
        }
        existingUser = matchingUser;
        if (_.toNumber(existingUser.prefineryUser.id) !== _.toNumber(candidate.prefineryUser.id)) {
          return Promise.reject('skipped-for-having-mismatched-prefinery-ids');
        }
        return self.db.ref(`/users/${existingUser.userId}/prefineryUser`).set(candidate.prefineryUser);
      }).then(() => {
        return self.db.ref(`/users/${existingUser.userId}`).update({ referralCode: candidate.referralCode });
      }).then(() => {
        resolve('updated-prefinery-data');
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
            let candidate: any = self.buildCandidate(prefineryUser);
            self.candidates[candidate.userId] = candidate;
          });
          self.importUnprocessedCandidates(false).then((newDataEncountered: boolean) => {
            self.showStats();
            if (!_.isEmpty(prefineryUsers)) {
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
    let candidate: any = this.buildNewUser(undefined, prefineryUser.profile.first_name, undefined, prefineryUser.profile.last_name, undefined);

    let p: any = {
      importBatchId: this.importBatchId,
      id: prefineryUser.id,
      status: prefineryUser.status,
      email: prefineryUser.email,
      ipAddress: prefineryUser.profile.ip,
      joinedAt: prefineryUser.joined_at,
      firstName: prefineryUser.profile.first_name,
      lastName: prefineryUser.profile.last_name,
      country: prefineryUser.profile.country,
      phone: prefineryUser.profile.telephone,
      httpReferrer: prefineryUser.profile.http_referrer,
      referredBy: prefineryUser.referred_by || 'unknownuser@ur.technology',
      shareLink: prefineryUser.share_link,
      userReportedCountry: (_.find((prefineryUser.responses || []), (r: any) => { return r.question_id === 82186 }) || {}).answer,
      userReportedReferrer: (_.find((prefineryUser.responses || []), (r: any) => { return r.question_id === 82178 }) || {}).answer
    };
    candidate.prefineryUser = _.mapValues(_.omitBy(p, _.isNil), (val: string) => { return _.trim(val || ''); });

    let referralCodeMatches = (candidate.prefineryUser.shareLink || '').match(/[\?\&]r\=(\w+)\b/);
    if (referralCodeMatches && referralCodeMatches[1]) {
      candidate.referralCode = referralCodeMatches[1];
    }

    candidate.email = _.toLower(_.trim(prefineryUser.email || ''));
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

  private lookupUserByPrefineryId(id: string): Promise<any> {
    let self = this;
    return new Promise((resolve, reject) => {
      self.lookupUsersByPrefineryId(id).then((matchingUsers) => {
        resolve(_.first(matchingUsers));
      }, (error) => {
        reject(error);
      });
    });
  }

}