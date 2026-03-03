import { useState, useRef, useEffect } from 'react';
import { ToolBlock } from './ToolBlock.jsx';
import { ThoughtBlock } from './ThoughtBlock.jsx';
import { getAgentCallIdentity, getAgentToolMetadata, getToolCallId } from './agentCallUtils.js';
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
    isMessageLive = false,
    onToolPanelToggle,
    showAllLive = false,
}) {
    const [isExpanded, setIsExpanded] = useState(false);
    const [isLiveExpanded, setIsLiveExpanded] = useState(false);
    const listRef = useRef(null);
    const prevCountRef = useRef(items.length);

    const isLiveGroup = isMessageLive || isAnyRunning;

    useEffect(() => {
        if (isLiveGroup && listRef.current && items.length > prevCountRef.current) {
            const el = listRef.current;
            el.scrollTop = el.scrollHeight;
        }
        prevCountRef.current = items.length;
    }, [items.length, isLiveGroup]);

    const allDone = !isLiveGroup;
    const toolItems = items.filter((i) => i.kind === 'tool');
    const actionableItems = items.filter((i) => i.kind === 'tool' || i.kind === 'thought');
    const totalToolCount = toolItems.length;
    const totalActionCount = actionableItems.length;
    const showSummary = allDone && totalToolCount > 1;

    let visibleItems = items;
    let hiddenItems = [];
    let hiddenCount = 0;
    if (!showAllLive && isLiveGroup && totalActionCount > MAX_VISIBLE_LIVE) {
        // Show only the last MAX_VISIBLE_LIVE actionable rows in a live stream.
        let actionsSeen = 0;
        let cutIndex = items.length;
        for (let i = items.length - 1; i >= 0; i--) {
            if (items[i].kind === 'tool' || items[i].kind === 'thought') actionsSeen++;
            if (actionsSeen >= MAX_VISIBLE_LIVE) {
                cutIndex = i;
                break;
            }
        }
        visibleItems = items.slice(cutIndex);
        hiddenItems = items.slice(0, cutIndex);
        hiddenCount = totalActionCount - MAX_VISIBLE_LIVE;
    }

    const summaryText = buildSummaryText(items);

    const renderItem = (item, index, listOffset = 0) => {
        const itemKeySuffix = item.key || `idx-${listOffset + index}`;
        if (item.kind === 'thought') {
            return (
                <ThoughtBlock
                    key={item.key || `thought-${itemKeySuffix}`}
                    thought={item.thought}
                    isThinking={item.isThinking}
                    showWorkedWhenIdle={item.showWorkedWhenIdle}
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
        const agentIdentity = getAgentCallIdentity({
            toolName,
            functionCall: toolPart?.functionCall,
            functionResponse: toolPart?.functionResponse,
            callId: toolCallId,
        });
        const handleAgentToggle = (agentMeta && onAgentCallToggle)
            ? () => {
                onAgentCallToggle({
                    callId: toolCallId,
                    agentId: agentIdentity.agentId,
                    agentName: agentIdentity.agentName,
                    instanceId: agentIdentity.instanceId,
                    instanceLabel: agentIdentity.instanceLabel,
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
                key={block.key || `tool-${itemKeySuffix}`}
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
                    className={`tool-calls-list${isLiveGroup ? ' tool-calls-list-live' : ''}`}
                >
                    {hiddenItems.length > 0 && (
                        <div className="tool-calls-live-hidden-group">
                            <div
                                className="tool-calls-summary"
                                onClick={() => setIsLiveExpanded((c) => !c)}
                                style={{ margin: '4px 0 8px 0' }}
                            >
                                <span className={`tool-calls-summary-chevron${isLiveExpanded ? ' open' : ''}`}>
                                    <IconChevronRight />
                                </span>
                                <span>{hiddenCount} older action{hiddenCount > 1 ? 's' : ''}</span>
                            </div>
                            {isLiveExpanded && (
                                <div className="tool-calls-list tool-calls-list-live-hidden" style={{ paddingLeft: '14px', borderLeft: '2px solid var(--border-light, #e8e6e1)', marginLeft: '6px', marginBottom: '12px' }}>
                                    {hiddenItems.map((item, index) => renderItem(item, index, 0))}
                                </div>
                            )}
                        </div>
                    )}
                    {visibleItems.map((item, index) => renderItem(item, index, hiddenItems.length))}
                </div>
            )}
        </div>
    );
}
