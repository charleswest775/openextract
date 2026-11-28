# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- Back up my iPhone: choosing a backup folder in OneDrive, iCloud Drive, Dropbox or Google Drive now shows a warning under it. A backup there still takes up space on the computer's own drive, so the space in the online account doesn't count, and the sync app uploading each file as it's saved can make the backup fail. If such a backup runs out of room, the message now says the folder is in OneDrive (or the like) and that its online space doesn't count

### Fixed
- Timeline: a voicemail kept only in the iPhone's store for one phone line (or whose recording is only there) now plays when you open it, instead of saying "Audio not available"
- Voicemail: a voicemail from a caller with no number now reads "Unknown", as such a call does on Calls, instead of a blank name, on the Voicemail screen, the Timeline and in saved voicemail lists and file names. It still isn't counted as anyone's on People. A copy of a voicemail in the phone line's store that gives the number without its "+", or a time a second off, is now listed once, not twice

## [0.21.0] - 2026-11-26

Saving now asks, once each time you open OpenExtract, what it's worth to you: $5, $25, $100 or any amount, with Save without paying right beside it. Calls no longer shows changes to a group chat (someone added or removed, a new name) as FaceTime calls, and Messages now says "Attachment not in this backup", instead of "Conversation update", when the iPhone removed a photo or file from a message.

### Added
- Saving: the first save each time you open OpenExtract asks "What's this worth to you?" before it saves, with $5, $25 (suggested), $100 or any amount. Paying opens the payment page in your browser and the save goes ahead at once. Save without paying saves straight away, Can't pay? Say thanks saves and opens the thank-you note, and Already paid? Don't ask again stops the question for good. It asks once each time the app is opened, before saves from the Save window and before saves that skip it (photos, voicemail audio), and in that run the "Pay it forward" card no longer comes after exports. Nothing is sent from the app

### Fixed
- Calls: changes to a group chat no longer show up as FaceTime calls. Each time someone was added to or removed from a group, or a group was renamed, Calls listed an answered FaceTime call that lasted no time, from whoever made the change (even in groups deleted long ago), and People, the Timeline, the Year view and saved call lists all counted it. Calls now come only from the iPhone's call history and voicemail, where FaceTime calls are listed with how long they lasted. A backup that isn't encrypted, and so has no call history, again says so on Calls instead of showing a few of these
- Messages: a photo or file the iPhone removed from a message while keeping the message now says "Attachment not in this backup" instead of "Conversation update", in the conversation, on the Timeline and People, and in every save of the conversation

## [0.20.1] - 2026-11-26

Notes now shows every note in the backup. An iPhone that has kept notes since before iOS 9 could show only a few old ones and hide the rest, and a note that's only numbers showed a blank page. A note still in the iPhone's Recently Deleted folder is now marked that way, and the Timeline, Year view and whole-backup search leave it out. Choosing a folder to open a backup from no longer lists the same backup several times, finds backups beside thousands of other folders or in two-letter folders like "de", and on a Mac no longer stops to ask for access to other apps' data.

### Fixed
- Open a backup folder: the same backup is no longer listed several times when a link in the folder (a symlink, or on Windows a junction such as Documents and Settings) leads back to it, and a MobileSync/Backup that's a link to an external drive is still found. A folder named Backup is looked inside even when thousands of other folders sit beside it, and a backup in a folder of yours with a two-letter name like "de" or "ca" is found. On a Mac, choosing your Library folder no longer stops to ask for access to other apps' data. The message for a folder with no backup says "1 folder" and "1 file" instead of "1 folders" and "1 files"
- Notes: every note in the backup now shows. An iPhone that has had notes since before iOS 9 can still keep an old account's notes (often "On My iPhone") in a separate file, and when it did, Notes listed only those old notes and none of the others. Now it lists both. A note whose text is only numbers, such as a code, now shows its text instead of a blank page
- Notes: a note in the iPhone's Recently Deleted folder is now marked Recently Deleted, in the list and above the open note, instead of looking like any other note. It stays in the list by date, and a saved note says so too. The Timeline, searching the whole backup and the Year view leave these notes out, as they leave out deleted voicemails. On People, a deleted note shared with someone still shows in their history, marked, and Save everything keeps it as a "Shared note (Recently Deleted)"

## [0.20.0] - 2026-11-25

On Photos you can now pick the photos you want and save just those, narrow the grid to the days they were taken, and see just the photos of the people you pick, from the groups of faces your iPhone's Photos app found. Saving photos into a folder you've used before says how many were already there, and the grid fills much faster. Each PDF of a conversation now holds about half as many photos and pages, so a computer short on memory can print it. Choosing a folder above a backup, such as MobileSync or a drive, now finds the backups inside it, and when a folder has no backup the app says what it does hold. Someone who saves from a sixth different iPhone in a year is asked once whether it's paid work; nothing in the app changes either way.

### Added
- Photos: pick the photos and videos you want and save just those. Click Select, then click each one, or Shift-click to pick every photo between the last one you clicked and this one. Cmd-click (Ctrl-click on Windows) picks a photo without clicking Select first, and Escape or Cancel stops picking. Save then says how many it will save ("Save 12 selected"), and puts them in the same year and month folders as Save all. Picking works in All Photos, Favorites, Hidden and every album (OE-193, OE-195)
- Photos: From and to dates narrow the grid to the photos and videos taken on those days, in All Photos, any album or the photos of the people picked, and Save these saves just those. The header counts what's left ("45 photos and videos from these dates"), and Any date shows everything again. A backup whose Photos library can't be read (some very old or damaged backups) has no dates for its photos, so the dates aren't offered there (OE-193)
- Photos: a People list under the albums, from the groups your iPhone's Photos app made of the faces it found, named or not (most never are), each with a face (or their head and shoulders, for someone Photos only saw from the side or behind) and how many photos the backup has. Pick someone to see just their photos, or several to see photos with any of them or only those with all of them together, and Save saves exactly those. OpenExtract only reads what your iPhone worked out; it never compares faces itself
- Using it for paid work?: after you save from a sixth different iPhone in a year, the app asks once whether it's paid work, and if it is, points to the business rates on the site ($50 a case or $200 a year, with a receipt). It's a request, not a condition of the license: nothing in the app changes either way, and it never asks again. The count stays on your computer, as scrambled iPhone IDs, and nothing is sent. Not shown to anyone who has said they've paid

