 // These methods were missing from the copy of firebase3.d.ts copied from angularfire2.

declare namespace firebase.database.ServerValue {
  var TIMESTAMP: any
}
declare namespace firebase.auth {
  interface Auth {
    createCustomToken(uid: string, options?: any): string;
  }
}
