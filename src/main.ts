import express from 'express';
import session from 'express-session';
import { createClient } from 'redis';
import { RedisStore } from 'connect-redis';
import RedisMock from 'redis-mock';
import multer from 'multer';
import { sql } from './sql.js';
import { googleDrive } from './drive.js';
import { google } from 'googleapis';
import { checkAuthAndAuthorization, processFiles } from './utils.js';
import cors from "cors"
import { InsertNotification } from './types.js';

const PORT = process.env.PORT || "8080";


const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 40 * 1024 * 1024 }
});

const oauth2Client = new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
);

let redisClient: any;
if (process.env.NODE_ENV === 'production') {
        console.log("prod");
        redisClient = createClient({ url: process.env.REDIS_URL });
        await redisClient.connect().catch(console.error);
} else {
        console.log("creating redis mock");
        redisClient = RedisMock.createClient();
}

const store = process.env.NODE_ENV === 'production'
        ? new RedisStore({ client: redisClient, prefix: "proj-obrazec:" })
        : undefined;


const app = express();
const allowedOrigins = [
        'http://localhost:5173',
        'https://proj-obrazec.vercel.app'
];

app.use(cors({
        origin: (origin, callback) => {
                if (!origin) return callback(null, true);

                if (allowedOrigins.includes(origin)) {
                        callback(null, true);
                } else {
                        callback(new Error('CORS policy violation'), false);
                }
        },
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization']
}));

app.set('trust proxy', 1);
app.use(express.json());

app.use(session({
        store: store,
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
                sameSite: process.env.NODE_ENV === "production" ? 'none' : 'lax',
                secure: process.env.NODE_ENV === "production",
                httpOnly: true,
                maxAge: 1000 * 60 * 60 * 24
        }
}));

app.get('/api/project-list', checkAuthAndAuthorization, async (req, res) => {
        try {
                const accId = req.session.accId;
                const result = await sql.projectList(accId);
                res.json(result);
        } catch (error) {
                console.error('Database query error:', error);
                res.status(500).json({ error: 'Internal Server Error' });
        }
});

app.get('/api/fetch-project/:project_id', checkAuthAndAuthorization, async (req, res) => {
        try {
                const projectId = Number(req.params.project_id);
                const accId = req.session.accId;

                const result = await sql.fetchProject(projectId, accId);

                res.json(result);
        } catch (error) {
                console.error('Failed to fetch project:', error);
                res.status(500).json({ error: 'Failed to fetch project' });
        }
});


app.post('/api/upsert-project', checkAuthAndAuthorization, upload.any(), async (req, res) => {
        try {
                const project = JSON.parse(req.body.project);
                const files = req.files as Express.Multer.File[];

                const result = await sql.transaction(async (trx) => {
                        try {
                                const projectId = await sql.upsertProject(project, trx);
                                const fileCount = await processFiles(projectId, files, trx);
                                return { projectId, fileCount };
                        } catch (err) {
                                res.status(500).json({ "success": false })
                                console.error(err)
                        }
                });

                res.json({
                        projectId: result.projectId,
                        success: true,
                        message: result.fileCount > 0
                                ? `Project created/modified with ${result.fileCount} file(s)`
                                : 'Project created'
                });

        } catch (err) {
                if (err.message === 'NOT_AUTHENTICATED') {
                        return res.status(401).json({ error: 'Please authenticate with Google first.' });
                }
                res.status(500).json({ error: `Failed to create project: ${err.message}` });
        }
});

app.get('/api/auth/google', (_, res) => {
        const url = oauth2Client.generateAuthUrl({
                access_type: 'offline',
                scope: 'https://www.googleapis.com/auth/drive.file',
                prompt: 'consent'
        });

        res.redirect(url);
});

app.get('/api/auth/callback', async (req, res) => {
        const { code } = req.query;
        try {
                const { tokens } = await oauth2Client.getToken(code as string);

                if (tokens.refresh_token) {
                        await sql.saveToken(tokens.refresh_token, "refresh_token");
                }

                googleDrive.setToken(tokens.refresh_token);

                res.send('Authenticated! You can now upload.');
        } catch (error) {
                res.status(500).send('Auth failed');
        }
});

app.post('/api/auth/google-login', async (req, res) => {
        const idToken = req.body.token;

        if (!idToken) {
                return res.status(400).send("No token provided");
        }

        const ticket = await oauth2Client.verifyIdToken({ idToken });
        const payload = ticket.getPayload();

        const acc = await sql.getOrCreateAcc({ googleId: payload.sub, name: payload.name, email: payload.email, imgUrl: payload.picture });

        req.session.accId = acc.id;

        res.json(acc);
});