### Changed
- Photos: with Videos or Live Photos picked in the type menu, the Save button now reads Save these and saves only that type. It used to save every photo and video in the album whatever the menu showed
- Saving photos into a folder you've saved them to before now says how many were already there, for example "40 exported · 1,200 were already in that folder". As since 0.19.0, only the ones that weren't there are copied, so saving all your photos again after a newer backup adds just the new ones (OE-193)
- Saving a conversation or WhatsApp chat as a PDF: each PDF now holds up to about 500 photos or 1,000 pages, half as much as before, so a computer without much memory to spare can print it. A long chat is split into more PDFs than before, by year or by runs of months; a shorter one still goes in one file (OE-170)

### Fixed
- Photos: the grid fills much faster, because it uses the small copies of each photo the iPhone keeps in the backup instead of opening every full-size photo, and a video's tile no longer copies the whole video out of an encrypted backup first, which held up every photo after it
- Calendar: All calendars now says how many events are in how many calendars, counting only calendars with events, as the home tile does, instead of also counting the empty calendar every iPhone has. An open repeating event says how it repeats once, in its details, instead of also as a label above them
- Voice Memos: an open recording no longer shows its file's internal name (such as 20251117 211010-7003F8D2.m4a) beside Save, and the sidebar's headings match the rest of the app
- Open a backup folder: choosing a folder above the backup, such as MobileSync, a drive, or a folder another program keeps its backups in, now finds backups up to four folders down instead of saying none were found. Choosing a folder inside a backup opens that backup. When there's no backup, the message says what the folder holds (it's empty, it has a .zip to extract first, it has a backup's files but not Manifest.db, or it holds photos) and which folder to choose, instead of asking for "a UDID-named subfolder"

## [0.19.0] - 2026-11-23

Two new sections: Voice Memos, with the iPhone's recordings, their transcripts and Recently Deleted, and Calendar, with every event and calendar files (.ics) to save. On People, photos, videos, voice messages and documents now show on each message as they do on the phone, and Save everything saves your whole history with someone, with every file. A chat too big for one PDF is saved as one PDF per year. Back up my iPhone no longer ruins the backup already in a folder when a new backup fails partway: if one failed with 0.18.0 or earlier, see Fixed below. Older backups can be moved to the Trash from Backup details. Saves never replace a file that's already there, so photos that share a name like IMG_0001 are all saved, and a save that runs out of room says so instead of calling photos "not in this backup". Long saves from encrypted backups are much faster and show how far they've got.

### Added
- People and Timeline: photos, videos, voice messages and documents sent in Messages now show on each message as small pictures, as on the phone. Click a photo to see it full size, a video to play it in the app (or open it in another app), a voice message to hear it, and a document to open it. WhatsApp's media show the same way. A file that isn't in the backup says so instead of showing "Attachment"
- Messages: photos in a conversation load small first and full size only when you open them, so long threads with many photos no longer hold up the app. Videos show a still frame and play in the app with seeking; HEIC photos show the right way up; PDFs, Office files and other documents open in the app your computer uses for them, while contact cards, archives and anything that could run (a program someone sent) are shown in their folder instead
- People: Save everything saves every message, WhatsApp chat, call, voicemail and shared note with one person in one file, with a folder beside it holding every photo, video, voice message, document and voicemail recording. It reads whole conversations, not only what's on screen, shows how far it has got, and never overwrites an earlier save. When a chip, the dates or a search narrow the page, Save these saves only what's shown, with its files
- Voice Memos: a new section with the iPhone's recordings, arranged like the Voice Memos app: All Recordings, Favorites, your folders, and Recently Deleted (recordings deleted on the iPhone that are still in the backup). Click a recording to play it, read its transcript if the iPhone made one, or save it. A recording the computer can't play here, or one too long to play here, opens in another app. A recording kept only in iCloud isn't in an iPhone backup, and the app says so. Save copies every recording with its date and name, with its transcript and a spreadsheet of them all, or saves just the spreadsheet
- Calendar: a new section with the events in the iPhone's calendars, grouped by account (iCloud, On My iPhone, Exchange and others), with holidays, birthdays and subscribed calendars listed apart so they don't crowd your own. Upcoming and Past are split at the date of the backup, a day at a time, and an event opens to its time, place, notes, links, who was invited and how they answered, alerts and how it repeats. All-day events stay on their own day in every time zone, and an event set in another time zone shows its time there too. Save writes calendar files (.ics) that Calendar, Outlook and Google import, one per calendar or just the one you're looking at, or a spreadsheet
- Backup details: older backups of the same iPhone in the same folder are listed, each with Move to Trash (Move to Recycle Bin on Windows) to get the space back once the Trash is emptied. OpenExtract never removes one by itself and never deletes one outright. The list appears inside a backup OpenExtract made, and offers only finished backups older than that one that can still be unlocked. Before anything moves it checks that the open one hasn't changed, has all its files and has readable Messages, says what you could lose, and asks, with Keep it as the default. That check can't prove every file in the newer backup is readable, so look through it first. It won't move a folder that has anything besides the backup in it. On Windows it also won't when the Recycle Bin hasn't room beside what's already in it, because Windows would then permanently erase those older items without asking. For the same reason a backup in the Recycle Bin can be erased by what you delete after it. Not offered on Linux, for network drives or, on Windows, for memory sticks

