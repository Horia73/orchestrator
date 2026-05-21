import fs from 'fs';
import path from 'path';

import { createAgentController, type BrowserEvidenceCapture } from '@/lib/browser-agent-runtime/agent';
import { createBrowserManager } from '@/lib/browser-agent-runtime/browser';
import type { ActionHistoryItem, IterationLimitReview, TabInfo } from '@/lib/browser-agent-runtime/prompts';
import type { ActionTrace, BrowserDownloadFile, BrowserFrameSnapshot } from '@/lib/browser-agent-runtime/browser';
import type { AgentAction, VisionConfig, VisionService } from '@/lib/browser-agent-runtime/vision';

const root = path.resolve(process.env.BROWSER_AGENT_SMOKE_DIR || 'tmp-official-display-agent-smoke');
const viewport = {
    width: Number(process.env.BROWSER_AGENT_SMOKE_WIDTH || 1280),
    height: Number(process.env.BROWSER_AGENT_SMOKE_HEIGHT || 720),
};

function fileUrl(filePath: string): string {
    return `file://${filePath}`;
}

function createSmokeVision(): VisionService {
    let step = 0;
    let config: VisionConfig = {
        model: 'smoke-fake-vision',
        thinkingLevel: 'minimal',
        mediaResolution: 'low',
    };

    return {
        async analyzeScreenshot(
            frame: BrowserFrameSnapshot,
            goal: string,
            actionHistory: ActionHistoryItem[],
            conversationHistory: string[],
            recentTrace?: ActionTrace | null,
            supplementalFrames?: BrowserFrameSnapshot[],
            isInterrupt?: boolean,
            openTabs?: TabInfo[],
            isAdvancedMode?: boolean,
            downloads?: BrowserDownloadFile[],
        ): Promise<AgentAction[]> {
            void frame;
            void goal;
            void actionHistory;
            void conversationHistory;
            void recentTrace;
            void supplementalFrames;
            void isInterrupt;
            void openTabs;
            void isAdvancedMode;
            void downloads;

            step += 1;
            if (step === 1) {
                return [{
                    action: 'type',
                    coordinate: [220, 111],
                    text: 'typed-by-agent-loop',
                    clearBefore: true,
                    reasoning: 'Type into the visible input using absolute display coordinates.',
                }];
            }
            if (step === 2) {
                return [{
                    action: 'findInPage',
                    text: 'Needle phrase',
                    reasoning: 'Use browser find to jump to target text.',
                }];
            }
            if (step === 3) {
                return [{
                    action: 'screenshot',
                    reasoning: 'Capture evidence after find-in-page moved the viewport.',
                }];
            }
            return [{
                action: 'done',
                reasoning: 'Official-display agent loop smoke completed.',
            }];
        },

        async reflectOnIterationLimit(): Promise<IterationLimitReview | null> {
            return null;
        },

        updateConfig(patch: Partial<VisionConfig>) {
            config = { ...config, ...patch };
        },

        getConfig() {
            return { ...config };
        },
    };
}

async function main() {
    fs.rmSync(root, { recursive: true, force: true });
    fs.mkdirSync(root, { recursive: true });

    const pagePath = path.join(root, 'page.html');
    fs.writeFileSync(
        pagePath,
        `<!doctype html>
<html>
  <head>
    <title>Official Display Agent Smoke</title>
  </head>
  <body style="font-family: sans-serif; padding: 48px">
    <h1>Official display agent smoke</h1>
    <input id="field" value="initial" style="font-size: 24px; width: 420px">
    <p style="margin-top: 760px; font-size: 30px">Needle phrase for agent loop</p>
  </body>
</html>`,
    );

    const manager = await createBrowserManager({
        backend: 'official-display',
        userDataDir: path.join(root, 'profile'),
        downloadsDir: path.join(root, 'downloads'),
        chromeExecutablePath: process.env.BROWSER_AGENT_CHROME_EXECUTABLE_PATH || '/usr/bin/chromium',
        liveView: true,
        viewport,
        launchArgs: [],
        onLog: (message) => console.log(`[browser] ${message}`),
    });

    const evidence: BrowserEvidenceCapture[] = [];
    const statuses: string[] = [];

    try {
        await manager.launch();
        const session = await manager.createSession({
            id: 'agent-smoke',
            startupUrl: fileUrl(pagePath),
        });

        const controller = createAgentController(
            session,
            createSmokeVision(),
            (message) => {
                statuses.push(message);
                console.log(`[agent] ${message}`);
            },
            {
                maxIterations: 8,
                stepDelayMs: 50,
                actionSettleDelayMs: 100,
                waitActionDelayMs: 250,
                onEvidence: (capture) => {
                    evidence.push(capture);
                    const outputPath = path.join(root, `${capture.filenameBase}.${capture.mimeType.includes('webm') ? 'webm' : 'jpg'}`);
                    fs.writeFileSync(outputPath, capture.data);
                    console.log(`[evidence] ${outputPath} ${capture.data.length} bytes`);
                },
            },
        );

        controller.setTask('Run official-display agent-loop smoke.');
        await controller.start();
        const status = controller.getStatus();
        if (status.running || status.currentGoal) {
            throw new Error(`Agent loop did not finish cleanly: ${JSON.stringify(status)}`);
        }
        if (evidence.length < 1) {
            throw new Error('Agent loop did not produce screenshot evidence.');
        }

        const finalFrame = await session.captureAgentFrame();
        const finalScreenshotPath = path.join(root, 'final-frame.jpg');
        fs.writeFileSync(finalScreenshotPath, Buffer.from(finalFrame.imageBase64, 'base64'));

        console.log(JSON.stringify({
            display: manager.getLiveViewState().display,
            wsPort: manager.getLiveViewState().wsPort,
            statuses: statuses.length,
            evidenceCount: evidence.length,
            finalScreenshotPath,
            finalFrameBytes: fs.statSync(finalScreenshotPath).size,
            coordinateSpace: finalFrame.coordinateSpace,
            viewport: finalFrame.viewport,
        }, null, 2));
    } finally {
        await manager.close();
    }
}

main().catch(error => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
});
