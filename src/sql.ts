import 'dotenv/config';
import { ClientNotification, InsertNotification, projectPermission, type Account, type Project } from './types.js';
import pg, { PoolClient, QueryResult } from 'pg';
type Pool = pg.Pool;

export class SQL {
        private client: Pool;

        constructor() {
                this.client = new pg.Pool({
                        connectionString: process.env.DATABASE_URL,
                        ssl: { rejectUnauthorized: false },
                        max: 1,
                        idleTimeoutMillis: 30000,
                        connectionTimeoutMillis: 60000,
                        statement_timeout: 90000
                });

                this.client.on('error', (err) => {
                        console.error('Unexpected pool error:', err);
                });

                this.client.query('SELECT NOW()')
                        .then(() => console.log('Connected to Neon database'))
                        .catch((err) => console.error('Failed to connect:', err));
        }


        async transaction<T>(callback: (client: PoolClient) => Promise<T>): Promise<T> {
                const client = await this.client.connect();
                try {
                        await client.query('BEGIN');
                        const result = await callback(client);
                        await client.query('COMMIT');
                        return result;
                } catch (err) {
                        await client.query('ROLLBACK');
                        throw err;
                } finally {
                        client.release();
                }
        }

        async upsertProject(project: Project, trx?: PoolClient): Promise<number> {
                const db = trx || this.client;
                const result = await db.query(`
                  INSERT INTO projektni_obrazec.project(title, creator_id, json)
                        VALUES ($1, $2, $3)
                  ON CONFLICT (title) DO UPDATE
                        SET json = EXCLUDED.json
                  RETURNING id
                `, [project.title, project.creator_id, project.json]);

                const projId = result.rows[0].id
                this.addUserToProject(projId, projectPermission.All, { accountId: project.creator_id });
                return projId;
        }

        setNestedValue(obj: any, path: string[], value: any) {
                let current = obj;
                for (let i = 0; i < path.length - 1; i++) {
                        if (!current[path[i]]) return;
                        current = current[path[i]];
                }
                current[path[path.length - 1]] = value;
        }

        async updateFullJson(projectId: number, updates: { path: string[], id: string }[], trx?: PoolClient) {
                const db = trx || this.client;
                const res = await db.query('SELECT json FROM projektni_obrazec.project WHERE id = $1', [projectId]);
                let fullJson = res.rows[0].json;

                updates.forEach(upd => {
                        this.setNestedValue(fullJson, upd.path, upd.id);
                });

                await db.query(
                        `UPDATE projektni_obrazec.project SET json = $1 WHERE id = $2`,
                        [JSON.stringify(fullJson), projectId]
                );
        }

        async setGoogleDir(projectId: number, googleDir: string, trx?: PoolClient) {
                const db = trx || this.client;

                await db.query(
                        `UPDATE projektni_obrazec.project 
			     SET google_dir = $2
			 WHERE id = $1
			 `, [projectId, googleDir]
                );
        }

        async projectList(accountId: number): Promise<Array<Project>> {
                const query = `
                        SELECT
                                p.id AS id,
                                p.title AS title,
                                p.creator_id as creator_id,
                                p.date_created as date_created,
                                json->'osnovni_podatki' as json,
                                pal.permission_id as permission_id
                        FROM projektni_obrazec.project_account_link as pal
                        LEFT JOIN projektni_obrazec.project p
                                ON p.id = pal.project_id
                        WHERE pal.account_id = $1
                        ORDER BY
                                p.date_created`;

                const result = await this.client.query(query, [accountId]);
                return result.rows.map(row => row as Project);
        }

        async fetchProject(projectId: number, accountId: number): Promise<Project> {
                const result = await this.client.query(`
			SELECT 
				p.id AS id,
				p.title AS title,
				p.creator_id as creator_id,
				p.date_created as date_created,
				p.json as json,
                                p.google_dir,
                                pal.permission_id as permission_id
			FROM projektni_obrazec.project as p
                        LEFT JOIN projektni_obrazec.project_account_link pal
                                ON pal.project_id = p.id
			WHERE
				p.id = $1 AND
                                pal.account_id = $2
			
		`, [projectId, accountId]);

                const row = result.rows[0];

                return {
                        id: row.id,
                        title: row.title,
                        creator_id: row.creator_id,
                        json: row.json,
                        google_dir: row.google_dir,
                        permission_id: row.permission_id
                } as Project;
        }

        async deleteProject(id: number) {
                const { rows } = await this.client.query(
                        `DELETE FROM projektni_obrazec.project WHERE id = $1 RETURNING title`,
                        [id]);

                const title = rows[0]?.title;
                await this.client.query(`
			DELETE FROM mobile.company WHERE name = $1
		`, [title]);

        }

        async fetchToken(type: string, trx?: PoolClient): Promise<string | null> {
                const db = trx || this.client;
                const resp = await db.query(
                        `SELECT token FROM projektni_obrazec.token WHERE type = $1`,
                        [type]
                );

                if (resp.rows.length === 0) {
                        return null;
                }

                return resp.rows[0].token;
        }

        async saveToken(token: string, type: string) {
                if (!token) return;

                await this.client.query(`
			INSERT INTO projektni_obrazec.token(token, type)
			    VALUES ($1, $2)
			ON CONFLICT (type)
			    DO UPDATE
				SET token = EXCLUDED.token`, [token, type]);
        }

