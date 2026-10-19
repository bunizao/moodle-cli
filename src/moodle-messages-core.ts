import { asArray, asRecord } from "./parsers.js";
import { FUNC_GET_CONVERSATIONS, FUNC_GET_CONVERSATION_MESSAGES, FUNC_SEND_CONVERSATION_MESSAGES, FUNC_SEND_INSTANT_MESSAGES, FUNC_MARK_CONVERSATION_READ } from "./constants.js";
import { htmlToStructuredContent } from "./html-utils.js";
import type { Conversation, ConversationDetail, ConversationMessage, MessageMember } from "./models.js";

type Call = (name: string, args: Record<string, unknown>) => Promise<unknown>;
const rows = (value: unknown) => asArray(value).map(asRecord);
const members = (value: unknown): MessageMember[] => rows(value).map(m => ({ id: Number(m.id), name: String(m.fullname ?? "") }));
const messages = (value: unknown, baseUrl: string): ConversationMessage[] => rows(value).map(m => ({
  id: Number(m.id), sender_id: Number(m.useridfrom),
  text: htmlToStructuredContent(String(m.text ?? ""), baseUrl).text,
  created_at: Number(m.timecreated),
}));

export async function listConversations(call: Call, userid: number, baseUrl: string, limit: number, offset: number): Promise<Conversation[]> {
  const data = asRecord(await call(FUNC_GET_CONVERSATIONS, { userid, limitnum: limit, limitfrom: offset }));
  return rows(data.conversations).map(c => {
    const people = members(c.members);
    return {
      id: Number(c.id), name: String(c.name || people.filter(m => m.id !== userid).map(m => m.name).join(", ") || people[0]?.name || ""),
      type: c.type === 2 ? "group" : c.type === 3 ? "self" : "direct", unread_count: Number(c.unreadcount ?? 0),
      members: people, messages: messages(c.messages, baseUrl),
    };
  });
}

export async function getConversation(call: Call, userid: number, baseUrl: string, id: number, limit: number, offset: number): Promise<ConversationDetail> {
  const data = asRecord(await call(FUNC_GET_CONVERSATION_MESSAGES, { currentuserid: userid, convid: id, limitnum: limit, limitfrom: offset, newest: true }));
  return { id, members: members(data.members), messages: messages(data.messages, baseUrl).reverse(), offset };
}

export async function sendMessage(call: Call, id: number, text: string, user: boolean): Promise<number> {
  const data = await call(user ? FUNC_SEND_INSTANT_MESSAGES : FUNC_SEND_CONVERSATION_MESSAGES, {
    ...(user ? {} : { conversationid: id }), messages: [{ ...(user ? { touserid: id } : {}), text, textformat: 2 }],
  });
  const sent = rows(data)[0];
  const messageId = Number(sent?.msgid ?? sent?.id);
  if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error(String(sent?.errormessage || "Moodle did not send the message."));
  return messageId;
}

export async function markConversationRead(call: Call, userid: number, id: number): Promise<void> {
  await call(FUNC_MARK_CONVERSATION_READ, { userid, conversationid: id });
}
