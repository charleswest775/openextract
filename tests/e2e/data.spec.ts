import { test, expect, loadExpected, openFixtureBackup, rpc } from './fixtures';

// Data-level regression: after opening the populated fixture through the UI,
// query every extractor through the real Electron → Python bridge and check
// exact values. Catches parsing regressions the UI might mask.
test('every extractor returns the fixture data', async ({ firstWindow: page }) => {
  const x = loadExpected();
  await openFixtureBackup(page);
  const udid = x.udid;

  await test.step('dashboard stats', async () => {
    const stats = await rpc(page, 'get_backup_stats', { udid });
    expect(stats.errors).toEqual([]);
    expect(stats.overview).toMatchObject({
      total_messages: x.total_messages,
      total_conversations: Object.keys(x.conversations).length,
      total_contacts: x.contacts.length,
      total_calls: x.total_calls,
      total_notes: x.notes.length,
      total_photos: x.photos.length,
      total_voicemails: Object.keys(x.voicemails).length,
    });
    expect(stats.calls.facetime_count).toBe(x.facetime_calls);
  });

  let aliceChatId = 0;
  await test.step('conversations resolve contact names', async () => {
    const { conversations } = await rpc(page, 'list_conversations', { udid });
    const counts = Object.fromEntries(conversations.map((c: any) => [c.display_name, c.message_count]));
    expect(counts).toEqual(x.conversations);
    expect(conversations.find((c: any) => c.display_name === 'Weekend Hike').is_group).toBe(true);
    aliceChatId = conversations.find((c: any) => c.display_name === x.attachment.conversation).chat_id;
  });

  await test.step('messages, attachment bytes, and search', async () => {
    const { messages } = await rpc(page, 'get_messages', { udid, chat_id: aliceChatId });
    expect(messages).toHaveLength(x.conversations[x.attachment.conversation]);
    expect(messages.map((m: any) => m.text)).not.toContain(x.recently_deleted);
    const withAttachment = messages.find((m: any) => m.has_attachments);
    expect(withAttachment.attachments[0].transfer_name).toBe(x.attachment.transfer_name);

    const att = await rpc(page, 'get_attachment', { udid, attachment_id: withAttachment.attachments[0].attachment_id });
    expect(att.mime_type).toBe('image/png');
    expect(Buffer.from(att.data, 'base64').length).toBe(x.attachment.bytes);

    const { results } = await rpc(page, 'search_messages', { udid, query: x.search.query });
    expect(results.map((r: any) => r.text)).toEqual([x.search.text]);
  });

  await test.step('contacts', async () => {
    const { contacts } = await rpc(page, 'list_contacts', { udid });
    expect(contacts.map((c: any) => c.display_name).sort()).toEqual([...x.contacts].sort());
  });

  await test.step('calls merge voicemails without duplicates', async () => {
    const { calls, total } = await rpc(page, 'list_calls', { udid });
    expect(total).toBe(x.total_calls);
    expect(calls.filter((c: any) => c.app === 'FaceTime Video')).toHaveLength(x.facetime_calls);
  });

  await test.step('notes decode their protobuf bodies', async () => {
    const { notes } = await rpc(page, 'list_notes', { udid });
    expect(notes.map((n: any) => n.title).sort()).toEqual([...x.notes].sort());
    expect(notes.some((n: any) => n.body.includes(x.note_body_fragment))).toBe(true);
  });

  await test.step('photos skip trashed assets and render thumbnails', async () => {
    const { photos } = await rpc(page, 'list_photos', { udid });
    expect(photos.map((p: any) => p.filename).sort()).toEqual([...x.photos].sort());
    expect(photos.map((p: any) => p.filename)).not.toContain(x.trashed_photo);

    const { albums } = await rpc(page, 'list_albums', { udid });
    expect(albums.find((a: any) => a.title === x.album.title).asset_count).toBe(x.album.count);

    const thumb = await rpc(page, 'get_photo_thumbnail', { udid, file_hash: photos[0].file_hash });
    expect(thumb.mime_type).toBe('image/jpeg');
    expect(thumb.data.length).toBeGreaterThan(100);
  });

  await test.step('voicemails and audio', async () => {
    const { voicemails } = await rpc(page, 'list_voicemails', { udid });
    const byName = Object.fromEntries(voicemails.map((v: any) => [v.contact_name, v.transcript]));
    expect(byName).toEqual(x.voicemails);
    const audio = await rpc(page, 'get_voicemail_audio', { udid, voicemail_id: voicemails[0].id });
    expect(Buffer.from(audio.data, 'base64').subarray(0, 6).toString()).toBe('#!AMR\n');
  });

  await test.step('browser history', async () => {
    expect((await rpc(page, 'has_browser_history', { udid })).has_any).toBe(true);
    const { visits } = await rpc(page, 'list_browser_history', { udid });
    expect(visits).toHaveLength(x.browser_visits);
    expect(new Set(visits.map((v: any) => v.title))).toEqual(new Set(x.browser_titles));
  });

  await test.step('message recovery finds deleted and orphaned texts', async () => {
    const rec = await rpc(page, 'recover_messages', { udid });
    expect(rec.scanned).toEqual({ recently_deleted: 1, orphaned: 1 });
    const texts = Object.values(rec.messages_by_conversation as Record<string, any[]>)
      .flat().map((m) => m.text);
    expect(texts).toEqual(expect.arrayContaining([x.recently_deleted, x.orphaned]));
  });
});
