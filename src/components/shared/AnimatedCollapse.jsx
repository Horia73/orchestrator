import { useEffect, useState } from 'react';
import './AnimatedCollapse.css';

const DEFAULT_DURATION_MS = 260;

function prefersReducedMotion() {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return false;
    }

    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function AnimatedCollapse({
    isOpen,
    children,
    className = '',
    innerClassName = '',
    durationMs = DEFAULT_DURATION_MS,
    onExited,
}) {
    const [isMounted, setIsMounted] = useState(isOpen);
    const [isVisible, setIsVisible] = useState(isOpen);

    useEffect(() => {
        const reducedMotion = prefersReducedMotion();
        let mountFrameId = null;
        let visibleFrameId = null;
        let exitTimer = null;

        if (isOpen) {
            if (!isMounted) {
                mountFrameId = window.requestAnimationFrame(() => {
                    setIsMounted(true);
                });
            } else if (!isVisible) {
                visibleFrameId = window.requestAnimationFrame(() => {
                    setIsVisible(true);
                });
            }
        } else if (isMounted) {
            if (reducedMotion) {
                visibleFrameId = window.requestAnimationFrame(() => {
                    setIsVisible(false);
                    setIsMounted(false);
                    onExited?.();
                });
            } else {
                visibleFrameId = window.requestAnimationFrame(() => {
                    setIsVisible(false);
                });
                exitTimer = window.setTimeout(() => {
                    setIsMounted(false);
                    onExited?.();
                }, durationMs);
            }
        }

        return () => {
            if (mountFrameId !== null) {
                window.cancelAnimationFrame(mountFrameId);
            }
            if (visibleFrameId !== null) {
                window.cancelAnimationFrame(visibleFrameId);
            }
            if (exitTimer !== null) {
                window.clearTimeout(exitTimer);
            }
        };
    }, [durationMs, isMounted, isOpen, isVisible, onExited]);

    if (!isMounted) {
        return null;
    }

    const rootClassName = ['animated-collapse', isVisible ? 'is-open' : 'is-closed', className]
        .filter(Boolean)
        .join(' ');
    const contentClassName = ['animated-collapse-inner', innerClassName]
        .filter(Boolean)
        .join(' ');

    return (
        <div
            className={rootClassName}
            style={{ '--animated-collapse-duration': `${durationMs}ms` }}
            aria-hidden={!isVisible}
        >
            <div className={contentClassName}>
                {children}
            </div>
        </div>
    );
}
