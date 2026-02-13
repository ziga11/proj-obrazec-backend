import express from 'express';
import session from 'express-session';
import { createClient } from 'redis';
import { RedisStore } from 'connect-redis';
import RedisMock from 'redis-mock';
import SQL from './sql.js';
import multer from 'multer';
import { googleDrive } from './drive.js';
import { google } from 'googleapis';
import { PoolClient } from 'pg';

const PORT = process.env.PORT || "8080";
const sql = new SQL();


const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: 10 * 1024 * 1024 }
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
        redisClient.connect().catch(console.error);
} else {
        console.log("creating redis mock");
        redisClient = RedisMock.createClient();
}

const store = process.env.NODE_ENV === 'production'
        ? new RedisStore({ client: redisClient, prefix: "proj-obrazec:" })
        : undefined;


const app = express();
app.use(express.json());
app.use((req, res, next) => {
        const origin = req.headers.origin;
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Access-Control-Allow-Credentials', 'true');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
        res.header('Cross-Origin-Resource-Policy', 'cross-origin');
        res.header('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');

        if (req.method === 'OPTIONS') {
                return res.sendStatus(200);
        }

        next();
});

app.use(session({
        store: store,
        secret: process.env.SESSION_SECRET,
        resave: false,
        saveUninitialized: false,
        cookie: {
                secure: process.env.NODE_ENV === "production",
                httpOnly: true,
                sameSite: 'lax',
                maxAge: 1000 * 60 * 60 * 24
        }
}));

const checkAuthAndAuthorization = async (req, res, next) => {
        if (!req.session || !req.session.accId) {
                console.log(req.session, req.session.accId);
                return res.status(401).json({ error: 'UnAuthenticated' });
        }

        const projectId = Number(req.params.project_id || req.body.project_id || "-1");

        if (projectId !== -1) {
                try {
                        const authorizedAccs = await sql.authorizedAccounts(projectId);

                        if (!authorizedAccs.includes(req.session.accId)) {
                                return res.status(403).json({ error: 'Access to this project denied' });
                        }
                } catch (err) {
                        console.error("Auth check error:", err);
                        return res.status(500).json({ error: 'Internal server error during auth check' });
                }
        }

        return next();
};

app.get('/api/project-list', checkAuthAndAuthorization, async (_, res) => {
        try {
                const result = await sql.projectList();
                res.json(result);
        } catch (error) {
                console.error('Database query error:', error);
                res.status(500).json({ error: 'Internal Server Error' });
        }
});

app.get('/api/fetch-project/:project_id', checkAuthAndAuthorization, async (req, res) => {
        try {
                const projectId = Number(req.params.project_id);

                const result = await sql.fetchProject(projectId);

                res.json(result);
        } catch (error) {
                console.error('Failed to fetch project:', error);
                res.status(500).json({ error: 'Failed to fetch project' });
        }
});

async function processFiles(projectId: number, files: Express.Multer.File[], trx: PoolClient): Promise<number> {
        if (!files || files.length === 0) return 0;

        const savedToken = await sql.fetchToken("refresh_token", trx);
        if (!savedToken) {
                throw new Error('NOT_AUTHENTICATED');
        }
        googleDrive.setToken(savedToken);

        const googleDirId = await googleDrive.fetchOrCreateDir(`${projectId}`);
        await sql.setGoogleDir(projectId, googleDirId, trx);


        const updates: { path: string[], id: string }[] = [];

        for (const file of files) {
                const response = await googleDrive.uploadFile(file, googleDirId);
                const path = file.fieldname.split('.');
                updates.push({ path, id: response.id });
        }

        await sql.updateFullJson(projectId, updates, trx);

        return files.length;
}

app.post('/api/upsert-project', checkAuthAndAuthorization, upload.any(), async (req, res) => {
        try {
                const project = JSON.parse(req.body.project);
                const files = req.files as Express.Multer.File[];

                const result = await sql.transaction(async (trx) => {
                        const projectId = await sql.upsertProject(project, trx);
                        const fileCount = await processFiles(projectId, files, trx);

                        return { projectId, fileCount };
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

app.post("/api/delete-project/:project_id", checkAuthAndAuthorization, async (req, res) => {
        try {
                const projectId = Number(req.params.project_id);
                const project = await sql.fetchProject(projectId);

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
