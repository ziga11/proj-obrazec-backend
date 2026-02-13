import { google } from 'googleapis';
import { Readable } from 'stream';
class GoogleDriveService {
    oauth2Client;
    drive;
    constructor() {
        this.oauth2Client = new google.auth.OAuth2({
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            redirectUri: process.env.GOOGLE_REDIRECT_URI,
        });
        this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    }
    setToken(refreshToken) {
        this.oauth2Client.setCredentials({
            refresh_token: refreshToken
        });
    }
    async createDir(folderName) {
        const fileMetadata = {
            name: folderName,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [process.env.GOOGLE_DRIVE_FOLDER_ID]
        };
        const folder = await this.drive.files.create({
            requestBody: fileMetadata,
            fields: 'id',
        });
        return folder.data.id;
    }
    async uploadFile(file, folderId) {
        const upload = await this.drive.files.create({
            requestBody: {
                name: file.originalname,
                parents: [folderId],
            },
            media: {
                mimeType: file.mimetype,
                body: Readable.from(file.buffer),
            },
            fields: 'id, name',
        });
        const fileId = upload.data.id;
        await this.drive.permissions.create({
            fileId: fileId,
            requestBody: {
                role: 'reader',
                type: 'anyone',
            },
        });
        return upload.data;
    }
    async trashDir(id) {
        try {
            const res = await this.drive.files.update({
                fileId: id,
                requestBody: { trashed: true }
            });
            return res.status;
        }
        catch (error) {
            return error.response?.status || 500;
        }
    }
}
export const googleDrive = new GoogleDriveService();
