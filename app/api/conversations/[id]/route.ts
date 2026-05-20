import { NextResponse } from 'next/server';
import { getConversation, deleteConversation, markConversationRead, markConversationUnread } from '@/lib/db';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> } // In Next.js 15, route params are Promises
) {
    try {
        const { id } = await params;
        const conversation = getConversation(id);
        if (!conversation) {
            return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
        }
        return NextResponse.json(conversation);
    } catch (error) {
        console.error("Failed to get conversation", error);
        return NextResponse.json({ error: "Failed to get conversation" }, { status: 500 });
    }
}

export async function DELETE(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        deleteConversation(id);
        return NextResponse.json({ success: true });
    } catch (error) {
        console.error("Failed to delete conversation", error);
        return NextResponse.json({ error: "Failed to delete conversation" }, { status: 500 });
    }
}

export async function PATCH(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    try {
        const { id } = await params;
        const body = await request.json().catch(() => ({}));
        const readAt = body?.read === false
            ? markConversationUnread(id)
            : markConversationRead(id);
        return NextResponse.json({ success: true, readAt });
    } catch (error) {
        console.error("Failed to update conversation read state", error);
        return NextResponse.json({ error: "Failed to update conversation read state" }, { status: 500 });
    }
}
