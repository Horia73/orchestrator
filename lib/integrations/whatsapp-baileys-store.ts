import Database from 'better-sqlite3'
import fs from 'fs'
import path from 'path'

import type { WAMessage } from 'baileys'

export interface StoredChat {
    id: string
    name: string | null
    isGroup: boolean
    isReadOnly: boolean
    unreadCount: number
    timestamp: number | null
    lastMessageId: string | null
}

export interface StoredContact {
    id: string
    name: string | null
}

export interface StoredMessageRow {
    id: string
    chatId: string
    timestamp: number
    fromMe: boolean
    message: WAMessage
}

const STORE_FILENAME = 'store.db'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    name TEXT,
    is_group INTEGER NOT NULL DEFAULT 0,
    is_read_only INTEGER NOT NULL DEFAULT 0,
    unread_count INTEGER NOT NULL DEFAULT 0,
    timestamp INTEGER,
    last_message_id TEXT
);
CREATE TABLE IF NOT EXISTS contacts (
    id TEXT PRIMARY KEY,
    name TEXT
);
CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    timestamp INTEGER NOT NULL DEFAULT 0,
    from_me INTEGER NOT NULL DEFAULT 0,
    json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_chat_ts ON messages(chat_id, timestamp DESC);
`

// The disk store keeps the WhatsApp companion view alive across app restarts:
// WhatsApp only delivers chat history at QR-pairing time, so an in-memory-only
// store goes permanently blind on every deploy. It lives inside the Baileys
// auth directory on purpose — it shares the session's lifecycle (wiped on
// disconnect/re-pair, excluded from backups alongside the live session).
export class BaileysStore {
    private readonly db: Database.Database

    constructor(dir: string) {
        fs.mkdirSync(dir, { recursive: true })
        this.db = new Database(path.join(dir, STORE_FILENAME), { timeout: 10_000 })
        this.db.pragma('journal_mode = WAL')
        this.db.pragma('busy_timeout = 10000')
        this.db.exec(SCHEMA)
    }

    loadChats(): StoredChat[] {
        const rows = this.db.prepare(
            'SELECT id, name, is_group, is_read_only, unread_count, timestamp, last_message_id FROM chats'
        ).all() as Array<{
            id: string
            name: string | null
            is_group: number
            is_read_only: number
            unread_count: number
            timestamp: number | null
            last_message_id: string | null
        }>
        return rows.map(row => ({
            id: row.id,
            name: row.name,
            isGroup: Boolean(row.is_group),
            isReadOnly: Boolean(row.is_read_only),
            unreadCount: row.unread_count,
            timestamp: row.timestamp,
            lastMessageId: row.last_message_id,
        }))
    }

    loadContacts(): StoredContact[] {
        const rows = this.db.prepare('SELECT id, name FROM contacts').all() as Array<{ id: string; name: string | null }>
        return rows.map(row => ({ id: row.id, name: row.name }))
    }

    upsertChat(chat: StoredChat): void {
        this.db.prepare(`
            INSERT INTO chats (id, name, is_group, is_read_only, unread_count, timestamp, last_message_id)
            VALUES (@id, @name, @isGroup, @isReadOnly, @unreadCount, @timestamp, @lastMessageId)
            ON CONFLICT(id) DO UPDATE SET
                name = excluded.name,
                is_group = excluded.is_group,
                is_read_only = excluded.is_read_only,
                unread_count = excluded.unread_count,
                timestamp = excluded.timestamp,
                last_message_id = excluded.last_message_id
        `).run({
            id: chat.id,
            name: chat.name,
            isGroup: chat.isGroup ? 1 : 0,
            isReadOnly: chat.isReadOnly ? 1 : 0,
            unreadCount: chat.unreadCount,
            timestamp: chat.timestamp,
            lastMessageId: chat.lastMessageId,
        })
    }

    upsertContact(contact: StoredContact): void {
        this.db.prepare(`
            INSERT INTO contacts (id, name) VALUES (@id, @name)
            ON CONFLICT(id) DO UPDATE SET name = excluded.name
        `).run(contact)
    }

    hasMessage(id: string): boolean {
        return Boolean(this.db.prepare('SELECT 1 FROM messages WHERE id = ?').get(id))
    }

    upsertMessage(row: StoredMessageRow): void {
        this.db.prepare(`
            INSERT INTO messages (id, chat_id, timestamp, from_me, json)
            VALUES (@id, @chatId, @timestamp, @fromMe, @json)
            ON CONFLICT(id) DO UPDATE SET
                chat_id = excluded.chat_id,
                timestamp = excluded.timestamp,
                from_me = excluded.from_me,
                json = excluded.json
        `).run({
            id: row.id,
            chatId: row.chatId,
            timestamp: row.timestamp,
            fromMe: row.fromMe ? 1 : 0,
            json: serializeWaMessage(row.message),
        })
    }

    getMessageById(id: string): WAMessage | null {
        const row = this.db.prepare('SELECT json FROM messages WHERE id = ?').get(id) as { json: string } | undefined
        return row ? deserializeWaMessage(row.json) : null
    }

    /** Newest-first messages for a chat. */
    messagesForChat(chatId: string, limit: number, options: { fromMe?: boolean } = {}): WAMessage[] {
        const filter = options.fromMe === undefined ? '' : 'AND from_me = @fromMe'
        const rows = this.db.prepare(`
            SELECT json FROM messages
            WHERE chat_id = @chatId ${filter}
            ORDER BY timestamp DESC
            LIMIT @limit
        `).all({
            chatId,
            limit,
            ...(options.fromMe === undefined ? {} : { fromMe: options.fromMe ? 1 : 0 }),
        }) as Array<{ json: string }>
        return rows.map(row => deserializeWaMessage(row.json))
    }

    countMessages(): number {
        const row = this.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
        return row.n
    }

    transaction<T>(fn: () => T): T {
        return this.db.transaction(fn)()
    }

    close(): void {
        try {
            this.db.close()
        } catch {
            // Closing is best-effort; the file is removed with the session dir anyway.
        }
    }
}

// WAMessage protos hold Uint8Array media keys and Long timestamps. Buffers
// round-trip through the same {type:'Buffer'} envelope Baileys uses for
// creds.json; Long values are flattened to plain numbers, which both our
// readers (timestampFromUnknown) and protobuf re-encoding accept.
function serializeWaMessage(message: WAMessage): string {
    return JSON.stringify(message, (_key, value) => {
        if (typeof value === 'object' && value !== null) {
            const record = value as {
                type?: unknown
                data?: unknown
                toNumber?: unknown
                low?: unknown
                high?: unknown
                unsigned?: unknown
            }
            if (value instanceof Uint8Array) {
                return { type: 'Buffer', data: Buffer.from(value).toString('base64') }
            }
            if (record.type === 'Buffer' && (Array.isArray(record.data) || typeof record.data === 'string')) {
                const buffer = typeof record.data === 'string'
                    ? Buffer.from(record.data, 'base64')
                    : Buffer.from(record.data as number[])
                return { type: 'Buffer', data: buffer.toString('base64') }
            }
            if (
                typeof record.toNumber === 'function'
                && typeof record.low === 'number'
                && typeof record.high === 'number'
                && typeof record.unsigned === 'boolean'
            ) {
                return (record.toNumber as () => number)()
            }
        }
        return value
    })
}

function deserializeWaMessage(json: string): WAMessage {
    return JSON.parse(json, (_key, value) => {
        if (typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'Buffer') {
            const data = (value as { data?: unknown }).data
            if (typeof data === 'string') return Buffer.from(data, 'base64')
            if (Array.isArray(data)) return Buffer.from(data as number[])
        }
        return value
    }) as WAMessage
}
