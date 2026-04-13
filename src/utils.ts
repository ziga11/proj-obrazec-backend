import { PoolClient } from "pg";
import { Request, Response, NextFunction } from 'express';
import { googleDrive } from "./drive.js";
import { sql } from "./sql.js";
import { projectPermission } from './types.js';

export async function processFiles(projectId: number, files: Express.Multer.File[], trx: PoolClient): Promise<number> {
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

function endpointPermission(endpoint: string): number {
        if (endpoint.includes("fetch-project")) {
                return projectPermission.View;
        }
        else if (endpoint.includes("upsert-project")) {
                return projectPermission.Modify;
        }
        return projectPermission.All;
}

async function isAuthorized(projectId: number, accountId: number, permissionType: number): Promise<boolean> {
        const authorizedAccounts = await sql.authorizedAccounts(projectId);

        for (const acc of authorizedAccounts) {
                if (acc.account_id != accountId) continue;

                return permissionType >= acc.permission_id;
        }

        return false;
}


export function checkAuthAndAuthorization(req: Request, res: Response, next: NextFunction) {
        if (!req.session || !req.session.accId) {
                console.log("unsuccessfull auth", req.session, req.session.accId);
                return res.status(401).json({ error: 'UnAuthenticated' });
        }

        const projectId = Number(req.params.project_id || req.body.project_id || "-1");

        if (projectId !== -1) {
                const requiredPermission = endpointPermission(req.path);
                const allowed = isAuthorized(projectId, Number(req.session.accId), requiredPermission)

                if (!allowed) {
                        return res.status(403).json({ error: 'Access to this project feature denied' });
                }
        }

        return next();
};
