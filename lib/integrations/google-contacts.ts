import { googleWorkspaceJson } from './google-drive'

const GOOGLE_PEOPLE_API_BASE = 'https://people.googleapis.com/v1'

export const GOOGLE_CONTACTS_PERSON_FIELDS = [
    'names',
    'emailAddresses',
    'phoneNumbers',
    'organizations',
    'addresses',
    'birthdays',
    'events',
    'urls',
    'biographies',
    'relations',
    'nicknames',
    'occupations',
    'memberships',
    'metadata',
    'photos',
    'userDefined',
    'calendarUrls',
    'imClients',
    'locales',
].join(',')

export const GOOGLE_CONTACTS_OTHER_FIELDS = [
    'names',
    'emailAddresses',
    'phoneNumbers',
    'metadata',
    'photos',
].join(',')

const GOOGLE_CONTACT_GROUP_FIELDS = 'metadata,groupType,memberCount,name,formattedName'
const GOOGLE_CONTACT_GROUP_WITH_MEMBERS_FIELDS = `${GOOGLE_CONTACT_GROUP_FIELDS},memberResourceNames`

type ReadSourceType = 'READ_SOURCE_TYPE_CONTACT' | 'READ_SOURCE_TYPE_PROFILE'
type SortOrder = 'LAST_MODIFIED_ASCENDING' | 'LAST_MODIFIED_DESCENDING' | 'FIRST_NAME_ASCENDING' | 'LAST_NAME_ASCENDING'

interface PeopleListResponse {
    connections?: Person[]
    otherContacts?: Person[]
    results?: Array<{ person?: Person }>
    responses?: Array<{ person?: Person; httpStatusCode?: number; requestedResourceName?: string }>
    nextPageToken?: string
    nextSyncToken?: string
    totalItems?: number
    totalPeople?: number
    totalSize?: number
}

interface ContactGroupsResponse {
    contactGroups?: ContactGroup[]
    nextPageToken?: string
    totalItems?: number
}

interface ContactGroup {
    resourceName?: string
    etag?: string
    groupType?: string
    name?: string
    formattedName?: string
    memberCount?: number
    memberResourceNames?: string[]
    metadata?: {
        updateTime?: string
        deleted?: boolean
    }
    clientData?: Array<{ key?: string; value?: string }>
}

interface Person {
    resourceName?: string
    etag?: string
    metadata?: {
        deleted?: boolean
        sources?: Array<{
            type?: string
            id?: string
            etag?: string
            updateTime?: string
        }>
    }
    names?: Array<{ displayName?: string; givenName?: string; familyName?: string; middleName?: string; honorificPrefix?: string; honorificSuffix?: string }>
    emailAddresses?: Array<{ value?: string; type?: string; formattedType?: string; displayName?: string }>
    phoneNumbers?: Array<{ value?: string; canonicalForm?: string; type?: string; formattedType?: string }>
    organizations?: Array<{ name?: string; title?: string; department?: string; type?: string }>
    addresses?: Array<{ formattedValue?: string; streetAddress?: string; city?: string; region?: string; postalCode?: string; country?: string; type?: string }>
    birthdays?: Array<{ text?: string; date?: { year?: number; month?: number; day?: number } }>
    events?: Array<{ type?: string; formattedType?: string; date?: { year?: number; month?: number; day?: number } }>
    urls?: Array<{ value?: string; type?: string; formattedType?: string }>
    biographies?: Array<{ value?: string; contentType?: string }>
    relations?: Array<{ person?: string; type?: string; formattedType?: string }>
    nicknames?: Array<{ value?: string; type?: string }>
    occupations?: Array<{ value?: string }>
    memberships?: Array<{ contactGroupMembership?: { contactGroupId?: string; contactGroupResourceName?: string } }>
    photos?: Array<{ url?: string; default?: boolean }>
    userDefined?: Array<{ key?: string; value?: string }>
    calendarUrls?: Array<{ url?: string; type?: string; formattedType?: string }>
    imClients?: Array<{ username?: string; protocol?: string; type?: string }>
    locales?: Array<{ value?: string }>
}

