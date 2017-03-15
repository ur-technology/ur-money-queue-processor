export type HandlerResponse = Promise<any>;

export interface IDVerifier {
    handleNationalIDScanVerification(userId: string, regionSet: string): HandlerResponse;
    bypassSelfieMatch(userID: string): Promise<any>
    matchSelfie(userID: string): Promise<any>
}
