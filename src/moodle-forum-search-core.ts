import type { ForumDiscussion, ForumDiscussionRef, ForumSearchHit } from "./models.js";

export interface ForumSearchSource {
  getForums(courseId?: number): Promise<Array<{ id: number; name: string; course_id: number; course_name: string; url: string }>>;
  getForumDiscussionRefs(forumCmid: number): Promise<ForumDiscussionRef[]>;
  getForumDiscussion(discussionId: number): Promise<ForumDiscussion>;
}

export interface ForumSearchOptions {
  limit?: number;
  courseId?: number;
  forumCmid?: number;
  includePostText?: boolean;
  unreadOnly?: boolean;
  sortBy?: "relevance" | "recent";
  maxForums?: number;
  maxDiscussionsPerForum?: number;
  baseUrl?: string;
}
export async function searchForumContent(
  source: ForumSearchSource,
  query: string,
  options: ForumSearchOptions = {},
): Promise<ForumSearchHit[]> {
  const cleanedQuery = query.trim();
  if (!cleanedQuery) {
    return [];
  }

  const includePostText = options.includePostText ?? true;
  const unreadOnly = options.unreadOnly ?? false;
  const sortBy = options.sortBy ?? "relevance";
  let forumRefs = await source.getForums(options.courseId);

  if (options.forumCmid !== undefined) {
    forumRefs = forumRefs.filter((ref) => ref.id === options.forumCmid);
    if (!forumRefs.length) {
      forumRefs = [
        {
          id: options.forumCmid,
          name: "",
          course_id: 0,
          course_name: "",
          url: `${(options.baseUrl ?? "").replace(/\/$/, "")}/mod/forum/view.php?id=${options.forumCmid}`,
        },
      ];
    }
  } else if (options.maxForums !== undefined) {
    forumRefs = forumRefs.slice(0, options.maxForums);
  }

  const hits: Array<[number, ForumSearchHit]> = [];
  const seen = new Set<string>();

  for (const forumRef of forumRefs) {
    let refs = await source.getForumDiscussionRefs(forumRef.id);
    if (options.maxDiscussionsPerForum !== undefined) {
      refs = refs.slice(0, options.maxDiscussionsPerForum);
    }

    for (const ref of refs) {
      let discussion: ForumDiscussion | null = null;
      let latestPost: ForumDiscussion["posts"][number] | null = null;
      let discussionHasUnread = false;
      const matchingPostHits: Array<[number, ForumSearchHit]> = [];

      if (includePostText || unreadOnly || sortBy === "recent") {
        discussion = await source.getForumDiscussion(ref.id);
        if (discussion.posts.length) {
          latestPost = discussion.posts.reduce((latest, post) => ((post.time_created || 0) > (latest.time_created || 0) ? post : latest));
          discussionHasUnread = discussion.posts.some((post) => post.unread);
        }
      }

      if (!includePostText) {
        addSubjectHit({
          hits,
          seen,
          score: matchScore(ref.subject, cleanedQuery),
          query: cleanedQuery,
          ref,
          forumRef,
          discussionHasUnread,
          unreadOnly,
          latestPost,
        });
        continue;
      }

      discussion ??= await source.getForumDiscussion(ref.id);
      for (const post of discussion.posts) {
        const postSubjectScore = matchScore(post.subject, cleanedQuery);
        const postBodyScore = matchScore(post.message_text, cleanedQuery);
        if (postSubjectScore <= 0 && postBodyScore <= 0) {
          continue;
        }
        if (unreadOnly && !post.unread) {
          continue;
        }

        const matchedIn = postSubjectScore >= postBodyScore ? "post_subject" : "post_body";
        const matchedText = matchedIn === "post_subject" ? post.subject : post.message_text;
        matchingPostHits.push([
          300 + Math.max(postSubjectScore, postBodyScore),
          {
            course_id: forumRef.course_id,
            course_name: forumRef.course_name,
            forum_id: forumRef.id,
            forum_name: forumRef.name,
            group_id: discussion.group_id || ref.group_id,
            group_name: discussion.group_name || ref.group_name,
            discussion_id: ref.id,
            discussion_subject: discussion.subject || ref.subject,
            post_id: post.id,
            author_name: post.author.fullname,
            matched_in: matchedIn,
            snippet: snippetForText(matchedText, cleanedQuery),
            unread: post.unread,
            time_created: post.time_created,
            url: post.url || ref.url,
          },
        ]);
      }

      if (matchingPostHits.length) {
        for (const [score, hit] of matchingPostHits) {
          const key = hitKey(hit.discussion_id, hit.post_id);
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          hits.push([score, hit]);
        }
        continue;
      }

      addSubjectHit({
        hits,
        seen,
        score: matchScore(ref.subject, cleanedQuery),
        query: cleanedQuery,
        ref,
        forumRef,
        discussionHasUnread,
        unreadOnly,
        latestPost,
      });
    }
  }

  hits.sort(sortBy === "recent" ? sortRecent : sortRelevant);
  return hits.slice(0, options.limit ?? 20).map(([, hit]) => hit);
}
export function normalizeQuery(value: string): { normalized: string; tokens: string[] } {
  const normalized = value.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  return { normalized, tokens: normalized ? normalized.split(/\s+/) : [] };
}

