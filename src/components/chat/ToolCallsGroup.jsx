import { useState, useRef, useEffect } from 'react';
import { ToolBlock } from './ToolBlock.jsx';
import { ThoughtBlock } from './ThoughtBlock.jsx';
import { getAgentToolMetadata, getToolCallId } from './agentCallUtils.js';
import { IconChevronRight, IconCheckCircle } from '../shared/icons.jsx';

const MAX_VISIBLE_LIVE = 3;

function buildSummaryText(items) {
    let commands = 0;
    let views = 0;
    let edits = 0;
    let web = 0;
    let agents = 0;
    let other = 0;

    const COMMAND_NAMES = new Set(['run_command', 'command_status', 'send_command_input', 'read_terminal']);
    const FILE_NAMES = new Set(['view_file', 'list_dir', 'find_by_name', 'grep_search', 'view_file_outline', 'view_code_item', 'view_content_chunk']);
    const EDIT_NAMES = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
    const WEB_NAMES = new Set(['read_url_content', 'search_web']);

    for (const item of items) {
        if (item.kind !== 'tool') continue;
        const name = String(item.block?.toolPart?.functionCall?.name ?? '');
        if (COMMAND_NAMES.has(name)) commands++;
        else if (FILE_NAMES.has(name)) views++;
        else if (EDIT_NAMES.has(name)) edits++;
        else if (WEB_NAMES.has(name)) web++;
        else if (name.startsWith('call_') || name === 'generate_image') agents++;
        else other++;
    }

    const parts = [];
    if (commands > 0) parts.push(`Ran ${commands} command${commands > 1 ? 's' : ''}`);
    if (views > 0) parts.push(`viewed ${views} file${views > 1 ? 's' : ''}`);
    if (edits > 0) parts.push(`${edits} edit${edits > 1 ? 's' : ''}`);
    if (web > 0) parts.push(`${web} web request${web > 1 ? 's' : ''}`);
    if (agents > 0) parts.push(`${agents} agent call${agents > 1 ? 's' : ''}`);
    if (other > 0) parts.push(`${other} tool${other > 1 ? 's' : ''}`);

    if (parts.length === 0) return 'Used tools';

    return parts.join(', ');
}

export function ToolCallsGroup({
    items = [],
    onAgentCallToggle,
    activeAgentCallId = '',
    commandChunks = {},
    isAnyRunning = false,
    onToolPanelToggle,
}) {
    const [isExpanded, setIsExpanded] = useState(false);
    const listRef = useRef(null);
    const prevCountRef = useRef(items.length);

    useEffect(() => {
        if (isAnyRunning && listRef.current && items.length > prevCountRef.current) {
            const el = listRef.current;
            el.scrollTop = el.scrollHeight;
        }
        prevCountRef.current = items.length;
    }, [items.length, isAnyRunning]);

    const allDone = !isAnyRunning;
    const toolItems = items.filter((i) => i.kind === 'tool');
    const totalToolCount = toolItems.length;
    const showSummary = allDone && totalToolCount > 1;

    // During live: show last MAX_VISIBLE_LIVE items (counting only tools for the limit)
    let visibleItems = items;
    let hiddenCount = 0;
    if (isAnyRunning && totalToolCount > MAX_VISIBLE_LIVE) {
        // Find the start index so we show the last MAX_VISIBLE_LIVE tools
        let toolsSeen = 0;
        let cutIndex = items.length;
        for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].kind === 'tool') toolsSeen++;
            if (toolsSeen >= MAX_VISIBLE_LIVE) {
                cutIndex = i;
                break;
            }
        }
        visibleItems = items.slice(cutIndex);
        hiddenCount = totalToolCount - MAX_VISIBLE_LIVE;
    }

    const summaryText = buildSummaryText(items);

    const renderItem = (item, index) => {
        if (item.kind === 'thought') {
            return (
                <ThoughtBlock
                    key={item.key || `thought-${index}`}
                    thought={item.thought}
                    isThinking={item.isThinking}
                    thinkingDurationMs={item.thinkingDurationMs}
                />
            );
        }

        const block = item.block;
        const toolPart = block.toolPart;
        const toolName = String(toolPart?.functionCall?.name ?? '').trim();
        const agentMeta = getAgentToolMetadata(toolName);
        const toolCallId = getToolCallId(toolPart?.functionCall);
        const isAgentCallOpen = !!agentMeta && toolCallId === String(activeAgentCallId ?? '').trim();
        const handleAgentToggle = (agentMeta && onAgentCallToggle)
            ? () => {
                onAgentCallToggle({
                    callId: toolCallId,
                    agentId: agentMeta.agentId,
                    agentName: agentMeta.agentName,
                    toolName,
                    toolPart: {
                        functionCall: toolPart.functionCall,
                        functionResponse: toolPart.functionResponse,
                        isExecuting: toolPart.isExecuting === true,
                    },
                });
            }
            : undefined;

        // For file/web tools, open in side panel instead of inline expand
        const handleToolPanelToggle = (!agentMeta && onToolPanelToggle)
            ? () => {
                onToolPanelToggle({
                    callId: toolCallId,
                    toolName,
                    toolPart: {
                        functionCall: toolPart.functionCall,
                        functionResponse: toolPart.functionResponse,
                        isExecuting: toolPart.isExecuting === true,
                    },
                });
            }
            : undefined;

        return (
            <ToolBlock
                key={block.key}
                functionCall={toolPart.functionCall}
                functionResponse={toolPart.functionResponse}
                isExecuting={toolPart.isExecuting}
                onAgentCallToggle={handleAgentToggle}
                isAgentCallOpen={isAgentCallOpen}
                commandChunks={commandChunks}
                onToolPanelToggle={handleToolPanelToggle}
            />
        );
    };

    // Single tool, no thoughts — render directly
    if (totalToolCount <= 1 && items.length === 1) {
        return (
            <div className="tool-calls-group">
                {renderItem(items[0], 0)}
            </div>
        );
    }

    return (
        <div className="tool-calls-group">
            {showSummary && (
                <div
                    className="tool-calls-summary"
                    onClick={() => setIsExpanded((c) => !c)}
                >
                    <span className={`tool-calls-summary-chevron${isExpanded ? ' open' : ''}`}>
                        <IconChevronRight />
                    </span>
                    <span>{summaryText}</span>
                    {allDone && (
                        <span style={{ color: '#2a6f57', display: 'inline-flex' }}>
                            <IconCheckCircle />
                        </span>
                    )}
                </div>
            )}

            {(!showSummary || isExpanded) && (
                <div
                    ref={listRef}
                    className={`tool-calls-list${isAnyRunning ? ' tool-calls-list-live' : ''}`}
                >
                    {hiddenCount > 0 && (
                        <div className="tool-calls-hidden-count">
                            +{hiddenCount} more above
                        </div>
                    )}
                    {visibleItems.map(renderItem)}
                </div>
            )}
        </div>
    );
}
