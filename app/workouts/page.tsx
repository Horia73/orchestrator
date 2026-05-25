import { redirect } from 'next/navigation'

/**
 * /workouts is now folded into /library?tab=workouts.
 *
 * Kept as a server-side redirect so existing bookmarks, links from older
 * chat messages, and any external pointers continue to work without a 404.
 */
export default function WorkoutsRedirect() {
    redirect('/library?tab=workouts')
}
