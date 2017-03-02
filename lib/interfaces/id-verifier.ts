export type HandlerResponse = Promise<any>;

export interface IDVerifier {
    handleNationalIDScanVerification(userId: string, regionSet: string): HandlerResponse;
    matchSelfie(userID: string): Promise<any>
}