export interface GoogleContactPersonSummary {
    resourceName: string | null
    etag: string | null
    deleted: boolean
    displayName: string | null
    names: string[]
    emailAddresses: string[]
    phoneNumbers: string[]
    organizations: string[]
    addresses: string[]
    birthdays: string[]
    events: string[]
    urls: string[]
    relations: string[]
    nicknames: string[]
    occupations: string[]
    memberships: string[]
    photos: string[]
    userDefined: Array<{ key: string; value: string }>
    sourceEtags: Array<{ type: string; id: string | null; etag: string | null; updateTime: string | null }>
}

export interface GoogleContactGroupSummary {
    resourceName: string | null
    etag: string | null
    name: string | null
    formattedName: string | null
    groupType: string | null
    memberCount: number | null
    memberResourceNames: string[]
    deleted: boolean
    updateTime: string | null
}

export async function googleContactsListConnections(options: {
    pageSize?: number
    pageToken?: string
    personFields?: string
    sortOrder?: SortOrder
    requestSyncToken?: boolean
    syncToken?: string
    sources?: ReadSourceType[]
} = {}) {
    const params = new URLSearchParams({
        personFields: cleanMask(options.personFields, GOOGLE_CONTACTS_PERSON_FIELDS),
        pageSize: String(clampInt(options.pageSize ?? 100, 1, 1000)),
    })
    addParam(params, 'pageToken', options.pageToken)
    addParam(params, 'sortOrder', options.sortOrder)
    addParam(params, 'syncToken', options.syncToken)
    if (options.requestSyncToken) params.set('requestSyncToken', 'true')
    addRepeated(params, 'sources', options.sources)

    const result = await googleWorkspaceJson<PeopleListResponse>(
        GOOGLE_PEOPLE_API_BASE,
        `/people/me/connections?${params.toString()}`
    )
    return summarizePeopleList(result, 'connections')
}

export async function googleContactsSearchContacts(options: {
    query: string
    pageSize?: number
    readMask?: string
    sources?: ReadSourceType[]
    warmup?: boolean
} = { query: '' }) {
    const readMask = cleanMask(options.readMask, GOOGLE_CONTACTS_PERSON_FIELDS)
    const params = buildSearchParams(options.query, readMask, clampInt(options.pageSize ?? 10, 1, 30), options.sources)

    if (options.warmup !== false && options.query.trim()) {
        const warmupParams = buildSearchParams('', readMask, 1, options.sources)
        await googleWorkspaceJson<PeopleListResponse>(GOOGLE_PEOPLE_API_BASE, `/people:searchContacts?${warmupParams.toString()}`)
        await sleep(800)
    }

    const result = await googleWorkspaceJson<PeopleListResponse>(
        GOOGLE_PEOPLE_API_BASE,
        `/people:searchContacts?${params.toString()}`
    )
    return {
        contacts: (result.results ?? []).map(item => summarizePerson(item.person ?? {})),
        rawCount: result.results?.length ?? 0,
    }
}

export async function googleContactsGetPerson(resourceName: string, personFields = GOOGLE_CONTACTS_PERSON_FIELDS, sources: ReadSourceType[] = []) {
    const params = new URLSearchParams({ personFields: cleanMask(personFields, GOOGLE_CONTACTS_PERSON_FIELDS) })
    addRepeated(params, 'sources', sources)
    const person = await googleWorkspaceJson<Person>(
        GOOGLE_PEOPLE_API_BASE,
        `/${encodeResourceName(resourceName)}?${params.toString()}`
    )
    return { summary: summarizePerson(person), person }
}

export async function googleContactsBatchGetPeople(resourceNames: string[], personFields = GOOGLE_CONTACTS_PERSON_FIELDS, sources: ReadSourceType[] = []) {
    const clean = resourceNames.map(item => item.trim()).filter(Boolean)
    if (clean.length === 0) throw new Error('At least one resource name is required.')
    const params = new URLSearchParams({ personFields: cleanMask(personFields, GOOGLE_CONTACTS_PERSON_FIELDS) })
    for (const resourceName of clean) params.append('resourceNames', resourceName)
    addRepeated(params, 'sources', sources)
    const result = await googleWorkspaceJson<PeopleListResponse>(
        GOOGLE_PEOPLE_API_BASE,
        `/people:batchGet?${params.toString()}`
    )
    return {
        people: (result.responses ?? []).map(response => ({
            requestedResourceName: response.requestedResourceName ?? null,
            httpStatusCode: response.httpStatusCode ?? null,
            summary: summarizePerson(response.person ?? {}),
            person: response.person ?? null,
        })),
    }
}

