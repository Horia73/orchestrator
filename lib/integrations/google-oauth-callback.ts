import { getGmailOAuthStateProvider } from '@/lib/integrations/gmail'
import { getGoogleOAuthStateProvider } from '@/lib/integrations/google-oauth'

export type GoogleOAuthCallbackProvider =
    | 'gmail'
    | 'googleCalendar'
    | 'googleDrive'

export function getGoogleOAuthCallbackStateProvider(
    state: string | null | undefined
): GoogleOAuthCallbackProvider | null {
    if (!state) return null
    const workspaceProvider = getGoogleOAuthStateProvider(state)
    if (workspaceProvider === 'googleCalendar' || workspaceProvider === 'googleDrive') {
        return workspaceProvider
    }
    return getGmailOAuthStateProvider(state)
}