### Changed
- People and Timeline: one continuous history that loads more as you scroll, instead of pages of 100 with Newer and Older buttons. Picking someone else, or other filters, starts again at the top, and each day's heading counts the whole day
- People: a person's name, number, last time in touch and address-book link are never cut short. The buttons move to their own row when the window is narrow
- People: each person's counts now match their history. A call from WhatsApp or FaceTime that has a name but no number counts for that person; a number on the same contact card as someone joins them instead of being listed separately; and a voicemail with no number and no name no longer shows up in the history of everyone you were in touch with at the time
- Saving: every save names its formats the same way and lists them in the same order: the kind's own format first when it has one (contact cards, podcast subscriptions, original photos, voicemail audio), then whichever of PDF, web page, spreadsheet (CSV) and plain text it can make. Messages, WhatsApp, People, the Timeline, calls, web history and recovered messages offer all four. PDF comes first and is chosen to start with, so "Save a conversation as a PDF" on the backup's home page now opens with PDF picked
- Saving: People and the Timeline no longer offer Markdown, and now offer PDF and plain text. Calls and web history can be saved as a PDF, web page or text as well as a spreadsheet, and ask which; notes as a web page as well as a PDF or text, and Save to this computer saves all notes in one file in any of those; recovered messages as plain text too
- Saving: every PDF is now made the same way, so notes and recovered messages print with proper line wrapping and show any language and emoji, and long call or web history tables repeat their headings on each page. Spreadsheets open with the right characters in Excel on Windows, and saved call history, web history, notes and recovered messages no longer replace an earlier save with the same name
- Saving a conversation or WhatsApp chat as a PDF: one too big for a single sensible PDF is now saved as one PDF per year, and the notice says why, for example "One PDF of it all would be about 1 GB and 6,300 pages, so it's split by year: 2020, 2021, 2022, 2023 and 2024–2026". A PDF holds its photos whole, so a long, busy chat used to make one file of a gigabyte or more that was hard to open, share or print. Everything still goes in one file when it fits (up to about 1,000 photos or 2,000 pages), however many years it covers. Once a chat is split, quiet years share a file, and a year too big on its own is split into runs of months. Each part is saved on its own, so if something goes wrong late in a long save, the PDFs already saved stay, and the error says how many there are
- People: a person's page now shows everything between you, not only messages, WhatsApp, calls and voicemail. Photos sent in your chats and notes you share with them over iCloud are there too, each with a chip of its own. A date range and a search box narrow the page to a stretch of time or to the words you're after, and the chips count what's left. Save these saves what's on screen. The page says what it is ("Everything between you and Karin"), and the list explains what picking someone shows
- People and Timeline: everything with one person is on People now. The Timeline no longer has a person picker: it shows the whole backup by day, with a link to People, and when you type someone's name in its search, the link opens their page. The picker also used to add every photo, note and web visit from between your first and last contact with them, which People leaves out. In the Year view, clicking a day with someone picked opens that day on their page in People

### Fixed
- Back up my iPhone: a backup that fails no longer ruins the backup already in that folder. Up to now, backing up into the folder that held the same iPhone's last backup emptied that backup's Manifest.plist right at the start, before the iPhone had even asked for its passcode. In an encrypted backup that file holds the keys. **So if a backup into a folder you had used before failed or was interrupted in OpenExtract 0.18.0 or earlier (a passcode not entered, a cable pulled out, the app closed), it may have left the earlier backup there impossible to unlock, and this update can't repair that.** OpenExtract says when a backup is like that. Don't delete it: if you have a copy of that same backup's Manifest.plist, for example in Time Machine or File History, putting the file back in that backup's folder can unlock it. From now on a backup never writes into, moves or deletes one that's already there. A new one gets its own dated folder beside it, the app shows where both are, and the newest is listed first. That means each backup into the same folder takes up its own space until you remove it. A backup that stops after every file had arrived is kept too
- Saving photos no longer loses photos that share a file name. iPhones reuse names like IMG_0001, and a save put each photo at its bare name, so one photo replaced another in the folder while the notice counted both as saved. It could also replace a file of your own with that name. Save to this computer, which puts every photo in one folder, was hit hardest, and Save all on the Photos screen did the same to photos from the same month. The second is now saved as "IMG_0001 (2).JPG", and a file that was already in the folder is never replaced by a different one. Photos saved with 0.18.0 or earlier may be missing some that had the same name as another, even though the notice said they were saved. If you still have the backup, save them again. Saving into the same folder adds the ones that are missing without making copies of the ones that are there (OE-131)
- Saving conversations all in one file, saving the Timeline and saving voicemail no longer replace what's already in the folder. The new file gets " (2)" in its name, and the notice points to what was really saved. With 0.18.0 or earlier, saving again into the same folder replaced these, so an older save of them may hold only what was saved there last: all_conversations as text, a spreadsheet or a web page (PDFs were safe), timeline-export in any format, voicemails.csv, recordings with the same name, and the file People saved under a person's name. A saved web page also no longer puts its photos and files into a folder another save made, and a PDF no longer replaces a file that took its name while it was being made
- Address book on Linux: saving over a file that's already there now asks first, as it does on a Mac and on Windows
- Messages and WhatsApp: a web-page save that runs out of room now stops and says so, instead of saying it worked and calling photos that are in the backup "not in this backup". The same false words appeared when this computer's disk was too full to decrypt an encrypted backup (and went on appearing after space was freed), and when the backup's drive or folder couldn't be read. A save that stops takes back its unfinished page and the files it copied, and leaves an earlier page of the same name whole. A file gets its name only once all of it is written. A file that can't be read or saved is labeled that way on the page and counted when the save finishes. PDF saves stop the same way when there's no room, and no longer call a picture they can't read "not in this backup". If you saved conversations with an earlier version while a disk was nearly full or the backup's drive was having trouble, check them for "not in this backup" and save them again before deleting the backup
- Encrypted backups: finding each file no longer reads the backup's whole list of files. With 400,000 files that took up to half a second for every photo or attachment, so saving a long WhatsApp chat as a PDF could run past the hour the app waits. A test save of 1,500 photos went from 13 and a half minutes to half a minute on Windows, and from three and a half minutes to 21 seconds on a Mac
- Saving Messages conversations and WhatsApp chats: the screen now shows how far a save has got, for example "Saving PDF 2 of 5: 1,200 of 15,000 messages…", and a save that is still moving is no longer stopped for taking too long. When something does time out, the next screen no longer times out 5 minutes later through no fault of its own: it waits for the engine, up to 5 minutes, and then says OpenExtract is still busy and what to do
- Messages, Calls, Voicemail and WhatsApp: an email address with digits in it is no longer given the name of a contact whose phone number ends in those digits. An address like mike86@example.com could be shown with the name of a contact saved with a number ending in 86. An email address is now named only from a contact card that has that address
- Timeline: the number beside each kind of event now counts only what the dates and search leave, so it's how many ticking that kind would show. It used to count the whole backup whatever the filters were

