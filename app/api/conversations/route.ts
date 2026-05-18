import { NextResponse } from 'next/server';
import { getConversationsWithMessages, createConversation } from '@/lib/db';
import type { Conversation } from '@/lib/types';

export async function GET() {
    try {
        const conversations = getConversationsWithMessages();
        return NextResponse.json(conversations);
    } catch (error) {
        console.error("Failed to fetch conversations", error);
        return NextResponse.json({ error: "Failed to fetch conversations" }, { status: 500 });
    }
}

export async function POST(request: Request) {
    try {
        const conversation: Conversation = await request.json();
        if (!conversation.id || !conversation.title) {
            return NextResponse.json({ error: "Invalid conversation data" }, { status: 400 });
        }
        createConversation(conversation);
        return NextResponse.json({ success: true, conversation });
    } catch (error) {
        console.error("Failed to create conversation", error);
        return NextResponse.json({ error: "Failed to create conversation" }, { status: 500 });
    }
}