app.get('/api/me', async (req, res) => {
        if (!req.session || !req.session.accId) {
                console.log("not authenticated --> api/me")
                return res.status(401).json({ error: "Not authenticated" });
        }

        try {
                const user = await sql.getOrCreateAcc({ accId: req.session.accId });
                if (!user) {
                        req.session.destroy(null);
                        return res.status(401).json({ error: "User not found" });
                }

                res.json(user);
        } catch (err) {
                res.status(500).json({ error: "Server error" });
        }
});

app.post('/api/add-account-to-project', checkAuthAndAuthorization, async (req, res) => {
        try {
                const { email, project_id, permission_id } = req.body;

                await sql.addUserToProject(project_id, permission_id, { email: email });

                res.status(200).json({ success: true });
        } catch (err) {
                if (err instanceof Error && err.message.includes('null value in column "account_id"')) {
                        res.status(400).json({ error: "User does not exist" });
                } else {
                        console.log(`Server error`, err);
                        res.status(500).json({ error: `Server error: ${err}` });
                }
        }
});

app.post('/api/send-notification', checkAuthAndAuthorization, async (req, res) => {
        try {
                const n = req.body as InsertNotification;

                console.log(n);

                await sql.sendNotification(n)

                res.status(200).json({ success: true });
        } catch (err) {
                console.log(err);
        }
        /*         res.status(200).json({ success: true }); */
});

app.post('/api/notification-response', checkAuthAndAuthorization, async (req, res) => {
        try {
                const { notification_id, state } = req.body;

                const result = await sql.notificationResponse(notification_id, state);
                const accId = req.session.accId;

                if (state == "Accepted" && result.metadata.length > 0) {
                        const metadataObj = JSON.parse(result.metadata);
                        await sql.addUserToProject(metadataObj.project_id, metadataObj.permission, { accountId: accId });

                        const user = await sql.getAccById(accId);
                        const project = await sql.getProjectById(metadataObj.project_id);
                        await sql.sendNotification({
                                content: `User ${user.name} (${user.email}) has accepted your invitation to the project ${project.title}`,
                                from_acc_id: accId,
                                to_acc_id: result.from_acc_id,
                                type: "message",
                        } as InsertNotification);
                }

                res.status(200).json({ success: true });
        } catch (err) {
                console.log(err);
                res.status(500).json({ error: `Failed to process notification resposne ${err}` });
        }
});

app.post('/api/list-notifications', checkAuthAndAuthorization, async (req, res) => {
        try {
                const accId = Number(req.session.accId);

                const notifications = await sql.fetchNotifications(accId);

                res.json(notifications);
        } catch (err) {
                console.log(err);
                res.status(500).json({ error: `Failed to fetch notifications ${err}` });
        }
        /*         res.status(200).json({ success: true }); */
});

app.post('/api/remove-account-from-project', checkAuthAndAuthorization, async (req, res) => {
        try {
                const { account_id: accountId, project_id: projectId } = req.body;

                if (!accountId || !projectId) {
                        return res.status(400).json({ error: "Missing required fields" });
                }

                await sql.removeUserFromProject(projectId, accountId);

                res.sendStatus(200);
        } catch (err) {
                console.log(`Server error ${err}`);
                res.status(500).json({ error: `Server error ${err}` });
        }
});

app.get('/api/project-accounts/:project_id', checkAuthAndAuthorization, async (req, res) => {
        try {
                const projectId = Number(req.params.project_id);

                const accs = await sql.projectAccounts(projectId);

                res.json(accs);
        } catch (err) {
                res.status(500).json({ error: "Server error" });
        }
});

app.post("/api/delete-project/:project_id", checkAuthAndAuthorization, async (req, res) => {
        try {
                const projectId = Number(req.params.project_id);
                const project = await sql.fetchProject(projectId, req.session.accId);

                const savedToken = await sql.fetchToken("refresh_token");
                if (!savedToken) {
                        console.error("No refresh token found in DB.");
                        return res.status(401).json({ error: 'Please authenticate with Google first.' });
                }

                googleDrive.setToken(savedToken);

                const googleDir = project.google_dir;

                if (!googleDir) {
                        console.log("google dir isn't set", projectId);

                        await sql.deleteProject(projectId);
                        return res.sendStatus(200);
                }

                const status = await googleDrive.trashDir(googleDir);
                if ([200, 404].includes(status)) {
                        await sql.deleteProject(projectId);
                        res.sendStatus(204);
                } else {
                        res.sendStatus(500);
                }
        } catch (err) {
                console.error('Failed to delete project:', err);
                res.status(500).json({ error: 'Failed to delete project!' });
        }
})

app.use((_, res) => {
        res.status(404).send('404 Not Found');
});

app.listen(PORT, () => {
        console.log(`serving on port ${PORT}`)
});
