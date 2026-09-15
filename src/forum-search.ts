import type { ForumCheckResult, ForumDiscussion, ForumSearchHit } from "./models.js";
import { filterDiscussionToPost } from "./forum.js";
import { searchForumContent, type ForumSearchOptions, type ForumSearchSource } from "./moodle-forum-search-core.js";
export { searchForumContent, normalizeQuery, matchScore, snippetForText } from "./moodle-forum-search-core.js";
export type { ForumSearchOptions, ForumSearchSource } from "./moodle-forum-search-core.js";
export interface ForumFindOptions extends ForumSearchOptions { listMode?: boolean; showBody?: boolean }
export type ForumFindResult = ForumSearchHit | ForumSearchHit[] | ForumDiscussion | null;

export async function findForumContent(
  source: ForumSearchSource,
  query: string,
  options: ForumFindOptions = {},
): Promise<ForumFindResult> {
  const listMode = options.listMode ?? false;
  const hits = await searchForumContent(source, query, {
    ...options,
    limit: listMode ? options.limit ?? 5 : 1,
    sortBy: "recent",
  });
  const hit = hits[0] ?? null;

  if (options.showBody && hit) {
    return filterDiscussionToPost(await source.getForumDiscussion(hit.discussion_id), hit.post_id || null);
  }
  return listMode ? hits : hit;
}

export async function checkForumDiscussions(
  source: Pick<ForumSearchSource, "getForumDiscussionRefs" | "getForumDiscussion">,
  forumCmid: number,
  limit = 20,
): Promise<ForumCheckResult[]> {
  const refs = (await source.getForumDiscussionRefs(forumCmid)).slice(0, limit);
  const results: ForumCheckResult[] = [];
  for (const ref of refs) {
    try {
      const discussion = await source.getForumDiscussion(ref.id);
      results.push({
        discussion_id: ref.id,
        subject: ref.subject,
        ok: true,
        posts: discussion.posts.length,
        images: discussion.posts.reduce((count, post) => count + post.image_urls.length, 0),
      });
    } catch (error) {
      results.push({
        discussion_id: ref.id,
        subject: ref.subject,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