export async function googleContactsCreateContact(person: Record<string, unknown>, personFields = GOOGLE_CONTACTS_PERSON_FIELDS) {
    const created = await googleWorkspaceJson<Person>(
        GOOGLE_PEOPLE_API_BASE,
        `/people:createContact?personFields=${encodeURIComponent(cleanMask(personFields, GOOGLE_CONTACTS_PERSON_FIELDS))}`,
        {
            method: 'POST',
            body: JSON.stringify(assertObject(person, 'person')),
        }
    )
    return { summary: summarizePerson(created), person: created }
}

export async function googleContactsBatchCreateContacts(contacts: Record<string, unknown>[], readMask = GOOGLE_CONTACTS_PERSON_FIELDS) {
    const clean = contacts.map((contact, index) => ({ contactPerson: assertObject(contact, `contacts[${index}]`) }))
    if (clean.length === 0) throw new Error('At least one contact is required.')
    const result = await googleWorkspaceJson<{ createdPeople?: Array<{ person?: Person }> }>(
        GOOGLE_PEOPLE_API_BASE,
        '/people:batchCreateContacts',
        {
            method: 'POST',
            body: JSON.stringify({
                contacts: clean,
                readMask: cleanMask(readMask, GOOGLE_CONTACTS_PERSON_FIELDS),
            }),
        }
    )
    return {
        contacts: (result.createdPeople ?? []).map(item => ({
            summary: summarizePerson(item.person ?? {}),
            person: item.person ?? null,
        })),
    }
}

export async function googleContactsUpdateContact(resourceName: string, person: Record<string, unknown>, updatePersonFields: string, personFields = GOOGLE_CONTACTS_PERSON_FIELDS) {
    const cleanFields = cleanRequired(updatePersonFields, 'update_person_fields')
    const updated = await googleWorkspaceJson<Person>(
        GOOGLE_PEOPLE_API_BASE,
        `/${encodeResourceName(resourceName)}:updateContact?${new URLSearchParams({
            updatePersonFields: cleanFields,
            personFields: cleanMask(personFields, GOOGLE_CONTACTS_PERSON_FIELDS),
        }).toString()}`,
        {
            method: 'PATCH',
            body: JSON.stringify(assertObject(person, 'person')),
        }
    )
    return { summary: summarizePerson(updated), person: updated }
}

export async function googleContactsBatchUpdateContacts(contacts: Record<string, unknown>, updateMask: string, readMask = GOOGLE_CONTACTS_PERSON_FIELDS) {
    const result = await googleWorkspaceJson<{ updateResult?: Record<string, { person?: Person }> }>(
        GOOGLE_PEOPLE_API_BASE,
        `/people:batchUpdateContacts?${new URLSearchParams({
            updateMask: cleanRequired(updateMask, 'update_mask'),
            readMask: cleanMask(readMask, GOOGLE_CONTACTS_PERSON_FIELDS),
        }).toString()}`,
        {
            method: 'POST',
            body: JSON.stringify({ contacts: assertObject(contacts, 'contacts') }),
        }
    )
    return {
        contacts: Object.entries(result.updateResult ?? {}).map(([resourceName, response]) => ({
            resourceName,
            summary: summarizePerson(response.person ?? {}),
            person: response.person ?? null,
        })),
    }
}

export async function googleContactsDeleteContact(resourceName: string) {
    await googleWorkspaceJson<Record<string, never>>(
        GOOGLE_PEOPLE_API_BASE,
        `/${encodeResourceName(resourceName)}:deleteContact`,
        { method: 'DELETE' }
    )
    return { deleted: true, resourceName: cleanRequired(resourceName, 'resource_name') }
}

export async function googleContactsBatchDeleteContacts(resourceNames: string[]) {
    const clean = resourceNames.map(item => item.trim()).filter(Boolean)
    if (clean.length === 0) throw new Error('At least one resource name is required.')
    await googleWorkspaceJson<Record<string, never>>(
        GOOGLE_PEOPLE_API_BASE,
        '/people:batchDeleteContacts',
        {
            method: 'POST',
            body: JSON.stringify({ resourceNames: clean }),
        }
    )
    return { deleted: true, resourceNames: clean }
}

