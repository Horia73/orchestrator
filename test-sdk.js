import { GoogleGenAI } from '@google/genai';
const ai = new GoogleGenAI({apiKey: 'foo'});
const chat = ai.chats.create({model: 'test'});
chat.history = [{role: 'user', parts: [{text: 'test'}]}, {role: 'model', parts: [{functionCall: {name: 'test'}}]}]
const last = chat.history[chat.history.length - 1];
console.log(last.parts[0].functionCall);
