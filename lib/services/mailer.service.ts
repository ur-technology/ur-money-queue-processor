let nodemailer = require('nodemailer');
let sgTransport = require('nodemailer-sendgrid-transport');


export class MailerService {
    private static _instance: MailerService;
    private mailer: any;

    constructor(private sgApiKey: string) {
        this.mailer = nodemailer.createTransport(sgTransport({
            auth: {
                api_key: sgApiKey
            }
        }));
    }

    static getInstance() {
        if (!MailerService._instance) {
            MailerService._instance = new MailerService(process.env.SENDGRID_API_KEY);
        }
        return MailerService._instance;
    }

    send(
        from: string,
        to: string,
        subject: string,
        text: string,
        html: string
    ): Promise<any> {
        return new Promise((resolve, reject) => {
            this.mailer
                .sendMail({
                    from,
                    to,
                    subject,
                    text,
                    html
                }, (err: any, info: any) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve(info);
                    }
                });
        });
    }
}
