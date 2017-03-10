let path = require('path');
let nodemailer = require('nodemailer');
let sgTransport = require('nodemailer-sendgrid-transport');
let EmailTemplate = require('email-templates').EmailTemplate;


export class MailerService {
    private static _instance: MailerService;
    private mailer: any;
    private templatesRoot: string;

    constructor(private sgApiKey: string) {
        this.mailer = nodemailer.createTransport(sgTransport({
            auth: {
                api_key: sgApiKey
            }
        }));

        this.templatesRoot = path.resolve(__dirname, '..', '..', 'mails');
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

    sendWithTemplate(from: string, to: string, templateName: string, context: any): Promise<any> {
        const templatesDir = path.join(this.templatesRoot, templateName);
        const emailTemplates = new EmailTemplate(templatesDir);

        return emailTemplates
            .render(context)
            .then((result: any) => {
                return this.send(
                    from,
                    to,
                    result.subject,
                    result.text,
                    result.html
                );
            });
    }
}