## [0.18.0] - 2026-11-19

Voicemail transcripts now show, under each voicemail and in search. Back up my iPhone no longer hangs for up to 5 minutes when a connected iPhone doesn't answer, and on Windows a backup the iPhone has finished no longer fails at the very last step. Videos in a backup that isn't encrypted open in your video player. Saved call history, web history, notes and voicemail lists show times in your own time zone instead of UTC, a backup whose folder is missing files now says so, and when WhatsApp's chats aren't in a backup, the app says why. New and experimental: Export a data bundle saves messages, calls, voicemail, contacts and photo details in one documented folder that other tools can read.

### Added
- WhatsApp: when the iPhone has WhatsApp but its chats aren't in the backup, the WhatsApp section now says why instead of not showing up at all. WhatsApp's own end-to-end encrypted backup is the usual reason: with it turned on, WhatsApp keeps its chats only in its iCloud backup. The screen says where to turn it off so the next backup includes them (OE-99)
- Save to computer: Export a data bundle saves messages, calls, voicemail, contacts, photo details and people in one folder, in a documented format other tools can read (JSON and JSON Lines, with every date in UTC). It copies message attachments and voicemail audio too, and photo files if you tick them, and lists a SHA-256 hash of every file in SHA256SUMS, so anyone can check that nothing in it has changed since. The format is experimental and may still change: docs/BUNDLE.md describes it

### Changed
- Recover deleted messages: says that it looks for deleted iMessages and texts, and, when the backup has WhatsApp, why deleted WhatsApp messages can't be brought back. If you send a report asking about encrypted or deleted WhatsApp messages, the app now answers it right away (OE-99)
- Back up my iPhone: on Windows, searching for iPhones takes about 2 seconds less. The app no longer runs a second search, meant for iPhones on Wi-Fi, that never found one

