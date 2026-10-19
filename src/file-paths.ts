// "/pluginfile.php/<context>/<component>/<area>/<item>/<path…>" names one stored file.
// The context is the activity itself, and a resource or folder revision is bumped by any
// settings edit (Moodle ignores it when serving), so neither belongs in a stable key.
export function storedPath(url: string): string[] | undefined {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return undefined;
  }
  const marker = "/pluginfile.php/";
  const at = pathname.indexOf(marker);
  if (at < 0) return undefined;
  const parts = pathname.slice(at + marker.length).split("/").filter(Boolean).map(decodeSegment).slice(1);
  if (parts.length < 3) return undefined;
  if ((parts[0] === "mod_folder" || parts[0] === "mod_resource") && parts[1] === "content") parts.splice(2, 1);
  return parts;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Section and activity names become folder names: no separators, nothing Windows rejects,
// no leading dot that would hide the folder. Windows also refuses device names like "CON"
// or "nul.txt" whatever their extension, so those gain a suffix.
export function pathSegment(name: string): string {
  const cleaned = name
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[\\/]/gu, "-")
    .replace(/[:*?"<>|]/gu, "")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^\.+/u, "")
    .replace(/[. ]+$/u, "");
  const short = (cleaned.length > 100 ? cleaned.slice(0, 100).trimEnd() : cleaned) || "_";
  return short.replace(/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?=\.|$)/iu, "$1_");
}

