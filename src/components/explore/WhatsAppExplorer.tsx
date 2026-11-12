import MessageExplorer, { type ChatSource, type FoundMessage, type MessageExplorerProps } from './MessageExplorer';
import WhatsAppAttachment, { WhatsAppMapPreview } from './WhatsAppAttachment';
import EmptyState from '../shared/EmptyState';
import { ReportProblemButton } from '../shared/Feedback';
import { WhatsAppIcon } from '../shared/Icons';
import {
  chatDetails, chatMatchFields, chatName, chatTypeLabel, emptyCopy, engineSearchText, mergeSearchHits, whatsappHits,
} from '../../lib/whatsapp';
import { sidecarCall } from '../../lib/ipc';
import { saveWhatsAppChat, saveWhatsAppChats } from '../../lib/saveData';
import type { WhatsAppSearchResult } from '../../types/whatsapp';

/**
 * Every WhatsApp message in the store that the query's longest word finds
 * (the rest are checked against the results). WhatsApp not being in the
 * backup finds nothing; a store that can't be read is an error to show.
 */
export async function searchWholeStore(udid: string, query: string): Promise<FoundMessage[]> {
  const text = engineSearchText(query);
  if (!text) return [];
  const r = await sidecarCall<WhatsAppSearchResult>('search_whatsapp_messages', { udid, query: text });
  if (r?.error && !r.empty_reason) throw new Error(r.error);
  return Array.isArray(r?.results) ? r.results : [];
}

/** Why the WhatsApp screen has no chats: calm when WhatsApp isn't there, the error and a Report button when it can't be read. */
function WhatsAppEmpty({ emptyReason, error }: { emptyReason: string | null; error: string | null }) {
  const copy = emptyCopy(emptyReason, error);
  const report = copy.kind !== 'empty';
  return (
    <EmptyState
      icon={WhatsAppIcon}
      title={copy.title}
      detail={copy.detail || report ? (
        <>
          {copy.detail}
          {report && <div><ReportProblemButton error={error || copy.title} area="whatsapp" className="mt-2" /></div>}
        </>
      ) : undefined}
    />
  );
}

/**
 * WhatsApp chats (ChatStorage.sqlite), read like Messages. Every id here is a
 * WhatsApp one, so every call is a WhatsApp call: the same number in Messages
 * is a different conversation.
 */
export const WHATSAPP_SOURCE: ChatSource = {
  area: 'whatsapp',
  title: 'WhatsApp',
  icon: WhatsAppIcon,
  rpc: { list: 'list_whatsapp_chats', page: 'get_whatsapp_messages', offset: 'get_whatsapp_message_offset' },
  entryType: 'whatsapp',
  stillReading: 'Still reading WhatsApp, more may match…',
  hitsByChat: whatsappHits,
  // Past the index's limit, older chats aren't in it: the engine searches them all
  fullSearch: {
    capped: index => index.whatsappCap != null,
    search: searchWholeStore,
    merge: mergeSearchHits,
    searching: 'Searching every chat…',
    searched: 'Search covers every chat.',
  },
  noun: 'chat',
  name: chatName,
  listMatchFields: chatMatchFields,
  rowDetails: chatDetails,
  headerDetails: c => [chatTypeLabel(c.chat_type)].filter(Boolean),
  saveOneLabel: 'Save chat',
  saveOneTitle: name => `Save your WhatsApp chat with ${name}`,
  saveOne: saveWhatsAppChat,
  saveMany: saveWhatsAppChats,
  emptyScreen: (emptyReason, error) => <WhatsAppEmpty emptyReason={emptyReason} error={error} />,
  bubble: { variant: 'whatsapp', Attachment: WhatsAppAttachment, MapPreview: WhatsAppMapPreview },
};

export default function WhatsAppExplorer(props: MessageExplorerProps) {
  return <MessageExplorer {...props} source={WHATSAPP_SOURCE} />;
}
