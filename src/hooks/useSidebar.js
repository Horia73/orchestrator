import { useState } from 'react';

export function useSidebar() {
    const [collapsed, setCollapsed] = useState(false);

    const collapse = () => setCollapsed(true);
    const expand = () => setCollapsed(false);
    const toggle = () => setCollapsed(prev => !prev);

    return { collapsed, collapse, expand, toggle };
}
