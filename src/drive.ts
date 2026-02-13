import { drive_v3, google } from 'googleapis';
import { Readable } from 'stream';

class GoogleDriveService {
        oauth2Client: InstanceType<typeof google.auth.OAuth2>;
        drive: drive_v3.Drive;

        constructor() {
                this.oauth2Client = new google.auth.OAuth2({
                        clientId: process.env.GOOGLE_CLIENT_ID,
                        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
                        redirectUri: process.env.GOOGLE_REDIRECT_URI,
                });
                this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
        }

        setToken(refreshToken: string) {
                this.oauth2Client.setCredentials({
                        refresh_token: refreshToken
                });
        }

        async fetchOrCreateDir(folderName: string): Promise<string> {
                const parentId = process.env.GOOGLE_DRIVE_FOLDER_ID;

                const existingFolders = await this.drive.files.list({
                        q: `name = '${folderName}' and '${parentId}' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
                        fields: 'files(id)',
                        spaces: 'drive',
                });

                const files = existingFolders.data.files;

                if (files && files.length > 0) {
                        return files[0].id!;
                }

                const fileMetadata = {
                        name: folderName,
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: [parentId]
                };

                const folder = await this.drive.files.create({
                        requestBody: fileMetadata,
                        fields: 'id',
                });

                return folder.data.id!;
        }

        async uploadFile(file: Express.Multer.File, folderId: string): Promise<drive_v3.Schema$File> {
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

                const fileId = upload.data.id!;

                await this.drive.permissions.create({
                        fileId: fileId,
                        requestBody: {
                                role: 'reader',
                                type: 'anyone',
                        },
                });

                return upload.data;
        }

        async trashDir(id: string): Promise<number> {
                try {
                        const res = await this.drive.files.update({
                                fileId: id,
                                requestBody: { trashed: true }
                        });
                        return res.status;
                } catch (error: any) {
                        return error.response?.status || 500;
                }
        }
}

export const googleDrive = new GoogleDriveService();
