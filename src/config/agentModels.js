export const THINKING_LEVELS = [
    {
        id: 'MINIMAL',
        label: 'Minimal',
        description: 'Fastest responses, least reasoning',
        color: '#7A766D',
    },
    {
        id: 'LOW',
        label: 'Low',
        description: 'Quick with light reasoning',
        color: '#6B9E78',
    },
    {
        id: 'MEDIUM',
        label: 'Medium',
        description: 'Balanced speed and depth',
        color: '#D4964E',
    },
    {
        id: 'HIGH',
        label: 'High',
        description: 'Deepest reasoning, slowest',
        color: '#C45A3C',
    },
];

export function tierColor(tier) {
    switch (tier) {
        case 'pro': return '#C45A3C';
        case 'flash': return '#D4964E';
        case 'flash-lite': return '#6B9E78';
        case 'image': return '#7C91C7';
        case 'video': return '#4C7A9A';
        default: return '#7A766D';
    }
}
