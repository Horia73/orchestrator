import { NextResponse } from 'next/server';
import { addMessage } from '@/lib/db';
import type { Message } from '@/lib/types';

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const message: Message = await request.json();
        const hasText = typeof message.content === 'string' && message.content.length > 0
        const hasAttachments = Array.isArray(message.attachments) && message.attachments.length > 0
        if (!message.id || !message.role || (!hasText && !hasAttachments)) {
            return NextResponse.json({ error: "Invalid message data" }, { status: 400 });
        }

        addMessage(id, message);
        return NextResponse.json({ success: true, message });
    } catch (error) {
        console.error("Failed to add message", error);
        return NextResponse.json({ error: "Failed to add message" }, { status: 500 });
    }
}
