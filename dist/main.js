import path from 'path';
import express from 'express';
import SQL from './sql.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import multer from 'multer';
import { googleDrive } from './drive.js';
import { google } from 'googleapis';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = process.env.PORT || "8080";
const sql = new SQL();
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 }
});
const oauth2Client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.header('Cross-Origin-Resource-Policy', 'cross-origin');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));
app.get('/api/project-list', async (_, res) => {
    try {
        const result = await sql.projectList();
        res.json(result);
    }
    catch (error) {
        console.error('Database query error:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});
app.get('/api/fetch-project/:project_id', async (req, res) => {
    try {
        const projectId = Number(req.params.project_id);
        const result = await sql.fetchProject(projectId);
        res.json(result);
    }
    catch (error) {
        console.error('Failed to fetch project:', error);
        res.status(500).json({ error: 'Failed to fetch project' });
    }
});
app.post('/api/create-project', async (req, res) => {
    try {
        const project = req.body;
        const projectId = await sql.createProject(project);
        res.json({ projectId: projectId });
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to create the project' });
    }
});
app.get('/api/auth/google', (req, res) => {
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
        const { tokens } = await oauth2Client.getToken(code);
        if (tokens.refresh_token) {
            await sql.saveToken(tokens.refresh_token, "refresh_token");
        }
        googleDrive.setToken(tokens.refresh_token);
        res.send('Authenticated! You can now upload.');
    }
    catch (error) {
        res.status(500).send('Auth failed');
    }
});
app.post('/api/upload-files/:project_id', upload.any(), async (req, res) => {
    try {
        const projectId = Number(req.params.project_id);
        const files = req.files;
        if (!files || files.length === 0) {
            return res.status(400).json({ error: 'No files uploaded' });
        }
        const savedToken = await sql.fetchToken("refresh_token");
        console.log(savedToken);
        if (!savedToken) {
            console.error("No refresh token found in DB.");
            return res.status(401).json({ error: 'Please authenticate with Google first.' });
        }
        googleDrive.setToken(savedToken);
        const googleDirId = await googleDrive.createDir(`${projectId}`);
        await sql.updateJsonPath(projectId, ["google_dir"], googleDirId);
        for (const file of files) {
            const response = await googleDrive.uploadFile(file, googleDirId);
            const fileId = response.id;
            const path = file.fieldname.split('.');
            await sql.updateJsonPath(projectId, path, fileId);
        }
        res.json({
            success: true,
            message: `${files.length} file(s) uploaded to Drive successfully`
        });
    }
    catch (err) {
        console.error('Drive upload error:', err);
        res.status(500).json({ error: 'Failed to upload files to Google Drive' });
    }
});
app.post('/api/update-project', async (req, res) => {
    try {
        const project = req.body;
        const result = await sql.updateProject(project);
        res.json(result);
    }
    catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Failed to update the project' });
    }
});
app.post("/api/delete-project/:project_id", async (req, res) => {
    try {
        const projectId = Number(req.params.project_id);
        const project = await sql.fetchProject(projectId);
        const savedToken = await sql.fetchToken("refresh_token");
        if (!savedToken) {
            console.error("No refresh token found in DB.");
            return res.status(401).json({ error: 'Please authenticate with Google first.' });
        }
        googleDrive.setToken(savedToken);
        const googleDir = project.json.google_dir;
        if (!googleDir) {
            await sql.deleteProject(projectId);
            return res.sendStatus(200);
        }
        const status = await googleDrive.trashDir(googleDir);
        if ([200, 404].includes(status)) {
            await sql.deleteProject(projectId);
            res.sendStatus(200);
        }
        else {
            res.sendStatus(500);
        }
    }
    catch (err) {
        console.error('Failed to delete project:', err);
        res.status(500).json({ error: 'Failed to delete project!' });
    }
});
/* app.use(`/${uploadsDir}`, express.static(path.join(rootDir, uploadsDir))); */
app.use((_, res) => {
    res.status(404).send('404 Not Found');
});
app.listen(PORT, () => {
    console.log(`serving on port ${PORT}`);
});
