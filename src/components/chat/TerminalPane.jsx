import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export function TerminalPane({ initialOutput = '', chunks = [], isRunning = false }) {
    const containerRef = useRef(null);
    const termRef = useRef(null);
    const fitAddonRef = useRef(null);
    const seededRef = useRef(false);
    const chunksLenRef = useRef(0);

    // Initialize terminal on mount
    useEffect(() => {
        if (!containerRef.current) return;

        const term = new Terminal({
            theme: {
                background: '#101317',
                foreground: '#dce6f2',
                cursor: '#8de093',
                selectionBackground: 'rgba(141, 224, 147, 0.3)',
            },
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', monospace",
            fontSize: 13,
            lineHeight: 1.4,
            scrollback: 5000,
            convertEol: true,
            cursorBlink: false,
            disableStdin: true,
        });

        const fitAddon = new FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current);
        fitAddon.fit();

        termRef.current = term;
        fitAddonRef.current = fitAddon;
        seededRef.current = false;
        chunksLenRef.current = 0;

        return () => {
            term.dispose();
            termRef.current = null;
            fitAddonRef.current = null;
            seededRef.current = false;
            chunksLenRef.current = 0;
        };
    }, []);

    // Seed with initial output (accumulated history)
    useEffect(() => {
        const term = termRef.current;
        if (!term || seededRef.current) return;
        if (initialOutput) {
            term.write(initialOutput);
        }
        seededRef.current = true;
        chunksLenRef.current = chunks.length;
    }, [initialOutput, chunks.length]);

    // Write new chunks as they arrive via SSE
    useEffect(() => {
        const term = termRef.current;
        if (!term || !seededRef.current) return;

        const newChunks = chunks.slice(chunksLenRef.current);
        for (const chunk of newChunks) {
            term.write(chunk);
        }
        chunksLenRef.current = chunks.length;
    }, [chunks]);

    return (
        <div
            style={{
                background: '#101317',
                borderRadius: '0 0 10px 10px',
                padding: '8px',
                position: 'relative',
            }}
        >
            <div ref={containerRef} style={{ width: '100%', height: '200px' }} />
            {isRunning && (
                <span
                    style={{
                        position: 'absolute',
                        bottom: '12px',
                        right: '12px',
                        color: '#8de093',
                        fontSize: '13px',
                        animation: 'blink 1s step-start infinite',
                    }}
                >
                    █
                </span>
            )}
        </div>
    );
}