export async function googleContactsListContactGroups(options: {
    pageSize?: number
    pageToken?: string
    syncToken?: string
    groupFields?: string
} = {}) {
    const params = new URLSearchParams({
        pageSize: String(clampInt(options.pageSize ?? 100, 1, 1000)),
        groupFields: cleanMask(options.groupFields, GOOGLE_CONTACT_GROUP_FIELDS),
    })
    addParam(params, 'pageToken', options.pageToken)
    addParam(params, 'syncToken', options.syncToken)
    const result = await googleWorkspaceJson<ContactGroupsResponse>(
        GOOGLE_PEOPLE_API_BASE,
        `/contactGroups?${params.toString()}`
    )
    return {
        contactGroups: (result.contactGroups ?? []).map(summarizeContactGroup),
        nextPageToken: result.nextPageToken ?? null,
        totalItems: result.totalItems ?? null,
    }
}

export async function googleContactsGetContactGroup(resourceName: string, maxMembers = 200, groupFields = GOOGLE_CONTACT_GROUP_WITH_MEMBERS_FIELDS) {
    const params = new URLSearchParams({
        maxMembers: String(clampInt(maxMembers, 0, 1000)),
        groupFields: cleanMask(groupFields, GOOGLE_CONTACT_GROUP_WITH_MEMBERS_FIELDS),
    })
    const group = await googleWorkspaceJson<ContactGroup>(
        GOOGLE_PEOPLE_API_BASE,
        `/${encodeResourceName(resourceName)}?${params.toString()}`
    )
    return { contactGroup: summarizeContactGroup(group), raw: group }
}

export async function googleContactsCreateContactGroup(name: string, readGroupFields = GOOGLE_CONTACT_GROUP_FIELDS) {
    const result = await googleWorkspaceJson<ContactGroup>(
        GOOGLE_PEOPLE_API_BASE,
        '/contactGroups',
        {
            method: 'POST',
            body: JSON.stringify({
                contactGroup: { name: cleanRequired(name, 'name') },
                readGroupFields: cleanMask(readGroupFields, GOOGLE_CONTACT_GROUP_FIELDS),
            }),
        }
    )
    return { contactGroup: summarizeContactGroup(result), raw: result }
}

export async function googleContactsUpdateContactGroup(args: {
    resourceName: string
    name: string
    etag?: string
    updateGroupFields?: string
    readGroupFields?: string
}) {
    const result = await googleWorkspaceJson<ContactGroup>(
        GOOGLE_PEOPLE_API_BASE,
        `/${encodeResourceName(args.resourceName)}`,
        {
            method: 'PUT',
            body: JSON.stringify({
                contactGroup: {
                    resourceName: cleanRequired(args.resourceName, 'resource_name'),
                    name: cleanRequired(args.name, 'name'),
                    ...(args.etag ? { etag: args.etag } : {}),
                },
                updateGroupFields: cleanMask(args.updateGroupFields, 'name'),
                readGroupFields: cleanMask(args.readGroupFields, GOOGLE_CONTACT_GROUP_FIELDS),
            }),
        }
    )
    return { contactGroup: summarizeContactGroup(result), raw: result }
}

export async function googleContactsDeleteContactGroup(resourceName: string, deleteContacts = false) {
    const params = new URLSearchParams({ deleteContacts: String(deleteContacts) })
    await googleWorkspaceJson<Record<string, never>>(
        GOOGLE_PEOPLE_API_BASE,
        `/${encodeResourceName(resourceName)}?${params.toString()}`,
        { method: 'DELETE' }
    )
    return { deleted: true, resourceName: cleanRequired(resourceName, 'resource_name'), deleteContacts }
}

export async function googleContactsModifyContactGroupMembers(args: {
    resourceName: string
    resourceNamesToAdd?: string[]
    resourceNamesToRemove?: string[]
}) {
    const add = cleanStringArray(args.resourceNamesToAdd)
    const remove = cleanStringArray(args.resourceNamesToRemove)
    if (add.length === 0 && remove.length === 0) throw new Error('Provide resource_names_to_add or resource_names_to_remove.')
    return googleWorkspaceJson<{
        notFoundResourceNames?: string[]
        canNotRemoveLastContactGroupResourceNames?: string[]
    }>(
        GOOGLE_PEOPLE_API_BASE,
        `/${encodeResourceName(args.resourceName)}/members:modify`,
        {
            method: 'POST',
            body: JSON.stringify({
                resourceNamesToAdd: add,
                resourceNamesToRemove: remove,
            }),
        }
    )
}