export function matchScore(text: string, query: string): number {
  const haystack = text.toLowerCase().split(/\s+/).filter(Boolean).join(" ");
  if (!haystack) {
    return 0;
  }

  const { normalized, tokens } = normalizeQuery(query);
  if (!normalized) {
    return 0;
  }
  if (haystack.includes(normalized)) {
    return 100 + normalized.length;
  }
  if (tokens.length && tokens.every((token) => haystack.includes(token))) {
    return 60 + tokens.length;
  }
  return 0;
}

export function snippetForText(text: string, query: string, maxLen = 120): string {
  const cleaned = text.split(/\s+/).filter(Boolean).join(" ");
  if (!cleaned) {
    return "";
  }

  const { normalized, tokens } = normalizeQuery(query);
  const lower = cleaned.toLowerCase();
  let start = normalized ? lower.indexOf(normalized) : -1;
  if (start < 0) {
    for (const token of tokens) {
      start = lower.indexOf(token);
      if (start >= 0) {
        break;
      }
    }
  }

  if (start < 0 || cleaned.length <= maxLen) {
    return cleaned.length <= maxLen ? cleaned : `${cleaned.slice(0, maxLen - 1)}…`;
  }

  const half = Math.floor(maxLen / 2);
  const left = Math.max(0, start - half);
  const right = Math.min(cleaned.length, left + maxLen);
  let snippet = cleaned.slice(left, right);
  if (left > 0) {
    snippet = `…${snippet}`;
  }
  if (right < cleaned.length) {
    snippet = `${snippet}…`;
  }
  return snippet;
}

function addSubjectHit(args: {
  hits: Array<[number, ForumSearchHit]>;
  seen: Set<string>;
  score: number;
  query: string;
  ref: ForumDiscussionRef;
  forumRef: { id: number; name: string; course_id: number; course_name: string };
  discussionHasUnread: boolean;
  unreadOnly: boolean;
  latestPost: ForumDiscussion["posts"][number] | null;
}): void {
  if (args.score <= 0 || (args.unreadOnly && !args.discussionHasUnread)) {
    return;
  }

  const key = hitKey(args.ref.id, 0);
  if (args.seen.has(key)) {
    return;
  }
  args.seen.add(key);
  args.hits.push([
    400 + args.score,
    {
      course_id: args.forumRef.course_id,
      course_name: args.forumRef.course_name,
      forum_id: args.forumRef.id,
      forum_name: args.forumRef.name,
      group_id: args.ref.group_id,
      group_name: args.ref.group_name,
      discussion_id: args.ref.id,
      discussion_subject: args.ref.subject,
      post_id: 0,
      author_name: "",
      matched_in: "discussion_subject",
      snippet: snippetForText(args.ref.subject, args.query),
      unread: args.discussionHasUnread,
      time_created: args.latestPost?.time_created ?? 0,
      url: args.ref.url,
    },
  ]);
}

function sortRecent(a: [number, ForumSearchHit], b: [number, ForumSearchHit]): number {
  return (
    (b[1].time_created || 0) - (a[1].time_created || 0) ||
    b[0] - a[0] ||
    compareText(a[1].course_name, b[1].course_name) ||
    compareText(a[1].forum_name, b[1].forum_name) ||
    a[1].discussion_id - b[1].discussion_id ||
    a[1].post_id - b[1].post_id
  );
}

function sortRelevant(a: [number, ForumSearchHit], b: [number, ForumSearchHit]): number {
  return (
    b[0] - a[0] ||
    compareText(a[1].course_name, b[1].course_name) ||
    compareText(a[1].forum_name, b[1].forum_name) ||
    a[1].discussion_id - b[1].discussion_id ||
    a[1].post_id - b[1].post_id
  );
}

function compareText(a: string, b: string): number {
  return a.toLowerCase().localeCompare(b.toLowerCase());
}

function hitKey(discussionId: number, postId: number): string {
  return `${discussionId}:${postId}`;
}
