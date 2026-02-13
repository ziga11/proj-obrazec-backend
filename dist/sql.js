import 'dotenv/config';
import pg from 'pg';
export class SQL {
    client;
    constructor() {
        this.client = new pg.Pool({
            connectionString: process.env.DATABASE_URL,
            ssl: { rejectUnauthorized: false },
            max: 1,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });
        this.client.on('error', (err) => {
            console.error('Unexpected pool error:', err);
        });
        this.client.query('SELECT NOW()')
            .then(() => console.log('Connected to Neon database'))
            .catch((err) => console.error('Failed to connect:', err));
    }
    async createProject(project) {
        const result = await this.client.query(`
		  INSERT INTO projektni_obrazec.project(title, creator_id, json)
		  	VALUES ($1, $2, $3)
		  ON CONFLICT (title) DO NOTHING
		  RETURNING id
		`, [project.title, project.creator_id, project.json]);
        return result.rows[0]?.id;
    }
    async updateJsonPath(projectId, path, value) {
        await this.client.query(`UPDATE projektni_obrazec.project 
			     SET json = jsonb_set(json, $1, $2::jsonb)
			 WHERE id = $3
			 `, [path, JSON.stringify(value), projectId]);
    }
    async updateProject(project) {
        const params = [];
        const setClauses = [];
        if (project.title) {
            params.push(project.title);
            setClauses.push(`title = $${params.length}`);
        }
        if (project.json) {
            params.push(project.json);
            setClauses.push(`json = $${params.length}`);
        }
        if (setClauses.length === 0) {
            return;
        }
        params.push(project.id);
        const updateQuery = `
			UPDATE projektni_obrazec.project 
				SET ${setClauses.join(', ')}
			WHERE
				id = $${params.length}
		`;
        await this.client.query(updateQuery, params);
    }
    async projectList() {
        const result = await this.client.query(`
			SELECT 
				p.id AS id,
				p.title AS title,
				a.id as creator_id,
				p.date_created as date_created,
				json->'osnovni_podatki' as json
			FROM projektni_obrazec.project as p
			JOIN projektni_obrazec.account a ON p.creator_id = a.id
			ORDER BY
				p.date_created
		`);
        const projArr = [];
        for (const row of result.rows) {
            projArr.push({
                id: row.id,
                title: row.title,
                creator_id: row.creator_id,
                json: row.json,
                date_created: row.date_created
            });
        }
        return projArr;
    }
    async fetchProject(projectId) {
        const result = await this.client.query(`
			SELECT 
				p.id AS id,
				p.title AS title,
				a.id as creator_id,
				p.date_created as date_created,
				p.json as json
			FROM projektni_obrazec.project as p
			JOIN projektni_obrazec.account a
				ON p.creator_id = a.id
			WHERE
				p.id = $1
			
		`, [projectId]);
        const row = result.rows[0];
        return {
            id: row.id,
            title: row.title,
            creator_id: row.creator_id,
            json: row.json,
        };
    }
    async deleteProject(id) {
        await this.client.query(`
			DELETE FROM projektni_obrazec.project WHERE id = $1
		`, [id]);
        await this.client.query(`
			DELETE FROM mobile.company WHERE id = $1
		`, [id]);
    }
    async fetchToken(type) {
        const resp = await this.client.query(`SELECT token FROM projektni_obrazec.token WHERE type = $1`, [type]);
        if (resp.rows.length === 0) {
            return null;
        }
        return resp.rows[0].token;
    }
    async saveToken(token, type) {
        if (!token)
            return;
        await this.client.query(`
			INSERT INTO projektni_obrazec.token(token, type)
			    VALUES ($1, $2)
			ON CONFLICT (type)
			    DO UPDATE
				SET token = EXCLUDED.token`, [token, type]);
    }
}
export default SQL;
