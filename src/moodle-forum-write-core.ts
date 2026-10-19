import { FUNC_ADD_DISCUSSION_POST, FUNC_GET_STRINGS } from "./constants.js";
import { parse, type HTMLElement } from "node-html-parser";
import { cleanText, filemanagerOptions } from "./html-utils.js";
import { asArray, asRecord, numberValue, stringValue } from "./parsers.js";
import { parseForumDiscussionRefsHtml, parseMoodleConfig } from "./scraper.js";
import { noticesOf } from "./moodle-quiz-core.js";
import { isSiteUrl } from "./site-root.js";
import type { ForumDiscussion } from "./models.js";
import type { SubmitFile } from "./moodle-assign-core.js";

export interface ForumWriteDeps {
  baseUrl: string;
  request(url: string, init?: RequestInit, options?: { allowErrorStatus?: boolean }): Promise<Response>;
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  getDiscussion(discussionId: number): Promise<ForumDiscussion>;
  fail(message: string): Error;
  usage(message: string): Error;
}

export interface ForumPostReceipt {
  id: number;
  discussion_id: number;
  parent_id: number;
  url: string;
}

export async function replyForumPost(deps: ForumWriteDeps, postId: number, text: string, files: SubmitFile[] = []): Promise<ForumPostReceipt> {
  if (!text.trim()) throw deps.usage("A forum reply needs some text.");
  const html = await (await deps.request(`${deps.baseUrl}/mod/forum/post.php?reply=${postId}`)).text();
  const form = postForm(deps, html);
  const subject = form.querySelector('input[name="subject"]')?.getAttribute("value") ?? "";
  const discussionId = Number(form.querySelector('input[name="discussion"]')?.getAttribute("value"));
  if (!discussionId || !subject) throw deps.fail("Moodle did not show the reply's discussion and subject.");
  const options: Array<{ name: string; value: string }> = [];
  if (files.length) options.push({ name: "attachmentsid", value: await uploadAttachments(deps, html, form, files) });
  const result = asRecord(await deps.call(FUNC_ADD_DISCUSSION_POST, { postid: postId, subject, message: text, messageformat: 2, options }));
  const id = numberValue(result.postid);
  if (!id) throw deps.fail("Moodle did not return a post id for the reply.");
  return verifyPost(deps, discussionId, id, postId);
}

export async function createForumDiscussion(deps: ForumWriteDeps, forumCmid: number, subject: string, text: string): Promise<ForumPostReceipt> {
  if (!subject.trim() || !text.trim()) throw deps.usage("A new discussion needs a subject and text.");
  const viewHtml = await (await deps.request(`${deps.baseUrl}/mod/forum/view.php?id=${forumCmid}`)).text();
  const previous = new Set(parseForumDiscussionRefsHtml(viewHtml, deps.baseUrl).map(ref => ref.id));
  const view = parse(viewHtml);
  const link = view.querySelectorAll("a[href]").find(node => {
    const url = new URL(node.getAttribute("href") ?? "", deps.baseUrl);
    return url.pathname.endsWith("/mod/forum/post.php") && url.searchParams.has("forum");
  });
  const addForm = view.querySelectorAll("form").find(node => node.querySelector('input[name="forum"]'));
  const forumId = link ? new URL(link.getAttribute("href")!, deps.baseUrl).searchParams.get("forum") : addForm?.querySelector('input[name="forum"]')?.getAttribute("value");
  if (!forumId) throw deps.usage("Moodle does not offer a new discussion in this forum.");
  const html = await (await deps.request(`${deps.baseUrl}/mod/forum/post.php?forum=${encodeURIComponent(forumId)}`)).text();
  // The add-topic link was found by shape, and intro text can link to another forum's;
  // the posting page names its own forum, so a mismatch stops before anything is written.
  const postingCmid = Number(parseMoodleConfig(html).contextInstanceId);
  if (postingCmid && postingCmid !== forumCmid) throw deps.fail(`Moodle offered the posting form of activity ${postingCmid}, not forum ${forumCmid}; nothing was posted.`);
  const form = postForm(deps, html);
  const fields = formFields(form);
  fields.set("subject", subject.trim());
  fields.set("message[text]", text);
  fields.set("message[format]", "2");
  fields.set("submitbutton", "1");
  const response = await deps.request(new URL(form.getAttribute("action") || "post.php", `${deps.baseUrl}/mod/forum/post.php`).toString(), { method: "POST", body: fields });
  const responseHtml = await response.text();
  const url = new URL(response.url, deps.baseUrl);
  let discussionId = url.pathname.endsWith("/mod/forum/discuss.php") ? Number(url.searchParams.get("d")) : 0;
  if (!discussionId) {
    const afterHtml = await (await deps.request(`${deps.baseUrl}/mod/forum/view.php?id=${forumCmid}`)).text();
    const added = parseForumDiscussionRefsHtml(afterHtml, deps.baseUrl).filter(ref => !previous.has(ref.id) && ref.subject === subject.trim());
    if (added.length === 1) discussionId = added[0].id;
  }
  if (!discussionId) {
    // Only the posting form coming back proves nothing was saved; anything else may be a
    // success page, and a retry would post the discussion twice.
    if (findPostForm(responseHtml)) throw deps.fail(`Moodle did not create the discussion: ${noticesOf(responseHtml) || "it returned the posting form"}`);
    throw deps.fail(`Moodle may have created the discussion, but it could not be found in forum ${forumCmid}. Check the forum before posting again.`);
  }
  const discussion = await deps.getDiscussion(discussionId);
  const first = discussion.posts.find(post => !post.parent_id && post.subject === subject.trim());
  if (!first) throw deps.fail(`Moodle created discussion ${discussionId}, but its first post could not be verified. Check it before posting again.`);
  return { id: first.id, discussion_id: discussionId, parent_id: 0, url: `${deps.baseUrl}/mod/forum/discuss.php?d=${discussionId}#p${first.id}` };
}

