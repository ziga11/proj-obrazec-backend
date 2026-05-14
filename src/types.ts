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

export interface InsertNotification {
        id?: number;
        from_acc_id: number;
        to_acc_id?: number;
        to_acc_email?: string;
        metadata?: string;
        type: string;
        content: string;
}

export interface ClientNotification {
        id: number;
        from_acc: Account;
        type: string;
        content: string;
        state: string;
        created_at: Date;
}

export const projectPermission = {
        View: 1,
        Modify: 2,
        All: 3,
}

