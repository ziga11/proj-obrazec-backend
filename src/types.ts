/**
 * Represents a single row of the `Project` table.
 */
export interface Project {
        id?: number;
        creator_id?: number;
        title?: string;
        date_created?: string;
        json?: Record<string, any>;
        google_dir?: string;
        permission_id: number;
}

/**
 * Represents a single row of the `Account` table.
 */
export interface Account {
        id: number;
        google_id?: string;
        name: string;
        email: string;
        created_at?: Date;
        img_url?: string;
}

export interface Form {
        id: number;
        name: string;
        value: string;
        checked: boolean;
        date_modified: Date;
        parent_form_id: number | null;
        parent_heading_id: number | null;
}


export const projectPermission = {
        View: 1,
        Modify: 2,
        All: 3,
}
