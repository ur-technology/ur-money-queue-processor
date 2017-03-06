let scryptAsync = require('scrypt-async');


export class PasswordService {
    private static _instance: PasswordService;

    static getInstance() {
        if (!PasswordService._instance) {
            PasswordService._instance = new PasswordService();
        }
        return PasswordService._instance;
    }

    hashPassword(rawPassword: string, salt: string) {
        return scryptAsync(
            rawPassword,
            salt,
            {
                N: 16384,
                r: 16,
                p: 1,
                dkLen: 64,
                encoding: 'hex'
            }
        );
    }
}