export async function setForumSubscription(deps: ForumWriteDeps, forumCmid: number, subscribed: boolean): Promise<{ forum_id: number; subscribed: boolean }> {
  const labels = asArray(await deps.call(FUNC_GET_STRINGS, { strings: ["subscribe", "unsubscribe"].map(stringid => ({ stringid, component: "forum" })) })).map(item => cleanText(stringValue(asRecord(item).string)));
  if (!labels[0] || !labels[1]) throw deps.fail("Moodle did not provide its subscription labels.");
  const viewUrl = `${deps.baseUrl}/mod/forum/view.php?id=${forumCmid}`;
  const readToggle = (html: string) => {
    const root = parse(html);
    for (const element of root.querySelectorAll('a[href], form[action]')) {
      const url = new URL(element.getAttribute("href") ?? element.getAttribute("action") ?? "", deps.baseUrl);
      // Intro text can hold a look-alike link; only this install's control gets the sesskey.
      if (!isSiteUrl(deps.baseUrl, url) || !url.pathname.endsWith("/mod/forum/subscribe.php")) continue;
      if (element.tagName === "FORM") for (const [key, value] of formFields(element)) url.searchParams.set(key, value);
      if (url.searchParams.has("d") || url.searchParams.has("mode") || url.searchParams.has("user")) continue;
      const label = cleanText(element.textContent);
      if (label === labels[0] || label === labels[1]) return { url, subscribed: label === labels[1] };
    }
    return null;
  };
  const before = readToggle(await (await deps.request(viewUrl)).text());
  if (!before) throw deps.usage("Moodle does not offer a subscription toggle for this forum; subscriptions may be forced or disabled.");
  if (before.subscribed === subscribed) return { forum_id: forumCmid, subscribed };
  if (!before.url.searchParams.has("sesskey")) throw deps.fail("Moodle's subscription control has no session key.");
  before.url.searchParams.set("returnurl", `/mod/forum/view.php?id=${forumCmid}`);
  const body = new URLSearchParams(before.url.searchParams);
  before.url.search = "";
  const response = await deps.request(before.url.toString(), { method: "POST", body });
  await response.body?.cancel();
  const after = readToggle(await (await deps.request(viewUrl)).text());
  if (!after || after.subscribed !== subscribed) throw deps.fail("Moodle did not confirm the requested forum subscription state.");
  return { forum_id: forumCmid, subscribed };
}

