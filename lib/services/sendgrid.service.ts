import * as SendGrid from 'sendgrid';

export class SendGridService {
    private sendGrid: any;

    constructor(private sendgridApiKey: string) {
        this.sendGrid = SendGrid(sendgridApiKey);
    }

    send(
        from: string,
        to: string,
        subject: string,
        content: string,
        contentType: string = 'text/plain'
    ): Promise<any> {
        const mail = new SendGrid.mail.Mail(
            new SendGrid.mail.Email(from),
            subject,
            new SendGrid.mail.Email(to),
            new SendGrid.mail.Content(contentType, content)
        );
        const request = this.sendGrid.emptyRequest({
            method: 'POST',
            path: '/v3/mail/send',
            body: mail.toJSON()
        });

        return this.sendGrid.API(request);
    }
}