        async getAccById(accId: number): Promise<Account> {
                const query = `SELECT * FROM projektni_obrazec.account WHERE id = $1`

                return (await this.client.query(query, [accId])).rows[0] as Account;
        }

        async getProjectById(projId: number): Promise<Project> {
                const query = `SELECT
                                        id AS id,
                                        title AS title,
                                        creator_id as creator_id,
                                        date_created as date_created,
                                        json->'osnovni_podatki' as json
                                FROM projektni_obrazec.project
                                WHERE id = $1`;

                const result = await this.client.query(query, [projId])

                return result.rows[0] as Project;
        }

        async getOrCreateAcc({
                googleId,
                name,
                email,
                imgUrl,
                accId
        }: {
                googleId?: string,
                name?: string,
                imgUrl?: string,
                accId?: number,
                email?: string
        } = {}): Promise<Account> {
                let query: string;
                let data: QueryResult<any>;

                if (accId) {
                        query = `SELECT id,
                                        name,
                                        email,
                                        img_url,
                                        date_created
                                FROM projektni_obrazec.account
                                WHERE id = $1`

                        data = await this.client.query(query, [accId]);
                }
                else {
                        query = `
                                INSERT INTO projektni_obrazec.account (google_id, name, email, img_url)
                                VALUES ($1, $2, $3, $4)
                                ON CONFLICT (google_id) 
                                DO UPDATE SET 
                                    name = EXCLUDED.name,
                                    email = EXCLUDED.email,
                                    img_url = COALESCE(EXCLUDED.img_url, account.img_url)
                                RETURNING id, name, email, img_url, date_created;
                            `;

                        data = await this.client.query(query, [googleId, name, email, imgUrl]);
                }

                const acc = data.rows[0];

                return {
                        id: acc.id,
                        name: acc.name,
                        email: acc.email,
                        img_url: acc.img_url,
                        created_at: acc.date_created,
                } as Account;
        }

        async authorizedAccounts(projectId: number): Promise<Array<{ account_id: number, permission_id: number }>> {
                const query = `
                        SELECT account_id, permission_id FROM projektni_obrazec.project_account_link
                                WHERE project_id = $1;
                    `;

                const data = await this.client.query<{ account_id: number, permission_id: number }>(query, [projectId]);

                return data.rows;
        }


        async addUserToProject(projectId: number, permissionId: number, { accountId, email }: { accountId?: number; email?: string } = {}): Promise<void> {
                const query = `
                        INSERT INTO projektni_obrazec.project_account_link(account_id, project_id, permission_id)
                        SELECT 
                            COALESCE($1::int, (SELECT id FROM projektni_obrazec.account WHERE email = $2)), $3, $4
                        ON CONFLICT (account_id, project_id) DO NOTHING;
                    `;

                await this.client.query(query, [accountId ?? null, email ?? null, projectId, permissionId]);
        }

        async sendNotification(notification: InsertNotification): Promise<void> {
                const query = `
                        INSERT INTO projektni_obrazec.notification(content, from_acc_id, to_acc_id, type, metadata)
                        SELECT 
                            $1, $2,
                            COALESCE($3::int,
                                (SELECT id FROM projektni_obrazec.account WHERE email = $4)
                            ),
                            $5, $6
                        ON CONFLICT (from_acc_id, metadata, state) DO NOTHING;
                    `;

                await this.client.query(query,
                        [notification.content,
                        notification.from_acc_id,
                        notification.to_acc_id,
                        notification.to_acc_email ?? null,
                        notification.type,
                        notification.metadata]);
        }

        async fetchNotifications(accountId: number): Promise<Array<ClientNotification>> {
                const query = `
                        SELECT
                            n.id as id,
                            n.content as content,
                            n.type as type,
                            n.state as state,
                            n.created_at as created_at,
                            to_jsonb(a) as from_acc
                        FROM projektni_obrazec.notification n
                        LEFT JOIN projektni_obrazec.account a ON n.from_acc_id = a.id
                        WHERE n.to_acc_id = $1 AND hidden = 'false'`;

                const result = await this.client.query(query, [accountId]);

                return result.rows;
        }

        async deleteNotification(notificationId: number) {
                const query = `DELETE FROM projektni_obrazec.notification WHERE id = $1`
                await this.client.query(query, [notificationId]);
        }

        async notificationResponse(notificationId: number, state: string): Promise<any> {
                const query = `UPDATE projektni_obrazec.notification
                                   SET state = $2,
                                       hidden = 'true'
                                WHERE id = $1
                                RETURNING from_acc_id, metadata`

                const result = await this.client.query(query, [notificationId, state]);

                return result.rows[0];
        }

        async projectAccounts(projectId: number): Promise<Array<Account>> {
                const query = `
                        SELECT
                                a.id,
                                name,
                                email,
                                img_url,
                                pal.permission_id
                        FROM projektni_obrazec.account a
                        JOIN projektni_obrazec.project_account_link pal ON
                                pal.account_id = a.id
                        WHERE project_id = $1;
                    `;

                return (await this.client.query<Account>(query, [projectId])).rows;
        }

        async removeUserFromProject(projectId: number, accountId: number): Promise<void> {
                const query = `
                        DELETE FROM projektni_obrazec.project_account_link
                        WHERE 
                                account_id = $1 AND
                                project_id = $2`;

                await this.client.query(query, [accountId, projectId]);
        }
}

export const sql = new SQL();