### Fixed
- Back up my iPhone: searching for iPhones no longer waits 5 minutes for one that doesn't answer, while the rest of the app waits too. An iPhone that's connected but doesn't answer within a few seconds is now listed as not answering, with what to do: unplug it, unlock it and plug it back in, and if that doesn't help, restart it (on Windows, restart the PC too, which restarts Apple Devices). If Apple's software that talks to iPhones doesn't answer either, the app says so and what to do (OE-37, OE-8, OE-31)
- Back up my iPhone: an iPhone that stops answering while the app asks it to trust this computer no longer holds up the app. It used to wait up to 5 minutes, then show an error, while everything else waited too. Now, within a few seconds, the iPhone is shown as not answering, with what to do
- Back up my iPhone on Windows: a backup the iPhone has finished copying no longer fails at the very last step with "OpenExtract wasn't allowed to change a file in the backup folder". At the end the iPhone has the computer remove its Snapshot folder, by then only empty folders, and Windows refused when another program, such as antivirus software, had one of them open. Now OpenExtract tries again for a few seconds, and if only empty folders are left, it lets the backup finish and leaves them. The backup opens as finished, not as "Didn't finish". If a file is still in that folder, the backup fails as before (OE-11)
- Photos: clicking a video in a backup that isn't encrypted now opens it in your video player. The app used to hand your computer the backup's own copy of the video, which has no file type in its name, so the computer couldn't tell it was a video. On a Mac, with the backup on some external or network drives, it opened Terminal instead. Now the video is copied out under its own name (IMG_1234.MOV) and that copy is opened, with "Getting the video ready…" on screen while a long one is copied. If a video still can't be opened, the app says why instead of doing nothing (#297)
- Send feedback: a report's engine log now holds only errors from this time the app was opened and the time before, and only from the version you're running. It used to hold the last few errors the app had ever logged, so a report could carry errors from versions installed weeks earlier that had nothing to do with it, and those could bring up the fix for a problem you no longer had. Errors from the time before are marked as such. The app's log on your computer also no longer grows without end: it keeps those two times and nothing older (#298)
- A backup whose folder is missing some of its files now says so. When a backup folder is copied or moved and the copy stops partway, the backup still lists every file, so Photos showed a grey square for each missing photo and clicking a missing video did nothing. Now a strip above the backup says how many files are missing and what to do, Photos and Backup details leave out the missing ones and say how many there are, instead of calling them only in iCloud, and a video that can't be opened says why (OE-102)
- Voicemail: transcripts now show. The app used to find no transcript for any voicemail, because the iPhone keeps each one in a file of its own next to the recording, not where the app looked. Now the text the Phone app shows is under each voicemail and in the Timeline, search finds words in it, and Save all's voicemails.csv and the data bundle include it
- Voicemail: the list Save all saves (voicemails.csv) now has the caller's number in a Phone Number column. For a caller saved in your contacts it used to show only their name. A new Spam column marks every spam voicemail, including spam you then deleted, which is in the Deleted list
- Voicemail: Save all's dates follow your computer's time zone, as message saves do: the list's Date column shows local time with its offset, and each audio file is named with the local day, so a voicemail left in the evening no longer gets the next day's date. They used to be UTC
- Saved call history, web history and notes show dates in your computer's time zone, as saved messages, WhatsApp chats and podcasts already do. They used to be in UTC, so in California a call made at 5:48 in the evening read 00:48 the next day. In the call history and web history spreadsheets (CSV), the Date column keeps its exact form with your time zone added: 2024-07-05T17:48:12-07:00. A saved note's Created and Modified lines read "Jul 5, 2024, 5:48 PM", and a note without a date says "Unknown date" instead of "None" or nothing

## [0.17.0] - 2026-11-17

Voicemail now has Spam and Deleted lists beside Voicemail, as on the iPhone. Spam voicemails used to be mixed in with the rest, deleted ones still in the backup weren't shown at all, and some older deleted ones showed up as if they hadn't been deleted. Save all saves every list, and a voicemail whose recording isn't in the backup now says so instead of failing to play.

### Added
- Voicemail: Spam and Deleted lists beside Voicemail, as on the iPhone. Spam voicemails used to be mixed in with the rest, and deleted ones that are still in the backup weren't shown at all. Save all saves every list, with spam and deleted voicemails in folders of their own (OE-79)

### Fixed
- Voicemail: older voicemails that were deleted on the iPhone no longer show up as if they were still there, and voicemails newer iPhones keep in a separate store for each phone line are read too, each listed once (OE-79, OE-85)
- Voicemail: a voicemail whose recording isn't in the backup says so, instead of failing to play without a word (OE-85)

## [0.16.0] - 2026-11-16

OpenExtract stays free for everyone, no strings. After an export, a Pay it forward note from Charles asks you to pay what it's worth to you, but only if you can. It has a Pay $5 button, and if you can't, Say thanks lets you send a thank-you note instead. Photos now lists Favorites, Hidden and the album folders you made on the phone. As on the iPhone, All Photos and Favorites leave out photos you've hidden: they're under Hidden. Save to this computer still saves every photo and video, hidden ones included. Back up my iPhone no longer asks for a new password when the iPhone already has a backup password.

### Added
- Pay it forward: OpenExtract stays free, and now asks plainly for $5 from people it helped. After an export, a note from Charles says the app is free, no strings, and asks you to pay what it's worth to you, but only if you can. It has two buttons: "Pay $5" opens the payment page in your browser, and "Say thanks" opens a short thank-you note to send instead if you can't pay. Closing the note (its ×) stops the asks until you next open the app, and "I've paid" stops them for good. A "Pay it forward" button sits at the top of every screen and glows briefly after an export (it stays still if your system is set to reduce motion). It replaces the one-time "Say thanks" card; Say thanks is also still in Settings. Nothing is sent: what you picked stays on your computer, and the app can't see payments
- Photos: Favorites and Hidden are listed under All Photos, and albums sit inside the folders you made on the iPhone, in the same order as on the phone. Folders open and close in the sidebar. With an album, Favorites or Hidden on screen, the save button saves just those photos (Save album, Save favorites, Save hidden). As on the iPhone, All Photos and Favorites leave out photos you've hidden: they're under Hidden, and the home screen, the Timeline and the Year view don't count them. Save to this computer still saves every photo and video, hidden ones included, and says how many of them are hidden (#215)

### Fixed
- Photos: the count next to All Photos no longer changes to the count of whichever album is open, and three albums Photos keeps for itself ("progress-sync" and two more) no longer appear as empty albums
- Back up my iPhone: when the iPhone already has a backup password, set earlier in Finder, iTunes or OpenExtract, the app says so and doesn't ask for a new one. An iPhone keeps that first password and encrypts every backup with it until it's removed, but the app used to ask for a new password and then not use it, so opening the backup afterwards said the password you'd just typed was wrong. Encrypt now stays ticked for such an iPhone, the note says how to remove a password you've forgotten, and the unlock dialog after the backup asks for the earlier password (OE-68)
- Voicemail: when the list couldn't open voicemails the home screen had just counted, it showed SQLite's "unable to open database file". Now a file that went away while the backup was open (removed by a temp-folder clean-up, or on a drive that went to sleep) is found again, Voicemail tries the backup's own copy before giving up, and if it still can't open them it says to check that the drive with the backup is still connected (OE-77)

## [0.15.1] - 2026-11-13

### Fixed
- Back up my iPhone works again. In 0.15.0 every backup stopped at once with "pymobiledevice3 is not installed. Run: pip install pymobiledevice3", on Windows, macOS and Linux: part of the code that talks to iPhones was left out when the app was built. Installing pymobiledevice3 yourself didn't help, because OpenExtract uses its own copy. If that code ever fails to load again, the app says so and no longer suggests pip, and the build now checks for it before anything ships (OE-50, OE-51, OE-54)

## [0.15.0] - 2026-11-12

### Added
- Podcasts: a Podcasts section with the shows you follow in Apple Podcasts and your listening history: the episodes you played, newest first, with how many times you played each one and where you stopped. Shows you don't follow are listed apart. Save your subscriptions as an OPML file, which most podcast apps can import, or every show and episode as CSV. An iPhone backup never includes podcast audio, so each episode has a Get audio button that opens it in your browser, from where the podcast publishes it; OpenExtract itself still connects to nothing. Reading podcasts was contributed by gbaudic (ios-backup-core#25)

### Changed
- Windows: the app's updater now downloads a copy of the installer named `OpenExtract-Update-X.Y.Z.exe` instead of `OpenExtract-Setup-X.Y.Z.exe`. It's the same signed file. The only difference is that GitHub's download counts for each release now show updates and new installs apart; the app still sends nothing. The first update to this version may download the whole installer rather than only the parts that changed

### Fixed
- When a backup in your Recent list has been moved, renamed or deleted, or is on a drive that isn't plugged in, the app says it can't find it and where it looked, and a Find it button lets you choose where it is now. It used to say only "Backup not found" with the iPhone's ID (OE-40)
- Back up my iPhone and every save now refuse a folder inside OpenExtract's own program folder. Updating OpenExtract replaces that folder, which would delete anything saved there, so the app explains and asks you to choose another

## [0.14.0] - 2026-11-11

### Added
- WhatsApp: a WhatsApp section with your chats, groups and broadcast lists, in the order they arrived on the iPhone. Replies show the message they answer, reactions sit under the message they react to, and calls, locations, photos, videos, voice messages and documents show in the chat. Photos and files that WhatsApp didn't keep on the iPhone say so instead of failing. Save a chat, or all of them, as a web page, PDF, CSV or text file. WhatsApp messages also show in the Timeline, in search and under each person in People. The Year view doesn't count them yet, and calls made before WhatsApp 2.24 aren't shown, because older versions keep them somewhere else. If WhatsApp's end-to-end encrypted backup is turned on in WhatsApp's settings, WhatsApp leaves its chats out of the iPhone's backup, so there's nothing to show

### Fixed
- The Timeline no longer shows a red "Calls: Call history not found" error with a Report this problem button on every unencrypted backup. Apple only puts call history in encrypted backups, so that's normal, and the home page already says so calmly. A call history the app couldn't read is still shown as an error

## [0.13.0] - 2026-11-10

### Added
- A Chip in button in Settings, and on the screen after you send a thank-you, opens openextract.app/support in your browser. There you can pay what you like, from $3, once, through Stripe, toward code signing and development. OpenExtract stays free for everyone, nothing unlocks, and the app sends nothing when you click it

### Fixed
- Backing up an iPhone: when the computer's drive fills up partway, the app says there isn't enough free space instead of "[Errno 28] No space left on device"
- Backing up an iPhone: when Apple Devices, iTunes or Finder is syncing the iPhone, the app says so and asks you to wait or close it, instead of "Failed to lock itunes sync file" or "Could not lock the device's sync lock file"
- Backing up an iPhone: when the iPhone asks for its passcode and nobody enters it in time, the app asks for the passcode instead of telling you to tap Trust and check the cable
- Backing up an iPhone into a folder reached through a link, a mapped drive or a short (8.3) Windows name: when another program, such as OneDrive or antivirus software, is using the backup folder, the app says so instead of showing "Access is denied" or "Permission denied" with a file path
- Backing up an iPhone on a Mac or Linux: when a permission problem stops the backup from tidying up its temporary Snapshot folder at the end, the app says it wasn't allowed to change the backup folder instead of "[Errno 13] Permission denied: '61'"
- Turning on encryption for a backup into a folder where an earlier try didn't finish no longer fails with "The folder you chose has an unfinished backup of this iPhone" (OE-6)
- Backups keep the computer awake while they run. A computer that went to sleep disconnected the iPhone partway through a big backup, often after a few GB, even with the iPhone still plugged in. On Windows the screen now stays on during a backup, because that is what keeps a laptop from sleeping. Closing a laptop's lid still puts it to sleep, and the app then says that's what stopped the backup
- When the connection drops partway through a backup, the message says how much had been copied and points to sleep or the USB connection. It used to ask you to tap Trust, or on an encrypted backup to enter your passcode, which can't be the problem once data is flowing
- Back up my iPhone: when the iPhone hangs up before it has finished tidying the backup away, the app says the connection dropped partway, instead of saying the backup finished and opening it as if it were complete
- Back up my iPhone: a big backup that takes more than 2 hours no longer stops partway with "Sidecar call timed out: backup.start" while it's still copying. The app now gives up only after 2 hours with no progress at all. Saving to this computer works the same way: a big save that's still making progress no longer stops after 6 hours
- Backups made by iOS 6 no longer stop OpenExtract a few moments after they open. Reading their photos used to end the part of OpenExtract that reads backups, so Messages, Contacts, Notes, Photos and everything after failed with "Sidecar exited with code 1", then "Python sidecar is not running", until you quit. Their photos show now, and anything else the engine can't send is reported as an error on that screen instead of stopping it
- If OpenExtract can't look for the backups on this computer, the first screen says so and has a Look again button. The "Also on this computer" list used to just disappear
- A backup that stopped partway, made by OpenExtract or another app, is marked "Didn't finish" in the list of backups found on this computer (and in Recent once you've opened it), and opening it says so above every screen, instead of opening as if it were complete and then failing one section at a time (Calls showed "file is not a database"). What arrived can still be looked at. One that stopped before there was anything to open says so, instead of "No iPhone backups found". OpenExtract's own backups now record when they finish, so this doesn't rely on guesswork (OE-31)

## [0.12.0] - 2026-11-07

### Added
- The first screen lists the backups Finder, iTunes and the Apple Devices app saved on this computer, each with an Open button, so most people don't need to pick a folder. Backups already in your list aren't shown twice. On a Mac, macOS hides that folder until OpenExtract has Full Disk Access, so the first screen offers to explain how to allow it

### Changed
- "Not now" on the "Keep OpenExtract up to date?" card no longer turns update checks off for good. The card comes back a week later, and only switching it off in Settings saves a no

### Fixed
- Windows: the installer no longer crashes as it starts on a PC where OpenExtract isn't installed (including after uninstalling it). On GitHub's Windows test machines about one such install in three stopped before showing anything, silent or not; running it again usually worked. Installing over an earlier version, and updates from inside the app, weren't affected
- Encrypted backups of iPhones on iOS 10.0 or 10.1 open now with their password. They used to fail with "Failed to decrypt backup: b'DPSL'" even when the password was right

## [0.11.0] - 2026-11-07

### Added
- You can say thanks from inside the app. After your first export, the "Your file is saved" card has a Say thanks button, and so does Settings. If you saw the older version of that card, the new one shows once on your next export. If you answer "Looks right" when the app asks whether an export came out right, it offers once more. A thank-you sends only what you write (even nothing at all), privately, with no details about your computer or backup. You can tick a box to let your words be quoted on openextract.app without your name. Once you've sent one, the app stops asking
- "Report this problem" has a "Common fixes" link beside it. It opens openextract.app/fixes, which lists what to do for each error OpenExtract knows about, by the words the app shows
- Messages saved as a web page include their photos, GIFs, videos and other attachments. They're copied into a folder beside the page (Mom.html gets Mom_attachments), so you can move or share the two together. Photos and GIFs show in the conversation, videos and most audio play in it, and every attachment links to its file, so a voice message or a video your browser can't play still opens in another app
- Backups made by iOS 9 and earlier open now: iTunes backups from about 2011 to 2016, the ones with a Manifest.mbdb file instead of Manifest.db. They used to not show up at all. Encrypted ones open too, with their password. Messages, Contacts, Calls, Photos and Notes all read, including the older call history and notes those iPhones kept. Messages from iOS 5 and earlier still can't be read, and the Messages screen says so
- Saving photos shows how far it has got: "Saving 1,234 of 5,678 photos and videos…" with a bar that fills as it goes, on the Photos screen and on Save to this computer. A big library can take a long while, especially from an encrypted backup, and the button's "Saving…" alone looked stuck. Photos that couldn't be copied are counted as it goes

### Changed
- Saved conversations get file names you can read: "Karin Lindqvist, Jul 5 2024 - Jun 21 2026.html" instead of "Karin_Lindqvist--240705091009-000000--260621170638-000000.html". One day reads "Karin Lindqvist, Jul 5 2024", and names keep their accents and emoji. Saving the same conversation again adds " (2)" to the new file instead of replacing the first one, as PDFs already did
- Messages: notices in a conversation say what happened instead of "[Conversation event]": who added or removed someone, who left, who renamed the conversation and to what, who changed or removed the group photo, who unsent a message, and FaceTime calls. For example "Karin added Theo to the conversation" or "You unsent a message", with names from your contacts. They read the same in the app, the Timeline and saved TXT, CSV, HTML and PDF files. Notices OpenExtract can't name yet say "[Conversation update]"

### Fixed
- Saving photos, or anything else, to this computer no longer fails with "Sidecar call timed out" when it takes longer than five minutes, as a big photo library can. Thumbnails you scroll to while it saves now show up when it's done instead of failing
- Saved messages show each time in your computer's time zone, written the way people read it: "Jul 5, 2024, 9:10 AM". They used to show it in UTC, as 2024-07-05T16:10:09+00:00, so in California a message sent at 9:10 in the morning read 16:10, and an evening message could land on the next day. Web pages and PDFs show each day's date once, above its first message, like the conversation in the app. In a spreadsheet (CSV), the Date column keeps its exact form with your time zone added: 2024-07-05T09:10:09-07:00
- Photos and videos you save now have the date they were taken as their file date, so Finder, File Explorer and photo apps sort them in the order you took them. They used to have the date of the backup instead, so a whole library could look like it was taken on the same day

## [0.10.2] - 2026-11-06

### Changed
- macOS and Linux: OpenExtract can open a backup as soon as its window appears. Its engine used to unpack itself into a temporary folder every time it started, which could keep you waiting several seconds more on a Mac. It now comes as a folder, as it already did on Windows, and starts in a fraction of a second

### Fixed
- Windows: backups in a folder whose name has accents or other letters outside English (C:\Users\José, for example) open now; they used to fail. Save to this computer → Messages no longer stops partway through when a conversation's name has an emoji, and no longer writes files with garbled names
- Mac: after closing OpenExtract's window, reopening it from the Dock left it unable to open or read anything until you quit the app. It works straight away now
- If the engine can't be started at all, the app says so right away instead of waiting five minutes
- Back up my iPhone: an encrypted backup of an iPhone that had never made one failed with "No such value." It works now
- Back up my iPhone: when the iPhone itself is too full to make a backup, the app says so. It used to say the drive you chose didn't have enough free space, even on a nearly empty external drive
- Back up my iPhone: three more failures say what to do instead of showing a technical error: the iPhone couldn't send some of its files (error 104), the folder holds an unfinished backup from an earlier try (error 205), and Windows wouldn't let OpenExtract change a file in the backup folder ("Access is denied")

## [0.10.1] - 2026-11-04

### Fixed
- Windows: Back up my iPhone on a PC without Apple's iPhone software used to show a red error. It now explains that Windows needs Apple Devices, Apple's free app, and installs it for you from the Microsoft Store with one click, without needing an administrator (or opens the Store page if you'd rather do it yourself). If Apple Devices is installed but not running yet, as it isn't right after installing, OpenExtract starts it. Opening backups you already have never needed it
- Other errors while looking for an iPhone now have a Report this problem link
- Back up my iPhone asks your iPhone to trust this computer once. Every search used to start a new request, so you could be asked to tap Trust and enter your passcode several times in a row. The app now says when to tap Trust, and when the iPhone wants its passcode to start the backup
- A backup could fail right after you entered your passcode, with a technical "Device locked (MBErrorDomain/208)" error. OpenExtract retried this automatically with older versions of the library it uses to talk to iPhones, but not with newer ones, which word the error differently. It retries again now, and if your iPhone is still locked it asks you to unlock it and click Retry
- Unplugging your iPhone during a backup now says it was disconnected. An encrypted backup used to say the iPhone was asking for its passcode, and a backup into a folder you'd backed up to before could even say it had finished
- Back up my iPhone's progress bar no longer jumps to about 90% in the first moments and sits there for most of the backup. It now climbs with the iPhone's own progress all the way through, and a count of how much has been copied ("12.43 GB copied") keeps moving every second, even while the iPhone's percentage pauses on large files. Before that, while the iPhone gets ready and asks for its passcode, the bar stays at 0% instead of showing 11% "Backing up files"
- Back up my iPhone selects your iPhone when it's the only one connected, as it is the first time. You used to have to click it before you could start

## [0.10.0] - 2026-11-03

### Changed
- A new look that's simpler to find your way around. A backup opens on a home page of large tiles, one for each kind of data with its count, and a search box sits at the top of every screen instead of the row of icons down the side. Kinds the backup doesn't have get a tile that says why. Every screen has a Home button and shows where you are, and a Tools row on the home page leads to Recover deleted messages, Save to this computer and Backup details
- Overview is now called Backup details, Contacts is now Address book, and Browser history is now Web history
- Each screen's own search box is gone; the one at the top filters the screen you're on (Messages had three search boxes, now it has one)
- Send feedback no longer needs a GitHub account. Send delivers the report privately to OpenExtract's developer, with an optional email if you'd like a reply, and shows a reference number. If the report looks like a known problem, the fix appears right away. If sending fails, you can copy the report or post it on GitHub instead

### Added
- Search the whole backup from the home page. Results are grouped by kind (notes, messages, voicemail, calls, photos, web history and people), with matches highlighted and a preview. Case and accents don't count, so "cafe" finds "Café"; every word must appear, in any order; text in quotes must appear as written; and phone numbers match however they're punctuated. Notes are searched in full, not just their first lines. ⌘K (Ctrl+K on Windows and Linux) jumps to the search box from anywhere
- Opening a search result shows that exact record: a message inside its conversation, with "3 of 12 ↑ ↓" to step through the matches, a voicemail opened, a photo full size, or a call or web visit marked in its list
- People: everyone you were in touch with by message, call or voicemail, most first. Each person has one page with all of it and Save everything, and links to their Address book card and back
- When a problem you reported is fixed, OpenExtract tells you. While a report is open, the app checks on it every few days, sending only the report's number and a random code (see the privacy page)
- Year view: a heatmap of the backup with one square per day, darker the more happened. Filter by type and person, hover for a day's counts, click a day to open it in the Timeline. Days the backup doesn't reach, such as messages kept only in iCloud, show as not in this backup instead of quiet

### Fixed
- Clicking a photo opens it full size; it used to do nothing
- A backup is read once when it opens, and Search, People and the Timeline share it, instead of each of them reading the whole backup again
- Windows: the app opens backups on PCs with Smart App Control turned on. The engine used to unpack its libraries into a temporary folder each time it started, most of them unsigned, and Smart App Control stopped it before it could answer ("Python sidecar is not running"). It now ships as a folder in which every file is signed (#169)
- If a library the engine needs only for encrypted backups can't be loaded, other backups still open
- A feedback report about an engine that crashes as it starts now includes the error, not just its exit code
- The Timeline's date filter no longer leaves out items in the last second of the end date
- Linux (Flatpak): the app no longer offers to check for or install updates itself; Flathub keeps it up to date, and Settings says so

## [0.9.0] - 2026-11-02

### Added
- Send feedback from inside the app: a Feedback button in the header and the sidebar, "Report this problem" next to error messages, and a "Did this export come out right?" card after an export (at most once per run, with "Don't ask again"). The form fills in the app version, system, phone model, iOS version and recent errors, with folder names, device names, emails and phone numbers replaced by placeholders, and shows all of it so you can edit or delete any of it. OpenExtract still sends nothing: the report opens in your browser as a GitHub issue, and you send it from there (a free GitHub account is needed)

### Fixed
- When the engine crashes, the app says so right away instead of waiting up to five minutes with no message

## [0.8.1] - 2026-11-02

### Added
- After the first successful export, a one-time card asks for a GitHub star or a word to a friend (Star on GitHub, Copy link, Get release notes, Not now). It shows once, is remembered on this computer, and sends nothing anywhere

### Fixed
- Windows and Linux: typing in a text field no longer downloads spell-check dictionaries from Google. Text fields no longer underline misspelled words
- Calls: calls from Teams, Skype and other apps show a readable name instead of unreadable characters
- Calls: numbers saved in a national format, like 06 12 34 56 78, now match calls logged in international format, like +33 6 12 34 56 78
- Calls: backups with the older call history format no longer fail to list their calls
- The app icon is OpenExtract's own coral "o" mark instead of the default Electron icon, and the website's tab icon matches it instead of a placeholder
- Windows: the DLLs that come with Electron (ffmpeg.dll, libEGL.dll, libGLESv2.dll, vk_swiftshader.dll, vulkan-1.dll) are signed along with the app, as the Microsoft Store requires

## [0.8.0] - 2026-10-28

### Added
- Export a conversation as PDF, with its photos, from the Messages view (single or several conversations) (#91)
- HTML and PDF message exports end with one small line: "Made with OpenExtract, free at openextract.app"

### Fixed
- Photos counts only the photos that are in the backup. With iCloud Photos and "Optimize iPhone Storage", the Photos header, album counts, and the Overview tile and card used to count every photo in the library; the rest get one line saying how many are only in iCloud, so the backup doesn't have them (#106)
- The Photos grid loads to the end instead of stopping partway, sometimes showing a photo twice (#106)
- Photos that iCloud Photos keeps from your other devices are found, and encrypted backups no longer show tiles for photos that aren't in the backup (#106)
- Message exports and the conversation view say what a message without text is ("You started sharing your location", "Audio message not in this backup", "Conversation event") instead of "[Attachment]" or a code like "[location_started_by_me]"; HTML exports name each attachment ("[Image: IMG_0042.HEIC]")
- Exporting from a conversation's menu shows an error if it fails, instead of doing nothing
- Windows: in an encrypted backup, a file whose name has a character Windows doesn't allow (such as `?` or `:`) couldn't be opened and was reported as not in the backup (ios-backup-core#16)
- Opening a backup again releases the earlier copy's files instead of keeping them locked until later (#146)

### Changed
- Tests and CI run on Linux, macOS and Windows, and a pre-release check builds the app on all three and tries it on test backups (#146)

## [0.7.0] and earlier

Not broken out by version. See [GitHub Releases](https://github.com/charleswest775/openextract/releases) for each version's notes.

### Added
- Initial project scaffold
- Electron + React + Python sidecar architecture
- Backup discovery for macOS and Windows
- Encrypted backup support via iphone_backup_decrypt
- Message extraction from sms.db with contact resolution
- Chat-bubble message viewer UI
- Photo extraction from CameraRollDomain
- Voicemail, call history, contacts, and notes extractors
- Export to TXT, CSV, and HTML formats
- Backup test corpus: tests against real public iPhone backups (iOS 13–17), run weekly in CI (see `corpus/README.md`)

### Fixed
- Stats dashboard counted every conversation as a group chat
- Photos on iOS 13 and earlier backups had no dates, albums or stats
- Photo details on iOS 15+ were missing the modified date and burst ID
