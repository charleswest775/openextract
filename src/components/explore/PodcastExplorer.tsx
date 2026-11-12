import { useState, useEffect, useMemo, useRef } from 'react';
import { PlayIcon, PodcastIcon } from '../shared/Icons';
import OrganicLoader from '../shared/OrganicLoader';
import { ReportProblemButton } from '../shared/Feedback';
import PageHeader from '../shared/PageHeader';
import EmptyState from '../shared/EmptyState';
import SaveDialog, { FORMATS, SaveButton } from '../shared/SaveDialog';
import Highlight from '../shared/Highlight';
import { useSaveAction } from '../../hooks/useSaveAction';
import { plural, savePodcasts } from '../../lib/saveData';
import { matches } from '../../lib/search';
import { formatDate } from '../../lib/dates';
import {
  AUDIO_NOTE, defaultEpisodeView, emptyCopy, episodeChips, episodeLine, episodeLink, episodeMatchFields, episodeName,
  episodesEmptyText, followState, groupShows, historyOrder, noMatchCopy, showCounts, showLine, showMatchFields, showName,
  webAddress,
} from '../../lib/podcasts';
import type { Podcast, PodcastEpisode, PodcastEpisodesResult, PodcastSaveFormat, PodcastsResult } from '../../types/podcasts';

interface Props {
  udid: string;
  /** What the top search box holds; the list shows only shows (and episodes) that match. */
  query: string;
}

/** The left list's first entry: every listened episode, across shows. */
const HISTORY = 'history';
type Selection = typeof HISTORY | number;
type EpisodeView = 'listened' | 'all';

/** One episode list as the engine answered it. */
interface EpisodeList {
  episodes: PodcastEpisode[];
  error: string | null;
}

// Long back catalogues (1,000 and more episodes) are shown a page at a time
const PAGE = 200;

/**
 * The Podcasts app's library (MTLibrary.sqlite): the shows followed, what was
 * listened to and when, and each show's episodes. Nothing is fetched from the
 * web: no artwork, feeds or audio. Episode audio is never in an iPhone backup,
 * so each episode links to where the podcast publishes it instead.
 */
