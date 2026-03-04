const DEFAULT_RESTORE_DELAY_MS = 280;

function isDocumentScrollContainer(node) {
    if (typeof document === 'undefined') {
        return false;
    }

    return (
        node === document.scrollingElement
        || node === document.documentElement
        || node === document.body
    );
}

function getScrollTop(node) {
    if (!node) {
        return 0;
    }

    if (isDocumentScrollContainer(node)) {
        return window.scrollY || document.documentElement.scrollTop || node.scrollTop || 0;
    }

    return node.scrollTop;
}

function setScrollTop(node, value) {
    if (!node) {
        return;
    }

    const nextTop = Math.max(0, Number(value) || 0);
    if (isDocumentScrollContainer(node)) {
        window.scrollTo({ top: nextTop, behavior: 'auto' });
        return;
    }

    node.scrollTop = nextTop;
}

function findScrollContainer(element) {
    if (typeof window === 'undefined' || !element) {
        return null;
    }

    let current = element.parentElement;
    while (current) {
        const styles = window.getComputedStyle(current);
        const overflowY = styles.overflowY;
        const canScroll = /(auto|scroll|overlay)/.test(overflowY);
        if (canScroll && current.scrollHeight > current.clientHeight + 1) {
            return current;
        }
        current = current.parentElement;
    }

    return document.scrollingElement || document.documentElement;
}

export function captureCollapseScrollAnchor(element) {
    const scrollContainer = findScrollContainer(element);
    if (!scrollContainer) {
        return null;
    }

    return {
        scrollContainer,
        scrollTop: getScrollTop(scrollContainer),
    };
}

export function restoreCollapseScrollAnchor(anchor, { delayMs = DEFAULT_RESTORE_DELAY_MS } = {}) {
    if (typeof window === 'undefined' || !anchor?.scrollContainer) {
        return () => {};
    }

    let frameId = null;
    let secondFrameId = null;
    let timeoutId = null;
    const { scrollContainer, scrollTop } = anchor;

    const restore = () => {
        setScrollTop(scrollContainer, scrollTop);
    };

    frameId = window.requestAnimationFrame(() => {
        restore();
        secondFrameId = window.requestAnimationFrame(restore);
    });
    timeoutId = window.setTimeout(restore, delayMs);

    return () => {
        if (frameId !== null) {
            window.cancelAnimationFrame(frameId);
        }
        if (secondFrameId !== null) {
            window.cancelAnimationFrame(secondFrameId);
        }
        if (timeoutId !== null) {
            window.clearTimeout(timeoutId);
        }
    };
}