export async function googleContactsListOtherContacts(options: {
    pageSize?: number
    pageToken?: string
    requestSyncToken?: boolean
    syncToken?: string
    readMask?: string
    sources?: ReadSourceType[]
} = {}) {
    const params = new URLSearchParams({
        pageSize: String(clampInt(options.pageSize ?? 100, 1, 1000)),
        readMask: cleanMask(options.readMask, GOOGLE_CONTACTS_OTHER_FIELDS),
    })
    addParam(params, 'pageToken', options.pageToken)
    addParam(params, 'syncToken', options.syncToken)
    if (options.requestSyncToken) params.set('requestSyncToken', 'true')
    addRepeated(params, 'sources', options.sources)
    const result = await googleWorkspaceJson<PeopleListResponse>(
        GOOGLE_PEOPLE_API_BASE,
        `/otherContacts?${params.toString()}`
    )
    return summarizePeopleList(result, 'otherContacts')
}

export async function googleContactsSearchOtherContacts(options: {
    query: string
    pageSize?: number
    readMask?: string
    warmup?: boolean
}) {
    const readMask = cleanMask(options.readMask, GOOGLE_CONTACTS_OTHER_FIELDS)
    const params = buildSearchParams(options.query, readMask, clampInt(options.pageSize ?? 10, 1, 30))

    if (options.warmup !== false && options.query.trim()) {
        const warmupParams = buildSearchParams('', readMask, 1)
        await googleWorkspaceJson<PeopleListResponse>(GOOGLE_PEOPLE_API_BASE, `/otherContacts:search?${warmupParams.toString()}`)
        await sleep(800)
    }

    const result = await googleWorkspaceJson<PeopleListResponse>(
        GOOGLE_PEOPLE_API_BASE,
        `/otherContacts:search?${params.toString()}`
    )
    return {
        contacts: (result.results ?? []).map(item => summarizePerson(item.person ?? {})),
        rawCount: result.results?.length ?? 0,
    }
}

export async function googleContactsCopyOtherContactToMyContacts(args: {
    resourceName: string
    copyMask?: string
    readMask?: string
    sources?: ReadSourceType[]
}) {
    const copied = await googleWorkspaceJson<Person>(
        GOOGLE_PEOPLE_API_BASE,
        `/${encodeResourceName(args.resourceName)}:copyOtherContactToMyContactsGroup`,
        {
            method: 'POST',
            body: JSON.stringify({
                copyMask: cleanMask(args.copyMask, 'names,emailAddresses,phoneNumbers'),
                readMask: cleanMask(args.readMask, GOOGLE_CONTACTS_PERSON_FIELDS),
                sources: args.sources,
            }),
        }
    )
    return { summary: summarizePerson(copied), person: copied }
}

function summarizePeopleList(result: PeopleListResponse, key: 'connections' | 'otherContacts') {
    const people = result[key] ?? []
    return {
        contacts: people.map(summarizePerson),
        nextPageToken: result.nextPageToken ?? null,
        nextSyncToken: result.nextSyncToken ?? null,
        totalItems: result.totalItems ?? result.totalPeople ?? result.totalSize ?? null,
    }
}

