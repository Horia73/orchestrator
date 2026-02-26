import { forwardRef } from 'react';
import { MarkdownContent } from './MarkdownContent.jsx';
import { ThoughtBlock } from './ThoughtBlock.jsx';
import { ToolBlock } from './ToolBlock.jsx';
import { FileManagementBlock } from './FileManagementBlock.jsx';
import { EditManagementBlock } from './EditManagementBlock.jsx';

const FILE_MANAGEMENT_TOOLS = new Set([
    'view_file',
    'list_dir',
    'find_by_name',
    'grep_search',
    'view_file_outline',
    'view_code_item',
    'view_content_chunk',
]);
const EDIT_TOOLS = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);

function isFileManagementTool(part) {
    const name = typeof part?.functionCall?.name === 'string'
        ? part.functionCall.name
        : '';

    return FILE_MANAGEMENT_TOOLS.has(name);
}

function isEditTool(part) {
    const name = typeof part?.functionCall?.name === 'string'
        ? part.functionCall.name
        : '';

    return EDIT_TOOLS.has(name);
}

function buildToolBlocks(parts) {
    // Tool calls can also appear inside signature parts; those are not real UI events.
    // Keep only non-signature call parts to preserve true execution order.
    const callParts = (parts || []).filter((part) => part?.functionCall && !part?.thoughtSignature);
    const responseParts = (parts || [])
        .filter((part) => part?.functionResponse)
        .map((part) => part.functionResponse);

    const toolParts = callParts.map((part) => ({
        functionCall: part.functionCall,
        functionResponse: part.functionResponse,
        isExecuting: part.isExecuting === true,
    }));

    const callIndexById = new Map();
    const pendingIndexesByName = new Map();
    for (let index = 0; index < toolParts.length; index += 1) {
        const current = toolParts[index];
        if (current.functionResponse) continue;

        const call = current.functionCall ?? {};
        const callId = typeof call.id === 'string' ? call.id.trim() : '';
        const callName = typeof call.name === 'string' ? call.name : 'unknown_tool';

        if (callId) {
            callIndexById.set(callId, index);
        }

        const queue = pendingIndexesByName.get(callName) ?? [];
        queue.push(index);
        pendingIndexesByName.set(callName, queue);
    }

    for (const functionResponse of responseParts) {
        const responseId = typeof functionResponse?.id === 'string' ? functionResponse.id.trim() : '';
        const responseName = typeof functionResponse?.name === 'string' ? functionResponse.name : 'unknown_tool';
        let targetIndex;

        if (responseId && callIndexById.has(responseId)) {
            targetIndex = callIndexById.get(responseId);
        } else {
            const queue = pendingIndexesByName.get(responseName) ?? [];
            while (queue.length > 0) {
                const candidate = queue.shift();
                if (candidate !== undefined && !toolParts[candidate]?.functionResponse) {
                    targetIndex = candidate;
                    break;
                }
            }
            pendingIndexesByName.set(responseName, queue);
        }

        if (targetIndex === undefined) {
            continue;
        }

        toolParts[targetIndex] = {
            ...toolParts[targetIndex],
            functionResponse,
            isExecuting: false,
        };
    }

    const renderedBlocks = [];
    for (let index = 0; index < toolParts.length; index += 1) {
        const current = toolParts[index];
        const isFileGroup = isFileManagementTool(current);
        const isEditGroup = isEditTool(current);

        if (!isFileGroup && !isEditGroup) {
            renderedBlocks.push({
                type: 'single_tool',
                key: `tool-${index}`,
                toolPart: current,
            });
            continue;
        }

        if (isEditGroup) {
            // Keep edit operations ungrouped so each file/change appears as its own card.
            renderedBlocks.push({
                type: 'edit_management',
                key: `edit-management-${index}`,
                entries: [current],
            });
            continue;
        }

        const groupedEntries = [current];
        const startIndex = index;

        while (
            index + 1 < toolParts.length
            && isFileGroup
            && isFileManagementTool(toolParts[index + 1])
        ) {
            index += 1;
            groupedEntries.push(toolParts[index]);
        }

        renderedBlocks.push({
            type: isFileGroup ? 'file_management' : 'edit_management',
            key: `${isFileGroup ? 'file-management' : 'edit-management'}-${startIndex}`,
            entries: groupedEntries,
        });
    }

    return renderedBlocks;
}