export default function PodcastExplorer({ udid, query }: Props) {
  const [podcasts, setPodcasts] = useState<Podcast[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [emptyReason, setEmptyReason] = useState<string | null>(null);
  const [selected, setSelected] = useState<Selection>(HISTORY);
  // The Listened / All episodes choice, per show
  const [views, setViews] = useState<Record<number, EpisodeView>>({});
  // Episode lists already read, by udid, show and view
  const [lists, setLists] = useState<Record<string, EpisodeList>>({});
  const asked = useRef<Set<string>>(new Set());
  const [limit, setLimit] = useState(PAGE);
  const [choosing, setChoosing] = useState(false);
  const { busy, run } = useSaveAction('podcasts');

  useEffect(() => {
    loadPodcasts();
  }, [udid]);

  async function loadPodcasts() {
    setLoading(true);
    setError(null);
    setEmptyReason(null);
    try {
      const res = await window.openextract.call('list_podcasts', { udid });
      if (!res.success) {
        setPodcasts([]);
        setError(res.error || "The podcasts couldn't be read.");
      } else if (res.data) {
        const data = res.data as PodcastsResult;
        const list = Array.isArray(data.podcasts) ? data.podcasts : [];
        setPodcasts(list);
        setEmptyReason(data.empty_reason ?? null);
        if (data.error) setError(data.error);
        // Open on what was listened to; with no listening at all, on the first show
        const groups = groupShows(list);
        const first = groups.followed[0] ?? groups.others[0];
        setSelected(list.some(p => p.listened_count > 0) || !first ? HISTORY : first.id);
      }
    } finally {
      setLoading(false);
    }
  }

  const groups = useMemo(() => {
    const { followed, others } = groupShows(podcasts);
    const keep = (p: Podcast) => matches(query, ...showMatchFields(p));
    return { followed: followed.filter(keep), others: others.filter(keep) };
  }, [podcasts, query]);
  const shownCount = groups.followed.length + groups.others.length;

  // A search that hides the open show opens the first one that matches
  const selectedShow = typeof selected === 'number' ? podcasts.find(p => p.id === selected) ?? null : null;
  const visible = [...groups.followed, ...groups.others];
  const show: Podcast | null = selectedShow && visible.includes(selectedShow)
    ? selectedShow
    : selected === HISTORY ? null : visible[0] ?? null;
  const view: EpisodeView = show ? views[show.id] ?? defaultEpisodeView(show) : 'listened';
  const listKey = show ? `${udid}:${show.id}:${view}` : `${udid}:${HISTORY}`;
  const list = lists[listKey];

  // Read the open list's episodes the first time it's shown
  useEffect(() => {
    if (podcasts.length === 0 || asked.current.has(listKey)) return;
    asked.current.add(listKey);
    loadEpisodes(listKey, show ? { udid, podcast_id: show.id, listened_only: view === 'listened' } : { udid, podcast_id: null, listened_only: true });
  }, [listKey, podcasts.length]);

  useEffect(() => { setLimit(PAGE); }, [listKey]);

  async function loadEpisodes(key: string, params: { udid: string; podcast_id: number | null; listened_only: boolean }) {
    let result: EpisodeList;
    try {
      const res = await window.openextract.call('list_podcast_episodes', params);
      const data = res.data as PodcastEpisodesResult | undefined;
      result = !res.success
        ? { episodes: [], error: res.error || "The episodes couldn't be read." }
        : {
          episodes: Array.isArray(data?.episodes) ? data!.episodes : [],
          // An empty list is calm; only a list that couldn't be read is an error
          error: data?.error && !data.empty_reason ? data.error : null,
        };
    } catch (err: any) {
      result = { episodes: [], error: err?.message || String(err) };
    }
    if (result.error) asked.current.delete(key); // ask again the next time it's opened
    setLists(prev => ({ ...prev, [key]: result }));
  }

  const episodes = useMemo(() => {
    if (!list) return [];
    if (!show) return historyOrder(list.episodes).filter(e => matches(query, ...episodeMatchFields(e)));
    // Found by the show's name: all its episodes. Otherwise only the episodes that match.
    if (matches(query, ...showMatchFields(show))) return list.episodes;
    return list.episodes.filter(e => matches(query, ...episodeMatchFields(e)));
  }, [list, show, query]);

  function save(format: PodcastSaveFormat) {
    setChoosing(false);
    run(() => savePodcasts(udid, format));
  }

  function chooseView(v: EpisodeView) {
    if (show) setViews(prev => ({ ...prev, [show.id]: v }));
  }

  return (
    <div className="h-full flex flex-col">
      <PageHeader
        title="Podcasts"
        count={podcasts.length > 0
          ? (query ? `${shownCount} of ${plural(podcasts.length, 'podcast')}` : plural(podcasts.length, 'podcast'))
          : undefined}
        actions={<SaveButton onClick={() => setChoosing(true)} busy={busy} disabled={podcasts.length === 0} label="Save" />}
      />
      {loading && (
        <div className="flex justify-center py-12 text-accent">
          <OrganicLoader size={72} />
        </div>
      )}
      {!loading && podcasts.length === 0 && (
        <div className="flex-1 overflow-y-auto">
          <PodcastsEmpty emptyReason={emptyReason} error={error} />
        </div>
      )}
      {!loading && podcasts.length > 0 && (
        <div className="flex-1 flex min-h-0">
          {/* Listening history, then the shows */}
          <nav aria-label="Podcasts" className="w-[300px] flex-shrink-0 border-r border-rule overflow-y-auto">
            <ListButton
              current={!show}
              onClick={() => setSelected(HISTORY)}
              icon={<PlayIcon size={18} />}
              title="Listening history"
              line="Episodes played, most recent first"
            />
            {groups.followed.length > 0 && <div className="hearth-eyebrow px-4 pt-4 pb-1.5">Following</div>}
            {groups.followed.map(p => (
              <ListButton
                key={p.id}
                current={show?.id === p.id}
                onClick={() => setSelected(p.id)}
                icon={<PodcastIcon size={18} />}
                title={<Highlight text={showName(p)} query={query} />}
                line={showLine(p)}
              />
            ))}
            {groups.others.length > 0 && <div className="hearth-eyebrow px-4 pt-4 pb-1.5">Played, not followed</div>}
            {groups.others.map(p => (
              <ListButton
                key={p.id}
                quiet
                current={show?.id === p.id}
                onClick={() => setSelected(p.id)}
                icon={<PodcastIcon size={18} />}
                title={<Highlight text={showName(p)} query={query} />}
                line={showLine(p)}
              />
            ))}
            {query && shownCount === 0 && (
              <div className="text-center px-4 py-6">
                <div className="text-sm text-text-primary">{noMatchCopy(query).title}</div>
                <div className="text-xs text-text-secondary mt-1">{noMatchCopy(query).detail}</div>
              </div>
            )}
          </nav>

          {/* The open show, or the listening history */}
          <section aria-label={show ? showName(show) : 'Listening history'} className="flex-1 min-w-0 overflow-y-auto">
            {show ? (
              <ShowDetails show={show} query={query} view={view} onView={chooseView} />
            ) : (
              <div className="px-8 pt-6 pb-4 border-b border-rule">
                <h2 className="text-2xl text-text-primary">Listening history</h2>
                <div className="text-sm text-text-secondary mt-1">
                  {list && !list.error ? `${plural(list.episodes.length, 'episode')} played on this iPhone` : 'Every episode played, across all shows'}
                </div>
              </div>
            )}
            <p className="px-8 py-3 text-xs text-text-tertiary border-b border-rule">{AUDIO_NOTE}</p>
            {!list && (
              <div className="flex justify-center py-8 text-accent">
                <OrganicLoader size={56} />
              </div>
            )}
            {list?.error && (
              <EmptyState
                icon={PodcastIcon}
                title="Couldn't read the episodes"
                detail={<>{list.error}<div><ReportProblemButton error={list.error} area="podcasts" className="mt-2" /></div></>}
              />
            )}
            {list && !list.error && episodes.length === 0 && (
              <div className="px-8 py-8 text-sm text-text-secondary">
                {query && list.episodes.length > 0
                  ? `No episodes match "${query}"`
                  : episodesEmptyText(show ? view : 'history')}
              </div>
            )}
            {list && !list.error && episodes.length > 0 && (
              <ul>
                {episodes.slice(0, limit).map(e => (
                  <EpisodeRow key={e.id} episode={e} query={query} inHistory={!show} />
                ))}
              </ul>
            )}
            {list && !list.error && episodes.length > limit && (
              <div className="px-8 py-4">
                <button type="button" className="hearth-ghost-btn" onClick={() => setLimit(n => n + PAGE)}>
                  Show {Math.min(PAGE, episodes.length - limit).toLocaleString()} more of {plural(episodes.length, 'episode')}
                </button>
              </div>
            )}
          </section>
        </div>
      )}
      {choosing && (
        <SaveDialog
          title="Save your podcasts"
          formats={[FORMATS.opml, FORMATS.csv]}
          onSave={save}
          onCancel={() => setChoosing(false)}
        />
      )}
    </div>
  );
}

/** Why the screen has no shows: calm when the Podcasts app wasn't used, the error and a Report button when it can't be read. */
function PodcastsEmpty({ emptyReason, error }: { emptyReason: string | null; error: string | null }) {
  const copy = emptyCopy(emptyReason, error);
  const report = copy.kind !== 'empty';
  return (
    <EmptyState
      icon={PodcastIcon}
      title={copy.title}
      detail={copy.detail || report ? (
        <>
          {copy.detail}
          {report && <div><ReportProblemButton error={error || copy.title} area="podcasts" className="mt-2" /></div>}
        </>
      ) : undefined}
    />
  );
}

function ListButton({ current, onClick, icon, title, line, quiet = false }: {
  current: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  title: React.ReactNode;
  line?: string;
  quiet?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={current ? 'true' : undefined}
      className={`w-full px-4 py-3 flex items-center gap-3 text-left border-b border-rule transition-colors ${
        current ? 'bg-accent-wash' : 'hover:bg-surface'
      }`}
    >
      <span className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${
        quiet ? 'bg-sand text-text-secondary' : 'bg-accent-wash text-accent'
      }`}>
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className={`block text-sm font-medium truncate ${quiet ? 'text-text-secondary' : 'text-text-primary'}`}>{title}</span>
        {line && <span className="block text-xs text-text-tertiary truncate mt-0.5">{line}</span>}
      </span>
    </button>
  );
}

function ShowDetails({ show, query, view, onView }: {
  show: Podcast;
  query: string;
  view: EpisodeView;
  onView: (view: EpisodeView) => void;
}) {
  const website = webAddress(show.webpage_url);
  const facts = [followState(show), show.added_date && `Added ${formatDate(show.added_date)}`, showCounts(show)].filter(Boolean);
  return (
    <div className="px-8 pt-6 pb-4 border-b border-rule">
      <div className="flex items-start gap-4">
        <span className="w-14 h-14 rounded-xl bg-accent-wash text-accent flex items-center justify-center flex-shrink-0">
          <PodcastIcon size={28} />
        </span>
        <div className="flex-1 min-w-0">
          <h2 className="text-2xl text-text-primary"><Highlight text={showName(show)} query={query} /></h2>
          {show.author && <div className="text-base text-text-secondary"><Highlight text={show.author} query={query} /></div>}
          <div className="text-sm text-text-tertiary mt-1">{facts.join(' · ')}</div>
        </div>
        {website && (
          <button type="button" className="hearth-ghost-btn flex-shrink-0" onClick={() => window.openextract.openExternal(website)}>
            Website
          </button>
        )}
      </div>
      {show.feed_url && (
        <div className="mt-4">
          <div className="text-xs text-text-tertiary">Feed address</div>
          <div className="text-sm text-text-secondary break-all select-all">{show.feed_url}</div>
        </div>
      )}
      <div role="group" aria-label="Which episodes" className="mt-4 inline-flex rounded-full border border-rule bg-surface p-0.5">
        {(['listened', 'all'] as const).map(v => (
          <button
            key={v}
            type="button"
            aria-pressed={view === v}
            onClick={() => onView(v)}
            className={`px-3.5 py-1 rounded-full text-sm transition-colors ${
              view === v ? 'bg-accent-wash text-accent font-medium' : 'text-text-secondary hover:text-text-primary'
            }`}
          >
            {v === 'listened' ? 'Listened' : 'All episodes'}
          </button>
        ))}
      </div>
    </div>
  );
}

function EpisodeRow({ episode, query, inHistory }: { episode: PodcastEpisode; query: string; inHistory: boolean }) {
  const link = episodeLink(episode);
  const chips = episodeChips(episode);
  const name = episodeName(episode);
  return (
    <li className="px-8 py-3.5 border-b border-rule flex items-start gap-4">
      <div className="flex-1 min-w-0">
        <div className="text-base font-medium text-text-primary"><Highlight text={name} query={query} /></div>
        <div className="text-sm text-text-secondary">{episodeLine(episode, { inHistory })}</div>
        {chips.length > 0 && (
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {chips.map(c => (
              <span key={c} className="px-2 py-0.5 rounded-full bg-sand text-xs text-text-secondary">{c}</span>
            ))}
          </div>
        )}
      </div>
      {link && (
        <button
          type="button"
          className="hearth-ghost-btn !px-3 !py-1.5 flex-shrink-0"
          aria-label={`Open "${name}" on the web`}
          onClick={() => window.openextract.openExternal(link)}
        >
          Open on the web
        </button>
      )}
    </li>
  );
}
