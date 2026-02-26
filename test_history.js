import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY } from './server/config.js';

async function main() {
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const chat = ai.chats.create({ model: 'gemini-3.1-pro-preview' });
    console.log('Object class:', chat.constructor.name);
    console.log('Keys:', Object.keys(chat));

    // Send a message with a tool call
    const toolDeclaration = {
        name: 'test_func',
        description: 'Test function',
        parameters: { type: 'object', properties: {} }
    };

    // To trigger a function call:
    const stream = await chat.sendMessageStream({
        message: 'testing function call',
    }, {
        tools: [{ functionDeclarations: [toolDeclaration] }]
    });

    let lastResp;
    for await (const chunk of stream) {
        lastResp = chunk;
    }

    console.log('Chat history method exists?', typeof chat.getHistory);
    const history = await chat.getHistory();
    console.log('History type:', Array.isArray(history));
    if (history.length > 0) {
        console.log('History last:', JSON.stringify(history[history.length - 1], null, 2));
    }
}
main().catch(console.error);
