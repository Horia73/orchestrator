import { useState } from 'react';
import './ToolBlock.css';

export function ToolBlock({ functionCall, functionResponse, isExecuting }) {
    const [isOpen, setIsOpen] = useState(false);

    // Safety check just in case
    if (!functionCall) return null;

    const hasResponse = !!functionResponse;
    const name = functionCall.name || 'unknown_tool';
    const args = functionCall.args || {};

    let responseData = null;
    if (hasResponse) {
        responseData = functionResponse.response;
        // If it's pure string or we can format it better, we do so:
        if (typeof responseData === 'object') {
            responseData = JSON.stringify(responseData, null, 2);
        } else {
            responseData = String(responseData);
        }
    }

    return (
        <div className="tool-block">
            <div className="tool-block-header" onClick={() => setIsOpen(!isOpen)}>
                <div className="tool-block-title">
                    <span className="tool-icon">🛠️</span>
                    <span className="tool-name">Used {name}</span>
                </div>
                {isExecuting && !hasResponse && <div className="tool-spinner" title="Tool is running..."></div>}
                <div className={`tool-chevron ${isOpen ? 'open' : ''}`}>▼</div>
            </div>

            {isOpen && (
                <div className="tool-block-content">
                    <div className="tool-section">
                        <div className="tool-section-title">Arguments:</div>
                        <pre>{JSON.stringify(args, null, 2)}</pre>
                    </div>
                    {hasResponse && (
                        <div className="tool-section">
                            <div className="tool-section-title">Result:</div>
                            <pre>{responseData}</pre>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
