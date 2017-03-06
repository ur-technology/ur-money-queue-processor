import * as _ from 'lodash';

let scryptAsync = require('scrypt-async');

export class PasswordService {
    private static _instance: PasswordService;

    static getInstance() {
        if (!PasswordService._instance) {
            PasswordService._instance = new PasswordService();
        }
        return PasswordService._instance;
    }

    generateCode(len = 6) {
        let chars: string = '23456789abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ';
        return _.sampleSize(chars, len).join('');
    }
    
    hashPassword(rawPassword: string, salt: string) {
        return new Promise((resolve, reject) => {
            scryptAsync(
                rawPassword,
                salt,
                {
                    N: 16384,
                    r: 16,
                    p: 1,
                    dkLen: 64,
                    encoding: 'hex'
                },
                (hashedPassword: string) => {
                    resolve(hashedPassword);
                }
            );
        });
    }
}