function summarizePerson(person: Person): GoogleContactPersonSummary {
    return {
        resourceName: person.resourceName ?? null,
        etag: person.etag ?? null,
        deleted: Boolean(person.metadata?.deleted),
        displayName: person.names?.find(name => name.displayName)?.displayName ?? null,
        names: (person.names ?? []).map(name => name.displayName || [name.honorificPrefix, name.givenName, name.middleName, name.familyName, name.honorificSuffix].filter(Boolean).join(' ')).filter(Boolean),
        emailAddresses: (person.emailAddresses ?? []).map(email => labelValue(email.value, email.type ?? email.formattedType)).filter(Boolean),
        phoneNumbers: (person.phoneNumbers ?? []).map(phone => labelValue(phone.canonicalForm || phone.value, phone.type ?? phone.formattedType)).filter(Boolean),
        organizations: (person.organizations ?? []).map(org => [org.name, org.title, org.department].filter(Boolean).join(' - ')).filter(Boolean),
        addresses: (person.addresses ?? []).map(address => labelValue(address.formattedValue || [address.streetAddress, address.city, address.region, address.postalCode, address.country].filter(Boolean).join(', '), address.type)).filter(Boolean),
        birthdays: (person.birthdays ?? []).map(birthday => birthday.text || formatDateParts(birthday.date)).filter(Boolean),
        events: (person.events ?? []).map(event => labelValue(formatDateParts(event.date), event.type ?? event.formattedType)).filter(Boolean),
        urls: (person.urls ?? []).map(url => labelValue(url.value, url.type ?? url.formattedType)).filter(Boolean),
        relations: (person.relations ?? []).map(relation => labelValue(relation.person, relation.type ?? relation.formattedType)).filter(Boolean),
        nicknames: (person.nicknames ?? []).map(nickname => labelValue(nickname.value, nickname.type)).filter(Boolean),
        occupations: (person.occupations ?? []).map(occupation => occupation.value).filter((value): value is string => Boolean(value)),
        memberships: (person.memberships ?? []).map(membership => membership.contactGroupMembership?.contactGroupResourceName ?? membership.contactGroupMembership?.contactGroupId).filter((value): value is string => Boolean(value)),
        photos: (person.photos ?? []).map(photo => photo.url).filter((value): value is string => Boolean(value)),
        userDefined: (person.userDefined ?? [])
            .map(item => ({ key: item.key ?? '', value: item.value ?? '' }))
            .filter(item => item.key || item.value),
        sourceEtags: (person.metadata?.sources ?? []).map(source => ({
            type: source.type ?? '',
            id: source.id ?? null,
            etag: source.etag ?? null,
            updateTime: source.updateTime ?? null,
        })),
    }
}

function summarizeContactGroup(group: ContactGroup): GoogleContactGroupSummary {
    return {
        resourceName: group.resourceName ?? null,
        etag: group.etag ?? null,
        name: group.name ?? null,
        formattedName: group.formattedName ?? null,
        groupType: group.groupType ?? null,
        memberCount: group.memberCount ?? null,
        memberResourceNames: group.memberResourceNames ?? [],
        deleted: Boolean(group.metadata?.deleted),
        updateTime: group.metadata?.updateTime ?? null,
    }
}

function buildSearchParams(query: string, readMask: string, pageSize: number, sources: ReadSourceType[] = []): URLSearchParams {
    const params = new URLSearchParams({
        query,
        readMask,
        pageSize: String(pageSize),
    })
    addRepeated(params, 'sources', sources)
    return params
}

function addParam(params: URLSearchParams, key: string, value: string | undefined): void {
    const clean = value?.trim()
    if (clean) params.set(key, clean)
}

function addRepeated(params: URLSearchParams, key: string, values: string[] | undefined): void {
    for (const value of cleanStringArray(values)) params.append(key, value)
}

function cleanStringArray(values: string[] | undefined): string[] {
    return (values ?? []).map(item => item.trim()).filter(Boolean)
}

function encodeResourceName(resourceName: string): string {
    return cleanRequired(resourceName, 'resource_name')
        .split('/')
        .map(part => encodeURIComponent(part))
        .join('/')
}

function assertObject(value: unknown, name: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error(`${name} must be an object.`)
    }
    return value as Record<string, unknown>
}

function cleanMask(value: string | undefined, fallback: string): string {
    return value?.split(',').map(item => item.trim()).filter(Boolean).join(',') || fallback
}

function cleanRequired(value: string, name: string): string {
    const clean = value.trim()
    if (!clean) throw new Error(`${name} is required.`)
    return clean
}

function clampInt(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min
    return Math.min(max, Math.max(min, Math.trunc(value)))
}

function labelValue(value: string | undefined, label: string | undefined): string {
    if (!value) return ''
    return label ? `${value} (${label})` : value
}

function formatDateParts(date: { year?: number; month?: number; day?: number } | undefined): string {
    if (!date) return ''
    const parts = [date.year, date.month, date.day].filter(value => typeof value === 'number')
    return parts.length > 0 ? parts.join('-') : ''
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms))
}
