// The page readers find values by the label beside them. Those labels are Moodle language
// strings, so a site in another language, or one that customised a string, shows different
// text. The readers accept the English label and whatever the site itself says the same
// strings are, which one core_get_strings call returns for the session's language.

/** English label as the readers match it → the language strings a site may show instead. */
export const LABEL_STRINGS: Readonly<Record<string, ReadonlyArray<readonly [component: string, id: string]>>> = {
  "Submission status": [["mod_assign", "submissionstatus"], ["mod_assign", "submissionstatusheading"]],
  "Grading status": [["mod_assign", "gradingstatus"]],
  "Time remaining": [["mod_assign", "timeremaining"]],
  "Grade": [["core", "gradenoun"], ["core_grades", "gradenoun"], ["mod_assign", "gradenoun"], ["mod_quiz", "grade"]],
  "Graded on": [["mod_assign", "gradedon"]],
  "Graded by": [["mod_assign", "gradedby"]],
  "Feedback comments": [["assignfeedback_comments", "pluginname"]],
  "Due:": [["mod_assign", "activitydate:submissionsdue"], ["core_course", "activitydate:due"]],
  "Opens:": [["core_course", "activitydate:opens"], ["mod_assign", "activitydate:submissionsopen"]],
  "Closes:": [["core_course", "activitydate:closes"]],
  "Attempts allowed:": [["mod_quiz", "attemptsallowed"]],
  "Time limit:": [["mod_quiz", "timelimit"]],
  "Status": [["mod_quiz", "attemptstate"], ["core", "status"]],
  "Started": [["mod_quiz", "startedon"]],
  "Completed": [["mod_quiz", "completedon"]],
  "Duration": [["mod_quiz", "attemptduration"]],
  "Marks": [["mod_quiz", "marks"]],
};

/** English label → the texts the site shows for it. Empty when the site could not be asked. */
export type SiteLabels = Readonly<Record<string, readonly string[]>>;

export function labelRequests(): Array<{ stringid: string; component: string }> {
  const seen = new Set<string>();
  const requests: Array<{ stringid: string; component: string }> = [];
  for (const refs of Object.values(LABEL_STRINGS)) {
    for (const [component, stringid] of refs) {
      const key = `${component}/${stringid}`;
      if (!seen.has(key)) { seen.add(key); requests.push({ stringid, component }); }
    }
  }
  return requests;
}

/** Builds the label map from core_get_strings' answer; strings the site lacks come back as [[id]]. */
export function siteLabelsFrom(data: unknown): SiteLabels {
  const texts = new Map<string, string>();
  for (const item of Array.isArray(data) ? data : []) {
    const { component, stringid, string } = (item ?? {}) as Record<string, unknown>;
    if (typeof string === "string" && string && !/^\[\[.*\]\]$/u.test(string)) texts.set(`${component}/${stringid}`, string);
  }
  const labels: Record<string, string[]> = {};
  for (const [label, refs] of Object.entries(LABEL_STRINGS)) {
    const found = [...new Set(refs.map(([component, id]) => texts.get(`${component}/${id}`)).filter((text): text is string => Boolean(text)))];
    if (found.length) labels[label] = found;
  }
  return labels;
}

/** Compares labels the way a page shows them: case, spacing and a trailing colon do not matter. */
export function labelKey(text: string): string {
  return text.normalize("NFKC").replace(/\s+/gu, " ").trim().replace(/\s*[:：]$/u, "").toLowerCase();
}

/** Every text that stands for `label` on this site, the English one first. */
export function labelTexts(label: string, labels?: SiteLabels): string[] {
  return [label, ...(labels?.[label] ?? [])];
}
