import type { ToolDef, ToolParameter, ToolResult } from '@/lib/ai/agents/types'
import {
    GOOGLE_CONTACTS_OTHER_FIELDS,
    GOOGLE_CONTACTS_PERSON_FIELDS,
    googleContactsBatchCreateContacts,
    googleContactsBatchDeleteContacts,
    googleContactsBatchGetPeople,
    googleContactsBatchUpdateContacts,
    googleContactsCopyOtherContactToMyContacts,
    googleContactsCreateContact,
    googleContactsCreateContactGroup,
    googleContactsDeleteContact,
    googleContactsDeleteContactGroup,
    googleContactsGetContactGroup,
    googleContactsGetPerson,
    googleContactsListConnections,
    googleContactsListContactGroups,
    googleContactsListOtherContacts,
    googleContactsModifyContactGroupMembers,
    googleContactsSearchContacts,
    googleContactsSearchOtherContacts,
    googleContactsUpdateContact,
    googleContactsUpdateContactGroup,
} from '@/lib/integrations/google-contacts'
import { booleanArg, numberArg, stringArg } from './helpers'

export const googleContactsTools: ToolDef[] = [
    {
        id: 'GoogleContactsListConnections',
        name: 'GoogleContactsListConnections',
        description: 'Lists the authenticated user’s Google Contacts. Use narrow page sizes and person_fields when possible; returns summarized contacts plus pagination/sync tokens.',
        input_schema: {
            type: 'object',
            properties: {
                page_size: { type: 'integer', description: 'Contacts to return, 1-1000. Defaults to 100.' },
                page_token: { type: 'string', description: 'Next page token from a prior list response.' },
                person_fields: personMaskParam(),
                sort_order: { type: 'string', enum: ['LAST_MODIFIED_ASCENDING', 'LAST_MODIFIED_DESCENDING', 'FIRST_NAME_ASCENDING', 'LAST_NAME_ASCENDING'] },
                request_sync_token: { type: 'boolean', description: 'Ask Google for a sync token on the last page.' },
                sync_token: { type: 'string', description: 'Sync token from a prior full sync; expires after about 7 days.' },
                sources: sourcesParam(),
            },
        },
        tags: ['read', 'google-contacts', 'contacts'],
    },
    {
        id: 'GoogleContactsSearchContacts',
        name: 'GoogleContactsSearchContacts',
        description: 'Searches Google Contacts by prefix match across contact fields. Sends a warmup query by default because People API search uses a lazy cache.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query. Matches prefixes; exact phone-number search can be unreliable in Google People API.' },
                page_size: { type: 'integer', description: 'Results to return, 1-30. Defaults to 10.' },
                read_mask: personMaskParam(),
                warmup: { type: 'boolean', description: 'Defaults true. Set false only when a warm cache is already known.' },
                sources: sourcesParam(),
            },
            required: ['query'],
        },
        tags: ['read', 'google-contacts', 'contacts'],
    },
    {
        id: 'GoogleContactsGetPerson',
        name: 'GoogleContactsGetPerson',
        description: 'Reads one Person resource by resource_name, returning both a summary and raw Person JSON. Use before updates to get etag/source metadata.',
        input_schema: {
            type: 'object',
            properties: {
                resource_name: resourceNameParam('Person resource name, e.g. people/c123.'),
                person_fields: personMaskParam(),
                sources: sourcesParam(),
            },
            required: ['resource_name'],
        },
        tags: ['read', 'google-contacts', 'contacts'],
    },
    {
        id: 'GoogleContactsBatchGetPeople',
        name: 'GoogleContactsBatchGetPeople',
        description: 'Reads multiple People resources by resource name. Prefer after a group lookup when resolving group members.',
        input_schema: {
            type: 'object',
            properties: {
                resource_names: { type: 'array', items: { type: 'string' }, description: 'Person resource names, e.g. people/c123.' },
                person_fields: personMaskParam(),
                sources: sourcesParam(),
            },
            required: ['resource_names'],
        },
        tags: ['read', 'google-contacts', 'contacts'],
    },
    {
        id: 'GoogleContactsCreateContact',
        name: 'GoogleContactsCreateContact',
        description: 'Creates a Google Contact. Person JSON commonly includes names, emailAddresses, phoneNumbers, organizations, addresses, birthdays, urls, biographies, relations, userDefined. Requires explicit confirmation.',
        input_schema: writeSchema({
            person: personObjectParam('Google People API Person JSON to create.'),
            person_fields: personMaskParam(),
        }, ['person', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'contacts', 'external_action'],
    },
    {
        id: 'GoogleContactsBatchCreateContacts',
        name: 'GoogleContactsBatchCreateContacts',
        description: 'Creates multiple Google Contacts in one request. Use only for user-approved imports or deduplicated batches; summarize count and sample rows before calling.',
        input_schema: writeSchema({
            contacts: { type: 'array', items: { type: 'object' }, description: 'Array of Google People API Person JSON contact objects.' },
            read_mask: personMaskParam(),
        }, ['contacts', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'contacts', 'bulk', 'external_action'],
    },
    {
        id: 'GoogleContactsUpdateContact',
        name: 'GoogleContactsUpdateContact',
        description: 'Updates an existing contact. Read the contact first and include etag/source metadata in person to avoid overwriting newer changes. Requires explicit confirmation.',
        input_schema: writeSchema({
            resource_name: resourceNameParam('Person resource name, e.g. people/c123.'),
            person: personObjectParam('Full or partial Person JSON including current etag/source metadata.'),
            update_person_fields: { type: 'string', description: 'Comma-separated update mask, e.g. names,emailAddresses,phoneNumbers.' },
            person_fields: personMaskParam(),
        }, ['resource_name', 'person', 'update_person_fields', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'contacts', 'external_action'],
    },
    {
        id: 'GoogleContactsBatchUpdateContacts',
        name: 'GoogleContactsBatchUpdateContacts',
        description: 'Updates multiple contacts. Each contact must include current etag/source metadata from a recent read. Use only after explicit user approval of exact changed contacts and fields.',
        input_schema: writeSchema({
            contacts: { type: 'object', description: 'Map from resource name to Person JSON, as required by people:batchUpdateContacts.' },
            update_mask: { type: 'string', description: 'Comma-separated fields to update, e.g. names,emailAddresses.' },
            read_mask: personMaskParam(),
        }, ['contacts', 'update_mask', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'contacts', 'bulk', 'external_action'],
    },
    {
        id: 'GoogleContactsDeleteContact',
        name: 'GoogleContactsDeleteContact',
        description: 'Deletes one Google Contact by person resource name. Requires explicit confirmation because it removes contact data synced across devices.',
        input_schema: writeSchema({
            resource_name: resourceNameParam('Person resource name, e.g. people/c123.'),
        }, ['resource_name', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'contacts', 'destructive', 'external_action'],
    },
    {
        id: 'GoogleContactsBatchDeleteContacts',
        name: 'GoogleContactsBatchDeleteContacts',
        description: 'Deletes multiple Google Contacts. Use only after showing the exact count and contact identities and receiving explicit approval.',
        input_schema: writeSchema({
            resource_names: { type: 'array', items: { type: 'string' }, description: 'Person resource names to delete.' },
        }, ['resource_names', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'contacts', 'bulk', 'destructive', 'external_action'],
    },
    {
        id: 'GoogleContactsListContactGroups',
        name: 'GoogleContactsListContactGroups',
        description: 'Lists Google Contact groups/labels owned by the user, including system groups and member counts.',
        input_schema: {
            type: 'object',
            properties: {
                page_size: { type: 'integer', description: 'Groups to return, 1-1000. Defaults to 100.' },
                page_token: { type: 'string' },
                sync_token: { type: 'string' },
                group_fields: groupMaskParam(),
            },
        },
        tags: ['read', 'google-contacts', 'contact-groups'],
    },
    {
        id: 'GoogleContactsGetContactGroup',
        name: 'GoogleContactsGetContactGroup',
        description: 'Reads one contact group/label, optionally including member person resource names. Use BatchGetPeople to resolve members.',
        input_schema: {
            type: 'object',
            properties: {
                resource_name: resourceNameParam('Contact group resource name, e.g. contactGroups/myContacts.'),
                max_members: { type: 'integer', description: 'Member resource names to return, 0-1000. Defaults to 200.' },
                group_fields: groupMaskParam(),
            },
            required: ['resource_name'],
        },
        tags: ['read', 'google-contacts', 'contact-groups'],
    },
    {
        id: 'GoogleContactsCreateContactGroup',
        name: 'GoogleContactsCreateContactGroup',
        description: 'Creates a Google Contacts group/label. Requires explicit confirmation.',
        input_schema: writeSchema({
            name: { type: 'string', description: 'New group/label name. Must be unique.' },
            read_group_fields: groupMaskParam(),
        }, ['name', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'contact-groups', 'external_action'],
    },
    {
        id: 'GoogleContactsUpdateContactGroup',
        name: 'GoogleContactsUpdateContactGroup',
        description: 'Renames or updates a contact group/label. Read the group first when etag is available; requires explicit confirmation.',
        input_schema: writeSchema({
            resource_name: resourceNameParam('Contact group resource name.'),
            name: { type: 'string', description: 'Updated group/label name.' },
            etag: { type: 'string', description: 'Optional current contact group etag.' },
            update_group_fields: { type: 'string', description: 'Defaults to name. Valid fields include name and clientData.' },
            read_group_fields: groupMaskParam(),
        }, ['resource_name', 'name', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'contact-groups', 'external_action'],
    },
    {
        id: 'GoogleContactsDeleteContactGroup',
        name: 'GoogleContactsDeleteContactGroup',
        description: 'Deletes a contact group/label. delete_contacts=false removes only the group; true also deletes contacts in the group. Requires explicit confirmation.',
        input_schema: writeSchema({
            resource_name: resourceNameParam('Contact group resource name.'),
            delete_contacts: { type: 'boolean', description: 'Dangerous: when true, also deletes contacts in this group. Defaults false.' },
        }, ['resource_name', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'contact-groups', 'destructive', 'external_action'],
    },
    {
        id: 'GoogleContactsModifyContactGroupMembers',
        name: 'GoogleContactsModifyContactGroupMembers',
        description: 'Adds/removes contacts from a contact group/label. Use exact people/* resource names and summarize the change before explicit confirmation.',
        input_schema: writeSchema({
            resource_name: resourceNameParam('Contact group resource name.'),
            resource_names_to_add: { type: 'array', items: { type: 'string' }, description: 'Person resource names to add.' },
            resource_names_to_remove: { type: 'array', items: { type: 'string' }, description: 'Person resource names to remove.' },
        }, ['resource_name', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'contact-groups', 'external_action'],
    },
    {
        id: 'GoogleContactsListOtherContacts',
        name: 'GoogleContactsListOtherContacts',
        description: 'Lists Google “Other contacts” from Gmail/autocomplete history. Read-only; use separate copy tool to promote one into My Contacts.',
        input_schema: {
            type: 'object',
            properties: {
                page_size: { type: 'integer', description: 'Other contacts to return, 1-1000. Defaults to 100.' },
                page_token: { type: 'string' },
                request_sync_token: { type: 'boolean' },
                sync_token: { type: 'string' },
                read_mask: { type: 'string', description: `Other contacts read mask. Defaults to ${GOOGLE_CONTACTS_OTHER_FIELDS}.` },
                sources: sourcesParam(),
            },
        },
        tags: ['read', 'google-contacts', 'other-contacts'],
    },
    {
        id: 'GoogleContactsSearchOtherContacts',
        name: 'GoogleContactsSearchOtherContacts',
        description: 'Searches Google “Other contacts” by name, email, or phone prefix. Sends a warmup query by default because People API search uses a lazy cache.',
        input_schema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Search query. Prefix-style matching.' },
                page_size: { type: 'integer', description: 'Results to return, 1-30. Defaults to 10.' },
                read_mask: { type: 'string', description: `Other contacts read mask. Defaults to ${GOOGLE_CONTACTS_OTHER_FIELDS}.` },
                warmup: { type: 'boolean', description: 'Defaults true. Set false only when a warm cache is already known.' },
            },
            required: ['query'],
        },
        tags: ['read', 'google-contacts', 'other-contacts'],
    },
    {
        id: 'GoogleContactsCopyOtherContactToMyContacts',
        name: 'GoogleContactsCopyOtherContactToMyContacts',
        description: 'Copies one “Other contact” into the user’s My Contacts group. Requires explicit confirmation because it changes synced Google Contacts.',
        input_schema: writeSchema({
            resource_name: resourceNameParam('Other contact resource name, e.g. otherContacts/c123.'),
            copy_mask: { type: 'string', description: 'Fields to copy. Valid: names,emailAddresses,phoneNumbers. Defaults to all three.' },
            read_mask: personMaskParam(),
            sources: sourcesParam(),
        }, ['resource_name', 'confirmed_by_user']),
        tags: ['write', 'google-contacts', 'other-contacts', 'external_action'],
    },
]

export async function executeGoogleContactsListConnections(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await googleContactsListConnections({
            pageSize: numberArg(args, ['page_size', 'pageSize'], 100),
            pageToken: stringArg(args, ['page_token', 'pageToken']),
            personFields: stringArg(args, ['person_fields', 'personFields']),
            sortOrder: enumArg(args, ['sort_order', 'sortOrder'], ['LAST_MODIFIED_ASCENDING', 'LAST_MODIFIED_DESCENDING', 'FIRST_NAME_ASCENDING', 'LAST_NAME_ASCENDING']),
            requestSyncToken: booleanArg(args, ['request_sync_token', 'requestSyncToken']),
            syncToken: stringArg(args, ['sync_token', 'syncToken']),
            sources: sourceTypes(args),
        }),
    }
}

export async function executeGoogleContactsSearchContacts(args: Record<string, unknown>): Promise<ToolResult> {
    const query = stringArg(args, ['query', 'q'])
    if (!query) return missing('query')
    return { success: true, data: await googleContactsSearchContacts({ query, pageSize: numberArg(args, ['page_size', 'pageSize'], 10), readMask: stringArg(args, ['read_mask', 'readMask']), warmup: booleanArg(args, ['warmup'], true), sources: sourceTypes(args) }) }
}

export async function executeGoogleContactsGetPerson(args: Record<string, unknown>): Promise<ToolResult> {
    const resourceName = stringArg(args, ['resource_name', 'resourceName'])
    if (!resourceName) return missing('resource_name')
    return { success: true, data: await googleContactsGetPerson(resourceName, stringArg(args, ['person_fields', 'personFields']) || GOOGLE_CONTACTS_PERSON_FIELDS, sourceTypes(args)) }
}

export async function executeGoogleContactsBatchGetPeople(args: Record<string, unknown>): Promise<ToolResult> {
    const resourceNames = stringArrayArg(args, ['resource_names', 'resourceNames'])
    if (resourceNames.length === 0) return missing('resource_names')
    return { success: true, data: await googleContactsBatchGetPeople(resourceNames, stringArg(args, ['person_fields', 'personFields']) || GOOGLE_CONTACTS_PERSON_FIELDS, sourceTypes(args)) }
}

export async function executeGoogleContactsCreateContact(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('creating a Google Contact')
    const person = objectArg(args.person)
    if (!person) return missing('person')
    return { success: true, data: await googleContactsCreateContact(person, stringArg(args, ['person_fields', 'personFields']) || GOOGLE_CONTACTS_PERSON_FIELDS) }
}

export async function executeGoogleContactsBatchCreateContacts(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('creating Google Contacts in bulk')
    if (!Array.isArray(args.contacts) || args.contacts.some(item => !item || typeof item !== 'object' || Array.isArray(item))) return { success: false, error: 'contacts must be an array of objects.' }
    return { success: true, data: await googleContactsBatchCreateContacts(args.contacts as Record<string, unknown>[], stringArg(args, ['read_mask', 'readMask']) || GOOGLE_CONTACTS_PERSON_FIELDS) }
}

export async function executeGoogleContactsUpdateContact(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('updating a Google Contact')
    const resourceName = stringArg(args, ['resource_name', 'resourceName'])
    const person = objectArg(args.person)
    const updatePersonFields = stringArg(args, ['update_person_fields', 'updatePersonFields'])
    if (!resourceName) return missing('resource_name')
    if (!person) return missing('person')
    if (!updatePersonFields) return missing('update_person_fields')
    return { success: true, data: await googleContactsUpdateContact(resourceName, person, updatePersonFields, stringArg(args, ['person_fields', 'personFields']) || GOOGLE_CONTACTS_PERSON_FIELDS) }
}

export async function executeGoogleContactsBatchUpdateContacts(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('updating Google Contacts in bulk')
    const contacts = objectArg(args.contacts)
    const updateMask = stringArg(args, ['update_mask', 'updateMask'])
    if (!contacts) return missing('contacts')
    if (!updateMask) return missing('update_mask')
    return { success: true, data: await googleContactsBatchUpdateContacts(contacts, updateMask, stringArg(args, ['read_mask', 'readMask']) || GOOGLE_CONTACTS_PERSON_FIELDS) }
}

export async function executeGoogleContactsDeleteContact(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('deleting a Google Contact')
    const resourceName = stringArg(args, ['resource_name', 'resourceName'])
    if (!resourceName) return missing('resource_name')
    return { success: true, data: await googleContactsDeleteContact(resourceName) }
}

export async function executeGoogleContactsBatchDeleteContacts(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('deleting Google Contacts in bulk')
    const resourceNames = stringArrayArg(args, ['resource_names', 'resourceNames'])
    if (resourceNames.length === 0) return missing('resource_names')
    return { success: true, data: await googleContactsBatchDeleteContacts(resourceNames) }
}

export async function executeGoogleContactsListContactGroups(args: Record<string, unknown>): Promise<ToolResult> {
    return { success: true, data: await googleContactsListContactGroups({ pageSize: numberArg(args, ['page_size', 'pageSize'], 100), pageToken: stringArg(args, ['page_token', 'pageToken']), syncToken: stringArg(args, ['sync_token', 'syncToken']), groupFields: stringArg(args, ['group_fields', 'groupFields']) }) }
}

export async function executeGoogleContactsGetContactGroup(args: Record<string, unknown>): Promise<ToolResult> {
    const resourceName = stringArg(args, ['resource_name', 'resourceName'])
    if (!resourceName) return missing('resource_name')
    return { success: true, data: await googleContactsGetContactGroup(resourceName, numberArg(args, ['max_members', 'maxMembers'], 200), stringArg(args, ['group_fields', 'groupFields'])) }
}

export async function executeGoogleContactsCreateContactGroup(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('creating a Google Contacts group')
    const name = stringArg(args, ['name'])
    if (!name) return missing('name')
    return { success: true, data: await googleContactsCreateContactGroup(name, stringArg(args, ['read_group_fields', 'readGroupFields'])) }
}

export async function executeGoogleContactsUpdateContactGroup(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('updating a Google Contacts group')
    const resourceName = stringArg(args, ['resource_name', 'resourceName'])
    const name = stringArg(args, ['name'])
    if (!resourceName) return missing('resource_name')
    if (!name) return missing('name')
    return {
        success: true,
        data: await googleContactsUpdateContactGroup({
            resourceName,
            name,
            etag: stringArg(args, ['etag']),
            updateGroupFields: stringArg(args, ['update_group_fields', 'updateGroupFields']),
            readGroupFields: stringArg(args, ['read_group_fields', 'readGroupFields']),
        }),
    }
}

export async function executeGoogleContactsDeleteContactGroup(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('deleting a Google Contacts group')
    const resourceName = stringArg(args, ['resource_name', 'resourceName'])
    if (!resourceName) return missing('resource_name')
    return { success: true, data: await googleContactsDeleteContactGroup(resourceName, booleanArg(args, ['delete_contacts', 'deleteContacts'])) }
}

export async function executeGoogleContactsModifyContactGroupMembers(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('modifying Google Contacts group membership')
    const resourceName = stringArg(args, ['resource_name', 'resourceName'])
    if (!resourceName) return missing('resource_name')
    return {
        success: true,
        data: await googleContactsModifyContactGroupMembers({
            resourceName,
            resourceNamesToAdd: stringArrayArg(args, ['resource_names_to_add', 'resourceNamesToAdd']),
            resourceNamesToRemove: stringArrayArg(args, ['resource_names_to_remove', 'resourceNamesToRemove']),
        }),
    }
}

export async function executeGoogleContactsListOtherContacts(args: Record<string, unknown>): Promise<ToolResult> {
    return {
        success: true,
        data: await googleContactsListOtherContacts({
            pageSize: numberArg(args, ['page_size', 'pageSize'], 100),
            pageToken: stringArg(args, ['page_token', 'pageToken']),
            requestSyncToken: booleanArg(args, ['request_sync_token', 'requestSyncToken']),
            syncToken: stringArg(args, ['sync_token', 'syncToken']),
            readMask: stringArg(args, ['read_mask', 'readMask']),
            sources: sourceTypes(args),
        }),
    }
}

export async function executeGoogleContactsSearchOtherContacts(args: Record<string, unknown>): Promise<ToolResult> {
    const query = stringArg(args, ['query', 'q'])
    if (!query) return missing('query')
    return { success: true, data: await googleContactsSearchOtherContacts({ query, pageSize: numberArg(args, ['page_size', 'pageSize'], 10), readMask: stringArg(args, ['read_mask', 'readMask']), warmup: booleanArg(args, ['warmup'], true) }) }
}

export async function executeGoogleContactsCopyOtherContactToMyContacts(args: Record<string, unknown>): Promise<ToolResult> {
    if (!confirmed(args)) return confirmationError('copying an Other Contact into Google Contacts')
    const resourceName = stringArg(args, ['resource_name', 'resourceName'])
    if (!resourceName) return missing('resource_name')
    return { success: true, data: await googleContactsCopyOtherContactToMyContacts({ resourceName, copyMask: stringArg(args, ['copy_mask', 'copyMask']), readMask: stringArg(args, ['read_mask', 'readMask']), sources: sourceTypes(args) }) }
}

function writeSchema(properties: Record<string, ToolParameter>, required: string[]): ToolParameter {
    return { type: 'object', properties: { ...properties, confirmed_by_user: { type: 'boolean', description: 'Must be true only after explicit approval for this exact Google Contacts write.' } }, required }
}

function resourceNameParam(description: string): ToolParameter {
    return { type: 'string', description }
}

function personMaskParam(): ToolParameter {
    return { type: 'string', description: `Google People API person field mask. Defaults to ${GOOGLE_CONTACTS_PERSON_FIELDS}.` }
}

function groupMaskParam(): ToolParameter {
    return { type: 'string', description: 'Google ContactGroup field mask, e.g. metadata,groupType,memberCount,name,formattedName,memberResourceNames.' }
}

function sourcesParam(): ToolParameter {
    return { type: 'array', items: { type: 'string', enum: ['READ_SOURCE_TYPE_CONTACT', 'READ_SOURCE_TYPE_PROFILE'] }, description: 'Optional People API sources. Use READ_SOURCE_TYPE_CONTACT by default; include PROFILE only when profile-enriched fields are useful.' }
}

function personObjectParam(description: string): ToolParameter {
    return { type: 'object', description }
}

function stringArrayArg(args: Record<string, unknown>, keys: string[]): string[] {
    for (const key of keys) {
        const value = args[key]
        if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        if (typeof value === 'string') return value.split(',').map(item => item.trim()).filter(Boolean)
    }
    return []
}

function enumArg<T extends string>(args: Record<string, unknown>, keys: string[], allowed: readonly T[]): T | undefined {
    const value = stringArg(args, keys)
    return allowed.includes(value as T) ? value as T : undefined
}

function sourceTypes(args: Record<string, unknown>): Array<'READ_SOURCE_TYPE_CONTACT' | 'READ_SOURCE_TYPE_PROFILE'> {
    return stringArrayArg(args, ['sources'])
        .filter((source): source is 'READ_SOURCE_TYPE_CONTACT' | 'READ_SOURCE_TYPE_PROFILE' =>
            source === 'READ_SOURCE_TYPE_CONTACT' || source === 'READ_SOURCE_TYPE_PROFILE')
}

function objectArg(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function confirmed(args: Record<string, unknown>): boolean {
    return args.confirmed_by_user === true
}

function missing(name: string): ToolResult {
    return { success: false, error: `Missing required parameter: ${name}` }
}

function confirmationError(action: string): ToolResult {
    return { success: false, error: `confirmed_by_user must be true before ${action}.` }
}