async function verifyPost(deps: ForumWriteDeps, discussionId: number, postId: number, parentId: number): Promise<ForumPostReceipt> {
  const discussion = await deps.getDiscussion(discussionId);
  const post = discussion.posts.find(item => item.id === postId && item.parent_id === parentId);
  if (!post) throw deps.fail(`Moodle returned post ${postId}, but the reply could not be verified in discussion ${discussionId}.`);
  return { id: postId, discussion_id: discussionId, parent_id: parentId, url: `${deps.baseUrl}/mod/forum/discuss.php?d=${discussionId}#p${postId}` };
}

function findPostForm(html: string): HTMLElement | undefined {
  return parse(html).querySelectorAll("form").find(node => node.querySelector('input[name="subject"]') && node.querySelector('textarea[name="message[text]"]'));
}

function postForm(deps: ForumWriteDeps, html: string): HTMLElement {
  const form = findPostForm(html);
  if (!form) throw deps.usage(`Moodle is not accepting a forum post: ${noticesOf(html) || "no posting form is available"}`);
  return form;
}

function formFields(form: HTMLElement): URLSearchParams {
  const fields = new URLSearchParams();
  for (const node of form.querySelectorAll("input[name], textarea[name], select[name]")) {
    const type = node.getAttribute("type") ?? "";
    if (["submit", "button", "file"].includes(type) || (["checkbox", "radio"].includes(type) && !node.hasAttribute("checked"))) continue;
    if (node.hasAttribute("disabled")) continue;
    if (node.tagName === "SELECT") {
      const options = node.hasAttribute("multiple") ? node.querySelectorAll("option[selected]") : [node.querySelector("option[selected]") ?? node.querySelector("option")].filter((option): option is HTMLElement => option !== null);
      for (const option of options) fields.append(node.getAttribute("name")!, option.getAttribute("value") ?? option.textContent);
    } else fields.append(node.getAttribute("name")!, node.tagName === "TEXTAREA" ? node.textContent : node.getAttribute("value") ?? "");
  }
  return fields;
}

async function uploadAttachments(deps: ForumWriteDeps, html: string, form: HTMLElement, files: SubmitFile[]): Promise<string> {
  const itemid = form.querySelector('input[name="attachments"]')?.getAttribute("value");
  if (!itemid) throw deps.usage("This forum does not accept attachments.");
  const options = filemanagerOptions(html, itemid);
  if (!options) throw deps.fail("Moodle did not describe the attachment upload area.");
  const maxFiles = Number(options.maxfiles ?? -1);
  if (maxFiles >= 0 && files.length > maxFiles) throw deps.usage(`This forum accepts at most ${maxFiles} attachment${maxFiles === 1 ? "" : "s"}.`);
  const picker = asRecord(options.filepicker);
  const repo = (Array.isArray(picker.repositories) ? picker.repositories : Object.values(asRecord(picker.repositories))).map(asRecord).find(item => item.type === "upload");
  const sesskey = form.querySelector('input[name="sesskey"]')?.getAttribute("value");
  if (!repo || !sesskey) throw deps.fail("Moodle did not provide an attachment upload repository.");
  for (const file of files) {
    const body = new FormData();
    for (const [key, value] of Object.entries({ sesskey, itemid, repo_id: repo.id, client_id: options.client_id, ctx_id: asRecord(options.context).id, env: "filemanager", savepath: "/", title: file.name, author: picker.author, license: picker.defaultlicense, maxbytes: options.maxbytes, areamaxbytes: options.areamaxbytes })) body.set(key, stringValue(value));
    const accepted = options.accepted_types;
    const types = Array.isArray(accepted) ? accepted.map(stringValue) : accepted && typeof accepted === "object" ? Object.values(accepted).map(stringValue) : ["*"];
    for (const type of types.length ? types : ["*"]) body.append("accepted_types[]", type);
    body.set("repo_upload_file", new Blob([Uint8Array.from(file.bytes)]), file.name);
    const response = await deps.request(`${deps.baseUrl}/repository/repository_ajax.php?action=upload`, { method: "POST", body }, { allowErrorStatus: true });
    const result = asRecord(await response.json());
    if (result.error || result.event === "fileexists" || (!result.url && !result.id && !result.file)) throw deps.fail(`Moodle refused attachment ${file.name}: ${stringValue(result.error) || "upload was not confirmed"}`);
  }
  return itemid;
}