/**
 * Individual message bubble.
 * Accepts a forwarded ref so ChatArea can scroll specific messages into view.
 */
export const Message = forwardRef(function Message({
    role,
    text,
    thought,
    parts,
    steps,
    isThinking = false,
}, ref) {
    if (role === 'user') {
        return (
            <div className="message-user" ref={ref}>
                <div className="message-user-bubble">
                    <MarkdownContent text={text} variant="user" />
                </div>
            </div>
        );
    }

    const renderAiContent = ({
        text: bodyText,
        thought: bodyThought,
        parts: bodyParts,
        bodyIsThinking,
        textFirst = false,
        showWorkedWhenNoThought = false,
    }) => {
        const renderedBlocks = buildToolBlocks(bodyParts);
        const hasText = String(bodyText ?? '').trim().length > 0;
        const hasThought = String(bodyThought ?? '').trim().length > 0;
        const shouldRenderThoughtBlock = bodyIsThinking || hasThought || showWorkedWhenNoThought;
        const textNode = hasText
            ? <MarkdownContent text={bodyText} variant="ai" />
            : null;

        return (
            <>
                {shouldRenderThoughtBlock && (
                    <ThoughtBlock
                        thought={bodyThought}
                        isThinking={bodyIsThinking}
                        showWorkedWhenIdle={showWorkedWhenNoThought}
                    />
                )}

                {textFirst && textNode}

                {renderedBlocks.map((block) => {
                    if (block.type === 'file_management') {
                        return (
                            <FileManagementBlock
                                key={block.key}
                                entries={block.entries}
                            />
                        );
                    }

                    if (block.type === 'edit_management') {
                        return (
                            <EditManagementBlock
                                key={block.key}
                                entries={block.entries}
                            />
                        );
                    }

                    const toolPart = block.toolPart;
                    return (
                        <ToolBlock
                            key={block.key}
                            functionCall={toolPart.functionCall}
                            functionResponse={toolPart.functionResponse}
                            isExecuting={toolPart.isExecuting}
                        />
                    );
                })}

                {!textFirst && textNode}
            </>
        );
    };

    const normalizedSteps = Array.isArray(steps)
        ? steps.filter((step) => {
            const hasText = String(step?.text ?? '').trim().length > 0;
            const hasThought = String(step?.thought ?? '').trim().length > 0;
            const hasParts = Array.isArray(step?.parts) && step.parts.length > 0;
            const isThinkingStep = step?.isThinking === true;
            const isWorkedStep = step?.isWorked === true;
            return hasText || hasThought || hasParts || isThinkingStep || isWorkedStep;
        })
        : [];
    const shouldRenderSteps = normalizedSteps.length > 1;

    return (
        <div className="message-ai" ref={ref}>
            <div className="message-ai-content">
                {shouldRenderSteps
                    ? normalizedSteps.map((step, index) => (
                        <section
                            key={`step-${step.index ?? index + 1}`}
                            className="message-ai-step"
                        >
                            {renderAiContent({
                                text: step.text,
                                thought: step.thought,
                                parts: step.parts,
                                bodyIsThinking: step?.isThinking === true,
                                textFirst: step?.textFirst === true,
                                showWorkedWhenNoThought: step?.isWorked === true,
                            })}
                        </section>
                    ))
                    : renderAiContent({
                        text,
                        thought,
                        parts,
                        bodyIsThinking: isThinking,
                    })}
            </div>
        </div>
    );
});
