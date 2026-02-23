/**
 * Date grouping helpers for conversation list
 */

export function getDateGroup(dateString) {
    const date = new Date(dateString);
    const now = new Date();
    const diff = now - date;
    const dayMs = 86400000;

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dateDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());

    if (dateDay.getTime() === today.getTime()) return 'Today';
    if (dateDay.getTime() === today.getTime() - dayMs) return 'Yesterday';
    if (diff < 7 * dayMs) return 'Previous 7 Days';
    if (diff < 30 * dayMs) return 'Previous 30 Days';
    return 'Older';
}

export function groupConversationsByDate(conversations) {
    const groups = {};
    const order = ['Today', 'Yesterday', 'Previous 7 Days', 'Previous 30 Days', 'Older'];

    conversations
        .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
        .forEach((conv) => {
            const group = getDateGroup(conv.updatedAt);
            if (!groups[group]) groups[group] = [];
            groups[group].push(conv);
        });

    return order
        .filter((group) => groups[group]?.length > 0)
        .map((group) => ({ label: group, conversations: groups[group] }));
}

export function formatTime(dateString) {
    const date = new Date(dateString);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
