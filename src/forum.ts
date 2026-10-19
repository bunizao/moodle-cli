import { NotFoundError, UsageError } from "./errors.js";
import type { ForumDiscussion } from "./models.js";

export function parseDiscussionReference(value: string): { discussionId: number; postId: number | null } {
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    return { discussionId: Number(raw), postId: null };
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError("DISCUSSION must be a numeric ID or a full discuss.php URL.");
  }

  const discussionValue = url.searchParams.get("d");
  if (!discussionValue || !/^\d+$/.test(discussionValue)) {
    throw new UsageError("Could not find discussion ID in URL query (expected ?d=...).");
  }

  const fragment = url.hash.replace(/^#/, "");
  const postId = /^p\d+$/.test(fragment) ? Number(fragment.slice(1)) : null;
  return { discussionId: Number(discussionValue), postId };
}

export async function parseForumReference(
  value: string,
  resolveForumCmid?: (discussionId: number) => Promise<number | null>,
): Promise<number> {
  const raw = value.trim();
  if (/^\d+$/.test(raw)) {
    return Number(raw);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError("FORUM must be a numeric ID or a full forum URL.");
  }

  if (url.pathname.endsWith("/mod/forum/view.php")) {
    const forumValue = url.searchParams.get("id");
    if (!forumValue || !/^\d+$/.test(forumValue)) {
      throw new UsageError("Could not find forum module ID in view.php URL (expected ?id=...).");
    }
    return Number(forumValue);
  }

  if (url.pathname.endsWith("/mod/forum/discuss.php")) {
    const discussionValue = url.searchParams.get("d");
    if (!discussionValue || !/^\d+$/.test(discussionValue)) {
      throw new UsageError("Could not find discussion ID in discuss.php URL (expected ?d=...).");
    }
    if (!resolveForumCmid) {
      throw new UsageError("A discuss.php URL needs a resolver to find the forum ID.");
    }
    const forumCmid = await resolveForumCmid(Number(discussionValue));
    if (!forumCmid) {
      throw new NotFoundError("Could not resolve forum ID from the discussion page.");
    }
    return forumCmid;
  }

  throw new UsageError("Unsupported forum URL. Use a view.php?id=... or discuss.php?d=... URL.");
}

export function filterDiscussionToPost(discussion: ForumDiscussion, postId: number | null | undefined): ForumDiscussion {
  if (postId == null) {
    return discussion;
  }
  const posts = discussion.posts.filter((post) => post.id === postId);
  if (!posts.length) {
    throw new NotFoundError(`Post ${postId} was not found in discussion ${discussion.id}.`);
  }
  return { ...discussion, posts };
}
